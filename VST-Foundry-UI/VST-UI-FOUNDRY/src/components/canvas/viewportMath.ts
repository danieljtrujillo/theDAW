/**
 * Viewport (zoom/pan) math for the canvas camera.
 *
 * Kept as a pure module (no React, no DOM) like resizeMath.ts / snapMath.ts so
 * the cursor-anchored zoom can be unit-tested. Canvas.tsx's wheel handler is a
 * thin DOM adapter over wheelZoomAtPoint.
 *
 * World→screen mapping (shared with rulers.ts and gridOverlay.tsx):
 *   screenX = containerW/2 + panX + (x − canvasW/2)·scale
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;

/** Multiplicative wheel sensitivity: one 100-unit notch ≈ ×1.16 zoom. */
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;

export interface ViewportState {
  scale: number;
  panX: number;
  panY: number;
}

export interface WheelZoomParams extends ViewportState {
  /** Cursor position relative to the CONTAINER CENTER, in screen px. */
  cursorX: number;
  cursorY: number;
  /** Raw WheelEvent.deltaY (negative = zoom in). */
  deltaY: number;
}

/**
 * Cursor-anchored multiplicative zoom. Returns the next viewport, or null when
 * the scale is already pinned at its clamp (so callers can skip the update).
 *
 * Anchor derivation: keeping the canvas point under the cursor fixed across a
 * scale change s→s' requires panX' = mx·(1 − r) + r·panX with r = s'/s. The
 * formula uses the CLAMPED ratio, so the anchor also holds exactly on the
 * notch that lands on MIN_SCALE/MAX_SCALE.
 */
export function wheelZoomAtPoint({
  scale,
  panX,
  panY,
  cursorX,
  cursorY,
  deltaY,
}: WheelZoomParams): ViewportState | null {
  const currentScale = scale || 1;
  const newScale = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, currentScale * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY)),
  );
  if (newScale === currentScale) return null;

  const r = newScale / currentScale;
  return {
    scale: newScale,
    panX: cursorX * (1 - r) + r * (panX || 0),
    panY: cursorY * (1 - r) + r * (panY || 0),
  };
}
