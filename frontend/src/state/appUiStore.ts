import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const theDAW_VIEWS = ['create', 'edit', 'train', 'library', 'advanced'] as const;
export type theDAWView = typeof theDAW_VIEWS[number];

export function normalizetheDAWView(value: unknown): theDAWView | null {
  return typeof value === 'string' && theDAW_VIEWS.includes(value as theDAWView)
    ? value as theDAWView
    : null;
}

/** Every center-bar tab: MAKE / EDIT / PERFORM / MIX / DJ / VJ / SWAY /
 *  FOUNDRY / UNDERFIT / NODEFI / LOOM / LEARN / TOUR. This is the canonical id
 *  list — what a tab id is allowed to be — and not the on-screen order, which
 *  CenterTabBar's own TABS table sets. All workspaces live here; the legacy
 *  left-side tabs (CREATE/PROCESS) are subsumed by these. LoRA training is the
 *  UNDERFIT tab (the standalone TRAIN workspace was retired in its favor). */
export const CENTER_TABS = ['make', 'edit', 'session', 'mix', 'dj', 'vj', 'sway', 'foundry', 'underfit', 'nodefi', 'loom', 'learn', 'tour'] as const;
export type CenterTab = typeof CENTER_TABS[number];

/** Tabs that were removed or renamed but may still appear in persisted state or
 *  in legacy navigate() calls. Each resolves to its current replacement. */
const CENTER_TAB_ALIASES: Record<string, CenterTab> = {
  // The standalone Train workspace was replaced by the Underfit trainer tab.
  train: 'underfit',
  // Audimate was renamed to NodeF.I. Anyone whose persisted centerTab still
  // says 'audimate' rehydrates onto the same workspace instead of 'make'.
  audimate: 'nodefi',
};

/** Translate a legacy 5-view name into the center-bar tab it became. Only
 *  setActiveView consults this — orb-kit, library row clicks and the
 *  assistant's navigate action all reach the bar through navigateTo or
 *  setCenterTab now — so a caller still holding a view name lands on the
 *  right workspace instead of nowhere. */
const LEGACY_VIEW_TO_CENTER_TAB: Record<string, CenterTab> = {
  create: 'make',
  advanced: 'make',
  // 'edit' must resolve to the EDIT tab. It mapped to 'mix', so every legacy
  // navigate('edit') — orb-kit actions, library row clicks, the assistant's own
  // navigate tool — opened MIX instead. That made the arrangement workspace
  // unreachable by name and left the assistant unable to open the one tab it is
  // meant to drive.
  edit: 'edit',
  session: 'session',
  train: 'underfit',
};

export function normalizeCenterTab(value: unknown): CenterTab | null {
  if (typeof value !== 'string') return null;
  if ((CENTER_TABS as readonly string[]).includes(value)) return value as CenterTab;
  return CENTER_TAB_ALIASES[value] ?? null;
}

/** Every name a navigation request may use for a workspace: canonical tab ids,
 *  display labels, and retired legacy view names. */
const NAVIGATE_ALIASES: Record<string, CenterTab> = {
  perform: 'session',
  create: 'make',
  advanced: 'make',
  generate: 'make',
  train: 'underfit',
  // NodeF.I. spellings the assistant or a legacy caller might use. 'nodefi'
  // itself is a real tab id now, so it needs no alias; 'audimate' is handled
  // by CENTER_TAB_ALIASES, which normalizeCenterTab consults first.
  'nodef.i.': 'nodefi',
  'node f.i.': 'nodefi',
  // LOOM — the shard sequencer (docs/design/loom.md).
  weave: 'loom',
  shards: 'loom',
  jacquard: 'loom',
};

/** The legacy 5-view enum. Nothing renders off it any more — PlayerFooter and
 *  ProcessingLog both moved to centerTab after it went stale on them — but it
 *  is still written on every navigation, so a reader that comes back to it
 *  never finds the value frozen at whatever the last navigate() left. */
function legacyViewForTab(tab: CenterTab): theDAWView {
  if (tab === 'edit') return 'edit';
  if (tab === 'underfit') return 'train';
  return 'create';
}

/** Interface modes, applied per-surface starting with the FOUNDRY tab.
 *  Senpai is the full pro cockpit as it ships today; Kouhai is a secondary
 *  presentation of the SAME surface: more app-like and simplified in
 *  appearance with zero functionality removed. Senpai is the default so
 *  existing users see no change on upgrade. */
export const UI_MODES = ['kouhai', 'senpai'] as const;
export type UiMode = typeof UI_MODES[number];

export function normalizeUiMode(value: unknown): UiMode | null {
  return typeof value === 'string' && (UI_MODES as readonly string[]).includes(value)
    ? value as UiMode
    : null;
}

