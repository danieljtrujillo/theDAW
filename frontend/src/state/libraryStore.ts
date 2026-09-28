/**
 * Zustand store wrapping the active StorageProvider.
 *
 * The provider is the source of truth — this store is just an in-memory
 * cache + React-reactive surface. No IndexedDB, no Cache API, no blob
 * lifetimes: all of that moved to the backend. The local-dev default
 * provider talks to `/api/library/*` and stores audio on disk.
 *
 * ── Paging ────────────────────────────────────────────────────────────────
 * A library of 200,000 entries cannot live in memory, so the store holds a
 * SPARSE cache: fixed-size pages of `LIBRARY_PAGE_SIZE` rows, an LRU of at most
 * `MAX_CACHED_PAGES` of them, and the server's `total` for everything it has
 * not fetched. Search, favourites, source and sort are sent to the backend as
 * query parameters — the store never filters 200,000 rows in the browser.
 *
 *   `entryAt(index)`  the row at a GLOBAL index into the current result set,
 *                     or undefined while its page is still coming;
 *   `entries`         every row currently loaded, IN RESULT ORDER. This is the
 *                     field every other consumer of the store already reads
 *                     ("the entries I can see"), and it keeps that meaning;
 *   `total`           how many rows match the query, loaded or not;
 *   `getById(id)`     an id lookup that works for rows on no loaded page: it
 *                     falls back to a cached single-entry fetch.
 *
 * Against a backend that predates the paged endpoint the probe request comes
 * back as the whole library; the store then keeps every row, filters and sorts
 * them here, and everything above still answers the same way.
 */

import { create } from 'zustand';
import { logError, logInfo } from './logStore';
import { useLibraryCounts } from './libraryCountsStore';
import type { LibraryEntry, LibraryEntryPatch, ImportRequest } from './libraryEntry';
import {
  DEFAULT_LIBRARY_QUERY,
  LIBRARY_PAGE_SIZE,
  LibraryIdCapError,
  bulkDeleteLibraryEntries,
  fetchLibraryEntry,
  fetchLibraryFacets,
  fetchLibraryIds,
  fetchLibraryList,
  getStorageProvider,
  type LibraryBulkDeleteRequest,
  type LibraryBulkDeleteResult,
  type LibraryQuery,
  type LibraryServerSort,
} from '../lib/backendLocalProvider';
import { LibraryOpeningError, type LibrarySearchCoverage } from '../lib/libraryIndexStatus';
import {
  facetCacheKey,
  type LibraryFacetField,
  type LibraryFacets,
} from '../lib/libraryFacets';
import { hasProvider } from '../lib/providerLabel';
import { entryMatchesSearch } from '../lib/librarySearchMatch';
import {
  firstIndexOfPage,
  missingPages,
  offsetInPage,
  pageOfIndex,
  pagesForRange,
  pagesToEvict,
  touchPage,
} from '../lib/pagedRows';
import { sortEntriesBy, type LibrarySortBy } from '../lib/libraryRows';

export type { LibraryEntry, LibraryEntryPatch, ImportRequest } from './libraryEntry';
export { LIBRARY_PAGE_SIZE, LibraryIdCapError } from '../lib/backendLocalProvider';

/** How many pages the LRU holds — 30 × 200 = 6,000 rows, ~a few MB. */
const MAX_CACHED_PAGES = 30;

/** A keystroke is not a query: the search box waits this long before asking. */
export const SEARCH_DEBOUNCE_MS = 200;

/** The library's own sort names, as the backend spells them. */
const SERVER_SORT: Record<LibrarySortBy, LibraryServerSort> = {
  newest: 'created_desc',
  oldest: 'created_asc',
  duration: 'duration_desc',
  title: 'title_asc',
  plays: 'plays_desc',
};

export interface LibraryState {
  /** Every row currently loaded, in the current query's order. */
  entries: LibraryEntry[];
  loaded: boolean;
  loading: boolean;
  searchQuery: string;
  onlyFavorites: boolean;
  /** One of the library's sort orders; `sortEntriesBy` applies it. */
  sortBy: LibrarySortBy;
  /** Media kind the list is over: 'audio' (default), 'media', 'all', … */
  kindFilter: string;
  /** 'generate' | 'studio' | 'import', or null for every source. */
  sourceFilter: string | null;
  /**
   * A provider id ('suno', 'stable-audio', …), or null for every provider.
   * The id is `inferProvider`'s: the slug the backend detected in the file's
   * own metadata, or the model/source derivation when it detected none. Sent
   * to the backend as `provider=`, so it filters the WHOLE library rather than
   * the rows already loaded. Orthogonal to `sourceFilter`.
   */
  providerFilter: string | null;
  playingId: string | null;
  selectedEntryId: string | null;

