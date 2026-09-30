import assert from 'node:assert/strict';
import {
  AUTOMATION_MODES, CURVE_HALFWAY_AT_FULL, curveFromDrag, curveShape, holdsAfterRelease,
  interpolatePoints, modeAfterStop, recordsWhileHeld, sampleCurve, upsertAutomationPoint,
  writeSpan, writesUntouched, type AutomationMode, type CurvePoint,
} from './automationModes.ts';

const near = (a: number, b: number, eps = 1e-12): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

/** A spread of u values strictly inside (0,1), plus the two ends. */
const US = [0, 0.001, 0.05, 0.1, 0.25, 1 / 3, 0.5, 0.618, 0.75, 0.9, 0.999, 1];
const INNER = US.filter((u) => u > 0 && u < 1);
const CURVES = [-1, -0.87, -0.5, -0.25, -0.01, 0, 0.01, 0.25, 0.5, 0.87, 1];

// ── The seven curve laws (the ticket pins every one) ─────────────────────────

// 1. f(0,c) = 0 — the segment starts at the first point's value, whatever the shape.
{
  for (const c of CURVES) assert.equal(curveShape(0, c), 0, `f(0,${c}) must be exactly 0`);
}

// 2. f(1,c) = 1 — and it reaches the target exactly, not 0.9999.
{
  for (const c of CURVES) assert.equal(curveShape(1, c), 1, `f(1,${c}) must be exactly 1`);
}

// 3. f(u,0) = u — absent/zero curve is the linear behaviour every existing lane has.
{
  for (const u of US) assert.equal(curveShape(u, 0), u, `f(${u},0) must be exactly ${u}`);
}

// 4. Monotonic non-decreasing in u — a segment never doubles back.
{
  for (const c of CURVES) {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i += 1) {
      const y = curveShape(i / 200, c);
      assert.ok(y >= prev, `f(u,${c}) went backwards at u=${i / 200}: ${y} < ${prev}`);
      prev = y;
    }
  }
}

// 5. f(u,c) > u for c > 0 on (0,1) — a positive curve reaches the target EARLY.
{
  for (const c of CURVES.filter((x) => x > 0)) {
    for (const u of INNER) assert.ok(curveShape(u, c) > u, `f(${u},${c}) = ${curveShape(u, c)} must exceed ${u}`);
  }
}

// 6. f(u,c) < u for c < 0 on (0,1) — a negative curve reaches it LATE.
{
  for (const c of CURVES.filter((x) => x < 0)) {
    for (const u of INNER) assert.ok(curveShape(u, c) < u, `f(${u},${c}) = ${curveShape(u, c)} must fall below ${u}`);
  }
}

// 7. f(u,c) = 1 - f(1-u,-c) — the negative curve is the mirror of the positive one,
//    so dragging a segment's handle down undoes dragging it up by the same amount.
{
  for (const c of CURVES) {
    for (const u of US) near(curveShape(u, c), 1 - curveShape(1 - u, -c));
  }
}

// The one calibration constant the laws leave free: at full curve the segment is
// 90% of the way at its midpoint (and, by the mirror law, 10% at -1).
{
  assert.equal(CURVE_HALFWAY_AT_FULL, 0.9);
  near(curveShape(0.5, 1), 0.9, 1e-12);
  near(curveShape(0.5, -1), 0.1, 1e-12);
  near(curveShape(0.5, 0), 0.5);
}

// Inputs are clamped, not trusted: a hand-edited project or a runaway drag cannot
// push a sample outside the segment or produce NaN.
{
  assert.equal(curveShape(-3, 0.5), 0);
  assert.equal(curveShape(4, 0.5), 1);
  assert.equal(curveShape(0.5, 7), curveShape(0.5, 1), 'curve clamps to +1');
  assert.equal(curveShape(0.5, -7), curveShape(0.5, -1), 'curve clamps to -1');
  assert.equal(curveShape(0.5, Number.NaN), 0.5, 'a NaN curve reads as linear');
  assert.equal(curveShape(0.5, Infinity), curveShape(0.5, 1));
  assert.equal(curveShape(Number.NaN, 0.5), 0, 'a NaN position reads as the segment start');
}

