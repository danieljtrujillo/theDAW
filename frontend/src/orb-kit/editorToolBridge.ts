/**
 * The four editor tools that cannot be answered in the browser.
 *
 * `state/editorTools.ts` is the facade for everything the timeline can do to
 * itself. Four things it cannot: measure a clip (`/analyze`), find its tempo
 * (`/detect-tempo`), line a MIDI part up against a recording
 * (`/compare-timing`), and stretch audio without moving its pitch
 * (`/stretch`). Those are the `/api/editor-tools/*` endpoints, and this module
 * is the only place in `orb-kit` that talks to them — `actionHandlers.ts` stays
 * a dispatch table.
 *
 * Three rules it keeps:
 *
 * 1. **Same envelope as the facade.** Every function returns a {@link
 *    ToolResult}: never throws, never reports success for work it did not do.
 *    A non-2xx response becomes an `error` string carrying the backend's own
 *    detail, because that string is what the model reads and acts on.
 *
 * 2. **The whole source is stretched, not the audible window.** A trimmed
 *    clip's `audioBlob` still holds all of its source media; stretching that
 *    whole blob by `r` scales every time coordinate inside it by `r`, so
 *    `offsetIntoSource` and `durationSec` scale by `r` and the trim survives
 *    the operation. `sourceDuration` is NOT computed — it is read from the
 *    returned file's header, and the window is clamped inside it. Extracting the window first (what
 *    `WaveformEditor` does before ITS stretch) would flatten the clip onto its
 *    audible part and throw the rest of the take away — a change nobody asked
 *    for as part of "make this fit 120 bpm".
 *
 * 3. **Offsets are frame-agnostic.** `/compare-timing` is handed the MIDI note
 *    starts expressed in the AUDIO clip's own source time, because the audio it
 *    detects onsets from is that clip's source. Both series then live in one
 *    frame and the median difference is the number of seconds to nudge by,
 *    whatever the clips' positions on the timeline happen to be.
 *
 * Everything takes an optional `deps` seam so the whole surface is provable in
 * Node: `fetchImpl` replaces `fetch`, `computePeaksImpl` replaces the Web Audio
 * decode that peak extraction needs.
 */
import { computePeaks, useEditorStore } from '../state/editorStore';
import type { AudioClip } from '../state/editorStore';
import { clipWithAudio } from '../state/midiRenderQueue';
import type { ToolResult } from '../state/editorTools';
import { stepClock } from '../lib/rollTempo';
import { logInfo } from '../state/logStore';

const BASE = '/api/editor-tools';

/** Backend guard rails, mirrored so a doomed call is refused before the upload.
 *  (`backend/modules/editor_tools/engine.py`: RATIO_MIN / RATIO_MAX.) */
export const RATIO_MIN = 0.25;
export const RATIO_MAX = 4;

/** Matches `DEFAULT_MAX_MATCH_SEC` in the editor-tools engine. */
const DEFAULT_MAX_MATCH_SEC = 0.25;

/** How many onsets / beats a result message may carry back to the model. The
 *  full arrays reach `data`; a four-minute track has thousands of onsets and
 *  pasting them into the turn buys nothing the count does not. */
const SERIES_CAP = 64;

export interface BridgeDeps {
  /** Replaces `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Replaces `editorStore.computePeaks`, which needs Web Audio. */
  computePeaksImpl?: (blob: Blob, bins: number) => Promise<{ peaks: Float32Array; duration: number }>;
}

/* ── shared plumbing ─────────────────────────────────────────────────────── */

const done = (message: string, data?: unknown): ToolResult => {
  logInfo('editor', message);
  return { ok: true, message, data };
};
const fail = (error: string): ToolResult => ({ ok: false, error });

const store = () => useEditorStore.getState();

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const numArg = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const strArg = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};

