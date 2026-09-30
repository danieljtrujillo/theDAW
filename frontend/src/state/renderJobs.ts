/**
 * renderJobs — the render queue's pure model: what a render job IS, the store
 * that holds them, the runner that serialises them, and the predicate that says
 * whether a given bounce could be rendered in chunks.
 *
 * WHY A QUEUE. Batch 6 gave the three timeline renderers one graph
 * (`lib/renderCore.renderBounce`), but each still runs inline behind its own
 * boolean in `WaveformEditor` — `isCommitting`, `isRendering`, `isBleeding`,
 * `isFreezing` — so two renders can be in flight at once, none reports progress,
 * and none can be called off. This file is the model those flags become
 * (T11c-b): one FIFO queue, one job at a time, a status and a progress number
 * per job, and a cancel that is honest about what it can actually do.
 *
 * WHY PROGRESS IS MOSTLY BINARY. `OfflineAudioContext.startRendering()` returns
 * a single promise. It exposes no progress and no cancel: once the render is
 * under way there is nothing to poll and nothing to abort. So a job's progress
 * is binary (0 → 1) UNLESS one of two things is true:
 *
 *   1. The job has stages beyond the one context — the freeze and stem flows
 *      already do (render → N VST3 backend hops → peaks), so the runner hands
 *      the run function an `onProgress(stage, total)` and those stages become
 *      real progress.
 *   2. The render is split across several contexts and concatenated (T11d). That
 *      is only sound when nothing in the graph carries audio state across a
 *      boundary, which is what `bounceIsChunkSafe` below answers. This ticket
 *      does NOT chunk; it records the verdict on the job so the UI can say "no
 *      progress available" because it knows, not because it guessed.
 *
 * WHAT CANCEL MEANS. A QUEUED job is cancelled outright — it never runs. A
 * RUNNING job raises `cancelRequested`, which the run function may notice at a
 * checkpoint (between stages, before starting the next context). If it never
 * does, the job still lands as `cancelled` and its result is DISCARDED rather
 * than handed to a caller who asked for it to stop. Pretending a single-context
 * render can be torn down mid-flight would be a lie.
 *
 * DOM-free by construction: no React, no AudioContext, no `window`. The store is
 * plain zustand (`state/metronomeStore.ts`'s shape, minus the persistence — a
 * job holds an `AudioBuffer`, which is not serialisable and must not outlive the
 * session), and the runner is driven through an injected `run`. Everything here
 * is exercised by `renderJobs.test.ts` under plain tsx.
 *
 * DESIGN SOURCE (read for its design only — NO code was copied from it):
 *   - Tracktion Engine `modules/tracktion_engine/model/export/
 *     tracktion_Renderer.h` (GPL-3.0 or commercial), already cited by
 *     `lib/renderCore.ts` for `BounceRequest`: a render is a flat parameter
 *     object handed to a runner that owns no policy of its own. The queue around
 *     it is this app's own. That reference was NOT reopened for this file.
 */
import { create } from 'zustand';

import type { RackEffectDef } from '../lib/rackEffects';
import { getRackEffect } from '../lib/rackEffects';
import { bounceWalksMix } from '../lib/render/bounceWalksMix';
import type { RenderRange } from '../lib/render/renderRange';
import { frameToSec, keptFrameCount } from '../lib/render/renderRange';
import type { BounceRequest } from '../lib/renderCore';
import type { ChainEntry } from './effectChainStore';
import type { ExportDestination, ExportRenderItem } from '../lib/render/exportDialogModel';

/* ── the job ───────────────────────────────────────────────────────────────── */

/** Which of the app's renders this job is. One per call site the queue replaces:
 *  the master mixdown, a track stem, the selection bounce, a VST freeze, and the
 *  step sequencer's pattern print. `export` is the export dialog's own bounce
 *  (T25c, F25) — a plain render + deliver with no timeline write and no MAKE
 *  handoff, so it cannot reuse `mixdown` (always both destinations) or `selection`
 *  (routes to MAKE) without misrouting or dropping the dialog's destination
 *  choice. */
