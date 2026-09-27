import assert from 'node:assert/strict';
import { genWrite, type GenSettings } from '../lib/meterFace.ts';
import { GEN_DEFAULT_OPTS } from '../lib/loomGen.ts';
import { unrollLanes } from '../lib/meterMap.ts';
import { feelLength, quantizeRollClip } from '../lib/rollClip.ts';
import { swingToGroove } from '../lib/grooveTemplate.ts';
import {
  DEFAULT_GROOVE_ID,
  MIN_NOTE_LENGTH,
  MIN_NOTE_STEPS,
  MIN_NOTE_TICKS,
  PPQ,
  ROLL_STEPS_PER_BEAT,
  laneName,
  migrateNotes,
  noteTick,
  noteTicks,
  rollMeterOf,
  sanitizeLanes,
  stepOfTick,
  tickOfStep,
  ticksPerStep,
  usePianoRollStore,
  withTicks,
  type PianoNote,
} from './pianoRollStore.ts';

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M54 = { num: 5, den: 4, groups: [2, 3] };
const M44 = { num: 4, den: 4, groups: [] };
const note = (step: number, length = 2, lane?: number) => ({ id: `n${step}`, note: 60, step, length, velocity: 90, ...(lane !== undefined ? { lane } : {}) });
const st = () => usePianoRollStore.getState();

// A 7/8 roll keeps its meter through an import that brings none, and fits to its bar lines.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().importNotes([note(0), note(18)]);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.equal(st().totalSteps, 28);
}

// An import that brings a meter replaces it; the pickup shifts the bar lines.
{
  st().importNotes([note(0), note(20)], 100, { meterMap: [{ bar: 0, meter: M54 }], pickupSteps: 4 });
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M54 }]);
  assert.equal(st().pickupSteps, 4);
  assert.equal(st().totalSteps, 24);
  assert.equal(st().bpm, 100);
}

// Lanes: add, draw into the active one, loop length, removal moves notes to lane 0.
{
  st().replaceAll([]);
  const b = st().addLane(12);
  assert.equal(b, 1);
  assert.deepEqual(st().lanes.map((l) => [l.id, l.name, l.cycleSteps]), [[0, 'A', null], [1, 'B', 12]]);
  st().setActiveLane(1);
  const id = st().addNote({ note: 48, step: 3, length: 2, velocity: 100 });
  assert.equal(st().notes.find((n) => n.id === id)?.lane, 1);
  st().setActiveLane(0);
  const a = st().addNote({ note: 60, step: 0, length: 2, velocity: 100 });
  assert.equal('lane' in (st().notes.find((n) => n.id === a) ?? {}), false);
  st().setLaneCycle(1, 10.4);
  st().setLaneCycle(0, 8);
  assert.deepEqual(st().lanes.map((l) => l.cycleSteps), [null, 10]);
  st().setActiveLane(1);
  st().removeLane(1);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
  assert.equal(st().activeLane, 0);
  assert.equal(st().notes.find((n) => n.id === id)?.lane, undefined);
  st().removeLane(0);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
}

// Sequence: a clip loaded with no meter keeps the roll's; a clip with one restores it, lanes included.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().setPickupSteps(0);
  st().loadFromClip('c1', [note(0)], 120, 32);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.equal(st().editingClipId, 'c1');
  // A 32-step clip in 7/8 ends on the next bar line; a short import never ends mid-bar.
  assert.equal(st().totalSteps, 42);
  st().importNotes([note(0, 1)]);
  assert.equal(st().totalSteps, 28);
  const saved = rollMeterOf(st());
  st().loadFromClip('c2', [note(0, 2, 2)], 120, 16, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [{ id: 2, name: 'C', cycleSteps: 6 }] });
  assert.deepEqual(st().lanes.map((l) => [l.id, l.cycleSteps]), [[0, null], [2, 6]]);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }]);
  st().loadFromClip('c1', [note(0)], 120, 32, saved);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.deepEqual(st().lanes.map((l) => l.id), [0]);
}

// A recording rounds the grid up to a bar line of the meter.
{
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  st().setTotalSteps(256);
  st().placeRecording([note(4)], { startStep: 0, endStep: 8 });
  assert.equal(st().totalSteps, 266);
}

