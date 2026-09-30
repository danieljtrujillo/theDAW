/**
 * The explorer's arithmetic and its wording: what a list IS, what it is
 * called, what it can be sorted by, and which page you are on.
 *
 * Everything here is pure, so the panel is a rendering of these answers and
 * the paging can be tested without a browser or a server — the same split
 * `lineageScaleModel.ts` makes for the focus view.
 *
 * Why it exists: the LEARN landing page showed eight numbers and four ranked
 * lists, and NONE of them led anywhere. An `ExploreSpec` is one of those
 * numbers turned into a list you can open, search, sort and page — for every
 * kind of relationship and both ends of it, not four presets.
 */
import { formatCount } from './lineageScaleModel';
import { relationWords } from '../lib/lineageInsights';

/** Which end of a link the song is on. `any` is either end. */
export type ExploreRole = 'parent' | 'child' | 'any';
export type ExploreSort = 'title' | 'created' | 'plays' | 'links' | 'count' | 'size';
export type ExploreDir = 'asc' | 'desc';
/** The two populations the "Songs" card counts. They partition the library. */
export type SongSet = 'with_lineage' | 'standalone';

/** `any` stands for every kind that is not an artifact rendering. */
export const KIND_ANY = 'any';

/**
 * Every kind a list can be opened for, in the backend's display order
 * (`graph.py: KIND_ORDER`). Kept here rather than fetched: it is the same
 * table the edges already carry, and a dropdown that needs a round trip
 * before it can be opened is a dropdown that flickers.
 */
export const EXPLORE_KINDS: readonly string[] = [
  'cover_of',
  'cover',
  'edit_of',
  'derived_from',
  'upsample_of',
  'overpaint_of',
  'underpaint_of',
  'speed_change_of',
  'stem_of',
  'mashup_source',
  'mashup',
  'chimera_source_of',
  'midi_of',
  'rendered_as_notation',
  'tabbed_as_notation',
  'arranged_as_notation',
  'charted_as_chords',
] as const;

/** Rows one page holds. The backend's own default. */
export const EXPLORE_PAGE = 50;

export interface ExploreRow {
  id: string;
  title: string;
  model: string;
  source: string;
  duration_sec: number;
  play_count: number;
  created_at: number;
  /** Non-artifact relationships this song is in (`songs`, family members). */
  links?: number;
  /** Links of the asked-for kind in the asked-for role (`kind`, `rankings`). */
  count?: number;
  /** Songs in the family (`families`). */
  size?: number;
  root_id?: string;
}

export interface ExplorePage {
  total: number;
  offset: number;
  limit: number;
  rows: ExploreRow[];
}

/** One openable list. Every stat card and every kind row names one of these. */
export type ExploreSpec =
  | {
      list: 'songs';
      set: SongSet;
      /** The sort this list opens on, when the thing that opened it asked a
       *  narrower question than "the songs with lineage" — "More…" under
       *  "Recently extended" continues THAT question. */
      sort?: ExploreSort;
      dir?: ExploreDir;
    }
  | { list: 'kind'; kind: string; role: ExploreRole }
  | { list: 'rankings'; kind: string; role: 'parent' | 'child' }
  | { list: 'families' }
  | { list: 'family'; id: string; title?: string };

/* ──────────────────────────── paging arithmetic ──────────────────────────── */

/** Pages a list of `total` rows has. An empty list is ONE page, never zero:
 *  a pager that says "page 1 of 0" is a bug on screen. */
export const pageTotal = (total: number, limit: number): number =>
  Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, limit)));

/** The 1-based page an offset is on. */
export const pageOf = (offset: number, limit: number): number =>
  Math.floor(Math.max(0, offset) / Math.max(1, limit)) + 1;

/** The offset of a 1-based page, pinned inside the list. A page number typed
 *  past the end lands ON the last page rather than on an empty one. */
export const clampPageOffset = (page: number, limit: number, total: number): number => {
  const size = Math.max(1, limit);
  const last = pageTotal(total, size);
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1;
  return (Math.min(Math.max(1, wanted), last) - 1) * size;
};

/**
 * The offset a typed page number means, or null when it means nothing yet.
 *
 * Null is "leave the list where it is": an empty box mid-edit, or a stray
 * character, must not send the pager to page 1 — which is what committing on
 * every keystroke did.
 */
export function offsetForPageInput(
  raw: string,
  limit: number,
  total: number,
): number | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return clampPageOffset(parsed, limit, total);
}

