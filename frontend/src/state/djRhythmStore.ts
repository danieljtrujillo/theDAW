/**
 * djRhythmStore — downbeats for the DJ tab, read-only and cheap.
 *
 * The rhythm module (`backend/modules/rhythm`) already knows where the bar
 * lines are: `GET /api/rhythm/{id}` returns a cached analysis with
 * `downbeats`, and `POST /api/rhythm/{id}/run` computes one. TrackInfo, the
 * Rhythm block and `lib/rhythmSeed` all read it. The DJ tab never did, so its
 * beatgrid drew a bar line every fourth beat (`i % 4 === 0` — wrong the
 * instant a track has a pickup or is not in 4/4) and cue seeding had nothing
 * but a flat beat list to work from.
 *
 * Two rules make this safe to call on every deck load:
 *
 *   1. **GET only.** A cache miss answers `200 {status: 'pending'}` and we
 *      stop there. `/run` decodes and re-analyzes the whole file; firing that
 *      from a deck load would stall the DJ tab behind a minute of CPU for
 *      data it only uses as a nicety. Cue seeding falls back to plain beats,
 *      and if the user later analyzes the track elsewhere the rhythm lands
 *      here on the next load.
 *   2. **One request per entry per session.** Results — including misses and
 *      failures — are remembered, so a deck that reloads the same track does
 *      not re-ask. Not persisted: the cache it mirrors lives on disk and can
 *      change between sessions.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

export interface DjRhythm {
  /** True when the backend had a finished analysis cached. */
  ready: boolean;
  /** Bar starts in seconds, or null when there are none to be had. */
  downbeats: number[] | null;
  /** Bar start times in seconds, taken from the payload's `bars`. The engine
   *  writes that as a list of objects (`{index, segment, start_sec, end_sec,
   *  beats, time_signature, syncopation}` — see
   *  `backend/modules/rhythm/engine.py`), so only `start_sec` is kept here. */
  bars: number[] | null;
  /** When this entry was last asked about. Only set on a MISS, which is the
   *  only result that is allowed to go stale. */
  checkedAt?: number;
}

interface DjRhythmState {
  byEntry: Record<string, DjRhythm>;
  /** Bumped per entry by `invalidateRhythm`. A deck watches its entry's
   *  number (see `useDeckRhythm`) so it asks again even when there was
   *  nothing in `byEntry` to delete: an invalidation that retires a GET still
   *  on the wire leaves `byEntry[id]` undefined before and after. */
  revision: Record<string, number>;
  /** What is already known about an entry; never fetches. */
  rhythmFor: (entryId: string | null) => DjRhythm | null;
  /** Fetch once (GET only) and remember. Resolves null when there is
   *  nothing usable — the caller seeds from plain beats in that case. */
  ensureRhythm: (entryId: string) => Promise<DjRhythm | null>;
}

/** In-flight requests, so three decks asking at once make one request. */
const inflight = new Map<string, Promise<DjRhythm | null>>();

/** Bumped by `invalidateRhythm`. A run carries the generation it started in
 *  and writes nothing once that number has moved: the answer it is holding
 *  was computed before the cache changed, so storing it would quietly undo
 *  the invalidation the caller just asked for. */
const generation = new Map<string, number>();

/** Keep only finite, non-negative times; `null` when nothing survives.
 *  Two shapes arrive here: `downbeats` is a flat list of seconds, while
 *  `bars` is a list of bar OBJECTS carrying `start_sec` (see `DjRhythm.bars`
 *  and `backend/modules/rhythm/engine.py`). Reading only numbers threw every
 *  real bar away, so `bars` was null in production however good the cache. */
function times(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    const t =
      typeof item === 'number'
        ? item
        : (item as { start_sec?: unknown } | null)?.start_sec;
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) out.push(t);
  }
  return out.length > 0 ? out : null;
}

/** How long a miss (pending cache, 404, 500, offline) is believed before the
 *  next deck load asks again. The backend cache lives on disk and anything
 *  else in the app — TrackInfo, the Rhythm block, `lib/rhythmSeed` — can fill
 *  it while the DJ tab is open, so remembering a miss for the whole session
 *  meant a track analyzed two minutes ago still drew its grid off `i % 4`. */
export const RHYTHM_MISS_TTL_MS = 30_000;

const miss = (): DjRhythm => ({ ready: false, downbeats: null, bars: null, checkedAt: Date.now() });

