import assert from 'node:assert/strict';
import {
  firstIndexOfPage,
  missingPages,
  offsetInPage,
  pageCount,
  pageOfIndex,
  pagesForRange,
  pagesToEvict,
  touchPage,
} from './pagedRows';

const SIZE = 200;

// ── index ↔ page mapping ────────────────────────────────────────────────────

// Row 0 is the first row of page 0; the last row of a page stays on it and the
// next row starts the next page. The three functions are one mapping, so they
// are asserted together at each boundary.
assert.equal(pageOfIndex(0, SIZE), 0);
assert.equal(offsetInPage(0, SIZE), 0);
assert.equal(firstIndexOfPage(0, SIZE), 0);

assert.equal(pageOfIndex(199, SIZE), 0, 'the 200th row is still page 0');
assert.equal(offsetInPage(199, SIZE), 199);

assert.equal(pageOfIndex(200, SIZE), 1, 'the 201st row opens page 1');
assert.equal(offsetInPage(200, SIZE), 0);
assert.equal(firstIndexOfPage(1, SIZE), 200);

// A deep index, the case the whole ticket exists for.
assert.equal(pageOfIndex(150_000, SIZE), 750);
assert.equal(offsetInPage(150_000, SIZE), 0);
assert.equal(firstIndexOfPage(750, SIZE), 150_000);
assert.equal(pageOfIndex(150_137, SIZE), 750);
assert.equal(offsetInPage(150_137, SIZE), 137);

// The mapping round-trips for every index: firstIndexOfPage(page) + offset.
for (const index of [1, 7, 199, 200, 201, 4321, 199_999]) {
  const page = pageOfIndex(index, SIZE);
  assert.equal(firstIndexOfPage(page, SIZE) + offsetInPage(index, SIZE), index);
}

// ── how many pages a result set occupies ────────────────────────────────────

assert.equal(pageCount(0, SIZE), 0, 'an empty result set has no pages');
assert.equal(pageCount(1, SIZE), 1);
assert.equal(pageCount(200, SIZE), 1, 'exactly one full page is one page');
assert.equal(pageCount(201, SIZE), 2);
assert.equal(pageCount(200_134, SIZE), 1001);

// ── which pages a visible row range needs ───────────────────────────────────

assert.deepEqual(pagesForRange(0, 0, SIZE), [0]);
assert.deepEqual(pagesForRange(0, 199, SIZE), [0], 'a range inside one page needs one page');
assert.deepEqual(pagesForRange(199, 200, SIZE), [0, 1], 'a range straddling a boundary needs both');
assert.deepEqual(pagesForRange(150_000, 150_040, SIZE), [750]);
assert.deepEqual(
  pagesForRange(390, 610, SIZE),
  [1, 2, 3],
  'a range wider than a page lists every page it crosses, ascending',
);

// The range is inclusive of `end`, so an end exactly on a page boundary pulls
// that next page in — an overscanned last row must not render as a skeleton.
assert.deepEqual(pagesForRange(100, 400, SIZE), [0, 1, 2]);

// ── which of those are not in hand yet ──────────────────────────────────────

assert.deepEqual(missingPages([1, 2, 3], new Set([2])), [1, 3]);
assert.deepEqual(missingPages([1, 2], new Set([1, 2])), [], 'nothing to fetch when all are held');
assert.deepEqual(missingPages([], new Set([1])), []);

// ── LRU order ───────────────────────────────────────────────────────────────

// Least-recently-used first, most-recent last. Touching an unheld page appends
// it; touching a held one moves it to the end without duplicating it.
assert.deepEqual(touchPage([], 5), [5]);
assert.deepEqual(touchPage([1, 2, 3], 4), [1, 2, 3, 4]);
assert.deepEqual(touchPage([1, 2, 3], 1), [2, 3, 1], 're-touching moves a page to most-recent');
assert.deepEqual(touchPage([1, 2, 3], 3), [1, 2, 3], 'touching the newest leaves the order alone');

// `touchPage` never mutates the order it is handed — the caller holds it as
// state that React may already have rendered.
{
  const order = [1, 2, 3];
  touchPage(order, 1);
  assert.deepEqual(order, [1, 2, 3], 'touchPage returns a new array');
}

// ── eviction ────────────────────────────────────────────────────────────────

assert.deepEqual(pagesToEvict([1, 2, 3], 5), [], 'under capacity evicts nothing');
assert.deepEqual(pagesToEvict([1, 2, 3], 3), [], 'exactly at capacity evicts nothing');
assert.deepEqual(pagesToEvict([1, 2, 3, 4], 2), [1, 2], 'the two least-recent go first');

// A page the user is looking at is never evicted, however old its last touch:
// dropping it would blank the rows on screen.
assert.deepEqual(
  pagesToEvict([1, 2, 3, 4], 2, new Set([1])),
  [2, 3],
  'a kept page is skipped and the next-oldest evictable page goes instead',
);
assert.deepEqual(
  pagesToEvict([1, 2, 3], 1, new Set([1, 2, 3])),
  [],
  'when everything is visible nothing is evicted, even over capacity',
);

// ── input validation ────────────────────────────────────────────────────────

for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
  assert.throws(() => pageOfIndex(bad, SIZE), RangeError, `pageOfIndex(${bad})`);
  assert.throws(() => offsetInPage(bad, SIZE), RangeError, `offsetInPage(${bad})`);
  assert.throws(() => firstIndexOfPage(bad, SIZE), RangeError, `firstIndexOfPage(${bad})`);
  assert.throws(() => pageCount(bad, SIZE), RangeError, `pageCount(${bad})`);
}
for (const badSize of [0, -200, 1.5, Number.NaN]) {
  assert.throws(() => pageOfIndex(0, badSize), RangeError, `pageSize=${badSize}`);
  assert.throws(() => pagesForRange(0, 1, badSize), RangeError, `pageSize=${badSize}`);
}
assert.throws(() => pagesForRange(10, 9, SIZE), RangeError, 'end before start is a range error');
assert.throws(() => pagesToEvict([1], -1), RangeError, 'a negative capacity is a range error');

console.log('pagedRows: ok');
