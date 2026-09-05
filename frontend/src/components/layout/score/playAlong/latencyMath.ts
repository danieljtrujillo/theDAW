/**
 * Pure arithmetic for the tap calibrator (LatencyCalibrator.tsx).
 *
 * The calibrator plays a metronome of short clicks scheduled on the audio
 * context's clock and records when the player taps along. Every tap is turned
 * into a delta against the nearest click; the offset the player hears/sees is
 * the median of the last few deltas minus the context's own output latency.
 * Keeping this in a module without DOM or audio imports lets it run under
 * node:assert.
 */

/** Clicks per calibration run. */
export const CALIBRATION_CLICKS = 12;
/** Seconds between clicks: 100 BPM. */
export const CALIBRATION_PERIOD_SEC = 0.6;
/** How many of the most recent taps the estimate is built from. */
export const CALIBRATION_LAST_N = 8;
/** Length of one click's envelope, seconds. */
export const CLICK_LENGTH_SEC = 0.03;
/** Click tone, Hz. */
export const CLICK_HZ = 1000;
/** Lead-in before the first click, seconds, so the first one is not swallowed
 *  by the context resuming. */
export const CLICK_LEAD_SEC = 0.5;
/** A tap further than this from every click is not a tap (a stray key press
 *  between beats); real device + reaction offsets sit well inside 200 ms. */
export const TAP_WINDOW_SEC = 0.2;

/** Scheduled click times: t0, t0 + period, ... */
export function clickTimes(
  t0: number,
  count: number = CALIBRATION_CLICKS,
  periodSec: number = CALIBRATION_PERIOD_SEC,
): number[] {
  const out: number[] = [];
  const n = Math.max(0, Math.floor(count));
  for (let k = 0; k < n; k += 1) out.push(t0 + k * periodSec);
  return out;
}

/** Index of the click nearest to `t` (ties go to the earlier click); -1 when
 *  there are no clicks. `clicks` must be sorted ascending. */
export function nearestClickIndex(clicks: readonly number[], t: number): number {
  if (clicks.length === 0 || !Number.isFinite(t)) return -1;
  let lo = 0;
  let hi = clicks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clicks[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first click >= t; the one before may be closer.
  if (lo > 0 && Math.abs(clicks[lo - 1] - t) <= Math.abs(clicks[lo] - t)) return lo - 1;
  return lo;
}

/**
 * Delta (seconds) between a tap and its nearest click, positive when the tap
 * came after the click. Null when the tap is further than `maxAbsSec` from
 * every click (a stray key press between beats is not a tap).
 */
export function tapDelta(
  clicks: readonly number[],
  tapSec: number,
  maxAbsSec: number = TAP_WINDOW_SEC,
): number | null {
  const i = nearestClickIndex(clicks, tapSec);
  if (i < 0) return null;
  const delta = tapSec - clicks[i];
  if (!Number.isFinite(delta) || Math.abs(delta) > maxAbsSec) return null;
  return delta;
}

/** Median of `values`; NaN when empty. */
export function median(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** max - min of `values`; 0 with fewer than two values. */
export function spread(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

export interface OffsetEstimate {
  /** The visual offset to apply, ms (positive = visuals later). */
  ms: number;
  /** max - min over the taps used, ms; a large spread means an unreliable run. */
  spreadMs: number;
  /** Taps the estimate was built from. */
  count: number;
}

/**
 * Turn tap deltas (seconds, tap minus click) into the offset estimate:
 * median of the last `lastN` deltas, minus the audio output latency the
 * context reports (the clicks were heard that much after their scheduled
 * time, which the taps therefore include). Null when there are no deltas.
 */
export function estimateOffsetMs(
  deltasSec: readonly number[],
  outputLatencySec: number,
  lastN: number = CALIBRATION_LAST_N,
): OffsetEstimate | null {
  const finite = deltasSec.filter((d) => Number.isFinite(d));
  if (finite.length === 0) return null;
  const used = finite.slice(Math.max(0, finite.length - Math.max(1, lastN)));
  const latency = Number.isFinite(outputLatencySec) ? outputLatencySec : 0;
  return {
    ms: (median(used) - latency) * 1000,
    spreadMs: spread(used) * 1000,
    count: used.length,
  };
}

/** Spread above which the run is flagged as noisy, ms. */
export const SPREAD_WARN_MS = 15;
