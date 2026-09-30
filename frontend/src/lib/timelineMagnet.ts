/**
 * Clip magnetism for the EDIT timeline: where a dragged clip actually lands.
 *
 * The grid was the only thing a drag ever snapped to (`editorStore.snapSec`
 * rounds to a BPM note step), so butting one clip exactly against the end of
 * another was only possible when that edge happened to fall on the grid. At
 * 99.384 BPM with 1/16 snap the grid lands every 151 ms — a clip boundary
 * almost never sits on it, so "line these two up" was a zoom-in-and-nudge job.
 *
 * This adds the other half: the clip's leading AND trailing edge magnetise to
 * the edges of every other clip, the playhead, markers and the loop region.
 * Nearest candidate wins outright, grid included, so magnetism never drags a
 * clip further than the grid would have — it only ever offers a closer answer.
 *
 * Pure — no React, no store, no DOM — so the test runs under plain node.
 */

/** Everything a drag can stick to, in timeline seconds. */
export interface MagnetTargets {
  /** Leading/trailing edges of the clips NOT being dragged. */
  clipEdges: readonly number[];
  /** The playhead, markers, loop bounds — anything else worth lining up on. */
  cues: readonly number[];
}

/**
 * Collect the stick points for a drag. `movingIds` are excluded so a clip never
 * magnetises to the position it is being dragged away from.
 */
export function magnetTargetsFor(
  clips: readonly { id: string; startSec: number; durationSec: number }[],
  movingIds: readonly string[],
  cues: readonly (number | null | undefined)[] = [],
): MagnetTargets {
  const moving = new Set(movingIds);
  const clipEdges: number[] = [];
  for (const c of clips) {
    if (moving.has(c.id)) continue;
    clipEdges.push(c.startSec, c.startSec + c.durationSec);
  }
  return {
    clipEdges,
    cues: cues.filter((c): c is number => typeof c === 'number' && Number.isFinite(c)),
  };
}

/**
 * The start time a clip dragged to `desiredStart` should take.
 *
 * Both of the clip's own edges are offered to every target: sticking the END to
 * a target means starting at `target - durationSec`, which is what makes a clip
 * butt up flush against the one before it.
 *
 * `gridStart` is what the grid snap would have returned, or null when snap is
 * off. It competes as just another candidate, so whichever is closest to where
 * the pointer actually is wins. With no candidate inside `toleranceSec`, the
 * grid answer stands (or the raw position, snap off).
 */
export function magnetStart(
  desiredStart: number,
  durationSec: number,
  targets: MagnetTargets,
  toleranceSec: number,
  gridStart: number | null,
): number {
  const fallback = gridStart ?? desiredStart;
  if (!(toleranceSec > 0)) return fallback;

  let best = fallback;
  // The grid only wins by being closer than an edge, so it starts out at its
  // real distance rather than at infinity.
  let bestDelta = gridStart === null ? Infinity : Math.abs(gridStart - desiredStart);

  const offer = (candidateStart: number) => {
    if (candidateStart < 0) return;
    const delta = Math.abs(candidateStart - desiredStart);
    if (delta > toleranceSec) return;
    // Ties go to the earlier candidate so a drag is never ambiguous between two
    // equidistant edges — the same gesture always lands the same way.
    if (delta < bestDelta || (delta === bestDelta && candidateStart < best)) {
      best = candidateStart;
      bestDelta = delta;
    }
  };

  for (const t of targets.clipEdges) {
    offer(t);                 // our leading edge onto the target
    offer(t - durationSec);   // our trailing edge onto the target
  }
  for (const t of targets.cues) {
    offer(t);
    offer(t - durationSec);
  }
  return Math.max(0, best);
}
