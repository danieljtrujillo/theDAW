import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';

interface ModelInfo {
  active_model: string;
  available_models: string[];
  has_cuda: boolean;
  device: string;
  vram_used_gb: number;
  vram_total_gb: number;
}

interface AutoencoderInfo {
  available_autoencoders: string[];
  loaded_autoencoders: string[];
}

interface TrainingStoreState {
  modelInfo: ModelInfo | null;
  autoencoderInfo: AutoencoderInfo | null;
  jobs: Array<Record<string, unknown>>;
  activeJobId: string | null;
  isTraining: boolean;
  error: string | null;
  logs: string[];
  encodedLatentsBase64: string | null;
  decodedAudioUrl: string | null;
  refreshMetadata: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  startLoraTraining: (payload: {
    modelName: string;
    dataDir: string;
    outputDir: string;
    rank: number;
    alpha: number;
    steps: number;
  }) => Promise<void>;
  startPreEncode: (payload: {
    modelName: string;
    dataDir: string;
    outputPath: string;
  }) => Promise<void>;
  encodeAudioToLatents: (payload: {
    modelName: string;
    audioFile: File;
  }) => Promise<void>;
  decodeLatentsToAudio: (payload: {
    modelName: string;
    fileFormat?: 'wav' | 'flac' | 'ogg';
  }) => Promise<void>;
  clearDecodedAudio: () => void;
  stopPolling: () => void;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const parseError = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === 'object') {
    const body = payload as { error?: unknown; detail?: unknown };
    if (typeof body.error === 'string') {
      return body.error;
    }
    if (typeof body.detail === 'string') {
      return body.detail;
    }
  }
  return fallback;
};

