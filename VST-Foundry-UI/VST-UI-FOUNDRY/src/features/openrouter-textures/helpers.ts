import { LS_PROVIDER_KEYS } from '../../components/orb/constants';
import type { TextureGenParams } from '../../types';
import type { ImageModel } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readStoredOpenRouterKey(): string {
  try {
    const raw = localStorage.getItem(LS_PROVIDER_KEYS);
    const keys: unknown = raw ? JSON.parse(raw) : undefined;
    return isRecord(keys) && typeof keys.openrouter === 'string' ? keys.openrouter.trim() : '';
  } catch {
    return '';
  }
}

export function parseImageModels(payload: unknown): ImageModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error('Invalid OpenRouter image model catalog.');
  return payload.models.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return [];
    return [{ id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.id }];
  });
}

export function selectImageModel(models: ImageModel[], previous: string): string {
  if (models.some((model) => model.id === previous)) return previous;
  return models.find((model) => /^google\/gemini.*-image(?:-preview)?$/.test(model.id))?.id
    || models.find((model) => model.id.startsWith('google/'))?.id
    || models[0]?.id || '';
}

export function withOpenRouterModel(params: TextureGenParams, model?: string): TextureGenParams {
  return params.provider === 'openrouter' && model?.trim() ? { ...params, model: model.trim() } : params;
}
