/**
 * rollClip — the piano roll's state as EDIT clip fields, and a clip's fields as
 * the arguments that load it back into the roll.
 *
 * A bounce stores two note lists. `sourcePianoRoll` holds the notes as they
 * sound: each looping lane's repeats written out and the lane ids dropped. EDIT
 * plays and draws that list once. `sourceRollNotes` holds the roll's own notes
 * with their lanes, so the clip reopens in the roll with the same lanes, and
 * its meter map, pickup, each lane's pitch bend and its tempo map travel beside
 * them. A clip's tempo map (`sourceTempoMap`) is written only when the roll
 * changes tempo; EDIT plays, draws and renders the clip's notes through it
 * (lib/rollTempo stepClock), and a clip without one holds `sourceBpm`.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import {
  DEFAULT_LANES,
  MIN_NOTE_STEPS,
  noteTick,
  noteTicks,
  rollMeterOf,
  sanitizeLanes,
  type PianoNote,
  type RollControl,
  type RollMeter,
  type RollPartRef,
  type RollPartsLoad,
  type RollTrack,
} from '../state/pianoRollStore';
import {
  PERCUSSION_PART_CHANNEL,
  cleanPartBank,
  cleanPartChannel,
  cleanPartColor,
  cleanPartControls,
  cleanPartName,
  cleanPartProgram,
  partController,
} from './rollTracks';
import { quantizeNotes, type QuantizeOptions } from './clipNotes';
import { applyGrooveInMeter, grooveLateness, type GrooveTemplate } from './grooveTemplate';
import { barAt, laneTimeOf, normalizeMeterMap, roundUpToBar, unrollLanes, type MeterSegment, type PolyLane } from './meterMap';
import { TICKS_PER_STEP, feelNoteTicks, laneSnapGrid, snapGrid, type RollSnapId, type SnapGrid } from './rollSnap';
import { copyBends, rollRenderBends, sanitizeBends, type LaneBend, type RollRenderBends } from './pitchBend';
import type { MidiFileData } from './midi';
import { midiFileToRoll } from './rollMidi';
import { copyTempoMap, hasTempoChanges, playedTempoMap, stepClock, type StepClock } from './rollTempo';
import type { TempoEvent } from './tempoMap';

/** The roll state a bounce reads. `tempoMap` left out is one tempo at `bpm`. */
export type RollClipSource = RollMeter & {
  notes: readonly PianoNote[];
  bpm: number;
  totalSteps: number;
  bends: readonly LaneBend[];
  tempoMap?: readonly TempoEvent[];
};

type RollClipKeys =
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceBpm'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
  | 'sourceLanes'
  | 'sourceBends';

/**
 * The clip fields a bounce writes. `sourceTempoMap` is always named, and
 * undefined for a roll at one tempo, so a re-bounce after the last tempo
 * change is removed clears the map the clip had.
 */
export type RollClipFields = Required<Pick<AudioClip, RollClipKeys>> & { sourceTempoMap: TempoEvent[] | undefined };

/** The clip fields clipRollLoad reads. */
export type RollClipInput = Pick<AudioClip, 'id' | RollClipKeys | 'sourceTempoMap'>;

/** The arguments of pianoRollStore's loadFromClip. */
export type RollLoadArgs = [
  clipId: string,
  notes: PianoNote[],
  bpm: number,
  totalSteps: number,
  meter: RollMeter,
  bends: LaneBend[],
  tempoMap: TempoEvent[] | undefined,
  parts?: RollPartsLoad,
];

/**
 * Where a clip's note sounds, in seconds from the clip's left edge: `relStart`
 * to `relEnd`. `timing` is a 16th's seconds, or the clip's StepClock
 * (lib/rollTempo) when its tempo map changes tempo. `offsetSec` is the clip's
 * trim into its source. The note keeps its own length, floored at the roll's
 * one tick, so a run shorter than a 16th plays and draws in EDIT at the length
 * it has in the roll.
 */
export const clipNoteSpan = (
  n: Pick<PianoNote, 'step' | 'length'>,
  timing: number | StepClock,
  offsetSec: number,
): { relStart: number; relEnd: number } => {
  const length = Math.max(MIN_NOTE_STEPS, n.length);
  const stepSec = typeof timing === 'number' ? timing : timing.stepSec;
  if (stepSec !== undefined) {
    const relStart = n.step * stepSec - offsetSec;
    return { relStart, relEnd: relStart + length * stepSec };
  }
  const clock = timing as StepClock;
  return { relStart: clock.at(n.step) - offsetSec, relEnd: clock.at(n.step + length) - offsetSec };
};

