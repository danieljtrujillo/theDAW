// The live mixer BUILDS ITS GRAPH from `routingGraph` (T10b, plan §3.6 step 2).
//
// Before this, `buildTrackNodes` hard-coded every track's destination to the
// session master bus, so "drums -> drum bus" and "vocal -> reverb send" were
// inexpressible no matter what the model said. This file pins the wiring pass
// that replaces that constant with a walk of the graph.
//
// What is pinned here:
//
//   1. `createBusNodes` — a bus strip is `input -> [fx] -> gain -> muteGain ->
//      output`. That is NOT a track's strip minus source, pan and comp: the rack
//      is on the other side of the fader. A track is post-fader inserts
//      (`gain -> muteGain -> [fx] -> panner`), a bus is PRE-fader inserts, which
//      is the conventional bus shape but means a bus MUTE cuts its tails (it is
//      post-FX) where a track mute lets them ring, and a bus FADER does not
//      drive its own inserts where a track fader does. Both faders and both
//      mutes still open at the stored values, so a muted bus is muted on the
//      first sample rather than on the first live push.
//   2. `wireRoutingGraph` — the pass, in `topoOrder` order, so every source
//      node is connected before the node that sums it. One edge per node's main
//      output; one dedicated gain node per send, keyed `from|to`.
//   3. The fallback. `topoOrder` THROWS on a cycle or a malformed graph, and a
//      graph can reach the mixer from a project file that no mutator vetted.
//      A throw must degrade to "every track straight to the master" — the
//      pre-ticket behaviour — never to silence.
//   4. `applySendGains` / `applyBusMix` — the live writers, `setTargetAtTime`
//      only, so a send fader or a bus mute moves mid-playback without a rebuild.
//   5. `disposeBusNodes` — buses and send gains are torn down with the tracks;
//      a rebuild that leaked either would double the bus's contribution.
//   6. Latency through a bus: a bus's own insert chain lags everything routed
//      into it, so the compensation must count `chain(track) + chain(bus)` and
//      not just the track's own.
//
// Run: npx tsx src/state/liveMixer.routing.test.ts
import assert from 'node:assert/strict';

import {
  applyBusMix,
  applySendGains,
  busMembershipSig,
  busMixSig,
  createBusNodes,
  disposeBusNodes,
  routingStructureSig,
  sendGainSig,
  sendKey,
  trackCompDelays,
  wireRoutingGraph,
  type BusMixNodes,
  type DisposableBus,
  type MixBus,
  type RoutingEndpoints,
} from './liveMixer.ts';
import {
  CONN_OUTPUT,
  CONN_SEND,
  MASTER_ID,
  addBus,
  addSend,
  emptyGraph,
  ensureTrackNode,
  setOutput,
  type RoutingGraph,
} from './routingGraph.ts';
import type { RackEffectDef } from '../lib/rackEffects.ts';
import type { ChainEntry } from './effectChainStore.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ── fake graph nodes ─────────────────────────────────────────────────────── */

interface FakeNode {
  kind: string;
  gain: { value: number; calls: [number, number, number][]; setTargetAtTime(v: number, t: number, tc: number): void };
  outputs: FakeNode[];
  disconnects: number;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
}

/** Every `connect` in creation order, so the ORDER of the pass is assertable
 *  and not just its end state. */
let wireLog: string[] = [];

const fakeNode = (kind: string): FakeNode => {
  const calls: [number, number, number][] = [];
  const node: FakeNode = {
    kind,
    gain: {
      value: 1,
      calls,
      setTargetAtTime(v, t, tc) { calls.push([v, t, tc]); node.gain.value = v; },
    },
    outputs: [],
    disconnects: 0,
    connect(to) { node.outputs.push(to); wireLog.push(`${node.kind}->${to.kind}`); return to; },
    disconnect() { node.disconnects += 1; node.outputs.length = 0; },
  };
  return node;
};

const fakeCtx = () => {
  const created: FakeNode[] = [];
  return {
    created,
    createGain() { const n = fakeNode(`gain${created.length}`); created.push(n); return n; },
    createDelay() { const n = fakeNode('delay'); created.push(n); return n; },
  };
};

type Ctx = Parameters<typeof createBusNodes>[0];

const bus = (id: string, over: Partial<MixBus> = {}): MixBus =>
  ({ id, fxChain: [], volume: 0.8, mute: false, ...over });