export type RenderJobKind = 'mixdown' | 'stem' | 'selection' | 'freeze' | 'pattern' | 'export';

/** `queued` → `running` → one of the three terminal states. A job never moves
 *  out of a terminal state; a late `cancel` on a finished job is a no-op. */
export type RenderJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * What a finished render produced. Every field is optional because the consumers
 * differ: the mixdown wants the encoded blob, the freeze path wants the buffer to
 * keep rendering from, and the bleed path wants both.
 *
 * `durationSec` and `peaks` are here for the stem flow, whose last stage is
 * `computePeaks` — `renderTrackStem` hands its caller
 * `{ audioBlob, durationSec, peaks }`, and that whole triple has to survive the
 * queue or the peaks stage would have to run outside `onProgress` accounting and
 * the job's progress would lie about when it was finished.
 */
export interface RenderJobResult {
  buffer?: AudioBuffer;
  blob?: Blob;
  /** Rendered length in seconds, when the consumer needs it without decoding. */
  durationSec?: number;
  /** Waveform peaks, when the job's last stage computed them. */
  peaks?: Float32Array;
}

export interface RenderJob {
  id: string;
  kind: RenderJobKind;
  /** Shown in the queue UI. The call site owns the wording. */
  label: string;
  /** The track this job is about, for the kinds that have one (stem, freeze). */
  trackId?: string;
  /** Everything the render needs — see `lib/renderCore.BounceRequest`. */
  request: BounceRequest;
  /**
   * The time range this render covers (F24). Absent = the whole timeline. A
   * SNAPSHOT: the user's selection may move while the job waits.
   *
   * This is a separate copy from `request.range` (`BounceRequest`, F24-2),
   * which stays the RENDERER's copy of truth — the run function reads that
   * one, never this one. This field exists only so the queue pill can say
   * what a queued render covers without re-deriving it from `request`.
   */
  range?: RenderRange;
  /** For an `export` job only: which destination(s) `deliverExport` should
   *  write to — the export dialog's own choice, not hardcoded like a
   *  `mixdown` job's library-and-save-both. */
  destination?: ExportDestination;
  /** For an `export` job only: which `ExportRenderItem` kind this job came
   *  from (`mixdown` | `stem` | `selection`), carried through only for
   *  `deliverExport`'s library-entry description — the queue itself treats
   *  every `export` job identically. */
  exportItemKind?: ExportRenderItem['kind'];
  status: RenderJobStatus;
  /** 0..1. Binary jobs go 0 → 1; a staged job walks `stage / total`. */
  progress: number;
  /**
   * Whether this bounce COULD be rendered in chunks — i.e. whether every effect
   * in every chain it would build is free of state that crosses a chunk
   * boundary. Computed by the call site with `bounceIsChunkSafe` and recorded
   * here; the runner does not chunk (that is T11d, gated on this). ABSENT means
   * nobody evaluated it, and the UI must then treat the job as binary.
   */
  chunkable?: boolean;
  /** Why not, one line per offending chain entry. Empty when `chunkable`. */
  chunkReasons?: string[];
  /**
   * Raised by `cancel` on a job that is already running. The run function is
   * handed an `isCancelled()` that reads this, and is expected to check it at
   * its checkpoints. A render already inside `startRendering()` cannot see it
   * until that promise settles — see the module header.
   */
  cancelRequested?: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** The thrown message. Recorded even when the job ends `cancelled`, so an
   *  abort's own explanation is never swallowed. */
  error?: string;
  /** Present only on `done`. A cancelled job's result is discarded. */
  result?: RenderJobResult;
}

/** What `enqueue` is given: the job minus everything the queue owns. */
export type RenderJobSeed = Omit<RenderJob, 'id' | 'status' | 'progress'>;

/**
 * What a job's `range` covers, for the queue pill ('0:34.000 – 1:12.500
 * (38.500 s)') — built once here so the UI never re-derives frame math from
 * `job.range` itself. `null` when the job has no range (a whole-timeline
 * render has nothing to summarise).
 */
