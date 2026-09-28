// Composer client -- typed calls to /api/composer (backend/modules/composer).
//
// Seven actions: plan a roman-numeral phrase voiced in soprano, alto, tenor
// and bass; check parts for voice-leading faults; realize a figured bass in
// four parts; write species counterpoint (first to fifth) against a cantus
// firmus; check a two-voice pair for invertible counterpoint; write a canon at
// an interval and lag; build a fugue exposition with its episodes and stretto
// search. Notes travel as `{note, tick, ticks}` at the roll's own 960 PPQ
// (lib/noteClock), and meter maps in the roll's shape (lib/meterMap), so a
// roll clip's notes and meter go in as they are and the answer's notes can go
// straight back.
//
// The helpers send through lib/apiJson, which adds the phone's pairing header
// that the backend's gate asks a LAN caller for, and throws ApiError with the
// route's own `detail` (a 422 names what could not be planned).

import { getJson, postJson } from './apiJson';
import type { MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';

export const COMPOSER_PPQ = PPQ;

export type ComposerPart = 'soprano' | 'alto' | 'tenor' | 'bass';
export const COMPOSER_PARTS: readonly ComposerPart[] = ['soprano', 'alto', 'tenor', 'bass'];

export type Cadence =
  | 'authentic_perfect'
  | 'authentic_imperfect'
  | 'half'
  | 'plagal'
  | 'deceptive'
  | 'phrygian_half';

/** Chromatic and seventh chords the planner can be asked to put in. */
export type ChordFeature = 'seventh' | 'applied' | 'neapolitan' | 'italian' | 'french' | 'german';

export type VoiceLeadingRule =
  | 'parallel_fifths'
  | 'parallel_octaves'
  | 'hidden_fifths'
  | 'hidden_octaves'
  | 'voice_crossing'
  | 'voice_overlap'
  | 'spacing'
  | 'range'
  | 'unresolved_leading_tone'
  | 'unresolved_seventh';

export type KeyMode = 'major' | 'minor';

/** A part's range as MIDI notes, inclusive: `{violin: [55, 103]}`. */
export type PartRanges = Record<string, [number, number]>;

export interface ComposerNote {
  /** MIDI note number. */
  note: number;
  /** Start in ticks at COMPOSER_PPQ. */
  tick: number;
  /** Length in ticks. */
  ticks: number;
  velocity?: number;
}

export interface FiguredBassNote extends ComposerNote {
  /** Figures as written: '', '6', '6/4', '64', '7', '#6', 'b7', '4/3'. */
  figure: string;
}

/** A note as the roll or anything else holds it: ticks when it has them, steps (sixteenths) when not. */
export interface NoteLike {
  note: number;
  tick?: number;
  ticks?: number;
  step?: number;
  length?: number;
}

export interface VoiceLeadingFlag {
  /** The meter map's bar index (0 = first bar, -1 = pickup). */
  bar: number;
  /** 1-based pulse in the bar: its group starts, dotted beats or beats. */
  beat: number;
  tick: number;
  parts: string[];
  rule: VoiceLeadingRule;
  message: string;
}

export interface PlannedChord {
  index: number;
  bar: number;
  beat: number;
  tick: number;
  ticks: number;
  /** music21's accent weight of the pulse the chord starts on (1 = downbeat). */
  accent: number;
  /** Roman numeral figure: 'I', 'V7/V', 'N6', 'It6', 'Fr43', 'Ger65', 'I64' ... */
  figure: string;
  /** Local key: 'C major', 'F# minor'. */
  key: string;
  kind: string;
  /** For the pivot chord of a modulation: its reading in the new key. */
  pivot: { figure: string; key: string } | null;
  pitches: Record<ComposerPart, number>;
  names: Record<ComposerPart, string>;
}

export interface PlanRequest {
  /** Tonic: 'C', 'F#', 'Bb'. A lowercase letter with no mode is minor. */
  key: string;
  mode?: KeyMode;
  bars?: number;
  meterMap?: readonly MeterSegment[];
  seed?: number;
  cadence?: Cadence;
  include?: ChordFeature[];
  /** A closely related key to modulate to through a pivot chord. */
  modulateTo?: string;
  /** 'pulse' puts a chord on every group start or beat; 'bar' one per bar. */
  harmonicRhythm?: 'pulse' | 'bar';
  ranges?: PartRanges;
}

export interface PlanResult {
  key: string;
  final_key: string;
  bars: number;
  seed: number;
  cadence: Cadence;
  ppq: number;
  meter_map: MeterSegment[];
  chords: PlannedChord[];
  parts: Record<ComposerPart, ComposerNote[]>;
  flags: VoiceLeadingFlag[];
}

export interface ChordLabel {
  tick: number;
  figure: string;
  key?: string;
}

export interface CheckRequest {
  parts: Record<string, readonly NoteLike[]>;
  /** Part names top voice first; SATB names sort themselves. */
  order?: string[];
  key?: string;
  mode?: KeyMode;
  /** The harmony from each tick on; without it the checker reads each slice in `key`. */
  chords?: ChordLabel[];
  ranges?: PartRanges;
  meterMap?: readonly MeterSegment[];
  pickupSteps?: number;
}

export interface CheckResult {
  flags: VoiceLeadingFlag[];
  count: number;
}

export interface ContinuoRequest {
  bass: readonly FiguredBassNote[];
  key: string;
  mode?: KeyMode;
  ranges?: PartRanges;
  meterMap?: readonly MeterSegment[];
  pickupSteps?: number;
}

export interface ContinuoChord {
  bar: number;
  beat: number;
  tick: number;
  ticks: number;
  figure: string;
  /** The roman numeral music21 reads in the realized chord. */
  roman: string | null;
  pitches: Record<ComposerPart, number>;
  names: Record<ComposerPart, string>;
}

export interface ContinuoResult {
  key: string;
  ppq: number;
  chords: ContinuoChord[];
  parts: Record<ComposerPart, ComposerNote[]>;
  flags: VoiceLeadingFlag[];
}

export interface ComposerCapabilities {
  module: string;
  ppq: number;
  cadences: Cadence[];
  include: ChordFeature[];
  harmonic_rhythms: string[];
  rules: VoiceLeadingRule[];
  ranges: Record<ComposerPart, [number, number]>;
  species: Species[];
  modes: ModalMode[];
  invertible_at: InvertibleInterval[];
  /** Fux's cantus firmi: MIDI notes, one a bar, and the mode they are in. */
  cantus_firmi: Record<CantusPreset, { key: string; notes: number[] }>;
  /** Voice names by voice count: `{'3': ['soprano', 'alto', 'bass']}`. */
  fugue_voices: Record<string, string[]>;
  counterpoint_rules: CounterpointRule[];
}

// ── counterpoint, canon and fugue ───────────────────────────────────────────

export type Species = 1 | 2 | 3 | 4 | 5;
export type ModalMode = KeyMode | 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian';
export type CantusPreset = 'fux_dorian' | 'fux_phrygian' | 'fux_mixolydian' | 'fux_aeolian' | 'fux_ionian';
/** Invertible counterpoint at the octave, tenth or twelfth. */
export type InvertibleInterval = 8 | 10 | 12;

export type CounterpointRule =
  | 'dissonance'
  | 'parallel_fifths'
  | 'parallel_octaves'
  | 'direct_perfect'
  | 'hidden_fifths'
  | 'hidden_octaves'
  | 'accented_parallels'
  | 'voice_crossing'
  | 'voice_overlap'
  | 'spacing'
  | 'unison'
  | 'parallel_imperfect'
  | 'melodic_interval'
  | 'repeated_note'
  | 'leap_recovery'
  | 'consecutive_leaps'
  | 'eighths'
  | 'ficta'
  | 'line_range'
  | 'climax'
  | 'opening'
  | 'cadence'
  | 'rhythm'
  | 'broken_ties';

/** A counterpoint rule broken at a place, shaped like the checker's flags. */
export interface CounterpointFlag {
  bar: number;
  beat: number;
  tick: number;
  parts: string[];
  rule: CounterpointRule;
  message: string;
}

export interface SpeciesRequest {
  /** The cantus firmus, one note a bar in time order; it comes back re-timed as whole notes. */
  cantus?: readonly NoteLike[];
  /** One of Fux's cantus firmi instead of `cantus`. */
  preset?: CantusPreset;
  /** 'D dorian', 'A', 'c'. Without it the mode is read from the cantus and its final. */
  key?: string;
  mode?: ModalMode;
  species?: Species;
  position?: 'above' | 'below';
  seed?: number;
  /** Accept only a line that also inverts cleanly at this interval. */
  invertible?: InvertibleInterval;
  /** Where the cantus starts (floored to a bar); a sent cantus starts at its first note. */
  startTick?: number;
}

export interface Suspension {
  bar: number;
  beat: number;
  tick: number;
  figure: '7-6' | '4-3' | '9-8' | '2-3' | null;
}

export interface InvertibleVersion {
  violations: CounterpointFlag[];
  flags: VoiceLeadingFlag[];
}

export interface InvertibleResult {
  ok: boolean;
  interval: InvertibleInterval;
  key: string;
  original: InvertibleVersion;
  inverted: InvertibleVersion & { parts: Record<string, ComposerNote[]>; order: string[] };
}

export interface SpeciesResult {
  species: Species;
  position: 'above' | 'below';
  key: string;
  ppq: number;
  bar_ticks: number;
  seed: number;
  invertible: InvertibleInterval | null;
  /** Part names top voice first. */
  order: string[];
  parts: { counterpoint: ComposerNote[]; cantus: ComposerNote[] };
  suspensions: Suspension[];
  /** The fifth species' bar patterns; the second's 'whole_penultimate' when it closes on a whole note. */
  rhythm: string[];
  violations: CounterpointFlag[];
  flags: VoiceLeadingFlag[];
  inversion?: InvertibleResult;
}

export interface InvertibleRequest {
  upper: readonly NoteLike[];
  lower: readonly NoteLike[];
  interval?: InvertibleInterval;
  key?: string;
  mode?: ModalMode;
}

export interface CanonRequest {
  key: string;
  mode?: ModalMode;
  /** The follower's generic interval: 1 unison, 5 a fifth above, -4 a fourth below, 8 an octave above. */
  interval?: number;
  /** The follower's delay in ticks, a whole number of quarters. */
  lag?: number;
  bars?: number;
  seed?: number;
  /** 'diatonic' stays in the key; 'real' moves by the exact interval. */
  transposition?: 'diatonic' | 'real';
  rhythm?: 'mixed' | 'halves' | 'quarters';
  startTick?: number;
}

export interface CanonResult {
  key: string;
  ppq: number;
  bar_ticks: number;
  interval: number;
  transposition: 'diatonic' | 'real';
  lag: number;
  bars: number;
  seed: number;
  /** The follower imitates strictly before this tick; the cadence follows. */
  canonic_until: number;
  rhythm: string[];
  order: string[];
  parts: { leader: ComposerNote[]; follower: ComposerNote[] };
  violations: CounterpointFlag[];
  flags: VoiceLeadingFlag[];
}

export interface FugueRequest {
  key: string;
  mode?: ModalMode;
  voices?: 2 | 3 | 4;
  /** The subject; without it one is written, two bars long. */
  subject?: readonly NoteLike[];
  /** Where a written subject starts: the tonic or the dominant. */
  subjectStart?: 'tonic' | 'dominant';
  seed?: number;
  episodes?: 0 | 1 | 2;
  countersubject?: boolean;
  startTick?: number;
}

export interface FugueEntry {
  voice: string;
  form: 'subject' | 'answer';
  tick: number;
  ticks: number;
  /** Semitones from the subject as given. */
  transpose: number;
}

export interface FugueEpisode {
  tick: number;
  ticks: number;
  /** The voice that sequences the subject fragment. */
  voice: string;
  fragment_notes: number;
  /** Ticks of one statement of the sequence. */
  model: number;
  reps: number;
  direction: 'down' | 'up';
  voices: string[];
  /** The voices that follow the sequence; the rest play free counterpoint. */
  sequential: string[];
}

export interface Stretto {
  lag: number;
  lag_beats: number;
  interval: number;
  follower: 'above' | 'below' | 'unison';
}

export interface FugueResult {
  key: string;
  ppq: number;
  bar_ticks: number;
  /** Voice names, top first. */
  voices: string[];
  seed: number;
  subject: ComposerNote[];
  answer: { kind: 'tonal' | 'real'; mutations: number[]; head: number; notes: ComposerNote[] };
  countersubject: ComposerNote[];
  countersubject_inversion: InvertibleResult | null;
  /** The countersubject accompanies entries 1 to this one (0: none). */
  countersubject_entries: number;
  /** Ticks of rest before the countersubject starts. */
  countersubject_rest: number;
  resting: { voice: string; tick: number; ticks: number }[];
  entries: FugueEntry[];
  episodes: FugueEpisode[];
  strettos: Stretto[];
  exposition_end: number;
  parts: Record<string, ComposerNote[]>;
  ranges: Record<string, [number, number]>;
  violations: CounterpointFlag[];
  flags: VoiceLeadingFlag[];
}

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/** `{note, tick, ticks}` for the backend: the note's own ticks when it has
 *  them, else its steps in ticks. Roll-only fields (id, lane, expr) stay home. */
export function toComposerNote(n: NoteLike): ComposerNote {
  const tick = typeof n.tick === 'number' && Number.isFinite(n.tick) ? n.tick : (n.step ?? 0) * TICKS_PER_STEP;
  const ticks = typeof n.ticks === 'number' && Number.isFinite(n.ticks) ? n.ticks : (n.length ?? 0) * TICKS_PER_STEP;
  return { note: Math.round(n.note), tick: Math.max(0, Math.round(tick)), ticks: Math.max(1, Math.round(ticks)) };
}

/** The roll's meter map as the backend reads it: bar and `{num, den, groups}`, nothing else. */
export function toMeterMap(map: readonly MeterSegment[] | undefined): MeterSegment[] {
  return (map ?? []).map((s) => ({
    bar: s.bar,
    meter: { num: s.meter.num, den: s.meter.den, groups: [...(s.meter.groups ?? [])] },
  }));
}

/** Drop keys whose value is undefined, so the backend's defaults apply. */
function compact<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function planBody(req: PlanRequest): Record<string, unknown> {
  return compact({
    key: req.key,
    mode: req.mode,
    bars: req.bars,
    meter_map: req.meterMap ? toMeterMap(req.meterMap) : undefined,
    seed: req.seed,
    cadence: req.cadence,
    include: req.include,
    modulate_to: req.modulateTo,
    harmonic_rhythm: req.harmonicRhythm,
    ranges: req.ranges,
  });
}

export function checkBody(req: CheckRequest): Record<string, unknown> {
  return compact({
    parts: Object.fromEntries(Object.entries(req.parts).map(([name, notes]) => [name, notes.map(toComposerNote)])),
    order: req.order,
    key: req.key,
    mode: req.mode,
    chords: req.chords,
    ranges: req.ranges,
    meter_map: req.meterMap ? toMeterMap(req.meterMap) : undefined,
    pickup_steps: req.pickupSteps,
  });
}

export function continuoBody(req: ContinuoRequest): Record<string, unknown> {
  return compact({
    bass: req.bass.map((n) => ({ ...toComposerNote(n), figure: n.figure ?? '' })),
    key: req.key,
    mode: req.mode,
    ranges: req.ranges,
    meter_map: req.meterMap ? toMeterMap(req.meterMap) : undefined,
    pickup_steps: req.pickupSteps,
  });
}

export function speciesBody(req: SpeciesRequest): Record<string, unknown> {
  return compact({
    cantus: req.cantus ? req.cantus.map(toComposerNote) : undefined,
    preset: req.preset,
    key: req.key,
    mode: req.mode,
    species: req.species,
    position: req.position,
    seed: req.seed,
    invertible: req.invertible,
    start_tick: req.startTick,
  });
}

export function invertibleBody(req: InvertibleRequest): Record<string, unknown> {
  return compact({
    upper: req.upper.map(toComposerNote),
    lower: req.lower.map(toComposerNote),
    interval: req.interval,
    key: req.key,
    mode: req.mode,
  });
}

export function canonBody(req: CanonRequest): Record<string, unknown> {
  return compact({
    key: req.key,
    mode: req.mode,
    interval: req.interval,
    lag: req.lag,
    bars: req.bars,
    seed: req.seed,
    transposition: req.transposition,
    rhythm: req.rhythm,
    start_tick: req.startTick,
  });
}

export function fugueBody(req: FugueRequest): Record<string, unknown> {
  return compact({
    key: req.key,
    mode: req.mode,
    voices: req.voices,
    subject: req.subject ? req.subject.map(toComposerNote) : undefined,
    subject_start: req.subjectStart,
    seed: req.seed,
    episodes: req.episodes,
    countersubject: req.countersubject,
    start_tick: req.startTick,
  });
}

export const composerApi = {
  /** Cadences, chord kinds, rules and default SATB ranges the backend knows. */
  capabilities(): Promise<ComposerCapabilities> {
    return getJson<ComposerCapabilities>('/api/composer/');
  },

  /** A phrase in `key`, voiced in four parts with no voice-leading flags. */
  plan(req: PlanRequest): Promise<PlanResult> {
    return postJson<PlanResult>('/api/composer/plan', planBody(req));
  },

  /** Voice-leading flags for any set of parts. */
  check(req: CheckRequest): Promise<CheckResult> {
    return postJson<CheckResult>('/api/composer/check', checkBody(req));
  },

  /** A figured bass realized in four parts. */
  continuo(req: ContinuoRequest): Promise<ContinuoResult> {
    return postJson<ContinuoResult>('/api/composer/continuo', continuoBody(req));
  },

  /** A species counterpoint above or below a cantus firmus, with no rule broken. */
  species(req: SpeciesRequest): Promise<SpeciesResult> {
    return postJson<SpeciesResult>('/api/composer/species', speciesBody(req));
  },

  /** A two-voice pair checked as written and inverted at the octave, tenth or twelfth. */
  invertibleCheck(req: InvertibleRequest): Promise<InvertibleResult> {
    return postJson<InvertibleResult>('/api/composer/invertible-check', invertibleBody(req));
  },

  /** A two-voice canon at an interval and lag, closed with a cadence. */
  canon(req: CanonRequest): Promise<CanonResult> {
    return postJson<CanonResult>('/api/composer/canon', canonBody(req));
  },

  /** A fugue exposition with its answer, countersubject, episodes and stretto search. */
  fugue(req: FugueRequest): Promise<FugueResult> {
    return postJson<FugueResult>('/api/composer/fugue', fugueBody(req));
  },
};
