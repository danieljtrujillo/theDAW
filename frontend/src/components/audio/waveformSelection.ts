/**
 * Pure selection maths for the EDIT timeline's clip multi-selection.
 *
 * The selection itself lives in `useEditorStore` (`selectedClipIds` +
 * `setSelectedClips`) so the assistant's `editor_select_clips` / `editor_select_range`
 * tools and the canvas are looking at ONE value. WaveformEditor used to keep a
 * second copy in `useState` and reached for the functional updater
 * (`setSelectedClipIds(prev => …)`) for the shift/ctrl cases; a store setter takes
 * a plain array, so those updaters live here instead — current selection in, next
 * selection out.
 *
 * Ordering is load-bearing: the store keeps `selectedClipId` as
 * `selectedClipIds[0]`, and `selectedClipId` is the anchor a shift-click ranges
 * from. Every helper that responds to a click therefore returns the CLICKED id
 * first, which reproduces the old `setSelected(clipId)` that ran alongside the
 * local-state update.
 */

/**
 * Drop ids that no longer name a live clip.
 *
 * Returns the SAME array when nothing was dropped, so the caller can skip the
 * store write. The pruning effect depends on the selection it prunes; handing
 * back a fresh-but-equal array every render would write the store forever.
 */
export const pruneSelection = (selected: string[], present: Iterable<string>): string[] => {
  const live = present instanceof Set ? present : new Set(present);
  const next = selected.filter((id) => live.has(id));
  return next.length === selected.length ? selected : next;
};

/** Ctrl/Cmd-click: add the clip as the new anchor, or take it back out. */
export const toggleSelection = (selected: string[], id: string): string[] =>
  selected.includes(id) ? selected.filter((other) => other !== id) : [id, ...selected];

/**
 * Shift-click: every id between the anchor and the clicked clip in timeline
 * order. `null` when either end is no longer on the timeline — the caller then
 * falls back to a plain single-clip selection, exactly as before.
 */
export const rangeSelection = (
  orderedIds: string[],
  anchorId: string,
  targetId: string,
): string[] | null => {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a < 0 || b < 0) return null;
  const [start, end] = a < b ? [a, b] : [b, a];
  const range = orderedIds.slice(start, end + 1);
  return [targetId, ...range.filter((id) => id !== targetId)];
};

/** Shift+Ctrl-click: fold a new range into the existing selection, duplicates
 *  collapsing onto their first (earliest-leading) position. */
export const mergeSelection = (selected: string[], add: string[]): string[] => {
  const merged = [...add, ...selected];
  return merged.filter((id, i) => merged.indexOf(id) === i);
};

/**
 * The modifiers a Ctrl/Cmd pointer-down replays on pointer-up when it never
 * travelled far enough to become an external drag. Every Ctrl pointer-down
 * takes that `ctrl-drag-pending` detour, so whatever Shift was held has to ride
 * along in the op record — dropping it made Shift+Ctrl-click (the additive
 * range) unreachable by mouse.
 */
export const ctrlDragClickModifiers = (
  op: { shiftKey?: boolean },
): { ctrlKey: true; shiftKey: boolean } => ({ ctrlKey: true, shiftKey: !!op.shiftKey });
