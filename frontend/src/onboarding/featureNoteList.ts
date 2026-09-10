/**
 * The notes themselves.
 *
 * Kept apart from the store and the renderer so adding one is a single entry
 * and touches nothing else. Keep this list SHORT — a note on every control is
 * the same as no notes at all. The bar: could a new user find this affordance
 * without being told? If yes, it does not belong here.
 *
 * Each note names its featureRegistry entry, which owns what the thing is and
 * how to reveal it. What stays here is what only a pinned note needs: the one
 * line it shows, which side of the target it sits on, and what counts as having
 * found the feature.
 */
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { NOTE_TARGET_SELECTOR, type FeatureNoteDef } from './featureNoteStore';

// The library used to head this list. It no longer qualifies: its edge tab
// carries the LIBRARY wordmark, and rule 1 in featureNoteStore is that a
// control which says what it is does not get a note.
export const FEATURE_NOTES: FeatureNoteDef[] = [
  {
    id: 'log',
    feature: 'log',
    label: 'Log',
    body: 'Machine stats, and every job the app has run. Click to expand.',
    target: NOTE_TARGET_SELECTOR('log'),
    placement: 'top',
    learned: () => useBottomPanelStore.getState().isLogOpen,
  },
  {
    id: 'panels',
    feature: 'panels',
    label: 'Panels',
    body: 'Score, lyrics, levels, MIDI and more — this strip opens them.',
    target: NOTE_TARGET_SELECTOR('panels'),
    placement: 'top',
    learned: () => useBottomPanelStore.getState().isOpen,
  },
];
