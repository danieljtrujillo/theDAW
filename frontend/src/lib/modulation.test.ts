/**
 * modulation.test.ts — the pure core first, then the engine on a fake clock.
 *
 * Every LFO number below is asserted against the SAME arithmetic NodeF.I.'s
 * private ticker used (`nodefiLive.ts`, the `wave` switch), because this module
 * replaces that ticker and a shape that drifts by a hair is a shape that
 * changed. The parity block at the bottom re-implements the old expression
 * verbatim and diffs it against `sampleSource` over a spread of times.
 */
import assert from 'node:assert/strict';
import { beatClock } from './beatClock.ts';
import {
  applyRoutes, createModEngine, gridBeats, normalizedDepth, sampleSource, shRandom,
  spanOf, syncedRateHz, targetKey,
  type ModContextState, type ModRoute, type ModShape, type ModTarget,
} from './modulation.ts';

const near = (a: number, b: number, eps = 1e-12): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const rack = (paramKey: string, min: number, max: number, entryId = 'e1'): ModTarget =>
  ({ kind: 'rackParam', scope: 'bus', entryId, paramKey, min, max });

/* ── 1. LFO shapes at known phases ───────────────────────────────────────── */

// The four continuous shapes, evaluated at the phases whose values are exact.
{
  const at = (shape: ModShape, phase: number): number =>
    sampleSource({ kind: 'lfo', shape, rateHz: 1, depth: 1, phase0: phase }, 0, {});

  // sine: 0 at 0 and 0.5, +1 at a quarter, -1 at three quarters.
  near(at('sine', 0), 0);
  near(at('sine', 0.25), 1);
  near(at('sine', 0.5), 0);
  near(at('sine', 0.75), -1);

  // saw: a straight ramp -1 → +1 across the cycle.
  assert.equal(at('saw', 0), -1);
  assert.equal(at('saw', 0.25), -0.5);
  assert.equal(at('saw', 0.5), 0);
  assert.equal(at('saw', 0.75), 0.5);

  // tri: NodeF.I.'s triangle starts at the PEAK (4·|c−0.5|−1), so 0 is +1 and
  // the midpoint is −1. Pinned deliberately: this is the existing shape.
  assert.equal(at('tri', 0), 1);
  assert.equal(at('tri', 0.25), 0);
  assert.equal(at('tri', 0.5), -1);
  assert.equal(at('tri', 0.75), 0);

  // square: +1 for the first half of the cycle, −1 for the second.
  assert.equal(at('square', 0), 1);
  assert.equal(at('square', 0.499), 1);
  assert.equal(at('square', 0.5), -1);
  assert.equal(at('square', 0.9), -1);
}

// Rate and time combine as (rate·t + phase0) mod 1, and the phase wraps for a
// NEGATIVE t instead of running off the end of the shape (NodeF.I. ticks a few
// times before its t0, where the un-wrapped triangle read 1.2).
{
  const src = { kind: 'lfo', shape: 'saw', rateHz: 2, depth: 1 } as const;
  assert.equal(sampleSource(src, 0.25, {}), 0);        // 2·0.25 = half a cycle
  assert.equal(sampleSource(src, 0.5, {}), -1);        // exactly one cycle, back to the start
  assert.equal(sampleSource(src, 0.375, {}), 0.5);
  const tri = { kind: 'lfo', shape: 'tri', rateHz: 1, depth: 1 } as const;
  for (let t = -1; t < 1; t += 0.017) {
    const v = sampleSource(tri, t, {});
    assert.ok(v >= -1 && v <= 1, `tri out of range at t=${t}: ${v}`);
  }
  // A non-negative phase is bit-identical to the raw modulo, not a re-wrapped
  // approximation of it (1.3 % 1 is 0.30000000000000004, and that is not this).
  assert.equal(sampleSource({ kind: 'lfo', shape: 'saw', rateHz: 1, depth: 1 }, 0.3, {}), 2 * (0.3 % 1) - 1);
}

