import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, LayoutGrid, List as ListIcon, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { HoverTip, InfoTip } from '../components/ui/Tooltip';
import { useLibraryStore } from '../state/libraryStore';
import { useCatalogueUiStore, selectSearchState } from './catalogueUiStore';
import {
  MATCH_MODES,
  MATCH_MODE_LABELS,
  SEARCH_TARGETS,
  SEARCH_TARGET_LABELS,
  SORT_OPTIONS,
  SORT_LABELS,
  type CatalogueMatchMode,
  type CatalogueSearchTarget,
  type CatalogueSortBy,
  type CatalogueSourceFilter,
  type CatalogueRatingFilter,
} from './catalogSearch';
import {
  entryProviderMeta,
  inferProvider,
  providerMeta,
  DEFAULT_PROVIDER_ORDER,
} from './catalogProviders';
import { facetOptionLabel, facetOptions, type LibraryFacetField } from '../lib/libraryFacets';

const SOURCES: CatalogueSourceFilter[] = ['all', 'generate', 'studio', 'import'];
const RATINGS: CatalogueRatingFilter[] = ['all', 'like', 'dislike', 'unrated'];

/**
 * The facet the backend counts for us. Model only, on purpose: a provider
 * count would have to be right for both halves of `inferProvider` (the slug
 * the backend detected AND the model/source derivation), and a number that is
 * wrong for imports is worse than no number. Provider options are named, not
 * counted — see `providers` below.
 */
const FACET_FIELDS: readonly LibraryFacetField[] = ['model'];

// CHANGED: tooltip copy. Each search MODE chip explains how the query is matched
// (mirrors the Advanced page's HoverTip granular-control pattern).
const MODE_TIPS: Record<CatalogueMatchMode, string> = {
  fuzzy:
    'Fuzzy — ignores punctuation, spaces and case. "lo-fi beat!" matches "lofi beat". Most forgiving; great default.',
  contains:
    'Contains — plain case-insensitive substring. The whole query (spaces included) must appear verbatim.',
  all_words:
    'All Words — every space-separated word must appear SOMEWHERE in the field, in any order.',
  in_order:
    'In Order — the words must appear left-to-right, gaps allowed. "deep bass" matches "deep sub bass".',
  exact:
    'Exact — the field must EQUAL the query (trimmed, case-insensitive). Best with a specific target like Title or ID.',
  regex:
    'Regex — your query is a JavaScript regular expression (case-insensitive). An invalid pattern matches nothing.',
};

const TARGET_TIP =
  'Search field — restrict the query to one field (Title, Lyrics, Style, Model, Tags, Notes, Seed, ID, …) or “All Fields” to search the entire record, including analysis + embedded tags.';
const SORT_TIP = 'Sort order for the result list — newest/oldest by created date, by length, or alphabetically by title.';
const FAVS_TIP = 'Toggle to show ONLY favorited tracks (the starred ones).';
const PROVIDER_TIP = 'Filter by provider — who made the track (Stable Audio, Suno, Udio, …), taken from what the file itself says when it says anything, and from the model + source otherwise. Applied by the server, so it searches the whole library, not just the rows on screen.';
const SOURCE_TIP = 'Filter by how the track entered the library: generated, studio render, or imported.';
const RATING_TIP = 'Filter by your thumbs rating: liked, disliked, or unrated.';
const MODEL_TIP = 'Filter to a single model. Every model in the library is listed, with how many entries use it — not just the models on the rows currently loaded.';
const LIST_TIP = 'List view — dense, virtualized rows. Scales to tens of thousands of tracks.';
const GRID_TIP = 'Grid view — visual card thumbnails. Best for smaller, browse-y sets.';

const SEARCH_INFO = `Robust catalogue search over the existing library — no extra index, just a live view.\n\nTwo dimensions combine:\n• FIELD — which field(s) the query runs against (the dropdown).\n• MODE — how the query is compared (the chips: Fuzzy / Contains / All Words / In Order / Exact / Regex).\n\n“All Fields” searches everything, including derived lyrics/style and the analysis + embedded-tag blobs. The text box is debounced so typing stays snappy.`;

interface Props {
  resultCount: number;
}

/**
 * CatalogueFilterBar — the search + filter header.
 *
 * The text input is locally debounced (~250ms) so typing doesn't re-run
 * `filterAndSort` over every keystroke; the committed value lives in
 * `catalogueUiStore`. Model/provider dropdown options are derived with
 * `useMemo` over the library `entries` — never inside a zustand selector,
 * which would return a fresh array each render and spin a render loop.
 */
