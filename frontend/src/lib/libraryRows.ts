/**
 * The library as a browsable list: one sort order, one quick filter, one row
 * text model.
 *
 * Pure — no React, no store, no fetch — so the DETAILS tab's library pane and
 * `libraryStore.getFiltered` share the SAME ordering instead of each carrying
 * a copy of the comparator, and the test runs under plain node.
 *
 * `sortEntriesBy` is the library's own sort order: the store calls it, the
 * DETAILS pane calls it, so the two can never disagree about what "newest"
 * means.
 */
import type { LibraryEntry } from '../state/libraryEntry';

/** The orders the library offers; `libraryStore.sortBy` is one of these. */
export type LibrarySortBy = 'newest' | 'oldest' | 'duration' | 'title' | 'plays';

/**
 * A sorted COPY. Never mutates the array it is handed: `entries` is Zustand
 * state that React has already rendered, and `Array.prototype.sort` in place
 * would reorder it under the current render.
 *
 * Timestamps compare as strings on purpose — they are ISO-8601, so
 * lexicographic order is chronological order, with no Date parsing per
 * comparison.
 */
export function sortEntriesBy(
  entries: readonly LibraryEntry[],
  sortBy: LibrarySortBy,
): LibraryEntry[] {
  const out = [...entries];
  switch (sortBy) {
    case 'newest':
      out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      break;
    case 'oldest':
      out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      break;
    case 'duration':
      out.sort((a, b) => b.duration - a.duration);
      break;
    case 'title':
      out.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'plays':
      out.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));
      break;
  }
  return out;
}

/**
 * Every term in the query has to appear somewhere in the row's own words —
 * title, prompt, model, notes, tags. Typing "amen 174" finds the break at 174
 * without caring which field holds which term.
 *
 * Deliberately NOT the analysis/embedded-tag haystack `getFiltered` searches:
 * this filter runs on every keystroke over the whole library, so it stays a
 * fixed handful of fields per entry.
 */
export function matchesLibraryQuery(entry: LibraryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    entry.title ?? '',
    entry.prompt ?? '',
    entry.model ?? '',
    entry.notes ?? '',
    ...(entry.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  // Terms are split on whitespace, so no term can ever straddle the join —
  // a plain space is a sufficient barrier between fields here.
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/** The entries a quick-filter query leaves. An empty query keeps all of them. */
export function filterLibraryEntries(
  entries: readonly LibraryEntry[],
  query: string,
): LibraryEntry[] {
  if (!query.trim()) return [...entries];
  return entries.filter((e) => matchesLibraryQuery(e, query));
}

/** The library, sorted then filtered — what the DETAILS pane renders. */
export function libraryListRows(
  entries: readonly LibraryEntry[],
  sortBy: LibrarySortBy,
  query: string,
): LibraryEntry[] {
  return filterLibraryEntries(sortEntriesBy(entries, sortBy), query);
}

/** m:ss, or `--:--` for a track with no usable length. */
export function formatRowDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** The entry's date, short. Falls back to the raw string for an unparsable one. */
export function formatRowDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString();
}

export interface LibraryRowText {
  title: string;
  /** `MODEL · 3:24 · 9/12/2026` — the one meta line a ~384px row can fit. */
  meta: string;
}

/** The strings a compact row draws. Nothing here touches the audio. */
export function libraryRowText(entry: LibraryEntry): LibraryRowText {
  const parts = [
    (entry.model ?? '').trim(),
    formatRowDuration(entry.duration),
    formatRowDate(entry.timestamp),
  ].filter((p) => p.length > 0);
  return {
    title: (entry.title ?? '').trim() || entry.audioFilename || 'untitled',
    meta: parts.join(' · '),
  };
}

/**
 * The header readout: the whole library, or how much of it the filter left.
 * Says "track" rather than "entry" because that is the word the rows are.
 */
export function libraryCountLabel(total: number, shown: number): string {
  const noun = total === 1 ? 'track' : 'tracks';
  if (shown === total) return `${total} ${noun}`;
  return `${shown} of ${total} ${noun}`;
}
