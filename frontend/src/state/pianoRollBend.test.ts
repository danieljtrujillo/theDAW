// The roll's pitch bend actions in the order a UI calls them: points added,
// moved past each other and removed, a range set, then the meter and length
// changed, lanes added and removed, and the roll imported and loaded over.
// Undo/redo of these edits is covered separately in pianoRollHistory.test.ts.
import assert from 'node:assert/strict';
import { laneName, usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { MAX_BENT_LANES, type BendShape } from '../lib/pitchBend.ts';

const st = () => usePianoRollStore.getState();
const A = { id: 0, name: 'A', cycleSteps: null };
const B = { id: 1, name: 'B', cycleSteps: null };
const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const note = (step: number, lane?: number): PianoNote => ({ id: `n${step}`, note: 60, step, length: 2, velocity: 90, ...(lane !== undefined ? { lane } : {}) });
/** Each lane's range and points as [step, value, shape]. */
const view = () => st().bends.map((b) => ({ lane: b.lane, range: b.range, points: b.points.map((p): [number, number, BendShape] => [p.step, p.value, p.shape]) }));
const ids = (lane: number) => st().bends.find((b) => b.lane === lane)?.points.map((p) => p.id) ?? [];

// Add, replace, move past a neighbour, land on a point, reshape, set the range, remove.
{
  st().importNotes([note(0), note(4)], 120, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [A] }, []);
  assert.deepEqual(st().bends, []);
  assert.equal(st().addLane(), 1);
  // A lane the roll does not have takes no point.
  assert.equal(st().addBendPoint(5, { step: 1, value: 1 }), null);
  assert.deepEqual(st().bends, []);
  const p1 = st().addBendPoint(1, { step: 4, value: 0.5 });
  const p2 = st().addBendPoint(1, { step: 2, value: -2, shape: 'hold' });
  const p3 = st().addBendPoint(1, { step: 8, value: 1, shape: 'smooth' });
  assert.ok(p1 && p2 && p3);
  assert.deepEqual(view(), [{ lane: 1, range: 2, points: [[2, -1, 'hold'], [4, 0.5, 'linear'], [8, 1, 'smooth']] }]);
  assert.deepEqual(ids(1), [p2, p1, p3]);
  // A point added at a taken step replaces the point there.
  const p4 = st().addBendPoint(1, { step: 4, value: 0 });
  assert.ok(p4);
  assert.deepEqual(ids(1), [p2, p4, p3]);
  // Moving a point past its neighbour re-sorts the curve.
  st().moveBendPoint(1, p2, { step: 6 });
  assert.deepEqual(ids(1), [p4, p2, p3]);
  // Landing on another point's step replaces that point.
  st().moveBendPoint(1, p4, { step: 8, value: 0.25 });
  assert.deepEqual(view()[0].points, [[6, -1, 'hold'], [8, 0.25, 'linear']]);
  assert.deepEqual(ids(1), [p2, p4]);
  // A step that is not a number keeps the point where it is.
  st().moveBendPoint(1, p4, { step: Number.NaN, shape: 'hold' });
  st().moveBendPoint(1, 'missing', { step: 0 });
  assert.deepEqual(view()[0].points, [[6, -1, 'hold'], [8, 0.25, 'hold']]);
  // Ranges clamp to 0-48 semitones; a lane the roll does not have is left alone.
  st().setBendRange(1, 60);
  assert.equal(st().bends[0].range, 48);
  st().setBendRange(1, 12.5);
  st().setBendRange(7, 3);
  assert.deepEqual(st().bends.map((b) => [b.lane, b.range]), [[1, 12.5]]);
  st().removeBendPoint(1, p2);
  st().removeBendPoint(1, 'missing');
  assert.deepEqual(view(), [{ lane: 1, range: 12.5, points: [[8, 0.25, 'hold']] }]);
}

