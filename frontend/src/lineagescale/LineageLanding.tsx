import React, { useCallback, useEffect, useState } from 'react';
import { entryProviderMeta } from '../catalog/catalogProviders';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { relationWords } from '../lib/lineageInsights';
import type { LineageSummary, RankingList, RankingRow } from './lineageScaleClient';
import { RANKING_LISTS } from './lineageScaleClient';
import {
  RANKING_HINTS, RANKING_TITLES, formatCount, kindRows, summaryHeadlines,
} from './lineageScaleModel';
import { LineageExplorer } from './LineageExplorer';
import { fetchExplorePage } from './exploreClient';
import {
  EXPLORE_KINDS, EXPLORE_PAGE, KIND_ANY, ROLE_WORDS, defaultDirFor, defaultSortFor,
  exploreTitle, specForHeadline, specForRanking,
} from './exploreModel';
import type {
  ExploreDir, ExplorePage, ExploreSort, ExploreSpec,
} from './exploreModel';

/**
 * LineageLanding — the way IN to a 200,000-song lineage.
 *
 * There is no picture of the library here, because there cannot be one: the
 * real graph is 194,833 nodes and 475,174 links, and one connected component
 * holds 81,501 songs. So the landing page is numbers, four ranked lists, and a
 * search box. You pick ONE song, and the focus view draws its neighbourhood.
 *
 * The search goes through the library's own paged `/entries` endpoint (the
 * same one the library list uses), so it costs one page of rows — the library
 * is never loaded. It is fts5-backed and already searches every song in the
 * library, which is why there is no second search route for this box.
 *
 * EVERY NUMBER ON THIS PAGE OPENS A LIST. The counts were a dead end: four
 * preset rankings were the only way in, and a library is not four lists. Each
 * headline card, each relationship-kind row and each ranked list's "More…"
 * names an `ExploreSpec` (`exploreModel.ts`) and hands it to `LineageExplorer`,
 * which reads ONE page of it at a time from `/api/lineage-scale/explore`. The
 * custom row at the top of the rankings builds that spec by hand: any kind, in
 * either role.
 */

export interface SearchHit {
  id: string;
  title: string;
  model?: string;
  source?: string;
}

export interface LineageLandingProps {
  summary: LineageSummary | null;
  rankings: Partial<Record<RankingList, RankingRow[]>>;
  rankingErrors?: Partial<Record<RankingList, string>>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onFocus: (id: string, title: string) => void;
  onSearch: (query: string) => Promise<SearchHit[]>;
}

const SEARCH_INPUT_ID = 'lineage-scale-search';
const CUSTOM_KIND_ID = 'lineage-rankings-kind';
const CUSTOM_ROLE_ID = 'lineage-rankings-role';
/** The two populations the "Songs" card counts, in the order it names them. */
const SONG_SETS = ['with_lineage', 'standalone'] as const;

/** One headline number. It is a BUTTON when there is a list behind it, and it
 *  says which list in its own accessible name — a number you cannot open is
 *  the thing this view was rebuilt to stop doing. */
const Card: React.FC<{
  label: string;
  value: string;
  hint: string;
  openLabel?: string;
  onOpen?: () => void;
  extra?: React.ReactNode;
}> = ({ label, value, hint, openLabel, onOpen, extra }) => {
  const body = (
    <>
      <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xl tabular-nums text-zinc-100">{value}</div>
      <div className="mt-0.5 text-[9px] font-mono text-zinc-500">{hint}</div>
    </>
  );
  return (
    <div className="rounded border border-white/10 bg-white/3 px-3 py-2">
      {onOpen ? (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="block w-full text-left hover:text-white"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {extra}
    </div>
  );
};

const RankedList: React.FC<{
  list: RankingList;
  rows: RankingRow[] | undefined;
  error: string | undefined;
  onFocus: (id: string, title: string) => void;
  onMore?: () => void;
  moreLabel?: string;
}> = ({ list, rows, error, onFocus, onMore, moreLabel }) => (
  <section aria-label={RANKING_TITLES[list]} className="flex min-h-0 flex-col rounded border border-white/10 bg-black/40">
    <header className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
      <div className="min-w-0 grow">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-300">{RANKING_TITLES[list]}</h3>
        <p className="mt-0.5 text-[9px] font-mono text-zinc-500">{RANKING_HINTS[list]}</p>
      </div>
      {onMore && (
        <button
          type="button"
          aria-label={moreLabel}
          onClick={onMore}
          className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-purple-400/60 hover:text-white"
        >
          More…
        </button>
      )}
    </header>
    {error ? (
      <p className="px-3 py-4 text-[10px] text-rose-300">{error}</p>
    ) : rows === undefined ? (
      <p className="px-3 py-4 text-[10px] font-mono text-zinc-500">Loading…</p>
    ) : rows.length === 0 ? (
      <p className="px-3 py-4 text-[10px] italic text-zinc-500">Nothing to rank yet.</p>
    ) : (
      <ol className="min-h-0 grow overflow-y-auto">
        {rows.map((row, i) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onFocus(row.id, row.title)}
              aria-label={`${row.title}, ${entryProviderMeta({ model: row.model, source: row.source }).label}, ${formatCount(row.count)}, ${row.detail}. Focus this song.`}
              className="flex w-full items-center gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5"
            >
              <span className="w-5 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-600">{i + 1}</span>
              <span className="min-w-0 grow">
                <span className="block truncate text-[11px] text-zinc-100">{row.title}</span>
                <span className="block truncate text-[9px] font-mono text-zinc-500">{row.detail}</span>
              </span>
              <ProviderBadge entry={{ model: row.model, source: row.source }} className="shrink-0" />
              <span className="shrink-0 text-[11px] tabular-nums text-purple-200">{formatCount(row.count)}</span>
            </button>
          </li>
        ))}
      </ol>
    )}
  </section>
);

