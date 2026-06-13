import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ sampler bank (D7) — persisted pad → library-entry assignments. The decoded
 * one-shot buffers live in djEngine (re-decoded on mount from each entry's
 * audioUrl); this store only remembers which track sits on which pad so the
 * bank survives a reload. */

export interface SamplerPad {
  entryId: string;
  name: string;
  /** Per-pad playback gain (0..1). Defaults to 1 when absent. */
  gain?: number;
  /** Loop the sample (re-press to stop) instead of one-shot. */
  loop?: boolean;
  /** Choke group member: firing this pad cuts the other choke pads. */
  choke?: boolean;
}

interface DjSamplerState {
  pads: Record<number, SamplerPad>;
  setPad: (i: number, pad: SamplerPad) => void;
  setPadOpts: (i: number, opts: Partial<Pick<SamplerPad, 'gain' | 'loop' | 'choke'>>) => void;
  clearPad: (i: number) => void;
}

export const useDjSampler = create<DjSamplerState>()(
  persist(
    (set) => ({
      pads: {},
      setPad: (i, pad) => set((s) => ({ pads: { ...s.pads, [i]: pad } })),
      setPadOpts: (i, opts) => set((s) => {
        const pad = s.pads[i];
        if (!pad) return s;
        return { pads: { ...s.pads, [i]: { ...pad, ...opts } } };
      }),
      clearPad: (i) => set((s) => {
        const p = { ...s.pads };
        delete p[i];
        return { pads: p };
      }),
    }),
    { name: 'thedaw.dj.sampler.v1' },
  ),
);
