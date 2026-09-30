/**
 * takeLaneLayout — the comping UI's arithmetic, kept out of the component.
 *
 * `lib/clipComp` is the MODEL (what a comp is and how it may be edited) and
 * `editorStore` is the document side of it. This file is the third piece: what
 * the take lanes LOOK like and what the keyboard does to them — rows to pixels,
 * regions to pixels, a pointer position back to a take and a time, the nearest
 * boundary to a caret, one snap step of a boundary, and the SOURCE-time rebase
 * a flatten print needs.
 *
 * It imports no React and touches no DOM, so `TakeLanes.tsx` is left with the
 * JSX and the event wiring and every rule below is arithmetic a plain `tsx`
 * test can pin.
 *
 * TWO CLOCKS, and the one place they meet. A comp is stored in CLIP-relative
 * seconds and read through the clip's stretch rate — `liveMixer.compParts`
 * places region `i` at `take.offsetIntoSource + startSec * rate` — so at rate 2
 * a boundary two seconds into the clip is four seconds into the take. The
 * pixel maths below works entirely in the CLIP clock (that is the clock the
 * timeline draws in, and the clock the store's actions take). `flattenPrintComp`
 * / `flattenPrintClip` are the single exception, and the only place a rate
 * appears: `editorStore.flattenComp` demands a print rendered at rate 1 over
 * `clipSourceSpanSec(clip)`, because the clip goes on reading that print through
 * its own ratio — so every boundary is rebased to where the SAME SOURCE MOMENT
 * lands once the rate is 1.
 *
 * DESIGN SOURCE (design only — no reference file was opened for this module and
 * NO code was copied from any of them): the take-lane presentation described in
 * the feature-gap plan's §3.7, whose model half `lib/clipComp.ts` already cites
 * (Tracktion Engine's `WaveAudioClip.cpp` / `TrackCompManager.h`, GPL-3.0 or
 * commercial — copyleft, and not read for this file).
 */
import { COMP_BOUNDARY_EPS, type CompRegion } from './clipComp';
import { clipStretchRate, clipSourceSpanSec, type AudioClip } from '../state/editorStore';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One take's row inside the lanes overlay, in pixels from the overlay's top. */
export interface TakeLaneRow {
  takeIndex: number;
  topPx: number;
  heightPx: number;
}

/**
 * A comp region as it is painted: its own stretch of the clip, in seconds and
 * in pixels.
 *
 * `index` is the region's index in the STORED array, NOT its position among the
 * spans that survived, because that index is what `moveCompBoundary` and
 * `setCompCrossfade` name. A region with no length is dropped from the paint
 * and the indices around it do not shuffle up.
 */
export interface CompRegionSpan {
  index: number;
  takeIndex: number;
  startSec: number;
  endSec: number;
  leftPx: number;
  widthPx: number;
  /** The crossfade at this region's LEADING boundary; 0 for a butt cut. */
  crossfadeSec: number;
}

/** A draggable boundary: the one that OPENS `regionIndex`. Region 0 opens at the
 *  clip head, which is not a boundary between two takes, so it is never here. */
export interface CompBoundaryHandle {
  regionIndex: number;
  atSec: number;
  xPx: number;
}

/** The crossfade lengths the region menu offers, in milliseconds. 0 is the butt
 *  cut every boundary starts as; 100 ms is about as long as a seam between two
 *  takes of one performance can get before it smears the transient. */
export const COMP_CROSSFADE_CHOICES_MS: readonly number[] = [0, 10, 25, 50, 100];

/**
 * One row per take, dividing `heightPx` exactly.
 *
 * The heights are FRACTIONAL on purpose: rounding each row down leaves the last
 * one short of the bottom by up to `takeCount - 1` pixels, which reads as the
 * overlay having slipped rather than as a rounding artefact. The browser
 * resolves the sub-pixel edges itself and the rows tile with no seam.
 */
