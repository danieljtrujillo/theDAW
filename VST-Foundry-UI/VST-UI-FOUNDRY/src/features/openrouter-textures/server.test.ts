// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExtractRoutes } from '../../../server/extract';
import { registerOpenRouterRoutes } from '../../../server/features/openrouter/catalog';
import { toJsonSchema } from '../../../server/features/openrouter/schema';

vi.mock('../../../server/logging', () => ({ appendLog: vi.fn() }));
vi.mock('../../../server/providers', () => ({
  getApiKey: (provider: string, override?: string) => override || (provider === 'gemini' ? 'synthetic-google-key' : 'synthetic-router-key'),
}));

const fetchMock = vi.fn<typeof fetch>();
const app = express();
app.use(express.json());
registerExtractRoutes(app);
registerOpenRouterRoutes(app);
const extractionBody = { image: 'data:image/png;base64,c3ludGhldGlj', mimeType: 'image/png', model: 'test/vision', sensitivity: 0.9 };
const bounds = { label: 'Frame', type: 'panel', xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('extraction provider adapters', () => {
  it.each([
    ['/api/extract/detect', [bounds], { elements: [bounds] }],
    ['/api/extract/detect-panels', [{ title: 'Panel', ...bounds }], { panels: [{ title: 'Panel', ...bounds }] }],
    ['/api/extract/label', { label: 'Frame', polygon: [[0, 0], [1, 1]] }, { label: 'Frame', polygon: [[0, 0], [1, 1]] }],
  ])('keeps the %s contract for OpenRouter image extraction', async (route, payload, expected) => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } }] }));
    const response = await request(app).post(route as string).send({ ...extractionBody, provider: 'openrouter' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expected);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-router-key');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test/vision');
    expect(body.messages[0].content[0].image_url.url).toBe(extractionBody.image);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.type).toBe(route === '/api/extract/label' ? 'object' : 'array');
  });

  it('preserves direct Gemini defaults, image normalization and uppercase schemas', async () => {
    fetchMock.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify([bounds]) }] } }] }));
    const response = await request(app).post('/api/extract/detect').send({ ...extractionBody, model: 'models/test-model' });
    expect(response.body).toEqual({ elements: [bounds] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('synthetic-google-key');
    const body = JSON.parse(String(init?.body));
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: 'c3ludGhldGlj' });
    expect(body.generationConfig.responseSchema.type).toBe('ARRAY');
    expect(body.contents[0].parts[1].text).toContain('frames');
    expect(body.contents[0].parts[1].text).toContain('extremely aggressive');
  });

  it('rejects unknown providers before a key can be sent to Gemini', async () => {
    const response = await request(app).post('/api/extract/detect').send({ ...extractionBody, provider: 'misspelled-router', apiKey: 'synthetic-override' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/unsupported extraction provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses an explicit OpenRouter key and redacts it from upstream errors', async () => {
    fetchMock.mockResolvedValue(new Response('invalid synthetic-override', { status: 401 }));
    const response = await request(app).post('/api/extract/detect').send({ ...extractionBody, provider: 'openrouter', apiKey: ' synthetic-override ' });
    expect(response.status).toBe(502);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-override');
    expect(response.body.error).toBe('OpenRouter 401: invalid [redacted]');
  });

  it('does not lowercase a property named type or mutate Gemini schemas', () => {
    const schema = { type: 'OBJECT', properties: { type: { type: 'STRING' }, polygon: { type: 'ARRAY', items: { type: 'NUMBER' } } } };
    expect(toJsonSchema(schema)).toEqual({ type: 'object', properties: { type: { type: 'string' }, polygon: { type: 'array', items: { type: 'number' } } } });
    expect(schema.properties.type.type).toBe('STRING');
  });

  it('surfaces malformed structured output as an extraction error', async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: 'no JSON available' } }] }));
    const response = await request(app).post('/api/extract/detect').send({ ...extractionBody, provider: 'openrouter' });
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/not valid JSON/i);
  });
});

describe('image model catalog', () => {
  it('keeps the public catalog contract without forwarding credentials', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [
      { id: 'test/image', name: 'Image', architecture: { output_modalities: ['image'] } },
      { id: 'test/text', architecture: { output_modalities: ['text'] } },
      { id: 'test/fallback' },
      { id: 5 },
      { id: 'test/image', name: 'Image' },
    ] }));
    const response = await request(app).get('/api/textures/openrouter-image-models').set('Authorization', 'Bearer synthetic-client-key');
    expect(response.status).toBe(200);
    expect(response.body.models).toEqual([{ id: 'test/image', label: 'Image' }, { id: 'test/fallback', label: 'test/fallback' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=image');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });

  it.each([Response.json({ wrong: [] }), new Response('unavailable', { status: 503 })])('surfaces catalog failures through HTTP 502', async (payload) => {
    fetchMock.mockResolvedValue(payload);
    const response = await request(app).get('/api/textures/openrouter-image-models');
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/catalog|models/i);
  });
});
