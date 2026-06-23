/**
 * catalogSearch — the Catalogue's ROBUST SEARCH ENGINE.
 *
 * Pure functions over `LibraryEntry[]`, mirroring SunoHarvester's Library
 * search UX (a `searchTarget` field selector + multiple match `mode`s) adapted
 * to theDAW's `LibraryEntry`. Everything here is in-memory and side-effect
 * free — the existing library store is the single source of truth; this is just
 * a rich VIEW over its `entries`.
 *
 * Targets (which field(s) the query runs against):
 *   all | title | prompt | lyrics | style | model | provider | tags | notes | seed | id
 *
 * Match modes (how the query string is compared):
 *   fuzzy      — alnum-normalized substring ("lo-fi!" matches "lofi")
 *   contains   — plain case-insensitive substring
 *   all_words  — every whitespace-separated word appears somewhere
 *   in_order   — words appear left-to-right (gaps allowed)
 *   exact      — whole field equals the query (trimmed, case-insensitive)
 *   regex      — user-authored RegExp (invalid pattern matches nothing)
 *
 * Filter dimensions: favorites, source, provider (derived), model, rating,
 * duration min/max. Sorts: newest | oldest | duration | title.
 *
 * lyrics/style are not first-class on `LibraryEntry`, so they're derived
 * best-effort from tags/notes (and analysis when present) — for Suno tracks
 * those fields often live in tags like `lyrics:` / `style:` or in notes.
 */

import type { LibraryEntry } from '../state/libraryEntry';
import { inferProvider } from './catalogProviders';

export type CatalogueSearchTarget =
  | 'all'
  | 'title'
  | 'prompt'
  | 'lyrics'
  | 'style'
  | 'model'
  | 'provider'
  | 'tags'
  | 'notes'
  | 'seed'
  | 'id';

export type CatalogueMatchMode =
  | 'fuzzy'
  | 'contains'
  | 'all_words'
  | 'in_order'
  | 'exact'
  | 'regex';

export type CatalogueSortBy = 'newest' | 'oldest' | 'duration' | 'title';

export type CatalogueSourceFilter = 'all' | 'generate' | 'studio' | 'import';

export type CatalogueRatingFilter = 'all' | 'like' | 'dislike' | 'unrated';

/** The full, serializable search/filter/sort state. */
export interface CatalogueSearchState {
  query: string;
  searchTarget: CatalogueSearchTarget;
  mode: CatalogueMatchMode;
  // Filters
  onlyFavorites: boolean;
  sourceFilter: CatalogueSourceFilter;
  /** Derived-provider filter; null/'' = all. */
  providerFilter: string | null;
  /** Exact model match; null/'' = all. */
  modelFilter: string | null;
  ratingFilter: CatalogueRatingFilter;
  durationMin: number | null;
  durationMax: number | null;
  // Sort
  sortBy: CatalogueSortBy;
}

/** Sensible defaults for a fresh Catalogue session. */
export const DEFAULT_SEARCH_STATE: CatalogueSearchState = {
  query: '',
  searchTarget: 'all',
  mode: 'fuzzy',
  onlyFavorites: false,
  sourceFilter: 'all',
  providerFilter: null,
  modelFilter: null,
  ratingFilter: 'all',
  durationMin: null,
  durationMax: null,
  sortBy: 'newest',
};

// ---------------------------------------------------------------------------
// Best-effort field derivation
// ---------------------------------------------------------------------------

/** Loose accessor for the optional `analysis` blob entries may carry. */
const analysisOf = (e: LibraryEntry): Record<string, unknown> | undefined =>
  (e as unknown as { analysis?: Record<string, unknown> }).analysis;

/** Loose accessor for the optional `embeddedTags` blob entries may carry. */
const embeddedTagsOf = (e: LibraryEntry): Record<string, unknown> | undefined =>
  (e as unknown as { embeddedTags?: Record<string, unknown> }).embeddedTags;

/** Collect values from a tag list whose tag begins with one of `prefixes`
 *  (e.g. `lyrics:`, `style:`). Returns the text after the prefix. */
