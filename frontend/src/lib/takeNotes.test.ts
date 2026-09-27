/**
 * lib/takeNotes: a take in seconds becomes roll notes at the ticks it was
 * played or heard on (960 to the quarter), never snapped to 16ths.
 *
 * The sequences replayed here are the MIDI tab's: REC hands basic-pitch's notes
 * to placeRecording at the roll's tempo, and loading a vocal artifact hands its
 * melody to importNotes at the artifact's tempo. The roll then plays each note
 * at tick / PPQ beats at its own BPM, which is what these check against the
 * seconds the notes were heard at.
 */
import assert from 'node:assert/strict';
import { artifactTake, artifactToRoll, takeToRoll } from './takeNotes.ts';
import { importedRollBpm, PPQ, usePianoRollStore } from '../state/pianoRollStore.ts';
import type { ArtifactNote } from './vocalExport.ts';

/** The second the roll plays a tick at, at its current BPM. */
const secondOf = (tick: number): number => (tick / PPQ) * (60 / usePianoRollStore.getState().bpm);
/** Half a tick at `bpm`: as close as a whole tick can land to a second. */
const halfTick = (bpm: number): number => 0.5 / PPQ / (bpm / 60);

// The conversion. At 100 BPM a tick is 1/1600 s and a 16th is 240 ticks.
{
  const { rollNotes, totalSteps } = takeToRoll(
    [
      { note: 60, velocity: 100, startSec: 10.2, endSec: 10.29 }, // 320 ticks in, 144 long
      { note: 64.4, velocity: 90.6, startSec: 10.25, endSec: 10.8 }, // rounded pitch and velocity
      { note: 67, velocity: 70, startSec: 11, endSec: 11 }, // a tap: one tick
    ],
    { bpm: 100, originSec: 10, idPrefix: 'mc' },
  );
  assert.deepEqual(
    rollNotes.map((n) => [n.id, n.note, n.velocity, n.tick, n.ticks, n.step, n.length]),
    [
      ['mc-0', 60, 100, 320, 144, 320 / 240, 144 / 240],
      ['mc-1', 64, 91, 400, 880, 400 / 240, 880 / 240],
      ['mc-2', 67, 70, 1600, 1, 1600 / 240, 1 / 240],
    ],
  );
  assert.equal(totalSteps, 7, 'the grid runs to the 16th after the last end (1601 ticks)');

  // A note that starts before the origin keeps the part after it.
  const early = takeToRoll([{ note: 60, velocity: 100, startSec: 9.5, endSec: 10.5 }], { bpm: 100, originSec: 10 });
  assert.deepEqual(early.rollNotes.map((n) => [n.tick, n.ticks]), [[0, 800]]);
  // No notes, no grid; a note with no finite time is left out; a bad BPM is 120.
  assert.deepEqual(takeToRoll([], { bpm: 100 }), { rollNotes: [], totalSteps: 0 });
  assert.equal(takeToRoll([{ note: 60, velocity: 100, startSec: Number.NaN, endSec: 1 }], { bpm: 100 }).rollNotes.length, 0);
  assert.equal(takeToRoll([{ note: 60, velocity: 100, startSec: 0.5, endSec: 1 }], { bpm: 0 }).rollNotes[0].tick, 960);
  // Out-of-range values are clamped; a velocity that is not a number is 100.
  const clamped = takeToRoll([{ note: 300, velocity: Number.NaN, startSec: 0, endSec: 1 }], { bpm: 120 }).rollNotes[0];
  assert.deepEqual([clamped.note, clamped.velocity], [127, 100]);
  // Artifact notes are milliseconds.
  assert.deepEqual(artifactTake([{ pitch: 62, start_ms: 250, end_ms: 400, velocity: 80 }]), [
    { note: 62, velocity: 80, startSec: 0.25, endSec: 0.4 },
  ]);
}

// MIDI tab REC: basic-pitch hears a played part (a flam, a late note, a 32nd)
// and placeRecording writes it at the roll's tempo. Every note plays at the
// second it was heard at, to within half a tick. Snapped to the nearest 16th
// with a one-step floor, the flam's two notes became one step apart, the late
// note moved to the beat and the 32nd doubled in length.
{
  const roll = usePianoRollStore.getState();
  roll.setBpm(120);
  const heard: ArtifactNote[] = [
    { pitch: 60, start_ms: 0, end_ms: 480, velocity: 100 },
    { pitch: 64, start_ms: 20, end_ms: 480, velocity: 90 }, // a flam: 20 ms after the first
    { pitch: 67, start_ms: 540, end_ms: 800, velocity: 80 }, // 40 ms late
    { pitch: 72, start_ms: 1000, end_ms: 1062, velocity: 70 }, // a 32nd at 120 BPM
  ];
  const bpm = usePianoRollStore.getState().bpm;
  usePianoRollStore.getState().placeRecording(artifactToRoll(heard, bpm, 'art').rollNotes, { startStep: 0, endStep: 16 });
  const notes = [...usePianoRollStore.getState().notes].sort((a, b) => a.note - b.note);
  assert.equal(notes.length, heard.length);
  notes.forEach((n, i) => {
    const h = heard[i];
    assert.ok(Math.abs(secondOf(n.tick ?? -1) - h.start_ms / 1000) <= halfTick(bpm), `note ${h.pitch} starts where it was heard`);
    assert.ok(Math.abs(secondOf((n.tick ?? 0) + (n.ticks ?? 0)) - h.end_ms / 1000) <= 2 * halfTick(bpm), `note ${h.pitch} ends where it was heard`);
  });
  assert.equal(notes[1].tick, 38, 'the flam lands 38 ticks after the first note');
  assert.equal(notes[3].ticks, 119, 'the 32nd is 119 ticks long, half a 16th');
}

// MIDI tab LOAD: a vocal artifact detected at 97.6 BPM. importNotes gives the
// roll a whole BPM (98), so the notes convert at 98 and each one plays at the
// second it was sung at. Converted at 97.6 and played at 98, the last note of a
// three-minute take landed 0.7 s early.
{
  const tempo = 97.6;
  const sung: ArtifactNote[] = [
    { pitch: 57, start_ms: 1234, end_ms: 1500, velocity: 90 },
    { pitch: 59, start_ms: 60_050, end_ms: 60_400, velocity: 90 },
    { pitch: 60, start_ms: 180_020, end_ms: 181_000, velocity: 90 },
  ];
  const bpm = importedRollBpm(tempo);
  usePianoRollStore.getState().importNotes(artifactToRoll(sung, bpm, 'art').rollNotes, bpm);
  assert.equal(usePianoRollStore.getState().bpm, 98);
  const notes = [...usePianoRollStore.getState().notes].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
  notes.forEach((n, i) => {
    assert.ok(Math.abs(secondOf(n.tick ?? -1) - sung[i].start_ms / 1000) <= halfTick(98), `note ${i} plays at the second it was sung at`);
  });
}

console.log('takeNotes tests passed');
