/**
 * samplePeak — the one honest "how loud is this region" measurement.
 *
 * Pure maths over already-decoded channel data: no store, no DOM, no
 * AudioContext, no Blob. That keeps it runnable in plain node (see
 * `samplePeak.test.ts`) and reusable from both a real decode (raw channel
 * data) and the app's cached, bin-normalised waveform peaks — whichever the
 * caller has on hand — without this module knowing or caring which.
 */

/**
 * A half-open sample window, `[startSample, endSample)`, on the channel
 * arrays passed to `samplePeak`/`samplePeakDb`. Both bounds are in samples.
 * Omitting a bound means "to the edge of the buffer on that side"; omitting
 * the whole region means the whole buffer.
 */
export interface PeakRegion {
  startSample?: number;
  endSample?: number;
}

/**
 * Resolve a region against ONE channel's own length: a missing bound reaches
 * to that edge of the buffer, a negative start clamps to 0, an end past the
 * channel clamps to the channel's length, and a degenerate window
 * (`end <= start`) resolves to an empty span rather than throwing. Bounds are
 * forced to integers — `start` floors and `end` ceils — because both feed a
 * `Float32Array` index directly: a fractional index (e.g. `channel[0.5]`) is
 * `undefined`, which reads as non-finite and gets silently skipped, so every
 * sample in the region would vanish instead of being measured.
 */
const resolveRegion = (length: number, region: PeakRegion | undefined): { start: number; end: number } => {
  const rawStart = region?.startSample;
  const rawStartValid = typeof rawStart === 'number' && Number.isFinite(rawStart) && rawStart >= 0;
  const start = Math.max(0, Math.floor(rawStartValid ? rawStart : 0));
  const rawEnd = region?.endSample;
  const rawEndValid = typeof rawEnd === 'number' && Number.isFinite(rawEnd) && rawEnd <= length;
  const end = Math.min(length, Math.ceil(rawEndValid ? rawEnd : length));
  return end > start ? { start, end } : { start: 0, end: 0 };
};

/**
 * The loudest sample across every channel within `region`, in LINEAR full-
 * scale units (1 = full scale). Each channel's region is clamped to that
 * channel's own bounds (see `resolveRegion`), so channels of different
 * lengths are each read safely rather than throwing. Non-finite samples
 * (NaN/Infinity) are skipped, never returned. 0 for no channels, an empty
 * region, or all-zero data.
 */
export function samplePeak(channels: ReadonlyArray<Float32Array>, region?: PeakRegion): number {
  let peak = 0;
  for (const channel of channels) {
    const { start, end } = resolveRegion(channel.length, region);
    for (let i = start; i < end; i += 1) {
      const value = channel[i];
      if (!Number.isFinite(value)) continue;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

/**
 * `samplePeak`, in dBFS (`20 * log10(peak)`). `Number.NEGATIVE_INFINITY` for
 * silence (peak 0), matching the fact that true silence has no dB level.
 */
export function samplePeakDb(channels: ReadonlyArray<Float32Array>, region?: PeakRegion): number {
  const peak = samplePeak(channels, region);
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/**
 * The gain, in dB, that takes a region currently peaking at `currentPeakDb`
 * up (or down) to `targetDb`. Silence (`currentPeakDb === -Infinity`) can
 * never be normalised to a target, so that case reads as
 * `Number.POSITIVE_INFINITY` rather than a finite, misleading gain.
 */
export function gainDbToReachPeak(currentPeakDb: number, targetDb: number): number {
  if (currentPeakDb === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return targetDb - currentPeakDb;
}
