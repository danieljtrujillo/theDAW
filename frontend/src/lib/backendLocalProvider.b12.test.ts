/**
 * T22 FETCH/CACHE HYGIENE — FE-019: the library audio blob cache was an
 * unbounded `Map<string, Promise<Blob>>`, so a long session (MATCH previews,
 * a big playlist scrub, an hour of Scout auditions) held every audio Blob it
 * ever fetched in RAM for the life of the tab. `BackendLocalProvider` now
 * keeps a byte-bounded LRU (`AudioBlobCache`) instead.
 *
 * Exercises the cache directly — no network, no BackendLocalProvider — so the
 * eviction/keep/failure rules are pinned down without fetch mocking noise.
 *
 * Run: npx tsx src/lib/backendLocalProvider.b12.test.ts
 */
import assert from 'node:assert/strict';
import {
  asFacetValues,
  AudioBlobCache,
  BackendLocalProvider,
  bulkDeleteLibraryEntries,
  describeBulkConflict,
  LibraryBulkConflictError,
} from './backendLocalProvider';

const blob = (bytes: number): Blob => new Blob([new Uint8Array(bytes)]);
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── Eviction: oldest unreferenced entry drops once the budget is exceeded ──
{
  const cache = new AudioBlobCache(10);
  cache.set('a', Promise.resolve(blob(6)));
  await settle();
  cache.set('b', Promise.resolve(blob(6)));
  await settle();

  assert.equal(cache.get('a'), undefined, 'the least-recently-used entry (a) was evicted to stay within budget');
  assert.ok(cache.get('b'), 'the most recent entry (b) survives');
  assert.equal(cache.stats().bytes, 6, 'resident bytes reflect only the surviving entry');
}

// ── Touch on get() protects an entry from eviction ──────────────────────────
{
  const cache = new AudioBlobCache(10);
  cache.set('a', Promise.resolve(blob(6)));
  await settle();
  cache.set('b', Promise.resolve(blob(4)));
  await settle();
  // Touch 'a' so it is now the most-recently-used, ahead of 'b'.
  assert.ok(cache.get('a'), 'a is still cached before the touch');
  cache.set('c', Promise.resolve(blob(4)));
  await settle();

  // Budget is 10; a(6)+b(4)+c(4)=14 over budget by 4. 'b' was least-recently
  // touched (a was re-touched by the get() above), so b is evicted, not a.
  assert.ok(cache.get('a'), 'a survives because it was touched most recently');
  assert.equal(cache.get('b'), undefined, 'b is evicted — it was the least-recently-used after the touch');
  assert.ok(cache.get('c'), 'c survives — it is the newest entry');
}

// ── A single entry bigger than the whole budget is kept, not evicted ───────
{
  const cache = new AudioBlobCache(5);
  cache.set('huge', Promise.resolve(blob(50)));
  await settle();
  assert.ok(cache.get('huge'), 'an over-budget single entry is kept — evicting it would just force a re-fetch every time');
  assert.equal(cache.stats().bytes, 50);
}

// ── A failed fetch's entry is removed, so the id can be retried ────────────
{
  const cache = new AudioBlobCache(10);
  const failing = Promise.reject(new Error('network down'));
  cache.set('bad', failing);
  await failing.catch(() => {});
  await settle();
  assert.equal(cache.get('bad'), undefined, 'a rejected fetch leaves nothing cached for that id');
  assert.equal(cache.stats().entries, 0, 'the failed entry does not linger in the index');
}

// ── Audit fix 1: a PENDING (in-flight) entry survives eviction pressure ────
// Its bytes are 0 until it resolves, so evicting it frees nothing — it must
// never be picked as a victim, or the next get() for that id would return
// undefined and the caller would start a duplicate ~26 MB fetch while the
// original, now-orphaned fetch finishes and its bytes are silently dropped.
{
  const cache = new AudioBlobCache(5);
  let resolvePending: ((b: Blob) => void) | undefined;
  const pendingPromise = new Promise<Blob>((r) => {
    resolvePending = r;
  });
  cache.set('pending', pendingPromise);
  await settle();

  // A second, resolved entry lands and is over budget on its own — the
  // eviction pass this triggers must not take the still-pending entry.
  cache.set('a', Promise.resolve(blob(6)));
  await settle();

  const stillCached = cache.get('pending');
  assert.equal(
    stillCached,
    pendingPromise,
    'get() returns the SAME promise instance for the still-pending fetch — a second caller does not start a duplicate fetch',
  );

  resolvePending?.(blob(2));
  await settle();
  assert.ok(cache.get('pending'), 'once it resolves, the entry is still present and now accounted for');
}

