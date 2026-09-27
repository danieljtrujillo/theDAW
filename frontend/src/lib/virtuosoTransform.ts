/**
 * Virtuoso transforms — rewrite simple piano-roll material (an arpeggio, a chord
 * progression, anything) into idiomatic, technically demanding lines, each under
 * a continuous 0..1 "amount" so the result can be dialed and morphed live, and
 * assemble those into full, developing, stylistic arrangements.
 *
 * Phrase transforms (each amount 0..1, optionally seeded per instance):
 *   harmony  — a diatonic third below a share of the top-line notes equal to the
 *              amount, moving in parallel with the line; past 0.66 about three
 *              in ten of those thirds drop a semitone for a borrowed/modal tone.
 *   ragtime  — Joplin stride: oom-pah LH under syncopated, accented RH stabs.
 *   runs     — Rudess scalar/chromatic flourishes that LAND on chord tones.
 *   rhythm   — polyrhythm/odd-meter feel via 3-against-4 cross-accents.
 *   humanize — velocity dynamics, beat accents, and small per-note micro-timing.
 *   sync     — anticipations: strong onsets move to the weak position before them.
 *   accent   — group and bar starts louder, every other note softer.
 *
 * `buildSong` composes rather than repeats. It (1) lays out a chord plan from the
 * style's degree progression, counted from the key's tonic, with real cadences
 * (in a minor mode a cadential V takes the leading tone), (2) voices every chord by
 * nearest-neighbor VOICE-LEADING (so inner voices move minimally, not in parallel
 * blocks), (3) writes an actual MELODY over it (stepwise motion, passing/neighbor
 * tones, appoggiaturas, an arch contour), and (4) renders each section with its
 * own accompaniment + right-hand behaviour (sustained, Alberti, arpeggio, stride,
 * octave stabs, or continuous runs). A song-long crescendo and the global
 * sliders shape the finished result.
 *
 * Phrasing is written as TEMPO, not as notes moved late: the song carries a
 * tempo map (lib/tempoMap) with a linear ritardando over each section's last
 * bar, deeper at the final cadence, and a section can hold a tempo of its own.
 * Every note stays on its bar line, so the roll, a bounce and a MIDI file all
 * agree on where the bars are while the music still slows into each cadence.
 *
 * Positions live on a 16th grid but allow fractional steps (32nd = 0.5, 64th =
 * 0.25, plus micro-timing), which the time-based preview scheduler plays and the
 * bounce path rounds — so runs and micro-timing both preview and render.
 *
 * Bars follow the roll's meter map (lib/meterMap) when the opts carry one, and
 * are 4/4 from step 0 when they do not. Accents come from the metrical weights
 * of each bar (lib/syncopation), and every odd-16th check counts from the start
 * of its bar, so 7/8 3+2+2 accents its group starts and 5/16 swings by its bar.
 */
import { MusicalScale, noteNameToMidi } from './arpEngine';
import { barSeconds, DEFAULT_METER, type Meter } from './colony';
import {
  barAt,
  bars,
  barStartStep,
  groupLines,
  meterAtBar,
  normalizeMeterMap,
  sanitizeMeter,
  segmentIndexAt,
  stepsPerBar,
  type BarSpan,
  type MeterSegment,
} from './meterMap';
import { metricalWeights, stepsPerBeat } from './syncopation';
import { PPQ } from './noteClock';
import { sanitizeRollTempoMap } from './rollTempo';
import { clampTempoBpm, getTempoAtBeat, type TempoCurve, type TempoEvent } from './tempoMap';
import { MIN_NOTE_STEPS, type PianoNote } from '../state/pianoRollStore';

const RH_FLOOR = 60; // C4 — right-hand register floor
const MEL_CENTER = 74; // D5 — melodic register center
const VOICE_CENTER = 52; // E3 — left-hand voicing center
const BASS_CENTER = 36; // C2 — bass register center
const SEED_PRIME = 1009;
const EPS = 1e-9;

/** Steps that take their own scale, such as a cadential V with a raised leading tone. */
export interface ScaleSpan {
  start: number;
  end: number;
  /** The span's pitch classes, sorted. */
  pcs: number[];
}

export interface TransformOpts {
  key: string;
  mode: string;
  /** The roll's time signatures by bar. Absent means 4/4 throughout. */
  meterMap?: MeterSegment[];
  /** Steps before bar 0. Absent means bar 0 starts at step 0. */
  pickupSteps?: number;
  /** Steps whose notes come from their own scale. Outside them, and when absent, the key's scale. */
  scaleSpans?: ScaleSpan[];
}

/** The meter fields of TransformOpts. */
export type MeterOpts = Pick<TransformOpts, 'meterMap' | 'pickupSteps'>;

/** Per-stage strength, each 0..1. */
export interface VirtuosoAmounts {
  harmony: number;
  ragtime: number;
  runs: number;
  rhythm: number;
  humanize: number;
  sync: number;
  accent: number;
}

export const ZERO_AMOUNTS: VirtuosoAmounts = { harmony: 0, ragtime: 0, runs: 0, rhythm: 0, humanize: 0, sync: 0, accent: 0 };

/**
 * A groove "pocket" extracted from a reference performance (a Library song's
 * transcribed MIDI): per-16th-slot timing offset (in steps) and relative
 * rhythmic emphasis (0..1). Applied by `humanize` in place of random jitter so
 * the output breathes with the feel of the reference. (Transcription gives flat
 * velocity, so the emphasis is derived from note density, not recorded dynamics.)
 */
export interface GrooveTemplate {
  name: string;
  /** 16 timing offsets, one per 16th slot, in step units (roughly -0.5..0.5). */
  timing: number[];
  /** 16 relative-emphasis weights, one per 16th slot, 0..1. */
  accent: number[];
}

let _seq = 0;
const uid = (): string => `vt-${Date.now().toString(36)}-${_seq++}`;
const clampMidi = (m: number): number => Math.max(0, Math.min(127, Math.round(m)));
const clampVel = (v: number): number => Math.max(1, Math.min(127, Math.round(v)));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const clone = (n: PianoNote): PianoNote => ({ ...n, id: uid() });

