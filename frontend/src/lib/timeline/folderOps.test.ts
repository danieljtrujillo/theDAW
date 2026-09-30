import assert from 'node:assert/strict';
import {
  deleteFolder,
  descendantIds,
  folderFlagPatch,
  moveIntoFolder,
  moveOutOfFolder,
  newFolderFromSelection,
  toTreeTracks,
  type FolderTrack,
} from './folderOps';

function track(id: string, extra: Partial<FolderTrack> = {}): FolderTrack {
  return { id, name: id, mute: false, solo: false, ...extra };
}

function folder(id: string, extra: Partial<FolderTrack> = {}): FolderTrack {
  return track(id, { isFolder: true, ...extra });
}

// toTreeTracks: field mapping (parentTrackId -> parentId, isFolder -> kind).
assert.deepEqual(toTreeTracks([track('a'), folder('f', { collapsed: true }), track('c', { parentTrackId: 'f' })]), [
  { id: 'a', parentId: null, kind: 'audio', collapsed: undefined },
  { id: 'f', parentId: null, kind: 'folder', collapsed: true },
  { id: 'c', parentId: 'f', kind: 'audio', collapsed: undefined },
]);

// descendantIds: depth-first, visible or not (c1 is collapsed but its child still counts).
const nested = [
  folder('g'),
  folder('f', { parentTrackId: 'g' }),
  folder('c1', { parentTrackId: 'f', collapsed: true }),
  track('gc', { parentTrackId: 'c1' }),
  track('c2', { parentTrackId: 'f' }),
  track('x'),
];
assert.deepEqual(descendantIds(nested, 'f'), ['c1', 'gc', 'c2']);
assert.deepEqual(descendantIds(nested, 'g'), ['f', 'c1', 'gc', 'c2']);
assert.throws(() => descendantIds(nested, 'nope'), /Unknown track id/);

// newFolderFromSelection puts the folder above the first selected track.
{
  const tracks = [track('a'), track('b'), track('c'), track('d')];
  const result = newFolderFromSelection(tracks, ['c'], folder('f'));
  assert.deepEqual(result.map((t) => t.id), ['a', 'b', 'f', 'c', 'd']);
  assert.equal(result.find((t) => t.id === 'c')?.parentTrackId, 'f');
  assert.deepEqual(tracks.map((t) => t.id), ['a', 'b', 'c', 'd']); // input untouched
}

// newFolderFromSelection skips a track already inside another selected track.
{
  const tracks = [folder('p'), track('c', { parentTrackId: 'p' }), track('x')];
  const result = newFolderFromSelection(tracks, ['p', 'c'], folder('f'));
  assert.equal(result.find((t) => t.id === 'p')?.parentTrackId, 'f');
  assert.equal(result.find((t) => t.id === 'c')?.parentTrackId, 'p'); // moves with p, not re-parented itself
}

// newFolderFromSelection on an empty selection throws.
assert.throws(
  () => newFolderFromSelection([track('a')], [], folder('f')),
  /Select at least one track to put in a folder/,
);
assert.throws(() => newFolderFromSelection([track('a')], ['nope'], folder('f')), /Unknown track id/);

// moveIntoFolder carries the whole subtree.
{
  const tracks = [folder('f'), folder('g'), track('c', { parentTrackId: 'g' })];
  const result = moveIntoFolder(tracks, 'g', 'f');
  assert.deepEqual(result.map((t) => t.id), ['f', 'g', 'c']);
  assert.equal(result.find((t) => t.id === 'g')?.parentTrackId, 'f');
  assert.equal(result.find((t) => t.id === 'c')?.parentTrackId, 'g');
}

// moveIntoFolder rejects a folder into itself.
assert.throws(() => moveIntoFolder([folder('f')], 'f', 'f'), /A folder cannot contain itself/);

// moveIntoFolder rejects a folder into its own descendant.
assert.throws(
  () => moveIntoFolder([folder('f'), folder('g', { parentTrackId: 'f' })], 'f', 'g'),
  /A folder cannot contain itself/,
);

// moveIntoFolder rejects a non-folder target.
assert.throws(
  () => moveIntoFolder([folder('f'), track('a')], 'f', 'a'),
  /Move into folder needs a folder/,
);

// moveOutOfFolder lifts to the grandparent.
{
  const tracks = [folder('g'), folder('f', { parentTrackId: 'g' }), track('c', { parentTrackId: 'f' })];
  const result = moveOutOfFolder(tracks, 'c');
  assert.equal(result.find((t) => t.id === 'c')?.parentTrackId, 'g');
}

// moveOutOfFolder at the root is a no-op and returns the same array.
{
  const tracks = [track('x')];
  assert.equal(moveOutOfFolder(tracks, 'x'), tracks);
}

// deleteFolder re-parents children and deletes nothing else.
{
  // c1 and c2 both parent to f but sit on either side of it in raw array order,
  // proving they land "in the folder's place" rather than wherever they were.
  const tracks = [
    folder('g'),
    track('c1', { parentTrackId: 'f' }),
    folder('f', { parentTrackId: 'g' }),
    track('c2', { parentTrackId: 'f' }),
    track('x'),
  ];
  const result = deleteFolder(tracks, 'f');
  assert.deepEqual(result.map((t) => t.id), ['g', 'c1', 'c2', 'x']);
  assert.equal(result.find((t) => t.id === 'c1')?.parentTrackId, 'g');
  assert.equal(result.find((t) => t.id === 'c2')?.parentTrackId, 'g');
  assert.equal(result.find((t) => t.id === 'f'), undefined);
  assert.equal(result.length, tracks.length - 1);
}

// deleteFolder on a nested folder keeps grandchildren under their parent.
{
  const tracks = [
    folder('g'),
    folder('f', { parentTrackId: 'g' }),
    folder('c1', { parentTrackId: 'f' }),
    track('gc', { parentTrackId: 'c1' }),
  ];
  const result = deleteFolder(tracks, 'f');
  assert.equal(result.find((t) => t.id === 'c1')?.parentTrackId, 'g');
  assert.equal(result.find((t) => t.id === 'gc')?.parentTrackId, 'c1'); // untouched
  assert.equal(result.find((t) => t.id === 'f'), undefined);
}

// deleteFolder throws on a non-folder id.
assert.throws(() => deleteFolder([track('a')], 'a'), /Not a folder/);

// folderFlagPatch covers every descendant once and skips folder rows.
{
  const tracks = [
    folder('f'),
    track('a', { parentTrackId: 'f' }),
    folder('g', { parentTrackId: 'f' }),
    track('b', { parentTrackId: 'g' }),
  ];
  assert.deepEqual(folderFlagPatch(tracks, 'f', { mute: true }), [
    { id: 'a', mute: true },
    { id: 'b', mute: true },
  ]);
  assert.deepEqual(folderFlagPatch(tracks, 'f', { solo: false }), [
    { id: 'a', solo: false },
    { id: 'b', solo: false },
  ]);
  // No non-folder descendants -> [].
  assert.deepEqual(folderFlagPatch([folder('empty')], 'empty', { mute: true }), []);
}

// Nothing mutates the input array.
{
  const tracks = [folder('f'), track('a', { parentTrackId: 'f' }), track('b')];
  const snapshot = JSON.parse(JSON.stringify(tracks));
  newFolderFromSelection(tracks, ['b'], folder('nf'));
  moveIntoFolder(tracks, 'b', 'f');
  moveOutOfFolder(tracks, 'a');
  deleteFolder(tracks, 'f');
  folderFlagPatch(tracks, 'f', { mute: true });
  assert.deepEqual(tracks, snapshot);
}

console.log('folderOps: ok');
