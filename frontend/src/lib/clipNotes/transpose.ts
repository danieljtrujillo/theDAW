/**
 * Transpose clip notes by semitones.
 *
 * Clamps rather than wraps: a note pushed past the top of the MIDI range should
 * stay the highest note in the clip, not reappear eight octaves down.
 */
import type { PianoNote } from '../../state/pianoRollStore';

export const MIN_PITCH = 0;
export const MAX_PITCH = 127;

/**
 * Shift every pitch by `semitones`, clamped to 0–127. Returns a new array of
 * new notes, ids preserved.
 */
export function transposeNotes(
  notes: readonly PianoNote[],
  semitones: number,
): PianoNote[] {
  const shift = Math.round(semitones);
  return notes.map((note) => ({
    ...note,
    note: Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.round(note.note) + shift)),
  }));
}
