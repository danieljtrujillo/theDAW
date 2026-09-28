/**
 * A library search of its own: one query, its own pages, its own answer.
 *
 * The LIBRARY tab's store holds the pages of ITS query. Every other surface
 * that looks something up in the library — the EDIT library picker, the LOOM
 * crate, the phone's library tab — asks its own question and must get the
 * answer over the whole library, not a filter of whatever the LIBRARY tab
 * happens to have loaded for a different query. A `LibrarySearchSession` is
 * that question: it sends its query to the backend, holds the pages it
 * fetched, fetches more on `loadMore()`, and starts again when its query or
 * the library changes.
 *
 * Against a backend that does not page, the first request comes back as the
 * whole library; the session then filters and sorts it here with the same
 * matcher the LIBRARY tab uses (`librarySearchMatch.ts`).
 *
 * No React in here, so the test drives it under plain node; `useLibrarySearch`
 * is the hook around it.
 */
import type { LibraryEntry } from '../state/libraryEntry';
import {
  DEFAULT_LIBRARY_QUERY,
  fetchLibraryList,
  LibrarySortUnsupportedError,
  type LibraryListResult,
  type LibraryQuery,
  type LibraryServerSort,
} from './backendLocalProvider';
import { hasProvider } from './providerLabel';
import { entryMatchesSearch } from './librarySearchMatch';

/** What a session shows. `rows` are in the query's order. */
export interface LibrarySearchSnapshot {
  rows: LibraryEntry[];
  /** Rows matching the query, fetched or not. */
  total: number;
  loading: boolean;
  error: string | null;
}

export type LibraryListFetcher = (
  query: LibraryQuery,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => Promise<LibraryListResult>;

export interface LibrarySearchOptions {
  /** Rows per request. */
  pageSize?: number;
  /** How long a change of `q` waits before it is sent. */
  debounceMs?: number;
  fetchList?: LibraryListFetcher;
}

export const LIBRARY_SEARCH_PAGE_SIZE = 100;
export const LIBRARY_SEARCH_DEBOUNCE_MS = 200;

const byTitle = (a: LibraryEntry, b: LibraryEntry) => a.title.localeCompare(b.title);

/** The server's sort orders, for rows sorted here. */
const CLIENT_SORT: Record<LibraryServerSort, (a: LibraryEntry, b: LibraryEntry) => number> = {
  created_desc: (a, b) => b.timestamp.localeCompare(a.timestamp),
  created_asc: (a, b) => a.timestamp.localeCompare(b.timestamp),
  title_asc: byTitle,
  title_desc: (a, b) => byTitle(b, a),
  plays_desc: (a, b) => (b.playCount ?? 0) - (a.playCount ?? 0),
  duration_desc: (a, b) => b.duration - a.duration,
  duration_asc: (a, b) => a.duration - b.duration,
  favorites_first: (a, b) => Number(b.favorite) - Number(a.favorite) || byTitle(a, b),
};

/**
 * What to ask a backend that refuses a sort newer than it is
 * (`LibrarySortUnsupportedError`): an order it has, which the rows are then
 * re-sorted from here. `favorites_first` came with the whole-library EDIT
 * picker; its title order is what a backend without it can give.
 */
const SORT_FALLBACK: Partial<Record<LibraryServerSort, LibraryServerSort>> = {
  favorites_first: 'title_asc',
};

const matchesKind = (entry: LibraryEntry, kind: string): boolean => {
  const k = entry.kind ?? 'audio';
  if (kind === 'all') return true;
  if (kind === 'media') return k === 'video' || k === 'image';
  return k === kind;
};

/** The query applied to a whole library held in hand. */
export function filterLibraryLocally(
  rows: readonly LibraryEntry[],
  query: LibraryQuery,
): LibraryEntry[] {
  const out = rows.filter(
    (e) =>
      matchesKind(e, query.kind || 'audio') &&
      (query.favorite !== true || e.favorite) &&
      (!query.source || e.source === query.source) &&
      (!query.provider || hasProvider(e, query.provider)) &&
      entryMatchesSearch(e, query.q),
  );
  return out.sort(CLIENT_SORT[query.sort] ?? CLIENT_SORT.created_desc);
}

/** `partial` without its undefined fields, so they keep the value they had. */
const definedFields = (partial: Partial<LibraryQuery>): Partial<LibraryQuery> =>
  Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  ) as Partial<LibraryQuery>;

const sameQuery = (a: LibraryQuery, b: LibraryQuery): boolean =>
  a.q.trim() === b.q.trim() &&
  a.sort === b.sort &&
  a.kind === b.kind &&
  a.favorite === b.favorite &&
  a.source === b.source &&
  a.provider === b.provider;

