// The live mixer CONNECTS SIDECHAIN KEYS (T64, wave 3).
//
// `state/routingGraph` has had `CONN_SIDECHAIN` since batch 6 — the edge, its
// `targetEntryId`, the duplicate rule, the cycle refusal, all pinned in
// `routingGraph.test.ts` — with nothing in either engine reading it. Every key a
// user could express was inaudible. This file pins the third pass of
// `wireRoutingGraph` that makes it audible, and the rules that keep it safe.
//
// What is pinned here:
//
//   1. The pass. A key TAPS the source's output — the same node the main path
//      and the sends tap — and lands on the key input of one NAMED effect entry
//      on the destination's rack. It is walked AFTER the outputs and the sends,
//      because it is the only edge whose destination is not a strip but
//      something inside one.
//   2. Refusal. A graph that could not be ordered gets NO keys, exactly as it
//      gets no sends: a key closes a Web Audio loop precisely as an output does,
//      and a loop with no delay in it is silence rather than feedback. A
//      `CONN_SIDECHAIN` edge with no `targetEntryId` — which `validateGraph`
//      names and no mutator can make — is skipped and logged once.
//   3. Tolerance. Several ordinary states of a live document resolve to "no key
//      input right now": a bypassed entry that was never instantiated, an entry
//      the user deleted, an effect that takes no key, a source strip that is
//      gone. All are skipped SILENTLY and none can make noise — an unconnected
//      key input leaves its effect exactly as it was.
//   4. Several sources keying ONE entry all connect, because `keyIn` is a gain
//      node and a gain node sums. (The picker offers one; the model allows more,
//      and the engine must not be the thing that breaks if a file holds two.)
//   5. `routingStructureSig` sees a key, so adding/moving/removing one rewires
//      rather than being pushed as a value onto the running graph.
//   6. `sidechainTargetIds` — the gate on re-wiring after a rack REBUILD. An
//      entry that was bypassed when its chain was first built has no instance
//      and so had no key input for the pass to find; enabling it later builds
//      one, and without this gate the key would stay unconnected until some
//      unrelated routing edit happened.
//
// Fake nodes, as in `liveMixer.routing.test.ts`: the pass is pure over injected
// endpoints, so the wiring is assertable with no Web Audio anywhere.
//
// Run: npx tsx src/state/liveMixer.sidechain.test.ts
import assert from 'node:assert/strict';

import {
  routingStructureSig,
  sidechainTargetIds,
  wireRoutingGraph,
  type RoutingEndpoints,
} from './liveMixer.ts';
import {
  CONN_OUTPUT,
  CONN_SIDECHAIN,
  MASTER_ID,
  addBus,
  emptyGraph,
  ensureTrackNode,
  setOutput,
  setSidechain,
  validateGraph,
  type RoutingGraph,
} from './routingGraph.ts';

/* ── fake graph nodes ─────────────────────────────────────────────────────── */

interface FakeNode {
  kind: string;
  gain: { value: number };
  outputs: FakeNode[];
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
}

/** Every `connect` in order, so the pass's ORDER is assertable. */
let wireLog: string[] = [];

const fakeNode = (kind: string): FakeNode => {
  const n: FakeNode = {
    kind,
    gain: { value: 1 },
    outputs: [],
    connect(to) { n.outputs.push(to); wireLog.push(`${n.kind}->${to.kind}`); return to; },
    disconnect() { n.outputs.length = 0; },
  };
  return n;
};

interface Rig {
  ends: RoutingEndpoints;
  out: Map<string, FakeNode>;
  inn: Map<string, FakeNode>;
  /** `${nodeId}|${entryId}` -> that entry's key input. */
  keys: Map<string, FakeNode>;
  sendGains: FakeNode[];
}

/** Endpoints over fakes. `keyed` names the (node, entry) pairs that HAVE a key
 *  input — which is what a rack of keyable, instantiated effects amounts to. */
function rig(trackIds: string[], busIds: string[], keyed: [string, string][] = []): Rig {
  const out = new Map<string, FakeNode>();
  const inn = new Map<string, FakeNode>();
  const keys = new Map<string, FakeNode>();
  for (const id of trackIds) out.set(id, fakeNode(`${id}.comp`));
  for (const id of busIds) {
    out.set(id, fakeNode(`${id}.out`));
    inn.set(id, fakeNode(`${id}.in`));
  }
  inn.set(MASTER_ID, fakeNode('master.in'));
  for (const [nodeId, entryId] of keyed) {
    keys.set(`${nodeId}|${entryId}`, fakeNode(`${nodeId}.${entryId}.keyIn`));
  }
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
    keyInputOf: (nodeId, entryId) => keys.get(`${nodeId}|${entryId}`) as never,
  };
  return { ends, out, inn, keys, sendGains };
}

