/**
 * composerPanelModel — the COMPOSE panel's options, limits, requests and
 * status, with no React and no store, so node tests read it whole.
 *
 * Every option list and limit here is the backend's own (the Pydantic models
 * in backend/modules/composer/router.py and the checks in canon.py, fugue.py
 * and form.py), so no control the panel draws can send a request the backend
 * refuses for its shape. What the backend refuses for its music (a key with no
 * pivot, a cantus with no stepwise close) comes back as a 422 whose message
 * the panel shows in its status line.
 */
import { ApiError } from './apiJson';
import type {
  Cadence,
  CanonRequest,
  CantusPreset,
  ComposerNote,
  CounterpointFlag,
  FormMeter,
  FormName,
  FormRequest,
  FugueRequest,
  HarmonicRhythm,
  InvertibleInterval,
  InvertibleRequest,
  KeyMode,
  ModalMode,
  NoteLike,
  PlanRequest,
  ProfileRequest,
  RondoPattern,
  Species,
  SpeciesRequest,
  StyleProfile,
  StyleSummary,
  VoiceLeadingFlag,
} from './composerClient';
import type { MeterSegment } from './meterMap';
import { PPQ } from './noteClock';

/* ── options ─────────────────────────────────────────────────────────────── */

export interface Option<T> {
  value: T;
  label: string;
}

/** Tonics the key pickers offer: every pitch class, both spellings of the black keys. */
export const TONICS: readonly string[] = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const KEY_MODES: readonly Option<KeyMode>[] = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
];

/** The church modes and major/minor, for counterpoint, canon and fugue. */
export const MODAL_MODES: readonly Option<ModalMode>[] = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'ionian', label: 'Ionian' },
  { value: 'dorian', label: 'Dorian' },
  { value: 'phrygian', label: 'Phrygian' },
  { value: 'lydian', label: 'Lydian' },
  { value: 'mixolydian', label: 'Mixolydian' },
  { value: 'aeolian', label: 'Aeolian' },
];

/** '' leaves the cadence to the backend: perfect authentic, or the style's own mix. */
export const CADENCE_OPTIONS: readonly Option<Cadence | ''>[] = [
  { value: '', label: 'Auto (perfect, or the style’s)' },
  { value: 'authentic_perfect', label: 'Perfect authentic' },
  { value: 'authentic_imperfect', label: 'Imperfect authentic' },
  { value: 'half', label: 'Half' },
  { value: 'plagal', label: 'Plagal' },
  { value: 'deceptive', label: 'Deceptive' },
  { value: 'phrygian_half', label: 'Phrygian half' },
];

/** '' leaves it to the backend: a chord on every pulse, or the style's rate with a style. */
export function harmonicRhythmOptions(hasStyle: boolean): Option<HarmonicRhythm | ''>[] {
  const out: Option<HarmonicRhythm | ''>[] = [
    { value: '', label: hasStyle ? 'Auto (the style’s rate)' : 'Auto (every pulse)' },
    { value: 'pulse', label: 'Every pulse' },
    { value: 'bar', label: 'One per bar' },
  ];
  // "style" needs a style: the backend refuses it without one.
  if (hasStyle) out.push({ value: 'style', label: 'The style’s rate' });
  return out;
}

/** A style picker option: its name and era, and whether its numbers were
 *  measured from scores or authored from textbook facts. */
export function styleOptionLabel(s: Pick<StyleSummary, 'name' | 'era' | 'source' | 'works'>): string {
  const era = s.era ? ` (${s.era})` : '';
  const how = s.source === 'authored' ? 'authored' : `measured${s.works ? `, ${s.works} works` : ''}`;
  return `${s.name}${era}: ${how}`;
}

export const FORM_OPTIONS: readonly Option<FormName>[] = [
  { value: 'sonata', label: 'Sonata' },
  { value: 'rondo', label: 'Rondo' },
  { value: 'theme_and_variations', label: 'Theme and variations' },
  { value: 'minuet_and_trio', label: 'Minuet and trio' },
  { value: 'scherzo', label: 'Scherzo' },
  { value: 'symphony', label: 'Symphony (four movements)' },
];

export const RONDO_OPTIONS: readonly Option<RondoPattern>[] = [
  { value: 'ABACA', label: 'ABACA' },
  { value: 'ABACABA', label: 'ABACABA' },
];

