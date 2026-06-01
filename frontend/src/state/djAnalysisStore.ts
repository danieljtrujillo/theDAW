/**
 * djAnalysisStore — per-entry audio analysis (BPM / key / etc.) for the DJ tab.
 *
 * The backend already computes BPM (aubio), musical key + scale (librosa), bars,
 * loudness, pitch — exposed at `/api/analysis/{id}` (GET row, returns
 * `{status:'pending'}` when not yet analyzed) and `/api/analysis/{id}/run`
 * (POST, synchronous foreground analysis). This store is a thin cache + an
 * `ensureAnalyzed()` that runs analysis on demand (e.g. when a track is loaded
 * onto a deck) so DJ decks show grid info without a manual step.
 *
 * Mirrors the shape DetailsView already uses; Camelot is derived client-side
 * (see lib/camelot.ts) — no extra backend work.
 */
import { create } from 'zustand';
import { logError } from './logStore';

export interface DjAnalysis {
  bpm: number | null;
  key: string | null;
  scale: string | null;
  key_confidence: number | null;
  bars_estimated: number | null;
  rms_db: number | null;
  duration_sec: number | null;
  beats: number[] | null;
  analyzed_at: number | null;
}

type Status = 'unknown' | 'pending' | 'running' | 'ready' | 'error';

interface Entry {
  status: Status;
  data: DjAnalysis | null;
}

interface DjAnalysisState {
  byId: Record<string, Entry>;
  /** Fetch the cached analysis row for an entry (no run). */
  fetch: (entryId: string) => Promise<void>;
  /** Fetch; if pending/unknown, kick off a /run and store the result. Safe to
   *  call repeatedly — in-flight + ready entries are skipped. */
  ensureAnalyzed: (entryId: string) => Promise<void>;
  /** Queue entries for background analysis (gentle, one at a time). Thin
   *  wrapper over the shared queue so existing callers keep working. */
  analyzeAll: (entryIds: string[]) => Promise<void>;
  /** Selector helper. */
  get: (entryId: string | null) => Entry | null;
}

// Shared single-consumer queue: every "analyze this" path (DJ-tab sweep,
// deck load, add-to-setlist/VJ) funnels here so analysis runs ONE track at a
// time — gentle on the backend's foreground analysis + a 6 GB machine — and
// never double-runs the same entry.
const _queue: string[] = [];
const _queued = new Set<string>();
let _processing = false;

async function _processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;
  try {
    while (_queue.length) {
      const id = _queue.shift()!;
      _queued.delete(id);
      const cur = useDjAnalysisStore.getState().byId[id];
      // Skip anything already resolved or in flight (don't re-hammer errors).
      if (cur && (cur.status === 'ready' || cur.status === 'running' || cur.status === 'error')) continue;
      await useDjAnalysisStore.getState().ensureAnalyzed(id);
      await new Promise((r) => setTimeout(r, 80));
    }
  } finally {
    _processing = false;
  }
}

/**
 * Queue one or more library entries for immediate background analysis. Safe to
 * call from anywhere (stores, buses) — null/dupe/already-analyzed ids are
 * dropped. This is what makes "anything added to DJ / VJ / a setlist gets
 * analyzed" hold without each call site spiking the backend.
 */
export function analyzeEntries(ids: Array<string | null | undefined>): void {
  for (const id of ids) {
    if (!id || _queued.has(id)) continue;
    const cur = useDjAnalysisStore.getState().byId[id];
    if (cur && (cur.status === 'ready' || cur.status === 'running')) continue;
    _queued.add(id);
    _queue.push(id);
  }
  void _processQueue();
}

function pickFields(raw: Record<string, unknown>): DjAnalysis {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    bpm: num(raw.bpm),
    key: typeof raw.key === 'string' ? raw.key : null,
    scale: typeof raw.scale === 'string' ? raw.scale : null,
    key_confidence: num(raw.key_confidence ?? raw.confidence),
    bars_estimated: num(raw.bars_estimated),
    rms_db: num(raw.rms_db),
    duration_sec: num(raw.duration_sec),
    beats: Array.isArray(raw.beats) ? (raw.beats as number[]) : null,
    analyzed_at: num(raw.analyzed_at),
  };
}

export const useDjAnalysisStore = create<DjAnalysisState>()((set, get) => ({
  byId: {},

  fetch: async (entryId) => {
    try {
      const r = await fetch(`/api/analysis/${entryId}`);
      if (!r.ok) {
        set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'error', data: null } } }));
        return;
      }
      const payload = (await r.json()) as Record<string, unknown> & { status?: string };
      if (payload.status === 'pending') {
        set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'pending', data: null } } }));
        return;
      }
      set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'ready', data: pickFields(payload) } } }));
    } catch (e) {
      logError('dj', `Analysis fetch failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
      set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'error', data: null } } }));
    }
  },

  ensureAnalyzed: async (entryId) => {
    const cur = get().byId[entryId];
    if (cur && (cur.status === 'ready' || cur.status === 'running')) return;

    // First see if it's already analyzed (cheap GET).
    await get().fetch(entryId);
    const after = get().byId[entryId];
    if (after?.status === 'ready') return;
    if (after?.status === 'error') return; // don't hammer a failing entry

    // Pending → run it (synchronous foreground analysis on the backend).
    set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'running', data: null } } }));
    try {
      const r = await fetch(`/api/analysis/${entryId}/run`, { method: 'POST' });
      if (!r.ok) {
        set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'error', data: null } } }));
        return;
      }
      const payload = (await r.json()) as Record<string, unknown>;
      set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'ready', data: pickFields(payload) } } }));
    } catch (e) {
      logError('dj', `Analysis run failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
      set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'error', data: null } } }));
    }
  },

  analyzeAll: async (entryIds) => { analyzeEntries(entryIds); },

  get: (entryId) => (entryId ? get().byId[entryId] ?? null : null),
}));
