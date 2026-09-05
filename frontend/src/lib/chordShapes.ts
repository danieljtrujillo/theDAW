/**
 * Chord-shape generation for fretted instruments (pure; no React, no DOM).
 *
 * A chord arrives as pitch classes (the backend chordtrack emits both the
 * MusicXML `kind` and `pitchClasses`, so no interval table lives here) and a
 * tuning arrives as open-string MIDI numbers, low string first. `findShapes`
 * enumerates every playable combination inside a sliding fret window, rejects
 * the unmusical ones (missing root/third, wrong bass, too many fingers, ...)
 * and ranks the rest with a hand-comfort cost. `bestShapes` puts the
 * hand-written open shapes from `curatedShapes.ts` in front of the generated
 * ones and handles the capo by transposing the chord down before generating,
 * so the diagram shows what the hand frets behind the capo.
 *
 * Fret values are absolute (0 = open, -1 = muted); `baseFret` only tells a
 * diagram whether to draw the nut (1) or a "fr N" marker.
 */
import { lookup as lookupCurated } from './curatedShapes.ts';

export interface ChordSpec {
  /** Root pitch class 0..11 (C = 0). */
  rootPc: number;
  /** Every pitch class the chord contains, root included; any order. */
  pitchClasses: number[];
  /** Pitch class that must sound lowest (slash chords); -1 = none (the root). */
  bassPc: number;
}

export interface ChordShape {
  /** Per string, low -> high: -1 mute, 0 open, else absolute fret. */
  frets: number[];
  /** Per string: 0 = no finger (open/mute), 1..4 = index..pinky. */
  fingers: number[];
  /** 1 when the shape sits in open position (draw the nut), else the lowest fretted fret. */
  baseFret: number;
  /** A barre finger: which fret and the inclusive string range it covers. */
  barre?: { fret: number; from: number; to: number };
  /** Cost; lower is better. Curated shapes carry 0. */
  score: number;
  curated: boolean;
}

