/**
 * crossfade — where two clips on a track overlap, and how loud each one is
 * across that overlap.
 *
 * There is no stored crossfade object and there deliberately isn't one: a
 * crossfade IS the overlap, derived from where the clips sit. Drag a clip and
 * the crossfade follows with no second piece of state to keep in step, and
 * nothing to migrate in saved projects.
 *
 * DESIGN SOURCE (read for its design only — NO code was copied from it):
 *   - ACE-Step-DAW `src/utils/crossfade.ts` (AGPL-3.0) — deriving regions by
 *     sorting and walking pairwise with an early exit, and the linear /
 *     equal-power gain pair.
 * That project is copyleft. Every line here was written from the described
 * behaviour. The equal-power pair is the sin/cos of t·π/2 this app's DJ
 * crossfader (`state/djEngine.ts` `crossGains`) already uses.
 */

/** Crossfade shapes. Equal power holds `in² + out² = 1` so a crossfade between
 *  two uncorrelated sources keeps a steady loudness; linear holds
 *  `in + out = 1`, which dips in the middle but is right for two takes of the
 *  same performance. */
export type CrossfadeCurve = 'linear' | 'equal-power';

/** The part of a clip an overlap is derived from. `AudioClip` satisfies it
 *  structurally, so `lib/` needs no `state/` import. */
export interface CrossfadeClip {
  id: string;
  startSec: number;
  durationSec: number;
}

/** One overlap between two clips, in timeline seconds. */
export interface CrossfadeRegion {
  /** The earlier clip — the one that fades OUT across the region. */
  outId: string;
  /** The later clip — the one that fades IN across the region. */
  inId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface CrossfadeGains {
  /** Gain for the incoming (later) clip. */
  in: number;
  /** Gain for the outgoing (earlier) clip. */
  out: number;
}

/**
 * Every overlap between the clips of ONE track, ordered by the earlier clip and
 * then by where the overlap starts.
 *
 * Clips that merely touch are not an overlap: a region needs length. Three
 * clips that all overlap produce all three pairs, because each pair really does
 * have to duck against the other. The walk sorts by start time and stops
 * scanning forward from a clip as soon as a later one starts at or after its
 * end, since nothing further along can reach back.
 */
export function crossfadeRegions(clips: readonly CrossfadeClip[]): CrossfadeRegion[] {
  if (clips.length < 2) return [];
  const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
  const regions: CrossfadeRegion[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const aEnd = a.startSec + a.durationSec;
    if (!(a.durationSec > 0)) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      if (b.startSec >= aEnd) break; // sorted by start, so nothing later reaches back
      if (!(b.durationSec > 0)) continue;
      const startSec = b.startSec;
      const endSec = Math.min(aEnd, b.startSec + b.durationSec);
      if (endSec <= startSec) continue;
      regions.push({ outId: a.id, inId: b.id, startSec, endSec, durationSec: endSec - startSec });
    }
  }
  return regions;
}

/**
 * The gain pair at timeline time `tSec` inside `region`. Before the region the
 * outgoing clip is still at full and the incoming one silent; after it, the
 * other way round. A region with no length is already fully crossed.
 */
export function crossfadeGains(
  tSec: number,
  region: Pick<CrossfadeRegion, 'startSec' | 'endSec'>,
  curve: CrossfadeCurve = 'equal-power',
): CrossfadeGains {
  const span = region.endSec - region.startSec;
  if (!(span > 0)) return { in: 1, out: 0 };
  const raw = (tSec - region.startSec) / span;
  const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
  if (curve === 'linear') return { in: t, out: 1 - t };
  return { in: Math.sin((t * Math.PI) / 2), out: Math.cos((t * Math.PI) / 2) };
}
