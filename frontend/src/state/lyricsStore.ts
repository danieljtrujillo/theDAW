/**
 * lyricsStore - the SING tab's document and its jobs.
 *
 * One entry at a time: `load(entryId)` fetches the LyricsBundle, edits go
 * through `setDoc` (debounced PUT of the whole document) or `setText`
 * (immediate PUT; the server carries timings over by line diff), and the
 * whisper jobs (transcribe / align / sidecar install) are polled into `job`.
 * The small view preferences (follow, pitch lane, mic offset) persist in
 * localStorage; everything else is session state.
 */
import { create } from 'zustand';
import {
  fetchActiveLyricsJob,
  deleteLyrics,
  fetchLyrics,
  fetchTranscriptionProbe,
  importLyrics,
  LyricsUnavailableError,
  pollLyricsJob,
  pollVocalJob,
  putLyrics,
  startAlign,
  startTranscribe,
  startTranscriptionInstall,
  type LyricsDoc,
  type LyricsJobStatus,
} from '../lib/lyricsClient';
import { assignTap, nextUntimedLine, nudgeLine, unstamp } from '../components/layout/sing/singSync';
import { useLibraryStore } from './libraryStore';
import { logError, logInfo } from './logStore';

export type JobKind = 'transcribe' | 'align' | 'install';

export interface LyricsJobState {
  id: string;
  kind: JobKind;
  status: LyricsJobStatus;
  message: string;
  progress: number;
}

export type TranscriptionState = 'unknown' | 'ready' | 'missing';

const SAVE_DEBOUNCE_MS = 800;
const SNAPSHOT_DEPTH = 32;
const KEY_FOLLOW = 'sing.follow';
const KEY_PITCH = 'sing.showPitch';
const KEY_MIC_OFFSET = 'sing.micOffsetMs';
const KEY_LANGUAGE = 'sing.language';
const KEY_AUTO_ALIGN = 'sing.autoAlign';

/** Whisper language codes offered in the picker; 'auto' lets whisper detect. */
export const SING_LANGUAGES: Array<[string, string]> = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'],
  ['th', 'Thai'], ['id', 'Indonesian'], ['tl', 'Tagalog'], ['el', 'Greek'], ['fi', 'Finnish'],
];
const readString = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const readNumber = (key: string, fallback: number): number => {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && localStorage.getItem(key) !== null ? v : fallback;
  } catch {
    return fallback;
  }
};
const writeStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
};

export interface LyricsState {
  entryId: string | null;
  doc: LyricsDoc | null;
  persisted: boolean;
  notesCandidate: string | null;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  job: LyricsJobState | null;
  follow: boolean;
  tapMode: boolean;
  showPitch: boolean;
  micOn: boolean;
  micOffsetMs: number;
  /** Whisper language for transcribe / align; 'auto' detects. */
  language: string;
  /** Time the words automatically when a song opens with lyrics but no timings. */
  autoAlign: boolean;
  transcription: TranscriptionState;
  /** Doc line index of the last tapped line; the next tap goes after it. */
  lastTapped: number;

  load: (entryId: string) => Promise<void>;
  setDoc: (next: LyricsDoc) => void;
  saveNow: () => Promise<void>;
  flush: () => Promise<void>;
  setText: (text: string) => Promise<void>;
  useNotesAsLyrics: () => Promise<void>;
  tap: (posMs: number) => void;
  undoTap: () => void;
  nudge: (lineIdx: number, deltaMs: number) => void;
  setOffset: (ms: number) => void;
  setFollow: (on: boolean) => void;
  setTapMode: (on: boolean) => void;
  setShowPitch: (on: boolean) => void;
  setMicOn: (on: boolean) => void;
  setMicOffsetMs: (ms: number) => void;
  setLanguage: (code: string) => void;
  setAutoAlign: (on: boolean) => void;
  /** ALIGN without a click: the doc has words but no times, whisper is
   *  installed, nothing is running. Joins a job the auto pipeline started. */
  maybeAutoAlign: () => Promise<void>;
  probeTranscription: () => Promise<void>;
  installTranscription: () => Promise<void>;
  runTranscribe: () => Promise<void>;
  runAlign: () => Promise<void>;
  importText: (format: 'lrc' | 'txt', content: string) => Promise<void>;
  removeTimings: () => Promise<void>;
  clearError: () => void;
}

// Module-level plumbing for the debounced save: one timer, one in-flight
// promise (so flush() can await it), one generation counter for load().
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let loadGeneration = 0;
let snapshots: Array<{ doc: LyricsDoc; lastTapped: number }> = [];

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const patchLibraryEntry = (entryId: string, lyrics: string): void => {
  useLibraryStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === entryId ? { ...e, lyrics } : e)),
  }));
};

