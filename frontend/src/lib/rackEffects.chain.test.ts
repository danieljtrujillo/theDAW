/**
 * buildEffectChain wiring: bypass keeps the instance, unknown ids stay visible.
 *
 * Two live-graph rules this pins down:
 *
 *  - A bypassed entry (`enabled: false`) is routed AROUND, not torn down. The
 *    instance, its params and its tails/buffers survive, and re-enabling puts
 *    the SAME instance object back in the path. Disposal happens only when the
 *    entry leaves the chain or the handle is disposed.
 *  - An entry whose effect id is not in the rack registry (every `vst3` entry)
 *    contributes no node, but it is not silent about it: the handle reports it
 *    through `inertIds()` and one console.warn per entry id names it. The
 *    enabled effects around it still wire in order.
 *
 * There is no Web Audio under tsx, so the graph here is fake: `FakeNode`
 * records connect/disconnect and keeps a live edge set, and the effects come
 * from a fake registry injected through `buildEffectChain`'s `resolve` seam
 * (the only stub — the real factories build concrete Web Audio nodes a fake
 * context cannot satisfy). Everything else is the production chain builder.
 *
 * Run: npx tsx src/lib/rackEffects.chain.test.ts
 */
import assert from 'node:assert/strict';

import { buildEffectChain, getRackEffect, type RackEffectDef, type RackEffectInstance } from './rackEffects.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';

/* ── fake audio graph ──────────────────────────────────────────────────────── */

/** Live edges of the fake graph, as `from->to` strings.
 *
 *  A repeated identical `connect(a, b)` is therefore invisible here — the Set
 *  already holds that edge. That matches Web Audio, where connecting the same
 *  output to the same input twice is a no-op and does NOT sum the signal, so
 *  the fake is not hiding a double-connection bug: "no node is wired in twice"
 *  holds because `rebuild` always tears every edge down in `clearWiring` and
 *  re-threads the chain from `input`, not because the Set deduplicates. */
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
/** Current graph as a sorted list, so assertions read as the whole topology. */
const wiring = () => [...edges].sort();
/** Assert the WHOLE live graph, order-insensitively. */
const assertWiring = (expected: string[], msg?: string) =>
  assert.deepEqual(wiring(), [...expected].sort(), msg);

/* ── fake effect registry ──────────────────────────────────────────────────── */

interface FakeInstance extends RackEffectInstance {
  /** `alpha#1` — the ordinal proves whether a rebuild reused or re-made it. */
  tag: string;
  disposeCount: number;
  paramPushes: Record<string, number>[];
}

/** Every instance ever made, newest last, across all chains in this file. */
const made: FakeInstance[] = [];
let madeCount = 0;

const FAKE_PARAMS = [
  { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, default: 0.1 },
];

/** Registry of three single-node effects; anything else resolves to undefined
 *  (the `vst3` case: present in state, unknown to the live rack). */
const FAKE_DEFS = new Map<string, RackEffectDef>(
  ['alpha', 'beta', 'gamma'].map((id) => [
    id,
    {
      id,
      label: id,
      group: 'test',
      description: '',
      params: FAKE_PARAMS,
      make: (_ctx, params) => {
        const tag = `${id}#${++madeCount}`;
        const inst: FakeInstance = {
          tag,
          disposeCount: 0,
          paramPushes: [{ ...params }],
          input: asNode(new FakeNode(`${tag}.in`)),
          output: asNode(new FakeNode(`${tag}.out`)),
          setParams: (p) => { inst.paramPushes.push({ ...p }); },
          dispose: () => { inst.disposeCount += 1; },
        };
        made.push(inst);
        return inst;
      },
    } satisfies RackEffectDef,
  ]),
);

const resolve = (id: string) => FAKE_DEFS.get(id);
const ctx = {} as unknown as BaseAudioContext;

const entry = (id: string, effect: string, enabled = true, params: Record<string, number> = {}): ChainEntry =>
  ({ id, effect, enabled, params });

/** The live instance the handle holds for an entry id, or undefined. */
const instOf = (h: ReturnType<typeof buildEffectChain>, id: string) =>
  h.instances().find((x) => x.id === id)?.inst as FakeInstance | undefined;

/* ── an enabled chain wires in order ───────────────────────────────────────── */

const input = new FakeNode('IN');
const output = new FakeNode('OUT');

const a = entry('a', 'alpha', true, { drive: 0.8 });
const b = entry('b', 'beta');

