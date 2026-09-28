/**
 * articulationMap — what a roll note's articulation sounds as.
 *
 * A note may carry an articulation (PianoNote `articulation`): legato,
 * staccato, pizzicato, tremolo, marcato, spiccato, col legno, harmonics or con
 * sordino; a note with none plays ordinario. Where the part plays decides how
 * the articulation is heard:
 *
 *   - SOUNDFONT: an articulation a General MIDI bank holds as a preset of its
 *     own plays that preset on a channel of its own, so the part's other notes
 *     keep their program: a string part's pizzicato is GM 46 Pizzicato Strings
 *     (program 45), its tremolo GM 45 Tremolo Strings (program 44), a
 *     trumpet's or trombone's con sordino GM 60 Muted Trumpet (program 59).
 *     Col legno has no GM preset; it plays the pizzicato preset, short and
 *     soft, the nearest struck string sound the bank has. Every other
 *     articulation stays on the part's own channel and program.
 *   - VST3: an orchestral library switches articulations itself, with a
 *     keyswitch note sent just before the note, or a controller. The default
 *     keyswitches are theDAW's own layout, one per articulation from C0 (MIDI
 *     12) up (DEFAULT_VST3_KEYSWITCHES); a part whose library speaks
 *     Spitfire's UACC sends CC 32 with the UACC value instead, for the four
 *     values checked against Spitfire's published list (long 1, tremolo 11,
 *     marcato 52, pizzicato 56), and the keyswitch for the rest.
 *
 * On both, every articulation also shapes the note as it is played
 * (ARTICULATION_SHAPES): staccato plays half its written length, spiccato a
 * third, marcato louder and a little detached, col legno short and soft,
 * legato a hair longer so it joins the next note. The written note stays as
 * written; only what sounds is shaped.
 *
 * EDIT's live MIDI (lib/editMidiScheduler clipLiveTiming), the roll's PLAY
 * (lib/rollPartPlay) and a clip's soundfont render (lib/articulationRender)
 * all read `articulatedNotes`, so the three split the same notes onto the
 * same targets.
 *
 * Pure, so node tests load it.
 */
import { orchestraInstrument } from './orchestra';

export type Articulation =
  | 'legato'
  | 'staccato'
  | 'pizzicato'
  | 'tremolo'
  | 'marcato'
  | 'spiccato'
  | 'col-legno'
  | 'harmonics'
  | 'con-sordino';

/** Every articulation, in the order the marker lane lists them. */
export const ARTICULATIONS: readonly Articulation[] = Object.freeze([
  'legato',
  'staccato',
  'spiccato',
  'marcato',
  'pizzicato',
  'tremolo',
  'col-legno',
  'harmonics',
  'con-sordino',
]);

/** The name the lane and the menus give each. */
export const ARTICULATION_LABELS: Readonly<Record<Articulation, string>> = Object.freeze({
  legato: 'Legato',
  staccato: 'Staccato',
  spiccato: 'Spiccato',
  marcato: 'Marcato',
  pizzicato: 'Pizzicato',
  tremolo: 'Tremolo',
  'col-legno': 'Col legno',
  harmonics: 'Harmonics',
  'con-sordino': 'Con sordino',
});

/** The short mark the lane prints over a run of notes, as a score abbreviates it. */
export const ARTICULATION_MARKS: Readonly<Record<Articulation, string>> = Object.freeze({
  legato: 'leg.',
  staccato: 'stacc.',
  spiccato: 'spicc.',
  marcato: 'marc.',
  pizzicato: 'pizz.',
  tremolo: 'trem.',
  'col-legno': 'c.l.',
  harmonics: 'harm.',
  'con-sordino': 'con sord.',
});

/** Where a note without an articulation plays: ordinario (arco on a string part). */
export const ORDINARIO_MARK = 'ord.';

export const isArticulation = (v: unknown): v is Articulation => typeof v === 'string' && (ARTICULATIONS as readonly string[]).includes(v);

/** How an articulation shapes a note as it plays: its length scaled, its velocity moved. */
export interface ArticulationShape {
  lengthScale: number;
  velocityDelta: number;
}

