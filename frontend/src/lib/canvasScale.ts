/**
 * Canvas sizing under the shell's CSS `zoom`.
 *
 * The shell scales the whole DAW with `zoom` on `.dense-layout` (0.85 / 0.95 /
 * 1.1 by breakpoint, mirrored into the `--layout-zoom` custom property so CSS
 * `calc()` can pre-compensate). Two coordinate spaces exist as a result:
 *
 *   local CSS px   what `style.width`, `clientWidth` and every CSS length
 *                  inside the zoomed subtree speak
 *   viewport px    what `getBoundingClientRect()` and `event.clientX` report
 *                  (local * cumulative zoom)
 *
 * `getBoundingClientRect().width` is therefore ALREADY multiplied by the zoom,
 * and writing it back as `style.width` applies the zoom a second time, so the
 * canvas renders at width * zoom^2 and every wave, playhead and mask handle
 * drifts out of register with the DOM overlays sitting on top of it. That is
 * the bug this module exists to prevent; ContextMenu.tsx documents the mirror
 * image of it for pointer coordinates (portalled to body, so no correction).
 *
 * Device pixels are a third space: a canvas backing store must cover
 * local * zoom * devicePixelRatio pixels to be sharp. `scale` bundles the two
 * multipliers, so drawing code can work in local CSS px and let the transform
 * do the rest.
 *
 * Usage:
 *   const box = measureCanvasBox(wrapEl);          // or fitCanvas(canvas, wrapEl)
 *   applyCanvasBox(canvas, box);
 *   const ctx = canvas.getContext('2d');
 *   scaleContextToBox(ctx, box);                   // absolute, never compounds
 *   ctx.fillRect(0, 0, box.cssWidth, box.cssHeight);
 */

export interface CanvasBox {
  /** Logical drawing size in the element's own CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Backing-store size in real device pixels. */
  deviceWidth: number;
  deviceHeight: number;
  /** deviceWidth / cssWidth, i.e. dpr * zoom. Feed this to setTransform. */
  scale: number;
  /** Cumulative CSS zoom in effect on the measured element. */
  zoom: number;
  /** Device pixel ratio actually used (after any cap). */
  dpr: number;
}

export interface MeasureOptions {
  /** Cap the device pixel ratio (visualizers cap at 2 to bound fill cost). */
  maxDpr?: number;
  /** Override the logical width in LOCAL css px, skipping the measurement. */
  cssWidth?: number;
  /** Override the logical height in LOCAL css px, skipping the measurement. */
  cssHeight?: number;
}

const isFinitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Cumulative CSS `zoom` applied to `el` by itself and every ancestor.
 *
 * Reading `--layout-zoom` would miss the counter-zoom that embedded panels
 * apply (`zoom: calc(1 / var(--layout-zoom))`), which inherits the variable
 * unchanged while cancelling the scale; walking computed `zoom` values is the
 * only measurement that stays true for both.
 */
export function effectiveZoom(el: Element | null | undefined): number {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 1;
  let zoom = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const raw = window.getComputedStyle(node).zoom;
    const value = raw ? parseFloat(raw) : NaN;
    if (isFinitePositive(value)) zoom *= value;
  }
  return isFinitePositive(zoom) ? zoom : 1;
}

/** Pure arithmetic behind {@link measureCanvasBox}; exported for tests. */
export function computeCanvasBox(
  rectWidth: number,
  rectHeight: number,
  zoom: number,
  dpr: number,
  opts: MeasureOptions = {},
): CanvasBox {
  const safeZoom = isFinitePositive(zoom) ? zoom : 1;
  const cap = isFinitePositive(opts.maxDpr) ? (opts.maxDpr as number) : Infinity;
  const safeDpr = Math.min(cap, isFinitePositive(dpr) ? dpr : 1);

  // Rect values arrive in viewport px; dividing by the zoom lands back in the
  // element's own coordinate space, which is what style lengths speak.
  const cssWidth = Math.max(1, opts.cssWidth ?? rectWidth / safeZoom);
  const cssHeight = Math.max(1, opts.cssHeight ?? rectHeight / safeZoom);
  const scale = safeZoom * safeDpr;

  return {
    cssWidth,
    cssHeight,
    deviceWidth: Math.max(1, Math.round(cssWidth * scale)),
    deviceHeight: Math.max(1, Math.round(cssHeight * scale)),
    scale,
    zoom: safeZoom,
    dpr: safeDpr,
  };
}

/** Measure an element into the three coordinate spaces a canvas needs. */
export function measureCanvasBox(el: Element, opts: MeasureOptions = {}): CanvasBox {
  const rect = el.getBoundingClientRect();
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return computeCanvasBox(rect.width, rect.height, effectiveZoom(el), dpr, opts);
}

export interface ApplyOptions {
  /**
   * Write `style.width/height` in local CSS px. Only needed for canvases the
   * stylesheet does not already size (no `w-full h-full` / `inset-0` stretch);
   * writing it otherwise is what re-introduces the zoom-squared bug.
   */
  style?: boolean;
}

/**
 * Push a measured box onto a canvas. Returns true when the backing store
 * changed, since assigning `width`/`height` resets the bitmap AND the context
 * transform, so callers that cache drawings need to know.
 */
export function applyCanvasBox(canvas: HTMLCanvasElement, box: CanvasBox, opts: ApplyOptions = {}): boolean {
  const changed = canvas.width !== box.deviceWidth || canvas.height !== box.deviceHeight;
  if (changed) {
    canvas.width = box.deviceWidth;
    canvas.height = box.deviceHeight;
  }
  if (opts.style) {
    const w = `${box.cssWidth}px`;
    const h = `${box.cssHeight}px`;
    if (canvas.style.width !== w) canvas.style.width = w;
    if (canvas.style.height !== h) canvas.style.height = h;
  }
  return changed;
}

/**
 * Set the drawing transform so one unit is one local CSS px.
 *
 * `setTransform` replaces the matrix rather than multiplying it, so a re-render
 * that skipped the backing-store reset cannot double-apply the scale the way a
 * bare `ctx.scale(dpr, dpr)` would.
 */
export function scaleContextToBox(ctx: CanvasRenderingContext2D, box: CanvasBox): void {
  ctx.setTransform(box.scale, 0, 0, box.scale, 0, 0);
}

/** Measure `el` (default: the canvas itself) and size the canvas to it. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  el?: Element | null,
  opts: MeasureOptions & ApplyOptions = {},
): CanvasBox {
  const box = measureCanvasBox(el ?? canvas, opts);
  applyCanvasBox(canvas, box, opts);
  return box;
}
