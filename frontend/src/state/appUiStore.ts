import { create } from 'zustand';

export const STABLEDAW_VIEWS = ['create', 'edit', 'train', 'library', 'advanced'] as const;
export type StableDAWView = typeof STABLEDAW_VIEWS[number];

export function normalizeStableDAWView(value: unknown): StableDAWView | null {
  return typeof value === 'string' && STABLEDAW_VIEWS.includes(value as StableDAWView)
    ? value as StableDAWView
    : null;
}

interface AppUiState {
  activeView: StableDAWView;
  isLeftPanelOpen: boolean;
  docsOpen: boolean;
  setActiveView: (view: unknown) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setDocsOpen: (open: boolean) => void;
}

export const useAppUiStore = create<AppUiState>()((set) => ({
  activeView: 'create',
  isLeftPanelOpen: true,
  docsOpen: false,
  setActiveView: (view) => {
    const normalized = normalizeStableDAWView(view);
    if (normalized) set({ activeView: normalized });
  },
  setLeftPanelOpen: (open) => set({ isLeftPanelOpen: open }),
  setDocsOpen: (open) => set({ docsOpen: open }),
}));
