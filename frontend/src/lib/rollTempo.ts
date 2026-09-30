/**
 * rollTempo — the piano roll's tempo map: the events its document holds, and
 * the clocks that turn its 16th-note steps into seconds.
 *
 * The roll's document carries a `TempoEvent[]` beside its `bpm`. The first
 * event always sits at beat 0 and its tempo IS the roll's `bpm` (the header's
 * BPM field edits it); every later event is a tempo change, a ramp to the next
 * one, or a fermata (lib/tempoMap). A roll or a clip with one event plays at
 * one tempo, exactly as it did before maps existed.
 *
 * Positions: a tempo event's `beat` is a quarter note from the roll's first
 * step (the pickup's start, when there is one), so a step is `beat * 4`.
 * Beats are kept on the roll's ticks (1/PPQ of a quarter), so a map writes to
 * a .mid file at the same places it was drawn.
 *
 * Seconds: `stepClock` gives the seconds of any step, and its inverse, through
 * `tempoMap.beatToTime`. A one-tempo clock multiplies by the 16th's length,
 * the same arithmetic every caller used before, so a roll without changes
 * renders to the same samples.
 *
 * `lapClock` is the roll scheduler's version: the scheduler counts ABSOLUTE
 * steps that loop over a lap of roll steps (lib/rollTransport), and a lap of a
 * roll that speeds up takes as long as its own steps take, every time round.
 *
 * No Vite-only imports, so node tests load it.
 */
import { PPQ } from './noteClock';
import {
  FERMATA_STRETCH_MAX,
  FERMATA_STRETCH_MIN,
  beatToTime,
  clampTempoBpm,
  getTempoAtBeat,
  normalizeTempoMap,
  timeToBeat,
  type TempoEvent,
  type TempoFermata,
} from './tempoMap';
import { REANCHOR_STEPS, followLap, playRange, playStartLap, type Lap, type LapState, type PlayStart } from './rollTransport';

/** Quarter notes to a step: the roll's steps are 16ths. */
const STEPS_PER_BEAT = 4;

/** The shortest fermata, in quarter notes: one tick. */
export const MIN_FERMATA_BEATS = 1 / PPQ;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A beat on the roll's ticks, never negative. */
export const tickBeat = (beat: number): number => Math.max(0, Math.round((isNum(beat) ? beat : 0) * PPQ) / PPQ);

/**
 * A fermata the roll can hold: a hold of at least one tick and a stretch in
 * FERMATA_STRETCH_MIN..MAX, or undefined for one that holds no time at all.
 */
export function sanitizeFermata(f: Partial<TempoFermata> | null | undefined): TempoFermata | undefined {
  if (!f || !isNum(f.beats) || !isNum(f.stretch) || f.beats <= 0) return undefined;
  const beats = Math.max(MIN_FERMATA_BEATS, Math.round(f.beats * PPQ) / PPQ);
  const stretch = Math.max(FERMATA_STRETCH_MIN, Math.min(FERMATA_STRETCH_MAX, f.stretch));
  return { beats, stretch };
}

/**
 * A tempo map the roll can hold, as a new frozen array: tempo events sorted by
 * beat, one per beat (the later one wins), beats on ticks, each tempo inside
 * 20..300 and each curve `'step'` or `'linear'`; fermata markers sorted, one
 * per beat, with their holds brought into range. A first tempo event at beat 0
 * always exists: when the list has none there, one at `startBpm` is put in.
 * An event before beat 0 is dropped, so it never takes the start's place.
 * Seconds are never stored (lib/tempoStore says why).
 */
export function sanitizeRollTempoMap(events: readonly (Partial<TempoEvent> | null | undefined)[] | null | undefined, startBpm: number): TempoEvent[] {
  const tempos = new Map<number, TempoEvent>();
  const holds = new Map<number, TempoEvent>();
  for (const e of events ?? []) {
    if (!e || !isNum(e.beat) || e.beat < 0) continue;
    const beat = tickBeat(e.beat);
    if (e.fermata) {
      const fermata = sanitizeFermata(e.fermata);
      if (!fermata) continue;
      holds.set(beat, { beat, bpm: isNum(e.bpm) && e.bpm > 0 ? clampTempoBpm(e.bpm) : clampTempoBpm(startBpm), fermata });
      continue;
    }
    if (!isNum(e.bpm) || e.bpm <= 0) continue;
    tempos.set(beat, { beat, bpm: clampTempoBpm(e.bpm), curve: e.curve === 'linear' ? 'linear' : 'step' });
  }
  if (!tempos.has(0)) tempos.set(0, { beat: 0, bpm: clampTempoBpm(isNum(startBpm) && startBpm > 0 ? startBpm : 120), curve: 'step' });
  const out = [...tempos.values(), ...holds.values()].sort((a, b) => a.beat - b.beat || Number(!!a.fermata) - Number(!!b.fermata));
  for (const e of out) {
    if (e.fermata) Object.freeze(e.fermata);
    Object.freeze(e);
  }
  return Object.freeze(out) as TempoEvent[];
}

