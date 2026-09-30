/**
 * clipComp — takes and comping: the model, kept pure.
 *
 * A TAKE is one alternate recording of a clip. A COMP is the choice of which
 * take plays across which stretch of that clip, as an ordered list of regions:
 * region `i` runs from its own `startSec` to region `i+1`'s start, and the last
 * one runs to the clip's end. There is no stored "segment" object and no
 * parallel lane — a comp IS the boundary list, so dragging a boundary is one
 * number changing and there is nothing else to keep in step.
 *
 * TAKES HANG OFF THE CLIP, not off a second track. Our clips already carry
 * their own bytes, so an alternate take is another blob on the same clip; the
 * clip's own `audioBlob` / `mimeType` / `sourceDuration` / `offsetIntoSource` /
 * `peaks` always mirror `takes[activeTakeIndex]`. That invariant is what lets
 * every existing path — decode, peaks, schedule, bounce, export — keep working
 * unchanged on a clip that happens to have takes: with no comp, it plays the
 * active take and nothing else can tell the difference.
 *
 * This file is the MODEL. It imports nothing — no store, no AudioContext, no
 * Blob construction — so the rules can be tested as arithmetic. `editorStore`
 * owns the state, `liveMixer` / `renderCore` play the segments this derives.
 *
 * DESIGN SOURCE (design only — these files were NOT opened, and NO code was
 * copied from them):
 *   - Tracktion Engine `modules/tracktion_engine/model/clips/
 *     tracktion_WaveAudioClip.cpp` (GPL-3.0 or commercial) — takes as a list of
 *     alternate sources owned by the clip, with one of them active.
 *   - Tracktion Engine `modules/tracktion_engine/model/tracks/
 *     tracktion_TrackCompManager.h` (GPL-3.0 or commercial) — a comp as
 *     ordered section boundaries naming a take, with a crossfade at a boundary.
 * That project is copyleft. Both entries are cited from the feature-gap plan's
 * §3.7 description ("takes/comp model from Tracktion `WaveAudioClip.cpp` +
 * `TrackCompManager.h` — takes hang off the clip, not a parallel lane"); every
 * line below was written here from that behavioural description.
 *
 * The crossfade convention matches the rest of the app: `lib/crossfade.ts`
 * derives an overlap and `lib/clipFade.ts` writes the envelope over it, so a
 * comp boundary is expressed the same way — the outgoing segment is extended
 * half the crossfade past the boundary and the incoming one starts half early,
 * and both carry a fade of the full crossfade length across that window.
 *
 * The gain CURVE is not computed here, and the consumer should hand these fades
 * to `applyFadeAutomation` as **`'linear'`**, not equal-power. `crossfade.ts:19-22`
 * already states the rule this follows: equal power (`in² + out² = 1`) is for
 * two UNCORRELATED sources, while linear (`in + out = 1`) "is right for two
 * takes of the same performance". A comp seam is exactly that case — the same
 * part played twice, so the two takes are correlated and their sum adds
 * coherently; an equal-power pair would bulge at the seam rather than hold
 * level.
 */

/** One alternate recording of a clip. The fields mirror the `AudioClip` ones
 *  the active take supplies, so switching takes is a field copy. */
export interface ClipTake {
  id: string;
  label: string;
  /** Source audio Blob for this take (the bytes we play / decode peaks from). */
  audioBlob: Blob;
  mimeType: string;
  /** Total length of this take's source audio in seconds. */
  sourceDuration: number;
  /** Seconds into this take's source where the clip starts reading. */
  offsetIntoSource: number;
  /** Cached peaks for waveform rendering; lazy-populated, like the clip's. */
  peaks?: Float32Array;
}

/** Ordered, ascending, CLIP-relative seconds. Region i runs to region i+1's
 *  start; the last runs to the clip end. */
export interface CompRegion {
  startSec: number;
  takeIndex: number;
  /** Crossfade at this region's LEADING boundary, in seconds; 0/undefined = a
   *  butt cut. Meaningless (and stripped) on the first region — the clip head
   *  is not a boundary between two takes. */
  crossfadeSec?: number;
}

/** One take's stretch of playback, clip-relative, with the crossfade overhang
 *  already applied. `fadeInSec` / `fadeOutSec` are the full crossfade lengths
 *  at this segment's two ends (0 at a butt cut, at the clip head and at the
 *  clip end). Two adjacent segments OVERLAP by exactly the crossfade. */
export interface CompSegment {
  takeIndex: number;
  startSec: number;
  endSec: number;
  fadeInSec: number;
  fadeOutSec: number;
}

