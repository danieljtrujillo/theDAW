/**
 * clipDragMath — the pure arithmetic behind dragging a clip: move, trim from
 * either edge, and slip the audio inside the clip.
 *
 * EDIT does move and the two trims inline inside a pointer handler
 * (`WaveformEditor.tsx` onPointerMove), which is why they have never been
 * tested and why slip does not exist at all. The functions here reproduce that
 * inline math EXACTLY when no snap function is passed — `clipDragMath.test.ts`
 * checks them against a transcription of it over a grid of clips and deltas —
 * so the component can hand its arithmetic over without changing behaviour.
 *
 * Snapping is deliberately NOT built in. The caller owns the grid (EDIT's
 * `snapSec` reads the store's snap division and bpm), so each function takes an
 * optional `snap` and applies it to the one value that should land on the grid.
 *
 * DESIGN SOURCE (read for its design only — NO code was copied from it):
 *   - ACE-Step-DAW `src/utils/dragMath.ts` (AGPL-3.0) — the idea of extracting
 *     drag arithmetic into pure functions with a shared minimum clip length,
 *     and the slip-edit clamp (`audioOffset` alone moves, bounded by how much
 *     source is left over).
 * That project is copyleft. Every line here was written from the described
 * behaviour, against this app's own field names and its existing inline math.
 */

/** Shortest clip a drag may leave, in seconds. This is the bound EDIT already
 *  enforces inline; the two trims differ in how they treat it, and that
 *  difference is preserved: the right edge CLAMPS to it, the left edge REFUSES
 *  the drag outright (the clip is left exactly as it was). */
export const MIN_CLIP_SEC = 0.05;

/** The part of a clip these gestures touch. `AudioClip` satisfies it
 *  structurally, so `lib/` needs no `state/` import. */
export interface DragClip {
  /** Position of the clip on the timeline, in seconds. */
  startSec: number;
  /** Length of the clip on the timeline, in seconds. */
  durationSec: number;
  /** Seconds into the source audio where the clip starts reading. */
  offsetIntoSource: number;
  /** Total length of the source audio, in seconds. */
  sourceDuration: number;
}

/** A grid quantiser, e.g. EDIT's `snapSec`. The identity when snapping is off. */
export type SnapFn = (sec: number) => number;

/** What a gesture leaves behind — the three fields a clip drag can change. */
export interface ClipDragResult {
  startSec: number;
  durationSec: number;
  offsetIntoSource: number;
}

/* Each gesture takes `snap` as an optional argument rather than defaulting it
 * to the identity, and the un-snapped path is written as the plain expression
 * the component uses today. Routing an un-snapped drag through `end - start`
 * or `snappedStart - start` would be the same number in real arithmetic but
 * not always in doubles — `(4 + 3 - 0.06) - 4` is one ULP away from
 * `3 - 0.06` — and the point of this module is to be swappable with no
 * behaviour change at all. */

/* ── Stretched clips: one view, one conversion ──────────────────────────────
 *
 * A clip that plays at rate `r` eats `r` seconds of source for every second of
 * timeline. Three of the gestures below measure a drag in TIMELINE seconds but
 * touch `offsetIntoSource` and `sourceDuration`, which are SOURCE seconds — so
 * something has to convert, and when each gesture converted for itself they
 * disagreed (resize-left added a timeline delta straight onto a source offset,
 * which at rate ≠ 1 moved the read head to the wrong place and changed how much
 * source the clip covered). The two functions here are the only conversion:
 * hand a gesture a timeline-denominated view, convert the offset it returns
 * back once. At rate 1 both are the identity, so an unstretched drag produces
 * exactly the numbers it always did. */

/**
 * The same clip with every length in TIMELINE seconds: how much timeline the
 * source before the read head would fill (`offsetIntoSource / rate`), and how
 * much the whole source would fill (`sourceDuration / rate`). `startSec` and
 * `durationSec` are already timeline, so they pass through untouched.
 */
