import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';
import { useGenerateParamsStore, type GenerateParamsState } from './generateParamsStore';
import { renderChimeraOnce } from '../lib/chimeraClient';

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
  initAudioEnabled?: boolean;
  initAudioFile?: File | null;
  inpaintAudioFile?: File | null;
  inpaintEnabled?: boolean;
  maskStart?: number;
  maskEnd?: number;

  samplerType?: string;
  sigmaMax?: number;
  durationPaddingSec?: number;

  apgScale?: number;
  cfgRescale?: number;
  cfgNormThreshold?: number;
  cfgIntervalMin?: number;
  cfgIntervalMax?: number;

  shiftMode?: string;
  logsnrAnchorLength?: number;
  logsnrAnchorLogsnr?: number;
  logsnrRate?: number;
  logsnrEnd?: number;
  fluxMinLen?: number;
  fluxMaxLen?: number;
  fluxAlphaMin?: number;
  fluxAlphaMax?: number;
  fullBaseShift?: number;
  fullMaxShift?: number;
  fullMinLen?: number;
  fullMaxLen?: number;

  inversionSteps?: number;
  inversionGamma?: number;
  inversionUnconditional?: boolean;

  fileFormat?: string;
  fileNaming?: string;
  outputName?: string;
  cutToDuration?: boolean;

  loras?: Array<{ file: File | null; weight: number }>;
}

type JobStatus = 'idle' | 'submitting' | 'queued' | 'running' | 'completed' | 'failed';

