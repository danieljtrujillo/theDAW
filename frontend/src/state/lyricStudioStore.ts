/**
 * lyricStudioStore — the LYRIC tab's notebook: lyrics written for their own
 * sake, with no library entry attached.
 *
 * One document at a time. `init()` lists the notebook and opens the last one
 * used, `setDraft()` is every keystroke, and two independent debounces hang off
 * it: the PUT that persists the words, and the analysis pass. They are separate
 * on purpose — saving is cheap and should happen often, while analysing is CPU
 * work on the backend (phonetics for every word) and must never run per
 * keystroke.
 *
 * The draft is also mirrored into localStorage on every change, so a reload
 * before the first save comes back to the words rather than to an empty page.
 *
 * Two passes produce the analysis, and this store owns both:
 *   - `analyzeNow` is the debounced live one — POST /analyze, nothing stored,
 *     no job, the deterministic detectors only;
 *   - `runAnalysis` is the explicit ANALYSE click — a real job against the
 *     saved document, which persists the result beside it and can carry the
 *     interpretive pass.
 * The analysis pane is handed the result through its `analysis` prop, so
 * `lyricAnalysisStore` (the karaoke's own document) is never written to here;
 * only the LLM preferences are read from it, because they are the pane's.
 */
import { create } from 'zustand';
import {
  analyzeLyricText,
  pollLyricAnalysisJob,
  startLyricAnalysis,
  type LyricAnalysisDoc,
} from '../lib/lyricAnalysisClient';
import { fetchLyrics, putLyrics } from '../lib/lyricsClient';
import { splitLyricLines } from '../components/layout/lyricstudio/lyricLines';
import { useLyricAnalysisStore } from './lyricAnalysisStore';
import {
  attachLyricDocument,
  createLyricDocument,
  deleteLyricDocument,
  duplicateLyricDocument,
  fetchLyricDocument,
  fetchLyricDocuments,
  updateLyricDocument,
  type LyricDocumentSummary,
} from '../components/layout/lyricstudio/lyricDocumentsClient';

/** Long enough that a fast typist never triggers a save mid-word. */
const SAVE_DEBOUNCE_MS = 700;
/** Analysis is a full phonetic pass on the backend; it waits for a real pause. */
const ANALYZE_DEBOUNCE_MS = 1400;

const KEY_DOC_ID = 'lyricStudio.docId';
const draftKey = (id: string): string => `lyricStudio.draft.${id}`;

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
};
const dropStorage = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode / quota */
  }
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface LyricStudioState {
  documents: LyricDocumentSummary[];
  docId: string | null;
  title: string;
  draft: string;
  /** The song this draft was saved into, or null while it belongs to none. */
  entryId: string | null;
  loading: boolean;
  saving: boolean;
  /** The draft differs from what the server holds. */
  dirty: boolean;
  error: string | null;

  analysis: LyricAnalysisDoc | null;
  /** The exact text `analysis` describes, so the UI can say when it is behind. */
  analyzedText: string;
  analyzing: boolean;
  analysisError: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string) => Promise<void>;
  createDoc: (seed?: { title?: string; text?: string; entryId?: string }) => Promise<void>;
  duplicateDoc: (id: string) => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  setDraft: (text: string) => void;
  setTitle: (title: string) => void;
  saveNow: () => Promise<void>;
  analyzeNow: () => Promise<void>;
  runAnalysis: () => Promise<void>;
  importFromEntry: (entryId: string, title: string) => Promise<void>;
  attachToEntry: (entryId: string) => Promise<void>;
  detach: () => Promise<void>;
  clearError: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let analyzeTimer: ReturnType<typeof setTimeout> | null = null;
// One counter per concern: a slow analysis for the document the writer has
// since left must not land on the one now open, and neither must a slow load.
let loadGeneration = 0;
let analyzeGeneration = 0;
// The in-flight `init()`, so a double mount opens one draft rather than two.
let initInFlight: Promise<void> | null = null;

