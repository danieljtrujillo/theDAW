// Routing + buses survive the .tasmo write/read.
//
// Before this, `routing` and `buses` survived undo and the autosave manifest but
// NOT save -> open: the writer emitted no routing keys at all, so every project
// reopened with its tracks collapsed onto the master. These pin the two pure
// mappers projectImport.ts uses at the file boundary, the way projectImport.test.ts
// pins the piano-roll ones: write -> JSON -> read, plus the two shapes a file can
// arrive in that no mutator ever vetted (a legacy file, a hand-edited cyclic one).
import assert from 'node:assert/strict';
import {
  busesToTasmo,
  captureEditorSession,
  tasmoToRouting,
  trackRoutingToTasmo,
  type TasmoRoutedTrack,
} from './projectImport.ts';
import type { TasmoBus } from './projectClient.ts';
import {
  addBus,
  addSend,
  emptyGraph,
  ensureTrackNode,
  MASTER_ID,
  outputOf,
  sendsFrom,
  setOutput,
  topoOrder,
  validateGraph,
  type RoutingGraph,
} from '../state/routingGraph.ts';
import { useEditorStore, type EditorBus } from '../state/editorStore.ts';

const ok = (r: { ok: boolean; graph?: RoutingGraph; reason?: string }): RoutingGraph => {
  assert.equal(r.ok, true, `mutator refused: ${r.reason}`);
  return r.graph as RoutingGraph;
};

/** Two tracks, one bus: drums -> bus, vocal -> master with a 0.4 send into the bus. */
function fixture(): { graph: RoutingGraph; buses: EditorBus[] } {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'Drums');
  g = ensureTrackNode(g, 't2', 'Vocal');
  g = addBus(g, 'b1', 'Drum Bus');
  g = ok(setOutput(g, 't1', 'b1'));
  g = ok(addSend(g, 't2', 'b1', 0.4));
  const buses: EditorBus[] = [
    {
      id: 'b1',
      name: 'Drum Bus',
      fxChain: [{ id: 'fx-1', effect: 'my_fx', params: { mix: 0.4 }, enabled: false, label: 'my_fx' }],
      volume: 0.7,
      mute: true,
    },
  ];
  return { graph: g, buses };
}

/** The file JSON a save produces for that session, after a real serialize. */
function writeThenParse(g: RoutingGraph, buses: EditorBus[]) {
  const payload = {
    tracks: [
      { id: 't1', name: 'Drums', ...trackRoutingToTasmo(g, 't1') },
      { id: 't2', name: 'Vocal', ...trackRoutingToTasmo(g, 't2') },
    ],
    buses: busesToTasmo(g, buses),
  };
  return JSON.parse(JSON.stringify(payload)) as {
    tracks: TasmoRoutedTrack[];
    buses: TasmoBus[];
  };
}

// ── The round trip ───────────────────────────────────────────────────────────
{
  const { graph, buses } = fixture();
  const file = writeThenParse(graph, buses);

  // What the writer put in the file.
  assert.equal(file.tracks[0].output_routing, 'b1', 'the drum track names its bus');
  assert.deepEqual(file.tracks[0].send_amounts, {});
  assert.equal(file.tracks[1].output_routing, null, 'master is written as null, never as a bus id');
  assert.deepEqual(file.tracks[1].send_amounts, { b1: 0.4 });
  assert.equal(file.buses.length, 1, 'the master is never written as a bus');
  assert.equal(file.buses[0].id, 'b1');
  assert.equal(file.buses[0].volume, 0.7);
  assert.equal(file.buses[0].mute, true);
  assert.equal(file.buses[0].output_routing, null);
  assert.deepEqual(file.buses[0].send_amounts, {}, 'a bus that sends nowhere writes no sends');
  assert.equal(file.buses[0].sidechain_keys, undefined, 'and no sidechain list');
  assert.equal(file.buses[0].effect_chain?.length, 1);

  // What the reader rebuilds. Compared through the accessors, not by identity:
  // the edge ORDER a rebuild produces is its own, and only the relations matter.
  const read = tasmoToRouting(file.tracks, file.buses);
  assert.deepEqual(
    read.routing.nodes.map((n) => `${n.kind}:${n.id}`).sort(),
    ['bus:b1', 'master:master', 'track:t1', 'track:t2'],
  );
  for (const id of ['t1', 't2', 'b1', MASTER_ID]) {
    assert.equal(outputOf(read.routing, id), outputOf(graph, id), `output of ${id}`);
    assert.deepEqual(
      sendsFrom(read.routing, id).map((e) => [e.to, e.gain]),
      sendsFrom(graph, id).map((e) => [e.to, e.gain]),
      `sends from ${id}`,
    );
  }
  assert.deepEqual(validateGraph(read.routing), [], 'the rebuilt graph is structurally sound');

  // The bus strip survives whole, chain entry included.
  assert.deepEqual(read.buses, buses);
}

// ── A file written before routing existed ────────────────────────────────────
{
  const read = tasmoToRouting(
    [
      { id: 't1', name: 'Gtr' },
      { id: 't2', name: 'Bass' },
    ],
    undefined,
  );
  assert.deepEqual(read.buses, []);
  assert.deepEqual(read.routing.nodes.map((n) => n.id).sort(), ['master', 't1', 't2']);
  assert.equal(outputOf(read.routing, 't1'), MASTER_ID, 'a legacy track feeds the master');
  assert.equal(outputOf(read.routing, 't2'), MASTER_ID);
  assert.deepEqual(sendsFrom(read.routing, 't1'), []);
  assert.deepEqual(validateGraph(read.routing), []);
}