/** "1–50 of 173,877" — where you are, in the numbers the landing page used. */
export const rangeLabel = (
  offset: number,
  limit: number,
  total: number,
  rowCount: number,
): string => {
  if (total <= 0 || rowCount <= 0) return 'nothing to show';
  const first = Math.max(0, offset) + 1;
  const last = Math.max(0, offset) + rowCount;
  return `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`;
};

/* ────────────────────────────────── wording ──────────────────────────────── */

/** What a song IS at each end of a link of this kind. The table is the wording
 *  half of `graph.py`'s role table: which end is the source is a FACT about the
 *  writer, and these sentences must agree with it. */
const KIND_WORDS: Record<string, { parent: string; child: string }> = {
  cover_of: { parent: 'Covered by another song', child: 'Covers of another song' },
  cover: { parent: 'Covered by another song', child: 'Covers of another song' },
  edit_of: { parent: 'Edited into another song', child: 'Edits of another song' },
  derived_from: { parent: 'Songs derived from', child: 'Songs derived from another' },
  upsample_of: { parent: 'Upsampled', child: 'Upsamples of another song' },
  overpaint_of: { parent: 'Overpainted', child: 'Overpaints of another song' },
  underpaint_of: { parent: 'Underpainted', child: 'Underpaints of another song' },
  speed_change_of: { parent: 'Speed-changed', child: 'Speed changes of another song' },
  stem_of: { parent: 'Separated into stems', child: 'Stems of another song' },
  mashup_source: { parent: 'Used in mashups', child: 'Mashups built from other songs' },
  mashup: { parent: 'Used in mashups', child: 'Mashups built from other songs' },
  chimera_source_of: { parent: 'Used as a chimera source', child: 'Built from chimera sources' },
  midi_of: { parent: 'Transcribed to MIDI', child: 'MIDI transcriptions' },
  rendered_as_notation: { parent: 'Rendered as notation', child: 'Notation renderings' },
  tabbed_as_notation: { parent: 'Tabbed as notation', child: 'Tabs' },
  arranged_as_notation: { parent: 'Arranged as notation', child: 'Arrangements' },
  charted_as_chords: { parent: 'Charted as chords', child: 'Chord charts' },
};

const kindWords = (kind: string, role: ExploreRole): string => {
  const words = KIND_WORDS[kind];
  if (!words) return `Songs with a ${relationWords(kind)} link`;
  if (role === 'any') return `${words.parent} or ${words.child.toLowerCase()}`;
  return words[role];
};

/** The sentence the panel shows, and the sentence the button that opens it
 *  announces. One string, so the two can never disagree. */
export function exploreTitle(spec: ExploreSpec): string {
  switch (spec.list) {
    case 'songs':
      return spec.set === 'standalone' ? 'Songs with no lineage' : 'Songs with lineage';
    case 'kind':
      return kindWords(spec.kind, spec.role);
    case 'rankings':
      if (spec.kind === KIND_ANY) {
        return spec.role === 'parent'
          ? 'Most relationships as the source'
          : 'Most relationships as the derived song';
      }
      return `Most ${relationWords(spec.kind)} links as the ${
        spec.role === 'parent' ? 'source' : 'derived song'
      }`;
    case 'families':
      return 'Families';
    case 'family':
      return `Family of ${spec.title || spec.id}`;
    default:
      return 'Songs';
  }
}

/** The line under the title: what the list is, in the landing page's terms. */
export function exploreHint(spec: ExploreSpec): string {
  switch (spec.list) {
    case 'songs':
      return spec.set === 'standalone'
        ? 'No song was made from them and they were made from no song'
        : 'Every song that is at either end of at least one relationship';
    case 'kind':
      return 'Every song holding at least one link of this kind, and how many';
    case 'rankings':
      return 'Ranked by how many of those links the song holds';
    case 'families':
      return 'Connected by descent only — mashups weld unrelated trees and are left out';
    case 'family':
      return 'Every song sharing this line of descent';
    default:
      return '';
  }
}

/** Only the sorts this list's route can answer. */
export function exploreSorts(spec: ExploreSpec): ExploreSort[] {
  switch (spec.list) {
    case 'songs':
      return ['title', 'created', 'plays', 'links'];
    case 'kind':
      return ['count', 'title', 'created', 'plays'];
    case 'rankings':
      return ['count'];
    case 'families':
      return ['size'];
    case 'family':
      return ['title', 'created', 'plays', 'links'];
    default:
      return ['title'];
  }
}

export const SORT_WORDS: Record<ExploreSort, string> = {
  title: 'Title',
  created: 'Created',
  plays: 'Plays',
  links: 'Relationships',
  count: 'Links of this kind',
  size: 'Family size',
};