/* ── 2. Sample-and-hold is deterministic ─────────────────────────────────── */
{
  const src = { kind: 'lfo', shape: 'sh', rateHz: 4, depth: 1 } as const;
  const rng = (step: number): number => ((step * 7) % 10) / 10;
  const st: ModContextState = { rng };

  // Held across the whole step, and it is the step's value, not the time's.
  assert.equal(sampleSource(src, 0.0, st), 2 * rng(0) - 1);
  assert.equal(sampleSource(src, 0.1, st), 2 * rng(0) - 1);
  assert.equal(sampleSource(src, 0.2499, st), 2 * rng(0) - 1);
  // A new step, a new value.
  assert.equal(sampleSource(src, 0.25, st), 2 * rng(1) - 1);
  assert.equal(sampleSource(src, 0.75, st), 2 * rng(3) - 1);
  // Same t, same value, however many times it is asked — no hidden RNG cursor.
  for (let i = 0; i < 5; i += 1) assert.equal(sampleSource(src, 0.42, st), 2 * rng(1) - 1);

  // The built-in RNG is a pure hash of the step: in range, repeatable, and not
  // a constant.
  const seen = new Set<number>();
  for (let s = 0; s < 64; s += 1) {
    const v = shRandom(s);
    assert.ok(v >= 0 && v < 1, `shRandom(${s}) = ${v} out of [0,1)`);
    assert.equal(shRandom(s), v);
    seen.add(v);
  }
  assert.ok(seen.size > 50, `shRandom is too repetitive: ${seen.size} distinct of 64`);
  // With no injected RNG the default is used, and it is still deterministic.
  assert.equal(sampleSource(src, 0.3, {}), sampleSource(src, 0.3, {}));
  assert.equal(sampleSource(src, 0.3, {}), 2 * shRandom(1) - 1);
}

/* ── 3. Macro and lane sources ───────────────────────────────────────────── */
{
  // A macro is its own value, clamped to [0,1] — a hand-edited project cannot
  // push a target past its range through the macro.
  assert.equal(sampleSource({ kind: 'macro', id: 'm1', value: 0.25 }, 0, {}), 0.25);
  assert.equal(sampleSource({ kind: 'macro', id: 'm1', value: -3 }, 0, {}), 0);
  assert.equal(sampleSource({ kind: 'macro', id: 'm1', value: 9 }, 0, {}), 1);
  assert.equal(sampleSource({ kind: 'macro', id: 'm1', value: Number.NaN }, 0, {}), 0);

  // A lane is read through the injected reader at tSec, with the SAME segment
  // curve the editor draws (automationModes.sampleCurve), clamped to [0,1].
  const lane = { id: 'l1', enabled: true, points: [{ t: 0, v: 0 }, { t: 2, v: 1 }] };
  const st: ModContextState = { getLane: (id) => (id === 'l1' ? lane : undefined) };
  assert.equal(sampleSource({ kind: 'lane', laneId: 'l1' }, 0, st), 0);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'l1' }, 1, st), 0.5);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'l1' }, 2, st), 1);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'l1' }, 99, st), 1); // holds the last point
  // A missing lane, a disabled lane, an empty lane and a missing reader are all
  // "no modulation", never a throw.
  assert.equal(sampleSource({ kind: 'lane', laneId: 'nope' }, 1, st), 0);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'l1' }, 1, {}), 0);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'x' }, 1, { getLane: () => ({ id: 'x', enabled: true, points: [] }) }), 0);
  assert.equal(sampleSource({ kind: 'lane', laneId: 'x' }, 1, { getLane: () => ({ id: 'x', enabled: false, points: [{ t: 0, v: 1 }] }) }), 0);
  // Out-of-range lane values clamp rather than blowing past the target range.
  assert.equal(sampleSource({ kind: 'lane', laneId: 'x' }, 1, { getLane: () => ({ id: 'x', enabled: true, points: [{ t: 0, v: 7 }] }) }), 1);
}

