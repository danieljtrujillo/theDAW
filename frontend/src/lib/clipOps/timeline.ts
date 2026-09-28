/**
 * Pure timeline math for editor clips.
 *
 * Everything here takes an `AudioClip` (or a list of them) and returns a NEW
 * clip, a list of ids, or a plan — nothing reads or writes the store, touches
 * the DOM, or decodes audio. That split exists because the assistant's
 * `editor_*` tools have to answer "is this edit legal, and what would it do?"
 * before anything is committed, and because clip geometry is the part of the
 * editor that is easiest to get wrong by one term and hardest to eyeball in a
 * running app.
 *
 * The invariant every function preserves, in priority order:
 *
 *     0 <= offsetIntoSource
 *     offsetIntoSource + durationSec <= sourceDuration
 *     startSec >= 0
 *     durationSec >= MIN_CLIP_SEC        (unless the source is shorter)
 *
 * i.e. a clip is always a window that lies entirely inside its source media and
 * entirely inside positive timeline time. The first three hold absolutely — a
 * window reading past the end of its media fails to decode at playback time.
 * The MIN_CLIP_SEC floor is the one that yields: a source shorter than the
 * minimum (a 5ms one-shot, a truncated import) produces a clip as long as the
 * source and no longer, because a clip under the nominal minimum is merely
 * small, while one that overruns its media is broken. Operations that are geometric
 * (trim/nudge/duplicate) CLAMP to that invariant, because a drag that runs off
 * the end of the media should stop at the end of the media rather than fail.
 * Operations that carry an explicit user-supplied value (set props, set source
 * BPM, stretch, merge, crossfade) REJECT with a message instead, because
 * silently substituting a different number for the one that was asked for is
 * how an assistant tool reports success for an edit it did not make.
 *
 * Audio time-stretching that preserves pitch is a backend job; `stretchPlan`
 * only computes the ratio and tags the clip `'audio'` so the caller routes it
 * there. MIDI clips are re-rendered locally — see `audioOps.stretchMidiClip`.
 */
import type { AudioClip } from '../../state/editorStore';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../tempoMap';

/** Shortest clip the editor will produce. A zero-length clip is invisible and
 *  unselectable, so a collapse lands here instead. (`splitClipAt` refuses to
 *  cut within 0.05s of an edge for the same reason; this is the hard floor
 *  underneath that policy.) */
export const MIN_CLIP_SEC = 0.01;

/** Tempo bounds: the app's 20-300 BPM, the range `editorStore.setBpm` clamps
 *  to and the roll, its render and its tempo map hold (lib/tempoMap). A tempo
 *  outside it is refused rather than silently moved. */
export const MIN_BPM = TEMPO_BPM_MIN;
export const MAX_BPM = TEMPO_BPM_MAX;

/**
 * Success carries the value; failure carries a message a tool can show a user
 * verbatim. Used instead of exceptions so the assistant layer can report a
 * refusal without a try/catch around every call.
 *
 * The mirrored `error?: undefined` / `value?: undefined` members are load
 * bearing, not clutter: this project compiles with `strictNullChecks` off, and
 * without it TypeScript will not narrow a union on a BOOLEAN discriminant. The
 * `if (res.ok)` branch resolves either way, but `if (!res.ok) return res.error`
 * — the shape every caller of this actually writes — does not compile unless
 * `error` is visible on both members. Declaring it on both makes the obvious
 * code work without forcing a cast at every call site.
 */
export type ClipOpResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

const fail = (error: string): ClipOpResult<never> => ({ ok: false, error });
const done = <T>(value: T): ClipOpResult<T> => ({ ok: true, value });

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The source length to trust. A clip whose `sourceDuration` is missing or
 *  nonsense (an import that never finished decoding) is treated as having
 *  exactly the media its current window already uses, so trimming can shorten
 *  it but never invent audio that may not exist. */
