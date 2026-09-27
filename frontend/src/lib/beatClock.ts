/**
 * beatClock — ONE bar/beat phase for every surface.
 *
 * Before this, tempo lived in five unrelated places (EDIT bpm, PERFORM
 * project.tempo, DJ per-deck analysis, NodeF.I. Live Out, the arp) and the only
 * launch quantizer in the app was PERFORM's bars-only `nextLaunchTime`, anchored
 * to a component-local ref nothing else could read. This module holds a single
 * (bpm, meter map, anchor) on the shared AudioContext so LOOM, the DJ shard
 * pads, PERFORM slots and NodeF.I. can all ask "when is the next bar?" and get
 * the same answer.
 *
 * The anchor is the AudioContext time of bar 0, beat 0. `setBpm` re-anchors so
 * the CURRENT beat position is preserved (no phase jump when a deck drifts).
 * The first `nextGrid` call with no anchor makes NOW bar 0, so a cold start is
 * immediate and everything after it lines up.
 *
 * The clock owns no arithmetic of its own. Beats and seconds go through
 * `tempoMap.ts` and bar lengths come from `meterMap.ts`, so `nextGrid('bar')`
 * is right in 7/8 and across a meter change — not just in 4/4. A beat is a
 * QUARTER NOTE everywhere here, whatever the meter, which is why a 7/8 bar is
 * 3.5 beats and `setBeatsPerBar(7)` means 7/4.
 *
 * TEMPO MAP. The clock holds a whole `TempoEvent[]`, not a bpm: `setTempoMap`
 * installs one (that is how `state/tempoStore.ts`, its owner, reaches the
 * clock) and `setBpm` is the constant-tempo shorthand that REPLACES the map
 * with one event. The 20..300 clamp here is the app's one tempo clamp and is
 * exported for the store to reuse; nothing else is allowed to define another.
 * The map installed here carries no `timeSec`: the clock rebases so beat 0 is
 * at second 0 — see `clampEvents` for why that is load-bearing.
 *
 * While the map is a single event — every caller today, and every case the
 * pinned tests cover — seconds and beats are proportional and `nextGrid` /
 * `timeOf` use the closed form they always have, to the float. The moment it is
 * not (a tempo change, or a ramp) those paths walk the map in BEATS instead,
 * the same way `nextBarLine` already walks a changing meter.
 *
 * THE START-TEMPO SCALARS. `beatSec()`, `barSec()` and `gridSec()` return a
 * single number, so they cannot express a changing tempo at all: they describe
 * the tempo the map STARTS at, and anything that needs an exact position must
 * ask `timeOf` / `nextGrid` / `phase`. Four callers still read them and must
 * migrate under T02, which is why all three carry an `@deprecated` line:
 *   - `components/session/DawSessionGrid.tsx:1146-1147` (`barSec`, `gridSec`)
 *   - `lib/loomEngine.ts:152` (`beatSec`)
 *   - `lib/modulation.ts:184,:186` (`beatSec`, `gridSec`)
 *   - `components/loom/ColonyCanvas.tsx:277` (`beatSec`)
 * Each is a per-frame or per-step duration derived once and reused across a
 * span, which is exactly the shape that silently drifts under a ramp.
 */
import { getEngineCtx } from '../state/playerStore';
import { DEFAULT_METER } from './colony';
import { meterAtBar, normalizeMeterMap, stepsPerBar, type MeterSegment } from './meterMap';
import {
  TEMPO_BPM_MAX, TEMPO_BPM_MIN, beatToTime, clampTempoBpm, getBarAtBeat, getBarLength, getBeatAtBar, getTempoAtBeat,
  timeToBeat, type TempoEvent,
} from './tempoMap';

export type ClockGrid = 'now' | '16th' | '8th' | 'beat' | 'half' | 'bar' | '2bar' | '4bar';
export type ClockSource = 'internal' | 'dj' | 'perform' | 'edit' | 'nodefi' | 'loom';

