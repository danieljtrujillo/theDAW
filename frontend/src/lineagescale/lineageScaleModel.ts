/**
 * The reading of a neighbourhood: what an edge is called, what a folded group
 * is called, what "+412 more" means, and where Back goes. Pure functions over
 * the wire shapes, so every rule here is pinned by a test that never renders
 * anything.
 *
 * Two decisions live here rather than in a component:
 *
 *  * ONE EDGE PER PAIR. The same relationship is stored several times in the
 *    real library — a stem points at its parent as derived_from AND edit_of
 *    AND stem_of. The server already merges them; `mergeEdges` merges again on
 *    arrival so the view can never draw three lines between the same two boxes
 *    whatever it is handed, and the label names every kind on the pair.
 *  * A FOLDED GROUP IS A QUERY, NOT A DRAWING. A node with 800 children gets a
 *    "Covers (312)" box, and opening it asks `relatives` for a page — a list,
 *    which stays the same size however big the family is.
 */
import { EDGE_COLOR_BY_KIND, edgeColor, relationWords } from '../lib/lineageInsights';
import type {
  HiddenCount,
  LinkRole,
  NeighbourEdge,
  NeighbourGroup,
  NeighbourNode,
  Neighbourhood,
  RankingList,
  RelativesRequest,
  RelativesSort,
} from './lineageScaleClient';

/* ─────────────────────────────────── edges ───────────────────────────────── */

/** Key for a (child, parent) pair. The ids come from the database and can hold
 *  anything, so the separator is one that an id cannot contain unescaped. */
const pairKey = (from: string, to: string): string =>
  `${encodeURIComponent(from)}\u0000${encodeURIComponent(to)}`;

/**
 * One edge per (from, to) pair, its `kinds` the union of every kind seen for
 * that pair in first-seen order. A pair that arrives with two different roles
 * keeps the first role that is not `other`, because `other` is the "we have
 * not classified this" bucket and any classified role is more informative.
 */
export function mergeEdges(edges: readonly NeighbourEdge[]): NeighbourEdge[] {
  const out: NeighbourEdge[] = [];
  const at = new Map<string, number>();
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    const key = pairKey(e.from, e.to);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, out.length);
      out.push({ from: e.from, to: e.to, kinds: e.kinds.slice(), role: e.role });
      continue;
    }
    const merged = out[index];
    for (let k = 0; k < e.kinds.length; k += 1) {
      if (!merged.kinds.includes(e.kinds[k])) merged.kinds.push(e.kinds[k]);
    }
    if (merged.role === 'other' && e.role !== 'other') merged.role = e.role;
  }
  return out;
}

/** Every kind on the edge, as words: "derived from · edit of · stem of". */
export const edgeKindsLabel = (kinds: readonly string[]): string =>
  kinds.length === 0 ? 'related' : kinds.map(relationWords).join(' · ');

/**
 * The edge's colour: the app-wide colour of its FIRST kind. `EDGE_COLOR_BY_KIND`
 * is the whole palette — a kind that is not in it gets that module's neutral,
 * and no colour is invented here, so a line means the same thing in this view
 * as it does in the lineage window.
 */
export const edgeColorForKinds = (kinds: readonly string[]): string =>
  edgeColor(kinds.length > 0 ? kinds[0] : '');

/** True when the palette actually names this edge's first kind. */
export const edgeKindIsPaletted = (kinds: readonly string[]): boolean =>
  kinds.length > 0 && Object.prototype.hasOwnProperty.call(EDGE_COLOR_BY_KIND, kinds[0]);

/**
 * `uses` is drawn dashed. A mashup "uses" two songs from unrelated trees; that
 * is a cross-reference, not descent, and the dash is the visual promise that
 * the view will not walk through it.
 */
export const isCrossReferenceRole = (role: LinkRole): boolean => role === 'uses';

/** Line weight by role: descent reads heavier than a cross-reference. */
export const edgeWidthForRole = (role: LinkRole): number => (role === 'ancestry' ? 1.6 : 1.1);

/* ─────────────────────────────── kind wording ────────────────────────────── */

