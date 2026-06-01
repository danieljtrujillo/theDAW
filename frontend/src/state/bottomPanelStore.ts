/**
 * Bottom panel store — drives the global dock at the bottom of the Shell.
 *
 * Two panels share the dock side-by-side:
 *   - the multi-tab panel (Visualize / Piano / … / SLIDE)
 *   - the processing LOG (bottom-right)
 * They share ONE body height (`multiHeight`) so the LOG can never grow taller
 * than the dock and push into the center work area. The LOG has its own
 * independent WIDTH (`logWidth`); its resize handle nudges the right column
 * above it, but resizing that column never changes `logWidth`. Persisted so the
 * layout survives reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BottomPanelTab =
  | 'spectral'
  | 'details'
  | 'piano-roll'
  | 'step-seq'
  | 'bucket'
  | 'slide';

interface BottomPanelState {
  activeTab: BottomPanelTab;
  isOpen: boolean;          // multi-tab panel body open
  isLogOpen: boolean;       // log panel body open
  multiHeight: number;      // px height of the dock body (shared by multi + log)
  logWidth: number;         // px width of the log column (independent)
  multiMaximized: boolean;  // multi-tab fills the work area
  setActiveTab: (t: BottomPanelTab) => void;
  setOpen: (v: boolean) => void;
  setLogOpen: (v: boolean) => void;
  setMultiHeight: (h: number) => void;
  setLogWidth: (w: number) => void;
  setMultiMaximized: (v: boolean) => void;
  toggleMultiMaximized: () => void;
  showTab: (t: BottomPanelTab) => void;
}

const MULTI_MIN = 120;
const MULTI_MAX = 900;
const LOG_MIN_WIDTH = 220;
const LOG_MAX_WIDTH = 720;

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set) => ({
      activeTab: 'spectral',
      isOpen: false,
      isLogOpen: false,
      multiHeight: 320,
      logWidth: 320,
      multiMaximized: false,
      setActiveTab: (t) => set({ activeTab: t }),
      setOpen: (v) => set({ isOpen: v }),
      setLogOpen: (v) => set({ isLogOpen: v }),
      setMultiHeight: (h) => set({ multiHeight: Math.max(MULTI_MIN, Math.min(MULTI_MAX, h)) }),
      setLogWidth: (w) => set({ logWidth: Math.max(LOG_MIN_WIDTH, Math.min(LOG_MAX_WIDTH, w)) }),
      setMultiMaximized: (v) => set({ multiMaximized: v }),
      toggleMultiMaximized: () => set((s) => ({ multiMaximized: !s.multiMaximized })),
      showTab: (t) =>
        set(() => ({
          activeTab: t,
          isOpen: true,
          // opening a tab doesn't force the log open/closed
        })),
    }),
    {
      name: 'stabledaw-bottom-panel-v4',
      partialize: (s) => ({
        activeTab: s.activeTab,
        isOpen: s.isOpen,
        isLogOpen: s.isLogOpen,
        multiHeight: s.multiHeight,
        logWidth: s.logWidth,
        multiMaximized: s.multiMaximized,
      }),
    },
  ),
);
