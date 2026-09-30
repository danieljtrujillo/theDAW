/**
 * motif — motif cells and the classical ways of developing them.
 *
 * A cell is a short run of notes held relative to its own start: each note's
 * onset (`at`) and length in ticks at the roll's 960 PPQ (lib/noteClock), its
 * MIDI pitch and velocity. `length` runs from 0 to the cell's end, so a rest
 * after the last note belongs to the cell. `place` remembers where the cell
 * sat in the roll's meter map (lib/meterMap), which is what lets a cell be
 * realized pulse for pulse into another meter: a figure written on the
 * quarters of 4/4 lands on the group starts of 7/8 2+2+3.
 *
 * describeCell reads a cell's intervals (between successive melody notes, the
 * top note of each onset), its durations and onset gaps, and each note's
 * metric position: bar, pulse (meterMap's pulseLines: the group starts, the
 * dotted beats of a compound meter, else the beats) and the fraction of that
 * pulse the note starts at.
 *
 * Transforms, each pure and returning a new cell:
 *   transpose / transposeDiatonic — by semitones, or by steps of a scale
 *     (a chromatic note keeps its alteration from the degree below it);
 *   invert / invertDiatonic       — mirror about an axis pitch, chromatically
 *     or by scale degree (a diatonic cell stays in its scale);
 *   retrograde                    — the notes backwards inside the cell's length;
 *   augment / diminish            — every onset and length times or over a factor;
 *   fragment                      — the first or last n onsets (a chord is one onset);
 *   sequence                      — the cell, then n more statements, each a
 *     further interval away, laid end to end;
 *   liquidate                     — stages that drop the cell's features toward
 *     a cadence: its leaps become steps, it shrinks to its head, the head's
 *     rhythm plays on one pitch, and last one note is left.
 *
 * A ThemeRegistry keeps named themes (their cells, key and home section) so a
 * later section can recall a theme through a chain of transforms, including a
 * move to another key (`toKey`), which keeps each note's scale degree.
 *
 * Everything here is pure.
 */
import { bars as meterBars, normalizeMeterMap, pulseLines, type MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';

export const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/** A note as the roll or the composer holds it: ticks when it has them, steps (sixteenths) when not. */
export interface MotifNoteIn {
  note: number;
  tick?: number;
  ticks?: number;
  step?: number;
  length?: number;
  velocity?: number;
  /** Carried through every transform, so a caller can tell which note became which. */
  id?: string;
}

/** A realized note in ticks. */
export interface MotifNote {
  note: number;
  tick: number;
  ticks: number;
  velocity: number;
  /** The source note's id, when it had one; a copy made by `sequence` gets `id~seqN`. */
  id?: string;
}

export interface CellNote {
  /** Onset in ticks from the cell's start. */
  at: number;
  ticks: number;
  note: number;
  velocity: number;
  id?: string;
}

/** Where a cell's tick 0 sat: a meter map, its pickup in steps, and the tick. */
export interface CellPlace {
  meterMap: MeterSegment[];
  pickupSteps: number;
  tick: number;
}

export interface MotifCell {
  /** Sorted by onset, then pitch. */
  notes: CellNote[];
  /** Ticks from 0 to the cell's end; never shorter than its last note. */
  length: number;
  /** Absent: 4/4 from tick 0. */
  place?: CellPlace;
}

export interface MetricPos {
  /** The meter map's bar (-1 is the pickup). */
  bar: number;
  /** 0-based pulse inside the bar. */
  pulse: number;
  /** How far into the pulse the note starts, 0..1. */
  frac: number;
  /** 'bar' on a downbeat, 'pulse' on another pulse start, 'off' between pulses. */
  accent: 'bar' | 'pulse' | 'off';
}

export interface CellDescription {
  /** Semitones between successive melody notes (the top note of each onset). */
  intervals: number[];
  /** Each melody note's length in ticks. */
  durations: number[];
  /** Ticks from each onset to the next; the last runs to the cell's end. */
  iois: number[];
  /** Each melody note's metric position where the cell sits. */
  metric: MetricPos[];
}

const EPS = 1e-9;
const clampMidi = (m: number): number => Math.max(0, Math.min(127, Math.round(m)));

// --- scales --------------------------------------------------------------- //

export type ScaleMode =
  | 'major'
  | 'minor'
  | 'harmonic_minor'
  | 'melodic_minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian';

export const SCALE_STEPS: Record<ScaleMode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** A scale: its tonic's pitch class and its steps in semitones above it, 0 first, ascending. */
export interface Scale {
  tonic: number;
  steps: readonly number[];
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Pitch class of a tonic name: 'C', 'F#', 'Bb', 'Eb', 'c#'. */
export function tonicPc(name: string): number {
  const raw = name.trim();
  const letter = raw.charAt(0).toUpperCase();
  if (!(letter in LETTER_PC)) throw new Error(`not a tonic: ${JSON.stringify(name)}`);
  let pc = LETTER_PC[letter];
  for (const ch of raw.slice(1)) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'b' || ch === '♭' || ch === '-') pc -= 1;
    else throw new Error(`not a tonic: ${JSON.stringify(name)}`);
  }
  return ((pc % 12) + 12) % 12;
}

