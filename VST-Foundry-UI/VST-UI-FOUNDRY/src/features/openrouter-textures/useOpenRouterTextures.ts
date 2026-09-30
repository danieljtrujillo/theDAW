import { useEffect, useState } from 'react';
import { parseImageModels, selectImageModel } from './helpers';
import type { ImageModel, OpenRouterTextureControls } from './types';

export function useOpenRouterTextures(isOpen: boolean, active: boolean): OpenRouterTextureControls {
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ImageModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) return;
    setModel('');
    setModels([]);
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !active || models.length) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await fetch('/api/textures/openrouter-image-models', { signal: controller.signal });
        if (!response.ok) throw new Error(`OpenRouter image model catalog failed (${response.status}).`);
        const payload: unknown = await response.json();
        if (controller.signal.aborted) return;
        const list = parseImageModels(payload);
        setModels(list);
        setError(list.length ? null : 'No image models returned by OpenRouter.');
        setModel((previous) => selectImageModel(list, previous));
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Failed to fetch OpenRouter image models.');
      }
    })();
    return () => controller.abort();
  }, [isOpen, active, models.length]);

  return { model, setModel, models, error };
}
