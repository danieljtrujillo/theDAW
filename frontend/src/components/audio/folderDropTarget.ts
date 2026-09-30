/**
 * Where a dragged track header lands relative to a folder row, during the
 * same header reorder drag trackReorderDrag.ts already runs: the middle band
 * of a folder row means "file this track into that folder"; the bands at its
 * top and bottom edges still mean "reorder before/after it", exactly like any
 * other row. One drag gesture serves both reordering and filing. Pure: no
 * DOM, no React, no store.
 *
 * Units: `y` is local CSS px, the same convention rowLayout.ts and
 * trackOrder.ts use (scroll offset already applied by the caller).
 */

import { dropBeforeIdAtY, rowAtY, type RowLayout } from '../../lib/timeline/rowLayout';

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

/** The band at each end of a folder row that still means "reorder", not "file into this folder". */
export const FOLDER_EDGE_PX = 6;

export type TrackDropTarget =
  | { kind: 'reorder'; beforeId: string | null }
  | { kind: 'into-folder'; folderId: string };

/**
 * Whether `candidate` descends from `ancestor`, walking up through
 * `parentOf`. A visited set guards a corrupt (cyclic) parent chain: once a
 * node repeats, the chain is broken and the walk stops instead of looping
 * forever. `candidate` itself is never considered its own descendant.
 */
export function isDescendantOf(
  parentOf: (id: string) => string | null | undefined,
  candidate: string,
  ancestor: string,
): boolean {
  const visited = new Set<string>();
  let cur = candidate;
  for (;;) {
    if (visited.has(cur)) return false;
    visited.add(cur);
    const parent = parentOf(cur);
    if (parent === null || parent === undefined) return false;
    if (parent === ancestor) return true;
    cur = parent;
  }
}

/**
 * Reconstruct a parentOf lookup from the layout's own ordering: `layout.rows`
 * lists every track (visible or hidden behind a collapsed ancestor) in
 * depth-first pre-order, so a row's parent is always the nearest earlier row
 * whose depth is exactly one less. Avoids needing the raw track tree here.
 */
function parentOfIn(layout: RowLayout): (id: string) => string | null | undefined {
  const parents = new Map<string, string | null>();
  const openAncestors: string[] = []; // openAncestors[d] = the id currently open at depth d
  for (const row of layout.rows) {
    openAncestors.length = row.depth;
    parents.set(row.trackId, row.depth > 0 ? openAncestors[row.depth - 1] : null);
    openAncestors[row.depth] = row.trackId;
  }
  return (id) => parents.get(id);
}

/** True when `trackId` is itself moving, or nests under something that is. */
function isMovingOrDescendant(layout: RowLayout, trackId: string, movingIds: readonly string[]): boolean {
  if (movingIds.includes(trackId)) return true;
  if (movingIds.length === 0) return false;
  const parentOf = parentOfIn(layout);
  return movingIds.some((movingId) => isDescendantOf(parentOf, trackId, movingId));
}

/**
 * Resolve the drop target at `y`. The row under the pointer decides:
 * - not a row at all, or not a folder -> ordinary reorder.
 * - a folder that is itself moving, or nested under something moving ->
 *   ordinary reorder (a folder can never swallow itself or its own subtree).
 * - a folder's own top/bottom edge band -> ordinary reorder, so a folder row
 *   can still be reordered like any other row.
 * - otherwise, the folder's middle -> file the moving tracks into it.
 *
 * The edge band is `FOLDER_EDGE_PX`, clamped to half the row (minus half a
 * pixel) so it can never grow past the row's own centre:
 * `edge = min(FOLDER_EDGE_PX, max(0, (height - 1) / 2))`. That keeps the
 * middle band half-open (`[top + edge, top + height - edge)`) and at least
 * one whole pixel wide at every height, including a row shorter than
 * `2 * FOLDER_EDGE_PX`, where fixed-width edge bands would otherwise overlap
 * and swallow the whole row -- or, at exactly `2 * FOLDER_EDGE_PX`, demand
 * `fromTop > 6 AND fromTop < 6`, which is impossible.
 */
export function trackDropTargetAtY(
  layout: RowLayout,
  y: number,
  movingIds: readonly string[],
  isFolder: (trackId: string) => boolean,
): TrackDropTarget {
  finite(y, 'y');
  const row = rowAtY(layout, y);
  if (row && isFolder(row.trackId) && !isMovingOrDescendant(layout, row.trackId, movingIds)) {
    const fromTop = y - row.top;
    const fromBottom = row.top + row.height - y;
    const edge = Math.min(FOLDER_EDGE_PX, Math.max(0, (row.height - 1) / 2));
    const inMiddle = fromTop >= edge && fromBottom > edge;
    if (inMiddle) return { kind: 'into-folder', folderId: row.trackId };
  }
  return { kind: 'reorder', beforeId: dropBeforeIdAtY(layout.visibleRows, y) };
}

/** Plain-English label for the drag hint and the live-region announcement. */
export function dropTargetLabel(target: TrackDropTarget, folderName: (id: string) => string): string {
  return target.kind === 'into-folder' ? `Move into folder “${folderName(target.folderId)}”` : 'Reorder';
}
