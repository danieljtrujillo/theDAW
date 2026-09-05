/**
 * Curated chord shapes for fretted instruments (pure; no React, no DOM).
 *
 * Shapes are keyed by tuning id and by the chord's interval signature
 * (`intervalKey`), so a lookup works no matter how the symbol is spelled
 * (C7 / Cdom7 / "dominant-seventh" all resolve to `0:0,4,7,10`). Every shape
 * is hand-written open-position vocabulary, plus E-shape and A-shape barre
 * templates transposed to every root so the common major/minor chords have an
 * idiomatic movable voicing before the generator in chordShapes.ts is asked.
 *
 * Frets are absolute (0 = open, -1 = muted), strings low -> high, matching the
 * TUNINGS table on the backend (guitar-standard E A D G B e, ukulele-standard
 * re-entrant G C E A). `lookup` returns fresh copies, so callers may mutate.
 */
import type { ChordShape, ChordSpec } from './chordShapes.ts';

function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

/** Interval signature of a chord: root pitch class + sorted semitone offsets from it. */
export function intervalKey(chord: ChordSpec): string {
  const root = mod12(chord.rootPc);
  const intervals = Array.from(new Set([0, ...chord.pitchClasses.map((pc) => mod12(pc - root))])).sort(
    (a, b) => a - b,
  );
  return `${root}:${intervals.join(',')}`;
}

/** Interval sets in the MusicXML/music21 chord-kind vocabulary the chordtrack emits. */
export const CURATED_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  'dominant-seventh': [0, 4, 7, 10],
  'minor-seventh': [0, 3, 7, 10],
  'major-seventh': [0, 4, 7, 11],
  'suspended-second': [0, 2, 7],
  'suspended-fourth': [0, 5, 7],
  'add-ninth': [0, 2, 4, 7],
} as const;

type Kind = keyof typeof CURATED_INTERVALS;

const PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  Ab: 8,
  A: 9,
  Bb: 10,
  B: 11,
};

function keyFor(rootPc: number, kind: Kind): string {
  return `${mod12(rootPc)}:${CURATED_INTERVALS[kind].join(',')}`;
}

/** Highest fret a transposed barre template may use. */
const MAX_TEMPLATE_FRET = 12;

type Table = Map<string, ChordShape[]>;

function shape(frets: number[], fingers: number[], barre?: ChordShape['barre']): ChordShape {
  const fretted = frets.filter((f) => f > 0);
  const baseFret = fretted.length === 0 || Math.max(...fretted) <= 4 ? 1 : Math.min(...fretted);
  const out: ChordShape = { frets, fingers, baseFret, score: 0, curated: true };
  if (barre) out.barre = barre;
  return out;
}

function add(table: Table, rootPc: number, kind: Kind, s: ChordShape): void {
  const key = keyFor(rootPc, kind);
  const list = table.get(key) ?? [];
  if (list.some((x) => x.frets.join(',') === s.frets.join(','))) return;
  list.push(s);
  table.set(key, list);
}

/** Parse "x32010" (or "x-8-10-10-9-8") into frets. */
function frets(text: string): number[] {
  const parts = text.includes('-') ? text.split('-') : text.split('');
  return parts.map((p) => (p === 'x' ? -1 : Number(p)));
}

function fingers(text: string): number[] {
  return text.split('').map((c) => Number(c));
}

