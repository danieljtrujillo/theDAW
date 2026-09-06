import type { CursorStep, ScoreTimeMap } from '../../scoreTimeMap';

/** Pure strip-scroll math for the SCORE tab's STRIP mode: maps every cursor
 *  step of a ScoreTimeMap to a pixel x on OSMD's single horizontal staffline,
 *  then answers "where is the sheet at second t" by interpolating between
 *  steps. No React, no OSMD import (structural types only) so it runs under
 *  plain node for its test and stays independent of the view that uses it. */

/** The subset of an OpenSheetMusicDisplay instance this module reads, after
 *  `load()` and `render()`. Declared structurally so nothing here pulls the
 *  OSMD bundle into a pure module. */
export interface OsmdGraphicalMeasureLike {
  PositionAndShape: {
    AbsolutePosition: { x: number };
    Size: { width: number };
  };
}

export interface OsmdSourceMeasureLike {
  AbsoluteTimestamp: { RealValue: number };
  Duration: { RealValue: number };
}

export interface OsmdLike {
  GraphicSheet: {
    /** `MeasureList[measureIndex][staffIndex]`; a hidden part (Instrument
     *  .Visible = false) leaves `undefined` holes, and a measure whose parts
     *  are ALL hidden has no graphical measure at all. */
    MeasureList: Array<Array<OsmdGraphicalMeasureLike | undefined | null> | undefined | null>;
    /** Rendered pages and their systems. A single-staffline render is ONE
     *  page with ONE system unless the score outgrew the width cap, in which
     *  case OSMD wraps the remainder into further systems (see
     *  `stripSystemCount`). Optional: the test doubles omit it. */
    MusicPages?: ReadonlyArray<{ MusicSystems: ReadonlyArray<unknown> } | undefined | null> | null;
  };
  Sheet: {
    SourceMeasures: OsmdSourceMeasureLike[];
  };
}

export interface StripXMap {
  /** Pixel x of each `map.steps[i]` on the rendered strip, non-decreasing. */
  stepX: Float64Array;
  /** Right edge of the last graphical measure in pixels (the scroll extent). */
  widthPx: number;
}

/** OSMD lays out in its own units; `unitInPixels` is 10 at zoom 1. */
const OSMD_UNIT_PX = 10;

/** Same bounds as the PAGE view's zoom cluster (ScoreView / scoreShared).
 *  Duplicated here so this module has no dependency on the React layer. */
export const STRIP_ZOOM_MIN = 0.4;
export const STRIP_ZOOM_MAX = 3;

/** Vertical breathing room fitZoomForHeight leaves inside the pane. */
const FIT_PADDING_PX = 8;

/** Above this many measure-staves (measures x visible parts) the strip view
 *  shows a notice suggesting the reader hide some parts. */
export const STRIP_SIZE_NOTICE = 4000;

/** OSMD 1.9.9 hard-caps a single horizontal staffline at this many pixels
 *  (EngravingRules.SheetMaximumWidth, and every backend crops its surface to
 *  the same width). A score wider than the cap at the current zoom is wrapped
 *  into a SECOND MusicSystem whose measures restart at x 0: the strip cannot
 *  scroll to them and buildStripXMap pins them to the right edge. Measured on
 *  the 109-measure band score: 6 parts wrap at zoom 0.64, fit at 0.45. */
export const STRIP_MAX_WIDTH_PX = 32767;

/** fitZoomForWidth aims this far under the cap so OSMD's last-system
 *  justification (up to LastSystemMaxScalingFactor) cannot tip it over. */
const WIDTH_FIT_TARGET = 0.98;

const clampZoom = (z: number): number => Math.min(STRIP_ZOOM_MAX, Math.max(STRIP_ZOOM_MIN, z));

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface MeasureBox {
  leftPx: number;
  widthPx: number;
  startWholes: number;
  durWholes: number;
}

/** First rendered staff of a measure, whichever part it belongs to. */
const firstGraphicalMeasure = (
  row: Array<OsmdGraphicalMeasureLike | undefined | null> | undefined | null,
): OsmdGraphicalMeasureLike | null => {
  if (!row) return null;
  for (const gm of row) {
    if (gm && gm.PositionAndShape) return gm;
  }
  return null;
};

/**
 * Build the per-step x map. Each step is placed proportionally inside its
 * source measure: `left + (wholeNotesIntoMeasure / measureDuration) * width`.
 * That is coarser than walking staff entries but needs only what every
 * rendered measure exposes, and the OSMD cursor hairline (driven separately)
 * remains the exact truth; this map only has to keep the scroll position
 * gliding smoothly and land within a fraction of a measure.
 *
 * A step whose measure has no graphical measure (every part hidden through
 * the PartFilter, or a measure OSMD chose not to draw) reuses the previous
 * step's x, and the whole map is forced non-decreasing so a layout oddity can
 * never make the strip scroll backwards while the audio moves forwards.
 */
