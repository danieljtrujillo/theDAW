import type { Express } from 'express';
import { isRecord } from './schema';

export interface ImageModel {
  id: string;
  label: string;
}

export async function fetchOpenRouterImageModels(): Promise<ImageModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=image', { signal: controller.signal });
    if (!response.ok) throw new Error(`OpenRouter models ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('Invalid OpenRouter model catalog');
    const models = new Map<string, ImageModel>();
    for (const entry of payload.data as unknown[]) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) continue;
      const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
      if (Array.isArray(architecture?.output_modalities) && !architecture.output_modalities.includes('image')) continue;
      models.set(entry.id, { id: entry.id, label: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id });
    }
    return [...models.values()];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('OpenRouter model catalog timed out after 10s');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function registerOpenRouterRoutes(app: Express): void {
  app.get('/api/textures/openrouter-image-models', async (_request, response) => {
    try {
      response.json({ models: await fetchOpenRouterImageModels() });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'Failed to fetch OpenRouter models' });
    }
  });
}