/* ── 1. A bus strip is a track strip minus source, pan and comp ───────────── */

function aBusStripIsWiredInputFxGainMuteOutput(): void {
  const ctx = fakeCtx();
  const nodes = createBusNodes(ctx as unknown as Ctx, bus('b1', { volume: 0.5, mute: true }));

  assert.equal(ctx.created.length, 4, 'four gains: input, volume, mute, output — no panner, no comp');
  // An EMPTY rack is a clean pass, so `input` lands straight on `gain`.
  assert.deepEqual((nodes.input as unknown as FakeNode).outputs, [nodes.gain], 'input feeds the fader through the (empty) rack');
  assert.deepEqual((nodes.gain as unknown as FakeNode).outputs, [nodes.muteGain], 'fader feeds the mute gate');
  assert.deepEqual((nodes.muteGain as unknown as FakeNode).outputs, [nodes.output], 'mute gate feeds the output');
  assert.deepEqual((nodes.output as unknown as FakeNode).outputs, [], 'the output is left for wireRoutingGraph to place');

  assert.equal(nodes.gain.gain.value, 0.5, 'the fader opens at the stored value');
  assert.equal(nodes.muteGain.gain.value, 0, 'and a muted bus is muted on the first sample, not the first push');

  const open = createBusNodes(fakeCtx() as unknown as Ctx, bus('b2'));
  assert.equal(open.muteGain.gain.value, 1, 'an unmuted bus passes unity');
}

/* ── 2. The pass, in topological order ───────────────────────────────────── */

/** t1 -> bus -> master, t2 -> master. */
function graphWithOneBus(): { graph: RoutingGraph; busId: string } {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'T1');
  g = ensureTrackNode(g, 't2', 'T2');
  g = addBus(g, 'b1', 'Drums');
  const res = setOutput(g, 't1', 'b1');
  assert.ok(res.ok, 't1 -> bus is a legal edge');
  return { graph: res.graph as RoutingGraph, busId: 'b1' };
}

interface Rig {
  ends: RoutingEndpoints;
  out: Map<string, FakeNode>;
  inn: Map<string, FakeNode>;
  sendGains: FakeNode[];
}

function rig(trackIds: string[], busIds: string[]): Rig {
  const out = new Map<string, FakeNode>();
  const inn = new Map<string, FakeNode>();
  for (const id of trackIds) out.set(id, fakeNode(`${id}.comp`));
  for (const id of busIds) {
    out.set(id, fakeNode(`${id}.out`));
    inn.set(id, fakeNode(`${id}.in`));
  }
  inn.set(MASTER_ID, fakeNode('master.in'));
  const sendGains: FakeNode[] = [];
  const ends: RoutingEndpoints = {
    outputNodeOf: (id) => out.get(id) as never,
    inputNodeOf: (id) => inn.get(id) as never,
    liveIds: () => out.keys(),
    makeSendGain: (g) => {
      const n = fakeNode(`send${sendGains.length}`);
      n.gain.value = g;
      sendGains.push(n);
      return n as never;
    },
  };
  return { ends, out, inn, sendGains };
}

function outputsAreWiredInTopologicalOrder(): void {
  const { graph, busId } = graphWithOneBus();
  const r = rig(['t1', 't2'], [busId]);
  wireLog = [];

  const sends = wireRoutingGraph(graph, r.ends);

  assert.deepEqual(r.out.get('t1')!.outputs, [r.inn.get(busId)], 't1 lands on the bus input');
  assert.deepEqual(r.out.get('t2')!.outputs, [r.inn.get(MASTER_ID)], 't2 lands on the master');
  assert.deepEqual(r.out.get(busId)!.outputs, [r.inn.get(MASTER_ID)], 'and the bus lands on the master');
  assert.equal(sends.size, 0, 'no sends in this graph');

  // topoOrder puts every source before the node that sums it, so the bus is
  // wired only after both of its inputs exist. That ordering is the reason the
  // pass can assume `inputNodeOf` resolves.
  assert.deepEqual(
    wireLog, ['t1.comp->b1.in', 't2.comp->master.in', 'b1.out->master.in'],
    'the bus is wired after the tracks that feed it',
  );
}