export const useLyricsStore = create<LyricsState>()((set, get) => {
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void get().saveNow();
    }, SAVE_DEBOUNCE_MS);
  };

  const trackJob = async (
    kind: JobKind,
    jobId: string,
    poll: typeof pollLyricsJob,
  ): Promise<LyricsDoc | null> => {
    set({ job: { id: jobId, kind, status: 'queued', message: 'queued', progress: 0 } });
    const job = await poll(jobId, (j) => {
      set({ job: { id: j.id, kind, status: j.status, message: j.message, progress: j.progress } });
    });
    if (job.status !== 'done') {
      set({ error: job.error || job.message || `${kind} failed`, job: null });
      return null;
    }
    set({ job: null });
    return job.result;
  };

  return {
    entryId: null,
    doc: null,
    persisted: false,
    notesCandidate: null,
    loading: false,
    dirty: false,
    saving: false,
    error: null,
    job: null,
    follow: readBool(KEY_FOLLOW, true),
    tapMode: false,
    showPitch: readBool(KEY_PITCH, false),
    micOn: false,
    micOffsetMs: readNumber(KEY_MIC_OFFSET, 20),
    language: readString(KEY_LANGUAGE, 'auto'),
    autoAlign: readBool(KEY_AUTO_ALIGN, true),
    transcription: 'unknown',
    lastTapped: -1,

    load: async (entryId) => {
      const generation = ++loadGeneration;
      if (get().dirty && get().entryId && get().entryId !== entryId) await get().flush();
      snapshots = [];
      set({ entryId, loading: true, error: null, tapMode: false, lastTapped: -1, job: null });
      try {
        const bundle = await fetchLyrics(entryId);
        if (generation !== loadGeneration) return;
        set({
          doc: bundle.doc,
          persisted: bundle.persisted,
          notesCandidate: bundle.notes_candidate,
          loading: false,
          dirty: false,
        });
        void get().maybeAutoAlign();
      } catch (e) {
        if (generation !== loadGeneration) return;
        set({ doc: null, loading: false, error: errorMessage(e) });
      }
    },

    setDoc: (next) => {
      set({ doc: next, dirty: true });
      scheduleSave();
    },

    saveNow: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (inflight) await inflight;
      const { doc, entryId, dirty } = get();
      if (!doc || !entryId || !dirty) return;
      const sent = doc;
      set({ saving: true });
      inflight = (async () => {
        try {
          const saved = await putLyrics(entryId, {
            lines: sent.lines,
            offset_ms: sent.offset_ms,
            language: sent.language,
            source: sent.source,
          });
          if (get().entryId !== entryId) return;
          // Edits made while the PUT was in flight stay dirty.
          const stillDirty = get().doc !== sent;
          set({ doc: stillDirty ? get().doc : saved, dirty: stillDirty, persisted: true, error: null });
          patchLibraryEntry(entryId, saved.text);
          if (stillDirty) scheduleSave();
        } catch (e) {
          set({ error: `Lyrics not saved: ${errorMessage(e)}` });
          logError('sing', `Lyrics save failed: ${errorMessage(e)}`);
        } finally {
          set({ saving: false });
          inflight = null;
        }
      })();
      await inflight;
    },

    flush: async () => {
      await get().saveNow();
    },

    setText: async (text) => {
      const { entryId } = get();
      if (!entryId) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (inflight) await inflight;
      set({ saving: true, error: null });
      try {
        const saved = await putLyrics(entryId, { text });
        if (get().entryId !== entryId) return;
        snapshots = [];
        set({ doc: saved, dirty: false, persisted: true, lastTapped: -1 });
        patchLibraryEntry(entryId, saved.text);
      } catch (e) {
        set({ error: `Lyrics not saved: ${errorMessage(e)}` });
      } finally {
        set({ saving: false });
      }
    },

    useNotesAsLyrics: async () => {
      const notes = get().notesCandidate;
      if (notes) await get().setText(notes);
    },

    tap: (posMs) => {
      const { doc, lastTapped } = get();
      if (!doc) return;
      const target = nextUntimedLine(doc, lastTapped);
      if (target < 0) return;
      snapshots.push({ doc, lastTapped });
      if (snapshots.length > SNAPSHOT_DEPTH) snapshots.shift();
      const next = assignTap(doc, target, posMs);
      if (!next.source || next.source === 'manual' || next.source === 'suno' || next.source === 'tags' || next.source === 'embedded' || next.source === 'notes') {
        next.source = 'tap';
      }
      set({ lastTapped: target });
      get().setDoc(next);
    },

    undoTap: () => {
      const snap = snapshots.pop();
      if (!snap) return;
      set({ lastTapped: snap.lastTapped });
      get().setDoc(snap.doc);
    },

    nudge: (lineIdx, deltaMs) => {
      const { doc } = get();
      if (!doc) return;
      get().setDoc(nudgeLine(doc, lineIdx, deltaMs));
    },

    setOffset: (ms) => {
      const { doc } = get();
      if (!doc) return;
      const offset = Math.round(Number.isFinite(ms) ? ms : 0);
      if (offset === doc.offset_ms) return;
      get().setDoc({ ...doc, offset_ms: offset });
    },

    setFollow: (on) => {
      set({ follow: on });
      writeStorage(KEY_FOLLOW, on ? '1' : '0');
    },
    setTapMode: (on) => set({ tapMode: on }),
    setShowPitch: (on) => {
      set({ showPitch: on });
      writeStorage(KEY_PITCH, on ? '1' : '0');
    },
    setMicOn: (on) => set({ micOn: on }),
    setMicOffsetMs: (ms) => {
      const v = Math.round(Number.isFinite(ms) ? ms : 0);
      set({ micOffsetMs: v });
      writeStorage(KEY_MIC_OFFSET, String(v));
    },
    setLanguage: (code) => {
      const v = (code || 'auto').trim().toLowerCase();
      set({ language: v });
      writeStorage(KEY_LANGUAGE, v);
    },

    setAutoAlign: (on) => {
      set({ autoAlign: on });
      writeStorage(KEY_AUTO_ALIGN, on ? '1' : '0');
      if (on) void get().maybeAutoAlign();
    },

    maybeAutoAlign: async () => {
      const { entryId, doc, job, transcription, autoAlign } = get();
      if (!entryId || !doc || job) return;
      const hasText = doc.text.trim().length > 0;
      const timed = doc.lines.some((l) => l.start_ms !== null);
      // A job the import pipeline started for this song is picked up whether
      // or not auto-align is on: its result belongs on screen either way.
      try {
        const running = await fetchActiveLyricsJob(entryId);
        if (running && get().entryId === entryId && !get().job) {
          const kind: JobKind = /transcribe/i.test(running.message) || !hasText ? 'transcribe' : 'align';
          const result = await trackJob(kind, running.id, pollLyricsJob);
          if (result && get().entryId === entryId) {
            snapshots = [];
            set({ doc: result, dirty: false, persisted: true, lastTapped: -1 });
            patchLibraryEntry(entryId, result.text);
          }
          return;
        }
      } catch {
        /* no job to join */
      }
      if (!autoAlign || !hasText || timed || transcription !== 'ready') return;
      logInfo('sing', 'Timing the lyrics against the vocal (auto-align)');
      await get().runAlign();
    },

    probeTranscription: async () => {
      try {
        const probe = await fetchTranscriptionProbe();
        set({ transcription: probe.critical_ok ? 'ready' : 'missing' });
      } catch {
        set({ transcription: 'missing' });
      }
      if (get().transcription === 'ready') void get().maybeAutoAlign();
    },

    installTranscription: async () => {
      if (get().job) return;
      set({ error: null });
      try {
        const { jobId } = await startTranscriptionInstall();
        const result = await trackJob('install', jobId, pollVocalJob);
        if (result !== null || get().job === null) {
          await get().probeTranscription();
          if (get().transcription === 'ready') logInfo('sing', 'Transcription sidecar installed');
        }
      } catch (e) {
        set({ error: errorMessage(e), job: null });
      }
    },

    runTranscribe: async () => {
      const { entryId } = get();
      if (!entryId || get().job) return;
      await get().flush();
      set({ error: null });
      try {
        const { jobId } = await startTranscribe(entryId, { isolate: true, language: get().language });
        const result = await trackJob('transcribe', jobId, pollLyricsJob);
        if (result && get().entryId === entryId) {
          snapshots = [];
          set({ doc: result, dirty: false, persisted: true, lastTapped: -1 });
          patchLibraryEntry(entryId, result.text);
        }
      } catch (e) {
        if (e instanceof LyricsUnavailableError) set({ transcription: 'missing', job: null });
        else set({ error: errorMessage(e), job: null });
      }
    },

    runAlign: async () => {
      const { entryId, doc } = get();
      if (!entryId || get().job) return;
      await get().flush();
      set({ error: null });
      try {
        const { jobId } = await startAlign(entryId, { isolate: true, language: get().language, text: doc?.text || undefined });
        const result = await trackJob('align', jobId, pollLyricsJob);
        if (result && get().entryId === entryId) {
          snapshots = [];
          set({ doc: result, dirty: false, persisted: true, lastTapped: -1 });
          patchLibraryEntry(entryId, result.text);
          // The review pass (whisper underlining what it heard differently)
          // runs as its own job after a forced alignment: pick it up.
          void get().maybeAutoAlign();
        }
      } catch (e) {
        if (e instanceof LyricsUnavailableError) set({ transcription: 'missing', job: null });
        else set({ error: errorMessage(e), job: null });
      }
    },

    importText: async (format, content) => {
      const { entryId } = get();
      if (!entryId) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (inflight) await inflight;
      set({ saving: true, error: null });
      try {
        const saved = await importLyrics(entryId, format, content);
        if (get().entryId !== entryId) return;
        snapshots = [];
        set({ doc: saved, dirty: false, persisted: true, lastTapped: -1 });
        patchLibraryEntry(entryId, saved.text);
      } catch (e) {
        set({ error: `Import failed: ${errorMessage(e)}` });
      } finally {
        set({ saving: false });
      }
    },

    removeTimings: async () => {
      const { entryId } = get();
      if (!entryId) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (inflight) await inflight;
      set({ dirty: false, error: null });
      try {
        await deleteLyrics(entryId);
        const bundle = await fetchLyrics(entryId);
        if (get().entryId !== entryId) return;
        snapshots = [];
        set({ doc: bundle.doc, persisted: bundle.persisted, notesCandidate: bundle.notes_candidate, lastTapped: -1 });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    clearError: () => set({ error: null }),
  };
});
