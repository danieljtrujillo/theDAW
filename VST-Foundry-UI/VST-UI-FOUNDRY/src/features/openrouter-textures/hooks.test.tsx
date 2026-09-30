import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LS_PROVIDER_KEYS } from '../../components/orb/constants';
import { buildParams, type BuildParamsArgs } from '../../components/texture-gen/buildParams';
import { useTextureProviderKeys } from './useTextureProviderKeys';
import { useOpenRouterTextures } from './useOpenRouterTextures';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider key selection', () => {
  it('resolves override, current stored OpenRouter key, then server fallback', () => {
    localStorage.setItem(LS_PROVIDER_KEYS, JSON.stringify({ openrouter: 'synthetic-stored', gemini: 'synthetic-google' }));
    const { result } = renderHook(() => useTextureProviderKeys(true, 'openrouter'));
    expect(result.current.resolveApiKey()).toBe('synthetic-stored');
    act(() => result.current.setApiKey(' synthetic-override '));
    expect(result.current.resolveApiKey()).toBe('synthetic-override');
    act(() => result.current.setApiKey(''));
    localStorage.setItem(LS_PROVIDER_KEYS, JSON.stringify({ openrouter: 'synthetic-updated' }));
    expect(result.current.resolveApiKey()).toBe('synthetic-updated');
    localStorage.removeItem(LS_PROVIDER_KEYS);
    expect(result.current.resolveApiKey()).toBe('');
  });

  it('tolerates blocked storage and never reuses another stored provider key', () => {
    localStorage.setItem(LS_PROVIDER_KEYS, JSON.stringify({ gemini: 'synthetic-google' }));
    const { result } = renderHook(() => useTextureProviderKeys(true, 'openrouter'));
    expect(result.current.resolveApiKey()).toBe('');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(result.current.resolveApiKey()).toBe('');
  });

  it('clears every manual override on close', () => {
    const { result, rerender } = renderHook(({ open }) => useTextureProviderKeys(open, 'openrouter'), { initialProps: { open: true } });
    act(() => result.current.setApiKey('synthetic-private'));
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.apiKey).toBe('');
  });
});

describe('image catalog lifecycle', () => {
  it('discards an old session response even when the request double ignores abort', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ open }) => useOpenRouterTextures(open, true), { initialProps: { open: true } });
    rerender({ open: false });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    rerender({ open: true });
    await act(async () => { resolveSecond(Response.json({ models: [{ id: 'test/new', label: 'New' }] })); });
    await act(async () => { resolveFirst(Response.json({ models: [{ id: 'test/old', label: 'Old' }] })); });
    expect(result.current.model).toBe('test/new');
    expect(result.current.models).toEqual([{ id: 'test/new', label: 'New' }]);
  });

  it('prefers a catalog Gemini image model and preserves manual selection across tabs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [
      { id: 'test/image', label: 'Other image' },
      { id: 'google/gemini-synthetic-image-preview', label: 'Synthetic Gemini image' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ active }) => useOpenRouterTextures(true, active), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.model).toBe('google/gemini-synthetic-image-preview'));
    act(() => result.current.setModel('test/image'));
    rerender({ active: false });
    rerender({ active: true });
    expect(result.current.model).toBe('test/image');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a catalog error and retries on the next activation', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ models: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ active }) => useOpenRouterTextures(true, active), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.error).toContain('502'));
    rerender({ active: false });
    rerender({ active: true });
    await waitFor(() => expect(result.current.error).toBe('No image models returned by OpenRouter.'));
  });
});

describe('texture request builder', () => {
  const args: BuildParamsArgs = {
    provider: 'openrouter', prompt: ' synthetic ', isSdTab: false, sdType: 'a1111', negativePrompt: '', width: 512,
    height: 512, steps: 25, cfgScale: 7, sampler: '', seed: -1, batchCount: 1, nIter: 1, model: 'sd/checkpoint',
    vae: '', loras: [], imageSize: '1024x1024', count: 3, activeTab: 'openrouter', quality: 'hd', style: 'vivid',
    apiKey: ' synthetic-key ', orModel: 'test/image',
  };

  it('adds only OpenRouter options to the cloud request', () => {
    expect(buildParams(args)).toEqual({ provider: 'openrouter', prompt: 'synthetic', imageSize: '1024x1024', count: 3, apiKey: 'synthetic-key', model: 'test/image' });
  });

  it('keeps the OpenRouter model out of Gemini and DALL-E requests', () => {
    expect(buildParams({ ...args, provider: 'gemini', activeTab: 'gemini' }).model).toBeUndefined();
    expect(buildParams({ ...args, provider: 'openai', activeTab: 'dalle' })).toMatchObject({ provider: 'openai', quality: 'hd', style: 'vivid' });
    expect(buildParams({ ...args, provider: 'openai', activeTab: 'dalle' }).model).toBeUndefined();
  });
});
