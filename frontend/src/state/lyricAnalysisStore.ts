/**
 * lyricAnalysisStore - the literary analysis of the SING tab's lyrics.
 *
 * One entry at a time, the same shape as lyricsStore: `load(entryId)` fetches
 * the stored document (and joins an analysis already running for it), `run()`
 * starts a fresh pass and polls its job into `job`, `clear()` drops everything.
 * The view preferences — which device families are painted, the confidence
 * floor, whether the karaoke overlay is on, and the LLM provider/model — live
 * in localStorage under `lyricAnalysis.*`; everything else is session state.
 */
import { create } from 'zustand';
import {
  deleteLyricAnalysis,
  fetchActiveLyricAnalysisJob,
  fetchLyricAnalysis,
  fetchLyricAnalysisCapability,
  pollLyricAnalysisJob,
  startLyricAnalysis,
  type Device,
  type DeviceFamily,
  type LyricAnalysisDoc,
  type LyricAnalysisJobStatus,
  type RunOptions,
} from '../lib/lyricAnalysisClient';

export const DEVICE_FAMILIES: DeviceFamily[] = ['rhyme', 'sound', 'repetition', 'structure', 'meaning'];

export const FAMILY_LABELS: Record<DeviceFamily, string> = {
  rhyme: 'RHYME',
  sound: 'SOUND',
  repetition: 'REPETITION',
  structure: 'STRUCTURE',
  meaning: 'MEANING',
};

/** One word can carry several devices; the overlay paints the first family in
 *  this order, so the rhyme scheme is never hidden under an alliteration. */
const FAMILY_PRIORITY: DeviceFamily[] = ['rhyme', 'repetition', 'sound', 'structure', 'meaning'];

export type FamilyVisibility = Record<DeviceFamily, boolean>;

export interface LyricAnalysisJobState {
  id: string;
  status: LyricAnalysisJobStatus;
  message: string;
  progress: number;
}

const KEY_FAMILIES = 'lyricAnalysis.families';
const KEY_MIN_CONFIDENCE = 'lyricAnalysis.minConfidence';
const KEY_OVERLAY = 'lyricAnalysis.overlay';
const KEY_PROVIDER = 'lyricAnalysis.provider';
const KEY_MODEL = 'lyricAnalysis.model';

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
    const raw = localStorage.getItem(key);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const readString = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
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

/** `sound` starts OFF: alliteration, assonance and consonance fire on most of
 *  a lyric by their nature (measured: 78% of words carry a mark with every
 *  family on, 48% without sound), which reads as a highlighter accident rather
 *  than a finding. The family toggle turns it back on for a sound pass. */
const DEFAULT_FAMILIES = (): FamilyVisibility =>
  Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, f !== 'sound'])) as FamilyVisibility;

const readFamilies = (): FamilyVisibility => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY_FAMILIES);
  } catch {
    return DEFAULT_FAMILIES();
  }
  if (raw === null) return DEFAULT_FAMILIES();
  const on = new Set(raw.split(',').filter(Boolean));
  return Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, on.has(f)])) as FamilyVisibility;
};

/** The backend types `family` as a plain string; anything unknown is dropped
 *  rather than painted with no colour. */
export const asFamily = (family: string): DeviceFamily | null =>
  (DEVICE_FAMILIES as string[]).includes(family) ? (family as DeviceFamily) : null;

