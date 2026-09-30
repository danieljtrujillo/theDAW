import assert from 'node:assert/strict';
import {
  REORDER_THRESHOLD_PX,
  cancelReorder,
  finishReorder,
  movingIdsFor,
  moveReorder,
  reorderRows,
  startReorder,
} from './trackReorderDrag';

const H = 100;
const ORDER = ['a', 'b', 'c'];
const ROWS = reorderRows(ORDER, H);

// ── Row layout ───────────────────────────────────────────────────────────────
assert.deepEqual(ROWS, [
  { id: 'a', top: 0, height: H, index: 0 },
  { id: 'b', top: H, height: H, index: 1 },
  { id: 'c', top: 2 * H, height: H, index: 2 },
]);
assert.throws(() => reorderRows(ORDER, 0), RangeError);
assert.throws(() => reorderRows(ORDER, Number.NaN), RangeError);

// ── Which tracks move ────────────────────────────────────────────────────────
// A track outside the selection drags alone, however many tracks are selected.
assert.deepEqual(movingIdsFor('a', []), ['a']);
assert.deepEqual(movingIdsFor('a', ['b', 'c']), ['a']);
// Dragging a selected track moves the whole selection, deduped, selection order.
assert.deepEqual(movingIdsFor('a', ['a', 'c']), ['a', 'c']);
assert.deepEqual(movingIdsFor('c', ['c', 'a', 'c']), ['c', 'a']);
// The moving set is fixed at pointer-down and rides on the session.
assert.deepEqual(startReorder(1, 'a', 20, ['a', 'c']).movingIds, ['a', 'c']);
assert.deepEqual(startReorder(1, 'b', 20, ['a', 'c']).movingIds, ['b']);

// ── Pending session ──────────────────────────────────────────────────────────
const pending = startReorder(7, 'a', 200, []);
assert.equal(pending.phase, 'pending');
assert.equal(pending.pointerId, 7);
assert.equal(pending.dragId, 'a');
assert.equal(pending.insertIndex, null);
assert.equal(pending.beforeId, null);
assert.throws(() => startReorder(7, 'a', Number.POSITIVE_INFINITY, []), RangeError);

// ── Threshold ────────────────────────────────────────────────────────────────
assert.equal(REORDER_THRESHOLD_PX, 4);
// Below the threshold nothing changes — not even the object identity, so a
// press that is really a click never re-renders the header column.
assert.equal(moveReorder(pending, 7, 203, 50, ROWS), pending);
assert.equal(moveReorder(pending, 7, 197, 50, ROWS), pending);
// At the threshold, in either direction, the drag activates.
assert.equal(moveReorder(pending, 7, 204, 50, ROWS).phase, 'active');
assert.equal(moveReorder(pending, 7, 196, 50, ROWS).phase, 'active');
// A different pointer (a second finger) never drives this session.
assert.equal(moveReorder(pending, 9, 400, 50, ROWS), pending);
assert.throws(() => moveReorder(pending, 7, Number.NaN, 50, ROWS), RangeError);
assert.throws(() => moveReorder(pending, 7, 400, Number.NaN, ROWS), RangeError);

// ── Drop target from y, for every position over the rows ─────────────────────
const targetAt = (localY: number): { insertIndex: number | null; beforeId: string | null } => {
  const s = moveReorder(startReorder(1, 'a', 0, []), 1, 400, localY, ROWS);
  return { insertIndex: s.insertIndex, beforeId: s.beforeId };
};
// Above every row, and in the upper half of the first row: before 'a'.
assert.deepEqual(targetAt(-40), { insertIndex: 0, beforeId: 'a' });
assert.deepEqual(targetAt(10), { insertIndex: 0, beforeId: 'a' });
// Lower half of a row: the gap below it.
assert.deepEqual(targetAt(60), { insertIndex: 1, beforeId: 'b' });
assert.deepEqual(targetAt(140), { insertIndex: 1, beforeId: 'b' });
assert.deepEqual(targetAt(160), { insertIndex: 2, beforeId: 'c' });
assert.deepEqual(targetAt(240), { insertIndex: 2, beforeId: 'c' });
// Lower half of the last row, and anywhere below the list: the end.
assert.deepEqual(targetAt(260), { insertIndex: 3, beforeId: null });
assert.deepEqual(targetAt(5000), { insertIndex: 3, beforeId: null });
// An active session that stays in the same gap keeps its identity.
const active = moveReorder(pending, 7, 260, 60, ROWS);
assert.equal(active.phase, 'active');
assert.equal(active.beforeId, 'b');
assert.equal(moveReorder(active, 7, 262, 70, ROWS), active);
assert.notEqual(moveReorder(active, 7, 262, 160, ROWS), active);

