/**
 * `analyzeBufferAsync` — the Worker offload path (DJ-2).
 *
 * The sibling `DJSemanticWaveform.b12.test.ts` pins the NO-Worker half: under
 * node/tsx `Worker` is undefined, so the async entry point falls back to the
 * synchronous analysis. That leaves the half that actually matters in the
 * browser — the offload itself — unpinned, so this file installs a fake
 * `Worker` BEFORE importing the module (the module memoises its worker in
 * module state, so the global has to exist at import time) and pins:
 *
 *  - the analysis really leaves the main thread (the resolved bins are the
 *    ones the worker sent, so nothing recomputed them here);
 *  - exactly ONE worker is ever constructed, shared by every request;
 *  - two instances mounting together share ONE in-flight request — the
 *    default DJ layout mounts two `DJSemanticWaveform`s per deck and they
 *    must not analyse the same audio twice;
 *  - the worker is fed COPIES of the channel data, never the `AudioBuffer`'s
 *    own arrays: `postMessage` DETACHES what it transfers, and detaching the
 *    engine's channel storage would silence the deck that is playing it;
 *  - a worker that reports an error falls back to the in-process analysis
 *    rather than leaving the lane blank, and stays usable afterwards;
 *  - (PR #207 review) another analysis of the same audio — a resize or zoom
 *    that changes the bin count — sends no channel data: the main thread no
 *    longer copies the whole decoded buffer per step;
 *  - an aborted analysis (a lane that unmounted) rejects, leaves nothing
 *    pending and stops the worker computing it;
 *  - a worker that dies is replaced, up to a limit, and a worker that goes
 *    silent is timed out and replaced the same way. One error used to end the
 *    Worker for the rest of the session, and silence hung the lane forever.
 *
 * Run: `npx tsx src/components/audio/djSemanticWaveformAnalysis.worker.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { WaveBin } from './djSemanticWaveformAnalysis.ts';

const g = globalThis as unknown as Record<string, unknown>;

// ── fake Worker + the `document` its availability check requires ───────────

type AnalyzeMessage = {
  type: 'analyze';
  id: number;
  dataKey: string;
  channels?: Float32Array[];
  length: number;
  sampleRate: number;
  bins: number;
  normalize: boolean;
};
type AnalyzeRequest = AnalyzeMessage | { type: 'drop'; dataKey: string | null };
type AnalyzeResponse = { id: number; bins: WaveBin[] } | { id: number; error: string } | { id: number; missing: true };

/** A recognisable result the main thread could not possibly have computed:
 *  if `analyzeBufferAsync` resolves to THIS array, the work really happened
 *  on the other side of the `postMessage`. */
function sentinelBins(tag: string): WaveBin[] {
  return [
    { peak: 1, rms: 1, min: -1, max: 1, low: 1, mid: 1, bright: 1, transient: 1, color: tag, clipped: 0 },
  ];
}

type Post = { message: AnalyzeMessage; transfer: unknown[] };

/** `silent`: take the request and never answer (a wedged worker). */
let replyMode: 'bins' | 'error' | 'throw' | 'silent' = 'bins';
let replyTag = 'worker-0';

