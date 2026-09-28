/**
 * Virtuoso writes into the roll part its source phrase came from.
 *
 * The sequence: a phrase in the first part, CAPTURE, a second part added and
 * edited, then a Virtuoso slider moved and RESET pressed. Without the part
 * recorded with the source, the slider poured the first part's phrase into
 * the second part and wiped its notes.
 *
 *   cd frontend && npx tsx src/state/virtuosoParts.test.ts
 */
import assert from 'node:assert/strict';
import { rollTracksOf, usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { useVirtuosoStore } from './virtuosoStore.ts';

const roll = () => usePianoRollStore.getState();
const n = (step: number, note: number): PianoNote => ({ id: `v${step}-${note}`, note, step, length: 2, velocity: 90 });

roll().importParts([{ name: 'Piano', notes: [n(0, 60), n(2, 64), n(4, 67), n(6, 72)] }, { name: 'Bass', notes: [n(0, 36)] }], 120);
const [piano, bass] = roll().tracks.map((t) => t.id);
roll().setActiveTrack(piano);
useVirtuosoStore.getState().captureSource();

// Turn to the bass and add a note: the bass holds two notes.
roll().setActiveTrack(bass);
roll().addNote({ note: 43, step: 8, length: 2, velocity: 90 });
assert.equal(roll().notes.length, 2);

// A slider moves: the rendered phrase goes into the piano part, and the roll turns to it.
useVirtuosoStore.getState().setAmount('harmony', 0.8);
assert.equal(roll().activeTrackId, piano, 'the roll turns to the part the phrase came from');
const parts = rollTracksOf(roll());
assert.equal(parts[1].notes.length, 2, 'the bass keeps its two notes');
assert.ok(parts[0].notes.length >= 4, 'the piano holds the rendered phrase');

// RESET, from the bass again: the source phrase goes back into the piano part.
roll().setActiveTrack(bass);
useVirtuosoStore.getState().resetToSource();
assert.equal(roll().activeTrackId, piano);
assert.deepEqual(rollTracksOf(roll())[0].notes.map((x) => x.note), [60, 64, 67, 72], 'the piano has its phrase back');
assert.equal(rollTracksOf(roll())[1].notes.length, 2, 'the bass is untouched');

console.log('virtuosoParts: ok');
