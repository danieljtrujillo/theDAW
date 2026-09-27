/**
 * takeNotes — a take in seconds as piano-roll notes, at the roll's own ticks.
 *
 * Every take the app turns into notes arrives in seconds: a pass played on a
 * MIDI keyboard (lib/midiCapture), the notes basic-pitch detects in a mic
 * recording or a library track (the MIDI tab's REC and LOAD, the track
 * menu's note detection and vocal melody rows), the vocal2midi column's notes
 * and the notes a vocal capture hears (lib/vocalToMidi). All of them convert
 * here, and lib/rollTakes hands them to the roll. Each edge becomes a whole
 * tick at PPQ (960) ticks to the quarter at the BPM handed in, and `step` /
 * `length` are those ticks counted in 16ths with the fraction kept, so the
 * store's `withTicks` keeps the ticks as they are.
 *
 * Nothing is quantised: a played note stays where it was played. The roll's
 * APPLY (Q, SWING and the groove) is where a take is pulled to a grid, and the
 * vocal2midi column's own Quantize setting runs on its seconds before they get
 * here. The only floor is one tick of length (MIN_NOTE_TICKS), so a tap whose
 * note-on and note-off land in the same instant is still a note.
 *
 * A take recorded against a roll that changes tempo converts through the
 * roll's tempo map (`tempoMap`), so a note played in a ritardando lands on the
 * beat it was played on, not where the starting tempo would put it.
 *
 * Pure. Its runtime imports are lib/noteClock, which has none, and
 * lib/tempoMap, which is pure arithmetic, so lib/midiCapture's store-free core
 * can use it.
 */
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { timeToBeat, type TempoEvent } from './tempoMap';
import type { PianoNote } from '../state/pianoRollStore';
import type { ArtifactNote } from './vocalExport';

/** One note of a take, in seconds. */
export interface TakeNote {
  /** MIDI note number; rounded and clamped to 0-127. */
  note: number;
  /** Velocity; rounded and clamped to 1-127, 100 when it is not a number. */
  velocity: number;
  startSec: number;
  endSec: number;
}

export interface TakeOptions {
  /** The tempo the roll plays the notes at. Not a positive number: 120. */
  bpm: number;
  /** The second tick 0 sits at: the clip's own start for a recorded pass. Defaults to 0. */
  originSec?: number;
  /** Prefix for the notes' ids, which are `<prefix>-<index>`. Defaults to `take`. */
  idPrefix?: string;
  /**
   * The roll's tempo map (lib/rollTempo playedTempoMap), when it changes tempo:
   * each second converts through it. Left out, every second converts at `bpm`.
   */
  tempoMap?: readonly TempoEvent[];
}

export interface TakeRoll {
  /** One note per input note that has a finite pitch, start and end, in input order. */
  rollNotes: PianoNote[];
  /** Grid length in whole steps: the last note's end rounded up to a 16th, 0 with no notes. */
  totalSteps: number;
}

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/**
 * Seconds to roll notes. A note that starts before `originSec` starts at tick
 * 0 and keeps the part of it after the origin.
 */
export function takeToRoll(notes: readonly TakeNote[], opts: TakeOptions): TakeRoll {
  const bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 120;
  const ticksPerSec = (bpm / 60) * PPQ;
  const map = opts.tempoMap && opts.tempoMap.length > 1 ? opts.tempoMap : null;
  const ticksAt = (sec: number): number => (map ? timeToBeat(map, sec) * PPQ : sec * ticksPerSec);
  const origin = opts.originSec !== undefined && Number.isFinite(opts.originSec) ? opts.originSec : 0;
  const prefix = opts.idPrefix ?? 'take';
  const rollNotes: PianoNote[] = [];
  let endTick = 0;
  for (const n of notes) {
    if (!Number.isFinite(n.note) || !Number.isFinite(n.startSec) || !Number.isFinite(n.endSec)) continue;
    const tick = Math.max(0, Math.round(ticksAt(n.startSec - origin)));
    const ticks = Math.max(MIN_NOTE_TICKS, Math.round(ticksAt(n.endSec - origin)) - tick);
    rollNotes.push({
      id: `${prefix}-${rollNotes.length}`,
      note: Math.max(0, Math.min(127, Math.round(n.note))),
      step: tick / TICKS_PER_STEP,
      length: ticks / TICKS_PER_STEP,
      velocity: Number.isFinite(n.velocity) ? Math.max(1, Math.min(127, Math.round(n.velocity))) : 100,
      tick,
      ticks,
    });
    endTick = Math.max(endTick, tick + ticks);
  }
  return { rollNotes, totalSteps: Math.ceil(endTick / TICKS_PER_STEP) };
}

/** Artifact notes (basic-pitch's answer, a vocal artifact's melody) as a take: milliseconds to seconds. */
export const artifactTake = (notes: readonly ArtifactNote[]): TakeNote[] =>
  notes.map((n) => ({ note: n.pitch, velocity: n.velocity, startSec: n.start_ms / 1000, endSec: n.end_ms / 1000 }));