export function rangeJobSummary(job: Pick<RenderJob, 'range'>): string | null {
  const { range } = job;
  if (!range) return null;
  const startSec = frameToSec(range.startFrame);
  const keptSec = frameToSec(keptFrameCount(range));
  const endSec = startSec + keptSec;
  return `${formatClock(startSec)} – ${formatClock(endSec)} (${keptSec.toFixed(3)} s)`;
}

/** `m:ss.mmm`, minutes unpadded — the queue pill's clock format. */
function formatClock(sec: number): string {
  const totalMs = Math.round(sec * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const msInMinute = totalMs - minutes * 60000;
  const seconds = Math.floor(msInMinute / 1000);
  const millis = msInMinute - seconds * 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** How many FINISHED jobs the store keeps. Queued and running jobs are never
 *  trimmed — only settled history is, oldest first. */
export const RENDER_JOB_HISTORY = 20;

const TERMINAL: readonly RenderJobStatus[] = ['done', 'failed', 'cancelled'];
const isFinished = (j: RenderJob): boolean => TERMINAL.includes(j.status);

/** Drop finished jobs past the bound, oldest first, leaving live work alone. */
const trimHistory = (jobs: RenderJob[]): RenderJob[] => {
  const finished = jobs.filter(isFinished);
  const excess = finished.length - RENDER_JOB_HISTORY;
  if (excess <= 0) return jobs;
  const doomed = new Set(finished.slice(0, excess).map((j) => j.id));
  return jobs.filter((j) => !doomed.has(j.id));
};

let jobSeq = 0;
const nextJobId = (): string => {
  jobSeq += 1;
  return `rj-${Date.now().toString(36)}-${jobSeq}`;
};

/**
 * The clock the STORE stamps with — today only `cancel`, for the `finishedAt` of
 * a job that never reached a runner. It is separate from `RenderRunnerDeps.now`
 * on purpose: the store outlives any runner and must be able to answer without
 * one, and `startRenderRunner` deliberately does NOT reach in and overwrite this
 * (a runner starting would otherwise silently change how the store timestamps).
 * A test that needs both to agree configures both.
 */
let storeNow: () => number = () => Date.now();

/** Point the store's clock somewhere else. Wall-clock `Date.now` by default. */
export function configureRenderJobs(opts: { now?: () => number }): void {
  if (opts.now) storeNow = opts.now;
}

/** Restore the default wall clock. For tests, and for a session teardown. */
export function resetRenderJobsClock(): void {
  storeNow = () => Date.now();
}

/* ── the store ─────────────────────────────────────────────────────────────── */

interface RenderJobsState {
  /** Queue and history in enqueue order — the runner takes the first `queued`,
   *  which makes the order FIFO. */
  jobs: RenderJob[];
  /** Add a job to the back of the queue. Returns its id. */
  enqueue: (job: RenderJobSeed) => string;
  /**
   * Enqueue, and resolve once the job has SETTLED — with the settled job
   * itself, in whatever terminal state it reached.
   *
   * The master VST freeze needs this: it renders the master mix and then has to
   * keep going with the resulting blob (through each plugin on the backend, into
   * `frozenMaster`, into the player), so it cannot simply fire a job and walk
   * away the way COMMIT EDIT does.
   *
   * It RESOLVES on failure and on cancellation rather than rejecting. A caller
   * has to tell "no blob because the render failed" from "no blob because the
   * user called it off" — the first deserves an error, the second deserves
   * silence — and a rejection collapses both into one throw. Read `status`.
   */
  enqueueAndWait: (job: RenderJobSeed) => Promise<RenderJob>;
  /** Queued → `cancelled` at once. Running → raises `cancelRequested`.
   *  Finished → nothing. Unknown id → nothing. */
  cancel: (id: string) => void;
  /** The job being rendered right now, if any. */
  active: () => RenderJob | undefined;
  /** Is there any unfinished work (of this kind, when one is named)? */
  isBusy: (kind?: RenderJobKind) => boolean;
  /** Drop every settled job, keeping the queue and whatever is running. */
  clearFinished: () => void;
}

export const useRenderJobs = create<RenderJobsState>((set, get) => ({
  jobs: [],

  enqueue: (job) => {
    const id = nextJobId();
    const full: RenderJob = {
      ...job,
      id,
      status: 'queued',
      progress: 0,
      // A value copy, not the caller's own object: `range` is a SNAPSHOT (see
      // `RenderJob.range` above) and must not move if the caller's selection —
      // and therefore the object it built this range from — changes after
      // enqueue but before the job is read back out of the store.
      range: job.range ? { ...job.range } : undefined,
    };
    set((s) => ({ jobs: trimHistory([...s.jobs, full]) }));
    return id;
  },

  enqueueAndWait: (job) => {
    const id = get().enqueue(job);
    return new Promise<RenderJob>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (j: RenderJob): void => {
        if (settled) return;
        settled = true;
        // `check` runs once before `subscribe` returns, so the job can already
        // be over by the time there is anything to unsubscribe from.
        unsubscribe?.();
        resolve(j);
      };
      const check = (): void => {
        const j = useRenderJobs.getState().jobs.find((x) => x.id === id);
        if (!j) {
          // Trimmed out of history before this waiter looked at it (only
          // possible behind RENDER_JOB_HISTORY other finished jobs). It is over
          // and its result went with it — say so rather than wait forever.
          finish({
            ...job,
            id,
            status: 'failed',
            progress: 0,
            error: 'the job left the history bound before its result was read',
          });
          return;
        }
        if (isFinished(j)) finish(j);
      };
      unsubscribe = useRenderJobs.subscribe(check);
      check();
    });
  },

  cancel: (id) => {
    set((s) => ({
      // A cancel CREATES finished jobs, so the bound has to be re-applied here
      // too — cancelling a long queue in one go would otherwise leave every one
      // of them in history. `trimHistory` never touches queued or running work.
      jobs: trimHistory(s.jobs.map((j) => {
        if (j.id !== id) return j;
        if (j.status === 'queued') {
          // It never reached the runner, so there is nothing to interrupt and no
          // flag to raise — it is simply over.
          return { ...j, status: 'cancelled' as const, finishedAt: storeNow() };
        }
        if (j.status === 'running') return { ...j, cancelRequested: true };
        return j; // already settled
      })),
    }));
  },

  active: () => get().jobs.find((j) => j.status === 'running'),

  isBusy: (kind) => get().jobs.some(
    (j) => !isFinished(j) && (kind === undefined || j.kind === kind),
  ),

  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((j) => !isFinished(j)) })),
}));

