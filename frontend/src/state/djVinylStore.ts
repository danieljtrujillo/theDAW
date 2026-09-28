import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';

/* DJ scratch character (vinyl mode), persisted. 'classic' = a clean
 * turntable resample; 'cyber' = fragmented, bit-crushed glitch. Shared by both
 * decks; the engine pushes it live to any active scratch worklet. */

export type ScratchMode = 'classic' | 'cyber';

interface DjVinylState {
  mode: ScratchMode;
  setMode: (m: ScratchMode) => void;
  toggle: () => void;
}

export const useDjVinyl = create<DjVinylState>()(
  persist(
    (set) => ({
      mode: 'classic',
      setMode: (mode) => set({ mode }),
      toggle: () => set((s) => ({ mode: s.mode === 'classic' ? 'cyber' : 'classic' })),
    }),
    { name: 'thedaw.dj.vinyl.v1', storage: persistStorage() },
  ),
);
