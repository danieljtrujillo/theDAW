/**
 * rollKey — the piano roll's key: the tonic and mode the composer routes read
 * (voice-leading check, continuo, plans) and the scale the diatonic motif
 * transforms move in (lib/rollTransforms).
 *
 * A roll holds a key once someone picks one or a plan, a continuo or a form
 * writes one (pianoRollStore `rollKey`); until then its key is read from its
 * notes with the Krumhansl-Kessler key profiles: each of the 24 keys is scored
 * by the correlation of its profile with the notes' pitch classes, each note
 * weighted by its length.
 *
 * Pure, so node tests load it.
 */
import { scaleOf, type Scale } from './motif';

export type RollKeyMode = 'major' | 'minor';

export interface RollKey {
  /** The tonic as the composer routes read it: 'C', 'F#', 'Bb'. */
  tonic: string;
  mode: RollKeyMode;
}

/** The tonic names the key picker offers, one per pitch class, spelled as keys usually are. */
export const ROLL_KEY_TONICS: readonly string[] = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);

/** Minor keys read better with some sharps: C# minor, not Db minor. */
const MINOR_TONICS: readonly string[] = Object.freeze(['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']);

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The pitch class of a tonic name ('C', 'F#', 'Bb', 'c#', 'E♭'), or null for anything else. */
export function tonicPitchClass(name: string): number | null {
  const raw = name.trim();
  const letter = raw.charAt(0).toUpperCase();
  if (!(letter in LETTER_PC)) return null;
  let pc = LETTER_PC[letter];
  for (const ch of raw.slice(1)) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'b' || ch === '♭' || ch === '-') pc -= 1;
    else return null;
  }
  return ((pc % 12) + 12) % 12;
}

/** The picker's spelling of pitch class `pc` in `mode`. */
export const tonicName = (pc: number, mode: RollKeyMode): string =>
  (mode === 'minor' ? MINOR_TONICS : ROLL_KEY_TONICS)[((Math.round(pc) % 12) + 12) % 12];

/** A key from a file, a clip or an edit, or null for anything that is not one. */
export function cleanRollKey(raw: unknown): RollKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tonic !== 'string' || (r.mode !== 'major' && r.mode !== 'minor')) return null;
  const pc = tonicPitchClass(r.tonic);
  if (pc === null) return null;
  const letter = r.tonic.trim().charAt(0).toUpperCase();
  const accidentals = r.tonic.trim().slice(1).replace(/♯/g, '#').replace(/[♭-]/g, 'b');
  return { tonic: `${letter}${accidentals}`, mode: r.mode };
}

/**
 * A key named as the composer routes name them: 'C major', 'f# minor',
 * 'Bb', 'e' (a lowercase letter alone is minor). Null for anything else.
 */
export function parseRollKey(text: string | null | undefined): RollKey | null {
  const m = /^\s*([A-Ga-g])([#b♯♭-]*)\s*(major|minor)?\s*$/i.exec(text ?? '');
  if (!m) return null;
  const mode: RollKeyMode = m[3] ? (m[3].toLowerCase() as RollKeyMode) : m[1] === m[1].toLowerCase() ? 'minor' : 'major';
  return cleanRollKey({ tonic: `${m[1].toUpperCase()}${m[2]}`, mode });
}

/** 'C major', 'F# minor'. */
export const rollKeyName = (k: RollKey): string => `${k.tonic} ${k.mode}`;

/** The key's scale for the motif transforms: major, or natural minor. */
export const rollKeyScale = (k: RollKey): Scale => scaleOf(tonicPitchClass(k.tonic) ?? 0, k.mode === 'minor' ? 'minor' : 'major');

// Krumhansl and Kessler's probe-tone ratings (1982), tonic first.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const correlation = (a: readonly number[], b: readonly number[]): number => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};

/** A note as the estimate reads it: its pitch and, when it has one, its length in ticks or steps. */
export interface KeyNote {
  note: number;
  ticks?: number;
  length?: number;
}

/**
 * The key the notes are most likely in (Krumhansl-Schmuckler): the major or
 * minor key whose profile correlates best with the notes' pitch classes,
 * each weighted by its length. C major for no notes. A tie goes to the major
 * key, then to the lower tonic.
 */
export function estimateRollKey(notes: readonly KeyNote[]): RollKey {
  const chroma = new Array(12).fill(0);
  for (const n of notes) {
    const w = typeof n.ticks === 'number' && n.ticks > 0 ? n.ticks : typeof n.length === 'number' && n.length > 0 ? n.length * 240 : 240;
    chroma[((Math.round(n.note) % 12) + 12) % 12] += w;
  }
  if (chroma.every((x) => x === 0)) return { tonic: 'C', mode: 'major' };
  let best: RollKey = { tonic: 'C', mode: 'major' };
  let bestScore = -Infinity;
  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let pc = 0; pc < 12; pc += 1) {
      const rotated = profile.map((_, i) => profile[(i - pc + 12) % 12]);
      const score = correlation(chroma, rotated);
      if (score > bestScore + 1e-12) {
        bestScore = score;
        best = { tonic: tonicName(pc, mode), mode };
      }
    }
  }
  return best;
}
