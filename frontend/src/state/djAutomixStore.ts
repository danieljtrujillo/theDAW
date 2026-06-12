import { create } from 'zustand';
import { useSetlistStore, type SetlistEntry } from './setlistStore';
import { useAppUiStore } from './appUiStore';

/**
 * djAutomix — the bridge from "Send to DJ" (suggester, or any track list) into
 * the DJ tab's automix. The DJ deck/automix machinery lives inside DJView as
 * local state, so a caller elsewhere cannot flip it on directly. Instead the
 * caller populates the active setlist + switches to the DJ tab, then trips this
 * one-shot `pendingStart` flag; DJView watches it, consumes it, and turns
 * automix on. A plain boolean (not a persisted value) so it never re-fires on a
 * remount or reload.
 */
interface DjAutomixState {
  /** Set true to ask the DJ tab to begin automixing the active set. */
  pendingStart: boolean;
  requestStart: () => void;
  consumeStart: () => void;
}

export const useDjAutomix = create<DjAutomixState>()((set) => ({
  pendingStart: false,
  requestStart: () => set({ pendingStart: true }),
  consumeStart: () => set({ pendingStart: false }),
}));

/** The reserved set name reused for suggester sends, so repeated sends update
 *  one "Suggested mix" list in place instead of piling up new setlists. */
const SUGGESTED_SET_NAME = 'Suggested mix';

/**
 * Load an ordered track list as the active automix set, switch to the DJ tab,
 * and request an automix start. Reuses the "Suggested mix" setlist if it exists.
 * Returns the number of tracks staged (0 if none had a library id).
 */
export function sendToDjAutomix(tracks: Array<{ entryId: string; label: string }>): number {
  const usable = tracks.filter((t) => t.entryId);
  if (usable.length === 0) return 0;
  const entries: SetlistEntry[] = usable.map((t) => ({
    entryId: t.entryId,
    label: t.label,
    kind: 'audio',
  }));

  const sl = useSetlistStore.getState();
  const existing = Object.values(sl.setlists).find((s) => s.name === SUGGESTED_SET_NAME);
  const id = existing?.id ?? sl.create(SUGGESTED_SET_NAME);
  sl.setEntries(id, entries);
  sl.setActive(id);

  useAppUiStore.getState().setCenterTab('dj');
  useDjAutomix.getState().requestStart();
  return entries.length;
}