/** Deterministic 0..1 from an integer — stable across re-renders (no RNG). */
const hash01 = (i: number): number => {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

// Quantize to 1/1000 of a step to tame float noise while allowing sub-16th
// positions (32nd = 0.5, 64th = 0.25) and micro-timing offsets. Integer callers
// are unaffected (round-trips exactly). A length floors at the roll's one tick
// (MIN_NOTE_STEPS), so a note shorter than a 64th keeps its length.
const q3 = (v: number): number => Math.round(v * 1000) / 1000;
const mk = (note: number, step: number, length: number, velocity: number): PianoNote => ({
  id: uid(),
  note: clampMidi(note),
  step: Math.max(0, q3(step)),
  length: Math.max(MIN_NOTE_STEPS, q3(length)),
  velocity: clampVel(velocity),
});

const pcOf = (name: string): number => noteNameToMidi(name, 0) % 12;
const pcToMidi = (pc: number, octave: number): number => (octave + 1) * 12 + (((pc % 12) + 12) % 12);

/** The scale's pitch classes from the tonic up, so index 0 is the tonic and each index is a scale degree. */
function scaleDegrees(key: string, mode: string): number[] {
  return new MusicalScale({ key, mode }).notes.map((n) => pcOf(n.note));
}

/** The scale's pitch classes as a set sorted from C, for ladders and chord lookups by pitch. */
function scalePitchClasses(key: string, mode: string): number[] {
  return Array.from(new Set(scaleDegrees(key, mode))).sort((a, b) => a - b);
}

function scaleLadder(pcs: number[], lo = 33, hi = 96): number[] {
  const set = new Set(pcs);
  const out: number[] = [];
  for (let m = lo; m <= hi; m += 1) if (set.has(((m % 12) + 12) % 12)) out.push(m);
  return out;
}

/** The scale at `step`: the first scale span holding it, else `pcs`. */
function scaleAt(opts: TransformOpts, pcs: number[], step: number): number[] {
  return opts.scaleSpans?.find((s) => step >= s.start - EPS && step < s.end - EPS)?.pcs ?? pcs;
}

/** One ladder per scale for the length of a transform call. */
function ladderCache(lo?: number, hi?: number): (pcs: number[]) => number[] {
  const memo = new Map<string, number[]>();
  return (pcs) => {
    const k = pcs.join(',');
    let l = memo.get(k);
    if (!l) {
      l = scaleLadder(pcs, lo, hi);
      memo.set(k, l);
    }
    return l;
  };
}

/**
 * The tones a minor mode raises on a cadential V, as scale tone -> raised tone:
 * the subtonic becomes the leading tone, and in Phrygian the flat 2nd becomes the
 * natural 2nd, so the V is a major triad that leads to the tonic. Empty when the
 * tonic triad is not minor with a perfect fifth (major modes, Locrian) or the 7th
 * already leads (harmonic and melodic minor).
 */
function cadentialRaises(degrees: number[]): Map<number, number> {
  const raises = new Map<number, number>();
  if (degrees.length < 7) return raises;
  const rel = (i: number): number => (((degrees[i] - degrees[0]) % 12) + 12) % 12;
  if (rel(2) !== 3 || rel(4) !== 7 || rel(6) !== 10) return raises;
  raises.set(degrees[6], (degrees[0] + 11) % 12);
  if (rel(1) === 1) raises.set(degrees[1], (degrees[0] + 2) % 12);
  return raises;
}

function topLine(notes: PianoNote[]): PianoNote[] {
  const byStep = new Map<number, PianoNote>();
  for (const n of notes) {
    const cur = byStep.get(n.step);
    if (!cur || n.note > cur.note) byStep.set(n.step, n);
  }
  return Array.from(byStep.values()).sort((a, b) => a.step - b.step);
}

function toRegister(midi: number, floor = RH_FLOOR): number {
  let m = midi;
  while (m < floor) m += 12;
  while (m > floor + 24) m -= 12;
  return m;
}

function nearestIndex(arr: number[], target: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < arr.length; i += 1) {
    const d = Math.abs(arr[i] - target);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function triadFromScale(rootPc: number, pcs: number[]): number[] {
  let i = pcs.indexOf(((rootPc % 12) + 12) % 12);
  if (i < 0) i = nearestIndex(pcs, rootPc);
  return [pcs[i], pcs[(i + 2) % pcs.length], pcs[(i + 4) % pcs.length]];
}

/** Diatonic triad pitch classes seated on a scale DEGREE (0 = the tonic) of a tonic-first scale from `scaleDegrees`. */
function chordAtDegree(deg: number, degrees: number[]): number[] {
  const i = ((deg % degrees.length) + degrees.length) % degrees.length;
  return [degrees[i], degrees[(i + 2) % degrees.length], degrees[(i + 4) % degrees.length]];
}

/** The MIDI note with pitch class `pc` nearest to `target`. */
function pcNearest(pc: number, target: number): number {
  const p = ((pc % 12) + 12) % 12;
  const base = target - ((((target % 12) + 12) % 12) - p + 12) % 12;
  return target - base <= 6 ? base : base + 12;
}

function ladderPath(ladder: number[], a: number, b: number): number[] {
  if (!ladder.length) return [a];
  const ia = nearestIndex(ladder, a);
  const ib = nearestIndex(ladder, b);
  const dir = ib >= ia ? 1 : -1;
  const path: number[] = [];
  for (let i = ia; dir > 0 ? i <= ib : i >= ib; i += dir) path.push(ladder[i]);
  return path.length ? path : [a];
}

function chromaticPath(a: number, b: number): number[] {
  const dir = b >= a ? 1 : -1;
  const path: number[] = [];
  for (let m = a; dir > 0 ? m <= b : m >= b; m += dir) path.push(m);
  return path.length ? path : [a];
}

const byStepThenNote = (a: PianoNote, b: PianoNote): number => a.step - b.step || a.note - b.note;

// --- meter grid ---------------------------------------------------------------- //

// An onset this close to a grid position counts as on it for syncopate and
// accentGroups, so a humanized note still reads as on its beat.
const ON_POSITION = 0.2;

interface GridPosition {
  b: BarSpan;
  /** Whole-step position inside a full bar of `b.meter`. */
  pos: number;
  /** The absolute step of that position. */
  step: number;
  weight: number;
}

/** Bar lookups for one transform call over a meter map. */
interface Grid {
  map: MeterSegment[];
  pickup: number;
  bar: (step: number) => BarSpan;
  /** Steps from the start of a full bar of the step's meter; a pickup counts back from its end. */
  inBar: (step: number) => number;
  /** The step where the meter segment holding `step` starts. */
  segmentStart: (step: number) => number;
  /** The grid position within `tolerance` steps of `step`, or null. */
  onPosition: (step: number, tolerance?: number) => GridPosition | null;
}

const weightCache = new Map<string, number[]>();
const weightsOf = (m: Meter): number[] => {
  const key = `${m.num}/${m.den}:${m.groups.join('+')}`;
  let w = weightCache.get(key);
  if (!w) {
    w = metricalWeights(m);
    weightCache.set(key, w);
  }
  return w;
};

/** The weight a position needs to carry the bar's pulse: a beat when the beat is a quarter or longer, else a group start. */
const pulseWeight = (m: Meter): number => (stepsPerBeat(m) >= 4 ? 2 : 3);
const onPulse = (m: Meter, pos: number): boolean => (weightsOf(m)[pos] ?? 0) >= pulseWeight(m);
const odd = (x: number): boolean => Math.abs(x % 2) === 1;

function gridOf(o?: MeterOpts): Grid {
  const map = normalizeMeterMap(o?.meterMap);
  const pickup = Math.max(0, o?.pickupSteps ?? 0);
  const memo = new Map<number, BarSpan>();
  const bar = (step: number): BarSpan => {
    let b = memo.get(step);
    if (!b) {
      b = barAt(map, step, pickup);
      memo.set(step, b);
    }
    return b;
  };
  const phase = (b: BarSpan): number => (b.bar < 0 ? stepsPerBar(b.meter) - b.len : 0);
  const inBar = (step: number): number => {
    const b = bar(step);
    return step - b.start + phase(b);
  };
  const segmentStart = (step: number): number =>
    barStartStep(map, map[segmentIndexAt(map, Math.max(0, bar(step).bar))].bar, pickup);
  const onPosition = (step: number, tolerance = 0): GridPosition | null => {
    const b = bar(step + tolerance);
    const x = step - b.start + phase(b);
    const pos = Math.round(x) + 0;
    if (Math.abs(x - pos) > tolerance) return null;
    const w = weightsOf(b.meter);
    return { b, pos, step: step - (x - pos), weight: w[((pos % w.length) + w.length) % w.length] ?? 0 };
  };
  return { map, pickup, bar, inBar, segmentStart, onPosition };
}

/** Each group of `m` as a start and a length in steps; a meter without groups is one group. */
function groupSpans(m: Meter): Array<{ start: number; len: number }> {
  const len = stepsPerBar(m);
  const starts = groupLines(m);
  return starts.map((start, i) => ({ start, len: (starts[i + 1] ?? len) - start }));
}

interface Pulse {
  at: number;
  /** Index of the pulse inside its group. */
  k: number;
  /** Pulses in the group. */
  count: number;
}

/**
 * The pulse the left hand and the octave hits move on: a quarter when the beat
 * is a quarter or longer, else an 8th. It restarts at every group start.
 */
function pulses(m: Meter): Pulse[] {
  const p = Math.min(4, Math.max(2, stepsPerBeat(m)));
  const out: Pulse[] = [];
  for (const g of groupSpans(m)) {
    const count = Math.max(1, Math.ceil(g.len / p - EPS));
    for (let k = 0; k < count; k += 1) out.push({ at: g.start + k * p, k, count });
  }
  return out;
}

/** Oom-pah: the bass on each group's first pulse, and on every other pulse of a group longer than three. */
const isOom = (p: Pulse): boolean => p.k === 0 || (p.count > 3 && p.k % 2 === 0);

/**
 * Ragtime "secondary rag" stabs inside one bar. Each group splits into 3s; a
 * leftover 16th widens the middle part to 4 and a leftover 8th adds a 2, so a
 * 4/4 bar gives the tresillo 3+3+4+3+3. Stabs alternate accented and light,
 * accented on every group start.
 */
function stabs(m: Meter): Array<{ at: number; accent: boolean }> {
  const out: Array<{ at: number; accent: boolean }> = [];
  for (const g of groupSpans(m)) {
    const threes = Math.floor(g.len / 3 + EPS);
    const rest = g.len - threes * 3;
    const parts = threes ? new Array<number>(threes).fill(3) : [g.len];
    if (threes && Math.abs(rest - 1) < EPS) parts[Math.floor(threes / 2)] = 4;
    else if (threes && Math.abs(rest - 2) < EPS) parts.push(2);
    else if (threes && rest > EPS) parts[threes - 1] += rest;
    let at = g.start;
    parts.forEach((len, k) => {
      out.push({ at, accent: k % 2 === 0 });
      at += len;
    });
  }
  return out;
}

/** The pulse nearest the middle of a bar of `m`, the stronger one on a tie. */
function midPulse(m: Meter): number {
  const half = stepsPerBar(m) / 2;
  const w = weightsOf(m);
  let best = 0;
  let bd = Infinity;
  let bw = -1;
  for (const { at } of pulses(m)) {
    const d = Math.abs(at - half);
    const wt = w[Math.round(at)] ?? 0;
    if (d < bd - EPS || (Math.abs(d - bd) <= EPS && wt > bw)) {
      best = at;
      bd = d;
      bw = wt;
    }
  }
  return best;
}

/** Melody anchors inside one bar: each group start, then every quarter that fits in the group. */
function anchorSlots(m: Meter): number[] {
  const out: number[] = [];
  for (const g of groupSpans(m)) for (let q = 0; q === 0 || q + 4 <= g.len + EPS; q += 4) out.push(g.start + q);
  return out;
}

// --- voice-leading ----------------------------------------------------------- //

export interface Voicing {
  bass: number;
  voices: number[];
}

/** `m` moved by whole octaves into [lo, hi], so it keeps its pitch class. */
function inRange(m: number, lo: number, hi: number): number {
  let x = m;
  while (x < lo) x += 12;
  while (x > hi) x -= 12;
  return x;
}

/**
 * Voice a triad so each tone moves to its nearest neighbour from the previous
 * voicing (smooth inner-voice motion, inversions chosen implicitly) rather than
 * jumping in parallel root-position blocks. The bass tracks the root register.
 * A tone that walks out of its register comes back by an octave.
 */
function voiceChord(triad: number[], prev: Voicing | null, center = VOICE_CENTER): Voicing {
  const voices = triad.map((pc, i) => {
    const target = prev ? (prev.voices[i] ?? center) : center + (i - 1) * 4;
    return inRange(pcNearest(pc, target), 30, 84);
  });
  voices.sort((a, b) => a - b);
  const bassTarget = prev ? prev.bass : BASS_CENTER;
  const bass = inRange(pcNearest(triad[0], bassTarget), 24, 52);
  return { bass, voices };
}

// --- runs (shared virtuoso flourish) ----------------------------------------- //

interface RunOpts {
  baseVel?: number;
  doubleOctave?: boolean;
  /** Fraction of the run after which subdivisions accelerate to 32nds. */
  accelAt?: number;
  /**
   * True tuplet subdivisions instead of the default straight 16th->32nd feel.
   * The step grid is 16ths, but the time-based preview scheduler plays fractional
   * steps and the bounce rounds them to ticks, so real triplets/sextuplets sound:
   *   3 = 8th-triplet (4/3 step) accelerating to 16th-triplet (2/3 step)
   *   6 = 16th-triplet (2/3 step) accelerating to 32nd-triplet (1/3 step)
   *   0 = straight (default): 16th (1) -> 32nd (0.5).
   */
  tuplet?: 0 | 3 | 6;
  /** The bars the run's pulse accents follow (4/4 from step 0 when absent). */
  grid?: Grid;
  /**
   * The ladder at a step, for a run that crosses a scale span. A run note off
   * the ladder of the step it sounds on moves to that ladder's nearest tone,
   * toward the run's direction on a tie. Absent means `ladder` throughout.
   */
  ladderAt?: (step: number) => number[];
}

/** `m` on `ladder`: itself when on it, else the nearest tone, the one toward `dir` on a tie. */
function snapToLadder(ladder: number[], m: number, dir: number): number {
  if (!ladder.length || ladder.includes(m)) return m;
  let best = ladder[0];
  for (const t of ladder) {
    const d = Math.abs(t - m) - Math.abs(best - m);
    if (d < 0 || (d === 0 && Math.sign(t - m) === dir)) best = t;
  }
  return best;
}

/** Subdivision increments (in 16th steps) for a run's before/after-accel phases. */
const runIncs = (tuplet: 0 | 3 | 6): [number, number] => {
  if (tuplet === 3) return [4 / 3, 2 / 3]; // 8th-triplet -> 16th-triplet
  if (tuplet === 6) return [2 / 3, 1 / 3]; // 16th-triplet -> 32nd-triplet
  return [1, 0.5]; // straight 16th -> 32nd
};

/**
 * A directional flourish from `fromMidi` to `toMidi` filling (fromStep, toStep):
 * scalar/ladder motion that accelerates into the target, crescendos, and closes
 * with a chromatic leading-tone into `toMidi` so it sounds like it ARRIVES on the
 * next chord tone rather than drifting up a scale. The caller places the landing
 * note at `toStep`.
 */
function genRun(
  fromMidi: number,
  toMidi: number,
  fromStep: number,
  toStep: number,
  ladder: number[],
  opts: RunOpts = {},
): PianoNote[] {
  const notes: PianoNote[] = [];
  const dur = toStep - fromStep;
  if (dur <= 0 || !ladder.length) return notes;
  const { baseVel = 84, doubleOctave = false, accelAt = 0.55, tuplet = 0 } = opts;
  const grid = opts.grid ?? gridOf();
  const accelStep = fromStep + dur * accelAt;
  const [incSlow, incFast] = runIncs(tuplet);
  const slots: Array<{ s: number; inc: number }> = [];
  for (let s = fromStep; s < toStep - 1e-6; ) {
    const inc = s < accelStep ? incSlow : incFast;
    slots.push({ s, inc });
    s += inc;
  }
  if (!slots.length) return notes;
  const i0 = nearestIndex(ladder, fromMidi);
  const i1 = nearestIndex(ladder, toMidi);
  const dir = i1 >= i0 ? 1 : -1;
  const span = Math.abs(i1 - i0);
  const last = slots.length - 1;
  for (let k = 0; k <= last; k += 1) {
    const t = last > 0 ? k / last : 1;
    let pitch: number;
    if (k === last) {
      pitch = toMidi - dir; // chromatic leading-tone into the landing
    } else if (span >= slots.length) {
      pitch = ladder[Math.max(0, Math.min(ladder.length - 1, i0 + dir * k))];
    } else {
      const idx = i0 + dir * Math.round(t * span);
      pitch = ladder[Math.max(0, Math.min(ladder.length - 1, idx))];
    }
    if (k !== last && opts.ladderAt) pitch = snapToLadder(opts.ladderAt(slots[k].s), pitch, dir);
    const on = grid.onPosition(Math.round(slots[k].s));
    const pulse = on !== null && on.weight >= pulseWeight(on.b.meter);
    const vel = clampVel(baseVel + Math.round(t * 30) + (pulse ? 10 : 0));
    notes.push(mk(pitch, slots[k].s, slots[k].inc, vel));
    if (doubleOctave) notes.push(mk(pitch - 12, slots[k].s, slots[k].inc, clampVel(vel - 16)));
  }
  return notes;
}

// --- melody generator -------------------------------------------------------- //

export interface ChordSpan {
  triad: number[];
  start: number;
  len: number;
  /** The bar's time signature; absent means 4/4. */
  meter?: Meter;
  /** The scale the bar's melody and runs move in; absent means the section's ladder. */
  ladder?: number[];
}

interface MelodyOpts {
  /** Notes per quarter beat: 1 = quarters, 2 = 8ths, 3 = triplet-ish, 4 = 16ths. */
  density: number;
  seed: number;
  /** 0..1 arch height — how far the line rises mid-phrase and settles after. */
  arch: number;
  ornament: boolean;
  baseVel: number;
}

const stepUp = (ladder: number[], m: number): number =>
  ladder[Math.min(ladder.length - 1, nearestIndex(ladder, m) + 1)];

/**
 * Write a singable line over a chord span: chord tones anchor the strong beats
 * (chosen near a running cursor, biased by an arch contour), and the beats between
 * are connected by stepwise ladder motion (passing tones), with the occasional
 * appoggiatura resolving down onto the anchor. Returns the notes and the final
 * cursor so the next section continues the line.
 */
function genMelodyLine(
  spans: ChordSpan[],
  ladder: number[],
  cursor: number,
  opts: MelodyOpts,
): { notes: PianoNote[]; cursor: number } {
  const notes: PianoNote[] = [];
  if (!spans.length) return { notes, cursor };
  let cur = cursor;
  const totalStart = spans[0].start;
  const totalEnd = spans[spans.length - 1].start + spans[spans.length - 1].len;
  const totalLen = Math.max(1, totalEnd - totalStart);
  const inc = 4 / Math.max(1, opts.density);

  // 1. anchors: a chord tone on each group start and each quarter inside the
  // group, near the cursor + arch bias. Each anchor keeps its bar's ladder.
  const anchors: Array<{ step: number; midi: number; end: number; ladder: number[] }> = [];
  for (const sp of spans) {
    const barLadder = sp.ladder ?? ladder;
    const chordTones = barLadder.filter((m) => sp.triad.includes(((m % 12) + 12) % 12) && m >= RH_FLOOR - 5);
    if (!chordTones.length) continue;
    const slotsInBar = anchorSlots(sp.meter ?? DEFAULT_METER);
    slotsInBar.forEach((q, j) => {
      const step = sp.start + q;
      const phasePos = (step - totalStart) / totalLen;
      const archOff = Math.sin(phasePos * Math.PI) * opts.arch * 11;
      const jitter = (hash01(step + opts.seed * SEED_PRIME) - 0.5) * 3;
      const target = cur + archOff * 0.35 + jitter;
      let best = chordTones[0];
      let bd = Infinity;
      for (const m of chordTones) {
        const d = Math.abs(m - target);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      anchors.push({ step, midi: best, end: sp.start + (slotsInBar[j + 1] ?? sp.len), ladder: barLadder });
      cur = best;
    });
  }
  if (!anchors.length) return { notes, cursor: cur };

  // 2. connect anchors with stepwise passing motion at the chosen density, in
  // the scale of the bar the passing notes sound in.
  for (let a = 0; a < anchors.length; a += 1) {
    const cs = anchors[a].step;
    const cm = anchors[a].midi;
    const ns = a + 1 < anchors.length ? anchors[a + 1].step : anchors[a].end;
    const nm = a + 1 < anchors.length ? anchors[a + 1].midi : cm;
    const barLadder = anchors[a].ladder;
    const path = ladderPath(barLadder, cm, nm);
    const slots = Math.max(1, Math.round((ns - cs) / inc));
    for (let k = 0; k < slots; k += 1) {
      const step = cs + k * inc;
      const idx = slots > 1 ? Math.round((k / slots) * (path.length - 1)) : 0;
      const pitch = path[Math.max(0, Math.min(path.length - 1, idx))];
      const onBeat = k === 0;
      const vel = opts.baseVel + (onBeat ? 12 : 0) - (k % 2 === 1 ? 6 : 0);
      if (onBeat && opts.ornament && hash01(step + opts.seed * 7) < 0.16) {
        // appoggiatura: an upper neighbour on the beat resolving down to the anchor.
        notes.push(mk(stepUp(barLadder, pitch), step, inc * 0.5, clampVel(vel - 4)));
        notes.push(mk(pitch, step + inc * 0.5, inc * 0.5, clampVel(vel)));
      } else {
        notes.push(mk(pitch, step, inc, clampVel(vel)));
      }
    }
  }
  return { notes, cursor: cur };
}

// --- phrase transforms (amount 0..1, optional per-instance seed) ------------- //

/**
 * A diatonic third below a share of the top-line notes equal to `amount`, each
 * as long as its note, so the added line moves in parallel with the melody.
 * Past 0.66 about three in ten of those thirds drop a semitone, a borrowed or
 * modal tone. A note inside a scale span takes its third from that span's scale.
 */
export function harmonize(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  // Every MIDI note is on the ladder, so a line above C7 or below A1 still gets the third below it.
  const ladderOf = ladderCache(0, 127);
  const out = notes.map(clone);
  const top = topLine(notes);
  top.forEach((n, i) => {
    if (hash01(i * 7 + 101 + seed * SEED_PRIME) > amount) return;
    const ladder = ladderOf(scaleAt(opts, pcs, n.step));
    const idx = nearestIndex(ladder, n.note);
    if (idx < 2) return;
    let counter = ladder[idx - 2];
    if (amount > 0.66 && hash01(i * 13 + 211 + seed * SEED_PRIME) < 0.3) counter -= 1;
    // The counter note takes the melody note's own length, so a run shorter
    // than a 16th gets a counter run that stays detached.
    out.push(mk(counter, n.step, Math.max(MIN_NOTE_STEPS, n.length), Math.max(1, n.velocity - 18)));
  });
  return out.sort(byStepThenNote);
}

export function ragtimeStride(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const grid = gridOf(opts);
  const lastStep = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  const out: PianoNote[] = [];
  let prev: Voicing | null = null;
  for (const b of bars(grid.map, lastStep, grid.pickup)) {
    const inBar = notes.filter((n) => n.step >= b.start && n.step < b.start + b.len);
    if (!inBar.length) continue;
    // A pickup has no downbeat to stride from.
    if (b.bar < 0 || hash01(b.bar * 5 + 1 + seed * SEED_PRIME) > amount) {
      inBar.forEach((n) => out.push(clone(n)));
      continue;
    }
    const rootPc = inBar.reduce((lo, n) => (n.note < lo.note ? n : lo)).note % 12;
    const triad = triadFromScale(rootPc, scaleAt(opts, pcs, b.start));
    const voicing = voiceChord(triad, prev);
    prev = voicing;
    // Oom-pah left hand: bass then chord on the bar's pulse, alternating root/fifth low note.
    let ooms = 0;
    for (const p of pulses(b.meter)) {
      if (isOom(p)) {
        out.push(mk(ooms % 2 === 0 ? voicing.bass : voicing.bass + 7, b.start + p.at, 2, ooms % 2 === 0 ? 104 : 96));
        ooms += 1;
      } else {
        voicing.voices.forEach((m) => out.push(mk(m, b.start + p.at, 2, 74)));
      }
    }
    // Syncopated, accented right-hand stabs on the rag pattern — the "stabby" feel.
    const melody = topLine(inBar);
    stabs(b.meter).forEach((s, i) => {
      const src = melody[i % Math.max(1, melody.length)];
      const pitch = toRegister(src ? src.note : triad[i % triad.length]);
      out.push(mk(pitch, b.start + s.at, 1.5, s.accent ? 116 : 92));
    });
  }
  return out.sort(byStepThenNote);
}

export function runsAndFlourishes(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts & { chromatic?: boolean },
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const ladderOf = ladderCache();
  const grid = gridOf(opts);
  const anchors = topLine(notes);
  const out = notes.map(clone);
  const octaveDouble = amount > 0.66;
  let gapIndex = 0;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const gap = b.step - a.step;
    if (gap <= 1) continue;
    const fill = hash01(gapIndex * 3 + 1 + seed * SEED_PRIME) < amount;
    gapIndex += 1;
    if (!fill) continue;
    if (opts.chromatic) {
      // chromatic sweep into the target
      const seq = chromaticPath(a.note, b.note);
      const inc = amount > 0.8 ? 0.5 : 1;
      for (let s = inc; s < gap; s += inc) {
        const idx = Math.min(seq.length - 1, Math.floor((s / gap) * seq.length));
        out.push(mk(seq[idx], a.step + s, inc, clampVel(72 + Math.round((s / gap) * 50))));
      }
    } else {
      // scalar flourish that accelerates and lands on the next anchor (b). Past
      // ~0.75 the runs turn into true triplet flourishes for a virtuosic feel.
      // Each run note takes the scale of the step it sounds on, so a run into a
      // scale span changes scale where the span starts.
      const tuplet: 0 | 3 | 6 = amount > 0.75 && hash01(gapIndex * 5 + seed * SEED_PRIME) < amount ? 3 : 0;
      const from = a.step + inc0(gap);
      genRun(a.note, b.note, from, b.step, ladderOf(scaleAt(opts, pcs, from)), {
        baseVel: 74,
        doubleOctave: octaveDouble,
        accelAt: amount > 0.8 ? 0.35 : 0.6,
        tuplet,
        grid,
        ...(opts.scaleSpans?.length ? { ladderAt: (s: number) => ladderOf(scaleAt(opts, pcs, s)) } : {}),
      }).forEach((n) => out.push(n));
    }
  }
  return out.sort(byStepThenNote);
}

// A run starts a beat after its anchor so the anchor note still speaks.
const inc0 = (gap: number): number => (gap >= 4 ? 1 : 0.5);

/**
 * The rhythm slider's accent. A meter with no groups and a beat of a quarter or
 * longer gets 3 against its 16ths, counted from the start of its meter segment.
 * An additive or short-beat meter (7/8 3+2+2, 5/16) is its own cross-rhythm, so
 * the accent goes on its group and bar starts.
 */
function crossAccent(grid: Grid, step: number): boolean {
  const { meter } = grid.bar(step);
  if (!meter.groups.length && stepsPerBeat(meter) >= 4) return Math.abs((step - grid.segmentStart(step)) % 3) === 0;
  const on = grid.onPosition(step);
  return on !== null && on.weight >= 3;
}

export function polyrhythm(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const grid = gridOf(opts);
  return notes
    .map((n) => {
      let vel = n.velocity;
      if (crossAccent(grid, n.step)) vel = Math.min(127, vel + Math.round(34 * amount));
      else vel = Math.max(1, vel - Math.round(10 * amount));
      let step = n.step;
      // Push some odd 16ths (counted from the bar start) onto the next 16th.
      if (odd(grid.inBar(n.step)) && hash01(n.step * 9 + 17 + seed * SEED_PRIME) < amount * 0.5) step = n.step + 1;
      return mk(n.note, step, n.length, vel);
    })
    .sort(byStepThenNote);
}

/** The groove slot of a step: its 16th inside its bar, wrapped to the template's 16 slots. */
const slotOf = (grid: Grid, step: number): number => {
  const r = Math.round(step);
  return ((Math.round(grid.inBar(r)) % 16) + 16) % 16;
};
const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * Velocity dynamics + beat accents + micro-timing for a natural, un-rigid feel.
 * With a `groove`, the timing and emphasis come from the reference pocket (a
 * light random component remains); without one, an expressive push/pull is
 * synthesized (on-beats pull ahead, off-beats lay back). Bar starts take the
 * big accent and the bar's pulse (beats, or group starts in 7/8 and 5/16) the
 * small one; off-16ths count from the bar start.
 */
export function humanize(
  notes: PianoNote[],
  amount: number,
  seed = 0,
  groove?: GrooveTemplate,
  meter?: MeterOpts,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const grid = gridOf(meter);
  const meanAccent = groove ? avg(groove.accent) : 0;
  return notes.map((n, i) => {
    const slot = slotOf(grid, n.step);
    let vel = n.velocity;
    if (groove) vel += Math.round((groove.accent[slot] - meanAccent) * 44 * amount);
    else vel += Math.round((hash01(i + seed * 131) - 0.5) * 2 * 20 * amount);
    const on = grid.onPosition(n.step);
    if (on && on.weight >= 4) vel += Math.round(12 * amount);
    else if (on && on.weight >= pulseWeight(on.b.meter)) vel += Math.round(6 * amount);
    // Some notes grow or shrink by a 32nd (0.5 steps), or by half their own
    // length when that is less, so a note shorter than a 16th changes in
    // proportion to its length and never floors above the roll's one tick.
    let len = n.length;
    if (hash01(i + seed * 257) < amount * 0.3) {
      len = Math.max(MIN_NOTE_STEPS, len + (hash01(i) > 0.5 ? 1 : -1) * Math.min(0.5, len / 2));
    }
    let micro: number;
    if (groove) {
      micro = groove.timing[slot] * amount + (hash01(i * 3 + seed * 131 + 5) - 0.5) * amount * 0.03;
    } else {
      const laid = odd(grid.inBar(n.step)) ? 1 : -1;
      micro = (hash01(i * 3 + seed * 131 + 5) - 0.5 + laid * 0.4) * amount * 0.14;
    }
    return mk(n.note, Math.max(0, n.step + micro), len, clampVel(vel));
  });
}

/**
 * Anticipations. An onset on a strong position (weight 2 or more: a beat, a
 * group start or a bar start) is a candidate when a weaker position lies within
 * half a beat before it. Candidates go strongest position first, ties in seeded
 * order, until `amount` of them have moved. A moved note starts on the weakest
 * of those earlier positions (the nearest on a tie) and keeps its end, so it
 * grows; a humanized offset moves with it.
 */
export function syncopate(notes: PianoNote[], amount: number, opts: MeterOpts, seed = 0): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map((n) => ({ ...n }));
  const grid = gridOf(opts);
  const candidates: Array<{ i: number; weight: number; shift: number; order: number }> = [];
  notes.forEach((n, i) => {
    const on = grid.onPosition(n.step, ON_POSITION);
    if (!on || on.weight < 2) return;
    const reach = Math.max(1, Math.floor(stepsPerBeat(on.b.meter) / 2));
    let shift = 0;
    let weakest = on.weight;
    for (let d = 1; d <= reach && on.step - d > -EPS; d += 1) {
      const before = grid.onPosition(on.step - d);
      if (before && before.weight < weakest) {
        shift = d;
        weakest = before.weight;
      }
    }
    if (shift > 0) candidates.push({ i, weight: on.weight, shift, order: hash01(i * 7 + 29 + seed * SEED_PRIME) });
  });
  candidates.sort((a, b) => b.weight - a.weight || a.order - b.order || a.i - b.i);
  const take = Math.round(clamp01(amount) * candidates.length);
  const moved = new Map(candidates.slice(0, take).map((c) => [c.i, c.shift]));
  return notes
    .map((n, i) => {
      const shift = moved.get(i);
      if (shift === undefined) return clone(n);
      const step = q3(n.step - shift);
      return { ...n, id: uid(), step, length: q3(n.step + n.length - step) };
    })
    .sort(byStepThenNote);
}

/** Group and bar starts (weight 3 and up) louder by up to 30 at amount 1; every other note softer by up to 10. */
export function accentGroups(notes: PianoNote[], amount: number, opts: MeterOpts): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map((n) => ({ ...n }));
  const grid = gridOf(opts);
  const a = clamp01(amount);
  return notes.map((n) => {
    const on = grid.onPosition(n.step, ON_POSITION);
    const lift = on && on.weight >= 3 ? 30 * a : -10 * a;
    return { ...n, id: uid(), velocity: clampVel(n.velocity + lift) };
  });
}

