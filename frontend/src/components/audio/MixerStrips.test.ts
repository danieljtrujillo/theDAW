/**
 * MixerStrips model helpers — the pure part of the mixer drawer.
 *
 * Every list the drawer renders is derived here rather than in JSX, so the two
 * things that can silently go wrong — an output option that would close a
 * feedback loop being offered, and a send row disagreeing with the graph — are
 * testable without React or Web Audio.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/MixerStrips.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  nextBusName,
  outputOptions,
  refusalMessage,
  sendRowsFor,
  sendTargetOptions,
} from './MixerStrips.tsx';
import {
  CONN_OUTPUT,
  CONN_SEND,
  MASTER_ID,
  addBus as graphAddBus,
  addSend as graphAddSend,
  emptyGraph,
  ensureTrackNode,
  setOutput as graphSetOutput,
  type RoutingGraph,
} from '../../state/routingGraph.ts';
import type { EditorBus } from '../../state/editorStore.ts';

const bus = (id: string, name: string): EditorBus => ({ id, name, fxChain: [], volume: 0.8, mute: false });

/** A graph with one track and two buses, everything still feeding the master. */
function fixture(): { g: RoutingGraph; buses: EditorBus[] } {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'Drums');
  g = graphAddBus(g, 'b1', 'Drum Bus');
  g = graphAddBus(g, 'b2', 'Reverb');
  return { g, buses: [bus('b1', 'Drum Bus'), bus('b2', 'Reverb')] };
}

const ok = (r: { ok: boolean; graph?: RoutingGraph }): RoutingGraph => {
  assert.ok(r.ok, 'fixture mutation was refused');
  return r.graph as RoutingGraph;
};

// ── outputOptions ────────────────────────────────────────────────────────────

// Master leads the list, then every bus in `buses` order. The node itself is
// never offered as its own output.
{
  const { g, buses } = fixture();
  const opts = outputOptions(g, buses, 't1');
  assert.deepEqual(opts.map((o) => o.id), [MASTER_ID, 'b1', 'b2']);
  assert.deepEqual(opts.map((o) => o.label), ['Master', 'Drum Bus', 'Reverb']);
  assert.deepEqual(opts.map((o) => o.disabled), [false, false, false]);

  const busOpts = outputOptions(g, buses, 'b1');
  assert.deepEqual(busOpts.map((o) => o.id), [MASTER_ID, 'b2'], 'a bus is not its own output option');
}

// A bus whose own output already feeds this node would close a loop, so that
// option is disabled and carries a title saying why. The node's CURRENT output
// is never disabled by its own edge — `setOutput` replaces that edge, so the
// option list must probe the graph with it removed, exactly as the store does.
{
  const { g, buses } = fixture();
  // b2 -> b1. Now routing b1 -> b2 would loop.
  const wired = ok(graphSetOutput(g, 'b2', 'b1'));

  const b1Opts = outputOptions(wired, buses, 'b1');
  const toB2 = b1Opts.find((o) => o.id === 'b2');
  assert.ok(toB2, 'b2 is still listed');
  assert.equal(toB2.disabled, true, 'b1 -> b2 would close the b2 -> b1 loop');
  assert.ok((toB2.title ?? '').length > 0, 'a disabled option explains itself');

  // b2's own picker still offers b1 — its current output — enabled.
  const b2Opts = outputOptions(wired, buses, 'b2');
  assert.equal(b2Opts.find((o) => o.id === 'b1').disabled, false, 'the current output stays selectable');
}

// A document whose bus strip is gone but whose output edge still points at it
// (a hand-edited or drifted project file) must not blank the picker: the
// current value is rendered as a disabled "(missing bus)" entry so the select
// still has the option it is parked on.
{
  const { g, buses } = fixture();
  const wired = ok(graphSetOutput(g, 't1', 'b1'));
  const opts = outputOptions(wired, [buses[1]], 't1'); // b1's strip is gone
  const orphan = opts.find((o) => o.id === 'b1');
  assert.ok(orphan, 'the current output is still listed');
  assert.equal(orphan.disabled, true, 'a bus with no strip cannot be chosen afresh');
  assert.ok(orphan.label.includes('missing'), `expected a "missing" label, got ${orphan.label}`);
  assert.deepEqual(opts.map((o) => o.id), [MASTER_ID, 'b2', 'b1'], 'the orphan is appended, not interleaved');

  // The master needs no such entry, and a node already on the master gets none.
  assert.equal(outputOptions(g, buses, 't1').length, 3);
}

