/**
 * Every library request besides the list while the backend opens the
 * library, replayed in the order a real start produces it:
 *
 *   1. the schema upgrade: the counts (`/summary`), the facets and a LOOM
 *      reference (`/entries/resolve`) all answer 503 with `library_status`.
 *      The counts go to status `opening` (the tabs keep `…`, no Retry
 *      button), the facets log nothing, and the reference waits;
 *   2. the store opens and the search index builds: the counts are asked for
 *      again by themselves, and the waiting reference is asked again and
 *      found;
 *   3. during the build, play / range / reveal (`partial`) get the ids the
 *      list shows, select-all is refused with the build's own wording, and a
 *      bulk delete by a searched filter is that refusal, never a count
 *      conflict;
 *   4. a failed open stays failed, and the alert's Retry asks the backend to
 *      try again and watches the new attempt to `ready`.
 *
 * Before the fix the counts showed `—` with a Retry button, every facets
 * request logged an error, a reference answered null, play fell back to one
 * track, and a failed open showed "opening" forever.
 *
 * Real stores, real provider, fake `fetch`. Real timers (1 s poll).
 *
 *   cd frontend && npx tsx src/state/libraryOpeningRequests.test.ts
 */
import assert from 'node:assert/strict';
import { useLibraryStore } from './libraryStore.ts';
import { useLibraryCounts } from './libraryCountsStore.ts';
import { useLibraryIndexStatus, INDEX_STATUS_POLL_MS } from './libraryIndexStatusStore.ts';
import { resolveEntryRef } from './shardIndexStore.ts';
import { useLogStore } from './logStore.ts';
import {
  LibraryBulkConflictError,
  LibrarySearchIndexBuildingError,
} from '../lib/backendLocalProvider.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Phase = 'upgrade' | 'index' | 'ready' | 'failed';
let phase: Phase = 'upgrade';
/** Whether the next Retry succeeds. */
let retrySucceeds = false;
const calls: { url: string; method: string }[] = [];

const snapshot = (p: Phase) => ({
  phase: p,
  label:
    p === 'upgrade'
      ? 'Upgrading the library database'
      : p === 'index'
        ? 'Building the search index'
        : p === 'failed'
          ? 'The library could not be opened'
          : 'Ready',
  done: p === 'upgrade' ? 3 : p === 'index' ? 400 : 0,
  total: p === 'upgrade' ? 30 : p === 'index' ? 1000 : 0,
  items: 0,
  eta_sec: null,
  opened: p === 'index' || p === 'ready',
  error: p === 'failed' ? 'the library folder cannot be read' : null,
});

const refusedWhileOpening = (): Response | null =>
  phase === 'upgrade' || phase === 'failed'
    ? jsonResponse({ detail: 'The library is opening', library_status: snapshot(phase) }, 503)
    : null;

