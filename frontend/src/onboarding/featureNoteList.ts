/**
 * The notes themselves.
 *
 * Kept apart from the store and the renderer so adding one is a single entry
 * and touches nothing else. Keep this list SHORT — a note on every control is
 * the same as no notes at all. The bar: could a new user find this affordance
 * without being told? If yes, it does not belong here.
 */
import { useAppUiStore } from '../state/appUiStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { NOTE_TARGET_SELECTOR, type FeatureNoteDef } from './featureNoteStore';

export const FEATURE_NOTES: FeatureNoteDef[] = [
  {
    id: 'library',
    label: 'Library',
    body: 'Your songs live here. Click the tab to slide the library out.',
    target: NOTE_TARGET_SELECTOR('library'),
    placement: 'left',
    // Opening it once is proof enough; the rail is obvious from then on.
    learned: () => useAppUiStore.getState().isRightPanelOpen,
  },
  {
    id: 'log',
    label: 'Log',
    body: 'Machine stats, and every job the app has run. Click to expand.',
    target: NOTE_TARGET_SELECTOR('log'),
    placement: 'top',
    learned: () => useBottomPanelStore.getState().isLogOpen,
  },
  {
    id: 'panels',
    label: 'Panels',
    body: 'Score, lyrics, levels, MIDI and more — this strip opens them.',
    target: NOTE_TARGET_SELECTOR('panels'),
    placement: 'top',
    learned: () => useBottomPanelStore.getState().isOpen,
  },
];
