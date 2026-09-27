/**
 * rollSnap — the piano roll's snap grid, in ticks, and the editing gestures
 * that land on it: a click that adds a note, a drag that moves the selection,
 * a resize, an arrow nudge, the note menu's steps, a paste's landing, and
 * TUPLET, which respaces selected notes N in the time of M.
 *
 * The grid is measured from each bar's accents: its group starts (7/8 3+2+2
 * restarts the grid on 8ths 1, 4 and 6), a compound meter's dotted beats, or
 * the bar line. A triplet or a quintuplet therefore restarts on every group
 * and never drifts across a bar of 7/8 or 11/16, and a /32 bar that starts on
 * a half step keeps its grid on its own bar line. A pickup counts its grid back
 * from bar 1, as its beats do. The GROUP snap puts one cell on each pulse
 * (meterMap pulseLines): the groups, the dotted beats, or the beats.
 *
 * Positions are ticks at the note model's PPQ (960 to the quarter), whole, so a
 * quintuplet 16th is 192 ticks and lands exactly; a septuplet cell is 960/7
 * and each line is rounded from its group start, never accumulated.
 *
 * A lane with its own time (meterMap laneTimeOf: a meter of its own, a tuplet
 * ratio) has its own grid, laneSnapGrid: the same lines in the lane's bars,
 * scaled into the roll's ticks, so a 3:2 lane snaps to its own triplet beats.
 *
 * APPLY lands on the same grid (feelNoteTicks): a start moves toward the
 * nearest line and a length toward a whole number of cells, so a quintuplet
 * snap keeps quintuplets.
 *
 * Everything here is pure: the roll's component calls it with pixels, and the
 * node tests replay the same calls.
 */
