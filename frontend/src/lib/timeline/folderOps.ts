/**
 * Pure planners for folder edits in the arrangement: create-from-selection,
 * move into/out of a folder, delete-with-reparent, and the mute/solo patch a
 * folder broadcasts to its descendants. All folder EDITS are decided here so
 * the store action that calls these is a thin wrapper, testable without a DOM.
 *
 * A folder is an arrangement row only: it holds no clips, creates no audio
 * node, changes no routing and links no selection.
 *
 * Cycle detection and subtree relocation are NOT reimplemented here — every
 * export validates through `assertTree(toTreeTracks(tracks))` and delegates
 * actual relocation to `moveSubtree`, both from ./trackOrder.
 *
 * Pure: no DOM, no React, no store. Works against a minimal structural type
 * (`FolderTrack`) so this module never imports the store or components.
 */

import { assertTree, moveSubtree, type TreeTrack } from './trackOrder';

/** The subset of an editor track's shape folder planning needs. */
export interface FolderTrack {
  id: string;
  name: string;
  mute: boolean;
  solo: boolean;
  parentTrackId?: string | null;
  isFolder?: boolean;
  collapsed?: boolean;
}

/** Maps the editor's track shape onto the generic tree shape trackOrder.ts operates on. */
export function toTreeTracks<T extends FolderTrack>(tracks: readonly T[]): TreeTrack[] {
  return tracks.map((t) => ({
    id: t.id,
    parentId: t.parentTrackId ?? null,
    kind: t.isFolder ? 'folder' : 'audio',
    collapsed: t.collapsed,
  }));
}

/** Direct children ids of every parent, keyed by parent id, siblings in input order. */
function childrenByParent(tree: readonly TreeTrack[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of tree) {
    if (t.parentId === null) continue;
    const siblings = out.get(t.parentId);
    if (siblings) siblings.push(t.id);
    else out.set(t.parentId, [t.id]);
  }
  return out;
}