export function buildStripXMap(osmd: OsmdLike, map: ScoreTimeMap, zoom: number): StripXMap {
  const scale = OSMD_UNIT_PX * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const measureList = osmd?.GraphicSheet?.MeasureList ?? [];
  const sourceMeasures = osmd?.Sheet?.SourceMeasures ?? [];

  const boxes: Array<MeasureBox | null> = new Array(sourceMeasures.length);
  let widthPx = 0;
  for (let m = 0; m < sourceMeasures.length; m += 1) {
    const gm = firstGraphicalMeasure(measureList[m]);
    const sm = sourceMeasures[m];
    if (!gm || !sm) {
      boxes[m] = null;
      continue;
    }
    const leftPx = gm.PositionAndShape.AbsolutePosition.x * scale;
    const w = gm.PositionAndShape.Size.width * scale;
    const box: MeasureBox = {
      leftPx: Number.isFinite(leftPx) ? leftPx : 0,
      widthPx: Number.isFinite(w) && w > 0 ? w : 0,
      startWholes: sm.AbsoluteTimestamp?.RealValue ?? 0,
      durWholes: sm.Duration?.RealValue ?? 0,
    };
    boxes[m] = box;
    const right = box.leftPx + box.widthPx;
    if (right > widthPx) widthPx = right;
  }

  const steps = map?.steps ?? [];
  const stepX = new Float64Array(steps.length);
  let prev = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const box = boxes[step.measureIndex] ?? null;
    let x = prev;
    if (box) {
      const frac =
        box.durWholes > 0 ? clamp01((step.wholeNotes - box.startWholes) / box.durWholes) : 0;
      x = box.leftPx + frac * box.widthPx;
      if (!Number.isFinite(x)) x = prev;
    }
    if (x < prev) x = prev;
    stepX[i] = x;
    prev = x;
  }

  return { stepX, widthPx };
}

/** Last step at or before `sec`; 0 before the first step, -1 for an empty
 *  map. Identical semantics to scoreTimeMap's findStepIndexBySeconds,
 *  re-stated here so this module stays free of the audio-engine import that
 *  file carries. */
export function stripStepIndexAtSeconds(steps: readonly CursorStep[], sec: number): number {
  if (steps.length === 0) return -1;
  if (sec <= steps[0].seconds) return 0;
  let lo = 0;
  let hi = steps.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].seconds <= sec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Pixel x of the music sounding at `sec`: linear between the step at or
 * before it and the next one, so the strip glides at a constant speed inside
 * each step instead of jumping when the cursor advances. Past the last step
 * (or on it) the last x is returned; before the first, the first.
 */
export function xAtSeconds(map: ScoreTimeMap, xmap: StripXMap, sec: number): number {
  const steps = map?.steps ?? [];
  const n = Math.min(steps.length, xmap?.stepX?.length ?? 0);
  if (n === 0) return 0;
  const i = Math.min(stripStepIndexAtSeconds(steps, sec), n - 1);
  if (i < 0) return 0;
  const x0 = xmap.stepX[i];
  if (i >= n - 1) return x0;
  const s0 = steps[i].seconds;
  const s1 = steps[i + 1].seconds;
  const span = s1 - s0;
  if (!(span > 0)) return x0;
  const t = clamp01((sec - s0) / span);
  return x0 + (xmap.stepX[i + 1] - x0) * t;
}

/** How many MusicSystems the last render produced, over every page. One is
 *  the strip's invariant; more means the score wrapped at the width cap. Zero
 *  when nothing has rendered (or the object does not expose pages). */
export function stripSystemCount(osmd: OsmdLike): number {
  const pages = osmd?.GraphicSheet?.MusicPages ?? [];
  let count = 0;
  for (const page of pages) count += page?.MusicSystems?.length ?? 0;
  return count;
}

/**
 * Total ink width of the rendered measures in pixels at `zoom`: the sum of
 * every source measure's (first graphical) width plus the left edge of the
 * leftmost one. Unlike `buildStripXMap().widthPx` this is meaningful after a
 * wrap, when the systems overlap in x and the right edge only reports the
 * widest one; when the score wrapped, the first system was justified to the
 * cap, so this over-estimates the natural width a little (conservative for
 * fitZoomForWidth). 0 when nothing is rendered.
 */
export function stripContentWidthPx(osmd: OsmdLike, zoom: number): number {
  const scale = OSMD_UNIT_PX * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const measureList = osmd?.GraphicSheet?.MeasureList ?? [];
  let sum = 0;
  let left = Number.POSITIVE_INFINITY;
  let any = false;
  for (const row of measureList) {
    const gm = firstGraphicalMeasure(row);
    if (!gm) continue;
    const w = gm.PositionAndShape.Size.width * scale;
    const x = gm.PositionAndShape.AbsolutePosition.x * scale;
    if (Number.isFinite(w) && w > 0) sum += w;
    if (Number.isFinite(x) && x < left) left = x;
    any = true;
  }
  if (!any) return 0;
  return sum + (Number.isFinite(left) ? Math.max(0, left) : 0);
}