export interface BeatClockState {
  bpm: number;
  /** Quarter notes in bar 0's bar. 4/4 is 4, 7/8 is 3.5. */
  beatsPerBar: number;
  /** AudioContext time of bar 0 beat 0; null until something has launched. */
  anchor: number | null;
  source: ClockSource;
}

export interface ClockPhase {
  bar: number;
  beat: number;
  sixteenth: number;
  /** 0..1 inside the current beat. */
  beatFrac: number;
  /** 0..1 inside the current bar. */
  barFrac: number;
}

type Listener = (s: BeatClockState) => void;

/** Small scheduling lead so a launch computed "now" is never already past. */
export const CLOCK_LEAD_SEC = 0.01;

/**
 * The app's ONE tempo clamp, read from `tempoMap.ts` (TEMPO_BPM_MIN..MAX), the
 * pure module the piano roll's store also reads it from. The clock re-exports
 * it because it is the tempo owner; `state/tempoStore.ts` imports
 * `clampClockBpm` rather than writing a second range, which is how tempo used
 * to end up with three of them.
 */
export const CLOCK_BPM_MIN = TEMPO_BPM_MIN;
export const CLOCK_BPM_MAX = TEMPO_BPM_MAX;
export const clampClockBpm = (bpm: number): number => clampTempoBpm(bpm);

const state: BeatClockState = { bpm: 120, beatsPerBar: 4, anchor: null, source: 'internal' };
const listeners = new Set<Listener>();

/** The meter half. One segment until something calls `setMeterMap`. */
let meterSegs: MeterSegment[] = normalizeMeterMap([{ bar: 0, meter: { ...DEFAULT_METER, groups: [] } }]);
/**
 * The tempo half. One event until something calls `setTempoMap`, so every
 * conversion is the constant-tempo one. READ ONLY from here: `tempoMap.ts`
 * caches its normalization on this array's identity, so the map is changed by
 * replacing the array, never by touching it in place.
 */
let tempoEvents: readonly TempoEvent[] = [{ beat: 0, bpm: state.bpm }];

/**
 * `meterSegs` with each segment's first bar in 16th-note steps, accumulated
 * left to right exactly as `meterMap.barStartStep` does — so a bar start read
 * from here is the same float that `getBeatAtBar` returns. Rebuilt when the
 * meter map changes, so walking bar lines costs no allocation and no sort:
 * `nextGrid` runs on the loom/colony launch path, and calling `meterAtBar` /
 * `getBeatAtBar` per bar re-normalized the whole map (Map + sort + allocate)
 * on every iteration.
 */
interface MeterSpan { bar: number; startStep: number; steps: number }
let meterSpans: MeterSpan[] = [];

function rebuildMeterSpans(): void {
  meterSpans = [];
  let startStep = 0;
  for (let i = 0; i < meterSegs.length; i += 1) {
    if (i > 0) startStep += (meterSegs[i].bar - meterSegs[i - 1].bar) * stepsPerBar(meterSegs[i - 1].meter);
    meterSpans.push({ bar: meterSegs[i].bar, startStep, steps: stepsPerBar(meterSegs[i].meter) });
  }
}
rebuildMeterSpans();

/** Whole bars between two lines of a bar-relative grid. */
const BAR_STRIDE: Partial<Record<ClockGrid, number>> = { half: 0.5, bar: 1, '2bar': 2, '4bar': 4 };
/** Quarter notes between two lines of a sub-beat grid. The rest are bar-relative. */
const BEAT_STRIDE: Partial<Record<ClockGrid, number>> = { '16th': 0.25, '8th': 0.5, beat: 1 };

const emit = () => { for (const l of listeners) l({ ...state }); };

function now(): number {
  try { return getEngineCtx().currentTime; } catch { return 0; }
}

/** Seconds from the anchor to `beat`. */
const secOfBeat = (beat: number): number => beatToTime(tempoEvents, beat);

/**
 * True while the map is a single event, i.e. while seconds and beats are
 * proportional. Every grid then has a closed form in seconds, which is the one
 * the clock has always used and which the captured test values pin.
 */