export function takeLaneRows(takeCount: number, heightPx: number): TakeLaneRow[] {
  if (!isNum(takeCount) || takeCount < 1) return [];
  if (!isNum(heightPx) || heightPx <= 0) return [];
  const count = Math.floor(takeCount);
  const h = heightPx / count;
  const rows: TakeLaneRow[] = [];
  for (let i = 0; i < count; i += 1) rows.push({ takeIndex: i, topPx: i * h, heightPx: h });
  return rows;
}

/**
 * Which take's row a y lands in, or `null` outside the overlay.
 *
 * The BOTTOM EDGE belongs to the last row: `y === heightPx` is where a pointer
 * released on the overlay's own border reports, and picking nothing there would
 * make the bottom take the one row a click can miss.
 */
export function takeLaneIndexAtY(y: number, takeCount: number, heightPx: number): number | null {
  if (!isNum(y) || !isNum(takeCount) || takeCount < 1) return null;
  if (!isNum(heightPx) || heightPx <= 0) return null;
  if (y < 0 || y > heightPx) return null;
  const count = Math.floor(takeCount);
  const idx = Math.floor((y / heightPx) * count);
  return idx < 0 ? 0 : idx >= count ? count - 1 : idx;
}

/** A clip-relative pixel back to a clip-relative second, held inside the clip
 *  box so a drag that ran off the end picks the clip's last instant rather than
 *  a time the comp model would refuse. */
export function laneSecAtX(xPx: number, zoom: number, clipDurationSec: number): number {
  if (!isNum(xPx) || !isNum(zoom) || zoom <= 0) return 0;
  const dur = isNum(clipDurationSec) && clipDurationSec > 0 ? clipDurationSec : 0;
  const sec = xPx / zoom;
  return sec <= 0 ? 0 : sec >= dur ? dur : sec;
}

/**
 * What the lanes PAINT, which is not quite what is stored.
 *
 * A clip with takes but no comp yet is playing its active take everywhere, and
 * painting nothing there would leave the lanes blank until the first pick. So
 * the empty comp is shown as the one region the store itself would seed —
 * `setCompRegionAt` seeds `[{ startSec: 0, takeIndex: active }]` before it picks
 * — and the paint therefore does not jump when that pick lands.
 *
 * FOR PAINTING ONLY: nothing derived from this is written back, and the region
 * INDICES it yields are the stored ones (there is exactly one, index 0, which is
 * the clip head and so never a boundary the user can drag).
 */
export function laneComp(
  comp: readonly CompRegion[] | undefined,
  activeTakeIndex: number | undefined,
): CompRegion[] {
  if (comp && comp.length > 0) return comp.map((r) => ({ ...r }));
  const active = Number.isInteger(activeTakeIndex) && (activeTakeIndex as number) >= 0
    ? (activeTakeIndex as number)
    : 0;
  return [{ startSec: 0, takeIndex: active }];
}

/** Where region `i` ends: the next region's start, or the clip end. */
const endOf = (comp: readonly CompRegion[], i: number, dur: number): number =>
  (i + 1 < comp.length && isNum(comp[i + 1]?.startSec) ? comp[i + 1].startSec : dur);

/**
 * The regions as painted, in stored order. Assumes the ascending, head-anchored
 * list `editorStore` guarantees (every comp in the document has been through
 * `clipComp.normalizeComp`); regions with no length are dropped rather than
 * painted as zero-width slivers.
 */