// Meter writes and length edits end the roll on a bar line; a merge-free write keeps a repeated meter.
{
  st().applyMeter({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
  st().setTotalSteps(256);
  assert.equal(st().totalSteps, 256);
  st().setMeterMap([{ bar: 0, meter: M54 }]);
  assert.equal(st().totalSteps, 260);
  st().setPickupSteps(2);
  assert.equal(st().totalSteps, 262);
  st().applyMeter({ meterMap: [{ bar: 0, meter: M44 }, { bar: 2, meter: M44 }] }, false);
  assert.deepEqual(st().meterMap.map((s) => s.bar), [0, 2]);
  st().setTotalSteps(20);
  assert.equal(st().totalSteps, 34);
}

// Lane names and sanitizing.
{
  assert.deepEqual([laneName(0), laneName(1), laneName(25), laneName(26), laneName(27)], ['A', 'B', 'Z', 'AA', 'AB']);
  assert.deepEqual(sanitizeLanes([{ id: 3, name: '', cycleSteps: 0 }, { id: 3, name: 'dup', cycleSteps: 4 }, { id: 0, name: 'Keys', cycleSteps: 9 }]), [
    { id: 0, name: 'Keys', cycleSteps: null },
    { id: 3, name: 'D', cycleSteps: null },
  ]);
}

// ── Multi-selection ──────────────────────────────────────────────────────────

const ids = () => [...st().selectedIds];
const fill = (...steps: number[]) => {
  st().importNotes(steps.map((s) => note(s)));
  st().setTotalSteps(256);
};

// A selection is a set, and `selectedNoteId` is its primary — the newest id in
// it — never written on its own.
{
  fill(0, 4, 8);
  assert.deepEqual(ids(), [], 'an import starts with nothing selected');
  assert.equal(st().selectedNoteId, null);

  st().setSelection(['n0', 'n8']);
  assert.deepEqual(ids(), ['n0', 'n8']);
  assert.equal(st().selectedNoteId, 'n8', 'the newest id is primary');
  st().setSelection(['n0', 'n8'], 'n0');
  assert.equal(st().selectedNoteId, 'n0', 'an explicit primary wins');
  st().setSelection(['n0', 'n8'], 'nope');
  assert.equal(st().selectedNoteId, 'n8', 'a primary that is not in the set falls back to the newest');

  // Ids with no note are dropped, so a stale id can never sit in the selection.
  st().setSelection(['n0', 'ghost', 'n4']);
  assert.deepEqual(ids(), ['n0', 'n4']);

  st().addToSelection(['n8']);
  assert.deepEqual(ids(), ['n0', 'n4', 'n8']);
  assert.equal(st().selectedNoteId, 'n8');
  st().addToSelection(['n0']);
  assert.deepEqual(ids(), ['n0', 'n4', 'n8'], 'a note already in keeps its place');

  st().toggleSelection('n4');
  assert.deepEqual(ids(), ['n0', 'n8']);
  st().toggleSelection('n4');
  assert.deepEqual(ids(), ['n0', 'n8', 'n4']);
  assert.equal(st().selectedNoteId, 'n4', 'a note toggled in becomes primary');
  st().toggleSelection('n4');
  assert.equal(st().selectedNoteId, 'n8', 'and toggling the primary out hands the slot back');

  st().selectAll();
  assert.deepEqual(ids(), ['n0', 'n4', 'n8']);
  st().clearSelection();
  assert.deepEqual(ids(), []);
  assert.equal(st().selectedNoteId, null);

  // The one-note setter is still the one-note form of the same thing.
  st().setSelectedNote('n4');
  assert.deepEqual(ids(), ['n4']);
  assert.equal(st().selectedNoteId, 'n4');
  st().setSelectedNote(null);
  assert.deepEqual(ids(), []);
}

// Every way notes leave takes the selection with them.
{
  fill(0, 4, 8);
  st().setSelection(['n0', 'n4', 'n8']);
  st().removeNote('n4');
  assert.deepEqual(ids(), ['n0', 'n8'], 'a removed note leaves the selection');
  st().removeNote('n8');
  assert.equal(st().selectedNoteId, 'n0', 'and the primary moves to what is left');

  st().setSelection(['n0']);
  st().replaceAll([note(0), note(4)]);
  assert.deepEqual(ids(), [], 'replaceAll');

  st().setSelection(['n0']);
  st().clear();
  assert.deepEqual(ids(), [], 'clear');

  fill(0, 4);
  st().setSelection(['n0']);
  st().loadFromClip('c9', [note(0)], 120, 32);
  assert.deepEqual(ids(), [], 'loadFromClip');

  st().setSelection(['n0']);
  st().placeRecording([note(0)], { startStep: 0, endStep: 4 });
  assert.deepEqual(ids(), [], 'placeRecording');

  st().setSelection(['n0']);
  st().importNotes([note(0)]);
  assert.deepEqual(ids(), [], 'importNotes');
  st().importNotes([]);
  assert.deepEqual(ids(), [], 'an import of nothing');

  // A note drawn is the whole selection.
  const drawn = st().addNote({ note: 62, step: 3, length: 2, velocity: 100 });
  assert.deepEqual(ids(), [drawn]);
}

// Nudging moves the selection as one block and stops at the walls; the delta is
// clamped in its direction of travel only, so notes keep their shape.
{
  st().importNotes([note(0), note(4)]);
  st().setTotalSteps(64);
  st().setRange(21, 108);
  st().setSelection(['n0', 'n4']);

  st().nudgeSelected(2, 0);
  assert.deepEqual(st().notes.map((n) => n.step), [2, 6], 'both move by the same amount');
  st().nudgeSelected(-2, 0);
  assert.deepEqual(st().notes.map((n) => n.step), [0, 4]);
  st().nudgeSelected(-1, 0);
  assert.deepEqual(st().notes.map((n) => n.step), [0, 4], 'a block against the left edge does not move at all');

  st().nudgeSelected(0, 12);
  assert.deepEqual(st().notes.map((n) => n.note), [72, 72]);
  st().nudgeSelected(0, -12);
  assert.deepEqual(st().notes.map((n) => n.note), [60, 60]);

  // Against the ceiling: the whole block stops rather than piling up on it.
  st().setSelection(['n0']);
  st().nudgeSelected(0, 100);
  assert.equal(st().notes[0].note, 108, 'clamped to the roll range');
  st().setSelection(['n0', 'n4']);
  st().nudgeSelected(0, 1);
  assert.deepEqual(st().notes.map((n) => n.note), [108, 60], 'the block is blocked by its highest note');

  // A note that is already out of range can still come back inside.
  st().replaceAll([{ id: 'low', note: 4, step: 0, length: 2, velocity: 90 }]);
  st().setRange(21, 108);
  st().setSelection(['low']);
  st().nudgeSelected(0, -1);
  assert.equal(st().notes[0].note, 4, 'no further out');
  st().nudgeSelected(0, 3);
  assert.equal(st().notes[0].note, 7, 'but back toward the range');

  // A fractional nudge keeps its fraction (micro-timing), and the right edge holds.
  st().replaceAll([note(0)]);
  st().setTotalSteps(16);
  st().setSelection(['n0']);
  st().nudgeSelected(0.25, 0);
  assert.equal(st().notes[0].step, 0.25);
  st().nudgeSelected(1000, 0);
  assert.equal(st().notes[0].step, st().totalSteps - 1, 'the last step is the wall');

  // Nothing selected, nothing moves; and a garbage delta is a no-op.
  const before = st().notes;
  st().clearSelection();
  st().nudgeSelected(1, 1);
  assert.equal(st().notes, before, 'the same array, so no undo step either');
  st().setSelection(['n0']);
  st().nudgeSelected(Number.NaN, Number.NaN);
  assert.equal(st().notes, before);
}

// Velocity: set and scale, both clamped to a playable 1-127.
{
  st().importNotes([note(0), note(4)]);
  st().setSelection(['n0', 'n4']);
  st().setVelocity(st().selectedIds, 40);
  assert.deepEqual(st().notes.map((n) => n.velocity), [40, 40]);
  st().setVelocity(['n0'], 500);
  assert.equal(st().notes[0].velocity, 127, 'over the top clamps to 127');
  st().setVelocity(['n0'], 0);
  assert.equal(st().notes[0].velocity, 1, 'and 0 is a note-off, so the floor is 1');
  st().setVelocity(['n4'], 63.6);
  assert.equal(st().notes[1].velocity, 64, 'velocities are whole');

  st().setVelocity(['n0', 'n4'], 100);
  st().scaleVelocity(['n0', 'n4'], 0.5);
  assert.deepEqual(st().notes.map((n) => n.velocity), [50, 50]);
  st().scaleVelocity(['n0'], 0);
  assert.equal(st().notes[0].velocity, 1, 'scaling to nothing still leaves a note');
  st().scaleVelocity(['n4'], 99);
  assert.equal(st().notes[1].velocity, 127);

  // A write that changes nothing keeps the same array, so it records no undo step.
  const same = st().notes;
  st().setVelocity(['n4'], 127);
  assert.equal(st().notes, same);
  st().scaleVelocity(['n4'], 1);
  assert.equal(st().notes, same);
  st().setVelocity([], 10);
  assert.equal(st().notes, same);
}

// addNote / updateNote validate: MIDI note and velocity in range and whole, no
// negative start, no zero length (the floor is one tick) — and a patched id is ignored.
{
  st().importNotes([note(0)]);
  const id = st().addNote({ note: 300.4, step: -5, length: 0, velocity: 999 });
  const added = () => st().notes.find((n) => n.id === id)!;
  assert.deepEqual(
    { note: added().note, step: added().step, length: added().length, ticks: added().ticks, velocity: added().velocity },
    { note: 127, step: 0, length: MIN_NOTE_STEPS, ticks: MIN_NOTE_TICKS, velocity: 127 },
  );
  st().updateNote(id, { note: -3, velocity: -1, length: -9, step: -2 });
  assert.deepEqual(
    { note: added().note, step: added().step, length: added().length, ticks: added().ticks, velocity: added().velocity },
    { note: 0, step: 0, length: MIN_NOTE_STEPS, ticks: MIN_NOTE_TICKS, velocity: 1 },
  );
  // A length that is not a number at all is one step.
  st().updateNote(id, { length: Number.NaN });
  assert.equal(added().length, MIN_NOTE_LENGTH);
  // A sub-step length stays what it was: a 32nd, a 16th triplet.
  st().updateNote(id, { length: 0.5 });
  assert.deepEqual([added().length, added().ticks], [0.5, 120]);
  st().updateNote(id, { length: 2 / 3 });
  assert.equal(added().ticks, 160);
  // A fractional STEP survives on purpose: swing and micro-timing live there.
  st().updateNote(id, { step: 3.5 });
  assert.equal(added().step, 3.5);
  // A note number is whole even when the caller had a fraction.
  st().updateNote(id, { note: 60.7 });
  assert.equal(added().note, 61);
  // The id in a patch is dropped: two notes with one id would break selection.
  st().updateNote(id, { id: 'n0', velocity: 70 } as Partial<PianoNote>);
  assert.equal(added().velocity, 70);
  assert.deepEqual(st().notes.map((n) => n.id).sort(), ['n0', id].sort());
}

// The timing feel lives on the roll, clamped, and survives a clip load.
{
  assert.equal(st().quantizePct, 100, 'the default is dead on the grid');
  assert.equal(st().swingPct, 0);
  st().setQuantizePct(63.4);
  st().setSwingPct(-12);
  assert.equal(st().quantizePct, 63);
  assert.equal(st().swingPct, -12);
  st().setQuantizePct(500);
  st().setSwingPct(500);
  assert.deepEqual([st().quantizePct, st().swingPct], [100, 50]);
  st().setQuantizePct(-500);
  st().setSwingPct(-500);
  assert.deepEqual([st().quantizePct, st().swingPct], [0, -50]);
  st().setSwingPct(Number.NaN);
  assert.equal(st().swingPct, 0, 'garbage falls back to the default');
  st().setQuantizePct(80);
  st().setSwingPct(20);
  st().loadFromClip('c-feel', [note(0)], 120, 32);
  assert.deepEqual([st().quantizePct, st().swingPct], [80, 20], 'a clip load leaves the feel alone');
  st().clear();
  assert.deepEqual([st().quantizePct, st().swingPct], [80, 20], 'and so does CLEAR');
}

// Undo and redo re-derive the selection: a step that takes notes away takes
// their ids with them, so a dead id can never survive into the next copy,
// nudge or delete.
{
  fill(0, 4);
  st().setSelection(['n0', 'n4']);
  const added = st().addNote({ note: 67, step: 8, length: 2, velocity: 90 });
  assert.deepEqual(ids(), [added], 'the new note is the selection');
  st().undo();
  assert.deepEqual(ids(), [], 'undo takes the note, and its id, out of the selection');
  assert.equal(st().selectedNoteId, null);
  st().redo();
  assert.deepEqual(ids(), [], 'redo brings the note back but not the selection it had');

  // A selection of notes that SURVIVE the step is kept whole.
  st().setSelection(['n0', 'n4']);
  st().updateNote('n0', { velocity: 50 });
  st().undo();
  assert.deepEqual(ids(), ['n0', 'n4'], 'a step that keeps every note keeps the selection');
  assert.equal(st().selectedNoteId, 'n4', 'primary included');

  // A step that removes only SOME of the selection keeps the rest.
  st().setSelection(['n0', 'n4', added]);
  assert.equal(st().selectedIds.size, 3);
  st().replaceAll(st().notes.filter((n) => n.id !== added));
  st().setSelection(['n0', 'n4']);
  st().redo();
  assert.ok(!st().selectedIds.has(added), 'a note the step does not have is not selected');
}

// The selection Set is REPLACED on every write that changes it, never mutated
// in place: a zustand subscriber compares by reference, so an in-place mutation
// would leave the roll drawing a stale selection. A write that changes NOTHING
// deliberately hands back the same Set, so it wakes no subscriber.
{
  fill(0, 4, 8);
  /** Run a write, and prove the Set it produced is new and the old one intact. */
  const changes = (what: string, write: () => void, expected: string[] | (() => string[])) => {
    const before = st().selectedIds;
    const frozen = [...before];
    write();
    const after = st().selectedIds;
    assert.notEqual(after, before, `${what}: handed back the same Set instead of a new one`);
    assert.deepEqual([...before], frozen, `${what}: mutated the previous Set in place`);
    assert.deepEqual([...after], typeof expected === 'function' ? expected() : expected, `${what}: contents`);
  };
  changes('setSelection', () => st().setSelection(['n0']), ['n0']);
  changes('addToSelection', () => st().addToSelection(['n4']), ['n0', 'n4']);
  changes('toggleSelection in', () => st().toggleSelection('n8'), ['n0', 'n4', 'n8']);
  changes('toggleSelection out', () => st().toggleSelection('n4'), ['n0', 'n8']);
  changes('selectAll', () => st().selectAll(), ['n0', 'n4', 'n8']);
  changes('setSelectedNote', () => st().setSelectedNote('n0'), ['n0']);
  let drawn = '';
  changes('addNote', () => { drawn = st().addNote({ note: 62, step: 12, length: 2, velocity: 90 }); }, () => [drawn]);
  changes('removeNote', () => st().removeNote(drawn), () => []);

  // The one deliberate exception: clearing an empty selection is a no-op, so it
  // hands back the Set it already had rather than waking every subscriber.
  const empty = st().selectedIds;
  st().clearSelection();
  assert.equal(st().selectedIds, empty, 'clearing nothing is not a write');
  changes('clearSelection', () => { st().setSelection(['n0']); st().clearSelection(); }, []);
  changes('replaceAll', () => { st().setSelection(['n0']); st().replaceAll([note(0), note(4)]); }, []);
}

// ── Ticks: the note model's clock ────────────────────────────────────────────

// The grid derives FROM ticks, at every grid the roll can offer. 960 divides by
// 3, 4 and 8, so triplets and 32nds all land on whole ticks.
{
  assert.equal(PPQ, 960);
  assert.equal(ROLL_STEPS_PER_BEAT, 4);
  assert.deepEqual([ticksPerStep(), ticksPerStep(4), ticksPerStep(3), ticksPerStep(8)], [240, 240, 320, 120]);
  // Garbage falls back to the roll's own grid rather than dividing by nothing.
  assert.deepEqual([ticksPerStep(0), ticksPerStep(-2), ticksPerStep(Number.NaN)], [240, 240, 240]);

  for (const [spb, per] of [[4, 240], [3, 320], [8, 120]] as const) {
    for (const step of [0, 1, 2.5, 7, 13.25]) {
      assert.equal(tickOfStep(step, spb), Math.round(step * per), `step ${step} at ${spb}/beat`);
      // Both ways, and the trip back is exact — that is what makes `step` a view.
      assert.equal(stepOfTick(tickOfStep(step, spb), spb), step, `round trip ${step} at ${spb}/beat`);
    }
    // And the other direction: a tick survives step and back untouched.
    for (const tick of [0, 1, 17, per, per * 3 + 1, 5039]) {
      assert.equal(tickOfStep(stepOfTick(tick, spb), spb), tick, `tick ${tick} at ${spb}/beat`);
    }
  }
  // One beat is one beat whatever the grid counts in.
  assert.equal(tickOfStep(4, 4), PPQ);
  assert.equal(tickOfStep(3, 3), PPQ);
  assert.equal(tickOfStep(8, 8), PPQ);
  // Nothing sits before the roll's start, and nothing is shorter than a tick.
  assert.equal(tickOfStep(-9), 0);
  assert.equal(stepOfTick(-9), 0);
  assert.equal(noteTicks({ ticks: 0 }), MIN_NOTE_TICKS);
}

// withTicks: migration, re-ticking, and the fields it validates.
{
  // A note with no ticks at all is migrated: tick = step x ticksPerStep.
  const legacy = withTicks({ id: 'l', note: 60, step: 6, length: 2, velocity: 90 });
  assert.deepEqual([legacy.tick, legacy.ticks, legacy.step, legacy.length], [1440, 480, 6, 2]);

  // A note that already agrees keeps its own ticks untouched.
  const kept = withTicks({ id: 'k', note: 60, step: 2.5, length: 1, velocity: 90, tick: 600, ticks: 240 });
  assert.deepEqual([kept.tick, kept.ticks], [600, 240]);

  // A note whose `step` was rewritten behind the model's back — a paste, a lane
  // unroll, a groove — is re-ticked FROM the rewritten step.
  const moved = withTicks({ id: 'm', note: 60, step: 10, length: 2, velocity: 90, tick: 600, ticks: 240 });
  assert.deepEqual([moved.tick, moved.ticks, moved.step, moved.length], [2400, 480, 10, 2]);

  // Tick-native: ticks with no step at all lead, and the step view follows them.
  const native = withTicks({ id: 'n', note: 60, velocity: 90, tick: 605, ticks: 60 } as PianoNote);
  assert.deepEqual([native.tick, native.ticks], [605, 60]);
  assert.equal(native.step, 605 / 240);
  assert.equal(native.length, 0.25, 'ticks reach below one step');
  // So does a tick-less length in steps: a half-step 32nd is 120 ticks, not a whole step.
  const thirtySecond = withTicks({ id: 'h', note: 60, step: 3, length: 0.5, velocity: 90 });
  assert.deepEqual([thirtySecond.ticks, thirtySecond.length], [120, 0.5]);
  const triplet = withTicks({ id: 't', note: 60, step: 0, length: 2 / 3, velocity: 90 });
  assert.equal(triplet.ticks, 160);
  // Zero, negative and missing lengths: one tick, one tick, one step.
  assert.equal(noteTicks({ step: 0, length: 0 }), MIN_NOTE_TICKS);
  assert.equal(noteTicks({ step: 0, length: -3 }), MIN_NOTE_TICKS);
  assert.equal(noteTicks({ step: 0 }), ticksPerStep());

  // Bounds: no negative tick, no zero-length note, a whole channel 1-16, expression in range.
  const bad = withTicks({ id: 'b', note: 60, velocity: 90, tick: -30.7, ticks: 0.2, channel: 99, expr: { pressure: 4, timbre: -1, pitchBend: -8 } } as PianoNote);
  assert.deepEqual([bad.tick, bad.ticks, bad.channel], [0, 1, 16]);
  assert.deepEqual(bad.expr, { pressure: 1, timbre: 0, pitchBend: -1 });
  assert.equal(withTicks({ id: 'c', note: 60, step: 0, length: 1, velocity: 90, channel: 0.6 }).channel, 1);
  // Nothing worth keeping is not kept: no channel, no expression, no empty object.
  const plain = withTicks({ id: 'p', note: 60, step: 0, length: 1, velocity: 90, channel: Number.NaN, expr: {} } as PianoNote);
  assert.equal('channel' in plain, false);
  assert.equal('expr' in plain, false);

  // It never rewrites pitch or velocity — whole-list ingest never validated
  // those, and starting now would quietly edit existing projects.
  const untouched = withTicks({ id: 'u', note: 300, step: 0, length: 1, velocity: 0 });
  assert.deepEqual([untouched.note, untouched.velocity], [300, 0]);

  // A triplet grid counts the same note's step differently, and says so.
  assert.equal(withTicks({ id: 't', note: 60, step: 3, length: 1, velocity: 90 }, 3).tick, 960);
  assert.deepEqual(migrateNotes([{ id: 'x', note: 60, step: 1, length: 1, velocity: 90 }], 8).map((n) => [n.tick, n.ticks]), [[120, 120]]);
  // …but a grid the CALLER names never overrules a tick the store already has.
  // A store note's step/length are counted on the roll's own 16ths, so that is
  // the only grid the agreement check may use; a triplet-grid export asking for
  // this note's ticks gets the authoritative ones back, unrewritten.
  const store3 = { id: 's3', note: 60, velocity: 90, tick: 250, ticks: 240, step: 250 / 240, length: 1 } as PianoNote;
  assert.equal(noteTick(store3, 3), 250, 'a foreign grid must not re-tick a note that has one');
  assert.equal(noteTicks(store3, 3), 240, 'nor re-length it');
  const kept3 = migrateNotes([store3], 3)[0];
  assert.deepEqual([kept3.tick, kept3.ticks], [250, 240]);
  assert.deepEqual([kept3.step, kept3.length], [250 / 240, 1], 'and the step view stays on the roll grid');

  // The helper-rewrote-step branch still re-ticks, and THERE the caller's grid
  // is what counts: step 10 on a triplet grid is 10 x 320 ticks.
  assert.equal(noteTick({ tick: 600, step: 10 }, 3), 3200);
  // A note with no tick at all is read on the caller's grid, as it always was.
  assert.equal(noteTick({ step: 2 }, 3), 640);

  // The accessors migrate without building a note.
  assert.equal(noteTick({ step: 4 }), 960);
  assert.equal(noteTicks({ length: 4 }), 960);
  assert.equal(noteTick({ step: 4, tick: 960 }), 960);
}

// Every way a note list reaches the store leaves it ticked and consistent.
{
  const ticked = (n: PianoNote) => [n.tick, n.ticks, n.step, n.length];
  const consistent = (where: string) => {
    for (const n of st().notes) {
      assert.equal(n.tick, tickOfStep(n.step), `${where}: ${n.id} tick vs step`);
      assert.equal(n.ticks, tickOfStep(n.length), `${where}: ${n.id} ticks vs length`);
    }
  };

  st().importNotes([note(4, 2)]);
  assert.deepEqual(ticked(st().notes[0]), [960, 480, 4, 2], 'importNotes');
  consistent('importNotes');

  // replaceAll with step-only notes: the ticks are derived there, which is what
  // keeps the groove and QUANT paths (which rewrite `step` on spread copies and
  // hand the result straight back) working without any of them knowing about ticks.
  st().replaceAll([note(3, 1), { id: 'swung', note: 62, step: 4.5, length: 0.5, velocity: 90 }]);
  assert.deepEqual(st().notes.map((n) => n.tick), [720, 1080]);
  assert.deepEqual(st().notes.map((n) => n.ticks), [240, 120], 'a sub-step LENGTH keeps its size');
  consistent('replaceAll');

  // A note carrying ticks that still agree keeps them exactly.
  st().replaceAll([{ id: 'exact', note: 60, step: 605 / 240, length: 0.25, velocity: 90, tick: 605, ticks: 60 }]);
  assert.deepEqual(ticked(st().notes[0]), [605, 60, 605 / 240, 0.25], 'consistent ticks survive replaceAll');

  // …and one whose step was moved under it is re-ticked from the step.
  st().replaceAll([{ id: 'stale', note: 60, step: 8, length: 2, velocity: 90, tick: 605, ticks: 60 }]);
  assert.deepEqual(ticked(st().notes[0]), [1920, 480, 8, 2], 'a rewritten step wins over stale ticks');

  st().loadFromClip('c-tick', [note(6, 3)], 120, 64);
  assert.deepEqual(ticked(st().notes[0]), [1440, 720, 6, 3], 'loadFromClip');
  st().placeRecording([note(2, 1)], { startStep: 0, endStep: 4 });
  assert.deepEqual(ticked(st().notes[0]), [480, 240, 2, 1], 'placeRecording');
}

// addNote / updateNote / nudge all write the ticks, whichever pair the caller names.
{
  st().importNotes([]);
  st().setTotalSteps(64);
  const id = st().addNote({ note: 60, step: 2, length: 2, velocity: 90 });
  const n = () => st().notes.find((x) => x.id === id)!;
  assert.deepEqual([n().tick, n().ticks], [480, 480], 'addNote from steps');

  // A patch that names ticks moves the step view.
  st().updateNote(id, { tick: 605, ticks: 60 });
  assert.deepEqual([n().tick, n().ticks, n().step, n().length], [605, 60, 605 / 240, 0.25]);
  // A patch that names steps re-ticks the note.
  st().updateNote(id, { step: 3.5, length: 2 });
  assert.deepEqual([n().tick, n().ticks], [840, 480]);
  // Bounds on the new fields, and the rest of the note left alone.
  st().updateNote(id, { tick: -4, ticks: -4 });
  assert.deepEqual([n().tick, n().ticks, n().step, n().length], [0, 1, 0, 1 / 240]);
  st().updateNote(id, { channel: 40, expr: { pressure: 0.5, pitchBend: 9 } });
  assert.equal(n().channel, 16);
  assert.deepEqual(n().expr, { pressure: 0.5, pitchBend: 1 });
  st().updateNote(id, { channel: Number.NaN });
  assert.equal('channel' in n(), false, 'a channel that is not one is dropped, not stored as NaN');

  // A tick-native add needs no step at all.
  st().importNotes([]);
  const tickOnly = st().addNote({ note: 64, velocity: 100, tick: 1805, ticks: 120 } as Omit<PianoNote, 'id'>);
  const t = st().notes.find((x) => x.id === tickOnly)!;
  assert.deepEqual([t.tick, t.ticks, t.step, t.length], [1805, 120, 1805 / 240, 0.5]);

  // Nudging moves the ticks with the steps, fractions included.
  st().replaceAll([note(0)]);
  st().setTotalSteps(16);
  st().setSelection(['n0']);
  st().nudgeSelected(2, 0);
  assert.deepEqual([st().notes[0].step, st().notes[0].tick], [2, 480]);
  st().nudgeSelected(0.25, 0);
  assert.deepEqual([st().notes[0].step, st().notes[0].tick], [2.25, 540]);

  // Undo and redo hand back notes that are still ticked and still consistent.
  // (A burst of edits this close together is ONE undo step, so the step back is
  // to before the burst — what matters here is that the ticks come back with it.)
  st().undo();
  for (const u of st().notes) assert.equal(u.tick, tickOfStep(u.step), `undo left ${u.id} un-ticked`);
  st().redo();
  assert.deepEqual([st().notes[0].step, st().notes[0].tick], [2.25, 540], 'redo restores the nudged ticks');
}

// The feel's groove id lives with Q and SWING, and rides in the same record.
{
  assert.equal(DEFAULT_GROOVE_ID, 'swing');
  st().setGrooveId('swing8:62');
  assert.equal(st().grooveId, 'swing8:62');
  st().setGrooveId('  spaced  ');
  assert.equal(st().grooveId, 'spaced', 'trimmed');
  st().setGrooveId('');
  assert.equal(st().grooveId, DEFAULT_GROOVE_ID, 'blank falls back to the default');
  st().setGrooveId(null as unknown as string);
  assert.equal(st().grooveId, DEFAULT_GROOVE_ID);
  // Whatever is set, the whole feel is what gets written — Q and SWING are not
  // dropped by a groove change, nor the groove by a slider move.
  st().setGrooveId('pocket:a');
  st().setQuantizePct(55);
  st().setSwingPct(-8);
  assert.deepEqual([st().grooveId, st().quantizePct, st().swingPct], ['pocket:a', 55, -8]);
  st().loadFromClip('c-groove', [note(0)], 120, 32);
  assert.equal(st().grooveId, 'pocket:a', 'a clip load leaves the feel alone');
}

// GEN writes a bar of 24 rule steps into a 4/4 bar of 16 roll steps: every
// cell is 16/24 = 0.667 steps long. The store takes the write (replaceAll, as
// the METER face's WRITE does), then the scheduler unrolls the notes to play
// them. Every note keeps its 0.667-step length the whole way, so the run plays
// detached: no note reaches the start of the next. The store used to raise
// each one to a full 16th, so every note overlapped the one after it.
{
  const third = 16 / 24;
  st().importNotes([], 120, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, []);
  st().setTotalSteps(16);
  const gen: GenSettings = { kind: 'euclid', opts: { ...GEN_DEFAULT_OPTS.euclid, hits: 24 }, steps: 24, gate: { kind: 'open' }, seed: 1 };
  const res = genWrite(st(), 0, gen, [60, 62, 64], 'g24');
  assert.equal(res.written, 24);
  st().replaceAll(res.notes);
  const held = [...st().notes].sort((a, b) => a.step - b.step);
  assert.equal(held.length, 24);
  for (const n of held) {
    assert.ok(Math.abs(n.length - third) < 1 / 240, `a GEN note keeps ${third.toFixed(3)} steps, got ${n.length}`);
    assert.equal(n.ticks, 160, 'two thirds of a 16th is 160 ticks');
  }
  for (let i = 1; i < held.length; i += 1) {
    assert.ok(held[i - 1].step + held[i - 1].length <= held[i].step + 1e-9, `note ${i - 1} ends before note ${i} starts`);
  }
  const played = unrollLanes(st().notes, st().lanes, st().totalSteps);
  assert.ok(played.every((n) => Math.abs(n.length - third) < 1 / 240), 'the notes play at their own length');
  // The bar still fits in one bar: the last note ends on the bar line, not past it.
  assert.equal(st().totalSteps, 16);

  // APPLY with QUANT 0 and the swing slider (a swing-only pass): starts move,
  // lengths stay. APPLY used to floor every length at one step here too.
  const notes = st().notes;
  const { sourceRollNotes: swung } = quantizeRollClip(
    { sourceRollNotes: notes, sourcePianoRoll: [], sourceLanes: st().lanes, sourceMeterMap: st().meterMap, sourcePickupSteps: 0, sourceTotalSteps: st().totalSteps },
    { grid: '1/16', strength: 0, groove: swingToGroove(20), grooveStrength: 1 },
  );
  st().replaceAll(swung.map((n, i) => ({ ...n, length: feelLength(notes[i].length, 0) })));
  assert.ok(st().notes.every((n) => n.ticks === 160), 'a swing-only APPLY leaves the lengths alone');
  // At QUANT 100 APPLY lands lengths on whole steps, as it always has.
  assert.equal(feelLength(third, 1), 1);
  assert.equal(feelLength(2.4, 1), 2);
  assert.ok(Math.abs(feelLength(third, 0.5) - (third + (1 - third) / 2)) < 1e-12);
}

// A clip or import whose last note is shorter than a step fits the roll to the
// bar that note ends in, not to the bar after it.
{
  st().importNotes([{ id: 'end', note: 60, step: 15.5, length: 0.25, velocity: 90 }], 120, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
  assert.equal(st().totalSteps, 16);
}

console.log('pianoRollStore: ok');