/** How close two boundaries may get, in seconds — a microsecond, well under a
 *  sample at any rate we run at. Dragging a boundary onto its neighbour would
 *  make a zero-length region, and deduping that away would delete whichever
 *  region the dedupe happened to lose; clamping to this gap keeps every
 *  boundary the user made. */
export const COMP_BOUNDARY_EPS = 1e-6;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A region with no `crossfadeSec` KEY at all when there is no crossfade, so
 *  the objects compare and serialize cleanly. */
const region = (startSec: number, takeIndex: number, crossfadeSec?: number): CompRegion =>
  (crossfadeSec === undefined ? { startSec, takeIndex } : { startSec, takeIndex, crossfadeSec });

const xfadeOf = (v: number | undefined): number | undefined => (isNum(v) && v > 0 ? v : undefined);

const durOf = (clipDurationSec: number): number => (isNum(clipDurationSec) && clipDurationSec > 0 ? clipDurationSec : 0);

/**
 * The structural invariants, without the take-RANGE check: finite ascending
 * starts inside the clip box, no duplicates, the first at the clip head, no
 * crossfade on that first region, and every `takeIndex` a non-negative integer.
 * Every exported operation ends here, so the lists they return are fixed points
 * of it and therefore compose.
 *
 * The index check here is structural only — it asks whether the value COULD
 * name a take, not whether that take exists, since the take count is not known
 * at this level. Without it a NaN or negative index survives into a
 * `CompSegment` and reaches a buffer resolver, which is not something a
 * downstream caller should have to defend against. `normalizeComp` is the one
 * place the index is checked against the actual number of takes.
 */
function sanitizeRegions(comp: readonly CompRegion[] | undefined, clipDurationSec: number): CompRegion[] {
  const dur = durOf(clipDurationSec);
  if (!comp || comp.length === 0 || dur === 0) return [];

  const kept: CompRegion[] = [];
  for (const raw of comp) {
    if (!raw || !isNum(raw.startSec)) continue;
    // Not a take index at all: NaN, a fraction, or negative.
    if (!Number.isInteger(raw.takeIndex) || raw.takeIndex < 0) continue;
    const startSec = raw.startSec <= 0 ? 0 : raw.startSec;
    // At or past the clip end a region has no length: it would play nothing and
    // only confuse the segment walk.
    if (startSec >= dur) continue;
    kept.push(region(startSec, raw.takeIndex, xfadeOf(raw.crossfadeSec)));
  }
  if (kept.length === 0) return [];

  // Stable, so the FIRST region written at a given instant is the one that
  // survives the dedupe below.
  kept.sort((a, b) => a.startSec - b.startSec);
  const out: CompRegion[] = [];
  for (const r of kept) {
    if (out.length > 0 && out[out.length - 1].startSec === r.startSec) continue;
    out.push(r);
  }
  // Whatever the first region claimed, the comp covers the clip from its head —
  // a gap at the front would leave that stretch playing no take at all. Its
  // crossfade goes too: there is nothing before the clip head to cross from.
  out[0] = region(0, out[0].takeIndex);
  return out;
}

/** Drop a region whose take is the same as the one before it: the boundary
 *  between them is not a boundary. */
function mergeEqualNeighbours(regions: readonly CompRegion[]): CompRegion[] {
  const out: CompRegion[] = [];
  for (const r of regions) {
    const prev = out[out.length - 1];
    if (prev && prev.takeIndex === r.takeIndex) continue;
    out.push(r);
  }
  return out;
}

/** Index of the region that CONTAINS `atSec` — the last one starting at or
 *  before it. Assumes a sanitized (ascending, head-anchored) list. */
function regionIndexAt(regions: readonly CompRegion[], atSec: number): number {
  let idx = 0;
  for (let i = 0; i < regions.length; i += 1) {
    if (regions[i].startSec > atSec) break;
    idx = i;
  }
  return idx;
}

/**
 * The comp as the rest of the app may rely on it: sorted, clamped into the clip
 * box, naming only takes that exist, no duplicate boundaries, first region at
 * the clip head. An empty result means NOT COMPED — the clip plays its own
 * `audioBlob` exactly as it always has.
 *
 * Adjacent regions naming the same take are deliberately NOT merged here: this
 * enforces structure, and `setRegionAt` is where a boundary that stopped being
 * a boundary is removed.
 */
export function normalizeComp(
  comp: CompRegion[] | undefined,
  takeCount: number,
  clipDurationSec: number,
): CompRegion[] {
  if (!comp || comp.length === 0) return [];
  if (!isNum(takeCount) || takeCount < 1) return [];
  const count = Math.floor(takeCount);
  const inRange = comp.filter(
    (r) => r && Number.isInteger(r.takeIndex) && r.takeIndex >= 0 && r.takeIndex < count,
  );
  return sanitizeRegions(inRange, clipDurationSec);
}

