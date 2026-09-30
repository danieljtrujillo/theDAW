/**
 * The library store's paged mode: a sparse page cache over a 200,000-row
 * result set the backend filters and sorts.
 *
 * Everything here runs against a FAKE `fetch`, so the suite exercises the real
 * store, the real provider and the real page arithmetic — only the network is
 * replaced. `entries` stays "the rows currently loaded, in result order", which
 * is the contract every other consumer of the store reads.
 */
import assert from 'node:assert/strict';
import { useLibraryStore } from './libraryStore.ts';
import { useLibraryCounts } from './libraryCountsStore.ts';
import { LIBRARY_PAGE_SIZE, LibraryIdCapError } from '../lib/backendLocalProvider.ts';

const st = () => useLibraryStore.getState();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Longer than the store's 200 ms search debounce. */
const afterDebounce = () => sleep(280);

interface ServerRecordish {
  id: string;
  title: string;
  favorite: boolean;
  [key: string]: unknown;
}

/** A server record with only the fields the store's mapper reads. */
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
  timestamp: `2026-01-01T00:00:00Z`,
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

let handler: Handler = async () => jsonResponse({}, 500);
const calls: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  return handler(url, init);
}) as typeof fetch;

/** A summary answer so the counts store (T21) never blocks a test. */
const summary = (revision: number) =>
  jsonResponse({ revision, counts: { tracks: 0, stems: 0, midi: 0, video: 0, score: 0 } });

/** A paged /entries answer over a synthetic result set of `total` rows. */
const pageFor = (url: string, total: number, revision: number, label = ''): Response => {
  const params = new URL(url, 'http://local').searchParams;
  const offset = Number(params.get('offset') ?? '0');
  const limit = Number(params.get('limit') ?? String(LIBRARY_PAGE_SIZE));
  const entries: ServerRecordish[] = [];
  for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
    entries.push(rec(i, label ? { title: `${label} ${i}` } : {}));
  }
  return jsonResponse({ entries, total, offset, limit, revision });
};

const isEntriesList = (url: string): boolean =>
  url.startsWith('/api/library/entries') && !url.startsWith('/api/library/entries/');

/** Reset every piece of module state a test could have left behind. */
const reset = (): void => {
  calls.length = 0;
  useLibraryStore.setState({ searchQuery: '', onlyFavorites: false, sortBy: 'newest' });
  st().resetPaging();
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

// ───────────────────────────────────────────────────────────────────────────
// A paged backend: only the visible range is ever fetched.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) return pageFor(url, 1000, 3);
    return jsonResponse({}, 404);
  };

  await st().load();

  assert.equal(st().paged, true, 'a response carrying `total` proves the backend pages');
  assert.equal(st().total, 1000, 'total comes from the server, not from what is loaded');
  assert.equal(st().revision, 3, 'the response revision is recorded');
  assert.equal(st().entries.length, LIBRARY_PAGE_SIZE, 'only the first page is in hand');
  assert.equal(st().entryAt(0)?.id, 'e0');
  assert.equal(st().entryAt(199)?.id, 'e199');
  assert.equal(st().entryAt(500), undefined, 'a row on an unloaded page is not in hand yet');

  // Jumping deep into the list pulls exactly the pages that range covers.
  const before = calls.length;
  await st().ensureRange(500, 520);
  assert.equal(st().entryAt(500)?.id, 'e500', 'the deep page resolves by global index');
  assert.equal(calls.length, before + 1, 'one range inside one page is one request');
  assert.equal(st().entries.length, 2 * LIBRARY_PAGE_SIZE, 'entries holds both loaded pages');
  assert.equal(st().entries[200]?.id, 'e400', 'loaded rows stay in result order');

  // Re-visiting a loaded range costs nothing.
  const cached = calls.length;
  await st().ensureRange(0, 40);
  await st().ensureRange(500, 520);
  assert.equal(calls.length, cached, 'a range already in hand issues no request');

  // A range straddling a page boundary pulls both pages in one go.
  const straddle = calls.length;
  await st().ensureRange(199, 200);
  assert.equal(calls.length, straddle + 1, 'page 0 was held, so only page 1 is fetched');
  assert.equal(st().entryAt(200)?.id, 'e200');
}

