// Run with: npx tsx src/components/audio/peaksDecodeScheduler.test.ts
/**
 * FE-007 — which clips need a peaks decode started right now, and a small
 * queue capping how many run at once.
 *
 * History: the effect used to share ONE `cancelled` flag across its whole
 * scan, so ANY `clips` change aborted every in-flight decode and rescanned
 * from the top. Keying per clip id fixed that restart bug, but exposed a
 * second one an audit caught: `acceptInpaint` (and switching a take) REPLACE
 * a clip's `audioBlob` (and clear its `peaks`) while a decode for the OLD
 * blob may still be running. Keyed on id alone, the effect saw the id was
 * "in flight" and skipped the clip; the stale decode then settled and wrote
 * the OLD audio's peaks onto the clip that now held NEW audio, and the new
 * audio was never decoded. Keying on id+blob fixed that — but a re-audit
 * caught a THIRD bug: `pump` started the new blob by OVERWRITING `running`'s
 * entry for the same id, so the OLD (still physically running) decode
 * silently stopped being counted, and the concurrency cap could be exceeded.
 * `pump` now refuses to start an item whose id is already running.
 */
import assert from 'node:assert/strict';
import { clipsNeedingPeaksDecode, createPeaksDecodeQueue, pruneFailedBlobs } from './peaksDecodeScheduler';

interface Clip { id: string; peaks?: unknown; audioBlob: string }

// --- clipsNeedingPeaksDecode: pure clip-state read --------------------------
{
  assert.deepEqual(clipsNeedingPeaksDecode<string>([]), []);

  const clips: Clip[] = [
    { id: 'a', peaks: 'p', audioBlob: 'blobA' },
    { id: 'b', audioBlob: 'blobB' },
  ];
  assert.deepEqual(clipsNeedingPeaksDecode(clips), [{ id: 'b', blob: 'blobB' }]);
}

// --- clipsNeedingPeaksDecode: a failed blob is not retried until it changes -
{
  const clips: Clip[] = [{ id: 'a', audioBlob: 'blobA' }, { id: 'b', audioBlob: 'blobB' }];

  // 'a' previously failed on exactly this blob: excluded.
  const failed = new Map([['a', 'blobA']]);
  assert.deepEqual(clipsNeedingPeaksDecode(clips, failed), [{ id: 'b', blob: 'blobB' }]);

  // The SAME clip id with a NEW blob is not the one that failed: included.
  const clipsNewBlob: Clip[] = [{ id: 'a', audioBlob: 'blobA2' }, { id: 'b', audioBlob: 'blobB' }];
  assert.deepEqual(clipsNeedingPeaksDecode(clipsNewBlob, failed), [
    { id: 'a', blob: 'blobA2' },
    { id: 'b', blob: 'blobB' },
  ]);

  // No failures recorded (the default): nothing excluded.
  assert.deepEqual(clipsNeedingPeaksDecode(clips), [{ id: 'a', blob: 'blobA' }, { id: 'b', blob: 'blobB' }]);
}

// --- pruneFailedBlobs: a removed clip's failure entry is dropped -----------
// (re-audit MAJOR #2: `peaksFailedBlob` pinned a deleted clip's Blob forever,
// since nothing ever removed its entry once the clip itself was gone.)
{
  const failed = new Map([['a', 'blobA'], ['b', 'blobB'], ['c', 'blobC']]);

  // Only 'a' and 'c' still exist as clips; 'b' was deleted.
  const pruned = pruneFailedBlobs(failed, new Set(['a', 'c']));
  assert.deepEqual([...pruned.entries()].sort(), [['a', 'blobA'], ['c', 'blobC']]);
  assert.equal(failed.size, 3, 'the input map is not mutated');

  // No live clips at all: everything dropped.
  assert.deepEqual(pruneFailedBlobs(failed, new Set()), new Map());

  // Empty input: empty output, no throw.
  assert.deepEqual(pruneFailedBlobs(new Map(), new Set(['a'])), new Map());
}