/**
 * What actually plays: one segment per region, with the crossfade overhang
 * applied. A crossfade L at a boundary runs the outgoing segment L/2 past it
 * and starts the incoming one L/2 early, so the two overlap by L and each
 * carries a fade of L across that window.
 *
 * The overhang each way is limited to HALF the length of both regions the
 * boundary joins. That half is what makes the two fades on any one segment fit
 * inside it: a region with a crossfade at each end takes at most half its own
 * length from either, so `fadeInSec + fadeOutSec <= endSec - startSec` always
 * holds and the consumer's `clipFade.clampClipFades` never has to shrink one
 * side of a seam (which would leave the two takes no longer summing across it).
 * The same limit is what keeps a crossfade longer than its neighbour inside the
 * clip box: with the first region anchored at 0 and the last running to the
 * end, no segment can reach outside [0, clipDurationSec].
 *
 * The input is normalized on the way in (minus the take-RANGE check, which
 * needs a take count and so stays in `normalizeComp` — the segments here can
 * still name a take that does not exist, and a resolver that has no buffer for
 * it schedules nothing), so a list straight off disk is safe to pass.
 */
export function compSegments(comp: CompRegion[], clipDurationSec: number): CompSegment[] {
  const regions = sanitizeRegions(comp, clipDurationSec);
  if (regions.length === 0) return [];
  const dur = durOf(clipDurationSec);

  /** Where region `i` ends with no crossfade: the next boundary, or the clip end. */
  const baseEnd = (i: number): number => (i + 1 < regions.length ? regions[i + 1].startSec : dur);

  // Half the effective crossfade at each region's LEADING boundary. Index 0 has
  // none: the clip head is not a boundary between two takes. Each side may give
  // up at most HALF its own region, so a region with a crossfade at both ends
  // still has its two fades fit inside the segment they land on.
  const half: number[] = regions.map(() => 0);
  for (let i = 1; i < regions.length; i += 1) {
    const asked = regions[i].crossfadeSec ?? 0;
    if (!(asked > 0)) continue;
    const prevLen = regions[i].startSec - regions[i - 1].startSec;
    const thisLen = baseEnd(i) - regions[i].startSec;
    const h = Math.min(asked / 2, prevLen / 2, thisLen / 2);
    half[i] = h > 0 ? h : 0;
  }

  const segments: CompSegment[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    const lead = half[i];
    const trail = i + 1 < regions.length ? half[i + 1] : 0;
    const startSec = Math.max(0, regions[i].startSec - lead);
    const endSec = Math.min(dur, baseEnd(i) + trail);
    if (!(endSec > startSec)) continue; // nothing to play
    segments.push({
      takeIndex: regions[i].takeIndex,
      startSec,
      endSec,
      fadeInSec: lead * 2,
      fadeOutSec: trail * 2,
    });
  }
  return segments;
}

/**
 * Cut a comp in two at `relSplitSec` (clip-relative), for `splitClipAt`.
 *
 * The left half keeps every region that starts before the cut. The right half
 * is re-based so its first region sits at 0: the region straddling the cut
 * continues there (carrying its take but not its crossfade, whose boundary is
 * now the right half's clip head), and everything after it moves back by the
 * cut. Both halves come back normalized against their OWN new lengths.
 */
export function splitCompAt(
  comp: CompRegion[],
  relSplitSec: number,
  clipDurationSec: number,
): { left: CompRegion[]; right: CompRegion[] } {
  const dur = durOf(clipDurationSec);
  const regions = sanitizeRegions(comp, dur);
  if (regions.length === 0) return { left: [], right: [] };

  const at = isNum(relSplitSec) ? relSplitSec : 0;
  if (at <= 0) return { left: [], right: regions };
  if (at >= dur) return { left: regions, right: [] };

  const left: CompRegion[] = [];
  const right: CompRegion[] = [];
  let seeded = false;
  for (const r of regions) {
    if (r.startSec < at) {
      left.push(region(r.startSec, r.takeIndex, r.crossfadeSec));
      continue;
    }
    if (r.startSec === at) {
      // The cut lands exactly on a boundary: that region opens the right half.
      seeded = true;
      right.push(region(0, r.takeIndex));
      continue;
    }
    right.push(region(r.startSec - at, r.takeIndex, r.crossfadeSec));
  }
  if (!seeded) {
    // The cut is INSIDE a region, so that region carries on into the right half.
    right.unshift(region(0, left[left.length - 1].takeIndex));
  }
  return {
    left: sanitizeRegions(left, at),
    right: sanitizeRegions(right, dur - at),
  };
}

