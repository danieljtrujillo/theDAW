import { describe, it, expect } from "vitest";
import { computeDragSnap, SNAP_THRESHOLD } from "./snapMath";

const box = (x: number, y: number, width = 50, height = 20) => ({
  x,
  y,
  width,
  height,
});

const defaults = {
  others: [] as ReturnType<typeof box>[],
  snapToGrid: true,
  gridSize: 10,
  alignThreshold: 5,
  smartAlign: true,
};

describe("computeDragSnap", () => {
  it("rounds the primary's top-left onto the grid", () => {
    const { dx, dy } = computeDragSnap({
      ...defaults,
      dx: 4,
      dy: 6,
      primary: box(13, 17),
    });
    // 13+4=17 → 20, 17+6=23 → 20
    expect(dx).toBe(7);
    expect(dy).toBe(3);
  });

  it("returns ONE delta so a multi-selection keeps its relative offsets", () => {
    // Pre-fix, every element re-rounded independently: elements 8px apart
    // collapsed onto the same gridline. The shared snapped delta preserves
    // arbitrary internal spacing.
    const primary = box(13, 10);
    const buddy = box(21, 10); // 8px to the right, off-grid relative to primary
    const { dx } = computeDragSnap({
      ...defaults,
      dx: 4,
      dy: 0,
      primary,
      smartAlign: false,
    });
    expect(primary.x + dx).toBe(20); // primary lands on the grid
    expect(buddy.x + dx - (primary.x + dx)).toBe(8); // spacing intact
  });

  it("passes the raw delta through when snap-to-grid is off", () => {
    const { dx, dy, guides } = computeDragSnap({
      ...defaults,
      snapToGrid: false,
      dx: 4.3,
      dy: -2.6,
      primary: box(13, 17),
    });
    expect(dx).toBeCloseTo(4.3, 10);
    expect(dy).toBeCloseTo(-2.6, 10);
    expect(guides).toEqual([]);
  });

  it("lets edge alignment override the grid and emits a guide", () => {
    const { dx, guides } = computeDragSnap({
      ...defaults,
      dx: 100,
      dy: 0,
      primary: box(0, 0, 50, 50),
      others: [box(103, 200, 60, 20)],
    });
    // Grid says 100, but the neighbor's left edge at 103 is within threshold.
    expect(dx).toBe(103);
    expect(guides).toContainEqual({ type: "x", pos: 103 });
  });

  it("respects the alignment threshold (screen-constant magnetism)", () => {
    // Same geometry, but a tight threshold (e.g. zoomed-in: 5/scale shrinks).
    const { dx, guides } = computeDragSnap({
      ...defaults,
      alignThreshold: 2,
      dx: 100,
      dy: 0,
      primary: box(0, 0, 50, 50),
      others: [box(103, 200, 60, 20)],
    });
    expect(dx).toBe(100); // grid wins, neighbor out of reach
    expect(guides).toEqual([]);
  });

  it("aligns my right edge to a neighbor's left edge", () => {
    const { dx, guides } = computeDragSnap({
      ...defaults,
      dx: 51,
      dy: 0,
      primary: box(0, 0, 50, 50),
      others: [box(103, 0, 60, 20)],
    });
    // myRight = 51+50 = 101, otherLeft = 103 → within 5 → x = 103 − 50.
    expect(dx).toBe(53);
    expect(guides).toContainEqual({ type: "x", pos: 103 });
  });

  it("skips element alignment for multi-drags (smartAlign=false)", () => {
    const { dx, guides } = computeDragSnap({
      ...defaults,
      smartAlign: false,
      dx: 100,
      dy: 0,
      primary: box(0, 0, 50, 50),
      others: [box(103, 200, 60, 20)],
    });
    expect(dx).toBe(100); // grid only
    expect(guides).toEqual([]);
  });

  it("survives a degenerate grid size", () => {
    const { dx } = computeDragSnap({
      ...defaults,
      gridSize: 0,
      dx: 4.4,
      dy: 0,
      primary: box(13, 17),
    });
    expect(dx).toBe(Math.round(13 + 4.4) - 13); // falls back to 1px grid
  });

  it("returns the raw delta when there is nothing to snap", () => {
    const { dx, dy } = computeDragSnap({
      ...defaults,
      dx: 3,
      dy: 4,
      primary: null,
    });
    expect(dx).toBe(3);
    expect(dy).toBe(4);
  });

  it("mixes axes: X aligns to a neighbor while Y falls back to the grid", () => {
    const { dx, dy, guides } = computeDragSnap({
      ...defaults,
      dx: 100,
      dy: 23,
      primary: box(0, 0, 50, 50),
      others: [box(103, 200, 60, 20)],
    });
    // X: myLeft = 0+100 = 100 is 3px from otherLeft 103 (<5) → aligns, x = 103.
    expect(dx).toBe(103);
    expect(guides).toContainEqual({ type: "x", pos: 103 });
    // Y: the neighbor is 200+ away, nothing to align to, so the grid takes
    // over: 0+23 = 23 rounds to 20. Non-trivial — not the raw 23.
    expect(dy).toBe(20);
    expect(guides.some((g) => g.type === "y")).toBe(false);
  });

  it("aligns X and Y to the same neighbor at once (two guides)", () => {
    const { dx, dy, guides } = computeDragSnap({
      ...defaults,
      dx: 100,
      dy: 100,
      primary: box(0, 0, 50, 50),
      others: [box(103, 103, 60, 20)],
    });
    // myLeft 100 vs otherLeft 103 and myTop 100 vs otherTop 103 are both <5,
    // so alignment overrides the grid on both axes simultaneously.
    expect(dx).toBe(103);
    expect(dy).toBe(103);
    expect(guides).toContainEqual({ type: "x", pos: 103 });
    expect(guides).toContainEqual({ type: "y", pos: 103 });
  });

  it("first neighbor inside the threshold wins on a shared axis (order-dependent by design)", () => {
    // Two neighbors both within alignThreshold on X. The loop walks `others`
    // in array order and the per-axis lock (snappedToX) freezes on the FIRST
    // match, so element order decides the winner. This is intentional; assert
    // it so a refactor that reorders or short-circuits differently trips here.
    const { dx, guides } = computeDragSnap({
      ...defaults,
      dx: 100,
      dy: 0,
      primary: box(0, 0, 50, 50),
      others: [box(102, 300, 60, 20), box(103, 400, 60, 20)],
    });
    // myLeft = 100; neighbor A's left 102 (|Δ|=2) matches before neighbor B's
    // left 103 (|Δ|=3), even though B is also in range.
    expect(dx).toBe(102);
    expect(guides).toContainEqual({ type: "x", pos: 102 });
    expect(guides).not.toContainEqual({ type: "x", pos: 103 });
  });

  it("uses a screen-constant magnet radius (SNAP_THRESHOLD / scale) so zoom shrinks its reach", () => {
    // useCanvasGestures passes alignThreshold = SNAP_THRESHOLD / scale (see
    // useCanvasGestures.ts ~line 412) so the magnet feels the same size on
    // screen at every zoom. Zooming in (scale > 1) shrinks the canvas-unit
    // radius, so a neighbor that WOULD snap at 1× drops out of reach.
    const primary = box(0, 0, 50, 50);
    const others = [box(103, 200, 60, 20)]; // myLeft 100 vs otherLeft 103 → 3px

    // At 1× the 3px neighbor is inside the 5px radius → snaps.
    const atOneX = computeDragSnap({
      ...defaults,
      alignThreshold: SNAP_THRESHOLD, // 5 / 1
      dx: 100,
      dy: 0,
      primary,
      others,
    });
    expect(atOneX.dx).toBe(103);
    expect(atOneX.guides).toContainEqual({ type: "x", pos: 103 });

    // Zoomed to 2.5× the radius collapses to 2px; the same 3px neighbor is now
    // out of reach, so grid snapping (100) wins and no guide is emitted.
    const scale = 2.5;
    const zoomed = computeDragSnap({
      ...defaults,
      alignThreshold: SNAP_THRESHOLD / scale, // 5 / 2.5 = 2
      dx: 100,
      dy: 0,
      primary,
      others,
    });
    expect(zoomed.dx).toBe(100);
    expect(zoomed.guides).toEqual([]);
  });
});