/** Meters a single form can be set in; '' keeps the form's own. */
export const FORM_METER_OPTIONS: readonly Option<string>[] = [
  { value: '', label: 'The form’s own' },
  ...['2/2', '2/4', '3/4', '4/4', '5/4', '3/8', '6/8', '7/8', '9/8', '12/8'].map((m) => ({ value: m, label: m })),
];

export const SPECIES_OPTIONS: readonly Option<Species>[] = [
  { value: 1, label: '1st: note against note' },
  { value: 2, label: '2nd: two against one' },
  { value: 3, label: '3rd: four against one' },
  { value: 4, label: '4th: syncopation' },
  { value: 5, label: '5th: florid' },
];

export const CANTUS_PRESETS: readonly Option<CantusPreset>[] = [
  { value: 'fux_dorian', label: 'Fux, D dorian' },
  { value: 'fux_phrygian', label: 'Fux, E phrygian' },
  { value: 'fux_mixolydian', label: 'Fux, G mixolydian' },
  { value: 'fux_aeolian', label: 'Fux, A aeolian' },
  { value: 'fux_ionian', label: 'Fux, C ionian' },
];

/** '' accepts any line; a number accepts only a line that also inverts there. */
export const INVERTIBLE_OPTIONS: readonly Option<InvertibleInterval | ''>[] = [
  { value: '', label: 'Not required' },
  { value: 8, label: 'At the octave' },
  { value: 10, label: 'At the tenth' },
  { value: 12, label: 'At the twelfth' },
];

export const INVERSION_INTERVALS: readonly Option<InvertibleInterval>[] = [
  { value: 8, label: 'Octave' },
  { value: 10, label: 'Tenth' },
  { value: 12, label: 'Twelfth' },
];

const ORDINAL = ['', 'unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'octave', '9th', '10th', '11th', '12th', '13th', '14th', 'double octave'];

/** A canon's generic interval in words: 1 the unison, 5 a fifth above, -4 a fourth below. */
export function canonIntervalLabel(n: number): string {
  if (n === 1) return 'Unison';
  const name = ORDINAL[Math.abs(n)] ?? `${Math.abs(n)}th`;
  const word = name.charAt(0).toUpperCase() + name.slice(1);
  return `${word} ${n > 0 ? 'above' : 'below'}`;
}

/** Every generic interval canon.py takes: 1, 2 to 15 and -2 to -15 (never 0 or -1). */
export const CANON_INTERVALS: readonly Option<number>[] = [
  1,
  ...Array.from({ length: 14 }, (_, i) => i + 2),
  ...Array.from({ length: 14 }, (_, i) => -(i + 2)),
].map((n) => ({ value: n, label: canonIntervalLabel(n) }));

export const CANON_TRANSPOSITIONS: readonly Option<'diatonic' | 'real'>[] = [
  { value: 'diatonic', label: 'Diatonic (in the key)' },
  { value: 'real', label: 'Real (exact interval)' },
];

export const CANON_RHYTHMS: readonly Option<'mixed' | 'halves' | 'quarters'>[] = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'halves', label: 'Halves' },
  { value: 'quarters', label: 'Quarters' },
];

export const FUGUE_VOICE_OPTIONS: readonly Option<2 | 3 | 4>[] = [
  { value: 2, label: '2 voices' },
  { value: 3, label: '3 voices' },
  { value: 4, label: '4 voices' },
];

export const FUGUE_EPISODE_OPTIONS: readonly Option<0 | 1 | 2>[] = [
  { value: 0, label: 'None' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

export const SUBJECT_STARTS: readonly Option<'tonic' | 'dominant'>[] = [
  { value: 'tonic', label: 'Tonic' },
  { value: 'dominant', label: 'Dominant' },
];

/* ── limits (router.py, canon.py, form.py) ───────────────────────────────── */

export const LIMITS = {
  planBars: { min: 2, max: 64 },
  formBars: { min: 16, max: 400 },
  symphonyBars: { min: 16, max: 800 },
  formTempo: { min: 20, max: 300 },
  variations: { min: 1, max: 12 },
  canonBars: { min: 4, max: 32 },
  /** A canon's lag, in quarter notes: PPQ to four 4/4 bars. */
  canonLagBeats: { min: 1, max: 16 },
  cantusNotes: { min: 2, max: 32 },
  subjectNotes: { min: 2, max: 32 },
  inversionNotes: { min: 1, max: 4096 },
  profileWorks: { min: 1, max: 40 },
  profileMaxBars: { min: 4, max: 400 },
  profileName: 80,
  seed: { min: 0, max: 2 ** 31 - 1 },
} as const;

/** A profile id the backend accepts: lowercase letters, digits, '-' and '_', 1 to 40. */
export const PROFILE_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** A whole number inside [min, max]; `fallback` for anything that is not a number. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** A new seed for the re-roll key. */
export function rerollSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 1_000_000);
}

