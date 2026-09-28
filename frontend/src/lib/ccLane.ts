/**
 * The CC lane's model: one controller of one roll part, drawn in the strip
 * under the piano roll (components/audio/CcLane) the way the bend lane draws a
 * lane's pitch wheel.
 *
 * A part's controller changes are its RollTrack `controls` (lib/rollTracks
 * cleanPartControls: sorted by tick, one change of a controller per tick). The
 * lane shows the changes of the controller it is set to, and every edit here
 * returns the part's whole list with that controller's changes replaced, so
 * the other controllers the part carries (a file's pedal under a drawn
 * modulation swell) stay where they are. A controller holds its value from one
 * change to the next, so the lane draws steps; a swell is many small steps,
 * which the lane's freehand draw and RAMP write.
 *
 * Pure: the lane, its tests and the hardware recorder share it.
 */
import type { NoteExpression, PianoNote, RollControl } from '../state/pianoRollStore';
import { dimensionPoints, withDimensionPoints, type ExpressionDimension } from './noteExpression';
import { cleanPartControls, partController, PART_CONTROLLERS } from './rollTracks';

/** The strip's height in px, the bend lane's. */
export const CC_LANE_HEIGHT = 72;
/** A point's drawn radius. */
export const CC_POINT_R = 4;
/** How near a pointer has to be to grab a point. */
export const CC_GRAB_R = 10;
/** The ticks between the points a freehand draw or a ramp writes: a 64th at 960 PPQ. */
export const CC_DRAW_TICKS = 60;

/** The controllers the lane offers, in the order its picker lists them: every one a part keeps. */
export const CC_LANE_CONTROLLERS: readonly number[] = Object.freeze(PART_CONTROLLERS.map((c) => c.controller));

/** The controller the lane opens on: expression (11), the one a phrase is shaped with. */
export const DEFAULT_CC_LANE_CONTROLLER = 11;

/** "CC 11 Expression". */
export const ccLabel = (controller: number): string => {
  const dim = NOTE_EXPRESSION_TARGETS.get(controller);
  return dim ? NOTE_TARGET_LABELS[dim] : `CC ${controller} ${partController(controller)?.name ?? ''}`.trim();
};

/** One change of the lane's controller. */
export interface CcPoint {
  tick: number;
  value: number;
}

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(Number.isFinite(v) ? v : 0)));
const wholeTick = (t: number): number => Math.max(0, Math.round(Number.isFinite(t) ? t : 0));

/** The changes of `controller` in a part's `controls`, in tick order. */
export function controllerPoints(controls: readonly RollControl[] | undefined, controller: number): CcPoint[] {
  return (controls ?? []).filter((c) => c.controller === controller).map((c) => ({ tick: c.tick, value: c.value }));
}

/**
 * A part's controls with `controller`'s changes replaced by `points` (cleaned:
 * whole ticks at 0 or later, values 0-127, the later of two at one tick). The
 * other controllers keep their changes. Undefined when nothing is left, as
 * cleanPartControls gives it.
 */
export function withControllerPoints(
  controls: readonly RollControl[] | undefined,
  controller: number,
  points: readonly CcPoint[],
): RollControl[] | undefined {
  const others = (controls ?? []).filter((c) => c.controller !== controller);
  const mine = points.map((p) => ({ tick: wholeTick(p.tick), controller, value: clamp7(p.value) }));
  return cleanPartControls([...others, ...mine]);
}

/** `points` with a change at `tick` set to `value` (one there already takes the new value). */
export function setCcPoint(points: readonly CcPoint[], tick: number, value: number): CcPoint[] {
  const t = wholeTick(tick);
  return [...points.filter((p) => p.tick !== t), { tick: t, value: clamp7(value) }].sort((a, b) => a.tick - b.tick);
}

/** `points` with the change at `from` moved to `to` and set to `value`; a change already at `to` gives way to it. */
export function moveCcPoint(points: readonly CcPoint[], from: number, to: number, value: number): CcPoint[] {
  const t = wholeTick(to);
  return [...points.filter((p) => p.tick !== from && p.tick !== t), { tick: t, value: clamp7(value) }].sort((a, b) => a.tick - b.tick);
}

/** `points` without the change at `tick`. */
export const removeCcPoint = (points: readonly CcPoint[], tick: number): CcPoint[] => points.filter((p) => p.tick !== tick);

/**
 * The value the controller holds at `tick`: the last change at or before it,
 * else the value the synth's channel starts at (lib/rollTracks PART_CONTROLLERS).
 */
