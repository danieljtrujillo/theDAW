/**
 * lib/takeNotes: a take in seconds becomes roll notes at the ticks it was
 * played or heard on (960 to the quarter), never snapped to 16ths. The MIDI
 * tab's REC and LOAD, which hand those notes to the roll, are replayed in
 * lib/rollTakes.test.ts.
 */
import assert from 'node:assert/strict';
import { artifactTake, takeToRoll } from './takeNotes.ts';

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

console.log('takeNotes tests passed');