function aNodeWithNoOutputEdgeStillReachesTheMaster(): void {
  // `outputOf` reads a missing output edge as "feeds the master", so a
  // half-built graph is audible rather than silent.
  const g: RoutingGraph = {
    nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 't1', kind: 'track', name: 'T1' }],
    edges: [],
  };
  const r = rig(['t1'], []);
  wireRoutingGraph(g, r.ends);
  assert.deepEqual(r.out.get('t1')!.outputs, [r.inn.get(MASTER_ID)], 'an edgeless track still feeds the master');
}

/* ── 3. Sends: one gain node each, keyed from|to ─────────────────────────── */

function eachSendGetsItsOwnGainNode(): void {
  const { graph, busId } = graphWithOneBus();
  const s1 = addSend(graph, 't2', busId, 0.25);
  assert.ok(s1.ok);
  const r = rig(['t1', 't2'], [busId]);

  const sends = wireRoutingGraph(s1.graph as RoutingGraph, r.ends);

  assert.equal(r.sendGains.length, 1, 'exactly one gain node per send');
  const g = r.sendGains[0];
  assert.equal(g.gain.value, 0.25, 'opening at the send amount');
  assert.deepEqual(
    r.out.get('t2')!.outputs, [r.inn.get(MASTER_ID), g],
    'the send TAPS the same output as the main path — it does not replace it',
  );
  assert.deepEqual(g.outputs, [r.inn.get(busId)], 'and the send gain feeds the target bus input');
  assert.deepEqual([...sends.keys()], [sendKey('t2', busId)], 'the map is keyed from|to');
  assert.equal(sends.get(sendKey('t2', busId)) as unknown, g, 'so setSendGain can reach this exact node');
}

function aSendToAMissingNodeIsSkippedNotThrown(): void {
  const g: RoutingGraph = {
    nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 't1', kind: 'track', name: 'T1' }],
    edges: [
      { from: 't1', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 't1', to: 'ghost', connType: CONN_SEND, gain: 0.5 },
    ],
  };
  const r = rig(['t1'], []);
  const sends = wireRoutingGraph(g, r.ends);
  assert.equal(sends.size, 0, 'a send with no live target builds no node');
  assert.equal(r.sendGains.length, 0, 'and allocates nothing');
  assert.deepEqual(r.out.get('t1')!.outputs, [r.inn.get(MASTER_ID)], 'while the main path is unaffected');
}

/* ── 4. A malformed graph degrades to every track -> master ──────────────── */

function aCyclicGraphFallsBackToTheMasterNeverToSilence(): void {
  // No mutator can produce this (`wouldCycle` refuses it), but a `.tasmo` or a
  // hand-edited autosave manifest can hand it straight to the mixer.
  const g: RoutingGraph = {
    nodes: [
      { id: MASTER_ID, kind: 'master', name: 'Master' },
      { id: 'b1', kind: 'bus', name: 'A' },
      { id: 'b2', kind: 'bus', name: 'B' },
      { id: 't1', kind: 'track', name: 'T1' },
    ],
    edges: [
      { from: 'b1', to: 'b2', connType: CONN_OUTPUT, gain: 1 },
      { from: 'b2', to: 'b1', connType: CONN_OUTPUT, gain: 1 },
      { from: 't1', to: 'b1', connType: CONN_OUTPUT, gain: 1 },
      { from: 't1', to: 'b2', connType: CONN_SEND, gain: 0.5 },
    ],
  };
  const r = rig(['t1'], ['b1', 'b2']);

  const sends = wireRoutingGraph(g, r.ends);

  assert.deepEqual(r.out.get('t1')!.outputs, [r.inn.get(MASTER_ID)], 'the track is audible on the master');
  assert.deepEqual(r.out.get('b1')!.outputs, [r.inn.get(MASTER_ID)], 'so is every bus');
  assert.deepEqual(r.out.get('b2')!.outputs, [r.inn.get(MASTER_ID)]);
  assert.equal(sends.size, 0, 'and no send is built — the fallback is the plain pre-routing mix');
}

