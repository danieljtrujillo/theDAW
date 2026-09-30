/**
 * lib/clipRollSync — an edit made to the notes a roll clip plays is written to
 * the roll's own notes too, so the piano roll opens with it.
 *
 * Each case bounces a real roll state (lib/rollClip rollClipFields), edits the
 * played list the way the assistant's note tools do, and checks two things:
 * the roll list keeps every lane it can, and unrolling the roll list gives the
 * edited played list back, note for note. A clip bounced before the roll kept
 * its own list has nothing to sync.
 *
 *   cd frontend && npx tsx src/lib/clipRollSync.test.ts
 */
import assert from 'node:assert/strict';
import type { PianoNote } from '../state/pianoRollStore.ts';
import type { PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';
import { baseNoteId, rollNotesAfterEdit } from './clipRollSync.ts';
import { playedRollBends } from './pitchBend.ts';
import { playedRollNotes, rollClipFields } from './rollClip.ts';

const note = (id: string, pitch: number, step: number, length = 1, lane?: number): PianoNote =>
  ({ id, note: pitch, step, length, velocity: 100, ...(lane === undefined ? {} : { lane }) } as PianoNote);

const LANE_A: PolyLane = { id: 0, name: 'A', cycleSteps: null };
const LOOP_B: PolyLane = { id: 1, name: 'B', cycleSteps: 3 };
const FREE_B: PolyLane = { id: 1, name: 'B', cycleSteps: null };

const bounce = (notes: PianoNote[], lanes: PolyLane[], bends: LaneBend[] = [], totalSteps = 16) => rollClipFields({
  notes, bpm: 100, totalSteps, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes, bends,
});

/** What a list plays, ids aside (a repeat written out gets an id of its own). */
const sounding = (notes: readonly PianoNote[]) =>
  notes.map((n) => [n.note, n.step, n.length, n.velocity]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);

assert.equal(baseNoteId('c~3'), 'c');
assert.equal(baseNoteId('c'), 'c');
assert.equal(baseNoteId('x~y'), 'x~y', 'only a numeric repeat suffix is a repeat');

// A clip bounced before the roll kept its own list: nothing to sync.
{
  const legacy = { sourcePianoRoll: [note('a', 60, 0)], sourceRollNotes: undefined, sourceLanes: undefined, sourceBends: undefined, sourceTotalSteps: 16 };
  assert.deepEqual(rollNotesAfterEdit(legacy, [note('a', 62, 0)], 16), {});
}

// No lane loops: the roll list is the edited list, each note back in its lane.
{
  const clip = bounce([note('a', 60, 0), note('b', 64, 4, 2, 1)], [LANE_A, FREE_B]);
  const edited = clip.sourcePianoRoll.map((n) => ({ ...n, note: n.note + 2 }));
  const out = rollNotesAfterEdit(clip, edited, 16);
  assert.deepEqual(out.sourceRollNotes?.map((n) => [n.id, n.note, (n as PianoNote & { lane?: number }).lane]), [['a', 62, undefined], ['b', 66, 1]]);
  assert.equal(out.sourceLanes, undefined, 'the lanes are unchanged');
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, clip.sourceLanes, 16)), sounding(edited));
}

// A looping lane the edit left alone keeps its loop and its roll notes.
{
  const clip = bounce([note('a', 60, 0), note('c', 72, 0, 1, 1)], [LANE_A, LOOP_B]);
  assert.equal(clip.sourcePianoRoll.length, 1 + 6, 'lane B loops a 3-16th cycle over 16 steps: 6 times');
  const edited = clip.sourcePianoRoll.map((n) => (n.id === 'a' ? { ...n, note: 59 } : n));
  const out = rollNotesAfterEdit(clip, edited, 16);
  assert.equal(out.sourceLanes, undefined, 'lane B keeps looping');
  assert.deepEqual(out.sourceRollNotes?.map((n) => [n.id, n.note]).sort(), [['a', 59], ['c', 72]], 'lane B keeps its one roll note');
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, clip.sourceLanes, 16)), sounding(edited));
}