/** The step just past the last note's end — the grid length a note list implies when nothing else says otherwise. */
const noteEndSteps = (notes: readonly PianoNote[]): number =>
  notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);

/**
 * The notes as they sound: each looping lane's repeats written out across the
 * roll. The editor and a MIDI file play a note list once, so every hand-off
 * takes this list. Lane ids are dropped, so a clip loaded back into the roll
 * does not loop its repeats a second time.
 */
export const playedRollNotes = (notes: readonly PianoNote[], lanes: readonly PolyLane[], totalSteps: number): PianoNote[] =>
  unrollLanes(notes, lanes, totalSteps).map(({ lane: _lane, ...n }) => n);

/** The clip fields a bounce writes from the roll's state. Every list is a copy. */
export function rollClipFields(s: RollClipSource): RollClipFields {
  const meter = rollMeterOf(s);
  return {
    sourcePianoRoll: playedRollNotes(s.notes, s.lanes, s.totalSteps),
    sourceRollNotes: s.notes.map((n) => ({ ...n })),
    sourceBpm: s.bpm,
    sourceTotalSteps: s.totalSteps,
    sourceMeterMap: meter.meterMap,
    sourcePickupSteps: meter.pickupSteps,
    sourceLanes: meter.lanes,
    sourceBends: copyBends(s.bends),
    sourceTempoMap: hasTempoChanges(s.tempoMap) ? copyTempoMap(s.tempoMap as TempoEvent[]) : undefined,
  };
}

/**
 * The clip fields of a MIDI file dropped into EDIT: the file as the roll reads
 * it (midiFileToRoll: each note at its own ticks, each bending channel in its
 * own lane with its curve, the file's meter and pickup, its tempo with its
 * fraction), ending on the bar line after its last note. Nothing is snapped to
 * 16ths, so the clip plays and reopens in the roll as the file was written.
 */
export function midiFileClipFields(data: MidiFileData, idPrefix = 'imp'): RollClipFields {
  const file = midiFileToRoll(data, idPrefix);
  const { meterMap, pickupSteps } = file.meter;
  const noteEnd = file.notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  return rollClipFields({
    ...file.meter,
    notes: file.notes,
    bpm: Number.isFinite(file.bpm) && file.bpm > 0 ? file.bpm : 120,
    totalSteps: roundUpToBar(meterMap, Math.max(1, noteEnd), pickupSteps),
    bends: file.bends,
    tempoMap: file.tempoMap,
  });
}

/** The clip fields a render of a roll clip reads. */
export type ClipRenderSource = Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'> &
  Partial<Pick<AudioClip, 'sourceRollPart'>>;

/** A note as it sounds, as one comparable string: its tick, length, pitch and velocity. */
const soundingKey = (n: Pick<PianoNote, 'step' | 'length' | 'note' | 'velocity'>): string =>
  `${Math.round(n.step * TICKS_PER_STEP)}|${Math.round(n.length * TICKS_PER_STEP)}|${n.note}|${n.velocity}`;

/** Whether two note lists sound the same, in any order. */
const soundsTheSame = (a: readonly PianoNote[], b: readonly PianoNote[]): boolean => {
  if (a.length !== b.length) return false;
  const ka = a.map(soundingKey).sort();
  const kb = b.map(soundingKey).sort();
  return ka.every((k, i) => k === kb[i]);
};

/**
 * The notes a roll clip's audio renders from over `totalSteps`, and the
 * controller changes of the part it holds (`controls`, from its
 * `sourceRollPart`), which a render plays with them so the pedal and the
 * volume a MIDI file gave the part are in the audio. A clip whose lanes bend
 * renders the roll's own notes unrolled with their lanes, so each note follows
 * its lane's curve, while those notes still play the clip's notes; any other
 * clip renders the notes it plays. EDIT's note tools and the assistant's write
 * the played notes alone, and a render of such a clip plays the edit, without
 * the bends of the roll notes it left behind.
 */
