import { create } from 'zustand';

export type BottomPanelTab = 'spectral' | 'details' | 'piano-roll' | 'bucket';

interface BottomPanelState {
  activeTab: BottomPanelTab;
  isOpen: boolean;
  setActiveTab: (tab: BottomPanelTab) => void;
  setOpen: (open: boolean) => void;
  showTab: (tab: BottomPanelTab) => void;
}

export const useBottomPanelStore = create<BottomPanelState>()((set) => ({
  activeTab: 'spectral',
  isOpen: true,
  setActiveTab: (activeTab) => set({ activeTab }),
  setOpen: (isOpen) => set({ isOpen }),
  showTab: (tab) => set({ activeTab: tab, isOpen: true }),
}));
