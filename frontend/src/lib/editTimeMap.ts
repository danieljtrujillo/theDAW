/**
 * editTimeMap — the EDIT arrangement's tempo map and meter map, and the clock,
 * grid, snap, bar and adoption arithmetic that reads them.
 *
 * One tempo model and one meter model: EDIT holds the same `TempoEvent[]` the
 * piano roll holds (lib/rollTempo, lib/tempoMap: steps, ramps and fermatas, a
 * beat-0 event that IS the start tempo, beats on the roll's ticks) and the same
 * `MeterSegment[]` (lib/meterMap: time signatures by bar, additive groups). The
 * only difference is the anchor: EDIT's beat 0 and bar 1 sit at timeline second
 * 0, with no pickup.
 *
 * Steps are 16th notes, as everywhere in the meter code, so a step converts to
 * seconds through the tempo map (`editClock`) and to bars through the meter map
 * (`barAt`). Clips stay anchored in SECONDS: a tempo edit moves the grid, and
 * every clip keeps playing where it sits (a MIDI clip plays at its own
 * `sourceTempoMap`).
 *
 * Everything here is pure, with no store behind it, so node tests load it.
 */
import { DEFAULT_METER, type Meter } from './colony';
import {
  accentLines,
  barAt,
  beatLines,
  normalizeMeterMap,
  sanitizeMeter,
  stepsAsMeter,
  stepsPerBar,
  meterEquals,
  type MeterSegment,
} from './meterMap';
import { PPQ } from './noteClock';
import {
  hasTempoChanges,
  playedTempoMap,
  sanitizeFermata,
  sanitizeRollTempoMap,
  startTempoOf,
  stepClock,
  tickBeat,
  type StepClock,
} from './rollTempo';
import { DEFAULT_BPM, clampTempoBpm, getTempoAtBeat, type TempoEvent } from './tempoMap';
import type { GridLevel, GridLine } from './timeline/gridLines';

/** Which of the two kinds of tempo-map event a call means. */
export type EditTempoEventKind = 'tempo' | 'fermata';

/** EDIT's two maps, as the store holds them. */
export interface EditTimeMaps {
  tempoMap: readonly TempoEvent[];
  meterMap: readonly MeterSegment[];
}

const EPS = 1e-9;
const STEPS_PER_BEAT = 4;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/* ── the maps themselves ─────────────────────────────────────────────────── */

/** A fresh project's meter: 4/4 from bar 1. */
export const editDefaultMeterMap = (): MeterSegment[] => [{ bar: 0, meter: { ...DEFAULT_METER, groups: [] } }];

/** A fresh project's tempo map: one event at `bpm`. */
export const editDefaultTempoMap = (bpm = DEFAULT_BPM): TempoEvent[] => sanitizeRollTempoMap([], bpm);

/** A meter map EDIT can hold: sorted, one segment per bar, valid meters, repeats merged, bar 0 present. */
export const sanitizeEditMeterMap = (map: readonly MeterSegment[] | null | undefined): MeterSegment[] =>
  normalizeMeterMap(map).map((s) => ({ bar: s.bar, meter: { num: s.meter.num, den: s.meter.den, groups: [...s.meter.groups] } }));

/** A tempo map EDIT can hold: the roll's rule (lib/rollTempo sanitizeRollTempoMap), started at `startBpm`. */
export const sanitizeEditTempoMap = (events: readonly (Partial<TempoEvent> | null | undefined)[] | null | undefined, startBpm: number): TempoEvent[] =>
  sanitizeRollTempoMap(events, startBpm);

/** The start tempo of a map: its beat-0 tempo event's, or the default. */
export const editStartBpm = (map: readonly TempoEvent[]): number => startTempoOf(map) ?? DEFAULT_BPM;

/** True when two tempo events hold the same beat, tempo (by `sameBpm`), curve and fermata. */
const sameEvent = (a: TempoEvent, b: TempoEvent | undefined, sameBpm: (x: number, y: number) => boolean = Object.is): boolean =>
  !!b && a.beat === b.beat && sameBpm(a.bpm, b.bpm) && (a.curve ?? 'step') === (b.curve ?? 'step')
  && !!a.fermata === !!b.fermata && a.fermata?.beats === b.fermata?.beats && a.fermata?.stretch === b.fermata?.stretch;

export const sameTempoMap = (a: readonly TempoEvent[], b: readonly TempoEvent[]): boolean =>
  a === b || (a.length === b.length && a.every((e, i) => sameEvent(e, b[i])));

/**
 * A tempo as a MIDI file's FF 51 holds it: whole microseconds a quarter (the
 * rounding lib/midi tempoMicros writes). A fermata's own bpm is not read.
 */
const ff51Micros = (bpm: number): number => Math.round(60_000_000 / bpm);

/**
 * True when two tempo maps are the same to a MIDI file's resolution: the same
 * events, each tempo the same whole microseconds a quarter. A MIDI file holds
 * 90 BPM as 666667 us, which reads back exactly as 89.999955 (lib/midi
 * tempoOfMicros), and such a part dropped on an arrangement at 90 plays the
 * same, so it is no change to offer (adoptClipTimeMaps' `changes`).
 */
