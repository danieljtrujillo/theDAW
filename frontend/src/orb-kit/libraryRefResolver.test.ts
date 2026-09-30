/**
 * libraryRefResolver — resolves one library entry by id through the
 * backend, with in-flight de-duplication and a small LRU of settled
 * answers.
 *
 * Pins: the URL hits the single-entry route (never the list); a 404
 * settles as 'missing' and IS cached; any other failure settles as
 * 'unavailable' and is NEVER cached (so a retry can succeed); concurrent
 * calls for the same (id, revision) share one fetch; a different revision
 * is a different cache key; and the LRU holds at most
 * LIBRARY_REF_CACHE_MAX settled answers.
 *
 * Run: `npx tsx src/orb-kit/libraryRefResolver.test.ts` (or `npm test`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveLibraryRef,
  peekLibraryRef,
  primeLibraryRefs,
  clearLibraryRefCache,
} from './libraryRefResolver.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);
const calls: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  return handler(url);
}) as typeof fetch;

const reset = (): void => {
  calls.length = 0;
  clearLibraryRefCache();
};

// ── resolves an entry by id and returns ok ──────────────────────────────────
{
  reset();
  // Real payload shape: the backend (store.py to_dict()) emits `duration`
  // (float seconds), never `durationSec` — this fixture must NOT fabricate
  // a `durationSec` key, or it would mask a resolver that only reads that
  // key and never falls back to the real `duration` field.
  handler = async () =>
    jsonResponse({ id: 'abc', title: 'Amen Break', duration: 12.5, source: 'import', revision: 3 });

  const result = await resolveLibraryRef('abc');

  assert.deepEqual(result, {
    status: 'ok',
    entry: { id: 'abc', title: 'Amen Break', durationSec: 12.5, source: 'import' },
    revision: 3,
  });
  assert.equal(calls.length, 1, 'exactly one fetch');
  assert.equal(calls[0], '/api/library/entries/abc', 'the single-entry route, id-encoded');
}

// ── 404 resolves to missing ──────────────────────────────────────────────────
{
  reset();
  handler = async () => jsonResponse({ detail: "Entry 'gone' not found" }, 404);

  const result = await resolveLibraryRef('gone');

  assert.deepEqual(result, { status: 'missing', id: 'gone' });
}

// ── a second call for the same id hits the cache (one fetch total) ─────────
{
  reset();
  let fetchCount = 0;
  handler = async () => {
    fetchCount += 1;
    return jsonResponse({ id: 'cached-1', title: 'One', durationSec: null, source: null, revision: 1 });
  };

  const first = await resolveLibraryRef('cached-1');
  const second = await resolveLibraryRef('cached-1');

  assert.deepEqual(first, second);
  assert.equal(fetchCount, 1, 'the second call is served from the LRU, not the network');
}

// ── two concurrent calls share one in-flight request ────────────────────────
{
  reset();
  let fetchCount = 0;
  handler = async () => {
    fetchCount += 1;
    return jsonResponse({ id: 'inflight-1', title: 'Two', durationSec: null, source: null, revision: 1 });
  };

  const [r1, r2] = await Promise.all([resolveLibraryRef('inflight-1'), resolveLibraryRef('inflight-1')]);

  assert.deepEqual(r1, r2);
  assert.equal(fetchCount, 1, 'only one fetch fires for two concurrent callers of the same key');
}

// ── a different revision re-fetches ──────────────────────────────────────────
{
  reset();
  let fetchCount = 0;
  handler = async () => {
    fetchCount += 1;
    return jsonResponse({ id: 'rev-1', title: 'Three', durationSec: null, source: null, revision: 5 });
  };

  await resolveLibraryRef('rev-1', 5);
  await resolveLibraryRef('rev-1', 6);

  assert.equal(fetchCount, 2, 'a bumped revision is a different cache key, so it re-fetches');
}

// ── a 500 returns unavailable and is not cached (second call fetches again) ─
{
  reset();
  let fetchCount = 0;
  handler = async () => {
    fetchCount += 1;
    return jsonResponse({ detail: 'boom' }, 500);
  };

  const first = await resolveLibraryRef('flaky');
  assert.deepEqual(first, { status: 'unavailable', id: 'flaky', error: 'HTTP 500' });

  const second = await resolveLibraryRef('flaky');
  assert.deepEqual(second, { status: 'unavailable', id: 'flaky', error: 'HTTP 500' });

  assert.equal(fetchCount, 2, 'an unavailable answer is never cached, so the second call retries');
}

// ── LRU keeps at most 64 entries ─────────────────────────────────────────────
{
  reset();
  handler = async (url) => {
    const id = url.split('/').pop() as string;
    return jsonResponse({ id, title: id, durationSec: null, source: null, revision: 1 });
  };

  for (let i = 0; i < 70; i += 1) {
    await resolveLibraryRef(`lru-${i}`);
  }

  assert.equal(peekLibraryRef('lru-0'), null, 'the oldest entry was evicted past the 64 cap');
  assert.ok(peekLibraryRef('lru-69'), 'the newest entry is still cached');
}

// ── primeLibraryRefs([]) makes no fetch ─────────────────────────────────────
{
  reset();
  handler = async () => {
    throw new Error('fetch should not be called for an empty id list');
  };

  const result = await primeLibraryRefs([]);

  assert.deepEqual(result, []);
  assert.equal(calls.length, 0);
}

// ── LibraryRefStatus and clearLibraryRefCache state id-authoritative / title-display-only ─
// These two were the exports the rework-round-1 audit found missing the MUST
// DO 9 clause (the other five already carry it, in their own words, and are
// intentionally not re-asserted here — this test targets exactly the finding).
{
  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'libraryRefResolver.ts');
  const source = readFileSync(sourcePath, 'utf8');

  const docCommentBefore = (marker: string): string => {
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, `expected to find "${marker}" in libraryRefResolver.ts`);
    const before = source.slice(0, markerIndex);
    const commentEnd = before.lastIndexOf('*/');
    assert.ok(commentEnd >= 0, `expected a doc comment before "${marker}"`);
    const commentStart = before.lastIndexOf('/**', commentEnd);
    assert.ok(commentStart >= 0, `expected a /** doc comment before "${marker}"`);
    return before.slice(commentStart, commentEnd + 2);
  };

  for (const marker of ['export type LibraryRefStatus', 'export function clearLibraryRefCache']) {
    const comment = docCommentBefore(marker);
    assert.match(comment, /authoritative/i, `${marker} doc comment must say the id is authoritative`);
    assert.match(comment, /display-only/i, `${marker} doc comment must say titles are display-only`);
  }
}

console.log('libraryRefResolver: ok');