// ───────────────────────────────────────────────────────────────────────────
// A slow answer to a query the user has already moved on from is dropped.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  let releaseOld: (() => void) | null = null;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) {
      if (url.includes('q=old')) {
        await new Promise<void>((r) => {
          releaseOld = r;
        });
        return pageFor(url, 7, 3, 'OLD');
      }
      return pageFor(url, 4, 3, 'NEW');
    }
    return jsonResponse({}, 404);
  };

  st().setSearchQuery('old');
  await afterDebounce();
  const stalePages = st().ensureRange(0, 10);

  // The user types again before the first answer lands.
  st().setSearchQuery('new');
  await afterDebounce();
  await st().ensureRange(0, 10);
  assert.equal(st().entries[0]?.title, 'NEW 0', 'the current query is on screen');
  assert.equal(st().total, 4);

  // …and now the old answer finally arrives.
  assert.ok(releaseOld, 'the stale request was actually issued');
  (releaseOld as unknown as () => void)();
  await stalePages;
  assert.equal(st().entries[0]?.title, 'NEW 0', 'a stale answer never overwrites a newer one');
  assert.equal(st().total, 4, 'nor its total');
}

// ───────────────────────────────────────────────────────────────────────────
// A newer library revision from the counts store (T21) invalidates the cache.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  let revision = 3;
  let label = 'BEFORE';
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(revision);
    if (isEntriesList(url)) return pageFor(url, 1000, revision, label);
    return jsonResponse({}, 404);
  };

  await st().load();
  await st().ensureRange(0, 10);
  assert.equal(st().entries[0]?.title, 'BEFORE 0');
  assert.equal(st().revision, 3);

  // Something committed elsewhere; the counts store sees the new revision.
  revision = 4;
  label = 'AFTER';
  await useLibraryCounts.getState().load();
  // The store reacts to the bump and refetches the range that is on screen.
  await sleep(50);
  await st().ensureRange(0, 10);
  assert.equal(st().revision, 4, 'the store followed the library forward');
  assert.equal(st().entries[0]?.title, 'AFTER 0', 'the visible range was refetched');
}

// ───────────────────────────────────────────────────────────────────────────
// An OLD backend (no `total` in the response) falls back to loading it all.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  const all = [
    rec(1, { title: 'Bravo', favorite: true }),
    rec(2, { title: 'Alpha' }),
    rec(3, { title: 'Charlie' }),
  ];
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) {
      return jsonResponse({ entries: all, count: all.length, root: '/x', kind: 'audio' });
    }
    return jsonResponse({}, 404);
  };

  const before = calls.filter(isEntriesList).length;
  await st().load();
  assert.equal(st().paged, false, 'a response without `total` marks the backend as unpaged');
  assert.equal(
    calls.filter(isEntriesList).length,
    before + 1,
    'the probe response IS the full list — it is not fetched twice',
  );
  assert.equal(st().total, 3);
  assert.equal(st().entries.length, 3);
  assert.equal(st().entryAt(0)?.id, 'e1', 'entryAt works without a paged backend');

  // A refresh re-probes: it must not assume the backend is still the unpaged
  // one it was a moment ago, and it must not leave the library looking empty.
  await st().refresh();
  assert.equal(st().entries.length, 3, 'refresh re-loads an unpaged library');
  assert.equal(st().total, 3);

  // The client-side filter is still the one that narrows an unpaged library.
  st().setOnlyFavorites(true);
  await afterDebounce();
  assert.deepEqual(st().entries.map((e) => e.id), ['e1'], 'favorites filter applies locally');
  assert.equal(st().total, 1, 'the total follows the filter in unpaged mode');

  st().setOnlyFavorites(false);
  st().setSortBy('title');
  await afterDebounce();
  assert.deepEqual(
    st().entries.map((e) => e.title),
    ['Alpha', 'Bravo', 'Charlie'],
    'and so does the sort',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Single-entry mutations patch the cached row in place — no page refetch.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = async (url, init) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) return pageFor(url, 400, 3);
    if (url.startsWith('/api/library/entries/') && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = url.slice('/api/library/entries/'.length);
      return jsonResponse(rec(Number(id.slice(1)), { ...patch, id }));
    }
    return jsonResponse({}, 404);
  };

  await st().load();
  const beforeMutations = calls.filter(isEntriesList).length;

  await st().updateEntry('e5', { title: 'Renamed' });
  assert.equal(st().getById('e5')?.title, 'Renamed', 'the cached row carries the new title');
  assert.equal(st().entries[5]?.title, 'Renamed', 'and so does the row in order');

  await st().toggleFavorite('e5');
  assert.equal(st().getById('e5')?.favorite, true, 'favorite flips in place');

  assert.equal(
    calls.filter(isEntriesList).length,
    beforeMutations,
    'a single-entry mutation never re-fetches a page',
  );
  assert.equal(st().total, 400, 'and never disturbs the total');
}

