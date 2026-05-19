import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';

export interface GenerateParams {
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  batch: number;
  initNoise: number;
  initType: string;
  initAudioFile?: File | null;
  inpaintAudioFile?: File | null;
  inpaintEnabled?: boolean;
  maskStart?: number;
  maskEnd?: number;
}

type JobStatus = 'idle' | 'submitting' | 'queued' | 'running' | 'completed' | 'failed';

interface GenerateStoreState {
  isGenerating: boolean;
  jobStatus: JobStatus;
  statusLabel: string;
  progressPct: number;
  currentJobId: string | null;
  lastAudioUrl: string | null;
  lastFilename: string | null;
  lastDurationSec: number | null;
  lastModelName: string | null;
  error: string | null;
  pollRunId: number;
  submitGeneration: (params: GenerateParams) => Promise<void>;
  cancelPolling: () => void;
  clearResult: () => void;
}

const POLL_INTERVAL_MS = 1000;

const base64ToBlob = (audioBase64: string, mimeType: string): Blob => {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
};

const decodeAudioToBlobUrl = (audioBase64: string, mimeType: string): string => {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
  return URL.createObjectURL(blob);
};

const getErrorMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const maybe = payload as { error?: unknown; detail?: unknown };
    if (typeof maybe.error === 'string') {
      return maybe.error;
    }
    if (typeof maybe.detail === 'string') {
      return maybe.detail;
    }
  }
  return fallback;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const useGenerateStore = create<GenerateStoreState>()((set, get) => ({
  isGenerating: false,
  jobStatus: 'idle',
  statusLabel: 'READY',
  progressPct: 0,
  currentJobId: null,
  lastAudioUrl: null,
  lastFilename: null,
  lastDurationSec: null,
  lastModelName: null,
  error: null,
  pollRunId: 0,

  submitGeneration: async (params) => {
    const prompt = params.prompt.trim();
    if (!prompt) {
      set({ error: 'Prompt is required before generation can start.' });
      return;
    }

    const previousUrl = get().lastAudioUrl;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }

    const nextRunId = get().pollRunId + 1;

    set({
      isGenerating: true,
      jobStatus: 'submitting',
      statusLabel: 'SUBMITTING JOB...',
      progressPct: 0,
      currentJobId: null,
      error: null,
      lastAudioUrl: null,
      lastFilename: null,
      pollRunId: nextRunId,
    });
    useStatusBarStore.getState().setText('GENERATION STARTED');
    logInfo('generate', `Submitting job: model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed} prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);

    const formData = new FormData();
    formData.append('model_name', params.model);
    formData.append('prompt', prompt);
    formData.append('negative_prompt', params.negativePrompt || '');
    formData.append('duration', String(params.duration));
    formData.append('steps', String(params.steps));
    formData.append('cfg_scale', String(params.cfg));
    formData.append('seed', String(params.seed));
    formData.append('batch_size', String(Math.max(1, params.batch)));
    formData.append('init_noise_level', String(params.initNoise));
    formData.append('init_audio_type', params.initType);
    formData.append('file_format', 'wav');
    formData.append('file_naming', 'verbose');
    if (params.initAudioFile) {
      formData.append('init_audio', params.initAudioFile);
    }
    if (params.inpaintEnabled && params.inpaintAudioFile) {
      formData.append('inpaint_audio', params.inpaintAudioFile);
      formData.append('mask_start', String(params.maskStart ?? 0));
      formData.append('mask_end', String(params.maskEnd ?? 0));
    }

    try {
      const response = await fetch('/api/generate-jobs', {
        method: 'POST',
        body: formData,
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Generation request failed with HTTP ${response.status}.`));
      }

      const jobId = (payload as { job?: { id?: string } })?.job?.id;
      if (!jobId) {
        throw new Error('Backend did not return a job id for /api/generate-jobs.');
      }

      set({
        currentJobId: jobId,
        jobStatus: 'queued',
        statusLabel: 'QUEUED...',
      });
      useStatusBarStore.getState().setText(`GENERATION QUEUED: ${jobId.slice(0, 8)}`);
      logInfo('generate', `Job queued: ${jobId.slice(0, 8)}`);

      while (true) {
        const state = get();
        if (state.pollRunId !== nextRunId) {
          return;
        }

        const jobResponse = await fetch(`/api/jobs/${jobId}`);
        let jobPayload: unknown = null;
        try {
          jobPayload = await jobResponse.json();
        } catch {
          jobPayload = null;
        }

        if (!jobResponse.ok) {
          throw new Error(getErrorMessage(jobPayload, `Job polling failed with HTTP ${jobResponse.status}.`));
        }

        const job = jobPayload as {
          status?: string;
          progress?: { step?: number; steps?: number };
          result?: {
            batch?: boolean;
            item?: { audio_base64?: string; mime_type?: string; filename?: string };
            items?: Array<{ audio_base64?: string; mime_type?: string; filename?: string }>;
          };
          error?: string;
        };

        const step = job.progress?.step ?? 0;
        const totalSteps = Math.max(1, job.progress?.steps ?? params.steps ?? 1);
        const progressPct = Math.max(0, Math.min(100, Math.round((step / totalSteps) * 100)));

        if (job.status === 'queued' || job.status === 'running') {
          const previousStatus = get().jobStatus;
          if (previousStatus !== job.status) {
            logInfo('generate', job.status === 'running'
              ? `Job running: ${jobId.slice(0, 8)} (sampler engaged)`
              : `Job still queued: ${jobId.slice(0, 8)}`);
          }
          set({
            jobStatus: job.status,
            isGenerating: true,
            statusLabel: job.status === 'queued' ? 'QUEUED...' : `SAMPLING ${step}/${totalSteps}`,
            progressPct,
          });
          await wait(POLL_INTERVAL_MS);
          continue;
        }

        if (job.status === 'completed') {
          const items = job.result?.batch ? job.result?.items ?? [] : job.result?.item ? [job.result.item] : [];
          const resultItem = items[0];
          if (!resultItem?.audio_base64) {
            throw new Error('Generation completed but no audio payload was returned.');
          }

          const audioUrl = decodeAudioToBlobUrl(resultItem.audio_base64, resultItem.mime_type || 'audio/wav');
          set({
            isGenerating: false,
            jobStatus: 'completed',
            statusLabel: 'COMPLETE',
            progressPct: 100,
            lastAudioUrl: audioUrl,
            lastFilename: resultItem.filename || 'output.wav',
            lastDurationSec: params.duration,
            lastModelName: params.model,
            error: null,
          });
          useStatusBarStore.getState().setText('GENERATION COMPLETE');
          logInfo('generate', `Completed: ${resultItem.filename || 'output.wav'} (${params.duration}s)`);

          // Auto-add all returned items (handles batch) to the library, and
          // auto-load the first one into the global footer player.
          let firstSavedBlob: Blob | null = null;
          let firstSavedTitle: string | null = null;
          let firstSavedId: string | null = null;
          try {
            const nowIso = new Date().toISOString();
            const library = useLibraryStore.getState();
            for (let i = 0; i < items.length; i += 1) {
              const it = items[i];
              if (!it?.audio_base64) continue;
              const mime = it.mime_type || 'audio/wav';
              const blob = base64ToBlob(it.audio_base64, mime);
              const entryId = items.length > 1 ? `${jobId}_${i}` : jobId;
              const title = it.filename || `gen_${entryId.slice(0, 8)}.wav`;
              await library.addEntry({
                id: entryId,
                title,
                prompt,
                negativePrompt: params.negativePrompt || '',
                model: params.model,
                duration: params.duration,
                steps: params.steps,
                cfg: params.cfg,
                seed: params.seed,
                audioBlob: blob,
                mimeType: mime,
                timestamp: nowIso,
                favorite: false,
                rating: null,
                tags: [],
                notes: '',
                source: 'generate',
              });
              if (i === 0) {
                firstSavedBlob = blob;
                firstSavedTitle = title;
                firstSavedId = entryId;
              }
            }
          } catch (libErr) {
            const msg = libErr instanceof Error ? libErr.message : 'Unknown error';
            logError('library', `Auto-save skipped: ${msg}`);
          }

          if (firstSavedBlob && firstSavedTitle) {
            try {
              await usePlayerStore.getState().load(firstSavedBlob, {
                label: firstSavedTitle,
                entryId: firstSavedId ?? undefined,
              });
            } catch {
              /* non-fatal */
            }
          }

          return;
        }

        if (job.status === 'failed') {
          throw new Error(job.error || 'Generation job failed.');
        }

        throw new Error(`Unexpected job status: ${job.status ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Generation failed unexpectedly.';
      set({
        isGenerating: false,
        jobStatus: 'failed',
        statusLabel: 'FAILED',
        error: message,
      });
      useStatusBarStore.getState().setText(`GENERATION FAILED: ${message}`);
      logError('generate', message);
    }
  },

  cancelPolling: () => {
    const nextRunId = get().pollRunId + 1;
    set({
      pollRunId: nextRunId,
      isGenerating: false,
      jobStatus: 'idle',
      statusLabel: 'STOPPED',
      progressPct: 0,
      currentJobId: null,
    });
    useStatusBarStore.getState().setText('GENERATION STOPPED');
    logInfo('generate', 'Job aborted by user');
  },

  clearResult: () => {
    const currentUrl = get().lastAudioUrl;
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }
    set({
      lastAudioUrl: null,
      lastFilename: null,
      lastDurationSec: null,
      lastModelName: null,
      error: null,
      statusLabel: 'READY',
      progressPct: 0,
    });
    useStatusBarStore.getState().setText('GENERATION OUTPUT CLEARED');
  },
}));
