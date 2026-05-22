import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BottomPanelTab = 'spectral' | 'details' | 'piano-roll' | 'bucket';

interface BottomPanelState {
  activeTab: BottomPanelTab;
  isOpen: boolean;
  setActiveTab: (tab: BottomPanelTab) => void;
  setOpen: (open: boolean) => void;
  showTab: (tab: BottomPanelTab) => void;
}

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set) => ({
      activeTab: 'spectral',
      isOpen: true,
      setActiveTab: (activeTab) => set({ activeTab }),
      setOpen: (isOpen) => set({ isOpen }),
      showTab: (tab) => set({ activeTab: tab, isOpen: true }),
    }),
    {
      name: 'stabledaw-bottom-panel',
      partialize: (s) => ({ activeTab: s.activeTab, isOpen: s.isOpen }),
    },
  ),
);
