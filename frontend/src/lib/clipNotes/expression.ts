/**
 * Phrase expression: a part's modulation (CC 1) and expression (CC 11)
 * curves, and its played attacks, from the shape of its lines.
 *
 * A drawn or composed part plays every note at one level. A player shapes it:
 * the dynamic rises through a phrase to its peak and falls away after it (a
 * hairpin, printed or not), a slur is one breath with no dip in it, a held
 * note swells and relaxes inside itself (messa di voce, the horn's swell), a
 * busy passage drives a little harder, and no two players start a note at
 * exactly the same instant. This module writes that as the part's controller
 * changes, which every player of a part already plays (the roll's PLAY, EDIT,
 * a render, both MIDI writers):
 *
 *   - CC 1 carries the dynamic: an orchestral soundfont (the stage-4 bank's
 *     per-zone CC 1 modulators) crossfades its dynamic layers with it. It
 *     follows each phrase's hairpins, lifted by the note density around it.
 *   - CC 11 carries the phrase inside that dynamic: it rides the same arc
 *     more gently, stays level across a slur, and swells inside every held
 *     note of a sustaining instrument.
 *   - Attacks: each note's onset moves by a seeded offset whose spread and
 *     lean depend on its articulation (a legato note speaks a hair early, a
 *     staccato tight, a tremolo loose), so the same seed gives the same
 *     performance.
 *
 * Phrases are the part's own (a rest of a beat or more ends one) split again
 * at any boundary given (a FORM section, a song section). Hairpins and slurs
 * may be given (a score's); a phrase with none gets a crescendo to its peak
 * (its loudest, highest onset) and a diminuendo after it, and notes that join
 * (each ends where the next begins) form a slur.
 *
 * Pure: the store's composer writes and Virtuoso's song build call it
 * (behind the roll's Expression toggle), and node tests run it.
 */
import type { PianoNote, RollControl } from '../../state/pianoRollStore';
import { articulationFamily, isArticulation, type Articulation, type ArticulationInstrument } from '../articulationMap';
import { PPQ, ROLL_STEPS_PER_BEAT as STEPS_PER_BEAT } from '../noteClock';

/** A dynamic wedge over ticks on the roll's clock. */
export interface Hairpin {
  fromTick: number;
  toTick: number;
  kind: 'cresc' | 'dim';
}

/** A slur over ticks on the roll's clock: its notes are one breath. */
export interface Slur {
  fromTick: number;
  toTick: number;
}

/** A phrase: its span on the roll's clock. */
export interface Phrase {
  fromTick: number;
  toTick: number;
}

export interface ExpressionOptions {
  /** The attacks' seed. Same seed, same performance. Default 1. */
  seed?: number;
  /** Ticks where a phrase must break (section starts); the part's own rests break it too. */
  boundaries?: readonly number[];
  /** A score's hairpins; left out, each phrase gets its own arc. */
  hairpins?: readonly Hairpin[];
  /** A score's slurs; left out, joined notes are slurred. */
  slurs?: readonly Slur[];
  /** How much of it, 0-1. Default 1. */
  depth?: number;
  /** Ticks between the changes a curve writes. Default a 32nd (120). */
  every?: number;
  /** The part's instrument: a sustaining one (strings, winds, voices) swells inside held notes. */
  instrument?: ArticulationInstrument;
  /** Move each note's attack by its seeded offset. Default true. */
  attacks?: boolean;
}

export interface ExpressionResult {
  /** The CC 1 and CC 11 changes, sorted by tick. */
  controls: RollControl[];
  /** The notes with their attacks moved (ids kept); the input order. */
  notes: PianoNote[];
  /** The phrases read, for a caller that shows them. */
  phrases: Phrase[];
}

/** The controllers this module writes. */
export const EXPRESSION_CONTROLLERS: readonly number[] = Object.freeze([1, 11]);

/** A rest this long (a beat) or longer ends a phrase. */
const PHRASE_REST_TICKS = PPQ;
/** A note this long (a beat) or longer swells inside itself on a sustaining instrument. */
const SWELL_MIN_TICKS = PPQ;
/** Onsets per beat that count as fully dense. */
const DENSE_ONSETS_PER_BEAT = 4;
const TICKS_PER_STEP = PPQ / STEPS_PER_BEAT;

/** The attack lean and spread per articulation, in ticks at 960 PPQ (10 ticks is 5 ms at 120 BPM). */
export const ATTACK_OFFSETS: Readonly<Record<Articulation | 'ordinario', { mean: number; spread: number }>> = Object.freeze({
  ordinario: { mean: 0, spread: 6 },
  legato: { mean: -8, spread: 6 },
  staccato: { mean: 0, spread: 3 },
  spiccato: { mean: 0, spread: 3 },
  marcato: { mean: -2, spread: 3 },
  pizzicato: { mean: -4, spread: 5 },
  tremolo: { mean: 0, spread: 10 },
  'col-legno': { mean: 0, spread: 4 },
  harmonics: { mean: 2, spread: 8 },
  'con-sordino': { mean: 0, spread: 6 },
});

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));
const tickOf = (n: PianoNote): number => n.tick ?? Math.round(n.step * TICKS_PER_STEP);
const ticksOf = (n: PianoNote): number => n.ticks ?? Math.max(1, Math.round(n.length * TICKS_PER_STEP));

