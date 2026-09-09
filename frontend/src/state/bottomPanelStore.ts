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
  | 'levels'
  | 'spectral'
  | 'details'
  | 'score'
  | 'sing'
  | 'midi'
  | 'step-seq'
  | 'draw'
  | 'slide'
  | 'sway'
  | 'xrbus'; // dev-only tab; hidden (and remapped on rehydrate) in production builds

/** Layout of the merged DETAILS tab: both panes, or one of them full-width. */
export type DetailsPane = 'split' | 'details' | 'media';

/** Layout of the SING tab: the karaoke lyrics alone, the whole SCORE tab
 *  alone, the two side by side, or the lyrics beside the literary analysis.
 *  A future pane only adds a member here and a button in the tab row's
 *  SingPaneToggle. */
export type SingPane = 'sing' | 'split' | 'score' | 'analysis';

interface BottomPanelState {
  activeTab: BottomPanelTab;
  detailsPane: DetailsPane;
  singPane: SingPane;
  singSplit: number;        // 0..1 fraction of the SING split the lyrics take
  isOpen: boolean;          // multi-tab panel body open
  isLogOpen: boolean;       // log panel body open
  logVerbose: boolean;      // LOG shows every raw entry; false = folded SIMPLE view
  multiHeight: number;      // px height of the dock body (shared by multi + log)
  logWidth: number;         // px width of the log column (independent)
  multiMaximized: boolean;  // multi-tab fills the work area
  setActiveTab: (t: BottomPanelTab) => void;
  setDetailsPane: (p: DetailsPane) => void;
  setSingPane: (p: SingPane) => void;
  setSingSplit: (f: number) => void;
  setOpen: (v: boolean) => void;
  setLogOpen: (v: boolean) => void;
  setLogVerbose: (v: boolean) => void;
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
/** Neither SING column may be squeezed past this; the separator clamps to it
 *  and reports it as its aria-value range. */
export const SING_SPLIT_MIN = 0.2;
export const SING_SPLIT_MAX = 0.8;

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set) => ({
      activeTab: 'spectral',
      detailsPane: 'split',
      singPane: 'sing',
      singSplit: 0.5,
      isOpen: false,
      isLogOpen: false,
      logVerbose: false,
      multiHeight: 320,
      logWidth: 320,
      multiMaximized: false,
      setActiveTab: (t) => set({ activeTab: t }),
      setDetailsPane: (p) => set({ detailsPane: p }),
      setSingPane: (p) => set({ singPane: p }),
      setSingSplit: (f) => set({ singSplit: Math.max(SING_SPLIT_MIN, Math.min(SING_SPLIT_MAX, f)) }),
      setOpen: (v) => set({ isOpen: v }),
      setLogOpen: (v) => set({ isLogOpen: v }),
      setLogVerbose: (v) => set({ logVerbose: v }),
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
      name: 'thedaw-bottom-panel-v5',
      version: 1,
      // The old 'piano-roll' and 'vocal' tabs merged into one 'midi' tab; map a
      // persisted active tab forward so a returning user lands somewhere valid.
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as { activeTab?: string };
        if (p.activeTab === 'piano-roll' || p.activeTab === 'vocal') {
          p.activeTab = 'midi';
        }
        // The Media bucket merged into the DETAILS tab (2026-09-07).
        if (p.activeTab === 'bucket') {
          p.activeTab = 'details';
        }
        // The XR Bus tab only exists in dev builds; a persisted selection must
        // not leave a production dock with no active tab.
        if (p.activeTab === 'xrbus' && !import.meta.env.DEV) {
          p.activeTab = 'spectral';
        }
        return p as unknown as BottomPanelState;
      },
      // Open/maximized state is intentionally NOT persisted so the bottom dock
      // and the log start collapsed on every app open. The active tab and the
      // sizes are remembered.
      partialize: (s) => ({
        activeTab: s.activeTab,
        detailsPane: s.detailsPane,
        singPane: s.singPane,
        singSplit: s.singSplit,
        multiHeight: s.multiHeight,
        logWidth: s.logWidth,
        logVerbose: s.logVerbose,
      }),
    },
  ),
);
