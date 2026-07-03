import { CanvasState } from "../../types";

/** On-screen grid step (px) below which the grid is hidden as unreadable noise. */
export const MIN_GRID_STEP_PX = 4;

export interface GridGeometry {
  /** Container-space rect of the canvas's on-screen footprint. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Grid tile size in screen px (gridSize * scale). */
  step: number;
}

/**
 * The single world→screen mapping shared by the grid overlay, rulers.ts, and
 * the pannable wrapper's CSS transform in Canvas.tsx:
 *   screenX = containerW/2 + panX + (x − canvasW/2)·scale
 *   screenY = containerH/2 + panY + (y − canvasH/2)·scale
 * Exported so every consumer references one formula — drift is impossible by
 * construction rather than guarded by duplicated math.
 */
export const worldToScreenX = (
  x: number,
  containerW: number,
  canvasW: number,
  scale: number,
  panX: number,
): number => containerW / 2 + panX + (x - canvasW / 2) * scale;

export const worldToScreenY = (
  y: number,
  containerH: number,
  canvasH: number,
  scale: number,
  panY: number,
): number => containerH / 2 + panY + (y - canvasH / 2) * scale;

/**
 * Where the canvas actually sits on screen, in container coordinates.
 *
 * Anchored via the shared worldToScreenX/worldToScreenY helpers, the same
 * mapping used by the pannable wrapper's transform in Canvas.tsx (flex-centered,
 * then `translate(panX, panY) scale(scale)` about its center) and by rulers.ts.
 * The grid pattern is anchored to this rect so its lines land exactly on
 * canvas-space multiples of gridSize — the same positions the snap logic rounds
 * to.
 *
 * Assumes the container has no border/padding: containerWidth/Height come from
 * getBoundingClientRect (border box) while the overlay's absolute left/top
 * resolve against the padding box — adding either would shift the grid.
 */
export function computeGridGeometry(opts: {
  containerWidth: number;
  containerHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
  panX: number;
  panY: number;
  gridSize: number;
}): GridGeometry | null {
  const scale = opts.scale || 1;
  const step = (opts.gridSize || 10) * scale;
  if (opts.containerWidth <= 0 || opts.containerHeight <= 0) return null;
  if (step < MIN_GRID_STEP_PX) return null;

  return {
    left: worldToScreenX(0, opts.containerWidth, opts.canvasWidth, scale, opts.panX || 0),
    top: worldToScreenY(0, opts.containerHeight, opts.canvasHeight, scale, opts.panY || 0),
    width: opts.canvasWidth * scale,
    height: opts.canvasHeight * scale,
    step,
  };
}

/**
 * Grid overlay anchored to the canvas (not the container/camera). Drawn in
 * container space at the canvas's computed screen rect so the 1px lines stay
 * crisp at every zoom, and clipped to the canvas so the grid reads as part of
 * the document. `animate` mirrors the pannable wrapper's transform transition
 * so the grid never detaches from the canvas mid zoom-tween.
 */
export function GridOverlay({
  canvasState,
  containerSize,
  animate,
}: {
  canvasState: CanvasState;
  containerSize: { width: number; height: number };
  animate: boolean;
}) {
  if (!canvasState.showGrid) return null;

  const geom = computeGridGeometry({
    containerWidth: containerSize.width,
    containerHeight: containerSize.height,
    canvasWidth: canvasState.width,
    canvasHeight: canvasState.height,
    scale: canvasState.scale || 1,
    panX: canvasState.panX || 0,
    panY: canvasState.panY || 0,
    gridSize: canvasState.gridSize || 10,
  });
  if (!geom) return null;

  return (
    <div
      className="absolute pointer-events-none opacity-20 z-40 mix-blend-difference"
      style={{
        left: geom.left,
        top: geom.top,
        width: geom.width,
        height: geom.height,
        backgroundImage: `linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)`,
        backgroundSize: `${geom.step}px ${geom.step}px`,
        transition: animate
          ? "left 0.1s ease-out, top 0.1s ease-out, width 0.1s ease-out, height 0.1s ease-out, background-size 0.1s ease-out"
          : "none",
      }}
    />
  );
}