export function toTimelineView(clip: DragClip, rate: number): DragClip {
  return {
    startSec: clip.startSec,
    durationSec: clip.durationSec,
    offsetIntoSource: clip.offsetIntoSource / rate,
    sourceDuration: clip.sourceDuration / rate,
  };
}

/** The inverse for the one field a gesture gives back in the timeline view:
 *  a read offset, returned to SOURCE seconds before it is stored. */
export function fromTimelineOffset(offsetTimelineSec: number, rate: number): number {
  return offsetTimelineSec * rate;
}

/**
 * Slide the whole clip along the timeline by `deltaSec`. The snapped start is
 * held at or after zero; the length and the audio under the clip are untouched.
 */
export function move(clip: DragClip, deltaSec: number, snap?: SnapFn): ClipDragResult {
  const raw = clip.startSec + deltaSec;
  return {
    startSec: Math.max(0, snap ? snap(raw) : raw),
    durationSec: clip.durationSec,
    offsetIntoSource: clip.offsetIntoSource,
  };
}

/**
 * Drag the clip's RIGHT edge by `deltaSec`, which changes only its length. The
 * snap lands on the clip's end time. The result is clamped to
 * `[MIN_CLIP_SEC, whatever source is left after the offset]`, so the edge can
 * never be dragged past the end of the audio — and never refuses the drag.
 */
export function resizeRight(clip: DragClip, deltaSec: number, snap?: SnapFn): ClipDragResult {
  const grown = snap
    ? snap(clip.startSec + clip.durationSec + deltaSec) - clip.startSec
    : clip.durationSec + deltaSec;
  const wanted = Math.max(MIN_CLIP_SEC, grown);
  const available = Math.max(MIN_CLIP_SEC, clip.sourceDuration - clip.offsetIntoSource);
  return {
    startSec: clip.startSec,
    durationSec: Math.min(wanted, available),
    offsetIntoSource: clip.offsetIntoSource,
  };
}

/**
 * Drag the clip's LEFT edge by `deltaSec`. The start, the read offset and the
 * length all move together, so the audio under the clip stays put.
 *
 * Returns `null` — the drag is refused and the clip left untouched — when it
 * would leave the clip at or under `MIN_CLIP_SEC`, or would read from before
 * the head of the source. The start is held at or after zero afterwards, which
 * (as in the current inline math) can shift a clip that was dragged past the
 * head of the timeline without shortening it.
 */
export function resizeLeft(clip: DragClip, deltaSec: number, snap?: SnapFn): ClipDragResult | null {
  const startSec = snap ? snap(clip.startSec + deltaSec) : clip.startSec + deltaSec;
  const delta = snap ? startSec - clip.startSec : deltaSec;
  const offsetIntoSource = clip.offsetIntoSource + delta;
  const durationSec = clip.durationSec - delta;
  if (durationSec <= MIN_CLIP_SEC || offsetIntoSource < 0) return null;
  return { startSec: Math.max(0, startSec), durationSec, offsetIntoSource };
}

/**
 * Slip the audio inside the clip by `deltaSec`: the clip does not move and does
 * not change length, only which part of the source it reads.
 *
 * The offset is clamped to `[0, sourceDuration - durationSec]`. A source no
 * longer than the clip has no slack at all, so it cannot slip — the offset is
 * returned unchanged rather than snapped to zero, which would jump a clip that
 * is already reading somewhere sensible.
 *
 * No snap: an offset into a source has nothing to do with the timeline grid.
 */
export function slip(clip: DragClip, deltaSec: number): ClipDragResult {
  const slack = clip.sourceDuration - clip.durationSec;
  if (!(slack > 0)) {
    return { startSec: clip.startSec, durationSec: clip.durationSec, offsetIntoSource: clip.offsetIntoSource };
  }
  const wanted = clip.offsetIntoSource + deltaSec;
  return {
    startSec: clip.startSec,
    durationSec: clip.durationSec,
    offsetIntoSource: Math.min(Math.max(0, wanted), slack),
  };
}