const constantTempo = (): boolean => tempoEvents.length === 1;

/**
 * Every bpm clamped to the clock's range, and every authoritative `timeSec`
 * DROPPED, so beat 0 of the clock's map is always at second 0.
 *
 * The seconds matter more than the clamp. `nextGrid` uses a closed form
 * (`anchor + n * unit`) while the tempo is constant, which assumes beat 0 sits
 * on the anchor; `timeOf` and `phase` ask `tempoMap.ts` instead. A single event
 * like `{ beat: 4, bpm: 120, timeSec: 10 }` would pin beat 4 at 10 s, put beat
 * 0 at 8 s, and make those two answers disagree by a constant nobody could see.
 * The clock is a live phase, not a score: it rebases, and the map it holds
 * carries no seconds at all. A caller that has authoritative seconds (a
 * `notechart`) converts with that map directly rather than installing it here.
 *
 * The array's IDENTITY is kept when nothing needed rewriting, so the caller's
 * map still hits `tempoMap`'s cache. A bpm that is not a positive number is
 * left alone for `normalizeTempoMap` to drop — clamping it would turn junk into
 * a 20 bpm segment.
 */
function clampEvents(events: readonly TempoEvent[] | null | undefined): readonly TempoEvent[] {
  if (!events || events.length === 0) return [{ beat: 0, bpm: state.bpm }];
  const out: TempoEvent[] = [];
  let changed = false;
  for (const e of events) {
    if (!e) { changed = true; continue; }
    const bpm = Number.isFinite(e.bpm) && e.bpm > 0 ? clampClockBpm(e.bpm) : e.bpm;
    if (bpm === e.bpm && e.timeSec === undefined) { out.push(e); continue; }
    changed = true;
    const copy: TempoEvent = { beat: e.beat, bpm };
    if (e.curve) copy.curve = e.curve;
    // A fermata marker is kept with its hold, or the clock would read it as a tempo change.
    if (e.fermata) copy.fermata = { ...e.fermata };
    out.push(copy);
  }
  return changed ? out : events;
}

/**
 * Install `next` without a phase jump: the beat we are on stays the beat we are
 * on, which is the rule `setBpm` has always followed and the reason a deck
 * nudging its tempo does not restart the bar.
 */
function installTempo(next: readonly TempoEvent[], source?: ClockSource): void {
  const t = now();
  const beatsElapsed = state.anchor != null ? timeToBeat(tempoEvents, t - state.anchor) : 0;
  tempoEvents = next;
  state.bpm = getTempoAtBeat(next, 0);
  if (state.anchor != null) state.anchor = t - secOfBeat(beatsElapsed);
  if (source) state.source = source;
  emit();
}

/**
 * The first line of a sub-beat grid at or after `t`, walked in BEATS. Only
 * needed once the tempo map has more than one event: while it has one, the
 * lines are evenly spaced in seconds and `nextGrid` uses the closed form.
 */
function nextBeatLine(t: number, strideBeats: number): number {
  const anchor = state.anchor ?? t;
  const beats = timeToBeat(tempoEvents, t - anchor);
  const n = Math.ceil(beats / strideBeats - 1e-6);
  return anchor + secOfBeat(n * strideBeats);
}

/**
 * The first line of a bar-relative grid at or after `t`. Only needed once the
 * meter map has more than one segment: with a single meter the lines are
 * evenly spaced and `nextGrid` uses the closed form instead.
 */
