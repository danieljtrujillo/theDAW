/**
 * Camelot wheel — harmonic-mixing key helper for the DJ tab.
 *
 * The backend analysis (`/api/analysis/{id}`, librosa) reports a musical key as
 * a note name ('C', 'C#', … 'B') plus a scale ('major' | 'minor'). DJs think in
 * the **Camelot wheel** instead: each key maps to a code like `8B` (C major) or
 * `8A` (A minor). Adjacent codes mix harmonically, so flagging compatible keys
 * lets a DJ pick a smooth next track at a glance.
 *
 * Mapping reference (standard Camelot / Open Key):
 *   B = major ring, A = minor ring. Same number across rings is the relative
 *   major/minor; ±1 on the same ring is a perfect-fifth neighbour.
 *
 * Pure, dependency-free — no backend round-trip, no package.
 */

/** Backend note names, sharp spelling (matches analysis/key.py `_NOTE_NAMES`). */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Common flat aliases so user-typed / tagged keys still resolve. */
const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
};

// Camelot number by note index, per ring. Index 0 = C.
//   Major: C=8B, then going up by fifths +1 around the wheel.
//   Minor: A=8A (relative minor of C major), same fifth logic.
const MAJOR_NUM: Record<string, number> = {
  C: 8, 'C#': 3, D: 10, 'D#': 5, E: 12, F: 7, 'F#': 2, G: 9, 'G#': 4, A: 11, 'A#': 6, B: 1,
};
const MINOR_NUM: Record<string, number> = {
  A: 8, 'A#': 3, B: 10, C: 5, 'C#': 12, D: 7, 'D#': 2, E: 9, F: 4, 'F#': 11, G: 6, 'G#': 1,
};

export interface CamelotInfo {
  /** e.g. "8B". */
  code: string;
  /** 1–12. */
  number: number;
  /** 'A' (minor) | 'B' (major). */
  letter: 'A' | 'B';
  /** HSL-ish hue (0–360) for a wheel-position colour chip. */
  hue: number;
  /** The set of Camelot codes that mix harmonically with this one. */
  compatible: string[];
}

const normalizeNote = (note: string): string => {
  const n = note.trim();
  if (n.length >= 2) {
    const head = n[0].toUpperCase() + n.slice(1);
    if (FLAT_TO_SHARP[head]) return FLAT_TO_SHARP[head];
  }
  return n[0]?.toUpperCase() + (n.slice(1) || '');
};

const normalizeScale = (scale: string | null | undefined): 'major' | 'minor' => {
  const s = (scale ?? '').toLowerCase();
  // 'min', 'm', 'minor', 'aeolian' → minor; default major.
  if (s.startsWith('min') || s === 'm' || s === 'aeolian') return 'minor';
  return 'major';
};

/** Camelot code → set of harmonically-compatible codes (self, ±1 same ring,
 *  same number other ring). */
function compatibleCodes(num: number, letter: 'A' | 'B'): string[] {
  const up = (num % 12) + 1;
  const down = ((num + 10) % 12) + 1;
  const other = letter === 'A' ? 'B' : 'A';
  return [`${num}${letter}`, `${up}${letter}`, `${down}${letter}`, `${num}${other}`];
}

/**
 * Resolve a note+scale to Camelot info. Returns null when the note is unknown
 * (e.g. analysis hasn't run or reported an unrecognised key).
 */
export function toCamelot(note: string | null | undefined, scale: string | null | undefined): CamelotInfo | null {
  if (!note) return null;
  const n = normalizeNote(note);
  if (!NOTE_NAMES.includes(n as (typeof NOTE_NAMES)[number])) return null;
  const isMinor = normalizeScale(scale) === 'minor';
  const number = isMinor ? MINOR_NUM[n] : MAJOR_NUM[n];
  if (number == null) return null;
  const letter: 'A' | 'B' = isMinor ? 'A' : 'B';
  return {
    code: `${number}${letter}`,
    number,
    letter,
    hue: Math.round(((number - 1) / 12) * 360),
    compatible: compatibleCodes(number, letter),
  };
}

/** True if two keys mix harmonically (either direction). Accepts raw note+scale. */
export function keysCompatible(
  a: { note: string | null | undefined; scale: string | null | undefined },
  b: { note: string | null | undefined; scale: string | null | undefined },
): boolean {
  const ca = toCamelot(a.note, a.scale);
  const cb = toCamelot(b.note, b.scale);
  if (!ca || !cb) return false;
  return ca.compatible.includes(cb.code);
}

/** Short human key label, e.g. "C maj" / "A min". */
export function keyLabel(note: string | null | undefined, scale: string | null | undefined): string {
  if (!note) return '—';
  return `${normalizeNote(note)} ${normalizeScale(scale) === 'minor' ? 'min' : 'maj'}`;
}