function theFallbackConnectsStripsTheDamagedGraphForgot(): void {
  // The graph is cyclic AND incomplete: `t2` is playing — it has a live strip —
  // but the file lost its node. Iterating the graph alone would leave t2's comp
  // delay connected to nothing, which is the one outcome the fallback exists to
  // rule out.
  const g: RoutingGraph = {
    nodes: [
      { id: MASTER_ID, kind: 'master', name: 'Master' },
      { id: 'b1', kind: 'bus', name: 'A' },
      { id: 'b2', kind: 'bus', name: 'B' },
      { id: 't1', kind: 'track', name: 'T1' },
    ],
    edges: [
      { from: 'b1', to: 'b2', connType: CONN_OUTPUT, gain: 1 },
      { from: 'b2', to: 'b1', connType: CONN_OUTPUT, gain: 1 },
    ],
  };
  const r = rig(['t1', 't2'], ['b1', 'b2']); // t2 has a strip, no node

  wireRoutingGraph(g, r.ends);

  assert.deepEqual(r.out.get('t2')!.outputs, [r.inn.get(MASTER_ID)], 'the forgotten track is still audible');
  assert.deepEqual(r.out.get('t1')!.outputs, [r.inn.get(MASTER_ID)], 'alongside the one the graph did name');
  assert.deepEqual(r.out.get('b1')!.outputs, [r.inn.get(MASTER_ID)], 'and every bus');
}

function theHealthyPassIgnoresLiveIds(): void {
  // `liveIds` is a degraded-path input only: a strip with no node in a SANE
  // graph is a strip the document does not describe, and inventing an edge for
  // it would resurrect a track the user deleted.
  const { graph, busId } = graphWithOneBus();
  const r = rig(['t1', 't2', 'ghost'], [busId]);
  wireRoutingGraph(graph, r.ends);
  assert.deepEqual(r.out.get('ghost')!.outputs, [], 'a strip with no node is left unconnected when the graph is sound');
}

/* ── 5. The live writers ─────────────────────────────────────────────────── */

function sendGainsMoveWithoutARebuild(): void {
  const { graph, busId } = graphWithOneBus();
  const added = addSend(graph, 't2', busId, 0.25);
  assert.ok(added.ok);
  let g = added.graph as RoutingGraph;
  g = { nodes: g.nodes, edges: g.edges.map((e) => (e.connType === CONN_SEND ? { ...e, gain: 0.8 } : e)) };

  const node = fakeNode('send');
  applySendGains(g, (k) => (k === sendKey('t2', busId) ? (node as unknown as { gain: { setTargetAtTime(v: number, t: number, tc: number): void } }) : undefined), 4.5);

  assert.deepEqual(node.gain.calls, [[0.8, 4.5, 0.015]], 'ramped, never jumped — a send fader must not click');

  // A send whose node is gone (rebuilt graph, stale map) is skipped, not thrown.
  applySendGains(g, () => undefined, 4.5);
}

function busFadersAndMutesAreWrittenLive(): void {
  const strips = new Map<string, { gain: FakeNode; muteGain: FakeNode }>([
    ['b1', { gain: fakeNode('b1.gain'), muteGain: fakeNode('b1.mute') }],
    ['b2', { gain: fakeNode('b2.gain'), muteGain: fakeNode('b2.mute') }],
  ]);

  applyBusMix(
    [bus('b1', { volume: 0.3, mute: false }), bus('b2', { volume: 0.9, mute: true }), bus('gone', { volume: 1, mute: false })],
    (id) => strips.get(id) as unknown as BusMixNodes | undefined,
    2,
  );

  assert.deepEqual(strips.get('b1')!.gain.gain.calls, [[0.3, 2, 0.015]], 'the bus fader rides live');
  assert.deepEqual(strips.get('b1')!.muteGain.gain.calls, [[1, 2, 0.015]], 'an unmuted bus passes unity');
  assert.deepEqual(strips.get('b2')!.muteGain.gain.calls, [[0, 2, 0.015]], 'a muted BUS mutes at its own gate');
  assert.deepEqual(strips.get('b2')!.gain.gain.calls, [[0.9, 2, 0.015]], 'with its fader value left intact underneath');
  assert.equal(strips.size, 2, 'a bus with no live strip writes nothing');
}

/* ── 6. Disposal: buses and send gains go with the tracks ────────────────── */

