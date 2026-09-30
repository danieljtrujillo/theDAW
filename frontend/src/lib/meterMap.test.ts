import assert from 'node:assert/strict';
import {
  barAt, barLines, bars, barStartStep, beatLines, gridLines, groupLines, lanesRealign, meterFromAnalysis,
  meterMapToMidiEvents, midiEventsToMeterMap, normalizeMeterMap, removeChangeAt, roundUpToBar, segmentBars,
  setMeterAt, stepsAsMeter, stepsPerBar, takeBarsFrom, unrollLanes, type MeterSegment,
} from './meterMap.ts';

const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M516 = { num: 5, den: 16, groups: [] };
// Two bars of 4/4, one of 7/8 3+2+2, then 5/16 from bar 3 on.
const MAP: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 3, meter: M516 }];

// Steps per bar.
{
  assert.equal(stepsPerBar(M44), 16);
  assert.equal(stepsPerBar(M78), 14);
  assert.equal(stepsPerBar(M516), 5);
  assert.equal(stepsPerBar({ num: 7, den: 32, groups: [] }), 3.5);
}

// Bar lines, with and without a pickup.
{
  assert.deepEqual(barLines(MAP, 60), [0, 16, 32, 46, 51, 56]);
  assert.deepEqual(barLines(MAP, 60, 4), [0, 4, 20, 36, 50, 55]);
  assert.equal(barStartStep(MAP, 3), 46);
  assert.equal(barStartStep(MAP, 5, 4), 60);
  assert.equal(barStartStep(MAP, -1, 4), 0);
  assert.deepEqual(bars(MAP, 20, 4).map((b) => [b.bar, b.start, b.len]), [[-1, 0, 4], [0, 4, 16]]);
}

// Round up to a bar line.
{
  assert.equal(roundUpToBar(MAP, 0), 0);
  assert.equal(roundUpToBar(MAP, 32), 32);
  assert.equal(roundUpToBar(MAP, 33), 46);
  assert.equal(roundUpToBar(MAP, 47), 51);
  assert.equal(roundUpToBar(MAP, 2, 4), 4);
}

