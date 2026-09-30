/**
 * `lanePathPoints` — the polyline the automation lane draws.
 *
 * The lane used to emit one vertex per breakpoint, so a curved segment (a point
 * with a non-zero `curve`) drew as the straight line it is NOT played as. This
 * pins the sampling: a linear segment still costs exactly its two endpoints, a
 * curved one gets interior samples taken from `interpolatePoints` — the same
 * function playback samples — so the picture and the sound cannot disagree.
 *
 * Pure helper only: no React, no DOM.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/AutomationLane.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { LANE_CURVE_SAMPLES, lanePathPoints } from './AutomationLane.tsx';
import { interpolatePoints, type CurvePoint } from '../../lib/automationModes.ts';

/** A monotone decreasing value -> y, the shape the component's own `yOf` has
 *  (screen y grows downward, value grows upward) over a 100px-tall lane. */
const yOf = (v: number): number => (1 - Math.max(0, Math.min(1, v))) * 100;
const ZOOM = 50; // px per second

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ── Degenerate lanes ─────────────────────────────────────────────────────────

// An empty lane draws nothing at all — not a stray vertex at the origin.
{
  assert.deepEqual(lanePathPoints([], ZOOM, yOf), []);
}

// One point is one vertex (a polyline of one point draws nothing, but the caller
// must not have to special-case the length).
{
  const pts: CurvePoint[] = [{ t: 2, v: 0.25 }];
  const out = lanePathPoints(pts, ZOOM, yOf);
  assert.equal(out.length, 1);
  near(out[0][0], 100);
  near(out[0][1], 75);
}

// A curve ON the last point emits no trailing segment — a point's curve
// describes the run FROM it, and there is no run after the last point.
{
  const pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1, curve: 1 }];
  const out = lanePathPoints(pts, ZOOM, yOf);
  assert.equal(out.length, 2, 'a trailing curve must not add samples');
}

// ── Linear lanes cost exactly their endpoints ────────────────────────────────

{
  const pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 3, v: 0.5 }, { t: 4, v: 0, curve: 0 }];
  const out = lanePathPoints(pts, ZOOM, yOf);
  assert.equal(out.length, pts.length, 'a linear lane emits one vertex per point');
  pts.forEach((p, i) => {
    near(out[i][0], p.t * ZOOM);
    near(out[i][1], yOf(p.v));
  });
}

// An absent curve and an explicit 0 are the same lane, and so is junk (NaN from a
// hand-edited project) — `clampCurve` reads all three as linear.
{
  const base: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  const zero: CurvePoint[] = [{ t: 0, v: 0, curve: 0 }, { t: 1, v: 1 }];
  const junk: CurvePoint[] = [{ t: 0, v: 0, curve: NaN }, { t: 1, v: 1 }];
  assert.deepEqual(lanePathPoints(zero, ZOOM, yOf), lanePathPoints(base, ZOOM, yOf));
  assert.deepEqual(lanePathPoints(junk, ZOOM, yOf), lanePathPoints(base, ZOOM, yOf));
}

// ── One curved segment ───────────────────────────────────────────────────────

{
  assert.equal(LANE_CURVE_SAMPLES, 16, 'the documented default sample count');

  const p0: CurvePoint = { t: 0, v: 0, curve: 0.75 };
  const p1: CurvePoint = { t: 2, v: 1 };
  const out = lanePathPoints([p0, p1], ZOOM, yOf);

  // 16 interior samples BETWEEN the two endpoints.
  assert.equal(out.length, 2 + LANE_CURVE_SAMPLES);

  // First and last vertices are the endpoints themselves, exactly.
  near(out[0][0], 0);
  near(out[0][1], yOf(0));
  near(out[out.length - 1][0], p1.t * ZOOM);
  near(out[out.length - 1][1], yOf(1));

  // Every interior sample is strictly inside the segment in x, and its y is what
  // playback would read at that time — same function, so picture = sound.
  for (let i = 1; i <= LANE_CURVE_SAMPLES; i += 1) {
    const [x, y] = out[i];
    assert.ok(x > 0 && x < p1.t * ZOOM, `interior x ${x} must be inside the segment`);
    near(y, yOf(interpolatePoints(p0, p1, x / ZOOM)));
  }

  // Monotonic: x strictly increasing, y strictly decreasing (the value rises).
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i][0] > out[i - 1][0], `x went backwards at ${i}`);
    assert.ok(out[i][1] < out[i - 1][1], `y went backwards at ${i}`);
  }

  // A positive curve reaches the target EARLY, so the drawn midpoint sits above
  // (smaller y than) the straight line's midpoint.
  const mid = out[1 + LANE_CURVE_SAMPLES / 2 - 1];
  assert.ok(mid[1] < yOf(0.5), 'a +curve must bow toward the target');

  // The mirrored curve bows the other way by the same amount.
  const down = lanePathPoints([{ ...p0, curve: -0.75 }, p1], ZOOM, yOf);
  const midDown = down[1 + LANE_CURVE_SAMPLES / 2 - 1];
  assert.ok(midDown[1] > yOf(0.5), 'a -curve must bow away from the target');
}

// ── Mixed lane: only the curved segments pay for samples ─────────────────────

{
  const pts: CurvePoint[] = [
    { t: 0, v: 0 },               // linear run to t=1
    { t: 1, v: 1, curve: -0.5 },  // curved run to t=3
    { t: 3, v: 0.25 },            // linear run to t=4
    { t: 4, v: 0.75 },
  ];
  const out = lanePathPoints(pts, ZOOM, yOf, 4);
  assert.equal(out.length, pts.length + 4, 'only the one curved segment adds samples');

  // The samples land between the second and third breakpoints, nowhere else.
  for (let i = 2; i < 2 + 4; i += 1) {
    assert.ok(out[i][0] > 1 * ZOOM && out[i][0] < 3 * ZOOM, `sample ${i} strayed out of the curved segment`);
  }
  near(out[1][0], 1 * ZOOM);
  near(out[2 + 4][0], 3 * ZOOM);
}

// A caller can turn sampling off (0 samples) and get the straight-line lane back.
{
  const pts: CurvePoint[] = [{ t: 0, v: 0, curve: 1 }, { t: 1, v: 1 }];
  assert.equal(lanePathPoints(pts, ZOOM, yOf, 0).length, 2);
}

// ── Zero-width segments never divide by zero ─────────────────────────────────

{
  const pts: CurvePoint[] = [{ t: 1, v: 0, curve: 0.5 }, { t: 1, v: 1 }];
  const out = lanePathPoints(pts, ZOOM, yOf);
  for (const [x, y] of out) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `non-finite vertex ${x},${y}`);
  }
}

console.log('AutomationLane: all assertions passed');
