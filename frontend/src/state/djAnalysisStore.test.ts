// Run with: npx tsx src/state/djAnalysisStore.test.ts
//
// DJ-1: the DJ tab's analysis storm. Opening the tab used to POST a run for
// every library row the browser had in hand, each one a real backend decode,
// with the deck the user just loaded queued behind all of them. These drive
// the store against a stub backend: the sweep is a capped, replaceable window,
// an explicit request jumps ahead of it, the queue can be paused, runs ask for
// the cheap `dj` profile, a failed entry is retried twice and no sooner than a
// minute, and the parsed row carries the detector's BPM confidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  useDjAnalysisStore,
  analyzeEntries,
  DJ_SWEEP_CAP,
  ANALYSIS_ERROR_RETRY_MS,
  MAX_SWEEP_ANALYSIS_ATTEMPTS,
} from './djAnalysisStore.ts';

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * Await `promise`, but for at most `ms`, and report WHICH won. A regression
 * that strands the queue's awaiters leaves an `await` here pending forever;
 * without this the file would hang rather than fail, and a hung run is
 * indistinguishable from a slow one.
 */
const raceTimeout = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<'settled' | 'timeout'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
  try {
    return await Promise.race([promise.then((): 'settled' => 'settled'), expiry]);
  } finally {
    clearTimeout(timer);
  }
};

// The timeout guard itself: a promise that never settles has to be REPORTED,
// not waited on. Without it a regression that strands the queue's awaiters
// hangs this file instead of failing it, and a hung run looks like a slow one.
{
  assert.equal(await raceTimeout(new Promise<void>(() => {}), 20), 'timeout',
    'the guard must report a promise that never settles');
  assert.equal(await raceTimeout(Promise.resolve(), 20), 'settled');
}

/** Rows the stub backend already has analysed (GET answers from here). */
const ready = new Map<string, Record<string, unknown>>();
/** Ids whose POST /run must fail. */
const failing = new Set<string>();
/** Ids whose POST /run parks until released. */
const holds = new Map<string, Deferred>();
const gets: string[] = [];
const posts: string[] = [];
const postUrls: string[] = [];

/** A clock the test owns, so the 60 s retry window costs no wall time. */
let nowMs = 1_000_000;
const realNow = Date.now;
Date.now = () => nowMs;

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  bpm: 128.0,
  bpm_confidence: 0.82,
  key: 'A',
  scale: 'minor',
  key_confidence: 0.6,
  bars_estimated: 64,
  rms_db: -12.5,
  beats_json: '[0.5, 1.0, 1.5]',
  analyzed_at: 1234.5,
  ...over,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if ((init?.method ?? 'GET') === 'GET') {
    const id = url.replace('/api/analysis/', '');
    gets.push(id);
    const have = ready.get(id);
    return json(have ?? { status: 'pending' });
  }

  const id = url.slice('/api/analysis/'.length).split('/')[0];
  posts.push(id);
  postUrls.push(url);
  const hold = holds.get(id);
  if (hold) {
    holds.delete(id);
    await hold.promise;
  }
  if (failing.has(id)) return json({ detail: 'nope' }, 500);
  const produced = row({ bpm: 120.0 });
  ready.set(id, produced);
  return json(produced);
}) as typeof fetch;

const st = () => useDjAnalysisStore.getState();

/** Wait for every queued analysis to finish: a sentinel appended to the SWEEP
 *  lane resolves only after everything ahead of it has run. Valid only while
 *  no `analyzeAll` runs concurrently — a new window would promote this
 *  awaited sentinel into the request lane, ahead of the work being waited
 *  for. Every call below drains AFTER the last `analyzeAll` of its block. */
let sentinelSeq = 0;
const drain = async (): Promise<void> => {
  sentinelSeq += 1;
  const id = `__drain_${sentinelSeq}`;
  ready.set(id, row());
  await st().ensureAnalyzed(id, { priority: false });
};

