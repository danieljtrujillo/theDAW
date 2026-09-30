/**
 * Where a known row sits in a sparsely loaded result set.
 *
 * A virtualized list scrolls by GLOBAL index, but the rest of the app names
 * rows by id: "inspect this entry", "the orb picked that one". The library
 * store can answer `entryAt(globalIndex)` and nothing else, so turning an id
 * back into an index means looking. Walking 200,000 indices to do it would be
 * absurd; the cache is page-shaped, so one probe at a page's first index says
 * whether the whole page is worth walking. A 200,000-row library with the
 * usual 30 pages cached costs ~1,000 probes plus ~6,000 real rows.
 *
 * Pure — no React, no store, no fetch.
 */

/** The row at a global index, or undefined while its page is not in hand. */
export type RowAt = (index: number) => { id: string } | undefined;

/**
 * The global index of `id` among the rows currently in hand, or -1 when no
 * loaded page holds it (which is not the same as "it does not exist" — the
 * caller decides whether that is worth a request).
 *
 * @param id       the entry id to locate; an empty id matches nothing.
 * @param total    rows in the result set, loaded or not. Must be a
 *                 non-negative integer.
 * @param entryAt  the store's row lookup by global index.
 * @param pageSize rows per cached page. Must be a positive integer.
 */
export function pagedIndexOf(
  id: string,
  total: number,
  entryAt: RowAt,
  pageSize: number,
): number {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError(`pagedIndexOf: pageSize must be a positive integer, got ${pageSize}`);
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`pagedIndexOf: total must be a non-negative integer, got ${total}`);
  }
  if (!id) return -1;
  for (let start = 0; start < total; start += pageSize) {
    // One probe rules out a whole page that is not in hand.
    const first = entryAt(start);
    if (!first) continue;
    if (first.id === id) return start;
    const end = Math.min(start + pageSize, total);
    for (let i = start + 1; i < end; i += 1) {
      if (entryAt(i)?.id === id) return i;
    }
  }
  return -1;
}
