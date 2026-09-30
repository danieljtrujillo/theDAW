import assert from 'node:assert/strict';
import {
  CONN_OUTPUT, CONN_SEND, CONN_SIDECHAIN, MASTER_ID,
  addBus, addSend, emptyGraph, ensureTrackNode, inputsOf, outputOf, removeNode, removeSend,
  removeSidechain, sendsFrom, setOutput, setSendGain, setSidechain, sidechainsInto, topoOrder,
  validateGraph, wouldCycle,
  type RoutingEdge, type RoutingGraph, type RoutingResult,
} from './routingGraph.ts';

/** Unwrap a successful mutation, failing loudly with the refusal reason otherwise. */
const must = (r: RoutingResult, what = 'mutation'): RoutingGraph => {
  if (r.ok) return r.graph;
  assert.fail(`${what} should have succeeded, got refusal: ${r.reason}`);
};
/** Assert a mutation was refused for `reason` AND left its input untouched. */
const refused = (g: RoutingGraph, run: () => RoutingResult, reason: string, what: string): void => {
  // The refusal path must not have half-applied anything to the caller's graph,
  // so the snapshot is taken BEFORE the mutator runs.
  const snap = JSON.stringify(g);
  const r = run();
  assert.equal(r.ok, false, `${what} should have been refused`);
  assert.equal(r.reason, reason, what);
  assert.equal(JSON.stringify(g), snap, `${what} must leave the graph untouched`);
};
/** Run `fn` and assert it did not mutate `g` (structural before/after equality). */
const pure = <T,>(g: RoutingGraph, fn: () => T, what: string): T => {
  const snap = JSON.stringify(g);
  const out = fn();
  assert.equal(JSON.stringify(g), snap, `${what} must not mutate its input graph`);
  return out;
};

const edgeKey = (e: RoutingEdge): string => `${e.from}>${e.to}:${e.connType}:${e.targetEntryId ?? ''}`;

// An empty graph is the master alone: master is a node like any other node.
{
  assert.equal(MASTER_ID, 'master');
  assert.equal(CONN_OUTPUT, 0);
  assert.equal(CONN_SEND, 1);
  assert.equal(CONN_SIDECHAIN, 2);
  const g = emptyGraph();
  assert.deepEqual(g.nodes, [{ id: MASTER_ID, kind: 'master', name: 'Master' }]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(validateGraph(g), []);
  assert.deepEqual(topoOrder(g), [MASTER_ID]);
  // Two calls must not share structure.
  assert.notEqual(emptyGraph().nodes, emptyGraph().nodes);
}

// ensureTrackNode / addBus: the node plus its one CONN_OUTPUT edge to master.
{
  const g0 = emptyGraph();
  const g1 = pure(g0, () => ensureTrackNode(g0, 't1', 'Drums'), 'ensureTrackNode');
  assert.deepEqual(g1.nodes.map((n) => n.id), [MASTER_ID, 't1']);
  assert.deepEqual(g1.nodes[1], { id: 't1', kind: 'track', name: 'Drums' });
  assert.deepEqual(g1.edges, [{ from: 't1', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 }]);
  assert.equal(outputOf(g1, 't1'), MASTER_ID);
  // Idempotent: the same id never creates a second node or a second output edge.
  const g2 = ensureTrackNode(g1, 't1', 'Drums');
  assert.deepEqual(g2.nodes.map((n) => n.id), [MASTER_ID, 't1']);
  assert.equal(g2.edges.length, 1);
  // A changed name is a rename, not a duplicate.
  const g3 = ensureTrackNode(g2, 't1', 'Kit');
  assert.equal(g3.nodes[1].name, 'Kit');
  assert.equal(g3.nodes.length, 2);

  const gb = pure(g1, () => addBus(g1, 'busA', 'Reverb Bus'), 'addBus');
  assert.deepEqual(gb.nodes[2], { id: 'busA', kind: 'bus', name: 'Reverb Bus' });
  assert.equal(outputOf(gb, 'busA'), MASTER_ID);
  assert.deepEqual(validateGraph(gb), []);
  // A bus id colliding with an existing node does not duplicate it.
  assert.equal(addBus(gb, 'busA', 'Reverb Bus').nodes.length, 3);
}

// The master is never created as a track or a bus: it has no output, so giving
// it one would be a master -> master self-edge that nothing can order.
{
  const g = emptyGraph();
  assert.deepEqual(ensureTrackNode(g, MASTER_ID, 'Not A Track'), g);
  assert.deepEqual(addBus(g, MASTER_ID, 'Not A Bus'), g);
  // Even on a graph that has no master node yet, it is never conjured with an edge.
  const bare: RoutingGraph = { nodes: [], edges: [] };
  assert.deepEqual(ensureTrackNode(bare, MASTER_ID, 'Master'), bare);
  assert.deepEqual(addBus(bare, MASTER_ID, 'Master'), bare);
}

// A node with no explicit output edge still reads as feeding master.
{
  const g: RoutingGraph = { nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 't1', kind: 'track', name: 'T' }], edges: [] };
  assert.equal(outputOf(g, 't1'), MASTER_ID);
  assert.equal(outputOf(g, MASTER_ID), null);
}