/** Rewrite one job in place. No-op if it has gone (trimmed, or never existed). */
const patch = (id: string, fn: (j: RenderJob) => RenderJob): void => {
  useRenderJobs.setState((s) => {
    const i = s.jobs.findIndex((j) => j.id === id);
    if (i === -1) return s;
    const next = s.jobs.slice();
    next[i] = fn(next[i]);
    return { jobs: next };
  });
};

/* ── the runner ────────────────────────────────────────────────────────────── */

/** The world the runner drives. The app passes the real render (T11c-b); a test
 *  passes a fake that resolves, throws, or reports stages on demand. */
export interface RenderRunnerDeps {
  /**
   * Perform one job. `onProgress(stage, total)` moves the job's progress for a
   * multi-stage render; a single-context render simply never calls it and goes
   * 0 → 1. `isCancelled()` reads the job's `cancelRequested` flag and should be
   * checked at every point the work can still be abandoned.
   */
  run: (
    job: RenderJob,
    onProgress: (stage: number, total: number) => void,
    isCancelled: () => boolean,
  ) => Promise<RenderJobResult>;
  /** Clock for `startedAt` / `finishedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Start draining the queue: one job at a time, in FIFO order, until stopped.
 *
 * Started ONCE by the app (T11c-b), and one at a time: the pump refuses to take
 * work while a job is `running`, so a second concurrent runner would simply idle.
 * Returns a stop function that detaches the subscription and lets the in-flight
 * job finish without another being taken — the queue is left intact, so a later
 * runner picks up exactly where this one left off.
 *
 * ORPHANS. A job left `running` by a runner that stopped (or a reload) has no
 * owner: its promise is gone, so nothing will ever settle it, and the pump's
 * "someone is running" check would then wedge every future runner against a job
 * that can never finish. It cannot be adopted — the render it was waiting on no
 * longer exists — so a new runner FAILS it, with a message saying so, before its
 * first pump. That is a real failure the user should see, not a silent reset.
 */
export function startRenderRunner(deps: RenderRunnerDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  let stopped = false;
  let pumping = false;

  useRenderJobs.setState((s) => (s.jobs.some((j) => j.status === 'running')
    ? {
      jobs: s.jobs.map((j) => (j.status === 'running'
        ? {
          ...j,
          status: 'failed' as const,
          error: 'orphaned by a previous runner',
          finishedAt: now(),
        }
        : j)),
    }
    : s));

  const runOne = async (job: RenderJob): Promise<void> => {
    const { id } = job;
    patch(id, (j) => ({ ...j, status: 'running', progress: 0, startedAt: now() }));

    const isCancelled = (): boolean =>
      useRenderJobs.getState().jobs.find((j) => j.id === id)?.cancelRequested === true;
    const onProgress = (stage: number, total: number): void => {
      if (!Number.isFinite(stage) || !Number.isFinite(total) || total <= 0) return;
      const p = Math.max(0, Math.min(1, stage / total));
      patch(id, (j) => (j.status === 'running' ? { ...j, progress: p } : j));
    };

    // The job the run function sees is the one the store holds now (it carries
    // `startedAt`), not the stale snapshot the pump matched on.
    const live = useRenderJobs.getState().jobs.find((j) => j.id === id) ?? job;

    let result: RenderJobResult | null = null;
    let error: string | undefined;
    try {
      result = await deps.run(live, onProgress, isCancelled);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const cancelled = isCancelled();
    patch(id, (j) => {
      // Someone already settled it — a new runner declaring this one orphaned is
      // the case that happens. A terminal state is never rewritten.
      if (isFinished(j)) return j;
      if (cancelled) {
        // The result of a render the user called off is thrown away — but if the
        // run function threw on its way out, its message is still recorded.
        return { ...j, status: 'cancelled', error, finishedAt: now() };
      }
      if (error !== undefined) {
        return { ...j, status: 'failed', error, finishedAt: now() };
      }
      return { ...j, status: 'done', progress: 1, result: result ?? {}, finishedAt: now() };
    });
    useRenderJobs.setState((s) => ({ jobs: trimHistory(s.jobs) }));
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (stopped) break;
        const { jobs } = useRenderJobs.getState();
        if (jobs.some((j) => j.status === 'running')) break; // another runner owns it
        const next = jobs.find((j) => j.status === 'queued');
        if (!next) break;
        await runOne(next);
      }
    } finally {
      pumping = false;
    }
  };

