import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TextureGenerateModal from '../../components/TextureGenerateModal';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes('openrouter-image-models')) return Response.json({ models: [{ id: 'test/image', label: 'Synthetic image' }] });
    return Response.json({ models: [], vaes: [], loras: [], samplers: [] });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('texture provider key isolation', () => {
  it('keeps overrides with their provider when switching cloud tabs', async () => {
    render(<TextureGenerateModal isOpen onClose={() => {}} onTexturesGenerated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^DALL-E$/ }));
    const keyInput = screen.getByPlaceholderText('Leave blank to use server-configured key');
    fireEvent.change(keyInput, { target: { value: 'synthetic-openai-key' } });
    fireEvent.click(screen.getByRole('button', { name: /^OpenRouter$/ }));
    expect((screen.getByPlaceholderText('Leave blank to use server-configured key') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByPlaceholderText('Leave blank to use server-configured key'), { target: { value: 'synthetic-router-key' } });
    fireEvent.click(screen.getByRole('button', { name: /^Gemini$/ }));
    expect((screen.getByPlaceholderText('Leave blank to use server-configured key') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^DALL-E$/ }));
    expect((screen.getByPlaceholderText('Leave blank to use server-configured key') as HTMLInputElement).value).toBe('synthetic-openai-key');
  });
});