function nextBarLine(t: number, stride: number): number {
  const anchor = state.anchor ?? t;
  const beats = timeToBeat(tempoEvents, t - anchor);
  const last = meterSpans[meterSpans.length - 1];
  // From this bar on the meter never changes again, so the grid is uniform.
  const uniformFrom = stride >= 1 ? Math.ceil(last.bar / stride) * stride : last.bar;
  let si = 0;
  for (let bar = 0; bar < uniformFrom; bar += 1) {
    while (si + 1 < meterSpans.length && meterSpans[si + 1].bar <= bar) si += 1;
    if (stride >= 1 && bar % stride !== 0) continue;
    const span = meterSpans[si];
    const len = span.steps / 4;
    const start = (span.startStep + (bar - span.bar) * span.steps) / 4;
    if (start >= beats - 1e-6 * len) return anchor + secOfBeat(start);
    if (stride < 1 && start + len / 2 >= beats - 1e-6 * len) return anchor + secOfBeat(start + len / 2);
  }
  const len = last.steps / 4;
  const unit = stride < 1 ? len / 2 : len * stride;
  const base = (last.startStep + (uniformFrom - last.bar) * last.steps) / 4;
  const n = Math.ceil((beats - base) / unit - 1e-6);
  return anchor + secOfBeat(base + n * unit);
}

