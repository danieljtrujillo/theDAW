/**
 * lyricsClient.ts - the /api/lyrics surface, plus the two vocal-transcription
 * routes the SING tab reuses to probe and install the whisper sidecar.
 *
 * The types mirror backend/modules/lyrics/schema.py byte for byte: times are
 * project-relative milliseconds, null means untimed, and `offset_ms` is added
 * to the player clock at playback (never baked into the stored times).
 */

export interface LyricWord {
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  /** What whisper heard where this word should be, when it was NOT this word
   *  (ALIGN sets it; '' means whisper heard nothing there). Absent or null
   *  when the word matched or no alignment has run. */
  heard?: string | null;
}

export interface LyricLine {
  text: string;
  kind: 'lyric' | 'marker';
  start_ms: number | null;
  end_ms: number | null;
  confidence: number | null;
  words: LyricWord[];
}

export interface LyricsStats {
  matched: number;
  total: number;
  asr_words: number;
  audio_source: string;
  /** Words whose `heard` is set: the pasted text and the vocal disagree there. */
  mismatched?: number;
  /** 'mms' (forced alignment of your words) | 'whisper' (whisper's words matched to yours). */
  aligner?: string;
  /** The whisper review ran and could follow the vocal (its differences are shown). */
  reviewed?: boolean;
}

export interface LyricsDoc {
  version: number;
  entry_id: string;
  timing_unit: string;
  language: string;
  /** '' | manual | suno | tags | embedded | notes | transcribed | aligned | lrc | tap */
  source: string;
  text: string;
  offset_ms: number;
  lines: LyricLine[];
  stats: LyricsStats | null;
  updated_at: number;
}

export interface LyricsBundle {
  doc: LyricsDoc;
  /** True when lyrics.json exists; false when the doc was derived on the fly. */
  persisted: boolean;
  /** The entry's notes, offered when they look like lyrics and the doc is empty. */
  notes_candidate: string | null;
}

export interface PutLyricsBody {
  text?: string;
  lines?: LyricLine[];
  offset_ms?: number;
  language?: string;
  source?: string;
}

export type LyricsJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LyricsJob {
  id: string;
  status: LyricsJobStatus;
  progress: number;
  message: string;
  result: LyricsDoc | null;
  error: string | null;
}

export interface TranscribeOptions {
  language?: string;
  isolate?: boolean;
  sync_vocal?: boolean;
}

/** The whisper sidecar is not installed; `install` is the route that builds it. */
export class LyricsUnavailableError extends Error {
  install: string;
  constructor(message: string, install: string) {
    super(message);
    this.name = 'LyricsUnavailableError';
    this.install = install;
  }
}

const enc = encodeURIComponent;

async function errorText(res: Response, fallback: string): Promise<string> {
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'error' in detail) {
    return String((detail as { error?: unknown }).error);
  }
  return `${fallback} HTTP ${res.status}`;
}

export async function fetchLyrics(entryId: string): Promise<LyricsBundle> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}`);
  if (!res.ok) throw new Error(await errorText(res, 'lyrics'));
  return (await res.json()) as LyricsBundle;
}

export async function putLyrics(entryId: string, body: PutLyricsBody): Promise<LyricsDoc> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res, 'lyrics save'));
  return (await res.json()) as LyricsDoc;
}

export async function deleteLyrics(entryId: string): Promise<void> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorText(res, 'lyrics delete'));
}

async function startJob(
  entryId: string,
  route: 'transcribe' | 'align',
  body: TranscribeOptions & { text?: string },
): Promise<{ jobId: string }> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const payload = await res.json().catch(() => ({} as Record<string, unknown>));
    const detail = (payload as { detail?: { error?: string; install?: string } }).detail ?? {};
    throw new LyricsUnavailableError(
      detail.error ?? 'transcription unavailable',
      detail.install ?? '/api/vocal/transcription/install',
    );
  }
  if (!res.ok) throw new Error(await errorText(res, `lyrics ${route}`));
  const payload = (await res.json()) as { job?: { id?: string } };
  const id = payload.job?.id;
  if (!id) throw new Error(`lyrics ${route}: no job id in the response`);
  return { jobId: id };
}

export const startTranscribe = (entryId: string, opts: TranscribeOptions = {}) =>
  startJob(entryId, 'transcribe', opts);

export const startAlign = (entryId: string, opts: TranscribeOptions & { text?: string } = {}) =>
  startJob(entryId, 'align', opts);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TERMINAL: LyricsJobStatus[] = ['done', 'failed', 'cancelled'];

async function pollJob(
  url: string,
  onUpdate?: (job: LyricsJob) => void,
  intervalMs = 1000,
): Promise<LyricsJob> {
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await errorText(res, 'job'));
    const job = (await res.json()) as LyricsJob;
    onUpdate?.(job);
    if (TERMINAL.includes(job.status)) return job;
    await sleep(intervalMs);
  }
}

export const pollLyricsJob = (jobId: string, onUpdate?: (job: LyricsJob) => void, intervalMs = 1000) =>
  pollJob(`/api/lyrics/jobs/${enc(jobId)}`, onUpdate, intervalMs);

/** The align / transcribe job running for the entry right now, if any: the
 *  auto pipeline (import, favourite) may have started one before SING opened. */
export async function fetchActiveLyricsJob(entryId: string): Promise<LyricsJob | null> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}/job`);
  if (!res.ok) return null;
  const payload = (await res.json()) as { job?: LyricsJob | null };
  return payload.job ?? null;
}

/** The vocal module's jobs (the sidecar install) share the same payload shape. */
export const pollVocalJob = (jobId: string, onUpdate?: (job: LyricsJob) => void, intervalMs = 1500) =>
  pollJob(`/api/vocal/jobs/${enc(jobId)}`, onUpdate, intervalMs);

export async function importLyrics(entryId: string, format: 'lrc' | 'txt', content: string): Promise<LyricsDoc> {
  const res = await fetch(`/api/lyrics/${enc(entryId)}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, content }),
  });
  if (!res.ok) throw new Error(await errorText(res, 'lyrics import'));
  return (await res.json()) as LyricsDoc;
}

export const lyricsExportUrl = (entryId: string, fmt: 'lrc' | 'txt', words = false): string =>
  `/api/lyrics/${enc(entryId)}/export?format=${fmt}&words=${words ? 1 : 0}`;

export interface TranscriptionProbe {
  ok: boolean;
  critical_ok: boolean;
  [key: string]: unknown;
}

export async function fetchTranscriptionProbe(): Promise<TranscriptionProbe> {
  const res = await fetch('/api/vocal/transcription/probe');
  if (!res.ok) throw new Error(await errorText(res, 'transcription probe'));
  return (await res.json()) as TranscriptionProbe;
}

export async function startTranscriptionInstall(): Promise<{ jobId: string }> {
  const res = await fetch('/api/vocal/transcription/install', { method: 'POST' });
  if (!res.ok) throw new Error(await errorText(res, 'transcription install'));
  const payload = (await res.json()) as { job?: { id?: string }; job_id?: string; id?: string };
  const id = payload.job?.id ?? payload.job_id ?? payload.id;
  if (!id) throw new Error('transcription install: no job id in the response');
  return { jobId: id };
}