const taggedValues = (tags: string[], prefixes: string[]): string[] => {
  const out: string[] = [];
  for (const t of tags) {
    for (const p of prefixes) {
      if (t.toLowerCase().startsWith(p)) out.push(t.slice(p.length).trim());
    }
  }
  return out;
};

/**
 * Best-effort "lyrics" text for an entry. Suno tracks frequently stash lyrics
 * in tags (`lyrics:…`) or notes; native generations have none. Falls back to
 * notes so a lyrics-target search still finds something sensible.
 */
export const deriveLyrics = (e: LibraryEntry): string => {
  const fromTags = taggedValues(e.tags, ['lyrics:', 'lyric:']);
  if (fromTags.length) return fromTags.join(' ');
  const a = analysisOf(e);
  const aLyrics = a && (a.lyrics ?? a.lyric);
  if (typeof aLyrics === 'string') return aLyrics;
  // Last resort: notes often hold pasted lyrics for imported songs.
  return e.notes ?? '';
};

/**
 * Best-effort "style" text. Suno stores a style/genre string; we look in tags
 * (`style:` / `genre:`), then analysis, then the prompt (the style of a native
 * generation IS its prompt).
 */
export const deriveStyle = (e: LibraryEntry): string => {
  const fromTags = taggedValues(e.tags, ['style:', 'genre:']);
  if (fromTags.length) return fromTags.join(' ');
  const a = analysisOf(e);
  const aStyle = a && (a.style ?? a.genre);
  if (typeof aStyle === 'string') return aStyle;
  return e.prompt ?? '';
};

/** Flatten an optional record's values into a space-joined string. */
const recordText = (rec: Record<string, unknown> | undefined): string => {
  if (!rec || typeof rec !== 'object') return '';
  const parts: string[] = [];
  for (const v of Object.values(rec)) {
    if (v == null) continue;
    parts.push(String(v));
  }
  return parts.join(' ');
};

/** The text to match for a given target. The 'all' haystack is the union of
 *  everything searchable, including derived lyrics/style and the analysis /
 *  embeddedTags blobs. */