/**
 * A relation is stored once but READS TWO WAYS, and the direction is which way
 * you are reading it from the focus song.
 *
 * This is not a nicety. A song that 677 mashups were built from emits a group
 * `{kind: 'mashup_source', direction: 'down', count: 677}` — `down` meaning
 * "made FROM this song". Labelling that "Mashup sources (677)" says the song
 * has 677 sources. It has none: it IS the source. The same group pointing `up`
 * — a mashup's own ingredients — is the one "Mashup sources" describes.
 *
 * So every phrase for a kind lives in ONE table with a column per direction,
 * and every label, heading and spoken sentence is read out of it. Nothing
 * composes its own wording, so nothing can drift back into stating the
 * opposite of the truth.
 */
export type RelativeDirection = 'up' | 'down';

export interface KindWording {
  /** A fold of songs made FROM the focus. */
  down: string;
  /** A fold of songs the focus was made FROM. */
  up: string;
  /** Spoken sentence, `{n}` and `{title}` filled in, derivatives side. */
  downSentence: string;
  /** The same, sources side. */
  upSentence: string;
}

export const KIND_WORDING: Record<string, KindWording> = {
  cover_of: {
    down: 'Covers', up: 'Cover of',
    downSentence: '{n} covers of {title}', upSentence: '{n} songs {title} is a cover of',
  },
  /**
   * The Suno poller writes a bare `cover` (backend/modules/suno/router.py:346)
   * where the promoted writer writes `cover_of`. Same relationship, so the
   * same words — the backend has already turned both into (child, parent), so
   * `down` still means derivatives here.
   */
  cover: {
    down: 'Covers', up: 'Cover of',
    downSentence: '{n} covers of {title}', upSentence: '{n} songs {title} is a cover of',
  },
  edit_of: {
    down: 'Edits', up: 'Edit of',
    downSentence: '{n} edits of {title}', upSentence: '{n} songs {title} is an edit of',
  },
  derived_from: {
    down: 'Derivatives', up: 'Derived from',
    downSentence: '{n} songs derived from {title}', upSentence: '{n} songs {title} was derived from',
  },
  upsample_of: {
    down: 'Upsamples', up: 'Upsample of',
    downSentence: '{n} upsamples of {title}', upSentence: '{n} songs {title} is an upsample of',
  },
  stem_of: {
    down: 'Stems', up: 'Stem of',
    downSentence: '{n} stems of {title}', upSentence: '{n} songs {title} is a stem of',
  },
  overpaint_of: {
    down: 'Overpaints', up: 'Overpaint of',
    downSentence: '{n} overpaints of {title}', upSentence: '{n} songs {title} is an overpaint of',
  },
  underpaint_of: {
    down: 'Underpaints', up: 'Underpaint of',
    downSentence: '{n} underpaints of {title}', upSentence: '{n} songs {title} is an underpaint of',
  },
  speed_change_of: {
    down: 'Speed changes', up: 'Speed change of',
    downSentence: '{n} speed changes of {title}', upSentence: '{n} songs {title} is a speed change of',
  },
  mashup_source: {
    down: 'Used in mashups', up: 'Mashup sources',
    downSentence: '{n} mashups use {title}', upSentence: '{n} songs {title} was mashed up from',
  },
  /** The poller's bare sibling of `mashup_source`; see `cover` above. */
  mashup: {
    down: 'Used in mashups', up: 'Mashup sources',
    downSentence: '{n} mashups use {title}', upSentence: '{n} songs {title} was mashed up from',
  },
  chimera_source_of: {
    down: 'Used in chimeras', up: 'Chimera sources',
    downSentence: '{n} chimeras use {title}', upSentence: '{n} songs {title} was built from',
  },
  /** The `kind=all` list: every relation in that direction at once. */
  all: {
    down: 'Derivatives', up: 'Sources',
    downSentence: '{n} songs made from {title}', upSentence: '{n} songs {title} was made from',
  },
};

const titleCase = (s: string): string => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