export const ARTICULATION_SHAPES: Readonly<Record<Articulation, ArticulationShape>> = Object.freeze({
  legato: { lengthScale: 1.05, velocityDelta: 0 },
  staccato: { lengthScale: 0.5, velocityDelta: 0 },
  spiccato: { lengthScale: 0.33, velocityDelta: -4 },
  marcato: { lengthScale: 0.85, velocityDelta: 14 },
  pizzicato: { lengthScale: 1, velocityDelta: 0 },
  tremolo: { lengthScale: 1, velocityDelta: 0 },
  'col-legno': { lengthScale: 0.3, velocityDelta: -12 },
  harmonics: { lengthScale: 1, velocityDelta: -10 },
  'con-sordino': { lengthScale: 1, velocityDelta: -6 },
});

/** The instrument a part plays, as far as the map cares: its registry record, else its GM program. */
export interface ArticulationInstrument {
  instrumentId?: string | null;
  program?: number | null;
  percussion?: boolean;
}

/**
 * The instrument a clip's articulations resolve against: its roll part's
 * registry record while the clip still plays the part's program, else the
 * program it plays (`program`, the clip's effective one), else its part's.
 */
export function clipArticulationInstrument(
  clip: { sourceRollPart?: { instrumentId?: string; program: number | null } },
  program: number | undefined,
  percussion: boolean,
): ArticulationInstrument {
  const part = clip.sourceRollPart;
  const partsOwn = !!part && (program === undefined || part.program === null || part.program === program);
  return {
    ...(partsOwn && part?.instrumentId ? { instrumentId: part.instrumentId } : {}),
    program: program ?? part?.program ?? null,
    percussion,
  };
}

export type ArticulationFamily = 'strings' | 'brass' | 'woodwinds' | 'other';

/** The family a part plays in: its registry record's, else its GM program's. */
export function articulationFamily(inst: ArticulationInstrument): ArticulationFamily {
  if (inst.percussion) return 'other';
  const rec = orchestraInstrument(inst.instrumentId ?? undefined);
  if (rec) {
    if (rec.family === 'strings') return 'strings';
    if (rec.family === 'brass') return 'brass';
    if (rec.family === 'woodwinds') return 'woodwinds';
    return 'other';
  }
  const p = inst.program;
  if (typeof p !== 'number') return 'other';
  if ((p >= 40 && p <= 45) || (p >= 48 && p <= 51)) return 'strings';
  if (p >= 56 && p <= 63) return 'brass';
  if (p >= 64 && p <= 79) return 'woodwinds';
  return 'other';
}

/** A preset an articulation plays on a soundfont: its bank select and program. */
export interface SoundfontArticulationTarget {
  bank: number;
  program: number;
}

/** GM 46 Pizzicato Strings, GM 45 Tremolo Strings, GM 60 Muted Trumpet (0-based programs). */
const PIZZICATO_STRINGS = 45;
const TREMOLO_STRINGS = 44;
const MUTED_TRUMPET = 59;

/**
 * The soundfont preset `art` plays on a part of `inst`, or null when it plays
 * on the part's own channel and program (an articulation the bank has no
 * preset for, or a note with none).
 */
export function soundfontArticulationTarget(art: Articulation | undefined, inst: ArticulationInstrument): SoundfontArticulationTarget | null {
  if (!art) return null;
  const family = articulationFamily(inst);
  if (family === 'strings') {
    if (art === 'pizzicato' || art === 'col-legno') return { bank: 0, program: PIZZICATO_STRINGS };
    if (art === 'tremolo') return { bank: 0, program: TREMOLO_STRINGS };
    return null;
  }
  if (family === 'brass' && art === 'con-sordino') {
    // The trumpets and trombones mute to GM's muted trumpet; a horn's stopped sound has no preset.
    const p = inst.program ?? orchestraInstrument(inst.instrumentId ?? undefined)?.program;
    return p === 56 || p === 57 || p === 58 ? { bank: 0, program: MUTED_TRUMPET } : null;
  }
  return null;
}

/** A soundfont target's key: one channel per key. */
export const targetKey = (t: SoundfontArticulationTarget): string => `${t.bank}:${t.program}`;

/** A note as the three players read it: its pitch, place, length and velocity, and its articulation. */
export interface ArticulatedInput {
  note: number;
  step: number;
  length: number;
  velocity: number;
  articulation?: Articulation;
}