export function clipRenderInput(
  clip: ClipRenderSource,
  totalSteps: number,
): { notes: PianoNote[]; bends?: RollRenderBends; controls?: RollControl[] } {
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const own = clip.sourceRollNotes;
  const controls = clip.sourceRollPart?.controls?.length ? clip.sourceRollPart.controls : undefined;
  const played = clip.sourcePianoRoll ?? [];
  const bends = clip.sourceBends?.length && own?.length ? rollRenderBends(sanitizeBends(clip.sourceBends), lanes, totalSteps) : undefined;
  if (!bends || !own) return { notes: played, ...(controls ? { controls } : {}) };
  const unrolled = unrollLanes(own, lanes, totalSteps);
  if (clip.sourcePianoRoll && !soundsTheSame(unrolled, played)) return { notes: played, ...(controls ? { controls } : {}) };
  return { notes: unrolled, bends, ...(controls ? { controls } : {}) };
}

/** A controller change at a timeline second: what a clip's part sends where EDIT plays it. */
export interface ClipControlTime {
  sec: number;
  controller: number;
  value: number;
}

/**
 * A clip's part controller changes (its `sourceRollPart` controls) at their
 * timeline seconds, as EDIT plays the clip: each at its tick through the
 * clip's own clock (its tempo map, else `sourceBpm`, else `fallbackBpm`),
 * shifted by the clip's start and trim, inside the clip's window. The value
 * each controller holds where the window starts comes first, at the clip's
 * start, so a trimmed clip starts with the pedal and volume it has there. A
 * controller that changes right where the window starts is left out of that
 * state, since its change plays there (the rule PLAY's chase follows in
 * lib/rollPartPlay), and a change within a nanosecond of the start counts as
 * inside the window, so rounding in the clock never drops it. The
 * arrangement's MIDI export (lib/arrangementMidi) reads it. EDIT's live
 * playback sends no part controllers yet; a live scheduler that does should
 * send this list.
 */
export function clipControlTimes(
  clip: Pick<AudioClip, 'startSec' | 'durationSec' | 'offsetIntoSource' | 'sourceBpm' | 'sourceTempoMap' | 'sourceRollPart'>,
  fallbackBpm: number,
): ClipControlTime[] {
  const own = clip.sourceRollPart?.controls ?? [];
  if (!own.length) return [];
  const clock = stepClock(clip.sourceBpm ?? fallbackBpm, clip.sourceTempoMap);
  const offset = clip.offsetIntoSource ?? 0;
  // Each controller the part uses, at the value it holds where the window
  // starts: the last change before the window, else where a channel starts.
  const state = new Map<number, number>();
  for (const c of own) if (!state.has(c.controller)) state.set(c.controller, partController(c.controller)?.initial ?? 0);
  const inside: ClipControlTime[] = [];
  const changingAtStart = new Set<number>();
  // `own` is in tick order and the clock only moves forward, so each change is before, inside or past the window in turn.
  for (const c of own) {
    const rel = clock.at(c.tick / TICKS_PER_STEP) - offset;
    if (rel < -1e-9) {
      state.set(c.controller, c.value);
      continue;
    }
    if (rel >= clip.durationSec) break;
    if (rel <= 1e-9) changingAtStart.add(c.controller);
    inside.push({ sec: clip.startSec + Math.max(0, rel), controller: c.controller, value: c.value });
  }
  const out: ClipControlTime[] = [];
  for (const [controller, value] of state) if (!changingAtStart.has(controller)) out.push({ sec: clip.startSec, controller, value });
  return out.concat(inside);
}

/**
 * The arguments that load `clip` into the roll: its stored notes when it has
 * them, else the notes it plays, its meter and its lanes' bends (none when it
 * has none). A clip with no meter map was bounced before the roll had one, so
 * it loads as 4/4 with no pickup and lane A only, and its grid length rounds up
 * to a bar line.
 */
export function clipRollLoad(clip: RollClipInput): RollLoadArgs {
  const stored = clip.sourceRollNotes?.length ? clip.sourceRollNotes : clip.sourcePianoRoll ?? [];
  const notes = stored.map((n) => ({ ...n }));
  const meterMap = normalizeMeterMap(clip.sourceMeterMap);
  const pickupSteps = clip.sourcePickupSteps ?? 0;
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const noteEnd = noteEndSteps(notes);
  const totalSteps =
    clip.sourceMeterMap && clip.sourceTotalSteps !== undefined
      ? clip.sourceTotalSteps
      : roundUpToBar(meterMap, Math.max(1, clip.sourceTotalSteps ?? noteEnd), pickupSteps);
  // A clip with no tempo map (one tempo, or bounced before maps existed) opens at its one tempo.
  // A mapped clip opens at the map EDIT plays: scaled to its sourceBpm, which a
  // retag or a stretch rewrites without touching the map.
  const bpm = clip.sourceBpm ?? 120;
  const tempoMap = hasTempoChanges(clip.sourceTempoMap) ? copyTempoMap(playedTempoMap(bpm, clip.sourceTempoMap)) : undefined;
  return [clip.id, notes, bpm, totalSteps, { meterMap, pickupSteps, lanes }, sanitizeBends(clip.sourceBends ?? []), tempoMap];
}