// --- createPeaksDecodeQueue: concurrency cap --------------------------------
{
  const queue = createPeaksDecodeQueue<string>(2);
  const started: string[] = [];
  const start = (item: { id: string; blob: string }) => { started.push(item.id); };

  queue.sync(
    [{ id: 'a', blob: 'A' }, { id: 'b', blob: 'B' }, { id: 'c', blob: 'C' }],
    start,
  );
  // Only 2 (the cap) start immediately; 'c' waits.
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(queue.has('c', 'C'), true);
  assert.equal(queue.has('a', 'A'), true);

  // A re-sync with the same needed list (another unrelated clip changed,
  // re-running the effect) must not start 'a'/'b' again or re-queue 'c'.
  queue.sync(
    [{ id: 'a', blob: 'A' }, { id: 'b', blob: 'B' }, { id: 'c', blob: 'C' }],
    start,
  );
  assert.deepEqual(started, ['a', 'b']);

  // 'a' settles: 'c' starts, freeing nothing else since only one slot opened.
  queue.settle('a', 'A', start);
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(queue.has('a', 'A'), false);
  assert.equal(queue.has('c', 'C'), true);
}

// --- A queued (not yet started) item that's no longer needed is dropped ----
{
  const queue = createPeaksDecodeQueue<string>(1);
  const started: string[] = [];
  const start = (item: { id: string; blob: string }) => { started.push(item.id); };

  queue.sync([{ id: 'a', blob: 'A' }, { id: 'b', blob: 'B' }], start);
  assert.deepEqual(started, ['a']); // cap 1: 'b' queued, not started

  // 'b' got peaks another way before its turn — no longer in `needed`.
  queue.sync([{ id: 'a', blob: 'A' }], start);
  assert.equal(queue.has('b', 'B'), false);

  queue.settle('a', 'A', start);
  assert.deepEqual(started, ['a'], "'b' must not start: it was dropped from the queue");
}

// --- THE regression: a blob swap while the old blob is still decoding ------
// A second decode for the SAME id must NEVER start while the first is still
// running — it stays queued, however many free slots the cap has — so
// settling the stale one never has to "not evict" anything: there is nothing
// running to evict yet.
{
  const queue = createPeaksDecodeQueue<string>(2);
  const started: Array<{ id: string; blob: string }> = [];
  const start = (item: { id: string; blob: string }) => { started.push(item); };

  // Clip 'x' starts decoding blob 'old'.
  queue.sync([{ id: 'x', blob: 'old' }], start);
  assert.deepEqual(started, [{ id: 'x', blob: 'old' }]);

  // acceptInpaint / a take switch replaces 'x's audio mid-decode: the same
  // clip id now needs 'new', not 'old'. A second clip 'y' needs a decode too.
  queue.sync([{ id: 'x', blob: 'new' }, { id: 'y', blob: 'Y' }], start);
  // 'new' is NOT the same as the running 'old' decode, so it is tracked
  // (queued) — but it must NOT have started yet: 'x' already has a decode
  // running, and starting a second one for the same id would run two real
  // decodes for 'x' at once.
  assert.equal(queue.has('x', 'new'), true);
  assert.equal(queue.has('y', 'Y'), true);
  assert.deepEqual(started, [{ id: 'x', blob: 'old' }, { id: 'y', blob: 'Y' }], "'x new' stays queued, not started");

  // The STALE 'old' decode finally settles. NOW 'x new' gets its turn.
  queue.settle('x', 'old', start);
  assert.deepEqual(
    started,
    [{ id: 'x', blob: 'old' }, { id: 'y', blob: 'Y' }, { id: 'x', blob: 'new' }],
    "'x new' starts only once 'old' has fully settled",
  );

  queue.settle('x', 'new', start);
  queue.settle('y', 'Y', start);
  assert.equal(queue.has('x', 'new'), false);
  assert.equal(queue.has('y', 'Y'), false);
}