const n2 = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Resolve a clip by id or label. Deliberately a copy of the facade's rule
 * rather than a call into it: `resolveClip` is private there, and an ambiguous
 * label must be refused with its candidates here too — picking one of two clips
 * called "Verse" is how a measuring tool reports the wrong take's tempo.
 */
function resolveClip(ref: unknown, kind = 'clip'): { ok: true; value: AudioClip; error?: undefined } | { ok: false; error: string; value?: undefined } {
  const asked = strArg(ref);
  if (!asked) return { ok: false, error: `${kind}: pass an id or a label` };
  const clips = store().clips;

  const byId = clips.find((c) => c.id === asked);
  if (byId) return { ok: true, value: byId };

  const lower = asked.toLowerCase();
  const byLabel = clips.filter((c) => c.label.toLowerCase() === lower);
  if (byLabel.length === 1) return { ok: true, value: byLabel[0] };
  if (byLabel.length > 1) {
    return {
      ok: false,
      error: `${byLabel.length} clips are called "${asked}": ${byLabel.map((c) => c.id).join(', ')}. Pass the id.`,
    };
  }
  const known = clips.slice(0, 20).map((c) => `${c.label} (${c.id})`).join(', ') || 'none';
  return { ok: false, error: `No ${kind} "${asked}". Known clips: ${known}` };
}

/** The live record for an id — a clip can be deleted while a request is out. */
const liveClip = (id: string): AudioClip | undefined => store().clips.find((c) => c.id === id);

const isMidiClip = (clip: AudioClip): boolean =>
  clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll?.length;

/** An extension the backend's temp file can keep, so ffmpeg/libsndfile probe
 *  the container they were actually given rather than a guess. */
function extensionFor(mime: string | undefined): string {
  const subtype = (mime ?? '').split(';')[0].trim().toLowerCase().split('/')[1] ?? '';
  if (!subtype) return 'wav';
  if (subtype === 'mpeg') return 'mp3';
  if (subtype === 'x-wav' || subtype === 'wave' || subtype === 'vnd.wave') return 'wav';
  if (subtype === 'x-m4a' || subtype === 'mp4' || subtype === 'aac') return 'm4a';
  return subtype.replace(/^x-/, '').replace(/[^a-z0-9]/g, '') || 'wav';
}

const uploadNameFor = (clip: AudioClip): string => `clip.${extensionFor(clip.mimeType)}`;

const fetchOf = (deps: BridgeDeps): typeof fetch => {
  const impl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!impl) throw new Error('no fetch implementation is available');
  return impl;
};

/** The backend's own words for a failure. FastAPI sends `{"detail": "..."}`;
 *  anything else is passed through as text so nothing is invented. */
