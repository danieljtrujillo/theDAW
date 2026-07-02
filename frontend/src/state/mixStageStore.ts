import { create } from 'zustand';

// The MIX Effect Stage selection state. It lives in a module-scope store rather
// than component state because DAWCenterPanel fully unmounts MixView on every
// tab switch; local useState would reset the three selectors and the stage
// would land on the EffectsVizPanel placeholder after a tab round-trip.
// The state is intentionally NOT persisted: the requirement is SPA-lifetime
// survival only, and chain entry ids from a previous app session would be
// meaningless against a freshly built chain.
// Chain removal (removeEffect / clearChain) is owned by effectChainStore, so
// selectedChainId can go stale after an entry is removed; MixView tolerates a
// stale id through its existing `?? chain[0]` fallback when deriving the
// selected entry, so no cross-store cleanup hook is needed here.
interface MixStageState {
  // The chain entry focused in the Effect Stage (a null or stale id falls back
  // to the first chain entry in MixView's derivation).
  selectedChainId: string | null;
  // The explicitly-picked Studio module shown in the stage; it outranks the
  // selected chain entry's effect-to-module mapping.
  activeModuleId: string | null;
  // The Magenta RT2 tool focused in the Effect Stage (Collider / Jam / MRT2).
  activeMagentaId: string | null;
  setSelectedChainId: (id: string | null) => void;
  setActiveModuleId: (id: string | null) => void;
  setActiveMagentaId: (id: string | null) => void;
}

export const useMixStageStore = create<MixStageState>()((set) => ({
  selectedChainId: null,
  activeModuleId: null,
  activeMagentaId: null,
  setSelectedChainId: (id) => set({ selectedChainId: id }),
  setActiveModuleId: (id) => set({ activeModuleId: id }),
  setActiveMagentaId: (id) => set({ activeMagentaId: id }),
}));
