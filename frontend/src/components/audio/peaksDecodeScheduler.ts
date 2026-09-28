/**
 * FE-007 — which clips need a peaks decode started right now, and a small
 * queue capping how many run at once.
 *
 * Pure and DOM-free, like `clipDoubleClick.ts`. `WaveformEditor`'s
 * peaks-decode effect keeps ONE `PeaksDecodeQueue` across renders (a ref) and
 * calls `sync` on every `clips` change with `clipsNeedingPeaksDecode(clips,
 * failedBlobs)`.
 *
 * HISTORY. The effect used to share ONE `cancelled` flag across its whole
 * scan: ANY `clips` change aborted EVERY in-flight decode and restarted the
 * scan from the top, so a drag (or anything else that touches `clips`
 * repeatedly) could keep cancelling and re-queuing the same decodes without
 * ever finishing. Keying the in-flight bookkeeping per clip id fixed that —
 * but exposed a second bug an audit caught: `acceptInpaint` and switching a
 * take REPLACE a clip's `audioBlob` (and clear its `peaks`) while a decode
 * for the OLD blob may still be running. Keyed on id alone, the effect saw
 * the id was "in flight" and skipped the clip entirely; the stale decode
 * then settled and wrote the OLD audio's peaks onto a clip that now held NEW
 * audio, so the new audio was never decoded at all.
 *
 * Keying on id+BLOB fixed THAT — but a re-audit caught a THIRD bug in the
 * fix: `pump` started the new blob's decode by OVERWRITING `running`'s entry
 * for the same id, so the OLD decode (still physically running — there is no
 * way to abort a decode already in flight) silently stopped being counted
 * against the concurrency cap. Two real decodes for the SAME clip id could
 * then run at once, and the cap of `concurrency` could be exceeded overall
 * (reproduced: 3 in flight with `concurrency = 2`). `pump` now refuses to
 * start an item whose id is ALREADY running — it stays queued — until the
 * stale decode's `settle` frees that id. `settle` itself was already keyed
 * on the exact blob, so a stale settle still cannot evict a newer entry.
 *
 * CONCURRENCY. Each `computePeaks` holds a full decoded PCM buffer plus its
 * own `AudioContext`, so running every pending clip's decode in parallel is
 * wasteful on a project with many clips. `createPeaksDecodeQueue` bounds how
 * many run at once (never more than one per clip id, and never more than
 * `concurrency` in total); the rest wait in a small in-memory queue.
 *
 * FAILURES. A decode that fails is not retried on every unrelated `clips`
 * change — only once its clip's blob actually changes — so a clip whose
 * audio truly cannot be decoded does not get re-attempted, and re-logged,
 * on every drag/rename/etc. elsewhere in the document. The caller tracks
 * which blob failed per clip id and passes it to `clipsNeedingPeaksDecode`;
 * a NEW blob for that id is not the one that failed, so it is retried.
 */

/** A clip id paired with the exact blob its decode is for. */
export interface PeaksDecodeItem<B> {
  readonly id: string;
  readonly blob: B;
}

/** The subset of a clip this module reads. */
export interface PeaksClip<B> {
  readonly id: string;
  readonly peaks?: unknown;
  /** Absent on a piano-roll clip with no render: it has nothing to scan. */
  readonly audioBlob?: B;
}

/**
 * Clips with no peaks yet, as `{id, blob}` pairs, in order — excluding a
 * clip whose CURRENT blob is the exact one `failedBlobs` records as having
 * already failed for that id (a decode is retried only once the blob
 * actually changes, not on every unrelated `clips` change). Whether an item
 * is already running or queued is the QUEUE's job (`has`/`sync` below), not
 * this function's — it only reads clip state, so it stays a plain, cheap
 * per-render read with no bookkeeping of its own.
 */
export function clipsNeedingPeaksDecode<B>(
  clips: readonly PeaksClip<B>[],
  failedBlobs: ReadonlyMap<string, B> = new Map(),
): Array<PeaksDecodeItem<B>> {
  const out: Array<PeaksDecodeItem<B>> = [];
  for (const c of clips) {
    if (c.peaks) continue;
    if (c.audioBlob === undefined || c.audioBlob === null) continue;
    if (failedBlobs.get(c.id) === c.audioBlob) continue;
    out.push({ id: c.id, blob: c.audioBlob });
  }
  return out;
}

