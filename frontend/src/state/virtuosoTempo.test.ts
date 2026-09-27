/**
 * Virtuoso's SONG build writes its notes and meter into the roll at the roll's
 * tempo, and leaves the roll's tempo map as it was: a slow introduction and a
 * ritardando drawn in the TEMPO lane are still there after the build, and
 * RESET puts the source phrase back with the map untouched.
 * Run from `frontend/`:
 *   npx tsx src/state/virtuosoTempo.test.ts
 */
import assert from 'node:assert/strict';
import { useVirtuosoStore } from './virtuosoStore.ts';
import { usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import type { TempoEvent } from '../lib/tempoMap.ts';

const roll = () => usePianoRollStore.getState();
const MAP: TempoEvent[] = [{ beat: 0, bpm: 56 }, { beat: 8, bpm: 120 }, { beat: 24, bpm: 120, curve: 'linear' }, { beat: 32, bpm: 72 }];
const phrase: PianoNote[] = [0, 2, 4, 5, 7, 9, 11, 12].map((d, i) => ({ id: `p${i}`, note: 60 + d, step: i * 2, length: 2, velocity: 90 }));

roll().importNotes(phrase, 56, undefined, [], MAP);
const before = roll().tempoMap;
useVirtuosoStore.setState({ sections: null, style: 'romantic', songMode: false, source: null });
useVirtuosoStore.getState().captureSource();
useVirtuosoStore.getState().buildSong();
assert.ok(roll().notes.length > phrase.length, 'the song was built into the roll');
assert.deepEqual(roll().tempoMap, before, 'the tempo map is the one the roll had');
assert.equal(roll().bpm, 56);
useVirtuosoStore.getState().resetToSource();
assert.deepEqual(roll().tempoMap, before);
console.log('virtuosoTempo: ok');