async function failureDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status} ${res.statusText}`.trim();
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail;
      if (typeof detail === 'string' && detail) return detail;
      if (detail !== undefined) return JSON.stringify(detail);
    } catch {
      /* not JSON — the raw body is the best description there is */
    }
    return text.slice(0, 400);
  } catch {
    return `${res.status} ${res.statusText}`.trim();
  }
}

/** POST a clip's audio as `multipart/form-data`, with any extra form fields. */
async function postClip(
  clip: AudioClip,
  path: string,
  fields: Record<string, string | undefined>,
  deps: BridgeDeps,
): Promise<Response> {
  const form = new FormData();
  // A MIDI clip with no render is rendered first (state/midiRenderQueue).
  const blob = clip.audioBlob ?? (await clipWithAudio(clip.id)).audioBlob;
  form.append('file', blob as Blob, uploadNameFor(clip));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }
  return fetchOf(deps)(`${BASE}${path}`, { method: 'POST', body: form });
}

/* ── analyze ─────────────────────────────────────────────────────────────── */

export interface ClipRefArgs {
  clip_id?: unknown;
  clip?: unknown;
}

const clipRef = (args: ClipRefArgs): unknown => args.clip_id ?? args.clip;

interface AnalyzeResponse {
  durationSec: number;
  sampleRate: number;
  channels: number;
  peakDb: number;
  rmsDb: number;
  tempo: { bpm: number | null; confidence: number; beats: number[] };
  onsets: number[];
  key: { root: string; scale: string; confidence: number } | null;
}

/** Trim the long series out of a payload the model has to read in one turn. */
function compact(data: AnalyzeResponse): Record<string, unknown> {
  const onsets = data.onsets ?? [];
  const beats = data.tempo?.beats ?? [];
  return {
    durationSec: data.durationSec,
    sampleRate: data.sampleRate,
    channels: data.channels,
    peakDb: data.peakDb,
    rmsDb: data.rmsDb,
    tempo: {
      bpm: data.tempo?.bpm ?? null,
      confidence: data.tempo?.confidence ?? 0,
      beatCount: beats.length,
      beats: beats.slice(0, SERIES_CAP).map(r3),
      beatsTruncated: beats.length > SERIES_CAP,
    },
    onsetCount: onsets.length,
    onsets: onsets.slice(0, SERIES_CAP).map(r3),
    onsetsTruncated: onsets.length > SERIES_CAP,
    key: data.key ?? null,
  };
}

/** Measure a clip: level, tempo, onsets, key. */
export async function analyzeClip(args: ClipRefArgs, deps: BridgeDeps = {}): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  let res: Response;
  try {
    res = await postClip(clip, '/analyze', {}, deps);
  } catch (e) {
    return fail(`analyze_clip: could not reach the backend — ${reason(e)}`);
  }
  if (!res.ok) return fail(`analyze_clip: the backend refused "${clip.label}" — ${await failureDetail(res)}`);

  let data: AnalyzeResponse;
  try {
    data = (await res.json()) as AnalyzeResponse;
  } catch (e) {
    return fail(`analyze_clip: the backend's answer was not JSON — ${reason(e)}`);
  }

  const summary = compact(data);
  return done(`Analyzed "${clip.label}": ${JSON.stringify(summary)}`, { clipId: clip.id, ...summary });
}

/* ── detect tempo ────────────────────────────────────────────────────────── */

/** Find a clip's tempo. */
export async function detectTempo(args: ClipRefArgs, deps: BridgeDeps = {}): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  let res: Response;
  try {
    res = await postClip(clip, '/detect-tempo', {}, deps);
  } catch (e) {
    return fail(`detect_tempo: could not reach the backend — ${reason(e)}`);
  }
  if (!res.ok) return fail(`detect_tempo: the backend refused "${clip.label}" — ${await failureDetail(res)}`);

  let data: { bpm: number | null; confidence: number; beats: number[] };
  try {
    data = await res.json();
  } catch (e) {
    return fail(`detect_tempo: the backend's answer was not JSON — ${reason(e)}`);
  }

  const beats = data.beats ?? [];
  if (data.bpm === null || data.bpm === undefined) {
    return fail(
      `detect_tempo: nothing periodic enough to call a tempo in "${clip.label}" (${beats.length} beat candidate(s)). Set the tempo by hand with editor_set_clip_source_bpm if you know it.`,
    );
  }
  return done(
    `"${clip.label}" is ${data.bpm} bpm (confidence ${r3(data.confidence ?? 0)}, from ${beats.length} beat(s)). Tag it with editor_set_clip_source_bpm {clip_id:"${clip.id}", bpm:${data.bpm}} before any tempo match.`,
    { clipId: clip.id, bpm: data.bpm, confidence: data.confidence, beatCount: beats.length, beats: beats.slice(0, SERIES_CAP).map(r3) },
  );
}

/* ── compare timing ──────────────────────────────────────────────────────── */

export interface CompareTimingArgs {
  midi_clip_id?: unknown;
  audio_clip_id?: unknown;
  max_match_sec?: unknown;
}

interface CompareTimingResponse {
  medianOffsetSec: number | null;
  meanOffsetSec: number | null;
  matched: number;
  unmatchedNotes: number;
  perNote: unknown[];
}

