/**
 * The chips at the top of the LIBRARY tab: how many entries the current view
 * holds, how many are favourites, their size and their total length.
 *
 * The count is the list's own `total`. The other three are the server's
 * totals for the WHOLE current query (`useLibraryStats`): at 200,000 entries
 * the browser never holds every row, so a sum of the rows in hand would change
 * as the user scrolled.
 */
import React from 'react';
import { Star } from 'lucide-react';
import { formatDuration, formatSize } from '../../lib/libraryFormat';
import { useLibraryStats } from '../../state/useLibraryStats';

export interface LibraryStatsStripProps {
  /** Entries matching the current view, from the list's paged answer. */
  total: number;
  /** The LIBRARY tab's search text. */
  searchQuery: string;
  /** Rows the store holds, named in the tooltips while only they are summed. */
  loadedRows: number;
}

export const LibraryStatsStrip: React.FC<LibraryStatsStripProps> = ({ total, searchQuery, loadedRows }) => {
  const stats = useLibraryStats();
  const query = searchQuery.trim();
  const scope = stats.whole
    ? query
      ? `the entries matching “${query}”`
      : 'every entry in this view'
    : `the ${loadedRows.toLocaleString()} rows loaded so far`;
  return (
    <div
      data-testid="library-stats"
      className="shrink-0 flex items-center gap-1 flex-wrap text-xs font-bold uppercase tracking-wide text-zinc-400 pb-1 border-b border-white/5"
    >
      <span
        className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10"
        title={query ? `Matching “${query}”` : 'Every entry in the library'}
      >
        <span className="text-zinc-200" data-stat="count">{total.toLocaleString()}</span> entries
      </span>
      <span
        className="px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20"
        title={`Favorites among ${scope}`}
      >
        <Star className="w-3 h-3 fill-current inline-block text-yellow-400 -mt-0.5" aria-hidden="true" />{' '}
        <span className="text-yellow-200" data-stat="favorites">{stats.favorites.toLocaleString()}</span>
        <span className="sr-only"> favorites</span>
      </span>
      <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10" title={`Size of ${scope}`}>
        <span className="text-zinc-200" data-stat="size">{formatSize(stats.sizeBytes)}</span>
      </span>
      <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10" title={`Total length of ${scope}`}>
        <span className="text-zinc-200" data-stat="duration">{formatDuration(stats.durationSec)}</span>
      </span>
    </div>
  );
};
