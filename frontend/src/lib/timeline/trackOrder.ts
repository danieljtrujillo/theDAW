/**
 * Track ordering and row geometry for the arrangement: multi-track moves
 * (drag handle, keyboard, store action), variable-height row layout and every
 * y -> track hit test. Pure: no DOM, no React, no store.
 *
 * Units: all vertical positions and heights are local CSS px, measured from the
 * top of the track-list content (scroll offset already applied by the caller).
 *
 * The folder helpers (TreeTrack, assertTree, flattenVisible, moveSubtree) are
 * arrangement hierarchy only; audio routing stays in the routing graph.
 */

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

/** The moving ids as a set, deduped; any id not present in `order` throws. */
function movingSet(order: readonly string[], movingIds: readonly string[]): Set<string> {
  const known = new Set(order);
  const moving = new Set<string>();
  for (const id of movingIds) {
    if (!known.has(id)) throw new Error(`Unknown track id: ${id}`);
    moving.add(id);
  }
  return moving;
}

/**
 * Move `movingIds` so they sit immediately before `beforeId` (null = end).
 * The moving set keeps its CURRENT relative order in `order`, whatever order
 * the selection was made in; duplicates are ignored. If `beforeId` is itself
 * moving, the anchor becomes the first non-moving id after it in `order`
 * (none -> end). Unknown ids throw. Returns a new array.
 */
export function moveIds(order: readonly string[], movingIds: readonly string[], beforeId: string | null): string[] {
  const moving = movingSet(order, movingIds);
  let anchor: string | null = beforeId;
  if (anchor !== null) {
    const at = order.indexOf(anchor);
    if (at < 0) throw new Error(`Unknown track id: ${anchor}`);
    if (moving.has(anchor)) {
      anchor = null;
      for (let i = at + 1; i < order.length; i++) {
        if (!moving.has(order[i])) {
          anchor = order[i];
          break;
        }
      }
    }
  }
  const block = order.filter((id) => moving.has(id));
  const rest = order.filter((id) => !moving.has(id));
  const insertAt = anchor === null ? rest.length : rest.indexOf(anchor);
  rest.splice(insertAt, 0, ...block);
  return rest;
}

/** True when both orders hold the same ids in the same positions (no-op detection). */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Keyboard move by one step. Each maximal contiguous run of moving ids moves
 * past the one non-moving neighbour on the `offset` side; a run already at
 * that edge stays put. Unknown ids throw. Returns a new array.
 */
export function moveByOffset(order: readonly string[], movingIds: readonly string[], offset: -1 | 1): string[] {
  const moving = movingSet(order, movingIds);
  const out = [...order];
  // Runs are computed on the original order. Each run's swap touches only the
  // run plus one neighbour, and two runs are separated by at least one
  // non-moving id, so the swaps never overlap.
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < order.length; i++) {
    if (!moving.has(order[i])) continue;
    const start = i;
    while (i + 1 < order.length && moving.has(order[i + 1])) i++;
    runs.push([start, i]);
  }
  for (const [start, end] of runs) {
    if (offset === -1) {
      if (start === 0) continue;
      const [neighbour] = out.splice(start - 1, 1);
      out.splice(end, 0, neighbour);
    } else {
      if (end === order.length - 1) continue;
      const [neighbour] = out.splice(end + 1, 1);
      out.splice(start, 0, neighbour);
    }
  }
  return out;
}

/** One laid-out track row. `top` and `height` in local CSS px; `index` is the row's position. */
export interface Row {
  id: string;
  top: number;
  height: number;
  index: number;
}

/**
 * Stack rows top to bottom starting at `startTop` (local CSS px, default 0).
 * Every height must be finite and > 0, otherwise RangeError.
 */
export function layoutRows(items: readonly { id: string; height: number }[], startTop = 0): Row[] {
  let top = finite(startTop, 'startTop');
  return items.map((item, index) => {
    if (!Number.isFinite(item.height) || item.height <= 0) throw new RangeError('Row height must be positive');
    const row: Row = { id: item.id, top, height: item.height, index };
    top += item.height;
    return row;
  });
}

