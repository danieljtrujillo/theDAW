/**
 * tempoConform — the roll's material moved from one tempo map to another so
 * that it keeps its time in seconds (KEEP TIME).
 *
 * A roll's notes sit on ticks, and a tick's second comes from the tempo map,
 * so a new tempo moves every note in time while it keeps its place in the bar.
 * That is right for music written on the grid. A transcription (a song's stem
 * run through basic-pitch, a sung take) was timed in seconds against its audio:
 * the tempo it was stamped at is a guess, and the notes have to stay on the
 * seconds they were heard at when the roll takes the song's real tempo, or they
 * drift from the audio they came from.
 *
 * Each helper here maps a place on the roll's clock through `from` to its
 * second and back through `to` to its new place: a note's start and its end
 * (so its length follows), each point of its own expression curves, a part's
 * controller changes and figured bass, the document's markers and the chord
 * figures over the ruler, and each bend point. A note on a looping lane is a
 * pattern of the grid, not a time, and keeps its tick.
 *
 * Pure, with no store import: the store and node tests share it.
 */
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { beatToTime, timeToBeat, type TempoEvent } from './tempoMap';
import type { FiguredBassMark, NoteExpression, NoteExpressionPoint, PianoNote, RollControl } from '../state/pianoRollStore';
import type { LaneBend } from './pitchBend';
import type { PolyLane } from './meterMap';

/** The two maps a conform moves between: the one the material was placed by, and the one it will play by. */
export interface TempoConform {
  from: readonly TempoEvent[];
  to: readonly TempoEvent[];
}

const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A tick's second under `from`, as a tick under `to`: whole, never negative. */
export const conformTick = (tick: number, c: TempoConform): number => {
  const beat = Math.max(0, isNum(tick) ? tick : 0) / PPQ;
  return Math.max(0, Math.round(timeToBeat(c.to, beatToTime(c.from, beat)) * PPQ));
};

/** A step's second under `from`, as a step under `to`, fraction kept. */
export const conformStep = (step: number, c: TempoConform): number => {
  const beat = Math.max(0, isNum(step) ? step : 0) / ROLL_STEPS_PER_BEAT;
  return Math.max(0, timeToBeat(c.to, beatToTime(c.from, beat)) * ROLL_STEPS_PER_BEAT);
};

/** True when two maps give every tick the same second, so a conform would move nothing. */
export function sameTiming(c: TempoConform): boolean {
  if (c.from === c.to) return true;
  if (c.from.length !== c.to.length) return false;
  return c.from.every((e, i) => {
    const o = c.to[i];
    return e.beat === o.beat && e.bpm === o.bpm && (e.curve ?? 'step') === (o.curve ?? 'step')
      && (e.fermata?.beats ?? 0) === (o.fermata?.beats ?? 0) && (e.fermata?.stretch ?? 0) === (o.fermata?.stretch ?? 0);
  });
}

/** One expression curve moved with its note: each point at its own second, measured from the note's new start. */
const conformCurve = (points: readonly NoteExpressionPoint[], oldStart: number, newStart: number, c: TempoConform): NoteExpressionPoint[] => {
  const byTick = new Map<number, number>();
  for (const p of points) byTick.set(Math.max(1, conformTick(oldStart + p.tick, c) - newStart), p.value);
  return [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({ tick, value }));
};

/** A note's expression with its curves moved to the note's new clock. */
const conformExpression = (e: NoteExpression, oldStart: number, newStart: number, c: TempoConform): NoteExpression => {
  if (!e.curves) return e;
  const curves: NonNullable<NoteExpression['curves']> = {};
  for (const dim of ['pressure', 'timbre', 'pitchBend'] as const) {
    const pts = e.curves[dim];
    if (pts?.length) curves[dim] = conformCurve(pts, oldStart, newStart, c);
  }
  return { ...e, curves };
};

/**
 * A note at the second it sounds under `from`, placed under `to`: its start
 * and its end each keep their second, so its length follows the tempo, and its
 * expression curves move with it. `step` and `length` are written from the new
 * ticks, as the store holds them.
 */
export function conformNote(n: PianoNote, c: TempoConform): PianoNote {
  const oldStart = isNum(n.tick) ? n.tick : Math.round((isNum(n.step) ? n.step : 0) * TICKS_PER_STEP);
  const oldTicks = isNum(n.ticks) ? n.ticks : Math.round((isNum(n.length) ? n.length : 1) * TICKS_PER_STEP);
  const tick = conformTick(oldStart, c);
  const ticks = Math.max(MIN_NOTE_TICKS, conformTick(oldStart + oldTicks, c) - tick);
  const out: PianoNote = { ...n, tick, ticks, step: tick / TICKS_PER_STEP, length: ticks / TICKS_PER_STEP };
  if (n.expr) out.expr = conformExpression(n.expr, oldStart, tick, c);
  return out;
}

/** The lanes whose notes are a loop's pattern (a cycle of their own): those keep their ticks. */
const loopingLanes = (lanes: readonly PolyLane[] | undefined): Set<number> =>
  new Set((lanes ?? []).filter((l) => l.id !== 0 && isNum(l.cycleSteps) && (l.cycleSteps as number) > 0).map((l) => l.id));

/** Every note of `notes` conformed (conformNote), but a note on a looping lane, which keeps its tick. */
export function conformNotes(notes: readonly PianoNote[], c: TempoConform, lanes?: readonly PolyLane[]): PianoNote[] {
  const loops = loopingLanes(lanes);
  return notes.map((n) => (n.lane !== undefined && loops.has(n.lane) ? n : conformNote(n, c)));
}

/** A part's controller changes at their seconds under the new map, still in tick order. */
export const conformControls = (controls: readonly RollControl[] | undefined, c: TempoConform): RollControl[] | undefined =>
  controls?.map((x) => ({ ...x, tick: conformTick(x.tick, c) }));

/** A part's figured bass at its seconds under the new map. */
export const conformFiguredBass = (marks: readonly FiguredBassMark[] | undefined, c: TempoConform): FiguredBassMark[] | undefined =>
  marks?.map((m) => ({ ...m, tick: conformTick(m.tick, c) }));

/** Anything placed by tick (a marker, a chord figure) at its second under the new map. */
export const conformTicked = <T extends { tick: number }>(items: readonly T[], c: TempoConform): T[] =>
  items.map((x) => ({ ...x, tick: conformTick(x.tick, c) }));

/** Each lane's bend points at their seconds under the new map; a looping lane's curve is its pattern and stays. */
export function conformBends(bends: readonly LaneBend[], c: TempoConform, lanes?: readonly PolyLane[]): LaneBend[] {
  const loops = loopingLanes(lanes);
  return bends.map((b) => (loops.has(b.lane) ? b : { ...b, points: b.points.map((p) => ({ ...p, step: conformStep(p.step, c) })) }));
}