// A SEND counts as an edge for feedback, exactly like an output: Web Audio does
// not care what a connection is called.
{
  const { g, buses } = fixture();
  const wired = ok(graphAddSend(g, 'b2', 'b1', 0.5)); // b2 sends into b1
  const opts = outputOptions(wired, buses, 'b1');
  assert.equal(opts.find((o) => o.id === 'b2').disabled, true, 'a send closes the loop too');
  assert.equal(opts.find((o) => o.id === MASTER_ID).disabled, false, 'the master can never cycle');
}

// ── sendRowsFor ──────────────────────────────────────────────────────────────

// One row per CONN_SEND edge leaving the node, in graph order, labelled by the
// bus strip's name and carrying the edge's gain.
{
  const { g, buses } = fixture();
  let wired = ok(graphAddSend(g, 't1', 'b2', 0.35));
  wired = ok(graphAddSend(wired, 't1', 'b1', 0.8));

  const rows = sendRowsFor(wired, buses, 't1');
  assert.deepEqual(rows.map((r) => r.to), ['b2', 'b1']);
  assert.deepEqual(rows.map((r) => r.label), ['Reverb', 'Drum Bus']);
  assert.deepEqual(rows.map((r) => r.gain), [0.35, 0.8]);

  // Outputs are not sends.
  assert.equal(sendRowsFor(wired, buses, 'b1').length, 0);
  assert.ok(wired.edges.some((e) => e.from === 't1' && e.connType === CONN_OUTPUT), 'the output edge survived');
  assert.equal(wired.edges.filter((e) => e.connType === CONN_SEND).length, 2);
}

// A send whose destination bus strip is gone still renders, named from the
// graph node — a row that vanished would leave an edge nobody can remove.
{
  const { g } = fixture();
  const wired = ok(graphAddSend(g, 't1', 'b1', 0.5));
  const rows = sendRowsFor(wired, [], 't1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Drum Bus');
}

// ── sendTargetOptions ────────────────────────────────────────────────────────

// Candidates for a NEW send: every bus except the node itself, with the ones
// already sent to disabled — one send per (from, to) pair. There is no
// retarget, so this list is only ever consulted for a send that does not exist
// yet and never has to keep an already-chosen option selectable.
{
  const { g, buses } = fixture();
  const wired = ok(graphAddSend(g, 't1', 'b1', 0.5));

  const opts = sendTargetOptions(wired, buses, 't1');
  assert.deepEqual(opts.map((o) => o.id), ['b1', 'b2']);
  assert.equal(opts[0].disabled, true, 'b1 already has a send from t1');
  assert.ok((opts[0].title ?? '').length > 0);
  assert.equal(opts[1].disabled, false);

  assert.deepEqual(sendTargetOptions(wired, buses, 'b1').map((o) => o.id), ['b2'], 'no self-send');
}

// A bus that feeds this node cannot also receive a send from it.
{
  const { g, buses } = fixture();
  const wired = ok(graphSetOutput(g, 'b2', 't1'));
  const opts = sendTargetOptions(wired, buses, 't1');
  assert.equal(opts.find((o) => o.id === 'b2').disabled, true, 'b2 -> t1 -> b2 is a loop');
}

// ── nextBusName ──────────────────────────────────────────────────────────────

// Matches the store's own default (`Bus ${buses.length + 1}`), so the name the
// drawer asks for is the name the store would have picked.
{
  assert.equal(nextBusName([]), 'Bus 1');
  assert.equal(nextBusName([bus('b1', 'Drum Bus')]), 'Bus 2');
  assert.equal(nextBusName([bus('b1', 'a'), bus('b2', 'b'), bus('b3', 'c')]), 'Bus 4');
}

// ── refusalMessage ───────────────────────────────────────────────────────────

// Every refusal the store can return has a sentence; none falls through to a
// bare enum value.
{
  for (const reason of ['cycle', 'missing-node', 'master-output', 'duplicate', 'missing-entry'] as const) {
    const msg = refusalMessage(reason);
    assert.ok(msg.length > 0, `${reason} has no message`);
    assert.ok(!msg.includes(reason), `${reason} leaks its enum value into the message`);
  }
}

console.log('MixerStrips model: all assertions passed');
