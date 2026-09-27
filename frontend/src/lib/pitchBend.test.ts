import assert from 'node:assert/strict';
import {
  ARP_LIVE_CHANNEL,
  BEND_CHANNELS,
  LIVE_ROLL_CHANNELS,
  MAX_BENT_LANES,
  SMOOTH_SEGMENTS,
  WHEEL_STEP_CENTS,
  bendAutomation,
  bendImportTolerance,
  bendRawToValue,
  bendStairAllowance,
  bendValueAt,
  bendValueToRaw,
  bendWheelEvents,
  capBentLanes,
  clampBendRange,
  clampBendValue,
  laneChannels,
  liveLaneChannels,
  loopedBendAutomation,
  loopedWheelEvents,
  playedRollBends,
  playingLane,
  rollRenderBends,
  sanitizeBendPoints,
  sanitizeBends,
  simplifyBend,
  unrollBend,
  wheelEventsToBendPoints,
  wheelRawStep,
  type BendPoint,
  type BendShape,
  type WheelEvent,
} from './pitchBend.ts';
import type { PolyLane } from './meterMap.ts';

const P = (step: number, value: number, shape: BendShape = 'linear', id = `p${step}`): BendPoint => ({ id, step, value, shape });
const near = (actual: number, expected: number, eps: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} is not within ${eps} of ${expected}`);
const lane = (id: number, cycleSteps: number | null = null): PolyLane => ({ id, name: String.fromCharCode(65 + id), cycleSteps });
const view = (points: readonly BendPoint[]) => points.map((p) => [p.step, p.value, p.shape]);

// Values clamp to -1..1 and ranges to 0-48 semitones to the cent; anything not a number is 0 or the default range.
{
  assert.deepEqual([clampBendValue(2), clampBendValue(-3), clampBendValue(Number.NaN), clampBendValue(0.25)], [1, -1, 0, 0.25]);
  assert.deepEqual([clampBendRange(60), clampBendRange(-1), clampBendRange(12.3456), clampBendRange(Number.NaN)], [48, 0, 12.35, 2]);
}

// Sanitizing sorts by step, keeps the later point at a step, clamps, names points without ids and drops points without a step.
{
  const clean = sanitizeBendPoints([
    { step: 8, value: 0.5 },
    { step: 2, value: 3, shape: 'hold' },
    { step: 8, value: -0.25, id: 'x' },
    { step: Number.NaN, value: 1 },
    { step: -4, value: 0.1, shape: 'wobble' as BendShape },
  ]);
  assert.deepEqual(clean, [
    { id: 'bp-4', step: 0, value: 0.1, shape: 'linear' },
    { id: 'bp-1', step: 2, value: 1, shape: 'hold' },
    { id: 'x', step: 8, value: -0.25, shape: 'linear' },
  ]);
  // One entry per lane, the later one winning; an entry with no points at the default range says nothing.
  assert.deepEqual(
    sanitizeBends([
      { lane: 1, range: 12, points: [] },
      { lane: 0, range: 2, points: [] },
      { lane: 2.5, range: 2, points: [{ id: 'q', step: 0, value: 1, shape: 'linear' }] },
      { lane: 1, range: 3, points: [{ step: 1, value: 0.5 } as BendPoint] },
    ]),
    [{ lane: 1, range: 3, points: [{ id: 'bp1-0', step: 1, value: 0.5, shape: 'linear' }] }],
  );
}

// The value at a step: 0 before the first point, a ramp, a hold that jumps at the next point, an ease, and the last value after the end.
{
  const curve = [P(4, 0.5, 'linear'), P(8, 1, 'hold'), P(12, -1, 'smooth'), P(16, 0)];
  const at = (s: number) => bendValueAt(curve, s);
  assert.deepEqual([at(0), at(3.99), at(4), at(6), at(8), at(10), at(11.999), at(12), at(16), at(99)], [0, 0, 0.5, 0.75, 1, 1, 1, -1, 0, 0]);
  near(at(13), -1 + (1 - Math.cos(Math.PI / 4)) / 2, 1e-12, 'ease a quarter of the way');
  near(at(14), -0.5, 1e-12, 'ease half way');
  assert.equal(bendValueAt([P(2, 0.75, 'linear')], 50), 0.75);
  assert.equal(bendValueAt([], 3), 0);
}

// Every 14-bit wheel position survives value and back; the ends and the centre land where MIDI puts them.
{
  for (let raw = 0; raw <= 16383; raw += 1) assert.equal(bendValueToRaw(bendRawToValue(raw)), raw);
  assert.deepEqual([bendValueToRaw(-1), bendValueToRaw(0), bendValueToRaw(1), bendValueToRaw(-0.5), bendValueToRaw(0.5)], [0, 8192, 16383, 4096, 12288]);
  assert.deepEqual([bendRawToValue(0), bendRawToValue(8192), bendRawToValue(16383), bendRawToValue(99999)], [-1, 0, 1, 1]);
  // Halves and quarters survive value to wheel and back.
  for (const v of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) assert.equal(bendRawToValue(bendValueToRaw(v)), v);
}

// Simplifying: collinear points become one ramp, a hold keeps its jump, an ease is not flattened.
{
  const dense = Array.from({ length: 33 }, (_, i) => P(i, i / 32));
  dense[32] = P(32, 1, 'hold');
  const simple = simplifyBend([...dense, P(40, 0, 'hold')]);
  assert.deepEqual(view(simple), [[0, 0, 'linear'], [32, 1, 'hold'], [40, 0, 'hold']]);
  assert.deepEqual(simple.map((p) => p.id), ['p0', 'p32', 'p40']);
  const holds = [P(0, 0.5, 'hold'), P(4, 0.5, 'hold'), P(8, -0.5, 'hold')];
  assert.deepEqual(simplifyBend(holds), holds);
  assert.deepEqual(view(simplifyBend([P(0, 0), P(2, 0.5), P(4, 1, 'hold')])), [[0, 0, 'linear'], [4, 1, 'hold']]);
  const eased = [P(0, 0, 'smooth'), P(4, 1, 'hold'), P(8, 1)];
  assert.deepEqual(simplifyBend(eased), eased);
}

// A looping lane's bend: points wrap into the cycle as notes do (the later point wins a step), repeat every cycle,
// hold to the end of each cycle and start over where the curve starts.
{
  assert.deepEqual(
    unrollBend([P(2, 0.5)], 8, 20).map((p) => [p.id, p.step, p.value, p.shape]),
    [['p2', 2, 0.5, 'hold'], ['p2~seam1', 8, 0, 'hold'], ['p2~1', 10, 0.5, 'hold'], ['p2~seam2', 16, 0, 'hold'], ['p2~2', 18, 0.5, 'linear']],
  );
  const points = [P(2, -1, 'linear'), P(6, 1, 'smooth'), P(9, 0.5, 'hold'), P(14, 0.25, 'hold')];
  const local = sanitizeBendPoints(points.map((p) => ({ ...p, step: p.step % 12 })));
  assert.deepEqual(view(local), [[2, 0.25, 'hold'], [6, 1, 'smooth'], [9, 0.5, 'hold']]);
  const unrolled = unrollBend(points, 12, 40);
  for (let s = 0; s < 40; s += 0.125) near(bendValueAt(unrolled, s), bendValueAt(local, s % 12), 1e-12, `looped step ${s}`);
  const ramp = [P(2, -1, 'linear'), P(6, 1, 'linear')];
  const rampUnrolled = unrollBend(ramp, 12, 40);
  for (let s = 0; s < 40; s += 0.125) near(bendValueAt(rampUnrolled, s), bendValueAt(ramp, s % 12), 1e-12, `looped ramp step ${s}`);
  // A lane that does not loop, or loops no shorter than the roll, keeps its points.
  assert.deepEqual(unrollBend(points, null, 40), points);
  assert.deepEqual(unrollBend(points, 40, 40), points);
  // A lane with a span counts its cycles from the span's first step and repeats them to its end:
  // the same curve as the unspanned lane, moved to start at step 16 and stopped at step 40.
  const spanned = unrollBend(points.map((p) => ({ ...p, step: p.step + 16 })), 12, 64, { start: 16, end: 40 });
  for (let s = 16; s < 40; s += 0.125) near(bendValueAt(spanned, s), bendValueAt(local, (s - 16) % 12), 1e-12, `spanned step ${s}`);
  assert.ok(spanned.every((p) => p.step >= 16 && p.step <= 40), 'no point outside the span');
  // A span shorter than the loop plays the loop's first cycle from the span's first step, as its notes do: the curve
  // inside the span is the cycle's, and nothing starts before the span. (repeatBend keeps the one point that carries
  // the curve past the end, as it does for any looping lane.)
  const short = unrollBend(points.map((p) => ({ ...p, step: p.step + 16 })), 12, 64, { start: 16, end: 24 });
  for (let s = 16; s < 24; s += 0.125) near(bendValueAt(short, s), bendValueAt(local, s - 16), 1e-12, `short span step ${s}`);
  assert.ok(short.every((p) => p.step >= 16), 'no point before the short span');
  assert.deepEqual(short.filter((p) => p.step > 24).length, 1, 'one point carries the curve past the span end');
}

// A looping lane whose ramp ends on the cycle's length ramps every cycle and starts over: a point at the cycle's end
// ends the cycle, and the wheel sends one message a step, the start of the next cycle at each seam.
{
  const ramp = [P(0, 0, 'linear'), P(12, 1, 'hold')];
  const unrolled = unrollBend(ramp, 12, 48);
  assert.deepEqual(view(unrolled), [
    [0, 0, 'linear'], [12, 1, 'hold'], [12, 0, 'linear'], [24, 1, 'hold'], [24, 0, 'linear'], [36, 1, 'hold'], [36, 0, 'linear'], [48, 1, 'hold'],
  ]);
  for (let s = 0; s < 48; s += 0.125) near(bendValueAt(unrolled, s), (s % 12) / 12, 1e-12, `cycle ramp at step ${s}`);
  assert.equal(bendValueAt(unrolled, 48), 1);
  const wheel = bendWheelEvents(unrolled, 0, 48, true);
  assert.ok(wheel.every((e, i) => i === 0 || e.step > wheel[i - 1].step), 'one message a step');
  wheel.forEach((e) => assert.ok(Math.abs(e.raw - bendValueToRaw(bendValueAt(unrolled, e.step))) <= 1, `message at ${e.step}`));
  assert.deepEqual(wheel.filter((e) => e.step % 12 === 0).map((e) => [e.step, e.raw]), [[0, 8192], [12, 8192], [24, 8192], [36, 8192], [48, 16383]]);
  // A point past the cycle still wraps into it, beside a point at the cycle's end.
  assert.deepEqual(view(unrollBend([P(0, 0), P(12, 1, 'hold'), P(18, 0.5, 'hold')], 12, 24)), [
    [0, 0, 'linear'], [6, 0.5, 'hold'], [12, 1, 'hold'], [12, 0, 'linear'], [18, 0.5, 'hold'], [24, 1, 'hold'],
  ]);
}

// The roll's played bends: only lanes the roll has and that have points. A note's lane is its own, or lane 0 when the roll has no such lane.
{
  const lanes = [lane(0), lane(1, 8)];
  const played = playedRollBends(
    [
      { lane: 0, range: 2, points: [P(1, 0.5)] },
      { lane: 1, range: 12, points: [P(2, 0.5)] },
      { lane: 2, range: 5, points: [] },
      { lane: 3, range: 2, points: [P(0, 1)] },
    ],
    lanes,
    20,
  );
  assert.deepEqual([...played.keys()], [0, 1]);
  assert.equal(played.get(1)?.range, 12);
  assert.deepEqual(played.get(1)?.points.map((p) => p.step), [2, 8, 10, 16, 18]);
  assert.deepEqual([playingLane(undefined, lanes), playingLane(1, lanes), playingLane(7, lanes)], [0, 1, 0]);
  assert.equal(rollRenderBends([{ lane: 1, range: 4, points: [] }], lanes, 20), undefined);
  assert.deepEqual([...(rollRenderBends([{ lane: 1, range: 4, points: [P(0, 1)] }], lanes, 20)?.channels ?? [])], [[0, 0], [1, 1]]);
}

// Channels: each lane with points takes the next channel, the others share the first one any of them takes; 9 is skipped.
{
  const four = [lane(0), lane(1), lane(2), lane(3)];
  const bent = (...ids: number[]) => ids.map((id) => ({ lane: id, range: 2, points: [P(0, 1)] }));
  assert.deepEqual([...laneChannels(four, bent(1, 3))], [[0, 0], [1, 1], [2, 0], [3, 2]]);
  assert.deepEqual([...laneChannels(four, bent(0))], [[0, 0], [1, 1], [2, 1], [3, 1]]);
  assert.deepEqual([...laneChannels(four, [])], [[0, 0], [1, 0], [2, 0], [3, 0]]);
  // A range with no points does not take a channel.
  assert.deepEqual([...laneChannels(four, [{ lane: 2, range: 12, points: [] }])], [[0, 0], [1, 0], [2, 0], [3, 0]]);
  // At most MAX_BENT_LANES lanes bend: the lanes past them share the next channel with the unbent, and no two groups share one.
  const many = Array.from({ length: 16 }, (_, i) => lane(i));
  const all = bent(...many.map((l) => l.id));
  const channels = laneChannels(many, all);
  assert.deepEqual([...channels.values()], [...BEND_CHANNELS.slice(0, MAX_BENT_LANES), 14, 14, 14]);
  assert.equal([...channels.values()].includes(9), false);
  assert.deepEqual([...playedRollBends(all, many, 16).keys()], many.slice(0, MAX_BENT_LANES).map((l) => l.id));
  assert.deepEqual(capBentLanes(all, many).map((b) => b.lane), many.slice(0, MAX_BENT_LANES).map((l) => l.id));
  // Live, the same groups count down from 14, clear of the drum channel and the arpeggiator's.
  const live = liveLaneChannels(many, all);
  assert.deepEqual([...live.values()], [...LIVE_ROLL_CHANNELS.slice(0, MAX_BENT_LANES), 0, 0, 0]);
  assert.equal(new Set(live.values()).size, MAX_BENT_LANES + 1);
  assert.ok(![...live.values()].some((ch) => ch === 9 || ch === ARP_LIVE_CHANNEL));
  assert.deepEqual([...liveLaneChannels(four, bent(1, 3))], [[0, 14], [1, 13], [2, 14], [3, 12]]);
  assert.deepEqual([...liveLaneChannels(four, [])], [[0, 14], [1, 14], [2, 14], [3, 14]]);
}

// Automation for a voice: a set at the start, a set at each jump, a ramp to each point a ramp reaches, an ease in pieces, and a ramp to the end inside a moving segment.
{
  const curve = [P(4, 0.5, 'linear'), P(8, 1, 'hold'), P(12, -1, 'smooth'), P(16, 0)];
  const full = bendAutomation(curve, 2, 0, 20);
  assert.deepEqual(full.slice(0, 4), [
    { step: 0, cents: 0, ramp: false },
    { step: 4, cents: 100, ramp: false },
    { step: 8, cents: 200, ramp: true },
    { step: 12, cents: -200, ramp: false },
  ]);
  const eased = full.slice(4, -1);
  assert.equal(eased.length, SMOOTH_SEGMENTS - 1);
  assert.ok(eased.every((e, i) => e.ramp && e.step === 12 + (4 * (i + 1)) / SMOOTH_SEGMENTS));
  eased.forEach((e) => near(e.cents, bendValueAt(curve, e.step) * 200, 1e-9, `eased cents at ${e.step}`));
  assert.deepEqual(full[full.length - 1], { step: 16, cents: 0, ramp: true });
  assert.equal(full.length, 20);
  // Inside a ramp: set where it is, ramp to where it will be.
  assert.deepEqual(bendAutomation(curve, 2, 5, 7), [{ step: 5, cents: 125, ramp: false }, { step: 7, cents: 175, ramp: true }]);
  // Inside a hold, and before the first point: one set.
  assert.deepEqual(bendAutomation(curve, 2, 9, 11), [{ step: 9, cents: 200, ramp: false }]);
  assert.deepEqual(bendAutomation(curve, 2, 0, 3), [{ step: 0, cents: 0, ramp: false }]);
  // Inside an ease.
  const inEase = bendAutomation(curve, 2, 13, 14);
  assert.deepEqual(inEase.map((e) => [e.step, e.ramp]), [[13, false], [13.25, true], [13.5, true], [13.75, true], [14, true]]);
  near(inEase[0].cents, (-1 + (1 - Math.cos(Math.PI / 4)) / 2) * 200, 1e-9, 'ease start');
  near(inEase[4].cents, -100, 1e-9, 'ease end');
  // The range scales the cents.
  assert.deepEqual(bendAutomation(curve, 12, 9, 10), [{ step: 9, cents: 1200, ramp: false }]);
}

// On a looping roll: a note near the end of the roll follows the curve across the loop.
{
  const played = { range: 2, points: [P(0, 0, 'linear'), P(12, 1, 'hold')] };
  const { events, originStep } = loopedBendAutomation(played, 16, 14, 4);
  assert.equal(originStep, 14);
  assert.deepEqual(events.map((e) => [e.step, e.ramp]), [[14, false], [16, false], [18, true]]);
  near(events[0].cents, 200, 1e-9, 'held at the end of the roll');
  near(events[1].cents, 0, 1e-9, 'start of the next lap');
  near(events[2].cents, (2 / 12) * 200, 1e-9, 'ramping in the next lap');
  // A note pushed early at step 0 reads the end of the previous lap.
  assert.equal(loopedBendAutomation(played, 16, -1, 1).originStep, 15);
}

// On a looping roll, a ramp that ends on the roll's end, or runs past it, keeps its course up to the loop: the voices and
// the wheel follow the curve the export and the bounce write, then the next lap starts over.
{
  const endRamp = [P(0, 0), P(16, 1, 'hold')];
  const auto = loopedBendAutomation({ range: 2, points: endRamp }, 16, 8, 8).events;
  assert.deepEqual(auto.slice(0, 2), bendAutomation(endRamp, 2, 8, 16));
  assert.deepEqual(auto.slice(2), [{ step: 16, cents: 0, ramp: false }]);
  const looped = loopedWheelEvents(endRamp, 16, 0, 16, true);
  assert.deepEqual(looped.map((e) => [e.abs, e.raw]), bendWheelEvents(endRamp, 0, 16, true).filter((e) => e.step < 16).map((e) => [e.step, e.raw]));
  assert.ok(looped.length > 60, `the wheel ramps: ${looped.length} messages`);
  assert.deepEqual(loopedWheelEvents(endRamp, 16, 0, 16.5, true).find((e) => e.abs === 16), { abs: 16, raw: 8192 });

  const cross = [P(0, 0.5, 'hold'), P(10, 1), P(20, -1, 'hold')];
  const crossAuto = loopedBendAutomation({ range: 2, points: cross }, 16, 12, 4).events;
  const unlooped = bendAutomation(cross, 2, 12, 16);
  assert.equal(crossAuto.length, 3);
  unlooped.forEach((e, i) => {
    assert.deepEqual([crossAuto[i].step, crossAuto[i].ramp], [e.step, e.ramp]);
    near(crossAuto[i].cents, e.cents, 1e-9, `crossing ramp event ${i}`);
  });
  near(crossAuto[1].cents, -40, 1e-9, 'arrives where the export curve is at the loop');
  assert.deepEqual(crossAuto[2], { step: 16, cents: 100, ramp: false });
  const crossWheel = loopedWheelEvents(cross, 16, 0, 16, true);
  assert.deepEqual(crossWheel.map((e) => [e.abs, e.raw]), bendWheelEvents(cross, 0, 16, true).filter((e) => e.step < 16).map((e) => [e.step, e.raw]));
  assert.ok(crossWheel[crossWheel.length - 1].raw < 8192, 'the wheel ramps down past the centre before the loop');
}

// Wheel messages: any cut of a span into back-to-back windows sends what one window over the span sends.
{
  const collapse = (evs: WheelEvent[]) => evs.filter((e, i) => i === 0 || e.raw !== evs[i - 1].raw);
  const curve = [P(0, 0, 'linear'), P(4, 1, 'smooth'), P(8, -1, 'hold'), P(10, 0.25, 'linear'), P(11, 0.25)];
  const full = bendWheelEvents(curve, 0, 12, true);
  const cuts = [0, 0.7, 1.3, 4, 6.01, 9, 10.5, 12];
  const pieces: WheelEvent[] = [];
  cuts.slice(1).forEach((to, i) => pieces.push(...bendWheelEvents(curve, cuts[i], to, i === 0)));
  assert.deepEqual(collapse(pieces), collapse(full));
  assert.deepEqual(full[0], { step: 0, raw: 8192 });
  assert.deepEqual(full.find((e) => e.step === 4), { step: 4, raw: 16383 });
  assert.deepEqual(full.find((e) => e.step === 8), { step: 8, raw: 0 });
  // The ramp to 4 moves at most 128 raw a message; the ease at most 128 times pi over 2.
  const upTo = (to: number) => full.filter((e) => e.step <= to);
  assert.equal(upTo(4).length, 65);
  assert.ok(upTo(4).every((e, i, a) => i === 0 || Math.abs(e.raw - a[i - 1].raw) <= 128));
  assert.ok(full.filter((e) => e.step > 4 && e.step <= 8).every((e, i, a) => i === 0 || Math.abs(e.raw - a[i - 1].raw) <= 202));
  full.forEach((e) => assert.ok(Math.abs(bendValueToRaw(bendValueAt(curve, e.step)) - e.raw) <= 1, `message at ${e.step}`));
  // One message a step, and a repeat only at a point, where it marks the step the curve may turn at (11 repeats 10).
  assert.ok(full.every((e, i) => i === 0 || (e.step > full[i - 1].step && (e.raw !== full[i - 1].raw || curve.some((p) => p.step === e.step)))));
  assert.deepEqual(full.slice(-2), [{ step: 10, raw: bendValueToRaw(0.25) }, { step: 11, raw: bendValueToRaw(0.25) }]);
}

// A ramp that starts after a flat stretch comes back within 3 cents where it starts: the point's message marks the step,
// so the import cannot start the ramp a whole stretch early.
{
  const late = [P(0, 0.5, 'hold'), P(16, 0.5, 'linear'), P(48, 1, 'hold')];
  const wheel = bendWheelEvents(late, 0, 48, true);
  assert.deepEqual(wheel.slice(0, 2), [{ step: 0, raw: 12288 }, { step: 16, raw: 12288 }]);
  const back = wheelEventsToBendPoints(wheel, 'bp', bendImportTolerance(2), bendStairAllowance(2));
  for (let s = 0; s <= 48; s += 1 / 16) assert.ok(Math.abs(bendValueAt(back, s) - bendValueAt(late, s)) <= bendImportTolerance(2) + 1 / 8192, `late ramp at step ${s}`);
  assert.ok(back.length <= 4, `late ramp points: ${JSON.stringify(view(back))}`);
}

// Wheel messages on a looping roll: each lap starts where the curve starts, and windows cut anywhere send the same messages.
{
  const curve = [P(2, 1, 'hold')];
  const full = loopedWheelEvents(curve, 8, -0.0001, 20, true);
  // A step from the end of the lap before the first (-8 + 7.9999) carries float noise.
  assert.deepEqual(full.map((e) => ({ abs: Math.round(e.abs * 1e9) / 1e9, raw: e.raw })), [
    { abs: -0.0001, raw: 16383 },
    { abs: 0, raw: 8192 },
    { abs: 2, raw: 16383 },
    { abs: 8, raw: 8192 },
    { abs: 10, raw: 16383 },
    { abs: 16, raw: 8192 },
    { abs: 18, raw: 16383 },
  ]);
  const cuts = [-0.0001, 5, 8, 16, 16.5, 20];
  const pieces = cuts.slice(1).flatMap((to, i) => loopedWheelEvents(curve, 8, cuts[i], to, i === 0));
  assert.deepEqual(pieces, full);
}

// Wheel messages back to a curve: the stairs a ramp was sent as become that ramp, holds keep their jumps, and a leading centre that starts a ramp stays.
{
  const curve = [P(0, 0, 'linear'), P(4, 1, 'hold'), P(6, -0.5, 'hold')];
  const back = wheelEventsToBendPoints(bendWheelEvents(curve, 0, 6, true));
  assert.deepEqual(view(back), view(curve));
  assert.deepEqual(back.map((p) => p.id), ['bp-0', 'bp-1', 'bp-2']);
  // A centre that only holds before the first move says nothing and is dropped; repeats are dropped.
  assert.deepEqual(
    view(wheelEventsToBendPoints([{ step: 0, raw: 8192 }, { step: 3, raw: 12288 }, { step: 4, raw: 12288 }, { step: 5, raw: 8192 }])),
    [[3, 0.5, 'hold'], [5, 0, 'hold']],
  );
}

// At any range a ramp moves about 3 cents between wheel messages, and the import keeps the curve within 3 cents of
// the messages, with the stairs back as ramps.
{
  assert.deepEqual([2, 12, 12.5, 24, 48].map((r) => wheelRawStep(r)), [128, 21, 20, 10, 5]);
  for (const range of [1, 2, 5.5, 12, 12.5, 24, 48]) {
    assert.ok((wheelRawStep(range) / 8192) * range * 100 <= WHEEL_STEP_CENTS + 1e-9, `message step at range ${range}`);
    const tolerance = bendImportTolerance(range);
    near(tolerance * range * 100, 3, 1e-9, `tolerance at range ${range}`);
    const curve = [P(0, -1, 'smooth'), P(40, 1), P(64, 0.2, 'hold')];
    const wheel = bendWheelEvents(curve, 0, 64, true, range);
    const largest = Math.max(...wheel.slice(1).map((e, i) => Math.abs(e.raw - wheel[i].raw)));
    assert.ok(largest <= wheelRawStep(range) + 1, `largest move at range ${range}: ${largest}`);
    const back = wheelEventsToBendPoints(wheel, 'bp', tolerance, bendStairAllowance(range));
    let worst = 0;
    for (let s = 0; s <= 64; s += 1 / 16) worst = Math.max(worst, Math.abs(bendValueAt(back, s) - bendValueAt(curve, s)));
    assert.ok(worst <= tolerance + 2 / 8192, `import at range ${range}: ${worst * range * 100} cents`);
    assert.ok(back.length * 4 < wheel.length, `points at range ${range}: ${back.length} for ${wheel.length} messages`);
  }
}

console.log('pitchBend: ok');
