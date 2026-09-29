/**
 * rollComposer — the composer routes' answers (lib/composerClient) as piano
 * roll parts, and the roll's parts as the questions the routes take.
 *
 * Pure: the store (pianoRollStore) calls these and writes what they return.
 *
 *   - checkPick: which parts a voice-leading check reads, under which names,
 *     with each part's range from the orchestra registry.
 *   - flagNoteIds: the notes a flag is about, part by part.
 *   - planPartWrites / continuoPartWrites / counterpointPartWrites /
 *     formMovementWrite: an answer's voices as named part writes, with the
 *     roman figures the harmony row shows.
 *   - figuredBassLine: a part's notes and figures as the continuo route's bass.
 *
 * A composer note is `{note, tick, ticks}` at the roll's own 960 PPQ, so a
 * note goes in and comes back on the roll's clock unchanged.
 */
import type { FiguredBassMark, PianoNote, RollTrack } from '../state/pianoRollStore';
import type {
  CanonResult,
  ComposerNote,
  ComposerPart,
  ContinuoResult,
  FiguredBassNote,
  FormResult,
  FugueResult,
  PartRanges,
  PlanResult,
  SpeciesResult,
  VoiceLeadingFlag,
} from './composerClient';
import type { MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { guessInstrument, normalizeName, orchestraInstrument, type OrchestraInstrument } from './orchestra';
import type { RollMarkerInput } from './rollMarkers';
import { parseRollKey, type RollKey } from './rollKey';
import { PERCUSSION_PART_CHANNEL } from './rollTracks';
import type { TempoEvent } from './tempoMap';

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/** The four SATB voices, top first, as the composer routes name them. */
export const SATB: readonly ComposerPart[] = Object.freeze(['soprano', 'alto', 'tenor', 'bass']);

/** The roll part name each SATB voice writes into. */
export const SATB_PART_NAMES: Readonly<Record<ComposerPart, string>> = Object.freeze({
  soprano: 'Soprano',
  alto: 'Alto',
  tenor: 'Tenor',
  bass: 'Bass',
});

/** The orchestra registry voice each SATB voice sings: its range and its sound. */
const SATB_INSTRUMENT: Readonly<Record<ComposerPart, string>> = Object.freeze({
  soprano: 'soprano',
  alto: 'alto',
  tenor: 'tenor',
  bass: 'bass-voice',
});

/**
 * A roll part's SATB voice when its name is one ("Soprano", "Alto 2",
 * "Bass voice", "tenor"), else null. "Bass Clarinet" is a clarinet.
 */
export function satbRoleOf(name: string): ComposerPart | null {
  const m = /^(soprano|alto|tenor|bass)(?: voice)?(?: \d+)?$/.exec(normalizeName(name));
  return m ? (m[1] as ComposerPart) : null;
}

/** The registry record whose range a part keeps: its instrument, its SATB voice, or the one its name names. */
export function partInstrument(t: Pick<RollTrack, 'name' | 'instrumentId'>): OrchestraInstrument | undefined {
  const own = orchestraInstrument(t.instrumentId);
  if (own) return own;
  const role = satbRoleOf(t.name);
  return role ? orchestraInstrument(SATB_INSTRUMENT[role]) : guessInstrument(t.name);
}

/** A part's practical range as MIDI notes, from the registry; null for a part the registry does not know or a kit. */
export function partRange(t: Pick<RollTrack, 'name' | 'instrumentId'>): [number, number] | null {
  const inst = partInstrument(t);
  return inst && !inst.percussion && inst.kitPitch == null ? [inst.rangeLow, inst.rangeHigh] : null;
}

const isPercussion = (t: Pick<RollTrack, 'channel'>): boolean => t.channel === PERCUSSION_PART_CHANNEL;

/** The mean pitch of a part's notes, each weighted by its length. */
const meanPitch = (notes: readonly PianoNote[]): number => {
  let sum = 0;
  let w = 0;
  for (const n of notes) {
    const len = Math.max(1, n.ticks ?? n.length * TICKS_PER_STEP);
    sum += n.note * len;
    w += len;
  }
  return w > 0 ? sum / w : 0;
};

/** The parts a voice-leading check reads, and how its answer maps back onto the roll. */
export interface CheckPick {
  /** The names the check knows the parts by, top voice first. */
  order: string[];
  /** The roll part each name stands for. */
  ids: Record<string, string>;
  /** Each name's notes. */
  parts: Record<string, PianoNote[]>;
  /** Each name's range from the orchestra registry, where the registry knows the part. */
  ranges: PartRanges;
}

/** At most this many parts go into one check: four-part writing. */
export const CHECK_MAX_PARTS = 4;

/**
 * The parts a voice-leading check reads, from `tracks` (every part with its
 * real notes: pianoRollStore rollTracksOf). With `partIds` (two or more),
 * those parts. Otherwise the parts named for SATB voices ("Soprano", "Alto",
 * "Tenor", "Bass") when two or more are, under their voice names, so the
 * checker applies its spacing between upper voices. Otherwise the four
 * highest parts by mean pitch. Parts without notes and drum parts never go
 * in. Null when fewer than two parts are left.
 */
export function checkPick(tracks: readonly RollTrack[], partIds?: readonly string[]): CheckPick | null {
  const eligible = tracks.filter((t) => t.notes.length > 0 && !isPercussion(t));
  let chosen: Array<{ name: string; track: RollTrack }>;
  const wanted = partIds && partIds.length >= 2 ? new Set(partIds) : null;
  const roles = new Map<ComposerPart, RollTrack>();
  for (const t of eligible) {
    const role = satbRoleOf(t.name);
    if (role && !roles.has(role)) roles.set(role, t);
  }
  if (wanted) {
    chosen = eligible
      .filter((t) => wanted.has(t.id))
      .sort((a, b) => meanPitch(b.notes) - meanPitch(a.notes))
      .map((t) => ({ name: t.name, track: t }));
  } else if (roles.size >= 2) {
    chosen = SATB.filter((r) => roles.has(r)).map((r) => ({ name: r, track: roles.get(r) as RollTrack }));
  } else {
    chosen = eligible
      .map((t) => ({ t, mean: meanPitch(t.notes) }))
      .sort((a, b) => b.mean - a.mean)
      .slice(0, CHECK_MAX_PARTS)
      .map(({ t }) => ({ name: t.name, track: t }));
  }
  if (chosen.length < 2) return null;
  // Two parts with one name: the later is "name 2", so every part has a key of its own.
  const taken = new Set<string>();
  const pick: CheckPick = { order: [], ids: {}, parts: {}, ranges: {} };
  for (const { name, track } of chosen) {
    let key = name;
    for (let n = 2; taken.has(key); n += 1) key = `${name} ${n}`;
    taken.add(key);
    pick.order.push(key);
    pick.ids[key] = track.id;
    pick.parts[key] = track.notes;
    const range = partRange(track);
    if (range) pick.ranges[key] = range;
  }
  return pick;
}

/** The ticks a roll note spans, from its own ticks or its steps. */
const spanOf = (n: PianoNote): { tick: number; end: number } => {
  const tick = n.tick ?? Math.round(n.step * TICKS_PER_STEP);
  return { tick, end: tick + Math.max(1, n.ticks ?? Math.round(n.length * TICKS_PER_STEP)) };
};

/**
 * The notes a flag is about, by roll part id: each of the flag's parts' notes
 * that sound at the flag's tick. A parallel's second chord starts there, so
 * the notes that make it are the ones under the flag.
 */
export function flagNoteIds(flag: Pick<VoiceLeadingFlag, 'tick' | 'parts'>, ids: Readonly<Record<string, string>>, tracks: readonly RollTrack[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of flag.parts) {
    const id = ids[name];
    const track = id ? tracks.find((t) => t.id === id) : undefined;
    if (!track) continue;
    const hit = track.notes.filter((n) => {
      const s = spanOf(n);
      return s.tick <= flag.tick && flag.tick < s.end;
    });
    if (hit.length) out.set(track.id, [...(out.get(track.id) ?? []), ...hit.map((n) => n.id)]);
  }
  return out;
}

let noteSerial = 0;

/** Composer notes as roll notes: each at its tick with its length, at `velocity` when it has none, with a new id. */
export function composerNotesToRoll(notes: readonly ComposerNote[], idPrefix: string, velocity = 80): PianoNote[] {
  return notes.map((n) => {
    const tick = Math.max(0, Math.round(n.tick));
    const ticks = Math.max(1, Math.round(n.ticks));
    noteSerial += 1;
    return {
      id: `${idPrefix}-${noteSerial.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      note: Math.max(0, Math.min(127, Math.round(n.note))),
      tick,
      ticks,
      step: tick / TICKS_PER_STEP,
      length: ticks / TICKS_PER_STEP,
      velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? velocity))),
    };
  });
}

/** One voice of an answer, to go into the roll part named `name`. */
export interface PartWrite {
  /** The answer's own name for the voice ('soprano', 'counterpoint', 'cantus'), which its flags name it by. */
  voice: string;
  name: string;
  notes: PianoNote[];
  /** The registry instrument a part made for this write takes (a part that exists keeps its own). */
  instrumentId?: string;
  /** This voice is the cantus firmus: it goes into the part marked as the cantus firmus when there is one. */
  cantus?: boolean;
}

/** A roman figure the harmony row shows, at its tick. */
export interface RollChordLabel {
  tick: number;
  figure: string;
  /** The local key, when the answer names it: 'C major'. */
  key?: string;
  /** A song chord's roman figure in `key` ('iv'), when the figure is a chord symbol (lib/songSections). */
  roman?: string;
}

/** An answer's voices as part writes, its figures and flags, and the key it was written in. */
export interface ComposerWrite {
  writes: PartWrite[];
  chords: RollChordLabel[];
  flags: VoiceLeadingFlag[];
  key: RollKey | null;
}

const satbWrites = (parts: Partial<Record<ComposerPart, ComposerNote[]>>, prefix: string, only: readonly ComposerPart[] = SATB): PartWrite[] =>
  only
    .filter((p) => parts[p])
    .map((p) => ({ voice: p, name: SATB_PART_NAMES[p], notes: composerNotesToRoll(parts[p] ?? [], `${prefix}-${p}`), instrumentId: SATB_INSTRUMENT[p] }));

/** A plan's four voices as the Soprano, Alto, Tenor and Bass parts, with its roman figures and its key. */
export function planPartWrites(plan: PlanResult): ComposerWrite {
  return {
    writes: satbWrites(plan.parts, 'plan'),
    chords: plan.chords.map((c) => ({ tick: c.tick, figure: c.figure, key: c.key })),
    flags: plan.flags ?? [],
    key: parseRollKey(plan.key),
  };
}

/**
 * A realized figured bass's upper three voices as the Soprano, Alto and Tenor
 * parts (the bass is the part the figures were written under, which keeps its
 * notes), with the roman numeral read in each chord (its figure when none was
 * read) and the flags.
 */
export function continuoPartWrites(result: ContinuoResult): ComposerWrite {
  return {
    writes: satbWrites(result.parts, 'continuo', ['soprano', 'alto', 'tenor']),
    chords: result.chords.map((c) => ({ tick: c.tick, figure: c.roman ?? c.figure })),
    flags: result.flags ?? [],
    key: parseRollKey(result.key),
  };
}

/** A voice name of an answer as a part name: 'soprano' is "Soprano", 'cantus' is "Cantus firmus", 'voice_2' is "Voice 2". */
export function voicePartName(voice: string): string {
  if (voice === 'cantus') return 'Cantus firmus';
  const text = voice.replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Voice';
}

/** Which of the three counterpoint answers a result is. */
export type CounterpointResult = SpeciesResult | CanonResult | FugueResult;

export const isSpeciesResult = (r: CounterpointResult): r is SpeciesResult => 'species' in r && 'position' in r;
export const isCanonResult = (r: CounterpointResult): r is CanonResult => 'canonic_until' in r;
export const isFugueResult = (r: CounterpointResult): r is FugueResult => 'entries' in r && 'voices' in r;

/**
 * A species, canon or fugue answer's voices as part writes, top voice first,
 * each named after its voice (voicePartName). A species answer's cantus is
 * marked `cantus`, so it goes back into the part marked as the cantus firmus.
 * A voice with an SATB name ("soprano" in a fugue) sings in the registry's
 * voice of that name when its part is new.
 */
export function counterpointPartWrites(result: CounterpointResult): ComposerWrite {
  const parts = result.parts as Record<string, ComposerNote[] | undefined>;
  const order = isFugueResult(result) ? result.voices : result.order;
  const names = [...order, ...Object.keys(parts).filter((k) => !order.includes(k))];
  const prefix = isSpeciesResult(result) ? 'species' : isCanonResult(result) ? 'canon' : 'fugue';
  const writes: PartWrite[] = names
    .filter((v) => parts[v])
    .map((v) => {
      const role = satbRoleOf(v);
      return {
        voice: v,
        name: voicePartName(v),
        notes: composerNotesToRoll(parts[v] ?? [], `${prefix}-${v}`),
        ...(role ? { instrumentId: SATB_INSTRUMENT[role] } : {}),
        ...(isSpeciesResult(result) && v === 'cantus' ? { cantus: true } : {}),
      };
    });
  // A species answer's suspensions, figured where they fall: 7-6, 4-3, 9-8, 2-3.
  const chords: RollChordLabel[] = isSpeciesResult(result)
    ? result.suspensions.filter((x) => x.figure).map((x) => ({ tick: x.tick, figure: x.figure as string }))
    : [];
  return { writes, chords, flags: result.flags ?? [], key: parseRollKey(result.key) };
}

/** A realized form movement as the roll takes it: its voices, meter, tempo, sections and figures. */
export interface FormMovementWrite extends ComposerWrite {
  meterMap: MeterSegment[];
  tempoMap: TempoEvent[];
  /** The movement's title as a movement marker at its start, then each section's label at its start, all FORM's own. */
  markers: RollMarkerInput[];
  /** The tempo the movement starts at. */
  bpm: number;
}

/**
 * Movement `index` of a realized form (composerApi realizeForm) as the roll
 * takes it: each section's SATB voices joined into the four parts, the
 * movement's meter map and tempo map, a movement marker with its title and a
 * section marker per section, all with FORM's origin, and every section's
 * roman figures and flags. Null for a movement the form does not have or one
 * that was planned but not realized (no voices).
 */
export function formMovementWrite(form: FormResult, index = 0): FormMovementWrite | null {
  const mv = form.movements[index];
  if (!mv || !mv.sections.some((s) => s.parts)) return null;
  const joined: Record<ComposerPart, ComposerNote[]> = { soprano: [], alto: [], tenor: [], bass: [] };
  const chords: RollChordLabel[] = [];
  const flags: VoiceLeadingFlag[] = [];
  for (const s of mv.sections) {
    for (const p of SATB) joined[p].push(...(s.parts?.[p] ?? []));
    chords.push(...s.chords.map((c) => ({ tick: c.tick, figure: c.figure, key: c.key })));
    flags.push(...(s.flags ?? []));
  }
  for (const p of SATB) joined[p].sort((a, b) => a.tick - b.tick);
  const markers: RollMarkerInput[] = [
    { tick: 0, name: mv.title, kind: 'movement', origin: 'form' },
    ...mv.sections.map((s) => ({ tick: s.start_tick, name: s.label, kind: 'section' as const, origin: 'form' as const })),
  ];
  const tempoMap: TempoEvent[] = mv.tempo_map.map((e) => ({ beat: e.beat, bpm: e.bpm, curve: 'step' }));
  return {
    writes: satbWrites(joined, `form${index}`),
    chords: chords.sort((a, b) => a.tick - b.tick),
    flags,
    key: parseRollKey(mv.key),
    meterMap: mv.meter_map.map((s) => ({ bar: s.bar, meter: { num: s.meter.num, den: s.meter.den, groups: [...(s.meter.groups ?? [])] } })),
    tempoMap,
    markers,
    bpm: mv.tempo_map.find((e) => e.beat === 0)?.bpm ?? mv.tempo.bpm,
  };
}

/**
 * A part's notes and figures as the continuo route's bass: one note at a time
 * (the lowest of each onset, cut short where the next onset starts), each with
 * the figure written at its tick (blank when none is).
 */
export function figuredBassLine(notes: readonly PianoNote[], marks: readonly FiguredBassMark[] | undefined): FiguredBassNote[] {
  const byTick = new Map((marks ?? []).map((m) => [m.tick, m.figure]));
  const lowest = new Map<number, { note: number; end: number }>();
  for (const n of notes) {
    const s = spanOf(n);
    const at = lowest.get(s.tick);
    if (!at || n.note < at.note) lowest.set(s.tick, { note: n.note, end: s.end });
  }
  const ticks = [...lowest.keys()].sort((a, b) => a - b);
  return ticks.map((tick, i) => {
    const n = lowest.get(tick) as { note: number; end: number };
    const next = ticks[i + 1];
    const end = next !== undefined ? Math.min(n.end, next) : n.end;
    return { note: n.note, tick, ticks: Math.max(1, end - tick), figure: byTick.get(tick) ?? '' };
  });
}

/** The bass line's onsets: the ticks the figured-bass lane takes a figure at. */
export const figureTicks = (notes: readonly PianoNote[]): number[] => [...new Set(notes.map((n) => spanOf(n).tick))].sort((a, b) => a - b);
