/**
 * The strand's contract: it physically joins the two cells (both ends sit ON
 * their anchors, never short of them), it grows out of the source rather than
 * appearing whole, it sags rather than running straight, and it behaves the
 * same at any frame rate.
 */
import assert from 'node:assert/strict';
import { easeAngle, GROW_SEC, makeRope, ropeAt, ropeDistance, stepRope, type Rope } from './tendril.ts';

const FIELD = { bowX: 0, bowY: 0, nAx: 1, nAy: 0, phase: 0 };
const A = { x: 0, y: 0 };
const B = { x: 300, y: 0 };

function grow(rope: Rope, secs: number, h = 1 / 60): void {
  for (let i = 0; i < Math.round(secs / h); i += 1) stepRope(rope, h, A, B, FIELD, 0.5);
}

// It starts bowed — never a straight line, not even on the first frame.
{
  const r = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  const mid = r.pts[6];
  assert.ok(Math.abs(mid.y) > 10, `the midpoint starts only ${Math.abs(mid.y).toFixed(1)} px off the chord — that is a wire`);
}

// It GROWS: partway through it has not reached the far cell yet.
{
  const r = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  grow(r, GROW_SEC * 0.4);
  assert.ok(r.grow < 1, 'still growing');
  assert.ok(r.live < r.n, `all ${r.n} segments are live after 40% of the growth time`);
  const tip = r.pts[r.live];
  assert.ok(Math.hypot(tip.x - B.x, tip.y - B.y) > 20, 'the tip should not have arrived yet');
}

// Once fused, BOTH ends sit exactly on their anchors — it truly connects.
{
  const r = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  grow(r, GROW_SEC + 6);
  assert.equal(r.grow, 1);
  assert.equal(r.live, r.n);
  assert.ok(Math.hypot(r.pts[0].x - A.x, r.pts[0].y - A.y) < 1e-6, 'the source end is not on the cell');
  assert.ok(Math.hypot(r.pts[r.n].x - B.x, r.pts[r.n].y - B.y) < 1e-6, 'the far end is not on the cell — it stops short, like a wire with a gap');
}

// It hangs slack rather than pulling straight between the two.
{
  const r = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  grow(r, GROW_SEC + 10);
  let longest = 0;
  for (let i = 0; i <= r.n; i += 1) longest = Math.max(longest, Math.abs(r.pts[i].y));
  assert.ok(longest > 8, `the strand is only ${longest.toFixed(1)} px off the straight line — it should sag`);
  // Arc length exceeds the gap: that is what "slack" means.
  let arc = 0;
  for (let i = 0; i < r.n; i += 1) arc += Math.hypot(r.pts[i + 1].x - r.pts[i].x, r.pts[i + 1].y - r.pts[i].y);
  assert.ok(arc > 300 * 1.02, `arc ${arc.toFixed(0)} px over a 300 px gap — no slack`);
}

// Pulled apart, it goes TAUT first and only gives slowly: the creep.
{
  const r = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  grow(r, GROW_SEC + 10);
  // Measure TOTAL slack, not per-segment rest: a long pull also resamples the
  // segment count, so rest alone is not comparable across the change.
  // A drag, not a teleport: a jump past half the rope's length is treated as a
  // transition and re-seeded, which is correct but is not what this checks.
  const far = { x: 520, y: 0 };
  const span = 520;
  for (let i = 0; i < 30; i += 1) stepRope(r, 1 / 60, A, far, FIELD, 0.5);
  const tautRatio = (r.rest * r.n) / span;
  assert.ok(tautRatio < 1.05, `half a second after the pull the strand is already ${tautRatio.toFixed(2)}x the gap — it did not go taut`);
  for (let i = 0; i < 60 * 10; i += 1) stepRope(r, 1 / 60, A, far, FIELD, 0.5);
  const givenRatio = (r.rest * r.n) / span;
  assert.ok(givenRatio > tautRatio + 0.1, `the strand never gave: ${tautRatio.toFixed(2)}x -> ${givenRatio.toFixed(2)}x`);
}

// The same elapsed time at 60 Hz and 240 Hz gives the same strand.
{
  const a = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  const b = makeRope(A.x, A.y, B.x, B.y, 12, 1, 0);
  grow(a, 4, 1 / 60);
  grow(b, 4, 1 / 240);
  assert.ok(Math.abs(a.grow - b.grow) < 0.02, `grow ${a.grow.toFixed(3)} vs ${b.grow.toFixed(3)} — frame-rate dependent`);
}

// An anchor angle creeps around the membrane; it cannot snap across.
{
  let th: number | null = null;
  th = easeAngle(th, { x: 1, y: 0 }, { x: 0, y: 0 }, 1 / 60);
  assert.equal(th, 0, 'the first angle is taken as-is');
  const next = easeAngle(th, { x: -1, y: 0.01 }, { x: 0, y: 0 }, 1 / 60);
  assert.ok(Math.abs(next - th) <= 1.1 / 60 + 1e-9, `the anchor swung ${(next - th).toFixed(3)} rad in one frame — it should be slew-capped`);
}

// The helpers the canvas leans on.
{
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  assert.deepEqual(ropeAt(pts, 2, 0), { x: 0, y: 0 });
  assert.deepEqual(ropeAt(pts, 2, 1), { x: 20, y: 0 });
  assert.equal(Math.round(ropeAt(pts, 2, 0.5).x), 10);
  assert.equal(ropeDistance(pts, 2, 10, 5), 5);
  assert.ok(ropeDistance(pts, 2, 10, 0) < 1e-9);
}

console.log('tendril: all assertions passed');
