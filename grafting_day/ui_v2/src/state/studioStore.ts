import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';

interface StudioHistoryEntry {
  id: string;
  effect: string;
  format: string;
  createdAt: number;
}

interface StudioStoreState {
  sourceFile: File | null;
  outputUrl: string | null;
  outputFormat: string;
  isProcessing: boolean;
  error: string | null;
  processHistory: StudioHistoryEntry[];
  setSourceFile: (file: File | null) => void;
  setOutputFormat: (format: string) => void;
  processAudio: (payload: { effect: string; params: Record<string, number> }) => Promise<void>;
  reuseOutputAsSource: () => Promise<void>;
  clearOutput: () => void;
}

const parseErrorText = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { detail?: string; error?: string };
    return payload.detail || payload.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

export const useStudioStore = create<StudioStoreState>()((set, get) => ({
  sourceFile: null,
  outputUrl: null,
  outputFormat: 'wav',
  isProcessing: false,
  error: null,
  processHistory: [],

  setSourceFile: (file) => {
    set({ sourceFile: file });
    useStatusBarStore.getState().setText(file ? `STUDIO SOURCE LOADED: ${file.name}` : 'STUDIO SOURCE CLEARED');
  },

  setOutputFormat: (format) => {
    set({ outputFormat: format });
  },

  processAudio: async ({ effect, params }) => {
    const source = get().sourceFile;
    if (!source) {
      const message = 'Load a source audio file before processing.';
      set({ error: message });
      useStatusBarStore.getState().setText(`STUDIO FAILED: ${message}`);
      return;
    }

    const previous = get().outputUrl;
    if (previous) {
      URL.revokeObjectURL(previous);
    }

    set({ isProcessing: true, error: null });
    useStatusBarStore.getState().setText(`STUDIO PROCESS STARTED: ${effect}`);

    const form = new FormData();
    form.append('audio', source);
    form.append('effect', effect);
    form.append('params', JSON.stringify(params));
    form.append('output_format', get().outputFormat);

    try {
      const response = await fetch('/api/studio/process', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        throw new Error(await parseErrorText(response));
      }

      const blob = await response.blob();
      const outputUrl = URL.createObjectURL(blob);
      const nextEntry: StudioHistoryEntry = {
        id: crypto.randomUUID(),
        effect,
        format: get().outputFormat,
        createdAt: Date.now(),
      };

      set((state) => ({
        isProcessing: false,
        outputUrl,
        processHistory: [nextEntry, ...state.processHistory].slice(0, 8),
        error: null,
      }));
      useStatusBarStore.getState().setText(`STUDIO PROCESS COMPLETE: ${effect}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Studio process failed.';
      set({ isProcessing: false, error: message });
      useStatusBarStore.getState().setText(`STUDIO PROCESS FAILED: ${message}`);
    }
  },

  reuseOutputAsSource: async () => {
    const output = get().outputUrl;
    if (!output) {
      return;
    }

    const response = await fetch(output);
    const blob = await response.blob();
    const sourceFile = new File([blob], `studio-output.${get().outputFormat}`, { type: blob.type || 'audio/wav' });
    set({ sourceFile });
    useStatusBarStore.getState().setText('STUDIO OUTPUT PROMOTED TO SOURCE');
  },

  clearOutput: () => {
    const output = get().outputUrl;
    if (output) {
      URL.revokeObjectURL(output);
    }
    set({ outputUrl: null, error: null });
    useStatusBarStore.getState().setText('STUDIO OUTPUT CLEARED');
  },
}));
