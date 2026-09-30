/**
 * Track-menu rows that look a library row up BY ID have to ask the store for
 * it. `entries` is only the loaded rows of a result set that can be 200,000
 * long, so walking it makes the favourite check pass for a row it never saw and
 * degrades suggested titles to raw uuids.
 *
 * Real stores, real provider, fake `fetch`.
 */
import assert from 'node:assert/strict';
import { suggestFrom, toggleFavoriteChecked } from './trackMenuActions.ts';
import { useLibraryStore } from '../../state/libraryStore.ts';
import { useLibraryCounts } from '../../state/libraryCountsStore.ts';
import { LIBRARY_PAGE_SIZE } from '../../lib/backendLocalProvider.ts';
import type { LibraryEntry } from '../../state/libraryEntry.ts';

const st = () => useLibraryStore.getState();
const TOTAL = 1000;

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
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

/** id → starred, server-side. `honourWrites=false` makes the backend drop it. */
const starred = new Map<string, boolean>();
let honourWrites = true;
/** The ids the suggester answers with, in order. */
let suggested: Array<{ id: string; title?: string }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  if (url.startsWith('/api/library/summary')) {
    return jsonResponse({ revision: 1, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  if (url === '/api/library/suggest-playlist') return jsonResponse({ tracks: suggested });
  if (isEntriesList(url)) {
    const params = new URL(url, 'http://local').searchParams;
    const offset = Number(params.get('offset') ?? '0');
    const limit = Number(params.get('limit') ?? String(LIBRARY_PAGE_SIZE));
    const entries: Array<Record<string, unknown>> = [];
    for (let i = offset; i < Math.min(offset + limit, TOTAL); i += 1) {
      entries.push(rec(i, { favorite: starred.get(`e${i}`) ?? false }));
    }
    return jsonResponse({ entries, total: TOTAL, offset, limit, revision: 3 });
  }
  const single = /^\/api\/library\/entries\/([^/?]+)$/.exec(url);
  if (single) {
    const id = decodeURIComponent(single[1]);
    const i = Number(id.replace(/^e/, ''));
    if (!Number.isInteger(i) || i < 0 || i >= TOTAL) return jsonResponse({}, 404);
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (honourWrites && typeof patch.favorite === 'boolean') starred.set(id, patch.favorite);
      return jsonResponse(rec(i, { favorite: starred.get(id) ?? false }));
    }
    return jsonResponse(rec(i, { favorite: starred.get(id) ?? false }));
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

const reset = (): void => {
  starred.clear();
  honourWrites = true;
  suggested = [];
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sortBy: 'newest' });
  st().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

const seed = (i: number): LibraryEntry => {
  const entry = st().getById(`e${i}`);
  assert.ok(entry, `e${i} is loaded`);
  return entry;
};

// ───────────────────────────────────────────────────────────────────────────
// Suggested titles resolve for ids on no loaded page.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  suggested = [{ id: 'e0' }, { id: 'e600' }, { id: 'e700', title: 'Server Said So' }, { id: 'e5' }];

  const list = await suggestFrom(seed(0));

  assert.deepEqual(
    list.map((t) => t.id),
    ['e0', 'e600', 'e700', 'e5'],
    'the seed leads, and the suggester keeps its order (minus the seed repeat)',
  );
  assert.equal(list[0]?.title, 'Track 0', 'the seed shows its own title');
  assert.equal(list[1]?.title, 'Track 600', 'a row on no loaded page still gets a real title');
  assert.equal(list[2]?.title, 'Server Said So', 'a title the suggester supplied is kept as-is');
  assert.equal(list[3]?.title, 'Track 5', 'a loaded row keeps its title');
}

// ───────────────────────────────────────────────────────────────────────────
// An id the library no longer has falls back to the id, it does not throw.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  suggested = [{ id: 'gone-id' }];

  const list = await suggestFrom(seed(1));
  assert.deepEqual(list.map((t) => t.title), ['Track 1', 'gone-id']);
}

// ───────────────────────────────────────────────────────────────────────────
// The favourite check reads the store BY ID, for a row on no loaded page.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  assert.equal(st().entries.some((e) => e.id === 'e800'), false, 'e800 is on no loaded page');

  await toggleFavoriteChecked('e800', true);
  assert.equal(starred.get('e800'), true, 'the star landed');
  assert.equal(st().getById('e800')?.favorite, true, 'and the cached row agrees');
}

// ───────────────────────────────────────────────────────────────────────────
// A backend that drops the write is reported — even for an unloaded row,
// which used to slip through because `entries` had nothing to check.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await st().load();
  honourWrites = false;

  await assert.rejects(
    toggleFavoriteChecked('e900', true),
    /did not save/,
    'a dropped write on an unloaded row is reported, not silently passed',
  );
}

console.log('trackMenuActions.paged: ok');
