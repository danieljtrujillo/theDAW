// Run with: npx tsx src/state/libraryCountsStore.test.ts
//
// The library tab strip's counts, replayed against a stub backend: a load
// fills the five categories, a slow OLD response never overwrites a newer
// one, a failed refresh keeps the last good counts, a malformed payload is
// refused rather than rendered, and a burst of invalidations collapses into
// one in-flight request plus one queued.
import assert from 'node:assert/strict';
import { useLibraryCounts, type LibraryCounts } from './libraryCountsStore.ts';

type Reply = { status: number; body: unknown } | 'network-error';

let calls = 0;
let handler: (call: number) => Reply | Promise<Reply> = () => ({ status: 200, body: null });
const urls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  urls.push(url);
  const reply = await handler(++calls);
  if (reply === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const st = () => useLibraryCounts.getState();
const counts = (over: Partial<LibraryCounts> = {}): LibraryCounts =>
  ({ tracks: 0, stems: 0, midi: 0, video: 0, score: 0, ...over });
const snapshot = (revision: number, over: Partial<LibraryCounts> = {}) =>
  ({ revision, counts: counts(over) });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
/** Let queued microtasks AND the coalesced follow-up request settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const reset = (): void => {
  calls = 0;
  urls.length = 0;
  useLibraryCounts.setState({ counts: null, revision: 0, status: 'idle', error: null });
};

// A load fills every category and marks the store ready.
{
  reset();
  handler = () => ({ status: 200, body: snapshot(7, { tracks: 3, stems: 12, midi: 2, video: 1, score: 4 }) });
  await st().load();
  assert.equal(st().status, 'ready');
  assert.equal(st().error, null);
  assert.equal(st().revision, 7);
  assert.deepEqual(st().counts, { tracks: 3, stems: 12, midi: 2, video: 1, score: 4 });
  assert.deepEqual(urls, ['/api/library/summary'], 'reads the summary endpoint');
}

// The race: an older response that lands AFTER a newer one is dropped. Both
// requests are in flight at once; the second answers first.
{
  reset();
  const slowOld = deferred<Reply>();
  const fastNew = deferred<Reply>();
  handler = (n) => (n === 1 ? slowOld.promise : fastNew.promise);

  const old = st().load();
  const fresh = st().load();
  fastNew.resolve({ status: 200, body: snapshot(9, { tracks: 5 }) });
  await fresh;
  assert.equal(st().revision, 9);
  assert.equal(st().counts?.tracks, 5);

  slowOld.resolve({ status: 200, body: snapshot(2, { tracks: 1 }) });
  await old;
  await settle();
  assert.equal(st().revision, 9, 'the stale response never rewinds the revision');
  assert.equal(st().counts?.tracks, 5, 'the stale response never overwrites newer counts');
  assert.equal(st().status, 'ready');
}

// A stale FAILURE is dropped just as hard as a stale success. Starting a
// second load aborts the first, so the first rejects AFTER the second has
// already succeeded; that late rejection must not throw the strip into an
// error state it has no business being in.
{
  reset();
  const slowOld = deferred<Reply>();
  handler = (n) => (n === 1 ? slowOld.promise : { status: 200, body: snapshot(11, { tracks: 4 }) });

  const old = st().load();
  const fresh = st().load();
  await fresh;
  assert.equal(st().status, 'ready');

  slowOld.resolve('network-error');
  await old;
  await settle();
  assert.equal(st().status, 'ready', 'a stale failure never overwrites a newer success');
  assert.equal(st().error, null);
  assert.equal(st().counts?.tracks, 4);
  assert.equal(st().revision, 11);
}

// A failed refresh keeps the last good counts and reports the error.
{
  reset();
  handler = () => ({ status: 200, body: snapshot(4, { tracks: 6, stems: 2 }) });
  await st().load();

  handler = () => 'network-error';
  await st().load();
  assert.equal(st().status, 'error');
  assert.ok(st().error && st().error!.length > 0, 'the failure is reported');
  assert.deepEqual(st().counts, counts({ tracks: 6, stems: 2 }), 'the last good counts survive');
  assert.equal(st().revision, 4);

  // An HTTP error is a failure too, and equally non-destructive.
  handler = () => ({ status: 503, body: { detail: 'library DB not available' } });
  await st().load();
  assert.equal(st().status, 'error');
  assert.deepEqual(st().counts, counts({ tracks: 6, stems: 2 }));

  // Recovery clears the error.
  handler = () => ({ status: 200, body: snapshot(5, { tracks: 7 }) });
  await st().load();
  assert.equal(st().status, 'ready');
  assert.equal(st().error, null);
  assert.equal(st().counts?.tracks, 7);
}

// A payload that is not five non-negative integers plus a revision is refused;
// a half-parsed snapshot never reaches the tab strip.
{
  const good = snapshot(3, { tracks: 2 });
  const bad: unknown[] = [
    null,
    'nope',
    { counts: counts() },                                        // no revision
    { revision: 1 },                                             // no counts
    { revision: 1, counts: { tracks: 1, stems: 1, midi: 1, video: 1 } }, // missing score
    { revision: 1, counts: { ...counts(), stems: -1 } },         // negative
    { revision: 1, counts: { ...counts(), midi: 1.5 } },         // not an integer
    { revision: 1, counts: { ...counts(), video: '3' } },        // not a number
    { revision: 1, counts: { ...counts(), score: Number.NaN } }, // not finite
    { revision: -1, counts: counts() },                          // negative revision
    { revision: 1.5, counts: counts() },                         // fractional revision
  ];
  for (const payload of bad) {
    reset();
    handler = () => ({ status: 200, body: good });
    await st().load();
    assert.equal(st().counts?.tracks, 2);

    handler = () => ({ status: 200, body: payload });
    await st().load();
    assert.equal(st().status, 'error', `rejects ${JSON.stringify(payload)}`);
    assert.deepEqual(st().counts, counts({ tracks: 2 }), `keeps counts for ${JSON.stringify(payload)}`);
    assert.equal(st().revision, 3);
  }
}

// invalidate() coalesces a burst: one request in flight, at most one queued.
{
  reset();
  const first = deferred<Reply>();
  handler = (n) => (n === 1 ? first.promise : { status: 200, body: snapshot(21, { tracks: 8 }) });

  const inFlight = st().load();
  st().invalidate();
  st().invalidate();
  st().invalidate();
  assert.equal(calls, 1, 'nothing extra goes out while a request is in flight');

  first.resolve({ status: 200, body: snapshot(20, { tracks: 1 }) });
  await inFlight;
  await settle();
  assert.equal(calls, 2, 'the whole burst collapses into exactly one follow-up');
  assert.equal(st().revision, 21, 'the follow-up result wins');
  assert.equal(st().counts?.tracks, 8);
  assert.equal(st().status, 'ready');
}

// invalidate() with nothing in flight fetches straight away, and a second
// burst after the queue drained is free to queue again.
{
  reset();
  handler = () => ({ status: 200, body: snapshot(30, { stems: 4 }) });
  st().invalidate();
  await settle();
  assert.equal(calls, 1);
  assert.equal(st().counts?.stems, 4);

  st().invalidate();
  await settle();
  assert.equal(calls, 2, 'a later invalidate is not swallowed by the drained queue');
}

console.log('libraryCountsStore: ok');
