import { describe, it, expect } from "vitest";
import { boundsToCanvasRect } from "./mapping";

describe("boundsToCanvasRect", () => {
  it("scales normalized bounds to canvas dims", () => {
    expect(
      boundsToCanvasRect({ xmin: 0.25, ymin: 0.5, xmax: 0.75, ymax: 1 }, { width: 800, height: 600 }),
    ).toEqual({ x: 200, y: 300, width: 400, height: 300 });
  });
  it("clamps degenerate boxes to 1px min", () => {
    const r = boundsToCanvasRect({ xmin: 0.5, ymin: 0.5, xmax: 0.5, ymax: 0.5 }, { width: 100, height: 100 });
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
  });
});