export const beatClock = {
  get state(): BeatClockState { return { ...state }; },
  get bpm(): number { return state.bpm; },
  get beatsPerBar(): number { return state.beatsPerBar; },
  /** The meter map the bar grid is built on. */
  get meterMap(): MeterSegment[] { return meterSegs.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...s.meter.groups] } })); },
  /**
   * The tempo map the beat grid is built on. A fresh COPY per read, like
   * `meterMap` — hold on to it if you are going to convert with it, because
   * `tempoMap.ts` caches on array identity and a fresh array re-normalizes.
   */
  get tempoMap(): TempoEvent[] { return tempoEvents.map((e) => ({ ...e })); },
  /**
   * Seconds in one quarter note at the tempo the map STARTS at.
   * @deprecated A start-tempo scalar: wrong the moment the map ramps or
   * changes. Migrate to `timeOf` / `nextGrid` / `phase` under T02 — callers are
   * `lib/loomEngine.ts:152`, `lib/modulation.ts:184`,
   * `components/loom/ColonyCanvas.tsx:277`.
   */
  beatSec(): number { return 60 / state.bpm; },

  /** Quarter notes in `bar`'s bar. */
  beatsPerBarAt(bar: number): number { return getBarLength(meterAtBar(meterSegs, bar)); },

  /**
   * Seconds in `bar`'s bar at the tempo the map STARTS at.
   * @deprecated A start-tempo scalar: wrong the moment the map ramps or
   * changes. Migrate to `timeOf` / `nextGrid` / `phase` under T02 — the caller
   * is `components/session/DawSessionGrid.tsx:1146`.
   */
  barSec(bar = 0): number { return (60 / state.bpm) * this.beatsPerBarAt(bar); },

  /**
   * Seconds per grid unit. Bar-relative grids are measured on `bar`'s bar.
   * @deprecated A start-tempo scalar: wrong the moment the map ramps or
   * changes. Migrate to `timeOf` / `nextGrid` / `phase` under T02 — callers are
   * `components/session/DawSessionGrid.tsx:1147` and `lib/modulation.ts:186`.
   * (`nextGrid` still calls it, but only on the path it has already proved the
   * tempo constant on.)
   */
  gridSec(grid: ClockGrid, bar = 0): number {
    const beat = 60 / state.bpm;
    const beatsPerBar = this.beatsPerBarAt(bar);
    switch (grid) {
      case 'now': return 0;
      case '16th': return beat / 4;
      case '8th': return beat / 2;
      case 'beat': return beat;
      case 'half': return beat * beatsPerBar / 2;
      case 'bar': return beat * beatsPerBar;
      case '2bar': return beat * beatsPerBar * 2;
      case '4bar': return beat * beatsPerBar * 4;
    }
  },

  /** Make `at` (default now) bar `bar`, beat 0. */
  setAnchor(at?: number, bar = 0): void {
    const t = at ?? now();
    state.anchor = t - secOfBeat(getBeatAtBar(meterSegs, bar));
    emit();
  },

  /**
   * Constant tempo, without a phase jump: the beat we are on stays the beat we
   * are on. This REPLACES the whole map with one event — which is what it has
   * always meant, and is why a map installed by `setTempoMap` collapses here
   * even when the starting tempo is the one already showing.
   */
  setBpm(bpm: number, source?: ClockSource): void {
    const next = clampClockBpm(bpm);
    if (constantTempo() && Math.abs(next - state.bpm) < 1e-6 && (!source || source === state.source)) return;
    installTempo([{ beat: 0, bpm: next }], source);
  },

  /**
   * The whole tempo map, ramps and all — `state/tempoStore.ts` owns the array
   * and pushes it here. Every bpm is clamped to this module's range, the one
   * the app has. An empty or missing map leaves the tempo where it is, as a
   * single constant event, rather than silently snapping to the 120 default.
   *
   * The array is stored as given (identity intact, so `tempoMap.ts`'s cache
   * keeps hitting) and never mutated.
   */
  setTempoMap(events: readonly TempoEvent[] | null | undefined, source?: ClockSource): void {
    const next = clampEvents(events);
    if (next === tempoEvents && (!source || source === state.source)) return;
    installTempo(next, source);
  },

  /** Every bar is `n` quarter notes, i.e. n/4. The whole-bar shorthand for `setMeterMap`. */
  setBeatsPerBar(n: number): void {
    const v = Math.max(1, Math.min(16, Math.round(n)));
    if (v === state.beatsPerBar && meterSegs.length === 1) return;
    this.setMeterMap([{ bar: 0, meter: { num: v, den: 4, groups: [] } }]);
  },

  /** Time signatures by bar, so bar lines are right outside 4/4. */
  setMeterMap(map: readonly MeterSegment[] | null | undefined): void {
    meterSegs = normalizeMeterMap(map);
    rebuildMeterSpans();
    state.beatsPerBar = this.beatsPerBarAt(0);
    emit();
  },

  /** Where we are, at `at` (default now). */
  phase(at?: number): ClockPhase {
    const t = at ?? now();
    const anchor = state.anchor ?? t;
    const beats = Math.max(0, timeToBeat(tempoEvents, t - anchor));
    const pos = getBarAtBeat(meterSegs, beats);
    const beatIdx = Math.floor(pos.beatInBar);
    const beatFrac = pos.beatInBar - beatIdx;
    return {
      bar: pos.bar,
      beat: beatIdx,
      sixteenth: Math.floor(beatFrac * 4),
      beatFrac,
      barFrac: pos.beatInBar / pos.lengthBeats,
    };
  },

  /** The next `grid` line at or after `from` (default now + lead). A cold clock
   *  anchors itself at `from`, so the first launch is immediate. */
  nextGrid(grid: ClockGrid, from?: number): number {
    const t = from ?? now() + CLOCK_LEAD_SEC;
    if (state.anchor == null) {
      state.anchor = t;
      emit();
      return t;
    }
    if (grid === 'now') return t;
    const stride = BAR_STRIDE[grid];
    // Lines are only evenly spaced in SECONDS while both the meter and the
    // tempo hold; walk them in beats once either does not.
    if (stride !== undefined) {
      if (meterSegs.length > 1 || !constantTempo()) return nextBarLine(t, stride);
    } else if (!constantTempo()) {
      return nextBeatLine(t, BEAT_STRIDE[grid] ?? 1);
    }
    const unit = this.gridSec(grid);
    const n = Math.ceil((t - state.anchor) / unit - 1e-6);
    return state.anchor + n * unit;
  },

  /** Time of an absolute step: bar `bar`, plus `stepsIntoBar` of `stepsPerBar`. */
  timeOf(bar: number, stepsIntoBar = 0, stepsPerBar = 16): number {
    const anchor = state.anchor ?? now();
    const beat = getBeatAtBar(meterSegs, bar);
    // A fraction of the bar is a fraction of its SECONDS only at a constant
    // tempo; otherwise the offset is a fraction of its BEATS, converted.
    if (stepsIntoBar && !constantTempo()) {
      return anchor + secOfBeat(beat + (stepsIntoBar / stepsPerBar) * this.beatsPerBarAt(bar));
    }
    return anchor + secOfBeat(beat) + (stepsIntoBar / stepsPerBar) * this.barSec(bar);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

export type BeatClock = typeof beatClock;
