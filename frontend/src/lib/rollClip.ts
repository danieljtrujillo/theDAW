/**
 * rollClip — the piano roll's state as EDIT clip fields, and a clip's fields as
 * the arguments that load it back into the roll.
 *
 * A bounce stores two note lists. `sourcePianoRoll` holds the notes as they
 * sound: each looping lane's repeats written out and the lane ids dropped. EDIT
 * plays and draws that list once. `sourceRollNotes` holds the roll's own notes
 * with their lanes, so the clip reopens in the roll with the same lanes, and
 * its meter map, pickup and each lane's pitch bend travel beside them.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip } from '../state/editorStore';
import { DEFAULT_LANES, MIN_NOTE_STEPS, rollMeterOf, sanitizeLanes, type PianoNote, type RollMeter } from '../state/pianoRollStore';
import { STEPS_PER_BEAT, quantizeNotes, type QuantizeOptions } from './clipNotes';
import { applyGroove, type GrooveTemplate } from './grooveTemplate';
import { barAt, normalizeMeterMap, roundUpToBar, unrollLanes, type PolyLane } from './meterMap';
import { copyBends, rollRenderBends, sanitizeBends, type LaneBend, type RollRenderBends } from './pitchBend';

/** The roll state a bounce reads. */
export type RollClipSource = RollMeter & { notes: readonly PianoNote[]; bpm: number; totalSteps: number; bends: readonly LaneBend[] };

type RollClipKeys =
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceBpm'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
  | 'sourceLanes'
  | 'sourceBends';

/** The clip fields a bounce writes. */
export type RollClipFields = Required<Pick<AudioClip, RollClipKeys>>;

/** The clip fields clipRollLoad reads. */
export type RollClipInput = Pick<AudioClip, 'id' | RollClipKeys>;

/** The arguments of pianoRollStore's loadFromClip. */
export type RollLoadArgs = [clipId: string, notes: PianoNote[], bpm: number, totalSteps: number, meter: RollMeter, bends: LaneBend[]];

/**
 * Where a clip's note sounds, in seconds from the clip's left edge: `relStart`
 * to `relEnd`. `offsetSec` is the clip's trim into its source. The note keeps
 * its own length, floored at the roll's one tick, so a run shorter than a 16th
 * plays and draws in EDIT at the length it has in the roll.
 */
export const clipNoteSpan = (
  n: Pick<PianoNote, 'step' | 'length'>,
  stepSec: number,
  offsetSec: number,
): { relStart: number; relEnd: number } => {
  const relStart = n.step * stepSec - offsetSec;
  return { relStart, relEnd: relStart + Math.max(MIN_NOTE_STEPS, n.length) * stepSec };
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
  };
}

/** The clip fields a render of a roll clip reads. */
export type ClipRenderSource = Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'>;

/**
 * The notes a roll clip's audio renders from over `totalSteps`. A clip whose
 * lanes bend renders the roll's own notes unrolled with their lanes, so each
 * note follows its lane's curve; any other clip renders the notes it plays.
 */
export function clipRenderInput(clip: ClipRenderSource, totalSteps: number): { notes: PianoNote[]; bends?: RollRenderBends } {
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const own = clip.sourceRollNotes;
  const bends = clip.sourceBends?.length && own?.length ? rollRenderBends(sanitizeBends(clip.sourceBends), lanes, totalSteps) : undefined;
  if (!bends || !own) return { notes: clip.sourcePianoRoll ?? [] };
  return { notes: unrollLanes(own, lanes, totalSteps), bends };
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
  return [clip.id, notes, clip.sourceBpm ?? 120, totalSteps, { meterMap, pickupSteps, lanes }, sanitizeBends(clip.sourceBends ?? [])];
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
 * `clipNotes.quantizeNotes`, the groove pass is `grooveTemplate.applyGroove`.
 */
export function quantizeRollClip(
  clip: RollClipNoteInput,
  options: RollClipQuantizeOptions,
): Pick<RollClipFields, 'sourceRollNotes' | 'sourcePianoRoll'> {
  const legacy = !clip.sourceRollNotes?.length;
  const own = legacy ? (clip.sourcePianoRoll ?? []) : (clip.sourceRollNotes as PianoNote[]);
  const totalSteps = clip.sourceTotalSteps ?? noteEndSteps(own);

  const quantized = quantizeNotes(own, options);
  let result = quantized;
  if (options.groove) {
    const meterMap = normalizeMeterMap(clip.sourceMeterMap);
    const pickupSteps = clip.sourcePickupSteps ?? 0;
    result = applyGroove(
      quantized,
      options.groove,
      STEPS_PER_BEAT,
      options.grooveStrength ?? 1,
      (step) => barAt(meterMap, step, pickupSteps).start,
      Math.max(0, totalSteps - 1),
    );
  }

  if (legacy) return { sourceRollNotes: [], sourcePianoRoll: result };
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  return { sourceRollNotes: result, sourcePianoRoll: playedRollNotes(result, lanes, totalSteps) };
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
