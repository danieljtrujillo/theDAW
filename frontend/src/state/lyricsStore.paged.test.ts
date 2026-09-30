/**
 * Saving lyrics also refreshes the library row that carries them. That patch
 * has to go through the library store's own `upsertEntry`, because `entries` is
 * a PROJECTION of the page cache: a raw `setState({entries})` is thrown away by
 * the next re-projection (a page load, a filter change, a refresh), and it
 * cannot reach a row that is on no loaded page at all.
 *
 * Real stores, real provider, fake `fetch`.
 */
import assert from 'node:assert/strict';
import { useLyricsStore } from './lyricsStore.ts';
import { useLibraryStore } from './libraryStore.ts';
import { useLibraryCounts } from './libraryCountsStore.ts';
import { LIBRARY_PAGE_SIZE } from '../lib/backendLocalProvider.ts';

const st = () => useLibraryStore.getState();

const rec = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `e${i}`,
  title: `Track ${i}`,
  prompt: '',
  negative_prompt: '',
  model: 'sa3',
  duration: 10,
  steps: 8,
  cfg: 1,
  seed: i,
  audio_url: `/api/library/audio/e${i}`,
  audio_filename: `${i}.wav`,
  file_size_bytes: 1024,
  mime_type: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
  lyrics: '',
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

const TOTAL = 1000;

const doc = (entryId: string, text: string): Record<string, unknown> => ({
  version: 1,
  entry_id: entryId,
  timing_unit: 'ms',
  language: 'en',
  source: 'manual',
  text,
  offset_ms: 0,
  lines: [],
  stats: null,
  updated_at: 0,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  if (url.startsWith('/api/library/summary')) {
    return jsonResponse({ revision: 1, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  if (isEntriesList(url)) {
    const params = new URL(url, 'http://local').searchParams;
    const offset = Number(params.get('offset') ?? '0');
    const limit = Number(params.get('limit') ?? String(LIBRARY_PAGE_SIZE));
    const entries: Array<Record<string, unknown>> = [];
    for (let i = offset; i < Math.min(offset + limit, TOTAL); i += 1) entries.push(rec(i));
    return jsonResponse({ entries, total: TOTAL, offset, limit, revision: 3 });
  }
  const single = /^\/api\/library\/entries\/([^/?]+)$/.exec(url);
  if (single) {
    const i = Number(decodeURIComponent(single[1]).replace(/^e/, ''));
    if (!Number.isInteger(i) || i < 0 || i >= TOTAL) return jsonResponse({}, 404);
    return jsonResponse(rec(i));
  }
  const lyrics = /^\/api\/lyrics\/([^/?]+)$/.exec(url);
  if (lyrics && init?.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { text?: string };
    return jsonResponse(doc(decodeURIComponent(lyrics[1]), body.text ?? ''));
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

const reset = (): void => {
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sortBy: 'newest' });
  st().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

// ───────────────────────────────────────────────────────────────────────────
// A loaded row's lyrics survive the next page re-projection.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  assert.equal(st().entries.length, LIBRARY_PAGE_SIZE, 'only page 0 is loaded');

  useLyricsStore.setState({ entryId: 'e5', doc: null, dirty: false });
  await useLyricsStore.getState().setText('hello world');

  assert.equal(st().getById('e5')?.lyrics, 'hello world', 'the row carries the new words');

  // Loading another page re-projects `entries` from the page cache. A patch
  // that only wrote `entries` is gone at this point.
  await st().ensureRange(400, 410);
  assert.equal(
    st().entries.find((e) => e.id === 'e5')?.lyrics,
    'hello world',
    'and still carries them after a re-projection',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// A row on no loaded page gets the words too.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  assert.equal(
    st().entries.some((e) => e.id === 'e700'),
    false,
    'e700 is on no loaded page',
  );

  useLyricsStore.setState({ entryId: 'e700', doc: null, dirty: false });
  await useLyricsStore.getState().setText('far away words');
  // The row has to be fetched before it can be patched.
  await st().ensureEntry('e700');

  assert.equal(
    st().getById('e700')?.lyrics,
    'far away words',
    'the evicted row carries the new words',
  );
}

console.log('lyricsStore.paged: ok');
