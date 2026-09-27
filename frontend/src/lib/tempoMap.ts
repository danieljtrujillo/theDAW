/**
 * tempoMap — the tempo half of the app's ONE time map, beside `meterMap.ts`.
 *
 * Before this, tempo lived in at least four places with four different clamps
 * (editorStore, pianoRollStore, beatClock, DJ per-deck) and every surface did
 * its own `60 / bpm`. A DAW has exactly one tempo owner, and it exposes
 * conversions — not a bare `bpm`. This module is that owner's arithmetic:
 * pure functions over a sorted `TempoEvent[]`, with no store behind them (a
 * store would just recreate the multi-owner problem).
 *
 * Model
 * -----
 * A beat is a QUARTER NOTE, everywhere, whatever the meter — the same unit
 * `notechart.ts` and MIDI use. `bpm` is quarter notes per minute, so one beat
 * lasts `60 / bpm` seconds. A segment runs from one event to the next, and
 * `beatToTime` is the exact integral of `60 / bpm` over beats. A `'step'`
 * segment (the default, and what every caller wrote before ramps existed) holds
 * its tempo, so that integral is a product.
 *
 * Tempo RAMPS
 * -----------
 * An event with `curve: 'linear'` ramps LINEARLY IN BEATS to the next event's
 * tempo instead of holding. Over the segment `[b0, b1]` with tempos `[v0, v1]`:
 *
 *     bpm(b) = v0 + k·Δb,        k = (v1 − v0) / (b1 − b0),   Δb = b − b0
 *
 * Seconds are the exact integral of `60 / bpm(b)`, which for `k ≠ 0` is a
 * logarithm, and its inverse an exponential:
 *
 *     t(b) − t(b0) = ∫ 60/bpm(u) du = (60/k)·ln(bpm(b)/v0)
 *                  = Δb·(60/v0)·ln(1+x)/x,          x = k·Δb/v0
 *     b(t) − b0    = (v0/k)·(e^y − 1)
 *                  = Δt·(v0/60)·(e^y − 1)/y,        y = k·Δt/60
 *
 * The right-hand forms are the ones implemented. `ln(1+x)/x` and `(e^y − 1)/y`
 * are both exactly 1 at 0 and are evaluated with `log1p` / `expm1`, so they
 * stay accurate for a shallow ramp AND collapse to `Δb · secPerBeat` — the same
 * single multiplication a step segment does, bit for bit. A step segment never
 * reaches them at all (`slope === 0` short-circuits), so ramps change no
 * existing result and cost constant-tempo maps nothing.
 *
 * `bpm` interpolates between two POSITIVE tempos, so it never reaches 0 inside
 * the segment: time stays strictly increasing and `1 + x = bpm(b)/v0 > 0`.
 * A ramp applies only INSIDE its own segment — the last event has nothing to
 * ramp to, and beats before the first event extend that event's own tempo
 * backwards, exactly as they always have.
 *
 * The map can never be empty: an empty, null or all-junk map is read as a
 * single 120 bpm event at beat 0, so every caller gets an answer.
 *
 * When the map CHANGES, `remapOnTempoChange` gives beat-anchored material its
 * new seconds and leaves seconds-anchored material alone; its doc comment
 * carries the recipe for deriving a beat from seconds under the OLD map, which
 * is the step a caller holding only seconds needs first.
 *
 * Bars come from `meterMap.ts` (`barStartStep` / `barAt`, in 16th-note steps);
 * this module only converts those steps to quarter-note beats, so there is one
 * meter implementation and one tempo implementation and nothing in between.
 *
 * Design references (READ, NOT COPIED — both are copyleft and incompatible
 * with this repo; no code from either was used):
 *   - ACE-Step-DAW `src/utils/tempoMap.ts` — AGPL-3.0-or-later.
 *   - Tracktion Engine `tracktion_TempoSequence.h` — GPL-3.0-or-later /
 *     commercial; the source of the "seeded, never-empty map" rule and of
 *     "every conversion funnels through one object".
 *   - Tracktion Engine `tracktion_TempoSequence.cpp:563-584` — GPL-3.0-or-later
 *     / commercial; named as the DESIGN source for "a tempo event carries a
 *     curve to the next one, and the conversion integrates it in closed form"
 *     (the file was NOT opened; the integral below is derived from that stated
 *     behaviour).
 * Everything below is written from the mathematical spec.
 */
