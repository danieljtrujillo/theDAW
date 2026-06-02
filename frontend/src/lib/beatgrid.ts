/**
 * Constant beatgrid — Mixxx-style.
 *
 * The analyzer reports raw per-beat times (librosa/aubio), which can wander a
 * few ms or drop/insert a beat. For DJ use (sync, quantize, loops) we want a
 * ROCK-STEADY grid: a single tempo (interval = 60 / BPM) anchored at the first
 * detected beat, regenerated uniformly across the track. That's what Mixxx
 * stores as a constant beatgrid (one BPM + one anchor) — drift-proof, so phase
 * sync can't be thrown off by a jittery raw beat.
 *
 * Pure + dependency-free. Returns null only when there's no tempo to anchor to.
 */

export interface Beatgrid {
  /** Grid tempo (BPM). Mirrors the analysis BPM when present. */
  bpm: number;
  /** Seconds per beat. */
  interval: number;
  /** The grid line nearest the start, in [0, interval) — the grid's phase. */
  anchor: number;
  /** Uniform beat times across [0, duration]. */
  beats: number[];
}

function medianInterval(beats: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1];
    if (d > 0 && Number.isFinite(d)) diffs.push(d);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/**
 * Build a constant beatgrid from analysis output.
 *
 * Tempo: 60/BPM when BPM is known (so the grid matches every other BPM-derived
 * number — display, sync, effective-BPM), else the median raw inter-beat
 * interval. Phase: aligned so a grid line passes through the first detected beat.
 */
export function buildBeatgrid(input: {
  bpm: number | null | undefined;
  beats: number[] | null | undefined;
  duration: number | null | undefined;
}): Beatgrid | null {
  const { bpm, beats, duration } = input;

  let interval = 0;
  if (bpm && bpm > 0) interval = 60 / bpm;
  else if (beats && beats.length >= 2) interval = medianInterval(beats);
  if (!(interval > 0) || !Number.isFinite(interval)) return null;

  const firstBeat = beats && beats.length > 0 ? beats[0] : 0;
  // Grid phase: the grid line nearest the start that still passes through the
  // first detected beat (firstBeat = anchor + k·interval for integer k).
  const anchor = firstBeat - Math.floor(firstBeat / interval) * interval;

  // Bound the grid: explicit duration, else the last raw beat + a beat of slack.
  const dur =
    duration && duration > 0
      ? duration
      : beats && beats.length > 0
        ? beats[beats.length - 1] + interval
        : null;

  const out: number[] = [];
  if (dur && dur > 0) {
    for (let t = anchor; t <= dur + 1e-6; t += interval) {
      out.push(Math.round(t * 1e6) / 1e6);
    }
  } else {
    out.push(anchor);
  }

  return { bpm: 60 / interval, interval, anchor, beats: out };
}
