/**
 * catalogSearch: the provider half of the Catalogue's search, and the ONE
 * path that pushes a Catalogue state into the library store.
 *
 * What it pins:
 *   * the `provider` target and the `all` haystack match the entry's one
 *     provider by ID and by DISPLAY LABEL, so typing "bandcamp" or "Apple
 *     Music" finds the rows the badge says those words on;
 *   * the provider filter accepts a detected slug and a derived one alike —
 *     one dropdown, one id space;
 *   * a provider filter no longer forces the client-side pass: the server
 *     applies `provider=`, so `isServerOnly` stays true and the whole library
 *     is searched rather than the rows in hand;
 *   * `applyCatalogueServerQuery` sets the provider on the library store
 *     alongside the text/favourites/sort/source it already set, and CLEARS it
 *     again — the single sync path behind the single dropdown.
 *
 *   cd frontend && npx tsx src/catalog/catalogSearch.test.ts
 */
import assert from 'node:assert/strict';
import type { LibraryEntry } from '../state/libraryEntry.ts';
import {
  applyCatalogueServerQuery,
  catalogueServerQuery,
  filterAndSort,
  isServerOnly,
  DEFAULT_SEARCH_STATE,
  type CatalogueLibrarySink,
  type CatalogueSearchState,
  type CatalogueSortBy,
} from './catalogSearch.ts';
import { selectSearchState, useCatalogueUiStore } from './catalogueUiStore.ts';

const entry = (over: Partial<LibraryEntry> & { id: string }): LibraryEntry => ({
  title: `track ${over.id}`,
  prompt: '',
  negativePrompt: '',
  model: 'sa3',
  duration: 30,
  steps: 8,
  cfg: 1,
  seed: 0,
  audioUrl: `/api/library/audio/${over.id}`,
  audioFilename: `${over.id}.wav`,
  fileSizeBytes: 1,
  mimeType: 'audio/wav',
  timestamp: '2026-09-20T00:00:00Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  lyrics: '',
  source: 'generate',
  ...over,
});

const state = (over: Partial<CatalogueSearchState> = {}): CatalogueSearchState => ({
  ...DEFAULT_SEARCH_STATE,
  ...over,
});

// A detected provider the derivation could never guess, on a row whose model
// says nothing about it; a native generation; an import.
const rows: LibraryEntry[] = [
  entry({ id: 'a', provider: 'bandcamp', providerLabel: 'Bandcamp', providerIsAi: false, model: 'import', source: 'import' }),
  entry({ id: 'b', provider: 'apple-music', model: 'import', source: 'import' }),
  entry({ id: 'c', model: 'sa3', source: 'generate' }),
  entry({ id: 'd', model: 'suno' }),
];

const ids = (list: LibraryEntry[]): string[] => list.map((e) => e.id).sort();

// ── the text search reaches the provider's label AND its id ─────────────────
{
  assert.deepEqual(
    ids(filterAndSort(rows, state({ query: 'bandcamp', searchTarget: 'provider' }))),
    ['a'],
    'the detected slug is searchable',
  );
  assert.deepEqual(
    ids(filterAndSort(rows, state({ query: 'Apple Music', searchTarget: 'provider', mode: 'contains' }))),
    ['b'],
    'and so is the LABEL of a provider whose slug is hyphenated',
  );
  assert.deepEqual(
    ids(filterAndSort(rows, state({ query: 'stable audio', searchTarget: 'provider', mode: 'contains' }))),
    ['c'],
    'a derived provider is searchable by its label too',
  );
  // The whole-record haystack carries the same text.
  assert.deepEqual(
    ids(filterAndSort(rows, state({ query: 'Apple Music', mode: 'contains' }))),
    ['b'],
    'the "all" haystack includes the provider label',
  );
  assert.deepEqual(
    ids(filterAndSort(rows, state({ query: 'bandcamp' }))),
    ['a'],
    'and the slug',
  );
}