/** All descendants of `folderId`, depth-first, visible or not. Unknown id throws. */
export function descendantIds<T extends FolderTrack>(tracks: readonly T[], folderId: string): string[] {
  const tree = toTreeTracks(tracks);
  const map = assertTree(tree);
  if (!map.has(folderId)) throw new Error(`Unknown track id: ${folderId}`);
  const byParent = childrenByParent(tree);
  const out: string[] = [];
  const stack = [...(byParent.get(folderId) ?? [])].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    out.push(id);
    const kids = byParent.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/**
 * Inserts `folder` (caller-built, `isFolder: true`) immediately before the
 * first selected track in array order, then re-parents every selected track
 * that is not already a descendant of another selected track to the new
 * folder, preserving their relative order. Throws on an unknown selected id
 * or an empty selection.
 */
export function newFolderFromSelection<T extends FolderTrack>(
  tracks: readonly T[],
  selectedIds: readonly string[],
  folder: T,
): T[] {
  const map = assertTree(toTreeTracks(tracks));
  if (selectedIds.length === 0) throw new Error('Select at least one track to put in a folder');
  for (const id of selectedIds) {
    if (!map.has(id)) throw new Error(`Unknown track id: ${id}`);
  }
  const selected = new Set(selectedIds);
  const isDescendantOfSelected = (id: string): boolean => {
    let pid = map.get(id)!.parentId;
    while (pid !== null) {
      if (selected.has(pid)) return true;
      pid = map.get(pid)!.parentId;
    }
    return false;
  };
  const firstIndex = tracks.findIndex((t) => selected.has(t.id));
  const reparented = tracks.map((t): T => {
    if (!selected.has(t.id) || isDescendantOfSelected(t.id)) return t;
    const moved: T = { ...t, parentTrackId: folder.id };
    return moved;
  });
  const next = [...reparented];
  next.splice(firstIndex, 0, folder);
  assertTree(toTreeTracks(next));
  return next;
}

/**
 * Appends `trackId` (with its whole subtree) as the last child of `folderId`.
 * Rejects a folder moved into itself or into its own descendant, and a
 * target that is not a folder.
 */
export function moveIntoFolder<T extends FolderTrack>(tracks: readonly T[], trackId: string, folderId: string): T[] {
  const tree = toTreeTracks(tracks);
  const map = assertTree(tree);
  if (!map.has(trackId)) throw new Error(`Unknown track id: ${trackId}`);
  const folderNode = map.get(folderId);
  if (!folderNode) throw new Error(`Unknown track id: ${folderId}`);
  if (folderId === trackId || descendantIds(tracks, trackId).includes(folderId)) {
    throw new Error('A folder cannot contain itself');
  }
  if (folderNode.kind !== 'folder') throw new Error('Move into folder needs a folder');
  const originalById = new Map(tracks.map((t): [string, T] => [t.id, t]));
  const moved = moveSubtree(tree, trackId, folderId);
  return moved.map((t): T => {
    const original = originalById.get(t.id)!;
    if (t.id !== trackId) return original;
    const reparented: T = { ...original, parentTrackId: folderId };
    return reparented;
  });
}

/**
 * Re-parents `trackId` to its parent's parent (null at the root). A track
 * already at the root is a no-op that returns the SAME array reference, so
 * the caller can skip the undo step.
 */
export function moveOutOfFolder<T extends FolderTrack>(tracks: readonly T[], trackId: string): T[] {
  const tree = toTreeTracks(tracks);
  const map = assertTree(tree);
  const node = map.get(trackId);
  if (!node) throw new Error(`Unknown track id: ${trackId}`);
  if (node.parentId === null) return tracks as T[];
  const grandparentId = map.get(node.parentId)!.parentId;
  const originalById = new Map(tracks.map((t): [string, T] => [t.id, t]));
  const moved = moveSubtree(tree, trackId, grandparentId);
  return moved.map((t): T => {
    const original = originalById.get(t.id)!;
    if (t.id !== trackId) return original;
    const lifted: T = { ...original, parentTrackId: grandparentId };
    return lifted;
  });
}

/**
 * Removes ONLY `folderId`'s own row and re-parents its direct children to
 * the folder's own parent, in the folder's place in the array order.
 * Children and grandchildren are never removed. Throws on a non-folder id.
 */
export function deleteFolder<T extends FolderTrack>(tracks: readonly T[], folderId: string): T[] {
  const map = assertTree(toTreeTracks(tracks));
  const node = map.get(folderId);
  if (!node) throw new Error(`Unknown track id: ${folderId}`);
  if (node.kind !== 'folder') throw new Error('Not a folder');
  const grandparentId = node.parentId;
  const isDirectChild = (t: T): boolean => (t.parentTrackId ?? null) === folderId;
  const next: T[] = [];
  for (const t of tracks) {
    if (t.id === folderId) {
      for (const child of tracks) {
        if (!isDirectChild(child)) continue;
        const reparented: T = { ...child, parentTrackId: grandparentId };
        next.push(reparented);
      }
      continue;
    }
    if (isDirectChild(t)) continue;
    next.push(t);
  }
  return next;
}

/**
 * One entry per non-folder descendant of `folderId`, carrying only the flags
 * passed in `flags`. Empty array when the folder has no non-folder
 * descendants.
 */
export function folderFlagPatch<T extends FolderTrack>(
  tracks: readonly T[],
  folderId: string,
  flags: { mute?: boolean; solo?: boolean },
): Array<{ id: string; mute?: boolean; solo?: boolean }> {
  const byId = new Map(tracks.map((t): [string, T] => [t.id, t]));
  const out: Array<{ id: string; mute?: boolean; solo?: boolean }> = [];
  for (const id of descendantIds(tracks, folderId)) {
    const track = byId.get(id)!;
    if (track.isFolder) continue;
    const patch: { id: string; mute?: boolean; solo?: boolean } = { id };
    if (flags.mute !== undefined) patch.mute = flags.mute;
    if (flags.solo !== undefined) patch.solo = flags.solo;
    out.push(patch);
  }
  return out;
}