export function ccValueAt(points: readonly CcPoint[], tick: number, controller: number): number {
  let v = partController(controller)?.initial ?? 0;
  for (const p of points) {
    if (p.tick > tick) break;
    v = p.value;
  }
  return v;
}

/**
 * A straight ramp from (`fromTick`, `fromValue`) to (`toTick`, `toValue`), a
 * change every `every` ticks and one at each end, with no two neighbours
 * holding the same value (a flat run is one change). What RAMP writes between
 * two points and what a freehand drag writes between two pointer samples.
 */
export function rampPoints(fromTick: number, fromValue: number, toTick: number, toValue: number, every = CC_DRAW_TICKS): CcPoint[] {
  const a = wholeTick(Math.min(fromTick, toTick));
  const b = wholeTick(Math.max(fromTick, toTick));
  const va = fromTick <= toTick ? fromValue : toValue;
  const vb = fromTick <= toTick ? toValue : fromValue;
  const out: CcPoint[] = [];
  const stride = Math.max(1, Math.round(every));
  for (let t = a; t < b; t += stride) {
    const v = clamp7(va + ((vb - va) * (t - a)) / Math.max(1, b - a));
    if (out.length && out[out.length - 1].value === v) continue;
    out.push({ tick: t, value: v });
  }
  const last = clamp7(vb);
  if (!out.length || out[out.length - 1].tick !== b) {
    if (out.length && out[out.length - 1].value === last) return out;
    out.push({ tick: b, value: last });
  }
  return out;
}

/** `points` with every change from `fromTick` to `toTick` (both ends in) replaced by `span`. */
export function replaceCcSpan(points: readonly CcPoint[], fromTick: number, toTick: number, span: readonly CcPoint[]): CcPoint[] {
  const a = Math.min(fromTick, toTick);
  const b = Math.max(fromTick, toTick);
  return [...points.filter((p) => p.tick < a || p.tick > b), ...span].sort((x, y) => x.tick - y.tick);
}

/** The y of `value` (0-127) in a strip `height` tall; 127 at the top, less a point's radius at each edge. */
export function ccValueToY(value: number, height: number): number {
  const usable = Math.max(1, height - 2 * CC_POINT_R);
  return CC_POINT_R + (1 - clamp7(value) / 127) * usable;
}

/** The value (0-127) at `y` in a strip `height` tall. */
export function ccYToValue(y: number, height: number): number {
  const usable = Math.max(1, height - 2 * CC_POINT_R);
  return clamp7((1 - (y - CC_POINT_R) / usable) * 127);
}

/** The tick a pointer at `x` lands on, snapped to `snapTicks` (none when 0 or `free`), inside the roll. */
export function ccTickAt(x: number, stepPx: number, ticksPerStep: number, totalTicks: number, snapTicks: number, free = false): number {
  if (!(stepPx > 0)) return 0;
  const raw = Math.max(0, Math.min(totalTicks, (x / stepPx) * ticksPerStep));
  if (free || !(snapTicks > 0)) return Math.round(raw);
  return Math.max(0, Math.min(totalTicks, Math.round(raw / snapTicks) * snapTicks));
}