/**
 * Line a MIDI clip's notes up against an audio clip's transients.
 *
 * Note starts are converted into the AUDIO clip's source time — the same frame
 * the backend detects its onsets in — so the median difference it reports is
 * directly the distance to move the notes, with no timeline bookkeeping left
 * over. A note that falls outside the audio clip's audible window is dropped
 * before the request: there is nothing there to match it against, and leaving
 * it in would only inflate `unmatchedNotes`.
 */
export async function compareTiming(args: CompareTimingArgs, deps: BridgeDeps = {}): Promise<ToolResult> {
  const midiFound = resolveClip(args.midi_clip_id, 'MIDI clip');
  if (!midiFound.ok) return fail(midiFound.error);
  const midi = midiFound.value;
  if (!isMidiClip(midi)) {
    return fail(`compare_timing: "${midi.label}" is not a piano-roll clip, so it has no note starts to compare`);
  }

  const audioFound = resolveClip(args.audio_clip_id, 'audio clip');
  if (!audioFound.ok) return fail(audioFound.error);
  const audio = audioFound.value;
  if (audio.id === midi.id) return fail('compare_timing: pass two different clips');

  const maxMatchSec = numArg(args.max_match_sec) ?? DEFAULT_MAX_MATCH_SEC;
  if (maxMatchSec < 0) return fail('compare_timing: max_match_sec must not be negative');

  // The MIDI clip's clock, through its tempo map when it has one, so a
  // ritardando or an Adagio-into-Allegro times its notes as EDIT plays them.
  const midiClock = stepClock(midi.sourceBpm ?? store().bpm, midi.sourceTempoMap);
  const midiOffset = midi.offsetIntoSource ?? 0;
  const audioOffset = audio.offsetIntoSource ?? 0;
  // Note start -> timeline seconds -> the audio clip's own source seconds.
  const toAudioSource = (step: number): number =>
    midiClock.at(step) - midiOffset + midi.startSec - audio.startSec + audioOffset;

  const windowStart = audioOffset;
  const windowEnd = audioOffset + audio.durationSec;
  const all = midi.sourcePianoRoll.map((n) => toAudioSource(n.step));
  const noteStartsSec = all.filter((t) => t >= windowStart - maxMatchSec && t <= windowEnd + maxMatchSec);
  const outside = all.length - noteStartsSec.length;
  if (noteStartsSec.length === 0) {
    return fail(
      `compare_timing: none of "${midi.label}"'s ${all.length} notes land inside "${audio.label}" on the timeline, so there is nothing to compare. Move one of the clips first.`,
    );
  }

  let res: Response;
  try {
    res = await postClip(
      audio,
      '/compare-timing',
      { noteStartsSec: JSON.stringify(noteStartsSec.map(r3)), maxMatchSec: String(maxMatchSec) },
      deps,
    );
  } catch (e) {
    return fail(`compare_timing: could not reach the backend — ${reason(e)}`);
  }
  if (!res.ok) return fail(`compare_timing: the backend refused the comparison — ${await failureDetail(res)}`);

  let data: CompareTimingResponse;
  try {
    data = (await res.json()) as CompareTimingResponse;
  } catch (e) {
    return fail(`compare_timing: the backend's answer was not JSON — ${reason(e)}`);
  }

  if (data.medianOffsetSec === null || data.medianOffsetSec === undefined) {
    return fail(
      `compare_timing: none of "${midi.label}"'s ${noteStartsSec.length} notes landed within ${maxMatchSec}s of a transient in "${audio.label}". Widen max_match_sec, or fix the tempo first (editor_detect_tempo then editor_set_clip_source_bpm).`,
    );
  }

  // The backend reports audio MINUS midi, so a positive median means the notes
  // are early and must move later — which is the sign editor_nudge_notes wants.
  const ms = Math.round(data.medianOffsetSec * 1000);
  const direction = ms === 0 ? 'already aligned' : ms > 0 ? 'EARLY — move it later' : 'LATE — move it earlier';
  return done(
    `"${midi.label}" vs "${audio.label}": median offset ${data.medianOffsetSec >= 0 ? '+' : ''}${data.medianOffsetSec}s (mean ${data.meanOffsetSec}s) over ${data.matched} matched note(s), ${data.unmatchedNotes} unmatched${outside ? `, ${outside} outside the audio` : ''}. The MIDI is ${direction}: editor_nudge_notes {clip_id:"${midi.id}", ms:${ms}}.`,
    {
      midiClipId: midi.id,
      audioClipId: audio.id,
      medianOffsetSec: data.medianOffsetSec,
      meanOffsetSec: data.meanOffsetSec,
      matched: data.matched,
      unmatchedNotes: data.unmatchedNotes,
      notesOutsideAudio: outside,
      suggestedNudgeMs: ms,
    },
  );
}