// ---------------------------------------------------------------------------
// guitar-standard: E2 A2 D3 G3 B3 E4 = [40, 45, 50, 55, 59, 64]
// ---------------------------------------------------------------------------
function buildGuitarStandard(): Table {
  const t: Table = new Map();
  const open = (name: string, kind: Kind, fr: string, fi: string, barre?: ChordShape['barre']) =>
    add(t, PC[name], kind, shape(frets(fr), fingers(fi), barre));

  open('C', 'major', 'x32010', '032010');
  open('C', 'dominant-seventh', 'x32310', '032410');
  open('C', 'major-seventh', 'x32000', '032000');
  open('C', 'add-ninth', 'x32030', '021030');
  open('D', 'major', 'xx0232', '000132');
  open('D', 'dominant-seventh', 'xx0212', '000213');
  open('D', 'minor', 'xx0231', '000231');
  open('D', 'minor-seventh', 'xx0211', '000211', { fret: 1, from: 4, to: 5 });
  open('D', 'suspended-fourth', 'xx0233', '000134');
  open('E', 'major', '022100', '023100');
  open('E', 'dominant-seventh', '020100', '020100');
  open('E', 'minor', '022000', '023000');
  open('E', 'minor-seventh', '020000', '020000');
  open('F', 'major', '133211', '134211', { fret: 1, from: 0, to: 5 });
  open('F', 'major-seventh', 'xx3210', '003210');
  open('G', 'major', '320003', '210003');
  open('G', 'dominant-seventh', '320001', '320001');
  open('A', 'major', 'x02220', '001230');
  open('A', 'dominant-seventh', 'x02020', '002030');
  open('A', 'minor', 'x02210', '002310');
  open('A', 'minor-seventh', 'x02010', '002010');
  open('A', 'suspended-second', 'x02200', '001200');
  open('B', 'dominant-seventh', 'x21202', '021304');
  open('B', 'minor', 'x24432', '013421', { fret: 2, from: 1, to: 5 });

  // Movable barre templates for every root. E-shape roots on the low E string
  // (fret r = root - E), A-shape roots on the A string (fret r = root - A).
  // Open E / A / Em / Am are already covered by the hand-written shapes above,
  // so r = 0 is skipped, and a template whose top fret would pass fret 12 is
  // dropped (the other shape still covers that root); a root's shapes are
  // ordered by baseFret ascending.
  const barres: { rootPc: number; kind: Kind; s: ChordShape }[] = [];
  for (let rootPc = 0; rootPc < 12; rootPc += 1) {
    const rE = mod12(rootPc - 4);
    if (rE > 0 && rE + 2 <= MAX_TEMPLATE_FRET) {
      barres.push({
        rootPc,
        kind: 'major',
        s: shape([rE, rE + 2, rE + 2, rE + 1, rE, rE], [1, 3, 4, 2, 1, 1], { fret: rE, from: 0, to: 5 }),
      });
      barres.push({
        rootPc,
        kind: 'minor',
        s: shape([rE, rE + 2, rE + 2, rE, rE, rE], [1, 3, 4, 1, 1, 1], { fret: rE, from: 0, to: 5 }),
      });
    }
    const rA = mod12(rootPc - 9);
    if (rA > 0 && rA + 2 <= MAX_TEMPLATE_FRET) {
      barres.push({
        rootPc,
        kind: 'major',
        s: shape([-1, rA, rA + 2, rA + 2, rA + 2, rA], [0, 1, 2, 3, 4, 1], { fret: rA, from: 1, to: 5 }),
      });
      barres.push({
        rootPc,
        kind: 'minor',
        s: shape([-1, rA, rA + 2, rA + 2, rA + 1, rA], [0, 1, 3, 4, 2, 1], { fret: rA, from: 1, to: 5 }),
      });
    }
  }
  const lowFret = (s: ChordShape) => Math.min(...s.frets.filter((f) => f > 0));
  barres.sort((x, y) => lowFret(x.s) - lowFret(y.s));
  for (const b of barres) add(t, b.rootPc, b.kind, b.s);
  return t;
}

// ---------------------------------------------------------------------------
// ukulele-standard (re-entrant): G4 C4 E4 A4 = [67, 60, 64, 69]
// ---------------------------------------------------------------------------
function buildUkuleleStandard(): Table {
  const t: Table = new Map();
  const open = (name: string, kind: Kind, fr: string, fi: string, barre?: ChordShape['barre']) =>
    add(t, PC[name], kind, shape(frets(fr), fingers(fi), barre));

  open('C', 'major', '0003', '0003');
  open('C', 'dominant-seventh', '0001', '0001');
  open('F', 'major', '2010', '2010');
  open('G', 'major', '0232', '0132');
  open('G', 'dominant-seventh', '0212', '0213');
  open('A', 'minor', '2000', '2000');
  open('A', 'major', '2100', '2100');
  open('D', 'major', '2220', '1230');
  open('D', 'minor', '2210', '2310');
  open('E', 'dominant-seventh', '1202', '1203');
  open('E', 'minor', '0432', '0432');
  open('Bb', 'major', '3211', '3211', { fret: 1, from: 2, to: 3 });
  return t;
}

const TABLES: Record<string, Table> = {
  'guitar-standard': buildGuitarStandard(),
  'ukulele-standard': buildUkuleleStandard(),
  // bass-standard, guitar-drop-d, ...: nothing curated; the generator handles them.
};

function copy(s: ChordShape): ChordShape {
  const out: ChordShape = {
    frets: s.frets.slice(),
    fingers: s.fingers.slice(),
    baseFret: s.baseFret,
    score: s.score,
    curated: true,
  };
  if (s.barre) out.barre = { ...s.barre };
  return out;
}

/**
 * Curated shapes for a tuning + chord, best first (curated: true, score 0).
 * Slash chords (bassPc set to a non-root tone) never match a curated shape,
 * because the table only holds root-position voicings.
 */
export function lookup(tuningId: string, chord: ChordSpec): ChordShape[] {
  const table = TABLES[tuningId];
  if (!table) return [];
  if (chord.bassPc >= 0 && mod12(chord.bassPc) !== mod12(chord.rootPc)) return [];
  const list = table.get(intervalKey(chord));
  return list ? list.map(copy) : [];
}

/** Every curated entry of a tuning (for tests and diagnostics). */
export function curatedEntries(tuningId: string): { key: string; rootPc: number; intervals: number[]; shapes: ChordShape[] }[] {
  const table = TABLES[tuningId];
  if (!table) return [];
  return [...table.entries()].map(([key, shapes]) => {
    const [rootText, ivText] = key.split(':');
    return {
      key,
      rootPc: Number(rootText),
      intervals: ivText.split(',').map((x) => Number(x)),
      shapes: shapes.map(copy),
    };
  });
}

/** Tuning ids that have curated shapes. */
export function curatedTunings(): string[] {
  return Object.keys(TABLES);
}
