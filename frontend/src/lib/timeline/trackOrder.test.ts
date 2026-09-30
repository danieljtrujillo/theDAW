import assert from 'node:assert/strict';
import {
  assertTree,
  dropBeforeIdAtY,
  flattenVisible,
  insertionIndexAtY,
  layoutRows,
  moveByOffset,
  moveIds,
  moveSubtree,
  rowAtY,
  sameOrder,
  type TreeTrack,
} from './trackOrder';

const O = ['a', 'b', 'c', 'd', 'e'];

// Single track: up, down, to start, to end.
assert.deepEqual(moveIds(O, ['c'], 'b'), ['a', 'c', 'b', 'd', 'e']);
assert.deepEqual(moveIds(O, ['c'], 'e'), ['a', 'b', 'd', 'c', 'e']);
assert.deepEqual(moveIds(O, ['c'], 'a'), ['c', 'a', 'b', 'd', 'e']);
assert.deepEqual(moveIds(O, ['c'], null), ['a', 'b', 'd', 'e', 'c']);

// Multi-track: the moving set keeps its CURRENT relative order, not the selection order.
assert.deepEqual(moveIds(O, ['d', 'b'], 'a'), ['b', 'd', 'a', 'c', 'e']);
assert.deepEqual(moveIds(O, ['b', 'c'], 'e'), ['a', 'd', 'b', 'c', 'e']);
assert.deepEqual(moveIds(O, ['a', 'b'], null), ['c', 'd', 'e', 'a', 'b']);
assert.deepEqual(moveIds(O, ['e', 'd'], 'a'), ['d', 'e', 'a', 'b', 'c']);
// Non-contiguous selection keeps relative order and closes up.
assert.deepEqual(moveIds(O, ['e', 'a', 'c'], 'd'), ['b', 'a', 'c', 'e', 'd']);
// Duplicates are ignored.
assert.deepEqual(moveIds(O, ['c', 'c'], 'a'), ['c', 'a', 'b', 'd', 'e']);

// beforeId inside the moving set anchors to the next non-moving id after it.
assert.deepEqual(moveIds(O, ['b', 'c'], 'c'), ['a', 'b', 'c', 'd', 'e']);
assert.deepEqual(moveIds(O, ['a', 'c'], 'c'), ['b', 'a', 'c', 'd', 'e']);
// ...and to the end when none follows.
assert.deepEqual(moveIds(O, ['a', 'e'], 'e'), ['b', 'c', 'd', 'a', 'e']);

// Unknown ids throw.
assert.throws(() => moveIds(O, ['z'], 'a'), Error);
assert.throws(() => moveIds(O, ['a'], 'z'), Error);

// No-op detection.
assert.equal(sameOrder(moveIds(O, ['b', 'c'], 'd'), O), true);
assert.equal(sameOrder(moveIds(O, ['c'], 'b'), O), false);
assert.equal(sameOrder(['a'], ['a', 'b']), false);
assert.equal(sameOrder([], []), true);
// Input arrays are not mutated.
assert.deepEqual(O, ['a', 'b', 'c', 'd', 'e']);

// Keyboard offset.
assert.deepEqual(moveByOffset(O, ['c'], -1), ['a', 'c', 'b', 'd', 'e']);
assert.deepEqual(moveByOffset(O, ['c'], 1), ['a', 'b', 'd', 'c', 'e']);
assert.deepEqual(moveByOffset(O, ['b', 'c'], -1), ['b', 'c', 'a', 'd', 'e']);
// A block already at the edge stays.
assert.deepEqual(moveByOffset(O, ['a'], -1), O);
assert.deepEqual(moveByOffset(O, ['e'], 1), O);
assert.deepEqual(moveByOffset(O, ['a', 'b'], -1), O);
// Split blocks: each run moves past one non-moving neighbour.
assert.deepEqual(moveByOffset(O, ['b', 'd'], -1), ['b', 'a', 'd', 'c', 'e']);
assert.deepEqual(moveByOffset(O, ['b', 'd'], 1), ['a', 'c', 'b', 'e', 'd']);
// Edge run stays while another run moves.
assert.deepEqual(moveByOffset(O, ['a', 'c'], -1), ['a', 'c', 'b', 'd', 'e']);
assert.deepEqual(moveByOffset(O, ['c', 'e'], 1), ['a', 'b', 'd', 'c', 'e']);
assert.throws(() => moveByOffset(O, ['z'], 1), Error);

