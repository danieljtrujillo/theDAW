// The piano roll's undo / redo history: which slices it tracks, which it
// deliberately does not, and that a burst of edits folds into one step.
//
// The recorder coalesces changes closer together than 300 ms, and a test run is
// far faster than that, so every block has to start from a reset coalesce clock
// or the edit under test would fold into the previous block's. `beginBlock()`
// does that the same way `editorStore.test.ts` does — it makes the setup write
// the one step on the stack and then undoes it, since undo() resets the clock.
// No timers are involved anywhere.
import assert from 'node:assert/strict';
import { DEFAULT_LANES, sanitizeLanes, usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { clipRollLoad, rollClipFields, type RollClipInput } from '../lib/rollClip.ts';

const st = () => usePianoRollStore.getState();
const note = (step: number, id = `n${step}`): PianoNote => ({ id, note: 60, step, length: 2, velocity: 90 });
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };

/**
 * Call right after a block's setup `setState`. Seeds a single history step whose
 * snapshot IS the state the setup just wrote (a write that touches no document
 * slice, so the recorder ignores it), then undoes it: the document is unchanged,
 * the stacks are empty, and the coalesce clock is reset, so the block's first
 * real edit starts a fresh step.
 */
const beginBlock = () => {
  const s = st();
  usePianoRollStore.setState({
    _undo: [
      {
        notes: s.notes,
        bpm: s.bpm,
        totalSteps: s.totalSteps,
        lowestNote: s.lowestNote,
        highestNote: s.highestNote,
        meterMap: s.meterMap,
        pickupSteps: s.pickupSteps,
        lanes: s.lanes,
        bends: s.bends,
      },
    ],
    _redo: [],
  });
  st().undo();
  assert.equal(st()._undo.length, 0, 'a block starts with an empty undo stack');
};

const freshLanes = () => ({ lanes: sanitizeLanes(DEFAULT_LANES), activeLane: 0, bends: [] });

// Adding a note records one step; undo takes it back and redo puts it again.
{
  usePianoRollStore.setState({ notes: [note(0)], selectedNoteId: null });
  beginBlock();
  const id = st().addNote({ note: 64, step: 4, length: 2, velocity: 90 });
  assert.equal(st()._undo.length, 1, 'an added note is one undo step');
  assert.equal(st().notes.length, 2);
  st().undo();
  assert.equal(st().notes.length, 1, 'undo removes the added note');
  assert.equal(st().notes[0].id, 'n0');
  st().redo();
  assert.equal(st().notes.length, 2, 'redo puts it back');
  assert.ok(st().notes.some((n) => n.id === id));
  st().undo();
}

// A burst of updateNote calls (one note drag) folds into a single undo step.
{
  usePianoRollStore.setState({ notes: [note(0), note(4)], selectedNoteId: null });
  beginBlock();
  st().updateNote('n0', { length: 3 });
  st().updateNote('n0', { length: 4 });
  st().updateNote('n0', { length: 5 });
  assert.equal(st()._undo.length, 1, 'a burst of edits is one step, not three');
  assert.equal(st().notes[0].length, 5);
  st().undo();
  assert.equal(st().notes[0].length, 2, 'undo takes the whole burst back');
}

// A meter edit is undoable, and restores the exact prior meter map.
{
  usePianoRollStore.setState({ notes: [], ...freshLanes() });
  beginBlock();
  const before = st().meterMap;
  const beforeSteps = st().totalSteps;
  st().setMeterMap([{ bar: 0, meter: M78 }]);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M78 }]);
  assert.equal(st()._undo.length, 1, 'a meter edit is one undo step');
  st().undo();
  assert.equal(st().meterMap, before, 'undo restores the meter map');
  assert.equal(st().totalSteps, beforeSteps, 'and the length the meter change rounded');
}

// A lane edit is undoable.
{
  usePianoRollStore.setState({ notes: [], ...freshLanes() });
  beginBlock();
  const beforeLanes = st().lanes;
  const id = st().addLane(12);
  assert.ok(st().lanes.some((l) => l.id === id), 'the lane is there');
  assert.equal(st()._undo.length, 1, 'a lane edit is one undo step');
  st().undo();
  assert.equal(st().lanes, beforeLanes, 'undo restores the lanes');
}