export const useLyricStudioStore = create<LyricStudioState>()((set, get) => {
  const cancelTimers = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    saveTimer = null;
    analyzeTimer = null;
  };

  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void get().saveNow();
    }, SAVE_DEBOUNCE_MS);
  };

  const scheduleAnalyze = (): void => {
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => {
      analyzeTimer = null;
      void get().analyzeNow();
    }, ANALYZE_DEBOUNCE_MS);
  };

  return {
    documents: [],
    docId: null,
    title: '',
    draft: '',
    entryId: null,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    analysis: null,
    analyzedText: '',
    analyzing: false,
    analysisError: null,

    init: async () => {
      // Opening the tab must not mint a draft per call. React runs a mount
      // effect twice in dev, and both passes see `docId: null` and both create
      // a blank page — one of which is then orphaned in the notebook forever.
      // Concurrent callers share the first call's work.
      if (initInFlight) return initInFlight;
      initInFlight = (async () => {
        try {
          await get().refresh();
          if (get().docId) return;
          const remembered = readStorage(KEY_DOC_ID);
          const documents = get().documents;
          const wanted = documents.find((d) => d.id === remembered) ?? documents[0];
          if (wanted) await get().select(wanted.id);
          else await get().createDoc();
        } finally {
          initInFlight = null;
        }
      })();
      return initInFlight;
    },

    refresh: async () => {
      try {
        set({ documents: await fetchLyricDocuments(), error: null });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    select: async (id) => {
      // Whatever is waiting on the save debounce belongs to the draft being
      // left, so it goes out before the id moves.
      await get().saveNow();
      const generation = ++loadGeneration;
      cancelTimers();
      set({
        docId: id,
        loading: true,
        error: null,
        analysis: null,
        analyzedText: '',
        analysisError: null,
      });
      writeStorage(KEY_DOC_ID, id);
      try {
        const doc = await fetchLyricDocument(id);
        if (generation !== loadGeneration) return;
        // A draft left in localStorage by a reload (or a save that never got
        // to leave) is newer than the stored copy by definition: the words the
        // writer last saw win, and are marked unsaved so the next PUT keeps them.
        const local = readStorage(draftKey(id));
        const unsaved = local !== null && local !== doc.text;
        set({
          title: doc.title,
          draft: unsaved ? local : doc.text,
          entryId: doc.entry_id || null,
          dirty: unsaved,
          loading: false,
        });
        if (unsaved) scheduleSave();
        scheduleAnalyze();
      } catch (e) {
        if (generation !== loadGeneration) return;
        set({ loading: false, error: errorMessage(e) });
      }
    },

    createDoc: async (seed = {}) => {
      try {
        const doc = await createLyricDocument({
          title: seed.title ?? '',
          text: seed.text ?? '',
          entry_id: seed.entryId ?? '',
        });
        dropStorage(draftKey(doc.id));
        await get().refresh();
        await get().select(doc.id);
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    duplicateDoc: async (id) => {
      try {
        await get().saveNow();
        const copy = await duplicateLyricDocument(id);
        await get().refresh();
        await get().select(copy.id);
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    removeDoc: async (id) => {
      try {
        await deleteLyricDocument(id);
        dropStorage(draftKey(id));
        if (get().docId === id) {
          cancelTimers();
          set({ docId: null, draft: '', title: '', entryId: null, dirty: false, analysis: null });
          dropStorage(KEY_DOC_ID);
        }
        await get().refresh();
        const next = get().documents[0];
        if (!get().docId) {
          if (next) await get().select(next.id);
          else await get().createDoc();
        }
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    setDraft: (text) => {
      const { docId } = get();
      set({ draft: text, dirty: true });
      if (docId) writeStorage(draftKey(docId), text);
      scheduleSave();
      scheduleAnalyze();
    },

    setTitle: (title) => {
      set({ title, dirty: true });
      scheduleSave();
    },

    saveNow: async () => {
      const { docId, draft, title, dirty } = get();
      if (!docId || !dirty) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      set({ saving: true, error: null });
      try {
        const doc = await updateLyricDocument(docId, { text: draft, title });
        // Only clear `dirty` when nothing was typed while the PUT was in
        // flight, or the newer keystrokes would never be saved.
        const current = get();
        const settled = current.docId === docId && current.draft === draft && current.title === title;
        set({ saving: false, dirty: settled ? false : current.dirty });
        if (settled) dropStorage(draftKey(docId));
        // The row carries the counts the switcher labels a draft with, and the
        // PUT answers with the document, not the summary — so recount here
        // rather than leave the dropdown reading "0 lines" for a full page.
        const lyricLines = splitLyricLines(doc.text).filter(
          (l) => l.kind === 'lyric' && l.text.trim(),
        );
        const lines = lyricLines.length;
        const words = lyricLines.reduce((sum, l) => sum + l.text.split(/\s+/).filter(Boolean).length, 0);
        set((s) => ({
          documents: s.documents.map((d) =>
            d.id === docId ? { ...d, title: doc.title, updated_at: doc.updated_at, lines, words } : d,
          ),
        }));
      } catch (e) {
        set({ saving: false, error: errorMessage(e) });
      }
    },

    analyzeNow: async () => {
      const { docId, draft } = get();
      if (!docId) return;
      if (analyzeTimer) {
        clearTimeout(analyzeTimer);
        analyzeTimer = null;
      }
      if (!draft.trim()) {
        set({ analysis: null, analyzedText: draft, analyzing: false, analysisError: null });
        return;
      }
      const generation = ++analyzeGeneration;
      set({ analyzing: true, analysisError: null });
      try {
        const doc = await analyzeLyricText(draft);
        if (generation !== analyzeGeneration || get().docId !== docId) return;
        set({ analysis: doc, analyzedText: draft, analyzing: false });
      } catch (e) {
        if (generation !== analyzeGeneration || get().docId !== docId) return;
        set({ analyzing: false, analysisError: errorMessage(e) });
      }
    },

    runAnalysis: async () => {
      const { docId, analyzing } = get();
      if (!docId || analyzing) return;
      // A live pass waiting on its debounce would only recompute what this run
      // is about to compute, and would land after it without the meaning pass.
      if (analyzeTimer) {
        clearTimeout(analyzeTimer);
        analyzeTimer = null;
      }
      // The job reads the document from disk, so the words have to be there
      // first; and the text captured here is the text it will have read.
      const text = get().draft;
      await get().saveNow();
      // The interpretive pass and its provider are the pane's own settings —
      // the same checkbox the karaoke's analysis uses.
      const { llm, provider, model } = useLyricAnalysisStore.getState();
      const generation = ++analyzeGeneration;
      set({ analyzing: true, analysisError: null });
      try {
        const started = await startLyricAnalysis(docId, { force: true, llm, provider, model });
        const jobId = started.job?.id;
        if (!jobId) throw new Error('the analysis did not start');
        const job = await pollLyricAnalysisJob(jobId);
        if (generation !== analyzeGeneration || get().docId !== docId) return;
        if (job.status !== 'done' || !job.result) {
          throw new Error(job.error || job.message || 'analysis failed');
        }
        set({ analysis: job.result, analyzedText: text, analyzing: false });
      } catch (e) {
        if (generation !== analyzeGeneration || get().docId !== docId) return;
        set({ analyzing: false, analysisError: errorMessage(e) });
      }
    },

    importFromEntry: async (entryId, title) => {
      try {
        // The song's own lyrics, through the lyrics API that owns them — the
        // derived document included, so an entry whose words only live in its
        // metadata still imports.
        const bundle = await fetchLyrics(entryId);
        await get().createDoc({ title, text: bundle.doc.text, entryId });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    attachToEntry: async (entryId) => {
      const { docId, draft } = get();
      if (!docId) return;
      set({ saving: true, error: null });
      try {
        await get().saveNow();
        // The words go in through /api/lyrics so they take the same path SING's
        // own editor takes: lines that did not change keep their timings.
        await putLyrics(entryId, { text: draft, source: 'manual' });
        await attachLyricDocument(docId, entryId);
        set({ entryId, saving: false });
        await get().refresh();
      } catch (e) {
        set({ saving: false, error: errorMessage(e) });
      }
    },

    detach: async () => {
      const { docId } = get();
      if (!docId) return;
      try {
        await updateLyricDocument(docId, { entry_id: '' });
        set({ entryId: null });
        await get().refresh();
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    clearError: () => set({ error: null, analysisError: null }),
  };
});