export interface FindShapesOptions {
  /** Highest fret the generator considers (default 12). */
  maxFret?: number;
  /** Width of the sliding window in frets (default 4: max stretch of 3 frets). */
  span?: number;
  /** Fretting fingers available (default 4; a barre counts as one). */
  maxFingers?: number;
  /** How many shapes to return, best first (default 3). */
  top?: number;
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const DEFAULT_MAX_FRET = 12;
const DEFAULT_SPAN = 4;
const DEFAULT_MAX_FINGERS = 4;
const DEFAULT_TOP = 3;
/** Per-string candidate cap (mute, open, and the first fretted hits). */
const MAX_CANDIDATES_PER_STRING = 4;
/** Shapes whose highest fretted fret is at or below this are "open position". */
const OPEN_POSITION_MAX_FRET = 4;

export function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

export function pcName(pc: number, preferFlats: boolean): string {
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return names[mod12(Math.round(pc))] ?? 'C';
}

/** Build a ChordSpec from a root and intervals above it (semitones). */
export function makeChordSpec(rootPc: number, intervals: number[], bassPc = -1): ChordSpec {
  const root = mod12(rootPc);
  const pcs = new Set<number>([root]);
  for (const iv of intervals) pcs.add(mod12(root + iv));
  return { rootPc: root, pitchClasses: [...pcs], bassPc: bassPc >= 0 ? mod12(bassPc) : -1 };
}

/** Normalised, de-duplicated pitch classes with the root first. */
export function normalizePitchClasses(chord: ChordSpec): number[] {
  const root = mod12(chord.rootPc);
  const out = [root];
  for (const pc of chord.pitchClasses) {
    const m = mod12(pc);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** Transpose a chord by `semitones` (negative = down). */
export function transposeChord(chord: ChordSpec, semitones: number): ChordSpec {
  return {
    rootPc: mod12(chord.rootPc + semitones),
    pitchClasses: normalizePitchClasses(chord).map((pc) => mod12(pc + semitones)),
    bassPc: chord.bassPc >= 0 ? mod12(chord.bassPc + semitones) : -1,
  };
}

/** Compact fret string for labels: x32010, or x-8-10-10-9-8 when a fret has two digits. */
export function fretString(frets: number[]): string {
  const parts = frets.map((f) => (f < 0 ? 'x' : String(f)));
  const wide = frets.some((f) => f >= 10);
  return parts.join(wide ? '-' : '');
}

/** Human/aria label such as "C major, x32010" or "F major, 133211 (barre fret 1)". */
export function chordLabel(symbol: string, shape: ChordShape): string {
  const bits = [`${symbol}, ${fretString(shape.frets)}`];
  if (shape.barre) bits.push(`(barre fret ${shape.barre.fret})`);
  else if (shape.baseFret > 1) bits.push(`(fret ${shape.baseFret})`);
  return bits.join(' ');
}

/** True when the tuning is not strictly ascending (ukulele's high G, for example). */
export function isReentrant(tuningMidi: number[]): boolean {
  for (let i = 1; i < tuningMidi.length; i += 1) {
    if (tuningMidi[i] <= tuningMidi[i - 1]) return true;
  }
  return false;
}

interface Analysis {
  fretted: number[]; // string indices with fret > 0
  sounding: number;
  muted: number;
  interiorMuted: number;
  minFret: number; // among fretted, Infinity when none
  maxFret: number; // among fretted, -Infinity when none
  hasOpen: boolean;
  barre: { fret: number; from: number; to: number } | null;
  fingerCount: number;
}

function analyse(frets: number[], maxFingers: number): Analysis {
  const fretted: number[] = [];
  let sounding = 0;
  let muted = 0;
  let hasOpen = false;
  let minFret = Infinity;
  let maxFret = -Infinity;
  let first = -1;
  let last = -1;
  for (let i = 0; i < frets.length; i += 1) {
    const f = frets[i];
    if (f < 0) {
      muted += 1;
      continue;
    }
    sounding += 1;
    if (first < 0) first = i;
    last = i;
    if (f === 0) hasOpen = true;
    else {
      fretted.push(i);
      if (f < minFret) minFret = f;
      if (f > maxFret) maxFret = f;
    }
  }
  let interiorMuted = 0;
  for (let i = first + 1; i < last; i += 1) if (frets[i] < 0) interiorMuted += 1;

  // Barre: the lowest fretted fret, from its first string to its last string,
  // is playable with one finger when every string in between is fretted at or
  // above that fret (an open string inside the barre would be silenced).
  let barre: Analysis['barre'] = null;
  let atMin = 0;
  if (fretted.length > 0) {
    let from = -1;
    let to = -1;
    for (const i of fretted) {
      if (frets[i] === minFret) {
        atMin += 1;
        if (from < 0) from = i;
        to = i;
      }
    }
    let feasible = atMin >= 2;
    for (let i = from; feasible && i <= to; i += 1) if (frets[i] < minFret) feasible = false;
    if (feasible) barre = { fret: minFret, from, to };
  }
  const plain = fretted.length;
  const withBarre = barre ? 1 + (plain - atMin) : Infinity;
  const useBarre = barre !== null && (plain > maxFingers || atMin >= 3);
  return {
    fretted,
    sounding,
    muted,
    interiorMuted,
    minFret,
    maxFret,
    hasOpen,
    barre: useBarre ? barre : null,
    fingerCount: useBarre ? withBarre : plain,
  };
}

function assignFingers(frets: number[], a: Analysis): number[] {
  const fingers = new Array<number>(frets.length).fill(0);
  let next = 1;
  const rest: number[] = [];
  if (a.barre) {
    for (const i of a.fretted) {
      if (frets[i] === a.barre.fret) fingers[i] = 1;
      else rest.push(i);
    }
    next = 2;
  } else {
    rest.push(...a.fretted);
  }
  rest.sort((x, y) => frets[x] - frets[y] || x - y);
  for (const i of rest) {
    fingers[i] = Math.min(next, 4);
    next += 1;
  }
  return fingers;
}

/**
 * Tones a voicing must contain. The root and the third (or the sus tone when
 * there is no third) always; the fifth (perfect, or the b5/#5 that stands in
 * for it in diminished/augmented chords) may be dropped on 4-string
 * instruments and in four-note chords; five-note chords keep root, third and
 * seventh only.
 */
function requiredTones(pcs: number[], stringCount: number): number[] {
  const root = pcs[0];
  const has = (iv: number) => pcs.includes(mod12(root + iv));
  const fifth = has(7) ? mod12(root + 7) : has(6) ? mod12(root + 6) : has(8) ? mod12(root + 8) : -1;
  if (pcs.length >= 5) {
    const req = [root];
    for (const iv of [3, 4]) if (has(iv)) req.push(mod12(root + iv));
    if (req.length === 1) for (const iv of [2, 5]) if (has(iv)) req.push(mod12(root + iv));
    for (const iv of [10, 11]) if (has(iv)) req.push(mod12(root + iv));
    return req;
  }
  if (pcs.length >= 4 || stringCount <= 4) return pcs.filter((pc) => pc !== fifth || pcs.length < 3);
  return pcs.slice();
}

function costOf(frets: number[], a: Analysis, baseFret: number): number {
  const outerMuted = a.muted - a.interiorMuted;
  const stretch = a.fretted.length > 0 ? a.maxFret - a.minFret : 0;
  return (
    10 * a.interiorMuted +
    4 * outerMuted +
    3 * a.fingerCount +
    2 * (baseFret - 1) +
    1.5 * stretch -
    1 * a.sounding +
    (baseFret === 1 && !a.hasOpen && frets.length > 0 ? 4 : 0)
  );
}

const memo = new Map<string, ChordShape[]>();

/**
 * Enumerate playable voicings of `chord` on `tuningMidi` (open-string MIDI
 * numbers, low string first), best first. Returns [] when the chord has no
 * pitch classes (N.C.) or nothing playable exists.
 */
export function findShapes(chord: ChordSpec, tuningMidi: number[], opts: FindShapesOptions = {}): ChordShape[] {
  const maxFret = Math.max(1, Math.floor(opts.maxFret ?? DEFAULT_MAX_FRET));
  const span = Math.max(1, Math.floor(opts.span ?? DEFAULT_SPAN));
  const maxFingers = Math.max(1, Math.floor(opts.maxFingers ?? DEFAULT_MAX_FINGERS));
  const top = Math.max(1, Math.floor(opts.top ?? DEFAULT_TOP));
  const pcs = normalizePitchClasses(chord);
  const n = tuningMidi.length;
  if (pcs.length === 0 || n === 0 || chord.pitchClasses.length === 0) return [];

  const key = `${tuningMidi.join(',')}|${pcs.join(',')}|${chord.bassPc}|${maxFret},${span},${maxFingers},${top}`;
  const hit = memo.get(key);
  if (hit) return hit.slice();

  const pcSet = new Set(pcs);
  const required = requiredTones(pcs, n);
  const reentrant = isReentrant(tuningMidi);
  const wantBass = chord.bassPc >= 0 ? mod12(chord.bassPc) : pcs[0];
  const minSounding = n >= 5 ? 3 : 2;
  const found = new Map<string, ChordShape>();

  const evaluate = (frets: number[]): void => {
    const fretsKey = frets.join(',');
    if (found.has(fretsKey)) return;
    const a = analyse(frets, maxFingers);
    if (a.sounding < minSounding) return;
    if (a.interiorMuted > 1) return;
    if (a.fingerCount > maxFingers) return;

    let lowestPitch = Infinity;
    let lowestPc = -1;
    const present = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      const f = frets[i];
      if (f < 0) continue;
      const midi = tuningMidi[i] + f;
      present.add(mod12(midi));
      if (midi < lowestPitch) {
        lowestPitch = midi;
        lowestPc = mod12(midi);
      }
    }
    for (const pc of required) if (!present.has(pc)) return;
    if (!reentrant && lowestPc !== wantBass) return;
    if (reentrant && chord.bassPc >= 0 && !present.has(wantBass)) return;

    const baseFret = a.fretted.length === 0 || a.maxFret <= OPEN_POSITION_MAX_FRET ? 1 : a.minFret;
    const shape: ChordShape = {
      frets: frets.slice(),
      fingers: assignFingers(frets, a),
      baseFret,
      score: costOf(frets, a, baseFret),
      curated: false,
    };
    if (a.barre) shape.barre = { ...a.barre };
    found.set(fretsKey, shape);
  };

  const current = new Array<number>(n).fill(-1);
  // Windows slide one fret at a time; the last one ends on maxFret (inclusive).
  for (let w = 0; w <= Math.max(0, maxFret - span + 1); w += 1) {
    const lo = Math.max(1, w);
    const hi = Math.min(maxFret, w + span - 1);
    const candidates: number[][] = tuningMidi.map((open) => {
      const c: number[] = [-1];
      if (pcSet.has(mod12(open))) c.push(0);
      for (let f = lo; f <= hi && c.length < MAX_CANDIDATES_PER_STRING; f += 1) {
        if (pcSet.has(mod12(open + f))) c.push(f);
      }
      return c;
    });
    const walk = (s: number, mutes: number): void => {
      if (s === n) {
        evaluate(current);
        return;
      }
      for (const f of candidates[s]) {
        const m = mutes + (f < 0 ? 1 : 0);
        if (n - m < minSounding) continue;
        current[s] = f;
        walk(s + 1, m);
      }
    };
    walk(0, 0);
  }

  const shapes = [...found.values()].sort(
    (x, y) => x.score - y.score || x.baseFret - y.baseFret || fretString(x.frets).localeCompare(fretString(y.frets)),
  );
  const out = shapes.slice(0, top);
  memo.set(key, out);
  return out.slice();
}

/**
 * Re-express a shape given in absolute frets relative to a capo at `capo`
 * (the capo becomes the nut: fret capo -> 0). Returns null when the shape
 * needs a fret below the capo, which cannot be played.
 */
export function applyCapo(shape: ChordShape, capo: number): ChordShape | null {
  const c = Math.max(0, Math.floor(capo));
  if (c === 0) return shape;
  const frets: number[] = [];
  for (const f of shape.frets) {
    if (f < 0 || f === 0) {
      // An open string now rings at the capo; a mute stays a mute.
      frets.push(f);
      continue;
    }
    if (f < c) return null;
    frets.push(f - c);
  }
  const fingers = shape.fingers.map((fg, i) => (frets[i] > 0 ? fg : 0));
  const frettedVals = frets.filter((f) => f > 0);
  const baseFret =
    frettedVals.length === 0 || Math.max(...frettedVals) <= OPEN_POSITION_MAX_FRET ? 1 : Math.min(...frettedVals);
  const out: ChordShape = { ...shape, frets, fingers, baseFret };
  if (shape.barre) {
    if (shape.barre.fret - c > 0) out.barre = { ...shape.barre, fret: shape.barre.fret - c };
    else delete out.barre;
  }
  return out;
}

/**
 * Curated shapes for the tuning first, then generated ones, de-duplicated by
 * frets. With a capo the chord is transposed down by `capo` semitones before
 * lookup, so the returned frets are what the hand plays behind the capo.
 */
export function bestShapes(tuningId: string, tuningMidi: number[], chord: ChordSpec, capo = 0): ChordShape[] {
  const c = Math.max(0, Math.floor(capo));
  const target = c > 0 ? transposeChord(chord, -c) : chord;
  const out: ChordShape[] = [];
  const seen = new Set<string>();
  for (const s of lookupCurated(tuningId, target)) {
    const k = s.frets.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  for (const s of findShapes(target, tuningMidi)) {
    const k = s.frets.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

