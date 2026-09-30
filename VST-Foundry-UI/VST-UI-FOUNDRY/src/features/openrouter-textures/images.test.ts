// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateViaOpenRouter } from '../../../server/sd';

vi.mock('../../../server/paths', () => ({ TEXTURES_DIR: 'synthetic-unused' }));
vi.mock('../../../server/logging', () => ({ appendLog: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const params = { provider: 'openrouter', prompt: 'synthetic texture', model: 'test/image', apiKey: 'synthetic-override' };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-server');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe('OpenRouter texture generation', () => {
  it('preserves model, count and dimensions on a successful cloud request', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'Zmlyc3Q=' }, { b64_json: 'c2Vjb25k' }] }));
    await expect(generateViaOpenRouter({ ...params, count: 2, imageSize: '2048x1024' })).resolves.toEqual(['Zmlyc3Q=', 'c2Vjb25k']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'test/image', prompt: params.prompt, n: 2, size: '2048x1024' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-override');
  });

  it.each([404, 405])('rejects an unavailable images endpoint (%s) without losing count or size in a second request', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status }));
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,b25l' } }] } }] }));
    await expect(generateViaOpenRouter({ ...params, count: 3, imageSize: '2048x2048' })).rejects.toThrow(/fallback.*count.*size/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a count above the supported UI range instead of silently clamping it', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'b25l' }] }));
    await expect(generateViaOpenRouter({ ...params, count: 7 })).rejects.toThrow(/count/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 11])('rejects invalid count %s before contacting the provider', async (count) => {
    await expect(generateViaOpenRouter({ ...params, count })).rejects.toThrow(/count/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the matching server key when the override is whitespace', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'b25l' }] }));
    await generateViaOpenRouter({ ...params, apiKey: '  ' });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-server');
  });

  it('surfaces upstream errors without retrying or exposing the key', async () => {
    fetchMock.mockResolvedValue(new Response('invalid synthetic-override', { status: 401 }));
    const error = await generateViaOpenRouter(params).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('OpenRouter 401: invalid [redacted]');
    expect((error as Error).message).not.toContain(params.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete successful responses with the actual and requested counts', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'b25l' }] }));
    await expect(generateViaOpenRouter({ ...params, count: 3 })).rejects.toThrow(/returned 1 of 3 requested images/i);
  });

  it('rejects empty image output', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    await expect(generateViaOpenRouter(params)).rejects.toThrow(/no image data/i);
  });
});
