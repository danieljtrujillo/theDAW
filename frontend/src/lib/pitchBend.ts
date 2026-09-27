/**
 * pitchBend — the piano roll's pitch bend, one curve per polymeter lane.
 *
 * A lane's bend is a list of points at step positions (16th notes, fractional
 * allowed) with a value from -1 to 1, and a range in semitones (2 unless set),
 * so a value of 1 raises the lane by `range` semitones. Before a lane's first
 * point the bend is 0; after its last point the last value holds. A point's
 * `shape` says how the curve travels to the next point: `linear` ramps,
 * `hold` keeps the value and jumps at the next point (what MIDI pitch wheel
 * messages do), `smooth` eases in and out.
 *
 * A MIDI pitch wheel bends a whole channel, so a lane with a bend exports on its
 * own channel (laneChannels) and plays through the live soundfont on its own
 * channel (liveLaneChannels). At most MAX_BENT_LANES lanes bend.
 *
 * A looping lane's bend loops with its notes: unrollBend writes its repeats out
 * the way unrollLanes writes out the notes.
 *
 * Everything here is pure, so node tests load it.
 */
import type { PolyLane } from './meterMap';

export type BendShape = 'linear' | 'hold' | 'smooth';

export interface BendPoint {
  id: string;
  /** Step position (16th notes from 0), fractional allowed. */
  step: number;
  /** -1 to 1; 1 is the lane's full range up. */
  value: number;
  /** How the curve travels from this point to the next one. */
  shape: BendShape;
}

/** A point as an action or a file hands it in: no id and no shape are both fine. */
export interface BendPointInput {
  id?: string;
  step: number;
  value: number;
  shape?: BendShape;
}

export interface LaneBend {
  /** The polymeter lane id this curve bends. */
  lane: number;
  /** Semitones a value of 1 raises the lane (MIDI RPN 0/0). */
  range: number;
  /** Sorted by step, one point per step. */
  points: BendPoint[];
}

/** A lane's curve as it plays: its range and its points written out across the roll. */
export interface PlayedBend {
  range: number;
  points: BendPoint[];
}

/** One automation event for a sounding voice, in cents: `ramp` false sets the value at `step`, true ramps linearly to it. */
export interface BendAutomationEvent {
  step: number;
  cents: number;
  ramp: boolean;
}

/** One MIDI pitch wheel message at a step: raw 0-16383, 8192 is the centre. */
export interface WheelEvent {
  step: number;
  raw: number;
}

export const DEFAULT_BEND_RANGE = 2;
export const MAX_BEND_RANGE = 48;
export const BEND_CENTER = 8192;
export const BEND_MAX_RAW = 16383;
/** How far (as a value, -1 to 1) a simplified curve may stray from the one it replaces. */
export const BEND_SIMPLIFY_TOLERANCE = 0.02;
/** Cents a ramp moves between two wheel messages: 128 wheel positions at a range of 2 semitones. */
export const WHEEL_STEP_CENTS = 3.125;
/** Cents an imported curve may stray from the wheel messages it is read from (bendImportTolerance). */
export const BEND_IMPORT_CENTS = 3;
/** Linear pieces a `smooth` segment is scheduled as on a Web Audio parameter. */
export const SMOOTH_SEGMENTS = 16;
/** The furthest step a bend point may sit at (the roll's longest grid). */
export const MAX_BEND_STEP = 4096;
/** MIDI channels a file gives lanes, in the order lanes take them. Zero-based channel 9 (MIDI channel 10, General MIDI drums) is skipped. */
export const BEND_CHANNELS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
/**
 * Live soundfont channels the roll plays its lanes on, in the order lanes take
 * them: from 14 down, past the drum channel 9, so the arpeggiator keeps 15.
 * These are channels of the preview synth. EDIT's live MIDI plays on synths of
 * its own (lib/editChannels), so it never shares one with a lane.
 */