/** Run the full phrase pipeline at the given amounts (optionally seeded). */
export function renderVirtuoso(
  source: PianoNote[],
  amounts: VirtuosoAmounts,
  opts: TransformOpts,
  seed = 0,
  groove?: GrooveTemplate,
): PianoNote[] {
  let n = source.map(clone);
  if (amounts.harmony > 0) n = harmonize(n, amounts.harmony, opts, seed);
  if (amounts.ragtime > 0) n = ragtimeStride(n, amounts.ragtime, opts, seed);
  if (amounts.runs > 0) n = runsAndFlourishes(n, amounts.runs, opts, seed);
  if (amounts.rhythm > 0) n = polyrhythm(n, amounts.rhythm, opts, seed);
  if (amounts.humanize > 0) n = humanize(n, amounts.humanize, seed, groove, opts);
  if (amounts.sync > 0) n = syncopate(n, amounts.sync, opts, seed);
  if (amounts.accent > 0) n = accentGroups(n, amounts.accent, opts);
  return n.sort(byStepThenNote);
}

// --- styles, roles, and the section renderer --------------------------------- //

/** Song-long dynamic arc: rise to the climax, then taper. */
function crescendoMult(pos: number, climaxAt: number): number {
  if (pos <= climaxAt) return 0.6 + 0.4 * (climaxAt > 0 ? pos / climaxAt : 1);
  return 1.0 - 0.24 * ((pos - climaxAt) / Math.max(0.001, 1 - climaxAt));
}