/**
 * The zoom that brings a strip of `contentWidthPx` (measured at `currentZoom`)
 * under `maxWidthPx` with a 2% margin, clamped to the shared zoom bounds. A
 * strip that already fits, or a degenerate measurement, leaves the zoom where
 * it is (clamped). Only ever lowers the zoom.
 */
export function fitZoomForWidth(
  contentWidthPx: number,
  maxWidthPx: number,
  currentZoom: number,
): number {
  const zoom = clampZoom(Number.isFinite(currentZoom) && currentZoom > 0 ? currentZoom : 1);
  if (!(contentWidthPx > 0) || !(maxWidthPx > 0)) return zoom;
  const target = maxWidthPx * WIDTH_FIT_TARGET;
  if (contentWidthPx <= target) return zoom;
  return clampZoom((zoom * target) / contentWidthPx);
}

/**
 * The zoom that makes a rendered strip of `contentHeightPx` (measured at
 * `currentZoom`) fill a pane of `paneHeightPx` with a little padding, clamped
 * to the shared zoom bounds. Degenerate measurements (a pane or content that
 * has not laid out yet) leave the zoom where it is.
 */
export function fitZoomForHeight(
  contentHeightPx: number,
  paneHeightPx: number,
  currentZoom: number,
): number {
  const zoom = Number.isFinite(currentZoom) && currentZoom > 0 ? currentZoom : 1;
  const avail = paneHeightPx - FIT_PADDING_PX;
  if (!(contentHeightPx > 0) || !(avail > 0)) return clampZoom(zoom);
  return clampZoom((zoom * avail) / contentHeightPx);
}

/** Rise time of the strip's scroll follower, seconds: how long a jump in the
 *  target takes to be (mostly) absorbed. The x map is proportional inside a
 *  measure, so a whole note or a rest is a plateau and the next attack a
 *  jump; ~0.35 s turns that into one glide while the lag behind a steady
 *  target stays under a notehead (2v/omega: ~13 px at 60 px/s). */
export const SCROLL_FOLLOW_RISE_SEC = 0.35;
/** A target further than this fraction of the pane from the current position
 *  is a seek (or the first frame): snap instead of gliding across the pane. */
export const SCROLL_SNAP_FRACTION = 0.6;
/** Frames longer than this (a hidden tab, a stall) are integrated as this. */
const FOLLOW_MAX_DT = 0.05;

export interface ScrollFollower {
  /** Advance toward `target` (px) at time `nowSec`; returns the position to
   *  write. `paneWidth` sizes the seek-snap threshold. */
  step: (target: number, nowSec: number, paneWidth: number) => number;
  /** Jump to `target` and forget the motion state (rebuild, resize, seek). */
  snap: (target: number) => number;
}

/**
 * A critically damped spring on the scroll position: continuous position AND
 * velocity, so a plateau-then-jump target becomes an accelerate-and-settle
 * glide with no visible step. While the target is ahead of the follower the
 * follower never moves backwards (a critically damped approach cannot
 * overshoot, and a target that is briefly behind by less than the snap
 * threshold is only ever a plateau's worth of over-run). A target far behind
 * (a seek back) or far ahead (a seek forward) snaps.
 */
export function createScrollFollower(): ScrollFollower {
  const omega = (2 * Math.PI) / SCROLL_FOLLOW_RISE_SEC;
  let x = Number.NaN;
  let v = 0;
  let last = Number.NaN;
  const jump = (target: number): number => {
    x = target;
    v = 0;
    return x;
  };
  return {
    // A public snap also forgets the clock: the next step() re-times from
    // its own `nowSec` instead of integrating the gap since the last frame.
    snap: (target) => {
      last = Number.NaN;
      return jump(target);
    },
    step: (target, nowSec, paneWidth) => {
      if (!Number.isFinite(target)) return Number.isFinite(x) ? x : 0;
      const threshold = Math.max(1, paneWidth) * SCROLL_SNAP_FRACTION;
      if (!Number.isFinite(x) || !Number.isFinite(last) || Math.abs(target - x) > threshold) {
        last = nowSec;
        return jump(target);
      }
      const dt = Math.min(FOLLOW_MAX_DT, Math.max(0, nowSec - last));
      last = nowSec;
      if (dt <= 0) return x;
      // Semi-implicit Euler on x'' = -2*omega*x' - omega^2 (x - target).
      v += (-2 * omega * v - omega * omega * (x - target)) * dt;
      const next = x + v * dt;
      // Forward-only while the music is ahead: never drift back toward a
      // target that is behind by less than a seek.
      if (target >= x && next < x) {
        v = 0;
        return x;
      }
      x = next;
      return x;
    },
  };
}
