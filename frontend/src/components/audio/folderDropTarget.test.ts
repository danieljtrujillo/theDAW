import assert from 'node:assert/strict';
import { buildRowLayout } from '../../lib/timeline/rowLayout';
import { FOLDER_EDGE_PX, dropTargetLabel, isDescendantOf, trackDropTargetAtY } from './folderDropTarget';

const H = 40; // taller than 2 * FOLDER_EDGE_PX (12): has both edge bands and a real middle
const noneMoving: readonly string[] = [];

// folder1 (top 0..40)
//   child1 (top 40..80), depth 1
// track2 (top 80..120)
const layout = buildRowLayout([
  { id: 'folder1', parentId: null, kind: 'folder', height: H },
  { id: 'child1', parentId: 'folder1', kind: 'audio', height: H },
  { id: 'track2', parentId: null, kind: 'audio', height: H },
]);
const isFolder = (id: string): boolean => id === 'folder1';

// Middle of a folder row is into-folder.
assert.deepEqual(trackDropTargetAtY(layout, 20, noneMoving, isFolder), { kind: 'into-folder', folderId: 'folder1' });

// The top edge band is half-open: FOLDER_EDGE_PX itself is already the middle.
assert.deepEqual(trackDropTargetAtY(layout, FOLDER_EDGE_PX, noneMoving, isFolder), {
  kind: 'into-folder',
  folderId: 'folder1',
});

// Top edge band of a folder row is reorder.
assert.deepEqual(trackDropTargetAtY(layout, 1, noneMoving, isFolder), { kind: 'reorder', beforeId: 'folder1' });

// Bottom edge band of a folder row is reorder.
assert.deepEqual(trackDropTargetAtY(layout, H - FOLDER_EDGE_PX, noneMoving, isFolder), {
  kind: 'reorder',
  beforeId: 'child1',
});
assert.deepEqual(trackDropTargetAtY(layout, H - 1, noneMoving, isFolder), { kind: 'reorder', beforeId: 'child1' });

// A non-folder row is always reorder, even hovering dead centre.
assert.deepEqual(trackDropTargetAtY(layout, 100, noneMoving, isFolder), { kind: 'reorder', beforeId: null });

// A folder being dragged is never its own drop target.
assert.deepEqual(trackDropTargetAtY(layout, 20, ['folder1'], isFolder), { kind: 'reorder', beforeId: 'child1' });

// A folder inside the dragged subtree is never a drop target.
const nestedLayout = buildRowLayout([
  { id: 'folder1', parentId: null, kind: 'folder', height: H },
  { id: 'subfolder', parentId: 'folder1', kind: 'folder', height: H },
  { id: 'leaf', parentId: 'subfolder', kind: 'audio', height: H },
]);
const isFolderNested = (id: string): boolean => id === 'folder1' || id === 'subfolder';
assert.deepEqual(trackDropTargetAtY(nestedLayout, 60, ['folder1'], isFolderNested), {
  kind: 'reorder',
  beforeId: 'leaf',
});

// A very short folder row still has a middle: exactly its centre pixel.
const shortH = 8; // < 2 * FOLDER_EDGE_PX (12)
const shortLayout = buildRowLayout([
  { id: 'tinyFolder', parentId: null, kind: 'folder', height: shortH },
  { id: 'sibling', parentId: null, kind: 'audio', height: H },
]);
const isTinyFolder = (id: string): boolean => id === 'tinyFolder';
assert.deepEqual(trackDropTargetAtY(shortLayout, shortH / 2, noneMoving, isTinyFolder), {
  kind: 'into-folder',
  folderId: 'tinyFolder',
});
assert.deepEqual(trackDropTargetAtY(shortLayout, shortH / 2 - 1, noneMoving, isTinyFolder), {
  kind: 'reorder',
  beforeId: 'tinyFolder',
});
assert.deepEqual(trackDropTargetAtY(shortLayout, shortH / 2 + 1, noneMoving, isTinyFolder), {
  kind: 'reorder',
  beforeId: 'sibling',
});

// An odd short folder row still has a middle at an integer y (the old
// two-branch formula only hit a .5 coordinate here -- unreachable for the
// integer CSS-px coordinates a pointermove delivers).
const nineH = 9; // < 2 * FOLDER_EDGE_PX (12), odd
const nineLayout = buildRowLayout([
  { id: 'nineFolder', parentId: null, kind: 'folder', height: nineH },
  { id: 'nineSibling', parentId: null, kind: 'audio', height: H },
]);
const isNineFolder = (id: string): boolean => id === 'nineFolder';
assert.deepEqual(trackDropTargetAtY(nineLayout, 4, noneMoving, isNineFolder), {
  kind: 'into-folder',
  folderId: 'nineFolder',
});

// A folder row exactly 2 * FOLDER_EDGE_PX tall must still have a middle (the
// old formula demanded fromTop > 6 AND fromTop < 6 there, which is impossible).
const boundaryH = 2 * FOLDER_EDGE_PX; // 12
const boundaryLayout = buildRowLayout([
  { id: 'boundaryFolder', parentId: null, kind: 'folder', height: boundaryH },
  { id: 'boundarySibling', parentId: null, kind: 'audio', height: H },
]);
const isBoundaryFolder = (id: string): boolean => id === 'boundaryFolder';
assert.deepEqual(trackDropTargetAtY(boundaryLayout, boundaryH / 2, noneMoving, isBoundaryFolder), {
  kind: 'into-folder',
  folderId: 'boundaryFolder',
});

// Below every row is reorder with beforeId null.
assert.deepEqual(trackDropTargetAtY(layout, 200, noneMoving, isFolder), { kind: 'reorder', beforeId: null });

// isDescendantOf survives a cyclic parent chain.
const cyclicParentOf = (id: string): string | null | undefined => {
  if (id === 'a') return 'b';
  if (id === 'b') return 'a'; // a <-> b cycle, never reaches 'root'
  return null;
};
assert.equal(isDescendantOf(cyclicParentOf, 'a', 'root'), false);
assert.equal(isDescendantOf(cyclicParentOf, 'a', 'b'), true);

// dropTargetLabel reads as plain English.
const folderName = (id: string): string => (id === 'folder1' ? 'Drums' : id);
assert.equal(
  dropTargetLabel({ kind: 'into-folder', folderId: 'folder1' }, folderName),
  'Move into folder “Drums”',
);
assert.equal(dropTargetLabel({ kind: 'reorder', beforeId: null }, folderName), 'Reorder');

// Non-finite y throws.
assert.throws(() => trackDropTargetAtY(layout, Number.NaN, noneMoving, isFolder), RangeError, 'y must be finite');
assert.throws(
  () => trackDropTargetAtY(layout, Number.POSITIVE_INFINITY, noneMoving, isFolder),
  RangeError,
  'y must be finite',
);

console.log('folderDropTarget: ok');