import { barAt, barStartStep, normalizeMeterMap, stepsPerBar, type MeterSegment } from './meterMap';
import type { Meter } from './colony';

/**
 * How an event's tempo reaches the NEXT event's: hold it until then (`'step'`,
 * the default and what every map was before ramps existed), or ramp to it
 * linearly in beats (`'linear'`).
 */
export type TempoCurve = 'step' | 'linear';

/** One tempo change. `beat` is a quarter-note position; `bpm` is quarter notes per minute. */
export interface TempoEvent {
  beat: number;
  bpm: number;
  /**
   * Absolute seconds of `beat`, when the source already knows them (a
   * `notechart` `TempoEntry` does). Left out, it is integrated from the events
   * before it.
   */
  timeSec?: number;
  /** Defaults to `'step'`. See the ramp section in the module header. */
  curve?: TempoCurve;
}

/**
 * A normalized event: sorted, deduped, with its seconds, seconds-per-beat and
 * ramp slope resolved. `bpm` / `secPerBeat` are the tempo AT `beat` — on a
 * ramping segment they are where the ramp starts, not an average.
 */
export interface TempoPoint {
  beat: number;
  bpm: number;
  timeSec: number;
  secPerBeat: number;
  /**
   * Change in bpm per beat across this segment, or `0` — which means "holds",
   * and is the value for every step segment, for the last event (nothing to
   * ramp to) and for a ramp between two equal tempos. `0` is the fast path
   * everywhere below, so a map without ramps computes exactly as it always has.
   */
  slope: number;
}

/** Where a beat falls in the bar grid. Lengths and positions are quarter notes. */
export interface BarPosition {
  bar: number;
  startBeat: number;
  lengthBeats: number;
  beatInBar: number;
  meter: Meter;
}

export const DEFAULT_BPM = 120;
/** The seeded default: a map is never empty, so a conversion always has an answer. */
export const DEFAULT_TEMPO_MAP: readonly TempoEvent[] = Object.freeze([{ beat: 0, bpm: DEFAULT_BPM, timeSec: 0 }]);

/** The normalization of every empty/missing/all-junk map. Shared, so it costs nothing. */
const DEFAULT_POINTS = Object.freeze([
  Object.freeze({ beat: 0, bpm: DEFAULT_BPM, timeSec: 0, secPerBeat: 60 / DEFAULT_BPM, slope: 0 }),
]) as unknown as TempoPoint[];

/**
 * Normalized points per input array IDENTITY. The SCORE highway converts once
 * per chart event, so re-normalizing (sort + allocate) on every call turned a
 * 500-event chart into a 400x slowdown. `notechart.ts` already caches its
 * `TempoEvent[]` by the same rule, and `beatClock` replaces its one-event array
 * whenever the bpm changes, so identity tracks content for both.
 *
 * The contract that buys this: **a `TempoEvent[]` handed to this module is
 * immutable.** Change the tempo by passing a NEW array; mutating one in place
 * is not a supported input and will keep serving the old normalization.
 */
const normalizedByMap = new WeakMap<readonly TempoEvent[], TempoPoint[]>();

/** Quarter notes in one bar of `m` (7/8 is 3.5). */
export function getBarLength(m: Meter): number {
  return stepsPerBar(m) / 4;
}

/** Quarter notes in one notated beat of `m` (an 8th in x/8). */
export function getBeatLength(m: Meter): number {
  return 4 / m.den;
}

/** The tempo range a document's tempo map holds, the app clock's own (beatClock). */
export const TEMPO_MIN_BPM = 20;
export const TEMPO_MAX_BPM = 300;

/**
 * A tempo map as a document stores it: events with a finite beat at or after
 * 0 and a positive tempo, tempos held to TEMPO_MIN_BPM-TEMPO_MAX_BPM with their
 * fraction kept, sorted by beat, one event per beat (the later one wins), a
 * `'linear'` curve kept and every `timeSec` dropped. A map being edited stores
 * no seconds (see normalizeTempoMap's precondition), so none survive here.
 * Anything that is not an array reads as the empty map.
 */
