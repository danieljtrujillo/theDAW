import { UIElement } from "../../types";

/**
 * Resize geometry for the on-canvas selection handles.
 *
 * Kept as a pure module (no React, no DOM) so the eight-handle math can be
 * reasoned about and unit-tested in isolation. `useCanvasGestures` owns the
 * live gesture state and calls `computeResize` on every pointer frame; Canvas
 * renders `RESIZE_HANDLES` on the single-selection outline.
 */

export type ResizeHandle =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

/** Minimum element footprint, in canvas units. */
export const MIN_ELEMENT_SIZE = 16;

/**
 * The eight handles that decorate the selection outline. `ux`/`uy` are unit
 * offsets along the element box (0 = left/top, 0.5 = mid, 1 = right/bottom) so
 * the renderer can place each handle without a per-handle switch. `cursor` is
 * the matching resize affordance.
 */
export const RESIZE_HANDLES: {
  handle: ResizeHandle;
  cursor: "nwse-resize" | "nesw-resize" | "ns-resize" | "ew-resize";
  ux: number;
  uy: number;
}[] = [
  { handle: "nw", cursor: "nwse-resize", ux: 0, uy: 0 },
  { handle: "n", cursor: "ns-resize", ux: 0.5, uy: 0 },
  { handle: "ne", cursor: "nesw-resize", ux: 1, uy: 0 },
  { handle: "e", cursor: "ew-resize", ux: 1, uy: 0.5 },
  { handle: "se", cursor: "nwse-resize", ux: 1, uy: 1 },
  { handle: "s", cursor: "ns-resize", ux: 0.5, uy: 1 },
  { handle: "sw", cursor: "nesw-resize", ux: 0, uy: 1 },
  { handle: "w", cursor: "ew-resize", ux: 0, uy: 0.5 },
];

export interface ComputeResizeParams {
  handle: ResizeHandle;
  /** The element geometry captured when the gesture began (never live). */
  initial: Pick<UIElement, "x" | "y" | "width" | "height">;
  /** Pointer delta already divided by the canvas scale (canvas units). */
  dx: number;
  dy: number;
  snapToGrid: boolean;
  gridSize: number;
  /** Shift held: lock the corner drag to the original aspect ratio. */
  preserveAspect: boolean;
  /** Knob / Spatial3D: force a square footprint regardless of handle. */
  lockSquare: boolean;
  minSize?: number;
}

/**
 * Compute the new integer `x/y/width/height` for a single element being
 * resized by one handle.
 *
 * Approach: the handle names encode which edges move (`n`/`s`/`e`/`w`). Moving
 * edges follow the pointer (and snap to grid); the opposite edges are the fixed
 * anchor. Size is clamped to `minSize`, optionally squared or aspect-locked,
 * then the box is repositioned from the anchor so top/left handles push `x`/`y`.
 * Negative or NaN sizes are impossible because both dimensions are floored at
 * `minSize` before positioning.
 */
export function computeResize({
  handle,
  initial,
  dx,
  dy,
  snapToGrid,
  gridSize,
  preserveAspect,
  lockSquare,
  minSize = MIN_ELEMENT_SIZE,
}: ComputeResizeParams): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x0 = initial.x;
  const y0 = initial.y;
  const w0 = initial.width;
  const h0 = initial.height;
  const right0 = x0 + w0;
  const bottom0 = y0 + h0;

  const affectsLeft = handle.includes("w");
  const affectsRight = handle.includes("e");
  const affectsTop = handle.includes("n");
  const affectsBottom = handle.includes("s");

  const grid = gridSize > 0 ? gridSize : 1;

  // Moving edges follow the pointer; fixed edges keep their original position.
  let left = affectsLeft ? x0 + dx : x0;
  let right = affectsRight ? right0 + dx : right0;
  let top = affectsTop ? y0 + dy : y0;
  let bottom = affectsBottom ? bottom0 + dy : bottom0;

  // Snap only the moving edges (mirrors the move-drag grid math).
  if (snapToGrid) {
    if (affectsLeft) left = Math.round(left / grid) * grid;
    if (affectsRight) right = Math.round(right / grid) * grid;
    if (affectsTop) top = Math.round(top / grid) * grid;
    if (affectsBottom) bottom = Math.round(bottom / grid) * grid;
  }

  // Floor at the minimum first so no downstream step can go negative/NaN.
  let width = Math.max(minSize, right - left);
  let height = Math.max(minSize, bottom - top);

  const isCorner =
    (affectsLeft || affectsRight) && (affectsTop || affectsBottom);

  if (lockSquare) {
    const size = Math.max(width, height, minSize);
    width = size;
    height = size;
  } else if (preserveAspect && isCorner && w0 > 0 && h0 > 0) {
    const ratio = w0 / h0;
    // Grow along the dimension that yields the larger box so the corner tracks
    // the pointer, then re-floor at the minimum.
    if (width / ratio >= height) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
    if (width < minSize) {
      width = minSize;
      height = width / ratio;
    }
    if (height < minSize) {
      height = minSize;
      width = height * ratio;
    }
  }

  // Reposition from the fixed anchor edges (opposite the moving ones) so
  // top/left handles move x/y while bottom/right handles keep them put.
  let newX = x0;
  let newY = y0;
  if (affectsLeft) newX = right0 - width;
  if (affectsTop) newY = bottom0 - height;

  return {
    x: Math.round(newX),
    y: Math.round(newY),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Below this absolute rotation (degrees) an element is treated as axis-aligned. */
export const ROTATION_EPSILON = 1e-3;

export interface ComputeResizeRotatedParams extends ComputeResizeParams {
  /** Element rotation in degrees (from the gesture-start snapshot). */
  rotation?: number;
}

/**
 * Rotation-aware resize. Elements render with `transform: rotate(rotation)` about
 * `center center`, so a raw screen-space pointer delta does not map onto the
 * element's own axes once it is rotated.
 *
 * - rotation ~= 0 (within `ROTATION_EPSILON`): delegates to `computeResize`
 *   unchanged — the axis-aligned anchor behavior is preserved byte-for-byte.
 * - rotation != 0: the pointer delta is counter-rotated into the element's LOCAL
 *   frame, then the box is resized ABOUT ITS CENTER. Because the transform origin
 *   is the center, keeping (cx,cy) fixed makes the on-screen center stay put and
 *   eliminates the jump/spin drift. Grid snapping is skipped for rotated elements
 *   because snapping an axis-aligned bounding box of a rotated element is
 *   meaningless.
 */
export function computeResizeRotated(
  params: ComputeResizeRotatedParams,
): { x: number; y: number; width: number; height: number } {
  const rotation = params.rotation ?? 0;

  if (Math.abs(rotation) < ROTATION_EPSILON) {
    return computeResize(params);
  }

  // Counter-rotate the screen-space delta into the element's local frame.
  const rad = -(rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = params.dx * cos - params.dy * sin;
  const ly = params.dx * sin + params.dy * cos;

  // Reuse computeResize purely for the width/height math (local delta, no snap);
  // its anchor-based x/y is discarded in favor of a center-locked position.
  const local = computeResize({
    ...params,
    dx: lx,
    dy: ly,
    snapToGrid: false,
  });

  const cx = params.initial.x + params.initial.width / 2;
  const cy = params.initial.y + params.initial.height / 2;

  return {
    x: Math.round(cx - local.width / 2),
    y: Math.round(cy - local.height / 2),
    width: local.width,
    height: local.height,
  };
}
