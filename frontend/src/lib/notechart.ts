/**
 * TypeScript mirror of the `gantasmo.notechart` v1 document written by
 * `backend/modules/notation/exporters/notechart.py`.
 *
 * Field names and "absent" values follow the Python `_blank_event()` /
 * `_part_block()` builders exactly, because the same JSON is what Unity's
 * JsonUtility reads: nothing is ever null, absent strings are `''`, absent
 * numbers `0`, and "no value" integers `-1`.
 *
 * Two additive groups of fields ride on every event (Unity ignores them):
 *   - `bs*`      Beat Saber lane/layer/colour/cut/difficulty, assigned once in
 *                Python (`exporters/beatsaber_map.py`); the web highway's
 *                'blocks' skin only filters on `bsMinDifficulty`.
 *   - `drumVoice` the percussion voice of an unpitched event ('' for pitched).
 * Both are optional here because charts exported before they existed lack
 * them; `ensureNoteChart` re-exports such charts.
 */

import { exportArtifact, notationArtifactUrl, type NotationArtifact } from './notationClient';

export const NOTECHART_SCHEMA = 'gantasmo.notechart';
export const NOTECHART_SCHEMA_VERSION = 1;
export const FALLBACK_BPM = 120;
/** Staff step every rest sits on (`REST_STAFF_STEP` in the exporter). */
export const REST_STAFF_STEP = 4;
/** SMuFL noteheadBlack (U+E0A4): the glyph a highway falls back to. */
export const NOTEHEAD_BLACK_CODEPOINT = 0xe0a4;
/** SMuFL noteheadXBlack (U+E0A9) and noteheadCircleX (U+E0B3), the two
 *  percussion heads the exporter emits for hats/cymbals. */
export const NOTEHEAD_X_CODEPOINT = 0xe0a9;
export const NOTEHEAD_CIRCLE_X_CODEPOINT = 0xe0b3;

export const DRUM_VOICES = ['kick', 'snare', 'hihat', 'tom', 'crash', 'ride', 'perc'] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];

export interface ChartEvent {
  id: number;
  isRest: boolean;
  onsetSec: number;
  onsetSecRaw: number;
  onsetBeats: number;
  onsetBeatsRaw: number;
  onsetTicks: number;
  durationSec: number;
  durationSecRaw: number;
  durationBeats: number;
  durationTicks: number;
  measure: number;
  beatInMeasure: number;
  voice: number;
  staff: number;
  midi: number;
  velocity: number;
  step: string;
  octave: number;
  alter: number;
  accidental: string;
  accidentalIsCautionary: boolean;
  diatonicNoteNum: number;
  staffStep: number;
  ledgerLines: number;
  ledgerBelow: boolean;
  noteType: string;
  dots: number;
  isTuplet: boolean;
  tupletActual: number;
  tupletNormal: number;
  tupletBracket: string;
  isGrace: boolean;
  tie: string;
  beam: string;
  beamDepth: number;
  stemDirection: string;
  chordId: number;
  isChordRoot: boolean;
  glyph: string;
  glyphCodepoint: number;
  noteheadGlyph: string;
  noteheadCodepoint: number;
  flagGlyph: string;
  flagCodepoint: number;
  accidentalGlyph: string;
  accidentalCodepoint: number;
  dotGlyph: string;
  dotCodepoint: number;
  /** Beat Saber lane 0..3 (additive; default 0). */
  bsLine?: number;
  /** Beat Saber layer 0..2 (additive; default 0). */
  bsLayer?: number;
  /** Beat Saber colour 0 red / 1 blue (additive; default 0). */
  bsColor?: number;
  /** Beat Saber cut direction 0..8, 8 = any (additive; default 8). */
  bsCut?: number;
  /** Lowest difficulty (0 Easy .. 4 ExpertPlus) that includes this note;
   *  -1 = never (rests, graces, tie continuations, percussion). */
  bsMinDifficulty?: number;
  /** Percussion voice for unpitched events; '' for pitched ones (additive). */
  drumVoice?: string;
}

export interface ChartClef {
  measure: number;
  staff: number;
  timeSec: number;
  timeBeats: number;
  sign: string;
  line: number;
  octaveChange: number;
  lowestLineDiatonic: number;
  glyph: string;
  glyphCodepoint: number;
}

export interface ChartPart {
  index: number;
  id: string;
  name: string;
  abbreviation: string;
  instrumentName: string;
  /** -1 when the score declares no program (0 is a real program). */
  midiProgram: number;
  midiChannel: number;
  staffCount: number;
  isPercussion: boolean;
  transposeSemitones: number;
  clefs: ChartClef[];
  events: ChartEvent[];
}

