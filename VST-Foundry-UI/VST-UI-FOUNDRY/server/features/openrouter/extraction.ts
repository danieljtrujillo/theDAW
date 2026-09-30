import { isRecord, parseJsonLoose, toJsonSchema } from './schema';

export type ExtractProvider = 'gemini' | 'openrouter';

interface ExtractInput {
  model: string;
  apiKey: string;
  base64Image: string;
  mimeType: string;
}

interface GenerateJsonArgs extends ExtractInput {
  prompt: string;
  responseSchema: unknown;
}

export function resolveExtractionSettings(
  input: { provider?: unknown; model?: unknown; apiKey?: unknown },
  getApiKey: (provider: string, requestKey?: string) => string,
): { provider: ExtractProvider; model: string; apiKey: string } {
  const provider = input.provider ?? 'gemini';
  if (provider !== 'gemini' && provider !== 'openrouter') throw new Error('Unsupported extraction provider');
  const model = typeof input.model === 'string' ? input.model.trim().replace(/^models\//, '') : '';
  if (!model) throw new Error('model required');
  const apiKey = getApiKey(provider, typeof input.apiKey === 'string' ? input.apiKey.trim() || undefined : undefined);
  if (!apiKey) throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'Gemini'} API key required — set one in assistant settings`);
  return { provider, model, apiKey };
}

export function generateExtractJson(
  input: ExtractInput & { provider: ExtractProvider },
  prompt: string,
  responseSchema: unknown,
  geminiGenerateJson: (args: GenerateJsonArgs) => Promise<unknown>,
): Promise<unknown> {
  const args = { model: input.model, apiKey: input.apiKey, base64Image: input.base64Image, mimeType: input.mimeType, prompt, responseSchema };
  return input.provider === 'openrouter' ? openrouterGenerateJson(args) : geminiGenerateJson(args);
}

export async function openrouterGenerateJson(args: GenerateJsonArgs): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({
        model: args.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${args.mimeType};base64,${args.base64Image}` } },
            { type: 'text', text: args.prompt },
          ],
        }],
        response_format: { type: 'json_schema', json_schema: { name: 'extraction', schema: toJsonSchema(args.responseSchema) } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).split(args.apiKey).join('[redacted]').slice(0, 300);
      throw new Error(`OpenRouter ${response.status}: ${detail}`);
    }
    const payload: unknown = await response.json();
    const choice: unknown = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const content = message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty response from OpenRouter');
    return parseJsonLoose(content);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('OpenRouter request timed out after 120s');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