// ── Drop outcome ─────────────────────────────────────────────────────────────
// Below the threshold, a release is a plain click on the grip: no move.
assert.deepEqual(finishReorder(pending, 7, ORDER), { kind: 'click' });
// A different pointer's release is not this session's business.
assert.deepEqual(finishReorder(active, 9, ORDER), { kind: 'ignore' });
// A real drag that would leave the order exactly as it is writes nothing:
// 'a' dropped in the gap before 'b' is where 'a' already is.
assert.deepEqual(finishReorder(active, 7, ORDER), { kind: 'none' });
// 'a' dropped in the gap before 'c'.
const toC = moveReorder(pending, 7, 260, 160, ROWS);
assert.deepEqual(finishReorder(toC, 7, ORDER), { kind: 'move', ids: ['a'], beforeId: 'c' });
// 'a' dropped past the end.
const toEnd = moveReorder(pending, 7, 260, 290, ROWS);
assert.deepEqual(finishReorder(toEnd, 7, ORDER), { kind: 'move', ids: ['a'], beforeId: null });
// A multi-track drop reports the whole moving set; where each one lands is
// moveIds' business (tested in trackOrder), not this module's.
const multi = moveReorder(startReorder(2, 'c', 0, ['c', 'a']), 2, 100, 140, ROWS);
assert.deepEqual(finishReorder(multi, 2, ORDER), { kind: 'move', ids: ['c', 'a'], beforeId: 'b' });
// Dropping the whole list on itself changes nothing.
const all = moveReorder(startReorder(3, 'a', 0, ['a', 'b', 'c']), 3, 100, 10, ROWS);
assert.deepEqual(finishReorder(all, 3, ORDER), { kind: 'none' });

// ── Cancel ───────────────────────────────────────────────────────────────────
// Escape / pointercancel: the session is spent and a later move or release
// cannot resurrect it, so the order is untouched.
const cancelled = cancelReorder(active);
assert.equal(cancelled.phase, 'cancelled');
assert.equal(cancelled.insertIndex, null);
assert.equal(cancelled.beforeId, null);
assert.equal(moveReorder(cancelled, 7, 900, 290, ROWS), cancelled);
assert.deepEqual(finishReorder(cancelled, 7, ORDER), { kind: 'ignore' });
// Cancelling twice is idempotent, and cancelling a pending press is fine.
assert.equal(cancelReorder(cancelled), cancelled);
assert.equal(cancelReorder(pending).phase, 'cancelled');

// ── A track removed mid-drag ─────────────────────────────────────────────────
// The order at drop time is the live one. Ids that are gone are dropped rather
// than thrown on, and an anchor that is gone means the end of the list.
// 'c' is gone: only 'a' still moves, and it really does move here.
assert.deepEqual(finishReorder(multi, 2, ['b', 'a']), { kind: 'move', ids: ['a'], beforeId: 'b' });
// The anchor 'c' is gone: the drop falls back to the end of the list.
assert.deepEqual(finishReorder(toC, 7, ['a', 'b']), { kind: 'move', ids: ['a'], beforeId: null });
// Nothing left to move at all.
assert.deepEqual(finishReorder(toC, 7, ['b', 'c']), { kind: 'none' });
assert.deepEqual(finishReorder(toC, 7, []), { kind: 'none' });

console.log('trackReorderDrag: ok');