// Mixed-height rows.
const rows = layoutRows([
  { id: 'a', height: 40 },
  { id: 'b', height: 100 },
  { id: 'c', height: 60 },
]);
assert.deepEqual(rows, [
  { id: 'a', top: 0, height: 40, index: 0 },
  { id: 'b', top: 40, height: 100, index: 1 },
  { id: 'c', top: 140, height: 60, index: 2 },
]);
assert.deepEqual(layoutRows([{ id: 'x', height: 10 }], 25), [{ id: 'x', top: 25, height: 10, index: 0 }]);
assert.throws(() => layoutRows([{ id: 'x', height: 0 }]), RangeError);
assert.throws(() => layoutRows([{ id: 'x', height: -5 }]), RangeError);
assert.throws(() => layoutRows([{ id: 'x', height: Number.NaN }]), RangeError);
assert.throws(() => layoutRows([{ id: 'x', height: 10 }], Number.POSITIVE_INFINITY), RangeError);

// rowAtY: top inclusive, bottom exclusive.
assert.equal(rowAtY(rows, -0.01), undefined);
assert.equal(rowAtY(rows, 0)?.id, 'a');
assert.equal(rowAtY(rows, 39.99)?.id, 'a');
assert.equal(rowAtY(rows, 40)?.id, 'b');
assert.equal(rowAtY(rows, 139.99)?.id, 'b');
assert.equal(rowAtY(rows, 140)?.id, 'c');
assert.equal(rowAtY(rows, 199.99)?.id, 'c');
assert.equal(rowAtY(rows, 200), undefined);
assert.equal(rowAtY([], 5), undefined);
assert.throws(() => rowAtY(rows, Number.NaN), RangeError);

// Insertion index: upper half -> index, lower half -> index + 1.
assert.equal(insertionIndexAtY(rows, -50), 0);
assert.equal(insertionIndexAtY(rows, 0), 0);
assert.equal(insertionIndexAtY(rows, 19.99), 0);
assert.equal(insertionIndexAtY(rows, 20), 1);
assert.equal(insertionIndexAtY(rows, 89.99), 1);
assert.equal(insertionIndexAtY(rows, 90), 2);
assert.equal(insertionIndexAtY(rows, 170), 3);
assert.equal(insertionIndexAtY(rows, 200), 3);
assert.equal(insertionIndexAtY(rows, 5000), 3);
assert.equal(insertionIndexAtY([], 10), 0);
assert.throws(() => insertionIndexAtY(rows, Number.POSITIVE_INFINITY), RangeError);

assert.equal(dropBeforeIdAtY(rows, -5), 'a');
assert.equal(dropBeforeIdAtY(rows, 30), 'b');
assert.equal(dropBeforeIdAtY(rows, 100), 'c');
assert.equal(dropBeforeIdAtY(rows, 180), null);
assert.equal(dropBeforeIdAtY([], 0), null);

// Tree: assertTree / flattenVisible / moveSubtree.
const tree: TreeTrack[] = [
  { id: 'f1', parentId: null, kind: 'folder' },
  { id: 'a1', parentId: 'f1', kind: 'audio' },
  { id: 'f2', parentId: 'f1', kind: 'folder', collapsed: true },
  { id: 'm1', parentId: 'f2', kind: 'midi' },
  { id: 'a2', parentId: 'f2', kind: 'audio' },
  { id: 'top', parentId: null, kind: 'audio' },
];
assert.equal(assertTree(tree).size, 6);
assert.throws(() => assertTree([...tree, { id: 'a1', parentId: null, kind: 'audio' }]), /Duplicate/);
assert.throws(() => assertTree([{ id: 'x', parentId: 'y', kind: 'audio' }]), /Parent/);
assert.throws(
  () =>
    assertTree([
      { id: 'p', parentId: 'q', kind: 'folder' },
      { id: 'q', parentId: 'p', kind: 'folder' },
    ]),
  /cycle/,
);

