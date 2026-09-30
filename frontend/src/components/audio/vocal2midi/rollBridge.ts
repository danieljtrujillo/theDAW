/**
 * The vocal2midi column's notes into theDAW's piano roll (pianoRollStore).
 *
 * vocal2midi keeps its notes in seconds and quantises them itself when its
 * Quantize setting asks (1/4 to 1/32, or off), at its own BPM, so the roll
 * takes them at the ticks they arrive on (lib/rollTakes), never snapped to
 * 16ths: a 1/32 or an unquantised take stays one in the roll, and APPLY there
 * quantises further. The roll takes the column's BPM with its fraction (a
 * detected 97.3 stays 97.3), so each note plays at the second it was sung at
 * and a quantised note sits on its grid line.
 */
import { otherPartsHoldNotes, usePianoRollStore } from '../../../state/pianoRollStore';
import { logWarn } from '../../../state/logStore';
import { importTake, takeRollBpm } from '../../../lib/rollTakes';
import type { TakeNote } from '../../../lib/takeNotes';
import { V2M_BEND_RANGE, slideBendPoints } from './audioProcessing';
import type { NoteEvent } from './types';

/** vocal2midi's notes (a start and a duration in seconds) as a take. */
export const noteEventTake = (notes: readonly NoteEvent[]): TakeNote[] =>
  notes.map((n) => ({ note: n.midiNote, velocity: n.velocity, startSec: n.startTime, endSec: n.startTime + n.duration }));

/**
 * Replace the notes of the part being edited with vocal2midi's, at `atBpm`
 * (the roll keeps its own tempo when `atBpm` is not a positive number). With
 * `withSlides`, the slides the MIDI export writes go to the roll's lane A at
 * the range that export assumes, and every other lane's points go and keep
 * their range; with no slides, importNotes clears every lane's points itself.
 * Returns the tempo the roll plays the notes at.
 *
 * In a roll whose other parts hold notes, the roll keeps its tempo map and its
 * bends, which every part plays by (lib/rollTakes importTake): the notes
 * convert through the roll's map, and slides asked for are left out with a
 * line in the log saying why.
 */
export function applyVocalNotesToRoll(notes: readonly NoteEvent[], atBpm: number, withSlides: boolean): number {
  const roll = usePianoRollStore.getState();
  const shared = otherPartsHoldNotes(roll);
  const bpm = takeRollBpm(atBpm);
  if (withSlides && shared) {
    logWarn('vocal', "The slides were not written to the roll: its pitch bends belong to every part, and other parts hold notes");
  }
  const points = withSlides && !shared ? slideBendPoints([...notes], bpm) : [];
  const bends = points.length
    ? [...roll.bends.filter((b) => b.lane !== 0).map((b) => ({ ...b, points: [] })), { lane: 0, range: V2M_BEND_RANGE, points }]
    : undefined;
  return importTake(noteEventTake(notes), bpm, 'v2m', bends);
}
