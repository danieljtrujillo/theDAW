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
  setFillMode: (m: FillMode) => void;
  setGapPx: (px: number) => void;
  reset: () => void;
}

export const useLayoutPrefs = create<LayoutPrefsState>()(
  persist(
    (set) => ({
      fillMode: 'scale',
      gapPx: DEFAULT_GAP,
      setFillMode: (m) => set({ fillMode: m }),
      setGapPx: (px) => set({ gapPx: clamp(Math.round(px), 0, 40) }),
      reset: () => set({ fillMode: 'scale', gapPx: DEFAULT_GAP }),
    }),
    { name: 'thedaw.layoutprefs.v1' },
  ),
);
