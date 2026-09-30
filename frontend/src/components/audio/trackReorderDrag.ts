/**
 * Drag a track header to reorder the arrangement: the pointer session
 * (pending -> active -> drop/cancel), which tracks travel with the grip, and
 * where a drop at a given y lands. Pure: no DOM, no React, no store — the
 * component owns capture, rendering and the store write.
 *
 * Units: `clientY` is viewport CSS px. The threshold is measured there on
 * purpose, so an autoscroll step (which moves the content under a stationary
 * pointer) never counts as pointer travel. `localY` is CSS px from the top of
 * the track-list content, with the scroll offset already applied by the caller.
 *
 * Nothing here touches routing, clips or ids: a reorder is a permutation of the
 * track array and nothing else.
 */

import {
  type Row,
  dropBeforeIdAtY,
  insertionIndexAtY,
  layoutRows,
  moveIds,
  sameOrder,
} from '../../lib/timeline/trackOrder';

/** Vertical travel, in client CSS px, that turns a press on the grip into a drag. */
export const REORDER_THRESHOLD_PX = 4;

/** 'pending' = pressed, still a click; 'active' = dragging; 'cancelled' = spent. */
export type ReorderPhase = 'pending' | 'active' | 'cancelled';

/** An in-flight header drag. Immutable: every step returns the next session. */
export interface ReorderSession {
  readonly pointerId: number;
  /** The track whose grip was pressed. */
  readonly dragId: string;
  /** Every track travelling with the grip, fixed at pointer-down. */
  readonly movingIds: readonly string[];
  /** Client y at pointer-down, the origin the threshold is measured from. */
  readonly startClientY: number;
  readonly phase: ReorderPhase;
  /** Insertion slot a drop would use, 0..rows.length; null unless active. */
  readonly insertIndex: number | null;
  /** Id the moving block lands before (null = the end); only set while active. */
  readonly beforeId: string | null;
}

/** What a pointer-up means. Only 'move' is an edit. */
export type ReorderDrop =
  /** Another pointer, or a session already cancelled: not this drag's release. */
  | { kind: 'ignore' }
  /** Released without ever passing the threshold: the grip was clicked. */
  | { kind: 'click' }
  /** A real drag that would leave the order exactly as it is. */
  | { kind: 'none' }
  | { kind: 'move'; ids: readonly string[]; beforeId: string | null };

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

/**
 * Lay out a uniform-height track list. `rowHeight` is local CSS px and must be
 * finite and > 0, otherwise RangeError.
 */
export function reorderRows(trackIds: readonly string[], rowHeight: number): Row[] {
  return layoutRows(trackIds.map((id) => ({ id, height: rowHeight })));
}

/**
 * The tracks a drag from `dragId` moves: the whole selection when the dragged
 * track is part of it (deduped, selection order), otherwise that track alone.
 * Dragging an unselected header never drags the selection along with it.
 */
export function movingIdsFor(dragId: string, selectedTrackIds: readonly string[]): string[] {
  if (!selectedTrackIds.includes(dragId)) return [dragId];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of selectedTrackIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Pointer down on a grip: a pending session that is still a click. */
export function startReorder(
  pointerId: number,
  dragId: string,
  clientY: number,
  selectedTrackIds: readonly string[],
): ReorderSession {
  return {
    pointerId,
    dragId,
    movingIds: movingIdsFor(dragId, selectedTrackIds),
    startClientY: finite(clientY, 'clientY'),
    phase: 'pending',
    insertIndex: null,
    beforeId: null,
  };
}

/**
 * Pointer move. A pending session activates once it has travelled
 * REORDER_THRESHOLD_PX vertically; an active one re-reads its drop target from
 * `localY`. Returns the SAME object when nothing changed, so a press that is
 * really a click never re-renders the header column.
 */
export function moveReorder(
  s: ReorderSession,
  pointerId: number,
  clientY: number,
  localY: number,
  rows: readonly Row[],
): ReorderSession {
  if (s.pointerId !== pointerId || s.phase === 'cancelled') return s;
  finite(clientY, 'clientY');
  finite(localY, 'localY');
  if (s.phase === 'pending' && Math.abs(clientY - s.startClientY) < REORDER_THRESHOLD_PX) return s;
  const insertIndex = insertionIndexAtY(rows, localY);
  const beforeId = dropBeforeIdAtY(rows, localY);
  if (s.phase === 'active' && s.insertIndex === insertIndex && s.beforeId === beforeId) return s;
  return { ...s, phase: 'active', insertIndex, beforeId };
}

/**
 * Escape, pointercancel or lost capture. The session is spent: no later move
 * or release can resurrect it, so the order is left exactly as it was.
 */
export function cancelReorder(s: ReorderSession): ReorderSession {
  if (s.phase === 'cancelled') return s;
  return { ...s, phase: 'cancelled', insertIndex: null, beforeId: null };
}

/**
 * Pointer up. `order` is the LIVE track order at release time, which is what
 * decides whether the drop is an edit: a drop that reproduces the current order
 * is 'none' (no undo step, no write). Tracks removed while the drag was in
 * flight simply drop out of the moving set, and an anchor that is gone means
 * the end of the list — a concurrent removal can never make a drop throw.
 */
export function finishReorder(s: ReorderSession, pointerId: number, order: readonly string[]): ReorderDrop {
  if (s.pointerId !== pointerId || s.phase === 'cancelled') return { kind: 'ignore' };
  if (s.phase === 'pending') return { kind: 'click' };
  const known = new Set(order);
  const ids = s.movingIds.filter((id) => known.has(id));
  if (ids.length === 0) return { kind: 'none' };
  const beforeId = s.beforeId !== null && known.has(s.beforeId) ? s.beforeId : null;
  if (sameOrder(order, moveIds(order, ids, beforeId))) return { kind: 'none' };
  return { kind: 'move', ids, beforeId };
}
