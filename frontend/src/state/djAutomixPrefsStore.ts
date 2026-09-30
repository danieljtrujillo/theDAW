import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';

/* DJ automix preferences, persisted.
 *
 * `preferHarmonic` is the "Harmonic order" toggle above the decks. On, the
 * automix sequencer may play a Camelot-compatible track ahead of a key clash
 * (every track it plays ahead of stays in the queue; see
 * `lib/djAutomixPlan.createAutomixQueue`). Off, the set plays strictly in its
 * order. A prepared performance set always plays as prepared either way. */

interface DjAutomixPrefsState {
  preferHarmonic: boolean;
  setPreferHarmonic: (on: boolean) => void;
}

export const useDjAutomixPrefs = create<DjAutomixPrefsState>()(
  persist(
    (set) => ({
      preferHarmonic: true,
      setPreferHarmonic: (preferHarmonic) => set({ preferHarmonic }),
    }),
    { name: 'thedaw.dj.automix.v1', storage: persistStorage() },
  ),
);
