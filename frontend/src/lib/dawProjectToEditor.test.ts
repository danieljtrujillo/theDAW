/**
 * An imported DAW project's MIDI clip opens in the piano roll at the ticks its
 * notes sit on. The importer's notes arrive in seconds; the roll copy rounded
 * each edge to the nearest 16th with a one-step floor, so a triplet part, a
 * swung part or a 32nd fill came into theDAW quantised.
 *
 * The sequence replayed: an eighth-note triplet and a 32nd at 90 BPM, as
 * notesFromDawClip hands them over (seconds), through pianoNotesFromRenderNotes
 * and into the roll the way "Edit in Piano Roll" opens a clip.
 */
import assert from 'node:assert/strict';
import { pianoNotesFromRenderNotes } from './dawProjectToEditor.ts';
import { PPQ, usePianoRollStore } from '../state/pianoRollStore.ts';
import type { RenderNote } from './midiSynth.ts';

const beat = 60 / 90;
const notes: RenderNote[] = [
  // An eighth-note triplet: three notes a third of a beat apart (320 ticks).
  { midi: 60, velocity: 100, startSec: 0, durationSec: beat / 3 },
  { midi: 62, velocity: 100, startSec: beat / 3, durationSec: beat / 3 },
  { midi: 64, velocity: 100, startSec: (2 * beat) / 3, durationSec: beat / 3 },
  // A 32nd on beat 2 (120 ticks).
  { midi: 67, velocity: 80, startSec: beat, durationSec: beat / 8 },
];

const { rollNotes, totalSteps } = pianoNotesFromRenderNotes(notes, 90);
assert.deepEqual(
  rollNotes.map((n) => [n.note, n.tick, n.ticks]),
  [
    [60, 0, 320],
    [62, 320, 320],
    [64, 640, 320],
    [67, 960, 120],
  ],
  'each note at its own tick, the triplet a third of a beat apart',
);
assert.equal(totalSteps, 16, 'the grid is at least 16 steps');
assert.deepEqual(rollNotes.map((n) => n.id), ['als-note-0', 'als-note-1', 'als-note-2', 'als-note-3']);

usePianoRollStore.getState().loadFromClip('als-clip', rollNotes, 90, totalSteps);
const opened = usePianoRollStore.getState().notes;
assert.deepEqual(
  opened.map((n) => [n.tick, n.ticks]),
  [
    [0, 320],
    [320, 320],
    [640, 320],
    [960, 120],
  ],
  'the roll holds the triplet and the 32nd as the project wrote them',
);
const secPerTick = beat / PPQ;
opened.forEach((n, i) => {
  assert.ok(Math.abs((n.tick ?? 0) * secPerTick - notes[i].startSec) <= secPerTick / 2, `note ${i} plays at its second`);
});

// A clip of 150,000 notes imports. The grid length was
// Math.max(16, ...notes.map(end)), which passes every note as an argument, and
// V8 throws a RangeError past about 125,000 of them.
{
  const many: RenderNote[] = [];
  for (let i = 0; i < 150_000; i += 1) many.push({ midi: 48 + (i % 24), velocity: 90, startSec: i * 0.01, durationSec: 0.02 });
  const big = pianoNotesFromRenderNotes(many, 120);
  assert.equal(big.rollNotes.length, 150_000);
  let end = 0;
  for (const n of big.rollNotes) end = Math.max(end, (n.tick ?? 0) + (n.ticks ?? 0));
  assert.equal(big.totalSteps, Math.ceil(end / 240), 'the grid runs to the 16th after the last note ends');
}

console.log('dawProjectToEditor tests passed');
