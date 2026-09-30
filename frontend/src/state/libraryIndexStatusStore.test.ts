/**
 * The LIBRARY list while the backend opens the library, replayed in the order
 * a real start produces it:
 *
 *   1. the list is asked for while the schema upgrade runs: 503 with
 *      `library_status` — the store records "opening", not an error;
 *   2. that starts the status poll, which reports the upgrade, then the
 *      search index build with the store open — the refused list is fetched
 *      again by itself and answers;
 *   3. a search during the build answers with `search_index.complete: false`;
 *   4. the poll reports `ready` — the list is fetched again, without anyone
 *      pressing Retry, and the counts store is asked for the new revision.
 *
 * Before the fix a 503 was a page error with a Retry button, nothing polled,
 * and a list refused during the upgrade stayed empty until the user retried.
 *
 * Real stores, real provider, fake `fetch`. Real timers: the poll interval is
 * 1 s, so this suite takes a few seconds.
 *
 *   cd frontend && npx tsx src/state/libraryIndexStatusStore.test.ts
 */
import assert from 'node:assert/strict';
import { useLibraryStore } from './libraryStore.ts';
import { useLibraryIndexStatus, INDEX_STATUS_POLL_MS } from './libraryIndexStatusStore.ts';
import { LIBRARY_PAGE_SIZE } from '../lib/backendLocalProvider.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rec = (i: number) => ({
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
});

const status = (phase: string, done: number, total: number, etaSec: number | null = null) => ({
  phase,
  label: phase === 'upgrade' ? 'Upgrading the library database' : phase === 'index' ? 'Building the search index' : 'Ready',
  done,
  total,
  items: 0,
  eta_sec: etaSec,
  opened: phase !== 'upgrade',
  error: null,
});

/** What the backend is doing; the test moves it forward. */
let phase: 'upgrade' | 'index' | 'ready' = 'upgrade';
const calls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  if (url.startsWith('/api/library/index-status')) {
    if (phase === 'upgrade') return jsonResponse(status('upgrade', 12, 30, 8));
    if (phase === 'index') return jsonResponse(status('index', 40_000, 200_000, 90));
    return jsonResponse(status('ready', 0, 0));
  }
  if (url.startsWith('/api/library/summary')) {
    if (phase === 'upgrade') {
      return jsonResponse({ detail: 'Upgrading', library_status: status('upgrade', 12, 30, 8) }, 503);
    }
    return jsonResponse({ revision: phase === 'ready' ? 8 : 7, counts: { tracks: 3, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  if (url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/')) {
    if (phase === 'upgrade') {
      return jsonResponse(
        { detail: 'Upgrading the library database; the library answers when it finishes', library_status: status('upgrade', 12, 30, 8) },
        503,
      );
    }
    const params = new URL(url, 'http://local').searchParams;
    const searched = params.has('q');
    const total = searched && phase === 'index' ? 1 : 3;
    const entries = Array.from({ length: total }, (_, i) => rec(i));
    return jsonResponse({
      entries,
      total,
      offset: 0,
      limit: LIBRARY_PAGE_SIZE,
      revision: phase === 'ready' ? 8 : 7,
      ...(searched
        ? {
            search_index:
              phase === 'index'
                ? { complete: false, indexed: 40_000, total: 200_000, eta_sec: 90 }
                : { complete: true },
          }
        : {}),
    });
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, test: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

// 1. The list during the upgrade: "opening", not an error.
await useLibraryStore.getState().load();
{
  const s = useLibraryStore.getState();
  assert.equal(s.libraryOpening, true, 'a 503 with library_status marks the library as opening');
  assert.equal(s.pageError, null, 'and is not shown as a page error');
  assert.equal(s.total, 0);
}

// 2. That started the poll, which reports the upgrade.
await until('the poll reports the upgrade', () => useLibraryIndexStatus.getState().status?.phase === 'upgrade');
assert.equal(useLibraryIndexStatus.getState().watching, true, 'still polling while the upgrade runs');
assert.equal(useLibraryIndexStatus.getState().status?.done, 12);
assert.equal(useLibraryIndexStatus.getState().status?.etaSec, 8);

// The upgrade ends, the search index build starts: the list answers, and so
// does a search, covering part of the library.
phase = 'index';
await until('the poll reports the index build', () => useLibraryIndexStatus.getState().status?.phase === 'index', 3 * INDEX_STATUS_POLL_MS);
// The store is open (only the search index is still building), so the list
// that was refused during the upgrade is fetched again by itself.
await until('the refused list answers', () => useLibraryStore.getState().total === 3, 3000);
assert.equal(useLibraryStore.getState().libraryOpening, false);
assert.equal(useLibraryIndexStatus.getState().watching, true, 'still polling while the index builds');
useLibraryStore.getState().setSearchQuery('track');
await until('the searched page lands', () => useLibraryStore.getState().searchIndex !== null);
{
  const s = useLibraryStore.getState();
  assert.equal(s.libraryOpening, false, 'a page that answered clears "opening"');
  assert.deepEqual(s.searchIndex, { complete: false, indexed: 40_000, total: 200_000, etaSec: 90 });
  assert.equal(s.total, 1, 'the search covers the indexed entries only');
}

// 3. The build ends: the poll sees `ready` and the list is fetched again by
// itself, now complete.
const listCallsBefore = calls.filter((u) => u.startsWith('/api/library/entries?')).length;
phase = 'ready';
await until('the poll reports ready', () => useLibraryIndexStatus.getState().status?.phase === 'ready', 3 * INDEX_STATUS_POLL_MS);
await until('the list is fetched again', () => useLibraryStore.getState().searchIndex?.complete === true, 3000);
{
  const s = useLibraryStore.getState();
  assert.ok(
    calls.filter((u) => u.startsWith('/api/library/entries?')).length > listCallsBefore,
    'ready refetches the visible range',
  );
  assert.equal(s.total, 3, 'the same search now covers every entry');
  assert.ok(calls.some((u) => u.startsWith('/api/library/summary')), 'the counts store was asked for the new revision');
  assert.equal(useLibraryIndexStatus.getState().watching, false, 'polling stops at ready');
}

// 4. Polling stays stopped: no status request after ready.
{
  const statusCalls = calls.filter((u) => u.startsWith('/api/library/index-status')).length;
  await sleep(INDEX_STATUS_POLL_MS + 300);
  assert.equal(
    calls.filter((u) => u.startsWith('/api/library/index-status')).length,
    statusCalls,
    'no poll after ready',
  );
}

console.log('libraryIndexStatusStore: all assertions passed');
