import { useEffect } from 'react';
import { useEffectChainStore } from '../../state/effectChainStore';
import { registerPowerModeBridge } from './bridge';

export function usePowerModeBridge(): void {
  useEffect(() => registerPowerModeBridge({
    findEntry: () => useEffectChainStore.getState().chain.find(entry => entry.effect === 'ares') ?? null,
    updateParams: (entryId, params) => useEffectChainStore.getState().updateParams(entryId, params),
  }), []);
}
