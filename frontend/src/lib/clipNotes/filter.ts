/**
 * Strip junk notes out of a clip.
 *
 * Aimed at transcription output (vocal2midi, basic-pitch): those produce
 * millisecond-long blips where a consonant was, near-silent notes where the
 * pitch tracker was unsure, sub-bass and whistle-register artifacts outside the
 * range anything actually sang, and the occasional lone note stranded seconds
 * away from the part. Each threshold is off unless the caller sets it, and both
 * halves come back so the assistant can say what it threw away.
 */
import type { PianoNote } from '../../state/pianoRollStore';

export interface FilterOptions {
  /** Drop notes shorter than this many steps. */
  minLengthSteps?: number;
  /** Drop notes quieter than this velocity. */
  minVelocity?: number;
  /** Drop notes below this MIDI pitch. */
  minPitch?: number;
  /** Drop notes above this MIDI pitch. */
  maxPitch?: number;
  /**
   * Drop notes stranded this many steps from every other note — measured as the
   * gap back to the furthest end reached by any earlier note, and forward to
   * the next note's start. A note with no neighbours at all (a one-note clip)
   * is never stranded.
   */
  maxGapSteps?: number;
}

export interface FilterResult {
  kept: PianoNote[];
  removed: PianoNote[];
}

/**
 * Returns copies of the surviving and discarded notes, each in the input order;
 * ids preserved. Thresholds are applied first, then the gap test, so a stray
 * that was already removed for being too quiet cannot make its neighbour look
 * stranded.
 */
export function filterNotes(
  notes: readonly PianoNote[],
  options: FilterOptions,
): FilterResult {
  const passesThresholds = (note: PianoNote): boolean => {
    if (options.minLengthSteps !== undefined && note.length < options.minLengthSteps) {
      return false;
    }
    if (options.minVelocity !== undefined && note.velocity < options.minVelocity) {
      return false;
    }
    if (options.minPitch !== undefined && note.note < options.minPitch) return false;
    if (options.maxPitch !== undefined && note.note > options.maxPitch) return false;
    return true;
  };

  const doomed = new Set<number>();
  const survivors: number[] = [];
  notes.forEach((note, index) => {
    if (passesThresholds(note)) survivors.push(index);
    else doomed.add(index);
  });

  const maxGap = options.maxGapSteps;
  if (maxGap !== undefined && survivors.length > 1) {
    const order = [...survivors].sort(
      (a, b) => notes[a].step - notes[b].step || a - b,
    );
    // The furthest point anything earlier has reached. Measuring against the
    // immediately preceding note's end instead would call a melody note
    // stranded just because the note that started before it was a short grace,
    // even while a pad underneath is still sounding.
    let maxEnd = -Infinity;
    order.forEach((index, position) => {
      const note = notes[index];
      const after = position < order.length - 1 ? notes[order[position + 1]] : null;
      const gapBefore = position > 0 ? note.step - maxEnd : Infinity;
      const gapAfter = after ? after.step - (note.step + note.length) : Infinity;
      if (Math.min(gapBefore, gapAfter) > maxGap) doomed.add(index);
      maxEnd = Math.max(maxEnd, note.step + note.length);
    });
  }

  const kept: PianoNote[] = [];
  const removed: PianoNote[] = [];
  notes.forEach((note, index) => {
    (doomed.has(index) ? removed : kept).push({ ...note });
  });

  return { kept, removed };
}
