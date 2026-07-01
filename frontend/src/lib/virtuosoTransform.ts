/**
 * Virtuoso transforms — rewrite simple piano-roll material (an arpeggio, a chord
 * progression, anything) into idiomatic, technically demanding lines, each under
 * a continuous 0..1 "amount" so the result can be dialed and morphed live, and
 * assemble those into full, developing, stylistic arrangements.
 *
 * Phrase transforms (each amount 0..1, optionally seeded per instance):
 *   harmony  — diatonic counter-line (contrary motion) + borrowed/modal tones.
 *   ragtime  — Joplin stride: oom-pah LH under syncopated, accented RH stabs.
 *   runs     — Rudess scalar/chromatic flourishes that LAND on chord tones.
 *   rhythm   — polyrhythm/odd-meter feel via 3-against-4 cross-accents.
 *   humanize — velocity dynamics, beat accents, and phrase-shaped rubato.
 *
 * `buildSong` composes rather than repeats. It (1) lays out a chord plan from the
 * style's degree progression with real cadences, (2) voices every chord by
 * nearest-neighbor VOICE-LEADING (so inner voices move minimally, not in parallel
 * blocks), (3) writes an actual MELODY over it (stepwise motion, passing/neighbor
 * tones, appoggiaturas, an arch contour), and (4) renders each section with its
 * own accompaniment + right-hand behaviour (sustained, Alberti, arpeggio, stride,
 * octave stabs, or continuous runs). A song-long crescendo, phrase-shaped
 * rubato, and the four global sliders shape the finished result.
 *
 * Positions live on a 16th grid but allow fractional steps (32nd = 0.5, 64th =
 * 0.25, plus micro-timing), which the time-based preview scheduler plays and the
 * bounce path rounds — so runs and rubato both preview and render.
 */
import { MusicalScale, noteNameToMidi } from './arpEngine';
import type { PianoNote } from '../state/pianoRollStore';

const STEPS_PER_BAR = 16; // 4/4 on a 16th-note grid
const RH_FLOOR = 60; // C4 — right-hand register floor
const MEL_CENTER = 74; // D5 — melodic register center
const VOICE_CENTER = 52; // E3 — left-hand voicing center
const BASS_CENTER = 36; // C2 — bass register center
const SEED_PRIME = 1009;

export interface TransformOpts {
  key: string;
  mode: string;
}

/** Per-stage strength, each 0..1. */
export interface VirtuosoAmounts {
  harmony: number;
  ragtime: number;
  runs: number;
  rhythm: number;
  humanize: number;
}

export const ZERO_AMOUNTS: VirtuosoAmounts = { harmony: 0, ragtime: 0, runs: 0, rhythm: 0, humanize: 0 };

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
// are unaffected (round-trips exactly).
const q3 = (v: number): number => Math.round(v * 1000) / 1000;
const mk = (note: number, step: number, length: number, velocity: number): PianoNote => ({
  id: uid(),
  note: clampMidi(note),
  step: Math.max(0, q3(step)),
  length: Math.max(0.25, q3(length)),
  velocity: clampVel(velocity),
});

const pcOf = (name: string): number => noteNameToMidi(name, 0) % 12;
const pcToMidi = (pc: number, octave: number): number => (octave + 1) * 12 + (((pc % 12) + 12) % 12);

function scalePitchClasses(key: string, mode: string): number[] {
  const ms = new MusicalScale({ key, mode });
  const pcs = ms.notes.map((n) => pcOf(n.note));
  return Array.from(new Set(pcs)).sort((a, b) => a - b);
}

