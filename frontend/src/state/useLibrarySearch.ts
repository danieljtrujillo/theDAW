/**
 * `useLibrarySearch` — a component's own search over the whole library.
 *
 * Wraps a `LibrarySearchSession` (lib/librarySearch.ts): the component passes
 * its query, gets back the rows of that query's first page (and more on
 * `loadMore`), and never sees the LIBRARY tab's query or its pages. The
 * session starts again when the library moves: the counts store's revision
 * is bumped by every committed write, from this window or any other.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  LibrarySearchSession,
  type LibrarySearchOptions,
  type LibrarySearchSnapshot,
} from '../lib/librarySearch';
import type { LibraryQuery } from '../lib/backendLocalProvider';
import { useLibraryCounts } from './libraryCountsStore';

export interface LibrarySearchResult extends LibrarySearchSnapshot {
  /** Fetch the next page of the query. */
  loadMore: () => void;
  /** Ask the first page again (a reload button). */
  refresh: () => void;
  /** More rows match than are held. */
  hasMore: boolean;
}

const IDLE: LibrarySearchSnapshot = { rows: [], total: 0, loading: false, error: null };
const idleSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE;

/**
 * `enabled: false` holds no session and fetches nothing (a closed picker).
 * The query fields are read one by one, so a caller may pass a fresh object
 * every render.
 */
export function useLibrarySearch(
  query: Partial<LibraryQuery>,
  { enabled = true, ...options }: LibrarySearchOptions & { enabled?: boolean } = {},
): LibrarySearchResult {
  const { q = '', sort, kind, favorite, source, provider } = query;
  const { pageSize, debounceMs, fetchList } = options;
  const revision = useLibraryCounts((s) => s.revision);
  const [session, setSession] = useState<LibrarySearchSession | null>(null);

  // One session per switch-on (and per change of how it fetches).
  useEffect(() => {
    if (!enabled) return undefined;
    const created = new LibrarySearchSession({}, { pageSize, debounceMs, fetchList });
    setSession(created);
    return () => {
      created.dispose();
      setSession((current) => (current === created ? null : current));
    };
  }, [enabled, pageSize, debounceMs, fetchList]);

  // The query goes to the live session: the first one starts it at once, a
  // later text change is debounced there, anything else is sent at once.
  const started = useRef<LibrarySearchSession | null>(null);
  useEffect(() => {
    if (!session) return;
    const next = { q, sort, kind, favorite, source, provider };
    if (started.current !== session) {
      started.current = session;
      void session.start(next);
    } else {
      void session.setQuery(next);
    }
  }, [session, q, sort, kind, favorite, source, provider]);

  // A newer library revision: the first page again. A session sees the
  // revision it was started at as current -- its first page was just asked
  // for -- so reopening after a write sends one request, not two.
  const seen = useRef<{ session: LibrarySearchSession | null; revision: number }>({
    session: null,
    revision,
  });
  useEffect(() => {
    if (!session) return;
    const last = seen.current;
    seen.current = { session, revision };
    if (last.session === session && last.revision !== revision) void session.refresh();
  }, [session, revision]);

  const snapshot = useSyncExternalStore(
    session ? session.subscribe : idleSubscribe,
    session ? session.getSnapshot : idleSnapshot,
    idleSnapshot,
  );
  const loadMore = useCallback(() => {
    void session?.loadMore();
  }, [session]);
  const refresh = useCallback(() => {
    void session?.refresh();
  }, [session]);
  const shown = enabled ? snapshot : IDLE;
  return { ...shown, loadMore, refresh, hasMore: shown.rows.length < shown.total };
}