export type Role = 'intro' | 'theme' | 'build' | 'chorus' | 'interlude' | 'solo' | 'climax' | 'outro';

export const ROLES: Role[] = ['intro', 'theme', 'build', 'chorus', 'interlude', 'solo', 'climax', 'outro'];

export const ROLE_LABELS: Record<Role, string> = {
  intro: 'Intro',
  theme: 'Theme',
  build: 'Build',
  chorus: 'Chorus',
  interlude: 'Interlude',
  solo: 'Solo',
  climax: 'Climax',
  outro: 'Outro',
};

const ROLE_OCT: Record<Role, number> = {
  intro: 5, theme: 5, build: 5, chorus: 5, interlude: 4, solo: 6, climax: 6, outro: 4,
};
const ROLE_DYN: Record<Role, number> = {
  intro: 0.62, theme: 0.75, build: 0.85, chorus: 0.95, interlude: 0.55, solo: 0.9, climax: 1.0, outro: 0.6,
};

export interface SectionState {
  voicing: Voicing | null;
  cursor: number;
}

export interface RenderCtx {
  ladder: number[];
  chorusTexture: 'stride' | 'octaves';
  seed: number;
  /** The song's bars, for the runs' pulse accents (4/4 from step 0 when absent). */
  meter?: MeterOpts;
}

