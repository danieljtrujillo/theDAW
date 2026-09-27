/**
 * rollTakes — a take in seconds written into the piano roll (pianoRollStore).
 *
 * lib/takeNotes turns a take into roll notes at a tempo; this module hands
 * them to the roll. Every place that writes a take calls one of these two: the
 * MIDI tab's LOAD and REC, the track menu's note detection and vocal melody
 * rows, and the vocal2midi column (vocal2midi/rollBridge).
 *
 * importTake keeps the take's own tempo, fraction and all (a detected 97.3
 * stays 97.3), so each note plays at the second it was heard at and a take
 * quantised at that tempo keeps every note on its grid line. placeTake keeps
 * the roll's tempo and converts at it. Neither quantises: APPLY does.
 */
import { importedRollBpm, usePianoRollStore } from '../state/pianoRollStore';
import type { LaneBend } from './pitchBend';
import { takeToRoll, type TakeNote } from './takeNotes';
import { stepClock } from './rollTempo';

/**
 * The tempo importTake gives the roll for a take at `bpm`: `bpm` held to
 * 20-300 (the app tempo range), or the roll's own tempo when `bpm` is not a positive number.
 */
export const takeRollBpm = (bpm: number): number =>
  importedRollBpm(Number.isFinite(bpm) && bpm > 0 ? bpm : usePianoRollStore.getState().bpm);

/**
 * Replace the roll's notes with `take` (importNotes fits the grid to it) at
 * `bpm`, the take converted to ticks at the tempo the roll then plays. `bends`
 * go to importNotes as they are. Returns that tempo.
 */
export function importTake(take: readonly TakeNote[], bpm: number, idPrefix: string, bends?: readonly LaneBend[]): number {
  const rollBpm = takeRollBpm(bpm);
  usePianoRollStore.getState().importNotes(takeToRoll(take, { bpm: rollBpm, idPrefix }).rollNotes, rollBpm, undefined, bends);
  return rollBpm;
}

/**
 * Place a recorded take `elapsedSec` long at the roll's own tempo, through its
 * tempo map when it changes tempo, marking the recorded span from step 0 to
 * the 16th the recording stopped in, without shrinking the grid
 * (placeRecording). Returns the number of notes placed.
 */
export function placeTake(take: readonly TakeNote[], elapsedSec: number, idPrefix: string): number {
  const roll = usePianoRollStore.getState();
  const clock = stepClock(roll.bpm, roll.tempoMap);
  const notes = takeToRoll(take, { bpm: roll.bpm, idPrefix, tempoMap: clock.map }).rollNotes;
  const endStep = Math.max(1, Math.ceil(clock.stepAt(Number.isFinite(elapsedSec) ? elapsedSec : 0)));
  roll.placeRecording(notes, { startStep: 0, endStep });
  return notes.length;
}