/** The point within CC_GRAB_R of (x, y), the nearest one, or null. */
export function ccPointAt(points: readonly CcPoint[], x: number, y: number, geo: { stepPx: number; ticksPerStep: number; height: number }): CcPoint | null {
  let best: CcPoint | null = null;
  let bestD = CC_GRAB_R;
  for (const p of points) {
    const px = (p.tick / geo.ticksPerStep) * geo.stepPx;
    const py = ccValueToY(p.value, geo.height);
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/**
 * The SVG path of the controller across the roll: the start value until the
 * first change, then a flat run to each next change and a jump there, and the
 * last value held to the end, since a controller holds until it changes.
 */
export function ccPath(points: readonly CcPoint[], controller: number, geo: { stepPx: number; ticksPerStep: number; totalTicks: number; height: number }): string {
  const xOf = (tick: number) => (tick / geo.ticksPerStep) * geo.stepPx;
  let v = partController(controller)?.initial ?? 0;
  let d = `M0 ${ccValueToY(v, geo.height).toFixed(2)}`;
  for (const p of points) {
    const x = xOf(p.tick).toFixed(2);
    d += ` H${x} V${ccValueToY(p.value, geo.height).toFixed(2)}`;
    v = p.value;
  }
  d += ` H${xOf(geo.totalTicks).toFixed(2)}`;
  return d;
}

/**
 * Hardware CC recording into the lane: a change `value` of `controller` played
 * at `tick` goes in unless it repeats the value the controller already has
 * there, and replaces what the pass wrote since `sinceTick` (the tick of the
 * pass's last write), so a second pass over the same bars overwrites the first.
 */
export function recordCcPoint(points: readonly CcPoint[], controller: number, tick: number, value: number, sinceTick: number | null): CcPoint[] {
  const t = wholeTick(tick);
  const base = sinceTick === null ? points : points.filter((p) => p.tick <= sinceTick || p.tick > t);
  if (ccValueAt(base, t, controller) === clamp7(value)) return [...base];
  return setCcPoint(base, t, value);
}

/* ── A selected note's own expression, drawn in the same lane ───────────── */

/**
 * The lane's note targets: a selected note's pressure, timbre (CC 74) and
 * bend (PianoNote `expr`, lib/noteExpression), drawn over the note's span as
 * 0-127 like a controller (the bend with 64 its centre). They take numbers no
 * controller has, so the lane keeps one number for what it shows.
 */
export const NOTE_EXPRESSION_TARGETS: ReadonlyMap<number, ExpressionDimension> = new Map([
  [-1, 'pressure'],
  [-2, 'timbre'],
  [-3, 'pitchBend'],
]);

/** The note dimension a lane target names, or null for a controller. */
export const noteDimensionOf = (target: number): ExpressionDimension | null => NOTE_EXPRESSION_TARGETS.get(target) ?? null;

/** The lane's label for a note target. */
export const NOTE_TARGET_LABELS: Readonly<Record<ExpressionDimension, string>> = Object.freeze({
  pressure: 'Note pressure',
  timbre: 'Note timbre (74)',
  pitchBend: 'Note bend',
});

/** A dimension's value (0..1, the bend -1..1) as the lane's 0-127. */
export const dimensionToCc = (dim: ExpressionDimension, v: number): number =>
  Math.max(0, Math.min(127, Math.round(dim === 'pitchBend' ? (v + 1) * 63.5 : v * 127)));

/** The lane's 0-127 as a dimension's value; the bend's 64 is its centre. */
export const ccToDimension = (dim: ExpressionDimension, cc: number): number =>
  dim === 'pitchBend' ? (Math.round(cc) === 64 ? 0 : Math.max(-1, Math.min(1, cc / 63.5 - 1))) : Math.max(0, Math.min(1, cc / 127));

/** Where the lane rests for a dimension a note has not set: no pressure, timbre at its centre, no bend. */
export const dimensionRest = (dim: ExpressionDimension): number => (dim === 'pressure' ? 0 : 64);

/** A note's dimension as the lane's points, at the roll's ticks (its start value at its first tick). */
export function noteExpressionPoints(note: Pick<PianoNote, 'tick' | 'step' | 'expr'>, dim: ExpressionDimension): CcPoint[] {
  const start = note.tick ?? Math.round(note.step * 240);
  return dimensionPoints(note.expr, dim).map((p) => ({ tick: start + p.tick, value: dimensionToCc(dim, p.value) }));
}

/**
 * The note's expression with dimension `dim` set to the lane's `points`
 * (roll ticks): each held inside the note (from its first tick to its last),
 * the first at or before the note's start its start value. Undefined when the
 * note is left with none.
 */
export function withNoteExpressionPoints(
  note: Pick<PianoNote, 'tick' | 'step' | 'ticks' | 'length' | 'expr'>,
  dim: ExpressionDimension,
  points: readonly CcPoint[],
): NoteExpression | undefined {
  const start = note.tick ?? Math.round(note.step * 240);
  const span = Math.max(1, note.ticks ?? Math.round(note.length * 240));
  const rel = points.map((p) => ({ tick: Math.max(0, Math.min(span - 1, Math.round(p.tick - start))), value: ccToDimension(dim, p.value) }));
  return withDimensionPoints(note.expr, dim, rel);
}

/** The SVG path of a note's dimension: flat from the note's start at its first value, a step at each change, to the note's end. */
export function notePath(points: readonly CcPoint[], rest: number, span: { from: number; to: number }, geo: { stepPx: number; ticksPerStep: number; height: number }): string {
  const xOf = (tick: number) => (tick / geo.ticksPerStep) * geo.stepPx;
  let d = `M${xOf(span.from).toFixed(2)} ${ccValueToY(points[0]?.tick <= span.from ? points[0].value : rest, geo.height).toFixed(2)}`;
  for (const p of points) {
    if (p.tick <= span.from) continue;
    d += ` H${xOf(p.tick).toFixed(2)} V${ccValueToY(p.value, geo.height).toFixed(2)}`;
  }
  d += ` H${xOf(span.to).toFixed(2)}`;
  return d;
}