export const LineageLanding: React.FC<LineageLandingProps> = ({
  summary, rankings, rankingErrors, loading, error, onRetry, onFocus, onSearch,
}) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // The open list, and everything one page of it needs. It lives here rather
  // than in the panel so "Back to the numbers" is a single setState and so the
  // panel stays a rendering of props (LineageExplorer.test.tsx renders it with
  // no store, no fetch and no browser).
  const [spec, setSpec] = useState<ExploreSpec | null>(null);
  const [listQuery, setListQuery] = useState('');
  const [sort, setSort] = useState<ExploreSort>('title');
  const [dir, setDir] = useState<ExploreDir>('asc');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ExplorePage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [customKind, setCustomKind] = useState<string>(KIND_ANY);
  const [customRole, setCustomRole] = useState<'parent' | 'child'>('parent');

  /** Open a list. Each one opens on the sort it is ranked by, at page one. */
  const openList = useCallback((next: ExploreSpec) => {
    setSpec(next);
    setSort(defaultSortFor(next));
    setDir(defaultDirFor(next));
    setListQuery('');
    setOffset(0);
    setPage(null);
    setListError(null);
  }, []);

  useEffect(() => {
    if (spec === null) return undefined;
    let cancelled = false;
    setListLoading(true);
    // Typing is debounced; every other change (a sort, a page) is immediate.
    const timer = setTimeout(
      () => {
        fetchExplorePage({ spec, q: listQuery, sort, dir, offset, limit: EXPLORE_PAGE })
          .then((next) => {
            if (cancelled) return;
            setPage(next);
            setListError(null);
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setPage(null);
            setListError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            if (!cancelled) setListLoading(false);
          });
      },
      listQuery ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec, listQuery, sort, dir, offset, reloads]);

  const copyId = useCallback((id: string) => {
    void navigator?.clipboard?.writeText?.(id);
  }, []);

  const runSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      if (!q) {
        setHits(null);
        setSearchError(null);
        return;
      }
      setSearching(true);
      setSearchError(null);
      onSearch(q)
        .then(setHits)
        .catch((err: unknown) => setSearchError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false));
    },
    [onSearch, query],
  );

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-3">
      <header>
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-zinc-300">Lineage at scale</h2>
        <p className="mt-0.5 max-w-3xl text-[10px] text-zinc-500">
          A library this size has no single picture — mashups weld unrelated families into clusters tens of
          thousands of songs wide. Start from one song instead: search for it, or pick one below.
        </p>
      </header>

      <form onSubmit={runSearch} className="flex flex-wrap items-center gap-2">
        <label htmlFor={SEARCH_INPUT_ID} className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">
          Find a song
        </label>
        <input
          id={SEARCH_INPUT_ID}
          name={SEARCH_INPUT_ID}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="title…"
          className="w-64 rounded border border-white/10 bg-black/60 px-2 py-1 text-[11px] font-mono text-zinc-200 placeholder-zinc-600 focus:border-purple-400/60 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded border border-purple-500/30 bg-purple-500/15 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-purple-400/60 hover:text-white"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
        {searchError && <span className="text-[10px] text-rose-300">{searchError}</span>}
      </form>

      {hits !== null && (
        <section aria-label="Search results" className="rounded border border-white/10 bg-black/40">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[10px] italic text-zinc-500">No song matched that title.</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => onFocus(hit.id, hit.title)}
                    aria-label={`${hit.title}, ${entryProviderMeta({ model: hit.model, source: hit.source }).label}. Focus this song.`}
                    className="flex w-full items-center gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5"
                  >
                    <span className="min-w-0 grow truncate text-[11px] text-zinc-100">{hit.title}</span>
                    <ProviderBadge entry={{ model: hit.model, source: hit.source }} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {spec !== null ? (
        <LineageExplorer
          spec={spec}
          page={page}
          loading={listLoading}
          error={listError}
          q={listQuery}
          sort={sort}
          dir={dir}
          onQuery={(next) => {
            setListQuery(next);
            setOffset(0);
          }}
          onSort={(next) => {
            setSort(next);
            setOffset(0);
          }}
          onDir={(next) => {
            setDir(next);
            setOffset(0);
          }}
          onOffset={setOffset}
          onSpec={openList}
          onClose={() => setSpec(null)}
          onFocus={onFocus}
          onCopyId={copyId}
          onRetry={() => setReloads((n) => n + 1)}
        />
      ) : (
        <>
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-3">
          <p className="text-[10px] text-rose-200">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-white/25 hover:text-white"
          >
            Try again
          </button>
        </div>
      ) : summary === null ? (
        <p className="px-1 py-6 text-[10px] font-mono text-zinc-500">
          {loading ? 'Counting the library…' : 'No lineage summary yet.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {summaryHeadlines(summary).map((h) => {
              const target = specForHeadline(h.key);
              return (
                <Card
                  key={h.key}
                  label={h.label}
                  value={h.value}
                  hint={h.hint}
                  openLabel={
                    target ? `${h.label}: ${h.value}. Open ${exploreTitle(target)}.` : undefined
                  }
                  onOpen={target ? () => openList(target) : undefined}
                  extra={
                    h.key === 'entries' ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {SONG_SETS.map((set) => (
                          <button
                            key={set}
                            type="button"
                            aria-label={`Open ${exploreTitle({ list: 'songs', set })}`}
                            onClick={() => openList({ list: 'songs', set })}
                            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-purple-400/60 hover:text-white"
                          >
                            {set === 'standalone' ? 'standalone' : 'with lineage'}
                          </button>
                        ))}
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </div>

          <section aria-label="Relationship kinds" className="rounded border border-white/10 bg-black/40 px-3 py-2">
            <h3 className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">Relationship kinds</h3>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {kindRows(summary.by_kind).map(([kind, n]) => (
                <li key={kind}>
                  <button
                    type="button"
                    aria-label={`${relationWords(kind)}, ${formatCount(n)} links. Open ${exploreTitle({ list: 'kind', kind, role: 'any' })}.`}
                    onClick={() => openList({ list: 'kind', kind, role: 'any' })}
                    className="text-[10px] font-mono text-zinc-400 hover:text-white"
                  >
                    {relationWords(kind)}{' '}
                    <span className="tabular-nums text-zinc-200">{formatCount(n)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[9px] font-mono text-zinc-600">
              {formatCount(summary.links_raw)} stored links become {formatCount(summary.links_distinct)} drawn
              relationships — the same relationship is often recorded several times.
            </p>
          </section>
        </>
      )}

      {/* Any ranking, built by hand: the four presets below are four points in
          this space, and this row is the rest of it. */}
      <section
        aria-label="Rank any relationship"
        className="flex flex-wrap items-center gap-2 rounded border border-white/10 bg-black/40 px-3 py-2"
      >
        <h3 className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">
          Rank any relationship
        </h3>
        <label
          htmlFor={CUSTOM_KIND_ID}
          className="text-[9px] font-mono uppercase tracking-widest text-zinc-500"
        >
          Kind
        </label>
        <select
          id={CUSTOM_KIND_ID}
          name={CUSTOM_KIND_ID}
          value={customKind}
          onChange={(e) => setCustomKind(e.target.value)}
          className="rounded border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
        >
          <option value={KIND_ANY}>any relationship</option>
          {EXPLORE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {relationWords(kind)}
            </option>
          ))}
        </select>
        <label
          htmlFor={CUSTOM_ROLE_ID}
          className="text-[9px] font-mono uppercase tracking-widest text-zinc-500"
        >
          Role
        </label>
        <select
          id={CUSTOM_ROLE_ID}
          name={CUSTOM_ROLE_ID}
          value={customRole}
          onChange={(e) => setCustomRole(e.target.value === 'child' ? 'child' : 'parent')}
          className="rounded border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
        >
          <option value="parent">{ROLE_WORDS.parent}</option>
          <option value="child">{ROLE_WORDS.child}</option>
        </select>
        <button
          type="button"
          aria-label={`Open ${exploreTitle({ list: 'rankings', kind: customKind, role: customRole })}`}
          onClick={() => openList({ list: 'rankings', kind: customKind, role: customRole })}
          className="rounded border border-purple-500/30 bg-purple-500/15 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-purple-400/60 hover:text-white"
        >
          Open
        </button>
      </section>

      {/* The ranked lists are four independent requests and are rendered
          whatever the summary did: one failed count must not take away the
          four ways in. Each one's "More…" opens the same question without the
          preset's limit — except `deepest`, which no ranking over a kind and a
          role can ask (see `specForRanking`). */}
      <div className="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-2">
        {RANKING_LISTS.map((list) => {
          const more = specForRanking(list);
          return (
            <RankedList
              key={list}
              list={list}
              rows={rankings[list]}
              error={rankingErrors?.[list]}
              onFocus={onFocus}
              onMore={more ? () => openList(more) : undefined}
              moreLabel={more ? `Open ${exploreTitle(more)}` : undefined}
            />
          );
        })}
      </div>
        </>
      )}
    </div>
  );
};

export default LineageLanding;