/**
 * The label for a fold of this kind, read this way round. A kind the table does
 * not know is named by its own words and told WHICH SIDE it is on — never
 * silently borrowed from the other direction.
 */
export function kindWords(kind: string, direction: RelativeDirection): string {
  const wording = KIND_WORDING[kind];
  if (wording) return direction === 'up' ? wording.up : wording.down;
  return `${titleCase(relationWords(kind))} (${direction === 'up' ? 'sources' : 'derived'})`;
}

/**
 * The same relationship as a sentence, for assistive tech.
 *
 * The nouns are plural because the only thing that is ever counted here is a
 * FOLDED GROUP, and the server folds only past twelve relatives of one kind in
 * one direction — a count of one cannot reach this function.
 */
export function kindSentence(
  kind: string,
  direction: RelativeDirection,
  count: number,
  title: string,
): string {
  const wording = KIND_WORDING[kind];
  const template = wording
    ? (direction === 'up' ? wording.upSentence : wording.downSentence)
    : (direction === 'up' ? '{n} sources of {title} ({words})' : '{n} derivatives of {title} ({words})');
  return template
    .replace('{n}', formatCount(count))
    .replace('{title}', title)
    .replace('{words}', relationWords(kind));
}

/* ─────────────────────────────────── groups ──────────────────────────────── */

/** "Used in mashups (677)" — what a folded group's box says. */
export const groupLabel = (group: Pick<NeighbourGroup, 'kind' | 'count' | 'direction'>): string =>
  `${kindWords(group.kind, group.direction)} (${formatCount(group.count)})`;

/** What the box says out loud: "677 mashups use Night Drive. Open the list." */
export const groupAccessibleName = (
  group: Pick<NeighbourGroup, 'kind' | 'count' | 'direction'>,
  parentTitle: string,
): string => `${kindSentence(group.kind, group.direction, group.count, parentTitle)}. Open the list.`;

/** The heading the opened list carries: the same label, plus whose fold it is. */
export const groupHeading = (
  group: Pick<NeighbourGroup, 'kind' | 'count' | 'direction'>,
  parentTitle: string,
): string => `${groupLabel(group)} — ${parentTitle}`;

/* ──────────────────────────────── list rows ──────────────────────────────── */

/**
 * A row in a relatives list is a SONG, and the kinds on it name the link, not
 * the row. In the `up` list the row is the source and in the `down` list it is
 * the derivative, so the side is stated rather than left to be inferred from a
 * phrase that reads the other way round.
 */
export const relativeRoleWord = (direction: RelativeDirection): string =>
  direction === 'up' ? 'source' : 'derivative';

export const relativeRowWords = (kinds: readonly string[], direction: RelativeDirection): string =>
  `${edgeKindsLabel(kinds)} · ${relativeRoleWord(direction)}`;

export const relativeRowAccessibleWords = (
  kinds: readonly string[],
  direction: RelativeDirection,
): string => `${edgeKindsLabel(kinds)}, a ${relativeRoleWord(direction)} of this song`;

/** Opening a group is a `relatives` query: the parent, that direction, that
 *  kind, page one. Sorting and paging then belong to the panel. */
export const relativesRequestForGroup = (
  group: Pick<NeighbourGroup, 'parent_id' | 'direction' | 'kind'>,
  sort: RelativesSort = 'title',
  limit = 100,
): RelativesRequest => ({
  entryId: group.parent_id,
  direction: group.direction,
  kind: group.kind,
  sort,
  offset: 0,
  limit,
});

/** "See every relative of this node" — the same query with no kind filter. */
export const relativesRequestForNode = (
  entryId: string,
  direction: 'up' | 'down',
  sort: RelativesSort = 'title',
  limit = 100,
): RelativesRequest => ({ entryId, direction, kind: 'all', sort, offset: 0, limit });

/* ─────────────────────────────────── hidden ──────────────────────────────── */

export const NO_HIDDEN: HiddenCount = { up: 0, down: 0 };

/** What was not expanded around one node. Absent means nothing was hidden. */
export const hiddenFor = (
  hidden: Record<string, HiddenCount> | undefined,
  nodeId: string,
): HiddenCount => hidden?.[nodeId] ?? NO_HIDDEN;

