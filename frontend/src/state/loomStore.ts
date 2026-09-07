/**
 * loomStore — the LOOM tab's state: the score text, the parsed score the engine
 * holds, the beat-clock mirror, cursors, and the tile-editing operations that
 * keep the plane and the code in step (docs/design/loom.md §4–5).
 *
 * The code pane is the source of truth for persistence (a `.loom` score is
 * plain text, as Jacquard's are). Grid edits rewrite the text through the
 * serializer; text edits re-parse on Apply. While playing, a new score is
 * QUEUED and swaps at the master lane's wrap.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  parseLoom,
  serializeLoom,
  STARTER_SCORE,
  DEFAULT_DIV,
  DEFAULT_LENGTH,
  type LoomLane,
  type LoomParseError,
  type LoomQuery,
  type LoomScore,
  type LoomTile,
} from '../lib/loomScore';
import { LoomEngine, type LaneCursor, type ResolveCtx, type ShardTile } from '../lib/loomEngine';
import { beatClock } from '../lib/beatClock';
import { camelotCode, camelotDistance, transposeSemitones } from '../lib/loomKey';
import { localCandidates, resolveEntryRef, useShardIndexStore, type ShardRow } from './shardIndexStore';
import { useLibraryStore } from './libraryStore';
import { logInfo } from './logStore';
import { loomTemplateById } from '../data/loomTemplates';
import { breedScores, fragmentScore, mutateScore } from '../lib/loomEvolve';
import { DEFAULT_SEED } from '../lib/loomEngine';
import { canWire, findNode, graphAt, LOOP_DEFAULTS, nodeKey, parseColony, serializeColony, STARTER_COLONY, uniqueId, walkNodes, type ColonyGraph, type ColonyNode, type ColonyScore, type GrowSpec, type Meter } from '../lib/colony';
import { GEN_DEFAULT_OPTS } from '../lib/loomGen';
import { ColonyEngine, type ColonyEvent } from '../lib/colonyEngine';
import { growColony, vitalityOf, WITHER_LAPS, type Activity } from '../lib/colonyGrow';
import { logError } from './logStore';

export interface TileSel { lane: string; row: number; step: number }

export interface FireInfo { step: number; at: number; title: string }

/** One generation in the GROW pane's lineage. */
export interface LoomGeneration { text: string; label: string; at: number }

export type LoomMode = 'plane' | 'colony';
export interface NodePos { x: number; y: number }
export type ColonyKind = 'loop' | 'rule' | 'gate' | 'mod' | 'colony';
/** A wire: the graph it lives in (null = root) and its ends. */
export interface EdgeSel { parent: string | null; from: string; to: string }

interface LoomState {
  text: string;
  applied: LoomScore;
  errors: LoomParseError[];
  dirty: boolean;
  running: boolean;
  queued: boolean;
  cursors: Record<string, LaneCursor>;
  fired: Record<string, FireInfo>;
  unresolved: string[];
  selected: TileSel | null;
  bpm: number;
  /** Lineage of scores the GROW pane produced (newest last). */
  history: LoomGeneration[];
  /** Lanes GROW leaves alone. */
  keepLanes: string[];

  /** Plane (lanes) or colony (cells and arrows). */
  mode: LoomMode;
  colonyText: string;
  colonyApplied: ColonyScore;
  colonyErrors: LoomParseError[];
  colonyDirty: boolean;
  /** Node positions on the canvas, keyed by path ("seven/hat"), colony-local. */
  colonyPositions: Record<string, NodePos>;
  colonySelected: string | null;
  /** The wire under the inspector, if any. */
  colonySelectedEdge: EdgeSel | null;
  /** The colony the canvas has dived into (null = the root dish). */
  colonyFocus: string | null;
  /** Names of loop nodes that resolved to nothing. */
  colonyUnresolved: string[];
  /** Root lap the engine is on (updates once a bar). */
  colonyLap: number;
  /** Growth steps that changed the colony since it was applied. */
  colonyGen: number;

  setMode: (m: LoomMode) => void;
  selectColonyEdge: (sel: EdgeSel | null) => void;
  setColonyFocus: (key: string | null) => void;
  /** Add a cell of `kind` into the graph at `parent` (null = root), near a spot. Returns its key. */
  addColonyNode: (parent: string | null, kind: ColonyKind, near?: NodePos) => string | null;
  removeColonyNode: (key: string) => void;
  duplicateColonyNode: (key: string) => string | null;
  addColonyEdge: (parent: string | null, from: string, to: string) => boolean;
  removeColonyEdge: (parent: string | null, from: string, to: string) => void;
  setColonyEdgeOn: (parent: string | null, from: string, to: string, on: number | undefined) => void;
  /** The root's meter and tempo (a nested colony's live on its node). */
  setRootMeter: (meter: Meter, tempo?: number) => void;
  setGrow: (spec: GrowSpec | null) => void;
  setSwing: (swing: number) => void;
  setGrain: (grain: number) => void;
  setColonySeed: (seed: number) => void;
  /** One growth step now; with a key, bud from that cell. */
  growNow: (force?: string) => void;
  setColonyText: (t: string) => void;
  applyColony: () => boolean;
  setColonyPosition: (key: string, pos: NodePos) => void;
  selectColony: (key: string | null) => void;
  /** Replace one node (found by path key) and re-serialize. */
  updateColonyNode: (key: string, node: ColonyNode) => void;
  resetColonyStarter: () => void;
  /** Re-resolve every tile (stems landed, crate changed). */
  refreshResolutions: () => void;