export const LIVE_ROLL_CHANNELS: readonly number[] = Object.freeze([14, 13, 12, 11, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
/** The live soundfont channel the arpeggiator plays and bends on. No roll lane takes it. */
export const ARP_LIVE_CHANNEL = 15;
/**
 * The live soundfont channel a hardware keyboard sounds on (lib/keyboardMonitor):
 * a seventeenth channel the preview synth adds for it, so no lane, the
 * arpeggiator or a preview changes its program under a held note. It shares
 * channel 0's dry output, and both play to the engine master.
 */
export const KEYBOARD_LIVE_CHANNEL = 16;
/**
 * The live soundfont channels DRAW's soundfont mode plays its strokes on, one
 * after another: eight more channels the preview synth adds past the keyboard's,
 * none a drum channel (SpessaSynth makes every channel n with n % 16 === 9 a
 * drum channel), so a stroke never plays a kit and never takes a roll lane's,
 * the arpeggiator's or the keyboard's channel.
 */
export const DRAW_LIVE_CHANNELS: readonly number[] = Object.freeze([17, 18, 19, 20, 21, 22, 23, 24]);
/** How many channels the preview synth has: 0-15, the keyboard's and DRAW's. */
export const PREVIEW_CHANNEL_COUNT = DRAW_LIVE_CHANNELS[DRAW_LIVE_CHANNELS.length - 1] + 1;
/** The channel DRAW's `stroke`-th soundfont stroke (counting from 0) plays on. */
export const drawStrokeChannel = (stroke: number): number =>
  DRAW_LIVE_CHANNELS[((Math.round(stroke) % DRAW_LIVE_CHANNELS.length) + DRAW_LIVE_CHANNELS.length) % DRAW_LIVE_CHANNELS.length];
/**
 * The most lanes that bend. Each takes a channel of its own and every other lane
 * shares one, so the roll's lanes fit LIVE_ROLL_CHANNELS on the live synth as
 * they fit BEND_CHANNELS in a file.
 */
export const MAX_BENT_LANES = LIVE_ROLL_CHANNELS.length - 1;

const EPS = 1e-9;
const SHAPES: readonly BendShape[] = ['linear', 'hold', 'smooth'];

/** Wheel positions a ramp moves between two messages at `range` semitones: WHEEL_STEP_CENTS of pitch, 128 at a range of 2. */
export const wheelRawStep = (range: number): number =>
  range > 0 ? Math.max(1, Math.min(BEND_CENTER, Math.floor((BEND_CENTER * WHEEL_STEP_CENTS) / (range * 100) + EPS))) : BEND_CENTER;

/** How far (as a value) a curve imported at `range` semitones may stray from the wheel messages it is read from: BEND_IMPORT_CENTS. */
export const bendImportTolerance = (range: number): number => (range > 0 ? BEND_IMPORT_CENTS / (range * 100) : BEND_SIMPLIFY_TOLERANCE);

/**
 * How much further (as a value) the stair before a wheel message may sit from
 * an imported line at `range` semitones: one message's move along a ramp
 * (wheelRawStep) and its rounding. The stairs a ramp is sent as then read back
 * as that ramp, and the line still passes within bendImportTolerance of every message.
 */
export const bendStairAllowance = (range: number): number => (wheelRawStep(range) + 2) / BEND_CENTER;

export const clampBendValue = (value: number): number => (Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0);

/** 0 to 48 semitones to the cent; anything that is not a number is the default 2. */
export const clampBendRange = (semitones: number): number =>
  Number.isFinite(semitones) ? Math.max(0, Math.min(MAX_BEND_RANGE, Math.round(semitones * 100) / 100)) : DEFAULT_BEND_RANGE;

export const clampBendStep = (step: number): number => (Number.isFinite(step) ? Math.max(0, Math.min(MAX_BEND_STEP, step)) : 0);

const shapeOf = (shape: unknown): BendShape => ((SHAPES as readonly unknown[]).includes(shape) ? (shape as BendShape) : 'linear');

/**
 * Sorted by step, one point per step (the later one in the list wins), steps 0
 * to 4096, values -1 to 1, a shape on every point. A point with no id, or an id
 * already taken, gets `<idPrefix>-<index>`.
 */
export function sanitizeBendPoints(points: readonly Partial<BendPointInput>[] | null | undefined, idPrefix = 'bp'): BendPoint[] {
  const byStep = new Map<number, BendPoint>();
  const ids = new Set<string>();
  let index = 0;
  for (const p of points ?? []) {
    index += 1;
    if (!p || typeof p.step !== 'number' || !Number.isFinite(p.step) || typeof p.value !== 'number') continue;
    const step = clampBendStep(p.step);
    const key = Math.round(step * 1e6);
    const prior = byStep.get(key);
    if (prior) ids.delete(prior.id);
    let id = typeof p.id === 'string' && p.id ? p.id : `${idPrefix}-${index - 1}`;
    while (ids.has(id)) id = `${id}'`;
    ids.add(id);
    byStep.set(key, { id, step, value: clampBendValue(p.value), shape: shapeOf(p.shape) });
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

/** A lane's bend as a file or a caller hands it in: any field may be missing, and points may lack ids and shapes. */
export interface LaneBendInput {
  lane?: number;
  range?: number;
  points?: readonly Partial<BendPointInput>[] | null;
}

/**
 * One entry per lane (the later one wins), lanes sorted, ranges clamped, points
 * sanitized. An entry with no points and the default range says nothing, so it
 * is left out.
 */
export function sanitizeBends(bends: readonly (LaneBendInput | null | undefined)[] | null | undefined): LaneBend[] {
  const byLane = new Map<number, LaneBend>();
  for (const b of bends ?? []) {
    if (!b || typeof b.lane !== 'number' || !Number.isInteger(b.lane) || b.lane < 0) continue;
    byLane.set(b.lane, {
      lane: b.lane,
      range: clampBendRange(typeof b.range === 'number' ? b.range : DEFAULT_BEND_RANGE),
      points: sanitizeBendPoints(b.points, `bp${b.lane}`),
    });
  }
  return [...byLane.values()].filter((b) => b.points.length > 0 || b.range !== DEFAULT_BEND_RANGE).sort((a, b) => a.lane - b.lane);
}

/** A deep copy, for a bounce payload, a save or an export. */
export const copyBends = (bends: readonly LaneBend[]): LaneBend[] =>
  bends.map((b) => ({ lane: b.lane, range: b.range, points: b.points.map((p) => ({ ...p })) }));

/** Index of the last point at or before `step`, or -1 when `step` is before the first point. */
export function pointIndexAt(points: readonly BendPoint[], step: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].step <= step + EPS) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const ease = (shape: BendShape, t: number): number => (shape === 'smooth' ? (1 - Math.cos(Math.PI * t)) / 2 : shape === 'hold' ? 0 : t);

/** The value a fraction `t` (0-1) of the way from `p` to `q`. */
const segmentValue = (p: BendPoint, q: BendPoint, t: number): number => p.value + (q.value - p.value) * ease(p.shape, t);

/** The bend value (-1 to 1) at `step`. */
export function bendValueAt(points: readonly BendPoint[], step: number): number {
  const i = pointIndexAt(points, step);
  if (i < 0) return 0;
  const p = points[i];
  const q = points[i + 1];
  if (!q || p.shape === 'hold') return p.value;
  const span = q.step - p.step;
  if (span <= EPS) return q.value;
  return segmentValue(p, q, Math.min(1, Math.max(0, (step - p.step) / span)));
}

/** A value and a range as cents. */
export const bendCents = (value: number, range: number): number => value * range * 100;

/** A value as a 14-bit wheel position, 8192 positions to a full range: -1 is 0, 0 is 8192, and 1 is 16383, the top of the wheel. */
export const bendValueToRaw = (value: number): number =>
  Math.max(0, Math.min(BEND_MAX_RAW, Math.round(BEND_CENTER + clampBendValue(value) * BEND_CENTER)));

/**
 * A 14-bit wheel position as a value, 8192 positions to a full range, so
 * halves and quarters are exact; 16383 reads as 1. Every raw value comes back
 * from bendValueToRaw unchanged.
 */
export const bendRawToValue = (raw: number): number => {
  const r = Math.max(0, Math.min(BEND_MAX_RAW, Math.round(raw)));
  return r >= BEND_MAX_RAW ? 1 : (r - BEND_CENTER) / BEND_CENTER;
};

/**
 * True when a straight line from point `a` to point `j` follows the curve
 * through the points between within `tolerance`. A hold may arrive at the next
 * point `stairAllowance` further off: the stairs a ramp is sent as lag the ramp
 * by one message's move just before each message.
 */
function lineFits(points: readonly BendPoint[], a: number, j: number, tolerance: number, stairAllowance: number): boolean {
  const pa = points[a];
  const pj = points[j];
  const span = pj.step - pa.step;
  if (span <= EPS) return false;
  const line = (s: number) => pa.value + ((pj.value - pa.value) * (s - pa.step)) / span;
  for (let k = a + 1; k <= j; k += 1) {
    const p = points[k - 1];
    const q = points[k];
    const at = line(q.step);
    if (Math.abs(q.value - at) > tolerance) return false;
    // Arriving at q: a hold arrives at its own value and jumps; a ramp or ease arrives at q's, checked above.
    if (p.shape === 'hold' && Math.abs(p.value - at) > tolerance + stairAllowance) return false;
    if (p.shape === 'smooth') {
      for (const t of [0.25, 0.5, 0.75]) {
        if (Math.abs(segmentValue(p, q, t) - line(p.step + t * (q.step - p.step))) > tolerance) return false;
      }
    }
  }
  return true;
}

/** Longest run of points one simplified segment may replace, which bounds the work on a dense import. */
const SIMPLIFY_RUN = 512;

/**
 * Fewer points for the same curve: each run of points that a straight line
 * through its two ends follows within `tolerance` becomes that line (a hold's
 * arrival at the next point allowed `stairAllowance` more). A hold keeps its
 * jump, the first and last points stay, and ids stay with the points that are kept.
 */
export function simplifyBend(points: readonly BendPoint[], tolerance = BEND_SIMPLIFY_TOLERANCE, stairAllowance = 0): BendPoint[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => ({ ...p }));
  const out: BendPoint[] = [];
  let a = 0;
  while (a < n - 1) {
    let best = a + 1;
    for (let j = a + 2; j < n && j - a <= SIMPLIFY_RUN; j += 1) {
      if (lineFits(points, a, j, tolerance, stairAllowance)) best = j;
      else break;
    }
    out.push(best === a + 1 ? { ...points[a] } : { ...points[a], shape: 'linear' });
    a = best;
  }
  out.push({ ...points[n - 1] });
  return out;
}

/**
 * The same curve with fewer points: a ramp or an ease between two equal values
 * is a hold, and a hold that repeats the hold before it says nothing.
 */
export function mergeFlat(points: readonly BendPoint[]): BendPoint[] {
  const out: BendPoint[] = [];
  points.forEach((point, i) => {
    const p = { ...point };
    const next = points[i + 1];
    if (next && p.shape !== 'hold' && next.value === p.value) p.shape = 'hold';
    const prev = out[out.length - 1];
    if (prev && prev.shape === 'hold' && p.shape === 'hold' && prev.value === p.value) return;
    out.push(p);
  });
  return out;
}

/** The points without their leading centre holds, which say nothing: before its first point a curve is 0. */
export function trimLeadingCentre(points: readonly BendPoint[]): BendPoint[] {
  let i = 0;
  while (i < points.length && points[i].value === 0 && points[i].shape === 'hold') i += 1;
  return points.slice(i).map((p) => ({ ...p }));
}

/**
 * `local` (points inside one period, sorted; the last one may sit at the
 * period's end) repeated every `period` steps before `until`. Each repeat
 * starts where the curve starts (0 unless it has a point at 0). After a
 * repeat's last point the value holds until the period ends; a point at the
 * period's end is the value the repeat arrives at, and the next repeat starts
 * at that same step, so the written-out curve holds two points at that step
 * and the later one is in force from it. The first point at or past `until` is
 * kept, so a segment that crosses `until` keeps its course up to it. Repeats
 * after the first get the id `<id>~<k>`.
 */
export function repeatBend(local: readonly BendPoint[], period: number, until: number): BendPoint[] {
  const out: BendPoint[] = [];
  if (!local.length || !(period > 0)) return out;
  const startValue = bendValueAt(local, 0);
  for (let k = 0; k * period < until - EPS; k += 1) {
    const base = k * period;
    if (k > 0 && out.length) {
      out[out.length - 1] = { ...out[out.length - 1], shape: 'hold' };
      if (local[0].step > EPS) out.push({ id: `${local[0].id}~seam${k}`, step: base, value: startValue, shape: 'hold' });
    }
    for (const p of local) {
      const step = base + p.step;
      out.push({ ...p, id: k === 0 ? p.id : `${p.id}~${k}`, step });
      if (step >= until - EPS) break;
    }
  }
  return out;
}

/**
 * A lane's curve across the roll. A lane that loops (a cycle shorter than the
 * roll) plays one cycle's curve every cycle: a point inside the cycle keeps its
 * step, a point at the cycle's length ends the cycle (a ramp drawn across the
 * cycle arrives there before the next cycle starts over), and a point past the
 * cycle wraps into it as unrollLanes wraps notes, the later point winning a
 * step. A lane that does not loop keeps its points.
 */
export function unrollBend(points: readonly BendPoint[], cycleSteps: number | null | undefined, totalSteps: number): BendPoint[] {
  const cyc = cycleSteps;
  if (!points.length || !cyc || cyc <= 0 || cyc >= totalSteps) return points.map((p) => ({ ...p }));
  const atEnd = (p: BendPoint) => Math.abs(p.step - cyc) <= EPS;
  const local = sanitizeBendPoints(points.filter((p) => !atEnd(p)).map((p) => ({ ...p, step: ((p.step % cyc) + cyc) % cyc })));
  const end = points.filter(atEnd).pop();
  if (end) local.push({ ...end, step: cyc, shape: 'hold' });
  return repeatBend(local, cyc, totalSteps);
}

/**
 * The curve up to `end`: its points before `end`, and when a ramp or an ease
 * runs on to `end` or past it, a hold at `end` with the value it arrives at
 * there. A hold, or a last point before `end`, already keeps its value to `end`.
 */
export function cutBend(points: readonly BendPoint[], end: number): BendPoint[] {
  let i = points.length - 1;
  while (i >= 0 && points[i].step >= end - EPS) i -= 1;
  const out = points.slice(0, i + 1).map((p) => ({ ...p }));
  const p = points[i];
  const q = points[i + 1];
  if (p && q && p.shape !== 'hold') {
    const t = Math.min(1, (end - p.step) / (q.step - p.step));
    out.push({ id: `${p.id}~end`, step: end, value: segmentValue(p, q, t), shape: 'hold' });
  }
  return out;
}

const lapCache = new WeakMap<readonly BendPoint[], Map<string, BendPoint[]>>();

/**
 * A played curve that starts over every `period` steps (the roll looping),
 * written out for `laps` periods. Each period plays the curve up to `period`
 * (cutBend), so a ramp that ends on the roll's end or runs past it keeps its
 * course up to the loop. Cached per points list.
 */
export function loopBend(points: readonly BendPoint[], period: number, laps: number): BendPoint[] {
  const key = `${period}:${laps}`;
  let byKey = lapCache.get(points);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const out = repeatBend(cutBend(points, period), period, period * laps);
  if (!byKey) {
    byKey = new Map();
    lapCache.set(points, byKey);
  }
  byKey.set(key, out);
  return out;
}

/**
 * The curve re-based so `from` is its step 0, for the roll's transport looping
 * a range that starts at `from`: the points after `from` moved back by `from`,
 * led by a point at 0 where the curve is at `from`. The segment `from` falls
 * inside keeps its course: a hold and a ramp carry on exactly, and an ease
 * carries on as straight pieces at its own SMOOTH_SEGMENTS divisions (the ones
 * bendAutomation plays an ease with). A `from` at or before 0 gives a copy.
 */
export function shiftBend(points: readonly BendPoint[], from: number): BendPoint[] {
  if (!(from > EPS) || !points.length) return points.map((p) => ({ ...p }));
  const i = pointIndexAt(points, from);
  const p = i >= 0 ? points[i] : null;
  const q = points[i + 1];
  const onPoint = !!p && Math.abs(p.step - from) <= EPS;
  const out: BendPoint[] = [];
  if (!p) {
    // Before the first point the curve is at the centre until that point.
    out.push({ id: `${points[0].id}~from`, step: 0, value: 0, shape: 'hold' });
  } else if (!onPoint) {
    if (!q || p.shape === 'hold') out.push({ id: `${p.id}~from`, step: 0, value: p.value, shape: 'hold' });
    else {
      out.push({ id: `${p.id}~from`, step: 0, value: bendValueAt(points, from), shape: 'linear' });
      if (p.shape === 'smooth') {
        for (let m = 1; m < SMOOTH_SEGMENTS; m += 1) {
          const s = p.step + ((q.step - p.step) * m) / SMOOTH_SEGMENTS;
          if (s <= from + EPS) continue;
          out.push({ id: `${p.id}~from${m}`, step: s - from, value: segmentValue(p, q, m / SMOOTH_SEGMENTS), shape: 'linear' });
        }
      }
    }
  }
  for (let j = onPoint ? i : i + 1; j < points.length; j += 1) out.push({ ...points[j], step: points[j].step - from });
  return out;
}

/** Each lane's played curve re-based so `from` is its step 0 (shiftBend); a `from` at or before 0 gives `played` itself. */
export function shiftPlayedBends(played: Map<number, PlayedBend>, from: number): Map<number, PlayedBend> {
  if (!(from > EPS)) return played;
  return new Map([...played].map(([lane, c]) => [lane, { range: c.range, points: shiftBend(c.points, from) }]));
}

/** The lane a note plays in: its own when the roll has that lane, else lane 0 (unrollLanes plays such a note as lane 0). */
export const playingLane = (lane: number | undefined, lanes: readonly PolyLane[]): number =>
  lane !== undefined && lanes.some((l) => l.id === lane) ? lane : 0;

/** The ids of the lanes that bend: lanes the roll has with points, in lane order, at most MAX_BENT_LANES of them. */
export function bentLanes(lanes: readonly PolyLane[], bends: readonly LaneBend[]): Set<number> {
  const withPoints = new Set(bends.filter((b) => b.points.length > 0).map((b) => b.lane));
  const ids = lanes.map((l) => l.id).filter((id) => withPoints.has(id));
  return new Set(ids.sort((a, b) => a - b).slice(0, MAX_BENT_LANES));
}

/** `bends` with points only on the lanes that may bend (bentLanes): a lane past MAX_BENT_LANES keeps its range and loses its points. */
export function capBentLanes(bends: readonly LaneBend[], lanes: readonly PolyLane[]): LaneBend[] {
  const bent = bentLanes(lanes, bends);
  return sanitizeBends(bends.map((b) => (b.points.length && !bent.has(b.lane) ? { ...b, points: [] } : b)));
}

/** Each lane's curve as the roll plays it, by lane id: only the lanes that bend (bentLanes). */
export function playedRollBends(bends: readonly LaneBend[], lanes: readonly PolyLane[], totalSteps: number): Map<number, PlayedBend> {
  const cycles = new Map(lanes.map((l) => [l.id, l.cycleSteps]));
  const bent = bentLanes(lanes, bends);
  const out = new Map<number, PlayedBend>();
  for (const b of bends) {
    if (!bent.has(b.lane)) continue;
    out.set(b.lane, { range: b.range, points: unrollBend(b.points, cycles.get(b.lane), totalSteps) });
  }
  return out;
}

/**
 * The MIDI channel each lane exports and renders on. A pitch wheel bends a
 * whole channel, so each lane that bends (bentLanes) takes its own channel, in
 * lane order; every other lane shares one channel, the first one any of them
 * takes. With no bend points at all every lane is on channel 0.
 */
export function laneChannels(lanes: readonly PolyLane[], bends: readonly LaneBend[]): Map<number, number> {
  const bent = bentLanes(lanes, bends);
  const out = new Map<number, number>();
  let next = 0;
  let shared: number | null = null;
  const take = () => BEND_CHANNELS[Math.min(next++, BEND_CHANNELS.length - 1)];
  for (const l of [...lanes].sort((a, b) => a.id - b.id)) {
    if (bent.has(l.id)) out.set(l.id, take());
    else {
      if (shared === null) shared = take();
      out.set(l.id, shared);
    }
  }
  return out;
}

/** The live soundfont channel each lane plays on: its file channel (laneChannels) moved to the same place in LIVE_ROLL_CHANNELS. */
export function liveLaneChannels(lanes: readonly PolyLane[], bends: readonly LaneBend[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const [lane, ch] of laneChannels(lanes, bends)) {
    const index = Math.min(Math.max(0, BEND_CHANNELS.indexOf(ch)), LIVE_ROLL_CHANNELS.length - 1);
    out.set(lane, LIVE_ROLL_CHANNELS[index]);
  }
  return out;
}

/** What a render or a live player needs to bend the roll: each lane's played curve, the lanes, and each lane's channel. */
export interface RollRenderBends {
  played: Map<number, PlayedBend>;
  lanes: PolyLane[];
  channels: Map<number, number>;
}

/** The roll's bends for a render, or undefined when no lane has a point. */
export function rollRenderBends(bends: readonly LaneBend[], lanes: readonly PolyLane[], totalSteps: number): RollRenderBends | undefined {
  const played = playedRollBends(bends, lanes, totalSteps);
  if (!played.size) return undefined;
  return { played, lanes: lanes.map((l) => ({ ...l })), channels: laneChannels(lanes, bends) };
}

/**
 * The automation that makes a voice follow `points` from `from` to `to`: a set
 * at `from`, then a set at each hold's jump and a ramp to each point a ramp
 * reaches, with a smooth segment as SMOOTH_SEGMENTS ramps, and a ramp to `to`
 * when `to` falls inside a ramp or an ease.
 */
export function bendAutomation(points: readonly BendPoint[], range: number, from: number, to: number): BendAutomationEvent[] {
  const cents = (v: number) => bendCents(v, range);
  const out: BendAutomationEvent[] = [{ step: from, cents: cents(bendValueAt(points, from)), ramp: false }];
  if (!points.length || !(to > from)) return out;
  const smooth = (p: BendPoint, q: BendPoint, until: number) => {
    for (let m = 1; m <= SMOOTH_SEGMENTS; m += 1) {
      const s = p.step + ((q.step - p.step) * m) / SMOOTH_SEGMENTS;
      if (s <= from + EPS) continue;
      if (s >= until - EPS) break;
      out.push({ step: s, cents: cents(segmentValue(p, q, m / SMOOTH_SEGMENTS)), ramp: true });
    }
  };
  let j = pointIndexAt(points, from) + 1;
  for (; j < points.length && points[j].step <= to + EPS; j += 1) {
    const q = points[j];
    const p = j > 0 ? points[j - 1] : null;
    if (!p || p.shape === 'hold') out.push({ step: q.step, cents: cents(q.value), ramp: false });
    else {
      if (p.shape === 'smooth') smooth(p, q, q.step);
      out.push({ step: q.step, cents: cents(q.value), ramp: true });
    }
  }
  // `to` inside a segment that moves: ramp on to where the curve is at `to`.
  if (j > 0 && j < points.length) {
    const p = points[j - 1];
    if (p.shape !== 'hold' && p.step < to - EPS) {
      if (p.shape === 'smooth') smooth(p, points[j], to);
      out.push({ step: to, cents: cents(bendValueAt(points, to)), ramp: true });
    }
  }
  return out;
}

/**
 * The automation for a voice on a curve that starts over every `period` steps
 * (the roll or the arpeggiator looping): `from` is taken modulo the period and
 * the window runs `span` steps, across the loop when it reaches past it.
 * `originStep` is where `from` sits on the returned events' steps.
 */
export function loopedBendAutomation(
  played: PlayedBend,
  period: number,
  from: number,
  span: number,
): { events: BendAutomationEvent[]; originStep: number } {
  const origin = period > 0 ? ((from % period) + period) % period : from;
  const laps = period > 0 ? Math.min(64, Math.ceil((origin + Math.max(0, span)) / period) + 1) : 1;
  const points = period > 0 ? loopBend(played.points, period, laps) : played.points;
  return { events: bendAutomation(points, played.range, origin, origin + Math.max(0, span)), originStep: origin };
}

/** True when the automation never leaves 0 cents, so a voice can skip it. */
export const bendAutomationIsFlat = (events: readonly BendAutomationEvent[]): boolean => events.every((e) => Math.abs(e.cents) < 1e-6);

/**
 * The wheel messages that play `points` at `range` semitones over (`from`,
 * `to`], and at `from` too when `includeFrom`: one at each point, and along a
 * ramp or an ease one every wheelRawStep(range) of change (WHEEL_STEP_CENTS of
 * pitch), at fixed places in the segment, so back-to-back windows send the
 * messages one window over the same span would. A message that repeats the one
 * before it in the window is left out, except at a point, where the curve may
 * turn and the message marks the step it turns at. A message at the step of the
 * one before it replaces it (a jump sends where the curve goes, not where it arrived).
 * With a `grid` (in steps, a file's tick), a ramp's or an ease's messages sit on
 * its multiples, each with the curve's value there, so a file's stairs lie on the curve.
 */
export function bendWheelEvents(
  points: readonly BendPoint[],
  from: number,
  to: number,
  includeFrom = true,
  range = DEFAULT_BEND_RANGE,
  grid = 0,
): WheelEvent[] {
  const out: WheelEvent[] = [];
  const rawStep = wheelRawStep(range);
  const push = (step: number, value: number, atPoint = false) => {
    const raw = bendValueToRaw(value);
    if (out.length && Math.abs(out[out.length - 1].step - step) <= EPS) out.pop();
    if (!atPoint && out.length && out[out.length - 1].raw === raw) return;
    out.push({ step, raw });
  };
  if (includeFrom) push(from, bendValueAt(points, from));
  const inside = (s: number) => s > from + EPS && s <= to + EPS;
  for (let i = Math.max(0, pointIndexAt(points, from)); i < points.length; i += 1) {
    const p = points[i];
    if (p.step > to + EPS) break;
    if (inside(p.step)) push(p.step, p.value, true);
    const q = points[i + 1];
    if (!q || p.shape === 'hold' || q.step <= from + EPS) continue;
    const delta = Math.abs(bendValueToRaw(q.value) - bendValueToRaw(p.value));
    const n = Math.max(1, Math.ceil((p.shape === 'smooth' ? (delta * Math.PI) / 2 : delta) / rawStep));
    for (let m = 1; m < n; m += 1) {
      let s = p.step + ((q.step - p.step) * m) / n;
      if (grid > 0) {
        s = Math.round(s / grid) * grid;
        if (s <= p.step + EPS || s >= q.step - EPS) continue;
      }
      if (s > to + EPS) break;
      if (inside(s)) push(s, segmentValue(p, q, (s - p.step) / (q.step - p.step)));
    }
  }
  return out;
}

/**
 * Wheel messages at `range` semitones over absolute steps (`from`, `to`] for a
 * curve that starts over every `period` steps, `abs` counted from the start of
 * the first lap. Each lap sends the messages bendWheelEvents sends for the
 * curve before `period`, a ramp that ends on the loop or runs past it included;
 * each lap's start sends where the curve starts, which overtakes a message at
 * the lap's end, and `from` itself is sent when `includeFrom`.
 */
export function loopedWheelEvents(
  points: readonly BendPoint[],
  period: number,
  from: number,
  to: number,
  includeFrom: boolean,
  range = DEFAULT_BEND_RANGE,
): Array<{ abs: number; raw: number }> {
  const out: Array<{ abs: number; raw: number }> = [];
  if (!(period > 0) || to < from) return out;
  let lap = Math.floor(from / period + EPS);
  let lapFrom = Math.max(0, from - lap * period);
  let include = includeFrom || lapFrom <= EPS;
  while (lap * period <= to + EPS) {
    const lapTo = Math.min(period, to - lap * period);
    if (lapTo >= lapFrom - EPS) {
      for (const e of bendWheelEvents(points, lapFrom, lapTo, include, range)) {
        if (e.step < period - EPS) out.push({ abs: lap * period + e.step, raw: e.raw });
      }
    }
    lap += 1;
    lapFrom = 0;
    include = true;
    if (lap * period > to - EPS) break;
  }
  return out;
}

/**
 * A channel's wheel messages as a curve: each message holds until the next,
 * runs of small steps become ramps (simplifyBend within `tolerance` and
 * `stairAllowance`: bendImportTolerance and bendStairAllowance of the curve's
 * range keep it to 3 cents of the messages at any range), repeats merge
 * (mergeFlat; a repeat before a ramp stays, marking where the ramp starts),
 * then a leading centre hold is dropped (a centre that starts a ramp stays).
 * Ids are `<idPrefix>-<index>`.
 */
export function wheelEventsToBendPoints(
  events: readonly WheelEvent[],
  idPrefix = 'bp',
  tolerance = BEND_SIMPLIFY_TOLERANCE,
  stairAllowance = 0,
): BendPoint[] {
  const holds = sanitizeBendPoints(
    events.map((e) => ({ step: e.step, value: bendRawToValue(e.raw), shape: 'hold' as const })),
    idPrefix,
  );
  return trimLeadingCentre(mergeFlat(simplifyBend(holds, tolerance, stairAllowance))).map((p, i) => ({ ...p, id: `${idPrefix}-${i}` }));
}
