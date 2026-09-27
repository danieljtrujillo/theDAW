/**
 * rollTransport — where the piano roll's PLAY runs: the steps it loops over,
 * the absolute-step clock's mapping onto roll steps, and the times a note
 * starts in a scheduling window.
 *
 * The roll's scheduler (PianoRoll.tsx PianoRollTransport) counts ABSOLUTE
 * steps from the moment PLAY starts, one per 16th at the tempo, and never runs
 * backwards. A lap maps them onto roll steps: from `base` on, absolute steps
 * play roll steps `start` .. `start + len` over and over. With no loop the lap
 * is the whole roll (start 0, len = the roll's length); with a loop it is the
 * loop's steps.
 *
 * Everything here is pure, so node tests load it.
 */
import { barAt, type MeterSegment } from './meterMap';

/** A loop range in roll steps: `start` inclusive, `end` exclusive. */
export interface RollLoop {
  start: number;
  end: number;
}

/** The steps PLAY loops over: the loop when one is on and fits the roll, else the whole roll. */
export interface PlayRange {
  start: number;
  end: number;
}

/** From `base` on, absolute steps play roll steps `start` .. `start + len`, then start over. */
export interface Lap {
  base: number;
  start: number;
  len: number;
}

/** The shortest loop: one step. A drag shorter than that is a click (a seek). */
export const MIN_LOOP_STEPS = 1;

const EPS = 1e-9;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A loop range the roll can hold, or null: both ends finite, the start at or
 * after 0, and at least MIN_LOOP_STEPS long. Ends given the wrong way round are
 * swapped, since a drag can run either way.
 */
export function sanitizeLoop(loop: Partial<RollLoop> | null | undefined): RollLoop | null {
  if (!loop || !finite(loop.start) || !finite(loop.end)) return null;
  const start = Math.max(0, Math.min(loop.start, loop.end));
  const end = Math.max(loop.start, loop.end);
  return end - start >= MIN_LOOP_STEPS - EPS ? { start, end } : null;
}

/**
 * The steps PLAY loops over. A loop that is on plays its steps, cut at the
 * roll's end; a loop that is off, or one that starts at or past the roll's end
 * (the roll was shortened under it), leaves the whole roll.
 */
export function playRange(loop: RollLoop | null, loopOn: boolean, totalSteps: number): PlayRange {
  const total = Math.max(1, finite(totalSteps) ? totalSteps : 1);
  const l = loopOn ? sanitizeLoop(loop) : null;
  if (l && l.start < total - EPS) return { start: l.start, end: Math.min(l.end, total) };
  return { start: 0, end: total };
}

/** True when `range` holds roll step `pos`. */
export const rangeHolds = (range: PlayRange, pos: number): boolean => pos >= range.start - EPS && pos < range.end - EPS;

/**
 * The lap that plays roll step `pos` at absolute step `at` when `range` holds
 * `pos`, and otherwise the lap that starts `range` over at `at`. PLAY starts
 * with `at` 0 and `pos` the playhead; an edit, a seek or a new loop while the
 * roll plays re-anchors with `at` just past what is already scheduled.
 */
export function lapAt(at: number, pos: number, range: PlayRange): Lap {
  const len = Math.max(EPS, range.end - range.start);
  if (rangeHolds(range, pos)) return { base: at - (pos - range.start), start: range.start, len };
  return { base: at, start: range.start, len };
}

/** The roll step absolute step `abs` plays. */
export function rollStepAt(lap: Lap, abs: number): number {
  const off = (((abs - lap.base) % lap.len) + lap.len) % lap.len;
  return lap.start + off;
}

/**
 * The absolute steps in (`from`, `to`] at which a note at roll step `step`
 * starts. A note the lap never reaches plays nowhere: one before the lap's
 * start, and one at or past its end, which is where a note at or past the
 * roll's end sits: it stays silent rather than wrapping into the roll's start.
 */
export function noteOnsets(lap: Lap, step: number, from: number, to: number): number[] {
  const out: number[] = [];
  if (!finite(step) || step < lap.start - EPS || step >= lap.start + lap.len - EPS || !(to > from)) return out;
  const first = lap.base + (step - lap.start);
  let occ = first + Math.ceil((from - first) / lap.len) * lap.len;
  if (occ <= from) occ += lap.len;
  for (; occ <= to; occ += lap.len) out.push(occ);
  return out;
}

/** How far past the cursor a re-anchored lap starts: past the step already scheduled, so it is not scheduled again. */
export const REANCHOR_STEPS = 1e-4;

/**
 * The scheduler's lap between ticks: the lap itself, the range it was built
 * for, the seek it has answered, and the absolute step the playhead shows from
 * (after a seek or a restart of the range the playhead shows the new place,
 * not the old lap's tail that is still sounding).
 */
export interface LapState {
  lap: Lap;
  range: PlayRange;
  seekId: number;
  shownFrom: number;
}

/** The lap PLAY starts with: absolute step 0 plays the playhead, or the range's start when the range leaves the playhead out. */
export function startLap(playhead: number, seekId: number, range: PlayRange): LapState {
  return { lap: lapAt(0, playhead, range), range, seekId, shownFrom: 0 };
}