  setText: (t: string) => void;
  apply: () => boolean;
  play: () => void;
  stop: () => void;
  toggle: () => void;
  select: (sel: TileSel | null) => void;
  setTile: (sel: TileSel, tile: LoomTile | null) => void;
  addRow: (lane: string) => void;
  removeRow: (lane: string, row: number) => void;
  setLaneOpts: (lane: string, opts: Partial<Pick<LoomLane, 'div' | 'length' | 'isTarget' | 'play' | 'name'>>) => void;
  addLane: () => void;
  removeLane: (lane: string) => void;
  setBpm: (bpm: number) => void;
  resetStarter: () => void;
  /** GROW: a mutated child of the applied score becomes the score. */
  mutate: (intensity: number) => void;
  /** GROW: cross the applied score with another (a template id or score text). */
  breed: (partner: string) => boolean;
  /** GROW: every rail becomes a one-beat fragment generator. */
  fragmentize: (size: number) => void;
  /** GROW: reseed the dice (chance gates and generators). */
  setSeed: (seed: number) => void;
  setForm: (form: string) => void;
  toggleKeepLane: (lane: string) => void;
  /** Return to an earlier generation. */
  revert: (index: number) => void;
  /** Load a sample score: text + apply + its songs into the crate. Returns the
   *  song references that could not be found in the library. */
  loadTemplate: (id: string) => string[];
  resolvedFor: (tile: ShardTile) => ShardRow | null;
}

const PERCUSSIVE = new Set(['drums', 'kick', 'snare', 'hihat', 'cymbals', 'toms']);

function pickBeats(beats: number, role?: string): number {
  if (role && PERCUSSIVE.has(role) && beats <= 1.5) return 1;
  if (beats <= 4.5) return 4;
  if (beats <= 8.5) return 8;
  return 16;
}

function entryTitle(id: string): string {
  return useLibraryStore.getState().entries.find((e) => e.id === id)?.title ?? id.slice(0, 8);
}

/** The key everything is transposed toward: the score's, or the first crate song's. */
function targetKey(score: LoomScore): { key: string; scale: string } | null {
  if (score.key && score.key !== 'follow') return { key: score.key, scale: score.scale ?? 'major' };
  const idx = useShardIndexStore.getState();
  for (const id of idx.crate) {
    const row = idx.byEntry[id]?.find((r) => r.key);
    if (row) return { key: row.key, scale: row.scale };
  }
  return null;
}