export function scaleOf(tonic: string | number, mode: ScaleMode = 'major'): Scale {
  const pc = typeof tonic === 'number' ? ((Math.round(tonic) % 12) + 12) % 12 : tonicPc(tonic);
  return { tonic: pc, steps: SCALE_STEPS[mode] };
}

/** A pitch as a scale degree (0 = the tonic in MIDI octave 0, 7 = an octave up) and the semitones it sits above that degree. */
export function toDegree(midi: number, scale: Scale): { deg: number; alt: number } {
  const n = scale.steps.length;
  const rel = midi - scale.tonic;
  const oct = Math.floor(rel / 12);
  const r = rel - oct * 12;
  let idx = 0;
  for (let i = 0; i < n; i += 1) if (scale.steps[i] <= r) idx = i;
  return { deg: oct * n + idx, alt: r - scale.steps[idx] };
}

export function fromDegree(deg: number, alt: number, scale: Scale): number {
  const n = scale.steps.length;
  const oct = Math.floor(deg / n);
  const idx = deg - oct * n;
  return scale.tonic + oct * 12 + scale.steps[idx] + alt;
}

export const inScale = (midi: number, scale: Scale): boolean => toDegree(midi, scale).alt === 0;

// --- meter ---------------------------------------------------------------- //

export interface Pulse {
  tick: number;
  ticks: number;
  bar: number;
  /** 0-based pulse inside the bar. */
  index: number;
}

/** Every pulse of the meter map that overlaps [fromTick, toTick). */
export function pulsesBetween(meterMap: readonly MeterSegment[] | undefined, pickupSteps: number, fromTick: number, toTick: number): Pulse[] {
  const map = normalizeMeterMap(meterMap);
  const pickup = Math.max(0, pickupSteps || 0);
  const out: Pulse[] = [];
  const endSteps = Math.max(toTick, fromTick + 1) / TICKS_PER_STEP + EPS;
  for (const b of meterBars(map, endSteps, pickup)) {
    const lines = b.bar < 0 ? [0] : pulseLines(b.meter);
    lines.forEach((at, i) => {
      const next = i + 1 < lines.length ? lines[i + 1] : b.len;
      const tick = Math.round((b.start + at) * TICKS_PER_STEP);
      const ticks = Math.round((next - at) * TICKS_PER_STEP);
      if (tick + ticks > fromTick && tick < Math.max(toTick, fromTick + 1)) out.push({ tick, ticks, bar: b.bar, index: i });
    });
  }
  return out;
}

/** A tick as (pulse k in `pulses`, fraction into it); past the last pulse the last pulse's length repeats. */
function pulsePos(pulses: readonly Pulse[], tick: number): { k: number; frac: number } {
  for (let k = pulses.length - 1; k >= 0; k -= 1) {
    const p = pulses[k];
    if (tick >= p.tick - EPS) {
      const frac = (tick - p.tick) / p.ticks;
      if (frac < 1 - EPS || k === pulses.length - 1) {
        const whole = Math.floor(frac + EPS);
        return { k: k + whole, frac: frac - whole };
      }
      return { k: k + 1, frac: 0 };
    }
  }
  return { k: 0, frac: (tick - pulses[0].tick) / pulses[0].ticks };
}

