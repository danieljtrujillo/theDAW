import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* Global control-surface preferences (client-only, separate from the backend
 * /api/settings feature toggles). These apply to every surface instance:
 *   - fillMode: how a control uses the dead space in its cell.
 *       'scale'   → the control grows to fill the cell (default).
 *       'natural' → the control stays at a compact size, centred.
 *   - gapPx: the gap between panels (the splitter track width), surface-wide.
 * Edited from the Settings modal's "Edit Layout Settings" section. */

export type FillMode = 'scale' | 'natural';

const DEFAULT_GAP = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface LayoutPrefsState {
  fillMode: FillMode;
  gapPx: number;
  /** Snap step (px) for dragging margins/handles; 0 = no snapping. Hold Ctrl
   *  while dragging to override with a 1px fine step. */
  snapPx: number;
  /** Show the centre + increment alignment guides while editing. */
  showGuides: boolean;
  setFillMode: (m: FillMode) => void;
  setGapPx: (px: number) => void;
  setSnapPx: (px: number) => void;
  setShowGuides: (v: boolean) => void;
  reset: () => void;
}

const DEFAULT_SNAP = 8;

export const useLayoutPrefs = create<LayoutPrefsState>()(
  persist(
    (set) => ({
      fillMode: 'scale',
      gapPx: DEFAULT_GAP,
      snapPx: DEFAULT_SNAP,
      showGuides: true,
      setFillMode: (m) => set({ fillMode: m }),
      setGapPx: (px) => set({ gapPx: clamp(Math.round(px), 0, 40) }),
      setSnapPx: (px) => set({ snapPx: clamp(Math.round(px), 0, 32) }),
      setShowGuides: (v) => set({ showGuides: v }),
      reset: () => set({ fillMode: 'scale', gapPx: DEFAULT_GAP, snapPx: DEFAULT_SNAP, showGuides: true }),
    }),
    { name: 'thedaw.layoutprefs.v1' },
  ),
);
