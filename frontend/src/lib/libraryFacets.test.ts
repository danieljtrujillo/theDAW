/**
 * Facet cache keys and dropdown options, under plain node.
 *
 * Pins: the cache key changes with every part of the query that changes the
 * answer and with the library revision (but NOT with the sort order, which
 * cannot move a count); options carry the server's counts, fall back to plain
 * values when the endpoint is not there, and never lose a value the caller
 * already knows about.
 *
 * Run: `npx tsx src/lib/libraryFacets.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import {
  facetCacheKey,
  facetOptionLabel,
  facetOptions,
  type LibraryFacetQuery,
  type LibraryFacetValue,
} from './libraryFacets.ts';

const query = (over: Partial<LibraryFacetQuery> = {}): LibraryFacetQuery => ({
  q: '',
  kind: 'audio',
  favorite: null,
  source: null,
  provider: null,
  ...over,
});

// ── The key ────────────────────────────────────────────────────────────────
{
  const base = facetCacheKey(['model'], query(), 7);
  assert.equal(base, facetCacheKey(['model'], query(), 7), 'the key is stable');

  assert.notEqual(base, facetCacheKey(['model'], query(), 8), 'a new revision is a new key');
  assert.notEqual(base, facetCacheKey(['model'], query({ q: 'amen' }), 7), 'the search is in the key');
  assert.notEqual(base, facetCacheKey(['model'], query({ kind: 'all' }), 7), 'so is the kind');
  assert.notEqual(base, facetCacheKey(['model'], query({ favorite: true }), 7), 'so is favorites-only');
  assert.notEqual(base, facetCacheKey(['model'], query({ source: 'import' }), 7), 'so is the source');
  // The request carries `provider=`, so it narrows the counts — two providers
  // must not share one cached answer.
  assert.notEqual(base, facetCacheKey(['model'], query({ provider: 'suno' }), 7), 'so is the provider');
  assert.notEqual(
    facetCacheKey(['model'], query({ provider: 'suno' }), 7),
    facetCacheKey(['model'], query({ provider: 'udio' }), 7),
    'and one provider is not answered from another one’s counts',
  );
  assert.notEqual(base, facetCacheKey(['model', 'source'], query(), 7), 'so is the field list');

  assert.equal(
    facetCacheKey(['source', 'model'], query(), 7),
    facetCacheKey(['model', 'source'], query(), 7),
    'field order is not part of the answer, so it is not part of the key',
  );
  // A trailing space is the same search: the request trims it, so the key must.
  assert.equal(facetCacheKey(['model'], query({ q: 'amen ' }), 7), facetCacheKey(['model'], query({ q: 'amen' }), 7));
}

// ── Bad input ──────────────────────────────────────────────────────────────
{
  assert.throws(() => facetCacheKey(['model'], query(), Number.NaN), RangeError);
  assert.throws(() => facetCacheKey(['model'], query(), Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => facetCacheKey(['model'], query(), -1), RangeError);
  assert.throws(() => facetCacheKey(['model'], query(), 1.5), RangeError);
}

// ── Options from the server ────────────────────────────────────────────────
{
  const values: LibraryFacetValue[] = [
    { value: 'sa3', count: 1234 },
    { value: 'suno-v4', count: 12 },
    { value: null, count: 3 },
  ];
  const options = facetOptions(values, ['sa3', 'magenta']);

  assert.deepEqual(
    options.map((o) => [o.value, o.count]),
    [['sa3', 1234], ['suno-v4', 12], ['magenta', null]],
    'server values keep the server order and counts; an unseen fallback follows with no count',
  );
  assert.ok(
    options.every((o) => o.value !== ''),
    'the null bucket is not an option — an empty <option value> already means "all"',
  );
}

// ── Options without the server (old backend) ───────────────────────────────
{
  const options = facetOptions(undefined, ['sa3', 'magenta', 'sa3']);
  assert.deepEqual(
    options.map((o) => [o.value, o.count]),
    [['sa3', null], ['magenta', null]],
    'the fallback list is used verbatim, de-duplicated, with no counts to show',
  );
}

// ── Labels ─────────────────────────────────────────────────────────────────
{
  assert.equal(facetOptionLabel({ value: 'sa3', label: 'SA3', count: 1234 }), 'SA3 (1,234)');
  assert.equal(facetOptionLabel({ value: 'sa3', label: 'SA3', count: null }), 'SA3');
  assert.equal(facetOptionLabel({ value: 'sa3', label: 'SA3', count: 0 }), 'SA3 (0)');
}

console.log('libraryFacets: ok');
