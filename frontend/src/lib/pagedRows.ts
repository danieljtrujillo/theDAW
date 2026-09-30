/**
 * Page arithmetic for a sparsely-loaded list.
 *
 * The library can hold 200,000 entries, so the store never holds them all: it
 * keeps a bounded LRU of fixed-size PAGES and asks the backend for the ones a
 * visible row range needs. This module is that arithmetic and nothing else —
 * DOM-free, React-free, store-free, fetch-free — so the rules about which page
 * a row lives on, which pages a scroll position needs, and which page gets
 * dropped when the cache is full can be tested on their own.
 *
 * Units: every `index` is a GLOBAL row index into the current query's result
 * set (0-based, the same space the backend's `offset` uses); every `page` is a
 * 0-based page number in that same result set; `pageSize` is rows per page.
 * Nothing here is measured in pixels.
 *
 * LRU orders are plain arrays, LEAST-recently-used first and most-recent last,
 * and every function returns a new array rather than mutating the one it is
 * handed (the caller holds it as state React may already have rendered).
 */

/** Throw unless `value` is a non-negative integer. */
const assertIndex = (value: number, what: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
  }
};

/** Throw unless `pageSize` is a positive integer count of rows. */
const assertPageSize = (pageSize: number): void => {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  }
};

/** The page holding global row `index`. */
export function pageOfIndex(index: number, pageSize: number): number {
  assertIndex(index, 'index');
  assertPageSize(pageSize);
  return Math.floor(index / pageSize);
}

/** Where global row `index` sits inside its own page (0 … pageSize-1). */
export function offsetInPage(index: number, pageSize: number): number {
  assertIndex(index, 'index');
  assertPageSize(pageSize);
  return index % pageSize;
}

/** The global row index of the first row on `page` — the backend's `offset`. */
export function firstIndexOfPage(page: number, pageSize: number): number {
  assertIndex(page, 'page');
  assertPageSize(pageSize);
  return page * pageSize;
}

/** How many pages a result set of `total` rows occupies. */
export function pageCount(total: number, pageSize: number): number {
  assertIndex(total, 'total');
  assertPageSize(pageSize);
  return Math.ceil(total / pageSize);
}

/**
 * Every page the inclusive row range `[start, end]` touches, ascending.
 *
 * `end` is INCLUSIVE because it comes straight from a virtualized list's last
 * rendered row: an overscanned row exactly on a page boundary has to pull that
 * page in, or it renders as a skeleton that never fills.
 */
export function pagesForRange(start: number, end: number, pageSize: number): number[] {
  assertIndex(start, 'start');
  assertIndex(end, 'end');
  assertPageSize(pageSize);
  if (end < start) {
    throw new RangeError(`end (${end}) must not be before start (${start})`);
  }
  const first = Math.floor(start / pageSize);
  const last = Math.floor(end / pageSize);
  const out: number[] = [];
  for (let page = first; page <= last; page += 1) out.push(page);
  return out;
}

/** The pages of `wanted` that are not already held (cached or in flight). */
export function missingPages(wanted: readonly number[], have: ReadonlySet<number>): number[] {
  return wanted.filter((page) => !have.has(page));
}

/** `order` with `page` moved to the most-recent end. Never mutates `order`. */
export function touchPage(order: readonly number[], page: number): number[] {
  assertIndex(page, 'page');
  const out = order.filter((p) => p !== page);
  out.push(page);
  return out;
}

/**
 * The pages to drop so at most `capacity` remain, least-recently-used first.
 *
 * Pages in `keep` are never evicted however stale their last touch: they back
 * rows that are on screen right now, and dropping one would blank them. That
 * can leave the cache over capacity, which is correct — a visible range bigger
 * than the cache is a cache that is too small, not a reason to thrash.
 */
export function pagesToEvict(
  order: readonly number[],
  capacity: number,
  keep: ReadonlySet<number> = new Set(),
): number[] {
  assertIndex(capacity, 'capacity');
  const out: number[] = [];
  let held = order.length;
  for (const page of order) {
    if (held <= capacity) break;
    if (keep.has(page)) continue;
    out.push(page);
    held -= 1;
  }
  return out;
}
