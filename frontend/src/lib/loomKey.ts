/**
 * loomKey — tiny key/Camelot helpers for LOOM (mirrors backend/modules/shards/service.py).
 */

const NOTE_PC: Record<string, number> = {
  C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11,
};

const norm = (k: string) => (k || '').toUpperCase().replace('♯', '#').replace('♭', 'B').trim();

export function pitchClass(key: string): number | null {
  const v = NOTE_PC[norm(key)];
  return v === undefined ? null : v;
}

/** 0 same code, 1 a wheel neighbour or the relative ring, … ; null when unknown. */
export function camelotDistance(a: string, b: string): number | null {
  if (!a || !b) return null;
  const na = Number(a.slice(0, -1));
  const nb = Number(b.slice(0, -1));
  const ra = a.slice(-1).toUpperCase();
  const rb = b.slice(-1).toUpperCase();
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  let d = Math.abs(na - nb) % 12;
  d = Math.min(d, 12 - d);
  return d + (ra === rb || d === 0 ? 0 : 1);
}

/** Smallest shift (−6..6) moving `from` onto `to`; relative keys share a centre. */
export function transposeSemitones(fromKey: string, fromScale: string, toKey: string, toScale: string): number {
  let a = pitchClass(fromKey);
  let b = pitchClass(toKey);
  if (a == null || b == null) return 0;
  const fromMinor = (fromScale || '').toLowerCase().startsWith('min');
  const toMinor = (toScale || '').toLowerCase().startsWith('min');
  if (fromMinor && !toMinor) a = (a + 3) % 12;
  else if (toMinor && !fromMinor) b = (b + 3) % 12;
  const d = (b - a + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/** Camelot code for a key + scale ('8A' for A minor, '8B' for C major). */
export function camelotCode(key: string, scale: string): string {
  const pc = pitchClass(key);
  if (pc == null) return '';
  const minor = (scale || '').toLowerCase().startsWith('min');
  // Wheel numbers by pitch class: minor ring (A) and major ring (B).
  const MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]; // C=5A … A=8A
  const MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // C=8B … A=11B
  return `${(minor ? MINOR : MAJOR)[pc]}${minor ? 'A' : 'B'}`;
}
