/**
 * modulation — ONE abstraction for "something moves a parameter".
 *
 * Before this the app had exactly one piece of live modulation machinery and it
 * was welded into NodeF.I.: `nodefiLive.ts` kept a private `controlMods` list, a
 * private 33 ms `setInterval`, a private four-case shape switch and a private
 * clamp, all of which only ever knew how to drive a Rack FX param on a NodeF.I.
 * graph node. Nothing else in the app could be modulated by anything, and the
 * LFO shapes lived in a switch no test could reach.
 *
 * This module is that machinery, generalised and pulled out:
 *
 *   SOURCES  — an LFO (five shapes, free-running or tempo-synced), a macro
 *              (a 0..1 knob the UI owns), or an automation lane sampled at time.
 *   TARGETS  — a rack param (a plain number behind `RackEffectInstance.setParams`,
 *              so it can only move at CONTROL rate) or an AudioParam (which takes
 *              an audio-rate signal and never touches the main thread).
 *   ROUTES   — source → target with a signed amount and a polarity, summed
 *              per target and clamped to the target's range.
 *
 * The file has two halves with a hard seam between them. Everything above
 * `createModEngine` is pure: no AudioContext, no store, no timers, no clock
 * reads except the tempo-sync helper, which delegates to `beatClock` rather than
 * keeping a second grid table. Everything below it is the runtime — one ticker
 * for control-rate targets and a Web Audio hookup for audio-rate ones.
 *
 * WHY TWO RATES. A rack param is a JS number: the only way to move it is to call
 * `setParams` from a timer, which is what NodeF.I. already did at 33 ms. An
 * AudioParam is a scheduled a-rate value: an oscillator connected into it moves
 * it per sample, with no main-thread jitter and no timer at all. Neither one can
 * do the other's job, so the engine offers both and the caller picks by target.
 *
 * DESIGN SOURCES (read for their design only — NO code was copied from them):
 *   - Tracktion Engine `modules/tracktion_engine/model/automation/
 *     tracktion_MacroParameter.h` and `tracktion_AutomatableParameter.cpp`
 *     (GPL-3.0 or commercial) — the shape of a modifier/macro assignment: a
 *     source, a target parameter, a signed depth, and a per-target sum that is
 *     clamped to the target parameter's own range rather than to the source's.
 *     That is a behavioural description; every line below was written here.
 *
 * ADAPTED (MIT, may be lifted with its notice):
 *   - Soundscape `packages/engine/src/audio/VoiceSynthesizer.ts` (lines ~110-139)
 *     — the audio-rate LFO wiring in `connectAudioRate` follows its idiom:
 *     `createOscillator()` → `createGain()` holding the DEPTH → connect the gain
 *     into the destination AudioParam → start the oscillator.
 *
 *     SPDX-License-Identifier: MIT
 *     Upstream: oss-refs/soundscape/packages/engine/src/audio/VoiceSynthesizer.ts
 *     Full licence text: oss-refs/soundscape/LICENSE
 *
 *     MIT License
 *
 *     Copyright (c) 2026 Anthony Liddle
 *
 *     Permission is hereby granted, free of charge, to any person obtaining a copy
 *     of this software and associated documentation files (the "Software"), to deal
 *     in the Software without restriction, including without limitation the rights
 *     to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *     copies of the Software, and to permit persons to whom the Software is
 *     furnished to do so, subject to the following conditions:
 *
 *     The above copyright notice and this permission notice shall be included in all
 *     copies or substantial portions of the Software.
 *
 *     THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *     IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *     FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *     AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *     LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *     OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *     SOFTWARE.
 */
import { beatClock, type ClockGrid } from './beatClock.ts';
import { sampleCurve, type CurvePoint } from './automationModes.ts';

/* ── Types ────────────────────────────────────────────────────────────────── */

/** LFO shapes. `sh` is sample-and-hold: one random level per cycle, held. */
export type ModShape = 'sine' | 'tri' | 'saw' | 'square' | 'sh';

export interface LfoSource {
  kind: 'lfo';
  shape: ModShape;
  /** Cycles per second. Ignored when `sync` is set. */
  rateHz: number;
  /** Modulation depth as a FRACTION of the target's range (see `normalizedDepth`). */
  depth: number;
  /** Starting phase in cycles, 0..1. Absent = 0. */
  phase0?: number;
  /** Tempo sync: one cycle per grid unit, using `beatClock`'s grid. */
  sync?: ClockGrid;
}

export interface MacroSource {
  kind: 'macro';
  id: string;
  /** 0..1. */
  value: number;
}