// --- accompaniment (left-hand) patterns for one bar -------------------------- //

export function accSustain(v: Voicing, at: number, vel: number, meter: Meter = DEFAULT_METER): PianoNote[] {
  const len = stepsPerBar(meter);
  const out = [mk(v.bass, at, len, vel)];
  v.voices.forEach((m) => out.push(mk(m, at, len, vel - 6)));
  return out;
}

export function accArpeggio(v: Voicing, at: number, vel: number, meter: Meter = DEFAULT_METER): PianoNote[] {
  const pattern = [v.bass, v.voices[0], v.voices[1], v.voices[2], v.voices[1], v.voices[0], v.voices[1], v.voices[2]];
  const len = stepsPerBar(meter);
  const out: PianoNote[] = [];
  for (let s = 0; s < len - EPS; s += 2) {
    out.push(mk(pattern[(s / 2) % pattern.length], at + s, Math.min(2, len - s), vel - (onPulse(meter, s) ? 0 : 8)));
  }
  return out;
}

export function accAlberti(v: Voicing, at: number, vel: number, meter: Meter = DEFAULT_METER): PianoNote[] {
  // Classic Alberti figure: low, high, middle, high.
  const pattern = [v.bass, v.voices[2], v.voices[1], v.voices[2]];
  const len = stepsPerBar(meter);
  const out: PianoNote[] = [];
  for (let s = 0; s < len - EPS; s += 2) {
    out.push(mk(pattern[(s / 2) % 4], at + s, Math.min(2, len - s), vel - (onPulse(meter, s) ? 0 : 8)));
  }
  return out;
}

