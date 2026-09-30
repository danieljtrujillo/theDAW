/**
 * The facets client call and the store's facet cache.
 *
 * Pins: the request carries the SAME filters as the page query (and not the
 * sort); an answer is cached per (fields, query, revision) so re-opening a
 * dropdown costs nothing; a backend without the route answers null ONCE and is
 * never asked again in that session, which is what lets the filter bar fall
 * back to the rows in hand.
 *
 * Run: `npx tsx src/lib/libraryFacetsClient.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { fetchLibraryFacets, fetchLibraryMatchCount } from './backendLocalProvider.ts';
import { useLibraryStore } from '../state/libraryStore.ts';
import { useLibraryCounts } from '../state/libraryCountsStore.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);
const calls: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  return handler(url, init);
}) as typeof fetch;

const rec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  prompt: '',
  negative_prompt: '',
  model: 'sa3',
  duration: 1,
  steps: 1,
  cfg: 1,
  seed: 1,
  audio_url: `/api/library/audio/${id}`,
  audio_filename: `${id}.wav`,
  file_size_bytes: 1,
  mime_type: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
  ...over,
});

const summary = (revision: number) =>
  jsonResponse({ revision, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

const facetBody = {
  facets: {
    model: [
      { value: 'sa3', count: 1234 },
      { value: 'suno-v4', count: 12 },
    ],
    provider: [{ value: 'stable-audio', count: 1246 }],
  },
  revision: 9,
};

const reset = (): void => {
  calls.length = 0;
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sourceFilter: null, kindFilter: 'audio' });
  useLibraryStore.getState().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

// ── The request shape ──────────────────────────────────────────────────────
{
  reset();
  handler = async () => jsonResponse(facetBody);

  const answer = await fetchLibraryFacets(['model', 'provider'], {
    q: ' amen  ',
    sort: 'title_asc',
    kind: 'media',
    favorite: true,
    source: 'import',
    provider: null,
  });

  assert.ok(answer, 'a 200 answers with the facets');
  assert.equal(answer.revision, 9);
  assert.deepEqual(answer.facets.model, facetBody.facets.model);

  const url = new URL(calls[0], 'http://local');
  assert.equal(url.pathname, '/api/library/entries/facets');
  assert.equal(url.searchParams.get('fields'), 'model,provider');
  assert.equal(url.searchParams.get('q'), 'amen', 'the search is trimmed, exactly as the page query trims it');
  assert.equal(url.searchParams.get('kind'), 'media');
  assert.equal(url.searchParams.get('favorite'), 'true');
  assert.equal(url.searchParams.get('source'), 'import');
  assert.equal(url.searchParams.get('sort'), null, 'the sort cannot move a count, so it is not sent');
}

// ── An old backend ─────────────────────────────────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ detail: 'Not Found' }, 404);
  const answer = await fetchLibraryFacets(['model'], {
    q: '', sort: 'created_desc', kind: 'audio', favorite: null, source: null, provider: null,
  });
  assert.equal(answer, null, 'a missing route is null, not a thrown error');
}

// ── A malformed answer is refused rather than half-rendered ────────────────
{
  reset();
  handler = async () => jsonResponse({ facets: { model: 'not-a-list' }, revision: 'soon' });
  const answer = await fetchLibraryFacets(['model'], {
    q: '', sort: 'created_desc', kind: 'audio', favorite: null, source: null, provider: null,
  });
  assert.ok(answer, 'the envelope still parses');
  assert.deepEqual(answer.facets.model, [], 'a field that is not a list of values is empty, never garbage');
  assert.equal(answer.revision, 0, 'and a non-numeric revision reads as "unknown"');
}

// ── The match count rides on the paged list ────────────────────────────────
{
  reset();
  handler = async (url) => {
    if (isEntriesList(url)) return jsonResponse({ entries: [rec('a')], total: 4321, offset: 0, limit: 1, revision: 9 });
    return jsonResponse({}, 404);
  };
  const count = await fetchLibraryMatchCount({
    q: '', sort: 'created_desc', kind: 'audio', favorite: true, source: null, provider: null,
  });
  assert.equal(count, 4321, 'the server total IS the count');
  const url = new URL(calls[0], 'http://local');
  assert.equal(url.searchParams.get('limit'), '1', 'and it costs one row, not a page');
}

// ── The store caches per (fields, query, revision) ─────────────────────────
{
  reset();
  let facetCalls = 0;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(9);
    if (url.startsWith('/api/library/entries/facets')) {
      facetCalls += 1;
      return jsonResponse(facetBody);
    }
    if (isEntriesList(url)) {
      return jsonResponse({ entries: [rec('a')], total: 1, offset: 0, limit: 200, revision: 9 });
    }
    return jsonResponse({}, 404);
  };

  await useLibraryStore.getState().load();
  await useLibraryStore.getState().ensureFacets(['model', 'provider']);
  assert.equal(facetCalls, 1);
  assert.deepEqual(
    useLibraryStore.getState().facets.model?.map((v) => v.value),
    ['sa3', 'suno-v4'],
    'the answer is on the store for the filter bar to read',
  );

  await useLibraryStore.getState().ensureFacets(['model', 'provider']);
  await useLibraryStore.getState().ensureFacets(['provider', 'model']);
  assert.equal(facetCalls, 1, 'the same question at the same revision is answered from the cache');

  // A different query is a different question.
  useLibraryStore.setState({ onlyFavorites: true });
  await useLibraryStore.getState().ensureFacets(['model', 'provider']);
  assert.equal(facetCalls, 2, 'changing a filter asks again');
}

// ── A backend without the route is asked exactly once ──────────────────────
{
  reset();
  let facetCalls = 0;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(9);
    if (url.startsWith('/api/library/entries/facets')) {
      facetCalls += 1;
      return jsonResponse({ detail: 'Not Found' }, 404);
    }
    if (isEntriesList(url)) {
      return jsonResponse({ entries: [rec('a')], total: 1, offset: 0, limit: 200, revision: 9 });
    }
    return jsonResponse({}, 404);
  };

  await useLibraryStore.getState().load();
  await useLibraryStore.getState().ensureFacets(['model']);
  assert.equal(useLibraryStore.getState().facetsSupported, false, 'the store records that there are no facets');
  useLibraryStore.setState({ onlyFavorites: true });
  await useLibraryStore.getState().ensureFacets(['model']);
  assert.equal(facetCalls, 1, 'and never asks again, however the query moves');
  assert.deepEqual(useLibraryStore.getState().facets, {}, 'with no facets to show');
}

console.log('libraryFacetsClient: ok');
