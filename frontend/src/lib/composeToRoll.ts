/**
 * composeToRoll — where the COMPOSE panel's answers go into the piano roll,
 * and what it reads back out of it.
 *
 * The panel and the assistant's composer tools call only this module. For now
 * it writes through the roll store's existing public actions: `importParts`
 * for an empty roll or a whole movement, `setPartNotes` / `addTrack` for a
 * part by name, `setSelection` for a flag's notes. AT MERGE this moves onto
 * the roll's own composer actions (plan-to-roll, `writeCounterpoint(result)`,
 * `writeFormMovement(movement)`, `runVoiceLeadingCheck()`), which the roll's
 * owner is adding to state/pianoRollStore.ts: each function below then becomes
 * a call to its namesake there, and the panel does not change.
 *
 * Notes come from the backend as `{note, tick, ticks}` at the roll's own PPQ
 * (960), so they go in at the tick they were written on; the store derives
 * their steps.
 */
import {
  composerApi,
  type CanonResult,
  type CheckResult,
  type ComposerNote,
  type FormMovement,
  type FugueResult,
  type KeyMode,
  type NoteLike,
  type PlanResult,
  type SpeciesResult,
  type VoiceLeadingFlag,
} from './composerClient';
import type { MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import type { RollMarkerInput } from './rollMarkers';
import type { TempoEvent } from './tempoMap';
import { notesSoundingAt } from './composerPanelModel';
import { rollTracksOf, usePianoRollStore, type PianoNote, type RollTrack } from '../state/pianoRollStore';

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;
const DEFAULT_VELOCITY = 80;

/** One part of an answer, named as the roll will show it. */
export interface ComposedPart {
  name: string;
  notes: readonly ComposerNote[];
}

/** What a write did: the parts it wrote, how many notes, and whether it replaced the roll. */
export interface RollWrite {
  parts: string[];
  notes: number;
  replaced: boolean;
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
    return { parts: names, notes: count, replaced: true };
  }
  let first: string | null = null;
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
    }
    if (first === null && id) first = id;
  });
  const after = usePianoRollStore.getState();
  if (first) after.setActiveTrack(first);
  const needed = Math.ceil(lastStep(parts));
  if (needed > after.totalSteps) after.setTotalSteps(needed);
  return { parts: names, notes: count, replaced: false };
}

/** A four-part plan (SATB) into the roll, on the meter it was planned on. */
export function writePlan(plan: PlanResult): RollWrite {
  const order = ['soprano', 'alto', 'tenor', 'bass'] as const;
  return writePartsToRoll(
    order.map((name) => ({ name, notes: plan.parts[name] ?? [] })),
    { meterMap: plan.meter_map },
  );
}

/** 4/4, the bar the counterpoint engines write in. */
const COMMON_TIME: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }];

/** A species line with its cantus, a canon or a fugue exposition into the roll, top voice first. */
export function writeCounterpoint(result: SpeciesResult | CanonResult | FugueResult): RollWrite {
  const parts = result.parts as Record<string, ComposerNote[]>;
  // A species line and a canon name their voices in `order`, a fugue in `voices`; both top first.
  const order = 'order' in result ? result.order : result.voices;
  return writePartsToRoll(
    order.filter((name) => parts[name]).map((name) => ({ name, notes: parts[name] })),
    { meterMap: COMMON_TIME },
  );
}

/** The movement's tempo changes as the roll's tempo map (beats are quarters from its start). */
const tempoEvents = (movement: FormMovement): TempoEvent[] =>
  movement.tempo_map.map((e) => ({ beat: e.beat, bpm: e.bpm, curve: 'step' }));

/**
 * A realized movement into the roll: it replaces the roll's parts with its
 * soprano, alto, tenor and bass, and takes its meter map, tempo map and a
 * marker at each section. One undo step.
 */