// ── interpolatePoints ────────────────────────────────────────────────────────

// The segment's shape comes from the LEFT point: a point's curve describes the
// run from it to the next one.
{
  const a: CurvePoint = { t: 0, v: 0, curve: 1 };
  const b: CurvePoint = { t: 2, v: 10, curve: -1 };
  assert.equal(interpolatePoints(a, b, 0), 0);
  assert.equal(interpolatePoints(a, b, 2), 10);
  near(interpolatePoints(a, b, 1), 9, 1e-9); // curve +1 at the midpoint = 90%
  // Curve-less is the plain linear ramp.
  const p: CurvePoint = { t: 0, v: 0 };
  const q: CurvePoint = { t: 2, v: 10 };
  assert.equal(interpolatePoints(p, q, 1), 5);
  assert.equal(interpolatePoints({ t: 0, v: 4, curve: 0 }, { t: 1, v: 4 }, 0.5), 4);
  // Falling segments curve the same way: +1 still means "most of the move, early".
  near(interpolatePoints({ t: 0, v: 10, curve: 1 }, { t: 2, v: 0 }, 1), 1, 1e-9);
  // Coincident points can't divide by zero (the 1e-6 guard sampleLane has always had).
  assert.ok(Number.isFinite(interpolatePoints({ t: 5, v: 1 }, { t: 5, v: 9 }, 5)));
}

// ── sampleCurve edge semantics — identical to the sampleLane it replaces ──────

/** The sampleLane body as it stood before this module existed. The oracle for
 *  "curve-less lanes sample exactly as they always did". */
const legacySample = (pts: CurvePoint[], t: number): number | null => {
  if (pts.length === 0) return null;
  if (t <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return a.v + (b.v - a.v) * f;
};

{
  assert.equal(sampleCurve([], 0), null, 'no points = no opinion (null, not 0)');
  assert.equal(sampleCurve([{ t: 3, v: 7 }], 0), 7, 'before the only point holds it');
  assert.equal(sampleCurve([{ t: 3, v: 7 }], 99), 7, 'after the only point holds it');
  const pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 3, v: 10 }, { t: 4, v: -5 }, { t: 9, v: 2 }];
  // Exhaustive sweep against the legacy oracle: every boundary, every interior
  // point, and well outside both ends.
  for (let i = -20; i <= 220; i += 1) {
    const t = i / 20;
    assert.equal(sampleCurve(pts, t), legacySample(pts, t), `curve-less sample drifted at t=${t}`);
  }
  // The coincident-t guard survives.
  const dup: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 5 }, { t: 1, v: 5 }, { t: 2, v: 9 }];
  for (const t of [0, 0.5, 1, 1.5, 2]) assert.equal(sampleCurve(dup, t), legacySample(dup, t));
}

// A curve bends the segment it starts, and nothing else.
{
  const pts: CurvePoint[] = [{ t: 0, v: 0, curve: 1 }, { t: 2, v: 10 }, { t: 4, v: 0 }];
  near(sampleCurve(pts, 1) as number, 9, 1e-9);        // shaped by the first point
  assert.equal(sampleCurve(pts, 3), 5);                 // the next segment is still linear
  assert.equal(sampleCurve(pts, 0), 0);
  assert.equal(sampleCurve(pts, 2), 10);
  assert.equal(sampleCurve(pts, 4), 0);
  assert.equal(sampleCurve(pts, 100), 0, 'the last value still holds past the end');
  // The LAST point's curve has no segment to shape, so it changes nothing.
  const tail: CurvePoint[] = [{ t: 0, v: 0 }, { t: 2, v: 10, curve: 1 }];
  assert.equal(sampleCurve(tail, 1), 5);
  assert.equal(sampleCurve(tail, 3), 10);
}