const sourceDurationOf = (clip: AudioClip): number => {
  const declared = clip.sourceDuration;
  const used = Math.max(0, clip.offsetIntoSource) + Math.max(0, clip.durationSec);
  return num(declared) && declared > 0 ? Math.max(declared, 0) : used;
};

const clipEnd = (clip: AudioClip): number => clip.startSec + clip.durationSec;

/* ── trim ────────────────────────────────────────────────────────────────── */

export interface TrimBounds {
  /** New timeline-absolute in point. Omitted = leave the head where it is. */
  inSec?: number;
  /** New timeline-absolute out point. Omitted = leave the tail where it is. */
  outSec?: number;
}

/**
 * Move a clip's in and/or out point, in timeline-absolute seconds.
 *
 * Moving the in point consumes (or gives back) the same number of seconds of
 * source, so the audio under the surviving part of the clip does not slide —
 * this is the same relationship `editorStore.splitClipAt` maintains when it
 * hands the right-hand piece `offsetIntoSource + relSplit`.
 *
 * Both bounds are clamped to what the source actually holds and to positive
 * timeline time; a request to trim past either end of the media stops at the
 * media. An inverted or degenerate range collapses to `MIN_CLIP_SEC`.
 */
export function trimClip(clip: AudioClip, bounds: TrimBounds): AudioClip {
  const srcTotal = sourceDurationOf(clip);
  const headroomBefore = Math.max(0, clip.offsetIntoSource);
  const headroomAfter = Math.max(0, srcTotal - (clip.offsetIntoSource + clip.durationSec));

  // How far the edges can travel before they run out of media (or out of time).
  const earliestStart = Math.max(0, clip.startSec - headroomBefore);
  const latestEnd = clipEnd(clip) + headroomAfter;

  const wantedStart = num(bounds.inSec) ? bounds.inSec : clip.startSec;
  const wantedEnd = num(bounds.outSec) ? bounds.outSec : clipEnd(clip);

  // Resolve a start into the window it implies. Containment beats the minimum
  // length: for a source shorter than MIN_CLIP_SEC — a 5ms one-shot, a
  // truncated import — the floor would otherwise hand back a window reading
  // past the end of the media, which is a decode failure at playback time. A
  // clip under the nominal minimum is merely small, so the floor is what yields.
  const windowAt = (start: number) => {
    const offsetIntoSource = Math.max(0, clip.offsetIntoSource + (start - clip.startSec));
    const remaining = Math.max(0, srcTotal - offsetIntoSource);
    const wanted = Math.max(MIN_CLIP_SEC, Math.min(wantedEnd, latestEnd) - start);
    return { startSec: start, offsetIntoSource, durationSec: Math.min(wanted, remaining) };
  };

  // The head is only bounded by the media and by time. It is NOT pulled left to
  // reserve room for a minimum-length clip: doing that moved the in point on a
  // source too short to supply MIN_CLIP_SEC, so trimming the OUT point silently
  // slid the head — on any call, including one with no bounds at all.
  const first = windowAt(clamp(wantedStart, earliestStart, latestEnd));
  if (first.durationSec > 0) return { ...clip, ...first };

  // The head landed where no media is left (a start at or past the very end).
  // Back it off to the shortest clip this source can still supply.
  const shortfall = Math.min(MIN_CLIP_SEC, latestEnd - earliestStart);
  return { ...clip, ...windowAt(Math.max(earliestStart, latestEnd - shortfall)) };
}

/* ── nudge ───────────────────────────────────────────────────────────────── */

/**
 * Move a clip along the timeline by a relative amount, without touching its
 * source window. Clamped at `minStart` (the timeline origin by default); a
 * non-finite delta is a no-op rather than an NaN start.
 */
export function nudgeClip(
  clip: AudioClip,
  deltaSec: number,
  opts: { minStart?: number } = {},
): AudioClip {
  const floor = num(opts.minStart) ? Math.max(0, opts.minStart) : 0;
  const moved = num(deltaSec) ? clip.startSec + deltaSec : clip.startSec;
  return { ...clip, startSec: Math.max(floor, moved) };
}