// Bends keep their steps through meter, pickup, length and tempo changes, a timing feel and a recording, as notes do.
{
  const before = st().bends;
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().setPickupSteps(3);
  st().setTotalSteps(20);
  st().applyMeter({ meterMap: [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }], pickupSteps: 0 }, false);
  st().setBpm(90);
  st().replaceAll([note(1), note(5, 1)]);
  st().placeRecording([note(2), note(6, 1)], { startStep: 0, endStep: 8 });
  assert.equal(st().bends, before);
  assert.deepEqual(view(), [{ lane: 1, range: 12.5, points: [[8, 0.25, 'hold']] }]);
}

// A lane's bend moves with its notes: removing lane B hands its notes and its bend to lane A when lane A has no points.
{
  st().replaceAll([note(0), note(4, 1)]);
  st().removeLane(1);
  assert.deepEqual(st().notes.map((n) => n.lane), [undefined, undefined]);
  assert.deepEqual(view(), [{ lane: 0, range: 12.5, points: [[8, 0.25, 'hold']] }]);
  // When lane A has points of its own, a removed lane's bend goes with the lane.
  assert.equal(st().addLane(12), 1);
  st().setBendPoints(1, [{ step: 3, value: 1 }, { step: 1, value: -1, shape: 'hold' }]);
  assert.deepEqual(view(), [
    { lane: 0, range: 12.5, points: [[8, 0.25, 'hold']] },
    { lane: 1, range: 2, points: [[1, -1, 'hold'], [3, 1, 'linear']] },
  ]);
  st().removeLane(1);
  assert.deepEqual(view(), [{ lane: 0, range: 12.5, points: [[8, 0.25, 'hold']] }]);
  // Setting the lanes drops the bends of lanes that go, and a lane that takes a freed id starts unbent.
  assert.equal(st().addLane(), 1);
  st().setBendPoints(1, [{ step: 0, value: 0.5 }]);
  st().setLanes([A]);
  assert.deepEqual(st().bends.map((b) => b.lane), [0]);
  assert.equal(st().addLane(), 1);
  assert.deepEqual(st().bends.map((b) => b.lane), [0]);
  assert.equal(st().setBendPoints(9, [{ step: 0, value: 1 }]), undefined);
  assert.deepEqual(st().bends.map((b) => b.lane), [0]);
}

// Clearing removes points and keeps ranges; CLEAR does it for every lane with the notes.
{
  st().setBendPoints(1, [{ step: 2, value: 1 }]);
  st().setBendRange(1, 5);
  st().clearBend(1);
  assert.deepEqual(view(), [{ lane: 0, range: 12.5, points: [[8, 0.25, 'hold']] }, { lane: 1, range: 5, points: [] }]);
  st().setBendPoints(1, [{ step: 2, value: 1 }]);
  st().clear();
  assert.deepEqual(st().notes, []);
  assert.deepEqual(view(), [{ lane: 0, range: 12.5, points: [] }, { lane: 1, range: 5, points: [] }]);
  // A lane back at the default range with no points has no entry.
  st().setBendRange(1, 2);
  st().setBendRange(0, 2);
  st().clearBend();
  assert.deepEqual(st().bends, []);
}