function pulseTick(pulses: readonly Pulse[], k: number, frac: number): number {
  if (k < pulses.length) return pulses[k].tick + frac * pulses[k].ticks;
  const last = pulses[pulses.length - 1];
  return last.tick + (k - (pulses.length - 1) + frac) * last.ticks;
}

// --- cells ---------------------------------------------------------------- //

const noteTick = (n: MotifNoteIn): number =>
  typeof n.tick === 'number' && Number.isFinite(n.tick) ? n.tick : (n.step ?? 0) * TICKS_PER_STEP;
const noteTicks = (n: MotifNoteIn): number =>
  typeof n.ticks === 'number' && Number.isFinite(n.ticks) ? n.ticks : (n.length ?? 0) * TICKS_PER_STEP;

const byOnset = (a: CellNote, b: CellNote): number => a.at - b.at || a.note - b.note;

function makeCell(notes: CellNote[], length: number, place?: CellPlace): MotifCell {
  const sorted = [...notes].sort(byOnset);
  const end = sorted.reduce((m, n) => Math.max(m, n.at + n.ticks), 0);
  return { notes: sorted, length: Math.max(length, end), ...(place ? { place } : {}) };
}

export interface ExtractOpts {
  meterMap?: readonly MeterSegment[];
  pickupSteps?: number;
}

/** One cell from a note list: onsets from its first note, its place in the meter map kept. */
export function extractCell(notes: readonly MotifNoteIn[], opts: ExtractOpts = {}): MotifCell {
  const list = notes.map((n) => ({ n, tick: Math.round(noteTick(n)), ticks: Math.max(1, Math.round(noteTicks(n))) }));
  if (!list.length) return { notes: [], length: 0, place: { meterMap: normalizeMeterMap(opts.meterMap), pickupSteps: opts.pickupSteps ?? 0, tick: 0 } };
  const origin = Math.min(...list.map((x) => x.tick));
  const cellNotes: CellNote[] = list.map(({ n, tick, ticks }) => ({
    at: tick - origin,
    ticks,
    note: clampMidi(n.note),
    velocity: n.velocity ?? 96,
    ...(n.id !== undefined ? { id: n.id } : {}),
  }));
  return makeCell(cellNotes, 0, { meterMap: normalizeMeterMap(opts.meterMap), pickupSteps: Math.max(0, opts.pickupSteps ?? 0), tick: origin });
}

export interface SplitOpts extends ExtractOpts {
  /** Where a new cell starts: at a rest, at each bar line (and rest), or at each pulse (and rest). Default 'bar'. */
  split?: 'rest' | 'bar' | 'pulse';
  /** Cells with fewer notes join the cell before them. Default 2. */
  minNotes?: number;
}

/** A note list cut into cells at rests and at bar lines or pulses. */
export function extractCells(notes: readonly MotifNoteIn[], opts: SplitOpts = {}): MotifCell[] {
  const split = opts.split ?? 'bar';
  const minNotes = Math.max(1, opts.minNotes ?? 2);
  const pickup = Math.max(0, opts.pickupSteps ?? 0);
  const sorted = [...notes].sort((a, b) => noteTick(a) - noteTick(b) || a.note - b.note);
  if (!sorted.length) return [];
  const lastEnd = Math.max(...sorted.map((n) => noteTick(n) + noteTicks(n)));
  const pulses = pulsesBetween(opts.meterMap, pickup, 0, lastEnd + 1);
  const unitOf = (tick: number): string => {
    if (split === 'rest') return '';
    const { k } = pulsePos(pulses, tick);
    const p = pulses[Math.min(k, pulses.length - 1)];
    return split === 'bar' ? String(p.bar) : `${p.bar}:${p.index}`;
  };
  const groups: MotifNoteIn[][] = [];
  let reach = -Infinity;
  let unit = '';
  let lastOnset = -Infinity;
  for (const n of sorted) {
    const t = noteTick(n);
    const u = unitOf(t);
    const newOnset = t > lastOnset + EPS;
    if (!groups.length || (newOnset && (t > reach + EPS || u !== unit))) groups.push([]);
    groups[groups.length - 1].push(n);
    reach = Math.max(reach, t + noteTicks(n));
    unit = u;
    lastOnset = t;
  }
  const merged: MotifNoteIn[][] = [];
  for (const g of groups) {
    if (merged.length && g.length < minNotes) merged[merged.length - 1].push(...g);
    else merged.push([...g]);
  }
  if (merged.length > 1 && merged[0].length < minNotes) merged.splice(0, 2, [...merged[0], ...merged[1]]);
  return merged.map((g) => extractCell(g, opts));
}