const handle = buildEffectChain(ctx, asNode(input), asNode(output), [a, b], { resolve });

const alpha = instOf(handle, 'a');
const beta = instOf(handle, 'b');
assert.ok(alpha && beta, 'both enabled entries got an instance');
assertWiring([`IN->${alpha.tag}.in`, `${alpha.tag}.out->${beta.tag}.in`, `${beta.tag}.out->OUT`]);

// Entry params merge ONTO the definition's defaults at construction.
assert.deepEqual(alpha.paramPushes[0], { mix: 0.5, drive: 0.8 });

/* ── bypass routes around the instance and keeps it alive ──────────────────── */

handle.rebuild([{ ...a, enabled: false }, b]);

assert.equal(instOf(handle, 'a'), alpha, 'the bypassed entry keeps the SAME instance object');
assert.equal(alpha.disposeCount, 0, 'bypass must not dispose — tails and buffers survive');
assertWiring(
  [`IN->${beta.tag}.in`, `${beta.tag}.out->OUT`],
  'prev connects straight to next; the bypassed instance is out of the audio path',
);

// A bypassed instance still takes live param moves, so re-enabling is in sync.
handle.updateParams('a', { mix: 0.2 });
assert.deepEqual(
  alpha.paramPushes.at(-1),
  { mix: 0.2, drive: 0.8 },
  'updateParams merges into the entry state, it does not reset to catalog defaults',
);

/* ── re-enabling re-inserts the SAME instance ──────────────────────────────── */

handle.rebuild([a, b]);

assert.equal(instOf(handle, 'a'), alpha, 're-enable reuses the instance, it does not re-make it');
assertWiring([`IN->${alpha.tag}.in`, `${alpha.tag}.out->${beta.tag}.in`, `${beta.tag}.out->OUT`]);
assert.equal(made.length, 2, 'a bypass round-trip built no new instances');

/* ── instance reuse across a plain rebuild, params pushed not rebuilt ──────── */

handle.rebuild([{ ...a, params: { drive: 0.3 } }, b]);
assert.equal(instOf(handle, 'a'), alpha);
assert.deepEqual(alpha.paramPushes.at(-1), { mix: 0.5, drive: 0.3 });
assert.equal(made.length, 2);

/* ── dispose happens on removal, and on handle.dispose() ───────────────────── */

handle.rebuild([b]);
assert.equal(alpha.disposeCount, 1, 'leaving the chain disposes the instance');
assert.equal(instOf(handle, 'a'), undefined);
assertWiring([`IN->${beta.tag}.in`, `${beta.tag}.out->OUT`]);

handle.dispose();
assert.equal(beta.disposeCount, 1, 'handle.dispose() disposes what is left');
assert.equal(alpha.disposeCount, 1, 'and does not double-dispose what already left');
assertWiring([], 'dispose leaves no edges behind');

/* ── unknown ids are inert, visible, and warned about exactly once ─────────── */

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

const input2 = new FakeNode('IN2');
const output2 = new FakeNode('OUT2');
const v = entry('v', 'vst3');
const g = entry('g', 'gamma');

const h2 = buildEffectChain(ctx, asNode(input2), asNode(output2), [a, v, g], { resolve });

const alpha2 = instOf(h2, 'a');
const gamma = instOf(h2, 'g');
assert.ok(alpha2 && gamma);
assert.equal(instOf(h2, 'v'), undefined, 'an unknown id contributes no node');
assertWiring(
  [`IN2->${alpha2.tag}.in`, `${alpha2.tag}.out->${gamma.tag}.in`, `${gamma.tag}.out->OUT2`],
  'the enabled entries around the inert one are still wired in order',
);

assert.deepEqual(h2.inertIds?.(), ['v'], 'the handle reports the entry the live graph cannot render');
assert.equal(warnings.length, 1, 'exactly one warning for the entry');
assert.ok(warnings[0].includes('v') && warnings[0].includes('vst3'), `warning names the entry and effect: ${warnings[0]}`);

// Rebuilds are frequent (every topology change); the warning does not repeat.
h2.rebuild([a, v, g]);
h2.rebuild([v, a, g]);
assert.equal(warnings.length, 1, 'one warning per entry id, not per rebuild');
assert.deepEqual(h2.inertIds?.(), ['v']);
assertWiring(
  [`IN2->${alpha2.tag}.in`, `${alpha2.tag}.out->${gamma.tag}.in`, `${gamma.tag}.out->OUT2`],
  'an inert entry at the head of the order changes nothing',
);