// ── writeSpan — a held control writes its value FORWARD through time ──────────

const MIN_DT = 0.02;

// The overwrite: everything strictly inside (fromT, toT] goes, the boundary point
// AT fromT survives, and the new value lands at toT.
{
  const pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }, { t: 5, v: 5 }];
  const out = writeSpan(pts, 1, 3, 9, MIN_DT);
  assert.deepEqual(out, [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 3, v: 9 }, { t: 5, v: 5 }]);
  assert.deepEqual(pts, [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }, { t: 5, v: 5 }], 'input is not mutated');
  // No stale breakpoint is left inside the pass: sampling anywhere in the span
  // rides the written ramp, never the values that were there.
  assert.equal(out.some((p) => p.t > 1 && p.t < 3), false);
}

// The point at toT is replaced, not duplicated.
{
  const out = writeSpan([{ t: 0, v: 0 }, { t: 2, v: 2 }], 1, 2, 9, MIN_DT);
  assert.deepEqual(out, [{ t: 0, v: 0 }, { t: 2, v: 9 }]);
}

// minDt merge, mirroring upsertPoint: a neighbour closer than minDt keeps ITS
// time and takes the new value — a 50 Hz gesture thins instead of piling up.
{
  // Left neighbour within minDt.
  assert.deepEqual(writeSpan([{ t: 1, v: 1 }], 1, 1.01, 9, MIN_DT), [{ t: 1, v: 9 }]);
  // Right neighbour within minDt.
  assert.deepEqual(writeSpan([{ t: 4, v: 4 }], 3.99, 3.995, 9, MIN_DT), [{ t: 4, v: 9 }]);
  // Far enough apart: a new point.
  assert.deepEqual(writeSpan([{ t: 1, v: 1 }], 1, 1.5, 9, MIN_DT), [{ t: 1, v: 1 }, { t: 1.5, v: 9 }]);
}

// A degenerate or backwards span is just the upsert — no removal window at all.
{
  const pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }];
  assert.deepEqual(writeSpan(pts, 5, 5, 9, MIN_DT), [...pts, { t: 5, v: 9 }]);
  assert.deepEqual(writeSpan(pts, 9, 1.5, 7, MIN_DT), [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 1.5, v: 7 }, { t: 2, v: 2 }],
    'fromT > toT removes nothing; only the upsert happens');
  assert.deepEqual(writeSpan([], 0, 1, 3, MIN_DT), [{ t: 1, v: 3 }], 'an empty lane gains its first point');
}

// Output stays sorted ascending after a write that lands mid-array.
{
  const out = writeSpan([{ t: 0, v: 0 }, { t: 4, v: 4 }, { t: 8, v: 8 }], 0.5, 2, 1, MIN_DT);
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i].t >= out[i - 1].t, 'writeSpan kept the array sorted');
  assert.deepEqual(out, [{ t: 0, v: 0 }, { t: 2, v: 1 }, { t: 4, v: 4 }, { t: 8, v: 8 }]);
}

// A whole overwrite pass: eight frames of a held control across a lane that was
// full of other breakpoints leaves exactly the written ride.
{
  let pts: CurvePoint[] = [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }, { t: 1.5, v: 1 }, { t: 2, v: 0 }];
  let lastT = 0.4;
  for (let i = 1; i <= 8; i += 1) {
    const t = 0.4 + i * 0.2;
    pts = writeSpan(pts, lastT, t, 0.25, MIN_DT);
    lastT = t;
  }
  assert.equal(pts.filter((p) => p.t > 0.4 && p.t <= 2).every((p) => p.v === 0.25), true,
    'nothing but the written value survives inside the pass');
  assert.equal(pts[0].t, 0, 'what was BEFORE the pass is untouched');
  assert.equal(pts[0].v, 0);
}

