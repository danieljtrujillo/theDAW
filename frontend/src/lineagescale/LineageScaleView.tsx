import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LIBRARY_QUERY, fetchLibraryList } from '../lib/backendLocalProvider';
import { FocusGraph } from './FocusGraph';
import { LineageLanding, type SearchHit } from './LineageLanding';
import { RelativesPanel } from './RelativesPanel';
import {
  DEPTH_MAX, DEPTH_MIN, RANKING_LISTS,
  fetchLineageSummary, fetchNeighbourhood, fetchRankings,
  type LineageSummary, type NeighbourGroup, type Neighbourhood,
  type RankingList, type RankingRow, type RelativesRequest,
} from './lineageScaleClient';
import {
  canGoBack, currentCrumb, formatCount, groupHeading, nodeTitle, popCrumb, pushCrumb,
  relativesRequestForNode, standsAlone, type Crumb,
} from './lineageScaleModel';

/**
 * LineageScaleView — lineage for a library that cannot be drawn.
 *
 * The old view asked for the whole graph and drew it. On the real library that
 * is 194,833 nodes, 475,174 links and a 128 MB answer, and the page dies. This
 * one never asks for the library at all: a landing page of counted summaries
 * and ranked lists, and then ONE song's neighbourhood at a time, bounded by a
 * budget the server enforces.
 *
 * Nothing in here touches the old view, its route, or its tab. It is a second
 * way to read the same relationships, built for the size they actually are.
 */

/**
 * The classic graph, for ONE song. Lazy for the reason the LEARN host is:
 * this module is large and pulls the force-graph engines behind it, so it is
 * not so much as fetched until the user asks for this song's picture.
 */
const ClassicPerTrackGraph = lazy(() =>
  import('../components/library/LineageModal').then((m) => ({ default: m.LineageModal })),
);

/**
 * What the "Classic graph" action mounts: the classic view rooted at the song
 * in focus, inside this tab, with the two whole-library tabs refused — that
 * drawing is the one this view exists because the library cannot take.
 *
 * Exported so the LEARN tab's test can construct that element and show it CAN
 * be drawn on a library where the whole-library one cannot.
 */
export const classicPerTrackProps = (focusId: string, visible = true) => ({
  open: true,
  mode: 'embedded' as const,
  visible,
  rootEntryId: focusId,
  wholeLibraryAllowed: false,
});

/**
 * The header action that opens — and closes — the classic graph of the song
 * in focus. It reports `aria-pressed`, so it has to be able to un-press:
 * a toggle that only ever goes one way lies to anything reading that state.
 */
export const ClassicGraphAction: React.FC<{
  label: string;
  open: boolean;
  onToggle: () => void;
}> = ({ label, open, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-label={`Classic graph for ${label}`}
    aria-pressed={open}
    title="The classic lineage graph of this song's own family"
    className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
  >
    Classic graph
  </button>
);

const SEARCH_LIMIT = 20;
const BUDGETS = [100, 200, 400, 800, 1500] as const;
const DEPTHS: number[] = [];
for (let d = DEPTH_MIN; d <= DEPTH_MAX; d += 1) DEPTHS.push(d);

/** Title search through the library's OWN paged endpoint — one page of rows,
 *  never the library. */
export async function searchLibraryTitles(query: string, limit = SEARCH_LIMIT): Promise<SearchHit[]> {
  const result = await fetchLibraryList({ ...DEFAULT_LIBRARY_QUERY, kind: 'all', q: query }, 0, limit);
  const rows = result.page?.entries ?? result.entries ?? [];
  const hits: SearchHit[] = [];
  for (let i = 0; i < rows.length && hits.length < limit; i += 1) {
    const row = rows[i];
    hits.push({ id: row.id, title: nodeTitle({ id: row.id, title: row.title ?? '' }), model: row.model, source: row.source });
  }
  return hits;
}

export interface GraphPaneProps {
  /** The neighbourhood, or null while nothing has been read yet. */
  data: Neighbourhood | null;
  focusId: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onHome: () => void;
  onFocusNode: (id: string, title: string) => void;
  onOpenGroup: (group: NeighbourGroup) => void;
}

/**
 * The graph half of the focus view, as a function of what is known — so each
 * of its four states is a render test rather than a browser (the same shape as
 * `LearnHostSurface` and `RelativesPanelBody`).
 *
 * The "stands alone" caption is `standsAlone`, not a node count: see that
 * function. A hub whose whole family is folded has one node and a pile of
 * groups, and captioning it "stands alone" hid the groups it did have.
 */
export const GraphPane: React.FC<GraphPaneProps> = ({
  data, focusId, loading, error, onRetry, onHome, onFocusNode, onOpenGroup,
}) => {
  if (error) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[11px] text-rose-300">{error}</p>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-white/25 hover:text-white"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onHome}
            className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100"
          >
            All songs
          </button>
        </span>
      </div>
    );
  }
  if (data === null) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
        {loading ? 'Loading…' : 'Nothing to draw.'}
      </p>
    );
  }
  if (standsAlone(data)) {
    return (
      <p className="absolute inset-0 flex items-center justify-center px-12 text-center text-[10px] italic text-zinc-500">
        This song stands alone — nothing was made from it, and it was made from nothing in this library.
      </p>
    );
  }
  return <FocusGraph data={data} focusId={focusId} onFocusNode={onFocusNode} onOpenGroup={onOpenGroup} />;
};