interface AppUiState {
  activeView: theDAWView;
  centerTab: CenterTab;
  uiMode: UiMode;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  isLibraryExpanded: boolean;
  rightPanelWidth: number;
  docsOpen: boolean;
  setActiveView: (view: unknown) => void;
  setCenterTab: (tab: unknown) => void;
  /** Navigate to any workspace by canonical tab id, display label, or legacy
   *  view name ('library' opens the right rail). Returns false when the target
   *  is unknown, so callers (the assistant) can report failure honestly. */
  navigateTo: (target: unknown) => boolean;
  setUiMode: (mode: unknown) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setLibraryExpanded: (expanded: boolean) => void;
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
      centerTab: 'make',
      uiMode: 'senpai',
      // There is no left panel any more — the center bar hosts all tab content
      // (CenterTabBar states the invariant). The flag survives because the
      // assistant's app context still reports it; nothing toggles it and
      // nothing renders behind it.
      isLeftPanelOpen: false,
      isRightPanelOpen: false,
      isLibraryExpanded: false,
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
      docsOpen: false,
      setActiveView: (view) => {
        const normalized = normalizetheDAWView(view);
        if (!normalized) return;
        // The library used to be a left-tab; it now lives in the right-edge
        // rail, which stays collapsed until its labelled edge tab (or Ctrl+K)
        // opens it. Any caller that asks to navigate to 'library' gets that
        // rail opened rather than a view change.
        if (normalized === 'library') {
          set({ isRightPanelOpen: true });
          return;
        }
        // Mirror legacy view → center tab, so a caller that still hands over a
        // view name moves the workspace too and not just the dead enum.
        const mapped = LEGACY_VIEW_TO_CENTER_TAB[normalized];
        if (mapped) {
          set({ activeView: normalized, centerTab: mapped });
        } else {
          set({ activeView: normalized });
        }
      },
      setCenterTab: (tab) => {
        const normalized = normalizeCenterTab(tab);
        if (!normalized) return;
        // Keep the legacy activeView in step: it used to be written only by
        // assistant navigation, so clicking a tab left it stale ('create'
        // forever, or stuck on 'train' after one navigate) and the footer
        // action button / assistant context read the wrong workspace.
        set({ centerTab: normalized, activeView: legacyViewForTab(normalized) });
      },
      navigateTo: (target) => {
        if (typeof target !== 'string') return false;
        const key = target.trim().toLowerCase();
        if (!key) return false;
        if (key === 'library') {
          set({ isRightPanelOpen: true });
          return true;
        }
        const tab = normalizeCenterTab(key) ?? NAVIGATE_ALIASES[key] ?? null;
        if (!tab) return false;
        set({ centerTab: tab, activeView: legacyViewForTab(tab) });
        return true;
      },
      setUiMode: (mode) => {
        const normalized = normalizeUiMode(mode);
        if (!normalized) return;
        set({ uiMode: normalized });
      },
      setLeftPanelOpen: (open) => set({ isLeftPanelOpen: open }),
      setRightPanelOpen: (open) => set({ isRightPanelOpen: open, ...(open ? {} : { isLibraryExpanded: false }) }),
      setLibraryExpanded: (expanded) => set({ isLibraryExpanded: expanded, ...(expanded ? { isRightPanelOpen: true } : {}) }),
      setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
      setDocsOpen: (open) => set({ docsOpen: open }),
    }),
    {
      name: 'thedaw-app-ui-v2',
      // Bumped when a persisted centerTab value could reference a removed tab
      // (e.g. the retired 'train' workspace). migrate() coerces it to a valid
      // tab so returning users never rehydrate onto a tab that no longer exists.
      // v2 added uiMode (Kouhai/Senpai, consumed by the FOUNDRY surface).
      // v3: the 'audimate' tab id became 'nodefi'; CENTER_TAB_ALIASES maps the
      // old value so a returning user lands back on the same workspace.
      version: 3,
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as { centerTab?: unknown; rightPanelWidth?: unknown; uiMode?: unknown };
        return {
          ...p,
          uiMode: normalizeUiMode(p.uiMode) ?? 'senpai',
          centerTab: normalizeCenterTab(p.centerTab) ?? 'make',
        };
      },
      // Panel open/expand state is intentionally NOT persisted: every app open
      // starts with the shell chrome collapsed — the right library rail shut,
      // the docs modal closed. Only the active center tab, the interface mode
      // and the rail width are remembered.
      partialize: (s) => ({
        centerTab: s.centerTab,
        uiMode: s.uiMode,
        rightPanelWidth: s.rightPanelWidth,
      }),
    },
  ),
);