export const sameTempoMapAtMidiResolution = (a: readonly TempoEvent[], b: readonly TempoEvent[]): boolean =>
  a === b || (a.length === b.length && a.every((e, i) => sameEvent(e, b[i], (x, y) => x === y || ff51Micros(x) === ff51Micros(y))));

export const sameMeterMap = (a: readonly MeterSegment[], b: readonly MeterSegment[]): boolean => {
  if (a === b) return true;
  const x = normalizeMeterMap(a);
  const y = normalizeMeterMap(b);
  return x.length === y.length && x.every((s, i) => s.bar === y[i].bar && meterEquals(s.meter, y[i].meter));
};

/** True when the event is the one of `kind` at `beat`. */
const isEventOf = (e: TempoEvent, beat: number, kind: EditTempoEventKind): boolean =>
  e.beat === beat && (kind === 'fermata') === !!e.fermata;

/** The map with its beat-0 tempo set to `bpm` (20-300, fraction kept); later events stay. */
export function withStartBpm(map: readonly TempoEvent[], bpm: number): TempoEvent[] {
  const next = clampTempoBpm(bpm);
  return sanitizeRollTempoMap(map.map((e) => (isEventOf(e, 0, 'tempo') ? { ...e, bpm: next } : e)), next);
}

/** The map with `event` added, replacing an event of its kind at its beat. */
export function withTempoEvent(map: readonly TempoEvent[], event: TempoEvent): TempoEvent[] {
  return sanitizeRollTempoMap([...map, event], editStartBpm(map));
}

/**
 * The map with the event of `kind` at `beat` moved, re-valued or re-shaped. The
 * start tempo stays at beat 0; a tempo change moved onto beat 0 stops a tick
 * after it, so the start is never lost. Null when there is no such event.
 */
export function withTempoEventMoved(
  map: readonly TempoEvent[],
  beat: number,
  kind: EditTempoEventKind,
  patch: Partial<TempoEvent>,
): TempoEvent[] | null {
  const found = map.find((e) => isEventOf(e, beat, kind));
  if (!found) return null;
  const start = kind === 'tempo' && beat === 0;
  const moved: TempoEvent = {
    ...found,
    beat: start ? 0 : isNum(patch.beat) ? tickBeat(patch.beat) : found.beat,
    bpm: isNum(patch.bpm) && patch.bpm > 0 ? patch.bpm : found.bpm,
    ...(kind === 'tempo' ? { curve: patch.curve ?? found.curve } : {}),
    ...(kind === 'fermata' ? { fermata: sanitizeFermata({ ...found.fermata, ...patch.fermata }) ?? found.fermata } : {}),
  };
  if (!start && kind === 'tempo' && moved.beat <= 0) moved.beat = tickBeat(1 / PPQ);
  return sanitizeRollTempoMap([...map.filter((e) => e !== found), moved], editStartBpm(map));
}

/** The map without the event of `kind` at `beat`; the start tempo is never removed. Null when nothing goes. */
export function withoutTempoEvent(map: readonly TempoEvent[], beat: number, kind: EditTempoEventKind): TempoEvent[] | null {
  if (kind === 'tempo' && beat === 0) return null;
  const next = map.filter((e) => !isEventOf(e, beat, kind));
  return next.length === map.length ? null : sanitizeRollTempoMap(next, editStartBpm(map));
}

/* ── the clock ───────────────────────────────────────────────────────────── */

const clockCache = new WeakMap<readonly TempoEvent[], StepClock>();

/**
 * Seconds of EDIT steps (16ths from timeline second 0), and back. Cached on the
 * map's identity: the store replaces the array on every edit, so a cached clock
 * can never serve a stale map, and the grid, the ruler and snap share one.
 */
export function editClock(map: readonly TempoEvent[]): StepClock {
  let clock = clockCache.get(map);
  if (!clock) {
    clock = stepClock(editStartBpm(map), map);
    clockCache.set(map, clock);
  }
  return clock;
}

/** The tempo sounding at timeline second `sec`, in BPM. */
export function editTempoAtSec(map: readonly TempoEvent[], sec: number): number {
  const clock = editClock(map);
  return getTempoAtBeat(clock.map, Math.max(0, clock.stepAt(Math.max(0, sec))) / STEPS_PER_BEAT);
}

/** The lowest and highest tempo the map plays, rounded to the hundredth. */
export function editTempoRange(map: readonly TempoEvent[]): [number, number] {
  const tempos = map.filter((e) => !e.fermata).map((e) => Math.round(e.bpm * 100) / 100);
  if (!tempos.length) return [DEFAULT_BPM, DEFAULT_BPM];
  return [Math.min(...tempos), Math.max(...tempos)];
}

/* ── bars ─────────────────────────────────────────────────────────────────── */

/** One bar of the arrangement: its 0-based index, its steps, its meter and its seconds. */
export interface EditBar {
  bar: number;
  startStep: number;
  lenSteps: number;
  meter: Meter;
  startSec: number;
  endSec: number;
}

/**
 * A meter map indexed for lookups: its segments (normalized, repeats kept) and
 * each segment's first step, accumulated left to right exactly as
 * meterMap.barStartStep does. Cached on the map's identity (the store replaces
 * the array on every edit), so snapping a drag through a 1200-change movement
 * is a binary search, not a re-sort of the whole map per pointer move.
 */