export function accStride(v: Voicing, at: number, vel: number, meter: Meter = DEFAULT_METER): PianoNote[] {
  const ps = pulses(meter);
  const out: PianoNote[] = [];
  ps.filter(isOom).forEach((p, j) => out.push(mk(j % 2 === 0 ? v.bass : v.bass + 7, at + p.at, 2, j % 2 === 0 ? vel + 8 : vel)));
  const pahs = ps.filter((p) => !isOom(p));
  v.voices.forEach((m) => pahs.forEach((p) => out.push(mk(m, at + p.at, 2, vel - 10))));
  return out;
}

export function accOctaves(v: Voicing, at: number, vel: number, meter: Meter = DEFAULT_METER): PianoNote[] {
  const ps = pulses(meter);
  const len = stepsPerBar(meter);
  const out: PianoNote[] = [];
  ps.forEach((p, i) => {
    const hold = Math.min(3, (ps[i + 1]?.at ?? len) - p.at);
    out.push(mk(v.bass, at + p.at, hold, vel));
    out.push(mk(v.bass + 12, at + p.at, hold, vel - 12));
  });
  return out;
}

/**
 * Render ONE section (its own chord spans) with a distinct accompaniment + right
 * hand. Voicing and melodic cursor are threaded via `state` so harmony connects
 * and the melody flows across section boundaries.
 */
export function renderSection(
  role: Role,
  spans: ChordSpan[],
  state: SectionState,
  ctx: RenderCtx,
): PianoNote[] {
  const out: PianoNote[] = [];
  const oct = ROLE_OCT[role];
  const grid = gridOf(ctx.meter);
  const perBarVoicing: Voicing[] = spans.map((sp) => {
    const v = voiceChord(sp.triad, state.voicing);
    state.voicing = v;
    return v;
  });

  // Left hand.
  spans.forEach((sp, bi) => {
    const v = perBarVoicing[bi];
    const meter = sp.meter ?? DEFAULT_METER;
    switch (role) {
      case 'intro':
        accArpeggio(v, sp.start, 60, meter).forEach((n) => out.push(n));
        break;
      case 'theme':
      case 'build':
        accAlberti(v, sp.start, 66, meter).forEach((n) => out.push(n));
        break;
      case 'interlude':
      case 'outro':
        accSustain(v, sp.start, 62, meter).forEach((n) => out.push(n));
        break;
      case 'chorus':
        (ctx.chorusTexture === 'stride' ? accStride(v, sp.start, 92, meter) : accOctaves(v, sp.start, 96, meter)).forEach((n) =>
          out.push(n),
        );
        break;
      case 'solo':
        out.push(mk(v.bass, sp.start, sp.len, 78));
        v.voices.forEach((m) => out.push(mk(m, sp.start, sp.len, 60)));
        break;
      case 'climax':
        accOctaves(v, sp.start, 100, meter).forEach((n) => out.push(n));
        break;
    }
  });

  // Right hand.
  if (role === 'solo' || role === 'climax') {
    // Continuous runs that hand off from bar to bar, each landing on the next
    // chord tone — the extreme-dexterity passages.
    let cursor = state.cursor;
    spans.forEach((sp, bi) => {
      const next = spans[bi + 1] ?? sp;
      const nextTone = pcNearest(next.triad[0], MEL_CENTER + (oct - 5) * 12);
      // Vary the subdivision per bar so the passage isn't a uniform 16th run:
      // deterministic by bar+seed (stable across slider drags). Climax leans on
      // fast sextuplet-triplet runs; solo alternates straight and triplet feels.
      const roll = hash01(sp.start + bi * 7 + ctx.seed * SEED_PRIME);
      const tuplet: 0 | 3 | 6 = role === 'climax'
        ? roll < 0.5 ? 6 : 3
        : roll < 0.4 ? 3 : 0;
      genRun(cursor, nextTone, sp.start, sp.start + sp.len, sp.ladder ?? ctx.ladder, {
        baseVel: role === 'climax' ? 98 : 84,
        doubleOctave: true,
        accelAt: 0.4,
        tuplet,
        grid,
      }).forEach((n) => out.push(n));
      cursor = nextTone;
    });
    state.cursor = cursor;
  } else if (role === 'chorus') {
    // Voiced chord stabs on the rag pattern (stride) or the pulse (octaves),
    // plus a strong melodic top.
    spans.forEach((sp, bi) => {
      const v = perBarVoicing[bi];
      const top = v.voices.map((m) => m + 12).sort((a, b) => a - b);
      const meter = sp.meter ?? DEFAULT_METER;
      const hits = ctx.chorusTexture === 'stride' ? stabs(meter) : pulses(meter).map((p) => ({ at: p.at, accent: p.k % 2 === 0 }));
      hits.forEach((h) => top.forEach((m) => out.push(mk(m, sp.start + h.at, 1.5, h.accent ? 116 : 96))));
    });
    const mel = genMelodyLine(spans, ctx.ladder, state.cursor, {
      density: 2, seed: ctx.seed, arch: 0.5, ornament: false, baseVel: 96,
    });
    mel.notes.forEach((n) => out.push(mk(n.note + 12, n.step, n.length, n.velocity)));
    state.cursor = mel.cursor;
  } else {
    // Lyrical melody for intro / theme / build / interlude / outro.
    const density = role === 'build' ? 3 : role === 'intro' || role === 'interlude' || role === 'outro' ? 2 : 2;
    const arch = role === 'intro' ? 0.7 : role === 'build' ? 0.9 : 0.6;
    const baseVel = role === 'intro' || role === 'interlude' || role === 'outro' ? 74 : 84;
    const mel = genMelodyLine(spans, ctx.ladder, state.cursor, {
      density, seed: ctx.seed, arch, ornament: role !== 'outro', baseVel,
    });
    mel.notes.forEach((n) => out.push(n));
    state.cursor = mel.cursor;
    // A build's back half accelerates into a run toward the next section.
    if (role === 'build' && spans.length) {
      const lastSp = spans[spans.length - 1];
      const target = pcNearest(lastSp.triad[2], MEL_CENTER + 7);
      genRun(state.cursor, target, lastSp.start + midPulse(lastSp.meter ?? DEFAULT_METER), lastSp.start + lastSp.len, lastSp.ladder ?? ctx.ladder, {
        baseVel: 86, accelAt: 0.3, grid,
      }).forEach((n) => out.push(n));
      state.cursor = target;
    }
  }
  return out;
}