// setOutput replaces the single CONN_OUTPUT edge; sends and sidechains survive it.
{
  let g = addBus(ensureTrackNode(emptyGraph(), 't1', 'T'), 'busA', 'Bus');
  g = must(addSend(g, 't1', 'busA', 0.25), 'addSend');
  const before = g;
  g = must(pure(before, () => setOutput(before, 't1', 'busA'), 'setOutput'), 'setOutput');
  assert.equal(outputOf(g, 't1'), 'busA');
  assert.equal(g.edges.filter((e) => e.from === 't1' && e.connType === CONN_OUTPUT).length, 1);
  assert.deepEqual(sendsFrom(g, 't1').map((e) => [e.to, e.gain]), [['busA', 0.25]]);
  // Back to master.
  g = must(setOutput(g, 't1', MASTER_ID), 'setOutput back');
  assert.equal(outputOf(g, 't1'), MASTER_ID);
  assert.deepEqual(validateGraph(g), []);
  // Master never gets an outgoing edge.
  refused(g, () => setOutput(g, MASTER_ID, 't1'), 'master-output', 'setOutput from master');
  refused(g, () => addSend(g, MASTER_ID, 't1', 1), 'master-output', 'addSend from master');
  // Unknown ids are refused, not silently created.
  refused(g, () => setOutput(g, 'nope', MASTER_ID), 'missing-node', 'setOutput from unknown');
  refused(g, () => setOutput(g, 't1', 'nope'), 'missing-node', 'setOutput to unknown');
}

// Sends: add / regain / remove, and no duplicate parallel send.
{
  let g = addBus(ensureTrackNode(emptyGraph(), 't1', 'T'), 'busA', 'Bus');
  const g0 = g;
  g = must(pure(g0, () => addSend(g0, 't1', 'busA', 0.5), 'addSend'), 'addSend');
  assert.deepEqual(sendsFrom(g, 't1'), [{ from: 't1', to: 'busA', connType: CONN_SEND, gain: 0.5 }]);
  refused(g, () => addSend(g, 't1', 'busA', 0.9), 'duplicate', 'addSend duplicate');
  const g1 = g;
  g = pure(g1, () => setSendGain(g1, 't1', 'busA', 0.125), 'setSendGain');
  assert.equal(sendsFrom(g, 't1')[0].gain, 0.125);
  // A gain set on a send that does not exist is a no-op, not a new edge.
  assert.deepEqual(setSendGain(g, 't1', MASTER_ID, 0.4).edges, g.edges);
  const g2 = g;
  g = pure(g2, () => removeSend(g2, 't1', 'busA'), 'removeSend');
  assert.deepEqual(sendsFrom(g, 't1'), []);
  assert.equal(outputOf(g, 't1'), MASTER_ID, 'removing a send leaves the output edge alone');
  assert.deepEqual(removeSend(g, 't1', 'busA').edges, g.edges, 'removing a missing send is a no-op');
}