/** mulberry32: the seeded PRNG clipNotes/humanize uses. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The part's phrases: a rest of a beat or more ends one, and each boundary starts one. */
export function readPhrases(notes: readonly PianoNote[], boundaries: readonly number[] = []): Phrase[] {
  const sorted = [...notes].sort((a, b) => tickOf(a) - tickOf(b));
  const cuts = [...new Set(boundaries.map((b) => Math.max(0, Math.round(b))))].sort((a, b) => a - b);
  const phrases: Phrase[] = [];
  let cur: Phrase | null = null;
  for (const n of sorted) {
    const on = tickOf(n);
    const off = on + ticksOf(n);
    const crossesCut = !!cur && cuts.some((c) => c > (cur as Phrase).fromTick && c <= on);
    if (!cur || on - cur.toTick >= PHRASE_REST_TICKS || crossesCut) {
      cur = { fromTick: on, toTick: off };
      phrases.push(cur);
    } else {
      cur.toTick = Math.max(cur.toTick, off);
    }
  }
  return phrases;
}

/** Slurs read from the notes: each run of two or more notes where each starts where the one before ends (or within a 64th of it). */
export function readSlurs(notes: readonly PianoNote[]): Slur[] {
  const sorted = [...notes].sort((a, b) => tickOf(a) - tickOf(b));
  const out: Slur[] = [];
  let run: Slur | null = null;
  let count = 0;
  let lastEnd = -Infinity;
  const tolerance = PPQ / 16;
  for (const n of sorted) {
    const on = tickOf(n);
    const joined = run !== null && Math.abs(on - lastEnd) <= tolerance && n.articulation !== 'staccato' && n.articulation !== 'spiccato';
    if (joined && run) {
      run.toTick = on + ticksOf(n);
      count += 1;
    } else {
      if (run && count >= 2) out.push(run);
      run = { fromTick: on, toTick: on + ticksOf(n) };
      count = 1;
    }
    lastEnd = on + ticksOf(n);
  }
  if (run && count >= 2) out.push(run);
  return out;
}

/** Each phrase's arc as two hairpins: a crescendo to its peak (the loudest, highest onset) and a diminuendo after. */
export function inferHairpins(notes: readonly PianoNote[], phrases: readonly Phrase[]): Hairpin[] {
  const out: Hairpin[] = [];
  for (const p of phrases) {
    const inside = notes.filter((n) => tickOf(n) >= p.fromTick && tickOf(n) < p.toTick);
    if (!inside.length) continue;
    let peak = inside[0];
    let best = -Infinity;
    for (const n of inside) {
      // A peak leans late in the phrase, as a line's climax does.
      const pos = (tickOf(n) - p.fromTick) / Math.max(1, p.toTick - p.fromTick);
      const score = n.velocity + n.note * 0.5 + pos * 12;
      if (score > best) {
        best = score;
        peak = n;
      }
    }
    const at = tickOf(peak);
    if (at > p.fromTick) out.push({ fromTick: p.fromTick, toTick: at, kind: 'cresc' });
    if (p.toTick > at) out.push({ fromTick: at, toTick: p.toTick, kind: 'dim' });
  }
  return out;
}

/** Onsets per beat within a beat each side of `tick`, 0-1 against DENSE_ONSETS_PER_BEAT. */
function densityAt(onsets: readonly number[], tick: number): number {
  let lo = 0;
  let hi = onsets.length;
  const from = tick - PPQ;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  let count = 0;
  for (let i = lo; i < onsets.length && onsets[i] <= tick + PPQ; i += 1) count += 1;
  return Math.min(1, count / 2 / DENSE_ONSETS_PER_BEAT);
}

/** The hairpin level at `tick`, 0 (the phrase's floor) to 1 (its peak). */
function hairpinLevel(hairpins: readonly Hairpin[], tick: number): number {
  for (const h of hairpins) {
    if (tick < h.fromTick || tick > h.toTick) continue;
    const u = (tick - h.fromTick) / Math.max(1, h.toTick - h.fromTick);
    // An eased wedge: a crescendo grows into its peak, a diminuendo falls away from it.
    const s = u * u * (3 - 2 * u);
    return h.kind === 'cresc' ? s : 1 - s;
  }
  return 0.5;
}