export const hiddenTotal = (h: HiddenCount): number => (h.up || 0) + (h.down || 0);

/** "+412 more", or '' when nothing is hidden — so a caller can render the
 *  badge on truth rather than on a zero. */
export const hiddenLabel = (h: HiddenCount): string => {
  const total = hiddenTotal(h);
  return total > 0 ? `+${formatCount(total)} more` : '';
};

/**
 * Can this node be focused — i.e. asked for by id?
 *
 * No, if its id contains a '/'. `/{entry_id}/neighbourhood` takes the id as a
 * PATH segment, and a '/' inside it is a path separator before any route
 * matching happens, so the request 404s however carefully the client escapes
 * it. Real entry ids never contain one (uuid4 hex, or "{job}_{index}"), but a
 * node can also be a bare link endpoint — a chimera source LABEL is an
 * arbitrary string from the entry's metadata. Those are drawn as plain labels
 * rather than as buttons that are guaranteed to fail.
 */
export const canFocusNode = (id: string): boolean => !id.includes('/');

/** True when the server left ANY relative unexpanded anywhere in this walk. */
export const hasHiddenRelatives = (
  hidden: Record<string, HiddenCount> | undefined,
): boolean => {
  for (const count of Object.values(hidden ?? {})) {
    if (hiddenTotal(count) > 0) return true;
  }
  return false;
};

/**
 * "This song stands alone" — true only when the walk found NOTHING.
 *
 * `nodes.length <= 1` alone is wrong, and wrong in the loudest case there is:
 * a hub whose relatives are ALL folded comes back as `nodes: [focus]` plus a
 * list of groups, so the one song with 800 covers would be captioned as having
 * no family while its group boxes went undrawn. A folded group and a hidden
 * count are both relatives; either one means this song is not alone.
 */
export const standsAlone = (
  data: Pick<Neighbourhood, 'nodes' | 'groups' | 'hidden'>,
): boolean =>
  data.nodes.length <= 1 && data.groups.length === 0 && !hasHiddenRelatives(data.hidden);

/** The badge said in full: which side the hidden relatives are on. */
export const hiddenAccessibleName = (h: HiddenCount, title: string): string => {
  const parts: string[] = [];
  if (h.up > 0) parts.push(`${formatCount(h.up)} more sources`);
  if (h.down > 0) parts.push(`${formatCount(h.down)} more derivatives`);
  return parts.length === 0 ? '' : `${parts.join(' and ')} of ${title}. Focus it to expand.`;
};

/* ──────────────────────────────── breadcrumbs ────────────────────────────── */

export interface Crumb {
  id: string;
  title: string;
}

/**
 * Focusing a node pushes a crumb — except:
 *   * re-focusing the song already in view changes nothing;
 *   * focusing a song that is ALREADY in the trail walks back to it instead of
 *     growing the trail, so an hour of clicking A → B → A → B leaves two
 *     crumbs, not sixty.
 */
export function pushCrumb(trail: readonly Crumb[], crumb: Crumb): Crumb[] {
  const at = trail.findIndex((c) => c.id === crumb.id);
  if (at >= 0) {
    const kept = trail.slice(0, at + 1);
    kept[at] = { id: crumb.id, title: crumb.title || kept[at].title };
    return kept;
  }
  return trail.concat([crumb]);
}

/** Back: drop the last crumb. The first crumb is never dropped — there is
 *  nowhere behind it but the landing page, which has its own control. */
export function popCrumb(trail: readonly Crumb[]): Crumb[] {
  return trail.length <= 1 ? trail.slice() : trail.slice(0, trail.length - 1);
}

export const currentCrumb = (trail: readonly Crumb[]): Crumb | null =>
  trail.length > 0 ? trail[trail.length - 1] : null;

/** True when Back has somewhere to go. */
export const canGoBack = (trail: readonly Crumb[]): boolean => trail.length > 1;

/* ──────────────────────────────── node reading ───────────────────────────── */

