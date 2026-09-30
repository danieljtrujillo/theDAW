import assert from 'node:assert/strict';
import {
  buildRowLayout,
  depthOf,
  dropBeforeIdAtY,
  heightOf,
  insertionIndexAtY,
  isVisible,
  rowAtY,
  topOf,
  totalHeight,
  type RowLayoutInput,
} from './rowLayout';

// flat list stacks like layoutRows
const flat: RowLayoutInput[] = [
  { id: 'a', parentId: null, kind: 'audio', height: 40 },
  { id: 'b', parentId: null, kind: 'audio', height: 100 },
  { id: 'c', parentId: null, kind: 'audio', height: 60 },
];
const flatLayout = buildRowLayout(flat);
assert.deepEqual(
  flatLayout.rows.map((r) => [r.trackId, r.top, r.height, r.depth, r.visible, r.index]),
  [
    ['a', 0, 40, 0, true, 0],
    ['b', 40, 100, 0, true, 1],
    ['c', 140, 60, 0, true, 2],
  ],
);
assert.deepEqual(flatLayout.visibleRows, [
  { id: 'a', top: 0, height: 40, index: 0 },
  { id: 'b', top: 40, height: 100, index: 1 },
  { id: 'c', top: 140, height: 60, index: 2 },
]);
assert.equal(flatLayout.totalHeight, 200);

// children are indented by depth
const nested: RowLayoutInput[] = [
  { id: 'f1', parentId: null, kind: 'folder', height: 30 },
  { id: 'f2', parentId: 'f1', kind: 'folder', height: 25 },
  { id: 'leaf', parentId: 'f2', kind: 'audio', height: 45 },
];
const nestedLayout = buildRowLayout(nested);
assert.deepEqual(
  nestedLayout.rows.map((r) => [r.trackId, r.depth, r.top, r.visible]),
  [
    ['f1', 0, 0, true],
    ['f2', 1, 30, true],
    ['leaf', 2, 55, true],
  ],
);
assert.equal(nestedLayout.totalHeight, 100);

// collapsed folder hides its whole subtree and reclaims its height
const collapsedTracks: RowLayoutInput[] = [
  { id: 'f1', parentId: null, kind: 'folder', collapsed: true, height: 30 },
  { id: 'a1', parentId: 'f1', kind: 'audio', height: 40 },
  { id: 'a2', parentId: 'f1', kind: 'audio', height: 50 },
  { id: 'top', parentId: null, kind: 'audio', height: 20 },
];
const collapsedLayout = buildRowLayout(collapsedTracks);
assert.deepEqual(
  collapsedLayout.rows.map((r) => [r.trackId, r.top, r.height, r.visible, r.index]),
  [
    ['f1', 0, 30, true, 0],
    ['a1', 0, 0, false, -1],
    ['a2', 0, 0, false, -1],
    ['top', 30, 20, true, 1],
  ],
);
assert.equal(collapsedLayout.visibleRows.length, 2);
// f1 (30) + top (20) only: a1 (40) + a2 (50) contribute nothing while hidden.
assert.equal(collapsedLayout.totalHeight, 50);

// nested collapsed folder inside a collapsed folder stays hidden
const doubleCollapsed: RowLayoutInput[] = [
  { id: 'outer', parentId: null, kind: 'folder', collapsed: true, height: 20 },
  { id: 'inner', parentId: 'outer', kind: 'folder', collapsed: true, height: 25 },
  { id: 'leaf', parentId: 'inner', kind: 'audio', height: 35 },
  { id: 'sibling', parentId: null, kind: 'audio', height: 15 },
];
const doubleLayout = buildRowLayout(doubleCollapsed);
assert.equal(isVisible(doubleLayout, 'inner'), false);
assert.equal(isVisible(doubleLayout, 'leaf'), false);
assert.equal(topOf(doubleLayout, 'inner'), 0);
assert.equal(topOf(doubleLayout, 'leaf'), 0);
assert.equal(depthOf(doubleLayout, 'inner'), 1);
assert.equal(depthOf(doubleLayout, 'leaf'), 2);
assert.equal(doubleLayout.totalHeight, 35);

// totalHeight equals the sum of visible heights
for (const layout of [flatLayout, nestedLayout, collapsedLayout, doubleLayout]) {
  const sum = layout.visibleRows.reduce((s, r) => s + r.height, 0);
  assert.equal(totalHeight(layout), sum);
}

// rowAtY hits the top edge and misses the bottom edge
assert.equal(rowAtY(flatLayout, 0)?.trackId, 'a');
assert.equal(rowAtY(flatLayout, 39.99)?.trackId, 'a');
assert.equal(rowAtY(flatLayout, 40)?.trackId, 'b'); // b's top edge, not a's bottom edge
assert.equal(rowAtY(flatLayout, 140)?.trackId, 'c');

// rowAtY returns undefined above 0 and below the last row
assert.equal(rowAtY(flatLayout, -0.01), undefined);
assert.equal(rowAtY(flatLayout, 200), undefined);
assert.equal(rowAtY(flatLayout, 5000), undefined);
assert.equal(rowAtY(buildRowLayout([]), 0), undefined);

// topOf / depthOf / isVisible for a hidden descendant
assert.equal(topOf(collapsedLayout, 'a1'), 0);
assert.equal(heightOf(collapsedLayout, 'a1'), 0);
assert.equal(depthOf(collapsedLayout, 'a1'), 1);
assert.equal(isVisible(collapsedLayout, 'a1'), false);

// non-positive height throws RangeError
assert.throws(() => buildRowLayout([{ id: 'x', parentId: null, kind: 'audio', height: 0 }]), RangeError);
assert.throws(() => buildRowLayout([{ id: 'x', parentId: null, kind: 'audio', height: -5 }]), RangeError);
assert.throws(
  () => buildRowLayout([{ id: 'x', parentId: null, kind: 'audio', height: Number.NaN }]),
  /Row height must be positive/,
);
// A bad height on a track hidden by collapse still throws: every input track is checked.
assert.throws(
  () =>
    buildRowLayout([
      { id: 'f', parentId: null, kind: 'folder', collapsed: true, height: 20 },
      { id: 'c', parentId: 'f', kind: 'audio', height: 0 },
    ]),
  RangeError,
);

// cycle throws Track hierarchy cycle
assert.throws(
  () =>
    buildRowLayout([
      { id: 'p', parentId: 'q', kind: 'folder', height: 10 },
      { id: 'q', parentId: 'p', kind: 'folder', height: 10 },
    ]),
  /cycle/,
);

// visibleRows feeds insertionIndexAtY unchanged
assert.equal(insertionIndexAtY(flatLayout.visibleRows, 90), 2);
assert.equal(insertionIndexAtY(flatLayout.visibleRows, 200), 3);
assert.equal(insertionIndexAtY(flatLayout.visibleRows, 5000), 3);
assert.equal(dropBeforeIdAtY(flatLayout.visibleRows, 30), 'b');
assert.equal(dropBeforeIdAtY(flatLayout.visibleRows, 180), null);

console.log('rowLayout: ok');
