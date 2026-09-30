/**
 * The bulk-delete client call and the store action over it.
 *
 * Deleting 200,000 entries one DELETE at a time is 200,000 requests; the
 * backend takes the whole job in one POST instead. The dangerous part is the
 * FILTER form — it names rows nobody has looked at — so the server re-counts
 * and refuses with 409 when its count is not the one the user was shown. This
 * suite pins that the client surfaces that refusal with the server's new count
 * (so the UI can re-ask rather than retry blindly), that a whole-library delete
 * cannot be sent without the explicit `all` flag, and that a backend without
 * the route says so instead of appearing to delete nothing.
 *
 * Run: `npx tsx src/lib/libraryBulkDelete.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { LibraryBulkConflictError, bulkDeleteLibraryEntries } from './backendLocalProvider.ts';
import { useLibraryStore } from '../state/libraryStore.ts';
import { useLibraryCounts } from '../state/libraryCountsStore.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);
const calls: { url: string; body: unknown }[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  return handler(url, init);
}) as typeof fetch;

const rec = (id: string) => ({
  id,
  title: id,
  prompt: '',
  negative_prompt: '',
  model: 'sa3',
  duration: 1,
  steps: 1,
  cfg: 1,
  seed: 1,
  audio_url: `/api/library/audio/${id}`,
  audio_filename: `${id}.wav`,
  file_size_bytes: 1,
  mime_type: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
});

const summary = (revision: number) =>
  jsonResponse({ revision, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

const reset = (): void => {
  calls.length = 0;
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sourceFilter: null, kindFilter: 'audio' });
  useLibraryStore.getState().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

// ── The id form ────────────────────────────────────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ deleted: 2, failed: [], total_matched: 2, revision: 11 });

  const result = await bulkDeleteLibraryEntries({ ids: ['a', 'b'] });
  assert.ok(result);
  assert.equal(result.deleted, 2);
  assert.equal(result.totalMatched, 2);
  assert.equal(result.revision, 11);
  assert.deepEqual(result.failed, []);
  assert.equal(calls[0].url, '/api/library/entries/bulk-delete');
  assert.deepEqual(calls[0].body, { ids: ['a', 'b'] }, 'the id form carries ids and nothing else');
}

// ── Per-id failures come back, they do not throw ───────────────────────────
{
  reset();
  handler = async () =>
    jsonResponse({
      deleted: 1,
      failed: [{ id: 'b', error: 'file is open' }],
      total_matched: 2,
      revision: 12,
    });
  const result = await bulkDeleteLibraryEntries({ ids: ['a', 'b'] });
  assert.deepEqual(result?.failed, [{ id: 'b', error: 'file is open' }]);
  assert.equal(result?.deleted, 1, 'one failure does not lose the successes');
}

// ── The filter form, and the server's refusal ──────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ detail: 'the library moved', total_matched: 12350 }, 409);

  await assert.rejects(
    () => bulkDeleteLibraryEntries({ filter: { favorite: false, kind: 'audio' }, confirmTotal: 12345 }),
    (e: unknown) => {
      assert.ok(e instanceof LibraryBulkConflictError, 'a 409 is its own error type');
      assert.equal(e.totalMatched, 12350, 'and carries the count to re-ask with');
      return true;
    },
  );
  assert.deepEqual(
    calls[0].body,
    { filter: { favorite: false, kind: 'audio' }, confirm_total: 12345 },
    'the filter goes over the wire in the server’s own spelling',
  );
}

// ── An empty filter needs the `all` flag ───────────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ deleted: 7, failed: [], total_matched: 7, revision: 13 });

  await assert.rejects(
    () => bulkDeleteLibraryEntries({ filter: {}, confirmTotal: 7 }),
    /all/i,
    'a filter that matches the whole library is refused before it is sent',
  );
  assert.equal(calls.length, 0, 'nothing reached the network');

  const result = await bulkDeleteLibraryEntries({ filter: {}, confirmTotal: 7, all: true });
  assert.equal(result?.deleted, 7);
  assert.deepEqual(calls[0].body, { filter: {}, confirm_total: 7, all: true });
}

// ── An empty id list is a no-op, not a whole-library delete ────────────────
{
  reset();
  handler = async () => jsonResponse({ deleted: 999, failed: [], total_matched: 999, revision: 14 });
  const result = await bulkDeleteLibraryEntries({ ids: [] });
  assert.deepEqual(result, { deleted: 0, failed: [], totalMatched: 0, revision: 0 });
  assert.equal(calls.length, 0, 'an empty selection never reaches the server');
}

// ── An old backend ─────────────────────────────────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ detail: 'Not Found' }, 404);
  const result = await bulkDeleteLibraryEntries({ ids: ['a'] });
  assert.equal(result, null, 'a missing route is null, so the caller can fall back');
}

// ── The store action drops the page cache and refreshes the counts ─────────
{
  reset();
  let revision = 9;
  let total = 400;
  let countsLoads = 0;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) {
      countsLoads += 1;
      return summary(revision);
    }
    if (url.startsWith('/api/library/entries/bulk-delete')) {
      revision = 10;
      total = 398;
      return jsonResponse({ deleted: 2, failed: [], total_matched: 2, revision });
    }
    if (isEntriesList(url)) {
      const params = new URL(url, 'http://local').searchParams;
      const offset = Number(params.get('offset') ?? '0');
      const limit = Number(params.get('limit') ?? '200');
      const entries = [];
      for (let i = offset; i < Math.min(offset + limit, total); i += 1) entries.push(rec(`e${i}`));
      return jsonResponse({ entries, total, offset, limit, revision });
    }
    return jsonResponse({}, 404);
  };

  await useLibraryStore.getState().load();
  assert.equal(useLibraryStore.getState().total, 400);
  const countsBefore = countsLoads;

  const result = await useLibraryStore.getState().bulkDelete({ ids: ['e0', 'e1'] });
  assert.equal(result?.deleted, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(useLibraryStore.getState().total, 398, 'the visible range was re-read against the new library');
  assert.ok(countsLoads > countsBefore, 'and the category counts were asked for again');
}

// ── The store action tells the caller when the backend has no route ────────
{
  reset();
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(9);
    if (url.startsWith('/api/library/entries/bulk-delete')) return jsonResponse({ detail: 'nope' }, 404);
    if (isEntriesList(url)) return jsonResponse({ entries: [rec('e0')], total: 1, offset: 0, limit: 200, revision: 9 });
    return jsonResponse({}, 404);
  };
  await useLibraryStore.getState().load();
  assert.equal(await useLibraryStore.getState().bulkDelete({ ids: ['e0'] }), null);
  assert.equal(useLibraryStore.getState().bulkDeleteSupported, false, 'and remembers, so the UI keeps its old labels');
}

console.log('libraryBulkDelete: ok');
