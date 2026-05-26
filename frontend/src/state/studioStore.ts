import { create } from 'zustand';
import { useStatusBarStore } from './statusBarStore';
import { logError, logInfo } from './logStore';
import { uuid } from '../orb-kit/utils';
import { useLibraryStore } from './libraryStore';
import { usePlayerStore } from './playerStore';

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
  // Pending action kept in sync by StudioView so GlobalGenerateBar can fire without local state.
  pendingEffect: string;
  pendingParams: Record<string, number>;
  setSourceFile: (file: File | null) => void;
  setOutputFormat: (format: string) => void;
  setPendingAction: (effect: string, params: Record<string, number>) => void;
  processAudio: (payload: { effect: string; params: Record<string, number>; skipLibrary?: boolean }) => Promise<void>;
  triggerPendingProcess: () => Promise<void>;
  reuseOutputAsSource: () => Promise<void>;
  clearOutput: () => void;
}

const parseErrorText = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    // Guard against non-JSON responses (e.g. Vite returning HTML for
    // unmatched routes when the backend is down).
    if (text.startsWith('<') || text.startsWith('<!')) {
      return `Backend returned HTML instead of JSON (HTTP ${response.status}). Is the backend running on port 8600?`;
    }
    const payload = JSON.parse(text) as { detail?: string; error?: string };
    return payload.detail || payload.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

/** Fetch with an AbortController timeout (default 10 minutes). */
const fetchWithTimeout = (input: RequestInfo | URL, init?: RequestInit, timeoutMs = 600_000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const useStudioStore = create<StudioStoreState>()((set, get) => ({
  sourceFile: null,
  outputUrl: null,
  outputFormat: 'wav',
  isProcessing: false,
  error: null,
  processHistory: [],
  pendingEffect: 'mastering_chain',
  pendingParams: { lowBoost: 0, highBoost: 0, limiterCeiling: 0.95, targetLUFS: -14 },

  setSourceFile: (file) => {
    set({ sourceFile: file });
    useStatusBarStore.getState().setText(file ? `STUDIO SOURCE LOADED: ${file.name}` : 'STUDIO SOURCE CLEARED');
  },

  setOutputFormat: (format) => {
    set({ outputFormat: format });
  },

  setPendingAction: (effect, params) => {
    set({ pendingEffect: effect, pendingParams: params });
  },

  triggerPendingProcess: async () => {
    const { pendingEffect, pendingParams, processAudio } = get();
    await processAudio({ effect: pendingEffect, params: pendingParams });
  },

  processAudio: async ({ effect, params, skipLibrary }) => {
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

    set({ isProcessing: true, error: null, outputUrl: null });
    useStatusBarStore.getState().setText(`STUDIO PROCESS STARTED: ${effect}`);
    logInfo('studio', `Processing: effect=${effect} format=${get().outputFormat} source=${source.name} (${Math.round(source.size / 1024)}KB)`);

    const form = new FormData();
    form.append('audio', source);
    form.append('effect', effect);
    form.append('params', JSON.stringify(params));
    form.append('output_format', get().outputFormat);

    try {
      logInfo('studio', `POST /api/studio/process — effect=${effect} params=${JSON.stringify(params)}`);
      const response = await fetchWithTimeout('/api/studio/process', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const detail = await parseErrorText(response);
        logError('studio', `POST /api/studio/process → ${response.status} ${response.statusText} — ${detail}`);
        throw new Error(detail);
      }

      // Guard: make sure we actually got audio back, not HTML from Vite's
      // SPA fallback (which would happen if the proxy silently failed).
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const msg = 'Backend returned HTML instead of audio. Is the backend running on port 8600?';
        logError('studio', msg);
        throw new Error(msg);
      }

      const blob = await response.blob();
      logInfo('studio', `POST /api/studio/process → 200 OK — ${Math.round(blob.size / 1024)}KB ${get().outputFormat}`);
      const outputUrl = URL.createObjectURL(blob);
      const nextEntry: StudioHistoryEntry = {
        id: uuid(),
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

      if (!skipLibrary) {
        const fmt = get().outputFormat;
        const title = `studio-${effect}.${fmt}`;
        try {
          const entry = await useLibraryStore.getState().importEntry({
            blob,
            filename: title,
            mimeType: blob.type || 'audio/wav',
            metadata: {
              title,
              prompt: `Effect: ${effect}`,
              model: effect,
              source: 'studio',
              tags: ['studio', effect],
            },
          });
          await usePlayerStore.getState().load(blob, { label: title, entryId: entry.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError('studio', `Library save failed: ${msg}`);
          useStatusBarStore
            .getState()
            .setText(`STUDIO LIBRARY SAVE FAILED — check Processing Log: ${msg}`);
          // Best-effort: still play it in the footer so user can review.
          try {
            await usePlayerStore.getState().load(blob, { label: title, entryId: `studio-fail-${Date.now()}` });
          } catch { /* swallow */ }
        }
      }
    } catch (error) {
      let message: string;
      if (error instanceof DOMException && error.name === 'AbortError') {
        message = 'Effect processing timed out after 10 minutes. Try a shorter audio file or simpler effect.';
      } else if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
        message = 'Network error — the backend may not be running on port 8600, or the response was interrupted. Restart the backend and try again.';
      } else {
        message = error instanceof Error ? error.message : 'Studio process failed.';
      }
      set({ isProcessing: false, error: message });
      useStatusBarStore.getState().setText(`STUDIO PROCESS FAILED: ${message}`);
      logError('studio', `effect=${effect} FAILED — ${message}`);
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
