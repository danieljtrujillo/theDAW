/**
 * stretchWorklet — one lazy loader for the Signalsmith Stretch WASM node.
 *
 * The DJ decks load it for key-lock; the Shard Engine loads it per LOOM lane for
 * the `transpose` lock. Sharing the dynamic import means the ~100 KB module is
 * fetched once, and a failure (no WASM, blocked worklet) is reported once.
 */
import type { StretchNode } from 'signalsmith-stretch';

let modulePromise: Promise<typeof import('signalsmith-stretch')> | null = null;

export async function createStretchNode(ctx: AudioContext): Promise<StretchNode> {
  if (!modulePromise) {
    modulePromise = import('signalsmith-stretch').catch((e) => {
      modulePromise = null; // allow a later retry
      throw e;
    });
  }
  const { default: SignalsmithStretch } = await modulePromise;
  return SignalsmithStretch(ctx);
}

export type { StretchNode };
