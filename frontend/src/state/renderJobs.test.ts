/**
 * The render job queue's pure model: the store, the serialising runner, and the
 * chunk-safety predicate.
 *
 * Everything under test is DOM-free — no React, no AudioContext — so the whole
 * suite runs under plain tsx. The runner is driven by a fake `run` that resolves,
 * throws, or reports stages on demand; the predicate is driven through its
 * `resolve` seam (the same seam `chainLatencySec` takes) plus a few reads of the
 * real registry, so the four declarations added in `rackEffects.ts` are pinned
 * against the shipping catalog and not only against a stub.
 *
 * What is pinned here:
 *
 *  - FIFO, one at a time: a second job enqueued while the first runs waits, and
 *    starts only once the first has settled.
 *  - Cancel is two different things. A QUEUED job never runs — it is cancelled
 *    on the spot. A RUNNING job cannot be interrupted mid-`startRendering()`, so
 *    cancel raises a flag the run function may notice at a checkpoint; if it
 *    never does, the job still lands as `cancelled` and its result is thrown
 *    away rather than handed to a caller who asked for it to stop.
 *  - A throw surfaces its message on the job. It is never swallowed — not even
 *    when the job was also cancelled.
 *  - Finished history is bounded; queued and running jobs are never dropped.
 *  - Staged progress: three stages move `progress` 0 → 1/3 → 2/3 → 1.
 *  - `chainIsChunkSafe` / `bounceIsChunkSafe`: which chains a request would
 *    render, and which effects carry state across a chunk boundary.
 *  - `enqueueAndWait` resolves with the SETTLED job — done, failed or cancelled
 *    — rather than rejecting, so the freeze path can read a result, an error or
 *    an abort off one awaited value (T11c-b).
 *  - The three request builders `WaveformEditor` enqueues with still carry
 *    exactly the fidelity flags `renderCore`'s header assigns to each of the
 *    three renderers they replaced. Moving a render behind a queue must not
 *    move a single flag.
 *
 * Run: npx tsx src/state/renderJobs.test.ts
 */
import assert from 'node:assert/strict';

import {
  RENDER_JOB_HISTORY,
  bounceIsChunkSafe,
  chainIsChunkSafe,
  configureRenderJobs,
  rangeJobSummary,
  resetRenderJobsClock,
  startRenderRunner,
  useRenderJobs,
  type RenderJob,
  type RenderJobResult,
} from './renderJobs.ts';
import type { ChainEntry } from './effectChainStore.ts';
import { mixdownRequest, selectionRequest, stemRequest } from '../components/audio/WaveformEditor.tsx';
import { BOUNCE_SAMPLE_RATE, type BounceRequest, type BounceScope } from '../lib/renderCore.ts';
import { RACK_EFFECTS, getRackEffect, type RackEffectDef } from '../lib/rackEffects.ts';
import { rangeFromSeconds } from '../lib/render/renderRange.ts';

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const req = (scope: BounceScope, includeFx = true): BounceRequest => ({
  scope,
  sampleRate: 44100,
  includeFx,
  includeAutomation: false,
  includeTrackMix: false,
  float32: false,
});

const MASTER = req({ kind: 'master' });

const seed = (over: Partial<RenderJob> = {}) => ({
  kind: 'mixdown' as const,
  label: 'Mixdown',
  request: MASTER,
  ...over,
});

const jobs = () => useRenderJobs.getState().jobs;
const byId = (id: string): RenderJob => {
  const j = jobs().find((x) => x.id === id);
  assert.ok(j, `job ${id} is in the store`);
  return j;
};
const reset = () => { useRenderJobs.setState({ jobs: [] }); resetRenderJobsClock(); };
/** Let the runner's microtask chain drain. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const entry = (id: string, effect: string, enabled = true): ChainEntry => ({
  id, effect, params: {}, enabled,
});

const track = (id: string, fxChain: ChainEntry[]) => ({ id, fxChain });

/** A stub registry: every id resolves, and `bad` is the one that is unsafe. */
const stubDef = (id: string, chunkUnsafe?: boolean): RackEffectDef => ({
  id,
  label: id,
  group: 'Test',
  description: id,
  params: [],
  chunkUnsafe,
  make: () => { throw new Error('the predicate must never build a graph'); },
});
const STUB = new Map<string, RackEffectDef>([
  ['safe', stubDef('safe')],
  ['alsoSafe', stubDef('alsoSafe', false)],
  ['bad', stubDef('bad', true)],
]);
const stubResolve = (id: string) => STUB.get(id);