export const useDjRhythmStore = create<DjRhythmState>()((set, get) => ({
  byEntry: {},
  revision: {},
  rhythmFor: (entryId) => (entryId ? get().byEntry[entryId] ?? null : null),
  ensureRhythm: async (entryId) => {
    if (!entryId) return null;
    const known = get().byEntry[entryId];
    // A ready result is final. A miss is only believed for its window: see
    // RHYTHM_MISS_TTL_MS.
    if (known?.ready) return known;
    if (known && Date.now() - (known.checkedAt ?? 0) < RHYTHM_MISS_TTL_MS) return null;
    const pending = inflight.get(entryId);
    if (pending) return pending;

    const gen = generation.get(entryId) ?? 0;
    /** Still the run the store cares about? False once invalidated. */
    const current = () => (generation.get(entryId) ?? 0) === gen;

    const run = (async (): Promise<DjRhythm | null> => {
      try {
        const res = await fetch(`/api/rhythm/${encodeURIComponent(entryId)}`);
        if (!res.ok) {
          // Remember the failure: a 404 (no such entry) or a 500 will not
          // start working on the next deck load, and retrying on every load
          // would be a request per track per reload.
          if (current()) set((s) => ({ byEntry: { ...s.byEntry, [entryId]: miss() } }));
          return null;
        }
        const body = (await res.json()) as { status?: string; downbeats?: unknown; bars?: unknown };
        // A cache miss stops here on purpose — see the header. No `/run`.
        if (body?.status !== 'ready') {
          if (current()) set((s) => ({ byEntry: { ...s.byEntry, [entryId]: miss() } }));
          return null;
        }
        const data: DjRhythm = {
          ready: true,
          downbeats: times(body.downbeats),
          bars: times(body.bars),
        };
        if (!current()) return null;
        set((s) => ({ byEntry: { ...s.byEntry, [entryId]: data } }));
        return data;
      } catch {
        // Backend still warming, or offline. Same as a miss: the DJ path
        // has a working fallback and must never surface this.
        if (current()) set((s) => ({ byEntry: { ...s.byEntry, [entryId]: miss() } }));
        return null;
      } finally {
        // Only if this run is still the registered one — an invalidation may
        // already have cleared the slot and a newer fetch taken it.
        if (current()) inflight.delete(entryId);
      }
    })();
    inflight.set(entryId, run);
    return run;
  },
}));

/** Forget what is known about one entry, so the next `ensureRhythm` asks the
 *  backend again, and tell a deck holding it to ask now. For the caller that
 *  has just made the cache change — a finished `/run` elsewhere in the app,
 *  or a re-analysis — and does not want to wait out `RHYTHM_MISS_TTL_MS`.
 *  Leaves every other entry's data alone, so it is always safe to call. */
export function invalidateRhythm(entryId: string): void {
  if (!entryId) return;
  // Retire any run that is already out on the wire BEFORE forgetting the
  // entry: its result describes the cache as it was a moment ago, and it
  // would otherwise land after this call and restore what was forgotten.
  generation.set(entryId, (generation.get(entryId) ?? 0) + 1);
  inflight.delete(entryId);
  useDjRhythmStore.setState((s) => {
    const revision = { ...s.revision, [entryId]: (s.revision[entryId] ?? 0) + 1 };
    if (!(entryId in s.byEntry)) return { revision };
    const next = { ...s.byEntry };
    delete next[entryId];
    return { byEntry: next, revision };
  }, false);
}

/** The rhythm a loaded deck draws its bar lines and cues from.
 *
 *  Cheap GET only: a cache miss is left alone, because `/run` is a full
 *  re-analysis and has no business firing because a deck loaded. Asks when
 *  the entry loads and again whenever `invalidateRhythm` names it, so a
 *  finished rhythm run elsewhere in the app reaches the deck at once. That
 *  includes a run that lands while the deck's own GET is still out: the
 *  retired GET stores nothing, `byEntry` never changes, and only the
 *  revision tells the deck to ask again. */
export function useDeckRhythm(entryId: string | null): DjRhythm | undefined {
  const ensureRhythm = useDjRhythmStore((s) => s.ensureRhythm);
  const rhythm = useDjRhythmStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const revision = useDjRhythmStore((s) => (entryId ? s.revision[entryId] ?? 0 : 0));
  useEffect(() => {
    // `ensureRhythm` honours the miss window, so a remembered miss is not
    // asked about again until it goes stale.
    if (entryId && !rhythm?.ready) void ensureRhythm(entryId);
  }, [entryId, rhythm, revision, ensureRhythm]);
  return rhythm;
}