import { accentLines, bars, pulseLines, stepsPerBar, type LaneTime, type MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import type { PianoNote } from '../state/pianoRollStore';

/** Ticks in one of the roll's steps (a 16th). */
export const TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

export type RollSnapId = '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/8T' | '1/16T' | '1/16Q' | '1/16S' | '1/8D' | 'group';

export interface RollSnapDef {
  id: RollSnapId;
  /** The select's text. */
  label: string;
  /** What the grid is, in words. */
  title: string;
  /** `count` cells fill `span` ticks (a triplet 8th: 3 in 960). 0 for GROUP, whose cells are the pulses. */
  span: number;
  count: number;
  /** The straight note TUPLET counts M of: a 16th for the 16th-based grids. */
  unit: number;
  /** Ticks a click draws, when it is not one cell (the 1/16 grid's click has always drawn an 8th). */
  draw?: number;
}

const Q = PPQ;

/** The snap select's choices, in the order it lists them. */
export const ROLL_SNAPS: readonly RollSnapDef[] = [
  { id: '1/4', label: '1/4', title: 'Quarter notes', span: Q, count: 1, unit: Q },
  { id: '1/8', label: '1/8', title: 'Eighth notes', span: Q / 2, count: 1, unit: Q / 2 },
  { id: '1/16', label: '1/16', title: 'Sixteenth notes; a click draws an eighth', span: Q / 4, count: 1, unit: Q / 4, draw: Q / 2 },
  { id: '1/32', label: '1/32', title: 'Thirty-second notes', span: Q / 8, count: 1, unit: Q / 8 },
  { id: '1/64', label: '1/64', title: 'Sixty-fourth notes', span: Q / 16, count: 1, unit: Q / 16 },
  { id: '1/8T', label: '1/8 triplet', title: 'Eighth-note triplets: three in a quarter', span: Q, count: 3, unit: Q / 2 },
  { id: '1/16T', label: '1/16 triplet', title: 'Sixteenth-note triplets: three in an eighth', span: Q / 2, count: 3, unit: Q / 4 },
  { id: '1/16Q', label: 'Quintuplet', title: 'Quintuplet sixteenths: five in a quarter', span: Q, count: 5, unit: Q / 4 },
  { id: '1/16S', label: 'Septuplet', title: 'Septuplet sixteenths: seven in a quarter', span: Q, count: 7, unit: Q / 4 },
  { id: '1/8D', label: 'Dotted 1/8', title: 'Dotted eighths: three sixteenths each', span: (3 * Q) / 4, count: 1, unit: Q / 2 },
  { id: 'group', label: 'Meter group', title: "The bar's groups (3+2+2), or its dotted beats, or its beats", span: 0, count: 1, unit: Q / 2 },
];

export const DEFAULT_ROLL_SNAP: RollSnapId = '1/16';

export const isRollSnapId = (v: unknown): v is RollSnapId => typeof v === 'string' && ROLL_SNAPS.some((d) => d.id === v);

export const rollSnapDef = (id: RollSnapId): RollSnapDef => ROLL_SNAPS.find((d) => d.id === id) ?? ROLL_SNAPS[2];

/** Ticks in one cell of a def with a fixed cell (GROUP has none). */
export const cellTicks = (def: RollSnapDef): number => (def.span > 0 ? def.span / def.count : 0);

export interface SnapGrid {
  def: RollSnapDef;
  /** Every line in ticks, sorted and unique: 0, each cell, and the roll's end. */
  lines: number[];
  /** The roll's end in ticks. */
  end: number;
  /** Roll ticks per tick of the grid's own time: 1 for the roll, m/n for a lane with a tuplet ratio. */
  scale?: number;
}

const toTick = (step: number): number => Math.round(step * TICKS_PER_STEP);

/** Lines from `from` to `to` (ticks) `def`'s cells apart, the first on `from`, or counted back from `to` for a pickup. */
function rangeLines(from: number, to: number, def: RollSnapDef, back: boolean, out: number[]): void {
  out.push(from, to);
  const len = to - from;
  if (def.span <= 0 || len <= 0) return;
  for (let k = 1; ; k += 1) {
    const off = Math.round((k * def.span) / def.count);
    if (off >= len) break;
    out.push(back ? to - off : from + off);
  }
}

/**
 * The grid of `snap` over a roll of `totalSteps` steps in `map` with its
 * pickup. The lines restart at every accent of every bar (see the module note).
 */
export function snapGrid(map: readonly MeterSegment[], pickupSteps: number, totalSteps: number, snap: RollSnapId): SnapGrid {
  const def = rollSnapDef(snap);
  const end = toTick(Math.max(0, totalSteps));
  const raw: number[] = [0, end];
  for (const b of bars(map, totalSteps, pickupSteps)) {
    const start = toTick(b.start);
    const stop = toTick(b.start + b.len);
    if (b.bar < 0) {
      // The pickup is the end of a bar: its grid counts back from bar 1.
      if (def.span > 0) rangeLines(start, stop, def, true, raw);
      else {
        const phase = b.len - stepsPerBar(b.meter);
        raw.push(start, stop);
        for (const p of pulseLines(b.meter)) if (p + phase > 0) raw.push(toTick(b.start + p + phase));
      }
      continue;
    }
    const anchors = (def.span > 0 ? accentLines(b.meter) : pulseLines(b.meter)).map((a) => toTick(b.start + a));
    anchors.forEach((a, i) => rangeLines(a, i + 1 < anchors.length ? anchors[i + 1] : stop, def, false, raw));
  }
  const kept = raw.filter((t) => t >= 0 && t <= end).sort((a, b) => a - b);
  const lines: number[] = [];
  for (const t of kept) if (!lines.length || t !== lines[lines.length - 1]) lines.push(t);
  return { def, lines, end };
}

/**
 * The grid of `snap` in a lane's own time (meterMap laneTimeOf) over a roll of
 * `totalSteps` steps: snapGrid in the lane's bars, each line scaled into roll
 * ticks and rounded from its own place, so a 3:2 lane's lines never drift. The
 * roll's start and end stay lines.
 */
export function laneSnapGrid(lt: LaneTime, totalSteps: number, snap: RollSnapId): SnapGrid {
  const inner = snapGrid(lt.map, lt.pickup, Math.max(0, totalSteps) / lt.scale, snap);
  const end = toTick(Math.max(0, totalSteps));
  const scaled = inner.lines.map((t) => Math.min(end, Math.round(t * lt.scale)));
  scaled.push(0, end);
  scaled.sort((a, b) => a - b);
  const lines: number[] = [];
  for (const t of scaled) if (!lines.length || t !== lines[lines.length - 1]) lines.push(t);
  return { def: inner.def, lines, end, scale: lt.scale };
}

/** Index of the last line at or before `tick` (0 when `tick` is before the first). */
function floorIndex(lines: readonly number[], tick: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  if (tick >= lines[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid] <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The last line at or before `tick`. */
export const floorLine = (g: SnapGrid, tick: number): number => g.lines[floorIndex(g.lines, tick)];

/** The line nearest `tick`; a tie goes to the earlier one. */
export function nearestLine(g: SnapGrid, tick: number): number {
  const i = floorIndex(g.lines, tick);
  const a = g.lines[i];
  const b = g.lines[Math.min(g.lines.length - 1, i + 1)];
  return tick - a <= b - tick ? a : b;
}

/** The first line after `tick` (dir 1) or before it (dir -1); null past either end of the roll. */
export function nextLine(g: SnapGrid, tick: number, dir: -1 | 1): number | null {
  const i = floorIndex(g.lines, tick);
  if (dir > 0) return i + 1 < g.lines.length ? g.lines[i + 1] : null;
  const onLine = g.lines[i] === tick;
  const j = onLine ? i - 1 : i;
  return j >= 0 && g.lines[j] < tick ? g.lines[j] : null;
}

/** The cell that holds `tick`: its start and the next line (the roll's end in the last cell). */
export function cellAt(g: SnapGrid, tick: number): { start: number; end: number } {
  const t = Math.max(0, Math.min(tick, g.end - 1));
  const start = floorLine(g, t);
  return { start, end: nextLine(g, start, 1) ?? g.end };
}

/** Grid x in pixels as ticks at `stepPx` pixels to the step. */
export const pxToTick = (x: number, stepPx: number): number => (x / stepPx) * TICKS_PER_STEP;

/* ── gestures ─────────────────────────────────────────────────────────────── */

/** A click on empty grid at `x` px: the cell it lands in, and a note one cell long (the 1/16 grid's eighth). Null off the roll. */
export function clickPlacement(g: SnapGrid, x: number, stepPx: number): { tick: number; ticks: number } | null {
  const tick = pxToTick(x, stepPx);
  if (!(tick >= 0) || tick >= g.end) return null;
  const cell = cellAt(g, tick);
  const draw = g.def.draw === undefined ? undefined : Math.round(g.def.draw * (g.scale ?? 1));
  return { tick: cell.start, ticks: Math.max(1, draw ?? cell.end - cell.start) };
}

/**
 * A resize drag: the note's end follows the pointer to the nearest line. It
 * stops one cell after the start, and a note already shorter than that cell
 * (a 32nd drawn on a 1/16 grid) keeps its length until the drag makes it longer.
 */
export function resizeTicks(g: SnapGrid, tick: number, initialTicks: number, dxPx: number, stepPx: number): number {
  const end = nearestLine(g, tick + initialTicks + pxToTick(dxPx, stepPx));
  const oneCell = (nextLine(g, tick, 1) ?? g.end) - tick;
  const snapped = end - tick;
  return Math.max(1, snapped >= oneCell ? snapped : Math.min(initialTicks, oneCell));
}

export interface NoteOrigin { id: string; tick: number; note: number }
export interface TimeUpdate { id: string; tick?: number; ticks?: number; note?: number }
export interface MoveBounds { endTick: number; lowestNote: number; highestNote: number }

/**
 * A drag of note bodies: `primary`'s start follows the pointer to the nearest
 * line and every note in `origins` moves by the same ticks, and by whole rows.
 * The block stops at the roll's edges as one, and a note already outside the
 * pitch range can still come back. Each call measures from the origins, so a
 * drag that comes back to where it started puts every note back.
 */
export function moveBlock(
  g: SnapGrid, origins: readonly NoteOrigin[], primaryId: string, dxPx: number, dyPx: number, stepPx: number, noteHeight: number,
  bounds: MoveBounds,
): TimeUpdate[] {
  const primary = origins.find((o) => o.id === primaryId) ?? origins[0];
  if (!primary) return [];
  let dt = nearestLine(g, primary.tick + pxToTick(dxPx, stepPx)) - primary.tick;
  let dn = -Math.round(dyPx / noteHeight);
  const minTick = Math.min(...origins.map((o) => o.tick));
  const maxTick = Math.max(...origins.map((o) => o.tick));
  const minNote = Math.min(...origins.map((o) => o.note));
  const maxNote = Math.max(...origins.map((o) => o.note));
  if (dt > 0) dt = Math.min(dt, Math.max(0, bounds.endTick - 1 - maxTick));
  else if (dt < 0) dt = Math.max(dt, Math.min(0, -minTick));
  const lo = Math.min(bounds.lowestNote, bounds.highestNote);
  const hi = Math.max(bounds.lowestNote, bounds.highestNote);
  if (dn > 0) dn = Math.min(dn, Math.max(0, hi - maxNote));
  else if (dn < 0) dn = Math.max(dn, Math.min(0, lo - minNote));
  return origins.map((o) => ({ id: o.id, tick: o.tick + dt, note: o.note + dn }));
}

/** An arrow nudge: the ticks that move `tick` `times` lines along, 0 at the roll's edge. */
export function nudgeTicks(g: SnapGrid, tick: number, dir: -1 | 1, times = 1): number {
  let at = tick;
  for (let i = 0; i < times; i += 1) {
    const next = nextLine(g, at, dir);
    if (next === null || next >= g.end) break;
    at = next;
  }
  return at - tick;
}

/** The note menu's Lengthen: the end to the next line; null at the roll's end. */
export function lengthenTicks(g: SnapGrid, n: { tick: number; ticks: number }): number | null {
  const next = nextLine(g, n.tick + n.ticks, 1);
  return next === null ? null : next - n.tick;
}

/** The note menu's Shorten: the end to the line before it; null when that line is the note's start or earlier. */
export function shortenTicks(g: SnapGrid, n: { tick: number; ticks: number }): number | null {
  const prev = nextLine(g, n.tick + n.ticks, -1);
  return prev === null || prev <= n.tick ? null : prev - n.tick;
}

/** The note menu's Nudge left / right: the start to the neighbouring line; null at the roll's edge. */
export function menuNudgeTick(g: SnapGrid, tick: number, dir: -1 | 1): number | null {
  const next = nextLine(g, tick, dir);
  return next === null || next >= g.end ? null : next;
}

/* ── APPLY ────────────────────────────────────────────────────────────────── */

/**
 * APPLY's quantize on grid `g` at strength `q` (0-1): the start moves toward
 * the nearest line, `q` of the way; the length moves toward a whole number of
 * the grid's cells (at least one), `q` of the way, so a quintuplet 16th stays a
 * quintuplet 16th on the quintuplet snap. On the GROUP snap, whose cells vary,
 * the end moves toward the nearest line after the new start. At 0 nothing
 * moves; lengths keep any size they had, a sub-cell one included.
 */
export function feelNoteTicks(g: SnapGrid, tick: number, ticks: number, q: number): { tick: number; ticks: number } {
  const s = Math.max(0, Math.min(1, Number.isFinite(q) ? q : 0));
  const start = Math.max(0, Math.round(tick + (nearestLine(g, tick) - tick) * s));
  const cell = cellTicks(g.def) * (g.scale ?? 1);
  let want: number;
  if (cell > 0) want = Math.max(1, Math.round(ticks / cell)) * cell;
  else {
    const snappedEnd = nearestLine(g, start + ticks);
    want = snappedEnd > start ? snappedEnd - start : (nextLine(g, start, 1) ?? g.end) - start;
  }
  return { tick: start, ticks: Math.max(1, Math.round(ticks + (want - ticks) * s)) };
}

/* ── TUPLET ───────────────────────────────────────────────────────────────── */

export const TUPLET_N_MIN = 2;
export const TUPLET_N_MAX = 16;
export const TUPLET_M_MIN = 1;
export const TUPLET_M_MAX = 16;

/**
 * The M a tuplet of N usually counts against: the largest power of two below
 * N (3 in 2, 5 in 4, 7 in 4, 9 in 8), and 3 for a duplet or a quadruplet
 * (2 in 3, 4 in 3), which live in compound time.
 */
export function defaultTupletM(n: number): number {
  const k = Math.max(TUPLET_N_MIN, Math.min(TUPLET_N_MAX, Math.round(n)));
  if (k === 2 || k === 4) return 3;
  let m = 1;
  while (m * 2 < k) m *= 2;
  return m;
}

/** The selection's onsets: the distinct starts of the notes in `ids`, sorted; notes a tick apart share one. */
export function selectedOnsets(notes: readonly PianoNote[], ids: ReadonlySet<string>): number[] {
  const ticks = notes.filter((n) => ids.has(n.id)).map((n) => n.tick ?? Math.round(n.step * TICKS_PER_STEP)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of ticks) if (!out.length || t - out[out.length - 1] > 1) out.push(t);
  return out;
}

/**
 * TUPLET: the selected notes respaced `n` in the time of `m` straight notes of
 * `unitTicks` (5 in 4 16ths is a quintuplet). The first onset stays; onset i
 * moves to first + i·m·unit/n, rounded from the first onset so the figure never
 * drifts, and a chord moves as one. Each note lasts until the next onset, the
 * last one a full tuplet cell. More onsets than `n` carry on at the same pace.
 */
export function tupletUpdates(notes: readonly PianoNote[], ids: ReadonlySet<string>, n: number, m: number, unitTicks: number): TimeUpdate[] {
  const onsets = selectedOnsets(notes, ids);
  if (onsets.length === 0 || !(n > 0) || !(m > 0) || !(unitTicks > 0)) return [];
  const cell = (m * unitTicks) / n;
  const first = onsets[0];
  const at = (i: number): number => first + Math.round(i * cell);
  const indexOf = (tick: number): number => {
    let i = 0;
    while (i + 1 < onsets.length && tick - onsets[i + 1] >= -1) i += 1;
    return i;
  };
  return notes
    .filter((x) => ids.has(x.id))
    .map((x) => {
      const i = indexOf(x.tick ?? Math.round(x.step * TICKS_PER_STEP));
      return { id: x.id, tick: at(i), ticks: Math.max(1, at(i + 1) - at(i)) };
    });
}

/* ── drawing ──────────────────────────────────────────────────────────────── */

/**
 * The grid's lines in steps for drawing, less the steps in `skip` (the bar,
 * group and beat tiers already draw those); empty when a cell is narrower than
 * `minPx` at `stepPx`. GROUP draws only the pulses the tiers miss.
 */
export function snapLineSteps(g: SnapGrid, stepPx: number, skip: ReadonlySet<number>, minPx: number): number[] {
  const cell = cellTicks(g.def) * (g.scale ?? 1);
  if (cell > 0 && (cell / TICKS_PER_STEP) * stepPx < minPx) return [];
  const key = (s: number): number => Math.round(s * 1e6) / 1e6;
  const skipped = new Set([...skip].map(key));
  const out: number[] = [];
  for (const t of g.lines) {
    const s = t / TICKS_PER_STEP;
    if (!skipped.has(key(s))) out.push(s);
  }
  return out;
}
