import assert from 'node:assert/strict';
import {
  gridCanvasDpr,
  gridCanvasDevicePx,
  GRID_CANVAS_MAX_DPR,
  GRID_CANVAS_MAX_DEVICE_PX,
  GRID_CANVAS_MIN_DPR,
} from './gridCanvasBudget';

// Small project keeps the real dpr: well inside the budget, so dpr 2 passes through.
{
  const box = { cssWidth: 1400, cssHeight: 400, layoutZoom: 1, dpr: 2 };
  assert.equal(gridCanvasDpr(box), 2);
}

// dpr is capped at 2 regardless of how sharp the display actually is.
{
  const box = { cssWidth: 1400, cssHeight: 400, layoutZoom: 1, dpr: 3 };
  assert.equal(gridCanvasDpr(box), 2);
}

// REGRESSION: a tall 30-track lanes stack (see TimelineGridLayer wiring) stays
// inside the budget instead of the ~1.37e8 device px an uncapped dpr 3 would ask for.
{
  const box = { cssWidth: 4200, cssHeight: 3634, layoutZoom: 1.1, dpr: 3 };
  const px = gridCanvasDevicePx(box);
  assert.ok(px <= GRID_CANVAS_MAX_DEVICE_PX, `expected ${px} <= ${GRID_CANVAS_MAX_DEVICE_PX}`);
  assert.ok(gridCanvasDpr(box) < 2);
}

// The floor keeps the grid drawable (blurry, not blank) even when the CSS
// size alone blows the budget.
{
  const box = { cssWidth: 20000, cssHeight: 20000, layoutZoom: 1, dpr: 2 };
  const dpr = gridCanvasDpr(box);
  assert.equal(dpr, GRID_CANVAS_MIN_DPR);
  assert.ok(Number.isFinite(dpr) && dpr > 0);
}

// Degenerate inputs never throw: each bad field alone falls back to dpr 1 /
// 0 device px rather than taking the layout effect down with it.
{
  const base = { cssWidth: 1400, cssHeight: 400, layoutZoom: 1, dpr: 2 };
  const cases = [
    { ...base, cssWidth: 0 },
    { ...base, cssHeight: Number.NaN },
    { ...base, layoutZoom: 0 },
    { ...base, dpr: Number.POSITIVE_INFINITY },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => gridCanvasDpr(c));
    assert.doesNotThrow(() => gridCanvasDevicePx(c));
    assert.equal(gridCanvasDpr(c), 1);
    assert.equal(gridCanvasDevicePx(c), 0);
  }
}

// Monotonic: halving cssHeight (shrinking the backing-store area) never
// lowers the dpr the budget allows.
{
  const tall = { cssWidth: 4200, cssHeight: 3634, layoutZoom: 1.1, dpr: 3 };
  const half = { ...tall, cssHeight: tall.cssHeight / 2 };
  assert.ok(gridCanvasDpr(half) >= gridCanvasDpr(tall));
}

console.log('gridCanvasBudget: ok');