// ── upsertAutomationPoint — curve handling (writeSpan and the store share it) ──
{
  // An explicit curve rides along on an insert; 0 and undefined stay ABSENT, so a
  // curve-less lane keeps the exact `{t, v}` shape it has always had on disk.
  assert.deepEqual(upsertAutomationPoint([], 1, 2, MIN_DT, 0.5), [{ t: 1, v: 2, curve: 0.5 }]);
  assert.deepEqual(upsertAutomationPoint([], 1, 2, MIN_DT, 0), [{ t: 1, v: 2 }]);
  assert.deepEqual(upsertAutomationPoint([], 1, 2, MIN_DT), [{ t: 1, v: 2 }]);
  assert.deepEqual(upsertAutomationPoint([], 1, 2, MIN_DT, 5), [{ t: 1, v: 2, curve: 1 }], 'curve clamps');
  // A merged neighbour keeps its own curve when the writer names none — a fader
  // ride overwrites VALUES, it does not flatten shapes somebody drew.
  assert.deepEqual(upsertAutomationPoint([{ t: 1, v: 1, curve: -0.5 }], 1.005, 9, MIN_DT),
    [{ t: 1, v: 9, curve: -0.5 }]);
  // ...and yields to an explicit one.
  assert.deepEqual(upsertAutomationPoint([{ t: 1, v: 1, curve: -0.5 }], 1.005, 9, MIN_DT, 0.25),
    [{ t: 1, v: 9, curve: 0.25 }]);
}

// ── curveFromDrag ────────────────────────────────────────────────────────────
{
  assert.equal(curveFromDrag(0, 0), 0);
  assert.equal(curveFromDrag(0, -50), 0.5, 'dragging UP (negative dy) makes the segment faster');
  assert.equal(curveFromDrag(0, 50), -0.5);
  assert.equal(curveFromDrag(0.5, -25), 0.75, 'the drag starts from the curve it grabbed');
  assert.equal(curveFromDrag(0, -1000), 1, 'clamped to +1');
  assert.equal(curveFromDrag(0, 1000), -1, 'clamped to -1');
  assert.equal(curveFromDrag(0, -25, 50), 0.5, 'pxPerUnit sets the drag sensitivity');
  assert.equal(curveFromDrag(Number.NaN, -50), 0.5, 'a missing start curve reads as linear');
  assert.equal(curveFromDrag(0, Number.NaN), 0, 'a junk delta moves nothing');
}

// ── The four modes ───────────────────────────────────────────────────────────
{
  assert.deepEqual(AUTOMATION_MODES, ['read', 'touch', 'latch', 'write'] as AutomationMode[]);

  // read never records anything.
  assert.equal(recordsWhileHeld('read'), false);
  assert.equal(holdsAfterRelease('read'), false);
  assert.equal(writesUntouched('read'), false);
  assert.equal(modeAfterStop('read'), 'read');

  // touch records while held and punches out on release.
  assert.equal(recordsWhileHeld('touch'), true);
  assert.equal(holdsAfterRelease('touch'), false);
  assert.equal(writesUntouched('touch'), false);
  assert.equal(modeAfterStop('touch'), 'touch');

  // latch records while held and keeps writing the released value.
  assert.equal(recordsWhileHeld('latch'), true);
  assert.equal(holdsAfterRelease('latch'), true);
  assert.equal(writesUntouched('latch'), false);
  assert.equal(modeAfterStop('latch'), 'latch');

  // write is latch plus "everything is held from play start", and demotes itself
  // on stop so the next pass doesn't silently overwrite the whole project again.
  assert.equal(recordsWhileHeld('write'), true);
  assert.equal(holdsAfterRelease('write'), true);
  assert.equal(writesUntouched('write'), true);
  assert.equal(modeAfterStop('write'), 'latch');
}

console.log('automationModes.test.ts: all assertions passed');