class FakeWorker {
  static instances = 0;
  static posts: Post[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: AnalyzeResponse }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  /** The audio this worker holds between requests, as the real one does. */
  held: string | null = null;
  constructor(_url: URL, _opts?: unknown) {
    FakeWorker.instances += 1;
    FakeWorker.last = this;
  }
  postMessage(message: AnalyzeRequest, transfer: unknown[] = []): void {
    // A structured-clone failure (a detached buffer, a value the algorithm
    // refuses) throws synchronously out of postMessage.
    if (replyMode === 'throw') throw new DOMException('Failed to execute postMessage', 'DataCloneError');
    if (message.type === 'drop') {
      if (message.dataKey === null || message.dataKey === this.held) this.held = null;
      return;
    }
    FakeWorker.posts.push({ message, transfer });
    const mode = replyMode;
    const tag = replyTag;
    if (mode === 'silent') return;
    // A real worker answers on a later turn of the event loop; replying
    // synchronously here would hide ordering bugs in the pending-request map.
    queueMicrotask(() => {
      if (this.terminated) return;
      if (message.channels) this.held = message.dataKey;
      else if (this.held !== message.dataKey) {
        this.onmessage?.({ data: { id: message.id, missing: true } });
        return;
      }
      this.onmessage?.({
        data: mode === 'error' ? { id: message.id, error: 'worker blew up' } : { id: message.id, bins: sentinelBins(tag) },
      });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

g.Worker = FakeWorker;
// `getAnalysisWorker` refuses to build a Worker without a `document` (that is
// how it detects "we are ourselves inside a worker"). A bare object is enough.
g.document = g.document ?? {};

const {
  MAX_WORKER_FAILURES,
  WORKER_SILENCE_MS,
  analysisWorkerFailures,
  analyzeBufferAsync,
  analyzeChannels,
  binCountFor,
  evictAnalysis,
  pendingAnalysisCount,
} = await import('./djSemanticWaveformAnalysis.ts');

/** Await `promise` for at most `ms` and report which won, so a regression
 *  that never settles fails this file instead of hanging it. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ settled: false }>((r) => {
    timer = setTimeout(() => r({ settled: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ settled: true as const, value })), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

// ── fixture ───────────────────────────────────────────────────────────────

/** Stereo, with `duration` driving the BIN COUNT and `length` the loop work,
 *  so a cheap fixture can still stand in for a 3.5-minute track's sizing. */
function stereoBuffer(counter: { calls: number }, duration = 210): AudioBuffer {
  const length = 20000;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = Math.sin(i * 0.01) * 0.6;
    right[i] = Math.sin(i * 0.013) * 0.4;
  }
  return {
    numberOfChannels: 2,
    length,
    duration,
    sampleRate: 44100,
    getChannelData(ch: number) {
      counter.calls += 1;
      return ch === 0 ? left : right;
    },
  } as unknown as AudioBuffer;
}

// ── the analysis leaves the main thread ───────────────────────────────────

{
  evictAnalysis('worker-a.wav');
  FakeWorker.posts = [];
  replyMode = 'bins';
  replyTag = 'from-worker';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const bins = await analyzeBufferAsync('worker-a.wav', buffer, { normalize: true, width: 1200 });

  assert.equal(FakeWorker.instances, 1, 'one Worker is constructed for the whole module');
  assert.equal(FakeWorker.posts.length, 1, 'and the analysis is posted to it exactly once');
  assert.equal(bins[0].color, 'from-worker', 'the resolved bins are the WORKER’s — nothing recomputed them here');
  assert.equal(bins.length, 1, 'the main thread did not analyse the buffer itself');

  const request = FakeWorker.posts[0].message;
  assert.equal(request.bins, binCountFor(210, 1200), 'the worker is told the width-derived bin count');
  assert.equal(request.normalize, true);
  assert.equal(request.length, buffer.length);
  assert.equal(request.sampleRate, buffer.sampleRate);
  assert.equal(request.channels?.length, 2, 'both channels are sent');
}

// ── the worker gets COPIES, never the buffer's own channel storage ─────────

{
  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const liveLeft = buffer.getChannelData(0);
  const sent = FakeWorker.posts[0].message.channels;
  assert.ok(sent, 'the first request carried the audio');

  assert.notEqual(sent[0], liveLeft, 'the transferred array must not BE the buffer’s channel array');
  assert.notEqual(
    sent[0].buffer,
    liveLeft.buffer,
    'nor share its ArrayBuffer — transferring detaches it, silencing the deck that is playing this audio',
  );
  assert.deepEqual(Array.from(sent[0].slice(0, 8)), Array.from(liveLeft.slice(0, 8)), 'but it is the same audio');
  assert.equal(
    FakeWorker.posts[0].transfer[0],
    sent[0].buffer,
    'the copies themselves are transferred, so the copy is moved rather than cloned again',
  );
  assert.equal(liveLeft.length, buffer.length, 'and the live channel array is untouched');
}

// ── two instances mounting together share ONE request ─────────────────────

{
  evictAnalysis('worker-b.wav');
  FakeWorker.posts = [];
  replyTag = 'shared';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const [first, second] = await Promise.all([
    analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 }),
    analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 }),
  ]);

  assert.equal(FakeWorker.posts.length, 1, 'the deck’s two waveform instances share one worker request');
  assert.equal(first, second, 'and get the very same analysed array');
  assert.equal(FakeWorker.instances, 1, 'still only ever one Worker');

  // A third caller after it resolved is a memo hit, not a fourth request.
  const third = await analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(third, first, 'a later caller is served from the memo');
  assert.equal(FakeWorker.posts.length, 1, 'with no further worker traffic');

  // A different lane width is a different bin count, so it IS a new request.
  await analyzeBufferAsync('worker-b.wav', buffer, { normalize: true, width: 40 });
  assert.equal(FakeWorker.posts.length, 2, 'a narrower lane analyses at its own bin count');
  assert.equal(FakeWorker.posts[1].message.bins, binCountFor(210, 40));
}