export interface LaneSource {
  kind: 'lane';
  laneId: string;
}

export type ModSource = LfoSource | MacroSource | LaneSource;

export interface RackParamTarget {
  kind: 'rackParam';
  scope: 'track' | 'master' | 'bus';
  /** Chain entry / graph node that owns the rack. */
  entryId: string;
  paramKey: string;
  min: number;
  max: number;
}

export interface AudioParamTarget {
  kind: 'audioParam';
  param: AudioParam;
  /** Un-modulated value, used when the caller supplies no base. */
  base: number;
  min: number;
  max: number;
}

export type ModTarget = RackParamTarget | AudioParamTarget;

export interface ModRoute {
  id: string;
  source: ModSource;
  target: ModTarget;
  /** Signed scale on the source, −1..1. Negative inverts it. */
  amount: number;
  /** True when the route wants a −1..1 sample, false when it wants 0..1. The
   *  source's own range is converted into this, whichever way round it is. */
  bipolar: boolean;
}

/** Structural twin of `editorStore`'s `AutomationLane`, declared here so the
 *  pure core never imports the store. An editor lane is assignable to it. */
export interface ModLane {
  id: string;
  points: readonly CurvePoint[];
  enabled: boolean;
}

/** Everything a source needs that is not on the source itself. Every field is
 *  optional: a source that does not need it is sampled with `{}`. */
export interface ModContextState {
  /** Tempo for synced LFOs. Defaults to the shared clock's. */
  bpm?: number;
  /** Reader for `lane` sources — injected, so the core has no store import. */
  getLane?: (id: string) => ModLane | undefined;
  /** Sample-and-hold RNG: step index → [0,1). Must be a PURE function of the
   *  step, so a given time always samples to the same level. */
  rng?: (step: number) => number;
}

/* ── Pure core ────────────────────────────────────────────────────────────── */

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Phase in [0,1) for a position in cycles. For a non-negative `x` this is
 * exactly `x % 1` — deliberately, because NodeF.I.'s ticker used the bare
 * modulo and the bit pattern of every shape it drew has to survive this move.
 * Only a negative `x` (the ~120 ms NodeF.I. ticks before its own start time)
 * takes the extra add, where the bare modulo used to run a triangle up to 1.2.
 */
const wrapCycle = (x: number): number => {
  if (!Number.isFinite(x)) return 0;
  const c = x % 1;
  return c < 0 ? c + 1 : c;
};

/**
 * Quarter notes per grid unit, read from `beatClock` rather than re-tabulated
 * here — the clock owns the bar length, so this is right in 7/8 too. The ratio
 * is tempo-free (both terms scale with 1/bpm), so the clock's current BPM does
 * not leak into a caller that supplied its own.
 */
export const gridBeats = (grid: ClockGrid): number => {
  const beat = beatClock.beatSec();
  if (!(beat > 0)) return 0;
  const sec = beatClock.gridSec(grid, 0);
  return Number.isFinite(sec) ? sec / beat : 0;
};

/** One cycle per grid unit: `rateHz = bpm/60 ÷ beats-per-cycle`. */
export const syncedRateHz = (sync: ClockGrid, bpm: number): number => {
  const beats = gridBeats(sync);
  return beats > 0 ? bpm / 60 / beats : 0;
};

/** The rate an LFO actually runs at: its own, or the tempo's when synced. */
export const lfoRate = (source: LfoSource, state: ModContextState = {}): number => {
  if (source.sync) return syncedRateHz(source.sync, state.bpm ?? beatClock.bpm);
  return Number.isFinite(source.rateHz) ? source.rateHz : 0;
};

/**
 * Default sample-and-hold RNG: a pure integer hash of the step index, so the
 * level for a given cycle is the same however many times (and in whatever
 * order) it is asked for. A stateful generator would make the value depend on
 * how often the ticker happened to fire, which is not a musical parameter.
 */
export const shRandom = (step: number): number => {
  let x = Math.imul(step | 0, 0x9e3779b1) ^ 0x85ebca6b;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
};

/**
 * The source's value at `tSec`, in its OWN natural range: [-1,1] for an LFO,
 * [0,1] for a macro or a lane. Depth, amount, polarity and the target range are
 * not applied here — `applyRoutes` does that, so one source can feed several
 * routes at different depths from a single evaluation.
 */
