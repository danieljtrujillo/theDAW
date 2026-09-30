/**
 * djRhythmStore — the DJ tab's read-only door onto the rhythm module (DJ-3).
 *
 * `backend/modules/rhythm` already computes downbeats/bars and caches them at
 * `data/rhythm/<id>.json`; TrackInfo, RhythmBlock and lib/rhythmSeed all read
 * it, and the DJ tab never did — so DJ cue seeding and the deck beatgrid were
 * both guessing bar lines off `i % 4`. This store fixes that WITHOUT paying
 * for it: it only ever issues the cheap `GET`, and on a cache miss
 * (`status: 'pending'`) it stops. `POST /run` is a full re-analysis of the
 * audio and has no business firing from a deck load.
 *
 * Run: `npx tsx src/state/djRhythmStore.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const { useDjRhythmStore, invalidateRhythm, RHYTHM_MISS_TTL_MS } = await import('./djRhythmStore.ts');

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  useDjRhythmStore.setState({ byEntry: {} }, false);
  await fn();
  passed++;
  console.log(`  ok ${name}`);
};

type FetchCall = string;
const calls: FetchCall[] = [];

/** Install a fetch that answers every `GET /api/rhythm/<id>` with `body`. */
function stubFetch(body: unknown, ok = true, status = 200) {
  calls.length = 0;
  globalThis.fetch = mock.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

console.log('djRhythmStore');

await test('a ready cache yields its downbeats', async () => {
  stubFetch({ status: 'ready', downbeats: [1.5, 3.5, 5.5], tempo: { bpm: 120, stable: true } });
  const got = await useDjRhythmStore.getState().ensureRhythm('e1');
  assert.ok(got);
  assert.equal(got.ready, true);
  assert.deepEqual(got.downbeats, [1.5, 3.5, 5.5]);
  assert.deepEqual(calls, ['/api/rhythm/e1']);
});

await test('a cache MISS never triggers the expensive /run', async () => {
  stubFetch({ status: 'pending' });
  // `ensureRhythm` resolves to usable data or null; a pending cache is null.
  const got = await useDjRhythmStore.getState().ensureRhythm('e2');
  assert.equal(got, null);
  // Exactly one request, and it is the GET. A `/run` here would re-analyze
  // the whole file every time a deck loads.
  assert.deepEqual(calls, ['/api/rhythm/e2']);
  assert.ok(!calls.some((c) => c.endsWith('/run')));
  // The miss is remembered, so a reload of the same deck is free too.
  assert.equal(useDjRhythmStore.getState().rhythmFor('e2')?.ready, false);
  await useDjRhythmStore.getState().ensureRhythm('e2');
  assert.equal(calls.length, 1, 'a pending entry is not re-fetched');
});

await test('a failed request is recorded, not retried forever', async () => {
  stubFetch({}, false, 500);
  const got = await useDjRhythmStore.getState().ensureRhythm('e3');
  assert.equal(got, null);
  assert.equal(calls.length, 1);
  await useDjRhythmStore.getState().ensureRhythm('e3');
  assert.equal(calls.length, 1, 'a known-failed entry is not re-fetched');
});

await test('a thrown fetch does not reject the caller', async () => {
  calls.length = 0;
  globalThis.fetch = mock.fn(async () => {
    calls.push('boom');
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const got = await useDjRhythmStore.getState().ensureRhythm('e4');
  assert.equal(got, null);
});

await test('a second call is served from the store, not the network', async () => {
  stubFetch({ status: 'ready', downbeats: [2, 4] });
  await useDjRhythmStore.getState().ensureRhythm('e5');
  const again = await useDjRhythmStore.getState().ensureRhythm('e5');
  assert.deepEqual(again?.downbeats, [2, 4]);
  assert.equal(calls.length, 1);
});

await test('concurrent calls for one id share a single request', async () => {
  stubFetch({ status: 'ready', downbeats: [1] });
  const [a, b, c] = await Promise.all([
    useDjRhythmStore.getState().ensureRhythm('e6'),
    useDjRhythmStore.getState().ensureRhythm('e6'),
    useDjRhythmStore.getState().ensureRhythm('e6'),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a?.downbeats, [1]);
  assert.deepEqual(b?.downbeats, [1]);
  assert.deepEqual(c?.downbeats, [1]);
});

/** One bar exactly as `backend/modules/rhythm/engine.py` writes it: the bars
 *  list is `list[dict]`, and the bar's start time is `start_sec`. A stub of
 *  bare numbers here let a store that threw the whole list away look correct
 *  — in production `bars` was always null. */
const bar = (index: number, start: number, end: number) => ({
  index,
  segment: 0,
  start_sec: start,
  end_sec: end,
  beats: 4,
  time_signature: '4/4',
  syncopation: { lhl: 0.1, wnbd: 0.2, offbeat_ratio: 0.3, onsets: 4, low_onsets: 2 },
});

await test('an explicit bars list is kept alongside downbeats', async () => {
  stubFetch({ status: 'ready', downbeats: [1, 3], bars: [bar(0, 1, 3), bar(1, 3, 5), bar(2, 5, 7)] });
  const got = await useDjRhythmStore.getState().ensureRhythm('e7');
  assert.deepEqual(got?.bars, [1, 3, 5]);
  assert.deepEqual(got?.downbeats, [1, 3]);
});

await test('a bar object with no usable start_sec is discarded, not read as 0', async () => {
  stubFetch({
    status: 'ready',
    bars: [bar(0, 2, 4), { index: 1, segment: 0 }, { ...bar(2, 6, 8), start_sec: 'later' }, bar(3, 10, 12)],
  });
  const got = await useDjRhythmStore.getState().ensureRhythm('e14');
  assert.deepEqual(got?.bars, [2, 10]);
});

await test('a MISS is re-checked after its window, not cached for the session', async () => {
  stubFetch({ status: 'pending' });
  await useDjRhythmStore.getState().ensureRhythm('e11');
  assert.equal(calls.length, 1);
  await useDjRhythmStore.getState().ensureRhythm('e11');
  assert.equal(calls.length, 1, 'a fresh miss is not re-fetched');
  // Age the miss past the window. The backend cache is on disk and anything
  // else in the app (TrackInfo, the Rhythm block) can fill it mid-session —
  // a deck loaded twenty minutes later must not still believe the miss.
  const stale = { ...useDjRhythmStore.getState().byEntry.e11, checkedAt: Date.now() - RHYTHM_MISS_TTL_MS - 1 };
  useDjRhythmStore.setState((s) => ({ byEntry: { ...s.byEntry, e11: stale } }), false);
  stubFetch({ status: 'ready', downbeats: [1, 3] });
  const got = await useDjRhythmStore.getState().ensureRhythm('e11');
  assert.deepEqual(got?.downbeats, [1, 3], 'the stale miss was re-fetched');
  assert.equal(calls.length, 1);
});

await test('invalidateRhythm sends the next call back to the network', async () => {
  stubFetch({ status: 'ready', downbeats: [2] });
  await useDjRhythmStore.getState().ensureRhythm('e12');
  assert.equal(calls.length, 1);
  invalidateRhythm('e12');
  assert.equal(useDjRhythmStore.getState().rhythmFor('e12'), null, 'the entry was forgotten');
  await useDjRhythmStore.getState().ensureRhythm('e12');
  assert.equal(calls.length, 2);
});

await test('a fetch already running when invalidateRhythm lands cannot re-store it', async () => {
  // `invalidateRhythm` is called by whoever just changed the cache. If the
  // GET it interrupts is allowed to finish into the store, the caller's
  // "forget this" is undone a few milliseconds later by data that predates
  // the change — and the next deck load reads the stale analysis as final.
  calls.length = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = mock.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    await gate;
    return { ok: true, status: 200, json: async () => ({ status: 'ready', downbeats: [9] }) } as Response;
  }) as unknown as typeof fetch;

  const pending = useDjRhythmStore.getState().ensureRhythm('e15');
  invalidateRhythm('e15');
  release?.();
  assert.equal(await pending, null, 'the late result is discarded, not returned');
  assert.equal(useDjRhythmStore.getState().rhythmFor('e15'), null, 'nothing was stored');

  // …and the entry is still fetchable: the invalidated run did not leave a
  // stuck in-flight promise behind.
  stubFetch({ status: 'ready', downbeats: [4] });
  const got = await useDjRhythmStore.getState().ensureRhythm('e15');
  assert.deepEqual(got?.downbeats, [4]);
  assert.equal(calls.length, 1);
});

await test('invalidateRhythm on an unknown id changes nothing', async () => {
  stubFetch({ status: 'ready', downbeats: [2] });
  await useDjRhythmStore.getState().ensureRhythm('e13');
  const before = useDjRhythmStore.getState().byEntry;
  invalidateRhythm('nope');
  invalidateRhythm('');
  assert.deepEqual(useDjRhythmStore.getState().byEntry, before);
  assert.equal(calls.length, 1);
});

await test('a ready payload with no downbeats reads as no data, not as []', async () => {
  stubFetch({ status: 'ready' });
  const got = await useDjRhythmStore.getState().ensureRhythm('e8');
  assert.equal(got?.downbeats, null);
  assert.equal(got?.bars, null);
});

await test('garbage in the payload is discarded', async () => {
  stubFetch({ status: 'ready', downbeats: 'nope', bars: [1, 'x', Number.NaN, 4] });
  const got = await useDjRhythmStore.getState().ensureRhythm('e9');
  assert.equal(got?.downbeats, null);
  assert.deepEqual(got?.bars, [1, 4]);
});

await test('an empty id is refused without a request', async () => {
  stubFetch({ status: 'ready', downbeats: [1] });
  assert.equal(await useDjRhythmStore.getState().ensureRhythm(''), null);
  assert.equal(calls.length, 0);
});

await test('the id is URL-encoded', async () => {
  stubFetch({ status: 'ready', downbeats: [1] });
  await useDjRhythmStore.getState().ensureRhythm('a b/c');
  assert.deepEqual(calls, ['/api/rhythm/a%20b%2Fc']);
});

await test('rhythmFor reads the store without any request', async () => {
  stubFetch({ status: 'ready', downbeats: [7] });
  assert.equal(useDjRhythmStore.getState().rhythmFor('e10'), null);
  await useDjRhythmStore.getState().ensureRhythm('e10');
  assert.deepEqual(useDjRhythmStore.getState().rhythmFor('e10')?.downbeats, [7]);
  assert.equal(calls.length, 1);
});

console.log(`\ndjRhythmStore: ${passed} passed`);