/**
 * clipNotes' quantize (grid/strength/swing/quantizeEnds), plus an optional
 * groove template (`lib/grooveTemplate.ts`) layered on top with its own
 * strength — the same two-stage feel `PianoRollFeel`'s APPLY uses on the live
 * roll, expressed as a document operation instead of a store mutation.
 */
export interface RollClipQuantizeOptions extends QuantizeOptions {
  /** A named feel (or the swing slider's synthesized groove, `swingToGroove`)
   *  laid over the quantized grid. Omit for grid quantize alone. */
  groove?: GrooveTemplate;
  /** How far into the groove's shape to go, 0..1. Defaults to 1 (the
   *  template's full depth) — callers that want it tied to the grid's own
   *  `strength` pass that value explicitly. */
  grooveStrength?: number;
}

/** The clip fields quantizeRollClip needs: the roll's own notes and enough of
 *  its meter to unroll them back into the played list it also returns. */
export type RollClipNoteInput = Pick<
  RollClipInput,
  'sourceRollNotes' | 'sourcePianoRoll' | 'sourceLanes' | 'sourceMeterMap' | 'sourcePickupSteps' | 'sourceTotalSteps'
>;

/**
 * Quantize (and optionally apply a groove to) a roll clip's OWN notes — the
 * lane-based document `sourceRollNotes` a reopened roll reads — then
 * re-derives the played list `sourcePianoRoll` the timeline renders from the
 * result, so re-quantizing a bounced clip can never leave the two note lists
 * this module keeps in sync out of step (T37B: there was no such operation in
 * this module at all).
 *
 * A clip bounced before the roll had its own note list (`sourceRollNotes`
 * empty — the same legacy case `clipRollLoad` treats as "no roll document",
 * see its own comment) has no lanes to preserve: its played notes are
 * quantized directly, `sourcePianoRoll` carries the result, and
 * `sourceRollNotes` stays empty rather than manufacturing lane data that was
 * never authored.
 *
 * The math is not reimplemented here: quantize/strength/swing is
 * `clipNotes.quantizeNotes`, whose grid restarts on every bar line of the
 * clip's meter (a half-step pickup or a 7/32 bar keeps its own lines), and the
 * groove pass is `grooveTemplate.applyGrooveInMeter`, which follows each bar's
 * groups for a group groove.
 */
export function quantizeRollClip(
  clip: RollClipNoteInput,
  options: RollClipQuantizeOptions,
): Pick<RollClipFields, 'sourceRollNotes' | 'sourcePianoRoll'> {
  const legacy = !clip.sourceRollNotes?.length;
  const own = legacy ? (clip.sourcePianoRoll ?? []) : (clip.sourceRollNotes as PianoNote[]);
  const totalSteps = clip.sourceTotalSteps ?? noteEndSteps(own);

  const meterMap = normalizeMeterMap(options.meterMap ?? clip.sourceMeterMap);
  const pickupSteps = options.pickupSteps ?? clip.sourcePickupSteps ?? 0;
  const quantized = quantizeNotes(own, { ...options, meterMap, pickupSteps });
  let result = quantized;
  if (options.groove) {
    result = applyGrooveInMeter(quantized, options.groove, options.grooveStrength ?? 1, meterMap, pickupSteps, Math.max(0, totalSteps - 1));
  }

  if (legacy) return { sourceRollNotes: [], sourcePianoRoll: result };
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  return { sourceRollNotes: result, sourcePianoRoll: playedRollNotes(result, lanes, totalSteps) };
}

/** What the roll's APPLY reads besides the notes: its meter, lanes and length. */
export interface RollFeelShape {
  meterMap: readonly MeterSegment[];
  pickupSteps: number;
  lanes: readonly PolyLane[];
  totalSteps: number;
}

export interface RollFeelOptions {
  /** The roll's snap: the grid starts and lengths move toward (lib/rollSnap). */
  snap: RollSnapId;
  /** Quantize strength, 0..1. */
  strength: number;
  /** The feel laid over the grid; omit for quantize alone. */
  groove?: GrooveTemplate;
  /** How far into the groove, 0..1 (the slider's own swing groove applies whole). */
  grooveStrength?: number;
}

