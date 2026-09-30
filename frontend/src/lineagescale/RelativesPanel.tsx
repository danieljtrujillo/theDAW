import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ProviderBadge } from '../components/library/ProviderBadge';
import {
  RELATIVES_LIMIT_MAX, fetchRelatives,
  type RelativesPage, type RelativesRequest, type RelativesSort,
} from './lineageScaleClient';
import {
  formatCount, formatDuration, nodeTitle, relativeRowAccessibleWords, relativeRowWords,
} from './lineageScaleModel';

/**
 * RelativesPanel — what a folded group opens into.
 *
 * A song in this library can have 750+ direct relatives, and one component of
 * the real graph holds 81,501 songs. Drawing that is the thing that killed the
 * old view, so a big family is never drawn: it is a PAGE of a list. The panel
 * asks `/relatives` for one page at a time, sorts server-side, and every row
 * is a button that re-focuses the graph on that song.
 *
 * The component is split so the rendering can be tested without a network: the
 * body is pure props, and the container owns the request.
 */

export interface RelativesPanelBodyProps {
  /** The heading: "Used in mashups (677) — Night Drive". */
  heading: string;
  request: RelativesRequest;
  page: RelativesPage | null;
  loading: boolean;
  error: string | null;
  onSort: (sort: RelativesSort) => void;
  onOffset: (offset: number) => void;
  onFocus: (id: string, title: string) => void;
  onClose: () => void;
  onRetry: () => void;
}

const SORTS: ReadonlyArray<{ value: RelativesSort; label: string }> = [
  { value: 'title', label: 'Title' },
  { value: 'plays', label: 'Most played' },
  { value: 'recent', label: 'Most recent' },
];

/** A stable DOM id per panel instance, so the <label> can point at the select.
 *  One panel is open at a time, but the id is derived from the request anyway
 *  so two panels could never collide. */
const sortSelectId = (request: RelativesRequest): string =>
  `lineage-scale-relatives-sort-${encodeURIComponent(request.entryId)}-${request.direction}-${request.kind}`;

export const RelativesPanelBody: React.FC<RelativesPanelBodyProps> = ({
  heading, request, page, loading, error, onSort, onOffset, onFocus, onClose, onRetry,
}) => {
  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];
  const first = total === 0 ? 0 : request.offset + 1;
  const last = Math.min(request.offset + rows.length, total);
  const hasPrev = request.offset > 0;
  const hasNext = request.offset + request.limit < total;
  const selectId = sortSelectId(request);

  return (
    <section
      aria-label={`Relatives: ${heading}`}
      className="flex h-full w-full flex-col overflow-hidden border-l border-white/10 bg-black/60"
    >
      <header className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
        <div className="min-w-0 grow">
          <h3 className="truncate text-[11px] font-mono uppercase tracking-widest text-zinc-200">{heading}</h3>
          <p className="mt-0.5 text-[9px] font-mono text-zinc-500">
            {loading && !page
              ? 'Loading…'
              : total === 0
                ? 'No relatives of this kind'
                : `Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the relatives list"
          className="shrink-0 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/20 hover:text-zinc-100"
        >
          Close
        </button>
      </header>

      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <label htmlFor={selectId} className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">
          Sort
        </label>
        <select
          id={selectId}
          name="lineage-scale-relatives-sort"
          value={request.sort}
          onChange={(e) => onSort(e.target.value as RelativesSort)}
          className="rounded border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <span className="grow" />
        <button
          type="button"
          disabled={!hasPrev || loading}
          onClick={() => onOffset(Math.max(0, request.offset - request.limit))}
          aria-label="Previous page of relatives"
          className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/20 hover:text-zinc-100 disabled:opacity-40"
        >
          Prev
        </button>
        <button
          type="button"
          disabled={!hasNext || loading}
          onClick={() => onOffset(request.offset + request.limit)}
          aria-label="Next page of relatives"
          className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/20 hover:text-zinc-100 disabled:opacity-40"
        >
          Next
        </button>
      </div>

      {error ? (
        <div className="px-3 py-4">
          <p className="text-[10px] text-rose-300">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/20 hover:text-white"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 && !loading ? (
        <p className="px-3 py-6 text-center text-[10px] italic text-zinc-500">
          Nothing here — this song has no relatives of that kind in that direction.
        </p>
      ) : (
        <ul className="min-h-0 grow overflow-y-auto">
          {rows.map((row) => {
            const title = nodeTitle(row);
            const duration = formatDuration(row.duration_sec);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onFocus(row.id, title)}
                  aria-label={`${title}${duration ? `, ${duration}` : ''}, ${relativeRowAccessibleWords(row.kinds, request.direction)}. Focus this song.`}
                  className="flex w-full items-center gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5"
                >
                  <span className="min-w-0 grow">
                    <span className="block truncate text-[11px] text-zinc-100">{title}</span>
                    <span className="block truncate text-[9px] font-mono text-zinc-500">
                      {relativeRowWords(row.kinds, request.direction)}
                      {duration ? ` · ${duration}` : ''}
                      {row.play_count > 0 ? ` · ${formatCount(row.play_count)} plays` : ''}
                    </span>
                  </span>
                  {/* model AND source: a legacy Suno import has an empty
                      model, and a badge given only the model calls it Stable
                      Audio. Same fix as 30f8732 in the catalogue. */}
                  <ProviderBadge entry={{ model: row.model, source: row.source }} className="shrink-0" />
                </button>
              </li>
            );
          })}
          {loading && (
            <li className="px-3 py-2 text-[9px] font-mono uppercase tracking-widest text-zinc-500">Loading…</li>
          )}
        </ul>
      )}
    </section>
  );
};

export interface RelativesPanelProps {
  heading: string;
  request: RelativesRequest;
  onFocus: (id: string, title: string) => void;
  onClose: () => void;
  /** Swapped in tests; production reads the real route. */
  load?: (request: RelativesRequest) => Promise<RelativesPage>;
}

/** The container: owns sort, offset and the in-flight request. */
export const RelativesPanel: React.FC<RelativesPanelProps> = ({
  heading, request, onFocus, onClose, load,
}) => {
  const [sort, setSort] = useState<RelativesSort>(request.sort);
  const [offset, setOffset] = useState(request.offset);
  const [page, setPage] = useState<RelativesPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A new group re-arms the panel from that group's own query.
  useEffect(() => {
    setSort(request.sort);
    setOffset(request.offset);
    setPage(null);
  }, [request.entryId, request.direction, request.kind, request.sort, request.offset]);

  const active = useMemo<RelativesRequest>(
    () => ({
      entryId: request.entryId,
      direction: request.direction,
      kind: request.kind,
      sort,
      offset,
      limit: Math.min(request.limit, RELATIVES_LIMIT_MAX),
    }),
    [request.entryId, request.direction, request.kind, request.limit, sort, offset],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    (load ?? fetchRelatives)(active)
      .then((p) => {
        if (live) setPage(p);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [active, load, attempt]);

  const onSort = useCallback((next: RelativesSort) => {
    setSort(next);
    setOffset(0);
  }, []);

  return (
    <RelativesPanelBody
      heading={heading}
      request={active}
      page={page}
      loading={loading}
      error={error}
      onSort={onSort}
      onOffset={setOffset}
      onFocus={onFocus}
      onClose={onClose}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
};

export default RelativesPanel;
