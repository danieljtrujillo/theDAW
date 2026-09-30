/**
 * FE-007 — owns the ONE `PeaksDecodeQueue` instance for a component's whole
 * life: created ON DEMAND (never during render) and disposed + its ref
 * NULLED on unmount.
 *
 * WHY ON DEMAND, NOT `useRef(createPeaksDecodeQueue(...))` OR A
 * "CREATE-IF-NULL DURING RENDER" CHECK — and why the unmount cleanup must
 * NULL the ref, not just call `dispose()`:
 *
 * `dispose()` is terminal (`peaksDecodeScheduler.ts`'s own contract: once
 * disposed, `sync` is permanently a no-op). React 19 StrictMode (dev only)
 * mounts a component, runs its effects, runs every effect's CLEANUP, then
 * runs the SAME effects again — WITHOUT re-rendering. A ref built once
 * during the FIRST render (or lazily on first read, then just returned from
 * `.current` thereafter) is never rebuilt by that dance; only the cleanup
 * itself can change what `.current` holds. A cleanup that disposes the queue
 * but leaves `.current` pointing at the now-disposed instance means the
 * StrictMode-simulated remount's effect reads that SAME disposed queue back
 * out — every `sync()` after that point is silently a no-op FOREVER: no
 * clip imported, recorded, pasted, inpainted or take-switched after the
 * remount ever gets a waveform. Proven in
 * `usePeaksDecodeQueue.strictMode.test.tsx` with real React 19 + jsdom.
 *
 * The fix — build lazily via `??=` and NULL (not just dispose) the ref on
 * unmount — is this repo's own documented pattern for an on-demand,
 * dispose-on-unmount resource owned by a ref (`EffectKnob.tsx:59-62`,
 * `EffectXYPad.tsx:45`, `SlideTrack.tsx:54`): the NEXT mount's first
 * `getQueue()` call then builds a fresh instance instead of reading the dead
 * one.
 */

import { useCallback, useEffect, useRef } from 'react';
import { createPeaksDecodeQueue, type PeaksDecodeQueue } from './peaksDecodeScheduler';

/** Returns a stable `getQueue()` accessor for the one `PeaksDecodeQueue<Blob>`
 *  this component owns, built on first use and rebuilt (fresh) after a
 *  StrictMode-simulated or real unmount/remount. `concurrency` is read once,
 *  at the first `getQueue()` call that actually creates the queue — a later
 *  change to it has no effect on an already-created instance, matching
 *  `PEAKS_DECODE_CONCURRENCY` being a module-level constant, never a prop. */
export function usePeaksDecodeQueue(concurrency: number): () => PeaksDecodeQueue<Blob> {
  const ref = useRef<PeaksDecodeQueue<Blob> | null>(null);
  const getQueue = useCallback(
    (): PeaksDecodeQueue<Blob> => (ref.current ??= createPeaksDecodeQueue<Blob>(concurrency)),
    [concurrency],
  );
  useEffect(() => () => {
    ref.current?.dispose();
    // NULLED, not left disposed: the next mount (a real one, or StrictMode's
    // simulated remount, which reuses this same ref) must build a fresh
    // queue on its first `getQueue()` call rather than reading the dead one.
    ref.current = null;
  }, []);
  return getQueue;
}