export const ROLE_WORDS: Record<ExploreRole, string> = {
  parent: 'As the source',
  child: 'As the derived song',
  any: 'Either end',
};

/** The number this row was ranked by, in words. '' when the list has none. */
export function rowCountLabel(spec: ExploreSpec, row: Partial<ExploreRow>): string {
  if (spec.list === 'families') return `${formatCount(row.size ?? 0)} songs`;
  if (spec.list === 'kind' || spec.list === 'rankings') return formatCount(row.count ?? 0);
  const links = row.links ?? 0;
  if (!links) return '';
  return `${formatCount(links)} relationship${links === 1 ? '' : 's'}`;
}

/** Two specs open the same list. Used to avoid re-reading a page you are on. */
export function sameSpec(a: ExploreSpec, b: ExploreSpec): boolean {
  if (a.list !== b.list) return false;
  if (a.list === 'songs' && b.list === 'songs') return a.set === b.set;
  if (a.list === 'kind' && b.list === 'kind') return a.kind === b.kind && a.role === b.role;
  if (a.list === 'rankings' && b.list === 'rankings') {
    return a.kind === b.kind && a.role === b.role;
  }
  if (a.list === 'family' && b.list === 'family') return a.id === b.id;
  return a.list === 'families';
}

/* ───────────────────────────── kind filtering ────────────────────────────── */

export interface KindBearingEdge {
  kinds: string[];
}

/**
 * The edges whose relationship is one of `kinds`.
 *
 * An empty or absent selection means NO filter, not "nothing matches": a chip
 * row with nothing pressed shows the whole neighbourhood.
 *
 * An edge is kept when ANY of its kinds is selected, because ONE drawn edge
 * carries every relation stored for that pair (`graph.py`: a stem points at
 * the same parent as derived_from + edit_of + stem_of). Filtering on `kinds[0]`
 * — the one the UI colours by — would hide a stem from someone who asked to
 * see stems.
 */
export function filterEdgesByKinds<T extends KindBearingEdge>(
  edges: readonly T[],
  kinds: readonly string[] | undefined | null,
): readonly T[] {
  if (!kinds || kinds.length === 0) return edges;
  const wanted = new Set(kinds);
  return edges.filter((edge) => edge.kinds.some((kind) => wanted.has(kind)));
}

/* ─────────────────────── which number opens which list ───────────────────── */

/**
 * The list a headline card opens (`lineageScaleModel.summaryHeadlines` keys).
 *
 * "Largest cluster" is the one number with no list of its own on purpose: a
 * cluster is not a family — 81,501 songs welded by mashups — so what it leads
 * to is the links that do the welding, which is the fact the number is trying
 * to tell you.
 */
export function specForHeadline(key: string): ExploreSpec | null {
  switch (key) {
    case 'entries':
      return { list: 'songs', set: 'with_lineage' };
    case 'links':
      return { list: 'rankings', kind: KIND_ANY, role: 'parent' };
    case 'largest_tree':
      return { list: 'families' };
    case 'largest_connected':
      return { list: 'kind', kind: 'mashup_source', role: 'parent' };
    default:
      return null;
  }
}

/**
 * The generalisation of one preset ranked list, or null when there is none.
 *
 * `deepest` has none: depth is the length of a chain, not a count of links,
 * and no ranking over a kind and a role can say it. The preset stays the only
 * way to read it, which is honest — a "More…" that quietly showed a different
 * list would not be.
 */
export function specForRanking(list: string): ExploreSpec | null {
  switch (list) {
    case 'most_derived':
      return { list: 'rankings', kind: KIND_ANY, role: 'parent' };
    case 'mashup_sources':
      return { list: 'rankings', kind: 'mashup_source', role: 'parent' };
    case 'recent':
      // Newest first, or the "More…" under "Recently extended" would answer a
      // different question from the list it is under.
      return { list: 'songs', set: 'with_lineage', sort: 'created', dir: 'desc' };
    default:
      return null;
  }
}

/** The sort a list opens on: the one its route ranks by. */
export function defaultSortFor(spec: ExploreSpec): ExploreSort {
  if (spec.list === 'songs' && spec.sort) return spec.sort;
  const sorts = exploreSorts(spec);
  if (spec.list === 'songs' && sorts.includes('links')) return 'links';
  return sorts[0];
}

/** Counts read biggest-first; names read A to Z. */
export function defaultDirFor(spec: ExploreSpec): ExploreDir {
  if (spec.list === 'songs' && spec.dir) return spec.dir;
  return defaultSortFor(spec) === 'title' ? 'asc' : 'desc';
}