export interface LineageScaleViewProps {
  /** False while the tab is mounted but hidden: nothing is fetched then. */
  visible?: boolean;
  /**
   * Open straight onto one song instead of the landing page — what the LEARN
   * host passes when the tab was entered from a particular entry. The id is
   * all that is known at that moment, so it stands in as the crumb's title
   * until the neighbourhood comes back with the real one.
   */
  rootEntryId?: string | null;
}

export const LineageScaleView: React.FC<LineageScaleViewProps> = ({ visible = true, rootEntryId = null }) => {
  const [trail, setTrail] = useState<Crumb[]>(
    () => (rootEntryId ? [{ id: rootEntryId, title: rootEntryId }] : []),
  );
  const [up, setUp] = useState(2);
  const [down, setDown] = useState(1);
  const [budget, setBudget] = useState<number>(400);

  const [summary, setSummary] = useState<LineageSummary | null>(null);
  const [rankings, setRankings] = useState<Partial<Record<RankingList, RankingRow[]>>>({});
  const [rankingErrors, setRankingErrors] = useState<Partial<Record<RankingList, string>>>({});
  const [landingError, setLandingError] = useState<string | null>(null);
  const [landingLoading, setLandingLoading] = useState(false);
  const [landingAttempt, setLandingAttempt] = useState(0);

  const [data, setData] = useState<Neighbourhood | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphAttempt, setGraphAttempt] = useState(0);

  const [panel, setPanel] = useState<{ heading: string; request: RelativesRequest } | null>(null);
  // The classic per-track graph, open over this view's body. It is state and
  // not a route so that closing it lands back on exactly this focus.
  const [classicOpen, setClassicOpen] = useState(false);

  const crumb = currentCrumb(trail);
  const focusId = crumb?.id ?? null;

  // A new `rootEntryId` is the host saying "open THIS song". It walks the trail
  // like any other focus, so Back still works afterwards.
  useEffect(() => {
    if (!rootEntryId) return;
    setTrail((cur) => (currentCrumb(cur)?.id === rootEntryId
      ? cur
      : pushCrumb(cur, { id: rootEntryId, title: rootEntryId })));
  }, [rootEntryId]);

  /* ───────────────────────────── the landing page ──────────────────────── */
  useEffect(() => {
    if (!visible) return undefined;
    if (summary !== null && landingAttempt === 0) return undefined;
    let live = true;
    setLandingLoading(true);
    setLandingError(null);
    fetchLineageSummary()
      .then((s) => {
        if (live) setSummary(s);
      })
      .catch((e: unknown) => {
        if (live) setLandingError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLandingLoading(false);
      });
    for (const list of RANKING_LISTS) {
      fetchRankings(list, 50)
        .then((r) => {
          if (live) setRankings((cur) => ({ ...cur, [list]: r.rows }));
        })
        .catch((e: unknown) => {
          if (live) setRankingErrors((cur) => ({ ...cur, [list]: e instanceof Error ? e.message : String(e) }));
        });
    }
    return () => {
      live = false;
    };
    // `summary` is read but deliberately not a dependency: this effect is the
    // thing that sets it, and re-running on its own result would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, landingAttempt]);

  /* ───────────────────────────── the focus view ────────────────────────── */
  useEffect(() => {
    if (!visible || !focusId) return undefined;
    let live = true;
    setGraphLoading(true);
    setGraphError(null);
    fetchNeighbourhood(focusId, { up, down, budget })
      .then((n) => {
        if (live) setData(n);
      })
      .catch((e: unknown) => {
        if (live) {
          setData(null);
          setGraphError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (live) setGraphLoading(false);
      });
    return () => {
      live = false;
    };
  }, [visible, focusId, up, down, budget, graphAttempt]);

  // A song opened by id alone is crumbed under its id; the answer carries the
  // real title, so the crumb is corrected once — never on every render.
  useEffect(() => {
    if (!data || !focusId) return;
    const focusNode = data.nodes.find((n) => n.id === focusId);
    const title = focusNode ? nodeTitle(focusNode) : null;
    if (!title || title === crumb?.title) return;
    setTrail((cur) => (currentCrumb(cur)?.id === focusId ? pushCrumb(cur, { id: focusId, title }) : cur));
  }, [data, focusId, crumb?.title]);

  const focusSong = useCallback((id: string, title: string) => {
    setPanel(null);
    setTrail((cur) => pushCrumb(cur, { id, title }));
  }, []);

  const goBack = useCallback(() => {
    setPanel(null);
    setTrail((cur) => popCrumb(cur));
  }, []);

  const goHome = useCallback(() => {
    setPanel(null);
    setClassicOpen(false);
    setData(null);
    setTrail([]);
  }, []);

  const openGroup = useCallback(
    (group: NeighbourGroup) => {
      const parentTitle = data
        ? nodeTitle(data.nodes.find((n) => n.id === group.parent_id) ?? { id: group.parent_id, title: '' })
        : group.parent_id;
      setPanel({
        heading: groupHeading(group, parentTitle),
        request: {
          entryId: group.parent_id,
          direction: group.direction,
          kind: group.kind,
          sort: 'title',
          offset: 0,
          limit: 100,
        },
      });
    },
    [data],
  );

  const openAllRelatives = useCallback(
    (direction: 'up' | 'down') => {
      if (!focusId) return;
      const title = crumb?.title ?? focusId;
      setPanel({
        heading: `${direction === 'up' ? 'Sources of' : 'Derivatives of'} ${title}`,
        request: relativesRequestForNode(focusId, direction),
      });
    },
    [crumb, focusId],
  );

  /* The two library actions this view borrows. Imported at click time so the
   * player and the library store are not pulled into this tab's bundle (and
   * not constructed at all for a user who never clicks them). */
  const playFocus = useCallback(() => {
    if (!focusId) return;
    void import('../state/playlistQueue').then(({ startQueue }) => startQueue([focusId]));
  }, [focusId]);

  const openInLibrary = useCallback(() => {
    if (!focusId) return;
    void import('../state/libraryStore').then(({ useLibraryStore }) =>
      useLibraryStore.getState().setSelectedEntry(focusId),
    );
  }, [focusId]);

  const onSearch = useCallback((q: string) => searchLibraryTitles(q), []);

  const counts = useMemo(() => {
    if (!data) return null;
    let sources = 0;
    let derivatives = 0;
    for (const n of data.nodes) {
      if (n.generation < 0) sources += 1;
      else if (n.generation > 0) derivatives += 1;
    }
    return { sources, derivatives, groups: data.groups.length };
  }, [data]);

  if (!focusId) {
    return (
      <div className="h-full w-full bg-black/20 text-zinc-200">
        <LineageLanding
          summary={summary}
          rankings={rankings}
          rankingErrors={rankingErrors}
          loading={landingLoading}
          error={landingError}
          onRetry={() => setLandingAttempt((n) => n + 1)}
          onFocus={focusSong}
          onSearch={onSearch}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-black/20 text-zinc-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <button
          type="button"
          onClick={goHome}
          aria-label="Back to the lineage landing page"
          className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100"
        >
          All songs
        </button>
        <button
          type="button"
          onClick={goBack}
          disabled={!canGoBack(trail)}
          aria-label="Back to the previously focused song"
          className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100 disabled:opacity-40"
        >
          Back
        </button>

        <nav aria-label="Focused songs" className="flex min-w-0 grow items-center gap-1 overflow-x-auto">
          {trail.map((c, i) => (
            <span key={`${c.id}-${i}`} className="flex shrink-0 items-center gap-1">
              {i > 0 && <span className="text-[9px] text-zinc-600">›</span>}
              <button
                type="button"
                onClick={() => focusSong(c.id, c.title)}
                aria-current={i === trail.length - 1 ? 'true' : undefined}
                aria-label={`Focus ${c.title}`}
                className={`max-w-56 truncate rounded px-1.5 py-0.5 text-[10px] ${
                  i === trail.length - 1 ? 'bg-purple-500/15 text-purple-100' : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {c.title}
              </button>
            </span>
          ))}
        </nav>

        <span className="flex items-center gap-1">
          <label htmlFor="lineage-scale-up" className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">
            Up
          </label>
          <select
            id="lineage-scale-up"
            name="lineage-scale-up"
            value={up}
            onChange={(e) => setUp(Number(e.target.value))}
            className="rounded border border-white/10 bg-black/60 px-1 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
          >
            {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          <label htmlFor="lineage-scale-down" className="ml-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500">
            Down
          </label>
          <select
            id="lineage-scale-down"
            name="lineage-scale-down"
            value={down}
            onChange={(e) => setDown(Number(e.target.value))}
            className="rounded border border-white/10 bg-black/60 px-1 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
          >
            {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          <label htmlFor="lineage-scale-budget" className="ml-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500">
            Budget
          </label>
          <select
            id="lineage-scale-budget"
            name="lineage-scale-budget"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            className="rounded border border-white/10 bg-black/60 px-1 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none"
          >
            {BUDGETS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </span>

        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={playFocus}
            aria-label={`Play ${crumb?.title ?? focusId}`}
            className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
          >
            Play
          </button>
          <button
            type="button"
            onClick={openInLibrary}
            aria-label={`Open ${crumb?.title ?? focusId} in the library`}
            className="rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
          >
            In library
          </button>
          <ClassicGraphAction
            label={crumb?.title ?? focusId}
            open={classicOpen}
            onToggle={() => setClassicOpen((v) => !v)}
          />
        </span>
      </header>

      {classicOpen ? (
        <div className="flex min-h-0 grow flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1">
            <p className="grow truncate text-[9px] font-mono text-zinc-500">
              {`The classic graph of ${crumb?.title ?? focusId} and its own family.`}
            </p>
            <button
              type="button"
              onClick={() => setClassicOpen(false)}
              aria-label="Back to the lineage view"
              className="rounded border border-white/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100"
            >
              Back to lineage
            </button>
          </div>
          <div className="relative min-h-0 grow">
            <Suspense
              fallback={
                <p className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
                  Loading the classic graph…
                </p>
              }
            >
              <ClassicPerTrackGraph
                {...classicPerTrackProps(focusId, visible)}
                onClose={() => setClassicOpen(false)}
              />
            </Suspense>
          </div>
        </div>
      ) : (
      <>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1">
        <p className="grow text-[9px] font-mono text-zinc-500">
          {graphLoading
            ? 'Reading this song’s neighbourhood…'
            : counts
              ? `${formatCount(counts.sources)} sources · ${formatCount(counts.derivatives)} derivatives · ${formatCount(counts.groups)} folded groups`
              : ''}
        </p>
        <button
          type="button"
          onClick={() => openAllRelatives('up')}
          className="rounded border border-white/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100"
        >
          List sources
        </button>
        <button
          type="button"
          onClick={() => openAllRelatives('down')}
          className="rounded border border-white/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:border-white/25 hover:text-zinc-100"
        >
          List derivatives
        </button>
      </div>

      <div className="flex min-h-0 grow">
        <div className="relative min-w-0 grow">
          <GraphPane
            data={data}
            focusId={focusId}
            loading={graphLoading}
            error={graphError}
            onRetry={() => setGraphAttempt((n) => n + 1)}
            onHome={goHome}
            onFocusNode={focusSong}
            onOpenGroup={openGroup}
          />
        </div>

        {panel && (
          <div className="w-96 shrink-0">
            <RelativesPanel
              heading={panel.heading}
              request={panel.request}
              onFocus={focusSong}
              onClose={() => setPanel(null)}
            />
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
};

export default LineageScaleView;
