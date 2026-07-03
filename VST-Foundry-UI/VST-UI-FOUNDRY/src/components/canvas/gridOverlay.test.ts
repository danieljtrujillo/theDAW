import { describe, it, expect } from "vitest";
import { computeGridGeometry, worldToScreenX, MIN_GRID_STEP_PX } from "./gridOverlay";

// worldToScreenX is the REAL exported mapping shared by computeGridGeometry and
// rulers.ts (drawRulers). Importing it here means these invariants guard the
// production formula itself — if the ruler mapping drifts, this test breaks.

const base = {
  containerWidth: 1000,
  containerHeight: 800,
  canvasWidth: 800,
  canvasHeight: 600,
  scale: 1,
  panX: 0,
  panY: 0,
  gridSize: 10,
};

describe("computeGridGeometry", () => {
  it("anchors the grid to the canvas origin (agrees with the ruler mapping)", () => {
    const geom = computeGridGeometry(base)!;
    expect(geom.left).toBe(worldToScreenX(0, 1000, 800, 1, 0));
    expect(geom.top).toBe(100); // 800/2 − 600/2
    expect(geom.width).toBe(800);
    expect(geom.height).toBe(600);
    expect(geom.step).toBe(10);
  });

  it("stays glued to the canvas under zoom (the original bug)", () => {
    // Pre-fix, backgroundPosition was just panX/panY, so zooming slid the
    // grid across the canvas. Every gridline must track its canvas coordinate
    // through a zoom change.
    for (const scale of [0.5, 1, 1.7, 2.5]) {
      const geom = computeGridGeometry({ ...base, scale })!;
      // Canvas x=30 (a 10-grid multiple) must land on a rendered gridline:
      // lines are drawn at left + k·step.
      const lineScreenX = worldToScreenX(30, 1000, 800, scale, 0);
      expect(geom.left + 3 * geom.step).toBeCloseTo(lineScreenX, 10);
      expect(geom.step).toBeCloseTo(10 * scale, 10);
    }
  });

  it("tracks panning 1:1", () => {
    const a = computeGridGeometry(base)!;
    const b = computeGridGeometry({ ...base, panX: 37, panY: -12 })!;
    expect(b.left - a.left).toBe(37);
    expect(b.top - a.top).toBe(-12);
    expect(b.step).toBe(a.step);
  });

  it("recomputes when the container resizes (grid must not drift)", () => {
    const a = computeGridGeometry(base)!;
    const b = computeGridGeometry({ ...base, containerWidth: 1200 })!;
    expect(b.left - a.left).toBe(100); // canvas re-centers with the container
  });

  it("hides the grid when the on-screen step would be unreadable noise", () => {
    expect(
      computeGridGeometry({ ...base, scale: (MIN_GRID_STEP_PX - 1) / 10 }),
    ).toBeNull();
    expect(
      computeGridGeometry({ ...base, scale: MIN_GRID_STEP_PX / 10 }),
    ).not.toBeNull();
  });

  it("returns null for an unmeasured container", () => {
    expect(
      computeGridGeometry({ ...base, containerWidth: 0, containerHeight: 0 }),
    ).toBeNull();
  });
});
