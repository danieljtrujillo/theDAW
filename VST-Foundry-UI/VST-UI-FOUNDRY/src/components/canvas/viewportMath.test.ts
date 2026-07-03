import { describe, it, expect } from "vitest";
import {
  wheelZoomAtPoint,
  MIN_SCALE,
  MAX_SCALE,
  WHEEL_ZOOM_SENSITIVITY,
} from "./viewportMath";

/**
 * World coordinate of the point under the cursor, using the shared mapping
 * screenX = containerW/2 + panX + (x − canvasW/2)·scale. With cursorX given
 * relative to the container center this inverts to:
 *   x = canvasW/2 + (cursorX − panX)/scale
 */
const worldUnderCursor = (
  cursorX: number,
  panX: number,
  scale: number,
  canvasW = 800,
) => canvasW / 2 + (cursorX - panX) / scale;

describe("wheelZoomAtPoint", () => {
  it("keeps the world point under the cursor fixed (the whole point)", () => {
    const before = { scale: 0.8, panX: 42, panY: -117 };
    const cursor = { cursorX: 233.5, cursorY: -91.25 };
    const after = wheelZoomAtPoint({ ...before, ...cursor, deltaY: -240 })!;

    expect(after.scale).toBeGreaterThan(before.scale);
    expect(
      worldUnderCursor(cursor.cursorX, after.panX, after.scale),
    ).toBeCloseTo(worldUnderCursor(cursor.cursorX, before.panX, before.scale), 9);
    expect(
      worldUnderCursor(cursor.cursorY, after.panY, after.scale, 600),
    ).toBeCloseTo(worldUnderCursor(cursor.cursorY, before.panY, before.scale, 600), 9);
  });

  it("is multiplicative: equal notches give equal ratios", () => {
    const s1 = wheelZoomAtPoint({ scale: 1, panX: 0, panY: 0, cursorX: 0, cursorY: 0, deltaY: -100 })!.scale;
    const s2 = wheelZoomAtPoint({ scale: s1, panX: 0, panY: 0, cursorX: 0, cursorY: 0, deltaY: -100 })!.scale;
    expect(s2 / s1).toBeCloseTo(s1 / 1, 12);
    expect(s1).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_SENSITIVITY), 12);
  });

  it("returns null when already pinned at the clamps", () => {
    expect(
      wheelZoomAtPoint({ scale: MAX_SCALE, panX: 0, panY: 0, cursorX: 50, cursorY: 0, deltaY: -100 }),
    ).toBeNull();
    expect(
      wheelZoomAtPoint({ scale: MIN_SCALE, panX: 0, panY: 0, cursorX: 50, cursorY: 0, deltaY: 100 }),
    ).toBeNull();
    expect(
      wheelZoomAtPoint({ scale: 1, panX: 0, panY: 0, cursorX: 50, cursorY: 0, deltaY: 0 }),
    ).toBeNull();
  });

  it("holds the cursor anchor exactly on the notch that lands on a clamp", () => {
    // 2.9 * e^0.15 would overshoot 3; the clamped ratio must still anchor.
    const before = { scale: 2.9, panX: -60, panY: 10 };
    const after = wheelZoomAtPoint({ ...before, cursorX: 120, cursorY: 40, deltaY: -100 })!;
    expect(after.scale).toBe(MAX_SCALE);
    expect(worldUnderCursor(120, after.panX, after.scale)).toBeCloseTo(
      worldUnderCursor(120, before.panX, before.scale),
      9,
    );
  });

  it("zooming at the container center leaves pan untouched", () => {
    const after = wheelZoomAtPoint({ scale: 1, panX: 33, panY: -7, cursorX: 0, cursorY: 0, deltaY: -100 })!;
    const r = after.scale / 1;
    expect(after.panX).toBeCloseTo(33 * r, 12);
    expect(after.panY).toBeCloseTo(-7 * r, 12);
    // ...scaled about the center: pan shrinks/grows with r, no cursor term.
  });

  it("treats scale 0 (unset state) as 1, matching the render fallbacks", () => {
    const after = wheelZoomAtPoint({ scale: 0, panX: 0, panY: 0, cursorX: 0, cursorY: 0, deltaY: -100 })!;
    expect(after.scale).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_SENSITIVITY), 12);
  });
});
