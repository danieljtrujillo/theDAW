/**
 * Opening whatever a feature lives inside, so a spotlight has something to
 * land on.
 *
 * Split out of featureRegistry.ts on purpose: the registry is pure data that a
 * node test and a keystroke-fast search can both read, while this half reaches
 * into the app's stores. Nothing that only needs to know WHERE a feature is
 * should have to drag zustand in behind it.
 *
 * Two flavours, and the difference matters. The tour is passing through, so its
 * helpers hand back an undo and the workspace ends up exactly as it was. A
 * one-off "show me where this is" is not passing through — you asked to be
 * taken there — so {@link revealFeature} opens and leaves it open.
 */
import { useAppUiStore, type CenterTab } from '../state/appUiStore';
import { useBottomPanelStore, type BottomPanelTab } from '../state/bottomPanelStore';
import type { FeatureEntry } from './featureRegistry';

/** Open the library rail; close it again afterwards if we were the ones who opened it. */
export const openLibraryRail = (): (() => void) | void => {
  const ui = useAppUiStore.getState();
  if (ui.isRightPanelOpen) return;
  ui.setRightPanelOpen(true);
  return () => useAppUiStore.getState().setRightPanelOpen(false);
};

/** Show a tab in the bottom dock; restore the dock exactly as it was afterwards. */
export const openDockTab = (tab: BottomPanelTab): (() => void) | void => {
  const dock = useBottomPanelStore.getState();
  const wasOpen = dock.isOpen;
  const prevTab = dock.activeTab;
  dock.showTab(tab);
  return () => {
    const d = useBottomPanelStore.getState();
    if (!wasOpen) d.setOpen(false);
    d.setActiveTab(prevTab);
  };
};

/** The workspace to switch to before measuring a feature's target, if any. */
export function centerTabFor(entry: FeatureEntry): CenterTab | undefined {
  return entry.surface.kind === 'center' ? entry.surface.tab : undefined;
}

/** Open what a feature lives in and leave it open. */
export function revealFeature(entry: FeatureEntry): void {
  switch (entry.surface.kind) {
    case 'rail':
      useAppUiStore.getState().setRightPanelOpen(true);
      break;
    case 'dock':
      useBottomPanelStore.getState().showTab(entry.surface.tab);
      break;
    default:
      break;
  }
}
