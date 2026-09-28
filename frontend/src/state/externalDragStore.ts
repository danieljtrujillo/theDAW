/**
 * Cross-surface "drag-out" coordination bus.
 *
 * Used when a drag gesture doesn't fit native HTML5 DnD — currently the
 * editor's Ctrl+drag on clips, which must coexist with the existing
 * pointer-driven move/resize logic.
 *
 * Lifecycle:
 *   - Drag source calls `begin(items, more?)` when it decides this gesture is
 *     a drag-out (e.g., Ctrl held + movement threshold exceeded). `items` is
 *     the audio it has now; `more.pending` is audio still being made for the
 *     drag (a MIDI part rendering for it), which the drop takes when it lands;
 *     `more.onDone` runs once the drag is over and `pending` has settled, so a
 *     render made for the drag alone can be freed.
 *   - Drop targets read `active` + `items` reactively and render their
 *     active-drop state. They listen for document-level `pointerup` and
 *     call `end()` after performing their drop logic (`dropPending` hands them
 *     the audio still being made).
 *   - If pointerup happens outside any drop target, the global cleanup
 *     listener calls `end()`.
 */

import { create } from 'zustand';
import type { AudioDragItem } from '../lib/audioDnD';

interface ExternalDragState {
  active: boolean;
  items: AudioDragItem[];
  /** Audio still being made for this drag; the drop adds it when it lands. */
  pending: Promise<AudioDragItem[]> | null;
  /** Run once the drag has ended and `pending` has settled. */
  onDone: (() => void) | null;
  begin: (items: AudioDragItem[], more?: { pending?: Promise<AudioDragItem[]>; onDone?: () => void }) => void;
  end: () => void;
}

export const useExternalDragStore = create<ExternalDragState>((set, get) => ({
  active: false,
  items: [],
  pending: null,
  onDone: null,
  begin: (items, more) => set({ active: true, items, pending: more?.pending ?? null, onDone: more?.onDone ?? null }),
  end: () => {
    const { pending, onDone } = get();
    set({ active: false, items: [], pending: null, onDone: null });
    if (onDone) void (pending ?? Promise.resolve([])).then(onDone, onDone);
  },
}));

/**
 * The audio still being made for the drag that is ending, for a drop target to
 * add once it lands: `add` gets the items, `fail` the reason when they cannot
 * be made. Nothing happens when the drag carries none. Call it before `end()`.
 */
export function dropPending(add: (items: AudioDragItem[]) => void, fail: (reason: string) => void): void {
  const pending = useExternalDragStore.getState().pending;
  if (!pending) return;
  pending.then(
    (items) => { if (items.length) add(items); },
    (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
  );
}
