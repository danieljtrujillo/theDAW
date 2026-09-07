/**
 * loomEngine — plays a LOOM score with Jacquard's rules on the shared beat clock
 * (docs/design/loom.md §4).
 *
 * Every channel lane has a runner: (current lane, step, lap, next step time).
 * A 25 ms ticker evaluates every step that falls inside a 160 ms lookahead:
 * the column at that step is read top→bottom; a gate that fails stops the
 * descent; a lock colours the tiles read after it (below in the stack, and
 * lanes below while the step lasts); a jump redirects the runner into a target
 * lane from the step after; a shard tile launches its resolved shard at the
 * step's exact clock time. A target lane runs until its end and returns to the
 * runner's home lane. The first channel lane is the master: when it wraps, a
 * queued score replaces the running one.
 *
 * Shard queries are resolved ahead of time (on score set, and one lap early for
 * rolling tiles) so nothing awaits inside the audio-time path; an unresolved
 * tile is silent and reported, never late.
 */
import { beatClock } from './beatClock';
import { getEngineCtx } from '../state/playerStore';
import { logInfo } from '../state/logStore';
import type { LoomLane, LoomQuery, LoomScore, LoomTile, LockParam } from './loomScore';
import type { ShardRow } from '../state/shardIndexStore';
import * as shards from './shardEngine';

export type ShardTile = Extract<LoomTile, { kind: 'shard' }>;

export interface ResolveCtx {
  lane: LoomLane;
  tile: ShardTile;
  lap: number;
  /** Beats the tile spans at the current tempo. */
  beats: number;
  bpm: number;
}

export interface LaneCursor { step: number; lap: number; laneName: string }

export interface LoomEngineHooks {
  resolve: (query: LoomQuery, ctx: ResolveCtx) => Promise<ShardRow | null> | ShardRow | null;
  semitonesFor: (shard: ShardRow) => number;
  onCursors?: (cursors: Record<string, LaneCursor>) => void;
  onFire?: (info: { lane: string; step: number; shard: ShardRow; when: number }) => void;
  onMasterWrap?: (lap: number) => void;
  onUnresolved?: (lane: string, tile: ShardTile) => void;
}

const LOOKAHEAD_SEC = 0.16;
const TICK_MS = 25;

type Effective = Record<LockParam, number>;
const DEFAULT_EFFECTIVE: Effective = {
  gain: 0, pan: 0, transpose: 0, stretch: 0, bleed: 0, cutoff: 1, resonance: 0.7, drive: 0, crush: 0,
  delay: 0, reverb: 0, gate: 1, attack: 0.004, release: 0.012, roll: 0,
};

interface Runner {
  home: LoomLane;
  cur: LoomLane;
  step: number;
  lap: number;
  nextTime: number;
  pendingJump: string | null;
}

interface CrossLock { laneIdx: number; from: number; until: number; mode: 'abs' | 'rel'; params: Partial<Record<LockParam, number>> }

interface Resolved { row: ShardRow | null; lap: number; pending: boolean }