export interface TempoEntry {
  timeSec: number;
  timeBeats: number;
  timeTicks: number;
  /** Always quarter notes per minute, whatever the meter. */
  bpm: number;
  secPerBeat: number;
  measure: number;
  interpolateToNext: boolean;
}

export interface ChartMeasure {
  number: number;
  timeSec: number;
  timeBeats: number;
  durationBeats: number;
  isPickup: boolean;
  barlineGlyph: string;
  barlineCodepoint: number;
  startsRepeat: boolean;
  endsRepeat: boolean;
}

export interface ChartTimeSignature {
  measure: number;
  timeSec: number;
  timeBeats: number;
  numerator: number;
  denominator: number;
  symbol: string;
  beatsPerBar: number;
  glyphNumerator: string;
  glyphNumeratorCodepoint: number;
  glyphDenominator: string;
  glyphDenominatorCodepoint: number;
}

export interface ChartKeySignature {
  measure: number;
  timeSec: number;
  timeBeats: number;
  fifths: number;
  mode: string;
  tonic: string;
  accidentalGlyph: string;
  accidentalCodepoint: number;
  accidentalCount: number;
}

export interface ChartSource {
  entryId: string;
  sourceArtifactId: string;
  sourcePath: string;
  sourceFormat: string;
  rawMidiArtifactId: string;
  title: string;
  artist: string;
  composer: string;
}

export interface ChartAudio {
  url: string;
  filename: string;
  mimeType: string;
  sampleRate: number;
  durationSec: number;
}

export interface ChartTiming {
  beatUnit: string;
  ticksPerQuarter: number;
  durationSec: number;
  durationBeats: number;
  totalMeasures: number;
  pickupBeats: number;
  audioOffsetSec: number;
}

export interface ChartQuantization {
  gridDivisionsPerQuarter: number;
  gridLabel: string;
  gridSeconds: number;
  tripletsAllowed: boolean;
  engine: string;
  /** True when no raw MIDI was paired: `onsetSecRaw` equals `onsetSec`. */
  rawIsQuantized: boolean;
  rawSource: string;
  matchedRawEvents: number;
  unmatchedRawEvents: number;
  maxRawDeviationSec: number;
  meanAbsRawDeviationSec: number;
}

export interface ChartStats {
  partCount: number;
  noteCount: number;
  restCount: number;
  chordCount: number;
  tupletCount: number;
  graceCount: number;
  tiedCount: number;
  measureCount: number;
  clampedDurations: number;
  densityNotesPerSec: number;
  maxSimultaneous: number;
  meanAbsRawDeviationSec: number;
  /** Additive: number of Beat Saber candidate notes across all parts. */
  beatSaberCandidates?: number;
}

export interface NoteChart {
  schema: string;
  schemaVersion: number;
  generator: string;
  generatedAtUtc: string;
  source: ChartSource;
  audio: ChartAudio;
  timing: ChartTiming;
  quantization: ChartQuantization;
  tempoMap: TempoEntry[];
  timeSignatureMap: ChartTimeSignature[];
  keySignatureMap: ChartKeySignature[];
  measures: ChartMeasure[];
  parts: ChartPart[];
  stats: ChartStats;
}

/** Every field at its "absent" value, exactly as `_blank_event()` writes it,
 *  plus the additive defaults (`BS_DEFAULTS` and `drumVoice: ''`). */
export function blankChartEvent(): ChartEvent {
  return {
    id: 0,
    isRest: false,
    onsetSec: 0,
    onsetSecRaw: 0,
    onsetBeats: 0,
    onsetBeatsRaw: 0,
    onsetTicks: 0,
    durationSec: 0,
    durationSecRaw: 0,
    durationBeats: 0,
    durationTicks: 0,
    measure: 1,
    beatInMeasure: 1,
    voice: 1,
    staff: 1,
    midi: 0,
    velocity: 0,
    step: '',
    octave: 0,
    alter: 0,
    accidental: '',
    accidentalIsCautionary: false,
    diatonicNoteNum: 0,
    staffStep: REST_STAFF_STEP,
    ledgerLines: 0,
    ledgerBelow: false,
    noteType: 'quarter',
    dots: 0,
    isTuplet: false,
    tupletActual: 0,
    tupletNormal: 0,
    tupletBracket: '',
    isGrace: false,
    tie: '',
    beam: '',
    beamDepth: 0,
    stemDirection: '',
    chordId: -1,
    isChordRoot: false,
    glyph: '',
    glyphCodepoint: 0,
    noteheadGlyph: '',
    noteheadCodepoint: 0,
    flagGlyph: '',
    flagCodepoint: 0,
    accidentalGlyph: '',
    accidentalCodepoint: 0,
    dotGlyph: '',
    dotCodepoint: 0,
    bsLine: 0,
    bsLayer: 0,
    bsColor: 0,
    bsCut: 8,
    bsMinDifficulty: -1,
    drumVoice: '',
  };
}