/* ── 4. Tempo sync reuses beatClock's grid → beats mapping ───────────────── */
{
  beatClock.setBeatsPerBar(4);
  assert.equal(gridBeats('16th'), 0.25);
  assert.equal(gridBeats('8th'), 0.5);
  assert.equal(gridBeats('beat'), 1);
  assert.equal(gridBeats('half'), 2);
  assert.equal(gridBeats('bar'), 4);
  assert.equal(gridBeats('2bar'), 8);
  assert.equal(gridBeats('4bar'), 16);

  // rate = bpm/60 ÷ beats-per-cycle. At 120 BPM a beat-synced LFO runs 2 Hz.
  near(syncedRateHz('beat', 120), 2);
  near(syncedRateHz('bar', 120), 0.5);
  near(syncedRateHz('16th', 120), 8);

  // The mapping is the clock's, so a 7/4 bar is 7 beats long here too — it is
  // read from beatClock, not re-tabulated.
  beatClock.setBeatsPerBar(7);
  assert.equal(gridBeats('bar'), 7);
  near(syncedRateHz('bar', 120), 2 / 7);
  beatClock.setBeatsPerBar(4);

  // A synced source ignores its own rateHz, and takes bpm from the state (or
  // from the clock when the state does not carry one).
  const synced = { kind: 'lfo', shape: 'saw', rateHz: 999, depth: 1, sync: 'beat' } as const;
  near(sampleSource(synced, 0.25, { bpm: 120 }), 0);   // 2 Hz → half a cycle at 0.25 s
  beatClock.setBpm(120, 'internal');
  near(sampleSource(synced, 0.25, {}), 0);
  // 'now' has no period; it holds at the start of the shape instead of dividing by zero.
  assert.equal(sampleSource({ kind: 'lfo', shape: 'saw', rateHz: 1, depth: 1, sync: 'now' }, 7.3, { bpm: 120 }), -1);
}

/* ── 5. Routes: the formula, the sum, the clamp ──────────────────────────── */
{
  const t = rack('cutoff', 200, 2200);              // span 2000
  const key = targetKey(t);
  assert.equal(spanOf(t), 2000);
  const route: ModRoute = {
    id: 'r1',
    source: { kind: 'lfo', shape: 'sine', rateHz: 1, depth: 0.1 },
    target: t,
    amount: 1,
    bipolar: true,
  };
  // base + amount·depth·sample·(max−min)
  let out = applyRoutes([route], { r1: 1 }, { [key]: 1000 });
  near(out[key], 1000 + 1 * 0.1 * 1 * 2000);
  out = applyRoutes([route], { r1: -0.5 }, { [key]: 1000 });
  near(out[key], 1000 - 100);
  // Amount is signed: −1 inverts the source.
  out = applyRoutes([{ ...route, amount: -1 }], { r1: 1 }, { [key]: 1000 });
  near(out[key], 800);

  // Two routes onto ONE target sum, and the sum is clamped to the descriptor.
  const a: ModRoute = { ...route, id: 'a' };
  const b: ModRoute = { ...route, id: 'b', source: { kind: 'macro', id: 'm', value: 1 } };
  out = applyRoutes([a, b], { a: 1, b: 1 }, { [key]: 1000 });
  assert.equal(out[key], 2200);                       // pre-clamp 3200, clamped to the top
  assert.equal(Object.keys(out).length, 1, 'one entry per target, not per route');
  out = applyRoutes([a, b], { a: 1, b: 1 }, {});       // base 0 when none supplied
  near(out[key], Math.min(2200, 0 + 200 + 2000));
  assert.equal(applyRoutes([{ ...a, amount: -1 }], { a: 1 }, { [key]: 200 })[key], 200); // and the bottom

  // A target with no usable span (an unclamped NodeF.I. param, min/max ±∞)
  // takes the depth as raw units, which is exactly what its ticker did.
  const open = rack('gain', -Infinity, Infinity);
  const ok = targetKey(open);
  const raw: ModRoute = { id: 'q', source: { kind: 'lfo', shape: 'sine', rateHz: 1, depth: 0.5 }, target: open, amount: 1, bipolar: true };
  assert.equal(spanOf(open), 1);
  assert.equal(applyRoutes([raw], { q: 1 }, { [ok]: 3 })[ok], 3.5);

  // normalizedDepth is the inverse of the span multiply, so a caller holding a
  // depth in NATURAL units gets its number back untouched.
  const d = normalizedDepth(0.25, t);
  near(applyRoutes([{ ...route, source: { kind: 'lfo', shape: 'sine', rateHz: 1, depth: d } }], { r1: 1 }, { [key]: 1000 })[key], 1000.25, 1e-9);
}