interface MeterIndex {
  segs: MeterSegment[];
  /** Each segment's first bar and first step. */
  bars: number[];
  starts: number[];
}
const meterIndexCache = new WeakMap<readonly MeterSegment[], MeterIndex>();

function meterIndex(map: readonly MeterSegment[]): MeterIndex {
  let idx = meterIndexCache.get(map);
  if (!idx) {
    const segs = normalizeMeterMap(map, false);
    const starts: number[] = [];
    let step = 0;
    for (let i = 0; i < segs.length; i += 1) {
      if (i > 0) step += (segs[i].bar - segs[i - 1].bar) * stepsPerBar(segs[i - 1].meter);
      starts.push(step);
    }
    idx = { segs, bars: segs.map((sg) => sg.bar), starts };
    meterIndexCache.set(map, idx);
  }
  return idx;
}

/** The last index whose value is at or below `x` (0 when none is). */
function lastAtOrBelow(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The bar that holds `step` (16ths from timeline second 0): lib/meterMap barAt with no pickup, through the index. */
function barOf(map: readonly MeterSegment[], step: number): { bar: number; start: number; len: number; meter: Meter } {
  const { segs, starts } = meterIndex(map);
  const s = Math.max(0, step);
  const i = lastAtOrBelow(starts, s + EPS);
  const meter = segs[i].meter;
  const len = stepsPerBar(meter);
  let k = Math.max(0, Math.floor((s - starts[i]) / len + EPS));
  if (i + 1 < segs.length) k = Math.min(k, segs[i + 1].bar - segs[i].bar - 1);
  return { bar: segs[i].bar + k, start: starts[i] + k * len, len, meter };
}

/** The bar that holds timeline second `sec`. */
export function editBarAtSec(maps: EditTimeMaps, sec: number): EditBar {
  const clock = editClock(maps.tempoMap);
  const b = barOf(maps.meterMap, Math.max(0, clock.stepAt(Math.max(0, sec))));
  return { bar: b.bar, startStep: b.start, lenSteps: b.len, meter: b.meter, startSec: clock.at(b.start), endSec: clock.at(b.start + b.len) };
}

/** Every bar from the one holding `fromStep`, in order, forever (the last segment holds). */
function* walkBars(map: readonly MeterSegment[], fromStep: number): Generator<{ bar: number; start: number; len: number; meter: Meter }> {
  const { segs } = meterIndex(map);
  const first = barOf(map, Math.max(0, fromStep));
  let bar = first.bar;
  let start = first.start;
  let si = 0;
  while (si + 1 < segs.length && segs[si + 1].bar <= bar) si += 1;
  for (;;) {
    while (si + 1 < segs.length && segs[si + 1].bar <= bar) si += 1;
    const meter = segs[si].meter;
    const len = stepsPerBar(meter);
    yield { bar, start, len, meter };
    start += len;
    bar += 1;
  }
}

/** The step where 0-based `bar` starts. */
export function editBarStartStep(map: readonly MeterSegment[], bar: number): number {
  const { segs, bars, starts } = meterIndex(map);
  const target = Math.max(0, Math.floor(bar));
  const i = lastAtOrBelow(bars, target);
  return starts[i] + (target - segs[i].bar) * stepsPerBar(segs[i].meter);
}

/** Timeline seconds where 0-based `bar` starts. */
export const editBarStartSec = (maps: EditTimeMaps, bar: number): number =>
  editClock(maps.tempoMap).at(editBarStartStep(maps.meterMap, bar));

/**
 * `sec` moved by `bars` whole bars, keeping its place inside the bar: the same
 * fraction of the bar, so a clip halfway through a 7/8 bar lands halfway through
 * the 4/4 bar it moves into. Never before 0.
 */
export function editMoveByBars(maps: EditTimeMaps, sec: number, bars: number): number {
  const clock = editClock(maps.tempoMap);
  const step = Math.max(0, clock.stepAt(Math.max(0, sec)));
  const here = barOf(maps.meterMap, step);
  const frac = here.len > 0 ? (step - here.start) / here.len : 0;
  const whole = Math.trunc(bars);
  const target = here.bar + whole;
  if (target < 0) return 0;
  const startStep = editBarStartStep(maps.meterMap, target);
  const len = stepsPerBar(barOf(maps.meterMap, startStep + EPS).meter);
  const partial = bars - whole;
  return Math.max(0, clock.at(startStep + frac * len + partial * len));
}

/**
 * `sec` moved by `beats` of the meter's own unit where it starts (an 8th in 7/8,
 * a quarter in 4/4), through the tempo map. Never before 0.
 */
export function editMoveByBeats(maps: EditTimeMaps, sec: number, beats: number): number {
  const clock = editClock(maps.tempoMap);
  const step = Math.max(0, clock.stepAt(Math.max(0, sec)));
  const unit = 16 / barOf(maps.meterMap, step).meter.den;
  return Math.max(0, clock.at(Math.max(0, step + beats * unit)));
}

/* ── snap ────────────────────────────────────────────────────────────────── */

/** A snap grid: `'bar'` for bar lines, otherwise the spacing in steps (0 = off). */
export type EditGrid = 'bar' | number;

/**
 * The nearest grid line to `sec`. The grid restarts at every bar line, so a
 * quarter grid in 7/8 falls on 0, 4, 8 and 12 steps and then on the next bar,
 * and a bar grid falls on the bar lines of whatever meter holds. Grid 0 is off.
 */
export function editSnapSec(maps: EditTimeMaps, sec: number, grid: EditGrid): number {
  const s = Math.max(0, sec);
  if (grid !== 'bar' && !(grid > 0)) return s;
  const clock = editClock(maps.tempoMap);
  const step = Math.max(0, clock.stepAt(s));
  const bar = barOf(maps.meterMap, step);
  const end = bar.start + bar.len;
  let best = bar.start;
  let bestDist = Math.abs(step - bar.start);
  const consider = (c: number) => {
    const d = Math.abs(step - c);
    if (d < bestDist - EPS) { best = c; bestDist = d; }
  };
  consider(end);
  if (grid !== 'bar') {
    const k = Math.round((step - bar.start) / grid);
    for (const j of [k - 1, k, k + 1]) {
      const c = bar.start + j * grid;
      if (c < bar.start - EPS || c > end + EPS) continue;
      consider(c);
    }
  }
  return Math.max(0, clock.at(best));
}

/** The length in seconds of one grid division where `sec` sits (a bar for `'bar'`); null when the grid is off. */
export function editGridStepSec(maps: EditTimeMaps, sec: number, grid: EditGrid): number | null {
  if (grid !== 'bar' && !(grid > 0)) return null;
  const clock = editClock(maps.tempoMap);
  const step = Math.max(0, clock.stepAt(Math.max(0, sec)));
  if (grid === 'bar') {
    const b = barOf(maps.meterMap, step);
    return clock.at(b.start + b.len) - clock.at(b.start);
  }
  return clock.at(step + grid) - clock.at(step);
}

/* ── the grid and the ruler ─────────────────────────────────────────────── */

/** Hard ceiling on returned grid lines, as lib/timeline/gridLines. */
export const EDIT_GRID_LINES_MAX = 5000;

/** Positions inside one bar for the grid's beat tier and sub tier, in steps. */
function barTiers(meter: Meter): { beat: number[]; sub: number[] } {
  const accents = accentLines(meter);
  if (accents.length > 1) return { beat: accents, sub: beatLines(meter) };
  const beats = beatLines(meter);
  const len = stepsPerBar(meter);
  const sub: number[] = [];
  if (16 / meter.den > 1 + EPS) for (let t = 0; t < len - EPS; t += 1) sub.push(t);
  return { beat: beats, sub };
}

/** Smallest gap between consecutive positions of a tier inside a bar, the bar end included. */
function minGap(positions: readonly number[], len: number): number {
  let gap = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    const next = i + 1 < positions.length ? positions[i + 1] : len;
    gap = Math.min(gap, next - positions[i]);
  }
  return gap;
}

