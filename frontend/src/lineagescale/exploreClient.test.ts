// Run with: npx tsx src/lineagescale/exploreClient.test.ts
//
// The explorer's URL building. No network: every assertion is the string that
// would be sent.
//
// What it pins:
//
//   * `q` is sent ONLY to the routes that read it. `/rankings` and `/families`
//     have no `q` parameter, and a query string that promises a filter the
//     answer does not have is a lie told in the address bar;
//   * `/rankings` is never sent a `dir` (a ranking is read from the top; the
//     route rejects one) and is always sent `sort=count`;
//   * an entry id is user data and is escaped into the path;
//   * paging is clamped BEFORE the request, so a pager that has run past the
//     end cannot turn into a 422.
import assert from 'node:assert/strict';

import { exploreUrl } from './exploreClient.ts';

const params = (url: string): URLSearchParams => new URLSearchParams(url.split('?')[1] ?? '');

/* ───────────────────────── q goes where q is read ────────────────────────── */

const songs = params(exploreUrl({ spec: { list: 'songs', set: 'standalone' }, q: 'night' }));
assert.equal(songs.get('q'), 'night');
assert.equal(songs.get('set'), 'standalone');

const kind = params(
  exploreUrl({ spec: { list: 'kind', kind: 'cover_of', role: 'parent' }, q: 'night' }),
);
assert.equal(kind.get('q'), 'night');
assert.equal(kind.get('role'), 'parent');

const members = params(exploreUrl({ spec: { list: 'family', id: 'abc' }, q: 'night' }));
assert.equal(members.get('q'), 'night');

// These two routes do not read it, so it is not sent.
const ranking = params(
  exploreUrl({ spec: { list: 'rankings', kind: 'any', role: 'parent' }, q: 'night', dir: 'desc' }),
);
assert.equal(ranking.get('q'), null, 'a ranking has no title filter');
assert.equal(ranking.get('dir'), null, 'a ranking is read from the top, never reversed');
assert.equal(ranking.get('sort'), 'count');
assert.equal(ranking.get('kind'), 'any');

const families = params(exploreUrl({ spec: { list: 'families' }, q: 'night' }));
assert.equal(families.get('q'), null, 'the family list has no title filter');
assert.equal(families.get('sort'), 'size');

/* ─────────────────────────────── the paths ───────────────────────────────── */

assert.ok(
  exploreUrl({ spec: { list: 'kind', kind: 'cover_of', role: 'any' } }).startsWith(
    '/api/lineage-scale/explore/kinds/cover_of?',
  ),
);
// An id is user data: it can hold anything, so it is escaped.
assert.ok(
  exploreUrl({ spec: { list: 'family', id: 'a/b?c' } }).includes(
    '/explore/families/a%2Fb%3Fc/members?',
  ),
);

/* ───────────────────────────── paging is clamped ─────────────────────────── */

const clamped = params(
  exploreUrl({ spec: { list: 'songs', set: 'with_lineage' }, offset: -5, limit: 99999 }),
);
assert.equal(clamped.get('offset'), '0');
assert.equal(clamped.get('limit'), '500');

const defaults = params(exploreUrl({ spec: { list: 'songs', set: 'with_lineage' } }));
assert.equal(defaults.get('limit'), '50');
assert.equal(defaults.get('offset'), '0');

console.log('exploreClient.test.ts: ok');