// ── Audit fix 2: a stale rejection must not delete a newer healthy entry ───
// set() is called twice for the same id (a retry racing its own failure): the
// FIRST promise later rejects, after the SECOND (healthy) one has already
// replaced it in the map. The first promise's rejection handler must not wipe
// out the entry the second `set()` installed.
{
  const cache = new AudioBlobCache(100);
  let rejectFirst: ((e: Error) => void) | undefined;
  const first = new Promise<Blob>((_r, rej) => {
    rejectFirst = rej;
  });
  cache.set('race', first);
  await settle();

  const second = Promise.resolve(blob(10));
  cache.set('race', second);
  await settle();
  assert.equal(cache.get('race'), second, 'the second, healthy fetch replaced the first');

  rejectFirst?.(new Error('the stale first fetch finally fails'));
  await settle();

  assert.equal(
    cache.get('race'),
    second,
    'the stale first promise rejecting later must not delete the newer healthy entry',
  );
  assert.equal(cache.stats().bytes, 10, 'byte accounting still reflects only the surviving (second) entry');
}

// ── delete() removes an entry and its byte accounting ───────────────────────
{
  const cache = new AudioBlobCache(100);
  cache.set('x', Promise.resolve(blob(20)));
  await settle();
  assert.equal(cache.stats().bytes, 20);
  cache.delete('x');
  assert.equal(cache.get('x'), undefined);
  assert.equal(cache.stats().bytes, 0, 'byte total is back to zero after delete');
}

console.log('backendLocalProvider: AudioBlobCache is byte-bounded LRU');