/** A note as it plays: shaped, with the soundfont target it plays on (null: the part's own channel). */
export interface ArticulatedNote<T extends ArticulatedInput> {
  note: T;
  /** The note shaped by its articulation (length and velocity); the same object when it has none. */
  played: T;
  target: SoundfontArticulationTarget | null;
  /** Index into `targets`, or -1 for the part's own channel. */
  slot: number;
}

/**
 * Each note shaped by its articulation, with the soundfont target it plays
 * on, and the part's distinct targets in the order of their first note: the
 * channels past the part's own that its articulations need.
 */
export function articulatedNotes<T extends ArticulatedInput>(
  notes: readonly T[],
  inst: ArticulationInstrument,
): { notes: ArticulatedNote<T>[]; targets: SoundfontArticulationTarget[] } {
  const targets: SoundfontArticulationTarget[] = [];
  const index = new Map<string, number>();
  const out: ArticulatedNote<T>[] = [];
  for (const n of notes) {
    const art = isArticulation(n.articulation) ? n.articulation : undefined;
    const target = inst.percussion ? null : soundfontArticulationTarget(art, inst);
    let slot = -1;
    if (target) {
      const key = targetKey(target);
      slot = index.get(key) ?? -1;
      if (slot < 0) {
        slot = targets.length;
        targets.push(target);
        index.set(key, slot);
      }
    }
    out.push({ note: n, played: art && !inst.percussion ? shapeNote(n, art) : n, target, slot });
  }
  return { notes: out, targets };
}

/** The soundfont targets a part's notes need past its own channel (articulatedNotes `targets`), counted. */
export const articulationSlotCount = (notes: readonly ArticulatedInput[], inst: ArticulationInstrument): number =>
  articulatedNotes(notes, inst).targets.length;

/**
 * `n` as its articulation plays it: its length scaled (ticks with it, so the
 * roll's tick model agrees) and its velocity moved, clamped to 1-127.
 */
export function shapeNote<T extends ArticulatedInput>(n: T, art: Articulation): T {
  const shape = ARTICULATION_SHAPES[art];
  if (shape.lengthScale === 1 && shape.velocityDelta === 0) return n;
  const ticks = (n as T & { ticks?: number }).ticks;
  return {
    ...n,
    length: n.length * shape.lengthScale,
    ...(typeof ticks === 'number' ? { ticks: Math.max(1, Math.round(ticks * shape.lengthScale)) } : {}),
    velocity: Math.max(1, Math.min(127, Math.round(n.velocity + shape.velocityDelta))),
  };
}

/* ── VST3: keyswitches and UACC ─────────────────────────────────────────── */

/** theDAW's default keyswitch layout: ordinario on C0 (MIDI 12), then each articulation a semitone up. */
export const ORDINARIO_KEYSWITCH = 12;
export const DEFAULT_VST3_KEYSWITCHES: Readonly<Record<Articulation, number>> = Object.freeze(
  Object.fromEntries(ARTICULATIONS.map((a, i) => [a, ORDINARIO_KEYSWITCH + 1 + i])) as Record<Articulation, number>,
);

/**
 * The UACC values (CC 32) checked against Spitfire's published list: 1 is a
 * generic long note (ordinario), 11 tremolo, 52 short marcato, 56 pizzicato.
 * An articulation without a checked value switches by its keyswitch.
 */
export const UACC_VALUES: Readonly<Partial<Record<Articulation | 'ordinario', number>>> = Object.freeze({
  ordinario: 1,
  tremolo: 11,
  marcato: 52,
  pizzicato: 56,
});
export const UACC_CONTROLLER = 32;

export type Vst3SwitchMode = 'keyswitch' | 'uacc';

/** How a VST3 instrument is told an articulation: a keyswitch note, or a controller change. */
export type Vst3ArticulationSwitch = { kind: 'keyswitch'; note: number } | { kind: 'cc'; controller: number; value: number };

