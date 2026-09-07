/**
 * shardIndexStore — the client mirror of the Shard Index (docs/design/loom.md §1).
 *
 * Holds every shard row for the songs "on deck" so a LOOM query resolves in
 * memory between two sixteenths; falls back to `POST /api/shards/query` when
 * the question is about the whole library. A song that has never been sharded
 * is cut on first reference (`POST /api/shards/{id}/run`) — the caller sees
 * status 'sharding' meanwhile and a tile stays silent until the rows land.
 */
import { create } from 'zustand';
import { useLibraryStore } from './libraryStore';
import { logError, logInfo } from './logStore';
import type { LoomQuery, LoomRole } from '../lib/loomScore';

export interface ShardRow {
  id: string;
  entry_id: string;
  stem_name: string;
  role: LoomRole | string;
  start_sec: number;
  end_sec: number;
  beats: number;
  bar_index: number;
  bpm: number;
  key: string;
  scale: string;
  camelot: string;
  pc_root: number;
  rms_db: number;
  low_frac: number;
  onset_density: number;
  centroid_hz: number;
  onset_mask: number;
  energy: number;
  section: string;
  chord: string;
  words: string;
  /** Present on server-ranked rows. */
  score?: number;
  tempo_ratio?: number;
  transpose?: number;
}

export interface ShardQueryRequest {
  role?: string;
  beats?: number;
  entry?: string;
  exclude_entry?: string;
  camelot_of?: string;
  key?: string;
  scale?: string;
  bpm?: number;
  stretch_max?: number;
  energy?: [number, number];
  section?: string;
  mask_like?: number;
  text?: string;
  limit?: number;
}

export type EntryShardStatus = 'idle' | 'loading' | 'sharding' | 'ready' | 'empty' | 'error';

interface ShardIndexState {
  byEntry: Record<string, ShardRow[]>;
  status: Record<string, EntryShardStatus>;
  /** Songs the user has put on deck for LOOM (entry ids). */
  crate: string[];
  addToCrate: (entryId: string) => void;
  removeFromCrate: (entryId: string) => void;
  /** Load (and cut, when needed) one entry's shards. Resolves to the rows. */
  ensureEntry: (entryId: string, opts?: { run?: boolean }) => Promise<ShardRow[]>;
  query: (req: ShardQueryRequest) => Promise<ShardRow[]>;
  pairings: (shardId: string, opts?: { role?: string; beats?: number; limit?: number }) => Promise<ShardRow[]>;
  keep: (aId: string, bId: string) => Promise<void>;
}

const DRUM_ROLES = new Set(['drums', 'kick', 'snare', 'hihat', 'cymbals', 'toms']);

async function fetchEntry(entryId: string): Promise<ShardRow[]> {
  const r = await fetch(`/api/shards/${encodeURIComponent(entryId)}`);
  if (!r.ok) throw new Error(`shards ${r.status}`);
  const j = (await r.json()) as { shards: ShardRow[] };
  return j.shards ?? [];
}

const inflight = new Map<string, Promise<ShardRow[]>>();