export function compRegionSpans(
  comp: readonly CompRegion[] | undefined,
  clipDurationSec: number,
  zoom: number,
): CompRegionSpan[] {
  if (!comp || comp.length === 0) return [];
  if (!isNum(clipDurationSec) || clipDurationSec <= 0) return [];
  if (!isNum(zoom) || zoom <= 0) return [];
  const dur = clipDurationSec;
  const spans: CompRegionSpan[] = [];
  for (let i = 0; i < comp.length; i += 1) {
    const r = comp[i];
    if (!r || !isNum(r.startSec)) continue;
    const startSec = r.startSec <= 0 ? 0 : r.startSec >= dur ? dur : r.startSec;
    const rawEnd = endOf(comp, i, dur);
    const endSec = rawEnd >= dur ? dur : rawEnd;
    if (!(endSec > startSec)) continue;
    spans.push({
      index: i,
      takeIndex: r.takeIndex,
      startSec,
      endSec,
      leftPx: startSec * zoom,
      widthPx: (endSec - startSec) * zoom,
      crossfadeSec: isNum(r.crossfadeSec) && r.crossfadeSec > 0 ? r.crossfadeSec : 0,
    });
  }
  return spans;
}

/** The draggable boundaries: one per region after the first. */
export function compBoundaryHandles(
  comp: readonly CompRegion[] | undefined,
  clipDurationSec: number,
  zoom: number,
): CompBoundaryHandle[] {
  if (!comp || comp.length < 2) return [];
  if (!isNum(clipDurationSec) || clipDurationSec <= 0) return [];
  if (!isNum(zoom) || zoom <= 0) return [];
  const out: CompBoundaryHandle[] = [];
  for (let i = 1; i < comp.length; i += 1) {
    const r = comp[i];
    if (!r || !isNum(r.startSec)) continue;
    if (r.startSec <= 0 || r.startSec >= clipDurationSec) continue;
    out.push({ regionIndex: i, atSec: r.startSec, xPx: r.startSec * zoom });
  }
  return out;
}

/**
 * The region CONTAINING `atSec` — the last one starting at or before it, so a
 * boundary belongs to the region it opens. A time outside the clip resolves to
 * the nearest end, because the comp covers the clip from head to tail and
 * "which take is playing there" always has an answer. `null` only when there is
 * no comp at all.
 */
export function compRegionIndexAt(comp: readonly CompRegion[] | undefined, atSec: number): number | null {
  if (!comp || comp.length === 0) return null;
  if (!isNum(atSec)) return null;
  let idx = 0;
  for (let i = 0; i < comp.length; i += 1) {
    if (!isNum(comp[i]?.startSec)) continue;
    if (comp[i].startSec > atSec) break;
    idx = i;
  }
  return idx;
}

/**
 * The boundary nearest `atSec` — what `[` and `]` act on. Region 0 is excluded
 * (the clip head is not a boundary), so `null` means the clip has no boundary
 * to move. A TIE goes to the earlier boundary, so the answer never turns on
 * float noise in whichever comparison happened to run first.
 */
export function nearestCompBoundary(comp: readonly CompRegion[] | undefined, atSec: number): number | null {
  if (!comp || comp.length < 2) return null;
  if (!isNum(atSec)) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < comp.length; i += 1) {
    if (!isNum(comp[i]?.startSec)) continue;
    const d = Math.abs(comp[i].startSec - atSec);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}

/**
 * Where one snap step moves the boundary that opens `regionIndex`: `direction`
 * is +1 for `]` and -1 for `[`.
 *
 * Clamped STRICTLY between its neighbours by the same `COMP_BOUNDARY_EPS` gap
 * `clipComp.moveBoundary` uses, so a step that would collapse a region lands a
 * hair short of it and every boundary the user made survives. `null` when the
 * index names no boundary, the step is not a number, or the neighbours leave no
 * room at all — the caller writes nothing rather than calling the store with a
 * value it would refuse.
 */
