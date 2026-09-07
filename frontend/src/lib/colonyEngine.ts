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
  kind: 'step' | 'trigger' | 'fire' | 'bar';
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
}

const LOOKAHEAD_SEC = 0.16;
const TICK_MS = 25;
const DEFAULT_SEED = 0x10c;

type Effective = Record<LockParam, number>;
const DEFAULT_EFFECTIVE: Effective = {
  gain: 0, pan: 0, transpose: 0, stretch: 0, bleed: 0, cutoff: 1, resonance: 0.7, drive: 0, crush: 0,
  delay: 0, reverb: 0, gate: 1, attack: 0.004, release: 0.012, roll: 0,
};

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
}

interface Resolved { row: ShardRow | null; pending: boolean }

export class ColonyEngine {
  private score: ColonyScore | null = null;
  private queued: ColonyScore | null = null;
  private root: Instance | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolved = new Map<string, Resolved>();
  running = false;

  constructor(private hooks: ColonyEngineHooks) {}

  get seed(): number { return this.score?.seed ?? DEFAULT_SEED; }
  get hasQueued(): boolean { return this.queued != null; }

  setScore(score: ColonyScore, opts?: { immediate?: boolean }): void {
    this.preResolve(score.root, []);
    if (this.running && !opts?.immediate) { this.queued = score; return; }
    this.score = score;
    this.queued = null;
    if (this.running) this.root = this.instance(score.root, [], beatClock.nextGrid('bar'), true, 60 / beatClock.bpm);
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
    shards.stopAll();
  }

  /** What a loop node resolves to (for the canvas / editor). */
  resolvedFor(query: LoomQuery): ShardRow | null {
    return this.resolved.get(serializeQuery(query))?.row ?? null;
  }

  /* ── instances ─────────────────────────────────────────────────────── */

  private instance(graph: ColonyGraph, path: string[], start: number, free: boolean, parentBeatSec: number): Instance {
    const beatSec = parentBeatSec / Math.max(0.01, graph.tempo);
    const inst: Instance = {
      graph, path, beatSec, barSec: barSeconds(graph.meter, beatSec), barStart: start, lap: 0, free,
      armed: free ? start : null, ruleStep: new Map(), ruleNext: new Map(), children: new Map(),
    };
    for (const n of graph.nodes) {
      if (n.kind === 'rule') { inst.ruleStep.set(n.id, 0); inst.ruleNext.set(n.id, start); }
      if (n.kind === 'colony') {
        const pointed = graph.edges.some((e) => e.to === n.id);
        inst.children.set(n.id, this.instance(n.graph, [...path, n.id], start, !pointed, beatSec));
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
    const horizon = getEngineCtx().currentTime + LOOKAHEAD_SEC;
    this.run(this.root, horizon, 0);
  }

  private run(inst: Instance, horizon: number, guard: number): void {
    if (guard > 64) return;
    // Bars: a free colony chains bars; a pointed colony waits to be armed.
    while (inst.armed != null && inst.armed < horizon) {
      const start = inst.armed;
      inst.barStart = start;
      for (const n of inst.graph.nodes) if (n.kind === 'rule') { inst.ruleStep.set(n.id, 0); inst.ruleNext.set(n.id, start); }
      this.hooks.onEvent?.({ kind: 'bar', at: start, path: inst.path, lap: inst.lap });
      this.stepRules(inst, Math.min(horizon, start + inst.barSec));
      if (inst.free) {
        inst.lap += 1;
        inst.armed = start + inst.barSec;
        if (inst.path.length === 0 && this.queued) {
          // Score swap at the root's bar boundary.
          const next = this.queued;
          this.queued = null;
          this.score = next;
          if (next.bpm) beatClock.setBpm(next.bpm, 'loom');
          this.root = this.instance(next.root, [], inst.armed, true, 60 / beatClock.bpm);
          logInfo('loom', 'Colony swapped at the bar');
          return;
        }
      } else {
        inst.lap += 1;
        inst.armed = null;
      }
    }
    // Steps left in a bar that started before this tick.
    if (inst.armed == null || inst.armed >= horizon) this.stepRules(inst, horizon);
    for (const child of inst.children.values()) this.run(child, horizon, guard + 1);
  }

  private stepRules(inst: Instance, horizon: number): void {
    const barEnd = inst.barStart + inst.barSec;
    for (const n of inst.graph.nodes) {
      if (n.kind !== 'rule') continue;
      let next = inst.ruleNext.get(n.id) ?? inst.barStart;
      let step = inst.ruleStep.get(n.id) ?? 0;
      const stepSec = inst.barSec / Math.max(1, n.steps);
      while (next < horizon && next < barEnd - 1e-6 && step < n.steps) {
        this.fireRule(inst, n, step, next);
        step += 1;
        next += stepSec;
      }
      inst.ruleNext.set(n.id, next);
      inst.ruleStep.set(n.id, step);
    }
  }

  private fireRule(inst: Instance, rule: RuleNode, step: number, t: number): void {
    const cell = genCell(ruleTile(rule), step, inst.lap, this.seed, this.score?.form, hashPath(inst.path, rule.id), 0);
    const symbol = symbolIndex(cell?.query ?? null);
    this.hooks.onEvent?.({ kind: 'step', at: t, path: [...inst.path, rule.id], step, symbol });
    if (symbol == null) return;
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
        return;
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
        if (child) { child.armed = t; child.lap = inst.lap; }
        return;
      }
      case 'rule':
        return; // a rule is a source; pointing at it does nothing
    }
    for (const e of inst.graph.edges) if (e.from === node.id) this.deliver(inst, e, t, { ...eff }, depth + 1);
  }

  private playLoop(inst: Instance, node: LoopNode, t: number, eff: Effective): void {
    const res = this.resolveLoop(node, inst.path);
    const row = res.row;
    const laneName = [...inst.path, node.id].join('/');
    if (!row) { if (!res.pending) this.hooks.onUnresolved?.(inst.path, node); return; }
    const gain = eff.gain + node.gain;
    const transpose = eff.transpose + node.transpose;
    const durationSec = node.hold ? 3600 : Math.max(0.03, node.beats * inst.beatSec * Math.max(0.05, eff.gate));
    shards.setLaneParams(laneName, { gainDb: 0, pan: eff.pan, cutoff: eff.cutoff, resonance: eff.resonance, transpose }, t);
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