/** Onsets of a cell, each with its notes, lowest first. */
function onsets(cell: MotifCell): CellNote[][] {
  const out: CellNote[][] = [];
  for (const n of cell.notes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0].at - n.at) <= EPS) last.push(n);
    else out.push([n]);
  }
  return out;
}

/** The top note of each onset. */
export function melody(cell: MotifCell): CellNote[] {
  return onsets(cell).map((g) => g[g.length - 1]);
}

const placeOf = (cell: MotifCell): CellPlace => cell.place ?? { meterMap: normalizeMeterMap([]), pickupSteps: 0, tick: 0 };

export function describeCell(cell: MotifCell): CellDescription {
  const mel = melody(cell);
  const place = placeOf(cell);
  const pulses = pulsesBetween(place.meterMap, place.pickupSteps, place.tick, place.tick + Math.max(1, cell.length));
  const metric = mel.map((n): MetricPos => {
    const tick = place.tick + n.at;
    const { k, frac } = pulsePos(pulses, tick);
    const p = pulses[Math.min(k, pulses.length - 1)];
    const onStart = Math.abs(frac) <= 1e-6;
    return { bar: p.bar, pulse: p.index, frac, accent: onStart ? (p.index === 0 ? 'bar' : 'pulse') : 'off' };
  });
  return {
    intervals: mel.slice(1).map((n, i) => n.note - mel[i].note),
    durations: mel.map((n) => n.ticks),
    iois: mel.map((n, i) => (i + 1 < mel.length ? mel[i + 1].at : cell.length) - n.at),
    metric,
  };
}

// --- transforms ------------------------------------------------------------ //

const mapPitch = (cell: MotifCell, f: (m: number) => number): MotifCell =>
  makeCell(cell.notes.map((n) => ({ ...n, note: clampMidi(f(n.note)) })), cell.length, cell.place);

export function transpose(cell: MotifCell, semitones: number): MotifCell {
  return mapPitch(cell, (m) => m + semitones);
}

export function transposeDiatonic(cell: MotifCell, steps: number, scale: Scale): MotifCell {
  return mapPitch(cell, (m) => {
    const { deg, alt } = toDegree(m, scale);
    return fromDegree(deg + steps, alt, scale);
  });
}

const firstNote = (cell: MotifCell): number => cell.notes[0]?.note ?? 60;

/** Mirror every pitch about `axis` (default the cell's first note): axis + 2 is sent to axis - 2. */
export function invert(cell: MotifCell, axis: number = firstNote(cell)): MotifCell {
  return mapPitch(cell, (m) => 2 * axis - m);
}

/** Mirror every scale degree about the degree of `axis` (default the cell's first note); a note in the scale stays in it. */
export function invertDiatonic(cell: MotifCell, scale: Scale, axis: number = firstNote(cell)): MotifCell {
  const a = toDegree(axis, scale).deg;
  return mapPitch(cell, (m) => {
    const { deg, alt } = toDegree(m, scale);
    return fromDegree(2 * a - deg, -alt, scale);
  });
}

/** The notes backwards: a note that ended at the cell's end now starts at 0. Twice is the identity. */
export function retrograde(cell: MotifCell): MotifCell {
  return makeCell(cell.notes.map((n) => ({ ...n, at: cell.length - (n.at + n.ticks) })), cell.length, cell.place);
}