  /** Rows matching the current query, loaded or not. */
  total: number;
  /** The `library_revision` the page cache was read at; 0 before any page. */
  revision: number;
  /** False once a backend has proved it does not understand `limit`. */
  paged: boolean;
  /** Page requests in flight — drives the list's loading bar. */
  pagesLoading: number;
  /** The last page failure, or null. The list shows it with a retry. */
  pageError: string | null;
  /**
   * True while the backend answers the list with 503 because it is still
   * opening the library (a schema upgrade). The list shows the progress bar
   * rather than an error, and fetches again once the library is ready.
   */
  libraryOpening: boolean;
  /**
   * The last searched page's `search_index`: `complete: false` while the
   * search index is still being built, when a search covers the indexed
   * entries only. Null for an unsearched list.
   */
  searchIndex: LibrarySearchCoverage | null;
  /** Bumped when a single-entry lookup lands, so a view can re-read it. */
  lookupVersion: number;

  /** The distinct values of each requested field over the WHOLE result set. */
  facets: LibraryFacets;
  /** False once a backend has proved it has no facets route. */
  facetsSupported: boolean;
  /** False once a backend has proved it has no bulk-delete route. */
  bulkDeleteSupported: boolean;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Add an entry that's already been persisted server-side (e.g. just
   * fetched a single record by id). Inserts at the head if new. */
  upsertEntry: (entry: LibraryEntry) => void;
  /** Upload a blob via the active provider. */
  importEntry: (req: ImportRequest) => Promise<LibraryEntry>;
  removeEntry: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<{ deleted: number; failed: number }>;
  clearAll: () => Promise<{ deleted: number; failed: number }>;
  updateEntry: (id: string, updates: LibraryEntryPatch) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  setRating: (id: string, rating: 'like' | 'dislike' | null) => Promise<void>;
  setSearchQuery: (q: string) => void;
  setOnlyFavorites: (v: boolean) => void;
  setSortBy: (s: LibraryState['sortBy']) => void;
  setKindFilter: (kind: string) => void;
  setSourceFilter: (source: string | null) => void;
  setProviderFilter: (provider: string | null) => void;
  setPlayingId: (id: string | null) => void;
  setSelectedEntry: (id: string | null) => void;
  /** Count a play for an entry: optimistic local bump + persist server-side. */
  registerPlay: (id: string) => void;
  getAudioUrl: (entry: LibraryEntry) => string;
  fetchAudioBlob: (entry: LibraryEntry) => Promise<Blob>;
  getFiltered: () => LibraryEntry[];

  /** The filter/sort state as the backend takes it. */
  getQuery: () => LibraryQuery;
  /** Make sure the rows for the inclusive index range are loaded (or coming). */
  ensureRange: (start: number, end: number) => Promise<void>;
  /** The row at a global index, or undefined while its page is still coming. */
  entryAt: (index: number) => LibraryEntry | undefined;
  /** A cached row by id; kicks a single-entry fetch when it is on no page. */
  getById: (id: string) => LibraryEntry | undefined;
  /** The full record for `id` (with full lyrics), fetched once and cached. */
  ensureEntry: (id: string) => Promise<LibraryEntry | null>;
  /**
   * Every id matching the current filters. Throws `LibraryIdCapError`.
   * `partial` is for the callers that follow the list on screen (play the
   * list, a shift-click range, revealing a track): while the search index is
   * still being built they get the matches the list shows. Without it
   * (select-all) a search then throws `LibrarySearchIndexBuildingError`.
   */
  listFilteredIds: (options?: { partial?: boolean }) => Promise<string[]>;
  /** Load `fields`' facets for the current query, or answer from the cache. */
  ensureFacets: (fields: readonly LibraryFacetField[]) => Promise<void>;
  /**
   * Delete many entries in ONE request: `{ids}`, or `{filter, confirmTotal}`
   * for rows nobody has loaded. Null when the backend has no bulk route.
   * Throws `LibraryBulkConflictError` when the server re-counts a filter and
   * gets a different number — nothing is deleted in that case.
   */
  bulkDelete: (req: LibraryBulkDeleteRequest) => Promise<LibraryBulkDeleteResult | null>;
  /** Drop every cached page; the visible range is fetched again. */
  invalidatePages: () => void;
  /** Clear the error and fetch the visible range again. */
  retryPages: () => Promise<void>;
  /** Forget everything paging-related (provider swap, tests). */
  resetPaging: () => void;
}