export function sampleSource(source: ModSource, tSec: number, state: ModContextState = {}): number {
  if (source.kind === 'macro') return clamp01(source.value);
  if (source.kind === 'lane') {
    const lane = state.getLane?.(source.laneId);
    if (!lane || !lane.enabled) return 0;
    const v = sampleCurve(lane.points, tSec);
    return v === null ? 0 : clamp01(v);
  }
  const rate = lfoRate(source, state);
  const pos = rate * tSec + (source.phase0 ?? 0);
  if (source.shape === 'sh') {
    const step = Number.isFinite(pos) ? Math.floor(pos) : 0;
    return (state.rng ?? shRandom)(step) * 2 - 1;
  }
  const cyc = wrapCycle(pos);
  switch (source.shape) {
    case 'square': return cyc < 0.5 ? 1 : -1;
    case 'saw': return 2 * cyc - 1;
    case 'tri': return 4 * Math.abs(cyc - 0.5) - 1;
    default: return Math.sin(2 * Math.PI * cyc);
  }
}

/** AudioParams have no id of their own, so identity is handed out lazily and
 *  kept weakly — a param whose node is gone takes its key with it. */
const audioParamKeys = new WeakMap<AudioParam, string>();
let audioParamSeq = 0;

/** Stable identity for a target. Two routes sharing one of these sum into it. */
export const targetKey = (target: ModTarget): string => {
  if (target.kind === 'rackParam') return `rack|${target.scope}|${target.entryId}|${target.paramKey}`;
  let k = audioParamKeys.get(target.param);
  if (!k) {
    audioParamSeq += 1;
    k = `param|${audioParamSeq}`;
    audioParamKeys.set(target.param, k);
  }
  return k;
};

/**
 * The target's range, as the multiplier a normalised depth is scaled by. A
 * target with no usable span (an unbounded NodeF.I. param that declares no
 * descriptor) uses 1, so its depth passes through in the param's own units —
 * which is exactly what NodeF.I.'s ticker did before this module existed.
 */
export const spanOf = (target: ModTarget): number => {
  const s = target.max - target.min;
  return Number.isFinite(s) && s > 0 ? s : 1;
};

/** A depth in the target's NATURAL units, expressed as the fraction of its
 *  range that `ModSource.depth` wants. The inverse of the span multiply. */
export const normalizedDepth = (rawDepth: number, target: ModTarget): number => rawDepth / spanOf(target);

const depthOf = (source: ModSource): number =>
  source.kind === 'lfo' && Number.isFinite(source.depth) ? source.depth : 1;

/** A source's natural range: LFOs swing either side of zero, controllers do not. */
const isBipolarSource = (source: ModSource): boolean => source.kind === 'lfo';

/** Convert a sample from its source's natural range into the route's. */
const toRoutePolarity = (sample: number, route: ModRoute): number => {
  const natural = isBipolarSource(route.source);
  if (route.bipolar === natural) return sample;
  return route.bipolar ? sample * 2 - 1 : (sample + 1) / 2;
};

/**
 * Sum every route into its target and clamp the total.
 *
 *   value = base + Σ amount · depth · sample · (max − min),  clamped to [min,max]
 *
 * `samples` is keyed by ROUTE id (one evaluation per route), `bases` by TARGET
 * key; a target with no base given starts from its own `base` for an AudioParam
 * and from 0 otherwise. The result has one entry per TARGET, never per route,
 * which is what makes "one write per target per tick" possible.
 *
 * TRAP, for whoever builds the mod matrix: when several routes resolve to the
 * same target KEY, the FIRST one's `min`/`max` win the clamp (and its `base`
 * fallback), because the key — not the object — is the identity. Each route
 * still scales by its OWN `spanOf`, so two routes naming one param with
 * disagreeing ranges will not agree about depth either. Keep one range per key.
 */
export function applyRoutes(
  routes: readonly ModRoute[],
  samples: Readonly<Record<string, number>>,
  bases: Readonly<Record<string, number>>,
): Record<string, number> {
  const sums = new Map<string, { value: number; target: ModTarget }>();
  for (const route of routes) {
    const key = targetKey(route.target);
    let acc = sums.get(key);
    if (!acc) {
      const base = bases[key] ?? (route.target.kind === 'audioParam' ? route.target.base : 0);
      acc = { value: Number.isFinite(base) ? base : 0, target: route.target };
      sums.set(key, acc);
    }
    const raw = samples[route.id];
    if (!Number.isFinite(raw)) continue;
    const sample = toRoutePolarity(raw, route);
    const amount = Number.isFinite(route.amount) ? route.amount : 0;
    acc.value += amount * depthOf(route.source) * sample * spanOf(route.target);
  }
  const out: Record<string, number> = {};
  for (const [key, { value, target }] of sums) {
    out[key] = Math.min(target.max, Math.max(target.min, value));
  }
  return out;
}