/** The switch `art` (undefined: ordinario) sends to a VST3 instrument, by `mode`, with `keyswitches` in place of the defaults. */
export function vst3ArticulationSwitch(
  art: Articulation | undefined,
  mode: Vst3SwitchMode = 'keyswitch',
  keyswitches: Partial<Record<Articulation, number>> = {},
): Vst3ArticulationSwitch {
  if (mode === 'uacc') {
    const value = UACC_VALUES[art ?? 'ordinario'];
    if (value !== undefined) return { kind: 'cc', controller: UACC_CONTROLLER, value };
  }
  const note = art ? (keyswitches[art] ?? DEFAULT_VST3_KEYSWITCHES[art]) : ORDINARIO_KEYSWITCH;
  return { kind: 'keyswitch', note };
}

/** One event a VST3 part sends before a note to switch its articulation: a keyswitch note-on/off or a controller, at a tick. */
export interface Vst3SwitchEvent {
  tick: number;
  switch: Vst3ArticulationSwitch;
}

/**
 * The switches a VST3 part's notes need, in tick order: one where the
 * articulation changes from the one before (the part starts ordinario), `lead`
 * ticks ahead of the note so the library has switched when the note arrives.
 * With `opening`, the first note's switch goes out even when it plays
 * ordinario, so an instrument an earlier clip or pass left on pizzicato comes
 * back. A render or live feed through the part's instrument sends each (a
 * keyswitch as a one-tick note at velocity 1) ahead of the notes it precedes.
 */
export function vst3SwitchEvents(
  notes: readonly (ArticulatedInput & { tick?: number })[],
  mode: Vst3SwitchMode = 'keyswitch',
  keyswitches: Partial<Record<Articulation, number>> = {},
  lead = 1,
  ticksPerStep = 240,
  opening = false,
): Vst3SwitchEvent[] {
  const sorted = [...notes].sort((a, b) => (a.tick ?? a.step * ticksPerStep) - (b.tick ?? b.step * ticksPerStep));
  const out: Vst3SwitchEvent[] = [];
  let current: Articulation | undefined;
  let first = true;
  for (const n of sorted) {
    const art = isArticulation(n.articulation) ? n.articulation : undefined;
    if (!first && art === current) continue;
    if (first && !art && !opening) {
      first = false;
      continue;
    }
    first = false;
    current = art;
    const tick = Math.max(0, Math.round(n.tick ?? n.step * ticksPerStep) - lead);
    out.push({ tick, switch: vst3ArticulationSwitch(art, mode, keyswitches) });
  }
  return out;
}

export const isVst3SwitchMode = (v: unknown): v is Vst3SwitchMode => v === 'keyswitch' || v === 'uacc';

/**
 * How a track whose instrument slot holds a VST3 plays its notes'
 * articulations: every note on the channels its lanes give it (a VST3
 * instrument has no General MIDI preset for a channel of its own to play), and
 * a switch by `mode` where the articulation changes. `opening`: the track's
 * notes use articulations, so each clip opens with its first note's switch.
 */
export interface Vst3Articulations {
  mode: Vst3SwitchMode;
  keyswitches?: Partial<Record<Articulation, number>>;
  opening: boolean;
}

/** True when any of `notes` carries an articulation the map knows. */
export const usesArticulations = (notes: readonly { articulation?: unknown }[]): boolean => notes.some((n) => isArticulation(n.articulation));

/* ── The marker lane ────────────────────────────────────────────────────── */

/** One run of a part's notes with one articulation (null: ordinario), from its first onset to its last note's end. */
export interface ArticulationRun {
  articulation: Articulation | null;
  startStep: number;
  endStep: number;
  ids: string[];
}

/**
 * A part's notes as the marker lane shows them: in onset order, each run of
 * notes that share an articulation one marker, as a score writes "pizz." once
 * over a passage and "arco" where it ends. Chords count once per onset.
 */
export function articulationRuns(notes: readonly (ArticulatedInput & { id: string })[]): ArticulationRun[] {
  const sorted = [...notes].sort((a, b) => a.step - b.step || a.note - b.note);
  const runs: ArticulationRun[] = [];
  for (const n of sorted) {
    const art = isArticulation(n.articulation) ? n.articulation : null;
    const last = runs[runs.length - 1];
    if (last && last.articulation === art) {
      last.ids.push(n.id);
      last.endStep = Math.max(last.endStep, n.step + n.length);
      continue;
    }
    runs.push({ articulation: art, startStep: n.step, endStep: n.step + n.length, ids: [n.id] });
  }
  return runs;
}