export const useTrainingStore = create<TrainingStoreState>()((set, get) => ({
  modelInfo: null,
  autoencoderInfo: null,
  jobs: [],
  activeJobId: null,
  isTraining: false,
  error: null,
  logs: [],
  encodedLatentsBase64: null,
  decodedAudioUrl: null,

  refreshMetadata: async () => {
    try {
      const [modelRes, aeRes] = await Promise.all([
        fetch('/api/model-info'),
        fetch('/api/autoencoder/info'),
      ]);

      const modelPayload = (await modelRes.json()) as ModelInfo | { error?: string };
      const aePayload = (await aeRes.json()) as AutoencoderInfo;

      if (!modelRes.ok) {
        throw new Error(parseError(modelPayload, 'Failed to load model metadata.'));
      }
      if (!aeRes.ok) {
        throw new Error('Failed to load autoencoder metadata.');
      }

      set({ modelInfo: modelPayload as ModelInfo, autoencoderInfo: aePayload, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Metadata request failed.';
      set({ error: message });
      useStatusBarStore.getState().setText(`TRAINING METADATA FAILED: ${message}`);
    }
  },

  refreshJobs: async () => {
    const response = await fetch('/api/jobs');
    const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> };
    if (!response.ok) {
      throw new Error('Failed to load jobs.');
    }
    set({ jobs: payload.jobs ?? [] });
  },

  startLoraTraining: async ({ modelName, dataDir, outputDir, rank, alpha, steps }) => {
    set({ isTraining: true, error: null, logs: [] });
    useStatusBarStore.getState().setText('TRAINING JOB SUBMITTING...');

    const form = new FormData();
    form.append('model_name', modelName);
    form.append('data_dir', dataDir);
    form.append('output_dir', outputDir);
    form.append('rank', String(rank));
    form.append('lora_alpha', String(alpha));
    form.append('steps', String(steps));

    try {
      const submit = await fetch('/api/jobs/train-lora', { method: 'POST', body: form });
      const payload = (await submit.json()) as { job?: { id?: string } } | { error?: string; detail?: string };

      if (!submit.ok) {
        throw new Error(parseError(payload, 'Failed to submit training job.'));
      }

      const jobId = (payload as { job?: { id?: string } })?.job?.id;
      if (!jobId) {
        throw new Error('Training response did not include a job id.');
      }

      set({ activeJobId: jobId });
      useStatusBarStore.getState().setText(`TRAINING JOB QUEUED: ${jobId.slice(0, 8)}`);

      while (true) {
        const active = get().activeJobId;
        if (!active || active !== jobId) {
          return;
        }

        const res = await fetch(`/api/jobs/${jobId}`);
        const job = (await res.json()) as {
          status?: string;
          logs?: string[];
          returncode?: number;
        };

        if (!res.ok) {
          throw new Error('Failed to poll training job status.');
        }

        set({ logs: job.logs ?? [] });

        if (job.status === 'queued' || job.status === 'running') {
          set({ isTraining: true });
          await wait(1000);
          continue;
        }

        if (job.status === 'completed') {
          set({ isTraining: false, activeJobId: null });
          useStatusBarStore.getState().setText('TRAINING JOB COMPLETED');
          await get().refreshJobs();
          return;
        }

        if (job.status === 'failed') {
          throw new Error('Training job failed. See console logs.');
        }

        throw new Error(`Unexpected training job status: ${job.status ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Training workflow failed.';
      set({ error: message, isTraining: false, activeJobId: null });
      useStatusBarStore.getState().setText(`TRAINING FAILED: ${message}`);
    }
  },

  startPreEncode: async ({ modelName, dataDir, outputPath }) => {
    const form = new FormData();
    form.append('model_name', modelName);
    form.append('data_dir', dataDir);
    form.append('output_path', outputPath);

    const response = await fetch('/api/jobs/pre-encode', { method: 'POST', body: form });
    const payload = (await response.json()) as { job?: { id?: string } } | { error?: string; detail?: string };

    if (!response.ok) {
      const message = parseError(payload, 'Pre-encode submission failed.');
      set({ error: message });
      useStatusBarStore.getState().setText(`PRE-ENCODE FAILED: ${message}`);
      return;
    }

    const jobId = (payload as { job?: { id?: string } })?.job?.id;
    set({ activeJobId: jobId ?? null });
    useStatusBarStore.getState().setText(`PRE-ENCODE JOB QUEUED${jobId ? `: ${jobId.slice(0, 8)}` : ''}`);
  },

  encodeAudioToLatents: async ({ modelName, audioFile }) => {
    const form = new FormData();
    form.append('model_name', modelName);
    form.append('audio', audioFile);

    const response = await fetch('/api/autoencoder/encode', {
      method: 'POST',
      body: form,
    });
    const payload = (await response.json()) as { latents_base64?: string; error?: string; detail?: string };

    if (!response.ok) {
      const message = parseError(payload, 'Autoencoder encode failed.');
      set({ error: message });
      useStatusBarStore.getState().setText(`AUTOENCODE FAILED: ${message}`);
      return;
    }

    if (!payload.latents_base64) {
      const message = 'Encode completed without latents payload.';
      set({ error: message });
      useStatusBarStore.getState().setText(`AUTOENCODE FAILED: ${message}`);
      return;
    }

    set({ encodedLatentsBase64: payload.latents_base64, error: null });
    useStatusBarStore.getState().setText('AUTOENCODE COMPLETE');
  },

  decodeLatentsToAudio: async ({ modelName, fileFormat = 'wav' }) => {
    const latents = get().encodedLatentsBase64;
    if (!latents) {
      const message = 'No encoded latents available for decode.';
      set({ error: message });
      useStatusBarStore.getState().setText(`AUTODECODE FAILED: ${message}`);
      return;
    }

    const existing = get().decodedAudioUrl;
    if (existing) {
      URL.revokeObjectURL(existing);
    }

    const form = new FormData();
    form.append('model_name', modelName);
    form.append('file_format', fileFormat);
    form.append('latents_base64', latents);

    const response = await fetch('/api/autoencoder/decode', {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const message = await (async () => {
        try {
          const payload = (await response.json()) as { error?: string; detail?: string };
          return parseError(payload, 'Autoencoder decode failed.');
        } catch {
          return 'Autoencoder decode failed.';
        }
      })();
      set({ error: message });
      useStatusBarStore.getState().setText(`AUTODECODE FAILED: ${message}`);
      return;
    }

    const blob = await response.blob();
    const decodedAudioUrl = URL.createObjectURL(blob);
    set({ decodedAudioUrl, error: null });
    useStatusBarStore.getState().setText('AUTODECODE COMPLETE');
  },

  clearDecodedAudio: () => {
    const existing = get().decodedAudioUrl;
    if (existing) {
      URL.revokeObjectURL(existing);
    }
    set({ decodedAudioUrl: null });
  },

  stopPolling: () => {
    set({ activeJobId: null, isTraining: false });
    useStatusBarStore.getState().setText('TRAINING POLLING STOPPED');
  },
}));