export function sanitizeTempoEvents(map: unknown): TempoEvent[] {
  if (!Array.isArray(map)) return [];
  const byBeat = new Map<number, TempoEvent>();
  for (const e of map as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const beat = Number((e as TempoEvent).beat);
    const bpm = Number((e as TempoEvent).bpm);
    if (!Number.isFinite(beat) || beat < 0 || !Number.isFinite(bpm) || bpm <= 0) continue;
    const clean: TempoEvent = { beat, bpm: Math.max(TEMPO_MIN_BPM, Math.min(TEMPO_MAX_BPM, bpm)) };
    if ((e as TempoEvent).curve === 'linear') clean.curve = 'linear';
    byBeat.set(beat, clean);
  }
  return [...byBeat.values()].sort((a, b) => a.beat - b.beat);
}

/**
 * Sorted by beat, one event per beat (the later one wins), every `timeSec` and
 * `secPerBeat` filled in. Events with a non-finite beat or a bpm that is not
 * positive are dropped. An empty result becomes the seeded 120 bpm default.
 *
 * A first event that starts after beat 0 and carries no seconds of its own has
 * its tempo run backwards to beat 0, which is what the old `notechart.ts`
 * lookup did (`max(0, bisect_right(...) - 1)` clamps to the first entry).
 *
 * A bpm that is zero or NEGATIVE is dropped rather than trusted: the inline
 * code this replaced would have run time backwards through such an event.
 *
 * PRECONDITION on `timeSec`: if any event carries one, the resulting seconds
 * must be non-decreasing, because `timeToBeat` searches on them. Authoritative
 * seconds are never clamped to enforce that — a caller that supplies `timeSec`
 * supplies it for EVERY event, as `notechart.ts` does. Mixing authoritative
 * seconds on some events with integrated seconds on others can put the
 * sequence out of order (0, 4, 2), after which `timeToBeat` stops being the
 * inverse of `beatToTime`. No caller does this today.
 *
 * The same precondition covers ramps, and more sharply: the event AFTER a
 * `'linear'` one must not carry its own `timeSec` unless that value IS the
 * ramp's own integral — otherwise the segment's far end says one thing and
 * the ramp inside it says another. A map being edited stores no seconds at
 * all, which is why `state/tempoStore.ts` never writes one.
 *
 * The result is CACHED against `map`'s identity and frozen: it is shared with
 * every other caller holding that array, so treat it as read-only.
 */
export function normalizeTempoMap(map: readonly TempoEvent[] | null | undefined): TempoPoint[] {
  if (!map) return DEFAULT_POINTS;
  const cached = normalizedByMap.get(map);
  if (cached) return cached;
  const built = buildPoints(map);
  normalizedByMap.set(map, built);
  return built;
}

/**
 * `ln(1+x)/x`, and exactly 1 at x = 0. `log1p` keeps it accurate for the
 * shallow ramps that matter (a 1 bpm drift over 64 beats), where `ln(v1/v0)`
 * would cancel most of its significant digits away.
 */
const logDiv = (x: number): number => (x === 0 ? 1 : Math.log1p(x) / x);

/** `(e^y − 1)/y`, and exactly 1 at y = 0. The inverse's companion. */
const expDiv = (y: number): number => (y === 0 ? 1 : Math.expm1(y) / y);

/**
 * Absolute seconds of `beat`, read through the segment `p` owns.
 *
 * `slope === 0` (every step segment) and `beat` at or before `p` (the backwards
 * extension in front of the first event) both take the constant-tempo product
 * this module has always computed — the same expression, in the same order, so
 * the result is bit-identical. Only a ramp reaches the logarithm.
 */
function timeInSegment(p: TempoPoint, beat: number): number {
  const db = beat - p.beat;
  if (p.slope === 0 || db <= 0) return p.timeSec + db * p.secPerBeat;
  return p.timeSec + db * p.secPerBeat * logDiv((p.slope * db) / p.bpm);
}

/** The inverse of `timeInSegment`, read through the segment `p` owns. */
function beatInSegment(p: TempoPoint, sec: number): number {
  const dt = sec - p.timeSec;
  if (p.slope === 0 || dt <= 0) return p.beat + dt / p.secPerBeat;
  return p.beat + (dt / p.secPerBeat) * expDiv((p.slope * dt) / 60);
}

