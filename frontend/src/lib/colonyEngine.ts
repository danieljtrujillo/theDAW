/**
 * colonyEngine — plays a LOOM colony (lib/colony.ts) on the shared beat clock.
 *
 * Every colony instance keeps a bar cursor. The root colony runs freely; a
 * nested colony runs freely too unless something points at it, in which case
 * it runs one bar per trigger. Inside a bar, every rule node steps
 * bar/steps and asks lib/loomGen for its symbol at (step, lap); a symbol
 * becomes a trigger that walks the out-edges: gates pass or drop it, mods
 * colour it, loops play, colonies start. Loops are their own lanes in the
 * shard engine, so a re-trigger chokes the previous hit (or, with `hold`,
 * the loop keeps rolling until the next trigger).
 *
 * v4: a loop's OUT wires fire when the loop ENDS — `kick -> bass` plays bass
 * after kick, `bass -> bass` repeats bass — so a colony can chain and loop
 * without a pacemaker on every cell. A re-trigger cancels the old end. Loops
 * carry their own pan / cutoff / resonance and a `space` mode (orbit,
 * pingpong, random) that moves them in the stereo field while they sound.
 * A queued score (Apply, or a growth step) swaps at the root's bar boundary
 * and CARRIES its laps and cursors over, so Life keeps its generation and a
 * bar is never dropped.
 *
 * v5: nothing arrives at full speed. A `vitality` hook (0..1, from the
 * growth bookkeeping) fades a newborn cell in over a few bars — quieter,
 * darker, and less likely to fire — and a withering one out the same way.
 * `swing` lands every odd rule step late. A loop with no in-wires is an
 * ORIGIN and fires on the first downbeat (the spore that starts it all). A
 * loop's `glide` is a live portamento across its length.
 *
 * The scheduler is the plane's: a 25 ms ticker, a 160 ms lookahead, every
 * launch at an exact clock time. Visual events (steps, triggers, fires) go out
 * with their audio time so the canvas can animate on the beat.
 */
import { beatClock } from './beatClock';
import { getEngineCtx } from '../state/playerStore';
import { logInfo } from '../state/logStore';
import { barSeconds, groupStarts, ruleTile, symbolIndex, type ColonyEdge, type ColonyGraph, type ColonyNode, type ColonyScore, type LoopNode, type RuleNode } from './colony';
import { genCell, unit } from './loomGen';
import { serializeQuery, type LockParam, type LoomQuery } from './loomScore';
import type { ShardRow } from '../state/shardIndexStore';
import type { ResolveCtx } from './loomEngine';
import * as shards from './shardEngine';

export interface ColonyEvent {
  kind: 'step' | 'trigger' | 'fire' | 'bar' | 'end';
  /** Audio-clock time the event happens. */
  at: number;
  /** Node path (colony ids then the node id). */
  path: string[];
  /** step: the step index and symbol; trigger: the edge's target. */
  step?: number;
  symbol?: number | null;
  edge?: ColonyEdge;
  lap?: number;
  shard?: ShardRow;
}

export interface ColonyEngineHooks {
  resolve: (query: LoomQuery, ctx: ResolveCtx) => Promise<ShardRow | null> | ShardRow | null;
  semitonesFor: (shard: ShardRow) => number;
  onEvent?: (e: ColonyEvent) => void;
  onUnresolved?: (path: string[], node: LoopNode) => void;
  /** How alive a cell is at a (fractional) root lap: 0 newborn or dying, 1 ripe. */
  vitality?: (path: string[], id: string, lap: number) => number;
}

const LOOKAHEAD_SEC = 0.16;
const TICK_MS = 25;
const DEFAULT_SEED = 0x10c;

type Effective = Record<LockParam, number>;
const DEFAULT_EFFECTIVE: Effective = {
  gain: 0, pan: 0, transpose: 0, stretch: 0, bleed: 0, cutoff: 1, resonance: 0.7, drive: 0, crush: 0,
  delay: 0, reverb: 0, gate: 1, attack: 0.004, release: 0.012, roll: 0,
};

/** A trigger a loop's end will deliver. */
interface Pending { at: number; edge: ColonyEdge; eff: Effective; loopId: string; gen: number }

interface Instance {
  graph: ColonyGraph;
  path: string[];
  beatSec: number;
  barSec: number;
  barStart: number;
  lap: number;
  /** Free-running, or one bar per trigger. */
  free: boolean;
  /** Time the next bar may start when triggered (null = idle). */
  armed: number | null;
  ruleStep: Map<string, number>;
  ruleNext: Map<string, number>;
  children: Map<string, Instance>;
  /** Loop-end triggers waiting for their time. */
  pending: Pending[];
  /** Per-loop trigger generation: a re-trigger invalidates the old end. */
  loopGen: Map<string, number>;
  /** Times each loop fired, for pingpong. */
  loopHits: Map<string, number>;
  /** The colony this instance is a cell of (null at the root). */
  parent: Instance | null;
}

