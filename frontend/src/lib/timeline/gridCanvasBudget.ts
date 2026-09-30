/**
 * Device-pixel budget for the timeline grid canvas.
 *
 * canvasScale.ts documents the two coordinate spaces a canvas straddles:
 * local CSS px (`cssWidth`/`cssHeight`, what layout code speaks) and device
 * px, the backing store, which is `cssWidth * cssHeight * (layoutZoom * dpr)
 * ** 2` because both the shell's CSS `zoom` and the display's
 * `devicePixelRatio` scale the bitmap. The timeline grid canvas is the
 * largest canvas in the app (full lanes height x ~3 viewports wide) and,
 * unlike every other canvas (AdvancedVisualizer.tsx, ModuleThumb.tsx,
 * ChordStripCanvas.tsx, ColonyCanvas.tsx all cap at dpr 2), it has never had
 * a cap: a tall multi-track project on a high-DPI display can ask for a
 * backing store hundreds of MB in size, which some browsers refuse to
 * allocate at all (a blank grid) rather than allocate.
 *
 * This module is pure arithmetic — no DOM, no `window`, no React — so it can
 * be unit-tested and called from inside a layout effect without risk. It only
 * decides the dpr to feed into `computeCanvasBox` (canvasScale.ts); it does
 * not touch a canvas itself.
 */

/** Never use a sharper ratio than this, matching every other canvas in the app. */
export const GRID_CANVAS_MAX_DPR = 2;

/**
 * Device-pixel area ceiling for the grid canvas backing store. 16 M device px
 * is the smallest per-canvas limit shipped browsers enforce, so staying at or
 * under it keeps allocation working everywhere.
 */
export const GRID_CANVAS_MAX_DEVICE_PX = 16_000_000;

/**
 * Floor for the returned dpr. A canvas whose CSS size alone blows the budget
 * still renders (blurrier) at this ratio rather than disappearing, which is
 * better than the blank-canvas failure this module exists to prevent.
 */
export const GRID_CANVAS_MIN_DPR = 0.5;

export interface GridCanvasBudgetInput {
  /** Grid layer width in local CSS px (see canvasScale.ts). */
  cssWidth: number;
  /** Grid layer height in local CSS px. */
  cssHeight: number;
  /** Cumulative CSS `zoom` in effect (see canvasScale.ts `effectiveZoom`). */
  layoutZoom: number;
  /** Raw `window.devicePixelRatio`, before any cap. */
  dpr: number;
}

/** True when an input is unusable for the area formula below. */
const isDegenerate = (a: GridCanvasBudgetInput): boolean =>
  !Number.isFinite(a.cssWidth) ||
  !Number.isFinite(a.cssHeight) ||
  !Number.isFinite(a.layoutZoom) ||
  !Number.isFinite(a.dpr) ||
  a.cssWidth <= 0 ||
  a.cssHeight <= 0 ||
  a.layoutZoom <= 0;

/**
 * The dpr the grid canvas should use so its backing store
 * (`cssWidth * cssHeight * (layoutZoom * dpr) ** 2` device px) stays at or
 * under {@link GRID_CANVAS_MAX_DEVICE_PX}, never exceeds
 * {@link GRID_CANVAS_MAX_DPR}, and never drops below {@link GRID_CANVAS_MIN_DPR}.
 *
 * Never throws: this runs inside a layout effect, so non-finite or
 * non-positive `cssWidth`/`cssHeight`/`layoutZoom` fall back to dpr 1.
 */
export function gridCanvasDpr(a: GridCanvasBudgetInput): number {
  if (isDegenerate(a)) return 1;

  const wanted = Math.min(GRID_CANVAS_MAX_DPR, a.dpr > 0 ? a.dpr : 1);
  // Largest dpr that keeps cssWidth * cssHeight * (layoutZoom * dpr) ** 2 at
  // or below the budget, solved for dpr.
  const fit = Math.sqrt(GRID_CANVAS_MAX_DEVICE_PX / (a.cssWidth * a.cssHeight)) / a.layoutZoom;
  return Math.max(GRID_CANVAS_MIN_DPR, Math.min(wanted, fit));
}

/**
 * Resulting backing-store area in device px at {@link gridCanvasDpr}'s
 * result, so a caller (or test) can assert the budget directly instead of
 * re-deriving the formula. Returns 0 for the degenerate inputs
 * {@link gridCanvasDpr} falls back on.
 */
export function gridCanvasDevicePx(a: GridCanvasBudgetInput): number {
  if (isDegenerate(a)) return 0;
  const dpr = gridCanvasDpr(a);
  return a.cssWidth * a.cssHeight * (a.layoutZoom * dpr) ** 2;
}
