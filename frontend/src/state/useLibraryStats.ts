/**
 * The LIBRARY tab's chips — favourites, size, total length — over the WHOLE
 * current query.
 *
 * A paged store holds a few pages of a result set that can be 200,000 rows
 * long, so summing `entries` counts whatever happened to be scrolled into
 * view. The totals come from the server (`GET /entries/stats`) for the
 * store's own query, asked again whenever the query or the library moves.
 * Against a backend that does not page, the store holds every row of the
 * query, so the sum of those rows IS the total; the same happens against a
 * paged backend too old to have the stats route.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchLibraryStats, type LibraryQuery, type LibraryStats } from '../lib/backendLocalProvider';
import type { LibraryEntry } from './libraryEntry';
import { SEARCH_DEBOUNCE_MS, useLibraryStore } from './libraryStore';
import { useLibraryCounts } from './libraryCountsStore';

/** The totals of rows held in hand. */
export function sumLibraryRows(rows: readonly LibraryEntry[]): LibraryStats {
  let sizeBytes = 0;
  let durationSec = 0;
  let favorites = 0;
  for (const e of rows) {
    sizeBytes += e.fileSizeBytes;
    durationSec += e.duration;
    if (e.favorite) favorites += 1;
  }
  return { count: rows.length, favorites, sizeBytes, durationSec, revision: 0 };
}

/** The server's totals for a query, or null when it has no stats route. */
export type LibraryStatsFetcher = (
  query: LibraryQuery,
  signal?: AbortSignal,
) => Promise<LibraryStats | null>;

/** What the chips show, and whether it covers the whole query. */
export interface LibraryStatsView extends LibraryStats {
  /** False while only the held rows are summed (no server totals). */
  whole: boolean;
}

export function useLibraryStats(fetcher: LibraryStatsFetcher = fetchLibraryStats): LibraryStatsView {
  const paged = useLibraryStore((s) => s.paged);
  const entries = useLibraryStore((s) => s.entries);
  const q = useLibraryStore((s) => s.searchQuery);
  const kind = useLibraryStore((s) => s.kindFilter);
  const favorite = useLibraryStore((s) => s.onlyFavorites);
  const source = useLibraryStore((s) => s.sourceFilter);
  const provider = useLibraryStore((s) => s.providerFilter);
  const revision = useLibraryCounts((s) => s.revision);
  const [server, setServer] = useState<{ key: string; stats: LibraryStats | null } | null>(null);

  const query = useMemo<LibraryQuery>(
    () => ({
      q,
      sort: 'created_desc',
      kind: kind || 'audio',
      favorite: favorite ? true : null,
      source,
      provider,
    }),
    [q, kind, favorite, source, provider],
  );
  const key = `${JSON.stringify(query)}@${revision}`;

  useEffect(() => {
    if (!paged) return undefined;
    const ctrl = new AbortController();
    // The store's search text moves on every keystroke; its pages wait for
    // a pause, and so do the totals.
    const timer = setTimeout(() => {
      fetcher(query, ctrl.signal)
        .then((stats) => {
          if (!ctrl.signal.aborted) setServer({ key, stats });
        })
        .catch(() => {
          // A failed request leaves the held-row sum on screen; the next
          // query or revision asks again.
          if (!ctrl.signal.aborted) setServer({ key, stats: null });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [paged, query, key, fetcher]);

  const held = useMemo(() => sumLibraryRows(entries), [entries]);
  // The last server answer stays on screen while the next one is out, so the
  // chips do not flicker to a partial sum on every keystroke.
  if (paged && server?.stats) return { ...server.stats, whole: true };
  return { ...held, whole: !paged };
}
