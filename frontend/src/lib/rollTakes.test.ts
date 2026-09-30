/**
 * lib/rollTakes: the MIDI tab's LOAD and REC hand a take to the roll through
 * importTake and placeTake, with the arguments MidiPanel passes them. The roll
 * then plays each note at tick / PPQ beats at its own BPM, which is what these
 * check against the seconds the notes were heard at.
 *
 * Before these existed MidiPanel rounded every edge to the nearest 16th with a
 * one-step floor, and LOAD gave the roll a whole BPM while the artifact was
 * detected at a fractional one.
 */
import assert from 'node:assert/strict';
import { importTake, placeTake, takeRollBpm } from './rollTakes.ts';
import { artifactTake } from './takeNotes.ts';
import { PPQ, usePianoRollStore } from '../state/pianoRollStore.ts';
import type { ArtifactNote } from './vocalExport.ts';

/** The second the roll plays a tick at, at its current BPM. */
const secondOf = (tick: number): number => (tick / PPQ) * (60 / usePianoRollStore.getState().bpm);
/** Half a tick at `bpm`: as close as a whole tick can land to a second. */
const halfTick = (bpm: number): number => 0.5 / PPQ / (bpm / 60);

const HEARD: ArtifactNote[] = [
  { pitch: 60, start_ms: 0, end_ms: 480, velocity: 100 },
  { pitch: 64, start_ms: 20, end_ms: 480, velocity: 90 }, // a flam: 20 ms after the first
  { pitch: 67, start_ms: 540, end_ms: 800, velocity: 80 }, // 40 ms late
  { pitch: 72, start_ms: 1000, end_ms: 1062, velocity: 70 }, // a 32nd at 120 BPM
];

const assertAsHeard = (what: string, heard: readonly ArtifactNote[]): void => {
  const bpm = usePianoRollStore.getState().bpm;
  const notes = [...usePianoRollStore.getState().notes].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0) || a.note - b.note);
  assert.equal(notes.length, heard.length, `${what}: every note arrives`);
  notes.forEach((n, i) => {
    const h = heard[i];
    assert.ok(Math.abs(secondOf(n.tick ?? -1) - h.start_ms / 1000) <= halfTick(bpm), `${what}: note ${h.pitch} starts where it was heard`);
    assert.ok(Math.abs(secondOf((n.tick ?? 0) + (n.ticks ?? 0)) - h.end_ms / 1000) <= 2 * halfTick(bpm), `${what}: note ${h.pitch} ends where it was heard`);
  });
};

// MIDI tab REC: the roll at 120 BPM holds a longer pattern; the mic records
// 3.1 s, basic-pitch hears a played part, and MidiPanel calls
// placeTake(artifactTake(notes), elapsedSec, 'art').
{
  const roll = usePianoRollStore.getState();
  roll.setBpm(120);
  roll.importNotes([{ id: 'old', note: 40, step: 300, length: 4, velocity: 100 }], 120);
  const gridBefore = usePianoRollStore.getState().totalSteps;
  const placed = placeTake(artifactTake(HEARD), 3.1, 'art');
  assert.equal(placed, HEARD.length);
  assertAsHeard('REC', HEARD);
  const notes = [...usePianoRollStore.getState().notes].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0) || a.note - b.note);
  assert.equal(notes[1].tick, 38, 'the flam lands 38 ticks after the first note');
  assert.equal(notes[3].ticks, 119, 'the 32nd is 119 ticks long, half a 16th');
  assert.equal(usePianoRollStore.getState().bpm, 120, 'REC keeps the roll tempo');
  assert.ok(usePianoRollStore.getState().totalSteps >= Math.min(gridBefore, 256), 'the grid does not shrink for a short take');
  // 3.1 s at 120 BPM is 24.8 16ths: the recorded span ends in the 25th.
  assert.deepEqual(usePianoRollStore.getState().recordedRange, { startStep: 0, endStep: 25 });
}

// MIDI tab LOAD: a vocal artifact detected at 97.6 BPM. MidiPanel calls
// importTake(artifactTake(doc.notes), doc.timing?.tempo_bpm ?? 0, 'art'). The
// roll takes 97.6 and each note plays at the second it was sung at, three
// minutes in as at the start.
{
  const sung: ArtifactNote[] = [
    { pitch: 57, start_ms: 1234, end_ms: 1500, velocity: 90 },
    { pitch: 59, start_ms: 60_050, end_ms: 60_400, velocity: 90 },
    { pitch: 60, start_ms: 180_020, end_ms: 181_000, velocity: 90 },
  ];
  const doc = { notes: sung, timing: { tempo_bpm: 97.6 } };
  const bpm = importTake(artifactTake(doc.notes), doc.timing?.tempo_bpm ?? 0, 'art');
  assert.equal(bpm, 97.6);
  assert.equal(usePianoRollStore.getState().bpm, 97.6, 'the roll plays at the tempo the artifact was detected at');
  assertAsHeard('LOAD', sung);
  assert.ok(usePianoRollStore.getState().notes.every((n) => n.id.startsWith('art-')));
}

// LOAD of an artifact with no tempo keeps the roll's tempo; a tempo past the
// roll's range is held to the app's 20-300.
{
  usePianoRollStore.getState().setBpm(133.5);
  const doc: { notes: ArtifactNote[]; timing?: { tempo_bpm?: number } } = { notes: HEARD };
  assert.equal(importTake(artifactTake(doc.notes), doc.timing?.tempo_bpm ?? 0, 'art'), 133.5);
  assert.equal(usePianoRollStore.getState().bpm, 133.5);
  assertAsHeard('LOAD at the roll tempo', HEARD);
  assert.equal(takeRollBpm(Number.NaN), 133.5);
  assert.equal(takeRollBpm(300), 300);
  assert.equal(takeRollBpm(20), 20);
  assert.equal(takeRollBpm(420), 300);
  assert.equal(takeRollBpm(12), 20);
}

console.log('rollTakes tests passed');
