/**
 * Resolve notes of the same pitch that collide in time.
 *
 * Monophonic synths and most samplers retrigger on a second note-on for a pitch
 * that is already sounding, so a transcribed or hand-drawn clip with stacked or
 * overlapping same-pitch notes plays back as stutters and stuck notes. The
 * three modes are the three things a musician actually wants done about it.
 */
import type { PianoNote } from '../../state/pianoRollStore';
import { MIN_NOTE_STEPS } from './quantize';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from '../noteClock';

/** The roll's shortest note, one tick, in steps. */
const ONE_TICK_STEPS = MIN_NOTE_TICKS / (PPQ / ROLL_STEPS_PER_BEAT);

export type OverlapMode =
  /** Extend (or shorten) each note so it runs exactly into the next of its pitch. */
  | 'legato'
  /** Only shorten: cut tails that run past the next onset of the same pitch. */
  | 'trim'
  /** Drop notes sharing a pitch and a start, keeping the loudest. */
  | 'dedupe';

export interface OverlapOptions {
  mode: OverlapMode;
}

/**
 * The start of the next note of the same pitch, per note index. `Infinity` when
 * a note is the last of its pitch — nothing to run into.
 *
 * Two notes sharing a pitch and a start are ordered by their position in the
 * input, so an exact stack still resolves deterministically (the earlier entry
 * collapses to {@link MIN_NOTE_STEPS}) instead of being left overlapping.
 */
const nextOnsetByIndex = (notes: readonly PianoNote[]): number[] => {
  const byPitch = new Map<number, number[]>();
  notes.forEach((note, index) => {
    const bucket = byPitch.get(note.note);
    if (bucket) bucket.push(index);
    else byPitch.set(note.note, [index]);
  });

  const next = new Array<number>(notes.length).fill(Infinity);
  for (const bucket of byPitch.values()) {
    bucket.sort((a, b) => notes[a].step - notes[b].step || a - b);
    for (let i = 0; i < bucket.length - 1; i += 1) {
      next[bucket[i]] = notes[bucket[i + 1]].step;
    }
  }
  return next;
};

/** Remove notes sharing a pitch and a start, keeping the loudest of each stack. */
const dedupe = (notes: readonly PianoNote[]): PianoNote[] => {
  const winners = new Map<string, number>();
  notes.forEach((note, index) => {
    const key = `${note.note}@${note.step}`;
    const held = winners.get(key);
    if (held === undefined || note.velocity > notes[held].velocity) {
      winners.set(key, index);
    }
  });
  const keep = new Set(winners.values());
  return notes.filter((_, index) => keep.has(index)).map((note) => ({ ...note }));
};

/**
 * Returns a new array of new notes in the input order, ids preserved. 'legato'
 * and 'trim' keep every note and run it exactly into the next onset of its
 * pitch, however close that onset is (down to the roll's one tick), so a fast
 * repeated-note run comes out with no overlap; only an exact stack, with no gap
 * at all, leaves {@link MIN_NOTE_STEPS}. Only 'dedupe' removes notes.
 */
export function fixOverlaps(
  notes: readonly PianoNote[],
  options: OverlapOptions,
): PianoNote[] {
  if (options.mode === 'dedupe') return dedupe(notes);

  const next = nextOnsetByIndex(notes);
  return notes.map((note, index) => {
    const onset = next[index];
    if (!Number.isFinite(onset)) return { ...note };
    if (options.mode === 'trim' && note.step + note.length <= onset) {
      return { ...note };
    }
    const gap = onset - note.step;
    return { ...note, length: gap > 0 ? Math.max(ONE_TICK_STEPS, gap) : MIN_NOTE_STEPS };
  });
}