function scaleTime(cell: MotifCell, factor: number): MotifCell {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error('a time factor must be a positive number');
  return makeCell(
    cell.notes.map((n) => ({ ...n, at: Math.round(n.at * factor), ticks: Math.max(1, Math.round(n.ticks * factor)) })),
    Math.round(cell.length * factor),
    cell.place,
  );
}

/** Every onset and length times `factor` (default 2). */
export const augment = (cell: MotifCell, factor = 2): MotifCell => scaleTime(cell, factor);
/** Every onset and length over `factor` (default 2). */
export const diminish = (cell: MotifCell, factor = 2): MotifCell => scaleTime(cell, 1 / factor);

/** The first ('head') or last ('tail') `count` onsets; a chord counts once. A tail starts at 0 and keeps its place in the meter. */
export function fragment(cell: MotifCell, part: 'head' | 'tail', count: number): MotifCell {
  const groups = onsets(cell);
  const n = Math.max(1, Math.min(groups.length, Math.round(count)));
  if (part === 'head') {
    const kept = groups.slice(0, n).flat();
    const end = n < groups.length ? groups[n][0].at : cell.length;
    return makeCell(kept, end, cell.place);
  }
  const kept = groups.slice(groups.length - n);
  const from = kept[0]?.[0].at ?? 0;
  const place = placeOf(cell);
  return makeCell(
    kept.flat().map((x) => ({ ...x, at: x.at - from })),
    cell.length - from,
    { ...place, tick: place.tick + from },
  );
}

/**
 * The cell, then `steps` more statements laid end to end, each `interval`
 * further on: scale steps when a scale is given, semitones when not. A copy's
 * note ids get `~seqN`.
 */
export function sequence(cell: MotifCell, steps: number, interval: number, scale?: Scale | null): MotifCell {
  const count = Math.max(0, Math.round(steps));
  const out: CellNote[] = [];
  for (let k = 0; k <= count; k += 1) {
    const moved = scale ? transposeDiatonic(cell, k * interval, scale) : transpose(cell, k * interval);
    for (const n of moved.notes) {
      out.push({ ...n, at: n.at + k * cell.length, ...(k > 0 && n.id !== undefined ? { id: `${n.id}~seq${k}` } : {}) });
    }
  }
  return makeCell(out, cell.length * (count + 1), cell.place);
}

export interface LiquidateOpts {
  /** Steps are scale steps in this scale; without one a leap becomes a whole tone. */
  scale?: Scale | null;
  /** The pitch the last two stages settle on; default the cell's first note. */
  target?: number;
}

/** The cell's leaps turned into steps in the same direction; repeated notes stay. */
function stepwise(cell: MotifCell, scale?: Scale | null): MotifCell {
  const groups = onsets(cell);
  if (!groups.length) return cell;
  const out: CellNote[] = [...groups[0]];
  let prevOld = groups[0][groups[0].length - 1].note;
  let prevNew = prevOld;
  for (let g = 1; g < groups.length; g += 1) {
    const top = groups[g][groups[g].length - 1].note;
    const iv = top - prevOld;
    let next: number;
    if (iv === 0) next = prevNew;
    else if (scale) {
      const { deg, alt } = toDegree(prevNew, scale);
      next = fromDegree(deg + Math.sign(iv), alt, scale);
    } else next = prevNew + Math.sign(iv) * Math.min(2, Math.abs(iv));
    const shift = next - top;
    for (const n of groups[g]) out.push({ ...n, note: clampMidi(n.note + shift) });
    prevOld = top;
    prevNew = next;
  }
  return makeCell(out, cell.length, cell.place);
}

/**
 * Liquidation in `steps` stages toward a cadence. The four features drop in
 * order: (1) the leaps become steps, (2) the cell shrinks to its head (the
 * first half of its onsets), (3) the head's rhythm plays on one pitch, (4) one
 * note is left, as long as the head. `steps` stages spread over those four and
 * the last is always the single note.
 */