/** The fewest bars a canon with a lag of `lagBeats` quarters fits in (canon.py:
 *  the follower's entry and a quarter before the two-bar cadence). */
export function minCanonBars(lagBeats: number): number {
  const lag = clampInt(lagBeats, LIMITS.canonLagBeats.min, LIMITS.canonLagBeats.max, 4);
  return Math.max(LIMITS.canonBars.min, Math.ceil((lag + 1) / 4) + 2);
}

/** The most bars a form can have: a symphony's four movements share up to 800. */
export function formBarsMax(form: FormName): number {
  return form === 'symphony' ? LIMITS.symphonyBars.max : LIMITS.formBars.max;
}

/** A meter option's value as the backend's `{num, den, groups}`; null for the form's own. */
export function parseFormMeter(value: string): FormMeter | null {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num < 1 || num > 64 || ![1, 2, 4, 8, 16, 32].includes(den)) return null;
  return { num, den, groups: [] };
}

/* ── panel state and the requests built from it ──────────────────────────── */

export interface HarmonyState {
  key: string;
  mode: KeyMode;
  bars: number;
  cadence: Cadence | '';
  harmonicRhythm: HarmonicRhythm | '';
  /** A style id from /styles, or '' for none. */
  style: string;
  seed: number;
}

export const DEFAULT_HARMONY: HarmonyState = { key: 'C', mode: 'major', bars: 8, cadence: '', harmonicRhythm: '', style: '', seed: 0 };

export function planRequest(h: HarmonyState, meterMap?: readonly MeterSegment[]): PlanRequest {
  const style = h.style || undefined;
  const rhythm = h.harmonicRhythm === 'style' && !style ? undefined : h.harmonicRhythm || undefined;
  return {
    key: h.key,
    mode: h.mode,
    bars: clampInt(h.bars, LIMITS.planBars.min, LIMITS.planBars.max, 8),
    seed: clampInt(h.seed, LIMITS.seed.min, LIMITS.seed.max, 0),
    ...(h.cadence ? { cadence: h.cadence } : {}),
    ...(rhythm ? { harmonicRhythm: rhythm } : {}),
    ...(style ? { style } : {}),
    ...(meterMap && meterMap.length ? { meterMap } : {}),
  };
}

export interface FormState {
  form: FormName;
  key: string;
  mode: KeyMode;
  /** null: the form's own length. */
  bars: number | null;
  /** null: the form's own tempo. */
  tempo: number | null;
  /** '' : the form's own meter; else '3/4' and the like. */
  meter: string;
  rondo: RondoPattern;
  /** null: the form's own count. */
  variations: number | null;
  seed: number;
}

export const DEFAULT_FORM: FormState = {
  form: 'sonata',
  key: 'C',
  mode: 'major',
  bars: null,
  tempo: null,
  meter: '',
  rondo: 'ABACA',
  variations: null,
  seed: 0,
};

/** Whether a FORM control means anything for the form chosen (a symphony keeps
 *  its movements' own meters and tempi; only a rondo has a pattern). */
export function formControlApplies(form: FormName, control: 'tempo' | 'meter' | 'rondo' | 'variations'): boolean {
  if (control === 'rondo') return form === 'rondo';
  if (control === 'variations') return form === 'theme_and_variations';
  return form !== 'symphony';
}