async function main(): Promise<void> {
  /* ── FIFO, one job at a time ─────────────────────────────────────────────── */
  {
    reset();
    const started: string[] = [];
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: (job) => {
        started.push(job.label);
        return new Promise<RenderJobResult>((res) => { release = res; });
      },
      now: () => 1000,
    });

    const a = useRenderJobs.getState().enqueue(seed({ label: 'first' }));
    const b = useRenderJobs.getState().enqueue(seed({ label: 'second' }));
    assert.notEqual(a, b, 'every job gets its own id');
    await tick();

    assert.deepEqual(started, ['first'], 'only the head of the queue runs');
    assert.equal(byId(a).status, 'running');
    assert.equal(byId(a).startedAt, 1000, 'the runner stamps startedAt from its clock');
    assert.equal(byId(b).status, 'queued', 'the second mixdown waits');
    assert.equal(useRenderJobs.getState().active()?.id, a, 'active() is the running job');
    assert.equal(useRenderJobs.getState().isBusy(), true);
    assert.equal(useRenderJobs.getState().isBusy('mixdown'), true);
    assert.equal(useRenderJobs.getState().isBusy('stem'), false, 'isBusy is per kind when asked');

    const buf = { fake: 'buffer' } as unknown as AudioBuffer;
    release!({ buffer: buf });
    await tick();

    assert.deepEqual(started, ['first', 'second'], 'the second starts only once the first settles');
    assert.equal(byId(a).status, 'done');
    assert.equal(byId(a).progress, 1, 'a finished job reads 1');
    assert.equal(byId(a).finishedAt, 1000);
    assert.equal(byId(a).result?.buffer, buf, 'the result is kept on the job');
    assert.equal(byId(b).status, 'running');
    assert.equal(useRenderJobs.getState().active()?.id, b);

    release!({});
    await tick();
    assert.equal(byId(b).status, 'done');
    assert.equal(useRenderJobs.getState().active(), undefined, 'nothing is active once the queue drains');
    assert.equal(useRenderJobs.getState().isBusy(), false);
    stop();
  }

  /* ── cancel: queued never runs ───────────────────────────────────────────── */
  {
    reset();
    const started: string[] = [];
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: (job) => {
        started.push(job.label);
        return new Promise<RenderJobResult>((res) => { release = res; });
      },
    });

    const a = useRenderJobs.getState().enqueue(seed({ label: 'runs' }));
    const b = useRenderJobs.getState().enqueue(seed({ label: 'never runs' }));
    await tick();

    configureRenderJobs({ now: () => 4242 });
    useRenderJobs.getState().cancel(b);
    assert.equal(byId(b).status, 'cancelled', 'a queued job is cancelled on the spot');
    assert.equal(byId(b).finishedAt, 4242, 'stamped from the store clock, not the wall clock');
    assert.equal(byId(b).cancelRequested, undefined, 'it never reached the runner, so no flag is needed');

    release!({});
    await tick();
    assert.deepEqual(started, ['runs'], 'the cancelled job is skipped, not run');
    assert.equal(useRenderJobs.getState().isBusy(), false);
    stop();
  }

  /* ── cancel: running, noticed at a checkpoint ────────────────────────────── */
  {
    reset();
    let sawCancel = false;
    let gate: (() => void) | null = null;
    const stop = startRenderRunner({
      run: async (_job, _onProgress, isCancelled) => {
        await new Promise<void>((res) => { gate = res; });
        if (isCancelled()) { sawCancel = true; throw new Error('aborted at stage 2'); }
        return {};
      },
    });

    const a = useRenderJobs.getState().enqueue(seed({ label: 'long' }));
    await tick();
    assert.equal(byId(a).status, 'running');

    useRenderJobs.getState().cancel(a);
    assert.equal(byId(a).status, 'running', 'a running render cannot be torn down mid-flight');
    assert.equal(byId(a).cancelRequested, true, 'cancel raises the flag the runner checks');

    gate!();
    await tick();
    assert.equal(sawCancel, true, 'the run function saw the flag at its checkpoint');
    assert.equal(byId(a).status, 'cancelled');
    assert.equal(
      byId(a).error,
      'aborted at stage 2',
      'the abort message is recorded even on a cancel — nothing is swallowed',
    );
    stop();
  }

  /* ── cancel: running, never noticed — the result is discarded ────────────── */
  {
    reset();
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: () => new Promise<RenderJobResult>((res) => { release = res; }),
    });

    const a = useRenderJobs.getState().enqueue(seed({ label: 'uninterruptible' }));
    await tick();
    useRenderJobs.getState().cancel(a);

    release!({ buffer: { fake: 'buffer' } as unknown as AudioBuffer });
    await tick();
    assert.equal(byId(a).status, 'cancelled', 'a single-context render lands cancelled when it completes');
    assert.equal(byId(a).result, undefined, 'and its buffer is thrown away, not handed back');
    assert.equal(byId(a).error, undefined, 'it did not fail — it was cancelled');
    stop();
  }

  /* ── failure surfaces its message ────────────────────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({
      run: async (job) => {
        if (job.label === 'boom') throw new Error('decode failed for clip c3');
        return {};
      },
    });

    const a = useRenderJobs.getState().enqueue(seed({ label: 'boom' }));
    const b = useRenderJobs.getState().enqueue(seed({ label: 'fine' }));
    await tick();
    await tick();

    assert.equal(byId(a).status, 'failed');
    assert.equal(byId(a).error, 'decode failed for clip c3', 'the thrown message is on the job');
    assert.equal(byId(a).result, undefined);
    assert.equal(byId(b).status, 'done', 'one failure does not stall the queue');
    stop();
  }

  /* ── staged progress ─────────────────────────────────────────────────────── */
  {
    reset();
    const seenProgress: number[] = [];
    const unsub = useRenderJobs.subscribe((s) => {
      const p = s.jobs[0]?.progress;
      if (p !== undefined && seenProgress[seenProgress.length - 1] !== p) seenProgress.push(p);
    });
    const stop = startRenderRunner({
      run: async (_job, onProgress) => {
        onProgress(1, 3);
        onProgress(2, 3);
        onProgress(3, 3);
        return {};
      },
    });

    const a = useRenderJobs.getState().enqueue(seed({ kind: 'freeze', label: 'Freeze · 3 VSTs' }));
    await tick();

    assert.deepEqual(
      seenProgress.map((p) => Number(p.toFixed(4))),
      [0, 1 / 3, 2 / 3, 1].map((p) => Number(p.toFixed(4))),
      'three stages walk progress 0 -> 1/3 -> 2/3 -> 1',
    );
    assert.equal(byId(a).status, 'done');
    assert.equal(byId(a).progress, 1);
    unsub();
    stop();
  }

  /* ── bounded history ─────────────────────────────────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({ run: async () => ({}) });
    const ids: string[] = [];
    for (let i = 0; i < RENDER_JOB_HISTORY + 5; i += 1) {
      ids.push(useRenderJobs.getState().enqueue(seed({ label: `job ${i}` })));
      await tick();
    }
    assert.equal(jobs().length, RENDER_JOB_HISTORY, `history is bounded at ${RENDER_JOB_HISTORY}`);
    assert.equal(jobs().some((j) => j.id === ids[0]), false, 'the oldest finished job is dropped first');
    assert.equal(jobs()[jobs().length - 1].id, ids[ids.length - 1], 'the newest is kept');
    assert.ok(jobs().every((j) => j.status === 'done'));

    useRenderJobs.getState().clearFinished();
    assert.deepEqual(jobs(), [], 'clearFinished empties a settled queue');
    stop();
  }

  /* ── the bound never drops a job that has not run ────────────────────────── */
  {
    reset();
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: () => new Promise<RenderJobResult>((res) => { release = res; }),
    });
    const head = useRenderJobs.getState().enqueue(seed({ label: 'head' }));
    await tick();
    const waiting: string[] = [];
    for (let i = 0; i < RENDER_JOB_HISTORY + 5; i += 1) {
      waiting.push(useRenderJobs.getState().enqueue(seed({ label: `waiting ${i}` })));
    }
    assert.equal(byId(head).status, 'running');
    assert.equal(
      jobs().filter((j) => j.status === 'queued').length,
      RENDER_JOB_HISTORY + 5,
      'queued work is never trimmed — only finished history is',
    );

    // Drain it so the runner is not left holding a promise.
    useRenderJobs.setState({
      jobs: jobs().map((j) => (j.status === 'queued' ? { ...j, status: 'cancelled' as const } : j)),
    });
    release!({});
    await tick();
    stop();
    assert.ok(waiting.length > 0);
  }

  /* ── clearFinished keeps the live jobs ───────────────────────────────────── */
  {
    reset();
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: () => new Promise<RenderJobResult>((res) => { release = res; }),
    });
    const running = useRenderJobs.getState().enqueue(seed({ label: 'running' }));
    await tick();
    const queued = useRenderJobs.getState().enqueue(seed({ label: 'queued' }));
    const done = useRenderJobs.getState().enqueue(seed({ label: 'already done' }));
    useRenderJobs.setState({
      jobs: jobs().map((j) => (j.id === done ? { ...j, status: 'done' as const, progress: 1 } : j)),
    });

    useRenderJobs.getState().clearFinished();
    assert.deepEqual(
      jobs().map((j) => j.id),
      [running, queued],
      'clearFinished drops only settled jobs',
    );
    release!({});
    await tick();
    stop();
  }

  /* ── cancel is a no-op on a settled job ──────────────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({ run: async () => ({}), now: () => 7 });
    const a = useRenderJobs.getState().enqueue(seed());
    await tick();
    assert.equal(byId(a).status, 'done');
    useRenderJobs.getState().cancel(a);
    assert.equal(byId(a).status, 'done', 'a finished job cannot be un-finished by a late cancel');
    assert.equal(byId(a).finishedAt, 7);
    useRenderJobs.getState().cancel('no-such-job');
    assert.equal(jobs().length, 1, 'cancelling an unknown id changes nothing');
    stop();
  }

  /* ── a stopped runner takes no more work ─────────────────────────────────── */
  {
    reset();
    let runs = 0;
    const stop = startRenderRunner({ run: async () => { runs += 1; return {}; } });
    useRenderJobs.getState().enqueue(seed());
    await tick();
    assert.equal(runs, 1);
    stop();
    useRenderJobs.getState().enqueue(seed());
    await tick();
    assert.equal(runs, 1, 'after stop() the queue is left alone');
    assert.equal(jobs()[1].status, 'queued', 'and the job simply waits for the next runner');
  }

  /* ── mass cancel re-applies the history bound ────────────────────────────── */
  {
    reset();
    // No runner: everything stays queued until it is cancelled, so this is the
    // one path that turns a whole queue finished without the runner's trim.
    const ids: string[] = [];
    for (let i = 0; i < RENDER_JOB_HISTORY + 6; i += 1) {
      ids.push(useRenderJobs.getState().enqueue(seed({ label: `mass ${i}` })));
    }
    assert.equal(jobs().length, RENDER_JOB_HISTORY + 6, 'queued work is never trimmed');
    for (const id of ids) useRenderJobs.getState().cancel(id);
    assert.equal(jobs().length, RENDER_JOB_HISTORY, 'cancelling the lot re-applies the bound');
    assert.ok(jobs().every((j) => j.status === 'cancelled'));
    assert.equal(jobs()[jobs().length - 1].id, ids[ids.length - 1], 'the newest cancellations survive');
    assert.equal(jobs().some((j) => j.id === ids[0]), false, 'the oldest are dropped');
  }

  /* ── a running job orphaned by a stopped runner ──────────────────────────── */
  {
    reset();
    // A runner that stops (or a reload) leaves its job `running` with nothing to
    // settle it. Without the sweep the next runner would refuse to take any work
    // at all, forever, because it would see that job still running.
    const stale = useRenderJobs.getState().enqueue(seed({ label: 'orphan' }));
    useRenderJobs.setState({
      jobs: jobs().map((j) => ({ ...j, status: 'running' as const, startedAt: 1 })),
    });

    let ran = 0;
    const stop = startRenderRunner({ run: async () => { ran += 1; return {}; }, now: () => 99 });
    assert.equal(byId(stale).status, 'failed', 'a new runner fails the orphan rather than waiting on it');
    assert.equal(byId(stale).error, 'orphaned by a previous runner');
    assert.equal(byId(stale).finishedAt, 99);

    const fresh = useRenderJobs.getState().enqueue(seed({ label: 'after the orphan' }));
    await tick();
    assert.equal(ran, 1, 'and the queue is no longer wedged');
    assert.equal(byId(fresh).status, 'done');
    stop();
  }

  /* ── stop() while a job is in flight ─────────────────────────────────────── */
  {
    reset();
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: () => new Promise<RenderJobResult>((res) => { release = res; }),
    });
    const inFlight = useRenderJobs.getState().enqueue(seed({ label: 'in flight' }));
    const queued = useRenderJobs.getState().enqueue(seed({ label: 'left behind' }));
    await tick();
    assert.equal(byId(inFlight).status, 'running');

    stop();
    release!({ blob: new Blob(['x']) });
    await tick();
    assert.equal(byId(inFlight).status, 'done', 'stop() does not abort the render already under way');
    assert.ok(byId(inFlight).result?.blob, 'and its result is still recorded');
    assert.equal(byId(queued).status, 'queued', 'but nothing else is taken');

    // The queue is intact, so the next runner picks up exactly where this left off.
    const stop2 = startRenderRunner({ run: async () => ({}) });
    await tick();
    assert.equal(byId(queued).status, 'done', 'a later runner resumes the queue');
    stop2();
  }

  /* ── a synchronous throw from run ────────────────────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({
      // Not an async function: it throws before ever returning a promise.
      run: (() => { throw new Error('OfflineAudioContext: length must be > 0'); }) as never,
    });
    const a = useRenderJobs.getState().enqueue(seed({ label: 'sync throw' }));
    await tick();
    assert.equal(byId(a).status, 'failed', 'a synchronous throw fails the job like any other');
    assert.equal(byId(a).error, 'OfflineAudioContext: length must be > 0');
    stop();
  }

  /* ── a non-Error throw still says something ──────────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({ run: async () => { throw 'plain string'; } });
    const a = useRenderJobs.getState().enqueue(seed());
    await tick();
    assert.equal(byId(a).status, 'failed');
    assert.equal(byId(a).error, 'plain string', 'a thrown non-Error is stringified, not dropped');
    stop();
  }

  /* ── onProgress guards ───────────────────────────────────────────────────── */
  {
    reset();
    let late: ((stage: number, total: number) => void) | null = null;
    // Sampled from outside the run function: asserting inside it would be caught
    // by the runner and reported as a failed render instead of a failed test.
    const after: number[] = [];
    const sample = () => { after.push(useRenderJobs.getState().active()?.progress ?? -1); };
    const stop = startRenderRunner({
      run: async (_job, onProgress) => {
        late = onProgress;
        onProgress(1, 0); sample(); // total <= 0
        onProgress(1, -4); sample(); // negative total
        onProgress(NaN, 3); sample(); // non-finite stage
        onProgress(1, Number.POSITIVE_INFINITY); sample(); // non-finite total
        onProgress(-2, 4); sample(); // clamps up to 0
        onProgress(9, 4); sample(); // clamps down to 1
        return {};
      },
    });
    const id = useRenderJobs.getState().enqueue(seed());
    await tick();
    assert.deepEqual(
      after,
      [0, 0, 0, 0, 0, 1],
      'a zero, negative or non-finite report is ignored; a stage outside 0..total clamps',
    );
    assert.equal(byId(id).status, 'done');
    assert.equal(byId(id).progress, 1);

    // The run function kept the callback. A job that has left `running` must not
    // be dragged back by a late report from work that is already over.
    late!(1, 4);
    assert.equal(byId(id).progress, 1, 'progress reported after the job finished is ignored');
    assert.equal(byId(id).status, 'done', 'and it cannot resurrect the job');
    stop();
  }

  /* ── enqueue carries the caller's fields through verbatim ────────────────── */
  {
    reset();
    const id = useRenderJobs.getState().enqueue({
      kind: 'stem',
      label: 'Stem · Drums',
      trackId: 't2',
      request: req({ kind: 'track', trackId: 't2' }),
      chunkable: false,
      chunkReasons: ['reverb (e1): tail state crosses a chunk boundary'],
    });
    const j = byId(id);
    assert.equal(j.status, 'queued');
    assert.equal(j.progress, 0, 'a fresh job reads 0');
    assert.equal(j.trackId, 't2');
    assert.equal(j.chunkable, false, 'the chunk verdict rides on the job for the UI to read');
    assert.deepEqual(j.chunkReasons, ['reverb (e1): tail state crosses a chunk boundary']);
    assert.equal(j.request.scope.kind, 'track');
    assert.equal(j.startedAt, undefined);
    assert.equal(j.error, undefined);
  }

  /* ── the range rides on the job as a snapshot (F24-4) ────────────────────── */
  {
    reset();
    const range = rangeFromSeconds(34, 72.5, { tailSec: 0 })!;
    const id = useRenderJobs.getState().enqueue(seed({ range }));
    assert.deepEqual(byId(id).range, range, 'enqueue copies the seed range onto the stored job unchanged');
  }

  {
    reset();
    const id = useRenderJobs.getState().enqueue(seed());
    assert.equal(byId(id).range, undefined, 'no range means the whole timeline — nothing rode on this job');
    assert.equal(rangeJobSummary(byId(id)), null, 'rangeJobSummary has nothing to say about a rangeless job');
  }

  {
    const range = rangeFromSeconds(34, 72.5, { tailSec: 0 })!;
    assert.equal(
      rangeJobSummary({ range }),
      '0:34.000 – 1:12.500 (38.500 s)',
      'start and end as m:ss.mmm, kept length (incl. any tail) as fixed-3 seconds',
    );
  }

  {
    reset();
    const range = rangeFromSeconds(34, 72.5, { tailSec: 0 })!;
    const original = { ...range };
    const id = useRenderJobs.getState().enqueue(seed({ range }));
    // The user's selection moves on to a different span while this job waits in
    // the queue — simulated in the sharpest way available: mutate the very
    // `range` object `enqueue` was handed, in place, with no new object at all.
    // If `enqueue` stored this reference verbatim instead of a value copy, this
    // mutation would leak straight into the already-queued job.
    range.startFrame = 0;
    range.endFrame = 1;
    assert.deepEqual(
      byId(id).range,
      original,
      "a later selection change does not alter a queued job's range",
    );
  }

  /* ── a stem result carries the whole triple renderTrackStem produces ─────── */
  {
    reset();
    const peaks = new Float32Array([0.1, 0.9, 0.4]);
    const blob = new Blob(['wav']);
    const stop = startRenderRunner({
      run: async (_job, onProgress) => {
        onProgress(1, 3); // the offline render
        onProgress(2, 3); // the VST3 hop
        onProgress(3, 3); // computePeaks — inside the accounting, not after it
        return { blob, durationSec: 12.5, peaks };
      },
    });
    const id = useRenderJobs.getState().enqueue(seed({ kind: 'stem', label: 'Stem · Bass', trackId: 't9' }));
    await tick();
    const r = byId(id).result;
    assert.equal(r?.blob, blob, 'the encoded stem');
    assert.equal(r?.durationSec, 12.5, 'its length, without the consumer decoding again');
    assert.equal(r?.peaks, peaks, 'and its peaks — the whole triple survives the queue');
    assert.equal(byId(id).progress, 1);
    stop();
  }

  /* ── chainIsChunkSafe ────────────────────────────────────────────────────── */
  {
    assert.deepEqual(
      chainIsChunkSafe([], stubResolve),
      { safe: true, reasons: [] },
      'an empty chain is chunk-safe',
    );
    assert.deepEqual(
      chainIsChunkSafe([entry('e1', 'safe'), entry('e2', 'alsoSafe')], stubResolve),
      { safe: true, reasons: [] },
      'stateless effects are chunk-safe',
    );

    const unsafe = chainIsChunkSafe([entry('e1', 'safe'), entry('e2', 'bad')], stubResolve);
    assert.equal(unsafe.safe, false, 'one stateful effect makes the whole chain unsafe');
    assert.equal(unsafe.reasons.length, 1, 'the safe entry contributes no reason');
    assert.match(unsafe.reasons[0], /e2/, 'the reason names the chain entry');
    assert.match(unsafe.reasons[0], /bad/, 'and the effect');

    assert.deepEqual(
      chainIsChunkSafe([entry('e2', 'bad', false)], stubResolve),
      { safe: true, reasons: [] },
      'a bypassed effect is routed around, so its state is not in the path',
    );

    const unknown = chainIsChunkSafe([entry('e9', 'vst3')], stubResolve);
    assert.equal(unknown.safe, false, 'an unresolvable id is unsafe — its state is unknown');
    assert.match(unknown.reasons[0], /vst3/);

    // Every unsafe entry is reported, not just the first, so the UI can list them.
    const many = chainIsChunkSafe([entry('a', 'bad'), entry('b', 'vst3'), entry('c', 'bad')], stubResolve);
    assert.equal(many.safe, false);
    assert.equal(many.reasons.length, 3, 'each unsafe entry gets its own reason');

    // ── the whole registry, not an allowlist ────────────────────────────────
    // Asserted over RACK_EFFECTS so a factory added later cannot carry state
    // across a seam without someone deciding about it here. Each id's reason is
    // at its registry entry, keyed to the three families in `RackEffectDef`.
    const CHUNK_UNSAFE = [
      'kargyraa',    // (b)(c) subharmonic worklet re-locks; growl + motion LFOs re-phase
      'spatializer', // (a)(c) HRTF convolution tail, free motion LFOs, absolute-time teleports
      'owlpad',      // (a)   two of five programs are feedback delays
      'gater',       // (c)   the gate LFO's phase IS the rhythm
      'ringmod',     // (c)   the carrier's phase steps the product at the seam
      'chop',        // (a)   a 2 s history ring, replayed
      'compressor',  // (b)   the envelope follower re-converges
      'reverb',      // (a)   the tail rings for up to 8 s
      'delay',       // (a)   the feedback line holds up to 2 s at up to 0.95
      'ares',        // (a)(c) delay + reverb + granular + gate in one box
    ];
    assert.deepEqual(
      RACK_EFFECTS.filter((d) => d.chunkUnsafe).map((d) => d.id),
      // In registry order, so the assertion reads against the file.
      RACK_EFFECTS.filter((d) => CHUNK_UNSAFE.includes(d.id)).map((d) => d.id),
      'exactly these effects declare chunkUnsafe — a new stateful factory must be decided about',
    );
    assert.equal(
      RACK_EFFECTS.filter((d) => d.chunkUnsafe).length,
      CHUNK_UNSAFE.length,
      'and none of the named ids has been renamed out from under this list',
    );
    for (const id of CHUNK_UNSAFE) {
      const def = getRackEffect(id);
      assert.ok(def, `${id} is in the shipping registry`);
      assert.equal(
        chainIsChunkSafe([entry('x', id)]).safe,
        false,
        `${id} makes a chain unsafe through the real registry (no resolve seam)`,
      );
    }

    // The deliberate exclusions, stated rather than left implicit. `crossfeed`
    // has a 300 us cross-path delay and the rest are biquads, waveshapers and
    // gains: all carry less than one 128-sample render quantum of state.
    for (const id of [
      'crossfeed', 'phantom_bass', 'stereo_widener', 'exciter',
      'loudness_contour', 'bitcrush', 'parametric_eq', 'highpass', 'lowpass',
    ]) {
      assert.ok(getRackEffect(id), `${id} is in the shipping registry`);
      assert.equal(
        chainIsChunkSafe([entry('x', id)]).safe,
        true,
        `${id} holds less than a render quantum of state, so a seam cannot be heard`,
      );
    }
    assert.equal(
      RACK_EFFECTS.length,
      CHUNK_UNSAFE.length + 9,
      'every registry entry is covered by one of the two lists above',
    );
  }

  /* ── bounceIsChunkSafe ───────────────────────────────────────────────────── */
  {
    const tracks = [
      track('t1', [entry('a', 'safe')]),
      track('t2', [entry('b', 'bad')]),
    ];
    const master = [entry('m', 'bad')];

    assert.deepEqual(
      bounceIsChunkSafe(req({ kind: 'master' }, false), tracks, master, stubResolve),
      { safe: true, reasons: [] },
      'includeFx:false builds no rack at all, so any bounce is chunk-safe',
    );

    const masterBounce = bounceIsChunkSafe(req({ kind: 'master' }), tracks, master, stubResolve);
    assert.equal(masterBounce.safe, false, 'the master bounce covers the master rack and every track rack');
    assert.equal(masterBounce.reasons.length, 2, 'both the master entry and t2 are reported');
    assert.ok(masterBounce.reasons.some((r) => r.includes('m')));
    assert.ok(masterBounce.reasons.some((r) => r.includes('b')));

    const safeTrack = bounceIsChunkSafe(req({ kind: 'track', trackId: 't1' }), tracks, master, stubResolve);
    assert.deepEqual(
      safeTrack,
      { safe: true, reasons: [] },
      'a track stem renders only that track chain — no master rack, no sibling track',
    );

    const unsafeTrack = bounceIsChunkSafe(req({ kind: 'track', trackId: 't2' }), tracks, master, stubResolve);
    assert.equal(unsafeTrack.safe, false, "the scoped track's own chain still counts");
    assert.equal(unsafeTrack.reasons.length, 1, 'and only it — the master rack is not in the stem graph');

    assert.deepEqual(
      bounceIsChunkSafe(req({ kind: 'track', trackId: 'gone' }), tracks, master, stubResolve),
      { safe: true, reasons: [] },
      'a scope naming no existing track renders nothing',
    );

    // A stem's hosted VST3 entries are stripped by `renderCore` and printed on the
    // backend afterwards, so they are not in the offline graph this predicate gates.
    assert.deepEqual(
      bounceIsChunkSafe(
        req({ kind: 'track', trackId: 'tv' }),
        [track('tv', [entry('v', 'vst3'), entry('s', 'safe')])],
        master,
        stubResolve,
      ),
      { safe: true, reasons: [] },
      'a track stem strips vst3 entries, so they do not make it unsafe',
    );
    // The master bounce leaves them in as inert passthroughs — unknown state.
    assert.equal(
      bounceIsChunkSafe(
        req({ kind: 'master' }),
        [track('tv', [entry('v', 'vst3')])],
        [],
        stubResolve,
      ).safe,
      false,
      'the master bounce keeps vst3 entries in the graph, so their unknown state counts',
    );

    // A selection bounce with FX puts the mix back on the track, so every track
    // rack and the master rack are built — the same universe as the master bounce.
    assert.equal(
      bounceIsChunkSafe(req({ kind: 'selection', clipIds: ['c1'] }), tracks, master, stubResolve).safe,
      false,
      'a selection bounce with FX covers the same racks the master bounce does',
    );
    assert.deepEqual(
      bounceIsChunkSafe(req({ kind: 'selection', clipIds: ['c1'] }, false), tracks, master, stubResolve),
      { safe: true, reasons: [] },
      "and today's selection bounce sets includeFx:false, so it is chunk-safe",
    );

    assert.deepEqual(
      bounceIsChunkSafe(req({ kind: 'master' }), [], [], stubResolve),
      { safe: true, reasons: [] },
      'a bounce with no racks anywhere is chunk-safe',
    );
    assert.deepEqual(
      bounceIsChunkSafe(req({ kind: 'master' }), [{ id: 't1' }], [], stubResolve),
      { safe: true, reasons: [] },
      'a track with no fxChain at all is fine',
    );
  }

  /* ── enqueueAndWait resolves with the settled job ────────────────────────── */
  {
    reset();
    const stop = startRenderRunner({
      run: async (job) => {
        if (job.label === 'boom') throw new Error('the render context died');
        return { durationSec: 4.5 };
      },
      now: () => 7,
    });

    const done = await useRenderJobs.getState().enqueueAndWait(seed({ label: 'ok' }));
    assert.equal(done.status, 'done', 'a job that ran resolves as done');
    assert.deepEqual(done.result, { durationSec: 4.5 }, 'and carries its result');
    assert.equal(done.progress, 1);
    assert.equal(done.finishedAt, 7);

    // A failure RESOLVES with the failed job rather than rejecting: the freeze
    // path has to distinguish "no blob because it failed" from "no blob because
    // the user cancelled", and a rejection collapses both into a throw.
    const failed = await useRenderJobs.getState().enqueueAndWait(seed({ label: 'boom' }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'the render context died');
    assert.equal(failed.result, undefined, 'a failed job has no result to read');

    stop();
    reset();
  }

  /* ── enqueueAndWait: cancelled before it ever ran ────────────────────────── */
  {
    reset();
    configureRenderJobs({ now: () => 99 });
    let release: ((r: RenderJobResult) => void) | null = null;
    const stop = startRenderRunner({
      run: () => new Promise<RenderJobResult>((res) => { release = res; }),
      now: () => 99,
    });

    useRenderJobs.getState().enqueue(seed({ label: 'holds the runner' }));
    await tick();

    let settled: RenderJob | null = null;
    const waiting = useRenderJobs.getState()
      .enqueueAndWait(seed({ label: 'never runs' }))
      .then((j) => { settled = j; return j; });
    await tick();
    assert.equal(settled, null, 'a queued job keeps its waiter waiting');

    const queued = jobs().find((j) => j.label === 'never runs');
    assert.ok(queued);
    useRenderJobs.getState().cancel(queued.id);
    const j = await waiting;
    assert.equal(j.status, 'cancelled', 'cancelling a queued job settles its waiter');
    assert.equal(j.result, undefined);

    release?.({});
    await tick();
    stop();
    reset();
  }

  /* ── the request builders still carry T11b's fidelity flags ──────────────── */
  {
    // The three rows of `lib/renderCore`'s header, verbatim. These are the only
    // thing that decides what a bounce SOUNDS like, so they are pinned against
    // the literal rather than against another expression of the same code.
    assert.deepEqual(
      mixdownRequest(),
      {
        scope: { kind: 'master' },
        sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: true,
        includeAutomation: true,
        includeTrackMix: true,
        float32: false,
      },
      'commitEdit: everything — master + per-track racks, automation, mute AND solo',
    );

    assert.deepEqual(
      selectionRequest(['c1', 'c2']),
      {
        scope: { kind: 'selection', clipIds: ['c1', 'c2'] },
        sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: false,
        includeAutomation: false,
        includeTrackMix: true,
        float32: false,
      },
      'sendSelectionToInit: no inserts, no automation, but the track mix applies',
    );

    assert.deepEqual(
      stemRequest('t1', false),
      {
        scope: { kind: 'track', trackId: 't1' },
        sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: true,
        includeAutomation: true,
        includeTrackMix: false,
        float32: false,
      },
      // The rack's lanes are in the stem: a freeze empties the live rack, so
      // nothing else would play them. A volume or pan lane is a lane on the
      // fader, which the render applies only with the track mix.
      "renderTrackStem: the track's own rack with its lanes baked in, no track mix",
    );
    assert.equal(
      stemRequest('t1', true).float32,
      true,
      'and float only when hosted VST3s will re-process the stem on the backend',
    );
    // `runStemJob` REBUILDS the stem request through this same builder from the
    // chain it resolves at run time, so a job that sat in the queue while a
    // VST3 was added to the track cannot print 16-bit ahead of a backend hop.
    // The run function itself needs an AudioContext and cannot be driven from
    // here; what is pinned is that the rule it re-runs is this one, and that it
    // depends on nothing but the flag.
    assert.deepEqual(
      { ...stemRequest('t1', true), float32: false },
      stemRequest('t1', false),
      'float32 is the ONLY field the hosted-plugin flag moves',
    );

    // A stem with no hosted plugins is chunk-safe with an empty rack, which is
    // what the pill reads to decide between a value and an indeterminate bar.
    assert.deepEqual(
      bounceIsChunkSafe(stemRequest('t1', false), [track('t1', [])], [], stubResolve),
      { safe: true, reasons: [] },
      'the builders produce requests bounceIsChunkSafe can actually judge',
    );
  }

  reset();
  console.log('renderJobs: all assertions passed');
}

await main();
