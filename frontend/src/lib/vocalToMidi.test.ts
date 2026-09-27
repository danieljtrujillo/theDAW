/**
 * lib/vocalToMidi: the notes a vocal capture hears, as roll notes. The
 * sequence replayed: a capture hears a phrase (an off-grid start, a 32nd, a
 * held note), captureNotesToPianoNotes converts it at the roll's tempo, the
 * roll takes it with importNotes and plays each note at tick / PPQ beats.
 * The converter used to round each edge to the nearest 16th with a one-step
 * floor, so the 32nd came back a whole 16th long and every start moved.
 */
import assert from 'node:assert/strict';
import { captureNotesToPianoNotes, type CaptureNote } from './vocalToMidi.ts';
import { PPQ, usePianoRollStore } from '../state/pianoRollStore.ts';

const heard: CaptureNote[] = [
  { pitch: 60, velocity: 90, startMs: 510, endMs: 541 }, // 10 ms late, a 32nd at 120 BPM
  { pitch: 62, velocity: 80, startMs: 1033, endMs: 1470 },
  { pitch: 64, velocity: 70, startMs: 2000, endMs: 3000 },
];

const notes = captureNotesToPianoNotes(heard, 120);
assert.deepEqual(notes.map((n) => [n.id, n.note, n.tick, n.ticks]), [
  ['vox-0', 60, 979, 60],
  ['vox-1', 62, 1983, 839],
  ['vox-2', 64, 3840, 1920],
]);
usePianoRollStore.getState().importNotes(notes, 120);
const roll = usePianoRollStore.getState();
const secPerTick = 60 / roll.bpm / PPQ;
const halfTick = secPerTick / 2;
[...roll.notes]
  .sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0))
  .forEach((n, i) => {
    assert.ok(Math.abs((n.tick ?? -1) * secPerTick - heard[i].startMs / 1000) <= halfTick, `note ${i} plays where it was sung`);
    assert.ok(Math.abs(((n.tick ?? 0) + (n.ticks ?? 0)) * secPerTick - heard[i].endMs / 1000) <= 2 * halfTick, `note ${i} ends where it was sung`);
  });

console.log('vocalToMidi tests passed');