// ───────────────────────────────────────────────────────────────────────────
// An id that is on no loaded page is fetched once and cached.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  let singleFetches = 0;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) return pageFor(url, 1000, 3);
    if (url.startsWith('/api/library/entries/')) {
      singleFetches += 1;
      return jsonResponse(rec(900, { title: 'Far away' }));
    }
    return jsonResponse({}, 404);
  };

  await st().load();
  assert.equal(st().getById('e900'), undefined, 'not on a loaded page');
  const fetched = await st().ensureEntry('e900');
  assert.equal(fetched?.title, 'Far away');
  assert.equal(st().getById('e900')?.title, 'Far away', 'getById now answers from the by-id cache');
  await st().ensureEntry('e900');
  assert.equal(singleFetches, 1, 'the by-id cache is consulted before the network');

  // A missing entry answers null rather than throwing.
  handler = async (url) => {
    if (url.startsWith('/api/library/entries/')) return jsonResponse({ detail: 'gone' }, 404);
    return jsonResponse({}, 404);
  };
  assert.equal(await st().ensureEntry('nope'), null);
}

// ───────────────────────────────────────────────────────────────────────────
// Select-all asks the server for ids, and says so when the library is too big.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (url.startsWith('/api/library/entries/ids')) {
      return jsonResponse({ ids: ['e0', 'e1', 'e2'], total: 3 });
    }
    if (isEntriesList(url)) return pageFor(url, 3, 3);
    return jsonResponse({}, 404);
  };
  await st().load();
  assert.deepEqual(await st().listFilteredIds(), ['e0', 'e1', 'e2']);

  handler = async (url) => {
    if (url.startsWith('/api/library/entries/ids')) {
      return jsonResponse({ detail: 'too many ids' }, 413);
    }
    return jsonResponse({}, 404);
  };
  await assert.rejects(
    () => st().listFilteredIds(),
    (e: unknown) => {
      assert.ok(e instanceof LibraryIdCapError, 'the 413 surfaces as its own error type');
      assert.match(e.message, /50,000/, 'and carries the cap in a message a user can act on');
      return true;
    },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// An unpaged backend has no /ids route: the loaded rows ARE every row.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (url.startsWith('/api/library/entries/ids')) return jsonResponse({ detail: 'nope' }, 404);
    if (isEntriesList(url)) {
      return jsonResponse({ entries: [rec(1), rec(2)], count: 2, root: '/x', kind: 'audio' });
    }
    return jsonResponse({}, 404);
  };
  await st().load();
  assert.deepEqual(await st().listFilteredIds(), ['e1', 'e2']);
}

// ───────────────────────────────────────────────────────────────────────────
// A page that fails leaves a message the view can retry from.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  let failing = true;
  handler = async (url) => {
    if (url.startsWith('/api/library/summary')) return summary(1);
    if (isEntriesList(url)) {
      if (failing) return jsonResponse({ detail: 'database is locked' }, 500);
      return pageFor(url, 10, 3);
    }
    return jsonResponse({}, 404);
  };

  await st().load();
  assert.ok(st().pageError, 'the failure is recorded');
  assert.match(String(st().pageError), /database is locked/);
  assert.equal(st().pagesLoading, 0, 'and the loading bar is not left running');

  failing = false;
  await st().retryPages();
  assert.equal(st().pageError, null, 'a successful retry clears the error');
  assert.equal(st().entries.length, 10);
}

console.log('libraryStore.paging: ok');