// Disabled unknown entries are off by intent, not silently dropped: nothing to report.
h2.rebuild([a, { ...v, enabled: false }, g]);
assert.deepEqual(h2.inertIds?.(), [], 'a bypassed unknown entry is not reported as inert');
assert.equal(warnings.length, 1);

/* ── every unknown id warns once; repointing an entry is a new fact ────────── */

// A second entry carrying a DIFFERENT unknown id gets its own single warning.
const x = entry('x', 'imported-x');
h2.rebuild([a, v, x, g]);
assert.deepEqual(h2.inertIds?.(), ['v', 'x'], 'both unrenderable entries are reported, in chain order');
assert.equal(warnings.length, 2, 'the second unknown id warns once of its own');
assert.ok(warnings[1].includes('x') && warnings[1].includes('imported-x'), `names the second: ${warnings[1]}`);

h2.rebuild([a, v, x, g]);
assert.equal(warnings.length, 2, 'neither of the two repeats on a further rebuild');

// Warn-once is keyed on entry id + effect id, so pointing the SAME entry at a
// different unknown effect is a new fact about the chain and is warned again.
h2.rebuild([a, { ...v, effect: 'imported-x' }, g]);
assert.equal(warnings.length, 3, 'an entry repointed at another unknown effect warns again');
assert.ok(warnings[2].includes('v') && warnings[2].includes('imported-x'), `names the repointed entry: ${warnings[2]}`);
assert.deepEqual(h2.inertIds?.(), ['v']);

// A chain of nothing but inert entries is a clean passthrough.
h2.rebuild([v]);
assertWiring(['IN2->OUT2'], 'inert-only chain passes input straight to output');
assert.equal(alpha2.disposeCount, 1, 'the effects it replaced were disposed');
assert.equal(gamma.disposeCount, 1, 'both of them, not just the first');

h2.dispose();
console.warn = realWarn;
assertWiring([]);
assert.deepEqual(h2.inertIds?.(), [], 'a disposed chain renders nothing, so it reports nothing inert');

/* ── a repointed entry id is re-made, and the effect it replaced disposed ──── */

const input3 = new FakeNode('IN3');
const output3 = new FakeNode('OUT3');
const h3 = buildEffectChain(ctx, asNode(input3), asNode(output3), [entry('x1', 'alpha')], { resolve });

const swapFrom = instOf(h3, 'x1');
assert.ok(swapFrom);

h3.rebuild([entry('x1', 'beta')]);
const swapTo = instOf(h3, 'x1');
assert.ok(swapTo);
assert.notEqual(swapTo, swapFrom, 'a different effect at the same entry id is a different instance');
assert.notEqual(swapTo.tag, swapFrom.tag);
assert.equal(swapFrom.disposeCount, 1, 'the effect it replaced is disposed');
assert.ok(
  !h3.instances().some((i) => i.inst === swapFrom),
  'and the replaced instance is gone from the handle',
);
assertWiring([`IN3->${swapTo.tag}.in`, `${swapTo.tag}.out->OUT3`]);

h3.dispose();
assert.equal(swapTo.disposeCount, 1);
assert.equal(swapFrom.disposeCount, 1, 'the replaced instance is not disposed a second time');

/* ── an entry that has never been enabled is never built ───────────────────── */

const input4 = new FakeNode('IN4');
const output4 = new FakeNode('OUT4');
const madeBefore = made.length;
const off = entry('off', 'gamma', false);

const h4 = buildEffectChain(ctx, asNode(input4), asNode(output4), [off], { resolve });
assert.equal(instOf(h4, 'off'), undefined, 'a bypassed entry with no instance yet is not instantiated');
assert.equal(made.length, madeBefore, 'no factory call happened for it');
assertWiring(['IN4->OUT4'], 'and the chain is a clean passthrough');

h4.rebuild([{ ...off, enabled: true }]);
const built = instOf(h4, 'off');
assert.ok(built, 'enabling it is what builds it');
assert.equal(made.length, madeBefore + 1, 'exactly one factory call, at the moment it was enabled');
assertWiring([`IN4->${built.tag}.in`, `${built.tag}.out->OUT4`]);

h4.dispose();
assert.equal(built.disposeCount, 1);
assertWiring([]);

