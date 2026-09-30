/**
 * The by-id library entry cache: dedupe, a bounded LRU, and revision
 * invalidation, all without a real network fetch.
 *
 * Pins: a cache hit never re-fetches, concurrent lookups for one id share a
 * single fetch, a 404 is remembered but a rejection is retryable, and only
 * a GREATER positive revision drops the cache.
 *
 * Run: `npx tsx src/lib/libraryEntryCache.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import type { LibraryEntry } from '../state/libraryEntry';
import {
  MAX_CACHED_ENTRIES,
  cacheStats,
  getCachedEntry,
  getEntry,
  putEntry,
  resetLibraryEntryCache,
  setEntryFetcher,
  setLibraryRevision,
} from './libraryEntryCache.ts';
import type { EntryFetcher } from './libraryEntryCache.ts';

/** A minimal, valid entry — only `id` varies across tests. */
const makeEntry = (id: string): LibraryEntry => ({
  id,
  title: `Track ${id}`,
  prompt: 'a prompt',
  negativePrompt: '',
  model: 'test-model',
  duration: 30,
  steps: 8,
  cfg: 1,
  seed: 0,
  audioUrl: `/api/library/audio/${id}`,
  audioFilename: `${id}.wav`,
  fileSizeBytes: 1024,
  mimeType: 'audio/wav',
  timestamp: '2026-01-01T00:00:00.000Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  lyrics: '',
  source: 'generate',
});

type StubOutcome = LibraryEntry | null | Error;

/** A fetcher stub: canned per-id outcomes, a call log, and no network. */
const makeStub = (initial: Record<string, StubOutcome> = {}) => {
  const outcomes = new Map<string, StubOutcome>(Object.entries(initial));
  const calls: string[] = [];
  const fetcher: EntryFetcher = async (id) => {
    calls.push(id);
    const outcome = outcomes.get(id);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? null;
  };
  return { fetcher, calls, set: (id: string, outcome: StubOutcome) => outcomes.set(id, outcome) };
};

// ── cache hit does not re-fetch ─────────────────────────────────────────────
{
  resetLibraryEntryCache();
  const entry = makeEntry('a1');
  const stub = makeStub({ a1: entry });
  setEntryFetcher(stub.fetcher);

  const first = await getEntry('a1');
  assert.equal(first, entry, 'the first call fetches and returns the entry');
  assert.equal(stub.calls.length, 1, 'one fetch for the first call');

  const second = await getEntry('a1');
  assert.equal(second, entry, 'a cache hit answers the same entry');
  assert.equal(stub.calls.length, 1, 'a cache hit does not re-fetch');
  assert.equal(getCachedEntry('a1'), entry, 'getCachedEntry answers synchronously');
}

// ── concurrent getEntry de-duplicates ───────────────────────────────────────
{
  resetLibraryEntryCache();
  const entry = makeEntry('b1');
  const stub = makeStub({ b1: entry });
  setEntryFetcher(stub.fetcher);

  const p1 = getEntry('b1');
  const p2 = getEntry('b1');
  assert.equal(p1, p2, 'two calls before resolution share the SAME promise');
  assert.equal(stub.calls.length, 1, 'two calls before resolution produce one fetch');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, entry);
  assert.equal(r2, entry);
  assert.equal(stub.calls.length, 1, 'still one fetch once both resolve');
}

// ── LRU evicts the least recently used ──────────────────────────────────────
{
  resetLibraryEntryCache();
  const total = MAX_CACHED_ENTRIES + 5;
  for (let i = 0; i < total; i += 1) {
    putEntry(makeEntry(`lru-${i}`));
    // Re-read an early id partway through so it is not the least-recently-used
    // by the time eviction reaches that part of the insertion order.
    if (i === 10) getCachedEntry('lru-3');
  }

  assert.equal(cacheStats().size, MAX_CACHED_ENTRIES, 'capped at MAX_CACHED_ENTRIES');
  assert.equal(getCachedEntry('lru-0'), undefined, 'the first inserted id is gone');
  assert.notEqual(getCachedEntry('lru-3'), undefined, 'the re-read id survived eviction');
}

// ── 404 becomes missing and is not asked twice ──────────────────────────────
{
  resetLibraryEntryCache();
  const stub = makeStub({ c1: null });
  setEntryFetcher(stub.fetcher);

  const first = await getEntry('c1');
  assert.equal(first, null, 'a 404 resolves null');
  assert.equal(stub.calls.length, 1);

  const second = await getEntry('c1');
  assert.equal(second, null);
  assert.equal(stub.calls.length, 1, 'a known-missing id is not asked twice');
  assert.equal(cacheStats().missing, 1);
}

// ── a rejected fetch is retryable ───────────────────────────────────────────
{
  resetLibraryEntryCache();
  const entry = makeEntry('d1');
  const stub = makeStub({ d1: new Error('network down') });
  setEntryFetcher(stub.fetcher);

  const first = await getEntry('d1');
  assert.equal(first, null, 'a rejected fetch resolves null, not a thrown error');
  assert.equal(stub.calls.length, 1);
  assert.equal(cacheStats().missing, 0, 'a rejection is not recorded as a 404');

  stub.set('d1', entry);
  const second = await getEntry('d1');
  assert.equal(second, entry, 'a retry after a rejection fetches again');
  assert.equal(stub.calls.length, 2);
}

// ── a newer revision invalidates the cache ──────────────────────────────────
{
  resetLibraryEntryCache();
  const entry = makeEntry('e1');
  const stub = makeStub({ e1: entry });
  setEntryFetcher(stub.fetcher);

  await getEntry('e1');
  assert.equal(stub.calls.length, 1);
  assert.notEqual(getCachedEntry('e1'), undefined);

  setLibraryRevision(2);
  assert.equal(getCachedEntry('e1'), undefined, 'a newer revision drops the cached row');
  assert.equal(cacheStats().revision, 2);

  const again = await getEntry('e1');
  assert.equal(again, entry, 'a later getEntry re-fetches');
  assert.equal(stub.calls.length, 2, 'the revision bump caused a re-fetch');

  setLibraryRevision(1);
  assert.equal(cacheStats().revision, 2, 'an equal-or-smaller revision changes nothing');
  assert.notEqual(getCachedEntry('e1'), undefined, 'the cache is untouched by the smaller revision');
}

// ── a revision bump while a fetch is in flight discards its result ─────────
{
  resetLibraryEntryCache();
  const entry = makeEntry('f1');
  let resolveHit: (value: LibraryEntry | null) => void = () => {};
  let resolveMiss: (value: LibraryEntry | null) => void = () => {};
  const hitPending = new Promise<LibraryEntry | null>((resolve) => {
    resolveHit = resolve;
  });
  const missPending = new Promise<LibraryEntry | null>((resolve) => {
    resolveMiss = resolve;
  });
  setEntryFetcher(async (id) => (id === 'f1' ? hitPending : missPending));

  const hitPromise = getEntry('f1');
  const missPromise = getEntry('f2');
  setLibraryRevision(2);
  resolveHit(entry);
  resolveMiss(null);
  const [hitResult, missResult] = await Promise.all([hitPromise, missPromise]);

  assert.equal(hitResult, entry, 'the caller still gets the entry it asked for');
  assert.equal(missResult, null, 'the caller still gets null for the miss it asked for');
  assert.equal(cacheStats().size, 0, 'a stale-revision hit is not written into the new cache');
  assert.equal(cacheStats().missing, 0, 'a stale-revision miss is not written into the new missing set');
}

console.log('libraryEntryCache: ok');