interface GenerateStoreState {
  isGenerating: boolean;
  jobStatus: JobStatus;
  statusLabel: string;
  progressPct: number;
  currentJobId: string | null;
  lastAudioUrl: string | null;
  lastAudioBlob: Blob | null;
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

export const buildGenerateJobFormData = (params: GenerateParams, prompt: string): FormData => {
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
  formData.append('file_format', params.fileFormat || 'wav');
  formData.append('file_naming', params.fileNaming || 'verbose');
  formData.append('custom_name', params.outputName || '');

  if (params.samplerType) formData.append('sampler_type', params.samplerType);
  if (params.sigmaMax !== undefined) formData.append('sigma_max', String(params.sigmaMax));
  if (params.durationPaddingSec !== undefined) formData.append('duration_padding_sec', String(params.durationPaddingSec));

  if (params.apgScale !== undefined) formData.append('apg_scale', String(params.apgScale));
  if (params.cfgRescale !== undefined) formData.append('cfg_rescale', String(params.cfgRescale));
  if (params.cfgNormThreshold !== undefined) formData.append('cfg_norm_threshold', String(params.cfgNormThreshold));
  if (params.cfgIntervalMin !== undefined) formData.append('cfg_interval_min', String(params.cfgIntervalMin));
  if (params.cfgIntervalMax !== undefined) formData.append('cfg_interval_max', String(params.cfgIntervalMax));

  if (params.shiftMode) formData.append('dist_shift_type', params.shiftMode);
  if (params.logsnrAnchorLength !== undefined) formData.append('logsnr_anchor_length', String(params.logsnrAnchorLength));
  if (params.logsnrAnchorLogsnr !== undefined) formData.append('logsnr_anchor_logsnr', String(params.logsnrAnchorLogsnr));
  if (params.logsnrRate !== undefined) formData.append('logsnr_rate', String(params.logsnrRate));
  if (params.logsnrEnd !== undefined) formData.append('logsnr_end', String(params.logsnrEnd));
  if (params.fluxMinLen !== undefined) formData.append('flux_min_len', String(params.fluxMinLen));
  if (params.fluxMaxLen !== undefined) formData.append('flux_max_len', String(params.fluxMaxLen));
  if (params.fluxAlphaMin !== undefined) formData.append('flux_alpha_min', String(params.fluxAlphaMin));
  if (params.fluxAlphaMax !== undefined) formData.append('flux_alpha_max', String(params.fluxAlphaMax));
  if (params.fullBaseShift !== undefined) formData.append('full_base_shift', String(params.fullBaseShift));
  if (params.fullMaxShift !== undefined) formData.append('full_max_shift', String(params.fullMaxShift));
  if (params.fullMinLen !== undefined) formData.append('full_min_len', String(params.fullMinLen));
  if (params.fullMaxLen !== undefined) formData.append('full_max_len', String(params.fullMaxLen));

  if (params.inversionSteps !== undefined) formData.append('inversion_steps', String(params.inversionSteps));
  if (params.inversionGamma !== undefined) formData.append('inversion_gamma', String(params.inversionGamma));
  if (params.inversionUnconditional !== undefined) formData.append('inversion_unconditional', String(params.inversionUnconditional));

  if (params.cutToDuration !== undefined) formData.append('cut_to_duration', String(params.cutToDuration));

  if (params.loras) {
    params.loras.forEach((lora, i) => {
      if (lora.file) {
        formData.append(`lora_file_${i}`, lora.file);
        formData.append(`lora_weight_${i}`, String(lora.weight));
      }
    });
  }

  if ((params.initAudioEnabled ?? true) && params.initAudioFile) {
    formData.append('init_audio', params.initAudioFile);
  }
  if (params.inpaintEnabled && params.inpaintAudioFile) {
    formData.append('inpaint_audio', params.inpaintAudioFile);
    formData.append('mask_start', String(params.maskStart ?? 0));
    formData.append('mask_end', String(params.maskEnd ?? 0));
  }

  return formData;
};

export const buildGenerateParamsFromState = (params: GenerateParamsState): GenerateParams => ({
  prompt: params.prompt,
  negativePrompt: params.negativePrompt,
  model: params.model,
  duration: params.duration,
  steps: params.steps,
  cfg: params.cfg,
  seed: params.seed,
  batch: params.batch,
  initNoise: params.initNoise,
  initType: params.initType,
  initAudioEnabled: params.initAudioEnabled,
  initAudioFile: params.initAudioFile,
  inpaintAudioFile: params.inpaintAudioFile,
  inpaintEnabled: params.inpaintEnabled,
  maskStart: params.maskStart,
  maskEnd: params.maskEnd,
  samplerType: params.samplerType,
  sigmaMax: params.sigmaMax,
  durationPaddingSec: params.durationPaddingSec,
  apgScale: params.apgScale,
  cfgRescale: params.cfgRescale,
  cfgNormThreshold: params.cfgNormThreshold,
  cfgIntervalMin: params.cfgIntervalMin,
  cfgIntervalMax: params.cfgIntervalMax,
  shiftMode: params.shiftMode,
  logsnrAnchorLength: params.logsnrAnchorLength,
  logsnrAnchorLogsnr: params.logsnrAnchorLogsnr,
  logsnrRate: params.logsnrRate,
  logsnrEnd: params.logsnrEnd,
  fluxMinLen: params.fluxMinLen,
  fluxMaxLen: params.fluxMaxLen,
  fluxAlphaMin: params.fluxAlphaMin,
  fluxAlphaMax: params.fluxAlphaMax,
  fullBaseShift: params.fullBaseShift,
  fullMaxShift: params.fullMaxShift,
  fullMinLen: params.fullMinLen,
  fullMaxLen: params.fullMaxLen,
  inversionSteps: params.inversionSteps,
  inversionGamma: params.inversionGamma,
  inversionUnconditional: params.inversionUnconditional,
  fileFormat: params.fileFormat,
  fileNaming: params.fileNaming,
  outputName: params.outputName,
  cutToDuration: params.cutToDuration,
  loras: params.loras.map((lora) => ({ file: lora.file, weight: lora.weight })),
});

export const useGenerateStore = create<GenerateStoreState>()((set, get) => ({
  isGenerating: false,
  jobStatus: 'idle',
  statusLabel: 'READY',
  progressPct: 0,
  currentJobId: null,
  lastAudioUrl: null,
  lastAudioBlob: null,
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
    // Wall-clock anchor for elapsed-time logging across the whole generate flow.
    const t0 = performance.now();
    const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;

    set({
      isGenerating: true,
      jobStatus: 'submitting',
      statusLabel: 'SUBMITTING JOB...',
      progressPct: 0,
      currentJobId: null,
      error: null,
      lastAudioUrl: null,
      lastAudioBlob: null,
      lastFilename: null,
      pollRunId: nextRunId,
    });
    useStatusBarStore.getState().setText('GENERATION STARTED');
    logInfo('generate', `[${elapsed()}] CREATE pressed: model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed} prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);

    let effectiveParams = params;
    let chimeraSourceLabels: string[] | undefined;
    const chimeraStack = useGenerateParamsStore.getState().chimera;
    if (chimeraStack.clips.length >= 2) {
      try {
        const chimeraT0 = performance.now();
        logInfo('generate', `[${elapsed()}] Chimera: starting mashup render (${chimeraStack.clips.length} clips, mode=${chimeraStack.alignMode}, target_bpm=${chimeraStack.targetBpm})`);
        useStatusBarStore.getState().setText(`CHIMERA: rendering ${chimeraStack.clips.length} clips...`);
        const { file, meta } = await renderChimeraOnce(chimeraStack);
        chimeraSourceLabels = chimeraStack.clips.map((c) => c.label);
        const chimeraDt = ((performance.now() - chimeraT0) / 1000).toFixed(1);
        logInfo('generate', `[${elapsed()}] Chimera: mashup done in ${chimeraDt}s — ${meta.duration_sec.toFixed(1)}s @ ${meta.target_bpm_used.toFixed(1)} BPM, ${Math.round(file.size / 1024)}KB`);
        useGenerateParamsStore.getState().patch({
          initAudioFile: file,
          initAudioEnabled: true,
          initAudioSourceLabel: `Chimera · ${chimeraStack.clips.length} clips · @${meta.target_bpm_used.toFixed(1)} BPM (${meta.align_mode_used})`,
          initAudioSourceClipLabels: chimeraSourceLabels,
        });
        useGenerateParamsStore.getState().setChimeraField('lastMeta', meta);
        effectiveParams = { ...params, initAudioFile: file, initAudioEnabled: true };
        useStatusBarStore.getState().setText('CHIMERA READY — submitting job');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError('generate', `Chimera mashup failed; aborting generation: ${msg}`);
        useStatusBarStore.getState().setText(`CHIMERA FAILED: ${msg}`);
        set({
          isGenerating: false,
          jobStatus: 'idle',
          statusLabel: 'IDLE',
          error: `Chimera mashup failed: ${msg}`,
        });
        return;
      }
    }

    const formData = buildGenerateJobFormData(effectiveParams, prompt);

    try {
      logInfo('generate', `[${elapsed()}] POST /api/generate-jobs — model=${params.model} duration=${params.duration}s steps=${params.steps} seed=${params.seed}`);
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
        const detail = getErrorMessage(payload, `HTTP ${response.status} ${response.statusText}`);
        logError('generate', `POST /api/generate-jobs → ${response.status} ${response.statusText} — ${detail}`);
        throw new Error(detail);
      }

      const jobId = (payload as { job?: { id?: string } })?.job?.id;
      if (!jobId) {
        logError('generate', 'POST /api/generate-jobs → 200 OK but no job_id in response payload');
        throw new Error('Backend did not return a job id for /api/generate-jobs.');
      }

      logInfo('generate', `[${elapsed()}] POST /api/generate-jobs → 200 OK — job_id=${jobId.slice(0, 8)} (server received the job)`);
      set({
        currentJobId: jobId,
        jobStatus: 'queued',
        statusLabel: 'QUEUED...',
      });
      useStatusBarStore.getState().setText(`GENERATION QUEUED: ${jobId.slice(0, 8)}`);
      logInfo('generate', `[${elapsed()}] Job queued: ${jobId.slice(0, 8)} — waiting for backend to start sampling`);

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
          if (jobResponse.status === 404) {
            logError('generate', `Job ${jobId.slice(0, 8)} not found on server (it may have restarted). Aborting.`);
            set({
              isGenerating: false,
              jobStatus: 'failed',
              statusLabel: 'SERVER RESET',
              error: 'Server restarted or lost job. Please try again.',
            });
            return;
          }
          const detail = getErrorMessage(jobPayload, `HTTP ${jobResponse.status} ${jobResponse.statusText}`);
          logError('generate', `GET /api/jobs/${jobId.slice(0, 8)} → ${jobResponse.status} ${jobResponse.statusText} — ${detail}`);
          throw new Error(`Job polling failed: ${detail}`);
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
              ? `[${elapsed()}] Job running: ${jobId.slice(0, 8)} — sampler started (${totalSteps} steps requested)`
              : `[${elapsed()}] Job still queued: ${jobId.slice(0, 8)}`);
          }
          set({
            jobStatus: job.status,
            isGenerating: true,
            statusLabel: job.status === 'queued' ? 'QUEUED...' : `SAMPLING ${progressPct}%`,
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

          const resultMime = resultItem.mime_type || 'audio/wav';
          const resultBlob = base64ToBlob(resultItem.audio_base64, resultMime);
          const audioUrl = URL.createObjectURL(resultBlob);
          set({
            isGenerating: false,
            jobStatus: 'completed',
            statusLabel: 'COMPLETE',
            progressPct: 100,
            lastAudioUrl: audioUrl,
            lastAudioBlob: resultBlob,
            lastFilename: resultItem.filename || 'output.wav',
            lastDurationSec: params.duration,
            lastModelName: params.model,
            error: null,
          });
          useStatusBarStore.getState().setText('Decoded — registering library entries...');
          logInfo('generate', `[${elapsed()}] Sampler finished — ${resultItem.filename || 'output.wav'} (${params.duration}s, ${Math.round(resultBlob.size / 1024)}KB). Audio was written to disk server-side; pulling the entries.`);

          // The backend already wrote each item to disk via _save_generation_artifacts_sync.
          // Refresh the library to surface the new entries via /api/library/entries.
          const isChimeraRun = !!(chimeraSourceLabels && chimeraSourceLabels.length > 0);
          const library = useLibraryStore.getState();
          await library.refresh();

          // Backend doesn't know the user-facing Chimera source labels, so
          // PATCH them in after refresh. Entry ID format matches what the
          // backend writes: `<job_id>_<index:02d>`.
          if (isChimeraRun && chimeraSourceLabels) {
            const newEntries = useLibraryStore.getState().entries;
            for (let i = 0; i < items.length; i += 1) {
              if (!items[i]?.audio_base64) continue;
              const entryId = `${jobId}_${String(i).padStart(2, '0')}`;
              const exists = newEntries.find((e) => e.id === entryId);
              if (!exists) {
                logError('library', `Chimera-sources PATCH skipped: entry ${entryId} not found in refresh.`);
                continue;
              }
              await useLibraryStore.getState().updateEntry(entryId, {
                tags: Array.from(new Set([...(exists.tags ?? []), 'chimera'])),
                chimeraSources: chimeraSourceLabels,
              });
            }
          }

          // Load the first new entry into the player so playback works
          // immediately. The blob comes from the backend streaming URL.
          const after = useLibraryStore.getState().entries;
          const firstEntry = items[0]?.audio_base64
            ? after.find((e) => e.id === `${jobId}_00`) ?? after.find((e) => e.id === jobId)
            : null;
          if (firstEntry) {
            try {
              const loadT0 = performance.now();
              const blob = await useLibraryStore.getState().fetchAudioBlob(firstEntry);
              await usePlayerStore.getState().load(blob, {
                label: firstEntry.title,
                entryId: firstEntry.id,
              });
              logInfo('generate', `[${elapsed()}] Loaded into player bar (${Math.round(performance.now() - loadT0)}ms).`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logError('generate', `Player load failed: ${msg}`);
            }
          } else {
            logError('generate', `Could not find freshly-saved entry for job ${jobId}; library may need a manual reload.`);
          }

          useStatusBarStore.getState().setText('GENERATION COMPLETE');
          logInfo('generate', `[${elapsed()}] Generation pipeline complete.`);
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
      lastAudioBlob: null,
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