const partialIndex = { complete: false, indexed: 400, total: 1000, eta_sec: 30 };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method });
  const params = new URL(url, 'http://local').searchParams;
  if (url.startsWith('/api/library/index-status')) return jsonResponse(snapshot(phase));
  if (url.startsWith('/api/library/retry-open')) {
    phase = retrySucceeds ? 'ready' : 'failed';
    return jsonResponse(snapshot(retrySucceeds ? 'index' : 'failed'));
  }
  if (url.startsWith('/api/library/summary')) {
    return refusedWhileOpening() ?? jsonResponse({ revision: 7, counts: { tracks: 3, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  if (url.startsWith('/api/library/entries/facets')) {
    return refusedWhileOpening() ?? jsonResponse({ facets: { model: [{ value: 'sa3', count: 3 }] }, revision: 7 });
  }
  if (url.startsWith('/api/library/entries/resolve')) {
    return refusedWhileOpening() ?? jsonResponse({ id: params.get('ref') === 'Track 1' ? 'e1' : null });
  }
  if (url.startsWith('/api/library/entries/ids')) {
    const refused = refusedWhileOpening();
    if (refused) return refused;
    if (params.has('q') && phase === 'index' && params.get('partial') !== 'true') {
      return jsonResponse(
        {
          detail: 'the search index is still being built (400 of 1,000 entries); select every match when it finishes',
          search_index: partialIndex,
        },
        409,
      );
    }
    return jsonResponse({
      ids: ['e1', 'e2'],
      total: 2,
      ...(params.has('q') ? { search_index: phase === 'index' ? partialIndex : { complete: true } } : {}),
    });
  }
  if (url.startsWith('/api/library/entries/bulk-delete')) {
    return jsonResponse(
      {
        detail: 'the search index is still being built (400 of 1,000 entries); delete every match when it finishes',
        search_index: partialIndex,
      },
      409,
    );
  }
  if (url.startsWith('/api/library/entries?')) {
    return (
      refusedWhileOpening() ??
      jsonResponse({ entries: [], total: 0, offset: 0, limit: 200, revision: 7 })
    );
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

const errorLines = () => useLogStore.getState().entries.filter((e) => e.level === 'error');

// 1. The upgrade: counts, facets and a reference are refused.
await useLibraryCounts.getState().load();
{
  const c = useLibraryCounts.getState();
  assert.equal(c.status, 'opening', 'a 503 with library_status is "opening"');
  assert.equal(c.error, null, 'and not an error, so no Retry button and no "—"');
}
await useLibraryStore.getState().ensureFacets(['model']);
assert.deepEqual(errorLines(), [], 'a facets request refused while opening logs no error');

let resolved: string | null | undefined;
const reference = resolveEntryRef('Track 1').then((id) => {
  resolved = id;
});
await sleep(200);
assert.equal(resolved, undefined, 'a reference refused while opening waits');

// 2. The store opens; the search index builds.
phase = 'index';
await until('the counts are asked for again', () => useLibraryCounts.getState().status === 'ready', 3 * INDEX_STATUS_POLL_MS);
assert.equal(useLibraryCounts.getState().counts?.tracks, 3);
await reference;
assert.equal(resolved, 'e1', 'the waiting reference is asked again once the library has opened');
assert.deepEqual(errorLines(), [], 'nothing on the way logged an error');

// 3. During the build: the list's own callers get the partial ids.
useLibraryStore.setState({ searchQuery: 'track' });
{
  const before = calls.length;
  const ids = await useLibraryStore.getState().listFilteredIds({ partial: true });
  assert.deepEqual(ids, ['e1', 'e2'], 'play / range / reveal get the ids the list shows');
  assert.ok(calls.slice(before).some((c) => c.url.includes('partial=true')), 'they say so with partial=true');
}
await assert.rejects(
  () => useLibraryStore.getState().listFilteredIds(),
  (e: unknown) =>
    e instanceof LibrarySearchIndexBuildingError &&
    e.message.startsWith('The search index is still being built (400 of 1,000 entries)'),
  'select-all is refused with the build\'s own wording',
);
await assert.rejects(
  () => useLibraryStore.getState().bulkDelete({ filter: { q: 'track' }, confirmTotal: 2 }),
  (e: unknown) => e instanceof LibrarySearchIndexBuildingError && !(e instanceof LibraryBulkConflictError),
  'a searched bulk delete during the build is that refusal, not a count conflict',
);

// 4. A failed open stays failed; Retry tries again and watches it through.
useLibraryIndexStatus.getState().stop();
phase = 'failed';
useLibraryIndexStatus.getState().watch();
await until('the poll reports the failure', () => useLibraryIndexStatus.getState().status?.phase === 'failed');
await until('polling stops at failed', () => !useLibraryIndexStatus.getState().watching);
{
  const polls = calls.filter((c) => c.url.startsWith('/api/library/index-status')).length;
  await sleep(INDEX_STATUS_POLL_MS + 300);
  assert.equal(
    calls.filter((c) => c.url.startsWith('/api/library/index-status')).length,
    polls,
    'a failure is not polled',
  );
}
await useLibraryIndexStatus.getState().retry();
assert.ok(
  calls.some((c) => c.url.startsWith('/api/library/retry-open') && c.method === 'POST'),
  'Retry posts to /retry-open',
);
await until('a retry that fails again is shown', () => useLibraryIndexStatus.getState().status?.phase === 'failed');
retrySucceeds = true;
await useLibraryIndexStatus.getState().retry();
await until('the retried open reaches ready', () => useLibraryIndexStatus.getState().status?.phase === 'ready', 3 * INDEX_STATUS_POLL_MS);
assert.equal(useLibraryIndexStatus.getState().retryError, null);
assert.equal(useLibraryIndexStatus.getState().retrying, false);

console.log('libraryOpeningRequests: all assertions passed');
