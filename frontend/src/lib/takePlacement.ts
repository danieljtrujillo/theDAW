/**
 * takePlacement — is this pass a TAKE of a clip, or a clip of its own?
 *
 * A performer who records bar 9 again means the second pass to be an
 * alternative to the first, not a second clip stacked on top of it. That
 * intent is not stored anywhere, so it has to be read off the geometry: a pass
 * that lands where a clip already is, is a take of it.
 *
 * THE RULE, and the whole of it: the take and the clip must overlap by at
 * least half of the SHORTER of the two spans. The shorter span is what makes
 * the rule symmetric — punching two bars into the middle of a four-minute clip
 * is a re-take of that clip (the take is almost wholly inside it), while a
 * four-minute pass that happens to cross two bars of an existing clip is not
 * (neither is mostly the other). Half of the LONGER span would refuse the
 * first; a fixed number of seconds would mean something different at every
 * clip length.
 *
 * This file is the RULE, kept pure: it imports nothing, holds no state, and
 * knows neither the store nor the clip type. `state/recordingStore.ts` applies
 * it at the one place a take becomes clip coordinates, and the structural
 * parameter types below are what `editorStore.AudioClip` already satisfies.
 *
 * DESIGN SOURCE: none. The threshold, the shorter-span denominator and the tie
 * rule were chosen here for this app's placement path; no reference DAW under
 * `oss-refs/` was opened for this file and no code was copied from any of them.
 * The take MODEL it feeds is `lib/clipComp.ts`, which carries its own citation.
 */

/**
 * Where a finished take wants to land, in timeline seconds — the span it is
 * allowed to WRITE, which is what the punch crop leaves of it.
 */
export interface TakeSpan {
  startSec: number;
  /** The take's length on the timeline. 0 (or non-finite) means the clock
   *  never measured it — see `matchClipForTake`. */
  durationSec: number;
  /** Seconds into the take's own source that `startSec` reads. 0 unless a
   *  punch crop moved the head. */
  offsetIntoSource?: number;
}

/**
 * What the rule needs to know about a clip already on the track. Structural on
 * purpose: `AudioClip` satisfies it without this file importing the store.
 */
export interface TakeTargetClip {
  id: string;
  startSec: number;
  durationSec: number;
  /** `'piano-roll'` clips are never take targets — see `matchClipForTake`. */
  sourceKind?: string;
  /** The clip's own label, which is take 1's label once takes exist. */
  label?: string;
  /** The clip's existing takes, if any. The count and the labels are read. */
  takes?: readonly { label?: string }[];
}

/** How much of the shorter span the two must share for the pass to be a take. */
export const TAKE_OVERLAP_MIN = 0.5;

/**
 * How far a take may fall short of the clip's end and still be a take of it,
 * seconds. A hand-stopped pass ends when the performer's hand got there, and
 * refusing a take over a millisecond at the tail would refuse nearly every
 * real one; ten milliseconds of silence at the very end of a clip is below
 * anything a listener can place, and the alternative — a second clip stacked
 * on the first — is worse in every case.
 */
export const TAKE_COVER_TOLERANCE_SEC = 0.01;

/** Slack on the comparison, so a span the arithmetic lands a few ulps under
 *  exactly half is still exactly half. Well below a sample at any rate. */
const RATIO_EPS = 1e-9;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A span both of whose numbers are usable and which covers real time. */
const usable = (startSec: number, durationSec: number): boolean =>
  isNum(startSec) && isNum(durationSec) && durationSec > 0;

/**
 * The shared time of a clip and a take, as a fraction of the shorter of the
 * two spans. 0 when they do not overlap, or when either span is unusable.
 */
export function takeOverlapRatio(clip: TakeTargetClip, take: TakeSpan): number {
  if (!usable(clip.startSec, clip.durationSec)) return 0;
  if (!usable(take.startSec, take.durationSec)) return 0;
  const from = Math.max(clip.startSec, take.startSec);
  const to = Math.min(clip.startSec + clip.durationSec, take.startSec + take.durationSec);
  const overlap = to - from;
  if (overlap <= 0) return 0;
  return overlap / Math.min(clip.durationSec, take.durationSec);
}

/**
 * Where the appended take must be read from so the CLIP plays it correctly —
 * or `null` when it cannot be a take of this clip at all.
 *
 * THE POINT OF THIS FUNCTION. A take does not bring its own position with it: a
 * clip that gains one keeps its own `startSec` and `durationSec` and simply
 * reads different bytes. So the take's read head has to be moved from the take's
 * own anchor to the CLIP's, or the clip plays the take's material from the wrong
 * moment — a pass punched at 100 s appended to a clip that starts at 0 would
 * play those eight seconds at the clip's head and silence for the rest of it.
 *
 * Two refusals, and both send the pass to a clip of its own:
 *
 *   - the clip starts BEFORE the take. The read head would be negative, which
 *     no source can express: there are no bytes from before the recording
 *     started. No tolerance here, deliberately — a clamp to 0 would silently
 *     slide the take against the clip.
 *   - the clip ends after the take's writable span does, by more than
 *     `TAKE_COVER_TOLERANCE_SEC`. The tail of the clip would play silence the
 *     moment the take was activated, which is not an alternate reading of the
 *     clip — it is a fragment of one. A partial pass belongs in a COMP region
 *     (the take is kept, and only the stretch it covers plays it); until the
 *     comp UI exists it is honest to leave it as its own clip, where the user
 *     can see and move it.
 *
 * "Writable span" is the take AFTER the punch crop, which is what makes the
 * punch window hold: material the window excluded can never be read back in
 * through a take, because a clip reaching outside the window is refused here.
 */