// Sidechain edges carry the target effect entry, and require it.
{
  let g = ensureTrackNode(ensureTrackNode(emptyGraph(), 'kick', 'Kick'), 'bass', 'Bass');
  const g0 = g;
  g = must(pure(g0, () => setSidechain(g0, 'kick', 'bass', 'comp-1'), 'setSidechain'), 'setSidechain');
  assert.deepEqual(sidechainsInto(g, 'bass'), [
    { from: 'kick', to: 'bass', connType: CONN_SIDECHAIN, gain: 1, targetEntryId: 'comp-1' },
  ]);
  assert.deepEqual(sidechainsInto(g, 'kick'), []);
  // A second sidechain into a DIFFERENT effect entry on the same node is legal.
  g = must(setSidechain(g, 'kick', 'bass', 'gate-2'), 'second sidechain');
  assert.deepEqual(sidechainsInto(g, 'bass').map((e) => e.targetEntryId), ['comp-1', 'gate-2']);
  // The same entry twice is a duplicate, not a second edge.
  refused(g, () => setSidechain(g, 'kick', 'bass', 'comp-1'), 'duplicate', 'duplicate sidechain');
  refused(g, () => setSidechain(g, 'kick', 'bass', ''), 'missing-entry', 'sidechain without an entry id');
  const g1 = g;
  g = pure(g1, () => removeSidechain(g1, 'kick', 'bass', 'comp-1'), 'removeSidechain');
  assert.deepEqual(sidechainsInto(g, 'bass').map((e) => e.targetEntryId), ['gate-2']);
  // Without an entry id, every sidechain on that pair goes.
  assert.deepEqual(sidechainsInto(removeSidechain(g, 'kick', 'bass'), 'bass'), []);
  assert.deepEqual(validateGraph(g), []);
}

// CYCLE REFUSAL — over ALL edge types, because Web Audio does not read labels.
{
  // Direct A -> B -> A.
  let g = ensureTrackNode(ensureTrackNode(emptyGraph(), 'a', 'A'), 'b', 'B');
  g = must(setOutput(g, 'a', 'b'), 'a->b');
  assert.equal(wouldCycle(g, 'b', 'a'), true);
  refused(g, () => setOutput(g, 'b', 'a'), 'cycle', 'direct cycle via output');
  refused(g, () => addSend(g, 'b', 'a', 0.5), 'cycle', 'direct cycle via send');
  refused(g, () => setSidechain(g, 'b', 'a', 'comp-1'), 'cycle', 'direct cycle via sidechain');
  assert.equal(g.edges.filter((e) => e.from === 'b').length, 1, 'a refusal added nothing');

  // Self-edge is a cycle.
  assert.equal(wouldCycle(g, 'a', 'a'), true);
  refused(g, () => setOutput(g, 'a', 'a'), 'cycle', 'self output');
  refused(g, () => addSend(g, 'a', 'a', 1), 'cycle', 'self send');

  // Three-node A -> B -> C -> A.
  let h = ensureTrackNode(ensureTrackNode(ensureTrackNode(emptyGraph(), 'a', 'A'), 'b', 'B'), 'c', 'C');
  h = must(setOutput(h, 'a', 'b'), 'a->b');
  h = must(setOutput(h, 'b', 'c'), 'b->c');
  assert.equal(wouldCycle(h, 'c', 'a'), true);
  refused(h, () => setOutput(h, 'c', 'a'), 'cycle', 'three-node cycle');
  assert.equal(wouldCycle(h, 'c', MASTER_ID), false, 'the legal output is still allowed');
  assert.ok(must(setOutput(h, 'c', MASTER_ID), 'c->master'));

  // Sidechain-closed cycle: track -> bus (output), bus -> track (sidechain key).
  let k = addBus(ensureTrackNode(emptyGraph(), 't1', 'T'), 'busA', 'Bus');
  k = must(setOutput(k, 't1', 'busA'), 't1->busA');
  assert.equal(wouldCycle(k, 'busA', 't1'), true);
  refused(k, () => setSidechain(k, 'busA', 't1', 'comp-1'), 'cycle', 'sidechain closes the loop');
  // A send that closes a loop through a chain of sends is refused too.
  let m = addBus(addBus(ensureTrackNode(emptyGraph(), 't1', 'T'), 'b1', 'B1'), 'b2', 'B2');
  m = must(addSend(m, 't1', 'b1', 0.3), 'send t1->b1');
  m = must(addSend(m, 'b1', 'b2', 0.3), 'send b1->b2');
  assert.equal(wouldCycle(m, 'b2', 't1'), true);
  refused(m, () => addSend(m, 'b2', 't1', 0.3), 'cycle', 'send chain cycle');
  // Nothing about a legal parallel path is a cycle.
  assert.equal(wouldCycle(m, 'b2', MASTER_ID), false);
  assert.equal(wouldCycle(m, 't1', 'b2'), false);
}