  const unsubscribe = useRenderJobs.subscribe(() => { void pump(); });
  void pump();

  return () => {
    stopped = true;
    unsubscribe();
  };
}

/* ── chunk safety ──────────────────────────────────────────────────────────── */

/** Whether a graph can be rendered in pieces, and why not when it cannot. */
export interface ChunkSafety {
  safe: boolean;
  /** One line per offending chain entry, naming the effect and the entry. */
  reasons: string[];
}

/** Resolve an effect id to its definition. The same seam `chainLatencySec` takes,
 *  so chunk safety can be asserted with no registry and no AudioContext. */
export type ResolveRackDef = (id: string) => RackEffectDef | undefined;

const defaultResolve: ResolveRackDef = (id) => getRackEffect(id);

/**
 * Could this insert chain be rendered one chunk at a time?
 *
 * Chunked rendering builds a fresh `OfflineAudioContext` per chunk, so every
 * node in the graph starts each chunk from silence. That is only sound for
 * effects whose output at time t depends on the input at time t (filters, EQ,
 * gain, waveshapers). An effect that carries audio forward — a convolution tail,
 * a feedback delay line, a compressor's envelope follower — would have its state
 * reset at every seam, and the join would be audible.
 *
 * Two things make a chain unsafe:
 *
 *  - An ENABLED entry whose definition declares `chunkUnsafe`. A BYPASSED entry
 *    does not count: `buildEffectChain` routes around it, so its state is not in
 *    the path at all — the same rule `chainLatencyReport` applies.
 *  - An entry whose id does not resolve. Every hosted `vst3` entry is one, as is
 *    any effect imported from another DAW. Their DSP is unknown to this app, so
 *    no claim about cross-chunk state can be made about them either way — and an
 *    unanswerable question is not a "yes". Unknown is unsafe.
 */