interface Resolved { row: ShardRow | null; pending: boolean }

/** A loop moving while it sounds: pan orbiting, or pitch gliding. */
interface Motion { lane: string; mode: 'orbit' | 'glide'; t0: number; end: number; period: number; base: number; sign: number; to: number }

export class ColonyEngine {
  private score: ColonyScore | null = null;
  private queued: ColonyScore | null = null;
  private root: Instance | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolved = new Map<string, Resolved>();
  private motions = new Map<string, Motion>();
  running = false;

  constructor(private hooks: ColonyEngineHooks) {}

  get seed(): number { return this.score?.seed ?? DEFAULT_SEED; }
  get hasQueued(): boolean { return this.queued != null; }
  /** The root lap the engine is on (0 when idle). */
  get lap(): number { return this.root?.lap ?? 0; }
  /** The root lap with the fraction of the bar played, at the audio clock's now. */
  get lapFloat(): number {
    const r = this.root;
    if (!r || !this.running) return 0;
    let now: number;
    try { now = getEngineCtx().currentTime; } catch { return r.lap; }
    const played = Math.max(0, Math.min(1, (now - r.barStart) / r.barSec));
    // `lap` already counts the bar that is playing.
    return Math.max(0, r.lap - 1 + played);
  }

  setScore(score: ColonyScore, opts?: { immediate?: boolean }): void {
    this.preResolve(score.root, []);
    if (this.running && !opts?.immediate) { this.queued = score; return; }
    this.score = score;
    this.queued = null;
    if (this.running) this.root = this.instance(score.root, [], beatClock.nextGrid('bar'), true, 60 / beatClock.bpm, this.root);
  }

