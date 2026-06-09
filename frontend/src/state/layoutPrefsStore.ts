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

// App-wide UI/text scale (page zoom). Clamped so nothing gets unusably big or
// small. 1.0 = the app's native density (unchanged default).
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.3;
const DEFAULT_UI_SCALE = 1.0;

interface LayoutPrefsState {
  fillMode: FillMode;
  gapPx: number;
  /** App-wide UI/text scale (page zoom), clamped to [UI_SCALE_MIN, UI_SCALE_MAX]. */
  uiScale: number;
  /** Snap step (px) for dragging margins/handles; 0 = no snapping. Hold Ctrl
   *  while dragging to override with a 1px fine step. */
  snapPx: number;
  /** Show the centre + increment alignment guides while editing. */
  showGuides: boolean;
  /** Match same-kind control sizes within a panel: equal height across a row,
   *  equal width down a column (sized to the shared cross-axis). On by default. */
  matchSizes: boolean;
  setFillMode: (m: FillMode) => void;
  setGapPx: (px: number) => void;
  setSnapPx: (px: number) => void;
  setShowGuides: (v: boolean) => void;
  setMatchSizes: (v: boolean) => void;
  setUiScale: (v: number) => void;
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
      matchSizes: true,
      uiScale: DEFAULT_UI_SCALE,
      setFillMode: (m) => set({ fillMode: m }),
      setGapPx: (px) => set({ gapPx: clamp(Math.round(px), 0, 40) }),
      setSnapPx: (px) => set({ snapPx: clamp(Math.round(px), 0, 32) }),
      setShowGuides: (v) => set({ showGuides: v }),
      setMatchSizes: (v) => set({ matchSizes: v }),
      // Round to 0.01 and clamp so persisted/applied values stay sane.
      setUiScale: (v) => set({ uiScale: clamp(Math.round(v * 100) / 100, UI_SCALE_MIN, UI_SCALE_MAX) }),
      reset: () => set({ fillMode: 'scale', gapPx: DEFAULT_GAP, snapPx: DEFAULT_SNAP, showGuides: true, matchSizes: true, uiScale: DEFAULT_UI_SCALE }),
    }),
    { name: 'thedaw.layoutprefs.v1' },
  ),
);