// topoOrder: deterministic, insertion-order ties, master last; throws on a cycle.
{
  let g = addBus(ensureTrackNode(ensureTrackNode(emptyGraph(), 't1', 'T1'), 't2', 'T2'), 'busA', 'Bus');
  g = must(setOutput(g, 't1', 'busA'), 't1->busA');
  g = must(addSend(g, 't2', 'busA', 0.4), 'send');
  const order = topoOrder(g);
  assert.equal(order[order.length - 1], MASTER_ID, 'master is always last');
  assert.deepEqual(order, ['t1', 't2', 'busA', MASTER_ID]);
  assert.equal(order.indexOf('t1') < order.indexOf('busA'), true);
  assert.deepEqual(topoOrder(g), order, 'deterministic across calls');
  // Every edge points forward in the order.
  for (const e of g.edges) assert.ok(order.indexOf(e.from) < order.indexOf(e.to), edgeKey(e));

  // Ties are broken by node insertion order, not by id.
  let t = ensureTrackNode(ensureTrackNode(ensureTrackNode(emptyGraph(), 'zzz', 'Z'), 'aaa', 'A'), 'mmm', 'M');
  assert.deepEqual(topoOrder(t), ['zzz', 'aaa', 'mmm', MASTER_ID]);

  // A hand-built cyclic graph (the mutators make this unreachable) throws.
  const cyclic: RoutingGraph = {
    nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 'a', kind: 'track', name: 'A' }, { id: 'b', kind: 'track', name: 'B' }],
    edges: [
      { from: 'a', to: 'b', connType: CONN_OUTPUT, gain: 1 },
      { from: 'b', to: 'a', connType: CONN_OUTPUT, gain: 1 },
    ],
  };
  assert.throws(() => topoOrder(cyclic), /cycle/i);

  // ACYCLIC BUT MALFORMED graphs still get an order: a `.tasmo` load can hand
  // `topoOrder` a graph no mutator vetted, and blaming a cycle for a dangling
  // id would send the reader hunting for a loop that is not there. Structural
  // damage is `validateGraph`'s job to name; ordering must not be collateral.
  const dangling: RoutingGraph = {
    nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 'a', kind: 'track', name: 'A' }],
    edges: [
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 'ghost', to: 'a', connType: CONN_SEND, gain: 0.5 }, // `from` is not a node
    ],
  };
  assert.deepEqual(topoOrder(dangling), ['a', MASTER_ID], 'a dangling `from` is not a cycle');
  assert.ok(validateGraph(dangling).some((p) => p.includes('ghost')), 'validateGraph names it instead');

  const masterSourced: RoutingGraph = {
    nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }, { id: 'a', kind: 'track', name: 'A' }],
    edges: [
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: MASTER_ID, to: 'a', connType: CONN_SEND, gain: 0.5 }, // master never sources an edge
    ],
  };
  assert.deepEqual(topoOrder(masterSourced), ['a', MASTER_ID], 'a master-sourced edge is not a cycle');
  assert.ok(validateGraph(masterSourced).some((p) => p.includes('master')));

  const dupIds: RoutingGraph = {
    nodes: [
      { id: MASTER_ID, kind: 'master', name: 'Master' },
      { id: 'a', kind: 'track', name: 'A' },
      { id: 'a', kind: 'track', name: 'A again' },
    ],
    edges: [{ from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 }],
  };
  assert.deepEqual(topoOrder(dupIds), ['a', MASTER_ID], 'a duplicate node id yields one entry, not a throw');
  assert.ok(validateGraph(dupIds).some((p) => p.includes('duplicate')));

  // The throw stays for a real cycle, and says where to look.
  assert.throws(() => topoOrder(cyclic), /run validateGraph/);
  // And the mutators really do make it unreachable: no sequence of accepted
  // mutations can produce a graph topoOrder refuses.
  let fuzz = addBus(addBus(ensureTrackNode(ensureTrackNode(emptyGraph(), 'a', 'A'), 'b', 'B'), 'c', 'C'), 'd', 'D');
  const ids = ['a', 'b', 'c', 'd', MASTER_ID];
  let seed = 12345;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 400; i += 1) {
    const from = ids[rnd(ids.length)];
    const to = ids[rnd(ids.length)];
    const pick = rnd(3);
    const r = pick === 0 ? setOutput(fuzz, from, to)
      : pick === 1 ? addSend(fuzz, from, to, 0.5)
        : setSidechain(fuzz, from, to, `e${rnd(2)}`);
    if (r.ok) fuzz = r.graph;
    topoOrder(fuzz); // must never throw
    assert.deepEqual(validateGraph(fuzz), [], `fuzz step ${i}`);
  }
}

