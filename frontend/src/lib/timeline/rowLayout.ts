/**
 * One shared row-layout index for the arrangement: a single pure pass over
 * the track tree that turns hierarchy + collapse state + per-row heights into
 * every row's vertical position, so call sites stop deriving `index *
 * trackHeight` by hand. A folder can hide its children and indent them
 * without every call site re-deriving geometry: a collapsed folder's
 * descendants take no vertical space, and a visible row always knows its
 * `top`, `height` and `depth`.
 *
 * Units: all vertical positions and heights are local CSS px, measured from
 * the top of the track-list content (scroll offset already applied by the
 * caller) — the same convention as trackOrder.ts.
 *
 * A folder is organisational only: it groups and indents rows for display and
 * collapse. It does not route audio and is not an audio node — that lives in
 * the routing graph, untouched by this module.
 *
 * Pure: no DOM, no React, no store. Does not account for the pinned master
 * row (F22 renders that outside the scrolling rows). Tree walking, cycle
 * checks and binary search are never reimplemented here — `assertTree`,
 * `flattenVisible`, `layoutRows`, `rowAtY`, `insertionIndexAtY` and
 * `dropBeforeIdAtY` are reused from ./trackOrder unchanged.
 */

import {
  type Row,
  assertTree,
  dropBeforeIdAtY,
  flattenVisible,
  insertionIndexAtY,
  layoutRows,
  rowAtY as rowAtYBase,
} from './trackOrder';

/**
 * One row's full geometry, visible or not. `top`/`height` are local CSS px;
 * `depth` is the row's nesting depth (0 = top level) and is always correct,
 * even when the row is hidden. `index` is the row's position among VISIBLE
 * rows only: a hidden row (a descendant of a collapsed folder) gets `index:
 * -1`, `height: 0`, and `top` equal to the top of its nearest visible
 * ancestor's row, since it takes no space of its own.
 */
export interface LayoutRow {
  trackId: string;
  top: number;
  height: number;
  depth: number;
  visible: boolean;
  index: number;
}

/** One track as `buildRowLayout` needs it: hierarchy plus its own row height. */
export interface RowLayoutInput {
  id: string;
  parentId: string | null;
  kind: 'audio' | 'midi' | 'folder';
  collapsed?: boolean;
  height: number;
}

/**
 * The built index. `visibleRows` is exactly the `Row[]` shape from
 * trackOrder, so `insertionIndexAtY`, `dropBeforeIdAtY` and
 * `trackReorderDrag`'s `reorderRows` consumers keep working unchanged.
 */
export interface RowLayout {
  rows: LayoutRow[];
  visibleRows: Row[];
  totalHeight: number;
}

/** Per-layout index of trackId -> LayoutRow, built once so the helpers below are O(1)/O(log n) after the build. */
const layoutIndexCache = new WeakMap<RowLayout, Map<string, LayoutRow>>();

function layoutIndexFor(layout: RowLayout): Map<string, LayoutRow> {
  let index = layoutIndexCache.get(layout);
  if (!index) {
    index = new Map(layout.rows.map((row) => [row.trackId, row]));
    layoutIndexCache.set(layout, index);
  }
  return index;
}

/**
 * Build the row-layout index for `tracks`. Every height must be finite and >
 * 0, otherwise RangeError (same message as `layoutRows`) — checked for every
 * track, visible or not, since a track hidden by a collapsed ancestor still
 * owns a real height that reappears the moment the folder expands. A tree
 * violation (duplicate id, missing/non-folder parent, cycle) propagates from
 * `assertTree` unchanged.
 */
export function buildRowLayout(tracks: readonly RowLayoutInput[]): RowLayout {
  for (const t of tracks) {
    if (!Number.isFinite(t.height) || t.height <= 0) throw new RangeError('Row height must be positive');
  }
  assertTree(tracks);

  // Full depth-first order of every track, collapse ignored: reuses
  // flattenVisible's own tree walk instead of re-deriving pre-order here.
  // (Collapse never changes tree shape, only which rows flattenVisible keeps,
  // so this is the same traversal `assertTree` just validated.)
  const fullList = flattenVisible(tracks.map((t) => ({ ...t, collapsed: false })));
  // The same walk, this time respecting collapse: exactly the visible rows.
  const visibleList = flattenVisible(tracks);
  const visibleIds = new Set(visibleList.map((item) => item.track.id));
  const visibleRows = layoutRows(visibleList.map((item) => ({ id: item.track.id, height: item.track.height })));
  const rowById = new Map(visibleRows.map((row) => [row.id, row]));

  // fullList is pre-order, so a parent is always visited before its
  // children: a hidden row can resolve its nearest visible ancestor's top
  // from what was already recorded for its (already-visited) parent.
  const nearestVisibleTop = new Map<string, number>();
  const rows: LayoutRow[] = fullList.map(({ track, depth }) => {
    if (visibleIds.has(track.id)) {
      const row = rowById.get(track.id) as Row;
      nearestVisibleTop.set(track.id, row.top);
      return { trackId: track.id, top: row.top, height: row.height, depth, visible: true, index: row.index };
    }
    const top = track.parentId !== null ? (nearestVisibleTop.get(track.parentId) ?? 0) : 0;
    nearestVisibleTop.set(track.id, top);
    return { trackId: track.id, top, height: 0, depth, visible: false, index: -1 };
  });

  const lastVisible = visibleRows[visibleRows.length - 1];
  const layout: RowLayout = {
    rows,
    visibleRows,
    totalHeight: lastVisible ? lastVisible.top + lastVisible.height : 0,
  };
  layoutIndexCache.set(layout, new Map(rows.map((row) => [row.trackId, row])));
  return layout;
}

/**
 * The visible row containing `y` (local CSS px). Top edge inclusive, bottom
 * edge exclusive; a hidden row never matches, and outside every visible row
 * -> undefined. O(log n): binary search over `visibleRows`, reused unchanged
 * from trackOrder's `rowAtY`.
 */
export function rowAtY(layout: RowLayout, y: number): LayoutRow | undefined {
  const row = rowAtYBase(layout.visibleRows, y);
  return row ? layoutIndexFor(layout).get(row.id) : undefined;
}

/** The top of `trackId`'s row: its own top if visible, its nearest visible ancestor's top if hidden. O(1). */
export function topOf(layout: RowLayout, trackId: string): number | undefined {
  return layoutIndexFor(layout).get(trackId)?.top;
}

/** The height of `trackId`'s row: its real height if visible, 0 if hidden. O(1). */
export function heightOf(layout: RowLayout, trackId: string): number | undefined {
  return layoutIndexFor(layout).get(trackId)?.height;
}

/** The total height of the visible rows only; a collapsed subtree contributes nothing. O(1). */
export function totalHeight(layout: RowLayout): number {
  return layout.totalHeight;
}

/** `trackId`'s nesting depth (0 = top level), correct whether or not the row is currently visible. O(1). */
export function depthOf(layout: RowLayout, trackId: string): number | undefined {
  return layoutIndexFor(layout).get(trackId)?.depth;
}

/** Whether `trackId` currently occupies a row (false for a descendant of a collapsed folder, or an unknown id). O(1). */
export function isVisible(layout: RowLayout, trackId: string): boolean {
  return layoutIndexFor(layout).get(trackId)?.visible ?? false;
}

export { dropBeforeIdAtY, insertionIndexAtY };