// ── PR #207 review: a resize that changes the bin count copies no audio ────
// The sequence: a lane analyses its track, then the user resizes (or zooms)
// it so the bin count changes, then flips normalize. Every one of those used
// to copy the whole decoded buffer on the main thread (~74 MB for a 3.5-minute
// stereo track) to post it again. The Worker keeps the last audio it was
// sent, so only the first request carries it.
{
  evictAnalysis('worker-r.wav');
  FakeWorker.posts = [];
  replyMode = 'bins';
  replyTag = 'retained';
  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);

  await analyzeBufferAsync('worker-r.wav', buffer, { normalize: true, width: 40 });
  assert.ok(FakeWorker.posts[0].message.channels, 'the first analysis sends the audio');
  const readsAfterFirst = counter.calls;

  const resized = await analyzeBufferAsync('worker-r.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(resized[0].color, 'retained', 'the resize is analysed on the worker');
  assert.equal(FakeWorker.posts.length, 2);
  assert.equal(FakeWorker.posts[1].message.channels, undefined, 'the resize sends no channel data');
  assert.equal(counter.calls, readsAfterFirst, 'and reads (copies) nothing from the buffer on the main thread');

  await analyzeBufferAsync('worker-r.wav', buffer, { normalize: false, width: 1200 });
  assert.equal(FakeWorker.posts[2].message.channels, undefined, 'nor does a normalize flip');
  assert.equal(counter.calls, readsAfterFirst);

  // A worker that no longer holds it (it let go, or was replaced) says so,
  // and gets the audio exactly once.
  assert.ok(FakeWorker.last);
  FakeWorker.last.held = null;
  const recovered = await analyzeBufferAsync('worker-r.wav', buffer, { normalize: false, width: 40 });
  assert.equal(recovered[0].color, 'retained');
  assert.equal(FakeWorker.posts.length, 5, 'one audio-less request, then one resend with the audio');
  assert.equal(FakeWorker.posts[3].message.channels, undefined);
  assert.ok(FakeWorker.posts[4].message.channels, 'the resend carries the audio');
}

// ── a worker error falls back to the in-process analysis ──────────────────

