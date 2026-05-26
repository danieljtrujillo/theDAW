import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  isRightPanelOpen: boolean;
  rightPanelWidth: number;
  docsOpen: boolean;
  setActiveView: (view: unknown) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setDocsOpen: (open: boolean) => void;
}

const RIGHT_PANEL_DEFAULT_WIDTH = 380;
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 640;

function clampRightPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, Math.round(w)));
}

export const useAppUiStore = create<AppUiState>()(
  persist(
    (set) => ({
      activeView: 'create',
      isLeftPanelOpen: true,
      isRightPanelOpen: false,
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
      docsOpen: false,
      setActiveView: (view) => {
        const normalized = normalizeStableDAWView(view);
        if (!normalized) return;
        // The library used to be a left-tab; it now lives in a permanent
        // right-side dock. Any caller that asks to navigate to 'library'
        // gets the right panel opened instead of changing the left view.
        if (normalized === 'library') {
          set({ isRightPanelOpen: true });
          return;
        }
        set({ activeView: normalized });
      },
      setLeftPanelOpen: (open) => set({ isLeftPanelOpen: open }),
      setRightPanelOpen: (open) => set({ isRightPanelOpen: open }),
      setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
      setDocsOpen: (open) => set({ docsOpen: open }),
    }),
    {
      name: 'stabledaw-app-ui',
      partialize: (s) => ({
        isLeftPanelOpen: s.isLeftPanelOpen,
        isRightPanelOpen: s.isRightPanelOpen,
        rightPanelWidth: s.rightPanelWidth,
      }),
    },
  ),
);