/* ── duplicate ───────────────────────────────────────────────────────────── */

/**
 * Copy a clip to a new id. Defaults to butt-joining the copy onto the end of
 * the original, which is what "duplicate" means when no position is given.
 *
 * The copy shares the source `Blob` and the cached peaks by reference: the
 * window into the media is identical, so re-encoding or re-analysing it would
 * produce the same bytes. `newId` is injected rather than generated so this
 * stays pure and the caller keeps control of id allocation.
 */
export function duplicateClip(clip: AudioClip, opts: { newId: string; at?: number }): AudioClip {
  const fallback = clipEnd(clip);
  const startSec = num(opts.at) ? Math.max(0, opts.at) : fallback;
  return { ...clip, id: opts.newId, startSec };
}

/* ── set props ───────────────────────────────────────────────────────────── */

export interface ClipPropPatch {
  /** Linear gain, 1 = unity. */
  gain?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  muted?: boolean;
  durationSec?: number;
  label?: string;
  /** GM program 0-127. */
  instrumentProgram?: number;
}

/**
 * Apply a property patch, validating the result as a whole rather than each key
 * in isolation — shortening a clip is checked against the fades that will
 * survive the change, so `{durationSec: 1}` on a clip with a 3s fade-in is
 * refused instead of producing a clip whose envelope never finishes opening.
 *
 * Keys absent from the patch are left exactly as they were.
 */
export function setClipProps(clip: AudioClip, patch: ClipPropPatch): ClipOpResult<AudioClip> {
  const next: AudioClip = { ...clip };

  if (patch.gain !== undefined) {
    if (!num(patch.gain) || patch.gain < 0) return fail('gain must be a finite number >= 0');
    next.gain = patch.gain;
  }

  if (patch.durationSec !== undefined) {
    if (!num(patch.durationSec) || patch.durationSec < MIN_CLIP_SEC) {
      return fail(`durationSec must be a finite number >= ${MIN_CLIP_SEC}`);
    }
    const available = sourceDurationOf(clip) - clip.offsetIntoSource;
    if (patch.durationSec > available + 1e-9) {
      return fail(`durationSec exceeds the available source (${available.toFixed(3)}s remain after the clip offset)`);
    }
    next.durationSec = patch.durationSec;
  }

  for (const key of ['fadeInSec', 'fadeOutSec'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!num(v) || v < 0) return fail(`${key} must be a finite number >= 0`);
    next[key] = v;
  }
  // Checked after both fades and the duration are settled, so the constraint is
  // evaluated against the clip that would actually exist.
  for (const key of ['fadeInSec', 'fadeOutSec'] as const) {
    const v = next[key];
    if (v !== undefined && v > next.durationSec + 1e-9) {
      return fail(`${key} (${v}s) cannot be longer than the clip (${next.durationSec}s)`);
    }
  }

  if (patch.muted !== undefined) next.muted = !!patch.muted;

  if (patch.label !== undefined) {
    const label = String(patch.label).trim();
    if (!label) return fail('label cannot be empty');
    next.label = label;
  }

  if (patch.instrumentProgram !== undefined) {
    const p = patch.instrumentProgram;
    if (!num(p) || !Number.isInteger(p) || p < 0 || p > 127) {
      return fail('instrumentProgram must be an integer 0-127');
    }
    next.instrumentProgram = p;
  }

  return done(next);
}

/* ── select ──────────────────────────────────────────────────────────────── */

export interface RangeQuery {
  startSec: number;
  endSec: number;
  /** Restrict to these tracks. Omitted = every track; an empty array selects
   *  nothing, which is what a filter that matched no tracks should do. */
  trackIds?: string[];
}

/**
 * Ids of every clip that OVERLAPS the range, in timeline order. Touching edges
 * do not count: a clip that ends exactly where the range begins shares an
 * instant with it, not a span, and selecting it would surprise anyone who just
 * dragged a selection up to a clip boundary.
 */
