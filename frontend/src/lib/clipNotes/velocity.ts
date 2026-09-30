/**
 * Scale and shift clip note velocities.
 *
 * `factor` then `offset`, then squeezed into the caller's window, then clamped
 * to the legal MIDI range. The floor is 1 rather than 0 because a velocity-0
 * note is a note-off in MIDI: scaling a clip down should make it quieter, never
 * make notes vanish.
 */
import type { PianoNote } from '../../state/pianoRollStore';

export const MIN_VELOCITY = 1;
export const MAX_VELOCITY = 127;

export interface VelocityOptions {
  /** Multiplier applied first. Defaults to 1. */
  factor?: number;
  /** Added after the multiplier. Defaults to 0. */
  offset?: number;
  /** Lower bound for the result. Clamped into 1–127 itself. */
  min?: number;
  /** Upper bound for the result. Clamped into 1–127 itself. */
  max?: number;
}

/**
 * Returns a new array of new notes with adjusted, whole-number velocities; ids
 * preserved.
 */
export function scaleVelocity(
  notes: readonly PianoNote[],
  options: VelocityOptions,
): PianoNote[] {
  const factor = options.factor ?? 1;
  const offset = options.offset ?? 0;
  const floor = Math.max(MIN_VELOCITY, Math.min(MAX_VELOCITY, options.min ?? MIN_VELOCITY));
  const ceiling = Math.max(floor, Math.min(MAX_VELOCITY, options.max ?? MAX_VELOCITY));

  return notes.map((note) => {
    const scaled = Math.round(note.velocity * factor + offset);
    return { ...note, velocity: Math.max(floor, Math.min(ceiling, scaled)) };
  });
}
