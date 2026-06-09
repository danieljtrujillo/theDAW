/**
 * sunoStore — state for the Suno generation panel.
 *
 * Integration model (CHANGED from the old StableDAW): the BACKEND owns
 * persistence. When a Suno job completes, the backend has ALREADY registered
 * it into the library on disk. The frontend's only job on completion is to
 * call `useLibraryStore.getState().refresh()` so the new track shows up
 * everywhere (Library dock, etc.).
 *
 * There is NO IndexedDB, NO blob promotion, NO catalog bridge, and NO
 * pendingParent lineage hand-off here anymore — all of that moved server-side.
 *
 * This store holds: the form state per mode, the job list, api-config status,
 * usage, and a submitting flag. It polls each non-terminal job every 3s.
 */

import { create } from 'zustand';
import { sunoApi, type SunoJob } from './sunoApi';
import { useLibraryStore } from '../state/libraryStore';
import { logError, logInfo } from '../state/logStore';

export type SunoMode = 'simple' | 'custom' | 'cover' | 'mashup';

interface SunoFormState {
  mode: SunoMode;
  description: string;
  title: string;
  lyrics: string;
  style: string;
  voiceId: string;
  instrumental: boolean;
  sourceId: string;
  additionalAudioId: string;
}

const EMPTY_FORM: Omit<SunoFormState, 'mode'> = {
  description: '',
  title: '',
  lyrics: '',
  style: '',
  voiceId: '',
  instrumental: false,
  sourceId: '',
  additionalAudioId: '',
};

// Active poll timers, keyed by job id (module-level so they survive re-renders).
const _timers = new Map<string, ReturnType<typeof setInterval>>();
// Jobs whose completion we've already handled (dedupe the library.refresh()).
const _refreshed = new Set<string>();

// CHANGED: clear stale timers on Vite HMR so duplicate intervals don't pile up
// across hot-reloads (each reload recreates the store but the old Map/Set survive).
{
  const hot = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot;
  if (hot) {
    hot.dispose(() => {
      _timers.forEach((t) => clearInterval(t));
      _timers.clear();
      _refreshed.clear();
    });
  }
}

interface SunoState extends SunoFormState {
  jobs: SunoJob[];
  /** null = unknown (not yet checked), true/false = backend key state. */
  apiConfigured: boolean | null;
  usage: Record<string, any> | null;
  submitting: boolean;

  patch: (p: Partial<SunoFormState>) => void;
  setMode: (mode: SunoMode) => void;
  resetForm: () => void;

  checkStatus: () => Promise<void>;
  setKey: (key: string) => Promise<void>;
  loadJobs: () => Promise<void>;
  loadUsage: () => Promise<void>;
  loadVoices: () => Promise<void>;

  submit: () => Promise<void>;
  startPolling: (id: string) => void;

  /** Prefill cover/mashup from an existing Suno clip (used by sunoActions). */
  prefillCover: (sourceId: string) => void;
  prefillMashup: (sourceId: string, additionalAudioId?: string) => void;
}