/** The roll's starting tempo: its beat-0 tempo event's. */
export const startTempoOf = (map: readonly TempoEvent[]): number | undefined =>
  map.find((e) => !e.fermata && e.beat === 0)?.bpm;

/** True when a map holds anything past its starting tempo: a change, a ramp's target or a fermata. */
export const hasTempoChanges = (map: readonly TempoEvent[] | null | undefined): boolean =>
  !!map && map.some((e) => !!e.fermata || e.beat > 0);

/** A deep copy, for a bounce, a save or an export. */
export const copyTempoMap = (map: readonly TempoEvent[]): TempoEvent[] =>
  map.map((e) => ({ ...e, ...(e.fermata ? { fermata: { ...e.fermata } } : {}) }));

/**
 * The map a clip or a render plays: `map` when it holds changes, with every
 * tempo scaled so its start is `bpm`, else one event at `bpm`. A clip keeps
 * `sourceBpm` beside its map, and a retag or a stretch rewrites only the
 * `sourceBpm`, so scaling here keeps every change in proportion to it.
 * For the roll's own store the two already agree and nothing is scaled.
 */
export function playedTempoMap(bpm: number, map?: readonly TempoEvent[] | null): readonly TempoEvent[] {
  const start = clampTempoBpm(isNum(bpm) && bpm > 0 ? bpm : 120);
  if (!hasTempoChanges(map)) return [{ beat: 0, bpm: start }];
  const own = sanitizeRollTempoMap(map, start);
  const from = startTempoOf(own) ?? start;
  if (from === start) return own;
  const k = start / from;
  return own.map((e) => (e.fermata ? e : { ...e, bpm: e.bpm * k }));
}

/** Seconds of roll steps, and back, at one map. */
export interface StepClock {
  /** Seconds from step 0 to `step`. */
  at: (step: number) => number;
  /** The step that sounds `sec` seconds after step 0. */
  stepAt: (sec: number) => number;
  /** A 16th's seconds when the whole clock holds one tempo, else undefined. */
  stepSec?: number;
  /** The map the clock reads. */
  map: readonly TempoEvent[];
}

/**
 * The clock of a roll or clip at `bpm` with `map`. With no changes it is the
 * product every caller computed before (`step * 60 / bpm / 4`), bit for bit.
 */
export function stepClock(bpm: number, map?: readonly TempoEvent[] | null): StepClock {
  const played = playedTempoMap(bpm, map);
  if (played.length === 1 && !played[0].fermata) {
    const stepSec = 60 / played[0].bpm / STEPS_PER_BEAT;
    return { at: (step) => step * stepSec, stepAt: (sec) => sec / stepSec, stepSec, map: played };
  }
  // Normalized once here, so a render's thousands of lookups share one cache entry.
  normalizeTempoMap(played);
  return {
    at: (step) => beatToTime(played, step / STEPS_PER_BEAT),
    stepAt: (sec) => timeToBeat(played, sec) * STEPS_PER_BEAT,
    map: played,
  };
}

/** Seconds a note from `step` lasting `length` steps sounds for. */
export const spanSec = (clock: StepClock, step: number, length: number): number =>
  clock.stepSec !== undefined ? length * clock.stepSec : clock.at(step + length) - clock.at(step);

/** Steps past `step` that `sec` seconds reach, at the tempo there. */
export const stepsIn = (clock: StepClock, step: number, sec: number): number =>
  clock.stepSec !== undefined ? sec / clock.stepSec : clock.stepAt(clock.at(step) + sec) - step;

/** The tempo in force at `step`, in quarter notes a minute (a fermata's slowed tempo inside one). */
export const tempoAtStep = (clock: StepClock, step: number): number =>
  clock.stepSec !== undefined ? 60 / clock.stepSec / STEPS_PER_BEAT : getTempoAtBeat(clock.map, step / STEPS_PER_BEAT);

// ── The scheduler's lap clock ────────────────────────────────────────────────

/**
 * The roll scheduler's clock: absolute step `anchorAbs` sounds at context time
 * `anchorTime`, and absolute steps map onto roll steps through `lap`. A lap
 * lasts as long as its roll steps take at `clock`, so every time round a loop
 * that holds a ritardando slows down in the same place.
 */
export interface LapClock {
  lap: Lap;
  clock: StepClock;
  anchorAbs: number;
  anchorTime: number;
}

/** Seconds of one lap: its roll steps from start to end. */
const lapSeconds = (lap: Lap, clock: StepClock): number => clock.at(lap.start + lap.len) - clock.at(lap.start);

/**
 * Seconds from the lap's base to absolute step `abs`: whole laps, then the
 * roll steps into this one. Continuous and increasing, so it has an inverse.
 */
