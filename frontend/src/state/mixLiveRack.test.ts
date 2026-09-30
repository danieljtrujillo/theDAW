/**
 * mixLiveRack — the MIX tab's subset of the unified chain, and what reaches the
 * global master insert.
 *
 * The rule this file exists for: a `vst3` entry added in MIX (where the user
 * adds Ozone) used to be filtered out BEFORE `buildEffectChain` ever saw it,
 * because the subset was `MIX_RACK_IDS` and that set is derived from
 * `RACK_EFFECTS`, which never contains `vst3`. The plugin therefore did
 * nothing at all on the live master — it only printed at bounce. Now the
 * hosted entry rides through to the chain builder's own `vst3` branch, which
 * is the ONE place that decides whether a plugin can be hosted here.
 *
 * Everything else about the subset is unchanged, and that is asserted too: a
 * backend-only id (`delay`, whose param shape collides with the rack's) is
 * still kept off the live insert.
 *
 * There is no Web Audio under tsx, so the graph is fake in exactly the way
 * `rackEffects.chain.test.ts` fakes it, and the plugin node comes through
 * `buildEffectChain`'s `vstFactory` seam rather than a real host process.
 *
 * Run: npx tsx src/state/mixLiveRack.test.ts
 */
import assert from 'node:assert/strict';

import { buildEffectChain, type RackEffectDef, type RackEffectInstance } from '../lib/rackEffects.ts';
import { liveRackEntries, mixRackSubset, rackEntryLabel } from './mixLiveRack.ts';
import type { ChainEntry } from './effectChainStore.ts';

/* ── fake audio graph (see rackEffects.chain.test.ts) ──────────────────────── */

const edges = new Set<string>();

class FakeNode {
  constructor(readonly name: string) {}
  connect(dest: FakeNode): FakeNode {
    edges.add(`${this.name}->${dest.name}`);
    return dest;
  }
  disconnect(dest?: FakeNode): void {
    if (dest) edges.delete(`${this.name}->${dest.name}`);
    else for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}

const asNode = (n: FakeNode) => n as unknown as AudioNode;
const wiring = () => [...edges].sort();
const assertWiring = (expected: string[], msg?: string) =>
  assert.deepEqual(wiring(), [...expected].sort(), msg);

let madeCount = 0;

/** A fake plugin instance, standing in for the live bridge node. */
interface FakePlugin extends RackEffectInstance {
  tag: string;
  disposeCount: number;
}

const plugins: FakePlugin[] = [];

/** The `vstFactory` seam: one fake node per entry, remembering its disposals so
 *  "removing the entry releases the session" is observable. */
const vstFactory = (_ctx: BaseAudioContext, e: ChainEntry): RackEffectInstance | null => {
  if (!e.vst?.plugin_path) return null;
  const tag = `vst#${++madeCount}`;
  const inst: FakePlugin = {
    tag,
    disposeCount: 0,
    input: asNode(new FakeNode(`${tag}.in`)),
    output: asNode(new FakeNode(`${tag}.out`)),
    setParams: () => {},
    dispose() {
      this.disposeCount += 1;
    },
  };
  plugins.push(inst);
  return inst;
};

/** A one-node stand-in for `spatializer`, so the reorder assertions run without
 *  a real AudioContext. The real factory builds a PannerNode graph. */
const FAKE_SPATIALIZER: RackEffectDef = {
  id: 'spatializer',
  label: 'Spatializer',
  group: 'test',
  description: '',
  params: [],
  make: () => {
    const tag = `sp#${++madeCount}`;
    return {
      input: asNode(new FakeNode(`${tag}.in`)),
      output: asNode(new FakeNode(`${tag}.out`)),
      setParams: () => {},
      dispose: () => {},
    };
  },
};

/** The rack registry the chain builder sees here: only `spatializer` resolves,
 *  which is all these assertions need. `vst3` must NOT resolve — the `vstFactory`
 *  branch is what has to pick it up. */
const resolve = (id: string): RackEffectDef | undefined =>
  id === 'spatializer' ? FAKE_SPATIALIZER : undefined;

const ctx = {} as BaseAudioContext;

const vstEntry = (id: string, enabled = true): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled,
  vst: { plugin_path: `C:/plugins/${id}.vst3`, plugin_name: id },
});