export function selectRange(clips: readonly AudioClip[], query: RangeQuery): string[] {
  const lo = Math.min(query.startSec, query.endSec);
  const hi = Math.max(query.startSec, query.endSec);
  if (!num(lo) || !num(hi)) return [];
  const tracks = query.trackIds ? new Set(query.trackIds) : null;
  return clips
    .filter((c) => (tracks ? tracks.has(c.trackId) : true) && c.startSec < hi && clipEnd(c) > lo)
    .slice()
    .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
    .map((c) => c.id);
}

/* ── merge ───────────────────────────────────────────────────────────────── */

export interface MergePlan {
  /** Clip ids in the order they must be concatenated. */
  order: string[];
  /** Silence to insert BETWEEN consecutive clips; length `order.length - 1`.
   *  Overlaps report 0 — concatenation cannot splice backwards, and an overlap
   *  is a crossfade, not a merge. */
  gaps: number[];
  /** Length of the concatenated result: every duration plus every gap. Equal to
   *  the timeline span from the first clip's start to the last clip's end when
   *  none of them overlap. */
  totalDurationSec: number;
  /** The single track all the clips live on. */
  trackId: string;
}

/**
 * Plan a merge of two or more clips into one. Refuses clips that span tracks:
 * a merge concatenates along ONE timeline, and collapsing parallel tracks into
 * a sequence would silently reorder audio the user hears simultaneously.
 */
export function mergePlan(clips: readonly AudioClip[]): ClipOpResult<MergePlan> {
  if (clips.length < 2) return fail('merge needs at least 2 clips');
  const trackId = clips[0].trackId;
  if (clips.some((c) => c.trackId !== trackId)) {
    return fail('all clips must be on the same track to merge');
  }

  const ordered = clips.slice().sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
  const gaps: number[] = [];
  let totalDurationSec = ordered[0].durationSec;
  for (let i = 1; i < ordered.length; i += 1) {
    const gap = Math.max(0, ordered[i].startSec - clipEnd(ordered[i - 1]));
    gaps.push(gap);
    totalDurationSec += gap + ordered[i].durationSec;
  }

  return done({ order: ordered.map((c) => c.id), gaps, totalDurationSec, trackId });
}

/* ── crossfade ───────────────────────────────────────────────────────────── */

export interface CrossfadePlan {
  /** The overlap actually used, after clamping to the shorter clip and to the
   *  timeline origin. May be less than requested. */
  overlapSec: number;
  /** The earlier clip: fades out across the overlap. */
  first: { id: string; fadeOutSec: number };
  /** The later clip: fades in across the overlap, slid back to where the
   *  overlap begins. Its source window is untouched — only its timeline
   *  position moves. */
  second: { id: string; fadeInSec: number; startSec: number };
}

/**
 * Plan a crossfade between two clips. Which clip is "first" is decided by
 * timeline position, not argument order, so a caller does not have to sort.
 *
 * The fades are symmetric (equal-length, both across the overlap window) because
 * that is the pair whose linear sum stays closest to constant through the
 * transition; asymmetric fades are a separate edit, not a crossfade.
 *
 * Requires the clips to already touch or overlap. Sliding a clip that sits
 * elsewhere on the timeline into contact is a move, and doing it implicitly
 * would relocate audio the caller never asked to relocate.
 */
export function crossfadePlan(
  a: AudioClip,
  b: AudioClip,
  opts: { overlapSec: number },
): ClipOpResult<CrossfadePlan> {
  if (a.id === b.id) return fail('cannot crossfade a clip with the same clip');
  if (!num(opts.overlapSec) || opts.overlapSec <= 0) {
    return fail('overlapSec must be a finite number > 0');
  }

  const [first, second] = a.startSec <= b.startSec ? [a, b] : [b, a];
  const gap = second.startSec - clipEnd(first);
  if (gap > 1e-9) {
    return fail(
      `clips are ${gap.toFixed(3)}s apart; close the gap before crossfading (a crossfade only shortens an existing overlap)`,
    );
  }

  // Never longer than the shorter clip, and never far enough to push the later
  // clip before the timeline origin.
  const maxByLength = Math.min(first.durationSec, second.durationSec);
  const maxByOrigin = clipEnd(first);
  const overlapSec = Math.min(opts.overlapSec, maxByLength, maxByOrigin);
  const startSec = Math.max(0, clipEnd(first) - overlapSec);

  return done({
    overlapSec,
    first: { id: first.id, fadeOutSec: overlapSec },
    second: { id: second.id, fadeInSec: overlapSec, startSec },
  });
}

