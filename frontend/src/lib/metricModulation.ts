/**
 * metricModulation — a new tempo from the tempo in force and a note-value
 * equation, the way a score writes a metric modulation: "dotted quarter =
 * quarter" means the new quarter note lasts as long as the old dotted quarter.
 *
 * Tempi are quarter notes a minute (lib/tempoMap), and every note value here is
 * its length in quarter notes, so the whole rule is one proportion. The old
 * value lasts `60 / old × before` seconds and the new one `60 / new × after`;
 * setting them equal gives
 *
 *     new = old × after / before
 *
 * where `before` is the value written left of the "=" (heard at the old tempo)
 * and `after` the one written right of it (at the new tempo). Dotted quarter =
 * quarter at 120 gives 120 × 1 / 1.5 = 80; quarter = dotted quarter gives 180.
 *
 * The tempo in force is the one just BEFORE the bar line the modulation starts
 * on: a tempo change already on that line is what the modulation replaces, and
 * a ramp that ends there has arrived at its last tempo. Fermatas are holds, not
 * tempi, and are left out.
 *
 * Pure, so node tests load it.
 */
import { clampTempoBpm, getTempoAtBeat, TEMPO_BPM_MAX, TEMPO_BPM_MIN, type TempoEvent } from './tempoMap';

/** A note value by its length in quarter notes. */
export interface NoteValue {
  id: string;
  label: string;
  quarters: number;
}

/** The values a modulation can equate, longest first: plain, dotted and tuplet values down to the 32nd. */
export const NOTE_VALUES: readonly NoteValue[] = Object.freeze([
  { id: 'whole', label: 'Whole', quarters: 4 },
  { id: 'dotted-half', label: 'Dotted half', quarters: 3 },
  { id: 'half', label: 'Half', quarters: 2 },
  { id: 'dotted-quarter', label: 'Dotted quarter', quarters: 1.5 },
  { id: 'half-triplet', label: 'Half triplet', quarters: 4 / 3 },
  { id: 'quarter', label: 'Quarter', quarters: 1 },
  { id: 'dotted-eighth', label: 'Dotted 8th', quarters: 0.75 },
  { id: 'quarter-triplet', label: 'Quarter triplet', quarters: 2 / 3 },
  { id: 'eighth', label: '8th', quarters: 0.5 },
  { id: 'eighth-quintuplet', label: '8th quintuplet', quarters: 0.4 },
  { id: 'dotted-sixteenth', label: 'Dotted 16th', quarters: 0.375 },
  { id: 'eighth-triplet', label: '8th triplet', quarters: 1 / 3 },
  { id: 'sixteenth', label: '16th', quarters: 0.25 },
  { id: 'sixteenth-quintuplet', label: '16th quintuplet', quarters: 0.2 },
  { id: 'sixteenth-sextuplet', label: '16th sextuplet', quarters: 1 / 6 },
  { id: 'sixteenth-septuplet', label: '16th septuplet', quarters: 1 / 7 },
  { id: 'thirty-second', label: '32nd', quarters: 0.125 },
]);

/** The value with `id`, or the quarter note for an id the list does not have. */
export const noteValue = (id: string): NoteValue =>
  NOTE_VALUES.find((v) => v.id === id) ?? (NOTE_VALUES.find((v) => v.id === 'quarter') as NoteValue);

/** The tempo after `bpm` with `before` (at the old tempo) = `after` (at the new one), unclamped. */
export const modulatedTempo = (bpm: number, before: NoteValue, after: NoteValue): number => (bpm * after.quarters) / before.quarters;

/**
 * The tempo in force just before `beat`, in quarter notes a minute: the
 * starting tempo at or before the first point, the arrival tempo of a ramp that
 * ends on `beat`, the ramp's value at `beat` when one runs through it, and
 * otherwise the last tempo point before `beat`.
 */
export function tempoInForceBefore(map: readonly TempoEvent[], beat: number): number {
  const tempi = map.filter((e) => !e.fermata && Number.isFinite(e.beat) && e.bpm > 0).sort((a, b) => a.beat - b.beat);
  if (!tempi.length) return getTempoAtBeat(null, 0);
  const before = tempi.filter((e) => e.beat < beat);
  if (!before.length) return tempi[0].bpm;
  const prev = before[before.length - 1];
  if (prev.curve !== 'linear') return prev.bpm;
  const next = tempi.find((e) => e.beat > prev.beat);
  if (!next) return prev.bpm;
  if (next.beat <= beat) return next.bpm;
  return getTempoAtBeat(tempi, beat);
}

/** A modulation ready to write into a tempo map. */
export interface MetricModulation {
  beat: number;
  /** The tempo in force before the bar line. */
  from: number;
  /** The new tempo, inside the app's 20..300 and to the hundredth. */
  bpm: number;
  /** True when the exact tempo lies outside 20..300 and was brought to its edge. */
  clamped: boolean;
  /** The exact tempo the equation gives. */
  exact: number;
}

/** The modulation at `beat` with `before` = `after`, from the tempo in force there. */
export function metricModulation(map: readonly TempoEvent[], beat: number, before: NoteValue, after: NoteValue): MetricModulation {
  const from = tempoInForceBefore(map, beat);
  const exact = modulatedTempo(from, before, after);
  const bpm = clampTempoBpm(Math.round(exact * 100) / 100);
  return { beat, from, bpm, clamped: exact < TEMPO_BPM_MIN || exact > TEMPO_BPM_MAX, exact };
}

/** The equation in words: "Dotted quarter = Quarter". */
export const equationText = (before: NoteValue, after: NoteValue): string => `${before.label} = ${after.label}`;