export interface EditGridArgs extends EditTimeMaps {
  startSec: number;
  endSec: number;
  /** Local CSS px per second. */
  zoom: number;
  /** A tier whose lines sit closer than this is dropped. Default 6. */
  minSpacingPx?: number;
}

/**
 * Bar, beat and sub lines inside [startSec, endSec] under both maps, sorted by
 * time. Each bar draws in its own meter and at its own tempo: its beat tier is
 * its group starts (7/8 3+2+2 gives 0, 6, 10) or a compound meter's dotted
 * beats, else its beats; the sub tier is the beats under groups, else the 16ths.
 * A tier is dropped in a bar where its lines would sit under `minSpacingPx`
 * apart, and when even bar lines are that close only every 2^k-th bar is kept.
 */
export function editGridLines(a: EditGridArgs): GridLine[] {
  const minPx = a.minSpacingPx ?? 6;
  if (!isNum(a.startSec) || !isNum(a.endSec) || !isNum(a.zoom) || a.zoom <= 0 || a.endSec < a.startSec) return [];
  const clock = editClock(a.tempoMap);
  const fromStep = Math.max(0, clock.stepAt(Math.max(0, a.startSec)));
  const out: GridLine[] = [];
  const push = (sec: number, level: GridLevel, barIndex: number) => {
    if (sec < a.startSec - EPS || sec > a.endSec + EPS) return;
    out.push({ sec, level, barIndex });
  };
  for (const b of walkBars(a.meterMap, fromStep)) {
    const startSec = clock.at(b.start);
    if (startSec > a.endSec + EPS) break;
    const endSec = clock.at(b.start + b.len);
    const barPx = (endSec - startSec) * a.zoom;
    let stride = 1;
    while (barPx * stride < minPx && stride < 1 << 20) stride *= 2;
    if (b.bar % stride === 0) push(startSec, 'bar', b.bar);
    if (barPx >= minPx) {
      const tiers = barTiers(b.meter);
      const pxPerStep = barPx / b.len;
      const beatOk = minGap(tiers.beat, b.len) * pxPerStep >= minPx;
      const subOk = beatOk && tiers.sub.length > 0 && minGap(tiers.sub, b.len) * pxPerStep >= minPx;
      const beats = new Set(tiers.beat.map((t) => Math.round(t * 1e6)));
      if (beatOk) for (const t of tiers.beat) if (t > EPS) push(clock.at(b.start + t), 'beat', b.bar);
      if (subOk) for (const t of tiers.sub) if (t > EPS && !beats.has(Math.round(t * 1e6))) push(clock.at(b.start + t), 'sub', b.bar);
    }
    if (out.length > EDIT_GRID_LINES_MAX) break;
  }
  out.sort((x, y) => x.sec - y.sec);
  return out.length > EDIT_GRID_LINES_MAX ? out.slice(0, EDIT_GRID_LINES_MAX) : out;
}