/** Position of the first row whose bottom is below `y` (rows sorted by top). */
function firstRowEndingAfter(rows: readonly Row[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].top + rows[mid].height <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The row containing `y` (local CSS px), by binary search over rows sorted by
 * top. Top edge inclusive, bottom edge exclusive; outside every row -> undefined.
 */
export function rowAtY(rows: readonly Row[], y: number): Row | undefined {
  finite(y, 'y');
  const row = rows[firstRowEndingAfter(rows, y)];
  return row && y >= row.top ? row : undefined;
}

/**
 * Insertion slot for a drop at `y` (local CSS px), 0..rows.length. The upper
 * half of a row gives its position, the lower half position + 1; above all
 * rows -> 0, below all -> rows.length. Positions are array positions in `rows`.
 */
export function insertionIndexAtY(rows: readonly Row[], y: number): number {
  finite(y, 'y');
  const at = firstRowEndingAfter(rows, y);
  const row = rows[at];
  if (!row) return rows.length;
  if (y < row.top) return at;
  return y < row.top + row.height / 2 ? at : at + 1;
}

/** The id a drop at `y` lands before, for moveIds; null means the end. */
export function dropBeforeIdAtY(rows: readonly Row[], y: number): string | null {
  return rows[insertionIndexAtY(rows, y)]?.id ?? null;
}

/** Arrangement hierarchy node. Only folders may be parents. */
export interface TreeTrack {
  id: string;
  parentId: string | null;
  kind: 'audio' | 'midi' | 'folder';
  collapsed?: boolean;
}

/**
 * Validate the hierarchy: unique ids, every parent an existing folder, no
 * cycles. Returns id -> track. Linear time (each ancestor chain is walked once).
 */
export function assertTree<T extends TreeTrack>(tracks: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const t of tracks) map.set(t.id, t);
  if (map.size !== tracks.length) throw new Error('Duplicate track ID');
  const verified = new Set<string>();
  for (const t of tracks) {
    const path = new Set<string>();
    let cur: T = t;
    for (;;) {
      if (verified.has(cur.id)) break;
      if (path.has(cur.id)) throw new Error('Track hierarchy cycle');
      path.add(cur.id);
      if (cur.parentId === null) break;
      const parent = map.get(cur.parentId);
      if (!parent || parent.kind !== 'folder') throw new Error('Parent must be an existing folder');
      cur = parent;
    }
    for (const id of path) verified.add(id);
  }
  return map;
}

function childrenByParent<T extends TreeTrack>(tracks: readonly T[]): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const t of tracks) {
    const list = out.get(t.parentId);
    if (list) list.push(t);
    else out.set(t.parentId, [t]);
  }
  return out;
}

/** Depth-first pre-order of the whole tree (siblings in input order), iterative. */
function preOrder<T extends TreeTrack>(byParent: Map<string | null, T[]>): Array<{ track: T; depth: number }> {
  const out: Array<{ track: T; depth: number }> = [];
  const stack: Array<{ track: T; depth: number }> = [];
  const pushChildren = (parent: string | null, depth: number): void => {
    const kids = byParent.get(parent) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ track: kids[i], depth });
  };
  pushChildren(null, 0);
  while (stack.length > 0) {
    const item = stack.pop() as { track: T; depth: number };
    out.push(item);
    pushChildren(item.track.id, item.depth + 1);
  }
  return out;
}

/**
 * The rows a track list shows: depth-first, siblings in input order, children
 * of a collapsed folder hidden. `descendantCount` counts all descendants,
 * visible or not. Iterative, with counts computed once.
 */
export function flattenVisible<T extends TreeTrack>(
  tracks: readonly T[],
): Array<{ track: T; depth: number; descendantCount: number }> {
  assertTree(tracks);
  const byParent = childrenByParent(tracks);
  const all = preOrder(byParent);
  const counts = new Map<string, number>();
  for (let i = all.length - 1; i >= 0; i--) {
    const { track } = all[i];
    let n = 0;
    for (const child of byParent.get(track.id) ?? []) n += 1 + (counts.get(child.id) ?? 0);
    counts.set(track.id, n);
  }
  const out: Array<{ track: T; depth: number; descendantCount: number }> = [];
  let hiddenBelowDepth = Number.POSITIVE_INFINITY;
  for (const { track, depth } of all) {
    if (depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = Number.POSITIVE_INFINITY;
    out.push({ track, depth, descendantCount: counts.get(track.id) ?? 0 });
    if (track.collapsed) hiddenBelowDepth = depth;
  }
  return out;
}

/**
 * Move a track and its whole subtree under `newParentId` (null = root),
 * before sibling `beforeId` in the destination (undefined = append). Child
 * ids and order are preserved. Rejects cycles (a folder into itself or a
 * descendant), non-folder parents, unknown ids and anchors that are not
 * destination siblings. Returns a new array in depth-first order — even a
 * drop that changes nothing still returns the list in depth-first order,
 * never the input array.
 */
export function moveSubtree<T extends TreeTrack>(
  tracks: readonly T[],
  dragId: string,
  newParentId: string | null,
  beforeId?: string,
): T[] {
  const map = assertTree(tracks);
  const dragged = map.get(dragId);
  if (!dragged) throw new Error('Dragged track does not exist');
  if (beforeId === dragId && newParentId === dragged.parentId) {
    return preOrder(childrenByParent(tracks)).map((item) => item.track);
  }
  const changed: T = { ...dragged, parentId: newParentId };
  const proposed = tracks.map((t) => (t.id === dragId ? changed : t));
  assertTree(proposed);
  const groups = childrenByParent(proposed);
  for (const [parent, list] of groups) groups.set(parent, list.filter((t) => t.id !== dragId));
  const siblings = groups.get(newParentId) ?? [];
  const at = beforeId === undefined ? siblings.length : siblings.findIndex((t) => t.id === beforeId);
  if (at < 0) throw new Error('Drop anchor is not a destination sibling');
  siblings.splice(at, 0, changed);
  groups.set(newParentId, siblings);
  return preOrder(groups).map((item) => item.track);
}