export function liquidate(cell: MotifCell, steps: number, opts: LiquidateOpts = {}): MotifCell[] {
  const n = Math.max(1, Math.round(steps));
  const target = clampMidi(opts.target ?? firstNote(cell));
  const one = stepwise(cell, opts.scale);
  const headCount = Math.max(1, Math.ceil(onsets(cell).length / 2));
  const two = fragment(one, 'head', headCount);
  const three = makeCell(
    melody(two).map((x) => ({ ...x, note: target })),
    two.length,
    two.place,
  );
  const first = cell.notes[0];
  const four = makeCell(
    first ? [{ ...first, at: 0, note: target, ticks: Math.max(1, two.length) }] : [],
    two.length,
    two.place,
  );
  const stages = [one, two, three, four];
  const out: MotifCell[] = [];
  for (let i = 1; i <= n; i += 1) out.push(stages[Math.min(4, Math.ceil((i * 4) / n)) - 1]);
  return out;
}

// --- realization ----------------------------------------------------------- //

export interface RealizeOpts {
  /** The meter the cell is realized into; default 4/4. */
  meterMap?: readonly MeterSegment[];
  pickupSteps?: number;
  /**
   * 'ticks' (default) keeps every onset and length as it is. 'metric' maps the
   * cell pulse for pulse, from the pulse its start sat in to the pulse that
   * holds `start`: a note on the third quarter of 4/4 lands on the third group
   * start of 7/8 2+2+3, a note that filled a pulse fills the group it lands
   * in, and a note partway into a pulse sits the same share of the way in.
   */
  align?: 'ticks' | 'metric';
}

/** The cell as notes in ticks from `start`. */
export function realizeCell(cell: MotifCell, start: number, opts: RealizeOpts = {}): MotifNote[] {
  const s = Math.max(0, Math.round(start));
  const out = (n: CellNote, tick: number, ticks: number): MotifNote => ({
    note: n.note,
    tick,
    ticks: Math.max(1, ticks),
    velocity: n.velocity,
    ...(n.id !== undefined ? { id: n.id } : {}),
  });
  if (opts.align !== 'metric') return cell.notes.map((n) => out(n, s + n.at, n.ticks));
  const place = placeOf(cell);
  const src = pulsesBetween(place.meterMap, place.pickupSteps, place.tick, place.tick + Math.max(1, cell.length) + 1);
  const src0 = pulsePos(src, place.tick).k;
  // Enough target pulses for every pulse the cell spans; dst[0] holds `start`.
  const spanPulses = pulsePos(src, place.tick + cell.length).k - src0 + 2;
  let reach = s + PPQ * 4;
  let dst = pulsesBetween(opts.meterMap, opts.pickupSteps ?? 0, s, reach);
  while (dst.length < spanPulses) {
    reach += PPQ * 4 * spanPulses;
    dst = pulsesBetween(opts.meterMap, opts.pickupSteps ?? 0, s, reach);
  }
  const map = (tick: number): number => {
    const p = pulsePos(src, place.tick + tick);
    return Math.round(pulseTick(dst, p.k - src0, p.frac));
  };
  return cell.notes.map((n) => {
    const on = map(n.at);
    return out(n, on, map(n.at + n.ticks) - on);
  });
}

// --- themes ---------------------------------------------------------------- //

export interface ThemeKey {
  tonic: string;
  mode: ScaleMode;
}

export interface Theme {
  name: string;
  /** The theme's cells in order; recall joins them end to end. */
  cells: MotifCell[];
  key: ThemeKey;
  /** The section the theme belongs to: 'first_group', 'second_group', 'refrain', 'A' ... */
  home: string;
}

export interface ThemeRegistry {
  themes: Record<string, Theme>;
}

export const createThemeRegistry = (): ThemeRegistry => ({ themes: {} });

/** A registry with `theme` added (or replaced by name). */
export function registerTheme(reg: ThemeRegistry, theme: Theme): ThemeRegistry {
  if (!theme.name.trim()) throw new Error('a theme needs a name');
  if (!theme.cells.length) throw new Error(`theme ${theme.name} has no cells`);
  scaleOf(theme.key.tonic, theme.key.mode);
  return { themes: { ...reg.themes, [theme.name]: theme } };
}