// Polarity: `bipolar` states what the ROUTE wants, and the sample is converted
// into that, whatever the source's natural range is.
{
  const t = rack('mix', 0, 1);
  const key = targetKey(t);
  const lfo = { kind: 'lfo', shape: 'sine', rateHz: 1, depth: 1 } as const;
  const macro = { kind: 'macro', id: 'm', value: 1 } as const;
  // bipolar LFO into a unipolar route: [-1,1] → [0,1].
  near(applyRoutes([{ id: 'r', source: lfo, target: t, amount: 1, bipolar: false }], { r: -1 }, { [key]: 0 })[key], 0);
  near(applyRoutes([{ id: 'r', source: lfo, target: t, amount: 1, bipolar: false }], { r: 1 }, { [key]: 0 })[key], 1);
  near(applyRoutes([{ id: 'r', source: lfo, target: t, amount: 1, bipolar: false }], { r: 0 }, { [key]: 0 })[key], 0.5);
  // unipolar macro into a bipolar route: [0,1] → [-1,1].
  near(applyRoutes([{ id: 'r', source: macro, target: t, amount: 1, bipolar: true }], { r: 0 }, { [key]: 0.5 })[key], 0);
  near(applyRoutes([{ id: 'r', source: macro, target: t, amount: 1, bipolar: true }], { r: 1 }, { [key]: 0.5 })[key], 1);
  // Matching polarity passes straight through.
  near(applyRoutes([{ id: 'r', source: lfo, target: t, amount: 1, bipolar: true }], { r: -1 }, { [key]: 0.5 })[key], 0);
}

// Target keys are stable and scope-aware, so two racks with the same param key
// never collide, and an AudioParam gets an identity without being stringifiable.
{
  assert.equal(targetKey(rack('mix', 0, 1, 'e1')), targetKey(rack('mix', 0, 1, 'e1')));
  assert.notEqual(targetKey(rack('mix', 0, 1, 'e1')), targetKey(rack('mix', 0, 1, 'e2')));
  assert.notEqual(
    targetKey({ kind: 'rackParam', scope: 'track', entryId: 'e1', paramKey: 'mix', min: 0, max: 1 }),
    targetKey({ kind: 'rackParam', scope: 'master', entryId: 'e1', paramKey: 'mix', min: 0, max: 1 }),
  );
  const p1 = { value: 0 } as unknown as AudioParam;
  const p2 = { value: 0 } as unknown as AudioParam;
  const ap = (param: AudioParam): ModTarget => ({ kind: 'audioParam', param, base: 0, min: 0, max: 1 });
  assert.equal(targetKey(ap(p1)), targetKey(ap(p1)));
  assert.notEqual(targetKey(ap(p1)), targetKey(ap(p2)));
  // An audioParam route with no base supplied falls back to the target's own.
  const k = targetKey(ap(p1));
  near(
    applyRoutes(
      [{ id: 'r', source: { kind: 'macro', id: 'm', value: 1 }, target: { kind: 'audioParam', param: p1, base: 0.25, min: 0, max: 1 }, amount: 1, bipolar: false }],
      { r: 1 },
      {},
    )[k],
    1,
  );
}