export function chainIsChunkSafe(
  entries: ChainEntry[],
  resolve: ResolveRackDef = defaultResolve,
): ChunkSafety {
  const reasons: string[] = [];
  for (const e of entries) {
    if (!e.enabled) continue; // routed around — not in the path
    const def = resolve(e.effect);
    if (!def) {
      reasons.push(`${e.effect} (${e.id}): unknown effect — its DSP is unknown, so no claim about cross-chunk state can be made`);
      continue;
    }
    if (def.chunkUnsafe) {
      reasons.push(`${def.label} (${e.id}): carries audio state across a chunk boundary`);
    }
  }
  return { safe: reasons.length === 0, reasons };
}

/** The shape of a track this predicate needs — id and insert chain, nothing
 *  else. `EditorTrack` satisfies it. */
export interface ChunkSafetyTrack {
  id: string;
  fxChain?: ChainEntry[];
}

/** The shape of a BUS this predicate needs. `EditorBus` satisfies it. */
export interface ChunkSafetyBus {
  id: string;
  fxChain?: ChainEntry[];
}

/**
 * Could the bounce this request describes be rendered in chunks?
 *
 * Runs `chainIsChunkSafe` over EVERY chain the request would actually build,
 * mirroring `renderCore.renderBounce`:
 *
 *  - `includeFx: false` builds no rack anywhere, so such a bounce is always
 *    chunk-safe.
 *  - A `track` scope is a stem: only that track's chain, and no master rack (a
 *    stem has no master bus). `renderBounce` also strips hosted `vst3` entries
 *    from a stem — they are printed on the backend as a LATER stage of the job —
 *    so they are not in the offline graph this predicate gates, and do not make
 *    it unsafe. The master and selection scopes leave them in, where they do.
 *  - `master` and `selection` cover the master rack plus every track's chain.
 *  - `buses` cover the BUS racks, which every bounce that walks the routing
 *    graph builds (lib/render/bounceWalksMix: the master scope since T14, and a
 *    clip selection printed with its inserts). A bus rack is as capable of
 *    carrying state across a chunk boundary as a track's. A stem is
 *    pre-routing, so it does not read them. The argument is OPTIONAL and
 *    defaults to none, which is the pre-bus behaviour and the right answer for
 *    a document with no buses.
 *
 * Mute and solo are deliberately NOT modelled. `renderBounce` skips a silenced
 * track's rack, so ignoring them can only ever call a bounce unsafe that was in
 * fact safe — the direction a gate should err in.
 */
export function bounceIsChunkSafe(
  req: BounceRequest,
  tracks: ChunkSafetyTrack[],
  masterFxChain: ChainEntry[],
  resolve: ResolveRackDef = defaultResolve,
  buses: ChunkSafetyBus[] = [],
): ChunkSafety {
  if (!req.includeFx) return { safe: true, reasons: [] };

  const { scope } = req;
  const isStem = scope.kind === 'track';
  const universe = isStem ? tracks.filter((t) => t.id === scope.trackId) : tracks;

  const chains: ChainEntry[][] = [];
  if (!isStem) chains.push(masterFxChain);
  for (const t of universe) {
    const chain = t.fxChain ?? [];
    chains.push(isStem ? chain.filter((e) => e.effect !== 'vst3') : chain);
  }
  if (bounceWalksMix(req)) {
    for (const b of buses) chains.push(b.fxChain ?? []);
  }

  const reasons: string[] = [];
  for (const chain of chains) reasons.push(...chainIsChunkSafe(chain, resolve).reasons);
  return { safe: reasons.length === 0, reasons };
}