// Imports and clip loads replace the notes: bends left out clear every lane's points and keep its range
// (the importers that bring no curves: the arpeggiator, a vocal artifact, AI compose, a new virtuoso song);
// a list replaces them.
{
  const two = [
    { lane: 0, range: 5, points: [{ id: 'a', step: 0, value: 0.25, shape: 'linear' as const }] },
    { lane: 1, range: 2, points: [{ id: 'b', step: 2, value: 0.5, shape: 'linear' as const }] },
    // The roll has no lane 4.
    { lane: 4, range: 2, points: [{ id: 'c', step: 0, value: 1, shape: 'linear' as const }] },
  ];
  st().setBends(two);
  assert.deepEqual(st().bends.map((b) => b.lane), [0, 1]);
  st().importNotes([note(0), note(2, 1)], 120);
  assert.deepEqual(view(), [{ lane: 0, range: 5, points: [] }]);
  st().setBends(two);
  st().importNotes([note(0)], 120, { lanes: [A] });
  assert.deepEqual(view(), [{ lane: 0, range: 5, points: [] }]);
  st().importNotes([note(0), note(1, 1)], 110, { lanes: [A, B] }, [
    { lane: 1, range: 3, points: [{ id: 'x', step: 1, value: 1, shape: 'hold' }] },
    { lane: 4, range: 2, points: [{ id: 'y', step: 0, value: 1, shape: 'linear' }] },
  ]);
  assert.deepEqual(st().bends, [{ lane: 1, range: 3, points: [{ id: 'x', step: 1, value: 1, shape: 'hold' }] }]);
  st().loadFromClip('c1', [note(0)], 120, 16);
  assert.deepEqual(view(), [{ lane: 1, range: 3, points: [] }]);
  st().loadFromClip('c1', [note(0)], 120, 16, undefined, []);
  assert.deepEqual(st().bends, []);
  // An empty import follows the rule too.
  st().setBends([{ lane: 0, range: 2, points: [{ id: 'z', step: 0, value: 0.5, shape: 'linear' }] }]);
  st().importNotes([], 120);
  assert.deepEqual(st().bends, []);
}

// Lanes set through the meter (MATCH, and the METER face's ADD LANE): a lane that goes takes its bend,
// a lane that arrives starts unbent even when a bend for its id is still about, and a loop change keeps the bends.
{
  st().setLanes([A, B]);
  st().setBends([]);
  assert.ok(st().addBendPoint(1, { step: 4, value: 0.5 }));
  const kept = st().bends;
  st().applyMeter({ lanes: [A, { ...B, cycleSteps: 8 }] });
  assert.equal(st().bends, kept);
  st().applyMeter({ lanes: [A] });
  assert.deepEqual(st().bends, []);
  usePianoRollStore.setState({ bends: [{ lane: 1, range: 7, points: [{ id: 'old', step: 0, value: 1, shape: 'hold' }] }] });
  st().applyMeter({ lanes: [A, B] });
  assert.deepEqual(st().bends, []);
}

// At most MAX_BENT_LANES lanes bend: a further lane takes no points, a bent lane keeps taking them, a range needs no
// channel, a list past the cap loses the later lanes' points, and a lane that stops bending frees its place.
{
  const lanes = Array.from({ length: MAX_BENT_LANES + 3 }, (_, id) => ({ id, name: laneName(id), cycleSteps: null }));
  st().setLanes(lanes);
  st().setBends([]);
  for (let id = 0; id < MAX_BENT_LANES; id += 1) assert.ok(st().addBendPoint(id, { step: 0, value: 0.5 }), `lane ${id} bends`);
  assert.equal(st().addBendPoint(MAX_BENT_LANES, { step: 0, value: 0.5 }), null);
  st().setBendPoints(MAX_BENT_LANES + 1, [{ step: 1, value: 1 }]);
  assert.equal(st().bends.filter((b) => b.points.length).length, MAX_BENT_LANES);
  assert.ok(st().addBendPoint(0, { step: 4, value: -1 }));
  st().setBendRange(MAX_BENT_LANES, 12);
  assert.deepEqual(st().bends.find((b) => b.lane === MAX_BENT_LANES), { lane: MAX_BENT_LANES, range: 12, points: [] });
  st().setBends(lanes.map((l) => ({ lane: l.id, range: 2, points: [{ id: `q${l.id}`, step: 0, value: 1, shape: 'hold' as const }] })));
  assert.deepEqual(st().bends.map((b) => b.lane), lanes.slice(0, MAX_BENT_LANES).map((l) => l.id));
  st().clearBend(0);
  assert.ok(st().addBendPoint(MAX_BENT_LANES, { step: 0, value: 0.5 }));
  st().setLanes([A]);
}

console.log('pianoRollBend: ok');