interface Style {
  label: string;
  /** Scale/mode this style implies (set on the store when chosen). */
  mode: string;
  climaxAt: number;
  humanize: number;
  /** Chord progression as scale degrees counted from the key's tonic (0 = I, 4 = V) — the harmonic movement. */
  progression: number[];
  /** Ordered arrangement of section roles, cycled to the target length. */
  arrangement: Role[];
  chorusTexture: 'stride' | 'octaves';
}

export const STYLES: Record<string, Style> = {
  romantic: {
    label: 'Rachmaninoff',
    mode: 'minor',
    climaxAt: 0.72,
    humanize: 0.5,
    progression: [0, 5, 3, 4],
    arrangement: ['intro', 'theme', 'theme', 'build', 'chorus', 'interlude', 'theme', 'build', 'climax', 'outro'],
    chorusTexture: 'octaves',
  },
  baroque: {
    label: 'Baroque',
    mode: 'dorian',
    climaxAt: 0.62,
    humanize: 0.3,
    progression: [0, 3, 4, 0, 5, 4],
    arrangement: ['theme', 'build', 'theme', 'solo', 'build', 'chorus', 'solo', 'climax', 'outro'],
    chorusTexture: 'octaves',
  },
  mussorgsky: {
    label: 'Mussorgsky',
    mode: 'aeolian',
    climaxAt: 0.78,
    humanize: 0.45,
    progression: [0, 6, 5, 0],
    arrangement: ['intro', 'chorus', 'interlude', 'chorus', 'build', 'climax', 'interlude', 'climax', 'outro'],
    chorusTexture: 'octaves',
  },
  flamenco: {
    label: 'Flamenco',
    mode: 'phrygian',
    climaxAt: 0.82,
    humanize: 0.55,
    progression: [0, 6, 5, 4],
    arrangement: ['intro', 'theme', 'solo', 'build', 'solo', 'climax', 'theme', 'climax', 'outro'],
    chorusTexture: 'octaves',
  },
  ragtime: {
    label: 'Ragtime',
    mode: 'major',
    climaxAt: 0.65,
    humanize: 0.4,
    progression: [0, 3, 4, 0],
    arrangement: ['intro', 'theme', 'chorus', 'theme', 'build', 'chorus', 'solo', 'chorus', 'outro'],
    chorusTexture: 'stride',
  },
};

export type StyleName = keyof typeof STYLES;
export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

/** A user-configurable section: a role played for a number of bars. */
export interface SectionSpec {
  role: Role;
  bars: number;
  /** The section's time signature; absent follows the roll's meter map. */
  meter?: Meter;
  /** The section's tempo in quarter notes a minute; absent follows the roll's tempo map. */
  bpm?: number;
}

/** A section tempo the song can hold: inside the app's 20..300, to the hundredth, or undefined. */
export const sanitizeSectionTempo = (bpm: unknown): number | undefined =>
  typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? clampTempoBpm(Math.round(bpm * 100) / 100) : undefined;

/** The default section layout for a style, one full harmonic cycle per section. */
export function defaultSections(style: StyleName): SectionSpec[] {
  const s = STYLES[style] ?? STYLES.romantic;
  const barsPer = Math.max(2, s.progression.length);
  return s.arrangement.map((role) => ({ role, bars: barsPer }));
}

export interface BuildSongOpts extends TransformOpts {
  style: StyleName;
  /** Global slider amounts, biasing the whole song on top of the textures. */
  amounts: VirtuosoAmounts;
  bpm: number;
  /** Target length in seconds when no explicit sections are given (default ~110). */
  targetSec?: number;
  /** Explicit section layout (song-structure configurator). Overrides the style. */
  sections?: SectionSpec[];
  /** Reference groove pocket applied by the final humanize pass. */
  groove?: GrooveTemplate;
  /**
   * The roll's tempo map (lib/rollTempo), which sections without a tempo of
   * their own follow. Absent means one tempo at `bpm`.
   */
  tempoMap?: readonly TempoEvent[];
}

export interface BuiltSong {
  notes: PianoNote[];
  /** The song's time signatures by bar: each section's meter, else the roll's map at that bar. */
  meterMap: MeterSegment[];
  /**
   * The song's tempo map: the roll's map, each section's own tempo over its
   * bars, and a ritardando over each section's last bar (songTempoMap).
   */
  tempoMap: TempoEvent[];
}

/** How much slower a section's last bar ends than it starts: 6% with Humanize at 0, up to 24% at 1. */
export const RIT_DEPTH_BASE = 0.06;
export const RIT_DEPTH_HUMANIZE = 0.18;
/** The final cadence's ritardando is this many times deeper than a section's. */
export const RIT_FINAL_MULT = 2.2;
/** The deepest ritardando: the last bar ends at half its tempo. */
export const RIT_DEPTH_MAX = 0.5;

/** The share of its tempo a section's last bar gives up by its end. */
export const ritDepth = (humanize: number, final: boolean): number =>
  Math.min(RIT_DEPTH_MAX, (RIT_DEPTH_BASE + RIT_DEPTH_HUMANIZE * clamp01(humanize)) * (final ? RIT_FINAL_MULT : 1));

/** One section's place in quarter-note beats from the roll's first step, and its own tempo. */
export interface SectionBeats {
  start: number;
  /** Where its last bar starts. */
  lastBar: number;
  end: number;
  bpm?: number;
}

/** A ritardando ends one tick before its section does, so the next section's tempo starts on the bar line. */
const RIT_END_BEATS = 1 / PPQ;

/**
 * The song's tempo map. `base` is the roll's map, which sections without a
 * tempo of their own follow. A section with a tempo holds it from its first
 * bar line to its end, where the roll's map takes over again. Then each
 * section's last bar ramps linearly from the tempo in force at its bar line to
 * `1 - ritDepth` of the tempo in force at its end, reached one tick before the
 * end, and the next section starts at the tempo the ramp interrupted ("a
 * tempo"). The final section's ramp is deeper, and its slowed tempo holds after
 * the song. The roll's fermatas stay where they are.
 */
export function songTempoMap(
  base: readonly TempoEvent[],
  startBpm: number,
  sections: readonly SectionBeats[],
  humanize: number,
): TempoEvent[] {
  const own = sanitizeRollTempoMap(base, startBpm);
  const holds = own.filter((e) => !!e.fermata);
  const baseTempi = own.filter((e) => !e.fermata);
  const tempos = new Map<number, TempoEvent>(baseTempi.map((e) => [e.beat, e]));
  const list = (): TempoEvent[] => [...tempos.values()].sort((a, b) => a.beat - b.beat);
  /** The curve of the tempo point that owns `beat`. */
  const curveAt = (events: readonly TempoEvent[], beat: number): TempoCurve => {
    let curve: TempoCurve = 'step';
    for (const e of events) if (e.beat <= beat) curve = e.curve === 'linear' ? 'linear' : 'step';
    return curve;
  };
  const put = (beat: number, bpm: number, curve: TempoCurve): void => {
    tempos.set(beat, { beat, bpm: clampTempoBpm(bpm), curve });
  };
  /** Removes the tempo points in [from, to), or in (from, to) when `fromIncluded` is false. */
  const dropInside = (from: number, to: number, fromIncluded: boolean): void => {
    for (const beat of [...tempos.keys()]) if ((fromIncluded ? beat >= from : beat > from) && beat < to) tempos.delete(beat);
  };

  // Each section's own tempo over its bars; the roll's map resumes at its end.
  for (const sec of sections) {
    const bpm = sanitizeSectionTempo(sec.bpm);
    if (bpm === undefined || !(sec.end > sec.start)) continue;
    const resume = { bpm: getTempoAtBeat(baseTempi, sec.end), curve: curveAt(baseTempi, sec.end) };
    dropInside(sec.start, sec.end, true);
    put(sec.start, bpm, 'step');
    if (!tempos.has(sec.end)) put(sec.end, resume.bpm, resume.curve);
  }

  // A ritardando over each section's last bar.
  sections.forEach((sec, i) => {
    const final = i === sections.length - 1;
    const from = sec.lastBar;
    const until = sec.end - RIT_END_BEATS;
    if (!(until > from)) return;
    const now = list();
    const startTempo = getTempoAtBeat(now, from);
    const endTempo = getTempoAtBeat(now, until);
    // "A tempo": the tempo the ramp interrupts, unless a point already starts the next section.
    const aTempo = { bpm: getTempoAtBeat(now, sec.end), curve: curveAt(now, sec.end) };
    dropInside(from, sec.end, false);
    put(from, startTempo, 'linear');
    put(until, endTempo * (1 - ritDepth(humanize, final)), 'step');
    if (!final && !tempos.has(sec.end)) put(sec.end, aTempo.bpm, aTempo.curve);
  });

  return sanitizeRollTempoMap([...list(), ...holds], startBpm);
}