/**
 * The focus node of an answer. The requested id wins; a server that names the
 * focus differently still resolves through generation 0, so the view cannot be
 * left without a centre.
 */
export function focusNodeOf(
  data: Pick<Neighbourhood, 'nodes' | 'focus'>,
  requestedId?: string,
): NeighbourNode | null {
  const wanted = requestedId ?? data.focus;
  for (let i = 0; i < data.nodes.length; i += 1) {
    if (data.nodes[i].id === wanted) return data.nodes[i];
  }
  for (let i = 0; i < data.nodes.length; i += 1) {
    if (data.nodes[i].generation === 0) return data.nodes[i];
  }
  return null;
}

/** A node with no title of its own still needs something to say — its id. */
export const nodeTitle = (node: Pick<NeighbourNode, 'id' | 'title'>): string =>
  node.title && node.title.trim() ? node.title : node.id;

/** "2 generations up" / "the focus" / "1 generation down". */
export function generationWords(generation: number): string {
  if (generation === 0) return 'the focus';
  const n = Math.abs(generation);
  return `${n} generation${n === 1 ? '' : 's'} ${generation < 0 ? 'up' : 'down'}`;
}

/** What a screen reader hears on a node button. */
export function nodeAccessibleName(node: NeighbourNode): string {
  const bits: string[] = [nodeTitle(node), generationWords(node.generation)];
  if (node.duration_sec > 0) bits.push(formatDuration(node.duration_sec));
  if (node.play_count > 0) bits.push(`${formatCount(node.play_count)} plays`);
  if (!node.in_library) bits.push('no longer in the library');
  return `${bits.join(', ')}. Focus this song.`;
}

/* ──────────────────────────────── formatting ─────────────────────────────── */

/** Thousands separators, because these numbers reach six figures. */
export const formatCount = (n: number): string =>
  Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';

/** m:ss, or h:mm:ss past an hour. '' when there is no duration to show. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/* ──────────────────────────────── the landing ────────────────────────────── */

export const RANKING_TITLES: Record<RankingList, string> = {
  most_derived: 'Most derived from',
  deepest: 'Deepest lineage',
  mashup_sources: 'Most used in mashups',
  recent: 'Recently extended',
};

export const RANKING_HINTS: Record<RankingList, string> = {
  most_derived: 'Songs with the most distinct descendants',
  deepest: 'Longest chain of descent ending at the song',
  mashup_sources: 'Songs the most mashups were built from',
  recent: 'Songs that most recently gained a child',
};

export interface Headline {
  key: string;
  label: string;
  value: string;
  hint: string;
}

/**
 * The four numbers the landing page leads with. `largest_connected` and
 * `largest_tree` are shown side by side on purpose: the gap between them is
 * the whole reason this view exists — a connected component is not a family,
 * because mashups weld unrelated trees together.
 */
export function summaryHeadlines(summary: {
  entries: number;
  with_lineage: number;
  standalone: number;
  links_distinct: number;
  largest_connected: number;
  largest_tree: number;
}): Headline[] {
  return [
    {
      key: 'entries',
      label: 'Songs',
      value: formatCount(summary.entries),
      hint: `${formatCount(summary.with_lineage)} with lineage, ${formatCount(summary.standalone)} standalone`,
    },
    {
      key: 'links',
      label: 'Relationships',
      value: formatCount(summary.links_distinct),
      hint: 'distinct song-to-song links',
    },
    {
      key: 'largest_tree',
      label: 'Largest family',
      value: formatCount(summary.largest_tree),
      hint: 'songs sharing one line of descent',
    },
    {
      key: 'largest_connected',
      label: 'Largest cluster',
      value: formatCount(summary.largest_connected),
      hint: 'connected through mashups — not one family',
    },
  ];
}

/** The kinds worth listing under the headline numbers, biggest first. */
export function kindRows(byKind: Record<string, number>, top = 10): Array<[string, number]> {
  const rows: Array<[string, number]> = [];
  for (const kind of Object.keys(byKind)) rows.push([kind, byKind[kind]]);
  rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows.slice(0, top);
}
