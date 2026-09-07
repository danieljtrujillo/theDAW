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

export interface TileSel { lane: string; row: number; step: number }

export interface FireInfo { step: number; at: number; title: string }

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
  return pickRanked(cands, target);
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
    onUnresolved: (lane, tile) => {
      const key = `${lane}: ${tile.query.entry ?? tile.query.role ?? tile.query.shardId ?? '?'}`;
      useLoomStore.setState((s) => (s.unresolved.includes(key) ? s : { unresolved: [...s.unresolved, key].slice(-8) }));
    },
    onMasterWrap: () => {
      const e = engine;
      if (e && !e.hasQueued) useLoomStore.setState({ queued: false });
    },
  });
  return engine;
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
          set({ running: false, queued: false, cursors: {} });
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

        resetStarter: () => {
          const { score, errors } = parseLoom(STARTER_SCORE);
          set({ text: STARTER_SCORE, applied: score, errors, dirty: false, selected: null });
          getEngine().setScore(score);
        },

        loadTemplate: (id) => {
          const t = loomTemplateById(id);
          if (!t) return [];
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
      version: 1,
      partialize: (s) => ({ text: s.text }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const { score, errors } = parseLoom(state.text);
        useLoomStore.setState({ applied: score, errors, dirty: false, bpm: score.bpm ?? beatClock.bpm });
        getEngine().setScore(score);
      },
    },
  ),
);

beatClock.subscribe((s) => {
  if (Math.abs(useLoomStore.getState().bpm - s.bpm) > 1e-6) useLoomStore.setState({ bpm: s.bpm });
});