// ── the filter matches detected and derived ids through one dropdown ────────
{
  assert.deepEqual(ids(filterAndSort(rows, state({ providerFilter: 'bandcamp' }))), ['a']);
  assert.deepEqual(ids(filterAndSort(rows, state({ providerFilter: 'apple-music' }))), ['b']);
  assert.deepEqual(
    ids(filterAndSort(rows, state({ providerFilter: 'stable-audio' }))),
    ['c'],
    'the import that carries a detected provider is NOT stable-audio any more',
  );
  assert.deepEqual(ids(filterAndSort(rows, state({ providerFilter: 'suno' }))), ['d']);
  assert.deepEqual(
    ids(filterAndSort(rows, state({ providerFilter: 'import' }))),
    [],
    'both imports here were claimed by a detected provider',
  );
  assert.deepEqual(
    ids(filterAndSort(rows, state({ providerFilter: null }))),
    ['a', 'b', 'c', 'd'],
    'no filter keeps every row',
  );
}

// ── the server applies the provider filter now ──────────────────────────────
{
  assert.equal(isServerOnly(state()), true, 'a bare state is server-only');
  assert.equal(
    isServerOnly(state({ providerFilter: 'suno' })),
    true,
    'a provider filter no longer forces a client-side pass over loaded rows',
  );
  assert.equal(isServerOnly(state({ modelFilter: 'sa3' })), false, 'an exact model still does');
  assert.equal(isServerOnly(state({ ratingFilter: 'like' })), false);
  assert.equal(isServerOnly(state({ mode: 'regex' })), false);

  assert.equal(catalogueServerQuery(state({ providerFilter: 'suno' })).provider, 'suno');
  assert.equal(catalogueServerQuery(state()).provider, null, 'no filter sends no provider');
  assert.equal(
    catalogueServerQuery(state({ providerFilter: '' })).provider,
    null,
    'an empty selection is not a filter',
  );
}

// ── the one sync path: both stores set, both cleared ────────────────────────
{
  interface Recorded {
    q: string[];
    favorites: boolean[];
    sort: CatalogueSortBy[];
    source: (string | null)[];
    provider: (string | null)[];
  }
  const seen: Recorded = { q: [], favorites: [], sort: [], source: [], provider: [] };
  const lib: CatalogueLibrarySink = {
    searchQuery: '',
    setSearchQuery: (q) => { seen.q.push(q); },
    setOnlyFavorites: (v) => { seen.favorites.push(v); },
    setSortBy: (s) => { seen.sort.push(s); },
    setSourceFilter: (s) => { seen.source.push(s); },
    setProviderFilter: (p) => { seen.provider.push(p); },
  };

  // The dropdown's own onChange: it patches the Catalogue's UI store, which is
  // what the client-side pass reads.
  const ui = useCatalogueUiStore.getState();
  ui.resetSearch();
  ui.patchSearch({ providerFilter: 'suno' });
  assert.equal(
    useCatalogueUiStore.getState().providerFilter,
    'suno',
    'the Catalogue store holds the selection',
  );

  // The effect then pushes that state at the library store — server side.
  applyCatalogueServerQuery(selectSearchState(useCatalogueUiStore.getState()), lib);
  assert.deepEqual(seen.provider, ['suno'], 'the library store is told to filter by provider');
  assert.deepEqual(seen.source, [null], 'the filters it already carried still go with it');
  assert.deepEqual(seen.favorites, [false]);
  assert.deepEqual(seen.sort, ['newest']);
  assert.deepEqual(seen.q, [], 'an unchanged query is not re-set: the store debounces it');

  // Clearing the dropdown clears BOTH.
  useCatalogueUiStore.getState().patchSearch({ providerFilter: null });
  assert.equal(useCatalogueUiStore.getState().providerFilter, null);
  applyCatalogueServerQuery(selectSearchState(useCatalogueUiStore.getState()), lib);
  assert.deepEqual(seen.provider, ['suno', null], 'and the server filter is cleared too');

  // A whole state change goes through the same call, not through the select.
  useCatalogueUiStore.getState().patchSearch({
    providerFilter: 'apple-music',
    sourceFilter: 'import',
    onlyFavorites: true,
    sortBy: 'title',
    query: 'amen',
  });
  applyCatalogueServerQuery(selectSearchState(useCatalogueUiStore.getState()), lib);
  assert.deepEqual(seen.provider, ['suno', null, 'apple-music']);
  assert.deepEqual(seen.source, [null, null, 'import']);
  assert.deepEqual(seen.favorites, [false, false, true]);
  assert.deepEqual(seen.sort, ['newest', 'newest', 'title']);
  assert.deepEqual(seen.q, ['amen'], 'a query that actually changed IS set');
  useCatalogueUiStore.getState().resetSearch();
}

console.log('catalogSearch: one provider id searched, filtered and synced');