/* ── 6. The engine on a fake clock ───────────────────────────────────────── */

interface FakeTimerState { fire: () => void; ms: number | null; cleared: boolean }
const fakeTimer = (): { timer: { set: (fn: () => void, ms: number) => number; clear: (h: number) => void }; state: FakeTimerState } => {
  const state: FakeTimerState = { fire: () => {}, ms: null, cleared: false };
  return {
    timer: {
      set: (fn, ms) => { state.fire = fn; state.ms = ms; state.cleared = false; return 1; },
      clear: () => { state.cleared = true; state.ms = null; },
    },
    state,
  };
};

{
  const { timer, state } = fakeTimer();
  const writes: Array<[string, number]> = [];
  let t = 0;
  const target = rack('depth', 0, 1);
  const key = targetKey(target);
  const engine = createModEngine({
    now: () => t,
    apply: (k, v) => { writes.push([k, v]); },
    timer,
    base: () => 0.5,
  });

  // No routes, no ticker — the same "only tick when something is modulating"
  // rule NodeF.I. had.
  assert.equal(state.ms, null);

  engine.addRoute({ id: 'r1', source: { kind: 'lfo', shape: 'square', rateHz: 1, depth: 0.25 }, target, amount: 1, bipolar: true });
  assert.equal(state.ms, 33, 'the default tick is 33 ms, as NodeF.I. ticked');

  state.fire();                                    // t=0 → square +1 → 0.5 + 0.25
  assert.deepEqual(writes, [[key, 0.75]]);
  state.fire();                                    // same value, same tick → no second write
  assert.deepEqual(writes, [[key, 0.75]]);
  t = 0.6;                                         // past the half cycle → −1 → 0.25
  state.fire();
  assert.deepEqual(writes, [[key, 0.75], [key, 0.25]]);

  // Two routes on ONE target still produce exactly ONE apply per tick.
  writes.length = 0;
  engine.addRoute({ id: 'r2', source: { kind: 'macro', id: 'm', value: 0.5 }, target, amount: 1, bipolar: false });
  t = 0;
  state.fire();
  assert.equal(writes.length, 1, 'one apply per target per tick');
  near(writes[0][1], Math.min(1, 0.5 + 0.25 + 0.5));

  // setMacro moves every route that reads that macro, and the next tick writes.
  writes.length = 0;
  engine.setMacro('m', 0);
  state.fire();
  assert.equal(writes.length, 1);
  near(writes[0][1], 0.75);
  writes.length = 0;
  engine.setMacro('m', 0);                          // unchanged → still no write
  state.fire();
  assert.equal(writes.length, 0);

  // invalidate() forgets what was last written, so the SAME sample writes
  // again. This is what keeps a modulated param from being stranded when
  // something else (NodeF.I.'s `updateParams`, pushing static params through
  // `setParams`) resets the target underneath a flat stretch of the shape.
  writes.length = 0;
  state.fire();
  assert.equal(writes.length, 0, 'nothing moved, so nothing is written');
  engine.invalidate();
  state.fire();
  assert.equal(writes.length, 1, 'after invalidate the same value is written again');
  const stale = writes[0];
  writes.length = 0;
  state.fire();
  assert.equal(writes.length, 0, 'and then the memo holds again');
  // A targeted invalidate only frees the key it names.
  engine.invalidate('not-a-target');
  state.fire();
  assert.equal(writes.length, 0);
  engine.invalidate(stale[0]);
  state.fire();
  assert.deepEqual(writes, [stale]);

  // updateRoute re-aims a live route; removeRoute stops it.
  const other = rack('depth', 0, 1, 'e2');
  engine.updateRoute('r2', { target: other });
  writes.length = 0;
  state.fire();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], targetKey(other));
  engine.removeRoute('r2');
  engine.removeRoute('r1');
  assert.equal(state.cleared, true, 'the ticker stops when the last route goes');
  writes.length = 0;
  state.fire();
  assert.equal(writes.length, 0);

  // dispose leaves nothing running, and a disposed engine never writes again.
  engine.addRoute({ id: 'r3', source: { kind: 'macro', id: 'm', value: 1 }, target, amount: 1, bipolar: false });
  assert.equal(state.cleared, false);
  engine.dispose();
  assert.equal(state.cleared, true);
  writes.length = 0;
  state.fire();
  engine.addRoute({ id: 'r4', source: { kind: 'macro', id: 'm', value: 1 }, target, amount: 1, bipolar: false });
  engine.setMacro('m', 0.2);
  engine.dispose();
  assert.equal(writes.length, 0, 'a disposed engine never writes again');
}

