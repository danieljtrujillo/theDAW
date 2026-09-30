/**
 * Pure note operations for editor clips.
 *
 * Timeline clips bounced from the piano roll keep their notes as `PianoNote[]`
 * (`sourcePianoRoll`) plus the tempo they were authored at (`sourceBpm`), so
 * every musical edit the assistant is asked for — quantize, nudge, transpose,
 * velocity, humanize, overlap repair, junk removal — can be done on the notes
 * and re-bounced, instead of being faked with audio processing.
 *
 * Everything here is side-effect free: no React, no stores, no I/O. Each
 * function takes notes and options and returns new arrays of new notes with the
 * ids preserved, so callers can diff, undo, or discard the result freely.
 */
export {
  PPQ,
  STEPS_PER_BEAT,
  divisionToSteps,
  msToSteps,
  noteEndStep,
  secToStep,
  stepToSec,
  stepsToMs,
  stepsToTicks,
  ticksToSteps,
} from './units';

export { MIN_NOTE_STEPS, quantizeNotes } from './quantize';
export type { QuantizeOptions } from './quantize';

export { nudgeNotes } from './nudge';
export type { NudgeOptions } from './nudge';

export { MAX_PITCH, MIN_PITCH, transposeNotes } from './transpose';

export { MAX_VELOCITY, MIN_VELOCITY, scaleVelocity } from './velocity';
export type { VelocityOptions } from './velocity';

export { buildExpression, inferHairpins, readPhrases, readSlurs, withExpressionControls } from './expression';
export type { ExpressionOptions, ExpressionResult, Hairpin, Phrase, Slur } from './expression';

export { humanizeNotes, humanizeSections } from './humanize';
export type { HumanizeOptions, HumanizePart, HumanizedNote, SectionHumanizeOptions, TimedPartNote } from './humanize';

export { fixOverlaps } from './overlaps';
export type { OverlapMode, OverlapOptions } from './overlaps';

export { filterNotes } from './filter';
export type { FilterOptions, FilterResult } from './filter';

export { oneAtATime } from './oneAtATime';
export type { OneAtATimeKeep, OneAtATimeResult } from './oneAtATime';