const flat = flattenVisible(tree).map((r) => [r.track.id, r.depth, r.descendantCount]);
assert.deepEqual(flat, [
  ['f1', 0, 4],
  ['a1', 1, 0],
  ['f2', 1, 2], // collapsed: children hidden, count still reported
  ['top', 0, 0],
]);
const expanded = tree.map((t) => (t.id === 'f2' ? { ...t, collapsed: false } : t));
assert.deepEqual(
  flattenVisible(expanded).map((r) => [r.track.id, r.depth, r.descendantCount]),
  [
    ['f1', 0, 4],
    ['a1', 1, 0],
    ['f2', 1, 2],
    ['m1', 2, 0],
    ['a2', 2, 0],
    ['top', 0, 0],
  ],
);
// Deep chain does not overflow the stack (iterative).
const deep: TreeTrack[] = [];
for (let i = 0; i < 20000; i++) deep.push({ id: `n${i}`, parentId: i === 0 ? null : `n${i - 1}`, kind: 'folder' });
const deepFlat = flattenVisible(deep);
assert.equal(deepFlat.length, 20000);
assert.equal(deepFlat[0].descendantCount, 19999);
assert.equal(deepFlat[19999].depth, 19999);

// Move a whole subtree to root, before 'top'.
assert.deepEqual(
  moveSubtree(tree, 'f2', null, 'top').map((t) => [t.id, t.parentId]),
  [
    ['f1', null],
    ['a1', 'f1'],
    ['f2', null],
    ['m1', 'f2'],
    ['a2', 'f2'],
    ['top', null],
  ],
);
// Append into a folder.
assert.deepEqual(
  moveSubtree(tree, 'top', 'f2').map((t) => t.id),
  ['f1', 'a1', 'f2', 'm1', 'a2', 'top'],
);
// Reorder within siblings.
assert.deepEqual(
  moveSubtree(tree, 'a2', 'f2', 'm1').map((t) => t.id),
  ['f1', 'a1', 'f2', 'a2', 'm1', 'top'],
);
// Input not mutated.
assert.equal(tree.find((t) => t.id === 'top')?.parentId, null);
// Cycle rejection: a folder into its own descendant, or into itself.
assert.throws(() => moveSubtree(tree, 'f1', 'f2'), /cycle/);
assert.throws(() => moveSubtree(tree, 'f1', 'f1'), /cycle/);
// Non-folder parent rejection.
assert.throws(() => moveSubtree(tree, 'top', 'a1'), /Parent/);
// Unknown dragged id / bad anchor.
assert.throws(() => moveSubtree(tree, 'nope', null), Error);
assert.throws(() => moveSubtree(tree, 'top', null, 'a1'), /anchor/);

// RS7-4: moveSubtree's no-op path must return depth-first order, not just
// echo the caller's array order. Child 'A' is listed after root sibling 'B'.
const rs74Tracks: TreeTrack[] = [
  { id: 'F', parentId: null, kind: 'folder' },
  { id: 'B', parentId: null, kind: 'audio' },
  { id: 'A', parentId: 'F', kind: 'audio' },
];
const rs74TracksCopy = rs74Tracks.map((t) => ({ ...t }));

// REGRESSION: a no-op drop returns depth-first order, not input order.
assert.deepEqual(
  moveSubtree(rs74Tracks, 'A', 'F', 'A').map((t) => t.id),
  ['F', 'A', 'B'],
);
assert.deepEqual(
  moveSubtree(rs74Tracks, 'A', 'F', 'A').map((t) => t.id),
  moveSubtree(rs74Tracks, 'A', 'F').map((t) => t.id),
);

// A no-op drop never returns the input array itself, and never mutates it.
assert.notEqual(moveSubtree(rs74Tracks, 'A', 'F', 'A'), rs74Tracks);
assert.deepEqual(rs74Tracks, rs74TracksCopy);

// A no-op drop on an already depth-first list is identity.
const rs74PreOrdered: TreeTrack[] = [
  { id: 'F', parentId: null, kind: 'folder' },
  { id: 'A', parentId: 'F', kind: 'audio' },
  { id: 'B', parentId: null, kind: 'audio' },
];
assert.deepEqual(
  moveSubtree(rs74PreOrdered, 'A', 'F', 'A').map((t) => t.id),
  ['F', 'A', 'B'],
);

// An invalid tree still throws on a no-op drop.
const rs74Dup: TreeTrack[] = [...rs74Tracks, { id: 'A', parentId: null, kind: 'audio' }];
assert.throws(() => moveSubtree(rs74Dup, 'A', 'F', 'A'), /Duplicate track ID/);

console.log('trackOrder: ok');