export const themeNames = (reg: ThemeRegistry): string[] => Object.keys(reg.themes);

/** The cells laid end to end, each after the length of the one before. */
export function joinCells(cells: readonly MotifCell[]): MotifCell {
  const out: CellNote[] = [];
  let at = 0;
  for (const c of cells) {
    for (const n of c.notes) out.push({ ...n, at: n.at + at });
    at += c.length;
  }
  return makeCell(out, at, cells[0]?.place);
}

export type MotifTransform =
  | { op: 'transpose'; semitones: number }
  | { op: 'transposeDiatonic'; steps: number }
  | { op: 'invert'; axis?: number }
  | { op: 'invertDiatonic'; axis?: number }
  | { op: 'retrograde' }
  | { op: 'augment'; factor?: number }
  | { op: 'diminish'; factor?: number }
  | { op: 'fragment'; part: 'head' | 'tail'; count: number }
  | { op: 'sequence'; steps: number; interval: number; diatonic?: boolean }
  | { op: 'liquidate'; steps: number; stage?: number; target?: number }
  | { op: 'toKey'; tonic: string; mode: ScaleMode };

/** Every note moved from `from` to the key `to`, keeping its scale degree; the tonic moves the nearest way (up to a tritone up, a fourth down). */
export function toKey(cell: MotifCell, from: Scale, to: Scale): MotifCell {
  const d = ((((to.tonic - from.tonic) % 12) + 12) % 12);
  const shift = d > 6 ? d - 12 : d;
  const target: Scale = { tonic: from.tonic + shift, steps: to.steps };
  return mapPitch(cell, (m) => {
    const { deg, alt } = toDegree(m, from);
    return fromDegree(deg, alt, target);
  });
}

/** One transform, in the scale that is current; `toKey` makes its key current. */
export function applyTransform(cell: MotifCell, t: MotifTransform, scale: Scale): { cell: MotifCell; scale: Scale } {
  switch (t.op) {
    case 'transpose':
      return { cell: transpose(cell, t.semitones), scale };
    case 'transposeDiatonic':
      return { cell: transposeDiatonic(cell, t.steps, scale), scale };
    case 'invert':
      return { cell: invert(cell, t.axis), scale };
    case 'invertDiatonic':
      return { cell: invertDiatonic(cell, scale, t.axis), scale };
    case 'retrograde':
      return { cell: retrograde(cell), scale };
    case 'augment':
      return { cell: augment(cell, t.factor), scale };
    case 'diminish':
      return { cell: diminish(cell, t.factor), scale };
    case 'fragment':
      return { cell: fragment(cell, t.part, t.count), scale };
    case 'sequence':
      return { cell: sequence(cell, t.steps, t.interval, t.diatonic === false ? null : scale), scale };
    case 'liquidate': {
      const stages = liquidate(cell, t.steps, { scale, target: t.target });
      const i = Math.max(1, Math.min(stages.length, Math.round(t.stage ?? stages.length)));
      return { cell: stages[i - 1], scale };
    }
    case 'toKey': {
      const next = scaleOf(t.tonic, t.mode);
      return { cell: toKey(cell, scale, next), scale: next };
    }
  }
}

export function applyChain(cell: MotifCell, chain: readonly MotifTransform[], scale: Scale): MotifCell {
  let cur = { cell, scale };
  for (const t of chain) cur = applyTransform(cur.cell, t, cur.scale);
  return cur.cell;
}

/** A registered theme (its cells joined, or one cell by index) through a chain of transforms in the theme's key. */
export function recallTheme(reg: ThemeRegistry, name: string, chain: readonly MotifTransform[] = [], opts: { cell?: number } = {}): MotifCell {
  const theme = reg.themes[name];
  if (!theme) throw new Error(`no theme named ${name}`);
  const base = opts.cell === undefined ? joinCells(theme.cells) : theme.cells[opts.cell];
  if (!base) throw new Error(`theme ${name} has no cell ${opts.cell}`);
  return applyChain(base, chain, scaleOf(theme.key.tonic, theme.key.mode));
}