function everyBusNodeAndSendGainIsDisposed(): void {
  const ctx = fakeCtx();
  const b1 = createBusNodes(ctx as unknown as Ctx, bus('b1'));
  const b2 = createBusNodes(ctx as unknown as Ctx, bus('b2'));
  const sends = [fakeNode('s1'), fakeNode('s2'), fakeNode('s3')];
  let fxDisposed = 0;
  const wrap = (n: ReturnType<typeof createBusNodes>): DisposableBus =>
    ({ ...n, fx: { dispose: () => { fxDisposed += 1; } } }) as unknown as DisposableBus;

  // `buildEffectChain` clears the input's wiring when it first builds, so count
  // the delta across teardown rather than an absolute.
  const before = [b1, b2].map((n) =>
    (['input', 'gain', 'muteGain', 'output'] as const).map((k) => (n[k] as unknown as FakeNode).disconnects));

  disposeBusNodes([wrap(b1), wrap(b2)], sends as unknown as { disconnect(): void }[]);

  assert.equal(fxDisposed, 2, 'each bus rack is disposed exactly once');
  [b1, b2].forEach((n, i) => {
    (['input', 'gain', 'muteGain', 'output'] as const).forEach((key, k) => {
      assert.equal(
        (n[key] as unknown as FakeNode).disconnects - before[i][k], 1,
        `${key} is disconnected exactly once at teardown`,
      );
    });
  });
  for (const s of sends) assert.equal(s.disconnects, 1, 'and every send gain with them');
}

/* ── 7. Latency: a bus lags everything routed into it ────────────────────── */

const entry = (id: string, effect: string, enabled = true): ChainEntry =>
  ({ id, effect, params: {}, enabled });

const fakeDef = (id: string, latencySec: number): RackEffectDef => ({
  id, label: id, group: 'Test', description: id, params: [], latencySec,
  make: () => { throw new Error('compensation must never build a graph'); },
});
const FAKE = new Map<string, RackEffectDef>([
  ['slow', fakeDef('slow', 0.02)],
  ['quick', fakeDef('quick', 0.005)],
]);
const resolveFake = (id: string) => FAKE.get(id);

function aBusChainDelaysEveryTrackRoutedIntoIt(): void {
  const { graph, busId } = graphWithOneBus(); // t1 -> bus -> master, t2 -> master
  const tracks = [
    { id: 't1', fxChain: [entry('e1', 'quick')] }, // 5 ms of its own
    { id: 't2', fxChain: [] },
  ];
  const buses = [{ id: busId, fxChain: [entry('e2', 'slow')] }]; // 20 ms more, downstream

  // WITHOUT the graph this is T09b's answer: only the track's own chain counts.
  const flat = trackCompDelays(tracks, resolveFake);
  assert.ok(close(flat[0].latencySec, 0.005), 't1 lags 5 ms on its own');
  assert.ok(close(flat[1].compSec, 0.005), 'so a flat mix delays t2 by 5 ms');

  // WITH it, t1's path to the master is its own chain PLUS the bus's.
  const rows = trackCompDelays(tracks, resolveFake, undefined, { graph, buses });
  assert.deepEqual(rows.map((r) => r.trackId), ['t1', 't2'], 'rows still follow store order');
  assert.ok(close(rows[0].latencySec, 0.025), 't1 lags 25 ms through the bus');
  assert.ok(close(rows[1].latencySec, 0), 't2 goes straight to the master and lags nothing');
  assert.ok(close(rows[0].compSec, 0), 'the slowest path is never delayed');
  assert.ok(close(rows[1].compSec, 0.025), 'and the direct track waits for it — the whole 25 ms');
}

function aBusInertEntryIsReportedOnItsTracks(): void {
  const { graph, busId } = graphWithOneBus();
  const rows = trackCompDelays(
    [{ id: 't1', fxChain: [] }, { id: 't2', fxChain: [] }],
    resolveFake,
    undefined,
    { graph, buses: [{ id: busId, fxChain: [entry('v1', 'vst3')] }] },
  );
  // A hosted plugin on the BUS is the same live/bounce gap as one on the track:
  // inert here, printing at freeze. It belongs to every track that passes it.
  assert.deepEqual(rows[0].uncounted, ['v1'], 't1 routes through the bus, so it inherits the gap');
  assert.deepEqual(rows[1].uncounted, [], 't2 does not, so it does not');
}

