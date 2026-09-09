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

import { getJson, postJson, delJson } from './apiJson';

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