/** A bar number on the ruler (1-based, as on screen) at its seconds. */
export interface EditRulerBar {
  bar: number;
  sec: number;
}

/**
 * Bar numbers for the ruler inside [startSec, endSec]. When bars sit closer than
 * `minPx`, only every 2^k-th bar keeps its number, as the grid thins its lines.
 */
export function editRulerBars(a: EditGridArgs & { minPx?: number }): EditRulerBar[] {
  const minPx = a.minPx ?? 24;
  if (!isNum(a.startSec) || !isNum(a.endSec) || !isNum(a.zoom) || a.zoom <= 0 || a.endSec < a.startSec) return [];
  const clock = editClock(a.tempoMap);
  const out: EditRulerBar[] = [];
  for (const b of walkBars(a.meterMap, Math.max(0, clock.stepAt(Math.max(0, a.startSec))))) {
    const sec = clock.at(b.start);
    if (sec > a.endSec + EPS) break;
    const px = (clock.at(b.start + b.len) - sec) * a.zoom;
    let stride = 1;
    while (px * stride < minPx && stride < 1 << 20) stride *= 2;
    if (b.bar % stride === 0 && sec >= a.startSec - EPS) out.push({ bar: b.bar + 1, sec });
    if (out.length > EDIT_GRID_LINES_MAX) break;
  }
  return out;
}