/** Quarter notes per minute at `beat`, read through the segment `p` owns. */
function tempoInSegment(p: TempoPoint, beat: number): number {
  const db = beat - p.beat;
  return p.slope === 0 || db <= 0 ? p.bpm : p.bpm + p.slope * db;
}

function buildPoints(map: readonly TempoEvent[]): TempoPoint[] {
  const byBeat = new Map<number, TempoEvent>();
  for (const e of map) {
    if (!e || !Number.isFinite(e.beat) || !Number.isFinite(e.bpm) || e.bpm <= 0) continue;
    byBeat.set(e.beat, e);
  }
  const sorted = [...byBeat.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  if (!sorted.length) return DEFAULT_POINTS;
  const out: TempoPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i];
    const after = sorted[i + 1];
    const secPerBeat = 60 / e.bpm;
    // A ramp needs somewhere to ramp TO and two different tempos. Equal ones
    // are a step by another name, and leaving the slope at 0 keeps them exact.
    // Beats are strictly increasing after the dedupe, so the divisor is > 0.
    const slope = e.curve === 'linear' && after !== undefined && after.bpm !== e.bpm
      ? (after.bpm - e.bpm) / (after.beat - e.beat)
      : 0;
    let timeSec: number;
    if (typeof e.timeSec === 'number' && Number.isFinite(e.timeSec)) timeSec = e.timeSec;
    // The previous point is already complete, ramp slope included, so the
    // segment's far end is its own integral — one formula, used once here and
    // again on every lookup inside the segment.
    else if (out.length) timeSec = timeInSegment(out[out.length - 1], e.beat);
    else timeSec = e.beat * secPerBeat;
    out.push(Object.freeze({ beat: e.beat, bpm: e.bpm, timeSec, secPerBeat, slope }));
  }
  return Object.freeze(out) as unknown as TempoPoint[];
}

/**
 * The last point at or before `value` on `key`, the first point below that —
 * the same clamped upper bound the `notechart.ts` binary search used (Python's
 * `max(0, bisect_right(starts, value) - 1)`). Beats are strictly increasing
 * after normalization; `timeSec` is too unless an input supplied explicit
 * seconds that run backwards, which is not a supported map.
 */
function indexAt(points: readonly TempoPoint[], key: 'beat' | 'timeSec', value: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid][key] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : 0;
}

/** The point that owns `beat`. */
function pointAtBeat(points: readonly TempoPoint[], beat: number): TempoPoint {
  return points[indexAt(points, 'beat', beat)];
}

/** The point that owns `sec`. Seconds rise with beats, so this mirrors `pointAtBeat`. */
function pointAtTime(points: readonly TempoPoint[], sec: number): TempoPoint {
  return points[indexAt(points, 'timeSec', sec)];
}

/**
 * Quarter notes per minute in force at `beat`. An event owns its own beat, so
 * a ramp's far end reads as the NEXT event's tempo — which is the value the
 * ramp converges to anyway, so the curve is continuous there.
 */
export function getTempoAtBeat(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  return tempoInSegment(pointAtBeat(normalizeTempoMap(map), beat), beat);
}

/** Seconds in one quarter note at `beat`. */
export function getSecPerBeatAt(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  const p = pointAtBeat(normalizeTempoMap(map), beat);
  const bpm = tempoInSegment(p, beat);
  return bpm === p.bpm ? p.secPerBeat : 60 / bpm;
}

/**
 * Absolute seconds of `beat`. Piecewise integration of `60 / bpm`: the owning
 * event's own seconds, plus the beats since it — at its own rate on a step
 * segment, through the ramp integral on a `'linear'` one. Beats before the
 * first event extend that event's tempo backwards.
 */
export function beatToTime(map: readonly TempoEvent[] | null | undefined, beat: number): number {
  return timeInSegment(pointAtBeat(normalizeTempoMap(map), beat), beat);
}

/** The inverse of `beatToTime`. */
export function timeToBeat(map: readonly TempoEvent[] | null | undefined, sec: number): number {
  return beatInSegment(pointAtTime(normalizeTempoMap(map), sec), sec);
}

/**
 * Whether two normalized maps describe the same music. Identity first (the
 * common case, since the cache hands back the same frozen array), then field by
 * field — two arrays built from equal content normalize to equal points, and
 * every field here is either an input or derived from one, so equality on all
 * five means every conversion would agree.
 */