/**
 * The roll's APPLY as a pure function: each note's start moves toward the
 * nearest line of the SNAP grid and its length toward a whole number of cells
 * (rollSnap feelNoteTicks), both `strength` of the way, then the groove moves
 * the start (grooveLateness), held inside the roll. A note in a lane with its
 * own time (meterMap laneTimeOf) lands on the lane's grid and takes the groove
 * in the lane's bars, so a 3:2 lane keeps its triplets. Ticks are written with
 * the steps, whole, so nothing is rounded to a 16th on the way back in.
 */
export function feelRollNotes(notes: readonly PianoNote[], roll: RollFeelShape, opts: RollFeelOptions): PianoNote[] {
  const map = normalizeMeterMap(roll.meterMap);
  const pickup = Math.max(0, roll.pickupSteps);
  const lastStep = Math.max(0, roll.totalSteps - 1);
  const grooveAmount = Math.max(0, Math.min(1, opts.grooveStrength ?? 1));
  const grids = new Map<number, { grid: SnapGrid; map: MeterSegment[]; pickup: number; scale: number }>();
  const gridOf = (laneId: number) => {
    let hit = grids.get(laneId);
    if (!hit) {
      const lt = laneTimeOf(roll.lanes.find((l) => l.id === laneId), map, pickup);
      hit = lt
        ? { grid: laneSnapGrid(lt, roll.totalSteps, opts.snap), map: lt.map, pickup: lt.pickup, scale: lt.scale }
        : { grid: snapGrid(map, pickup, roll.totalSteps, opts.snap), map, pickup, scale: 1 };
      grids.set(laneId, hit);
    }
    return hit;
  };
  return notes.map((n) => {
    const g = gridOf(roll.lanes.some((l) => l.id === n.lane) ? (n.lane as number) : 0);
    const placed = feelNoteTicks(g.grid, noteTick(n), noteTicks(n), opts.strength);
    let step = placed.tick / TICKS_PER_STEP;
    if (opts.groove && grooveAmount > 0) {
      const own = step / g.scale;
      const b = barAt(g.map, own, g.pickup);
      const late = grooveLateness(opts.groove, own, { start: b.start, len: b.len, meter: b.meter, bar: b.bar }) * grooveAmount * g.scale;
      step = Math.min(lastStep, Math.max(0, step + late));
    }
    const tick = Math.max(0, Math.round(step * TICKS_PER_STEP));
    return { ...n, tick, ticks: placed.ticks, step: tick / TICKS_PER_STEP, length: placed.ticks / TICKS_PER_STEP };
  });
}

/**
 * A note's length after the roll's APPLY at quantize strength `q` (0-1):
 * pulled from its own length toward the nearest whole number of steps (at
 * least one), `q` of the way. At 0 the length stays as it was, a sub-step
 * triplet 16th included, so a swing-only APPLY moves starts and leaves lengths
 * alone; at 1 it lands on whole steps, APPLY's 1/16 grid.
 */
export function feelLength(length: number, q: number): number {
  const strength = Math.max(0, Math.min(1, Number.isFinite(q) ? q : 0));
  const whole = Math.max(1, Math.round(length));
  return length + (whole - length) * strength;
}

// ── Parts: roll parts as EDIT clips and back ────────────────────────────────

/** The record a part's clip keeps of it (AudioClip `sourceRollPart`): its document, id, place, settings and controller changes. */
export function rollPartRef(part: RollTrack, order: number, doc: string): RollPartRef {
  return {
    doc,
    id: part.id,
    order,
    name: part.name,
    program: part.program,
    bank: part.bank,
    channel: part.channel,
    color: part.color,
    mute: part.mute,
    solo: part.solo,
    ...(part.instrumentId ? { instrumentId: part.instrumentId } : {}),
    ...(part.controls?.length ? { controls: part.controls.map((c) => ({ ...c })) } : {}),
  };
}

/**
 * A part record from a file or an autosave, every field brought into range,
 * or undefined when it names no document or no part. `name` and `color` fall
 * back to the ones given (the clip's track), so a hand-edited record still opens.
 */