/** Deterministic PRNG so a chance gate is reproducible per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LoomEngine {
  private score: LoomScore | null = null;
  private queued: LoomScore | null = null;
  private runners: Runner[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolved = new Map<ShardTile, Resolved>();
  private crossLocks: CrossLock[] = [];
  private rng = mulberry32(0x10c);
  private cursorsDirty = false;
  running = false;

  constructor(private hooks: LoomEngineHooks) {}

  /** Replace the score. While running, the swap waits for the master wrap
   *  (Jacquard queues score changes to the sync boundary). */
  setScore(score: LoomScore, opts?: { immediate?: boolean }): void {
    if (this.running && !opts?.immediate) {
      this.queued = score;
      this.preResolve(score);
      return;
    }
    this.score = score;
    this.queued = null;
    this.preResolve(score);
    if (this.running) this.rebuildRunners(beatClock.nextGrid('bar'));
  }

  get hasQueued(): boolean { return this.queued != null; }

  start(): void {
    if (this.running || !this.score) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.score.bpm) beatClock.setBpm(this.score.bpm, 'loom');
    const t0 = beatClock.nextGrid('bar');
    this.rebuildRunners(t0);
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    logInfo('loom', `Playing at ${beatClock.bpm.toFixed(1)} BPM`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.crossLocks = [];
    shards.stopAll();
    this.emitCursors(true);
  }

  cursors(): Record<string, LaneCursor> {
    const out: Record<string, LaneCursor> = {};
    for (const r of this.runners) out[r.home.name] = { step: r.step, lap: r.lap, laneName: r.cur.name };
    return out;
  }

  /** What a tile currently resolves to (for the UI). */
  resolvedFor(tile: ShardTile): ShardRow | null { return this.resolved.get(tile)?.row ?? null; }

  /* ── internals ────────────────────────────────────────────────────────── */

  private stepSec(lane: LoomLane): number {
    return (beatClock.beatSec() * 4) / lane.div;
  }

  private beatsFor(tile: ShardTile, lane: LoomLane): number {
    return (tile.steps * 4) / lane.div;
  }

  private rebuildRunners(t0: number): void {
    if (!this.score) return;
    this.runners = this.score.lanes
      .filter((l) => !l.isTarget)
      .map((l) => ({ home: l, cur: l, step: 0, lap: 0, nextTime: t0, pendingJump: null }));
    this.emitCursors(true);
  }

  private preResolve(score: LoomScore): void {
    for (const lane of score.lanes) {
      for (const row of lane.rows) {
        for (const tile of row) {
          if (tile && tile.kind === 'shard' && !this.resolved.has(tile)) this.resolveTile(tile, lane, 0);
        }
      }
    }
  }

  private resolveTile(tile: ShardTile, lane: LoomLane, lap: number): void {
    const prev = this.resolved.get(tile);
    if (prev?.pending) return;
    const entry: Resolved = { row: prev?.row ?? null, lap, pending: true };
    this.resolved.set(tile, entry);
    const ctx: ResolveCtx = { lane, tile, lap, beats: this.beatsFor(tile, lane), bpm: beatClock.bpm };
    Promise.resolve(this.hooks.resolve(tile.query, ctx))
      .then((row) => {
        entry.row = row;
        entry.lap = lap;
        entry.pending = false;
        if (row) shards.prefetch([row], beatClock.bpm, (s) => this.hooks.semitonesFor(s));
      })
      .catch(() => { entry.pending = false; });
  }

  private tick(): void {
    if (!this.score) return;
    const ctx = getEngineCtx();
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    let guard = 0;
    for (let i = 0; i < this.runners.length; i += 1) {
      const r = this.runners[i];
      if (!r.home.play) { r.nextTime = Math.max(r.nextTime, horizon); continue; }
      while (r.nextTime < horizon && guard < 4096) {
        guard += 1;
        this.evaluate(r, i, r.nextTime);
        this.advance(r, r.nextTime);
      }
    }
    const cutoff = ctx.currentTime - 1;
    if (this.crossLocks.length) this.crossLocks = this.crossLocks.filter((c) => c.until > cutoff);
    if (this.cursorsDirty) this.emitCursors();
  }

  private effectiveAt(laneIdx: number, t: number): Effective {
    const eff: Effective = { ...DEFAULT_EFFECTIVE };
    for (const c of this.crossLocks) {
      if (c.laneIdx < laneIdx && c.from <= t + 1e-4 && t < c.until - 1e-4) applyLock(eff, c.mode, c.params);
    }
    return eff;
  }

  private evaluate(r: Runner, runnerIdx: number, t: number): void {
    const lane = r.cur;
    const step = r.step;
    const stepSec = this.stepSec(lane);
    const eff = this.effectiveAt(runnerIdx, t);
    for (const row of lane.rows) {
      const tile = row[step];
      if (!tile) continue;
      if (tile.kind === 'chance') {
        if (this.rng() * 100 >= tile.pct) return; // gate closed: stop the descent
        continue;
      }
      if (tile.kind === 'cycle') {
        const lapIdx = (r.lap % tile.period) + 1;
        if (!tile.laps.includes(lapIdx)) return;
        continue;
      }
      if (tile.kind === 'lock') {
        applyLock(eff, tile.mode, tile.params);
        this.crossLocks.push({ laneIdx: runnerIdx, from: t, until: t + stepSec, mode: tile.mode, params: tile.params });
        continue;
      }
      if (tile.kind === 'jump') {
        r.pendingJump = tile.target;
        continue;
      }
      this.fire(r, tile, t, eff);
    }
  }

  private fire(r: Runner, tile: ShardTile, t: number, eff: Effective): void {
    const lane = r.cur;
    const laneName = r.home.name;
    const stepSec = this.stepSec(lane);
    const res = this.resolved.get(tile);
    const rollEvery = tile.roll > 0 ? tile.roll : eff.roll > 0 ? Math.round(eff.roll) : 0;
    if (!res) {
      this.resolveTile(tile, lane, r.lap);
      this.hooks.onUnresolved?.(laneName, tile);
      return;
    }
    if (rollEvery > 0 && !res.pending && r.lap - res.lap >= rollEvery) {
      // Re-roll for the NEXT time; play what we have now.
      this.resolveTile(tile, lane, r.lap);
    }
    const row = res.row;
    if (!row) {
      if (!res.pending) this.hooks.onUnresolved?.(laneName, tile);
      return;
    }
    const durationSec = Math.max(0.03, tile.steps * stepSec * Math.max(0.05, eff.gate));
    shards.setLaneParams(laneName, {
      gainDb: 0, // per-voice gain carries the lock so stacked shards keep their own levels
      pan: eff.pan,
      cutoff: eff.cutoff,
      resonance: eff.resonance,
      transpose: eff.transpose,
    }, t);
    const bleedSec = eff.bleed > 0 ? eff.bleed * stepSec : 0;
    // Sequential shards on a lane choke each other (a stack launched at the
    // same instant is left alone); a bleed lock turns the cut into a seam.
    shards.releaseLane(laneName, t, bleedSec > 0 ? bleedSec : 0.008);
    void shards.launch(row, {
      when: t,
      durationSec,
      lane: laneName,
      bpm: beatClock.bpm,
      gainDb: eff.gain,
      semitones: this.hooks.semitonesFor(row),
      attackSec: bleedSec > 0 ? bleedSec : eff.attack,
      releaseSec: bleedSec > 0 ? Math.max(eff.release, bleedSec * 0.5) : eff.release,
    });
    this.hooks.onFire?.({ lane: laneName, step: r.step, shard: row, when: t });
  }

  private advance(r: Runner, t: number): void {
    r.nextTime = t + this.stepSec(r.cur);
    r.step += 1;
    this.cursorsDirty = true;
    if (r.pendingJump && this.score) {
      const target = this.score.lanes.find((l) => l.name === r.pendingJump);
      r.pendingJump = null;
      if (target && target !== r.cur) {
        r.cur = target;
        r.step = 0;
        return;
      }
    }
    if (r.step >= r.cur.length) {
      const wasTarget = r.cur.isTarget;
      r.cur = r.home;
      r.step = 0;
      r.lap += 1;
      // Re-resolve rolling tiles one lap ahead so the next lap never waits.
      for (const row of r.home.rows) for (const tile of row) {
        if (tile && tile.kind === 'shard' && tile.roll > 0) {
          const res = this.resolved.get(tile);
          if (res && !res.pending && r.lap - res.lap >= tile.roll) this.resolveTile(tile, r.home, r.lap);
        }
      }
      if (!wasTarget || true) {
        const master = this.runners[0];
        if (r === master) {
          this.hooks.onMasterWrap?.(r.lap);
          if (this.queued) {
            const next = this.queued;
            this.queued = null;
            this.score = next;
            if (next.bpm) beatClock.setBpm(next.bpm, 'loom');
            this.rebuildRunners(r.nextTime);
            logInfo('loom', 'Score swapped at the master wrap');
          }
        }
      }
    }
  }

  private emitCursors(force = false): void {
    if (!force && !this.cursorsDirty) return;
    this.cursorsDirty = false;
    this.hooks.onCursors?.(this.cursors());
  }
}

function applyLock(eff: Effective, mode: 'abs' | 'rel', params: Partial<Record<LockParam, number>>): void {
  for (const [k, v] of Object.entries(params) as [LockParam, number][]) {
    if (v === undefined) continue;
    eff[k] = mode === 'abs' ? v : eff[k] + v;
  }
}