/* ── audio stretch ───────────────────────────────────────────────────────── */

export interface StretchAudioArgs extends ClipRefArgs {
  ratio?: unknown;
  target_bpm?: unknown;
  target_duration_sec?: unknown;
}

/**
 * The ratio (new duration / old duration) this call asks for, from whichever
 * of the three targets was given. Exactly one; two would be two different
 * answers and none is not a request.
 */
export function resolveStretchRatio(
  clip: AudioClip,
  args: StretchAudioArgs,
): { ok: true; value: number; error?: undefined } | { ok: false; error: string; value?: undefined } {
  const ratio = numArg(args.ratio);
  const targetBpm = numArg(args.target_bpm);
  const targetDurationSec = numArg(args.target_duration_sec);
  const given = [ratio, targetBpm, targetDurationSec].filter((v) => v !== undefined);
  if (given.length !== 1) {
    return {
      ok: false,
      error: `pass exactly one of ratio, target_bpm or target_duration_sec (got ${given.length})`,
    };
  }

  let value: number;
  if (ratio !== undefined) {
    value = ratio;
  } else if (targetDurationSec !== undefined) {
    if (targetDurationSec <= 0) return { ok: false, error: 'target_duration_sec must be greater than 0' };
    if (!(clip.durationSec > 0)) return { ok: false, error: `"${clip.label}" has no usable duration to stretch from` };
    value = targetDurationSec / clip.durationSec;
  } else {
    if (!(targetBpm > 0)) return { ok: false, error: 'target_bpm must be greater than 0' };
    const sourceBpm = clip.sourceBpm;
    if (!(sourceBpm > 0)) {
      return {
        ok: false,
        error: `"${clip.label}" has no sourceBpm, so there is nothing to convert ${targetBpm} bpm against. Run editor_detect_tempo then editor_set_clip_source_bpm first.`,
      };
    }
    // A clip at sourceBpm played at targetBpm lasts sourceBpm/targetBpm as long.
    value = sourceBpm / targetBpm;
  }

  if (!Number.isFinite(value) || value < RATIO_MIN || value > RATIO_MAX) {
    return {
      ok: false,
      error: `that works out to a ${Number.isFinite(value) ? value.toFixed(3) : String(value)}x stretch, outside the ${RATIO_MIN}x-${RATIO_MAX}x the backend supports`,
    };
  }
  return { ok: true, value };
}

/**
 * The playing length of a RIFF/WAVE file, read from its header: `data` chunk
 * bytes over the `fmt ` chunk's byte rate. `undefined` when the bytes are not a
 * WAV this can size.
 *
 * Chunks are walked rather than read at fixed offsets because ffmpeg writes a
 * `LIST` chunk (its encoder tag) between `fmt ` and `data`, so `data` is not at
 * byte 36. A `data` size of 0xFFFFFFFF (the streaming placeholder) or one larger
 * than what was received is taken as "everything that follows", which is what a
 * decoder would play.
 */
