// Composer client -- typed calls to /api/composer (backend/modules/composer).
//
// Three actions: plan a roman-numeral phrase voiced in soprano, alto, tenor
// and bass (optionally in a composer's style); check parts for voice-leading
// faults; realize a figured bass in four parts. Style profiles list, load
// and count through styles(), style() and profile(). Notes travel as `{note, tick, ticks}` at the roll's own 960 PPQ
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

export type HarmonicRhythm = 'pulse' | 'bar' | 'style';

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
  /** 'pulse' puts a chord on every group start or beat; 'bar' one per bar;
   *  'style' (the default with a style) as often as the style changes chord. */
  harmonicRhythm?: HarmonicRhythm;
  ranges?: PartRanges;
  /** A style profile id from styles(): 'bach', 'debussy' ... Without a
   *  cadence, the style's cadence frequencies pick one. */
  style?: string;
}

export interface PlanResult {
  key: string;
  final_key: string;
  bars: number;
  seed: number;
  cadence: Cadence;
  /** The style the plan was written in, or null. */
  style: string | null;
  harmonic_rhythm: HarmonicRhythm;
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

/** Whether a profile was counted from scores or written from textbook facts. */
export type StyleSource = 'extracted' | 'authored';

export type OrchestrationPreset =
  | 'satb_choir'
  | 'voice_and_continuo'
  | 'string_quartet'
  | 'piano'
  | 'chamber_ensemble'
  | 'classical_orchestra'
  | 'romantic_orchestra'
  | 'impressionist_orchestra'
  | 'modern_orchestra';

/** One line of GET /api/composer/styles. */
export interface StyleSummary {
  id: string;
  name: string;
  era: string;
  source: StyleSource;
  /** Where the numbers come from, in one line. */
  basis: string;
  /** How many works it was counted from (0 when authored). */
  works: number;
  orchestration: OrchestrationPreset;
  chords_per_pulse: number;
}

/** A style profile (schema 'thedaw.composer.style'). Shares are 0..1. */
export interface StyleProfile {
  schema: 'thedaw.composer.style';
  schemaVersion: number;
  id: string;
  name: string;
  era: string;
  source: StyleSource;
  basis: string;
  /** Corpus paths or ids of the works counted; [] when authored. */
  works: string[];
  sample: { works: number; bars?: number; harmonies?: number; cadences?: number; [k: string]: unknown };
  modes: Record<KeyMode, number>;
  /** Roman-numeral chords (inversion dropped: 'V7', 'ii', 'N', 'V7/V') by share, per mode. */
  vocabulary: Record<KeyMode, Record<string, number>>;
  cadences: Record<Cadence, number>;
  /** Share of phrase ends that fit none of the six cadences. */
  cadence_other: number;
  harmonic_rhythm: { chords_per_bar: number; chords_per_pulse: number };
  texture: { voices: number; homophony: number; polyphony: number };
  meter: { meters: Record<string, number>; hemiola: number; syncopation: number };
  /** Melodic intervals in semitones, '0'..'12' and '13+'. */
  intervals: Record<string, number>;
  orchestration: OrchestrationPreset;
}

/** Count a profile from music21 corpus piece ids (GET /api/notation/corpus)
 *  or from a library composition's sheet; give one of the two. */
export interface ProfileRequest {
  corpus?: string[];
  entryId?: string;
  /** The new profile's id: lowercase letters, digits, '-' and '_'. */
  id?: string;
  name?: string;
  /** Bars read from each work (default 96). */
  maxBars?: number;
}

export interface ComposerCapabilities {
  module: string;
  ppq: number;
  cadences: Cadence[];
  include: ChordFeature[];
  harmonic_rhythms: HarmonicRhythm[];
  /** Ids of the shipped style profiles. */
  styles: string[];
  rules: VoiceLeadingRule[];
  ranges: Record<ComposerPart, [number, number]>;
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
    style: req.style,
  });
}

export function profileBody(req: ProfileRequest): Record<string, unknown> {
  return compact({
    corpus: req.corpus,
    entry_id: req.entryId,
    id: req.id,
    name: req.name,
    max_bars: req.maxBars,
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

  /** The shipped style profiles, one line each. */
  async styles(): Promise<StyleSummary[]> {
    const body = await getJson<{ styles: StyleSummary[] }>('/api/composer/styles');
    return body.styles;
  },

  /** One shipped style profile in full. */
  style(id: string): Promise<StyleProfile> {
    return getJson<StyleProfile>(`/api/composer/styles/${encodeURIComponent(id)}`);
  },

  /** A style profile counted from corpus pieces or a library composition. */
  profile(req: ProfileRequest): Promise<StyleProfile> {
    return postJson<StyleProfile>('/api/composer/profile', profileBody(req));
  },
};