/** t1 -> master, t2 -> master, plus a bus. The kick (t1) will key the bass (t2). */
function baseGraph(): RoutingGraph {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'Kick');
  g = ensureTrackNode(g, 't2', 'Bass');
  g = addBus(g, 'b1', 'Drums');
  return g;
}

const keyed = (g: RoutingGraph, from: string, to: string, entryId: string): RoutingGraph => {
  const r = setSidechain(g, from, to, entryId);
  assert.ok(r.ok, `${from} -> ${to}:${entryId} is a legal key (${r.reason ?? ''})`);
  return r.graph as RoutingGraph;
};

/* ── 1. The pass ─────────────────────────────────────────────────────────── */

function aKeyTapsTheSourceOutputAndLandsOnTheEntrysKeyInput(): void {
  const g = keyed(baseGraph(), 't1', 't2', 'e1');
  const r = rig(['t1', 't2'], ['b1'], [['t2', 'e1']]);
  wireLog = [];

  wireRoutingGraph(g, r.ends);

  const t1 = r.out.get('t1') as FakeNode;
  const keyIn = r.keys.get('t2|e1') as FakeNode;
  assert.deepEqual(
    t1.outputs, [r.inn.get(MASTER_ID), keyIn],
    'the key TAPS the same output the main path leaves from — it does not replace it, and it '
      + 'costs no second strip: the key hears exactly what the mix hears',
  );
  assert.deepEqual(
    r.out.get('t2')!.outputs, [r.inn.get(MASTER_ID)],
    'and the KEYED track is untouched by being keyed — its own output is where it was',
  );

  // Keys come last: every strip is placed, and every rack built, before an edge
  // into something INSIDE a rack is made.
  assert.equal(
    wireLog[wireLog.length - 1], 't1.comp->t2.e1.keyIn',
    'the key is the last connection of the pass',
  );
  assert.deepEqual(
    wireLog.slice(0, 3), ['t1.comp->master.in', 't2.comp->master.in', 'b1.out->master.in'],
    'and the output pass ahead of it is exactly what it was before keys existed',
  );
}

function aBusCanKeyAndCanBeKeyed(): void {
  // A bus is an ordinary node in the model, so both directions must wire.
  let g = baseGraph();
  const out = setOutput(g, 't1', 'b1');
  assert.ok(out.ok);
  g = out.graph as RoutingGraph;
  g = keyed(g, 'b1', 't2', 'e1');   // the drum bus keys the bass
  g = keyed(g, 't1', 'b1', 'bfx');  // and t1 keys the bus it already feeds

  const r = rig(['t1', 't2'], ['b1'], [['t2', 'e1'], ['b1', 'bfx']]);
  wireRoutingGraph(g, r.ends);

  assert.ok(
    (r.out.get('b1') as FakeNode).outputs.includes(r.keys.get('t2|e1') as FakeNode),
    "a BUS's output keys a track's effect",
  );
  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs,
    [r.inn.get('b1'), r.keys.get('b1|bfx')],
    "and a track's output keys a BUS's effect — alongside the OUTPUT edge into the same bus, "
      + 'which is the ordinary "the kick feeds the drum bus and keys its compressor" shape and '
      + 'is not a cycle: nothing downstream of the bus leads back to the track',
  );
}

function severalSourcesKeyingOneEntryAllConnect(): void {
  // The picker offers one source; the MODEL allows several (the duplicate rule
  // is per `targetEntryId`, not per destination), and `keyIn` is a gain node, so
  // they sum. A file holding two must not be the thing that breaks the engine.
  let g = baseGraph();
  g = keyed(g, 't1', 't2', 'e1');
  g = keyed(g, 'b1', 't2', 'e1');
  const r = rig(['t1', 't2'], ['b1'], [['t2', 'e1']]);

  wireRoutingGraph(g, r.ends);

  const keyIn = r.keys.get('t2|e1') as FakeNode;
  assert.ok((r.out.get('t1') as FakeNode).outputs.includes(keyIn), 'the first source connects');
  assert.ok((r.out.get('b1') as FakeNode).outputs.includes(keyIn), 'and so does the second');
}