// A looping lane the edit changed is written out and stops looping, so it plays what the edit made.
{
  const clip = bounce([note('a', 60, 0), note('c', 72, 0, 1, 1)], [LANE_A, LOOP_B]);
  const edited = clip.sourcePianoRoll.map((n) => ({ ...n, note: n.note - 12 }));
  const out = rollNotesAfterEdit(clip, edited, 16);
  assert.ok(out.sourceLanes, 'the lanes change');
  assert.equal(out.sourceLanes!.find((l) => l.id === 1)!.cycleSteps, null, 'lane B stops looping');
  assert.equal(out.sourceRollNotes!.length, 7, 'its six repeats are notes of their own');
  assert.ok(out.sourceRollNotes!.every((n) => !/~\d+$/.test(n.id)), 'with ids of their own');
  assert.equal(new Set(out.sourceRollNotes!.map((n) => n.id)).size, 7, 'every id is unique');
  assert.ok(out.sourceRollNotes!.filter((n) => n.note === 60).every((n) => (n as PianoNote & { lane?: number }).lane === 1), 'still in lane B');
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, out.sourceLanes!, 16)), sounding(edited), 'it unrolls to exactly the edit');
}

// A written-out lane's bend is written out the way it played.
{
  const bends: LaneBend[] = [{ lane: 1, range: 2, points: [{ id: 'p0', step: 0, value: 0, shape: 'linear' }, { id: 'p1', step: 2, value: 1, shape: 'hold' }] }];
  const clip = bounce([note('a', 60, 0), note('c', 72, 0, 1, 1)], [LANE_A, LOOP_B], bends);
  const edited = clip.sourcePianoRoll.filter((n) => !(n.id === 'c~2'));
  const out = rollNotesAfterEdit(clip, edited, 16);
  const played = playedRollBends(bends, [LANE_A, LOOP_B], 16).get(1)!;
  assert.deepEqual(out.sourceBends?.find((b) => b.lane === 1)?.points.map((p) => [p.step, p.value, p.shape]), played.points.map((p) => [p.step, p.value, p.shape]));
  assert.ok((out.sourceBends?.find((b) => b.lane === 1)?.points.length ?? 0) > bends[0].points.length, 'the curve repeats across the clip');
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, out.sourceLanes!, 16)), sounding(edited), 'the deleted repeat stays deleted');
}

// A note the roll never had goes in no lane; deleting a lane's notes empties it.
{
  const clip = bounce([note('a', 60, 0), note('c', 72, 0, 1, 1)], [LANE_A, LOOP_B]);
  const edited = [...clip.sourcePianoRoll.filter((n) => baseNoteId(n.id) !== 'c'), note('new', 67, 8, 2)];
  const out = rollNotesAfterEdit(clip, edited, 16);
  const fresh = out.sourceRollNotes!.find((n) => n.id === 'new') as PianoNote & { lane?: number };
  assert.equal(fresh.lane, undefined, 'a new note is in lane A');
  assert.ok(!out.sourceRollNotes!.some((n) => n.note === 72), "lane B's notes are gone as the edit said");
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, out.sourceLanes ?? clip.sourceLanes, 16)), sounding(edited));
}

// A new part with an empty roll list takes the edited notes.
{
  const empty = { sourcePianoRoll: [], sourceRollNotes: [], sourceLanes: [LANE_A], sourceBends: [], sourceTotalSteps: 16 };
  const out = rollNotesAfterEdit(empty, [note('x', 60, 0), note('y', 62, 2)], 16);
  assert.deepEqual(out.sourceRollNotes?.map((n) => n.id), ['x', 'y']);
}

// The grid grows past the loop's old end: the lane is written out, never repeated further than the edit.
{
  const clip = bounce([note('a', 60, 0), note('c', 72, 0, 1, 1)], [LANE_A, LOOP_B]);
  const edited = clip.sourcePianoRoll.map((n) => (n.id === 'a' ? { ...n, step: 18 } : n));
  const out = rollNotesAfterEdit(clip, edited, 32);
  assert.deepEqual(sounding(playedRollNotes(out.sourceRollNotes!, out.sourceLanes ?? clip.sourceLanes, 32)), sounding(edited), 'the edited part plays exactly the edit on the longer grid');
}

console.log('clipRollSync: ok');
