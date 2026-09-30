/**
 * Shift clip notes in time.
 *
 * Three units, because the three callers think in three different ones: the
 * grid thinks in steps, a human fixing latency thinks in milliseconds, and an
 * imported MIDI file thinks in ticks. Exactly one may be given per call — a
 * request carrying two is a caller bug, and guessing which one was meant would
 * silently move somebody's clip to the wrong place.
 */
import type { PianoNote } from '../../state/pianoRollStore';
import { msToSteps, ticksToSteps } from './units';

export interface NudgeOptions {
  /** Shift in 16th-note steps. */
  steps?: number;
  /** Shift in milliseconds. Requires `bpm`. */
  ms?: number;
  /** Tempo for the `ms` conversion. */
  bpm?: number;
  /** Shift in MIDI ticks at PPQ 480. */
  ticks?: number;
}

/**
 * Resolve the requested shift to steps. Throws when the caller gave zero or
 * more than one unit, or milliseconds without a tempo.
 */
const shiftInSteps = (options: NudgeOptions): number => {
  const given = (['steps', 'ms', 'ticks'] as const).filter(
    (key) => options[key] !== undefined,
  );
  if (given.length !== 1) {
    throw new TypeError(
      `nudgeNotes: expected exactly one of steps/ms/ticks, got ${
        given.length === 0 ? 'none' : given.join(' and ')
      }`,
    );
  }
  if (options.ms !== undefined) {
    if (options.bpm === undefined || !(options.bpm > 0)) {
      throw new TypeError('nudgeNotes: ms requires a positive bpm');
    }
    return msToSteps(options.ms, options.bpm);
  }
  if (options.ticks !== undefined) return ticksToSteps(options.ticks);
  return options.steps as number;
};

/**
 * Move every note by the same amount, clamped so nothing is pushed before the
 * start of the clip. Returns a new array of new notes, ids preserved.
 */
export function nudgeNotes(
  notes: readonly PianoNote[],
  options: NudgeOptions,
): PianoNote[] {
  const delta = shiftInSteps(options);
  return notes.map((note) => ({ ...note, step: Math.max(0, note.step + delta) }));
}