export function writeFormMovement(movement: FormMovement): RollWrite {
  const order = ['soprano', 'alto', 'tenor', 'bass'] as const;
  const parts: ComposedPart[] = order.map((name) => ({
    name,
    notes: movement.sections.flatMap((s) => s.parts?.[name] ?? []),
  }));
  const count = parts.reduce((sum, p) => sum + p.notes.length, 0);
  if (count === 0) throw new Error('the movement has no notes: plan it with REALIZE, not PLAN');
  const markers: RollMarkerInput[] = [
    { tick: 0, name: movement.title, kind: 'movement' },
    ...movement.sections.map((s) => ({ tick: s.start_tick, name: s.label, kind: 'section' as const })),
  ];
  usePianoRollStore.getState().importParts(
    parts.map((p) => ({ name: partTitle(p.name), notes: p.notes.map(toPianoNote) })),
    movement.tempo.bpm,
    { meterMap: movement.meter_map.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...(s.meter.groups ?? [])] } })), pickupSteps: 0 },
    undefined,
    tempoEvents(movement),
    0,
    markers,
  );
  return { parts: parts.map((p) => partTitle(p.name)), notes: count, replaced: true };
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

/** A part's notes as the composer reads them (`tick`/`ticks` when they have them). */
export function rollPartNotes(id: string): NoteLike[] {
  const track = rollTracksOf(usePianoRollStore.getState()).find((t) => t.id === id);
  return track ? track.notes.map((n) => ({ note: n.note, tick: n.tick, ticks: n.ticks, step: n.step, length: n.length })) : [];
}

const meanPitch = (t: RollTrack): number => (t.notes.length ? t.notes.reduce((s, n) => s + n.note, 0) / t.notes.length : 0);

/** Every roll part with notes, under a name unique among them, top voice first. */
export function rollPartsForCheck(): { parts: Record<string, NoteLike[]>; order: string[]; idByName: Record<string, string> } {
  const tracks = rollTracksOf(usePianoRollStore.getState())
    .filter((t) => t.notes.length > 0)
    .sort((a, b) => meanPitch(b) - meanPitch(a));
  const parts: Record<string, NoteLike[]> = {};
  const idByName: Record<string, string> = {};
  const order: string[] = [];
  for (const t of tracks) {
    let name = t.name.trim() || 'Part';
    for (let k = 2; name in parts; k += 1) name = `${t.name.trim() || 'Part'} ${k}`;
    parts[name] = t.notes.map((n) => ({ note: n.note, tick: n.tick, ticks: n.ticks, step: n.step, length: n.length }));
    idByName[name] = t.id;
    order.push(name);
  }
  return { parts, order, idByName };
}

export interface CheckOutcome extends CheckResult {
  /** Roll part ids by the names the flags use. */
  idByName: Record<string, string>;
}

/** The voice-leading check over every part of the roll that has notes. */
export async function runVoiceLeadingCheck(opts: { key?: string; mode?: KeyMode } = {}): Promise<CheckOutcome> {
  const { parts, order, idByName } = rollPartsForCheck();
  if (order.length < 2) throw new Error('the roll needs two parts with notes to check voice leading');
  const s = usePianoRollStore.getState();
  const result = await composerApi.check({
    parts,
    order,
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.key && opts.mode ? { mode: opts.mode } : {}),
    meterMap: s.meterMap,
    pickupSteps: s.pickupSteps,
  });
  return { ...result, idByName };
}

/**
 * Select the notes a flag names: the first of its parts becomes the part
 * being edited, and its notes sounding at the flag's tick are selected (the
 * roll selects inside one part at a time). Returns how many were selected.
 */
export function selectFlagNotes(flag: Pick<VoiceLeadingFlag, 'tick' | 'parts'>, idByName: Record<string, string>): number {
  const id = flag.parts.map((p) => idByName[p]).find(Boolean);
  if (!id) return 0;
  const store = usePianoRollStore.getState();
  store.setActiveTrack(id);
  const after = usePianoRollStore.getState();
  const ids = notesSoundingAt(after.notes, flag.tick);
  after.setSelection(ids);
  // The playhead goes to the flag, so PLAY starts on it; never while the roll plays.
  if (ids.length && !after.isPlaying) after.seek(Math.floor(flag.tick / TICKS_PER_STEP));
  return ids.length;
}