/* ───────────────────────── paging plumbing (module state) ─────────────────────
 * None of this is state a component renders, so it lives beside the store the
 * way libraryCountsStore keeps its sequence numbers: `entries` is the rendered
 * projection of the cache, and changing it is what notifies React.
 */

/** page number → that page's rows. */
const pageCache = new Map<number, LibraryEntry[]>();
/** LRU order, least-recently-used first. */
let lruOrder: number[] = [];
/** page number → the request currently fetching it. */
const inFlight = new Map<number, Promise<void>>();
/** page number → its abort handle, so a dead query stops using the network. */
const controllers = new Map<number, AbortController>();
/** Bumped by every query change; an answer from an older one is dropped. */
let querySeq = 0;
/** The row range the list last reported; pages covering it are never evicted. */
let visibleStart = 0;
let visibleEnd = LIBRARY_PAGE_SIZE - 1;
/** id → row, over the loaded pages. Rebuilt with `entries`. */
let idIndex = new Map<string, LibraryEntry>();
/** Rows fetched one at a time because they were on no loaded page. */
const byId = new Map<string, LibraryEntry>();
const byIdInFlight = new Map<string, Promise<LibraryEntry | null>>();
/** Ids the server answered 404 for; asking again would loop forever. */
const byIdMissing = new Set<string>();
/** Every row, when the backend has no paging. null in paged mode. */
let allRows: LibraryEntry[] | null = null;
/** Mutations this store made itself, whose revision bump is not news. */
let localMutations = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Facet answers, keyed by (fields, query, revision) — see `facetCacheKey`.
 * Re-opening a dropdown, or switching back to a filter you already used, is
 * free; a new revision is a new key, so a stale count can never be shown.
 */
const facetCache = new Map<string, LibraryFacets>();
/** In-flight facet requests, so two dropdowns opening at once ask once. */
const facetsInFlight = new Map<string, Promise<void>>();
/** How many facet answers the cache keeps. Each is a few hundred small rows. */
const MAX_CACHED_FACETS = 8;

const clearPages = (): void => {
  for (const ctrl of controllers.values()) ctrl.abort();
  controllers.clear();
  inFlight.clear();
  pageCache.clear();
  lruOrder = [];
};

/** The pages backing the range the list is showing right now. */
const visiblePages = (): Set<number> =>
  new Set(pagesForRange(visibleStart, Math.max(visibleStart, visibleEnd), LIBRARY_PAGE_SIZE));

/** Every loaded row in page order, plus the id index over them. */
const projectRows = (): LibraryEntry[] => {
  const pages = [...pageCache.keys()].sort((a, b) => a - b);
  const rows: LibraryEntry[] = [];
  const index = new Map<string, LibraryEntry>();
  for (const page of pages) {
    for (const row of pageCache.get(page) ?? []) {
      rows.push(row);
      index.set(row.id, row);
    }
  }
  idIndex = index;
  return rows;
};

/**
 * The client-side filter + sort. Only an UNPAGED backend needs it: when the
 * server pages, the server has already applied all of this.
 */
