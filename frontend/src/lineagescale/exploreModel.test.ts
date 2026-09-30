// Run with: npx tsx src/lineagescale/exploreModel.test.ts
//
// The explorer's arithmetic and its wording, with no React and no network.
//
// What it pins:
//
//   * a page is a page: the last page of 173,877 rows at 50 a page is page
//     3,478 and its offset is 173,850, and a page number typed past the end
//     lands ON the last page rather than on an empty one;
//   * an empty list is still ONE page, so the pager never says "page 1 of 0";
//   * every list names itself — the title a stat card opens is the sentence
//     the panel shows and the sentence the button announces;
//   * a list only offers sorts its route can answer (`count` belongs to a
//     kind list, `links` to a song list, and neither to the other);
//   * `filterEdgesByKinds` keeps an edge when ANY of its kinds is selected,
//     because one drawn edge carries every relation stored for that pair —
//     filtering on kinds[0] alone would hide a stem that is also a cover.
import assert from 'node:assert/strict';

import {
  EXPLORE_PAGE,
  clampPageOffset,
  offsetForPageInput,
  exploreSorts,
  exploreTitle,
  filterEdgesByKinds,
  pageOf,
  pageTotal,
  rangeLabel,
  defaultDirFor,
  defaultSortFor,
  rowCountLabel,
  sameSpec,
  specForHeadline,
  specForRanking,
} from './exploreModel.ts';
import type { ExploreSpec } from './exploreModel.ts';

/* ───────────────────────────── paging arithmetic ─────────────────────────── */

assert.equal(EXPLORE_PAGE, 50);

assert.equal(pageTotal(173877, 50), 3478);
assert.equal(pageTotal(100, 50), 2);
assert.equal(pageTotal(1, 50), 1);
// An empty list is one page, not zero: "page 1 of 0" is not a thing.
assert.equal(pageTotal(0, 50), 1);
assert.equal(pageTotal(-5, 50), 1);

assert.equal(pageOf(0, 50), 1);
assert.equal(pageOf(50, 50), 2);
assert.equal(pageOf(173850, 50), 3478);
assert.equal(pageOf(-10, 50), 1);

assert.equal(clampPageOffset(1, 50, 120), 0);
assert.equal(clampPageOffset(2, 50, 120), 50);
// Page 9 of a 3-page list is the 3rd page, not an empty one.
assert.equal(clampPageOffset(9, 50, 120), 100);
assert.equal(clampPageOffset(0, 50, 120), 0);
assert.equal(clampPageOffset(Number.NaN, 50, 120), 0);
assert.equal(clampPageOffset(2, 50, 0), 0);

// A typed page number means nothing until it parses: an empty box mid-edit
// must not be read as page 1.
assert.equal(offsetForPageInput('12', 50, 1000), 550);
assert.equal(offsetForPageInput(' 3 ', 50, 1000), 100);
assert.equal(offsetForPageInput('900', 50, 1000), 950, 'past the end is the last page');
assert.equal(offsetForPageInput('', 50, 1000), null);
assert.equal(offsetForPageInput('   ', 50, 1000), null);
assert.equal(offsetForPageInput('-', 50, 1000), null);
assert.equal(offsetForPageInput('abc', 50, 1000), null);
assert.equal(offsetForPageInput('0', 50, 1000), 0);

assert.equal(rangeLabel(0, 50, 173877, 50), '1–50 of 173,877');
assert.equal(rangeLabel(173850, 50, 173877, 27), '173,851–173,877 of 173,877');
assert.equal(rangeLabel(0, 50, 0, 0), 'nothing to show');

/* ──────────────────────────── every list names itself ────────────────────── */

const specs: Array<[ExploreSpec, string]> = [
  [{ list: 'songs', set: 'with_lineage' }, 'Songs with lineage'],
  [{ list: 'songs', set: 'standalone' }, 'Songs with no lineage'],
  [{ list: 'kind', kind: 'cover_of', role: 'parent' }, 'Covered by another song'],
  [{ list: 'families' }, 'Families'],
  [{ list: 'family', id: 'abc', title: 'Night Drive' }, 'Family of Night Drive'],
];
for (const [spec, expected] of specs) assert.equal(exploreTitle(spec), expected);

// A ranking says which way round it is read, because "most covers" is two
// different lists depending on which end of the link the song is on.
assert.match(exploreTitle({ list: 'rankings', kind: 'cover_of', role: 'parent' }), /cover/i);
assert.notEqual(
  exploreTitle({ list: 'rankings', kind: 'cover_of', role: 'parent' }),
  exploreTitle({ list: 'rankings', kind: 'cover_of', role: 'child' }),
);
assert.match(exploreTitle({ list: 'rankings', kind: 'any', role: 'parent' }), /relationship/i);