  start(): void {
    if (this.running || !this.score) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.score.bpm) beatClock.setBpm(this.score.bpm, 'loom');
    beatClock.setBeatsPerBar(Math.max(1, Math.min(16, Math.round(this.score.root.meter.num * 4 / this.score.root.meter.den))));
    const t0 = beatClock.nextGrid('bar');
    this.root = this.instance(this.score.root, [], t0, true, 60 / beatClock.bpm);
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    logInfo('loom', `Colony playing at ${beatClock.bpm.toFixed(1)} BPM, ${this.score.root.meter.num}/${this.score.root.meter.den}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.queued = null;
    this.motions.clear();
    shards.stopAll();
  }

  /** What a loop node resolves to (for the canvas / editor). */
  resolvedFor(query: LoomQuery): ShardRow | null {
    return this.resolved.get(serializeQuery(query))?.row ?? null;
  }

  /* ── instances ─────────────────────────────────────────────────────── */

  /** Build an instance; `prev` (same path) hands over its laps, cursors and
   *  pending ends so a swap mid-set keeps the music where it was. */
  private instance(graph: ColonyGraph, path: string[], start: number, free: boolean, parentBeatSec: number, prev?: Instance | null, parent: Instance | null = null): Instance {
    const beatSec = parentBeatSec / Math.max(0.01, graph.tempo);
    const inst: Instance = {
      graph, path, beatSec, barSec: barSeconds(graph.meter, beatSec), barStart: start, lap: prev?.lap ?? 0, free,
      armed: free ? start : (prev && !prev.free ? prev.armed : null),
      ruleStep: new Map(), ruleNext: new Map(), children: new Map(), pending: [], loopGen: new Map(prev?.loopGen ?? []), loopHits: new Map(prev?.loopHits ?? []),
      parent,
    };
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (prev) inst.pending = prev.pending.filter((p) => ids.has(p.edge.to) && ids.has(p.edge.from));
    for (const n of graph.nodes) {
      if (n.kind === 'rule') { inst.ruleStep.set(n.id, 0); inst.ruleNext.set(n.id, start); }
      if (n.kind === 'colony') {
        const pointed = graph.edges.some((e) => e.to === n.id);
        inst.children.set(n.id, this.instance(n.graph, [...path, n.id], start, !pointed, beatSec, prev?.children.get(n.id) ?? null, inst));
      }
    }
    return inst;
  }

  private preResolve(graph: ColonyGraph, path: string[]): void {
    for (const n of graph.nodes) {
      if (n.kind === 'loop') this.resolveLoop(n, path);
      if (n.kind === 'colony') this.preResolve(n.graph, [...path, n.id]);
    }
  }

  private resolveLoop(node: LoopNode, path: string[]): Resolved {
    const key = serializeQuery(node.query);
    const prev = this.resolved.get(key);
    if (prev && (prev.pending || prev.row)) return prev;
    const entry: Resolved = { row: null, pending: true };
    this.resolved.set(key, entry);
    const lane = { name: [...path, node.id].join('/'), div: 4, length: 4, isTarget: false, play: true, rows: [] };
    const tile = { kind: 'shard' as const, query: node.query, steps: 1, roll: 0 };
    const ctx: ResolveCtx = { lane, tile, lap: 0, beats: node.beats, bpm: beatClock.bpm };
    Promise.resolve(this.hooks.resolve(node.query, ctx))
      .then((row) => {
        entry.row = row;
        entry.pending = false;
        if (row) shards.prefetch([row], beatClock.bpm, (s) => this.hooks.semitonesFor(s));
        else this.hooks.onUnresolved?.(path, node);
      })
      .catch(() => { entry.pending = false; });
    return entry;
  }

  /* ── scheduling ────────────────────────────────────────────────────── */

  private tick(): void {
    if (!this.root || !this.score) return;
    const now = getEngineCtx().currentTime;
    const horizon = now + LOOKAHEAD_SEC;
    this.run(this.root, horizon, 0);
    this.moveSpace(now);
  }

  private run(inst: Instance, horizon: number, guard: number): void {
    if (guard > 64) return;
    // A queued score swaps at the root's bar boundary, carrying laps over.
    if (inst.path.length === 0 && this.queued && inst.armed != null && inst.armed < horizon) {
      const next = this.queued;
      this.queued = null;
      this.score = next;
      if (next.bpm) beatClock.setBpm(next.bpm, 'loom');
      // Play the rest of the outgoing bar first.
      this.stepRules(inst, inst.armed);
      this.flushPending(inst, inst.armed);
      this.root = this.instance(next.root, [], inst.armed, true, 60 / beatClock.bpm, inst);
      this.run(this.root, horizon, guard + 1);
      return;
    }
    // Bars: a free colony chains bars; a pointed colony waits to be armed.
    while (inst.armed != null && inst.armed < horizon) {
      const start = inst.armed;
      // Finish the bar that is ending before the new one resets the cursors.
      this.stepRules(inst, start);
      this.flushPending(inst, start);
      inst.barStart = start;
      for (const n of inst.graph.nodes) if (n.kind === 'rule') { inst.ruleStep.set(n.id, 0); inst.ruleNext.set(n.id, start); }
      this.hooks.onEvent?.({ kind: 'bar', at: start, path: inst.path, lap: inst.lap });
      if (inst.lap === 0) this.fireOrigins(inst, start);
      this.stepRules(inst, Math.min(horizon, start + inst.barSec));
      // A colony's out-wires fire in its parent when this bar ends (like a loop's).
      const parent = inst.parent;
      const selfId = inst.path[inst.path.length - 1];
      if (parent && selfId) {
        for (const e of parent.graph.edges) {
          if (e.from !== selfId || e.to === selfId) continue;
          parent.pending.push({ at: start + inst.barSec, edge: e, eff: { ...DEFAULT_EFFECTIVE }, loopId: selfId, gen: 0 });
        }
      }
      if (inst.free) {
        inst.lap += 1;
        inst.armed = start + inst.barSec;
      } else {
        inst.lap += 1;
        inst.armed = null;
      }
    }
    // Steps left in a bar that started before this tick.
    if (inst.armed == null || inst.armed >= horizon) this.stepRules(inst, horizon);
    this.flushPending(inst, horizon);
    for (const child of inst.children.values()) this.run(child, horizon, guard + 1);
  }

  /** Loops nothing points at fire on the first downbeat: the spore starts itself. */
  private fireOrigins(inst: Instance, t: number): void {
    for (const n of inst.graph.nodes) {
      if (n.kind !== 'loop') continue;
      if (inst.graph.edges.some((e) => e.to === n.id && e.from !== n.id)) continue;
      this.hooks.onEvent?.({ kind: 'trigger', at: t, path: [...inst.path, n.id], edge: { from: n.id, to: n.id } });
      this.playLoop(inst, n, t, { ...DEFAULT_EFFECTIVE });
    }
  }

  /** When step `i` of a rule with `steps` lands: odd steps late by the swing. */
  private stepTime(inst: Instance, steps: number, i: number): number {
    const stepSec = inst.barSec / Math.max(1, steps);
    const swing = this.score?.swing ?? 0.5;
    const late = i % 2 === 1 ? (swing - 0.5) * 2 * stepSec : 0;
    return inst.barStart + i * stepSec + late;
  }

  private stepRules(inst: Instance, horizon: number): void {
    const barEnd = inst.barStart + inst.barSec;
    for (const n of inst.graph.nodes) {
      if (n.kind !== 'rule') continue;
      let step = inst.ruleStep.get(n.id) ?? 0;
      let next = this.stepTime(inst, n.steps, step);
      while (next < horizon && next < barEnd - 1e-6 && step < n.steps) {
        this.fireRule(inst, n, step, next);
        step += 1;
        next = this.stepTime(inst, n.steps, step);
      }
      inst.ruleNext.set(n.id, next);
      inst.ruleStep.set(n.id, step);
    }
  }

  /** Root lap, fractional, at audio time `t`. */
  private lapAt(t: number): number {
    const r = this.root;
    if (!r) return 0;
    return Math.max(0, r.lap - 1 + Math.max(0, Math.min(1, (t - r.barStart) / r.barSec)));
  }

  /** Deliver every loop-end trigger due before `horizon`. */
  private flushPending(inst: Instance, horizon: number): void {
    if (!inst.pending.length) return;
    let rounds = 0;
    while (rounds < 64) {
      rounds += 1;
      const due = inst.pending.filter((p) => p.at < horizon);
      if (!due.length) break;
      inst.pending = inst.pending.filter((p) => p.at >= horizon);
      due.sort((a, b) => a.at - b.at);
      for (const p of due) {
        if ((inst.loopGen.get(p.loopId) ?? 0) !== p.gen) continue; // re-triggered since: the old end is void
        this.hooks.onEvent?.({ kind: 'end', at: p.at, path: [...inst.path, p.loopId] });
        this.deliver(inst, p.edge, p.at, { ...p.eff }, 0);
      }
    }
  }

  private fireRule(inst: Instance, rule: RuleNode, step: number, t: number): void {
    const cell = genCell(ruleTile(rule), step, inst.lap, this.seed, this.score?.form, hashPath(inst.path, rule.id), 0);
    const symbol = symbolIndex(cell?.query ?? null);
    this.hooks.onEvent?.({ kind: 'step', at: t, path: [...inst.path, rule.id], step, symbol });
    if (symbol == null) return;
    // A young or withering pacemaker only fires some of its steps.
    const v = this.hooks.vitality?.(inst.path, rule.id, this.lapAt(t)) ?? 1;
    if (v < 1 && unit(this.seed, 6, hashPath(inst.path, rule.id), step, inst.lap) > 0.2 + 0.8 * v) return;
    const eff: Effective = { ...DEFAULT_EFFECTIVE };
    if (cell?.gain) eff.gain += cell.gain;
    if (cell?.transpose) eff.transpose += cell.transpose;
    // Group downbeats get an accent (Zappa's 3+2+2 breathes on its own).
    if (groupStarts(inst.graph.meter, rule.steps).includes(step)) eff.gain += 1.5;
    for (const e of inst.graph.edges) {
      if (e.from !== rule.id) continue;
      if (e.on != null && e.on !== symbol) continue;
      this.deliver(inst, e, t, eff, 0);
    }
  }

  private deliver(inst: Instance, edge: ColonyEdge, t: number, eff: Effective, depth: number): void {
    if (depth > 16) return;
    const node = inst.graph.nodes.find((n) => n.id === edge.to);
    if (!node) return;
    this.hooks.onEvent?.({ kind: 'trigger', at: t, path: [...inst.path, edge.to], edge });
    switch (node.kind) {
      case 'loop':
        this.playLoop(inst, node, t, eff);
        return; // its wires fire when it ends
      case 'gate': {
        if (node.pct != null && unit(this.seed, 5, hashPath(inst.path, node.id), Math.round(t * 1000)) * 100 >= node.pct) return;
        if (node.period != null && !(node.laps ?? []).includes((inst.lap % node.period) + 1)) return;
        break;
      }
      case 'mod':
        applyLock(eff, node.mode, node.params);
        break;
      case 'colony': {
        const child = inst.children.get(node.id);
        if (child) { child.armed = t; child.lap = Math.max(child.lap, inst.lap); }
        return;
      }
      case 'rule':
        return; // a rule is a source; pointing at it does nothing
    }
    for (const e of inst.graph.edges) if (e.from === node.id && e.to !== edge.from) this.deliver(inst, e, t, { ...eff }, depth + 1);
  }

  private playLoop(inst: Instance, node: LoopNode, t: number, eff: Effective): void {
    const res = this.resolveLoop(node, inst.path);
    const row = res.row;
    const laneName = [...inst.path, node.id].join('/');
    const gen = (inst.loopGen.get(node.id) ?? 0) + 1;
    inst.loopGen.set(node.id, gen);
    const hits = (inst.loopHits.get(node.id) ?? 0) + 1;
    inst.loopHits.set(node.id, hits);
    const lengthSec = Math.max(0.03, node.beats * inst.beatSec * Math.max(0.05, eff.gate));
    // The loop's wires fire at its end whether it holds or not — `hold` is
    // about the sound rolling on, the chain is about time.
    const outs = inst.graph.edges.filter((e) => e.from === node.id);
    for (const e of outs) inst.pending.push({ at: t + lengthSec, edge: e, eff: { ...eff }, loopId: node.id, gen });
    if (!row) { if (!res.pending) this.hooks.onUnresolved?.(inst.path, node); return; }
    // Vitality: a newborn fades in dark and quiet; a withering cell fades out.
    const v = this.hooks.vitality?.(inst.path, node.id, this.lapAt(t)) ?? 1;
    const gain = eff.gain + node.gain - 22 * (1 - v);
    const transpose = eff.transpose + node.transpose;
    const cutoff = Math.min(eff.cutoff, node.cutoff) * (0.25 + 0.75 * v);
    const resonance = eff.resonance !== DEFAULT_EFFECTIVE.resonance ? eff.resonance : node.resonance;
    const durationSec = node.hold ? 3600 : lengthSec;
    // Spatial: where the loop sits, and whether it moves.
    let pan = Math.max(-1, Math.min(1, eff.pan + node.pan));
    this.motions.delete(laneName);
    this.motions.delete(`${laneName}#glide`);
    if (node.space === 'random') pan = Math.max(-1, Math.min(1, node.pan + (unit(this.seed, 9, hashPath(inst.path, node.id), hits) * 2 - 1) * 0.9));
    else if (node.space === 'pingpong') pan = Math.max(-1, Math.min(1, node.pan + (hits % 2 ? 0.8 : -0.8)));
    else if (node.space === 'orbit') this.motions.set(laneName, { lane: laneName, mode: 'orbit', t0: t, end: t + durationSec, period: Math.max(0.5, node.beats * inst.beatSec * 2), base: node.pan, sign: hits % 2 ? 1 : -1, to: 0 });
    // Portamento: the pitch glides across the loop's nominal length.
    if (node.glide) this.motions.set(`${laneName}#glide`, { lane: laneName, mode: 'glide', t0: t, end: t + lengthSec, period: lengthSec, base: transpose, sign: 1, to: transpose + node.glide });
    shards.setLaneParams(laneName, { gainDb: 0, pan, cutoff, resonance, transpose }, t);
    shards.releaseLane(laneName, t, 0.008);
    void shards.launch(row, {
      when: t,
      durationSec,
      lane: laneName,
      bpm: beatClock.bpm,
      gainDb: gain,
      semitones: this.hooks.semitonesFor(row),
      attackSec: eff.attack,
      releaseSec: eff.release,
    });
    this.hooks.onEvent?.({ kind: 'fire', at: t, path: [...inst.path, node.id], shard: row });
  }