export function steppedBoundarySec(
  comp: readonly CompRegion[] | undefined,
  regionIndex: number,
  direction: 1 | -1,
  stepSec: number,
  clipDurationSec: number,
): number | null {
  if (!comp || comp.length === 0) return null;
  if (!Number.isInteger(regionIndex) || regionIndex < 1 || regionIndex >= comp.length) return null;
  if (!isNum(stepSec) || stepSec <= 0) return null;
  if (!isNum(clipDurationSec) || clipDurationSec <= 0) return null;
  const here = comp[regionIndex];
  const prev = comp[regionIndex - 1];
  if (!isNum(here?.startSec) || !isNum(prev?.startSec)) return null;
  const lo = prev.startSec + COMP_BOUNDARY_EPS;
  const hi = endOf(comp, regionIndex, clipDurationSec) - COMP_BOUNDARY_EPS;
  if (!(hi >= lo)) return null;
  const wanted = here.startSec + direction * stepSec;
  return wanted <= lo ? lo : wanted >= hi ? hi : wanted;
}

/**
 * The comp rebased into SOURCE time, for a flatten print.
 *
 * A boundary stored at clip-relative `t` reads its take at
 * `offsetIntoSource + t * rate`; the print is rendered at rate 1, so the same
 * source moment sits at `t * rate` in it. The crossfade is a LENGTH in the same
 * clock and rides the same factor. At rate 1 — every clip that is not stretched
 * — this is the identity, and a rate that is not a usable rate leaves the comp
 * exactly where it is rather than sending every boundary to NaN.
 *
 * No `crossfadeSec` KEY is written where there was none, so the regions still
 * compare and serialize the way `clipComp` writes them.
 */
export function flattenPrintComp(comp: readonly CompRegion[] | undefined, rate: number): CompRegion[] {
  if (!comp || comp.length === 0) return [];
  const r = isNum(rate) && rate > 0 ? rate : 1;
  if (r === 1) return comp.map((x) => ({ ...x }));
  return comp.map((x) => (
    isNum(x.crossfadeSec) && x.crossfadeSec > 0
      ? { startSec: x.startSec * r, takeIndex: x.takeIndex, crossfadeSec: x.crossfadeSec * r }
      : { startSec: x.startSec * r, takeIndex: x.takeIndex }
  ));
}

/**
 * The synthetic clip a `Flatten comp` bounce renders — a SOURCE, not the clip
 * as it sounds.
 *
 * `editorStore.flattenComp`'s doc comment is the contract this satisfies, and
 * it refuses anything else: the clip keeps its own length, gain, fades, stretch
 * ratio and warp after the flatten and reads the print through all of them, so
 * printing the clip AS IT SOUNDS would hand a rate-2 clip half the audio it
 * needs and silently truncate it. Hence:
 *
 *  - rate FORCED to 1 over `clipSourceSpanSec(clip)` seconds, with the comp
 *    rebased to match (`flattenPrintComp`);
 *  - no clip gain, no fades, not muted — every one of those is a property of
 *    the CLIP and stays on it;
 *  - `startSec: 0`, so the render's extent is exactly the span and the print
 *    begins at the head of its own bytes;
 *  - a NEW id, so the print is never mistaken for the document's clip, and the
 *    same `trackId`, because a bounce still groups its clips by track.
 *
 * The takes, the active index and the blobs ride along BY REFERENCE: this is a
 * re-scoped view of the same audio, never a copy of the bytes.
 *
 * Warp is dropped here, but a warped clip must not reach this at all — live
 * plays the active take only for a warped comp (`liveMixer.compParts`), so a
 * flatten would print what preview refuses to play. The caller disables the
 * menu item; this is the second line of that defence, not the first.
 */
export function flattenPrintClip(clip: AudioClip, idSuffix = 'flatten'): AudioClip {
  const rate = clipStretchRate(clip);
  return {
    ...clip,
    id: `${clip.id}::${idSuffix}`,
    startSec: 0,
    durationSec: clipSourceSpanSec(clip),
    timeStretchRate: 1,
    stretchMode: 'repitch',
    comp: flattenPrintComp(clip.comp, rate),
    gain: 1,
    muted: false,
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: undefined,
    fadeOutCurve: undefined,
    warpMarkers: undefined,
  };
}
