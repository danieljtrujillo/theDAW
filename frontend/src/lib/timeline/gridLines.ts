/**
 * Tempo-aware bar / beat / subdivision grid lines for the timeline lanes.
 *
 * Units: every time value is in SECONDS on the timeline (0 = project start);
 * `zoom` is local CSS px per second, so a spacing of `sec * zoom` is local px.
 * The grid is anchored at 0 s: bar 0 starts at 0 and the tempo is constant.
 *
 * Pure and DOM-free so it can be unit-tested and reused by any renderer.
 */

export type GridLevel = 'bar' | 'beat' | 'sub';

export interface GridLine {
  /** Line position in seconds. */
  sec: number;
  /** Highest tier that falls on this position. */
  level: GridLevel;
  /** Zero-based bar the line sits in (a bar line starts bar `barIndex`). */
  barIndex: number;
}

export interface GridLinesArgs {
  /** Window start in seconds (inclusive). */
  startSec: number;
  /** Window end in seconds (inclusive), >= startSec. */
  endSec: number;
  /** Tempo in beats per minute, 1..999. */
  bpm: number;
  /** Beats per bar, positive integer. Default 4. */
  beatsPerBar?: number;
  /** Subdivision lines per beat, positive integer. Default 4. */
  subdivisionsPerBeat?: number;
  /** Local CSS px per second, > 0. */
  zoom: number;
  /** Tiers whose line spacing in local px falls below this are dropped. Default 6. */
  minSpacingPx?: number;
}

/** Hard ceiling on returned lines; beyond it the caller must window tighter. */
export const GRID_LINES_MAX = 5000;

/** Tolerance, in units of the step, for lines that sit on a window bound. */
const EPS = 1e-9;

const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

/**
 * Grid lines inside [startSec, endSec], sorted by time, one per position.
 *
 * Tiers are suppressed from the finest up: sub lines go when their spacing is
 * under `minSpacingPx`, then beat lines. When even bar lines are too close,
 * only every 2^k-th bar is kept, with k the smallest value that fits.
 *
 * @throws RangeError on non-finite or out-of-range input, or when the window
 *   would produce more than {@link GRID_LINES_MAX} lines.
 */
export function gridLines(a: GridLinesArgs): GridLine[] {
  const { startSec, endSec, bpm, zoom } = a;
  const beatsPerBar = a.beatsPerBar ?? 4;
  const subs = a.subdivisionsPerBeat ?? 4;
  const minSpacingPx = a.minSpacingPx ?? 6;

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new RangeError(`gridLines: startSec/endSec must be finite (got ${startSec}, ${endSec})`);
  }
  if (endSec < startSec) throw new RangeError(`gridLines: endSec ${endSec} < startSec ${startSec}`);
  if (!Number.isFinite(bpm) || bpm < 1 || bpm > 999) throw new RangeError(`gridLines: bpm must be in [1, 999] (got ${bpm})`);
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError(`gridLines: zoom must be > 0 (got ${zoom})`);
  if (!positiveInt(beatsPerBar)) throw new RangeError(`gridLines: beatsPerBar must be a positive integer (got ${beatsPerBar})`);
  if (!positiveInt(subs)) throw new RangeError(`gridLines: subdivisionsPerBeat must be a positive integer (got ${subs})`);
  if (!Number.isFinite(minSpacingPx) || minSpacingPx < 0) {
    throw new RangeError(`gridLines: minSpacingPx must be finite and >= 0 (got ${minSpacingPx})`);
  }

  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  const subSec = beatSec / subs;

  // The finest kept tier sets the step. `stepsPerBeat` is 0 once beats are
  // gone, and then `barStride` (a power of two) is the bars per step.
  let stepSec: number;
  let stepsPerBeat = 0; // 0 = step is a whole number of bars
  let barStride = 1;
  if (subs > 1 && subSec * zoom >= minSpacingPx) {
    stepSec = subSec;
    stepsPerBeat = subs;
  } else if (beatSec * zoom >= minSpacingPx) {
    stepSec = beatSec;
    stepsPerBeat = 1;
  } else {
    while (barSec * barStride * zoom < minSpacingPx) barStride *= 2;
    stepSec = barSec * barStride;
  }

  // `+ 0` folds the -0 that ceil() returns for tiny negatives into 0.
  const first = Math.ceil(startSec / stepSec - EPS) + 0;
  const last = Math.floor(endSec / stepSec + EPS);
  const count = last - first + 1;
  if (count <= 0) return [];
  if (count > GRID_LINES_MAX) {
    throw new RangeError(`gridLines: ${count} lines exceeds the ${GRID_LINES_MAX} cap; window the request`);
  }

  const out: GridLine[] = new Array(count);
  for (let n = first, i = 0; n <= last; n++, i++) {
    const sec = n * stepSec;
    if (stepsPerBeat === 0) {
      out[i] = { sec, level: 'bar', barIndex: n * barStride };
      continue;
    }
    const stepsPerBar = stepsPerBeat * beatsPerBar;
    const barIndex = Math.floor(n / stepsPerBar);
    const level: GridLevel = n % stepsPerBar === 0 ? 'bar' : n % stepsPerBeat === 0 ? 'beat' : 'sub';
    out[i] = { sec, level, barIndex };
  }
  return out;
}