const applyClientQuery = (rows: readonly LibraryEntry[], state: LibraryState): LibraryEntry[] => {
  let filtered = [...rows];
  if (state.onlyFavorites) filtered = filtered.filter((e) => e.favorite);
  if (state.sourceFilter) filtered = filtered.filter((e) => e.source === state.sourceFilter);
  // The provider filter is normally applied by the server; an UNPAGED backend
  // has no such filter, so it is re-applied here for exactly the same reason
  // the source filter above is.
  if (state.providerFilter) filtered = filtered.filter((e) => hasProvider(e, state.providerFilter));
  const query = state.searchQuery.trim();
  if (query) filtered = filtered.filter((e) => entryMatchesSearch(e, query));
  // The one comparator, shared with the DETAILS tab's library pane so the
  // two lists can never disagree about what "newest" means.
  return sortEntriesBy(filtered, state.sortBy);
};

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /** Put the whole library in hand: the backend has no paging. */
  const adoptFullLibrary = (rows: LibraryEntry[]): void => {
    allRows = rows;
    rebuildUnpaged(rows);
  };

  /** Re-chunk the full library through the client filter into the cache. */
  const rebuildUnpaged = (rows: readonly LibraryEntry[]): void => {
    const filtered = applyClientQuery(rows, get());
    clearPages();
    for (let page = 0; page * LIBRARY_PAGE_SIZE < filtered.length; page += 1) {
      const from = firstIndexOfPage(page, LIBRARY_PAGE_SIZE);
      pageCache.set(page, filtered.slice(from, from + LIBRARY_PAGE_SIZE));
      lruOrder.push(page);
    }
    idIndex = new Map(filtered.map((e) => [e.id, e]));
    set({
      entries: filtered,
      total: filtered.length,
      paged: false,
      pageError: null,
      loaded: true,
    });
  };

  /** Fold one fetched page into the cache and re-project `entries`. */
  const applyPage = (
    page: number,
    rows: LibraryEntry[],
    total: number,
    revision: number,
  ): void => {
    const known = get().revision;
    if (revision > 0 && known > 0 && revision > known) {
      // The library moved under us mid-scroll: every other page is stale.
      clearPages();
    }
    pageCache.set(page, rows);
    lruOrder = touchPage(lruOrder, page);
    for (const dead of pagesToEvict(lruOrder, MAX_CACHED_PAGES, visiblePages())) {
      pageCache.delete(dead);
      lruOrder = lruOrder.filter((p) => p !== dead);
    }
    set({
      entries: projectRows(),
      total,
      revision: revision > 0 ? revision : get().revision,
      paged: true,
      pageError: null,
    });
  };

  const fetchPage = (page: number, seq: number): Promise<void> => {
    const ctrl = new AbortController();
    controllers.set(page, ctrl);
    set({ pagesLoading: get().pagesLoading + 1 });
    const run = (async () => {
      try {
        const result = await fetchLibraryList(
          get().getQuery(),
          firstIndexOfPage(page, LIBRARY_PAGE_SIZE),
          LIBRARY_PAGE_SIZE,
          ctrl.signal,
        );
        if (seq !== querySeq) return; // a newer query already owns the screen
        if (result.paged && result.page) {
          applyPage(page, result.page.entries, result.page.total, result.page.revision);
          set({ libraryOpening: false, searchIndex: result.page.searchIndex ?? null });
        } else {
          adoptFullLibrary(result.entries ?? []);
          set({ libraryOpening: false, searchIndex: null });
        }
      } catch (e) {
        if (seq !== querySeq || ctrl.signal.aborted) return;
        if (e instanceof LibraryOpeningError) {
          // Not a failure: the backend is still upgrading the library, and
          // the LIBRARY tab's progress bar says how far it has got. The
          // visible range is fetched again when it reports `ready`.
          if (!get().libraryOpening) {
            logInfo('library', `${e.status.label || 'The library is opening'}; the list loads when it finishes`);
          }
          set({ libraryOpening: true, pageError: null });
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        set({ pageError: msg });
        logError('library', `page ${page} failed: ${msg}`);
      } finally {
        controllers.delete(page);
        inFlight.delete(page);
        set({ pagesLoading: Math.max(0, get().pagesLoading - 1) });
      }
    })();
    inFlight.set(page, run);
    return run;
  };

  /** Fetch whatever the inclusive range needs, and await what is already out. */
  const ensurePages = (start: number, end: number): Promise<void> => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) return Promise.resolve();
    const total = get().total;
    const last = total > 0 ? Math.min(Math.max(end, start), total - 1) : Math.max(end, start);
    const wanted = pagesForRange(start, last, LIBRARY_PAGE_SIZE);
    // An unpaged library is entirely in hand; there is nothing to fetch.
    if (!get().paged) return Promise.resolve();
    const seq = querySeq;
    const pending: Promise<void>[] = [];
    for (const page of missingPages(wanted, new Set(pageCache.keys()))) {
      pending.push(inFlight.get(page) ?? fetchPage(page, seq));
    }
    for (const page of wanted) {
      const running = inFlight.get(page);
      if (running) pending.push(running);
    }
    // Loaded pages the user is looking at stay the most-recently used.
    for (const page of wanted) {
      if (pageCache.has(page)) lruOrder = touchPage(lruOrder, page);
    }
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : Promise.resolve();
  };

  /** The query changed: nothing cached is about it any more. */
  const applyQueryChange = (): void => {
    querySeq += 1;
    if (allRows) {
      rebuildUnpaged(allRows);
      return;
    }
    clearPages();
    idIndex = new Map();
    set({ entries: [], total: 0, pageError: null });
    void ensurePages(visibleStart, visibleEnd);
  };

  /** Replace a row wherever it is cached, without disturbing the order. */
  const patchCachedEntry = (entry: LibraryEntry): void => {
    let touched = false;
    for (const [page, rows] of pageCache) {
      const at = rows.findIndex((r) => r.id === entry.id);
      if (at === -1) continue;
      const next = rows.slice();
      next[at] = entry;
      pageCache.set(page, next);
      touched = true;
    }
    if (byId.has(entry.id)) byId.set(entry.id, entry);
    if (allRows) {
      const at = allRows.findIndex((r) => r.id === entry.id);
      if (at >= 0) allRows[at] = entry;
    }
    if (!touched) return;
    set({ entries: projectRows() });
  };

  /** Forget a row. In paged mode the rows after it have all shifted up. */
  const dropCachedEntries = (ids: readonly string[]): void => {
    for (const id of ids) {
      byId.delete(id);
      byIdMissing.delete(id);
    }
    const gone = new Set(ids);
    if (allRows) {
      allRows = allRows.filter((e) => !gone.has(e.id));
      rebuildUnpaged(allRows);
      return;
    }
    // Every index after the first deletion moved, so the cache is no longer
    // aligned with the server. Drop it and refetch what is on screen.
    const removed = get().entries.filter((e) => gone.has(e.id)).length;
    clearPages();
    idIndex = new Map();
    querySeq += 1;
    set({ entries: [], total: Math.max(0, get().total - removed) });
    void ensurePages(visibleStart, visibleEnd);
  };

  return {
    entries: [],
    loaded: false,
    loading: false,
    searchQuery: '',
    onlyFavorites: false,
    sortBy: 'newest',
    kindFilter: DEFAULT_LIBRARY_QUERY.kind,
    sourceFilter: null,
    providerFilter: null,
    playingId: null,
    selectedEntryId: null,

    total: 0,
    revision: 0,
    paged: true,
    pagesLoading: 0,
    pageError: null,
    libraryOpening: false,
    searchIndex: null,
    lookupVersion: 0,
    facets: {},
    facetsSupported: true,
    bulkDeleteSupported: true,

    getQuery: () => {
      const s = get();
      return {
        q: s.searchQuery,
        sort: SERVER_SORT[s.sortBy] ?? 'created_desc',
        kind: s.kindFilter || 'audio',
        favorite: s.onlyFavorites ? true : null,
        source: s.sourceFilter,
        provider: s.providerFilter,
      };
    },

    load: async () => {
      if (get().loading) return;
      set({ loading: true, pageError: null });
      try {
        querySeq += 1;
        allRows = null;
        clearPages();
        idIndex = new Map();
        set({ entries: [], paged: true });
        await ensurePages(visibleStart, visibleEnd);
        set({ loaded: true, loading: false });
        const s = get();
        // While the backend is still opening the library the page was refused
        // (fetchPage logged that); "ready: 0 entries" would be untrue.
        if (!s.libraryOpening) {
          logInfo(
            'library',
            s.paged
              ? `Library ready: ${s.total} entries, ${s.entries.length} loaded (paged)`
              : `Loaded ${s.entries.length} entries from ${getStorageProvider().name}`,
          );
        }
      } catch (e) {
        set({ loading: false });
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError('library', `Failed to load entries: ${msg}`);
      }
      // The category counts are part of "the library is loaded": the shell boots
      // the library through this path, so the tab strip gets every count here
      // rather than only when a sub-tab is first visited. Independent of the
      // entries fetch above — the counts are worth having even if that failed.
      useLibraryCounts.getState().invalidate();
    },

    refresh: async () => {
      try {
        querySeq += 1;
        allRows = null;
        clearPages();
        idIndex = new Map();
        byId.clear();
        byIdMissing.clear();
        // Re-probe: `paged` false would make `ensurePages` a no-op, and
        // dropping `allRows` just above left nothing else to render from.
        set({ paged: true });
        await ensurePages(visibleStart, visibleEnd);
        set({ loaded: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError('library', `refresh failed: ${msg}`);
      }
      useLibraryCounts.getState().invalidate();
    },

    ensureRange: (start, end) => {
      visibleStart = Math.max(0, Math.floor(start));
      visibleEnd = Math.max(visibleStart, Math.floor(end));
      return ensurePages(visibleStart, visibleEnd);
    },

    entryAt: (index) => {
      if (!Number.isInteger(index) || index < 0) return undefined;
      const rows = pageCache.get(pageOfIndex(index, LIBRARY_PAGE_SIZE));
      return rows ? rows[offsetInPage(index, LIBRARY_PAGE_SIZE)] : undefined;
    },

    getById: (id) => {
      const hit = idIndex.get(id) ?? byId.get(id);
      if (hit) return hit;
      // Not on a loaded page: ask for it once, so the next render has it.
      if (!byIdMissing.has(id) && !byIdInFlight.has(id)) void get().ensureEntry(id);
      return undefined;
    },

    ensureEntry: (id) => {
      const hit = idIndex.get(id) ?? byId.get(id);
      if (hit) return Promise.resolve(hit);
      if (byIdMissing.has(id)) return Promise.resolve(null);
      const running = byIdInFlight.get(id);
      if (running) return running;
      const run = fetchLibraryEntry(id)
        .then((entry) => {
          if (entry) {
            byId.set(id, entry);
            set({ lookupVersion: get().lookupVersion + 1 });
          } else {
            byIdMissing.add(id);
          }
          return entry;
        })
        .catch((e: unknown) => {
          logError('library', `entry ${id.slice(0, 8)} lookup failed: ${String(e)}`);
          return null;
        })
        .finally(() => {
          byIdInFlight.delete(id);
        });
      byIdInFlight.set(id, run);
      return run;
    },

    listFilteredIds: async (options) => {
      // An unpaged library has every row in hand: those ARE every id.
      if (!get().paged) return get().entries.map((e) => e.id);
      const res = await fetchLibraryIds(get().getQuery(), undefined, undefined, {
        partial: options?.partial === true,
      });
      if (res === null) return get().entries.map((e) => e.id);
      return res.ids;
    },

    ensureFacets: async (fields) => {
      if (fields.length === 0 || !get().facetsSupported) return;
      // An unpaged backend has every row in hand: whatever the caller derives
      // from `entries` IS the whole library, so there is nothing to ask for.
      if (!get().paged) return;
      const key = facetCacheKey(fields, get().getQuery(), Math.max(0, get().revision));
      const cached = facetCache.get(key);
      if (cached) {
        if (get().facets !== cached) set({ facets: cached });
        return;
      }
      const running = facetsInFlight.get(key);
      if (running) return running;
      const run = (async () => {
        try {
          const answer = await fetchLibraryFacets(fields, get().getQuery());
          if (answer === null) {
            // No facets route: say so once, and every dropdown falls back to
            // the values it can see on the rows it holds.
            set({ facetsSupported: false, facets: {} });
            return;
          }
          facetCache.set(key, answer.facets);
          // Oldest first: a Map iterates in insertion order.
          while (facetCache.size > MAX_CACHED_FACETS) {
            const oldest = facetCache.keys().next().value;
            if (oldest === undefined) break;
            facetCache.delete(oldest);
          }
          // The query may have moved on while this was out; only the answer to
          // the question being asked NOW is allowed on screen.
          if (facetCacheKey(fields, get().getQuery(), Math.max(0, get().revision)) === key) {
            set({ facets: answer.facets });
          }
        } catch (e) {
          // The library is still opening: nothing failed. The dropdowns keep
          // what they have, and the first page after the open carries a new
          // revision, which asks for the facets again.
          if (e instanceof LibraryOpeningError) return;
          logError('library', `facets failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          facetsInFlight.delete(key);
        }
      })();
      facetsInFlight.set(key, run);
      return run;
    },

    bulkDelete: async (req) => {
      const result = await bulkDeleteLibraryEntries(req);
      if (result === null) {
        set({ bulkDeleteSupported: false });
        return null;
      }
      if (result.deleted > 0) {
        localMutations += 1;
        // Every index after the first deleted row moved, and any cached row
        // may be one of the deleted ones: start from the server again.
        byId.clear();
        byIdInFlight.clear();
        byIdMissing.clear();
        facetCache.clear();
        // An unpaged library was held whole; that copy is now wrong, and
        // re-probing is the only way to know what is left.
        if (allRows) {
          allRows = null;
          set({ paged: true });
        }
        if (Object.prototype.hasOwnProperty.call(req, 'ids')) {
          const gone = new Set((req as { ids: readonly string[] }).ids);
          set((s) => ({
            playingId: s.playingId && gone.has(s.playingId) ? null : s.playingId,
            selectedEntryId:
              s.selectedEntryId && gone.has(s.selectedEntryId) ? null : s.selectedEntryId,
          }));
        } else {
          set({ playingId: null, selectedEntryId: null });
        }
        set({ facets: {} });
        get().invalidatePages();
        useLibraryCounts.getState().invalidate();
        logInfo(
          'library',
          `Bulk delete: ${result.deleted} removed${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}`,
        );
      }
      return result;
    },

    invalidatePages: () => {
      querySeq += 1;
      if (allRows) {
        rebuildUnpaged(allRows);
        return;
      }
      clearPages();
      idIndex = new Map();
      set({ entries: [] });
      void ensurePages(visibleStart, visibleEnd);
    },

    retryPages: async () => {
      set({ pageError: null });
      await ensurePages(visibleStart, visibleEnd);
    },

    resetPaging: () => {
      querySeq += 1;
      clearPages();
      idIndex = new Map();
      byId.clear();
      byIdInFlight.clear();
      byIdMissing.clear();
      allRows = null;
      localMutations = 0;
      visibleStart = 0;
      visibleEnd = LIBRARY_PAGE_SIZE - 1;
      facetCache.clear();
      facetsInFlight.clear();
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      set({
        entries: [],
        total: 0,
        revision: 0,
        paged: true,
        pagesLoading: 0,
        pageError: null,
        libraryOpening: false,
        searchIndex: null,
        loaded: false,
        loading: false,
        lookupVersion: 0,
        facets: {},
        facetsSupported: true,
        bulkDeleteSupported: true,
      });
    },

    upsertEntry: (entry) => {
      if (idIndex.has(entry.id) || byId.has(entry.id)) {
        patchCachedEntry(entry);
        return;
      }
      byId.set(entry.id, entry);
      byIdMissing.delete(entry.id);
      if (allRows) {
        allRows = [entry, ...allRows];
        rebuildUnpaged(allRows);
        return;
      }
      // A row the cache has never seen belongs somewhere in the server's
      // order; only the server knows where. Take the visible range again.
      get().invalidatePages();
    },

    importEntry: async (req) => {
      const entry = await getStorageProvider().import(req);
      localMutations += 1;
      get().upsertEntry(entry);
      logInfo(
        'library',
        `Imported: ${entry.title} (${Math.round(entry.fileSizeBytes / 1024)}KB, ${entry.source})`,
      );
      useLibraryCounts.getState().invalidate();
      return entry;
    },

    removeEntry: async (id) => {
      try {
        await getStorageProvider().delete(id);
        localMutations += 1;
        dropCachedEntries([id]);
        set((s) => ({
          playingId: s.playingId === id ? null : s.playingId,
          selectedEntryId: s.selectedEntryId === id ? null : s.selectedEntryId,
        }));
        logInfo('library', `Removed entry: ${id.slice(0, 8)}`);
        // A delete takes the entry's stems / MIDI / scores with it (ON DELETE
        // CASCADE), so every category count can move, not just tracks.
        useLibraryCounts.getState().invalidate();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError('library', `Remove failed: ${msg}`);
      }
    },

    removeMany: async (ids) => {
      const provider = getStorageProvider();
      let deleted = 0;
      let failed = 0;
      const gone: string[] = [];
      for (const id of ids) {
        try {
          await provider.delete(id);
          gone.push(id);
          deleted += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError('library', `removeMany: failed to delete ${id}: ${msg}`);
          failed += 1;
        }
      }
      if (gone.length > 0) {
        localMutations += 1;
        dropCachedEntries(gone);
      }
      const goneSet = new Set(gone);
      set((s) => ({
        playingId: s.playingId && goneSet.has(s.playingId) ? null : s.playingId,
        selectedEntryId:
          s.selectedEntryId && goneSet.has(s.selectedEntryId) ? null : s.selectedEntryId,
      }));
      logInfo(
        'library',
        `removeMany: ${deleted} deleted, ${failed} failed (of ${ids.length} requested)`,
      );
      // Covers clearAll(), which is removeMany over every LOADED id. One
      // invalidation for the whole batch — the store coalesces it.
      if (deleted > 0) useLibraryCounts.getState().invalidate();
      return { deleted, failed };
    },

    clearAll: async () => {
      // The rows in hand. With a paged backend that is what the user can see,
      // and the confirm they answered counts the same rows.
      const ids = get().entries.map((e) => e.id);
      return get().removeMany(ids);
    },

    updateEntry: async (id, updates) => {
      try {
        const updated = await getStorageProvider().update(id, updates);
        localMutations += 1;
        patchCachedEntry(updated);
        if (!idIndex.has(id)) byId.set(id, updated);
        // A committed write bumps `library_revision`; telling the counts store
        // keeps the tab strip honest without re-reading a single page here.
        useLibraryCounts.getState().invalidate();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError('library', `Update failed: ${msg}`);
      }
    },

    toggleFavorite: async (id) => {
      // A row on an evicted page is in no loaded page and so in no `entries`:
      // fetch it once rather than making the first click do nothing.
      const current = get().getById(id) ?? (await get().ensureEntry(id));
      if (!current) return;
      await get().updateEntry(id, { favorite: !current.favorite });
    },

    setRating: async (id, rating) => {
      await get().updateEntry(id, { rating });
    },

    setSearchQuery: (q) => {
      set({ searchQuery: q });
      // One request per pause, not one per keystroke.
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        applyQueryChange();
      }, SEARCH_DEBOUNCE_MS);
    },
    setOnlyFavorites: (v) => {
      if (get().onlyFavorites === v) return;
      set({ onlyFavorites: v });
      applyQueryChange();
    },
    setSortBy: (s) => {
      if (get().sortBy === s) return;
      set({ sortBy: s });
      applyQueryChange();
    },
    setKindFilter: (kind) => {
      if (get().kindFilter === kind) return;
      set({ kindFilter: kind });
      applyQueryChange();
    },
    setSourceFilter: (source) => {
      if (get().sourceFilter === source) return;
      set({ sourceFilter: source });
      applyQueryChange();
    },
    setProviderFilter: (provider) => {
      if (get().providerFilter === provider) return;
      set({ providerFilter: provider });
      applyQueryChange();
    },
    setPlayingId: (id) => set({ playingId: id }),
    setSelectedEntry: (id) => set({ selectedEntryId: id }),

    registerPlay: (id) => {
      // Optimistic local bump so the sort + readout update immediately.
      const current = get().getById(id);
      if (current) {
        patchCachedEntry({
          ...current,
          playCount: (current.playCount ?? 0) + 1,
          lastPlayedAt: Date.now() / 1000,
        });
      }
      // Persist (fire-and-forget); the count survives restarts on the backend.
      void fetch(`/api/library/entries/${encodeURIComponent(id)}/play`, {
        method: 'POST',
      }).catch((e) =>
        logError('library', `play-count update failed for ${id.slice(0, 8)}: ${e}`),
      );
    },

    getAudioUrl: (entry) => getStorageProvider().getAudioUrl(entry),

    fetchAudioBlob: (entry) => getStorageProvider().fetchAudioBlob(entry),

    // The rows the current filters leave. With a paged backend the server has
    // already applied them, so this is exactly the loaded rows in order.
    getFiltered: () => get().entries,
  };
});

/**
 * Follow the library forward.
 *
 * The counts store (T21) re-reads `/api/library/summary` after every committed
 * mutation, and that answer carries the DB's `library_revision`. A revision
 * NEWER than the one our pages were read at means somebody changed the library
 * — an import, a background job, another window — so the cache is stale and
 * the visible range is taken again.
 *
 * A bump this store caused itself is not news: `localMutations` counts those,
 * and one of them absorbs one bump, so a favourite toggle patched in place
 * does not throw the page cache away and re-fetch it.
 */
useLibraryCounts.subscribe((counts, previous) => {
  if (counts.revision === previous.revision) return;
  const lib = useLibraryStore.getState();
  if (lib.revision === 0 || counts.revision <= lib.revision) return;
  if (localMutations > 0) {
    localMutations = 0;
    useLibraryStore.setState({ revision: counts.revision });
    return;
  }
  useLibraryStore.setState({ revision: counts.revision });
  lib.invalidatePages();
});