/**
 * Follow-up fix 2 (MAJOR, possible data loss): a row's `lyrics` falls back to
 * `lyrics_preview` (see `toEntry`, ~L94) purely for DISPLAY when the backend
 * omitted the full text from a paged list row (over 280 chars). Any save path
 * that includes that preview-carrying `.lyrics` value in a PATCH — whether
 * because a caller spreads a preview-only entry into a patch today, or one
 * does in the future — must never let the 280-character preview overwrite the
 * server's full lyrics. `update()` now only forwards a `lyrics` patch for an
 * id whose FULL text was actually loaded (a single-entry GET, or a paged row
 * short enough that the backend sent it in full); otherwise the key is
 * dropped from the outgoing PATCH body entirely, every other field in the
 * same patch still going through.
 *
 * Run: npx tsx src/lib/backendLocalProvider.b12.test.ts
 */
{
  const record = (id: string, extra: { lyrics?: string; lyrics_preview?: string }) => ({
    id,
    title: id,
    prompt: '',
    negative_prompt: '',
    model: 'import',
    duration: 1,
    steps: 0,
    cfg: 0,
    seed: 0,
    audio_url: `/api/library/audio/${id}`,
    audio_filename: `${id}.wav`,
    file_size_bytes: 1,
    mime_type: 'audio/wav',
    timestamp: '2026-09-19T00:00:00Z',
    favorite: false,
    rating: null,
    tags: [],
    notes: '',
    source: 'import',
    ...extra,
  });

  const fullText = 'verse one\nverse two\n(this is the complete, un-truncated lyrics)';
  const previewText = 'verse one\nverse two\n(this is only the first 280 characters of a much longer…';

  let lastPatchBody: unknown = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      lastPatchBody = init.body ? JSON.parse(String(init.body)) : null;
      const id = url.split('/').pop()!;
      return new Response(JSON.stringify(record(id, { lyrics: fullText })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/entries')) {
      return new Response(
        JSON.stringify({ entries: [record('preview-id', { lyrics_preview: previewText })] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/entries/full-id')) {
      return new Response(JSON.stringify(record('full-id', { lyrics: fullText })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new BackendLocalProvider('http://backend/api/library');

    // A paged row whose lyrics were long enough to be truncated to a preview.
    const [previewEntry] = await provider.list();
    assert.equal(previewEntry.lyrics, previewText, 'sanity: the entry carries the preview for display');

    // Some save includes lyrics in its patch (e.g. a naive spread of the
    // entry) without the user ever having opened/edited lyrics for this row.
    lastPatchBody = null;
    await provider.update(previewEntry.id, { title: 'Renamed', lyrics: previewEntry.lyrics });
    assert.ok(lastPatchBody && typeof lastPatchBody === 'object', 'the PATCH still went out');
    assert.ok(
      !('lyrics' in (lastPatchBody as object)),
      'the PATCH body must NOT carry a lyrics key for a preview-only entry — the server\'s full text stays untouched',
    );
    assert.equal(
      (lastPatchBody as Record<string, unknown>).title,
      'Renamed',
      'every OTHER field in the same patch still goes through',
    );

    // An entry whose full lyrics WAS actually loaded (single-entry GET).
    const fullEntry = await provider.get('full-id');
    assert.ok(fullEntry, 'the full entry loads');
    assert.equal(fullEntry!.lyrics, fullText, 'sanity: this entry carries the FULL text, not a preview');

    lastPatchBody = null;
    await provider.update(fullEntry!.id, { lyrics: 'a deliberate edit to the full lyrics' });
    assert.ok(
      lastPatchBody && (lastPatchBody as Record<string, unknown>).lyrics === 'a deliberate edit to the full lyrics',
      'a save for an entry whose full lyrics WAS loaded still saves lyrics normally',
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('backendLocalProvider: a preview-only row never overwrites the server\'s full lyrics');
}

/**
 * Follow-up fix 3 (MINOR, dead code): `asFacetValues` used to compute `value`
 * as `typeof v.value === 'string' ? v.value : v.value == null ? null : null`
 * — both arms of the inner ternary return `null`, so it was equivalent to (and
 * is now) `typeof v.value === 'string' ? v.value : null`. Same behaviour,
 * dead branch removed: a string passes through, anything else (a real null,
 * a missing field, or a malformed non-string the server should never send)
 * normalizes to null rather than crashing the filter dropdown.
 *
 * Run: npx tsx src/lib/backendLocalProvider.b12.test.ts
 */
{
  assert.deepEqual(
    asFacetValues([{ value: 'wav', count: 3 }, { value: null, count: 7 }]),
    [{ value: 'wav', count: 3 }, { value: null, count: 7 }],
    'a real string and a genuine null bucket both pass through unchanged',
  );
  assert.deepEqual(
    asFacetValues([{ value: 42, count: 1 }, { count: 2 }, { value: undefined, count: 3 }]),
    [{ value: null, count: 1 }, { value: null, count: 2 }, { value: null, count: 3 }],
    'a malformed (non-string, non-null) value, a missing value field, and an explicit undefined all normalize to null',
  );
  assert.deepEqual(asFacetValues('not an array'), [], 'a non-array answer yields no facet values');
  assert.deepEqual(
    asFacetValues([{ value: 'ok', count: 'not a number' }]),
    [{ value: 'ok', count: 0 }],
    'a non-numeric count defaults to 0 rather than propagating garbage',
  );

  console.log('backendLocalProvider: asFacetValues normalizes non-string values to null (dead branch removed)');
}

/**
 * Follow-up fix 4 (MINOR): a 409 conflict body that omits `total_matched`
 * used to default the conflict count to 0 — a specific, WRONG claim ("the
 * library now has zero matching entries") rather than an honest "we don't
 * know". There is no list of ids/entries in a 409 body to count instead (see
 * backend/modules/library/router.py's 409: `{detail, total_matched}` only),
 * so the fix reports the count as NaN — a value every consumer (arithmetic,
 * `.toLocaleString()`) visibly shows as not-a-real-number rather than
 * silently rendering "0 entries left".
 *
 * Run: npx tsx src/lib/backendLocalProvider.b12.test.ts
 */
{
  const realFetch = globalThis.fetch;

  // total_matched present: the real count still comes through unchanged.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: 'changed', total_matched: 7 }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    await bulkDeleteLibraryEntries({ ids: ['a', 'b'] }, undefined, 'http://backend/api/library');
    assert.fail('expected LibraryBulkConflictError');
  } catch (e) {
    assert.ok(e instanceof LibraryBulkConflictError);
    assert.equal(e.totalMatched, 7, 'a real total_matched from the server passes through unchanged');
  } finally {
    globalThis.fetch = realFetch;
  }

  // total_matched absent: NaN, not a misleading 0.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: 'changed' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    await bulkDeleteLibraryEntries({ ids: ['a', 'b'] }, undefined, 'http://backend/api/library');
    assert.fail('expected LibraryBulkConflictError');
  } catch (e) {
    assert.ok(e instanceof LibraryBulkConflictError);
    assert.ok(
      Number.isNaN(e.totalMatched),
      `a conflict with no total_matched reports NaN (unknown), not a misleading 0 — got ${e.totalMatched}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('backendLocalProvider: a 409 conflict with no total_matched reports NaN, not a misleading 0');
}

/**
 * Follow-up fix 4b: `LibraryView.tsx` turned a conflict's `totalMatched`
 * straight into a rendered count (`${e.totalMatched.toLocaleString()}
 * entries`) and into stored state (`setClearAllTotal`, `maintenanceCounts`).
 * Since fix 4 above can now make that NaN, those call sites would have shown
 * "It now holds NaN entries" and left NaN sitting in state for the NEXT
 * confirm dialog to render. `describeBulkConflict` is the one place that
 * turns a conflict into what to SHOW and what to STORE, so both call sites
 * share one rule instead of each needing its own NaN guard.
 *
 * Run: npx tsx src/lib/backendLocalProvider.b12.test.ts
 */
{
  const known = describeBulkConflict(1234);
  assert.equal(
    known.message,
    'The library changed while the confirmation was open — nothing was deleted. It now holds 1,234 entries.',
    'a real count is named in the message',
  );
  assert.equal(known.total, 1234, 'a real count is returned for the caller to store/re-confirm with');

  const unknown = describeBulkConflict(NaN);
  assert.equal(
    unknown.message,
    'The library changed while the confirmation was open — nothing was deleted.',
    'an unknown count omits the count entirely rather than saying "NaN"',
  );
  assert.equal(
    unknown.total,
    null,
    'an unknown count is null, not NaN — callers must not store this in place of a real number',
  );

  console.log('backendLocalProvider: describeBulkConflict never turns NaN into a rendered or stored count');
}
