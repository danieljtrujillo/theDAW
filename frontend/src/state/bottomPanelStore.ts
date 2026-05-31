import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BottomPanelTab = 'spectral' | 'details' | 'piano-roll' | 'step-seq' | 'bucket' | 'slide';

interface BottomPanelState {
  activeTab: BottomPanelTab;
  isOpen: boolean;
  isLogOpen: boolean;
  /** Height of the BottomMultiTabPanel column when open. Independent
   *  of the LOG column — changing this does NOT affect the LOG and
   *  vice versa. Each column has its own resize handle. */
  multiHeight: number;
  /** Height of the ProcessingLog column when open. Independent of
   *  the multi panel. */
  logHeight: number;
  /** When true, the multi-tab body fills the work area (covers the canvas).
   *  Remembers the prior multiHeight so restore returns to it. */
  multiMaximized: boolean;
  setActiveTab: (tab: BottomPanelTab) => void;
  setOpen: (open: boolean) => void;
  setLogOpen: (open: boolean) => void;
  setMultiHeight: (height: number) => void;
  setLogHeight: (height: number) => void;
  setMultiMaximized: (on: boolean) => void;
  toggleMultiMaximized: () => void;
  showTab: (tab: BottomPanelTab) => void;
}

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set) => ({
      activeTab: 'spectral',
      isOpen: true,
      isLogOpen: false,
      multiHeight: 260,
      logHeight: 260,
      multiMaximized: false,
      setActiveTab: (activeTab) => set({ activeTab }),
      setOpen: (isOpen) => set({ isOpen }),
      setLogOpen: (isLogOpen) => set({ isLogOpen }),
      setMultiHeight: (multiHeight) => set({ multiHeight }),
      setLogHeight: (logHeight) => set({ logHeight }),
      setMultiMaximized: (multiMaximized) => set({ multiMaximized }),
      toggleMultiMaximized: () => set((s) => ({ multiMaximized: !s.multiMaximized })),
      // Opening/activating a tab should also un-maximize so the user isn't
      // trapped full-screen after navigating.
      showTab: (tab) => set({ activeTab: tab, isOpen: true }),
    }),
    {
      name: 'stabledaw-bottom-panel-v3',
      partialize: (s) => ({
        activeTab: s.activeTab,
        isOpen: s.isOpen,
        isLogOpen: s.isLogOpen,
        multiHeight: s.multiHeight,
        logHeight: s.logHeight,
        multiMaximized: s.multiMaximized,
      }),
    },
  ),
);