// A bend edit is undoable.
{
  usePianoRollStore.setState({ notes: [note(0)], ...freshLanes() });
  beginBlock();
  const pointId = st().addBendPoint(0, { step: 2, value: 0.5 });
  assert.ok(pointId, 'the point is added');
  assert.equal(st().bends.length, 1);
  assert.equal(st()._undo.length, 1, 'a bend edit is one undo step');
  st().undo();
  assert.deepEqual(st().bends, [], 'undo restores the bends');
}

// View and transport changes never enter history.
{
  usePianoRollStore.setState({ notes: [note(0)], selectedNoteId: null, currentStep: 0, isPlaying: false });
  beginBlock();
  st().setSelectedNote('n0');
  st().setCurrentStep(12);
  st().setPlaying(true);
  st().setPlaying(false);
  st().setActiveLane(0);
  assert.equal(st()._undo.length, 0, 'selection, playhead and transport record nothing');
  assert.equal(st().selectedNoteId, 'n0', 'and they still took effect');
  assert.equal(st().currentStep, 12);
}

// replaceAll is undoable and restores the notes it swapped out.
{
  usePianoRollStore.setState({ notes: [note(0), note(4)], selectedNoteId: null });
  beginBlock();
  const beforeNotes = st().notes;
  st().replaceAll([note(8, 'x8')]);
  assert.equal(st().notes.length, 1);
  assert.equal(st()._undo.length, 1, 'replaceAll is one undo step');
  st().undo();
  assert.equal(st().notes, beforeNotes, 'undo restores the notes replaceAll swapped out');
}

// clear is undoable — notes and bends both come back.
{
  usePianoRollStore.setState({ notes: [note(0)], ...freshLanes(), editingClipId: null });
  beginBlock();
  st().addBendPoint(0, { step: 1, value: 0.25 });
  st().undo(); // the bend edit is its own step; leaves the clock reset
  const beforeNotes = st().notes;
  st().clear();
  assert.deepEqual(st().notes, []);
  st().undo();
  assert.equal(st().notes, beforeNotes, 'clear is undoable');
}

// importNotes is undoable — notes, tempo and the fitted length all come back.
{
  usePianoRollStore.setState({ notes: [note(0)], bpm: 120, ...freshLanes() });
  beginBlock();
  const beforeNotes = st().notes;
  const beforeSteps = st().totalSteps;
  st().importNotes([note(32, 'i32')], 140);
  assert.equal(st().bpm, 140);
  assert.equal(st()._undo.length, 1, 'importNotes is one undo step');
  st().undo();
  assert.equal(st().notes, beforeNotes, 'undo restores the notes the import replaced');
  assert.equal(st().bpm, 120, 'and the tempo it brought');
  assert.equal(st().totalSteps, beforeSteps, 'and the length it fitted');
}

// placeRecording is undoable; the recorded range is view state and stays put.
{
  usePianoRollStore.setState({ notes: [note(0)], recordedRange: null, ...freshLanes() });
  beginBlock();
  const beforeNotes = st().notes;
  const range = { startStep: 64, endStep: 70 };
  st().placeRecording([note(64, 'r64')], range);
  assert.deepEqual(st().recordedRange, range);
  assert.equal(st()._undo.length, 1, 'placeRecording is one undo step');
  st().undo();
  assert.equal(st().notes, beforeNotes, 'placeRecording is undoable');
  assert.deepEqual(st().recordedRange, range, 'the recorded range is view state, not restored');
}

// Undo on an empty stack is a no-op, and a fresh edit drops the redo stack.
{
  usePianoRollStore.setState({ notes: [note(0)], selectedNoteId: null });
  beginBlock();
  const notes = st().notes;
  st().undo();
  assert.equal(st().notes, notes, 'undo with nothing to undo changes nothing');
  st().addNote({ note: 62, step: 2, length: 2, velocity: 90 });
  st().undo();
  assert.equal(st()._redo.length, 1, 'the undone step is on the redo stack');
  st().replaceAll([note(16, 'z16')]);
  assert.equal(st()._redo.length, 0, 'a new edit drops the redo stack');
  st().undo();
}