/* ── a hosted VST3 is a LIVE node now, not an inert passthrough ─────────────
   The entries above stay inert because they carry no `vst` block — there is no
   plugin to host. An entry that HAS one goes through `buildEffectChain`'s
   `vst3` branch, which builds its node from the whole ENTRY (a plugin is
   identified by path and restored from stored state, neither of which fits
   through a `Record<string, number>`). The seam here stands in for the real
   bridge, which needs an AudioWorklet and a host process.

   `getRackEffect('vst3')` stays undefined throughout: a hosted plugin is still
   not a rack effect, and nothing about this branch puts one in the registry. */

const hosted = (id: string, enabled = true): ChainEntry => ({
  ...entry(id, 'vst3', enabled),
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
});

{
  assert.equal(getRackEffect('vst3'), undefined, 'a hosted plugin is not a rack effect');

  const input5 = new FakeNode('IN5');
  const output5 = new FakeNode('OUT5');
  const vstCalls: string[] = [];
  const vstFactory = (_c: BaseAudioContext, e: ChainEntry): RackEffectInstance | null => {
    vstCalls.push(e.id);
    const node = new FakeNode(`VST(${e.id})`);
    return {
      input: asNode(node),
      output: asNode(node),
      setParams: () => {},
      dispose: () => { node.disconnect(); },
    };
  };

  const a5 = entry('a5', 'alpha');
  const v5 = hosted('v5');
  const h5 = buildEffectChain(ctx, asNode(input5), asNode(output5), [a5, v5], { resolve, vstFactory });
  const alpha5 = instOf(h5, 'a5');
  assert.ok(alpha5);
  assert.deepEqual(vstCalls, ['v5'], 'the factory is called with the entry, once');
  assertWiring(
    [`IN5->${alpha5.tag}.in`, `${alpha5.tag}.out->VST(v5)`, `VST(v5)->OUT5`],
    'the plugin is wired INTO the chain, in order',
  );
  assert.deepEqual(h5.inertIds?.(), [], 'and it is no longer reported as inert');

  // Bypass still means "routed around", and a bypassed entry that has never
  // been built is still not built — which is what stops a switched-off plugin
  // from spawning a host process.
  const vstCallsBefore = vstCalls.length;
  h5.rebuild([a5, { ...v5, enabled: false }]);
  assert.equal(vstCalls.length, vstCallsBefore, 'no new factory call for the bypass');
  assertWiring([`IN5->${alpha5.tag}.in`, `${alpha5.tag}.out->OUT5`], 'routed around, instance kept');
  assert.deepEqual(h5.inertIds?.(), [], 'a bypassed entry is off by intent, not unrenderable');

  h5.rebuild([a5, v5]);
  assertWiring([`IN5->${alpha5.tag}.in`, `${alpha5.tag}.out->VST(v5)`, `VST(v5)->OUT5`], 'and back');
  h5.dispose();
  assertWiring([]);
}

/* ── no host binary: the SAME entry falls back to inert, and says so ───────── */
{
  const input6 = new FakeNode('IN6');
  const output6 = new FakeNode('OUT6');
  const warns: string[] = [];
  const realWarn2 = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };

  const a6 = entry('a6', 'alpha');
  const v6 = hosted('v6');
  // A factory that declines is exactly what `createVstLiveNode` returns when
  // this machine has no live host binary.
  const h6 = buildEffectChain(ctx, asNode(input6), asNode(output6), [a6, v6], {
    resolve,
    vstFactory: () => null,
  });
  const alpha6 = instOf(h6, 'a6');
  assert.ok(alpha6);
  assert.equal(instOf(h6, 'v6'), undefined, 'no node for a plugin that cannot be hosted');
  assertWiring([`IN6->${alpha6.tag}.in`, `${alpha6.tag}.out->OUT6`], 'the chain closes over it');
  assert.deepEqual(h6.inertIds?.(), ['v6'], 'and the UI is told, so the row can say "render-only"');
  assert.equal(warns.length, 1, 'warned once, like every other unrenderable entry');
  assert.ok(warns[0].includes('v6'), `the warning names the entry: ${warns[0]}`);

  // A BYPASSED entry that cannot be hosted is off by intent: nothing to report.
  h6.rebuild([a6, { ...v6, enabled: false }]);
  assert.deepEqual(h6.inertIds?.(), []);
  h6.dispose();
  console.warn = realWarn2;
}

console.log('rackEffects chain: bypass keeps the instance, unknown ids stay visible — passed');