/**
 * `failedBlobs` (WaveformEditor's `peaksFailedBlob`, tracking which blob most
 * recently failed to decode per clip id) with any id NOT in `liveClipIds`
 * dropped. A clip that is deleted must not keep its failure entry forever —
 * the entry's VALUE is a `Blob`, so an unpruned entry pins that clip's audio
 * in memory for the life of the mount even after the clip itself is gone.
 * The caller re-assigns its ref to this function's result before every
 * `sync` (a pure function returns a new Map; it does not mutate `failedBlobs`).
 */
export function pruneFailedBlobs<B>(
  failedBlobs: ReadonlyMap<string, B>,
  liveClipIds: ReadonlySet<string>,
): Map<string, B> {
  const out = new Map<string, B>();
  for (const [id, blob] of failedBlobs) {
    if (liveClipIds.has(id)) out.set(id, blob);
  }
  return out;
}

export interface PeaksDecodeQueue<B> {
  /** True while `id` is running OR queued for exactly `blob` (compared with
   *  `===`, so two decoded copies of "the same audio" are still distinct). */
  has(id: string, blob: B): boolean;
  /**
   * Reconcile against the clips that currently need a decode: drop a queued
   * (not yet started) entry whose id+blob is no longer in `needed` — the
   * clip moved on again before its decode even began — enqueue any `needed`
   * item not already running or queued for its exact blob, then start as
   * many queued items as capacity allows, calling `start` synchronously for
   * each one started (never for one still waiting). A no-op once `dispose`d.
   */
  sync(needed: readonly PeaksDecodeItem<B>[], start: (item: PeaksDecodeItem<B>) => void): void;
  /**
   * `id`'s decode for `blob` has settled (success or failure): free its slot
   * and start the next eligible queued item, if capacity allows. Matched on
   * the EXACT blob, not id alone: if the same clip's blob changed again
   * while this decode was still running, a newer decode may already be
   * queued (or, once it gets its turn, running) for this id — freeing the
   * slot here on the stale settle must not let that queued item start
   * before the REAL current decode for this id has had its turn.
   */
  settle(id: string, blob: B, start: (item: PeaksDecodeItem<B>) => void): void;
  /**
   * Drop every PENDING (not yet started) item. Decodes already running are
   * left alone — they cannot be aborted — but their eventual `settle` will
   * no longer start anything new. Call on unmount: nothing should start a
   * fresh decode for a component that is gone.
   */
  dispose(): void;
}

/** `concurrency` — the cap on decodes started at once — must be a positive
 *  integer. Two decodes for the SAME clip id never run at once regardless of
 *  `concurrency`: a second item for an id already running stays queued until
 *  the first settles. */
export function createPeaksDecodeQueue<B>(concurrency: number): PeaksDecodeQueue<B> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer (got ${concurrency})`);
  }
  const running = new Map<string, B>();
  const queue: Array<PeaksDecodeItem<B>> = [];
  let disposed = false;

  const pump = (start: (item: PeaksDecodeItem<B>) => void): void => {
    if (disposed) return;
    let i = 0;
    while (running.size < concurrency && i < queue.length) {
      const item = queue[i];
      // An id already running (a stale decode for an OLDER blob of the same
      // clip) is left queued in place — starting it now would run two real
      // decodes for the same id at once and silently overwrite `running`'s
      // bookkeeping for it, undercounting the concurrency cap.
      if (running.has(item.id)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      running.set(item.id, item.blob);
      start(item);
      // Item at `i` was removed; the next item has shifted into place there.
    }
  };

  return {
    has(id, blob) {
      if (running.get(id) === blob) return true;
      return queue.some((q) => q.id === id && q.blob === blob);
    },
    sync(needed, start) {
      if (disposed) return;
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (!needed.some((n) => n.id === q.id && n.blob === q.blob)) queue.splice(i, 1);
      }
      for (const item of needed) {
        if (running.get(item.id) === item.blob) continue;
        if (queue.some((q) => q.id === item.id && q.blob === item.blob)) continue;
        queue.push(item);
      }
      pump(start);
    },
    settle(id, blob, start) {
      if (running.get(id) === blob) running.delete(id);
      pump(start);
    },
    dispose() {
      disposed = true;
      queue.length = 0;
    },
  };
}
