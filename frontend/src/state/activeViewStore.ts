import { create } from 'zustand';

interface ActiveViewStoreState {
  activeView: string;
  setActiveView: (v: string) => void;
}

export const useActiveViewStore = create<ActiveViewStoreState>()((set) => ({
  activeView: 'create',
  setActiveView: (v) => set({ activeView: v }),
}));