{
  evictAnalysis('worker-c.wav');
  FakeWorker.posts = [];
  replyMode = 'error';

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const bins = await analyzeBufferAsync('worker-c.wav', buffer, { normalize: true, width: 40 });

  assert.equal(FakeWorker.posts.length, 1, 'the request was attempted on the worker');
  const expected = analyzeChannels(
    [buffer.getChannelData(0), buffer.getChannelData(1)],
    buffer.length,
    buffer.sampleRate,
    binCountFor(210, 40),
    true,
  );
  assert.equal(bins.length, expected.length, 'a failed worker analysis still produces a full set of bins');
  assert.deepEqual(bins[0], expected[0], 'computed in-process, identically');
  assert.notEqual(bins[0].color, 'shared', 'and it is not a stale worker result');

  // The worker itself is still healthy: a message-level error must not poison
  // it the way `onerror` (a dead worker) does.
  replyMode = 'bins';
  replyTag = 'recovered';
  evictAnalysis('worker-d.wav');
  const after = await analyzeBufferAsync('worker-d.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(after[0].color, 'recovered', 'the next analysis still goes to the worker');
  assert.equal(FakeWorker.instances, 1, 'and no replacement worker was built');
}

// ── a postMessage that THROWS must not leak its pending id ────────────────

{
  // `postMessage` throws synchronously when structured clone refuses a value.
  // The request was registered in the pending table BEFORE the post, so a
  // throw used to strand that entry there for the life of the page — one
  // leaked closure pair per failed analysis, never collected.
  assert.equal(pendingAnalysisCount(), 0, 'nothing is pending before this case');

  evictAnalysis('worker-throw.wav');
  replyMode = 'throw';
  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const bins = await analyzeBufferAsync('worker-throw.wav', buffer, { normalize: true, width: 40 });

  assert.ok(bins.length > 1, 'a refused postMessage still yields a real in-process analysis');
  assert.equal(
    pendingAnalysisCount(),
    0,
    'a postMessage that threw must leave NOTHING in the pending-request table',
  );
}

// ── PR #207 review: an unmounted lane's analysis is aborted ────────────────
// The sequence: a lane asks for its analysis and unmounts (a deck changes
// track, a layout switch) before the worker answers. Nothing could withdraw
// the request, so the worker kept computing it and the result went into the
// memo for a lane that no longer existed.
{
  evictAnalysis('worker-abort.wav');
  FakeWorker.posts = [];
  replyMode = 'silent';
  const failuresBefore = analysisWorkerFailures();
  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const controller = new AbortController();
  const pending = analyzeBufferAsync('worker-abort.wav', buffer, { normalize: true, width: 40, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorker.posts.length, 1, 'the analysis reached the worker');
  const worker = FakeWorker.last;
  assert.ok(worker);

  controller.abort();
  const outcome = await raceTimeout(
    pending.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.name : String(err)),
    ),
    1000,
  );
  assert.ok(outcome.settled, 'an aborted analysis must settle, not hang');
  assert.equal(outcome.value, 'AbortError', 'and reject with an AbortError');
  assert.equal(pendingAnalysisCount(), 0, 'nothing is left pending');
  assert.equal(worker.terminated, true, 'the worker computing nobody’s analysis is stopped');
  assert.equal(analysisWorkerFailures(), failuresBefore, 'walking away is not a worker failure');

  // Nothing was memoised for it: the next lane asking gets a fresh analysis.
  replyMode = 'bins';
  replyTag = 'after-abort';
  const fresh = await analyzeBufferAsync('worker-abort.wav', buffer, { normalize: true, width: 40 });
  assert.equal(fresh[0].color, 'after-abort');
}