function scaleLadder(pcs: number[], lo = 33, hi = 96): number[] {
  const set = new Set(pcs);
  const out: number[] = [];
  for (let m = lo; m <= hi; m += 1) if (set.has(((m % 12) + 12) % 12)) out.push(m);
  return out;
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

/** Diatonic triad pitch classes seated on a scale DEGREE (0-indexed). */
function chordAtDegree(deg: number, pcs: number[]): number[] {
  const i = ((deg % pcs.length) + pcs.length) % pcs.length;
  return [pcs[i], pcs[(i + 2) % pcs.length], pcs[(i + 4) % pcs.length]];
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

// --- voice-leading ----------------------------------------------------------- //

interface Voicing {
  bass: number;
  voices: number[];
}

/**
 * Voice a triad so each tone moves to its nearest neighbour from the previous
 * voicing (smooth inner-voice motion, inversions chosen implicitly) rather than
 * jumping in parallel root-position blocks. The bass tracks the root register.
 */
function voiceChord(triad: number[], prev: Voicing | null, center = VOICE_CENTER): Voicing {
  const voices = triad.map((pc, i) => {
    const target = prev ? (prev.voices[i] ?? center) : center + (i - 1) * 4;
    return Math.max(30, Math.min(84, pcNearest(pc, target)));
  });
  voices.sort((a, b) => a - b);
  const bassTarget = prev ? prev.bass : BASS_CENTER;
  const bass = Math.max(24, Math.min(52, pcNearest(triad[0], bassTarget)));
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
    const vel = clampVel(baseVel + Math.round(t * 30) + (Math.round(slots[k].s) % 4 === 0 ? 10 : 0));
    notes.push(mk(pitch, slots[k].s, slots[k].inc, vel));
    if (doubleOctave) notes.push(mk(pitch - 12, slots[k].s, slots[k].inc, clampVel(vel - 16)));
  }
  return notes;
}

// --- melody generator -------------------------------------------------------- //

interface ChordSpan {
  triad: number[];
  start: number;
  len: number;
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

  // 1. anchors: one chord tone per quarter beat, near the cursor + arch bias.
  const anchors: Array<{ step: number; midi: number }> = [];
  for (const sp of spans) {
    const chordTones = ladder.filter((m) => sp.triad.includes(((m % 12) + 12) % 12) && m >= RH_FLOOR - 5);
    if (!chordTones.length) continue;
    for (let q = 0; q < sp.len; q += 4) {
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
      anchors.push({ step, midi: best });
      cur = best;
    }
  }
  if (!anchors.length) return { notes, cursor: cur };

  // 2. connect anchors with stepwise passing motion at the chosen density.
  for (let a = 0; a < anchors.length; a += 1) {
    const cs = anchors[a].step;
    const cm = anchors[a].midi;
    const ns = a + 1 < anchors.length ? anchors[a + 1].step : cs + 4;
    const nm = a + 1 < anchors.length ? anchors[a + 1].midi : cm;
    const path = ladderPath(ladder, cm, nm);
    const slots = Math.max(1, Math.round((ns - cs) / inc));
    for (let k = 0; k < slots; k += 1) {
      const step = cs + k * inc;
      const idx = slots > 1 ? Math.round((k / slots) * (path.length - 1)) : 0;
      const pitch = path[Math.max(0, Math.min(path.length - 1, idx))];
      const onBeat = k === 0;
      const vel = opts.baseVel + (onBeat ? 12 : 0) - (k % 2 === 1 ? 6 : 0);
      if (onBeat && opts.ornament && hash01(step + opts.seed * 7) < 0.16) {
        // appoggiatura: an upper neighbour on the beat resolving down to the anchor.
        notes.push(mk(stepUp(ladder, pitch), step, inc * 0.5, clampVel(vel - 4)));
        notes.push(mk(pitch, step + inc * 0.5, inc * 0.5, clampVel(vel)));
      } else {
        notes.push(mk(pitch, step, inc, clampVel(vel)));
      }
    }
  }
  return { notes, cursor: cur };
}

// --- phrase transforms (amount 0..1, optional per-instance seed) ------------- //

export function harmonize(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const ladder = scaleLadder(pcs);
  const out = notes.map(clone);
  const top = topLine(notes);
  top.forEach((n, i) => {
    if (hash01(i * 7 + 101 + seed * SEED_PRIME) > amount) return;
    const idx = nearestIndex(ladder, n.note);
    let counter = ladder[Math.max(0, idx - 2)];
    if (amount > 0.66 && hash01(i * 13 + 211 + seed * SEED_PRIME) < 0.3) counter -= 1;
    out.push(mk(counter, n.step, Math.max(1, n.length), Math.max(1, n.velocity - 18)));
  });
  return out.sort(byStepThenNote);
}

// Ragtime "secondary rag" / tresillo accent pattern within a bar.
const TRESILLO = [0, 3, 6, 10, 13];

export function ragtimeStride(
  notes: PianoNote[],
  amount: number,
  opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const lastStep = notes.reduce((m, n) => Math.max(m, n.step + Math.max(1, n.length)), 0);
  const bars = Math.max(1, Math.ceil(lastStep / STEPS_PER_BAR));
  const out: PianoNote[] = [];
  let prev: Voicing | null = null;
  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * STEPS_PER_BAR;
    const inBar = notes.filter((n) => n.step >= barStart && n.step < barStart + STEPS_PER_BAR);
    if (!inBar.length) continue;
    if (hash01(bar * 5 + 1 + seed * SEED_PRIME) > amount) {
      inBar.forEach((n) => out.push(clone(n)));
      continue;
    }
    const rootPc = inBar.reduce((lo, n) => (n.note < lo.note ? n : lo)).note % 12;
    const triad = triadFromScale(rootPc, pcs);
    const voicing = voiceChord(triad, prev);
    prev = voicing;
    // Oom-pah left hand: root then chord, alternating root/fifth low note.
    out.push(mk(voicing.bass, barStart + 0, 2, 104));
    voicing.voices.forEach((m) => out.push(mk(m, barStart + 4, 2, 74)));
    out.push(mk(voicing.bass + 7, barStart + 8, 2, 96));
    voicing.voices.forEach((m) => out.push(mk(m, barStart + 12, 2, 74)));
    // Syncopated, accented right-hand stabs on the tresillo — the "stabby" feel.
    const melody = topLine(inBar);
    TRESILLO.forEach((s, i) => {
      const src = melody[i % Math.max(1, melody.length)];
      const pitch = toRegister(src ? src.note : triad[i % triad.length]);
      out.push(mk(pitch, barStart + s, 1.5, i % 2 === 0 ? 116 : 92));
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
  const ladder = scaleLadder(pcs);
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
      const tuplet: 0 | 3 | 6 = amount > 0.75 && hash01(gapIndex * 5 + seed * SEED_PRIME) < amount ? 3 : 0;
      genRun(a.note, b.note, a.step + inc0(gap), b.step, ladder, {
        baseVel: 74,
        doubleOctave: octaveDouble,
        accelAt: amount > 0.8 ? 0.35 : 0.6,
        tuplet,
      }).forEach((n) => out.push(n));
    }
  }
  return out.sort(byStepThenNote);
}

// A run starts a beat after its anchor so the anchor note still speaks.
const inc0 = (gap: number): number => (gap >= 4 ? 1 : 0.5);

export function polyrhythm(
  notes: PianoNote[],
  amount: number,
  _opts: TransformOpts,
  seed = 0,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  return notes
    .map((n) => {
      let vel = n.velocity;
      if (n.step % 3 === 0) vel = Math.min(127, vel + Math.round(34 * amount));
      else vel = Math.max(1, vel - Math.round(10 * amount));
      let step = n.step;
      if (n.step % 2 === 1 && hash01(n.step * 9 + 17 + seed * SEED_PRIME) < amount * 0.5) step = n.step + 1;
      return mk(n.note, step, n.length, vel);
    })
    .sort(byStepThenNote);
}

const slotOf = (step: number): number => ((Math.round(step) % 16) + 16) % 16;
const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * Velocity dynamics + beat accents + micro-timing for a natural, un-rigid feel.
 * With a `groove`, the timing and emphasis come from the reference pocket (a
 * light random component remains); without one, an expressive push/pull is
 * synthesized (on-beats pull ahead, off-beats lay back).
 */
export function humanize(
  notes: PianoNote[],
  amount: number,
  seed = 0,
  groove?: GrooveTemplate,
): PianoNote[] {
  if (amount <= 0 || !notes.length) return notes.map(clone);
  const meanAccent = groove ? avg(groove.accent) : 0;
  return notes.map((n, i) => {
    const slot = slotOf(n.step);
    let vel = n.velocity;
    if (groove) vel += Math.round((groove.accent[slot] - meanAccent) * 44 * amount);
    else vel += Math.round((hash01(i + seed * 131) - 0.5) * 2 * 20 * amount);
    if (n.step % STEPS_PER_BAR === 0) vel += Math.round(12 * amount);
    else if (n.step % 4 === 0) vel += Math.round(6 * amount);
    let len = n.length;
    if (hash01(i + seed * 257) < amount * 0.3) len = Math.max(0.25, len + (hash01(i) > 0.5 ? 0.5 : -0.5));
    let micro: number;
    if (groove) {
      micro = groove.timing[slot] * amount + (hash01(i * 3 + seed * 131 + 5) - 0.5) * amount * 0.03;
    } else {
      const laid = n.step % 2 === 1 ? 1 : -1;
      micro = (hash01(i * 3 + seed * 131 + 5) - 0.5 + laid * 0.4) * amount * 0.14;
    }
    return mk(n.note, Math.max(0, n.step + micro), len, clampVel(vel));
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
  if (amounts.humanize > 0) n = humanize(n, amounts.humanize, seed, groove);
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

interface SectionState {
  voicing: Voicing | null;
  cursor: number;
}

interface RenderCtx {
  ladder: number[];
  chorusTexture: 'stride' | 'octaves';
  seed: number;
}

// --- accompaniment (left-hand) patterns for one bar -------------------------- //

function accSustain(v: Voicing, at: number, vel: number): PianoNote[] {
  const out = [mk(v.bass, at, 16, vel)];
  v.voices.forEach((m) => out.push(mk(m, at, 16, vel - 6)));
  return out;
}

function accArpeggio(v: Voicing, at: number, vel: number): PianoNote[] {
  const pattern = [v.bass, v.voices[0], v.voices[1], v.voices[2], v.voices[1], v.voices[0], v.voices[1], v.voices[2]];
  const out: PianoNote[] = [];
  for (let s = 0; s < 16; s += 2) out.push(mk(pattern[(s / 2) % pattern.length], at + s, 2, vel - (s % 4 ? 8 : 0)));
  return out;
}

function accAlberti(v: Voicing, at: number, vel: number): PianoNote[] {
  // Classic Alberti figure: low, high, middle, high.
  const pattern = [v.bass, v.voices[2], v.voices[1], v.voices[2]];
  const out: PianoNote[] = [];
  for (let s = 0; s < 16; s += 2) out.push(mk(pattern[(s / 2) % 4], at + s, 2, vel - (s % 4 ? 8 : 0)));
  return out;
}

function accStride(v: Voicing, at: number, vel: number): PianoNote[] {
  const out = [
    mk(v.bass, at + 0, 2, vel + 8),
    mk(v.bass + 7, at + 8, 2, vel),
  ];
  v.voices.forEach((m) => {
    out.push(mk(m, at + 4, 2, vel - 10));
    out.push(mk(m, at + 12, 2, vel - 10));
  });
  return out;
}

function accOctaves(v: Voicing, at: number, vel: number): PianoNote[] {
  const out: PianoNote[] = [];
  [0, 4, 8, 12].forEach((s) => {
    out.push(mk(v.bass, at + s, 3, vel));
    out.push(mk(v.bass + 12, at + s, 3, vel - 12));
  });
  return out;
}

/**
 * Render ONE section (its own chord spans) with a distinct accompaniment + right
 * hand. Voicing and melodic cursor are threaded via `state` so harmony connects
 * and the melody flows across section boundaries.
 */
function renderSection(
  role: Role,
  spans: ChordSpan[],
  state: SectionState,
  ctx: RenderCtx,
): PianoNote[] {
  const out: PianoNote[] = [];
  const oct = ROLE_OCT[role];
  const perBarVoicing: Voicing[] = spans.map((sp) => {
    const v = voiceChord(sp.triad, state.voicing);
    state.voicing = v;
    return v;
  });

  // Left hand.
  spans.forEach((sp, bi) => {
    const v = perBarVoicing[bi];
    switch (role) {
      case 'intro':
        accArpeggio(v, sp.start, 60).forEach((n) => out.push(n));
        break;
      case 'theme':
      case 'build':
        accAlberti(v, sp.start, 66).forEach((n) => out.push(n));
        break;
      case 'interlude':
      case 'outro':
        accSustain(v, sp.start, 62).forEach((n) => out.push(n));
        break;
      case 'chorus':
        (ctx.chorusTexture === 'stride' ? accStride(v, sp.start, 92) : accOctaves(v, sp.start, 96)).forEach((n) =>
          out.push(n),
        );
        break;
      case 'solo':
        out.push(mk(v.bass, sp.start, 16, 78));
        v.voices.forEach((m) => out.push(mk(m, sp.start, 16, 60)));
        break;
      case 'climax':
        accOctaves(v, sp.start, 100).forEach((n) => out.push(n));
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
      genRun(cursor, nextTone, sp.start, sp.start + sp.len, ctx.ladder, {
        baseVel: role === 'climax' ? 98 : 84,
        doubleOctave: true,
        accelAt: 0.4,
        tuplet,
      }).forEach((n) => out.push(n));
      cursor = nextTone;
    });
    state.cursor = cursor;
  } else if (role === 'chorus') {
    // Voiced chord stabs on the tresillo (stride) or the beats (octaves), plus a
    // strong melodic top.
    const stabSteps = ctx.chorusTexture === 'stride' ? TRESILLO : [0, 4, 8, 12];
    spans.forEach((sp, bi) => {
      const v = perBarVoicing[bi];
      const top = v.voices.map((m) => m + 12).sort((a, b) => a - b);
      stabSteps.forEach((s, i) => top.forEach((m) => out.push(mk(m, sp.start + s, 1.5, i % 2 ? 96 : 116))));
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
      genRun(state.cursor, target, lastSp.start + 8, lastSp.start + lastSp.len, ctx.ladder, {
        baseVel: 86, accelAt: 0.3,
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
  /** Chord progression as scale degrees (0-indexed) — the harmonic movement. */
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
}

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
}

/** Build the ordered section list, either explicit or derived from the style. */
function resolveSections(opts: BuildSongOpts): SectionSpec[] {
  if (opts.sections && opts.sections.length) {
    return opts.sections.map((s) => ({ role: s.role, bars: Math.max(1, Math.round(s.bars)) }));
  }
  const style = STYLES[opts.style] ?? STYLES.romantic;
  const bpm = Math.max(40, Math.min(300, opts.bpm || 120));
  const barSec = (60 / bpm) * 4;
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
 * a crescendo arc and phrase-shaped rubato, then bias with the four global
 * sliders. Sections come from the configurator when given, else from the style.
 */
export function buildSong(source: PianoNote[], opts: BuildSongOpts): PianoNote[] {
  if (!source.length) return [];
  const style = STYLES[opts.style] ?? STYLES.romantic;
  const pcs = scalePitchClasses(opts.key, opts.mode);
  const ladder = scaleLadder(pcs);
  const sections = resolveSections(opts);
  const totalBars = Math.max(1, sections.reduce((n, s) => n + s.bars, 0));

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

  const ctx: RenderCtx = { ladder, chorusTexture: style.chorusTexture, seed: 1 };
  const state: SectionState = { voicing: null, cursor: MEL_CENTER };
  const out: PianoNote[] = [];
  const ritPoints: Array<{ end: number; depth: number }> = [];
  const humAmt = clamp01(style.humanize * 0.6 + opts.amounts.humanize);
  const rubatoDepth = 0.5 + opts.amounts.humanize * 2.5;

  let cursorBar = 0;
  sections.forEach((sec, si) => {
    ctx.seed = si + 1;
    const spans: ChordSpan[] = [];
    for (let b = 0; b < sec.bars; b += 1) {
      const bar = cursorBar + b;
      spans.push({ triad: chordAtDegree(degSeq[bar] ?? 0, pcs), start: bar * STEPS_PER_BAR, len: STEPS_PER_BAR });
    }
    const secStart = cursorBar * STEPS_PER_BAR;
    const secEnd = (cursorBar + sec.bars) * STEPS_PER_BAR;
    const notes = renderSection(sec.role, spans, state, ctx);
    // crescendo across the whole song, scaled by the role's dynamic weight.
    for (const n of notes) {
      const pos = totalBars > 0 ? n.step / (totalBars * STEPS_PER_BAR) : 0;
      const dyn = crescendoMult(pos, style.climaxAt) * ROLE_DYN[sec.role];
      out.push(mk(n.note, n.step, n.length, n.velocity * dyn));
    }
    // ritardando into each section end; strongest at the final cadence.
    const isFinal = si === sections.length - 1;
    ritPoints.push({ end: secEnd, depth: rubatoDepth * (isFinal ? 2.2 : 1) });
    void secStart;
    cursorBar += sec.bars;
  });

  // Global slider bias on the finished song (light, additive where possible).
  const o: TransformOpts = { key: opts.key, mode: opts.mode };
  let notes = out;
  if (opts.amounts.ragtime > 0) notes = ragtimeStride(notes, opts.amounts.ragtime * 0.4, o, 11);
  if (opts.amounts.harmony > 0) notes = harmonize(notes, opts.amounts.harmony * 0.5, o, 12);
  if (opts.amounts.runs > 0) notes = runsAndFlourishes(notes, opts.amounts.runs * 0.5, o, 13);
  if (opts.amounts.rhythm > 0) notes = polyrhythm(notes, opts.amounts.rhythm * 0.6, o, 14);
  notes = humanize(notes, humAmt, 7, opts.groove);

  // Phrase-shaped rubato: a monotonic time-warp that eases each note later as it
  // approaches a section end (ritardando), pushing subsequent material too.
  const ritSpan = STEPS_PER_BAR; // ease over the last bar of each section
  notes = notes.map((n) => {
    let shift = 0;
    for (const rp of ritPoints) {
      if (n.step >= rp.end) shift += rp.depth;
      else if (n.step >= rp.end - ritSpan) {
        const e = (n.step - (rp.end - ritSpan)) / ritSpan;
        shift += rp.depth * (e * e); // ease-in for a natural slow-down
      }
    }
    return mk(n.note, n.step + shift, n.length, n.velocity);
  });

  return notes.sort(byStepThenNote);
}