export const useShardIndexStore = create<ShardIndexState>()((set, get) => ({
  byEntry: {},
  status: {},
  crate: [],

  addToCrate: (entryId) => {
    if (get().crate.includes(entryId)) return;
    set((s) => ({ crate: [...s.crate, entryId] }));
    void get().ensureEntry(entryId, { run: true });
  },
  removeFromCrate: (entryId) => set((s) => ({ crate: s.crate.filter((id) => id !== entryId) })),

  ensureEntry: async (entryId, opts) => {
    const have = get().byEntry[entryId];
    if (have && have.length > 0) return have;
    const key = entryId;
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      set((s) => ({ status: { ...s.status, [entryId]: 'loading' } }));
      try {
        let rows = await fetchEntry(entryId);
        if (rows.length === 0 && opts?.run !== false) {
          set((s) => ({ status: { ...s.status, [entryId]: 'sharding' } }));
          const title = useLibraryStore.getState().entries.find((e) => e.id === entryId)?.title ?? entryId;
          logInfo('loom', `Sharding "${title}"…`);
          const run = await fetch(`/api/shards/${encodeURIComponent(entryId)}/run`, { method: 'POST' });
          if (!run.ok) {
            let detail = `HTTP ${run.status}`;
            try { const j = await run.json(); if (typeof j.detail === 'string') detail = j.detail; } catch { /* keep */ }
            throw new Error(detail);
          }
          rows = await fetchEntry(entryId);
          logInfo('loom', `"${title}" → ${rows.length} shards`);
        }
        set((s) => ({
          byEntry: { ...s.byEntry, [entryId]: rows },
          status: { ...s.status, [entryId]: rows.length ? 'ready' : 'empty' },
        }));
        return rows;
      } catch (e) {
        set((s) => ({ status: { ...s.status, [entryId]: 'error' } }));
        logError('loom', `Shards for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  },

  query: async (req) => {
    const r = await fetch('/api/shards/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`shard query ${r.status}`);
    const j = (await r.json()) as { shards: ShardRow[] };
    return j.shards ?? [];
  },

  pairings: async (shardId, opts) => {
    const r = await fetch('/api/shards/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shard_id: shardId, ...(opts ?? {}) }),
    });
    if (!r.ok) throw new Error(`pairings ${r.status}`);
    const j = (await r.json()) as { complements: ShardRow[] };
    return j.complements ?? [];
  },

  keep: async (aId, bId) => {
    await fetch('/api/shards/keep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a_id: aId, b_id: bId }),
    });
  },
}));

/** An entry reference from the notation — an id, or a title fragment — to an id. */
const foldTitle = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[\s_\-–—.]+/g, ' ').trim();

export function resolveEntryRef(ref: string): string | null {
  const entries = useLibraryStore.getState().entries;
  if (entries.some((e) => e.id === ref)) return ref;
  const byPrefix = ref.length >= 8 && entries.find((e) => e.id.startsWith(ref));
  if (byPrefix) return byPrefix.id;
  const needle = foldTitle(ref);
  if (!needle) return null;
  const titled = entries.map((e) => ({ id: e.id, t: foldTitle(e.title ?? '') }));
  const exact = titled.find((e) => e.t === needle);
  if (exact) return exact.id;
  const starts = titled.find((e) => e.t.startsWith(needle));
  if (starts) return starts.id;
  const within = titled.find((e) => e.t.includes(needle));
  return within ? within.id : null;
}

export function roleMatches(want: string | undefined, have: string): boolean {
  if (!want) return true;
  if (want === 'drums') return DRUM_ROLES.has(have);
  return want === have;
}

/** In-memory candidates for a query over the given entries (the crate, or a pin). */
export function localCandidates(q: LoomQuery, entryIds: string[]): ShardRow[] {
  const by = useShardIndexStore.getState().byEntry;
  const out: ShardRow[] = [];
  for (const id of entryIds) {
    if (q.excludeEntry && resolveEntryRef(q.excludeEntry) === id) continue;
    for (const r of by[id] ?? []) {
      if (q.shardId && r.id !== q.shardId) continue;
      if (!roleMatches(q.role, r.role)) continue;
      if (q.beats && r.beats !== q.beats) continue;
      if (q.bar != null && r.bar_index !== q.bar) continue;
      if (q.energyMin != null && r.energy < q.energyMin) continue;
      if (q.energyMax != null && r.energy > q.energyMax) continue;
      if (q.section && r.section !== q.section) continue;
      if (q.text) {
        const t = q.text.toLowerCase();
        if (!r.words.toLowerCase().includes(t) && !r.chord.toLowerCase().includes(t)) continue;
      }
      out.push(r);
    }
  }
  return out;
}