// Group and beat lines inside a bar.
{
  assert.deepEqual(groupLines(M78), [0, 6, 10]);
  assert.deepEqual(beatLines(M78), [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(groupLines(M44), [0]);
  const g = gridLines(MAP, 51);
  assert.deepEqual(g.bar, [0, 16, 32, 46, 51]);
  assert.deepEqual(g.group, [38, 42]);
  assert.ok(g.beat.includes(4) && g.beat.includes(34) && !g.beat.includes(38));
}

// A fractional step lands in its bar.
{
  const b = barAt(MAP, 46.5);
  assert.deepEqual([b.bar, b.start, b.len], [3, 46, 5]);
  const half = barAt([{ bar: 0, meter: { num: 7, den: 32, groups: [] } }], 7.2);
  assert.deepEqual([half.bar, half.start, half.len], [2, 7, 3.5]);
  assert.equal(barAt(MAP, 2, 4).bar, -1);
}

// Editing the map: changes merge with an equal meter before them.
{
  let map = setMeterAt([{ bar: 0, meter: M44 }], 1, M44);
  assert.equal(map.length, 1);
  map = setMeterAt(map, 2, M78);
  map = setMeterAt(map, 3, M44);
  assert.deepEqual(map.map((s) => s.bar), [0, 2, 3]);
  map = removeChangeAt(map, 2);
  assert.deepEqual(map.map((s) => s.bar), [0]);
  assert.deepEqual(setMeterAt([{ bar: 0, meter: M44 }], 4, M44, false).map((s) => s.bar), [0, 4]);
  assert.deepEqual(segmentBars(MAP, 1, 60), { first: 2, last: 2 });
  assert.deepEqual(segmentBars(MAP, 2, 60), { first: 3, last: 5 });
  assert.deepEqual(normalizeMeterMap([{ bar: 3, meter: M78 }]), [{ bar: 0, meter: M78 }]);
  assert.deepEqual(normalizeMeterMap([{ bar: 0, meter: { num: 7, den: 8, groups: [3, 3] } }])[0].meter.groups, []);
}

// MIDI time signature events round-trip, pickup included.
{
  assert.deepEqual(stepsAsMeter(4), { num: 1, den: 4, groups: [] });
  assert.deepEqual(stepsAsMeter(6), { num: 3, den: 8, groups: [] });
  assert.deepEqual(stepsAsMeter(3), { num: 3, den: 16, groups: [] });
  assert.deepEqual(stepsAsMeter(1.5), { num: 3, den: 32, groups: [] });
  const events = meterMapToMidiEvents(MAP, 96, 4);
  assert.deepEqual(events.map((e) => [e.tick, e.num, e.den]), [[0, 1, 4], [96, 4, 4], [864, 7, 8], [1200, 5, 16]]);
  const back = midiEventsToMeterMap(events, 96);
  assert.equal(back.pickupSteps, 4);
  assert.deepEqual(back.map, MAP);
  const plain = midiEventsToMeterMap([{ tick: 0, num: 4, den: 4 }, { tick: 96 * 8, num: 7, den: 8 }], 96);
  assert.deepEqual(plain, { map: [{ bar: 0, meter: M44 }, { bar: 2, meter: { num: 7, den: 8, groups: [] } }], pickupSteps: 0 });
  assert.deepEqual(midiEventsToMeterMap([{ tick: 96 * 4, num: 3, den: 4 }], 96).map.map((s) => s.bar), [0, 1]);
  assert.deepEqual(midiEventsToMeterMap([], 96), { map: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
}

// The pickup the tick-0 event carries is read before the guess; events from another app keep the guess.
{
  const M24 = { num: 2, den: 4, groups: [] };
  const M78e = { num: 7, den: 8, groups: [] };
  const noMark = (events: ReturnType<typeof meterMapToMidiEvents>) => events.map(({ pickupSteps: _drop, ...e }) => e);

  // A 2/4 bar, then 4/4: no pickup, though the first bar is short enough to look like one.
  const short = meterMapToMidiEvents([{ bar: 0, meter: M24 }, { bar: 1, meter: M44 }], 480, 0);
  assert.equal(short[0].pickupSteps, 0);
  assert.deepEqual(midiEventsToMeterMap(short, 480), { map: [{ bar: 0, meter: M24 }, { bar: 1, meter: M44 }], pickupSteps: 0 });
  assert.deepEqual(midiEventsToMeterMap(noMark(short), 480), { map: [{ bar: 0, meter: M44 }], pickupSteps: 8 });

  // 7/8 after a 20-step pickup, whose partial bar (5/4) is longer than a 7/8 bar.
  const long = meterMapToMidiEvents([{ bar: 0, meter: M78e }], 480, 20);
  assert.deepEqual(long.map((e) => [e.tick, e.num, e.den, e.pickupSteps]), [[0, 5, 4, 20], [2400, 7, 8, undefined]]);
  assert.deepEqual(midiEventsToMeterMap(long, 480), { map: [{ bar: 0, meter: M78e }], pickupSteps: 20 });
  assert.deepEqual(midiEventsToMeterMap(noMark(long), 480), { map: [{ bar: 0, meter: { num: 5, den: 4, groups: [] } }, { bar: 1, meter: M78e }], pickupSteps: 0 });

  // A mark the signatures contradict (no change where bar 1 would start) falls back to the guess.
  assert.deepEqual(midiEventsToMeterMap([{ tick: 0, num: 4, den: 4, pickupSteps: 6 }], 480), { map: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
}

// A song base takes the old base's meter on the bars a section meter owned.
{
  const M34 = { num: 3, den: 4, groups: [] };
  const rollMap: MeterSegment[] = [{ bar: 0, meter: M78 }, { bar: 4, meter: M34 }];
  assert.deepEqual(takeBarsFrom(rollMap, [{ bar: 0, meter: M44 }], [0, 1, 2, 3]), [{ bar: 0, meter: M44 }, { bar: 4, meter: M34 }]);
  assert.deepEqual(takeBarsFrom(rollMap, [{ bar: 0, meter: M44 }], []), rollMap);
  assert.deepEqual(takeBarsFrom([{ bar: 0, meter: M34 }], MAP, [2, 5]), [{ bar: 0, meter: M34 }, { bar: 2, meter: M78 }, { bar: 3, meter: M34 }, { bar: 5, meter: M516 }, { bar: 6, meter: M34 }]);
}

// Compound meters from the rhythm engine scale their grouping to the numerator.
{
  assert.deepEqual(meterFromAnalysis({ numerator: 6, denominator: 8, grouping: [1, 1], beats_per_bar: 2 }), { num: 6, den: 8, groups: [3, 3] });
  assert.deepEqual(meterFromAnalysis({ numerator: 7, denominator: 8, grouping: [3, 2, 2], beats_per_bar: 7 }), M78);
  assert.deepEqual(meterFromAnalysis({ numerator: 4, denominator: 4, grouping: [4] }), M44);
  assert.equal(meterFromAnalysis({ numerator: 0 }), null);
}

// A 12-step lane against a 60-step roll repeats, and realigns with a 16-step lane at 48.
{
  const lanes = [{ id: 1, name: 'Bass', cycleSteps: 12 }, { id: 2, name: 'Bell', cycleSteps: 16 }];
  const notes = [
    { id: 'a', note: 48, step: 0, length: 2, velocity: 90, lane: 1 },
    { id: 'b', note: 59, step: 18, length: 1, velocity: 90, lane: 2 },
    { id: 'c', note: 60, step: 5, length: 8, velocity: 90 },
  ];
  const out = unrollLanes(notes, lanes, 60);
  assert.deepEqual(out.filter((n) => n.lane === 1).map((n) => n.step), [0, 12, 24, 36, 48]);
  assert.deepEqual(out.filter((n) => n.lane === 2).map((n) => n.step), [2, 18, 34, 50]);
  assert.deepEqual(out.filter((n) => n.id === 'c').map((n) => n.step), [5]);
  assert.equal(out.find((n) => n.id === 'a~4')?.step, 48);
  assert.equal(lanesRealign(lanes), 48);
  assert.equal(lanesRealign([{ id: 1, name: 'x', cycleSteps: null }]), null);
  const clipped = unrollLanes([{ id: 'd', note: 50, step: 10, length: 8, velocity: 90, lane: 1 }], lanes, 30);
  assert.deepEqual(clipped.map((n) => [n.step, n.length]), [[10, 8], [22, 8]]);
}

// A repeat carries its OWN ticks, not the ticks of the note it came from: it is
// a whole number of cycles away, so the arithmetic is exact. A note built
// without ticks stays without them rather than being given a grid it never had.
{
  const lanes = [{ id: 1, name: 'B', cycleSteps: 8 }];
  const per = 240; // the roll's 16ths at PPQ 960 — the notes below carry it themselves

  // On the grid: step 1 -> tick 240, and each repeat is 8 steps = 1920 ticks on.
  const onGrid = unrollLanes([{ id: 'g', note: 48, step: 1, length: 2, velocity: 90, lane: 1, tick: 240, ticks: 480 }], lanes, 32);
  assert.deepEqual(onGrid.map((n) => [n.step, n.tick]), [[1, 240], [9, 2160], [17, 4080], [25, 6000]]);
  assert.deepEqual([...new Set(onGrid.map((n) => n.ticks))], [480]);
  for (const n of onGrid) assert.equal(n.tick, Math.round(n.step * per), `${n.id} tick vs step`);

  // Off the grid: a swung note keeps its 5-tick offset in every pass.
  const swung = unrollLanes([{ id: 's', note: 50, step: 605 / per, length: 60 / per, velocity: 90, lane: 1, tick: 605, ticks: 60 }], lanes, 24);
  assert.deepEqual(swung.map((n) => n.tick), [605, 2525, 4445]);
  assert.deepEqual([...new Set(swung.map((n) => n.ticks))], [60]);

  // A note placed past its lane's first cycle wraps, and its ticks wrap with it.
  const wrapped = unrollLanes([{ id: 'w', note: 52, step: 10, length: 1, velocity: 90, lane: 1, tick: 2400, ticks: 240 }], lanes, 24);
  assert.deepEqual(wrapped.map((n) => [n.step, n.tick]), [[2, 480], [10, 2400], [18, 4320]]);

  // A tail clipped by the roll's end loses the same ticks it loses steps.
  const clipped = unrollLanes([{ id: 'c', note: 54, step: 2, length: 8, velocity: 90, lane: 1, tick: 480, ticks: 1920 }], lanes, 12);
  assert.deepEqual(clipped.map((n) => [n.step, n.length, n.ticks]), [[2, 8, 1920], [10, 2, 480]]);

  // No ticks in, no ticks out — helpers that predate the tick model are untouched.
  const bare = unrollLanes([{ id: 'b', note: 56, step: 1, length: 1, velocity: 90, lane: 1 }], lanes, 24);
  assert.deepEqual(bare.map((n) => n.step), [1, 9, 17]);
  assert.equal(bare.some((n) => 'tick' in n || 'ticks' in n), false);

  // A note that does not repeat is handed back as the very same object.
  const [passed] = unrollLanes([{ id: 'p', note: 60, step: 3, length: 1, velocity: 90, tick: 720, ticks: 240 }], lanes, 24);
  assert.deepEqual([passed.step, passed.tick, passed.ticks], [3, 720, 240]);
}

console.log('meterMap: ok');