export function wavDurationSec(bytes: ArrayBuffer): number | undefined {
  const view = new DataView(bytes);
  if (view.byteLength < 12) return undefined;
  const tagAt = (o: number): string =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tagAt(0) !== 'RIFF' || tagAt(8) !== 'WAVE') return undefined;

  let byteRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tagAt(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > view.byteLength) return undefined;
      byteRate = view.getUint32(body + 8, true);
      if (!(byteRate > 0)) return undefined;
    } else if (id === 'data') {
      if (!byteRate) return undefined;
      const available = view.byteLength - body;
      const dataBytes = size === 0xffffffff || size > available ? available : size;
      return dataBytes / byteRate;
    }
    // Chunks are word-aligned: an odd-sized chunk carries one pad byte.
    offset = body + size + (size % 2);
  }
  return undefined;
}

/**
 * The clip fields a stretch is computed from. If any of them moves while the
 * backend is working, the result no longer describes the clip the user is
 * looking at: `startSec`/`trackId` are where they put it, `offsetIntoSource`/
 * `durationSec` the window they trimmed, `sourceDuration`/`audioBlob` the media
 * the window reads, and `sourceBpm` the tempo a `target_bpm` ratio was worked
 * out against.
 */
const STRETCH_INPUTS = [
  'startSec',
  'trackId',
  'offsetIntoSource',
  'durationSec',
  'sourceDuration',
  'audioBlob',
  'sourceBpm',
] as const;

/**
 * Pitch-preserving time-stretch of an AUDIO clip, on the backend.
 *
 * MIDI clips do not come here — `editorTools.stretchClip` re-renders those from
 * their notes, which is both faster and exact.
 *
 * Two things are NOT taken on trust once the file comes back:
 *
 * - its length. `atempo` does not land on the sample, so the result is usually
 *   a few milliseconds off `old x ratio`. The clip is sized from the WAV header,
 *   and the window is clamped inside it — a window that reads past the end of
 *   its media fails to decode at playback.
 * - the clip. The request takes seconds and the user keeps editing. The write is
 *   built from the record as it is NOW, and if the window it was computed from
 *   moved in the meantime the stretch is refused rather than written over their
 *   edit.
 */
export async function stretchAudioClip(args: StretchAudioArgs, deps: BridgeDeps = {}): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;
  if (isMidiClip(clip)) {
    return fail(`stretch: "${clip.label}" is a MIDI clip and should have been re-rendered locally, not sent to the backend`);
  }

  const plan = resolveStretchRatio(clip, args);
  if (!plan.ok) return fail(`stretch: ${plan.error}`);
  const ratio = plan.value;

  let res: Response;
  try {
    res = await postClip(clip, '/stretch', { ratio: String(ratio) }, deps);
  } catch (e) {
    return fail(`stretch: could not reach the backend — ${reason(e)}`);
  }
  if (!res.ok) return fail(`stretch: the backend refused "${clip.label}" — ${await failureDetail(res)}`);

  let blob: Blob;
  let sourceDuration: number | undefined;
  try {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) return fail(`stretch: the backend returned an empty file for "${clip.label}"`);
    sourceDuration = wavDurationSec(bytes);
    blob = new Blob([bytes], { type: 'audio/wav' });
  } catch (e) {
    return fail(`stretch: the stretched audio could not be read — ${reason(e)}`);
  }
  if (!(sourceDuration > 0)) {
    return fail(
      `stretch: the backend's file for "${clip.label}" is not a WAV whose length could be read, so the clip cannot be sized to it; nothing was written`,
    );
  }

  const live = liveClip(clip.id);
  if (!live) {
    return fail(`"${clip.label}" was removed while the backend was stretching it; nothing was written`);
  }
  const moved = STRETCH_INPUTS.filter((key) => live[key] !== clip[key]);
  if (moved.length) {
    return fail(
      `"${live.label}" was edited while the backend was stretching it (${moved.join(', ')} changed); nothing was written, so the edit stands. Stretch it again as it is now if you still want it.`,
    );
  }

  // The WHOLE source came back stretched, so every coordinate inside it scales
  // by the same ratio and the clip keeps the window it had — clamped to the
  // file that actually arrived, since that is what playback will decode.
  const offsetIntoSource = Math.min((live.offsetIntoSource ?? 0) * ratio, sourceDuration);
  const room = sourceDuration - offsetIntoSource;
  if (room <= 1e-6) {
    return fail(
      `stretch: the stretched file for "${live.label}" is ${n2(sourceDuration)}s, which ends before the clip's window starts; nothing was written`,
    );
  }
  const durationSec = Math.min(live.durationSec * ratio, room);
  // The source tempo IS the tempo the audio now plays at; leaving it behind
  // would make the next tempo match compute its ratio from a stale number.
  const sourceBpm = live.sourceBpm > 0 ? live.sourceBpm / ratio : undefined;

  store().updateClip(live.id, {
    audioBlob: blob,
    mimeType: 'audio/wav',
    sourceDuration,
    durationSec,
    offsetIntoSource,
    // The cached waveform describes the old audio.
    peaks: undefined,
    ...(sourceBpm === undefined ? {} : { sourceBpm }),
  });

  return done(
    `Stretched "${live.label}" x${ratio.toFixed(3)} on the backend — now ${n2(durationSec)}s${sourceBpm === undefined ? '' : `, tagged ${sourceBpm.toFixed(1)} bpm`}`,
    { clipId: live.id, ratio, durationSec, sourceDuration, sourceBpm: sourceBpm ?? null },
  );
}