function pickRanked(cands: ShardRow[], target: { key: string; scale: string } | null): ShardRow | null {
  if (cands.length === 0) return null;
  const tc = target ? camelotCode(target.key, target.scale) : '';
  const scored = cands.map((r) => {
    let s = Math.random() * 0.4;
    if (tc && r.camelot) {
      const d = camelotDistance(tc, r.camelot);
      s -= 0.35 * (d ?? 2);
    }
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].r;
}

async function resolveQuery(q: LoomQuery, ctx: ResolveCtx, score: LoomScore): Promise<ShardRow | null> {
  const idx = useShardIndexStore.getState();
  const target = targetKey(score);
  if (q.shardId) {
    const entryId = q.shardId.split('__')[0];
    await idx.ensureEntry(entryId, { run: false });
    return localCandidates(q, [entryId])[0] ?? null;
  }
  let entryIds: string[];
  if (q.entry) {
    const id = resolveEntryRef(q.entry);
    if (!id) return null;
    await idx.ensureEntry(id, { run: true });
    entryIds = [id];
  } else {
    entryIds = idx.crate;
    await Promise.all(entryIds.map((id) => idx.ensureEntry(id, { run: true })));
  }
  const beats = q.beats ?? pickBeats(ctx.beats, q.role);
  if (entryIds.length === 0) {
    // Nothing on deck: ask the whole index.
    try {
      const rows = await idx.query({
        role: q.role,
        beats,
        exclude_entry: q.excludeEntry ? resolveEntryRef(q.excludeEntry) ?? undefined : undefined,
        key: target?.key,
        scale: target?.scale,
        bpm: ctx.bpm,
        energy: q.energyMin != null || q.energyMax != null ? [q.energyMin ?? 0, q.energyMax ?? 1] : undefined,
        section: q.section,
        text: q.text,
        limit: 12,
      });
      if (rows.length === 0) return null;
      return rows[Math.floor(Math.random() * Math.min(5, rows.length))];
    } catch {
      return null;
    }
  }
  let cands = localCandidates({ ...q, beats }, entryIds);
  if (cands.length === 0 && beats !== 4) cands = localCandidates({ ...q, beats: 4 }, entryIds);
  if (cands.length === 0) cands = localCandidates({ ...q, beats: undefined }, entryIds);
  if (cands.length === 0 && q.role && q.role !== 'mix') {
    // No stem for that role yet: play the mix now and get the stems cut in
    // the background; the score re-resolves when they land. Silence is the
    // one thing a first press of Play must never produce.
    const unstemmed = entryIds.filter((id) => !(idx.byEntry[id] ?? []).some((r) => r.stem_name !== 'mix'));
    for (const id of unstemmed) void requestStems(id);
    const mixQ: LoomQuery = { ...q, role: 'mix' };
    cands = localCandidates({ ...mixQ, beats }, entryIds);
    if (cands.length === 0 && beats !== 4) cands = localCandidates({ ...mixQ, beats: 4 }, entryIds);
    if (cands.length === 0) cands = localCandidates({ ...mixQ, beats: undefined }, entryIds);
  }
  return pickRanked(cands, target);
}

const stemsRequested = new Set<string>();

/** Separate an entry's stems once, then re-read its shards and re-resolve. */
async function requestStems(entryId: string): Promise<void> {
  if (stemsRequested.has(entryId)) return;
  stemsRequested.add(entryId);
  try {
    const r = await fetch(`/api/stems/${encodeURIComponent(entryId)}/run?stems=4`, { method: 'POST' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      logError('loom', `Stems for "${entryTitle(entryId)}": ${(body as { detail?: string }).detail ?? r.status}`);
      return;
    }
    logInfo('loom', `Cutting stems for "${entryTitle(entryId)}" so drum, bass and vocal loops can play`);
  } catch (e) {
    logError('loom', `Stems request failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Poll until the separation is over, then refresh the shard rows.
  const deadline = Date.now() + 25 * 60 * 1000;
  let seenRunning = false;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 4000));
    try {
      const p = await fetch(`/api/stems/${encodeURIComponent(entryId)}/progress`, { cache: 'no-store' });
      const j = (await p.json()) as { phase?: string };
      const phase = j.phase ?? 'idle';
      if (phase !== 'idle') seenRunning = true;
      if (/^(idle|done|complete|completed|finished|error|failed)$/.test(phase) && (seenRunning || phase !== 'idle')) break;
    } catch { /* keep polling */ }
  }
  try {
    const r = await fetch(`/api/shards/${encodeURIComponent(entryId)}`);
    if (r.ok) {
      const j = (await r.json()) as { shards: ShardRow[] };
      const rows = j.shards ?? [];
      const hasStems = rows.some((row) => row.stem_name !== 'mix');
      if (!hasStems) {
        // Stems landed but the shards were not re-cut yet: ask for a cut.
        await fetch(`/api/shards/${encodeURIComponent(entryId)}/run`, { method: 'POST' });
        const r2 = await fetch(`/api/shards/${encodeURIComponent(entryId)}`);
        const j2 = (await r2.json()) as { shards: ShardRow[] };
        useShardIndexStore.setState((s) => ({ byEntry: { ...s.byEntry, [entryId]: j2.shards ?? rows } }));
      } else {
        useShardIndexStore.setState((s) => ({ byEntry: { ...s.byEntry, [entryId]: rows } }));
      }
      logInfo('loom', `Stems ready for "${entryTitle(entryId)}" — re-resolving at the next wrap`);
      useLoomStore.getState().refreshResolutions();
    }
  } catch (e) {
    logError('loom', `Shard refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let engine: LoomEngine | null = null;

function getEngine(): LoomEngine {
  if (engine) return engine;
  engine = new LoomEngine({
    resolve: (q, ctx) => resolveQuery(q, ctx, useLoomStore.getState().applied),
    semitonesFor: (shard) => {
      const t = targetKey(useLoomStore.getState().applied);
      if (!t || !shard.key) return 0;
      const st = transposeSemitones(shard.key, shard.scale, t.key, t.scale);
      return Math.max(-6, Math.min(6, st));
    },
    onCursors: (cursors) => useLoomStore.setState({ cursors }),
    onFire: ({ lane, step, shard, when }) => {
      const title = `${entryTitle(shard.entry_id)} · ${shard.stem_name} #${shard.bar_index}`;
      useLoomStore.setState((s) => ({ fired: { ...s.fired, [lane]: { step, at: when, title } } }));
    },
    onBpm: (bpm) => useLoomStore.setState({ bpm }),
    onUnresolved: (lane, tile) => {
      const key = tile.kind === 'gen'
        ? `${lane}: ${tile.gen}(…)`
        : `${lane}: ${tile.query.entry ?? tile.query.role ?? tile.query.shardId ?? '?'}`;
      useLoomStore.setState((s) => (s.unresolved.includes(key) ? s : { unresolved: [...s.unresolved, key].slice(-8) }));
    },
    onMasterWrap: () => {
      const e = engine;
      if (e && !e.hasQueued) useLoomStore.setState({ queued: false });
    },
  });
  return engine;
}

const colonyListeners = new Set<(e: ColonyEvent) => void>();

/** What fired when, who was born when, who is withering — the growth
 *  bookkeeping (module state: it changes many times a bar). */
const activity: Activity = { fires: {}, born: {}, dying: {} };
let rootLap = 0;
/** Laps counted by hand while the engine is stopped (each GROW press). */
let manualLap = 0;

/** The root lap, fractional while playing, for ripening and withering. */
function lapNow(): number {
  return colonyEngine?.running ? colonyEngine.lapFloat : manualLap;
}

/** How alive a cell is right now (0 newborn or withering, 1 ripe) — for the canvas. */
export function colonyVitality(key: string): number {
  return vitalityOf(activity, key, lapNow());
}

/** Whether a cell is withering (the canvas hollows it out). */
export function colonyWithering(key: string): boolean {
  return activity.dying[key] != null;
}

/** Where a newborn cell appears: ON its parent (it divides off; the bonds
 *  push it out), or at the centre of a newborn colony. */
function birthPosition(positions: Record<string, NodePos>, key: string, parent: string | null, k: number): NodePos {
  const angle = ((k * 137.5) % 360) * (Math.PI / 180);
  if (parent && key.startsWith(`${parent}/`)) return { x: Math.round(Math.cos(angle) * 12), y: Math.round(Math.sin(angle) * 12) };
  const p = parent ? positions[parent] ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  return { x: Math.round(p.x + Math.cos(angle) * 8), y: Math.round(p.y + Math.sin(angle) * 8) };
}

/** Re-key one record when a cell moves (enveloped) or dies. */
function rekey<T>(rec: Record<string, T>, from: string, to: string | null): void {
  for (const k of Object.keys(rec)) {
    if (k !== from && !k.startsWith(`${from}/`)) continue;
    const v = rec[k];
    delete rec[k];
    if (to) rec[`${to}${k.slice(from.length)}`] = v;
  }
}
/** The canvas subscribes here; events carry their audio-clock time. */
export function subscribeColonyEvents(fn: (e: ColonyEvent) => void): () => void {
  colonyListeners.add(fn);
  return () => { colonyListeners.delete(fn); };
}

let colonyEngine: ColonyEngine | null = null;

function getColonyEngine(): ColonyEngine {
  if (colonyEngine) return colonyEngine;
  colonyEngine = new ColonyEngine({
    resolve: (q, ctx) => resolveQuery(q, ctx, useLoomStore.getState().applied),
    semitonesFor: (shard) => {
      const st = useLoomStore.getState();
      const c = st.colonyApplied;
      const t = c.key && c.key !== 'follow' ? { key: c.key, scale: c.scale ?? 'major' } : targetKey(st.applied);
      if (!t || !shard.key) return 0;
      return Math.max(-6, Math.min(6, transposeSemitones(shard.key, shard.scale, t.key, t.scale)));
    },
    onEvent: (e) => {
      if (e.kind === 'fire') activity.fires[e.path.join('/')] = rootLap;
      else if (e.kind === 'bar' && e.path.length === 0) {
        rootLap = e.lap ?? 0;
        useLoomStore.setState({ colonyLap: rootLap });
        // The organism grows at the top of every root bar; the new body is
        // queued and takes over at the next bar boundary.
        const st = useLoomStore.getState();
        if (st.colonyApplied.grow && st.colonyApplied.grow.rate > 0 && !st.colonyDirty && st.colonyErrors.length === 0) st.growNow();
      }
      for (const fn of colonyListeners) fn(e);
    },
    onUnresolved: (path, node) => {
      const key = [...path, node.id].join('/');
      useLoomStore.setState((s) => (s.colonyUnresolved.includes(key) ? s : { colonyUnresolved: [...s.colonyUnresolved, key].slice(-8) }));
    },
    vitality: (path, id, lap) => vitalityOf(activity, nodeKey(path, id), lap),
  });
  return colonyEngine;
}

export function colonyResolvedFor(query: LoomQuery): ShardRow | null {
  return colonyEngine ? colonyEngine.resolvedFor(query) : null;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function laneOf(score: LoomScore, name: string): LoomLane | undefined {
  return score.lanes.find((l) => l.name === name);
}

export const useLoomStore = create<LoomState>()(
  persist(
    (set, get) => {
      /** Commit a score edited on the grid: serialize, apply, push to the engine. */
      const commit = (next: LoomScore) => {
        const text = serializeLoom(next);
        const eng = getEngine();
        eng.setScore(next);
        set({ applied: next, text, errors: [], dirty: false, queued: eng.running && eng.hasQueued, unresolved: [] });
      };

      const initial = parseLoom(STARTER_SCORE);
      const initialColony = parseColony(STARTER_COLONY);

      /** Commit a colony edited from the canvas or inspector. */
      const commitColony = (next: ColonyScore) => {
        const text = serializeColony(next);
        const eng = getColonyEngine();
        eng.setScore(next);
        set({ colonyApplied: next, colonyText: text, colonyErrors: [], colonyDirty: false, queued: eng.running && eng.hasQueued, colonyUnresolved: [] });
      };

      /** Default cells for the + buttons: each plays something on its own. */
      const freshNode = (g: ColonyGraph, kind: ColonyKind): ColonyNode => {
        switch (kind) {
          case 'loop': return { kind: 'loop', id: uniqueId(g, 'drums'), query: { role: 'drums', beats: 4 }, beats: 4, gain: 0, transpose: 0, hold: false, ...LOOP_DEFAULTS };
          case 'rule': { const steps = g.meter.num * (g.meter.den >= 8 ? 1 : 2); return { kind: 'rule', id: uniqueId(g, 'pulse'), gen: 'euclid', steps, symbols: 2, opts: { ...GEN_DEFAULT_OPTS.euclid, hits: Math.max(1, Math.round(steps * 0.6)) } }; }
          case 'gate': return { kind: 'gate', id: uniqueId(g, 'maybe'), pct: 50 };
          case 'mod': return { kind: 'mod', id: uniqueId(g, 'dark'), mode: 'abs', params: { cutoff: 0.4 } };
          case 'colony': {
            const child: ColonyGraph = { meter: { num: 7, den: 8, groups: [3, 2, 2] }, tempo: 1, nodes: [], edges: [] };
            child.nodes.push({ kind: 'rule', id: 'tick', gen: 'euclid', steps: 7, symbols: 2, opts: { ...GEN_DEFAULT_OPTS.euclid, hits: 3 } });
            child.nodes.push({ kind: 'loop', id: 'hat', query: { role: 'hihat', beats: 1 }, beats: 1, gain: -6, transpose: 0, hold: false, ...LOOP_DEFAULTS });
            child.edges.push({ from: 'tick', to: 'hat' });
            return { kind: 'colony', id: uniqueId(g, 'seven'), graph: child };
          }
        }
      };

      /** Drop every saved position under a key (the node and, for a colony, its cells). */
      const dropPositions = (positions: Record<string, NodePos>, key: string): Record<string, NodePos> => {
        const out: Record<string, NodePos> = {};
        for (const [k, v] of Object.entries(positions)) if (k !== key && !k.startsWith(`${key}/`)) out[k] = v;
        return out;
      };

      return {
        text: STARTER_SCORE,
        applied: initial.score,
        errors: initial.errors,
        dirty: false,
        running: false,
        queued: false,
        cursors: {},
        fired: {},
        unresolved: [],
        selected: null,
        bpm: initial.score.bpm ?? beatClock.bpm,
        history: [],
        keepLanes: [],
        mode: 'colony',
        colonyText: STARTER_COLONY,
        colonyApplied: initialColony.score,
        colonyErrors: initialColony.errors,
        colonyDirty: false,
        colonyPositions: {},
        colonySelected: null,
        colonySelectedEdge: null,
        colonyFocus: null,
        colonyUnresolved: [],
        colonyLap: 0,
        colonyGen: 0,

        selectColonyEdge: (sel) => set({ colonySelectedEdge: sel, colonySelected: sel ? null : get().colonySelected }),
        setColonyFocus: (key) => set({ colonyFocus: key }),

        addColonyNode: (parent, kind, near) => {
          const next = clone(get().colonyApplied);
          const g = graphAt(next.root, parent);
          if (!g) return null;
          const node = freshNode(g, kind);
          g.nodes.push(node);
          const key = parent ? `${parent}/${node.id}` : node.id;
          const k = walkNodes(next.root).length;
          const angle = ((k * 137.5) % 360) * (Math.PI / 180);
          const pos = near ?? { x: Math.round(Math.cos(angle) * 110), y: Math.round(Math.sin(angle) * 110) };
          set((s) => ({ colonyPositions: { ...s.colonyPositions, [key]: pos }, colonySelected: key, colonySelectedEdge: null }));
          commitColony(next);
          logInfo('loom', `Added ${kind} "${node.id}"${parent ? ` in ${parent}` : ''}`);
          return key;
        },

        removeColonyNode: (key) => {
          const next = clone(get().colonyApplied);
          const w = findNode(next.root, key);
          if (!w) return;
          w.graph.nodes.splice(w.graph.nodes.indexOf(w.node), 1);
          w.graph.edges = w.graph.edges.filter((e) => e.from !== w.node.id && e.to !== w.node.id);
          set((s) => ({
            colonyPositions: dropPositions(s.colonyPositions, key),
            colonySelected: s.colonySelected === key || s.colonySelected?.startsWith(`${key}/`) ? null : s.colonySelected,
            colonySelectedEdge: null,
            colonyFocus: s.colonyFocus === key || s.colonyFocus?.startsWith(`${key}/`) ? null : s.colonyFocus,
          }));
          commitColony(next);
        },

        duplicateColonyNode: (key) => {
          const next = clone(get().colonyApplied);
          const w = findNode(next.root, key);
          if (!w) return null;
          const copy = clone(w.node);
          copy.id = uniqueId(w.graph, w.node.id.replace(/\d+$/, ''));
          w.graph.nodes.push(copy);
          // The copy hears what the original hears.
          for (const e of [...w.graph.edges]) if (e.to === w.node.id && e.from !== w.node.id) w.graph.edges.push({ from: e.from, to: copy.id, on: e.on });
          const parent = w.path.length ? w.path.join('/') : null;
          const newKey = parent ? `${parent}/${copy.id}` : copy.id;
          const p = get().colonyPositions[key] ?? { x: 0, y: 0 };
          set((s) => ({ colonyPositions: { ...s.colonyPositions, [newKey]: { x: p.x + 70, y: p.y + 40 } }, colonySelected: newKey, colonySelectedEdge: null }));
          commitColony(next);
          return newKey;
        },

        addColonyEdge: (parent, from, to) => {
          const next = clone(get().colonyApplied);
          const g = graphAt(next.root, parent);
          if (!g) return false;
          const a = g.nodes.find((n) => n.id === from);
          const b = g.nodes.find((n) => n.id === to);
          if (!a || !b || !canWire(a, b)) return false;
          if (g.edges.some((e) => e.from === from && e.to === to)) return false;
          g.edges.push({ from, to });
          set({ colonySelectedEdge: { parent, from, to }, colonySelected: null });
          commitColony(next);
          return true;
        },

        removeColonyEdge: (parent, from, to) => {
          const next = clone(get().colonyApplied);
          const g = graphAt(next.root, parent);
          if (!g) return;
          g.edges = g.edges.filter((e) => !(e.from === from && e.to === to));
          set({ colonySelectedEdge: null });
          commitColony(next);
        },

        setColonyEdgeOn: (parent, from, to, on) => {
          const next = clone(get().colonyApplied);
          const g = graphAt(next.root, parent);
          const e = g?.edges.find((x) => x.from === from && x.to === to);
          if (!e) return;
          e.on = on;
          commitColony(next);
        },

        setRootMeter: (meter, tempo) => {
          const next = clone(get().colonyApplied);
          next.root.meter = meter;
          if (tempo != null) next.root.tempo = tempo;
          commitColony(next);
        },

        setGrow: (spec) => {
          const next = clone(get().colonyApplied);
          if (spec) next.grow = spec; else delete next.grow;
          commitColony(next);
        },

        setSwing: (swing) => {
          const next = clone(get().colonyApplied);
          next.swing = Math.round(Math.max(0.5, Math.min(0.85, swing)) * 100) / 100;
          commitColony(next);
        },

        setGrain: (grain) => {
          const next = clone(get().colonyApplied);
          next.grain = grain;
          commitColony(next);
        },

        setColonySeed: (seed) => {
          const next = clone(get().colonyApplied);
          next.seed = Math.max(0, Math.floor(seed));
          commitColony(next);
        },

        growNow: (force) => {
          const st = get();
          // Stopped, every press is its own lap (so the dice move); a manual
          // press also grows eagerly — it is "one step of life", not a maybe.
          const lap = st.running ? rootLap : (manualLap += 1);
          const res = growColony(st.colonyApplied, lap, activity, force ? { force, rate: 1 } : st.running ? undefined : { rate: Math.max(st.colonyApplied.grow?.rate ?? 0, 0.8) });
          if (!res.born.length && !res.died.length && !res.withering.length && !res.moved.length && !res.changed.length) return;
          let positions = { ...st.colonyPositions };
          let selected = st.colonySelected;
          let focus = st.colonyFocus;
          // Enveloped cells keep their place: the new membrane sits where the
          // cell was and the cell moves to its centre.
          for (const m of res.moved) {
            const colKey = m.to.slice(0, m.to.lastIndexOf('/'));
            const at = positions[m.from] ?? { x: 0, y: 0 };
            positions = dropPositions(positions, m.from);
            positions[colKey] = at;
            positions[m.to] = { x: 0, y: 0 };
            rekey(activity.born, m.from, m.to);
            rekey(activity.fires, m.from, m.to);
            rekey(activity.dying, m.from, m.to);
            if (selected === m.from) selected = m.to;
            if (focus === m.from) focus = null;
          }
          res.born.forEach((b, i) => { if (!positions[b.key]) positions[b.key] = birthPosition(positions, b.key, b.parent, lap * 7 + i); activity.born[b.key] = lap; });
          for (const w of res.withering) activity.dying[w] = lap + WITHER_LAPS;
          for (const d of res.died) {
            positions = dropPositions(positions, d);
            rekey(activity.born, d, null); rekey(activity.fires, d, null); rekey(activity.dying, d, null);
            if (selected === d || selected?.startsWith(`${d}/`)) selected = null;
            if (focus === d || focus?.startsWith(`${d}/`)) focus = null;
          }
          set({ colonyPositions: positions, colonySelected: force ? res.born[0]?.key ?? selected : selected, colonyFocus: focus, colonySelectedEdge: null, colonyGen: st.colonyGen + 1 });
          commitColony(res.score);
          const what = [res.born.length ? `+${res.born.length}` : '', res.moved.length ? `⊂${res.moved.length}` : '', res.withering.length ? `↓${res.withering.length}` : '', res.died.length ? `−${res.died.length}` : '', res.changed.length ? `~${res.changed.length}` : ''].filter(Boolean).join(' ');
          logInfo('loom', `${force ? 'Bud' : 'Grew'}: ${what} (${walkNodes(res.score.root).length} cells)`);
        },

        setMode: (m) => {
          if (get().running) get().stop();
          set({ mode: m, selected: null, colonySelected: null });
        },
        setColonyText: (t) => {
          const { score, errors } = parseColony(t);
          const dirty = errors.length === 0 ? serializeColony(score) !== serializeColony(get().colonyApplied) : true;
          set({ colonyText: t, colonyErrors: errors, colonyDirty: dirty });
        },
        applyColony: () => {
          const { score, errors } = parseColony(get().colonyText);
          if (errors.length) { set({ colonyErrors: errors }); return false; }
          const eng = getColonyEngine();
          eng.setScore(score);
          if (score.bpm && !eng.running) beatClock.setBpm(score.bpm, 'loom');
          set({ colonyApplied: score, colonyErrors: [], colonyDirty: false, queued: eng.running && eng.hasQueued, colonyUnresolved: [], bpm: score.bpm ?? beatClock.bpm, colonyGen: 0 });
          logInfo('loom', eng.running ? 'Colony queued for the next bar' : 'Colony applied');
          return true;
        },
        setColonyPosition: (key, pos) => set((s) => ({ colonyPositions: { ...s.colonyPositions, [key]: pos } })),
        selectColony: (key) => set({ colonySelected: key }),
        updateColonyNode: (key, node) => {
          const next = clone(get().colonyApplied);
          for (const w of walkNodes(next.root)) {
            if (nodeKey(w.path, w.node.id) === key) {
              const i = w.graph.nodes.indexOf(w.node);
              // Renames carry the edges, the saved positions and the selection with them.
              if (node.id !== w.node.id) {
                if (w.graph.nodes.some((n) => n !== w.node && n.id === node.id)) return;
                for (const e of w.graph.edges) { if (e.from === w.node.id) e.from = node.id; if (e.to === w.node.id) e.to = node.id; }
                const newKey = nodeKey(w.path, node.id);
                set((s) => {
                  const positions: Record<string, NodePos> = {};
                  for (const [k, v] of Object.entries(s.colonyPositions)) positions[k === key ? newKey : k.startsWith(`${key}/`) ? `${newKey}${k.slice(key.length)}` : k] = v;
                  return { colonyPositions: positions, colonySelected: s.colonySelected === key ? newKey : s.colonySelected, colonyFocus: s.colonyFocus === key ? newKey : s.colonyFocus };
                });
              }
              w.graph.nodes[i] = node;
              break;
            }
          }
          commitColony(next);
        },
        resetColonyStarter: () => {
          const { score, errors } = parseColony(STARTER_COLONY);
          activity.fires = {};
          activity.born = {};
          activity.dying = {};
          manualLap = 0;
          set({ colonyText: STARTER_COLONY, colonyApplied: score, colonyErrors: errors, colonyDirty: false, colonySelected: null, colonySelectedEdge: null, colonyFocus: null, colonyPositions: {}, colonyGen: 0 });
          getColonyEngine().setScore(score);
        },
        refreshResolutions: () => {
          const st = get();
          getEngine().setScore(clone(st.applied));
          getColonyEngine().setScore(clone(st.colonyApplied));
        },

        setText: (t) => {
          const { score, errors } = parseLoom(t);
          const dirty = errors.length === 0 ? serializeLoom(score) !== serializeLoom(get().applied) : true;
          set({ text: t, errors, dirty });
        },

        apply: () => {
          const { score, errors } = parseLoom(get().text);
          if (errors.length) { set({ errors }); return false; }
          const eng = getEngine();
          eng.setScore(score);
          if (score.bpm && !eng.running) beatClock.setBpm(score.bpm, 'loom');
          set({ applied: score, errors: [], dirty: false, queued: eng.running && eng.hasQueued, unresolved: [], bpm: score.bpm ?? beatClock.bpm });
          logInfo('loom', eng.running ? 'Score queued for the next master wrap' : 'Score applied');
          return true;
        },

        play: () => {
          const st = get();
          if (st.mode === 'colony') {
            if (st.colonyDirty && !get().applyColony()) return;
            const eng = getColonyEngine();
            eng.setScore(get().colonyApplied, { immediate: true });
            eng.start();
            set({ running: true, queued: false, colonyUnresolved: [] });
            return;
          }
          if (st.dirty || !getEngine()['score']) {
            if (!get().apply()) return;
          }
          const eng = getEngine();
          eng.setScore(get().applied, { immediate: true });
          eng.start();
          set({ running: true, queued: false, unresolved: [] });
        },
        stop: () => {
          getEngine().stop();
          getColonyEngine().stop();
          set({ running: false, queued: false, cursors: {}, colonyLap: 0 });
          rootLap = 0;
        },
        toggle: () => { if (get().running) get().stop(); else get().play(); },

        select: (sel) => set({ selected: sel }),

        setTile: (sel, tile) => {
          const next = clone(get().applied);
          const lane = laneOf(next, sel.lane);
          if (!lane) return;
          while (lane.rows.length <= sel.row) lane.rows.unshift(new Array(lane.length).fill(null));
          const row = lane.rows[sel.row];
          if (!row || sel.step < 0 || sel.step >= lane.length) return;
          row[sel.step] = tile;
          commit(next);
        },

        addRow: (name) => {
          const next = clone(get().applied);
          const lane = laneOf(next, name);
          if (!lane) return;
          lane.rows.unshift(new Array(lane.length).fill(null));
          commit(next);
        },

        removeRow: (name, rowIdx) => {
          const next = clone(get().applied);
          const lane = laneOf(next, name);
          if (!lane || lane.rows.length <= 1 || rowIdx === lane.rows.length - 1) return; // keep the rail
          lane.rows.splice(rowIdx, 1);
          commit(next);
          set({ selected: null });
        },

        setLaneOpts: (name, opts) => {
          const next = clone(get().applied);
          const lane = laneOf(next, name);
          if (!lane) return;
          if (opts.name && opts.name !== name && !laneOf(next, opts.name) && /^[a-zA-Z0-9_\-.]+$/.test(opts.name)) {
            // Rename: retarget jumps too.
            for (const l of next.lanes) for (const row of l.rows) for (const t of row) if (t && t.kind === 'jump' && t.target === name) t.target = opts.name;
            lane.name = opts.name;
          }
          if (opts.div) lane.div = opts.div;
          if (opts.length && opts.length !== lane.length) {
            const len = Math.max(1, Math.min(256, Math.round(opts.length)));
            lane.rows = lane.rows.map((row) => {
              const out: (LoomTile | null)[] = new Array(len).fill(null);
              for (let i = 0; i < Math.min(len, row.length); i += 1) out[i] = row[i];
              return out;
            });
            lane.length = len;
          }
          if (opts.isTarget !== undefined) lane.isTarget = opts.isTarget;
          if (opts.play !== undefined) lane.play = opts.play;
          commit(next);
        },

        addLane: () => {
          const next = clone(get().applied);
          let n = next.lanes.length + 1;
          while (laneOf(next, `lane${n}`)) n += 1;
          next.lanes.push({ name: `lane${n}`, div: DEFAULT_DIV, length: DEFAULT_LENGTH, isTarget: false, play: true, rows: [new Array(DEFAULT_LENGTH).fill(null)] });
          commit(next);
        },

        removeLane: (name) => {
          const next = clone(get().applied);
          next.lanes = next.lanes.filter((l) => l.name !== name);
          for (const l of next.lanes) for (const row of l.rows) for (let i = 0; i < row.length; i += 1) {
            const t = row[i];
            if (t && t.kind === 'jump' && t.target === name) row[i] = null;
          }
          commit(next);
          set({ selected: null });
        },

        setBpm: (bpm) => {
          const v = Math.max(20, Math.min(300, bpm));
          beatClock.setBpm(v, 'loom');
          const next = clone(get().applied);
          next.bpm = v;
          const text = serializeLoom(next);
          set({ applied: next, text, bpm: v });
          getEngine().setScore(next, { immediate: true });
        },

        mutate: (intensity) => {
          const st = get();
          const parent = st.applied;
          const seed = (parent.seed ?? DEFAULT_SEED) * 31 + st.history.length * 7 + Math.floor(Math.random() * 1e6);
          const child = mutateScore(parent, seed, { intensity, keep: st.keepLanes });
          const gen = st.history.length + 1;
          set({ history: [...st.history, { text: st.text, label: `gen ${gen - 1}`, at: Date.now() }].slice(-24), selected: null });
          commit(child);
          logInfo('loom', `Grew generation ${gen} (${intensity} edits)`);
        },

        breed: (partner) => {
          const st = get();
          const tpl = loomTemplateById(partner);
          const { score: other, errors } = parseLoom(tpl ? tpl.text : partner);
          if (errors.length || other.lanes.length === 0) return false;
          const seed = (st.applied.seed ?? DEFAULT_SEED) ^ (other.seed ?? 0x51) ^ Math.floor(Math.random() * 1e6);
          const child = breedScores(st.applied, other, seed, { keep: st.keepLanes });
          const gen = st.history.length + 1;
          set({ history: [...st.history, { text: st.text, label: `gen ${gen - 1}`, at: Date.now() }].slice(-24), selected: null });
          commit(child);
          if (tpl) {
            const idx = useShardIndexStore.getState();
            for (const ref of tpl.songs) { const id = resolveEntryRef(ref); if (id) idx.addToCrate(id); }
          }
          logInfo('loom', `Bred generation ${gen} with ${tpl ? tpl.name : 'the pasted score'}`);
          return true;
        },

        fragmentize: (size) => {
          const st = get();
          const gen = st.history.length + 1;
          set({ history: [...st.history, { text: st.text, label: `gen ${gen - 1}`, at: Date.now() }].slice(-24), selected: null });
          commit(fragmentScore(st.applied, size));
          logInfo('loom', `Fragmented every rail into ${size}-beat pieces`);
        },

        setSeed: (seed) => {
          const next = clone(get().applied);
          next.seed = Math.max(0, Math.floor(seed));
          commit(next);
        },

        setForm: (form) => {
          const next = clone(get().applied);
          const f = form.replace(/[^A-Za-z]/g, '').toUpperCase();
          if (f) next.form = f; else delete next.form;
          commit(next);
        },

        toggleKeepLane: (lane) => set((s) => ({ keepLanes: s.keepLanes.includes(lane) ? s.keepLanes.filter((l) => l !== lane) : [...s.keepLanes, lane] })),

        revert: (index) => {
          const st = get();
          const g = st.history[index];
          if (!g) return;
          const { score, errors } = parseLoom(g.text);
          if (errors.length) return;
          set({ history: st.history.slice(0, index), selected: null });
          commit(score);
          logInfo('loom', `Back to ${g.label}`);
        },

        resetStarter: () => {
          const { score, errors } = parseLoom(STARTER_SCORE);
          set({ text: STARTER_SCORE, applied: score, errors, dirty: false, selected: null });
          getEngine().setScore(score);
        },

        loadTemplate: (id) => {
          const t = loomTemplateById(id);
          if (!t) return [];
          if (t.mode === 'colony') {
            if (get().running) get().stop();
            const c = parseColony(t.text);
            const ceng = getColonyEngine();
            ceng.setScore(c.score);
            if (c.score.bpm) beatClock.setBpm(c.score.bpm, 'loom');
            set({ mode: 'colony', colonyText: t.text, colonyApplied: c.score, colonyErrors: c.errors, colonyDirty: false, colonySelected: null, colonySelectedEdge: null, colonyFocus: null, colonyPositions: {}, colonyUnresolved: [], bpm: c.score.bpm ?? beatClock.bpm, colonyGen: 0 });
            const missingC: string[] = [];
            const idxC = useShardIndexStore.getState();
            for (const ref of t.songs) { const eid = resolveEntryRef(ref); if (eid) idxC.addToCrate(eid); else missingC.push(ref); }
            logInfo('loom', `Loaded colony "${t.name}"`);
            return missingC;
          }
          const { score, errors } = parseLoom(t.text);
          const eng = getEngine();
          eng.setScore(score);
          if (score.bpm && !eng.running) beatClock.setBpm(score.bpm, 'loom');
          set({ text: t.text, applied: score, errors, dirty: false, selected: null, queued: eng.running && eng.hasQueued, unresolved: [], bpm: score.bpm ?? beatClock.bpm });
          const missing: string[] = [];
          const idx = useShardIndexStore.getState();
          for (const ref of t.songs) {
            const entryId = resolveEntryRef(ref);
            if (entryId) idx.addToCrate(entryId); else missing.push(ref);
          }
          logInfo('loom', missing.length
            ? `Loaded "${t.name}" — not in the library: ${missing.join(', ')}`
            : `Loaded "${t.name}"${eng.running ? ' (swaps at the master wrap)' : ''}`);
          return missing;
        },

        resolvedFor: (tile) => getEngine().resolvedFor(tile),
      };
    },
    {
      name: 'thedaw-loom-v1',
      version: 2,
      migrate: (persisted) => ({ ...(persisted as object), mode: 'colony' }),
      partialize: (s) => ({ text: s.text, colonyText: s.colonyText, mode: s.mode, colonyPositions: s.colonyPositions }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // The LOOM tab has one view now: the colony.
        if (state.mode !== 'colony') useLoomStore.setState({ mode: 'colony' });
        const { score, errors } = parseLoom(state.text);
        useLoomStore.setState({ applied: score, errors, dirty: false, bpm: score.bpm ?? beatClock.bpm });
        getEngine().setScore(score);
        const c = parseColony(state.colonyText || STARTER_COLONY);
        useLoomStore.setState({ colonyApplied: c.score, colonyErrors: c.errors, colonyDirty: false });
        getColonyEngine().setScore(c.score);
      },
    },
  ),
);

beatClock.subscribe((s) => {
  if (Math.abs(useLoomStore.getState().bpm - s.bpm) > 1e-6) useLoomStore.setState({ bpm: s.bpm });
});