// A custom tick interval is honoured, and the lane reader is read fresh on
// every tick rather than captured once.
{
  const { timer, state } = fakeTimer();
  let t = 0;
  let laneV = 0;
  const target = rack('mix', 0, 1);
  const writes: number[] = [];
  const engine = createModEngine({
    now: () => t,
    apply: (_k, v) => { writes.push(v); },
    tickMs: 10,
    timer,
    state: () => ({ getLane: () => ({ id: 'l', enabled: true, points: [{ t: 0, v: laneV }] }) }),
    base: () => 0,
  });
  engine.addRoute({ id: 'r', source: { kind: 'lane', laneId: 'l' }, target, amount: 1, bipolar: false });
  assert.equal(state.ms, 10);
  state.fire();
  assert.deepEqual(writes, [0]);
  laneV = 0.75;
  t = 1;
  state.fire();
  assert.deepEqual(writes, [0, 0.75]);
  engine.dispose();
}

/* ── 7. connectAudioRate: osc → gain(depth) → param ──────────────────────── */
{
  interface FakeNode { connected: unknown[]; disconnected: number }
  const mk = (): FakeNode & Record<string, unknown> => {
    const n: FakeNode & Record<string, unknown> = {
      connected: [],
      disconnected: 0,
      connect(to: unknown) { n.connected.push(to); },
      disconnect() { n.disconnected += 1; },
    };
    return n;
  };
  let started = 0;
  let stopped = 0;
  const oscs: Array<Record<string, unknown>> = [];
  const gains: Array<Record<string, unknown>> = [];
  const consts: Array<Record<string, unknown>> = [];
  const ctx = {
    currentTime: 0,
    createConstantSource() {
      const n = mk();
      n.offset = { value: 0 };
      n.start = () => { started += 1; };
      n.stop = () => { stopped += 1; };
      consts.push(n);
      return n;
    },
    createOscillator() {
      const n = mk();
      n.type = 'sine';
      n.frequency = { value: 0 };
      n.start = () => { started += 1; };
      n.stop = () => { stopped += 1; };
      oscs.push(n);
      return n;
    },
    createGain() {
      const n = mk();
      n.gain = { value: 0 };
      gains.push(n);
      return n;
    },
  } as unknown as BaseAudioContext;

  const { timer } = fakeTimer();
  const engine = createModEngine({ ctx, now: () => 0, apply: () => {}, timer });
  const param = { value: 0 } as unknown as AudioParam;
  const route: ModRoute = {
    id: 'ar',
    source: { kind: 'lfo', shape: 'tri', rateHz: 5, depth: 0.3 },
    target: { kind: 'audioParam', param, base: 0, min: 0, max: 1 },
    amount: 1,
    bipolar: true,
  };
  const off = engine.connectAudioRate(route);
  assert.ok(off, 'an lfo → AudioParam route connects at audio rate');
  assert.equal(oscs.length, 1);
  assert.equal(gains.length, 1);
  assert.equal(oscs[0].type, 'triangle', 'shape names map onto OscillatorType');
  assert.deepEqual(oscs[0].frequency, { value: 5 });
  // depth scales by the target span, so a 0..1 param moves by ±0.3 here.
  assert.deepEqual(gains[0].gain, { value: 0.3 });
  assert.deepEqual((oscs[0] as unknown as FakeNode).connected, [gains[0]]);
  assert.deepEqual((gains[0] as unknown as FakeNode).connected, [param]);
  assert.equal(started, 1);

  off?.();
  assert.equal(stopped, 1);
  assert.equal((oscs[0] as unknown as FakeNode).disconnected, 1);
  assert.equal((gains[0] as unknown as FakeNode).disconnected, 1);
  off?.();                                          // idempotent
  assert.equal(stopped, 1);

  // Amount is folded into the gain, and a negative amount inverts the LFO.
  const off2 = engine.connectAudioRate({ ...route, amount: -0.5 });
  assert.deepEqual(gains[1].gain, { value: -0.15 });
  off2?.();

  // A rack param is not an AudioParam, and sample-and-hold is not an
  // OscillatorNode shape: both fall back to the control-rate ticker.
  assert.equal(engine.connectAudioRate({ ...route, target: rack('mix', 0, 1) }), null);
  assert.equal(engine.connectAudioRate({ ...route, source: { kind: 'lfo', shape: 'sh', rateHz: 5, depth: 0.3 } }), null);
  assert.equal(engine.connectAudioRate({ ...route, source: { kind: 'macro', id: 'm', value: 1 } }), null);
  assert.equal(oscs.length, 2, 'no oscillator is built for a route that cannot run at audio rate');

  // A synced source takes its audio-rate frequency from the tempo, too.
  const off3 = engine.connectAudioRate({ ...route, source: { kind: 'lfo', shape: 'sine', rateHz: 1, depth: 0.5, sync: 'beat' } });
  assert.deepEqual(oscs[2].frequency, { value: syncedRateHz('beat', beatClock.bpm) });
  off3?.();

  // dispose tears down anything still connected.
  const off4 = engine.connectAudioRate(route);
  assert.ok(off4);
  const oscN = oscs[oscs.length - 1] as unknown as FakeNode;
  engine.dispose();
  assert.equal(oscN.disconnected, 1, 'dispose disconnects a live audio-rate route');

  // An engine with no context cannot wire audio rate at all.
  const noCtx = createModEngine({ now: () => 0, apply: () => {}, timer });
  assert.equal(noCtx.connectAudioRate(route), null);
  noCtx.dispose();

  // A UNIPOLAR route wants 0..1 out of a ±1 oscillator, which is half the swing
  // plus a DC offset of the same half — so the wiring grows a ConstantSourceNode
  // leg straight into the param alongside the halved depth gain.
  const uni = createModEngine({ ctx, now: () => 0, apply: () => {}, timer });
  const oscBefore = oscs.length;
  const gainBefore = gains.length;
  const startBefore = started;
  const offU = uni.connectAudioRate({ ...route, bipolar: false });
  assert.ok(offU, 'a unipolar audio-rate route wires through a constant source');
  assert.equal(oscs.length, oscBefore + 1);
  assert.equal(gains.length, gainBefore + 1);
  assert.equal(consts.length, 1);
  const uOsc = oscs[oscs.length - 1] as unknown as FakeNode;
  const uGain = gains[gains.length - 1];
  const uDc = consts[0];
  // swing = amount · depth · span = 1 · 0.3 · 1, halved onto each leg.
  assert.deepEqual(uGain.gain, { value: 0.15 });
  assert.deepEqual(uDc.offset, { value: 0.15 });
  assert.deepEqual(uOsc.connected, [uGain]);
  assert.deepEqual((uGain as unknown as FakeNode).connected, [param]);
  assert.deepEqual((uDc as unknown as FakeNode).connected, [param], 'the DC leg goes straight at the param');
  assert.equal(started, startBefore + 2, 'both the oscillator and the constant source are started');

  const stopBefore = stopped;
  offU?.();
  assert.equal(stopped, stopBefore + 2, 'the disposer stops both');
  assert.equal(uOsc.disconnected, 1);
  assert.equal((uGain as unknown as FakeNode).disconnected, 1);
  assert.equal((uDc as unknown as FakeNode).disconnected, 1);
  offU?.();                                         // idempotent, both legs
  assert.equal(stopped, stopBefore + 2);
  assert.equal((uDc as unknown as FakeNode).disconnected, 1);

  // dispose tears the DC leg down too, when the caller never called the disposer.
  const offU2 = uni.connectAudioRate({ ...route, bipolar: false });
  assert.ok(offU2);
  const uDc2 = consts[consts.length - 1] as unknown as FakeNode;
  uni.dispose();
  assert.equal(uDc2.disconnected, 1);

  // With no ConstantSourceNode there is no honest way to offset the oscillator,
  // so the route falls back to the ticker rather than sitting an octave wrong.
  const bare = { createOscillator: ctx.createOscillator, createGain: ctx.createGain } as unknown as BaseAudioContext;
  const noDc = createModEngine({ ctx: bare, now: () => 0, apply: () => {}, timer });
  assert.equal(noDc.connectAudioRate({ ...route, bipolar: false }), null);
  assert.ok(noDc.connectAudioRate({ ...route, bipolar: true }), 'a bipolar route still wires without one');
  noDc.dispose();
}

