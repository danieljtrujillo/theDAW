/**
 * lyricAnalysisClient.ts - the /api/lyricanalysis surface: the literary
 * analysis of a library entry's timed lyrics (rhyme scheme, sound devices,
 * repetition, structure, and the optional interpretive LLM pass).
 *
 * The types mirror backend/modules/lyricanalysis/schema.py byte for byte, so
 * the field names stay snake_case. Every finding is anchored in LyricsDoc
 * coordinates — `line` indexes `doc.lines`, `word` indexes
 * `doc.lines[line].words` — which is what lets the karaoke paint a device onto
 * the very words it is already highlighting, with no re-tokenising here.
 *
 * A span may cover only PART of a word: an alliteration is anchored to the
 * initial consonant (`char_start` 0, `char_end` 1), an assonance to the
 * stressed syllable. The karaoke overlay works at word granularity — the sung
 * word is one element wearing a gradient clipped to its glyphs, and splitting
 * it would break the fill — so it marks the whole word and the pane's findings
 * list carries the exact stretch. Anything drawing at sub-word resolution must
 * read `char_start` / `char_end` itself.
 */

import { getJson, postJson, putJson, delJson } from './apiJson';

export type DeviceFamily = 'rhyme' | 'sound' | 'repetition' | 'structure' | 'meaning';

export interface Span {
  line: number;
  word: number;
  char_start: number;
  /** null means "to the end of the word". */
  char_end: number | null;
  text: string;
}

export interface Device {
  id: string;
  kind: string;
  family: string;
  label: string;
  /** The two halves of a rhyme, every line of an anaphora: one group, one colour. */
  group: string;
  spans: Span[];
  detail: string;
  phones: string[];
  confidence: number;
  source: 'rules' | 'llm';
}

export interface LineMetrics {
  line: number;
  /** Rhyme-scheme letter; '' when the line is a marker, untimed, or rhymes with nothing. */
  letter: string;
  syllables: number;
  words: number;
  /** One character per syllable: '1' primary, '2' secondary, '0' unstressed. */
  stress: string;
  end_key: string;
  end_phones: string[];
  section: string;
}

export interface SectionSummary {
  name: string;
  start_line: number;
  end_line: number;
  scheme: string;
  lines: number;
  syllables: number;
}

export interface AnalysisStats {
  lines: number;
  words: number;
  syllables: number;
  unique_words: number;
  ttr: number;
  rhyme_density: number;
  multisyllabic_rhymes: number;
  avg_syllables_per_line: number;
  /** Words with no dictionary pronunciation; high counts soften every rhyme finding. */
  guessed_pronunciations: number;
  devices_by_kind: Record<string, number>;
  devices_by_family: Record<string, number>;
}

export interface LlmPass {
  provider: string;
  model: string;
  ran_at: number;
  /** Set when the pass was asked for but could not run (no key, bad JSON). */
  error: string;
}

export interface LyricAnalysisDoc {
  version: number;
  analyzer_version: number;
  entry_id: string;
  language: string;
  source_updated_at: number;
  /** Hash of the lyric text the analysis actually read. Derived (unsaved)
   *  lyrics never set `updated_at`, so for those the timestamp stays 0 and only
   *  the hash can tell that the words have moved. '' on a document written
   *  before the field existed. */
  source_text_hash: string;
  pronunciation_source: string;
  devices: Device[];
  lines: LineMetrics[];
  sections: SectionSummary[];
  scheme: string;
  stats: AnalysisStats;
  llm: LlmPass | null;
  updated_at: number;
}

export interface LyricAnalysisBundle {
  doc: LyricAnalysisDoc | null;
  /** True when lyric_analysis.json exists on the entry. */
  persisted: boolean;
  /** The lyrics moved (or the analyzer did) since this document was computed. */
  stale: boolean;
}

// --- the writer's own marks -------------------------------------------------
//
// A detector is a reader with a dictionary, and it will always miss what a
// writer hears: a rhyme that only works in delivery, a callback across a whole
// song, a pun the phonetics cannot see. Marks sit beside the detected devices,
// survive a re-run, and a `reject` suppresses a finding the engine got wrong.

export type MarkVerdict = 'mark' | 'confirm' | 'reject';

export const MARK_VERDICTS: MarkVerdict[] = ['mark', 'confirm', 'reject'];

export interface LyricMark {
  id: string;
  /** A device kind when the writer is naming one ('internal-rhyme'), or '' for
   *  a free note. Unknown kinds are allowed: a writer may hear something the
   *  taxonomy has no word for. */
  kind: string;
  label: string;
  /** Marks sharing a group are ONE thing — the words of a rhyme picked out by
   *  hand. This is the whole point of marking, so it is never empty. */
  group: string;
  spans: Span[];
  note: string;
  /** 'mark': the writer's own annotation. 'confirm': real, and kept as ground
   *  truth. 'reject': the engine found it and it is wrong — hidden on display. */
  verdict: MarkVerdict;
  /** For a reject, the `Device.group` being struck out. Device ids are minted
   *  fresh on every run and groups are derived from the words, so the group is
   *  the only handle that survives a re-analysis. */
  target_group: string;
  created_at: number;
  updated_at: number;
}

export interface RunOptions {
  force?: boolean;
  llm?: boolean;
  provider?: string;
  model?: string;
  api_key?: string;
}

export type LyricAnalysisJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LyricAnalysisJob {
  id: string;
  status: LyricAnalysisJobStatus;
  progress: number;
  message: string;
  result: LyricAnalysisDoc | null;
  error: string | null;
}

/** What the module can do right now: whether an LLM pass is reachable, which
 *  providers it would accept, and the taxonomy this build emits (family -> kinds). */