// --- A stale settle (wrong blob) must not evict a newer running entry ------
// Reachable if the caller ever settles out of order for some other reason;
// pinned here independently of the "never start two at once" behavior above.
{
  const queue = createPeaksDecodeQueue<string>(2);
  const started: Array<{ id: string; blob: string }> = [];
  const start = (item: { id: string; blob: string }) => { started.push(item); };

  queue.sync([{ id: 'x', blob: 'old' }], start);
  queue.settle('x', 'old', start); // frees 'x'
  queue.sync([{ id: 'x', blob: 'new' }], start); // 'new' starts (nothing running for 'x')
  assert.deepEqual(started, [{ id: 'x', blob: 'old' }, { id: 'x', blob: 'new' }]);

  // A settle for the OLD blob arrives again (should not happen twice in
  // practice, but the guard is keyed on the exact blob for exactly this): it
  // must not touch the 'new' entry that is actually running now.
  queue.settle('x', 'old', start);
  assert.equal(queue.has('x', 'new'), true, "a stale settle for 'old' must not evict 'new'");
}

// --- Invariant sweep: never > concurrency in flight, never > 1 per clip id -
// A scripted sequence of syncs/settles across several clips and blob swaps,
// checking the invariant after EVERY step rather than at one hand-picked
// point.
{
  const concurrency = 2;
  const queue = createPeaksDecodeQueue<string>(concurrency);
  const runningNow = new Set<string>(); // "id:blob" tokens currently started-but-not-settled
  const perId = new Map<string, number>(); // id -> count of tokens for that id currently running

  const token = (id: string, blob: string) => `${id}:${blob}`;
  const start = (item: { id: string; blob: string }) => {
    runningNow.add(token(item.id, item.blob));
    perId.set(item.id, (perId.get(item.id) ?? 0) + 1);
    assert.ok(runningNow.size <= concurrency, `never more than ${concurrency} in flight (got ${runningNow.size})`);
    assert.ok((perId.get(item.id) ?? 0) <= 1, `never more than 1 in flight for clip ${item.id}`);
  };
  const settle = (id: string, blob: string) => {
    runningNow.delete(token(id, blob));
    perId.set(id, (perId.get(id) ?? 1) - 1);
    queue.settle(id, blob, start);
  };

  queue.sync([{ id: 'a', blob: 'a1' }, { id: 'b', blob: 'b1' }, { id: 'c', blob: 'c1' }], start);
  // 'a' swaps blob twice while its first decode is still in flight.
  queue.sync([{ id: 'a', blob: 'a2' }, { id: 'b', blob: 'b1' }, { id: 'c', blob: 'c1' }], start);
  queue.sync([{ id: 'a', blob: 'a3' }, { id: 'b', blob: 'b1' }, { id: 'c', blob: 'c1' }], start);
  settle('a', 'a1');
  settle('b', 'b1');
  queue.sync([{ id: 'a', blob: 'a3' }, { id: 'd', blob: 'd1' }], start);
  settle('c', 'c1');
  settle('a', 'a3');
  settle('d', 'd1');
  assert.equal(runningNow.size, 0, 'everything drains to empty');
}

// --- dispose(): drops pending items; running ones are left to finish -------
{
  const queue = createPeaksDecodeQueue<string>(1);
  const started: string[] = [];
  const start = (item: { id: string; blob: string }) => { started.push(item.id); };

  queue.sync([{ id: 'a', blob: 'A' }, { id: 'b', blob: 'B' }, { id: 'c', blob: 'C' }], start);
  assert.deepEqual(started, ['a']); // cap 1: 'b', 'c' queued

  queue.dispose();
  assert.equal(queue.has('b', 'B'), false, 'a pending item is dropped by dispose');
  assert.equal(queue.has('c', 'C'), false);
  // The running one ('a') is untouched — it cannot be aborted.
  assert.equal(queue.has('a', 'A'), true);

  // Settling the still-running one after dispose starts nothing new.
  queue.settle('a', 'A', start);
  assert.deepEqual(started, ['a'], 'dispose: nothing queued starts after the fact');

  // A sync after dispose is a no-op too.
  queue.sync([{ id: 'd', blob: 'D' }], start);
  assert.deepEqual(started, ['a']);
  assert.equal(queue.has('d', 'D'), false);
}

// --- concurrency must be a positive integer ---------------------------------
{
  assert.throws(() => createPeaksDecodeQueue(0), RangeError);
  assert.throws(() => createPeaksDecodeQueue(-1), RangeError);
  assert.throws(() => createPeaksDecodeQueue(1.5), RangeError);
}

console.log('peaksDecodeScheduler: ok');
