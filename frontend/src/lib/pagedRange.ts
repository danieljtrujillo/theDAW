/**
 * Pure range-clamping arithmetic for a virtualized list's reported row range.
 *
 * A virtual list (react-window and friends) reports whichever row range it
 * last rendered, and that range can be stale: a filter can narrow a
 * 200,000-row result set down to 10 rows in the same tick the list is still
 * reporting rows 50-60 from before the filter applied. This module is the
 * arithmetic that reconciles the two — DOM-free, React-free, store-free,
 * fetch-free — so it can be tested on its own and never throws no matter
 * what garbage the DOM hands it.
 *
 * Units: every `start`/`end`/`total` is a GLOBAL row index into the current
 * query's result set (0-based, inclusive `end`), the same space
 * `pagedRows.ts` uses. Nothing here is measured in pixels.
 *
 * `null` means "fetch nothing" — either the result set is empty or the
 * requested range sits entirely past its end — never "error". A virtual
 * list reporting a stale range is an expected transient, not a bug, so this
 * module reports it as "nothing to do" instead of throwing.
 */

/** An inclusive row range: rows `start` through `end`, both included. */
export interface RowRange {
  start: number;
  end: number;
}

/** True for a finite, non-negative integer — the only valid index shape. */
const isValidIndex = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * Clamp a virtual list's reported `[start, end]` row range to `total` rows.
 *
 * Returns `null` when there is nothing to fetch: invalid input, an empty
 * result set, or a range that starts entirely past the end of the result
 * set. Otherwise returns the range normalised so `end >= start` and capped
 * so `end <= total - 1`. Never throws — the caller gets a garbage range
 * straight from the DOM and must not crash on it.
 */
export function clampVisibleRange(start: number, end: number, total: number): RowRange | null {
  if (!isValidIndex(start) || !isValidIndex(end) || !isValidIndex(total)) return null;
  if (total === 0) return null;
  const normalisedEnd = Math.max(start, end);
  if (start >= total) return null;
  return { start, end: Math.min(normalisedEnd, total - 1) };
}
