/**
 * TS mirror of the `gantasmo.chordtrack` v1 JSON written by
 * backend/modules/notation/exporters/chordtrack.py, plus the small pure
 * helpers the CHORDS play-along view needs (current-chord lookup, colour by
 * chord kind, ChordSpec conversion for the diagram generator).
 *
 * The schema carries no nulls: a no-chord span is symbol 'N.C.', kind 'none',
 * pitchClasses [] and rootPc/bassPc -1.
 */
import type { ChordSpec } from './chordShapes.ts';
import { notationArtifactUrl } from './notationClient.ts';

export const CHORD_TRACK_SCHEMA = 'gantasmo.chordtrack';
export const CHORD_TRACK_SCHEMA_VERSION = 1;

export interface ChordSpan {
  id: number;
  startSec: number;
  endSec: number;
  startBeat: number;
  endBeat: number;
  /** 1-based measure number of the span start. */
  measure: number;
  /** Display symbol, e.g. 'C', 'Am7', 'G/B', 'N.C.'. */
  symbol: string;
  /** Root spelling, e.g. 'Bb' ('' for N.C.). */
  root: string;
  /** Root pitch class 0..11; -1 for N.C. */
  rootPc: number;
  /** MusicXML/music21 chord-kind vocabulary: 'major', 'minor', 'dominant-seventh', ..., 'none'. */
  kind: string;
  /** Slash bass pitch class; -1 when the root is the bass. */
  bassPc: number;
  /** Pitch classes in the chord, root first; [] for N.C. */
  pitchClasses: number[];
  /** 0..1 (1.0 for lead-sheet harmony). */
  confidence: number;
}

export interface ChordTrack {
  schema: typeof CHORD_TRACK_SCHEMA;
  schemaVersion: typeof CHORD_TRACK_SCHEMA_VERSION;
  generator: string;
  generatedAtUtc: string;
  source: { entryId: string; method: 'harmony' | 'chroma'; sourceArtifactId: string };
  timing: { bpm: number; beats: number[]; downbeats: number[]; beatsPerBar: number; durationSec: number };
  key: { tonic: string; mode: string; confidence: number };
  chords: ChordSpan[];
  stats: { chordCount: number; distinctSymbols: number; meanConfidence: number };
}

/**
 * Index of the last span whose startSec <= sec (binary search), -1 before the
 * first span. Spans are contiguous in a valid track, so this is the sounding
 * chord; callers wanting strict containment also check `endSec`.
 */
export function chordIndexAt(track: Pick<ChordTrack, 'chords'>, sec: number): number {
  const chords = track.chords;
  if (chords.length === 0 || !(sec >= chords[0].startSec)) return -1;
  let lo = 0;
  let hi = chords.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chords[mid].startSec <= sec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The span sounding at `sec`, or null before the first / after the last span ends. */
export function chordAt(track: Pick<ChordTrack, 'chords'>, sec: number): ChordSpan | null {
  const i = chordIndexAt(track, sec);
  if (i < 0) return null;
  const span = track.chords[i];
  return sec < span.endSec || i === track.chords.length - 1 ? span : null;
}

/** Structural check on a parsed JSON payload. */
export function isChordTrack(value: unknown): value is ChordTrack {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === CHORD_TRACK_SCHEMA &&
    typeof v.schemaVersion === 'number' &&
    Array.isArray(v.chords) &&
    !!v.timing &&
    typeof v.timing === 'object'
  );
}

/** Fetch and validate a chordtrack artifact through the notation file route. */
export async function loadChordTrack(artifactId: string): Promise<ChordTrack> {
  const res = await fetch(notationArtifactUrl(artifactId));
  if (!res.ok) throw new Error(`chord track HTTP ${res.status}`);
  const payload: unknown = await res.json();
  if (!isChordTrack(payload)) throw new Error('not a gantasmo.chordtrack document');
  if (payload.schemaVersion !== CHORD_TRACK_SCHEMA_VERSION) {
    throw new Error(`unsupported chordtrack schemaVersion ${String(payload.schemaVersion)}`);
  }
  return payload;
}

/** Tailwind-400 palette values (canvas needs literal colours, not class names). */
const COLOR_MAJOR = '#34d399'; // emerald-400
const COLOR_MINOR = '#38bdf8'; // sky-400
const COLOR_SEVENTH = '#fbbf24'; // amber-400
const COLOR_ALTERED = '#fb7185'; // rose-400
const COLOR_OPEN = '#d4d4d8'; // zinc-300
const COLOR_DEFAULT = '#a1a1aa'; // zinc-400

/**
 * Colour for a chord kind (MusicXML vocabulary): plain major -> emerald, plain
 * minor -> sky, any dominant/seventh/extended -> amber, diminished/augmented
 * (including dim7 / half-diminished) -> rose, power/suspended -> zinc-300,
 * everything else (N.C., unknown) -> zinc-400.
 */
export function kindColor(kind: string): string {
  const k = (kind || '').toLowerCase().trim();
  if (k === 'major') return COLOR_MAJOR;
  if (k === 'minor') return COLOR_MINOR;
  if (k.includes('diminished') || k.includes('augmented')) return COLOR_ALTERED;
  if (
    k.includes('dominant') ||
    k.includes('seventh') ||
    k.includes('sixth') ||
    k.includes('ninth') ||
    k.includes('eleventh') ||
    k.includes('thirteenth')
  ) {
    return COLOR_SEVENTH;
  }
  if (k === 'power' || k.startsWith('suspended')) return COLOR_OPEN;
  return COLOR_DEFAULT;
}

/** ChordSpec for the diagram generator; an N.C. span yields empty pitch classes. */
export function toChordSpec(span: Pick<ChordSpan, 'rootPc' | 'pitchClasses' | 'bassPc'>): ChordSpec {
  const rootPc = span.rootPc >= 0 ? ((span.rootPc % 12) + 12) % 12 : 0;
  const pitchClasses = span.rootPc >= 0 ? span.pitchClasses.map((pc) => ((pc % 12) + 12) % 12) : [];
  const bassPc = span.bassPc >= 0 && span.rootPc >= 0 ? ((span.bassPc % 12) + 12) % 12 : -1;
  return { rootPc, pitchClasses, bassPc };
}