export function takeReadOffsetFor(clip: TakeTargetClip, take: TakeSpan): number | null {
  if (!usable(clip.startSec, clip.durationSec)) return null;
  if (!usable(take.startSec, take.durationSec)) return null;
  const head = isNum(take.offsetIntoSource) ? take.offsetIntoSource : 0;
  if (head < 0) return null;
  const aligned = head + (clip.startSec - take.startSec);
  if (aligned < 0) return null;
  const clipEnd = clip.startSec + clip.durationSec;
  const takeEnd = take.startSec + take.durationSec;
  if (clipEnd > takeEnd + TAKE_COVER_TOLERANCE_SEC) return null;
  return aligned;
}

/**
 * The clip this take belongs to, or `null` when it belongs to none and should
 * land as a clip of its own.
 *
 * `clipsOnTrack` is the take's OWN track; the caller filters, because a clip on
 * another lane is never a candidate however it overlaps in time.
 *
 * Three kinds of clip are stepped over:
 *
 *   - a clip with no length. There is no span to share.
 *   - a `'piano-roll'` clip. Its audio is a render of its notes and is replaced
 *     wholesale whenever the instrument changes, so an audio take hung off it
 *     would be discarded by the next render — and "Edit in Piano Roll" would
 *     open material the clip is no longer playing. (The mic engine is not armed
 *     for a MIDI track at all, `lib/midiCapture.capturesMidi`; this covers the
 *     track that holds one old MIDI clip and is recording audio now.)
 *   - every clip, when the TAKE has no measured length: a pass whose transport
 *     never rolled reports 0 here and has its length repaired from the decode
 *     moments later. Matching on a length already known to be wrong would bury
 *     that pass inside a clip it may not overlap at all, so it lands beside
 *     them — which is what every such pass did before takes existed.
 *
 * A candidate must also be one the take can actually BE — see
 * `takeReadOffsetFor`, which is the stricter of the two tests: a take that
 * covers the clip from a representable read head necessarily overlaps it by all
 * of the shorter span. Both are applied, and in this order, because the overlap
 * ratio is the rule this feature is specified by and reads as the reason a pass
 * was or was not a take, while the coverage test is the reason the take SOUNDS
 * right once it is one.
 *
 * Of the candidates, the biggest overlap wins; a tie goes to the EARLIER clip,
 * so the answer never depends on the order the clip array happens to be in.
 */
export function matchClipForTake(
  clipsOnTrack: readonly TakeTargetClip[],
  take: TakeSpan,
): string | null {
  if (!usable(take.startSec, take.durationSec)) return null;
  let best: TakeTargetClip | null = null;
  let bestRatio = 0;
  for (const clip of clipsOnTrack) {
    if (clip.sourceKind === 'piano-roll') continue;
    const ratio = takeOverlapRatio(clip, take);
    if (ratio + RATIO_EPS < TAKE_OVERLAP_MIN) continue;
    if (takeReadOffsetFor(clip, take) === null) continue;
    if (!best || ratio > bestRatio + RATIO_EPS) {
      best = clip;
      bestRatio = ratio;
      continue;
    }
    // A tie on overlap: the earlier clip takes it.
    if (ratio + RATIO_EPS >= bestRatio && clip.startSec < best.startSec) {
      best = clip;
      bestRatio = Math.max(bestRatio, ratio);
    }
  }
  return best ? best.id : null;
}

/**
 * What to call the take about to be appended to `clip`.
 *
 * A clip with no `takes` is not a clip with no takes: its own media becomes
 * `takes[0]` the moment a second one lands (`editorStore.addTakeToClip`), so it
 * is already holding take 1 and the pass arriving is take 2. The number counts
 * THIS clip's takes — unlike the session-wide numbering `recordingStore` gives
 * a brand-new clip — because it is read beside the other takes of the same
 * clip, where "Take 3" has to mean the third of them.
 */
export function nextTakeLabel(clip: Pick<TakeTargetClip, 'takes' | 'label'>): string {
  // A clip with no `takes` is not a clip with no takes: its own media becomes
  // `takes[0]` the moment a second one lands, carrying the clip's own label, so
  // that label is in the running too.
  const held: readonly (string | undefined)[] = clip.takes && clip.takes.length > 0
    ? clip.takes.map((t) => t.label)
    : [clip.label];
  // Counting is the floor, not the answer: a clip whose takes are `Take 1` and
  // `Take 4` (two of them deleted, or imported under names of their own) must
  // not produce a second `Take 3`. The highest number already used wins.
  let next = held.length + 1;
  for (const label of held) {
    const m = /^take\s+(\d+)$/i.exec((label ?? '').trim());
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n + 1 > next) next = n + 1;
  }
  // Belt and braces: a label that is taken for any other reason is stepped over
  // rather than duplicated, because two takes reading `Take 3` in a list are
  // indistinguishable to the person choosing between them.
  const taken = new Set(held.map((l) => (l ?? '').trim()));
  while (taken.has(`Take ${next}`)) next += 1;
  return `Take ${next}`;
}