function twoEntriesOnOneRackAreKeyedIndependently(): void {
  let g = baseGraph();
  g = keyed(g, 't1', 't2', 'e1');
  g = keyed(g, 'b1', 't2', 'e2');
  const r = rig(['t1', 't2'], ['b1'], [['t2', 'e1'], ['t2', 'e2']]);

  wireRoutingGraph(g, r.ends);

  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs.slice(1), [r.keys.get('t2|e1')],
    't1 keys entry e1 and nothing else',
  );
  assert.deepEqual(
    (r.out.get('b1') as FakeNode).outputs.slice(1), [r.keys.get('t2|e2')],
    'and b1 keys e2 — the edge names the ENTRY, not the strip',
  );
}

/* ── 2. Refusal ──────────────────────────────────────────────────────────── */

function theModelRefusesAKeyThatWouldCycle(): void {
  // The first line of defence, and the reason the engine can be as simple as it
  // is: the edge never gets built. `t2 -> t1` already exists as a key, so
  // `t1 -> t2` closes a loop over the two edge types together.
  let g = baseGraph();
  g = keyed(g, 't2', 't1', 'e9');
  const refused = setSidechain(g, 't1', 't2', 'e1');
  assert.equal(refused.ok, false, 'a key back down the chain is refused');
  assert.equal(refused.reason, 'cycle', 'as a cycle');
  assert.equal(refused.graph, undefined, 'and the graph is not handed back at all');

  const out = setOutput(g, 't1', 'b1');
  assert.ok(out.ok);
  const intoOwnSource = setSidechain(out.graph as RoutingGraph, 'b1', 't1', 'e1');
  assert.equal(
    intoOwnSource.ok, false,
    'and so is keying a track from the bus it already feeds — the path back exists whatever '
      + 'the edges along it are CALLED',
  );
}

function aGraphThatCouldNotBeOrderedGetsNoKeys(): void {
  // No mutator can build this; a `.tasmo` or a hand-edited autosave manifest
  // hands it straight to the mixer. The degraded pass is every strip to the
  // master, and a key must degrade with it: we could not order the graph, so we
  // cannot claim the key does not close a loop.
  const g: RoutingGraph = {
    nodes: [
      { id: MASTER_ID, kind: 'master', name: 'Master' },
      { id: 'b1', kind: 'bus', name: 'A' },
      { id: 'b2', kind: 'bus', name: 'B' },
      { id: 't1', kind: 'track', name: 'T1' },
      { id: 't2', kind: 'track', name: 'T2' },
    ],
    edges: [
      { from: 'b1', to: 'b2', connType: CONN_OUTPUT, gain: 1 },
      { from: 'b2', to: 'b1', connType: CONN_OUTPUT, gain: 1 },
      { from: 't1', to: 't2', connType: CONN_SIDECHAIN, gain: 1, targetEntryId: 'e1' },
    ],
  };
  const r = rig(['t1', 't2'], ['b1', 'b2'], [['t2', 'e1']]);

  wireRoutingGraph(g, r.ends);

  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs, [r.inn.get(MASTER_ID)],
    'the degraded mix is every strip straight to the master, and NO key',
  );
  assert.deepEqual((r.keys.get('t2|e1') as FakeNode).outputs, [], 'nothing reaches the key input');
  assert.deepEqual(
    (r.out.get('t2') as FakeNode).outputs, [r.inn.get(MASTER_ID)],
    'and every track is still audible — the fallback never degrades to silence',
  );
}

function aKeyWithNoTargetEntryIsSkippedNotThrown(): void {
  const g: RoutingGraph = {
    nodes: [
      { id: MASTER_ID, kind: 'master', name: 'Master' },
      { id: 't1', kind: 'track', name: 'T1' },
      { id: 't2', kind: 'track', name: 'T2' },
    ],
    edges: [
      { from: 't1', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 't2', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 't1', to: 't2', connType: CONN_SIDECHAIN, gain: 1 }, // no targetEntryId
    ],
  };
  assert.ok(
    validateGraph(g).some((p) => p.includes('no targetEntryId')),
    'the model calls this graph damaged',
  );
  const r = rig(['t1', 't2'], [], [['t2', 'e1']]);

  wireRoutingGraph(g, r.ends); // logs once; must not throw

  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs, [r.inn.get(MASTER_ID)],
    'the damaged key is skipped and the main path is untouched',
  );
  assert.deepEqual((r.keys.get('t2|e1') as FakeNode).outputs, [], 'and nothing is keyed by guess');
}