export const CatalogueFilterBar: React.FC<Props> = ({ resultCount }) => {
  const entries = useLibraryStore((s) => s.entries);
  // Facets: the distinct values across the WHOLE library, not the loaded page.
  const facets = useLibraryStore((s) => s.facets);
  const libraryQuery = useLibraryStore((s) => s.searchQuery);
  const libraryKind = useLibraryStore((s) => s.kindFilter);
  const libraryFavorites = useLibraryStore((s) => s.onlyFavorites);
  const librarySource = useLibraryStore((s) => s.sourceFilter);
  const libraryRevision = useLibraryStore((s) => s.revision);
  const ensureFacets = useLibraryStore((s) => s.ensureFacets);

  // One request per (query, revision); the store answers the rest from its
  // cache, so re-opening a dropdown or re-sorting the list costs nothing.
  useEffect(() => {
    void ensureFacets(FACET_FIELDS);
  }, [ensureFacets, libraryQuery, libraryKind, libraryFavorites, librarySource, libraryRevision]);

  // CHANGED: was `useCatalogueUiStore()` (no selector) which subscribes to the
  // ENTIRE store and re-renders the bar on every unrelated change. Subscribe to
  // just the search slice via the shared `selectSearchState` selector wrapped in
  // `useShallow` so the reference stays stable when nothing relevant changed.
  const search = useCatalogueUiStore(useShallow(selectSearchState));
  const patchSearch = useCatalogueUiStore((s) => s.patchSearch);
  const viewMode = useCatalogueUiStore((s) => s.viewMode);
  const setViewMode = useCatalogueUiStore((s) => s.setViewMode);

  // Local, debounced mirror of the query so the input stays snappy.
  const [queryDraft, setQueryDraft] = useState(search.query);
  const debounceRef = useRef<number | null>(null);

  // Keep the draft in sync if the store query is reset externally.
  useEffect(() => {
    setQueryDraft(search.query);
    // Only when the committed query changes out from under us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.query]);

  const onQueryChange = (v: string) => {
    setQueryDraft(v);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      patchSearch({ query: v });
    }, 250);
  };

  // Derived dropdown option lists — computed downstream of the stable
  // `entries` / `facets` references, NOT inside a selector.
  //
  // The server's facet values come first, each with the number of entries it
  // matches across the whole library; the models on the rows in hand follow, so
  // a backend with no facets route (or one that has not answered yet) still
  // offers exactly what it used to.
  const models = useMemo(() => {
    const loaded = new Set<string>();
    for (const e of entries) if (e.model) loaded.add(e.model);
    return facetOptions(facets.model, Array.from(loaded).sort());
  }, [entries, facets]);

  // The provider options: the platforms we always offer, in their fixed
  // order, then every distinct provider on the rows in hand — the slug the
  // backend detected as readily as a derived one, because `inferProvider` is
  // the one answer for both — and finally whatever is selected, so the current
  // value always has an <option> to sit in. Nothing is invented: a name gets
  // here from this app's own registry or from an entry the backend sent.
  //
  // First label wins, so the list does not re-word itself as pages load.
  const providers = useMemo(() => {
    const labels = new Map<string, string>();
    for (const slug of DEFAULT_PROVIDER_ORDER) {
      if (!labels.has(slug)) labels.set(slug, providerMeta(slug).label);
    }
    for (const e of entries) {
      const slug = inferProvider(e);
      if (!labels.has(slug)) labels.set(slug, entryProviderMeta(e).label);
    }
    const selected = search.providerFilter;
    if (selected && !labels.has(selected)) {
      labels.set(selected, providerMeta(selected).label);
    }
    return Array.from(labels, ([value, label]) => ({ value, label }));
  }, [entries, search.providerFilter]);

  return (
    <div className="flex flex-col gap-2 px-2 pt-2 pb-1 border-b border-white/5 bg-[#0a080f]/60 shrink-0">
      {/* Search row */}
      <div className="flex items-center gap-2">
        {/* InfoTip explaining the whole search system (Advanced-page pattern). */}
        <div className="flex items-center shrink-0"><InfoTip title="Search" body={SEARCH_INFO} /></div>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600 pointer-events-none" />
          <input
            type="text"
            id="catalog-search"
            name="catalog-search"
            aria-label="Search catalogue"
            className="compact-input w-full pl-7 pr-7"
            placeholder="SEARCH CATALOGUE..."
            value={queryDraft}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {queryDraft && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-white"
              onClick={() => { setQueryDraft(''); patchSearch({ query: '' }); }}
              title="Clear"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <span className="text-[8px] font-mono text-zinc-600 whitespace-nowrap">{resultCount} RESULTS</span>
        <HoverTip text={LIST_TIP}>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600 hover:text-zinc-300'}`}
          >
            <ListIcon className="w-3 h-3" />
          </button>
        </HoverTip>
        <HoverTip text={GRID_TIP}>
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600 hover:text-zinc-300'}`}
          >
            <LayoutGrid className="w-3 h-3" />
          </button>
        </HoverTip>
      </div>

      {/* Match-mode chips + target dropdown */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {MATCH_MODES.map((m: CatalogueMatchMode) => (
            <HoverTip key={m} text={MODE_TIPS[m]}>
              <button
                className={`mono-tag whitespace-nowrap ${search.mode === m ? 'bg-purple-600/20! text-purple-300! border-purple-500/40!' : 'bg-white/5! text-zinc-500!'}`}
                onClick={() => patchSearch({ mode: m })}
              >
                {MATCH_MODE_LABELS[m]}
              </button>
            </HoverTip>
          ))}
        </div>
        <HoverTip text={TARGET_TIP}>
          <select
            id="catalog-search-target"
            name="catalog-search-target"
            aria-label="Search target"
            className="compact-input text-[9px]! py-0.5! bg-black/40"
            value={search.searchTarget}
            onChange={(e) => patchSearch({ searchTarget: e.target.value as CatalogueSearchTarget })}
          >
            {SEARCH_TARGETS.map((t) => (
              <option key={t} value={t}>{SEARCH_TARGET_LABELS[t]}</option>
            ))}
          </select>
        </HoverTip>
      </div>

      {/* Sort + filters */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
        <HoverTip text={FAVS_TIP}>
          <button
            className={`mono-tag flex items-center gap-1 whitespace-nowrap ${search.onlyFavorites ? 'bg-purple-600/20! text-purple-300! border-purple-500/40!' : 'bg-white/5! text-zinc-400!'}`}
            onClick={() => patchSearch({ onlyFavorites: !search.onlyFavorites })}
          >
            <Star className="w-2 h-2 fill-current" /> FAVS
          </button>
        </HoverTip>

        <HoverTip text={SORT_TIP}>
          <select
            id="catalog-sort-by"
            name="catalog-sort-by"
            aria-label="Sort by"
            className="compact-input text-[9px]! py-0.5! bg-black/40"
            value={search.sortBy}
            onChange={(e) => patchSearch({ sortBy: e.target.value as CatalogueSortBy })}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s} value={s}>{SORT_LABELS[s].toUpperCase()}</option>
            ))}
          </select>
        </HoverTip>

        <HoverTip text={PROVIDER_TIP}>
          <div className="flex items-center">
            {/* Native select → a real <label htmlFor>, visually hidden because
                the bar is icon-dense. A labelled native control needs no
                aria-label on top (see PermissionModeSelect.test.tsx). */}
            <label htmlFor="catalog-filter-provider" className="sr-only">
              Filter by provider
            </label>
            <select
              id="catalog-filter-provider"
              name="catalog-filter-provider"
              className="compact-input text-[9px]! py-0.5! bg-black/40"
              value={search.providerFilter ?? ''}
              onChange={(e) => patchSearch({ providerFilter: e.target.value || null })}
            >
              <option value="">ALL PROVIDERS</option>
              {providers.map((p) => (
                <option key={p.value} value={p.value}>{p.label.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </HoverTip>

        <HoverTip text={SOURCE_TIP}>
          <select
            id="catalog-filter-source"
            name="catalog-filter-source"
            aria-label="Filter by source"
            className="compact-input text-[9px]! py-0.5! bg-black/40"
            value={search.sourceFilter}
            onChange={(e) => patchSearch({ sourceFilter: e.target.value as CatalogueSourceFilter })}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s === 'all' ? 'ALL SOURCES' : s.toUpperCase()}</option>
            ))}
          </select>
        </HoverTip>

        <HoverTip text={RATING_TIP}>
          <select
            id="catalog-filter-rating"
            name="catalog-filter-rating"
            aria-label="Filter by rating"
            className="compact-input text-[9px]! py-0.5! bg-black/40"
            value={search.ratingFilter}
            onChange={(e) => patchSearch({ ratingFilter: e.target.value as CatalogueRatingFilter })}
          >
            {RATINGS.map((r) => (
              <option key={r} value={r}>{r === 'all' ? 'ALL RATINGS' : r.toUpperCase()}</option>
            ))}
          </select>
        </HoverTip>

        {models.length > 0 && (
          <HoverTip text={MODEL_TIP}>
            <select
              id="catalog-filter-model"
              name="catalog-filter-model"
              aria-label="Filter by model"
              className="compact-input text-[9px]! py-0.5! bg-black/40"
              value={search.modelFilter ?? ''}
              onChange={(e) => patchSearch({ modelFilter: e.target.value || null })}
            >
              <option value="">ALL MODELS</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>{facetOptionLabel(m)}</option>
              ))}
            </select>
          </HoverTip>
        )}
      </div>
    </div>
  );
};