/**
 * The lap after a tick reads the store, with `cursor` the absolute step
 * scheduled up to. A new seek re-anchors at the new playhead; a new range (a
 * length change, a loop set, moved, turned on or off) keeps the playhead's
 * place when the new range holds it and otherwise starts the range over.
 * Nothing new gives back the same object, so the caller can tell a re-anchor
 * by identity.
 */
export function followLap(state: LapState, next: { range: PlayRange; seekId: number; playhead: number }, cursor: number): LapState {
  const at = cursor + REANCHOR_STEPS;
  if (next.seekId !== state.seekId) {
    return { lap: lapAt(at, next.playhead, next.range), range: next.range, seekId: next.seekId, shownFrom: at };
  }
  if (next.range.start === state.range.start && next.range.end === state.range.end) return state;
  const pos = rollStepAt(state.lap, at);
  return {
    lap: lapAt(at, pos, next.range),
    range: next.range,
    seekId: state.seekId,
    shownFrom: rangeHolds(next.range, pos) ? state.shownFrom : at,
  };
}

/** The roll step the playhead shows at absolute step `elapsed`. */
export const shownStep = (state: LapState, elapsed: number): number => rollStepAt(state.lap, Math.max(state.shownFrom, elapsed));

/** Every start in (`from`, `to`] of the notes in `played`, in note order: the note and the absolute step it starts at. */
export function windowOnsets<T extends { step: number }>(played: readonly T[], lap: Lap, from: number, to: number): Array<{ note: T; abs: number }> {
  const out: Array<{ note: T; abs: number }> = [];
  for (const n of played) for (const abs of noteOnsets(lap, n.step, from, to)) out.push({ note: n, abs });
  return out;
}

/**
 * The loop a drag along the ruler sets, from the step the press went down on
 * to the step under the pointer, each rounded to the nearest step line and
 * held inside the roll. Null while the two lines are the same one: that is
 * still a click (a seek), not a loop.
 */
export function rulerLoop(downStep: number, atStep: number, totalSteps: number): RollLoop | null {
  const total = Math.max(1, finite(totalSteps) ? Math.floor(totalSteps) : 1);
  const a = Math.max(0, Math.min(total, Math.round(finite(downStep) ? downStep : 0)));
  const b = Math.max(0, Math.min(total, Math.round(finite(atStep) ? atStep : 0)));
  return sanitizeLoop({ start: a, end: b });
}

/** The step a click on the ruler seeks to: the step cell under the pointer, inside the roll. */
export function rulerSeekStep(atStep: number, totalSteps: number): number {
  const last = Math.max(0, Math.ceil(finite(totalSteps) ? totalSteps : 1) - 1);
  return Math.max(0, Math.min(last, Math.floor(finite(atStep) ? atStep : 0)));
}

/**
 * A loop in words: "bar 3" or "bars 3-4" (the pickup reads "the pickup") when
 * it runs from bar line to bar line, otherwise "steps 5-12", counted from 1.
 */
export function loopLabel(loop: RollLoop, meterMap: readonly MeterSegment[], pickupSteps = 0): string {
  const first = barAt(meterMap, loop.start, pickupSteps);
  const last = barAt(meterMap, Math.max(loop.start, loop.end - EPS * 1e3), pickupSteps);
  const onLines = Math.abs(first.start - loop.start) < 1e-6 && Math.abs(last.start + last.len - loop.end) < 1e-6;
  if (!onLines) return `steps ${fmt(loop.start + 1)}-${fmt(loop.end)}`;
  const name = (bar: number) => (bar < 0 ? 'the pickup' : String(bar + 1));
  if (first.bar === last.bar) return first.bar < 0 ? 'the pickup' : `bar ${name(first.bar)}`;
  return `bars ${first.bar < 0 ? 'pickup' : name(first.bar)}-${name(last.bar)}`;
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * Where a key on the ruler moves the playhead from roll step `at`, or null for
 * a key the ruler does not take: the arrows a step (Shift: to the bar line
 * before or after), Home and End to the roll's first and last step.
 */
export function rulerKeyStep(
  key: string,
  shift: boolean,
  at: number,
  totalSteps: number,
  meterMap: readonly MeterSegment[],
  pickupSteps = 0,
): number | null {
  const last = Math.max(0, Math.ceil(finite(totalSteps) ? totalSteps : 1) - 1);
  const from = Math.max(0, Math.min(last, Math.floor(finite(at) ? at : 0)));
  let to: number;
  if (key === 'Home') to = 0;
  else if (key === 'End') to = last;
  else if (key === 'ArrowLeft' || key === 'ArrowDown') {
    if (shift) {
      const bar = barAt(meterMap, from, pickupSteps);
      to = bar.start < from - EPS ? bar.start : barAt(meterMap, Math.max(0, from - 1), pickupSteps).start;
    } else to = from - 1;
  } else if (key === 'ArrowRight' || key === 'ArrowUp') {
    if (shift) {
      const bar = barAt(meterMap, from, pickupSteps);
      to = bar.start + bar.len;
    } else to = from + 1;
  } else return null;
  return Math.max(0, Math.min(last, to));
}