/** A meter as it reads on screen: "7/8", "7/8 3+2+2". */
export const editMeterLabel = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` ${m.groups.join('+')}` : ''}`;

/** A meter change on the ruler: where it starts (0-based bar), its seconds and its label. */
export interface EditMeterFlag {
  bar: number;
  sec: number;
  meter: Meter;
  label: string;
}

/** Every meter change starting inside [startSec, endSec], bar 1's meter included. */
export function editMeterFlags(maps: EditTimeMaps, startSec: number, endSec: number): EditMeterFlag[] {
  const clock = editClock(maps.tempoMap);
  const out: EditMeterFlag[] = [];
  // Each change's first step accumulated left to right, as barStartStep does,
  // so the whole map costs one pass however many changes it holds.
  const segs = normalizeMeterMap(maps.meterMap);
  let step = 0;
  for (let i = 0; i < segs.length; i += 1) {
    if (i > 0) step += (segs[i].bar - segs[i - 1].bar) * stepsPerBar(segs[i - 1].meter);
    const sec = clock.at(step);
    if (sec < startSec - EPS) continue;
    if (sec > endSec + EPS) break;
    out.push({ bar: segs[i].bar, sec, meter: segs[i].meter, label: editMeterLabel(segs[i].meter) });
  }
  return out;
}

/** A tempo event on the ruler, with its seconds and its label. */
export interface EditTempoFlag {
  beat: number;
  kind: EditTempoEventKind;
  sec: number;
  bpm: number;
  curve: 'step' | 'linear';
  label: string;
}

/** A tempo as it reads on screen, to the hundredth. */
export const editBpmText = (bpm: number): string => String(Math.round(bpm * 100) / 100);

/** Every tempo event inside [startSec, endSec]: tempo changes, ramps and fermatas. */
export function editTempoFlags(maps: EditTimeMaps, startSec: number, endSec: number): EditTempoFlag[] {
  const clock = editClock(maps.tempoMap);
  const out: EditTempoFlag[] = [];
  for (const e of maps.tempoMap) {
    const sec = clock.at(e.beat * STEPS_PER_BEAT);
    if (sec < startSec - EPS || sec > endSec + EPS) continue;
    const kind: EditTempoEventKind = e.fermata ? 'fermata' : 'tempo';
    const curve = e.curve === 'linear' ? 'linear' : 'step';
    const label = e.fermata ? `Hold x${Math.round(e.fermata.stretch * 100) / 100}` : `${editBpmText(e.bpm)} BPM${curve === 'linear' ? ' ramp' : ''}`;
    out.push({ beat: e.beat, kind, sec, bpm: e.bpm, curve, label });
  }
  return out;
}

/* ── positions a person types ───────────────────────────────────────────── */

/** A tempo event's beat as a 1-based bar and the quarter notes after that bar's start. */
export function editBeatToBarPos(map: readonly MeterSegment[], beat: number): { bar: number; beatInBar: number } {
  const step = Math.max(0, beat) * STEPS_PER_BEAT;
  const b = barOf(map, step);
  return { bar: b.bar + 1, beatInBar: Math.round(((step - b.start) / STEPS_PER_BEAT) * PPQ) / PPQ };
}

/** A 1-based bar and quarter notes into it, as a tempo-map beat on the roll's ticks. */
export function editBarPosToBeat(map: readonly MeterSegment[], bar: number, beatInBar: number): number {
  const b = Math.max(1, Math.floor(isNum(bar) ? bar : 1));
  const startStep = editBarStartStep(map, b - 1);
  return tickBeat(startStep / STEPS_PER_BEAT + Math.max(0, isNum(beatInBar) ? beatInBar : 0));
}

/** A typed meter ("7/8", "7/8 3+2+2", "7/8 groups=3+2+2") as a Meter, or null. */
export function parseEditMeter(text: string): Meter | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*(?:(?:groups\s*=\s*)?([\d+\s]+))?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  const groups = m[3] ? m[3].split('+').map((g) => Number(g.trim())).filter((g) => g > 0) : [];
  const meter = sanitizeMeter({ num, den, groups });
  if (!meter) return null;
  if (groups.length > 1 && meter.groups.length === 0) return null;
  return meter;
}

/* ── adopting a clip's maps ─────────────────────────────────────────────── */

/**
 * The map without tempo events that change nothing: a held event whose tempo is
 * the held tempo before it. A ramp's target and a ramp's own start are kept.
 * The map is already sanitized, so the start stays and the result is frozen.
 */
export function dropRepeatedTempos(map: TempoEvent[]): TempoEvent[] {
  let prev: TempoEvent | undefined;
  const keep = map.filter((e) => {
    if (e.fermata) return true;
    const same = !!prev && e.beat > 0 && (prev.curve ?? 'step') === 'step' && (e.curve ?? 'step') === 'step' && prev.bpm === e.bpm;
    if (!same) prev = e;
    return !same;
  });
  return keep.length === map.length ? map : (Object.freeze(keep) as TempoEvent[]);
}

/**
 * The tempo events of `map` that sound before `beat`, so a new tempo from
 * `beat` on leaves every second before it where it was: a fermata reaching
 * past `beat` is cut to end there, and a ramp running into `beat` is held
 * from one tick before it (the ramp keeps its line up to there).
 */
export function tempoEventsBefore(map: readonly TempoEvent[], beat: number): TempoEvent[] {
  const clock = editClock(map);
  const before: TempoEvent[] = [];
  let inForce: TempoEvent | undefined;
  for (const e of map) {
    if (e.beat >= beat - EPS) continue;
    if (e.fermata) {
      const room = beat - e.beat;
      const fermata = sanitizeFermata({ beats: Math.min(e.fermata.beats, room), stretch: e.fermata.stretch });
      if (fermata) before.push({ beat: e.beat, bpm: e.bpm, fermata });
      continue;
    }
    before.push({ ...e });
    inForce = e;
  }
  if (inForce && inForce.curve === 'linear') {
    const holdBeat = tickBeat(beat - 1 / PPQ);
    if (holdBeat > inForce.beat + EPS) before.push({ beat: holdBeat, bpm: getTempoAtBeat(clock.map, holdBeat), curve: 'step' });
    else before[before.indexOf(inForce)] = { ...inForce, curve: 'step' };
  }
  return before;
}

/** The clip fields adoption reads: where the clip sits and the maps its notes were written in. */
export interface ClipTimeSource {
  startSec: number;
  offsetIntoSource: number;
  sourceBpm?: number;
  sourceTempoMap?: readonly TempoEvent[];
  sourceMeterMap?: readonly MeterSegment[];
  sourcePickupSteps?: number;
}

export type AdoptResult =
  | {
      ok: true;
      tempoMap: TempoEvent[];
      meterMap: MeterSegment[];
      /** Timeline seconds where the clip's first step sits. */
      anchorSec: number;
      /** The 0-based EDIT bar where the clip's first bar (after its pickup) now starts. */
      firstBar: number;
      /** True when the result differs from the maps it was computed against. */
      changes: boolean;
      error?: undefined;
    }
  // The mirrored optional members let callers narrow on `ok` with strictNullChecks off.
  | { ok: false; error: string; tempoMap?: undefined; meterMap?: undefined; anchorSec?: undefined; firstBar?: undefined; changes?: undefined };

/**
 * EDIT's maps with the clip's tempo and meter put in from the clip's first step
 * onward, so the clip's bar lines land on EDIT's and EDIT's tempo follows it.
 * Everything before the clip's first step stays as it was; everything from it on
 * is replaced by the clip's maps (their last tempo and meter hold after the clip).
 *
 * The clip's first step sits at `startSec - offsetIntoSource` on the timeline.
 * When that falls inside an EDIT bar, the bar is shortened to end there (a
 * partial bar, written as n/16 or n/32), and a clip pickup becomes a partial bar
 * of its own before the clip's bar 1. A ramp running into the clip's start is
 * held from one tick before it, so every second before the clip stays put.
 */
export function adoptClipTimeMaps(edit: EditTimeMaps, clip: ClipTimeSource): AdoptResult {
  const anchorSec = clip.startSec - clip.offsetIntoSource;
  if (!isNum(anchorSec) || anchorSec < -1e-6) {
    return { ok: false, error: 'The clip is trimmed past the start of the timeline, so its first bar has nowhere to go. Move it right first.' };
  }
  const clock = editClock(edit.tempoMap);
  const anchorBeat = tickBeat(Math.max(0, clock.stepAt(Math.max(0, anchorSec))) / STEPS_PER_BEAT);
  const anchorStep = anchorBeat * STEPS_PER_BEAT;

  // Tempo: EDIT's events before the anchor, then the clip's, shifted.
  const before = tempoEventsBefore(edit.tempoMap, anchorBeat);
  const own = playedTempoMap(clip.sourceBpm ?? editStartBpm(edit.tempoMap), clip.sourceTempoMap ?? null);
  const shifted = own.map((e) => ({ ...e, beat: e.beat + anchorBeat, ...(e.fermata ? { fermata: { ...e.fermata } } : {}) }));
  const startBpm = anchorBeat > EPS ? editStartBpm(edit.tempoMap) : (startTempoOf(own) ?? editStartBpm(edit.tempoMap));
  const tempoMap = dropRepeatedTempos(sanitizeRollTempoMap([...before, ...shifted], startBpm));

  // Meter: EDIT's bars before the anchor, a partial bar when the anchor is inside one, the pickup, then the clip's bars.
  const segs = normalizeMeterMap(edit.meterMap, false);
  const here = barAt(segs, anchorStep);
  const into = anchorStep - here.start;
  const added: MeterSegment[] = [];
  let base: number;
  if (into <= 1e-6) {
    base = here.bar;
  } else {
    const partial = stepsAsMeter(Math.round(into * 2) / 2);
    if (!partial || Math.abs(Math.round(into * 2) / 2 - into) > 1e-6) {
      return { ok: false, error: 'The clip starts between 32nd notes of a bar, where no time signature can end the bar. Snap it to 1/32 or a bar line first.' };
    }
    added.push({ bar: here.bar, meter: partial });
    base = here.bar + 1;
  }
  const pickup = Math.max(0, clip.sourcePickupSteps ?? 0);
  if (pickup > 0) {
    const pm = stepsAsMeter(pickup);
    if (!pm) return { ok: false, error: `The clip's pickup of ${pickup} 16ths cannot be written as a bar.` };
    added.push({ bar: base, meter: pm });
    base += 1;
  }
  const clipSegs = normalizeMeterMap(clip.sourceMeterMap ?? null, false).map((s) => ({ bar: s.bar + base, meter: { ...s.meter, groups: [...s.meter.groups] } }));
  const keepBelow = added.length ? added[0].bar : base;
  const meterMap = sanitizeEditMeterMap([...segs.filter((s) => s.bar < keepBelow), ...added, ...clipSegs]);

  // A tempo that differs only below a MIDI file's resolution is no change.
  const changes = !sameTempoMapAtMidiResolution(tempoMap, edit.tempoMap) || !sameMeterMap(meterMap, edit.meterMap);
  return { ok: true, tempoMap, meterMap, anchorSec: Math.max(0, anchorSec), firstBar: base, changes };
}

