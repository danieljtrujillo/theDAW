/**
 * Store actions that take an ENTRY ID must work when that row sits on a page
 * nobody has loaded. `entries` is only the loaded rows of a result set that can
 * be 200,000 long, so an id lookup that walks `entries` silently misses; the
 * id-aware path is `getById(id)` then `ensureEntry(id)`.
 *
 * Real store, real provider, fake `fetch`.
 */
import assert from 'node:assert/strict';
import { useLibraryStore } from './libraryStore.ts';
import { useLibraryCounts } from './libraryCountsStore.ts';
import { LIBRARY_PAGE_SIZE } from '../lib/backendLocalProvider.ts';

const st = () => useLibraryStore.getState();

interface ServerRecordish {
  id: string;
  title: string;
  favorite: boolean;
  [key: string]: unknown;
}

const rec = (i: number, over: Record<string, unknown> = {}): ServerRecordish => ({
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

const summary = (revision: number) =>
  jsonResponse({ revision, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });

const pageFor = (url: string, total: number, revision: number): Response => {
  const params = new URL(url, 'http://local').searchParams;
  const offset = Number(params.get('offset') ?? '0');
  const limit = Number(params.get('limit') ?? String(LIBRARY_PAGE_SIZE));
  const entries: ServerRecordish[] = [];
  for (let i = offset; i < Math.min(offset + limit, total); i += 1) entries.push(rec(i));
  return jsonResponse({ entries, total, offset, limit, revision });
};

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

/** id → whether the server has it starred. The PATCH route writes here. */
const starred = new Map<string, boolean>();
const calls: string[] = [];

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  return handler(url, init);
}) as typeof fetch;

const reset = (): void => {
  calls.length = 0;
  starred.clear();
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sortBy: 'newest' });
  st().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

/** A paged backend of 1000 rows that also answers single-entry GET and PATCH. */
const pagedBackend: Handler = async (url, init) => {
  if (url.startsWith('/api/library/summary')) return summary(1);
  if (isEntriesList(url)) return pageFor(url, 1000, 3);
  const single = /^\/api\/library\/entries\/([^/?]+)$/.exec(url);
  if (single) {
    const id = decodeURIComponent(single[1]);
    const i = Number(id.replace(/^e/, ''));
    if (!Number.isInteger(i) || i < 0 || i >= 1000) return jsonResponse({}, 404);
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (typeof patch.favorite === 'boolean') starred.set(id, patch.favorite);
      return jsonResponse(rec(i, { favorite: starred.get(id) ?? false }));
    }
    return jsonResponse(rec(i, { favorite: starred.get(id) ?? false }));
  }
  return jsonResponse({}, 404);
};

// ───────────────────────────────────────────────────────────────────────────
// toggleFavorite on a row that is on no loaded page.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = pagedBackend;
  await st().load();

  assert.equal(st().paged, true, 'the backend pages');
  assert.equal(st().entries.length, LIBRARY_PAGE_SIZE, 'only page 0 is loaded');
  assert.equal(
    st().entries.some((e) => e.id === 'e500'),
    false,
    'e500 is on an evicted/unloaded page, so `entries` cannot answer for it',
  );

  await st().toggleFavorite('e500');

  assert.equal(starred.get('e500'), true, 'the star reached the backend on the FIRST click');
  assert.equal(st().getById('e500')?.favorite, true, 'and the cached row shows it');

  // Clicking it again unstars it — the cached row, not `entries`, is the truth.
  await st().toggleFavorite('e500');
  assert.equal(starred.get('e500'), false, 'a second click unstars it');
  assert.equal(st().getById('e500')?.favorite, false);
}

// ───────────────────────────────────────────────────────────────────────────
// A loaded row still takes the cheap path: no single-entry GET for it.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = pagedBackend;
  await st().load();

  calls.length = 0;
  await st().toggleFavorite('e3');
  assert.equal(starred.get('e3'), true, 'a loaded row stars too');
  assert.equal(
    calls.some((c) => c.startsWith('GET /api/library/entries/e3')),
    false,
    'a row already in hand is not fetched again',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// An id the server does not have resolves to nothing and writes nothing.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = pagedBackend;
  await st().load();

  await st().toggleFavorite('e99999');
  assert.equal(
    calls.some((c) => c.startsWith('PATCH /api/library/entries/e99999')),
    false,
    'an unknown id never issues a write',
  );
}

console.log('libraryStore.paged: ok');