// ── PR #207 review: a silent worker times out and is replaced ──────────────
// A worker that takes a request and never answers (wedged, or its reply lost)
// used to leave the lane blank for the rest of the session: nothing timed it
// out. The silence watch is driven by a captured timer here, so the test
// costs no wall time.
{
  evictAnalysis('worker-silent.wav');
  FakeWorker.posts = [];
  replyMode = 'silent';
  const failuresBefore = analysisWorkerFailures();
  const instancesBefore = FakeWorker.instances;
  const realSetTimeout = g.setTimeout as typeof setTimeout;
  const realClearTimeout = g.clearTimeout as typeof clearTimeout;
  const watches = new Map<number, () => void>();
  let nextWatch = 1_000_000;
  g.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === WORKER_SILENCE_MS) {
      nextWatch += 1;
      watches.set(nextWatch, fn);
      return nextWatch;
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
  g.clearTimeout = ((id: number) => {
    if (watches.delete(id)) return;
    realClearTimeout(id);
  }) as typeof clearTimeout;
  try {
    const counter = { calls: 0 };
    const buffer = stereoBuffer(counter);
    const pending = analyzeBufferAsync('worker-silent.wav', buffer, { normalize: true, width: 40 });
    await new Promise((r) => realSetTimeout(r, 0));
    assert.equal(FakeWorker.posts.length, 1, 'the worker took the request');
    assert.equal(watches.size, 1, 'and a silence watch is running while it is pending');
    const wedged = FakeWorker.last;
    assert.ok(wedged);

    // WORKER_SILENCE_MS pass with no word from the worker.
    replyMode = 'bins';
    replyTag = 'after-silence';
    const [fire] = watches.values();
    fire();
    const outcome = await raceTimeout(pending, 1000);
    assert.ok(outcome.settled, 'the silent worker was timed out');
    assert.equal(outcome.value[0].color, 'after-silence', 'and the analysis retried on a fresh worker');
    assert.equal(wedged.terminated, true, 'the wedged worker is terminated');
    assert.equal(FakeWorker.instances, instancesBefore + 1, 'one replacement worker');
    assert.equal(analysisWorkerFailures(), failuresBefore + 1, 'silence counts as one failure');
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
}

// ── a dead worker is replaced, until the failure limit ────────────────────

// Deliberately LAST: reaching the limit latches the in-process path for the
// life of the module.
{
  replyMode = 'bins';
  replyTag = 'replaced';
  evictAnalysis('worker-e.wav');

  const counter = { calls: 0 };
  const buffer = stereoBuffer(counter);
  const worker = FakeWorker.last;
  assert.ok(worker, 'a worker exists before it is killed');
  assert.equal(typeof worker.onmessageerror, 'function', 'an undeliverable reply must be handled, not dropped');
  const instancesBefore = FakeWorker.instances;

  // An undeliverable message (a reply that structured-clone cannot deliver)
  // fires `onmessageerror`, never `onmessage` — unhandled, the request that
  // caused it would hang forever and the lane would stay blank.
  const hung = analyzeBufferAsync('worker-e.wav', buffer, { normalize: true, width: 40 });
  worker.onmessageerror?.({});
  const bins = await hung;
  assert.equal(bins[0].color, 'replaced', 'an undeliverable reply is retried on a fresh worker');
  assert.equal(pendingAnalysisCount(), 0, 'and clears the pending table');
  assert.equal(worker.terminated, true, 'the dead worker is terminated, not just dereferenced and leaked');
  assert.equal(FakeWorker.instances, instancesBefore + 1, 'one replacement, not the in-process path for good');

  // Keep killing workers until the limit: after it, the in-process path.
  while (analysisWorkerFailures() < MAX_WORKER_FAILURES) {
    evictAnalysis('worker-limit.wav');
    const doomed = analyzeBufferAsync('worker-limit.wav', buffer, { normalize: true, width: 40 });
    FakeWorker.last?.onerror?.({});
    const result = await doomed;
    assert.ok(result.length >= 1, 'every analysis still answers');
  }
  evictAnalysis('worker-f.wav');
  const postsBefore = FakeWorker.posts.length;
  const instancesAtLimit = FakeWorker.instances;
  const after = await analyzeBufferAsync('worker-f.wav', buffer, { normalize: true, width: 40 });
  assert.ok(after.length > 1, 'past the limit the analysis runs in-process');
  assert.equal(FakeWorker.posts.length, postsBefore, 'with no further worker traffic');
  assert.equal(FakeWorker.instances, instancesAtLimit, 'and no further workers are built');
}

console.log('djSemanticWaveformAnalysis.worker.test.ts OK');