/* ── 8. NodeF.I. parity ──────────────────────────────────────────────────── */

// The old ticker's arithmetic, transcribed from nodefiLive.ts before this
// module replaced it. If the two ever disagree, a NodeF.I. patch changed shape.
const legacyWave = (shape: string, cyc: number): number =>
  shape === 'square' ? (cyc < 0.5 ? 1 : -1)
  : shape === 'sawtooth' ? 2 * cyc - 1
  : shape === 'triangle' ? 4 * Math.abs(cyc - 0.5) - 1
  : Math.sin(2 * Math.PI * cyc);

const LEGACY_TO_MOD: Record<string, ModShape> = { square: 'square', sawtooth: 'saw', triangle: 'tri', sine: 'sine' };

{
  for (const [legacy, shape] of Object.entries(LEGACY_TO_MOD)) {
    for (const rate of [0.1, 0.5, 1, 3.7, 8]) {
      for (let i = 0; i <= 120; i += 1) {
        const t = i * 0.033;
        const cyc = (rate * t) % 1;
        assert.equal(
          sampleSource({ kind: 'lfo', shape, rateHz: rate, depth: 1 }, t, {}),
          legacyWave(legacy, cyc),
          `${legacy} drifted at rate=${rate} t=${t}`,
        );
      }
    }
  }

  // And the whole write, end to end: base + wave·depth, clamped to the param's
  // descriptor — to a hair, since the depth is carried normalised onto the span.
  const descr = { min: 200, max: 2200, base: 900, depth: 300 };
  const t = rack('freq', descr.min, descr.max);
  const key = targetKey(t);
  for (const [legacy, shape] of Object.entries(LEGACY_TO_MOD)) {
    for (let i = 0; i <= 60; i += 1) {
      const tt = i * 0.033;
      const cyc = (2 * tt) % 1;
      const legacyV = Math.max(descr.min, Math.min(descr.max, descr.base + legacyWave(legacy, cyc) * descr.depth));
      const route: ModRoute = {
        id: 'p',
        source: { kind: 'lfo', shape, rateHz: 2, depth: normalizedDepth(descr.depth, t) },
        target: t,
        amount: 1,
        bipolar: true,
      };
      const got = applyRoutes([route], { p: sampleSource(route.source, tt, {}) }, { [key]: descr.base })[key];
      near(got, legacyV, 1e-9);
    }
  }
}

console.log('modulation.test.ts: all assertions passed');