export class LibrarySearchSession {
  private query: LibraryQuery;
  private readonly pageSize: number;
  private readonly debounceMs: number;
  private readonly fetchList: LibraryListFetcher;
  private snapshot: LibrarySearchSnapshot = { rows: [], total: 0, loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  /** Bumped by every restart; an answer to an older one is dropped. */
  private seq = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Callers waiting on a debounced query; a newer one settles them too. */
  private waiting: (() => void)[] = [];
  /** The whole library, when the backend does not page. */
  private unpagedRows: LibraryEntry[] | null = null;
  /** The backend refused a sort; ask its `SORT_FALLBACK` from now on. */
  private sortRefused = false;
  private disposed = false;

  constructor(query: Partial<LibraryQuery> = {}, options: LibrarySearchOptions = {}) {
    this.query = { ...DEFAULT_LIBRARY_QUERY, ...definedFields(query) };
    this.pageSize = options.pageSize ?? LIBRARY_SEARCH_PAGE_SIZE;
    this.debounceMs = options.debounceMs ?? LIBRARY_SEARCH_DEBOUNCE_MS;
    this.fetchList = options.fetchList ?? fetchLibraryList;
  }

  getSnapshot = (): LibrarySearchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getQuery(): LibraryQuery {
    return this.query;
  }

  /** Fetch the first page now: of `query` when given, else of the current one. */
  start(query?: Partial<LibraryQuery>): Promise<void> {
    if (query) this.query = { ...this.query, ...definedFields(query) };
    this.cancelTimer();
    return this.restart();
  }

  /**
   * Change the query. A change of the text waits `debounceMs` (one request
   * per pause, not one per keystroke); any other change is sent at once.
   * Resolves when the new first page has landed (or was superseded).
   */
  setQuery(partial: Partial<LibraryQuery>): Promise<void> {
    const next = { ...this.query, ...definedFields(partial) };
    if (sameQuery(next, this.query)) return Promise.resolve();
    const textOnly =
      next.q.trim() !== this.query.q.trim() &&
      sameQuery({ ...next, q: this.query.q }, this.query);
    this.query = next;
    this.cancelTimer();
    if (!textOnly || this.debounceMs <= 0) return this.restart();
    this.seq += 1;
    this.controller?.abort();
    this.emit({ ...this.snapshot, loading: true, error: null });
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.timer = setTimeout(() => {
        this.timer = null;
        const settle = this.waiting;
        this.waiting = [];
        void this.restart().then(() => settle.forEach((done) => done()));
      }, this.debounceMs);
    });
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const settle = this.waiting;
    this.waiting = [];
    settle.forEach((done) => done());
  }

  /** The library changed (a new revision): take the first page again. */
  refresh(): Promise<void> {
    this.unpagedRows = null;
    this.cancelTimer();
    return this.restart();
  }

  /** Fetch the next page of the current query, when there is one. */
  async loadMore(): Promise<void> {
    const { rows, total, loading } = this.snapshot;
    if (loading || rows.length >= total || this.disposed) return;
    if (this.unpagedRows) {
      const all = filterLibraryLocally(this.unpagedRows, this.query);
      this.emit({ ...this.snapshot, rows: all.slice(0, rows.length + this.pageSize) });
      return;
    }
    const seq = this.seq;
    const ctrl = new AbortController();
    this.controller = ctrl;
    this.emit({ ...this.snapshot, loading: true, error: null });
    try {
      const result = await this.fetchRows(rows.length, ctrl.signal);
      if (seq !== this.seq) return;
      if (result.paged && result.page) {
        const seen = new Set(rows.map((r) => r.id));
        const more = result.page.entries.filter((r) => !seen.has(r.id));
        this.emit({
          rows: this.inQueryOrder([...rows, ...more]),
          total: result.page.total,
          loading: false,
          error: null,
        });
      } else {
        this.adoptUnpaged(result.entries ?? [], rows.length + this.pageSize);
      }
    } catch (e) {
      if (seq !== this.seq || ctrl.signal.aborted) return;
      this.emit({ ...this.snapshot, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.seq += 1;
    this.controller?.abort();
    this.cancelTimer();
    this.listeners.clear();
  }

  private async restart(): Promise<void> {
    if (this.disposed) return;
    this.seq += 1;
    const seq = this.seq;
    this.controller?.abort();
    if (this.unpagedRows) {
      this.adoptUnpaged(this.unpagedRows, this.pageSize);
      return;
    }
    const ctrl = new AbortController();
    this.controller = ctrl;
    this.emit({ ...this.snapshot, loading: true, error: null });
    try {
      const result = await this.fetchRows(0, ctrl.signal);
      if (seq !== this.seq) return;
      if (result.paged && result.page) {
        this.emit({
          rows: this.inQueryOrder(result.page.entries),
          total: result.page.total,
          loading: false,
          error: null,
        });
      } else {
        this.adoptUnpaged(result.entries ?? [], this.pageSize);
      }
    } catch (e) {
      if (seq !== this.seq || ctrl.signal.aborted) return;
      this.emit({ rows: [], total: 0, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * One page of the current query from `offset`. A backend that refuses the
   * sort is asked again with the `SORT_FALLBACK`, and so is every later
   * request of this session.
   */
  private async fetchRows(offset: number, signal: AbortSignal): Promise<LibraryListResult> {
    const fallback = SORT_FALLBACK[this.query.sort];
    if (this.sortRefused && fallback) {
      return this.fetchList({ ...this.query, sort: fallback }, offset, this.pageSize, signal);
    }
    try {
      return await this.fetchList(this.query, offset, this.pageSize, signal);
    } catch (e) {
      if (!(e instanceof LibrarySortUnsupportedError) || !fallback) throw e;
      this.sortRefused = true;
      return this.fetchList({ ...this.query, sort: fallback }, offset, this.pageSize, signal);
    }
  }

  /**
   * Rows as the query orders them. The backend's order already is, unless it
   * was asked a fallback sort; then the rows held are sorted here, so the
   * favourites among them come first.
   */
  private inQueryOrder(rows: LibraryEntry[]): LibraryEntry[] {
    if (!this.sortRefused || !SORT_FALLBACK[this.query.sort]) return rows;
    return [...rows].sort(CLIENT_SORT[this.query.sort]);
  }

  private adoptUnpaged(all: LibraryEntry[], show: number): void {
    this.unpagedRows = all;
    const matched = filterLibraryLocally(all, this.query);
    this.emit({ rows: matched.slice(0, show), total: matched.length, loading: false, error: null });
  }

  private emit(next: LibrarySearchSnapshot): void {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