/** Build the ordered section list, either explicit or derived from the style. */
function resolveSections(opts: BuildSongOpts): SectionSpec[] {
  if (opts.sections && opts.sections.length) {
    return opts.sections.map((s) => {
      const meter = sanitizeMeter(s.meter);
      const bpm = sanitizeSectionTempo(s.bpm);
      return { role: s.role, bars: Math.max(1, Math.round(s.bars)), ...(meter ? { meter } : {}), ...(bpm !== undefined ? { bpm } : {}) };
    });
  }
  const style = STYLES[opts.style] ?? STYLES.romantic;
  const bpm = Math.max(40, Math.min(300, opts.bpm || 120));
  const barSec = barSeconds(meterAtBar(normalizeMeterMap(opts.meterMap), 0), 60 / bpm);
  const targetBars = Math.max(style.progression.length * 3, Math.ceil((opts.targetSec ?? 110) / barSec));
  const barsPer = Math.max(2, style.progression.length);
  const out: SectionSpec[] = [];
  let total = 0;
  let ai = 0;
  while (total < targetBars && ai < 200) {
    const role = style.arrangement[ai % style.arrangement.length];
    out.push({ role, bars: barsPer });
    total += barsPer;
    ai += 1;
  }
  return out;
}

/**
 * Build a full, developing arrangement. Lay out a voice-led chord plan (with
 * cadences), render each section with its own texture + real melody, shape it with
 * a crescendo arc, then bias with the global sliders. Sections come from the
 * configurator when given, else from the style. Bar 0 starts after the roll's
 * pickup, and each bar takes its section's meter or the roll's meter at that
 * bar; the result carries the meter map that follows. The phrasing is the
 * result's tempo map (songTempoMap): every note stays on its step, and only
 * humanize's small micro-timing moves it.
 */
export function buildSong(source: PianoNote[], opts: BuildSongOpts): BuiltSong {
  const rollMap = normalizeMeterMap(opts.meterMap);
  const startBpm = clampTempoBpm(opts.bpm > 0 ? opts.bpm : 120);
  if (!source.length) return { notes: [], meterMap: rollMap, tempoMap: sanitizeRollTempoMap(opts.tempoMap, startBpm) };
  const style = STYLES[opts.style] ?? STYLES.romantic;
  // Degrees count from the key's tonic; the sorted set feeds the ladders.
  const degrees = scaleDegrees(opts.key, opts.mode);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const ladder = scaleLadder(pcs);
  const sections = resolveSections(opts);
  const totalBars = Math.max(1, sections.reduce((n, s) => n + s.bars, 0));

  const barMeters: Meter[] = [];
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b += 1) barMeters.push(sec.meter ?? meterAtBar(rollMap, barMeters.length));
  }
  const meterMap = normalizeMeterMap(barMeters.map((meter, bar) => ({ bar, meter })));
  const songStart = Math.max(0, opts.pickupSteps ?? 0);
  const barStart: number[] = [];
  let songEnd = songStart;
  for (const m of barMeters) {
    barStart.push(songEnd);
    songEnd += stepsPerBar(m);
  }

  // Chord plan: cycle the degree progression bar by bar across the whole song,
  // then impose cadences — a half cadence (V) to end the intro, and an authentic
  // cadence (V -> I) to close the piece — so the harmony has goals.
  const degSeq: number[] = [];
  for (let b = 0; b < totalBars; b += 1) degSeq.push(style.progression[b % style.progression.length]);
  const introBars = sections[0]?.role === 'intro' ? sections[0].bars : 0;
  if (introBars > 0) degSeq[introBars - 1] = 4; // half cadence
  if (totalBars >= 2) {
    degSeq[totalBars - 1] = 0; // tonic
    degSeq[totalBars - 2] = 4; // dominant
  }

  // A cadential V is a V that ends a section (the intro's half cadence among
  // them) or leads into the final tonic. In a minor mode it takes the leading
  // tone, in its chord and in every note written over its bar.
  const cadential = new Set<number>();
  let sectionEnd = 0;
  for (const sec of sections) {
    sectionEnd += sec.bars;
    if (degSeq[sectionEnd - 1] === 4) cadential.add(sectionEnd - 1);
  }
  if (totalBars >= 2) cadential.add(totalBars - 2);
  const raises = cadentialRaises(degrees);
  const raise = (pc: number): number => raises.get(pc) ?? pc;
  const cadPcs = Array.from(new Set(pcs.map(raise))).sort((a, b) => a - b);
  const cadLadder = scaleLadder(cadPcs);
  const scaleSpans: ScaleSpan[] = raises.size
    ? [...cadential].sort((a, b) => a - b).map((bar) => ({ start: barStart[bar], end: barStart[bar] + stepsPerBar(barMeters[bar]), pcs: cadPcs }))
    : [];

  const o: TransformOpts = { key: opts.key, mode: opts.mode, meterMap, pickupSteps: songStart, ...(scaleSpans.length ? { scaleSpans } : {}) };
  const ctx: RenderCtx = { ladder, chorusTexture: style.chorusTexture, seed: 1, meter: o };
  const state: SectionState = { voicing: null, cursor: MEL_CENTER };
  const out: PianoNote[] = [];
  const sectionBeats: SectionBeats[] = [];
  const humAmt = clamp01(style.humanize * 0.6 + opts.amounts.humanize);

  let cursorBar = 0;
  let cursorStep = songStart;
  sections.forEach((sec, si) => {
    ctx.seed = si + 1;
    const spans: ChordSpan[] = [];
    for (let b = 0; b < sec.bars; b += 1) {
      const bar = cursorBar + b;
      const meter = barMeters[bar];
      const len = stepsPerBar(meter);
      const triad = chordAtDegree(degSeq[bar] ?? 0, degrees);
      if (raises.size && cadential.has(bar)) spans.push({ triad: triad.map(raise), start: cursorStep, len, meter, ladder: cadLadder });
      else spans.push({ triad, start: cursorStep, len, meter });
      cursorStep += len;
    }
    const notes = renderSection(sec.role, spans, state, ctx);
    // crescendo across the whole song, scaled by the role's dynamic weight.
    for (const n of notes) {
      const pos = songEnd > songStart ? (n.step - songStart) / (songEnd - songStart) : 0;
      const dyn = crescendoMult(pos, style.climaxAt) * ROLE_DYN[sec.role];
      out.push(mk(n.note, n.step, n.length, n.velocity * dyn));
    }
    // Where the section and its last bar sit, for its ritardando in the tempo map.
    sectionBeats.push({ start: spans[0].start / 4, lastBar: spans[spans.length - 1].start / 4, end: cursorStep / 4, bpm: sec.bpm });
    cursorBar += sec.bars;
  });

  // Global slider bias on the finished song (light, additive where possible).
  let notes = out;
  if (opts.amounts.ragtime > 0) notes = ragtimeStride(notes, opts.amounts.ragtime * 0.4, o, 11);
  if (opts.amounts.harmony > 0) notes = harmonize(notes, opts.amounts.harmony * 0.5, o, 12);
  if (opts.amounts.runs > 0) notes = runsAndFlourishes(notes, opts.amounts.runs * 0.5, o, 13);
  if (opts.amounts.rhythm > 0) notes = polyrhythm(notes, opts.amounts.rhythm * 0.6, o, 14);
  notes = humanize(notes, humAmt, 7, opts.groove, o);
  if (opts.amounts.sync > 0) notes = syncopate(notes, opts.amounts.sync, o, 15);
  if (opts.amounts.accent > 0) notes = accentGroups(notes, opts.amounts.accent, o);

  // The phrasing: a ritardando into each section end, written as tempo.
  const tempo = songTempoMap(opts.tempoMap ?? [], startBpm, sectionBeats, opts.amounts.humanize);
  return { notes: notes.sort(byStepThenNote), meterMap, tempoMap: tempo };
}
