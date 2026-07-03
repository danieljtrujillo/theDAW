import { UIElement } from "../../types";

/**
 * Drag snapping for the canvas gesture engine.
 *
 * Kept as a pure module (no React, no DOM) like resizeMath.ts so the grid /
 * alignment math can be unit-tested in isolation. useCanvasGestures calls
 * computeDragSnap on every pointer frame and applies the returned delta to the
 * whole selection, so multi-selections keep their relative offsets instead of
 * each element re-rounding onto the grid independently.
 */

/** Alignment magnetism radius in SCREEN pixels. Divide by scale for canvas units. */
export const SNAP_THRESHOLD = 5;

export interface SnapGuide {
  type: "x" | "y";
  pos: number;
}

type Box = Pick<UIElement, "x" | "y" | "width" | "height">;

export interface ComputeDragSnapParams {
  /** Raw pointer delta since gesture start, in canvas units. */
  dx: number;
  dy: number;
  /** Gesture-start geometry of the element that drives snapping. */
  primary: Box | null;
  /** Alignment candidates (everything outside the selection). */
  others: Box[];
  snapToGrid: boolean;
  gridSize: number;
  /** Alignment radius in canvas units — pass SNAP_THRESHOLD / scale so the magnet feels the same at every zoom. */
  alignThreshold: number;
  /** Element-to-element alignment only applies to single-element drags. */
  smartAlign: boolean;
}

export interface DragSnapResult {
  /** Snapped delta to apply to every element in the selection. */
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Compute the snapped drag delta. Grid snap rounds the primary element's
 * top-left to the nearest grid multiple; smart alignment (edges + centers vs.
 * other elements) overrides grid snap when within `alignThreshold`, matching
 * how design tools prioritize object alignment over the grid.
 */
export function computeDragSnap({
  dx,
  dy,
  primary,
  others,
  snapToGrid,
  gridSize,
  alignThreshold,
  smartAlign,
}: ComputeDragSnapParams): DragSnapResult {
  if (!primary) return { dx, dy, guides: [] };

  const grid = gridSize > 0 ? gridSize : 1;
  const newX = primary.x + dx;
  const newY = primary.y + dy;

  let snappedX = newX;
  let snappedY = newY;
  if (snapToGrid) {
    snappedX = Math.round(newX / grid) * grid;
    snappedY = Math.round(newY / grid) * grid;
  }

  const guides: SnapGuide[] = [];

  if (smartAlign) {
    let snappedToX = false;
    let snappedToY = false;

    for (const other of others) {
      // Check X (edges and centers)
      const myLeft = newX;
      const myRight = newX + primary.width;
      const myCenterX = newX + primary.width / 2;
      const otherLeft = other.x;
      const otherRight = other.x + other.width;
      const otherCenterX = other.x + other.width / 2;

      [
        [myLeft, otherLeft, otherLeft],
        [myLeft, otherRight, otherRight],
        [myRight, otherLeft, otherLeft - primary.width],
        [myRight, otherRight, otherRight - primary.width],
        [myCenterX, otherCenterX, otherCenterX - primary.width / 2],
      ].forEach(([myPos, otherPos, targetX]) => {
        if (!snappedToX && Math.abs(myPos - otherPos) < alignThreshold) {
          snappedX = targetX;
          snappedToX = true;
          guides.push({ type: "x", pos: otherPos });
        }
      });

      // Check Y (edges and centers)
      const myTop = newY;
      const myBottom = newY + primary.height;
      const myCenterY = newY + primary.height / 2;
      const otherTop = other.y;
      const otherBottom = other.y + other.height;
      const otherCenterY = other.y + other.height / 2;

      [
        [myTop, otherTop, otherTop],
        [myTop, otherBottom, otherBottom],
        [myBottom, otherTop, otherTop - primary.height],
        [myBottom, otherBottom, otherBottom - primary.height],
        [myCenterY, otherCenterY, otherCenterY - primary.height / 2],
      ].forEach(([myPos, otherPos, targetY]) => {
        if (!snappedToY && Math.abs(myPos - otherPos) < alignThreshold) {
          snappedY = targetY;
          snappedToY = true;
          guides.push({ type: "y", pos: otherPos });
        }
      });
    }
  }

  return {
    dx: snappedX - primary.x,
    dy: snappedY - primary.y,
    guides,
  };
}