/* ── the subset lets a hosted plugin through, and nothing else changes ─────── */
{
  const chain: ChainEntry[] = [
    { id: 'a', effect: 'spatializer', params: {}, enabled: true },
    vstEntry('ozone'),
    // A backend-owned id whose param shape collides with a rack id: it must
    // STAY off the live insert, exactly as before.
    { id: 'b', effect: 'delay', params: {}, enabled: true },
  ];
  assert.deepEqual(
    mixRackSubset(chain).map((e) => e.id),
    ['a', 'ozone'],
    'a vst3 entry reaches the live rack; a backend-only id still does not',
  );
  assert.deepEqual(
    liveRackEntries(chain, true).map((e) => e.id),
    ['a', 'ozone'],
    'a live plugin is named as colouring the global master',
  );
  assert.deepEqual(liveRackEntries(chain, false), [], 'nothing is live while detached');
  assert.equal(rackEntryLabel(chain[1]), 'ozone', 'a plugin row is named by its plugin, not "vst3"');
}

/* ── a bypassed plugin is in the subset but contributes no node ─────────────── */
{
  const chain = [vstEntry('oz', false)];
  assert.deepEqual(
    mixRackSubset(chain).map((e) => e.id),
    ['oz'],
    'a bypassed plugin stays in the subset (the chain builder owns bypass)',
  );
  assert.deepEqual(liveRackEntries(chain, true), [], 'a bypassed plugin colours nothing');
}

/* ── the subset feeds buildEffectChain, which hosts the plugin live ────────── */
{
  edges.clear();
  plugins.length = 0;
  madeCount = 0;

  const input = new FakeNode('in');
  const output = new FakeNode('out');
  const chain: ChainEntry[] = [vstEntry('oz')];

  const handle = buildEffectChain(ctx, asNode(input), asNode(output), mixRackSubset(chain), {
    resolve,
    vstFactory,
  });

  assert.equal(plugins.length, 1, 'the MIX rack built a live instance for the vst3 entry');
  assertWiring(['in->vst#1.in', 'vst#1.out->out'], 'the plugin is in the master insert path');
  assert.deepEqual(handle.inertIds?.(), [], 'a hosted plugin is not reported inert');

  /* bypass: routed around, instance kept */
  handle.rebuild(mixRackSubset([vstEntry('oz', false)]));
  assert.equal(plugins.length, 1, 'bypass did not re-make the plugin');
  assert.equal(plugins[0].disposeCount, 0, 'bypass did not dispose the plugin');
  assertWiring(['in->out'], 'a bypassed plugin is routed around, leaving a clean insert');

  /* re-enable: the SAME instance goes back in the path */
  handle.rebuild(mixRackSubset([vstEntry('oz')]));
  assert.equal(plugins.length, 1, 're-enabling reused the running session');
  assertWiring(['in->vst#1.in', 'vst#1.out->out'], 'the same plugin is back in the path');

  /* reorder: a rack effect moved around the plugin re-threads in chain order */
  const rack: ChainEntry = { id: 'sp', effect: 'spatializer', params: {}, enabled: true };
  handle.rebuild(mixRackSubset([rack, vstEntry('oz')]));
  const beforeReorder = plugins[0].disposeCount;
  handle.rebuild(mixRackSubset([vstEntry('oz'), rack]));
  assert.equal(plugins.length, 1, 'a reorder did not respawn the plugin host');
  assert.equal(plugins[0].disposeCount, beforeReorder, 'a reorder did not dispose the plugin');

  /* remove: the entry left the chain, so its instance is disposed — which is
     what starts the registry's grace timer and ultimately closes the session */
  handle.rebuild(mixRackSubset([rack]));
  assert.equal(plugins[0].disposeCount, 1, 'removing the entry disposed its live instance');

  handle.dispose();
}

console.log('mixLiveRack: ok');