const fieldText = (e: LibraryEntry, target: CatalogueSearchTarget): string => {
  switch (target) {
    case 'title':
      return e.title;
    case 'prompt':
      return `${e.prompt} ${e.negativePrompt}`;
    case 'lyrics':
      return deriveLyrics(e);
    case 'style':
      return deriveStyle(e);
    case 'model':
      return e.model;
    case 'provider':
      return inferProvider(e);
    case 'tags':
      return e.tags.join(' ');
    case 'notes':
      return e.notes;
    case 'seed':
      return String(e.seed);
    case 'id':
      return e.id;
    case 'all':
    default:
      return [
        e.title,
        e.prompt,
        e.negativePrompt,
        e.model,
        inferProvider(e),
        e.tags.join(' '),
        e.notes,
        String(e.seed),
        e.id,
        e.source,
        e.mimeType,
        ...(e.chimeraSources ?? []),
        deriveLyrics(e),
        deriveStyle(e),
        recordText(analysisOf(e)),
        recordText(embeddedTagsOf(e)),
      ].join(' ​ ');
  }
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Strip to lowercase alphanumerics — used by fuzzy matching so punctuation
 *  and separators don't matter ("lo-fi beat!" ≈ "lofi beat"). */
const normalizeAlnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Test a single haystack against the query under a given mode. */
const matchOne = (haystack: string, query: string, mode: CatalogueMatchMode): boolean => {
  if (!query) return true;
  const hay = haystack.toLowerCase();
  const q = query.toLowerCase();

  switch (mode) {
    case 'contains':
      return hay.includes(q);

    case 'all_words': {
      const words = q.split(/\s+/).filter(Boolean);
      return words.every((w) => hay.includes(w));
    }

    case 'in_order': {
      // Words must appear left-to-right, gaps allowed.
      const words = q.split(/\s+/).filter(Boolean);
      let cursor = 0;
      for (const w of words) {
        const found = hay.indexOf(w, cursor);
        if (found === -1) return false;
        cursor = found + w.length;
      }
      return true;
    }

    case 'exact':
      return hay.trim() === q.trim();

    case 'regex': {
      try {
        // User-authored pattern; an invalid regex simply matches nothing.
        return new RegExp(query, 'i').test(haystack);
      } catch {
        return false;
      }
    }

    case 'fuzzy':
    default:
      return normalizeAlnum(haystack).includes(normalizeAlnum(query));
  }
};

/** Does this entry satisfy the active query/mode/target? Empty query → true. */
export const entryMatches = (e: LibraryEntry, state: CatalogueSearchState): boolean => {
  if (!state.query.trim()) return true;
  return matchOne(fieldText(e, state.searchTarget), state.query, state.mode);
};

// ---------------------------------------------------------------------------
// Filtering + sorting
// ---------------------------------------------------------------------------

const passesFilters = (e: LibraryEntry, state: CatalogueSearchState): boolean => {
  if (state.onlyFavorites && !e.favorite) return false;
  if (state.sourceFilter !== 'all' && e.source !== state.sourceFilter) return false;
  if (state.modelFilter && e.model !== state.modelFilter) return false;
  if (state.providerFilter && inferProvider(e) !== state.providerFilter) return false;
  if (state.ratingFilter !== 'all') {
    if (state.ratingFilter === 'unrated' && e.rating != null) return false;
    if (state.ratingFilter === 'like' && e.rating !== 'like') return false;
    if (state.ratingFilter === 'dislike' && e.rating !== 'dislike') return false;
  }
  if (state.durationMin != null && e.duration < state.durationMin) return false;
  if (state.durationMax != null && e.duration > state.durationMax) return false;
  return true;
};

const compareEntries = (a: LibraryEntry, b: LibraryEntry, sortBy: CatalogueSortBy): number => {
  switch (sortBy) {
    case 'oldest':
      return a.timestamp.localeCompare(b.timestamp);
    case 'duration':
      return b.duration - a.duration;
    case 'title':
      return a.title.localeCompare(b.title);
    case 'newest':
    default:
      return b.timestamp.localeCompare(a.timestamp);
  }
};

/** Apply all filters + the text search, then sort. Pure — never mutates input. */
export const filterAndSort = (
  entries: LibraryEntry[],
  state: CatalogueSearchState,
): LibraryEntry[] => {
  const out = entries.filter((e) => passesFilters(e, state) && entryMatches(e, state));
  return out.sort((a, b) => compareEntries(a, b, state.sortBy));
};

// ---------------------------------------------------------------------------
// Label maps (for the filter bar UI)
// ---------------------------------------------------------------------------

export const MATCH_MODE_LABELS: Record<CatalogueMatchMode, string> = {
  fuzzy: 'Fuzzy',
  contains: 'Contains',
  all_words: 'All Words',
  in_order: 'In Order',
  exact: 'Exact',
  regex: 'Regex',
};

export const SEARCH_TARGET_LABELS: Record<CatalogueSearchTarget, string> = {
  all: 'All Fields',
  title: 'Title',
  prompt: 'Prompt',
  lyrics: 'Lyrics',
  style: 'Style',
  model: 'Model',
  provider: 'Provider',
  tags: 'Tags',
  notes: 'Notes',
  seed: 'Seed',
  id: 'ID',
};

export const SORT_LABELS: Record<CatalogueSortBy, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  duration: 'Length',
  title: 'Title',
};

/** Ordered lists for rendering chips/dropdowns. */
export const MATCH_MODES: CatalogueMatchMode[] = [
  'fuzzy', 'contains', 'all_words', 'in_order', 'exact', 'regex',
];
export const SEARCH_TARGETS: CatalogueSearchTarget[] = [
  'all', 'title', 'prompt', 'lyrics', 'style', 'model', 'provider', 'tags', 'notes', 'seed', 'id',
];
export const SORT_OPTIONS: CatalogueSortBy[] = ['newest', 'oldest', 'duration', 'title'];