function chainedBusesAccumulate(): void {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'T1');
  g = addBus(g, 'inner', 'Inner');
  g = addBus(g, 'outer', 'Outer');
  g = (setOutput(g, 't1', 'inner').graph as RoutingGraph);
  g = (setOutput(g, 'inner', 'outer').graph as RoutingGraph);

  const rows = trackCompDelays(
    [{ id: 't1', fxChain: [entry('e1', 'quick')] }],
    resolveFake,
    undefined,
    { graph: g, buses: [{ id: 'inner', fxChain: [entry('e2', 'slow')] }, { id: 'outer', fxChain: [entry('e3', 'slow')] }] },
  );
  assert.ok(close(rows[0].latencySec, 0.045), 'every bus along the path adds its own chain (5 + 20 + 20 ms)');
}

/* ── 8. The rebuild/update decision table ────────────────────────────────── */

function structureForcesNodeWorkAndValuesDoNot(): void {
  // `applyRoutingLive` reaches node work ONLY when one of the two structural
  // signatures moves, and pushes a value otherwise. It runs inside a playing
  // session and cannot be called here, so the decision itself is pinned on the
  // four signatures it branches on. Read: "did this edit change the graph's
  // SHAPE, or only a number riding on it?"
  const { graph, busId } = graphWithOneBus();
  const buses: MixBus[] = [bus(busId)];

  const base = {
    membership: busMembershipSig(buses),
    structure: routingStructureSig(graph),
    mix: busMixSig(buses),
    sends: sendGainSig(graph),
  };

  // A. A bus FADER / MUTE ride: values only. No rebuild, no rewire.
  const rid: MixBus[] = [bus(busId, { volume: 0.2, mute: true })];
  assert.equal(busMembershipSig(rid), base.membership, 'a fader ride does not rebuild the strips');
  assert.notEqual(busMixSig(rid), base.mix, 'but it does move the mix signature');

  // B. A SEND GAIN ride: values only. This is the one the structural signature
  //    must deliberately ignore — riding a send knob at 60 Hz must not rewire.
  const withSend = addSend(graph, 't2', busId, 0.25);
  assert.ok(withSend.ok);
  const sendGraph = withSend.graph as RoutingGraph;
  const louder: RoutingGraph = {
    nodes: sendGraph.nodes,
    edges: sendGraph.edges.map((e) => (e.connType === CONN_SEND ? { ...e, gain: 0.9 } : e)),
  };
  assert.equal(
    routingStructureSig(louder), routingStructureSig(sendGraph),
    'a send gain is invisible to the structural signature',
  );
  assert.notEqual(sendGainSig(louder), sendGainSig(sendGraph), 'and visible to the send-gain one');

  // C. ADDING the send is structural — a new gain node has to be built.
  assert.notEqual(routingStructureSig(sendGraph), base.structure, 'adding a send rewires');

  // D. REPOINTING an output is structural.
  const moved = setOutput(graph, 't2', busId);
  assert.ok(moved.ok);
  assert.notEqual(routingStructureSig(moved.graph as RoutingGraph), base.structure, 'repointing an output rewires');

  // E. A NEW BUS is a strip rebuild, not merely a rewire.
  const more: MixBus[] = [...buses, bus('b2')];
  assert.notEqual(busMembershipSig(more), base.membership, 'a new bus rebuilds the strips');

  // F. A no-op tick — the 60 Hz playhead case — moves nothing at all.
  assert.equal(busMembershipSig([bus(busId)]), base.membership);
  assert.equal(routingStructureSig(graphWithOneBus().graph), base.structure);
  assert.equal(busMixSig([bus(busId)]), base.mix);
  assert.equal(sendGainSig(graphWithOneBus().graph), base.sends);
}

aBusStripIsWiredInputFxGainMuteOutput();
outputsAreWiredInTopologicalOrder();
aNodeWithNoOutputEdgeStillReachesTheMaster();
eachSendGetsItsOwnGainNode();
aSendToAMissingNodeIsSkippedNotThrown();
aCyclicGraphFallsBackToTheMasterNeverToSilence();
theFallbackConnectsStripsTheDamagedGraphForgot();
theHealthyPassIgnoresLiveIds();
sendGainsMoveWithoutARebuild();
busFadersAndMutesAreWrittenLive();
everyBusNodeAndSendGainIsDisposed();
aBusChainDelaysEveryTrackRoutedIntoIt();
aBusInertEntryIsReportedOnItsTracks();
chainedBusesAccumulate();
structureForcesNodeWorkAndValuesDoNot();

console.log('liveMixer.routing: ok');
