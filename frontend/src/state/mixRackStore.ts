/**
 * mixRackStore — the MIX tab's own chain of real-time psychoacoustic rack effects
 * (the same engine EDIT uses, rackEffects.ts). Kept separate from EDIT's
 * masterFxChain and from MIX's backend effect chain (effectChainStore): this is a
 * Web-Audio rack the user applies to the single MIX source, baked offline into the
 * MIX output. In-memory zustand so it survives MIX tab remounts.
 */

import { create } from 'zustand';
import type { ChainEntry } from './effectChainStore';
import { rackEffectDefaults } from '../lib/rackEffects';

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `mixfx-${Math.random().toString(36).slice(2)}`;

interface MixRackState {
  chain: ChainEntry[];
  add: (effectId: string) => void;
  remove: (id: string) => void;
  reorder: (from: number, to: number) => void;
  toggle: (id: string) => void;
  updateParams: (id: string, params: Record<string, number>) => void;
  clear: () => void;
}

export const useMixRackStore = create<MixRackState>((set) => ({
  chain: [],
  add: (effectId) =>
    set((s) => ({ chain: [...s.chain, { id: uid(), effect: effectId, enabled: true, params: { ...rackEffectDefaults(effectId) } }] })),
  remove: (id) => set((s) => ({ chain: s.chain.filter((e) => e.id !== id) })),
  reorder: (from, to) =>
    set((s) => {
      const c = [...s.chain];
      if (from < 0 || from >= c.length || to < 0 || to >= c.length) return { chain: c };
      const [moved] = c.splice(from, 1);
      c.splice(to, 0, moved);
      return { chain: c };
    }),
  toggle: (id) => set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
  updateParams: (id, params) => set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, params } : e)) })),
  clear: () => set({ chain: [] }),
}));
