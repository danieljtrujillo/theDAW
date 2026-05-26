/**
 * Cross-surface "drag-out" coordination bus.
 *
 * Used when a drag gesture doesn't fit native HTML5 DnD — currently the
 * editor's Ctrl+drag on clips, which must coexist with the existing
 * pointer-driven move/resize logic.
 *
 * Lifecycle:
 *   - Drag source calls `begin(items)` when it decides this gesture is a
 *     drag-out (e.g., Ctrl held + movement threshold exceeded).
 *   - Drop targets read `active` + `items` reactively and render their
 *     active-drop state. They listen for document-level `pointerup` and
 *     call `end()` after performing their drop logic.
 *   - If pointerup happens outside any drop target, the global cleanup
 *     listener calls `end()`.
 */

import { create } from 'zustand';
import type { AudioDragItem } from '../lib/audioDnD';

interface ExternalDragState {
  active: boolean;
  items: AudioDragItem[];
  begin: (items: AudioDragItem[]) => void;
  end: () => void;
}

export const useExternalDragStore = create<ExternalDragState>((set) => ({
  active: false,
  items: [],
  begin: (items) => set({ active: true, items }),
  end: () => set({ active: false, items: [] }),
}));