// inputsOf reports every incoming edge whatever its type.
{
  let g = addBus(ensureTrackNode(ensureTrackNode(emptyGraph(), 't1', 'T1'), 't2', 'T2'), 'busA', 'Bus');
  g = must(setOutput(g, 't1', 'busA'), 'out');
  g = must(addSend(g, 't2', 'busA', 0.2), 'send');
  g = must(setSidechain(g, 't1', 'busA', 'comp-1'), 'sc');
  assert.deepEqual(inputsOf(g, 'busA').map(edgeKey), ['t1>busA:0:', 't2>busA:1:', 't1>busA:2:comp-1']);
  assert.deepEqual(inputsOf(g, 't1'), []);
}

// removeNode: edges go, orphaned outputs are re-homed to master, master stays.
{
  let g = addBus(ensureTrackNode(ensureTrackNode(emptyGraph(), 't1', 'T1'), 't2', 'T2'), 'busA', 'Bus');
  g = must(setOutput(g, 't1', 'busA'), 'out t1');
  g = must(addSend(g, 't2', 'busA', 0.3), 'send t2');
  g = must(setSidechain(g, 't2', 'busA', 'comp-1'), 'sc t2');
  const before = g;
  g = pure(before, () => removeNode(before, 'busA'), 'removeNode');
  assert.deepEqual(g.nodes.map((n) => n.id), [MASTER_ID, 't1', 't2']);
  assert.equal(outputOf(g, 't1'), MASTER_ID, 'the orphaned output is re-homed so nothing goes silent');
  assert.deepEqual(sendsFrom(g, 't2'), [], 'the dangling send is dropped, not re-homed');
  assert.deepEqual(sidechainsInto(g, 't2'), []);
  assert.deepEqual(validateGraph(g), []);
  assert.deepEqual(topoOrder(g), ['t1', 't2', MASTER_ID]);

  // Master cannot be removed, and an unknown id is a no-op.
  assert.deepEqual(removeNode(g, MASTER_ID), g);
  assert.deepEqual(removeNode(g, 'nope'), g);

  // TWO feeders orphaned at once: both are re-homed, neither goes silent.
  {
    let d = addBus(ensureTrackNode(ensureTrackNode(emptyGraph(), 'k', 'Kick'), 's', 'Snare'), 'drums', 'Drum Bus');
    d = must(setOutput(d, 'k', 'drums'), 'k->drums');
    d = must(setOutput(d, 's', 'drums'), 's->drums');
    d = removeNode(d, 'drums');
    assert.equal(outputOf(d, 'k'), MASTER_ID);
    assert.equal(outputOf(d, 's'), MASTER_ID);
    assert.equal(d.edges.length, 2, 'exactly one output edge each, no leftovers');
    assert.deepEqual(validateGraph(d), []);
    assert.deepEqual(topoOrder(d), ['k', 's', MASTER_ID]);
  }

  // Removing a node whose output already pointed at master leaves exactly one edge.
  const h = removeNode(g, 't2');
  assert.deepEqual(h.nodes.map((n) => n.id), [MASTER_ID, 't1']);
  assert.equal(h.edges.filter((e) => e.from === 't1' && e.connType === CONN_OUTPUT).length, 1);
}

