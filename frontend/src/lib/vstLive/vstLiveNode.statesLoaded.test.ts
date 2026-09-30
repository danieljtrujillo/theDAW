/**
 * A live plugin node never spawns its host on an entry whose saved state is
 * still loading from IndexedDB (T18 audit, MAJOR 3).
 *
 * `registry.acquire` hands `entry.vst.raw_state` to the host it spawns. On
 * startup a MIX entry's state arrives a moment after hydration; a node built
 * in that gap (the MIX rack attaching on mount) used to spawn the plugin at
 * its DEFAULTS, and the state the host wrote back on teardown then replaced
 * the user's saved row. The node now waits for `vstStatesLoaded`, acquires
 * with the entry as it is once loaded, and a node disposed while waiting
 * never acquires at all.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.statesLoaded.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from '../../state/effectChainStore.fakeIdb.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { VstLiveSession, VstSessionRegistry } from './sessionRegistry.ts';

const mem = installLocalStorage();
const idb = new FakeIdb([
  ['e1', { rawState: 'SAVED-1', stateHost: 'thedaw' }],
  ['e2', { rawState: 'SAVED-2', stateHost: 'thedaw' }],
]);
idb.install();
idb.holdGets = true;

const vst = (name: string) => ({ plugin_path: `C:/VST3/${name}.vst3`, plugin_name: name });
mem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: [
        { id: 'e1', effect: 'vst3', params: {}, enabled: true, vst: vst('One') },
        { id: 'e2', effect: 'vst3', params: {}, enabled: true, vst: vst('Two') },
      ],
    },
    version: 1,
  }),
);

const { useEffectChainStore, vstStatesLoaded } = await import('../../state/effectChainStore.ts');
const { createVstLiveNode } = await import('./vstLiveNode.ts');

/* ── fakes: an audio context with a worklet, and a registry that records ─── */
class FakeGain {
  gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, cancelScheduledValues: () => {} };
  connect(d: unknown): unknown {
    return d;
  }
  disconnect(): void {}
}
const ctx = {
  currentTime: 0,
  sampleRate: 48000,
  audioWorklet: { addModule: async () => {} },
  createGain: () => new FakeGain(),
} as unknown as BaseAudioContext;

const acquired: ChainEntry[] = [];
const registry = {
  acquire: (e: ChainEntry) => {
    acquired.push(e);
    return Promise.resolve(null as VstLiveSession | null);
  },
  release: () => {},
  get: () => undefined,
  markParamsChanged: () => {},
} as unknown as VstSessionRegistry;
const deps = { registry, parkMs: 0, ensureModule: async () => {} };

/* ── two nodes built before the loads settle ──────────────────────────────── */
const [snap1, snap2] = useEffectChainStore.getState().chain;
assert.equal(snap1.vst?.raw_state, undefined, 'precondition: the state has not arrived');
const node1 = createVstLiveNode(ctx, snap1, deps);
const node2 = createVstLiveNode(ctx, snap2, deps);
assert.ok(node1 && node2, 'both entries are hostable here');
await tick(10);
assert.deepEqual(acquired, [], 'no host is spawned while a saved state is still loading');

/* ── one is torn down while waiting ───────────────────────────────────────── */
node2!.dispose();

/* ── the loads settle ─────────────────────────────────────────────────────── */
idb.releaseGets();
await vstStatesLoaded;
await tick(10);
assert.equal(acquired.length, 1, 'exactly one acquire: the disposed node never acquires, the live one once');
assert.equal(acquired[0].id, 'e1');
assert.equal(acquired[0].vst?.raw_state, 'SAVED-1', 'the host is spawned WITH the loaded state');

node1!.dispose();
console.log('vstLiveNode.statesLoaded: ok');