/* ── source tempo ────────────────────────────────────────────────────────── */

/**
 * Declare the tempo the clip's media was recorded/rendered at. This does NOT
 * re-render anything — it is the reference `stretchPlan` needs to convert a
 * target BPM into a ratio, and what a mis-tagged MIDI bounce needs corrected
 * before any tempo match will land on the beat.
 */
export function setClipSourceBpm(clip: AudioClip, bpm: number): ClipOpResult<AudioClip> {
  if (!num(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    return fail(`bpm must be a finite number between ${MIN_BPM} and ${MAX_BPM}`);
  }
  return done({ ...clip, sourceBpm: bpm });
}

/* ── stretch ─────────────────────────────────────────────────────────────── */

export interface StretchPlan {
  /** New length as a multiple of the current one: `newDurationSec / durationSec`.
   *  A FASTER target tempo yields a ratio below 1, because the same bars take
   *  less time. MIDI re-renders at `sourceBpm / ratio`; audio goes to the
   *  pitch-preserving backend stretch with this same ratio. */
  ratio: number;
  newDurationSec: number;
  /** `'midi'` when the clip carries the notes that produced it, so it can be
   *  re-rendered losslessly at the new tempo; `'audio'` otherwise. */
  kind: 'midi' | 'audio';
}

/** A clip is stretchable as MIDI only if the notes that made it are still
 *  attached — a piano-roll clip whose note list was dropped is just audio. */
export const stretchKindOf = (clip: AudioClip): 'midi' | 'audio' =>
  clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll?.length ? 'midi' : 'audio';

/**
 * Work out the length change for a tempo or duration target. Exactly one target
 * must be given: two targets that disagree have no single answer, and guessing
 * which one the caller meant is worse than refusing.
 */
export function stretchPlan(
  clip: AudioClip,
  target: { targetBpm?: number; targetDurationSec?: number },
): ClipOpResult<StretchPlan> {
  const hasBpm = target.targetBpm !== undefined;
  const hasDur = target.targetDurationSec !== undefined;
  if (hasBpm && hasDur) return fail('pass exactly one of targetBpm or targetDurationSec, not both');
  if (!hasBpm && !hasDur) return fail('a target is required: pass targetBpm or targetDurationSec');

  const kind = stretchKindOf(clip);

  if (hasDur) {
    const newDurationSec = target.targetDurationSec as number;
    if (!num(newDurationSec) || newDurationSec < MIN_CLIP_SEC) {
      return fail(`targetDurationSec must be a finite number >= ${MIN_CLIP_SEC}`);
    }
    if (!num(clip.durationSec) || clip.durationSec <= 0) return fail('clip has no usable durationSec');
    return done({ ratio: newDurationSec / clip.durationSec, newDurationSec, kind });
  }

  const targetBpm = target.targetBpm as number;
  if (!num(targetBpm) || targetBpm < MIN_BPM || targetBpm > MAX_BPM) {
    return fail(`targetBpm must be a finite number between ${MIN_BPM} and ${MAX_BPM}`);
  }
  const sourceBpm = clip.sourceBpm;
  if (!num(sourceBpm) || sourceBpm <= 0) {
    return fail('clip has no sourceBpm; set it with setClipSourceBpm before stretching to a tempo');
  }
  const ratio = sourceBpm / targetBpm;
  return done({ ratio, newDurationSec: clip.durationSec * ratio, kind });
}
