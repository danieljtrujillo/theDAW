/**
 * Bounded, revision-aware cache for library entries looked up BY ID.
 *
 * The library can hold 200,000 rows, so nothing may keep a `Map` from id to
 * row for the whole thing: that is the exact mistake `libraryStore.ts`'s
 * sparse page cache exists to avoid, just for a different access pattern.
 * Plenty of callers only have an id — a lineage parent, a queue entry, a
 * search result outside the loaded window — and need that ONE row's title,
 * cover or duration without knowing, or caring, which page (if any) holds it.
 *
 * This generalises the ad-hoc `byId` / `byIdInFlight` / `byIdMissing` module
 * maps `libraryStore.ts` already keeps (see there, and its `ensureEntry`)
 * into a standalone module any caller can use without depending on the paged
 * store.
 *
 * Pins: at most `MAX_CACHED_ENTRIES` rows are ever held, least-recently-used
 * first — the same convention as `pagedRows.ts`'s page order; a 404 is
 * remembered so the same missing id is never asked for twice; concurrent
 * lookups for one id share a single fetch. Pure bookkeeping — no fetch of its
 * own beyond the injected `EntryFetcher`, no React, no Zustand, no DOM.
 */

import type { LibraryEntry } from '../state/libraryEntry';
import { logError } from '../state/logStore';
import { fetchLibraryEntry } from './backendLocalProvider';

/** How many entries the cache keeps. Each row is a small metadata record, not audio. */
export const MAX_CACHED_ENTRIES = 2000;

/** Resolves one entry by id, or null when it does not exist. Injected so tests never touch the network. */
export type EntryFetcher = (id: string, signal?: AbortSignal) => Promise<LibraryEntry | null>;

/** id → row. */
const cache = new Map<string, LibraryEntry>();
/** LRU order, least-recently-used first. Never mutated in place — see `touchId`. */
let lruOrder: string[] = [];
/** id → the request currently fetching it, so concurrent callers share one fetch. */
const inFlight = new Map<string, Promise<LibraryEntry | null>>();
/** Ids the server answered 404 for; asking again would loop forever. */
const missing = new Set<string>();
/** The last revision seen. 0 means none yet — real revisions are positive integers. */
let revision = 0;
/** The function a cache miss calls. Swappable via `setEntryFetcher` for tests. */
let fetcher: EntryFetcher = fetchLibraryEntry;

/** `order` with `id` moved to the most-recent end. Never mutates `order`. */
const touchId = (order: readonly string[], id: string): string[] => {
  const out = order.filter((existing) => existing !== id);
  out.push(id);
  return out;
};

/** Drop least-recently-used ids until at most MAX_CACHED_ENTRIES remain. */
const evictOverflow = (): void => {
  while (lruOrder.length > MAX_CACHED_ENTRIES) {
    const victim = lruOrder[0];
    lruOrder = lruOrder.slice(1);
    cache.delete(victim);
  }
};

/**
 * Synchronous cache hit only. Touches recency on a hit so a caller that reads
 * through this function alone still keeps its hot ids from being evicted.
 * Never fetches — use `getEntry` for that.
 */
export function getCachedEntry(id: string): LibraryEntry | undefined {
  const hit = cache.get(id);
  if (hit) lruOrder = touchId(lruOrder, id);
  return hit;
}

/**
 * One entry by id: a cache hit resolves immediately, a previously-404'd id
 * resolves `null` without a request, and concurrent callers for the same id
 * share one fetch. Mirrors `libraryStore.ts`'s `ensureEntry`.
 *
 * The revision this lookup started under is captured before the fetch goes
 * out. If `setLibraryRevision` invalidates the cache while the fetch is still
 * in flight, the result is stale for the library as it now stands, so it is
 * not written into the cache or the missing set on arrival — the caller who
 * asked still gets what they asked for, but nothing pollutes the fresh cache.
 */
export function getEntry(id: string): Promise<LibraryEntry | null> {
  const hit = getCachedEntry(id);
  if (hit) return Promise.resolve(hit);
  if (missing.has(id)) return Promise.resolve(null);
  const running = inFlight.get(id);
  if (running) return running;

  const startedRevision = revision;
  const run = fetcher(id)
    .then((entry) => {
      if (revision !== startedRevision) return entry;
      if (entry) {
        putEntry(entry);
      } else {
        missing.add(id);
      }
      return entry;
    })
    .catch((e: unknown) => {
      logError('library', `entry ${id.slice(0, 8)} lookup failed: ${String(e)}`);
      return null;
    })
    .finally(() => {
      inFlight.delete(id);
    });
  inFlight.set(id, run);
  return run;
}

/**
 * Bump the known library revision. A greater positive integer means the
 * library changed under us, so every cached row, its LRU order and the 404
 * set are dropped — a lookup after this re-fetches instead of answering with
 * data from before the change. In-flight requests are left running: whatever
 * they resolve to is either still correct for the new revision, or lands as
 * an ordinary `putEntry` write into the now-empty cache. A smaller or equal
 * revision is old news and does nothing.
 */
export function setLibraryRevision(nextRevision: number): void {
  if (!Number.isInteger(nextRevision) || nextRevision <= 0) return;
  if (nextRevision <= revision) return;
  cache.clear();
  lruOrder = [];
  missing.clear();
  revision = nextRevision;
}

/** Insert or replace `entry`, marking it most-recently-used and clearing any 404 mark for its id. */
export function putEntry(entry: LibraryEntry): void {
  cache.set(entry.id, entry);
  lruOrder = touchId(lruOrder, entry.id);
  missing.delete(entry.id);
  evictOverflow();
}

/** Drop `ids` from the cache, the LRU order and the missing set. */
export function forgetEntries(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  for (const id of drop) {
    cache.delete(id);
    missing.delete(id);
  }
  lruOrder = lruOrder.filter((id) => !drop.has(id));
}

/** Clear everything, including the revision and any in-flight requests. For tests and provider swaps. */
export function resetLibraryEntryCache(): void {
  cache.clear();
  lruOrder = [];
  inFlight.clear();
  missing.clear();
  revision = 0;
}

/**
 * Dependency-injection seam: swap the function `getEntry` calls on a cache
 * miss, so tests never touch the network. `null` restores the default,
 * `fetchLibraryEntry` against the backend.
 */
export function setEntryFetcher(next: EntryFetcher | null): void {
  fetcher = next ?? fetchLibraryEntry;
}

/** Cache sizes and the known revision, for tests and debugging only. */
export function cacheStats(): { size: number; missing: number; inFlight: number; revision: number } {
  return {
    size: cache.size,
    missing: missing.size,
    inFlight: inFlight.size,
    revision,
  };
}