/** The findings the current filters let through, strongest first. */
export function visibleDevices(
  doc: LyricAnalysisDoc | null,
  families: FamilyVisibility,
  minConfidence: number,
): Device[] {
  if (!doc) return [];
  return doc.devices
    .filter((d) => {
      const fam = asFamily(d.family);
      return fam !== null && families[fam] && d.confidence >= minConfidence;
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export interface WordDeviceMark {
  family: DeviceFamily;
  /** Every group touching this word, so the selected finding can light up. */
  groups: string[];
  /** Tooltip text: the labels of the devices on this word, capped. */
  title: string;
}

export const wordMarkKey = (line: number, word: number): string => `${line}:${word}`;

/** A dense lyric puts six or more findings on one word, and a label naming
 *  every span of a 400-line refrain runs to thousands of characters. A native
 *  tooltip has to stay readable, so both are clipped. */
const TITLE_MAX_LABELS = 4;
const TITLE_MAX_LABEL_CHARS = 80;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Word -> device mark, keyed `line:word`. Built once per render in the
 * scroller (never inside its per-frame position loop), so painting a device is
 * just one more data attribute on a span that already exists.
 *
 * The mark is per WORD, not per span: `span.char_start` / `char_end` are
 * deliberately ignored here. A span may cover only part of a word (an
 * alliteration is anchored to the initial consonant alone, an assonance to the
 * stressed syllable), but the karaoke word is one element carrying a gradient
 * clipped to its glyphs — splitting it would break the fill — so the whole
 * word wears the underline. Read the pane's findings list for the exact
 * stretch a device claims.
 */
export function buildWordDeviceIndex(
  doc: LyricAnalysisDoc | null,
  families: FamilyVisibility,
  minConfidence: number,
): Map<string, WordDeviceMark> {
  const marks = new Map<string, WordDeviceMark>();
  for (const device of visibleDevices(doc, families, minConfidence)) {
    const family = asFamily(device.family);
    if (!family) continue;
    const group = device.group || device.id;
    const label = clip(device.label, TITLE_MAX_LABEL_CHARS);
    for (const span of device.spans) {
      if (span.line < 0 || span.word < 0) continue;
      const key = wordMarkKey(span.line, span.word);
      const prev = marks.get(key);
      if (!prev) {
        marks.set(key, { family, groups: [group], title: label });
        continue;
      }
      if (!prev.groups.includes(group)) {
        prev.groups.push(group);
        if (prev.groups.length <= TITLE_MAX_LABELS) prev.title = `${prev.title} · ${label}`;
      }
      if (FAMILY_PRIORITY.indexOf(family) < FAMILY_PRIORITY.indexOf(prev.family)) prev.family = family;
    }
  }
  for (const mark of marks.values()) {
    const hidden = mark.groups.length - TITLE_MAX_LABELS;
    if (hidden > 0) mark.title = `${mark.title} · +${hidden} more`;
  }
  return marks;
}

export interface LyricAnalysisState {
  entryId: string | null;
  doc: LyricAnalysisDoc | null;
  persisted: boolean;
  /** The lyrics changed under this analysis: the findings no longer line up. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  job: LyricAnalysisJobState | null;
  /** Empty until the capability probe answers; then the providers it accepts. */
  providers: string[];
  llmAvailable: boolean;
  probed: boolean;

  families: FamilyVisibility;
  minConfidence: number;
  overlay: boolean;
  /** The device group the findings list has selected; the karaoke lights it up. */
  selectedGroup: string | null;
  llm: boolean;
  provider: string;
  model: string;

  load: (entryId: string) => Promise<void>;
  run: (opts?: RunOptions) => Promise<void>;
  remove: () => Promise<void>;
  probe: () => Promise<void>;
  clear: () => void;
  setFamily: (family: DeviceFamily, on: boolean) => void;
  setMinConfidence: (v: number) => void;
  setOverlay: (on: boolean) => void;
  setSelectedGroup: (group: string | null) => void;
  setLlm: (on: boolean) => void;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  clearError: () => void;
}

// One generation counter so a slow load for the previous entry cannot land on
// top of the entry the user has since selected.
let loadGeneration = 0;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useLyricAnalysisStore = create<LyricAnalysisState>()((set, get) => {
  /**
   * Still on the entry (and the load) this work began for? The poller runs to
   * the job's end whatever the user does, so every write it makes has to ask
   * first: a job for the song they have since left must not push its progress,
   * its error or its result onto the song now on screen — and must not leave
   * `job` set, which would block ANALYSE for the new one.
   */
  const stillCurrent = (entryId: string, generation: number): boolean =>
    generation === loadGeneration && get().entryId === entryId;

  /** Follow a job to its end; returns the analysis it produced, or null. */
  const trackJob = async (
    entryId: string,
    generation: number,
    jobId: string,
  ): Promise<LyricAnalysisDoc | null> => {
    if (!stillCurrent(entryId, generation)) return null;
    set({ job: { id: jobId, status: 'queued', message: 'queued', progress: 0 } });
    const job = await pollLyricAnalysisJob(jobId, (j) => {
      if (!stillCurrent(entryId, generation)) return;
      set({ job: { id: j.id, status: j.status, message: j.message, progress: j.progress } });
    });
    if (!stillCurrent(entryId, generation)) return null;
    if (job.status !== 'done') {
      set({ error: job.error || job.message || 'analysis failed', job: null });
      return null;
    }
    set({ job: null });
    return job.result;
  };

  const landResult = (
    entryId: string,
    generation: number,
    doc: LyricAnalysisDoc | null,
  ): void => {
    if (!doc || !stillCurrent(entryId, generation)) return;
    set({ doc, persisted: true, stale: false, error: null });
  };

  return {
    entryId: null,
    doc: null,
    persisted: false,
    stale: false,
    loading: false,
    error: null,
    job: null,
    providers: [],
    llmAvailable: false,
    probed: false,

    families: readFamilies(),
    minConfidence: readNumber(KEY_MIN_CONFIDENCE, 0.5),
    overlay: readBool(KEY_OVERLAY, true),
    selectedGroup: null,
    // The interpretive pass costs a call to a provider, so it never turns
    // itself on: the checkbox starts off every session.
    llm: false,
    provider: readString(KEY_PROVIDER, ''),
    model: readString(KEY_MODEL, ''),

    load: async (entryId) => {
      const generation = ++loadGeneration;
      set({ entryId, loading: true, error: null, job: null, selectedGroup: null });
      try {
        const bundle = await fetchLyricAnalysis(entryId);
        if (generation !== loadGeneration) return;
        set({
          doc: bundle.doc,
          persisted: bundle.persisted,
          stale: bundle.stale,
          loading: false,
        });
      } catch (e) {
        if (generation !== loadGeneration) return;
        set({ doc: null, persisted: false, stale: false, loading: false, error: errorMessage(e) });
        return;
      }
      // An analysis started before the pane opened keeps running server-side.
      const running = await fetchActiveLyricAnalysisJob(entryId);
      if (running && generation === loadGeneration && !get().job) {
        landResult(entryId, generation, await trackJob(entryId, generation, running.id));
      }
    },

    run: async (opts = {}) => {
      const { entryId, job, llm, provider, model } = get();
      if (!entryId || job) return;
      const generation = loadGeneration;
      set({ error: null, selectedGroup: null });
      try {
        const started = await startLyricAnalysis(entryId, {
          force: opts.force ?? true,
          llm: opts.llm ?? llm,
          provider: opts.provider ?? provider,
          model: opts.model ?? model,
        });
        const jobId = started.job?.id;
        if (!jobId) {
          // No job came back: the analysis was already on disk and current.
          const bundle = await fetchLyricAnalysis(entryId);
          if (stillCurrent(entryId, generation)) {
            set({ doc: bundle.doc, persisted: bundle.persisted, stale: bundle.stale });
          }
          return;
        }
        landResult(entryId, generation, await trackJob(entryId, generation, jobId));
      } catch (e) {
        if (!stillCurrent(entryId, generation)) return;
        set({ error: errorMessage(e), job: null });
      }
    },

    remove: async () => {
      const { entryId } = get();
      if (!entryId) return;
      try {
        await deleteLyricAnalysis(entryId);
        if (get().entryId !== entryId) return;
        set({ doc: null, persisted: false, stale: false, selectedGroup: null, error: null });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    probe: async () => {
      if (get().probed) return;
      try {
        const cap = await fetchLyricAnalysisCapability();
        // The capability payload is written by another module; keep only what
        // can actually go in an <option>.
        const providers = Array.isArray(cap.providers)
          ? cap.providers.filter((p): p is string => typeof p === 'string')
          : [];
        set({
          probed: true,
          llmAvailable: !!cap.llm_available,
          providers,
          provider: get().provider || providers[0] || '',
        });
      } catch {
        // The probe failed — usually the backend is not up yet. Do NOT latch
        // `probed`: latching it would disable the meaning pass for the whole
        // session over one refused connection. The next mount asks again.
        set({ probed: false, llmAvailable: false, providers: [] });
      }
    },

    clear: () => {
      // Bump the generation so a job still polling for the entry being dropped
      // cannot write its result back in after this.
      loadGeneration += 1;
      set({
        entryId: null,
        doc: null,
        persisted: false,
        stale: false,
        loading: false,
        error: null,
        job: null,
        selectedGroup: null,
      });
    },

    setFamily: (family, on) => {
      const families = { ...get().families, [family]: on };
      set({ families });
      writeStorage(KEY_FAMILIES, DEVICE_FAMILIES.filter((f) => families[f]).join(','));
    },
    setMinConfidence: (v) => {
      const next = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
      set({ minConfidence: next });
      writeStorage(KEY_MIN_CONFIDENCE, String(next));
    },
    setOverlay: (on) => {
      set({ overlay: on });
      writeStorage(KEY_OVERLAY, on ? '1' : '0');
    },
    setSelectedGroup: (group) => set({ selectedGroup: group }),
    setLlm: (on) => set({ llm: on }),
    setProvider: (provider) => {
      set({ provider });
      writeStorage(KEY_PROVIDER, provider);
    },
    setModel: (model) => {
      set({ model });
      writeStorage(KEY_MODEL, model);
    },
    clearError: () => set({ error: null }),
  };
});