/* ── Runtime ──────────────────────────────────────────────────────────────── */

/** OscillatorNode type for a shape, or null when no oscillator draws it. */
const OSC_TYPE: Partial<Record<ModShape, OscillatorType>> = {
  sine: 'sine',
  tri: 'triangle',
  saw: 'sawtooth',
  square: 'square',
};

type TimerHandle = number;

export interface ModTimer {
  set: (fn: () => void, ms: number) => TimerHandle;
  clear: (handle: TimerHandle) => void;
}

const defaultTimer: ModTimer = {
  set: (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
  clear: (h) => { clearInterval(h as unknown as ReturnType<typeof setInterval>); },
};

export interface ModEngineOptions {
  /** Needed only for `connectAudioRate`; the control-rate ticker runs without it. */
  ctx?: BaseAudioContext | null;
  /** Seconds for source evaluation — whatever zero the caller wants phase measured from. */
  now: () => number;
  /** Write a target's summed value. The target is passed so the caller does not
   *  have to parse the key back apart. */
  apply: (targetKey: string, value: number, target: ModTarget) => void;
  /** Control-rate period. 33 ms, the rate NodeF.I. has always ticked at. */
  tickMs?: number;
  /** Per-tick context (bpm / lane reader / RNG), read fresh so a tempo or lane
   *  edit lands on the next tick instead of being captured at wiring time. */
  state?: () => ModContextState;
  /** The un-modulated value a target sits at, read per tick for the same reason. */
  base?: (target: ModTarget, key: string) => number;
  /** Injectable for tests. Defaults to setInterval/clearInterval. */
  timer?: ModTimer;
}

export interface ModEngine {
  addRoute: (route: ModRoute) => void;
  removeRoute: (id: string) => void;
  updateRoute: (id: string, patch: Partial<Omit<ModRoute, 'id'>>) => void;
  /** Move every macro source with this id. Takes effect on the next tick. */
  setMacro: (id: string, value: number) => void;
  /**
   * Forget what was last written to a target (or to every target), so the next
   * tick writes even if the value it computes is the one it computed last time.
   *
   * REQUIRED whenever something OTHER than this engine moves a modulated
   * parameter. The "don't re-write an unmoved value" rule assumes the engine is
   * the only writer: if a caller pushes its own static params at the target
   * (NodeF.I.'s `updateParams` does exactly that, resetting the modulated key to
   * its base) the memo still holds the pre-reset value, and a shape that is flat
   * for a while — a square, or a sine sitting on its clamp — would never write
   * again until it happened to move. The modulation would look stalled.
   */
  invalidate: (key?: string) => void;
  /** Current routes, in insertion order. */
  routes: () => ModRoute[];
  /** Run one control-rate pass now. The ticker calls this; tests can too. */
  tick: () => void;
  /**
   * Wire an `lfo` → `audioParam` route as a real audio-rate signal, bypassing
   * the ticker entirely. Returns a disposer, or null when the route cannot run
   * at audio rate (a rack-param target, a non-LFO source, a sample-and-hold
   * shape, or no AudioContext) — in which case the ticker is the answer.
   */
  connectAudioRate: (route: ModRoute) => (() => void) | null;
  dispose: () => void;
}

export function createModEngine(opts: ModEngineOptions): ModEngine {
  const tickMs = opts.tickMs ?? 33;
  const timer = opts.timer ?? defaultTimer;
  const routes = new Map<string, ModRoute>();
  /** Last value written per target, so an unmoved target is not re-written. */
  const lastApplied = new Map<string, number>();
  /** Routes currently running at audio rate, by id — the ticker skips them. */
  const audioRouteIds = new Map<string, number>();
  const audioDisposers = new Set<() => void>();
  let handle: TimerHandle | null = null;
  let disposed = false;

  /** Drop a target's "last written" memo once nothing drives it any more, so a
   *  later route onto it writes even if its value lands back where it was. A
   *  target another route still feeds keeps its memo — wiping it would make
   *  that route re-write on the next tick for no reason. */
  const forgetIfUnused = (key: string): void => {
    for (const r of routes.values()) if (targetKey(r.target) === key) return;
    lastApplied.delete(key);
  };

  const controlRouteCount = (): number => {
    let n = 0;
    for (const id of routes.keys()) if (!audioRouteIds.get(id)) n += 1;
    return n;
  };

  /** Start the ticker when something needs it, stop it when nothing does — the
   *  "no mods, no timer" rule NodeF.I. had, kept. */
  const syncTimer = (): void => {
    if (disposed) return;
    const want = controlRouteCount() > 0;
    if (want && handle === null) handle = timer.set(() => { tick(); }, tickMs);
    else if (!want && handle !== null) { timer.clear(handle); handle = null; }
  };

  function tick(): void {
    if (disposed) return;
    const t = opts.now();
    const state = opts.state?.() ?? {};
    const active: ModRoute[] = [];
    const samples: Record<string, number> = {};
    const bases: Record<string, number> = {};
    const targets = new Map<string, ModTarget>();
    for (const route of routes.values()) {
      if (audioRouteIds.get(route.id)) continue;
      active.push(route);
      samples[route.id] = sampleSource(route.source, t, state);
      const key = targetKey(route.target);
      if (!targets.has(key)) {
        targets.set(key, route.target);
        const base = opts.base?.(route.target, key);
        bases[key] = base ?? (route.target.kind === 'audioParam' ? route.target.base : 0);
      }
    }
    if (!active.length) return;
    for (const [key, value] of Object.entries(applyRoutes(active, samples, bases))) {
      if (lastApplied.get(key) === value) continue;
      lastApplied.set(key, value);
      const target = targets.get(key);
      if (target) opts.apply(key, value, target);
    }
  }

  const engine: ModEngine = {
    addRoute: (route) => {
      if (disposed) return;
      routes.set(route.id, route);
      syncTimer();
    },
    removeRoute: (id) => {
      const route = routes.get(id);
      if (!route) return;
      routes.delete(id);
      forgetIfUnused(targetKey(route.target));
      syncTimer();
    },
    updateRoute: (id, patch) => {
      const route = routes.get(id);
      if (!route) return;
      const next = { ...route, ...patch, id };
      routes.set(id, next);
      const oldKey = targetKey(route.target);
      if (targetKey(next.target) !== oldKey) forgetIfUnused(oldKey);
    },
    setMacro: (id, value) => {
      for (const [routeId, route] of routes) {
        if (route.source.kind === 'macro' && route.source.id === id) {
          routes.set(routeId, { ...route, source: { ...route.source, value } });
        }
      }
    },
    invalidate: (key) => {
      if (key === undefined) lastApplied.clear();
      else lastApplied.delete(key);
    },
    routes: () => [...routes.values()],
    tick,
    connectAudioRate: (route) => {
      const ctx = opts.ctx;
      if (!ctx || disposed) return null;
      if (route.target.kind !== 'audioParam' || route.source.kind !== 'lfo') return null;
      const type = OSC_TYPE[route.source.shape];
      if (!type) return null;
      const param = route.target.param;
      // Soundscape's idiom (MIT, see the header): oscillator → gain holding the
      // depth → the destination AudioParam.
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = lfoRate(route.source, opts.state?.() ?? {});
      const swing = route.amount * route.source.depth * spanOf(route.target);
      const depth = ctx.createGain();
      // A unipolar route wants 0..1 out of a ±1 oscillator, which is half the
      // swing plus a DC offset of the same half — so it needs a constant source.
      const unipolar = !route.bipolar;
      const makeConst = (ctx as unknown as { createConstantSource?: () => ConstantSourceNode }).createConstantSource;
      if (unipolar && typeof makeConst !== 'function') return null;
      depth.gain.value = unipolar ? swing / 2 : swing;
      osc.connect(depth);
      depth.connect(param);
      let dc: ConstantSourceNode | null = null;
      if (unipolar) {
        dc = makeConst.call(ctx);
        dc.offset.value = swing / 2;
        dc.connect(param);
      }
      osc.start();
      dc?.start();
      let off = false;
      const dispose = (): void => {
        if (off) return;
        off = true;
        audioDisposers.delete(dispose);
        const n = (audioRouteIds.get(route.id) ?? 1) - 1;
        if (n > 0) audioRouteIds.set(route.id, n);
        else audioRouteIds.delete(route.id);
        try { osc.stop(); } catch { /* never started */ }
        osc.disconnect();
        depth.disconnect();
        if (dc) {
          try { dc.stop(); } catch { /* never started */ }
          dc.disconnect();
        }
        syncTimer();
      };
      audioDisposers.add(dispose);
      audioRouteIds.set(route.id, (audioRouteIds.get(route.id) ?? 0) + 1);
      syncTimer();
      return dispose;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (handle !== null) { timer.clear(handle); handle = null; }
      for (const off of [...audioDisposers]) off();
      audioDisposers.clear();
      audioRouteIds.clear();
      routes.clear();
      lastApplied.clear();
    },
  };
  return engine;
}
