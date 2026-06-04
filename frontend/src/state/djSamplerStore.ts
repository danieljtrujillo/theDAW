import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ sampler bank (D7) — persisted pad → library-entry assignments. The decoded
 * one-shot buffers live in djEngine (re-decoded on mount from each entry's
 * audioUrl); this store only remembers which track sits on which pad so the
 * bank survives a reload. */

export interface SamplerPad {
  entryId: string;
  name: string;
}

interface DjSamplerState {
  pads: Record<number, SamplerPad>;
  setPad: (i: number, pad: SamplerPad) => void;
  clearPad: (i: number) => void;
}

export const useDjSampler = create<DjSamplerState>()(
  persist(
    (set) => ({
      pads: {},
      setPad: (i, pad) => set((s) => ({ pads: { ...s.pads, [i]: pad } })),
      clearPad: (i) => set((s) => {
        const p = { ...s.pads };
        delete p[i];
        return { pads: p };
      }),
    }),
    { name: 'thedaw.dj.sampler.v1' },
  ),
);