/**
 * Click-to-pick: play `takeIndex` from `atSec` up to the next boundary.
 *
 * The region containing `atSec` is split there (or retargeted in place when the
 * click lands on its boundary), and any boundary that stops separating two
 * different takes is removed. On a clip with no comp yet there is no earlier
 * boundary to preserve, so the pick seeds ONE region over the whole clip; a
 * caller that wants the head to keep the active take seeds
 * `[{ startSec: 0, takeIndex: active }]` first and then picks.
 */
export function setRegionAt(
  comp: CompRegion[],
  atSec: number,
  takeIndex: number,
  clipDurationSec: number,
): CompRegion[] {
  const dur = durOf(clipDurationSec);
  const regions = sanitizeRegions(comp, dur);
  if (dur === 0) return regions;
  if (!Number.isInteger(takeIndex) || takeIndex < 0) return regions;

  const at = isNum(atSec) ? Math.max(0, Math.min(atSec, dur)) : 0;
  // At or past the clip end there is no room for a region.
  if (at >= dur) return regions;
  if (regions.length === 0) return [region(0, takeIndex)];

  const idx = regionIndexAt(regions, at);
  if (regions[idx].takeIndex === takeIndex) return regions; // already this take

  const out = regions.map((r) => region(r.startSec, r.takeIndex, r.crossfadeSec));
  if (regions[idx].startSec === at) {
    // On the boundary: retarget in place. The crossfade belongs to the boundary,
    // which is still there, so it stays.
    out[idx] = region(at, takeIndex, regions[idx].crossfadeSec);
  } else {
    // Inside: the region keeps its take up to the click, the rest is the pick.
    out.splice(idx + 1, 0, region(at, takeIndex));
  }
  return mergeEqualNeighbours(out);
}

/**
 * Drag the boundary that OPENS `regionIndex` to `toSec`, clamped strictly
 * between its neighbours (the previous boundary, and the next one or the clip
 * end) so the list stays ascending and no region is collapsed away. Region 0 is
 * the clip head rather than a boundary, so it cannot be dragged; an index that
 * names no boundary, or a target that is not a number, is a no-op.
 */
export function moveBoundary(
  comp: CompRegion[],
  regionIndex: number,
  toSec: number,
  clipDurationSec: number,
): CompRegion[] {
  const dur = durOf(clipDurationSec);
  const regions = sanitizeRegions(comp, dur);
  if (!Number.isInteger(regionIndex) || regionIndex < 1 || regionIndex >= regions.length) return regions;
  if (!isNum(toSec)) return regions;

  const lo = regions[regionIndex - 1].startSec + COMP_BOUNDARY_EPS;
  const hi = (regionIndex + 1 < regions.length ? regions[regionIndex + 1].startSec : dur) - COMP_BOUNDARY_EPS;
  if (!(hi >= lo)) return regions; // the neighbours leave no room

  const to = toSec <= lo ? lo : toSec >= hi ? hi : toSec;
  const out = regions.map((r) => region(r.startSec, r.takeIndex, r.crossfadeSec));
  out[regionIndex] = region(to, regions[regionIndex].takeIndex, regions[regionIndex].crossfadeSec);
  return out;
}

/**
 * Stable string for everything about a clip's comp that reaches the rendered
 * audio, for `freezeSignature` to fold in. Order-sensitive and deliberately NOT
 * normalized: it reports what is STORED, so any edit to the list changes it.
 * An absent comp and an empty one are the same thing, and an absent (or
 * nonsense) active take reads as take 0 — the invariant says the clip's own
 * blob mirrors `takes[0]` in that case.
 */
export function compDigest(comp: CompRegion[] | undefined, activeTakeIndex: number | undefined): string {
  const active = Number.isInteger(activeTakeIndex) && (activeTakeIndex as number) >= 0 ? activeTakeIndex : 0;
  const body = (comp ?? [])
    .filter((r) => !!r)
    .map((r) => `${r.startSec}:${r.takeIndex}:${r.crossfadeSec ?? 0}`)
    .join('|');
  return `${active}#${body}`;
}

/**
 * Is this clip actually COMPED — playing more than one take across its length?
 * Two takes with no comp is take SWITCHING, which needs none of the segment
 * machinery: the clip's own blob is the active take and everything downstream
 * plays it unchanged.
 */
export function isComped(clip: { takes?: ClipTake[]; comp?: CompRegion[] }): boolean {
  return (clip?.takes?.length ?? 0) > 1 && (clip?.comp?.length ?? 0) >= 1;
}
