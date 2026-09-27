/**
 * The vocal2midi column's notes into theDAW's piano roll (pianoRollStore).
 *
 * vocal2midi keeps its notes in seconds and quantises them itself when its
 * Quantize setting asks (1/4 to 1/32, or off), so the roll takes them at the
 * ticks they arrive on (lib/takeNotes), never snapped to 16ths: a 1/32 or an
 * unquantised take stays one in the roll, and APPLY there quantises further.
 * The notes and the slides convert at the tempo importNotes gives the roll (a
 * whole BPM), so each note plays at the second it was sung at.
 */
import { importedRollBpm, usePianoRollStore } from '../../../state/pianoRollStore';
import { takeToRoll, type TakeNote } from '../../../lib/takeNotes';
import { V2M_BEND_RANGE, slideBendPoints } from './audioProcessing';
import type { NoteEvent } from './types';

/** vocal2midi's notes (a start and a duration in seconds) as a take. */
export const noteEventTake = (notes: readonly NoteEvent[]): TakeNote[] =>
  notes.map((n) => ({ note: n.midiNote, velocity: n.velocity, startSec: n.startTime, endSec: n.startTime + n.duration }));

/**
 * Replace the roll's notes with vocal2midi's, at `atBpm` (the roll keeps its
 * own tempo when `atBpm` is not a positive number). With `withSlides`, the
 * slides the MIDI export writes go to the roll's lane A at the range that
 * export assumes, and every other lane's points go and keep their range; with
 * no slides, importNotes clears every lane's points itself. Returns the tempo
 * the roll plays the notes at.
 */
export function applyVocalNotesToRoll(notes: readonly NoteEvent[], atBpm: number, withSlides: boolean): number {
  const roll = usePianoRollStore.getState();
  const bpm = importedRollBpm(Number.isFinite(atBpm) && atBpm > 0 ? atBpm : roll.bpm);
  const points = withSlides ? slideBendPoints([...notes], bpm) : [];
  const bends = points.length
    ? [...roll.bends.filter((b) => b.lane !== 0).map((b) => ({ ...b, points: [] })), { lane: 0, range: V2M_BEND_RANGE, points }]
    : undefined;
  roll.importNotes(takeToRoll(noteEventTake(notes), { bpm, idPrefix: 'v2m' }).rollNotes, bpm, undefined, bends);
  return bpm;
}