function samePoints(a: readonly TempoPoint[], b: readonly TempoPoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (p.beat !== q.beat || p.bpm !== q.bpm || p.timeSec !== q.timeSec
      || p.secPerBeat !== q.secPerBeat || p.slope !== q.slope) return false;
  }
  return true;
}

/** An item's position for `remapOnTempoChange`. */
export interface TempoAnchoredPosition {
  /**
   * The musical position the item is pinned to, in quarter notes. PRESENT means
   * the item is beat-anchored (a clip or note that must stay on its bar line
   * when the tempo changes); ABSENT means it is anchored to seconds (a recorded
   * take, an audio marker) and must not move at all.
   */
  beat?: number;
  /** Where the item sits today, in seconds under `prev`. */
  sec: number;
}

/**
 * The seconds every item should have once the tempo map changes from `prev` to
 * `next`. Returns one number per input, in order: a beat-anchored item gets the
 * seconds of its beat under `next`; a seconds-anchored item gets its `sec`
 * back, unchanged.
 *
 * Pure, and deliberately the whole job — it moves nothing and knows nothing
 * about clips, notes or stores. A caller applies the numbers to its own model.
 *
 * `prev` is the map the incoming `sec` values were measured under. A map that
 * did not actually change moves nothing, and that is decided by COMPARING THE
 * NORMALIZED POINTS, not by array identity: a store that rebuilt an equal array
 * (an undo that lands back on the same tempo, a re-imported project) must not
 * nudge every clip by a rounding error. The comparison walks two frozen arrays
 * of the same length, so it costs nothing next to the conversions it skips.
 *
 * DERIVING THE BEAT. An item that only knows its seconds is beat-anchored the
 * moment a caller says so, and its beat comes from the map those seconds were
 * measured under — `prev`, never `next`:
 *
 *     const items = clips.map((c) => ({ beat: timeToBeat(prev, c.startSec), sec: c.startSec }));
 *     const moved = remapOnTempoChange(prev, next, items);
 *
 * Do that ONCE, when the clip is first anchored, and store the beat: deriving
 * it again from seconds after every edit re-rounds the same position forever.
 * Seconds-anchored items are the ones that pass no `beat` at all.
 */
export function remapOnTempoChange(
  prev: readonly TempoEvent[] | null | undefined,
  next: readonly TempoEvent[] | null | undefined,
  positions: readonly TempoAnchoredPosition[],
): number[] {
  const from = normalizeTempoMap(prev);
  const to = normalizeTempoMap(next);
  if (samePoints(from, to)) return positions.map((p) => p.sec);
  return positions.map((p) => (typeof p.beat === 'number' && Number.isFinite(p.beat)
    ? timeInSegment(pointAtBeat(to, p.beat), p.beat)
    : p.sec));
}

/**
 * The quarter-note beat where `bar` starts, meter-aware. `meterMap.ts` counts
 * in 16th-note steps; four of those are one beat. Bar -1 (a pickup) starts at
 * beat 0, as it does there.
 */
export function getBeatAtBar(
  meterMap: readonly MeterSegment[] | null | undefined,
  bar: number,
  pickupSteps = 0,
): number {
  return barStartStep(normalizeMeterMap(meterMap, false), bar, pickupSteps) / 4;
}

/**
 * The bar holding `beat`, with where it starts and how long it is — all in
 * quarter notes. Negative beats read as beat 0, matching `meterMap.barAt`.
 *
 * `beatInBar` is clamped at 0. `meterMap.barAt` snaps to the next bar inside a
 * ~1e-9-step window below a bar line, so without the clamp a beat a hair under
 * a bar line would report the NEXT bar with a NEGATIVE offset into it — and
 * `beatClock.phase()` would hand out `beat: -1`, `sixteenth: 3` and a negative
 * `barFrac`, which the floor-based code it replaced could never produce.
 */
export function getBarAtBeat(
  meterMap: readonly MeterSegment[] | null | undefined,
  beat: number,
  pickupSteps = 0,
): BarPosition {
  const span = barAt(normalizeMeterMap(meterMap, false), beat * 4, pickupSteps);
  const startBeat = span.start / 4;
  return {
    bar: span.bar,
    startBeat,
    lengthBeats: span.len / 4,
    beatInBar: Math.max(0, beat - startBeat),
    meter: span.meter,
  };
}