// ── A hand-edited file whose buses feed each other in a loop ─────────────────
{
  const read = tasmoToRouting(
    [{ id: 't1', name: 'Gtr', output_routing: 'a', send_amounts: {} }],
    [
      { id: 'a', name: 'A', volume: 0.8, mute: false, output_routing: 'b', effect_chain: [] },
      { id: 'b', name: 'B', volume: 0.8, mute: false, output_routing: 'a', effect_chain: [] },
    ],
  );
  // One of the two edges is refused and that bus is left feeding the master, so
  // the project still opens and still makes sound.
  const outs = [outputOf(read.routing, 'a'), outputOf(read.routing, 'b')];
  assert.equal(outs.filter((o) => o === MASTER_ID).length, 1, 'exactly one edge re-homed to master');
  assert.equal(outputOf(read.routing, 't1'), 'a', 'the track that named a real bus keeps it');
  assert.doesNotThrow(() => topoOrder(read.routing), 'the rebuilt graph is a DAG');
  assert.deepEqual(validateGraph(read.routing), []);
  assert.equal(read.buses.length, 2, 'both strips still exist — only the edge was refused');
}

// ── A hand-edited file naming a bus that is not there ────────────────────────
{
  const read = tasmoToRouting(
    [{ id: 't1', name: 'Gtr', output_routing: 'ghost', send_amounts: { ghost: 0.5, t1: 0.2 } }],
    [],
  );
  assert.equal(outputOf(read.routing, 't1'), MASTER_ID, 'an unknown output re-homes to master');
  assert.deepEqual(sendsFrom(read.routing, 't1'), [], 'and an unknown or self send is dropped');
  assert.deepEqual(validateGraph(read.routing), []);
}

// ── A hand-edited file with an absurd or broken send gain ────────────────────
{
  const read = tasmoToRouting(
    [{ id: 't1', name: 'Gtr', send_amounts: { b: 1e9, c: -4, d: Number.NaN } }],
    [
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
      { id: 'd', name: 'D' },
    ],
  );
  assert.deepEqual(
    sendsFrom(read.routing, 't1').map((e) => [e.to, e.gain]),
    [['b', 2], ['c', 0]],
    'gains clamp into [0, 2]; a NaN gain is dropped entirely',
  );
  // A bus the file gives no fader loads at the BACKEND default (unity), not the
  // store's default for a newly created bus.
  assert.deepEqual(read.buses.map((x) => x.volume), [1, 1, 1]);
  assert.deepEqual(read.buses.map((x) => x.mute), [false, false, false]);
  assert.deepEqual(read.buses[0].fxChain, []);
}

// ── The writer never invents a bus ───────────────────────────────────────────
{
  // A graph carrying a bus NODE with no strip behind it (a damaged document):
  // the file lists the strips, so the phantom node is not written.
  let g = emptyGraph();
  g = addBus(g, 'phantom', 'Phantom');
  assert.deepEqual(busesToTasmo(g, []), []);
  // And a strip whose node is missing still writes, feeding the master and
  // sending nowhere.
  assert.deepEqual(busesToTasmo(g, [{ id: 'nostrip', name: 'N', fxChain: [], volume: 0.5, mute: false }]), [
    { id: 'nostrip', name: 'N', volume: 0.5, mute: false, output_routing: null, send_amounts: {}, effect_chain: [] },
  ]);
}

// ── The captured save payload, end to end ────────────────────────────────────
// The mappers above are only useful if the SAVE payload actually carries what
// they produce: before this, captureEditorSession emitted no routing keys and no
// bus list at all, so the file could not describe a bus even though the model had
// somewhere to put one.
{
  const { graph, buses } = fixture();
  useEditorStore.setState({
    bpm: 124,
    routing: graph,
    buses,
    tracks: [
      { id: 't1', name: 'Drums', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' },
      { id: 't2', name: 'Vocal', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' },
    ] as never,
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        label: 'take',
        audioBlob: new Blob([new Uint8Array([0])], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        startSec: 0,
        durationSec: 1,
        sourceDuration: 1,
      },
    ] as never,
  });

  const session = captureEditorSession();
  assert.equal(session.clipCount, 1, 'the session is non-empty, so save would not skip it');
  const byId = Object.fromEntries(session.tracks.map((t) => [t.id, t]));
  assert.equal(byId.t1.output_routing, 'b1', 'the payload track names its bus');
  assert.deepEqual(byId.t2.send_amounts, { b1: 0.4 }, 'and the other carries its send');
  assert.equal(byId.t2.output_routing, null);
  assert.equal(session.buses.length, 1, 'and the payload carries the bus strip');
  assert.equal(session.buses[0].id, 'b1');
  assert.equal(session.buses[0].volume, 0.7);
  assert.equal(session.buses[0].mute, true);

  // The payload survives the JSON the save POST actually sends, and reads back
  // to the same graph — the full write -> wire -> read loop.
  const wire = JSON.parse(JSON.stringify({ tracks: session.tracks, buses: session.buses }));
  const read = tasmoToRouting(wire.tracks, wire.buses);
  assert.equal(outputOf(read.routing, 't1'), 'b1');
  assert.deepEqual(sendsFrom(read.routing, 't2').map((e) => [e.to, e.gain]), [['b1', 0.4]]);
  assert.deepEqual(read.buses, buses);
}

console.log('projectImport.routing: all assertions passed');
