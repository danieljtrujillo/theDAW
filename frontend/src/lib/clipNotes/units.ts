/**
 * Time units for clip note operations.
 *
 * Piano-roll clips store their notes in *steps* — 16th notes counted from the
 * start of the clip — and carry the BPM they were authored at alongside
 * (`sourceBpm`). Everything in this directory therefore works in step space,
 * which is tempo-independent: re-quantizing a clip never has to know its BPM,
 * and a clip authored at 99 BPM behaves exactly like one authored at 120.
 *
 * BPM only enters when a caller speaks in wall-clock time ("nudge it 10ms
 * late"), and PPQ only enters when a caller speaks in MIDI ticks. Those two
 * conversions live here so nothing else has to repeat them.
 */
import type { SnapDivision } from '../../state/editorStore';

/** A step is a 16th note, a beat is a quarter note. */
export const STEPS_PER_BEAT = 4;

/** Pulses per quarter note, the tick resolution the MIDI import/export uses. */
export const PPQ = 480;

/** Seconds per step at a given tempo. */
export const stepToSec = (step: number, bpm: number): number =>
  (step / STEPS_PER_BEAT) * (60 / bpm);

/** Steps per second at a given tempo — the inverse of {@link stepToSec}. */
export const secToStep = (sec: number, bpm: number): number =>
  (sec * bpm * STEPS_PER_BEAT) / 60;

/** Milliseconds expressed as steps. Signed: a negative nudge stays negative. */
export const msToSteps = (ms: number, bpm: number): number =>
  secToStep(ms / 1000, bpm);

/** Steps expressed as milliseconds — the inverse of {@link msToSteps}. */
export const stepsToMs = (steps: number, bpm: number): number =>
  stepToSec(steps, bpm) * 1000;

/** MIDI ticks expressed as steps. Tempo-free: ticks are musical, not temporal. */
export const ticksToSteps = (ticks: number): number =>
  (ticks / PPQ) * STEPS_PER_BEAT;

/** Steps expressed as MIDI ticks — the inverse of {@link ticksToSteps}. */
export const stepsToTicks = (steps: number): number =>
  (steps / STEPS_PER_BEAT) * PPQ;

/**
 * The step just past the last note's end, or `floor` when that is later (0 by
 * default). A loop: `Math.max(...notes.map(...))` passes one argument per note
 * and throws "Maximum call stack size exceeded" at symphony-sized clips.
 */
export const noteEndStep = (notes: readonly { step: number; length: number }[], floor = 0): number => {
  let end = floor;
  for (const n of notes) end = Math.max(end, n.step + n.length);
  return end;
};

/**
 * Grid step for each snap division, in beats. Mirrors the table the timeline
 * editor snaps to (`SNAP_BEATS` in `state/editorStore.ts`) so the assistant and
 * the toolbar agree on what "1/8T" means. Triplets are 2/3 of the straight
 * value, a quintuplet 16th (Q) is a fifth of a beat and a septuplet 16th (S) a
 * seventh, dotted are 3/2, and '1/1' assumes 4/4 because the editor still has
 * no time-signature model.
 */
const DIVISION_BEATS: Record<Exclude<SnapDivision, 'off'>, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
  '1/64': 0.0625,
  '1/4T': 2 / 3,
  '1/8T': 1 / 3,
  '1/16T': 1 / 6,
  '1/32T': 1 / 12,
  '1/16Q': 1 / 5,
  '1/16S': 1 / 7,
  '1/4D': 1.5,
  '1/8D': 0.75,
  '1/16D': 0.375,
};

/**
 * The grid spacing of a snap division, in steps. Fractional for triplets — a
 * 1/8 triplet is 4/3 of a 16th — which is why every grid calculation in here is
 * float arithmetic rather than integer modulo.
 *
 * Returns 0 for 'off' (and for any unknown value, e.g. a hand-edited project
 * file); callers treat 0 as "no grid, leave it alone".
 */
export const divisionToSteps = (division: SnapDivision): number => {
  if (division === 'off') return 0;
  const beats = DIVISION_BEATS[division];
  if (!beats) return 0;
  return beats * STEPS_PER_BEAT;
};