// ── the run uses the cheap DJ profile, and the parsed row keeps its fields ──
{
  await st().ensureAnalyzed('dj-profile');
  assert.deepEqual(posts, ['dj-profile']);
  assert.equal(postUrls[0], '/api/analysis/dj-profile/run?profile=dj',
    'a DJ run must ask for the deck-only profile, not a full analysis');

  const entry = st().byId['dj-profile'];
  assert.equal(entry.status, 'ready');
  assert.equal(entry.data?.bpm, 120.0);
  assert.equal(entry.data?.bpm_confidence, 0.82, 'the detector confidence reaches the deck');
  // The beats/beats_json tolerance the decks depend on is untouched.
  assert.deepEqual(entry.data?.beats, [0.5, 1.0, 1.5]);
  assert.equal(entry.data?.key, 'A');
  assert.equal(entry.data?.rms_db, -12.5);
}

// A cached row is taken from the GET; no run is posted for it.
{
  posts.length = 0;
  ready.set('already', row({ bpm: 90.0, beats: [1, 2], bpm_confidence: 0.3 }));
  await st().ensureAnalyzed('already');
  assert.deepEqual(posts, [], 'an analysed entry must not be re-run');
  assert.equal(st().byId['already'].data?.bpm, 90.0);
  assert.equal(st().byId['already'].data?.bpm_confidence, 0.3);
  assert.deepEqual(st().byId['already'].data?.beats, [1, 2], 'a parsed beats array is accepted too');
}

// ── analyzeAll is a CAPPED working set ──────────────────────────────────────
{
  posts.length = 0;
  await st().analyzeAll(Array.from({ length: 50 }, (_, i) => `cap_${i}`), { cap: 3 });
  await drain();
  const swept = posts.filter((id) => id.startsWith('cap_'));
  assert.deepEqual(swept, ['cap_0', 'cap_1', 'cap_2'],
    'the sweep must stop at the cap, in the order the caller ranked them');
}

// The default cap is the documented one: everything past it is dropped.
{
  posts.length = 0;
  await st().analyzeAll(Array.from({ length: DJ_SWEEP_CAP + 9 }, (_, i) => `dflt_${i}`));
  await drain();
  const swept = posts.filter((id) => id.startsWith('dflt_'));
  assert.equal(swept.length, DJ_SWEEP_CAP);
  assert.equal(swept[0], 'dflt_0');
  assert.equal(swept.at(-1), `dflt_${DJ_SWEEP_CAP - 1}`);
}

// ── a later sweep REPLACES the window: scrolled-away rows stop costing ──────
{
  posts.length = 0;
  const hold = deferred();
  holds.set('win_0', hold);
  void st().analyzeAll(['win_0', 'win_1', 'win_2'], { cap: 3 });
  // Let the first run start and park inside its POST.
  await new Promise((r) => setTimeout(r, 5));
  // The browser scrolled: a new window, none of the old rows in it.
  await st().analyzeAll(['win_9'], { cap: 3 });
  hold.resolve();
  await drain();
  assert.deepEqual(posts, ['win_0', 'win_9'],
    'rows that left the window must not be analysed after the window moved');
}

// ── an explicit request jumps the whole sweep ───────────────────────────────
{
  posts.length = 0;
  const hold = deferred();
  holds.set('jump_a', hold);
  void st().analyzeAll(['jump_a', 'jump_b', 'jump_c'], { cap: 3 });
  await new Promise((r) => setTimeout(r, 5));
  // A deck loads while the sweep is mid-flight.
  const deckLoad = st().ensureAnalyzed('deck_now');
  hold.resolve();
  await deckLoad;
  await drain();
  assert.equal(posts[0], 'jump_a', 'the run already in flight is not abandoned');
  assert.equal(posts[1], 'deck_now', 'a deck load must not wait behind the browsing sweep');
  assert.deepEqual(posts.slice(2), ['jump_b', 'jump_c']);
}

// analyzeEntries (setlist / VJ) is an explicit request too: a sweep can
// neither delay nor discard it.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('set_a', hold);
  void st().analyzeAll(['set_a', 'set_b'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 5));
  analyzeEntries(['added_1', null, undefined, 'added_1']);
  await st().analyzeAll(['unrelated'], { cap: 2 });
  hold.resolve();
  await drain();
  assert.deepEqual(posts, ['set_a', 'added_1', 'unrelated'],
    'an added track keeps its place when the sweep window is replaced');
}