/** Whether `inst` sustains a held note (strings, winds, voices): the ones that swell inside it. */
const sustains = (inst: ArticulationInstrument | undefined): boolean => {
  if (!inst) return true;
  if (inst.percussion) return false;
  const family = articulationFamily(inst);
  if (family !== 'other') return true;
  const p = inst.program;
  // Voices and synth pads sustain; pianos, plucked and struck sounds do not.
  return typeof p === 'number' && ((p >= 52 && p <= 54) || (p >= 88 && p <= 95));
};

/** Build the part's CC 1 and CC 11 curves and its played attacks (see the header). */
export function buildExpression(notes: readonly PianoNote[], opts: ExpressionOptions = {}): ExpressionResult {
  const depth = Math.max(0, Math.min(1, opts.depth ?? 1));
  const every = Math.max(10, Math.round(opts.every ?? PPQ / 8));
  const phrases = readPhrases(notes, opts.boundaries);
  if (!notes.length || depth === 0) return { controls: [], notes: notes.map((n) => ({ ...n })), phrases };
  const hairpins = opts.hairpins?.length ? [...opts.hairpins] : inferHairpins(notes, phrases);
  const slurs = opts.slurs ? [...opts.slurs] : readSlurs(notes);
  const onsets = notes.map(tickOf).sort((a, b) => a - b);
  const swells = sustains(opts.instrument);

  const cc1: Array<{ tick: number; value: number }> = [];
  const cc11: Array<{ tick: number; value: number }> = [];
  const push = (list: Array<{ tick: number; value: number }>, tick: number, value: number) => {
    const v = clamp7(value);
    if (list.length && list[list.length - 1].value === v) return;
    list.push({ tick, value: v });
  };
  const inSlur = (tick: number) => slurs.some((s) => tick > s.fromTick && tick < s.toTick);
  // The held notes that swell, by their spans.
  const held = swells ? notes.filter((n) => ticksOf(n) >= SWELL_MIN_TICKS && n.articulation !== 'staccato' && n.articulation !== 'spiccato' && n.articulation !== 'pizzicato') : [];

  for (const p of phrases) {
    for (let t = p.fromTick; t <= p.toTick; t += every) {
      const level = hairpinLevel(hairpins, t);
      const dense = densityAt(onsets, t);
      // CC 1: the dynamic layer, 48 at a phrase's floor to 100 at its peak, a busy passage lifted.
      push(cc1, t, 48 + depth * (52 * level + 14 * dense));
      // CC 11: the phrase inside the dynamic, gentler, with a held note's swell laid over it.
      let e = 92 + depth * 24 * level;
      const h = held.find((n) => t >= tickOf(n) && t < tickOf(n) + ticksOf(n));
      if (h) {
        const u = (t - tickOf(h)) / ticksOf(h);
        // Messa di voce: up to its crest at 40% of the note, back down by its end; a slur keeps its floor up.
        const crest = u < 0.4 ? u / 0.4 : 1 - (u - 0.4) / 0.6;
        const floor = inSlur(t) ? 0.4 : 0;
        e += depth * (32 * Math.max(floor, crest) - 18 * (1 - dense));
      }
      push(cc11, t, e);
    }
    // After the phrase: the level where the next one starts from.
    push(cc11, p.toTick, 92);
  }

  const controls: RollControl[] = [
    ...cc1.map((c) => ({ tick: c.tick, controller: 1, value: c.value })),
    ...cc11.map((c) => ({ tick: c.tick, controller: 11, value: c.value })),
  ].sort((a, b) => a.tick - b.tick || a.controller - b.controller);

  // Attacks: a seeded offset per note, its lean and spread set by its articulation.
  const rand = mulberry32((opts.seed ?? 1) * 7919 + 17);
  const moved = notes.map((n) => {
    const r1 = rand();
    const r2 = rand();
    if (opts.attacks === false) return { ...n };
    const art = isArticulation(n.articulation) ? n.articulation : 'ordinario';
    const { mean, spread } = ATTACK_OFFSETS[art];
    // A triangular draw: most offsets near the lean, none past the spread.
    const offset = Math.round((mean + (r1 + r2 - 1) * spread) * depth);
    const tick = Math.max(0, tickOf(n) + offset);
    const ticks = Math.max(1, ticksOf(n) - Math.max(0, tick - tickOf(n)));
    return { ...n, tick, ticks, step: tick / TICKS_PER_STEP, length: ticks / TICKS_PER_STEP };
  });
  return { controls, notes: moved, phrases };
}

/** A part's controls with its CC 1 and CC 11 replaced by `expression`'s; every other controller stays. */
export function withExpressionControls(controls: readonly RollControl[] | undefined, expression: readonly RollControl[]): RollControl[] {
  return [...(controls ?? []).filter((c) => !EXPRESSION_CONTROLLERS.includes(c.controller)), ...expression].sort((a, b) => a.tick - b.tick);
}