/** Index of the last tempo entry whose `key` is <= `value` (Python's
 *  `max(0, bisect_right(starts, value) - 1)`). */
function tempoIndexAt(tempoMap: readonly TempoEntry[], key: 'timeBeats' | 'timeSec', value: number): number {
  let lo = 0;
  let hi = tempoMap.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tempoMap[mid][key] <= value) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** Beats (quarter lengths) to absolute seconds across the piecewise-constant
 *  tempo map; the same two lines of arithmetic as `_seconds_from_beats`. */
export function secondsFromBeats(tempoMap: readonly TempoEntry[], beats: number): number {
  if (tempoMap.length === 0) return (beats * 60) / FALLBACK_BPM;
  const entry = tempoMap[tempoIndexAt(tempoMap, 'timeBeats', beats)];
  const bpm = entry.bpm || FALLBACK_BPM;
  return entry.timeSec + ((beats - entry.timeBeats) * 60) / bpm;
}

/** Absolute seconds back to beats (`_apply_raw_beats.beats_from_seconds`). */
export function beatsFromSeconds(tempoMap: readonly TempoEntry[], sec: number): number {
  if (tempoMap.length === 0) return (sec * FALLBACK_BPM) / 60;
  const entry = tempoMap[tempoIndexAt(tempoMap, 'timeSec', sec)];
  const bpm = entry.bpm || FALLBACK_BPM;
  return entry.timeBeats + ((sec - entry.timeSec) * bpm) / 60;
}

/** True for an event a player is expected to strike: a sounding note that
 *  starts a sound (not a rest, not a grace, not a tie continuation, not an
 *  irrational-tuplet member). */
export function isHitBearing(e: ChartEvent): boolean {
  return !e.isRest && !e.isGrace && (e.tie === '' || e.tie === 'start') && e.tupletBracket !== 'irrational';
}

/** True when the chart was exported after the Beat Saber fields existed
 *  (the first non-rest event carries a numeric `bsMinDifficulty`). */
export function hasBeatSaberFields(chart: NoteChart): boolean {
  for (const part of chart.parts ?? []) {
    for (const event of part.events ?? []) {
      if (event.isRest) continue;
      return typeof event.bsMinDifficulty === 'number';
    }
  }
  return false;
}

/** All events of every part, flattened, tagged with their indices. */
export function* chartEvents(chart: NoteChart): Generator<[number, number, ChartEvent]> {
  for (const part of chart.parts ?? []) {
    const events = part.events ?? [];
    for (let i = 0; i < events.length; i += 1) yield [part.index, i, events[i]];
  }
}

export async function loadNoteChart(artifactId: string): Promise<NoteChart> {
  const res = await fetch(notationArtifactUrl(artifactId));
  if (!res.ok) throw new Error(`note chart HTTP ${res.status}`);
  const chart = (await res.json()) as NoteChart;
  if (!chart || chart.schema !== NOTECHART_SCHEMA || !Array.isArray(chart.parts)) {
    throw new Error('note chart: unexpected document');
  }
  return chart;
}

export function findNoteChartArtifact(
  sourceArtifact: NotationArtifact,
  artifacts: readonly NotationArtifact[],
): NotationArtifact | null {
  return artifacts.find((a) => a.kind === 'notechart' && a.source_ref === sourceArtifact.id) ?? null;
}

/**
 * Resolve the note chart derived from `sourceArtifact`, exporting it through
 * the existing `/export` route when it is missing, unreadable, or predates the
 * Beat Saber fields (the route uses INSERT OR REPLACE on the same artifact
 * id, so a re-export refreshes in place).
 */
export async function ensureNoteChart(
  entryId: string,
  sourceArtifact: NotationArtifact,
  artifacts: readonly NotationArtifact[],
): Promise<{ artifact: NotationArtifact; chart: NoteChart; created: boolean }> {
  const existing = findNoteChartArtifact(sourceArtifact, artifacts);
  if (existing) {
    try {
      const chart = await loadNoteChart(existing.id);
      if (hasBeatSaberFields(chart)) return { artifact: existing, chart, created: false };
    } catch {
      // Fall through: the registered file is unreadable, rebuild it.
    }
  }
  const artifact = await exportArtifact(entryId, sourceArtifact.id, 'notechart');
  if (!artifact) throw new Error('note chart export returned no artifact');
  const chart = await loadNoteChart(artifact.id);
  return { artifact, chart, created: true };
}