export interface LyricAnalysisCapability {
  ok: boolean;
  llm_available: boolean;
  providers: string[];
  kinds: Record<string, string[]>;
  analyzer_version: number;
}

const enc = encodeURIComponent;

export const fetchLyricAnalysisCapability = (): Promise<LyricAnalysisCapability> =>
  getJson<LyricAnalysisCapability>('/api/lyricanalysis');

/** Analyse pasted text with no library entry involved (nothing is stored). */
export const analyzeLyricText = (text: string, language = 'en'): Promise<LyricAnalysisDoc> =>
  postJson<LyricAnalysisDoc>('/api/lyricanalysis/analyze', { text, language });

export const fetchLyricAnalysis = (entryId: string): Promise<LyricAnalysisBundle> =>
  getJson<LyricAnalysisBundle>(`/api/lyricanalysis/${enc(entryId)}`);

export const deleteLyricAnalysis = (entryId: string): Promise<{ ok: boolean }> =>
  delJson<{ ok: boolean }>(`/api/lyricanalysis/${enc(entryId)}`);

const marksUrl = (docId: string): string => `/api/lyricanalysis/documents/${enc(docId)}/marks`;

/**
 * Marks belong to a lyric DOCUMENT (the LYRIC notebook), never to a library
 * entry: `documents.is_document_id` is the only id the marks routes accept, and
 * anything else is a 404 whatever the body says. SING passes a library entry id
 * to this pane, so this is the gate that stops the writer being offered a
 * marking flow whose every save would be thrown away.
 *
 * Kept character for character with `_ID_RE` in
 * backend/modules/lyricanalysis/documents.py.
 */
const DOC_ID_RE = /^lyricdoc_[0-9a-f]{32}$/;

export const isMarkableDocId = (docId: string | null | undefined): boolean =>
  typeof docId === 'string' && DOC_ID_RE.test(docId);

/**
 * The prefix `service.mark_device` mints its ids with. A stored analysis holds
 * detections only, but the merged view a document's run answers with has the
 * writer's own marks appended AS devices — so every surface that draws
 * "what the engine found" has to be able to tell them apart. No detector can
 * produce this: `devices._Out` mints hex digests.
 */
export const MARK_DEVICE_PREFIX = 'mark:';

export const isMarkDevice = (device: Device): boolean =>
  device.id.startsWith(MARK_DEVICE_PREFIX);

/** GET answers with the set re-anchored onto the words as they are now, plus
 *  the ids of the marks the lyric moved out from under. A stale mark must not
 *  be painted: its anchors point at whatever now sits at that index. */
export interface LyricMarksBundle {
  marks: LyricMark[];
  /** Ids whose anchors no longer match the words they were placed on. */
  stale: string[];
  /** PUT only: marks the server refused because every anchor named a line or
   *  word the lyric does not have. */
  dropped: number;
}

const asBundle = (
  payload: { marks?: LyricMark[]; stale?: string[]; dropped?: number },
  fallback: LyricMark[],
): LyricMarksBundle => ({
  marks: payload.marks ?? fallback,
  stale: payload.stale ?? [],
  dropped: payload.dropped ?? 0,
});

/** The writer's whole mark set for a document. */
export const fetchLyricMarks = async (docId: string): Promise<LyricMarksBundle> =>
  asBundle(await getJson<{ marks?: LyricMark[]; stale?: string[] }>(marksUrl(docId)), []);

/** Replace the whole set — the editor owns the list, so a PUT is the only
 *  write there is. Answers with what was stored: the ids are the server's (it
 *  mints them, and a client id is never taken), and `dropped` counts the marks
 *  it would not store. */
export const putLyricMarks = async (
  docId: string,
  marks: LyricMark[],
): Promise<LyricMarksBundle> =>
  asBundle(
    await putJson<{ marks?: LyricMark[]; stale?: string[]; dropped?: number }>(marksUrl(docId), {
      marks,
    }),
    marks,
  );

/** Start (or join) the analysis job for an entry. `reused` is true when the
 *  returned job was already running — a second ANALYSE click attaches to it. */
export const startLyricAnalysis = (
  entryId: string,
  opts: RunOptions = {},
): Promise<{ ok: boolean; job: LyricAnalysisJob | null; reused: boolean }> =>
  postJson<{ ok: boolean; job: LyricAnalysisJob | null; reused: boolean }>(
    `/api/lyricanalysis/${enc(entryId)}/run`,
    {
      force: opts.force ?? false,
      llm: opts.llm ?? false,
      provider: opts.provider ?? '',
      model: opts.model ?? '',
      api_key: opts.api_key ?? '',
    },
  );

/** The job running for this entry right now, if any: an analysis another view
 *  (or an earlier visit) started keeps going while the pane is closed. */
export async function fetchActiveLyricAnalysisJob(entryId: string): Promise<LyricAnalysisJob | null> {
  try {
    const payload = await getJson<{ job?: LyricAnalysisJob | null }>(
      `/api/lyricanalysis/${enc(entryId)}/job`,
    );
    return payload.job ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TERMINAL: LyricAnalysisJobStatus[] = ['done', 'failed', 'cancelled'];

export async function pollLyricAnalysisJob(
  jobId: string,
  onUpdate?: (job: LyricAnalysisJob) => void,
  intervalMs = 1000,
): Promise<LyricAnalysisJob> {
  for (;;) {
    const job = await getJson<LyricAnalysisJob>(`/api/lyricanalysis/jobs/${enc(jobId)}`);
    onUpdate?.(job);
    if (TERMINAL.includes(job.status)) return job;
    await sleep(intervalMs);
  }
}
