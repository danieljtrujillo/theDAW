import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BottomPanelTab = 'spectral' | 'details' | 'piano-roll' | 'step-seq' | 'bucket';

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
  setActiveTab: (tab: BottomPanelTab) => void;
  setOpen: (open: boolean) => void;
  setLogOpen: (open: boolean) => void;
  setMultiHeight: (height: number) => void;
  setLogHeight: (height: number) => void;
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
      setActiveTab: (activeTab) => set({ activeTab }),
      setOpen: (isOpen) => set({ isOpen }),
      setLogOpen: (isLogOpen) => set({ isLogOpen }),
      setMultiHeight: (multiHeight) => set({ multiHeight }),
      setLogHeight: (logHeight) => set({ logHeight }),
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
      }),
    },
  ),
);