export function lapOffsetSec(lap: Lap, clock: StepClock, abs: number): number {
  const rel = abs - lap.base;
  if (clock.stepSec !== undefined) return rel * clock.stepSec;
  const k = Math.floor(rel / lap.len);
  const off = rel - k * lap.len;
  return k * lapSeconds(lap, clock) + clock.at(lap.start + off) - clock.at(lap.start);
}

/** The absolute step `sec` seconds past the lap's base. The inverse of lapOffsetSec. */
export function lapStepAt(lap: Lap, clock: StepClock, sec: number): number {
  if (clock.stepSec !== undefined) return lap.base + sec / clock.stepSec;
  const dur = lapSeconds(lap, clock);
  const k = Math.floor(sec / dur);
  const r = sec - k * dur;
  const step = Math.min(lap.start + lap.len, clock.stepAt(clock.at(lap.start) + r));
  return lap.base + k * lap.len + (step - lap.start);
}

/** The context time absolute step `abs` sounds at. */
export const lapTimeOf = (c: LapClock, abs: number): number =>
  c.anchorTime + lapOffsetSec(c.lap, c.clock, abs) - lapOffsetSec(c.lap, c.clock, c.anchorAbs);

/** The absolute step sounding at context time `time`. */
export const lapAbsAt = (c: LapClock, time: number): number =>
  lapStepAt(c.lap, c.clock, lapOffsetSec(c.lap, c.clock, c.anchorAbs) + (time - c.anchorTime));

/**
 * The clock after the lap or the tempo changes, anchored at absolute step
 * `abs`: that step keeps the time it had, so nothing already scheduled moves
 * and the next note is timed by the new lap and the new map.
 */
export const reanchorLapClock = (c: LapClock, lap: Lap, clock: StepClock, abs: number): LapClock =>
  ({ lap, clock, anchorAbs: abs, anchorTime: lapTimeOf(c, abs) });

/**
 * A lap-local step's seconds, for a voice's bend automation: step `x` of the
 * lap (0 is the lap's start, one lap later is `lap.len`) at `clock`.
 */
export const lapLocalTime = (lap: Lap, clock: StepClock) => (x: number): number => lapOffsetSec(lap, clock, lap.base + x);

/** The slowest and fastest tempo a clip at `bpm` with `map` plays, rounded to whole BPM (fermatas are holds, not tempi). */
export function tempoSpan(bpm: number, map?: readonly TempoEvent[] | null): [number, number] {
  const tempi = playedTempoMap(bpm, map).filter((e) => !e.fermata).map((e) => Math.round(e.bpm));
  return [Math.min(...tempi), Math.max(...tempi)];
}

// ── The scheduler's play state ───────────────────────────────────────────────

/** The roll fields PLAY reads each tick: where it starts and loops, and its tempo. */
export interface RollPlaySource extends PlayStart {
  bpm: number;
  tempoMap: readonly TempoEvent[];
}

/**
 * What the roll's scheduler carries between ticks: the lap (lib/rollTransport),
 * the clock that times it, and the tempo that clock was built from.
 */
export interface RollPlayState {
  lapState: LapState;
  clock: LapClock;
  steps: StepClock;
  tempo: { bpm: number; map: readonly TempoEvent[] };
}

/** PLAY's first state: the lap from the playhead, absolute step 0 sounding at `startTime`. */
export function startRollPlay(roll: RollPlaySource, startTime: number): RollPlayState {
  const lapState = playStartLap(roll);
  const steps = stepClock(roll.bpm, roll.tempoMap);
  return {
    lapState,
    steps,
    tempo: { bpm: roll.bpm, map: roll.tempoMap },
    clock: { lap: lapState.lap, clock: steps, anchorAbs: 0, anchorTime: startTime },
  };
}

/**
 * The state after a tick reads the roll, with `cursor` the absolute step
 * scheduled up to. A seek, a new length or a new loop re-anchors the lap just
 * past the cursor (followLap); a new tempo map or BPM rebuilds the clock at the
 * cursor. Either way the step it anchors at keeps its time, so a note already
 * scheduled never moves and the next one is timed by the new map. Nothing new
 * gives back the same object, so the caller can tell a re-anchor by identity.
 */
export function followRollPlay(state: RollPlayState, roll: RollPlaySource, cursor: number): RollPlayState {
  const newTempo = state.tempo.bpm !== roll.bpm || state.tempo.map !== roll.tempoMap;
  const followed = followLap(
    state.lapState,
    { range: playRange(roll.loop, roll.loopOn, Math.max(1, roll.totalSteps)), seekId: roll.seekId, playhead: roll.currentStep },
    cursor,
  );
  if (followed === state.lapState && !newTempo) return state;
  const steps = newTempo ? stepClock(roll.bpm, roll.tempoMap) : state.steps;
  const at = followed !== state.lapState ? cursor + REANCHOR_STEPS : cursor;
  return {
    lapState: followed,
    steps,
    tempo: newTempo ? { bpm: roll.bpm, map: roll.tempoMap } : state.tempo,
    clock: reanchorLapClock(state.clock, followed.lap, steps, at),
  };
}
