/**
 * One note at a time: a part reduced to a single line, so no two notes ever
 * sound together.
 *
 * Aimed at a transcription of a line an instrument plays one note at a time
 * (a sung melody, a bass line, a lead) that the transcriber heard as chords:
 * a harmonic under the voice, a string ringing on under the next note, two
 * guesses at one pitch. `keep` says which note wins where two overlap:
 *
 * - 'top': the higher note, the melody's line. A lower note that starts while
 *   a higher one sounds is dropped; a higher one cuts the note under it at its
 *   start.
 * - 'bottom': the lower note, the bass line, the same way down.
 * - 'latest': the note that starts last, as a monophonic synth plays: each
 *   note cuts the one before it at its start.
 *
 * Notes that start together are one choice: the highest for 'top' and
 * 'latest', the lowest for 'bottom'. A note that is cut keeps at least one
 * tick. Works on ticks (the store's `tick`/`ticks`, else `step`/`length` on the
 * roll's 16ths) and writes `step`/`length` from the ticks, as the store holds
 * them. Returns new notes, ids kept, in start order, and how many were
 * dropped and shortened.
 */
import type { PianoNote } from '../../state/pianoRollStore';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from '../noteClock';

export type OneAtATimeKeep = 'top' | 'bottom' | 'latest';

export interface OneAtATimeResult {
  notes: PianoNote[];
  /** Notes left out because another note won where they sounded. */
  dropped: number;
  /** Notes cut short where a later note took over. */
  shortened: number;
}

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const startOf = (n: PianoNote): number => (isNum(n.tick) ? n.tick : Math.round((isNum(n.step) ? n.step : 0) * TICKS_PER_STEP));
const lengthOf = (n: PianoNote): number => Math.max(MIN_NOTE_TICKS, isNum(n.ticks) ? n.ticks : Math.round((isNum(n.length) ? n.length : 1) * TICKS_PER_STEP));

/** `n` cut to `ticks` long, its step view written from its ticks. */
const cut = (n: PianoNote, start: number, ticks: number): PianoNote => ({
  ...n,
  tick: start,
  ticks,
  step: start / TICKS_PER_STEP,
  length: ticks / TICKS_PER_STEP,
});

export function oneAtATime(notes: readonly PianoNote[], keep: OneAtATimeKeep): OneAtATimeResult {
  // Start order; at one start, the note `keep` prefers first.
  const prefer = (a: PianoNote, b: PianoNote): number => (keep === 'bottom' ? a.note - b.note : b.note - a.note) || b.velocity - a.velocity;
  const order = [...notes].sort((a, b) => startOf(a) - startOf(b) || prefer(a, b));
  const out: PianoNote[] = [];
  let dropped = 0;
  const shortened = new Set<string>();
  for (let i = 0; i < order.length; i += 1) {
    const n = order[i];
    const start = startOf(n);
    const prev = out[out.length - 1];
    // A note that starts with the one just kept lost the choice at that start.
    if (prev && startOf(prev) === start) {
      dropped += 1;
      continue;
    }
    if (prev) {
      const prevStart = startOf(prev);
      const prevEnd = prevStart + lengthOf(prev);
      if (prevEnd > start) {
        const wins = keep === 'latest' || (keep === 'top' ? n.note > prev.note : n.note < prev.note);
        if (!wins) {
          dropped += 1;
          continue;
        }
        out[out.length - 1] = cut(prev, prevStart, Math.max(MIN_NOTE_TICKS, start - prevStart));
        shortened.add(prev.id);
      }
    }
    out.push({ ...n, tick: start, ticks: lengthOf(n), step: start / TICKS_PER_STEP, length: lengthOf(n) / TICKS_PER_STEP });
  }
  return { notes: out, dropped, shortened: shortened.size };
}