export function formRequest(f: FormState): FormRequest {
  const req: FormRequest = {
    form: f.form,
    key: f.key,
    mode: f.mode,
    seed: clampInt(f.seed, LIMITS.seed.min, LIMITS.seed.max, 0),
  };
  if (f.bars !== null && Number.isFinite(f.bars)) req.bars = clampInt(f.bars, LIMITS.formBars.min, formBarsMax(f.form), LIMITS.formBars.min);
  if (formControlApplies(f.form, 'tempo') && f.tempo !== null && Number.isFinite(f.tempo)) {
    req.tempo = Math.max(LIMITS.formTempo.min, Math.min(LIMITS.formTempo.max, f.tempo));
  }
  if (formControlApplies(f.form, 'meter')) {
    const meter = parseFormMeter(f.meter);
    if (meter) req.meter = meter;
  }
  if (formControlApplies(f.form, 'rondo')) req.rondo = f.rondo;
  if (formControlApplies(f.form, 'variations') && f.variations !== null && Number.isFinite(f.variations)) {
    req.variations = clampInt(f.variations, LIMITS.variations.min, LIMITS.variations.max, 4);
  }
  return req;
}

/** Two form requests ask for the same thing (a realize can reuse the last plan's answer). */
export function sameFormRequest(a: FormRequest | null, b: FormRequest | null): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

export interface CounterpointState {
  species: Species;
  position: 'above' | 'below';
  /** 'part' takes the cantus from the selected roll part; else a Fux preset. */
  cantus: 'part' | CantusPreset;
  /** '' reads the key from the cantus. */
  key: string;
  /** '' reads the mode from the cantus's final. */
  mode: ModalMode | '';
  invertible: InvertibleInterval | '';
  seed: number;
}

export const DEFAULT_COUNTERPOINT: CounterpointState = {
  species: 1,
  position: 'above',
  cantus: 'fux_dorian',
  key: '',
  mode: '',
  invertible: '',
  seed: 0,
};

/** A request the panel cannot send, and why. */
export class ComposeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeInputError';
  }
}