/* ──────────────────────── a list offers only what it can ─────────────────── */

const songSorts = exploreSorts({ list: 'songs', set: 'with_lineage' });
assert.ok(songSorts.includes('links'));
assert.ok(!songSorts.includes('count'));
const kindSorts = exploreSorts({ list: 'kind', kind: 'cover_of', role: 'any' });
assert.ok(kindSorts.includes('count'));
assert.ok(!kindSorts.includes('links'));
assert.deepEqual(exploreSorts({ list: 'families' }), ['size']);
assert.ok(exploreSorts({ list: 'family', id: 'a' }).includes('title'));

/* ──────────────────────────────── row wording ────────────────────────────── */

assert.equal(
  rowCountLabel({ list: 'songs', set: 'with_lineage' }, { links: 3 }),
  '3 relationships',
);
assert.equal(rowCountLabel({ list: 'songs', set: 'with_lineage' }, { links: 1 }), '1 relationship');
assert.equal(rowCountLabel({ list: 'songs', set: 'standalone' }, {}), '');
assert.equal(rowCountLabel({ list: 'kind', kind: 'cover_of', role: 'parent' }, { count: 12 }), '12');
assert.equal(rowCountLabel({ list: 'families' }, { size: 8618 }), '8,618 songs');

/* ─────────────────────────── the same list, or not ───────────────────────── */

assert.ok(sameSpec({ list: 'songs', set: 'standalone' }, { list: 'songs', set: 'standalone' }));
assert.ok(!sameSpec({ list: 'songs', set: 'standalone' }, { list: 'songs', set: 'with_lineage' }));
assert.ok(
  !sameSpec(
    { list: 'kind', kind: 'cover_of', role: 'parent' },
    { list: 'kind', kind: 'cover_of', role: 'child' },
  ),
);

/* ───────────────────────────── kind filtering ────────────────────────────── */

const edges = [
  { from: 'b', to: 'a', kinds: ['cover_of', 'derived_from'], role: 'ancestry' },
  { from: 'c', to: 'a', kinds: ['mashup_source'], role: 'uses' },
  { from: 'd', to: 'a', kinds: ['stem_of', 'derived_from', 'edit_of'], role: 'ancestry' },
];

// No selection is not an empty selection: the graph is unfiltered.
assert.equal(filterEdgesByKinds(edges, []), edges);
assert.equal(filterEdgesByKinds(edges, undefined), edges);

assert.deepEqual(
  filterEdgesByKinds(edges, ['mashup_source']).map((e) => e.from),
  ['c'],
);
// An edge is kept when ANY of its kinds is selected, not only its first.
assert.deepEqual(
  filterEdgesByKinds(edges, ['edit_of']).map((e) => e.from),
  ['d'],
);
assert.deepEqual(
  filterEdgesByKinds(edges, ['derived_from']).map((e) => e.from),
  ['b', 'd'],
);
assert.deepEqual(filterEdgesByKinds(edges, ['midi_of']), []);

/* ─────────────────── every number opens the list it counts ───────────────── */

// The four headline cards on the landing page, by their own keys.
assert.deepEqual(specForHeadline('entries'), { list: 'songs', set: 'with_lineage' });
assert.deepEqual(specForHeadline('largest_tree'), { list: 'families' });
assert.equal(specForHeadline('links')?.list, 'rankings');
// A cluster is NOT a family, so that card leads to the links that weld one.
assert.deepEqual(specForHeadline('largest_connected'), {
  list: 'kind',
  kind: 'mashup_source',
  role: 'parent',
});
assert.equal(specForHeadline('nonsense'), null);

// "More…" under a preset continues THAT question: the recent list is newest
// first, so the list it opens is too.
const recent = specForRanking('recent');
assert.equal(recent?.list, 'songs');
assert.equal(defaultSortFor(recent!), 'created');
assert.equal(defaultDirFor(recent!), 'desc');

assert.equal(specForRanking('most_derived')?.list, 'rankings');
assert.equal(specForRanking('mashup_sources')?.list, 'rankings');
// Depth is the length of a chain, not a count of links: no ranking says it.
assert.equal(specForRanking('deepest'), null);

assert.equal(defaultSortFor({ list: 'songs', set: 'with_lineage' }), 'links');
assert.equal(defaultSortFor({ list: 'families' }), 'size');
assert.equal(defaultSortFor({ list: 'kind', kind: 'cover_of', role: 'any' }), 'count');
assert.equal(defaultSortFor({ list: 'family', id: 'a' }), 'title');
assert.equal(defaultDirFor({ list: 'family', id: 'a' }), 'asc');
assert.equal(defaultDirFor({ list: 'families' }), 'desc');

console.log('exploreModel.test.ts: ok');