  /** Sweep the pan of every orbiting loop, and the pitch of every gliding one, a little further each tick. */
  private moveSpace(now: number): void {
    for (const [key, m] of this.motions) {
      if (now > m.end + 0.1) { this.motions.delete(key); continue; }
      if (now < m.t0) continue;
      if (m.mode === 'glide') {
        const x = Math.max(0, Math.min(1, (now - m.t0) / m.period));
        const eased = x * x * (3 - 2 * x);
        shards.setLaneParams(m.lane, { transpose: m.base + (m.to - m.base) * eased }, now);
        continue;
      }
      const phase = ((now - m.t0) / m.period) * Math.PI * 2;
      const pan = Math.max(-1, Math.min(1, m.base + Math.sin(phase) * 0.85 * m.sign));
      shards.setLaneParams(m.lane, { pan }, now);
    }
  }
}

function hashPath(path: string[], id: string): number {
  let h = 7;
  for (const ch of [...path, id].join('/')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function applyLock(eff: Effective, mode: 'abs' | 'rel', params: Partial<Record<LockParam, number>>): void {
  for (const [k, v] of Object.entries(params) as [LockParam, number][]) {
    if (v === undefined) continue;
    eff[k] = mode === 'abs' ? v : eff[k] + v;
  }
}

/** Which node kinds a trigger can land on — for the editor's edge picker. */
export const TRIGGERABLE: ReadonlySet<ColonyNode['kind']> = new Set(['loop', 'gate', 'mod', 'colony']);
