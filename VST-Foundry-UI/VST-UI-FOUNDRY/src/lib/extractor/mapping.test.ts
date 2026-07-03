import { describe, it, expect } from "vitest";
import { boundsToCanvasRect, panelLocalToGlobal } from "./mapping";

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

describe("panelLocalToGlobal", () => {
  const panel = { xmin: 0.5, ymin: 0.25, xmax: 1.0, ymax: 0.75 };
  it("maps crop-relative child bounds into source-image space", () => {
    expect(
      panelLocalToGlobal({ xmin: 0.2, ymin: 0.0, xmax: 0.6, ymax: 0.5 }, panel),
    ).toEqual({ xmin: 0.6, ymin: 0.25, xmax: 0.8, ymax: 0.5 });
  });
  it("identity panel is a no-op", () => {
    const b = { xmin: 0.1, ymin: 0.2, xmax: 0.3, ymax: 0.4 };
    expect(
      panelLocalToGlobal(b, { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }),
    ).toEqual(b);
  });
});