/** A single line from a part's notes: time order, one note per start (the top one of a chord). */
export function melodicLine(notes: readonly NoteLike[]): NoteLike[] {
  const starts = new Map<number, NoteLike>();
  for (const n of notes) {
    const tick = typeof n.tick === 'number' ? n.tick : (n.step ?? 0) * (PPQ / 4);
    const held = starts.get(tick);
    if (!held || n.note > held.note) starts.set(tick, n);
  }
  return [...starts.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

export function speciesRequest(c: CounterpointState, partNotes?: readonly NoteLike[]): SpeciesRequest {
  const req: SpeciesRequest = {
    species: c.species,
    position: c.position,
    seed: clampInt(c.seed, LIMITS.seed.min, LIMITS.seed.max, 0),
    ...(c.invertible ? { invertible: c.invertible } : {}),
  };
  if (c.cantus !== 'part') return { ...req, preset: c.cantus };
  const line = melodicLine(partNotes ?? []);
  if (line.length < LIMITS.cantusNotes.min) throw new ComposeInputError('the selected part needs at least two notes to be a cantus');
  if (line.length > LIMITS.cantusNotes.max) {
    throw new ComposeInputError(`a cantus is at most ${LIMITS.cantusNotes.max} notes; the selected part has ${line.length}`);
  }
  return {
    ...req,
    cantus: line,
    ...(c.key ? { key: c.key } : {}),
    ...(c.mode ? { mode: c.mode } : {}),
  };
}

export interface CanonState {
  key: string;
  mode: ModalMode;
  interval: number;
  lagBeats: number;
  bars: number;
  transposition: 'diatonic' | 'real';
  rhythm: 'mixed' | 'halves' | 'quarters';
  seed: number;
}

export const DEFAULT_CANON: CanonState = {
  key: 'C',
  mode: 'major',
  interval: 8,
  lagBeats: 4,
  bars: 8,
  transposition: 'diatonic',
  rhythm: 'mixed',
  seed: 0,
};

export function canonRequest(c: CanonState): CanonRequest {
  const lagBeats = clampInt(c.lagBeats, LIMITS.canonLagBeats.min, LIMITS.canonLagBeats.max, 4);
  const interval = CANON_INTERVALS.some((o) => o.value === c.interval) ? c.interval : 8;
  return {
    key: c.key,
    mode: c.mode,
    interval,
    lag: lagBeats * PPQ,
    bars: clampInt(c.bars, minCanonBars(lagBeats), LIMITS.canonBars.max, 8),
    transposition: c.transposition,
    rhythm: c.rhythm,
    seed: clampInt(c.seed, LIMITS.seed.min, LIMITS.seed.max, 0),
  };
}

export interface FugueState {
  key: string;
  mode: ModalMode;
  voices: 2 | 3 | 4;
  /** 'part' takes the subject from the selected roll part; 'generate' writes one. */
  subject: 'generate' | 'part';
  subjectStart: 'tonic' | 'dominant';
  episodes: 0 | 1 | 2;
  countersubject: boolean;
  seed: number;
}

export const DEFAULT_FUGUE: FugueState = {
  key: 'C',
  mode: 'minor',
  voices: 3,
  subject: 'generate',
  subjectStart: 'tonic',
  episodes: 1,
  countersubject: true,
  seed: 0,
};

export function fugueRequest(f: FugueState, partNotes?: readonly NoteLike[]): FugueRequest {
  const req: FugueRequest = {
    key: f.key,
    mode: f.mode,
    voices: f.voices,
    episodes: f.episodes,
    countersubject: f.countersubject,
    seed: clampInt(f.seed, LIMITS.seed.min, LIMITS.seed.max, 0),
  };
  if (f.subject === 'generate') return { ...req, subjectStart: f.subjectStart };
  const line = melodicLine(partNotes ?? []);
  if (line.length < LIMITS.subjectNotes.min) throw new ComposeInputError('the selected part needs at least two notes to be a subject');
  if (line.length > LIMITS.subjectNotes.max) {
    throw new ComposeInputError(`a subject is at most ${LIMITS.subjectNotes.max} notes; the selected part has ${line.length}`);
  }
  return { ...req, subject: line };
}

export function inversionRequest(
  upper: readonly NoteLike[],
  lower: readonly NoteLike[],
  interval: InvertibleInterval,
  key?: string,
  mode?: ModalMode | '',
): InvertibleRequest {
  if (!upper.length || !lower.length) throw new ComposeInputError('both parts need notes to check an inversion');
  if (upper.length > LIMITS.inversionNotes.max || lower.length > LIMITS.inversionNotes.max) {
    throw new ComposeInputError(`a part is at most ${LIMITS.inversionNotes.max} notes for an inversion check`);
  }
  return { upper: [...upper], lower: [...lower], interval, ...(key ? { key } : {}), ...(mode ? { mode } : {}) };
}

export interface ProfileState {
  source: 'corpus' | 'library' | 'style';
  corpus: string[];
  entryId: string;
  /** A shipped style id, for 'style'. */
  style: string;
  id: string;
  name: string;
  maxBars: number;
}

export const DEFAULT_PROFILE: ProfileState = {
  source: 'corpus',
  corpus: [],
  entryId: '',
  style: '',
  id: 'custom',
  name: '',
  maxBars: 96,
};

export function profileRequest(p: ProfileState): ProfileRequest {
  const id = p.id.trim() || 'custom';
  if (!PROFILE_ID_PATTERN.test(id)) throw new ComposeInputError('a profile id is lowercase letters, digits, - and _, at most 40');
  const name = p.name.trim().slice(0, LIMITS.profileName);
  const maxBars = clampInt(p.maxBars, LIMITS.profileMaxBars.min, LIMITS.profileMaxBars.max, 96);
  if (p.source === 'library') {
    if (!p.entryId) throw new ComposeInputError('pick a library score first');
    return { entryId: p.entryId, id, ...(name ? { name } : {}), maxBars };
  }
  if (!p.corpus.length) throw new ComposeInputError('pick at least one corpus piece');
  if (p.corpus.length > LIMITS.profileWorks.max) throw new ComposeInputError(`at most ${LIMITS.profileWorks.max} corpus pieces`);
  return { corpus: [...p.corpus], id, ...(name ? { name } : {}), maxBars };
}

/** Toggle a corpus piece in or out of a profile's list, never past the backend's 40. */
export function toggleCorpusPiece(list: readonly string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  if (list.length >= LIMITS.profileWorks.max) return [...list];
  return [...list, id];
}

/* ── what a profile's numbers show ───────────────────────────────────────── */

export interface Share {
  label: string;
  /** 0..100, one decimal. */
  pct: number;
}

const pct = (v: number): number => Math.round(v * 1000) / 10;

/** The most used chords of a profile in a mode, most first. */
export function topChords(profile: Pick<StyleProfile, 'vocabulary'>, mode: KeyMode, n = 8): Share[] {
  const vocab = profile.vocabulary?.[mode] ?? {};
  return Object.entries(vocab)
    // Ties in code-point order, so the list is the same in every locale.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([label, v]) => ({ label, pct: pct(v) }));
}

const CADENCE_WORDS: Record<Cadence, string> = {
  authentic_perfect: 'Perfect authentic',
  authentic_imperfect: 'Imperfect authentic',
  half: 'Half',
  plagal: 'Plagal',
  deceptive: 'Deceptive',
  phrygian_half: 'Phrygian half',
};

/** A profile's cadences by share, most first, with the phrase ends that fit none. */
export function cadenceShares(profile: Pick<StyleProfile, 'cadences' | 'cadence_other'>): Share[] {
  const out = Object.entries(profile.cadences ?? {})
    .map(([k, v]) => ({ label: CADENCE_WORDS[k as Cadence] ?? k, pct: pct(v) }))
    .sort((a, b) => b.pct - a.pct);
  if (profile.cadence_other) out.push({ label: 'Other', pct: pct(profile.cadence_other) });
  return out;
}

/** "2.1 chords a bar, 0.55 a pulse". */
export function harmonicRhythmText(profile: Pick<StyleProfile, 'harmonic_rhythm'>): string {
  const hr = profile.harmonic_rhythm;
  if (!hr) return 'unknown';
  return `${hr.chords_per_bar.toFixed(2)} chords a bar, ${hr.chords_per_pulse.toFixed(2)} a pulse`;
}

/* ── flags ───────────────────────────────────────────────────────────────── */

export type AnyFlag = VoiceLeadingFlag | CounterpointFlag;

/** 'parallel_fifths' as 'Parallel fifths'. */
export function ruleLabel(rule: string): string {
  const words = rule.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Flags counted by rule, most first. */
export function countByRule(flags: readonly AnyFlag[]): { rule: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of flags) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, count]) => ({ rule, label: ruleLabel(rule), count }));
}