/* ── waveform peaks ──────────────────────────────────────────────────────── */

export interface WaveformPeaksArgs extends ClipRefArgs {
  buckets?: unknown;
}

const DEFAULT_BUCKETS = 200;
const MIN_BUCKETS = 8;
const MAX_BUCKETS = 2048;

/**
 * A clip's shape as absolute peak values in [0, 1].
 *
 * The clip's cached `peaks` is reused only when it already has exactly the
 * requested number of buckets, and the result is never written back into that
 * cache: the timeline renders from it at its own bin count, so storing a
 * differently-sized array there would redraw every waveform at the wrong
 * resolution.
 */
export async function getWaveformPeaks(args: WaveformPeaksArgs, deps: BridgeDeps = {}): Promise<ToolResult> {
  const found = resolveClip(clipRef(args));
  if (!found.ok) return fail(found.error);
  const clip = found.value;

  const asked = numArg(args.buckets) ?? DEFAULT_BUCKETS;
  if (asked < MIN_BUCKETS || asked > MAX_BUCKETS) {
    return fail(`get_waveform_peaks: buckets must be between ${MIN_BUCKETS} and ${MAX_BUCKETS}`);
  }
  const buckets = Math.round(asked);

  let peaks: Float32Array;
  let duration = clip.sourceDuration;
  const cached = clip.peaks;
  if (cached && cached.length === buckets) {
    peaks = cached;
  } else {
    const compute = deps.computePeaksImpl ?? computePeaks;
    try {
      // A MIDI clip with no render is rendered first (state/midiRenderQueue).
      const blob = clip.audioBlob ?? (await clipWithAudio(clip.id)).audioBlob;
      const out = await compute(blob as Blob, buckets);
      peaks = out.peaks;
      duration = out.duration;
    } catch (e) {
      return fail(`get_waveform_peaks: "${clip.label}" could not be decoded — ${reason(e)}`);
    }
  }

  const values = Array.from(peaks, r3);
  return done(
    `"${clip.label}" — ${values.length} peak bucket(s) across ${n2(duration)}s of source audio (absolute amplitude 0..1): ${JSON.stringify(values)}`,
    { clipId: clip.id, buckets: values.length, sourceDurationSec: duration, peaks: values },
  );
}