/* ── 3. Tolerance: the ordinary "no key input right now" states ──────────── */

function anEntryWithNoKeyInputIsSkippedSilently(): void {
  const g = keyed(baseGraph(), 't1', 't2', 'e1');
  // No `keyed` pairs at all: the entry is bypassed-and-uninstantiated, deleted,
  // or is an effect that takes no key. Each is an ordinary document state.
  const r = rig(['t1', 't2'], ['b1']);

  wireRoutingGraph(g, r.ends);

  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs, [r.inn.get(MASTER_ID)],
    'no key is made, and the source still reaches the master — an unconnected key input '
      + 'leaves its effect exactly as it was, so this can never be audible',
  );
}

function aKeyFromAStripThatIsGoneIsSkipped(): void {
  const g = keyed(baseGraph(), 'b1', 't2', 'e1');
  const r = rig(['t1', 't2'], [], [['t2', 'e1']]); // b1 has a node, no strip

  wireRoutingGraph(g, r.ends);

  assert.deepEqual(
    (r.keys.get('t2|e1') as FakeNode).outputs, [],
    'a key whose SOURCE has no live strip builds nothing',
  );
}

function endpointsWithoutAKeyLookupWireEverythingElse(): void {
  // `keyInputOf` is optional so the older routing suites — which know nothing
  // about racks — keep constructing endpoints by hand.
  const g = keyed(baseGraph(), 't1', 't2', 'e1');
  const r = rig(['t1', 't2'], ['b1'], [['t2', 'e1']]);
  const withoutKeys: RoutingEndpoints = { ...r.ends, keyInputOf: undefined };

  wireRoutingGraph(g, withoutKeys);

  assert.deepEqual(
    (r.out.get('t1') as FakeNode).outputs, [r.inn.get(MASTER_ID)],
    'the outputs are wired and no key is attempted',
  );
}

/* ── 4. A key is STRUCTURAL ──────────────────────────────────────────────── */

function aKeyMovesTheStructuralSignature(): void {
  const base = baseGraph();
  const one = keyed(base, 't1', 't2', 'e1');
  assert.notEqual(
    routingStructureSig(one), routingStructureSig(base),
    'adding a key rewires — it is node work, not a value to push',
  );

  const other = keyed(base, 'b1', 't2', 'e1');
  assert.notEqual(
    routingStructureSig(other), routingStructureSig(one),
    'and so does changing which strip the key comes from',
  );

  const otherEntry = keyed(base, 't1', 't2', 'e2');
  assert.notEqual(
    routingStructureSig(otherEntry), routingStructureSig(one),
    'and moving it to a different ENTRY on the same rack, which is the field a signature '
      + 'built from `from > to` alone would miss entirely',
  );
}

/* ── 5. The rebuild gate ─────────────────────────────────────────────────── */

function theRebuildGateNamesEveryKeyedStrip(): void {
  let g = baseGraph();
  assert.deepEqual([...sidechainTargetIds(g)], [], 'a graph with no key gates nothing');

  g = keyed(g, 't1', 't2', 'e1');
  g = keyed(g, 't1', 'b1', 'bfx');
  assert.deepEqual(
    [...sidechainTargetIds(g)].sort(), ['b1', 't2'],
    'the DESTINATIONS are what a rack rebuild has to re-wire: an entry that was bypassed when '
      + 'its chain was first built has no instance and so had no key input for the pass to '
      + 'find, and enabling it later builds one that nothing would connect',
  );
  assert.equal(
    sidechainTargetIds(g).has('t1'), false,
    'the SOURCE is not in it — its rack has nothing keyed on it, and a rebuild there replaces '
      + 'no node the key passes through',
  );
}

aKeyTapsTheSourceOutputAndLandsOnTheEntrysKeyInput();
aBusCanKeyAndCanBeKeyed();
severalSourcesKeyingOneEntryAllConnect();
twoEntriesOnOneRackAreKeyedIndependently();
theModelRefusesAKeyThatWouldCycle();
aGraphThatCouldNotBeOrderedGetsNoKeys();
aKeyWithNoTargetEntryIsSkippedNotThrown();
anEntryWithNoKeyInputIsSkippedSilently();
aKeyFromAStripThatIsGoneIsSkipped();
endpointsWithoutAKeyLookupWireEverythingElse();
aKeyMovesTheStructuralSignature();
theRebuildGateNamesEveryKeyedStrip();

console.log('liveMixer.sidechain: ok');
