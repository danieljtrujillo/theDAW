import { useEffect, useState, type SetStateAction } from 'react';
import type { ProviderTab } from '../../components/texture-gen/types';
import { readStoredOpenRouterKey } from './helpers';

export function useTextureProviderKeys(isOpen: boolean, activeTab: ProviderTab) {
  const [overrides, setOverrides] = useState<Partial<Record<ProviderTab, string>>>({});
  const apiKey = overrides[activeTab] || '';

  useEffect(() => {
    if (!isOpen) setOverrides({});
  }, [isOpen]);

  const setApiKey = (value: SetStateAction<string>) => {
    setOverrides((previous) => ({
      ...previous,
      [activeTab]: typeof value === 'function' ? value(previous[activeTab] || '') : value,
    }));
  };

  const resolveApiKey = () => apiKey.trim() || (activeTab === 'openrouter' ? readStoredOpenRouterKey() : '');
  return { apiKey, setApiKey, resolveApiKey };
}