// Open EDIT clip A, edit it, open clip B, undo: the sequence WaveformEditor's
// double-click (clipRollLoad -> loadFromClip) and the roll's Ctrl/Cmd+Z make.
// Opening B starts a new document, so the undo has nothing to take back: B's
// notes stay, the roll stays linked to B, and SAVE (rollClipFields, what the
// SAVE key writes into the linked clip) writes B's own notes into B. The undo
// used to bring A's notes back while the roll stayed linked to B, and SAVE then
// wrote A's notes into B.
{
  const clip = (id: string, steps: number[]): RollClipInput => ({
    id,
    sourceRollNotes: steps.map((st, i) => ({ id: `${id}-${i}`, note: 60 + i, step: st, length: 2, velocity: 90 })),
    sourceBpm: 120,
    sourceTotalSteps: 32,
    sourceMeterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
    sourcePickupSteps: 0,
    sourceLanes: [{ id: 0, name: 'A', cycleSteps: null }],
    sourceBends: [],
  });
  usePianoRollStore.setState({ notes: [note(0)], selectedNoteId: null });
  beginBlock();
  st().loadFromClip(...clipRollLoad(clip('A', [0, 4, 8])));
  assert.equal(st()._undo.length, 0, 'opening a clip leaves no step to undo');
  st().addNote({ note: 72, step: 12, length: 2, velocity: 90 });
  assert.equal(st()._undo.length, 1, 'an edit in clip A is one step');
  st().loadFromClip(...clipRollLoad(clip('B', [2, 6])));
  assert.deepEqual([st()._undo.length, st()._redo.length], [0, 0], 'opening clip B empties both stacks');
  st().undo();
  assert.equal(st().editingClipId, 'B');
  assert.deepEqual(st().notes.map((n) => n.id), ['B-0', 'B-1'], "undo after opening B leaves B's notes");
  const saved = rollClipFields(st());
  assert.deepEqual(saved.sourceRollNotes.map((n) => n.id), ['B-0', 'B-1'], "SAVE writes B's own notes into B");
  st().redo();
  assert.deepEqual(st().notes.map((n) => n.id), ['B-0', 'B-1'], 'redo has nothing of A to bring back');
  // The first edit in B is a fresh step, and undoing it lands on B as opened.
  st().addNote({ note: 50, step: 20, length: 2, velocity: 90 });
  assert.equal(st()._undo.length, 1);
  st().undo();
  assert.deepEqual(st().notes.map((n) => n.id), ['B-0', 'B-1']);
  assert.equal(st().editingClipId, 'B');
}

// CLEAR unlinks the clip in the same write that empties the roll. Its undo
// brings the notes back AND the link, so SAVE writes them into their own clip;
// redo clears and unlinks again. A bounce after CLEAR binds a new clip without
// a step of its own, and undoing back past CLEAR relinks the first clip.
{
  usePianoRollStore.setState({ notes: [note(0), note(4)], editingClipId: 'A', selectedNoteId: null });
  beginBlock();
  st().clear();
  assert.deepEqual([st().notes.length, st().editingClipId], [0, null]);
  st().undo();
  assert.deepEqual(st().notes.map((n) => n.id), ['n0', 'n4']);
  assert.equal(st().editingClipId, 'A', 'undoing CLEAR relinks the clip its notes came from');
  st().redo();
  assert.deepEqual([st().notes.length, st().editingClipId], [0, null], 'redo clears and unlinks again');
  st().undo();
  assert.equal(st().editingClipId, 'A');

  // CLEAR, draw, bounce (links C), undo twice.
  st().clear();
  // Undo and redo leave CLEAR in place and reset the coalesce clock, so the draw is its own step.
  st().undo();
  st().redo();
  st().addNote({ note: 64, step: 2, length: 2, velocity: 90 });
  st().setEditingClip('C');
  assert.equal(st()._undo.length, 2);
  st().undo();
  assert.deepEqual([st().notes.length, st().editingClipId], [0, 'C'], 'undoing the draw keeps the bounced link');
  st().undo();
  assert.deepEqual(st().notes.map((n) => n.id), ['n0', 'n4']);
  assert.equal(st().editingClipId, 'A', "clip A's notes come back linked to A, never to C");
}

// A paste past the roll's end (appendNotes) grows the roll in the same write,
// so one undo takes back the notes and the length together.
{
  usePianoRollStore.setState({ notes: [note(0)], totalSteps: 32, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, selectedNoteId: null });
  beginBlock();
  st().appendNotes([note(30, 'p30'), note(40, 'p40')]);
  assert.equal(st().totalSteps, 48, 'the roll grows to the bar line after the last pasted note');
  assert.deepEqual([...st().selectedIds], ['p30', 'p40']);
  assert.equal(st()._undo.length, 1);
  st().undo();
  assert.deepEqual([st().notes.length, st().totalSteps], [1, 32]);
  // The loop and the playhead are transport state: never a step.
  st().setLoop({ start: 4, end: 8 });
  st().seek(12);
  assert.equal(st()._undo.length, 0);
}

console.log('pianoRollHistory: ok');