export const useSunoStore = create<SunoState>()((set, get) => ({
  mode: 'simple',
  ...EMPTY_FORM,
  jobs: [],
  apiConfigured: null,
  usage: null,
  submitting: false,

  patch: (p) => set(p),
  setMode: (mode) => set({ mode }),
  resetForm: () => set({ ...EMPTY_FORM }),

  checkStatus: async () => {
    try {
      const r = await sunoApi.getStatus();
      set({ apiConfigured: r.configured });
    } catch {
      set({ apiConfigured: false });
    }
  },

  setKey: async (key) => {
    try {
      await sunoApi.setKey(key.trim());
      set({ apiConfigured: true });
      logInfo('suno', 'API key saved');
    } catch (e) {
      logError('suno', `Failed to save key: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  },

  loadJobs: async () => {
    try {
      const { jobs } = await sunoApi.listJobs();
      const sorted = [...jobs].sort((a, b) =>
        (b.created_at ?? '').localeCompare(a.created_at ?? ''),
      );
      set({ jobs: sorted });
      // Resume polling any jobs still in flight.
      sorted.forEach((j) => {
        if (j.status !== 'complete' && j.status !== 'error') get().startPolling(j.id);
      });
    } catch {
      /* no jobs yet — fine */
    }
  },

  loadUsage: async () => {
    try {
      set({ usage: await sunoApi.usage() });
    } catch {
      /* ignore */
    }
  },

  loadVoices: async () => {
    // Voices are static constants in the UI; this just warms the endpoint.
    try {
      await sunoApi.getVoices();
    } catch {
      /* ignore */
    }
  },

  submit: async () => {
    if (get().submitting) return;
    const s = get();
    set({ submitting: true });
    try {
      let job: SunoJob;
      switch (s.mode) {
        case 'simple':
          if (!s.description.trim()) throw new Error('Description is required.');
          job = await sunoApi.simple({
            description: s.description.trim(),
            title: s.title.trim() || undefined,
            voice_id: s.voiceId || undefined,
          });
          break;
        case 'custom':
          if (!s.style.trim()) throw new Error('Style is required.');
          if (!s.instrumental && !s.lyrics.trim())
            throw new Error('Lyrics are required (or enable Instrumental).');
          job = await sunoApi.custom({
            style: s.style.trim(),
            lyrics: s.instrumental ? undefined : s.lyrics.trim(),
            title: s.title.trim() || undefined,
            voice_id: s.voiceId || undefined,
            instrumental: s.instrumental,
          });
          break;
        case 'cover':
          if (!s.sourceId.trim()) throw new Error('Source clip ID is required.');
          job = await sunoApi.cover({
            source_id: s.sourceId.trim(),
            lyrics: s.lyrics.trim() || undefined,
            style: s.style.trim() || undefined,
            voice_id: s.voiceId || undefined,
          });
          break;
        case 'mashup':
          if (!s.sourceId.trim() || !s.additionalAudioId.trim())
            throw new Error('Both clip IDs are required.');
          job = await sunoApi.mashup({
            source_id: s.sourceId.trim(),
            additional_audio_id: s.additionalAudioId.trim(),
            lyrics: s.lyrics.trim() || undefined,
            style: s.style.trim() || undefined,
            title: s.title.trim() || undefined,
          });
          break;
        default:
          throw new Error('Unknown mode.');
      }

      set((st) => ({ jobs: [job, ...st.jobs.filter((j) => j.id !== job.id)] }));
      get().startPolling(job.id);
      get().resetForm();
      void get().loadUsage();
      logInfo('suno', `Submitted ${s.mode} job ${job.id.slice(0, 8)}`);
    } catch (e) {
      logError('suno', `Generate failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      set({ submitting: false });
    }
  },

  startPolling: (id) => {
    if (_timers.has(id)) return;
    const timer = setInterval(async () => {
      try {
        const updated = await sunoApi.poll(id);
        set((st) => {
          const idx = st.jobs.findIndex((j) => j.id === id);
          if (idx === -1) return { jobs: [updated, ...st.jobs] };
          const next = [...st.jobs];
          next[idx] = updated;
          return { jobs: next };
        });
        if (updated.status === 'complete') {
          clearInterval(timer);
          _timers.delete(id);
          // The backend already registered this clip in the library — just
          // refresh the library store so it appears everywhere.
          if (!_refreshed.has(id)) {
            _refreshed.add(id);
            void useLibraryStore
              .getState()
              .refresh()
              .then(() =>
                logInfo('suno', `Job ${id.slice(0, 8)} complete — library refreshed`),
              )
              .catch(() => _refreshed.delete(id)); // allow a retry on next poll
          }
        } else if (updated.status === 'error') {
          clearInterval(timer);
          _timers.delete(id);
          logError('suno', `Job ${id.slice(0, 8)} failed: ${updated.error || 'unknown'}`);
        }
      } catch {
        /* transient — keep polling */
      }
    }, 3000);
    _timers.set(id, timer);
  },

  prefillCover: (sourceId) => set({ ...EMPTY_FORM, mode: 'cover', sourceId }),
  prefillMashup: (sourceId, additionalAudioId = '') =>
    set({ ...EMPTY_FORM, mode: 'mashup', sourceId, additionalAudioId }),
}));
