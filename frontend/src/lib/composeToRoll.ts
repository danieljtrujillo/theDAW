/**
 * composeToRoll — where the COMPOSE panel's answers go into the piano roll,
 * and what it reads back out of it.
 *
 * The panel and the assistant's composer tools call only this module, and
 * each write is the roll store's own composer action of the same job, one
 * undo step each: `writePlan` is `writePlanToRoll`, `writeCounterpoint`,
 * `writeFormMovement`, `runVoiceLeadingCheck` and `selectFlagNotes` are their
 * namesakes (state/pianoRollStore.ts). The flags a check or a write comes back
 * with live in the store's `voiceLeading`, so the panel's CHECK list and the
 * roll's harmony row show the same flags.
 *
 * What the panel sends reads the roll through `rollComposeContext` (its key,
 * meter map, pickup and SATB ranges) and `cantusFirmusOf` (the part marked as
 * the cantus firmus). `writePartsToRoll` writes parts by name for a caller
 * with no composer answer.
 *
 * Notes come from the backend as `{note, tick, ticks}` at the roll's own PPQ
 * (960), so they go in at the tick they were written on; the store derives
 * their steps.
 */
import type {
  CanonResult,
  CheckResult,
  ComposerNote,
  FormResult,
  FugueResult,
  KeyMode,
  NoteLike,
  PlanResult,
  SpeciesResult,
  VoiceLeadingFlag,
} from './composerClient';
import type { MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { TONICS } from './composerPanelModel';
import { parseRollKey, tonicPitchClass } from './rollKey';
import {
  cantusFirmusOf,
  rollComposeContext,
  rollTracksOf,
  usePianoRollStore,
  type PianoNote,
  type RollComposeContext,
  type RollTrack,
  type RollWriteResult,
} from '../state/pianoRollStore';

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;
const DEFAULT_VELOCITY = 80;

/** One part of an answer, named as the roll will show it. */
export interface ComposedPart {
  name: string;
  notes: readonly ComposerNote[];
}

/** What a write did: the parts it wrote (names and ids, the answer's order), how many notes, and whether it became the roll. */
export interface RollWrite {
  parts: string[];
  /** The ids of the parts written, in the same order as `parts`. */
  partIds: string[];
  notes: number;
  /** True when the roll held no notes before the write, so the answer is the roll. */
  replaced: boolean;
  /** Parts the write made (the rest existed and had their notes replaced). */
  created: number;
  /** Voices left out because the roll already held its most parts. */
  skipped: number;
}

/** 'soprano' as 'Soprano': the name a part gets in the roll. */
export function partTitle(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

let noteSeq = 0;
const noteId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cmp-${Date.now().toString(36)}-${(noteSeq++).toString(36)}`;

/** A composer note as a roll note, at its own tick. */
export function toPianoNote(n: ComposerNote): PianoNote {
  const tick = Math.max(0, Math.round(n.tick));
  const ticks = Math.max(1, Math.round(n.ticks));
  return {
    id: noteId(),
    note: Math.max(0, Math.min(127, Math.round(n.note))),
    tick,
    ticks,
    step: tick / TICKS_PER_STEP,
    length: ticks / TICKS_PER_STEP,
    velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? DEFAULT_VELOCITY))),
  };
}

const lastStep = (parts: readonly ComposedPart[]): number =>
  parts.reduce((m, p) => p.notes.reduce((mm, n) => Math.max(mm, (n.tick + n.ticks) / TICKS_PER_STEP), m), 0);

const rollIsEmpty = (): boolean => rollTracksOf(usePianoRollStore.getState()).every((t) => t.notes.length === 0);

/** A store write's result as the panel reports it: the written parts' names and note counts after the write. */
function reportWrite(done: RollWriteResult, replaced: boolean): RollWrite {
  const tracks = rollTracksOf(usePianoRollStore.getState());
  const written = done.partIds.map((id) => tracks.find((t) => t.id === id)).filter((t): t is RollTrack => !!t);
  return {
    parts: written.map((t) => t.name),
    partIds: written.map((t) => t.id),
    notes: written.reduce((sum, t) => sum + t.notes.length, 0),
    replaced,
    created: done.created,
    skipped: done.skipped,
  };
}

/**
 * Write parts into the roll by name. On a roll with no notes the parts become
 * the roll (one undo step, taking `meterMap` when given). Otherwise each part
 * replaces the notes of the roll part with its name, or is added after the
 * others; the rest of the roll stays. The first part written is left active.
 */
export function writePartsToRoll(parts: readonly ComposedPart[], opts: { meterMap?: readonly MeterSegment[] } = {}): RollWrite {
  const store = usePianoRollStore.getState();
  const tracks = rollTracksOf(store);
  const count = parts.reduce((sum, p) => sum + p.notes.length, 0);
  const names = parts.map((p) => partTitle(p.name));
  if (tracks.every((t) => t.notes.length === 0)) {
    store.importParts(
      parts.map((p, i) => ({ name: names[i], notes: p.notes.map(toPianoNote) })),
      undefined,
      opts.meterMap && opts.meterMap.length ? { meterMap: opts.meterMap.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...(s.meter.groups ?? [])] } })) } : undefined,
    );
    const ids = rollTracksOf(usePianoRollStore.getState()).map((t) => t.id);
    return { parts: names, partIds: ids, notes: count, replaced: true, created: names.length, skipped: 0 };
  }
  const ids: string[] = [];
  let created = 0;
  parts.forEach((p, i) => {
    const s = usePianoRollStore.getState();
    const name = names[i];
    const notes = p.notes.map(toPianoNote);
    const found = rollTracksOf(s).find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    let id: string | null;
    if (found) {
      s.setPartNotes(found.id, notes);
      id = found.id;
    } else {
      id = s.addTrack({ name, notes });
      if (id) created += 1;
    }
    if (id) ids.push(id);
  });
  const after = usePianoRollStore.getState();
  if (ids[0]) after.setActiveTrack(ids[0]);
  const needed = Math.ceil(lastStep(parts));
  if (needed > after.totalSteps) after.setTotalSteps(needed);
  return { parts: names, partIds: ids, notes: count, replaced: false, created, skipped: parts.length - ids.length };
}

/**
 * A four-part plan (SATB) into the parts named Soprano, Alto, Tenor and Bass
 * (pianoRollStore writePlanToRoll): the roll takes its key, and the harmony
 * row its roman figures and flags. One undo step.
 */
export function writePlan(plan: PlanResult): RollWrite {
  const replaced = rollIsEmpty();
  return reportWrite(usePianoRollStore.getState().writePlanToRoll(plan), replaced);
}

/**
 * A species line with its cantus, a canon or a fugue exposition into the roll
 * (pianoRollStore writeCounterpoint), top voice first; a species cantus goes
 * back into the part marked as the cantus firmus. One undo step.
 */
export function writeCounterpoint(result: SpeciesResult | CanonResult | FugueResult): RollWrite {
  const replaced = rollIsEmpty();
  return reportWrite(usePianoRollStore.getState().writeCounterpoint(result), replaced);
}

/**
 * Movement `movementIndex` of a realized form into the roll (pianoRollStore
 * writeFormMovement): its soprano, alto, tenor and bass, its meter map, tempo
 * map, key and a marker at each section. One undo step. Throws for a movement
 * the form did not realize.
 */
export function writeFormMovement(form: FormResult, movementIndex = 0): RollWrite {
  const replaced = rollIsEmpty();
  const done = usePianoRollStore.getState().writeFormMovement(form, movementIndex);
  if (!done) throw new Error('the movement has no notes: plan it with REALIZE, not PLAN');
  return reportWrite(done, replaced);
}

/* ── reading the roll ────────────────────────────────────────────────────── */

/** A roll part as the panel's pickers list it. */
export interface RollPartOption {
  id: string;
  name: string;
  notes: number;
}

export function rollPartOptions(): RollPartOption[] {
  return rollTracksOf(usePianoRollStore.getState()).map((t) => ({ id: t.id, name: t.name, notes: t.notes.length }));
}

/** The part being edited, which "the selected part" names in the panel. */
export function activeRollPartId(): string {
  return usePianoRollStore.getState().activeTrackId;
}

const noteLikes = (t: RollTrack): NoteLike[] => t.notes.map((n) => ({ note: n.note, tick: n.tick, ticks: n.ticks, step: n.step, length: n.length }));

/** A part's notes as the composer reads them (`tick`/`ticks` when they have them). */
export function rollPartNotes(id: string): NoteLike[] {
  const track = rollTracksOf(usePianoRollStore.getState()).find((t) => t.id === id);
  return track ? noteLikes(track) : [];
}

/** The part a species request takes as its cantus when "the selected part" is picked: the part marked as the cantus firmus, else the part being edited. */
export function speciesCantusPart(): { id: string; name: string; marked: boolean } {
  const s = usePianoRollStore.getState();
  const marked = cantusFirmusOf(s);
  if (marked) return { id: marked.id, name: marked.name, marked: true };
  const active = rollTracksOf(s).find((t) => t.id === s.activeTrackId);
  return { id: s.activeTrackId, name: active?.name ?? '', marked: false };
}

/** The notes of speciesCantusPart, as a species request sends them. */
export function speciesCantusNotes(): NoteLike[] {
  return rollPartNotes(speciesCantusPart().id);
}

/** The roll as a request reads it: its meter map and pickup, and the ranges of its SATB parts. */
export function rollRequestContext(): RollComposeContext {
  return rollComposeContext(usePianoRollStore.getState());
}

/**
 * The roll's key (rollComposeContext) as the panel's Key and Mode pickers name
 * it: its tonic spelled as one of the panel's TONICS, and its mode.
 */
export function rollKeyForPanel(): { key: string; mode: KeyMode } {
  const k = rollRequestContext().key;
  const pc = tonicPitchClass(k.tonic);
  const key = TONICS.includes(k.tonic) ? k.tonic : TONICS.find((t) => tonicPitchClass(t) === pc) ?? 'C';
  return { key, mode: k.mode };
}

export interface CheckOutcome extends CheckResult {
  /** Roll part ids by the names the flags use. */
  idByName: Record<string, string>;
}

/**
 * The voice-leading check (pianoRollStore runVoiceLeadingCheck): the roll's
 * SATB parts (else its four highest), in the roll's key or in `key`/`mode`
 * when given. The flags land in the store's `voiceLeading`, which the harmony
 * row and the panel's CHECK list both show.
 */
export async function runVoiceLeadingCheck(opts: { key?: string; mode?: KeyMode; partIds?: readonly string[] } = {}): Promise<CheckOutcome> {
  const key = opts.key ? parseRollKey(`${opts.key}${opts.mode ? ` ${opts.mode}` : ''}`) : null;
  const store = usePianoRollStore.getState();
  const result = await store.runVoiceLeadingCheck({ ...(key ? { key } : {}), ...(opts.partIds ? { partIds: opts.partIds } : {}) });
  return { ...result, idByName: { ...(usePianoRollStore.getState().voiceLeading?.ids ?? {}) } };
}

/**
 * Select the notes a flag of the roll's last voice-leading answer names
 * (pianoRollStore selectFlagNotes): the part being edited when it is one of
 * the flag's parts, else the first; the playhead goes to the flag. Returns how
 * many were selected.
 */
export function selectFlagNotes(flag: VoiceLeadingFlag): number {
  return usePianoRollStore.getState().selectFlagNotes(flag);
}