/** Where a flag sits, as a musician reads it: bar 1 is the first bar, bar -1 the pickup. */
export function flagPlace(f: Pick<AnyFlag, 'bar' | 'beat'>): string {
  return f.bar < 0 ? `Pickup, beat ${f.beat}` : `Bar ${f.bar + 1}, beat ${f.beat}`;
}

/** The ids of notes in `notes` that sound at `tick` (started at or before it, still held). */
export function notesSoundingAt(notes: readonly { id: string; tick?: number; ticks?: number; step: number; length: number }[], tick: number): string[] {
  const per = PPQ / 4;
  return notes
    .filter((n) => {
      const start = typeof n.tick === 'number' ? n.tick : n.step * per;
      const len = typeof n.ticks === 'number' ? n.ticks : n.length * per;
      return start <= tick && tick < start + len;
    })
    .map((n) => n.id);
}

/* ── status ──────────────────────────────────────────────────────────────── */

export type StatusTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error';

/** The panel's status line: a dot, one word, and the sentence after it. */
export interface ComposeStatus {
  tone: StatusTone;
  word: string;
  message: string;
}

export const IDLE_STATUS: ComposeStatus = { tone: 'idle', word: 'Ready', message: '' };

export const busyStatus = (what: string): ComposeStatus => ({ tone: 'busy', word: 'Working', message: `${what}…` });

export const doneStatus = (message: string, flags = 0): ComposeStatus =>
  flags > 0 ? { tone: 'warn', word: 'Flagged', message } : { tone: 'ok', word: 'Done', message };

/** A failure as the status line shows it: the backend's own sentence on a
 *  422, the reason for a request the panel would not send, else the error. */
export function errorStatus(action: string, e: unknown): ComposeStatus {
  if (e instanceof ComposeInputError) return { tone: 'warn', word: 'Check', message: `${action}: ${e.message}` };
  if (e instanceof ApiError) {
    const word = e.status === 422 ? 'Refused' : e.status === 404 ? 'Missing' : 'Error';
    return { tone: 'error', word, message: `${action}: ${e.message}` };
  }
  const text = e instanceof Error ? e.message : String(e);
  return { tone: 'error', word: 'Error', message: `${action}: ${text}` };
}

/** Notes counted across parts, for a result's summary. */
export function noteCount(parts: Record<string, readonly ComposerNote[]>): number {
  return Object.values(parts).reduce((sum, notes) => sum + notes.length, 0);
}