/** A clip's maps in words for the offer: "7/8 3+2+2, 96-132 BPM", "4/4 then 5/4, 120 BPM". */
export function describeClipTime(clip: Pick<ClipTimeSource, 'sourceBpm' | 'sourceTempoMap' | 'sourceMeterMap'>): string {
  const segs = normalizeMeterMap(clip.sourceMeterMap ?? null);
  const meters: string[] = [];
  for (const s of segs) {
    const label = editMeterLabel(s.meter);
    if (!meters.includes(label)) meters.push(label);
  }
  const meterText = meters.length > 3 ? `${meters.slice(0, 3).join(', ')} and ${meters.length - 3} more meters` : meters.join(' then ');
  const [lo, hi] = editTempoRange(playedTempoMap(clip.sourceBpm ?? DEFAULT_BPM, clip.sourceTempoMap ?? null));
  const tempoText = lo === hi ? `${editBpmText(lo)} BPM` : `${editBpmText(lo)}-${editBpmText(hi)} BPM`;
  return `${meterText}, ${tempoText}`;
}

/** A new MIDI clip's time, taken from the arrangement where it starts. */
export interface ArrangementClipTime {
  /** Timeline seconds of the clip's first step. */
  startSec: number;
  /** The clip's grid: `bars` bars of the arrangement's meters from its start. */
  sourceTotalSteps: number;
  /** The arrangement's meters from the clip's first bar, bar 0 first. */
  sourceMeterMap: MeterSegment[];
  sourcePickupSteps: 0;
  /** The tempo sounding at the clip's start. */
  sourceBpm: number;
  /** The arrangement's tempo changes inside the clip, from its first step (absent at one tempo). */
  sourceTempoMap: TempoEvent[] | undefined;
}

/**
 * The beats each fermata of `map` holds, as the tempo overlay reads them
 * (lib/tempoMap withFermatas): in beat order, a hold that starts inside an
 * earlier one cut to start where that one ends, and a hold before the first
 * tempo event started at it.
 */
function holdWindows(map: readonly TempoEvent[]): Array<{ start: number; end: number; stretch: number }> {
  let first = Infinity;
  for (const e of map) if (!e.fermata && e.beat < first) first = e.beat;
  if (!Number.isFinite(first)) first = 0;
  const out: Array<{ start: number; end: number; stretch: number }> = [];
  const holds = map
    .filter((e) => !!e.fermata && isNum(e.beat) && isNum(e.fermata.beats) && e.fermata.beats > 0 && isNum(e.fermata.stretch) && e.fermata.stretch > 1)
    .sort((a, b) => a.beat - b.beat);
  for (const e of holds) {
    const f = e.fermata as NonNullable<TempoEvent['fermata']>;
    const end = e.beat + f.beats;
    const start = Math.max(e.beat, first, out.length ? out[out.length - 1].end : -Infinity);
    if (end > start) out.push({ start, end, stretch: f.stretch });
  }
  return out;
}

