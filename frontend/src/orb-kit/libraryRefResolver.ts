/**
 * Library reference resolver — resolves a single library entry by id
 * through the backend.
 *
 * The library holds on the order of 200,000 rows; the browser only ever
 * holds the page it is currently looking at. A reference the assistant
 * carries (a chip, a tool target) can no longer be found by scanning an
 * in-memory list, so this module asks the backend for exactly one row by
 * id. The id is the only authoritative identifier here — a title is
 * display-only and this module never looks anything up by it. A deleted
 * entry resolves to 'missing' so callers can refuse cleanly instead of
 * guessing from a stale in-memory row.
 *
 * In-flight fetches for the same (id, revision) are de-duplicated, and a
 * small LRU remembers the last LIBRARY_REF_CACHE_MAX settled answers.
 * 'unavailable' answers (a non-404 failure) are never cached, so a
 * transient failure does not stick around for the rest of the session.
 */

/** How a lookup resolved: found ('ok'), confirmed gone ('missing' — the
 *  backend answered 404), or undetermined ('unavailable' — a network or
 *  HTTP failure; never cached, so it is always safe to retry) — the id is
 *  authoritative; titles are display-only. */
export type LibraryRefStatus = 'ok' | 'missing' | 'unavailable';

/** A resolved library row, for reference display and tool targeting only.
 *  `id` is the authoritative identifier callers must key off of; `title`
 *  is display-only and must never be used to re-find or match the entry. */
export interface LibraryRefEntry {
  id: string;
  title: string;
  durationSec: number | null;
  source: string | null;
}

/** The outcome of resolving one library ref, discriminated on `status`.
 *  `id` is always the authoritative identifier that was looked up — never
 *  re-derive identity from `entry.title`, which is display-only. */
export type LibraryRefResolution =
  | { status: 'ok'; entry: LibraryRefEntry; revision: number }
  | { status: 'missing'; id: string }
  | { status: 'unavailable'; id: string; error: string };

/** Cap on settled (ok/missing) answers kept in the LRU. */
const LIBRARY_REF_CACHE_MAX = 64;

/** Settled ok/missing answers, keyed by `${id}@${revision ?? 0}`. Map
 *  insertion order doubles as recency order: touching a key deletes and
 *  re-sets it, so the least-recently-used entry is always the first one
 *  iteration yields. 'unavailable' answers are never stored here. */
const settledCache = new Map<string, LibraryRefResolution>();

/** In-flight requests keyed the same way as `settledCache`, so a second
 *  caller for the same (id, revision) while the first is still pending
 *  shares that request instead of firing a second fetch. */
const inFlightCache = new Map<string, Promise<LibraryRefResolution>>();

function cacheKey(id: string, revision?: number): string {
  return `${id}@${revision ?? 0}`;
}

/** Records a settled answer as most-recently-used, evicting the oldest
 *  entry once the cache grows past LIBRARY_REF_CACHE_MAX. */
function rememberSettled(key: string, value: LibraryRefResolution): void {
  settledCache.delete(key);
  settledCache.set(key, value);
  if (settledCache.size > LIBRARY_REF_CACHE_MAX) {
    const oldestKey = settledCache.keys().next().value;
    if (oldestKey !== undefined) settledCache.delete(oldestKey);
  }
}

/** Fetches one entry from the backend and turns the response into a
 *  LibraryRefResolution. The id is authoritative throughout — never look
 *  up by title, and never call the list route. */
async function fetchLibraryRef(id: string, revision: number | undefined): Promise<LibraryRefResolution> {
  let result: LibraryRefResolution;
  try {
    const res = await fetch(`/api/library/entries/${encodeURIComponent(id)}`);
    if (res.status === 200) {
      const json = await res.json();
      result = {
        status: 'ok',
        entry: {
          id: String(json.id ?? id),
          title: String(json.title ?? ''),
          durationSec:
            typeof json.durationSec === 'number'
              ? json.durationSec
              : typeof json.duration === 'number'
                ? json.duration
                : null,
          source: typeof json.source === 'string' ? json.source : null,
        },
        revision: typeof json.revision === 'number' ? json.revision : (revision ?? 0),
      };
    } else if (res.status === 404) {
      result = { status: 'missing', id };
    } else {
      result = { status: 'unavailable', id, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    result = { status: 'unavailable', id, error: err instanceof Error ? err.message : String(err) };
  }

  // 'unavailable' is deliberately never cached — a transient failure must
  // not stick around for the rest of the session.
  if (result.status !== 'unavailable') {
    rememberSettled(cacheKey(id, revision), result);
  }
  return result;
}

/**
 * Resolves one library entry by id through the backend. The id is
 * authoritative; this never looks anything up by title and never calls
 * the list route. A hit on the small LRU, or an identical in-flight
 * request, short-circuits the fetch; a 404 settles (and caches) as
 * 'missing'; any other failure resolves as 'unavailable' and is never
 * cached, so it is always safe to retry.
 */
export async function resolveLibraryRef(id: string, revision?: number): Promise<LibraryRefResolution> {
  const key = cacheKey(id, revision);

  const cached = settledCache.get(key);
  if (cached) {
    // Touch for recency: delete + re-set moves this key to the
    // most-recently-used end of the Map's iteration order.
    settledCache.delete(key);
    settledCache.set(key, cached);
    return cached;
  }

  const pending = inFlightCache.get(key);
  if (pending) return pending;

  const promise = fetchLibraryRef(id, revision).finally(() => {
    inFlightCache.delete(key);
  });
  inFlightCache.set(key, promise);
  return promise;
}

/**
 * Synchronous cache read only — no fetch, no promise. Returns a
 * previously settled answer for (id, revision), or null if nothing is
 * cached yet. For synchronous resolve paths that cannot await a fetch.
 * `id` is authoritative; the returned entry's `title` is display-only.
 */
export function peekLibraryRef(id: string, revision?: number): LibraryRefResolution | null {
  return settledCache.get(cacheKey(id, revision)) ?? null;
}

/**
 * Resolves every id (reusing the LRU and the in-flight de-dupe of
 * resolveLibraryRef) and returns all results in order. An empty list
 * resolves immediately with no fetch. Ids are authoritative; each
 * result's `entry.title` is display-only.
 */
export async function primeLibraryRefs(ids: string[], revision?: number): Promise<LibraryRefResolution[]> {
  if (ids.length === 0) return [];
  return Promise.all(ids.map((id) => resolveLibraryRef(id, revision)));
}

/**
 * Clears the settled-answer LRU and the in-flight map. Test-only: do not
 * call this from application code, which relies on the cache persisting
 * for the life of the page — the id is authoritative; titles are
 * display-only.
 */
export function clearLibraryRefCache(): void {
  settledCache.clear();
  inFlightCache.clear();
}