// ── pause / resume ──────────────────────────────────────────────────────────
{
  posts.length = 0;
  st().pauseQueue();
  await st().analyzeAll(['pause_a', 'pause_b'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(posts, [], 'a paused queue must not start new analyses');
  st().resumeQueue();
  await drain();
  assert.deepEqual(posts, ['pause_a', 'pause_b'], 'resume drains what was queued');
}

// The run already in flight when pause is called still finishes.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('inflight', hold);
  void st().analyzeAll(['inflight', 'after_pause'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 5));
  st().pauseQueue();
  hold.resolve();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(posts, ['inflight'], 'the in-flight run completes; the next one waits');
  assert.equal(st().byId['inflight'].status, 'ready');
  st().resumeQueue();
  await drain();
  assert.deepEqual(posts, ['inflight', 'after_pause']);
}

// ── a failed sweep entry backs off, doubling, then the sweep gives up ──────
{
  posts.length = 0;
  failing.add('flaky');
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(st().byId['flaky'].status, 'error');
  assert.deepEqual(posts, ['flaky']);

  // Nothing before the first window.
  nowMs += ANALYSIS_ERROR_RETRY_MS - 1;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.deepEqual(posts, ['flaky'], 'a failing entry must not be re-hammered');

  // 60 s: attempt two.
  nowMs += 2;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(posts.length, 2, 'the first retry lands after 60 s');

  // The wait DOUBLES: 60 s more is not enough, 120 s is.
  nowMs += ANALYSIS_ERROR_RETRY_MS;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(posts.length, 2, 'the second wait is 120 s, not another 60 s');
  nowMs += ANALYSIS_ERROR_RETRY_MS;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(posts.length, 3, 'the second retry lands after 120 s');

  // There is no third wait: the attempt cap ends the ladder after the second
  // retry, so the doubled 240 s step is never served.
  nowMs += ANALYSIS_ERROR_RETRY_MS * 4;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(posts.length, 3,
    'the served ladder is 60 s then 120 s; after the third failure the sweep gives up');
  assert.equal(MAX_SWEEP_ANALYSIS_ATTEMPTS, 3);

  // However long it waits, the sweep is done with this row.
  nowMs += ANALYSIS_ERROR_RETRY_MS * 1000;
  await st().analyzeAll(['flaky'], { cap: 1 });
  await drain();
  assert.equal(posts.length, 3, 'the sweep gives up rather than retrying forever');

  // But a user asking for it by name runs it anyway — and the ladder resets.
  failing.delete('flaky');
  await st().ensureAnalyzed('flaky');
  assert.equal(posts.length, 4, 'a deck load must override the sweep giving up');
  assert.equal(st().byId['flaky'].status, 'ready');
}

// A priority request for an entry still inside its backoff runs immediately.
{
  posts.length = 0;
  failing.add('cooling');
  await st().analyzeAll(['cooling'], { cap: 1 });
  await drain();
  assert.deepEqual(posts, ['cooling']);
  // Well inside the 60 s window the sweep would skip it...
  await st().analyzeAll(['cooling'], { cap: 1 });
  await drain();
  assert.deepEqual(posts, ['cooling']);
  // ...and a user request does not.
  failing.delete('cooling');
  await st().ensureAnalyzed('cooling');
  assert.deepEqual(posts, ['cooling', 'cooling'], 'priority ignores the backoff');
  assert.equal(st().byId['cooling'].status, 'ready');
}

// ── an awaited id is never dropped by a window change ──────────────────────
{
  posts.length = 0;
  const hold = deferred();
  holds.set('busy', hold);
  void st().analyzeAll(['busy'], { cap: 1 });
  await new Promise((r) => setTimeout(r, 5));
  // Queued behind the running one, in the sweep lane, and awaited.
  let resolved = false;
  const awaited = st().ensureAnalyzed('awaited_row', { priority: false }).then(() => { resolved = true; });
  // The browser scrolls: the new window has neither of them.
  await st().analyzeAll(['elsewhere'], { cap: 1 });
  hold.resolve();
  await awaited;
  assert.ok(resolved);
  assert.ok(posts.includes('awaited_row'),
    'an awaited id was dropped by a window change and its promise resolved having done nothing');
  assert.equal(st().byId['awaited_row'].status, 'ready');
  await drain();
}

// ── a throw inside the queue loop releases awaiters and keeps the consumer ──
{
  posts.length = 0;
  let thrown = 0;
  const unsubscribe = useDjAnalysisStore.subscribe(() => {
    // A component selector blowing up during setState: the throw propagates
    // out of the store write and into the queue's loop body.
    if (thrown === 0 && useDjAnalysisStore.getState().byId['boom']?.status === 'running') {
      thrown += 1;
      throw new Error('a subscriber exploded');
    }
  });
  try {
    const first = st().ensureAnalyzed('boom');
    assert.equal(await raceTimeout(first, 2_000), 'settled',
      'a throw inside the queue loop left every awaiter of that id pending forever');
    assert.equal(thrown, 1, 'the test did not reproduce a throw inside the loop');
  } finally {
    unsubscribe();
  }
  // The consumer survived: the next entry still runs.
  await st().ensureAnalyzed('after_boom');
  assert.ok(posts.includes('after_boom'), 'one throw killed the queue consumer');
  assert.equal(st().byId['after_boom'].status, 'ready');

  // And the entry the throw interrupted is not stranded. It was left mid-run,
  // so its status is whatever the interrupted write set — and a status of
  // 'running' is never eligible, which would make every later request for it
  // a silent no-op: the deck asks, nothing runs, the promise resolves, the
  // row stays empty forever.
  posts.length = 0;
  await st().ensureAnalyzed('boom', { priority: true });
  assert.ok(posts.includes('boom'),
    'the interrupted entry stayed "running" forever: ensureAnalyzed can never run it again');
  assert.equal(st().byId['boom'].status, 'ready');
}

// ── a subscriber that is broken FOR GOOD still cannot strand an entry ──────
// The queue's recovery writes the entry to 'error' through the same setState
// that just exploded, so a subscriber that throws every time makes the
// recovery itself the thing that fails.
{
  const breakEverythingFor = (id: string) => {
    let thrown = 0;
    const stop = useDjAnalysisStore.subscribe(() => {
      if (useDjAnalysisStore.getState().byId[id]) {
        thrown += 1;
        throw new Error('a subscriber that stays broken');
      }
    });
    return { count: () => thrown, stop };
  };

  const sweepCase = breakEverythingFor('stuck');
  assert.equal(await raceTimeout(st().ensureAnalyzed('stuck'), 2_000), 'settled');
  sweepCase.stop();
  assert.ok(sweepCase.count() >= 2, 'the recovery write never threw: the case is not reproduced');
  // zustand commits the next state BEFORE it notifies, so the 'error' write
  // landed even though delivering it exploded.
  assert.equal(st().byId['stuck'].status, 'error');
  // The failure belongs to the subscriber, not to the file, so it must not
  // spend the file's retry ladder: the browsing sweep runs it right away.
  posts.length = 0;
  await st().analyzeAll(['stuck'], { cap: 1 });
  await drain();
  assert.ok(posts.includes('stuck'),
    'a broken subscriber put the FILE into backoff: the sweep will not touch it for a minute');
  assert.equal(st().byId['stuck'].status, 'ready');

  // ...and an explicit request revives it too.
  const priorityCase = breakEverythingFor('stuck_p');
  assert.equal(await raceTimeout(st().ensureAnalyzed('stuck_p'), 2_000), 'settled');
  priorityCase.stop();
  assert.ok(priorityCase.count() >= 2);
  posts.length = 0;
  await st().ensureAnalyzed('stuck_p', { priority: true });
  assert.ok(posts.includes('stuck_p'), 'a priority request could not revive the entry');
  assert.equal(st().byId['stuck_p'].status, 'ready');
}

// ── PR #207 review: a deck load never waits behind the sweep ──────────────
// The sequence from the DJ tab: the browsing sweep's row is inside its POST
// (a full backend decode, seconds long) when the user loads a track on a
// deck. Both lanes fed ONE serial consumer, so the deck's run could not start
// until the sweep row came back.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('sweep_busy', hold);
  void st().analyzeAll(['sweep_busy', 'sweep_next'], { cap: 2 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(posts, ['sweep_busy'], 'the sweep row is in flight');

  const deckLoad = st().ensureAnalyzed('deck_live');
  assert.equal(await raceTimeout(deckLoad, 500), 'settled',
    'the deck load waited for the sweep row the queue was on');
  assert.deepEqual(posts, ['sweep_busy', 'deck_live'],
    'the deck run started while the sweep row was still decoding');
  assert.equal((await deckLoad)?.bpm, 120, 'and resolves with the deck’s analysis');

  hold.resolve();
  await drain();
  assert.deepEqual(posts, ['sweep_busy', 'deck_live', 'sweep_next'], 'the sweep carries on after it');
  assert.equal(posts.filter((id) => id === 'deck_live').length, 1, 'the deck row is not re-run by the queue');
}

// A paused queue holds the sweep, not the user: a deck load still runs.
{
  posts.length = 0;
  st().pauseQueue();
  await st().analyzeAll(['paused_row'], { cap: 1 });
  assert.equal(await raceTimeout(st().ensureAnalyzed('deck_while_paused'), 500), 'settled',
    'a deck load waited for resumeQueue');
  assert.deepEqual(posts, ['deck_while_paused'], 'and the paused sweep still did not start');
  st().resumeQueue();
  await drain();
  assert.deepEqual(posts, ['deck_while_paused', 'paused_row']);
}

// ── ensureAnalyzed on a RUNNING entry waits for that run and returns its data ─
// The sequence: a deck load starts the run, and a second caller (the second
// deck loading the same track, or chimeraClient reading beats for a clip)
// asks while it is in flight. The second call used to return at once — the
// entry was 'running', so not eligible — and the caller read an empty row.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('twice', hold);
  const first = st().ensureAnalyzed('twice');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(st().byId['twice'].status, 'running');

  const second = st().ensureAnalyzed('twice');
  assert.equal(await raceTimeout(second, 50), 'timeout',
    'ensureAnalyzed returned while the entry was still running');
  hold.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(b?.bpm, 120, 'the second caller gets the run’s result');
  assert.deepEqual(a, b);
  assert.deepEqual(posts, ['twice'], 'one run served both callers');
}

// The same when the run in flight is the SWEEP's: a deck load for the row the
// consumer is on joins that run instead of returning empty-handed.
{
  posts.length = 0;
  const hold = deferred();
  holds.set('swept_then_loaded', hold);
  void st().analyzeAll(['swept_then_loaded'], { cap: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const deckLoad = st().ensureAnalyzed('swept_then_loaded');
  assert.equal(await raceTimeout(deckLoad, 50), 'timeout',
    'the deck load returned before the sweep’s run of its row finished');
  hold.resolve();
  assert.equal((await deckLoad)?.bpm, 120);
  await drain();
  assert.deepEqual(posts, ['swept_then_loaded'], 'the row was decoded once');
}

// ── DJView hands the sweep its ranking, not the raw row order ──────────────
// A source pin (b12/dj3 style): the cap only means anything if the caller
// ranks what it passes, and that ranking lives in DJView's one sweep call.
{
  const djView = readFileSync(new URL('../views/DJView.tsx', import.meta.url), 'utf8');
  const call = djView.slice(djView.indexOf('void analyzeAll('));
  const body = call.slice(0, call.indexOf(');') + 2);
  const at = (needle: string): number => body.indexOf(needle);
  assert.ok(at('deckATrack') >= 0 && at('deckBTrack') >= 0, 'the loaded decks must be swept first');
  assert.ok(at('activeSet') > at('deckATrack'), 'the active set comes after the decks');
  assert.ok(at('entries.map') > at('activeSet'), 'the visible rows come last');
  assert.ok(!/Scrolling the browser brings more into range/.test(djView),
    'the comment still describes the old unbounded sweep');
}

Date.now = realNow;
console.log('djAnalysisStore: all assertions passed');