// validateGraph names each malformed shape.
{
  const master = { id: MASTER_ID, kind: 'master' as const, name: 'Master' };
  const t = (id: string): { id: string; kind: 'track'; name: string } => ({ id, kind: 'track', name: id });
  const has = (g: RoutingGraph, needle: string): void => {
    const problems = validateGraph(g);
    assert.ok(problems.some((p) => p.includes(needle)), `expected a problem mentioning "${needle}", got ${JSON.stringify(problems)}`);
  };
  has({ nodes: [master, t('a'), t('a')], edges: [{ from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 }] }, 'duplicate');
  has({ nodes: [master, t('a')], edges: [{ from: 'a', to: 'ghost', connType: CONN_OUTPUT, gain: 1 }] }, 'ghost');
  has({ nodes: [master, t('a')], edges: [{ from: 'ghost', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 }] }, 'ghost');
  has({ nodes: [master, t('a')], edges: [] }, 'output');
  has({
    nodes: [master, t('a')],
    edges: [
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
    ],
  }, 'output');
  has({
    nodes: [master, t('a'), t('b')],
    edges: [
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 'b', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: 'a', to: 'b', connType: CONN_SIDECHAIN, gain: 1 },
    ],
  }, 'targetEntryId');
  has({
    nodes: [master, t('a')],
    edges: [
      { from: 'a', to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 },
      { from: MASTER_ID, to: 'a', connType: CONN_SEND, gain: 1 },
    ],
  }, 'master');
  // A healthy graph reports nothing.
  assert.deepEqual(validateGraph(must(addSend(addBus(ensureTrackNode(emptyGraph(), 'a', 'A'), 'b', 'B'), 'a', 'b', 0.2))), []);
}

// The model stays expressible in the dormant .tasmo schema
// (Track.output_routing: str | None, Track.send_amounts: dict[str, float]).
{
  let g = addBus(ensureTrackNode(emptyGraph(), 't1', 'T1'), 'busA', 'Bus');
  g = must(setOutput(g, 't1', 'busA'), 'out');
  g = must(addSend(g, 't1', MASTER_ID, 0.6), 'send');
  const outputRouting = outputOf(g, 't1');
  const sendAmounts = Object.fromEntries(sendsFrom(g, 't1').map((e) => [e.to, e.gain]));
  assert.equal(outputRouting, 'busA');
  assert.deepEqual(sendAmounts, { [MASTER_ID]: 0.6 });
}

console.log('routingGraph: ok');