/**
 * The arrangement's played tempo map cut at `startBeat`, as a part starting
 * there holds it. The part's start tempo is the tempo underneath at that beat,
 * read from the tempo events alone: inside a fermata the overlay slows the
 * tempo, and a part that took the slowed tempo as its own would play every bar
 * at it. A ramp running through the start keeps ramping. A hold sounding at the
 * start (the part begins on its beat or inside it) carries on into the part as
 * a fermata at beat 0 for the beats it has left, with its stretch; a hold that
 * ended before the start is left out, and every later event moves by the start.
 */
function tempoFromBeat(played: readonly TempoEvent[], startBeat: number): { startBpm: number; tempoMap: TempoEvent[] } {
  const tempos = played.filter((e) => !e.fermata);
  const startBpm = getTempoAtBeat(tempos, startBeat);
  let segCurve: TempoEvent['curve'] = 'step';
  for (const e of tempos) if (e.beat <= startBeat + EPS) segCurve = e.curve ?? 'step';
  const events: TempoEvent[] = [{ beat: 0, bpm: startBpm, curve: segCurve }];
  const holding = holdWindows(played).find((w) => w.start <= startBeat + EPS && w.end > startBeat + EPS);
  if (holding) events.push({ beat: 0, bpm: startBpm, fermata: { beats: holding.end - startBeat, stretch: holding.stretch } });
  for (const e of played) {
    if (e.beat <= startBeat + EPS) continue;
    events.push(e.fermata
      ? { beat: e.beat - startBeat, bpm: e.bpm, fermata: { ...e.fermata } }
      : { beat: e.beat - startBeat, bpm: e.bpm, curve: e.curve ?? 'step' });
  }
  return { startBpm, tempoMap: sanitizeRollTempoMap(events, startBpm) };
}

/**
 * The time of a new MIDI clip `bars` bars long starting at 0-based arrangement
 * bar `bar`: its grid, its meters and its tempo, so the clip's bar lines and
 * seconds are the arrangement's. The tempo map is cut at the clip's first beat
 * (tempoFromBeat): the tempo underneath there becomes the clip's start tempo (a
 * ramp going through it keeps ramping), each later change moves by the clip's
 * start, a fermata held on or across its first beat holds on into it for the
 * beats it has left, and a fermata that ended before the clip is left out.
 */
export function arrangementClipTime(maps: EditTimeMaps, bar: number, bars: number): ArrangementClipTime {
  const first = Math.max(0, Math.floor(bar));
  const count = Math.max(1, Math.floor(bars));
  const startStep = editBarStartStep(maps.meterMap, first);
  const endStep = editBarStartStep(maps.meterMap, first + count);
  const { segs } = meterIndex(maps.meterMap);
  const inForce = segs[lastAtOrBelow(segs.map((s) => s.bar), first)].meter;
  const meterMap = sanitizeEditMeterMap([
    { bar: 0, meter: inForce },
    ...segs.filter((s) => s.bar > first && s.bar < first + count).map((s) => ({ bar: s.bar - first, meter: s.meter })),
  ]);
  const clock = editClock(maps.tempoMap);
  const { startBpm, tempoMap } = tempoFromBeat(clock.map, startStep / STEPS_PER_BEAT);
  const changes = hasTempoChanges(tempoMap);
  return {
    startSec: clock.at(startStep),
    sourceTotalSteps: endStep - startStep,
    sourceMeterMap: meterMap,
    sourcePickupSteps: 0,
    sourceBpm: startBpm,
    sourceTempoMap: changes ? tempoMap : undefined,
  };
}

/**
 * The time of a new MIDI clip `bars` bars long starting at timeline second
 * `sec`. On a bar line this is arrangementClipTime. Inside a bar the clip's
 * bars cannot be the arrangement's, so it holds the meter sounding there for
 * all its bars, and takes the tempo map from that second on.
 */
export function arrangementClipTimeAtSec(maps: EditTimeMaps, sec: number, bars: number): ArrangementClipTime {
  const here = editBarAtSec(maps, Math.max(0, sec));
  if (Math.abs(here.startSec - sec) <= 1e-6) return arrangementClipTime(maps, here.bar, bars);
  const count = Math.max(1, Math.floor(bars));
  const clock = editClock(maps.tempoMap);
  const startStep = Math.max(0, clock.stepAt(Math.max(0, sec)));
  const { startBpm, tempoMap } = tempoFromBeat(clock.map, startStep / STEPS_PER_BEAT);
  return {
    startSec: Math.max(0, sec),
    sourceTotalSteps: count * stepsPerBar(here.meter),
    sourceMeterMap: sanitizeEditMeterMap([{ bar: 0, meter: here.meter }]),
    sourcePickupSteps: 0,
    sourceBpm: startBpm,
    sourceTempoMap: hasTempoChanges(tempoMap) ? tempoMap : undefined,
  };
}