export function cleanRollPartRef(raw: unknown, fallback: { name: string; color: string }): RollPartRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.doc !== 'string' || !r.doc || typeof r.id !== 'string' || !r.id) return undefined;
  const order = typeof r.order === 'number' && Number.isFinite(r.order) ? Math.max(0, Math.round(r.order)) : 0;
  const controls = cleanPartControls(r.controls);
  return {
    doc: r.doc,
    id: r.id,
    order,
    name: cleanPartName(r.name, fallback.name),
    program: cleanPartProgram(r.program),
    bank: cleanPartBank(r.bank),
    channel: cleanPartChannel(r.channel),
    color: cleanPartColor(r.color, fallback.color),
    mute: r.mute === true,
    solo: r.solo === true,
    ...(typeof r.instrumentId === 'string' && r.instrumentId ? { instrumentId: r.instrumentId } : {}),
    ...(controls ? { controls } : {}),
  };
}

/** The clip fields clipPartsLoad reads of every clip. */
export type RollPartClip = RollClipInput & Pick<AudioClip, 'trackId' | 'label' | 'color' | 'startSec' | 'sourceRollPart' | 'sourceKind'>;

/** A clip as one of the roll's parts: its record when it has one, else its track's name, colour and drum channel. */
function partOfClip(clip: RollPartClip, track: Pick<EditorTrack, 'name' | 'color' | 'isPercussion'> | undefined, notes: PianoNote[], id: string): RollTrack {
  const ref = clip.sourceRollPart;
  if (ref) {
    return {
      id,
      name: ref.name,
      program: ref.program,
      bank: ref.bank,
      channel: ref.channel,
      color: ref.color,
      mute: ref.mute,
      solo: ref.solo,
      notes,
      ...(ref.instrumentId ? { instrumentId: ref.instrumentId } : {}),
      ...(ref.controls?.length ? { controls: ref.controls.map((c) => ({ ...c })) } : {}),
    };
  }
  // A clip bounced before parts: its EDIT track names it, and a drum track makes it a percussion part.
  return {
    id,
    name: cleanPartName(track?.name, cleanPartName(clip.label, 'Part 1')),
    program: null,
    bank: 0,
    channel: track?.isPercussion ? PERCUSSION_PART_CHANNEL : null,
    color: cleanPartColor(track?.color ?? clip.color, '#a855f7'),
    mute: false,
    solo: false,
    notes,
  };
}

/**
 * The arguments that open `clip` in the roll with every part of its roll
 * document: each clip in `clips` whose record names the same document becomes
 * a part, in the order they were bounced, linked to its clip, with `clip`'s
 * part active and `clip`'s meter, tempo map and bends for the document. Two
 * clips of one part (a split or a copy in EDIT) give it once: `clip` itself
 * for its own part, else the earliest on the timeline. A clip with no record
 * (bounced before parts) opens alone as one part named after its track.
 */
export function clipPartsLoad(
  clip: RollPartClip,
  clips: readonly RollPartClip[],
  tracks: readonly Pick<EditorTrack, 'id' | 'name' | 'color' | 'isPercussion'>[],
): RollLoadArgs {
  const base = clipRollLoad(clip);
  const withParts = (parts: RollPartsLoad): RollLoadArgs => [base[0], base[1], base[2], base[3], base[4], base[5], base[6], parts];
  const trackOf = (c: RollPartClip) => tracks.find((t) => t.id === c.trackId);
  const ref = clip.sourceRollPart;
  if (!ref) {
    const id = `part-${clip.id}`;
    const part = partOfClip(clip, trackOf(clip), base[1], id);
    return withParts({ tracks: [part], activeTrackId: id, links: { [id]: clip.id } });
  }
  const byPart = new Map<string, RollPartClip>();
  byPart.set(ref.id, clip);
  const siblings = clips
    .filter((c) => c.id !== clip.id && c.sourceRollPart?.doc === ref.doc)
    .sort((a, b) => a.startSec - b.startSec);
  for (const c of siblings) {
    const id = (c.sourceRollPart as RollPartRef).id;
    if (!byPart.has(id)) byPart.set(id, c);
  }
  const ordered = [...byPart.entries()].sort(([, a], [, b]) => (a.sourceRollPart as RollPartRef).order - (b.sourceRollPart as RollPartRef).order);
  const links: Record<string, string> = {};
  const parts = ordered.map(([id, c]) => {
    links[id] = c.id;
    return partOfClip(c, trackOf(c), c === clip ? base[1] : clipRollLoad(c)[1], id);
  });
  return withParts({ doc: ref.doc, tracks: parts, activeTrackId: ref.id, links });
}
