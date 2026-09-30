import type { GenParams } from '../../sd';
import { isRecord } from './schema';

export async function generateViaOpenRouter(params: GenParams): Promise<string[]> {
  const apiKey = params.apiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim() || '';
  if (!apiKey) throw new Error('OpenRouter API key required');
  const model = params.model?.trim() || 'google/gemini-2.5-flash-image';
  const count = params.count ?? params.batchCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error('OpenRouter count must be an integer from 1 to 4');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prompt: params.prompt,
        n: count,
        ...(params.imageSize ? { size: params.imageSize } : {}),
      }),
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 405) {
      throw new Error(`OpenRouter images endpoint unavailable (${response.status}). Chat fallback cannot guarantee the requested count (${count}) and size (${params.imageSize || 'provider default'}); generation stopped.`);
    }
    if (!response.ok) {
      const detail = (await response.text()).split(apiKey).join('[redacted]').slice(0, 300);
      throw new Error(`OpenRouter ${response.status}: ${detail}`);
    }
    const payload: unknown = await response.json();
    const images = isRecord(payload) && Array.isArray(payload.data)
      ? payload.data.flatMap((entry: unknown) => isRecord(entry) && typeof entry.b64_json === 'string' && entry.b64_json.trim() ? [entry.b64_json] : [])
      : [];
    if (!images.length) throw new Error('OpenRouter returned no image data');
    if (images.length !== count) throw new Error(`OpenRouter returned ${images.length} of ${count} requested images; generation incomplete`);
    return images;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenRouter generation timed out after 5 minutes');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
