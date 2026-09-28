// The offline bounce FOLLOWS THE ROUTING GRAPH, and the printed file is trimmed
// by the latency the chains it built declare (T14, plan §3.6 step 3b + §3.8
// step 3a).
//
// Two gaps closed here, both of them one file:
//
//   1. Since batch 6 the LIVE mixer walks `state/routingGraph` — "drums -> drum
//      bus", "vocal -> reverb send at -12 dB" — while `lib/renderCore` still
//      hard-wired every track tail to one unity master bus. A mix that played
//      through a bus printed as if the bus were not there. `renderBounce` now
//      builds a bus strip per `EditorBus` and hands every strip to the SAME
//      `liveMixer.wireRoutingGraph` the live engine uses, so there is one
//      wiring pass in the app rather than a live one and an offline one.
//   2. Live playback is latency-compensated per track (`trackCompDelays`), so
//      the mix arrives `maxSec` late and the transport reads back by the same
//      amount. The bounce printed that lag into the file. `trimLeadingSec`
//      takes it off the front.
//      T14 could only land the SLOWEST path that way, because the offline graph
//      had no comp delays: every other track printed `maxSec - own` EARLY.
//      T18 splices the comps the live strips have into the master scope's, so
//      `latency + comp == maxSec` on every path and the one trim lands all of
//      them — section 6b, `everyStripIsCompensatedNotJustTheSlowest`.
//      Both the comps and the trim have to DEGRADE with the wiring: a graph
//      that will not order renders with no bus in any path, so it must hold and
//      trim nothing for one rather than bill a cycle's racks per hop and cut
//      the head off the user's file.
//
// The pins below are the behaviours a later edit could silently lose: bus FX
// only under `includeFx`, bus fader/mute only under `includeTrackMix`, one gain
// node per send tapped off the SAME output as the main path, a malformed graph
// degrading to every strip -> master rather than to silence, the two scopes
// that are pre-routing BY DEFINITION (a stem, a selection), and a routing-less
// project rendering the identical flat graph it always did.
//
// Fake-context pattern is `renderCore.test.ts`'s: nodes that record their
// connections, a context that hands them out. `scheduleSources` is a no-op stub
// here — the clip wiring is that file's subject, the graph ABOVE the clip is
// this one's.
//
// Run: npx tsx src/lib/renderCore.routing.test.ts
import assert from 'node:assert/strict';

import type { AudioClip, EditorBus, EditorTrack } from '../state/editorStore.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';
import type { ChainHandle } from './rackEffects.ts';
import { bounceIsChunkSafe } from '../state/renderJobs.ts';
import { trackCompDelays, type TrackCompRow } from '../state/liveMixer.ts';
import {
  CONN_OUTPUT, CONN_SEND, MASTER_ID, addBus, addSend, emptyGraph, ensureTrackNode, setOutput,
  type RoutingGraph,
} from '../state/routingGraph.ts';
import {
  renderBounce, trimLeadingSec,
  type BounceRequest, type BounceScope, type RenderDeps,
} from './renderCore.ts';

/* ── Stand-ins ────────────────────────────────────────────────────────────── */

interface FakeNode {
  kind: string;
  gain: { value: number };
  pan: { value: number };
  /** A `DelayNode`'s param, for the comp delays. A real one is an AudioParam;
   *  the render only ever writes `.value` on it (offline there is nothing to
   *  ramp), so a recorder of the value is the whole surface. */
  delayTime: { value: number };
  /** The channel-count pair, started at values NO real node has (a `DelayNode`
   *  defaults to 2 / `'max'`) so that asserting 2 / `'explicit'` proves the
   *  render WROTE them rather than that the default happened to match. */
  channelCount: number;
  channelCountMode: string;
  outputs: FakeNode[];
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
}

/** Every `connect`, in the order the pass made it, so the ORDER is assertable
 *  and not just the end state — `wireRoutingGraph` promises topological order. */
let wireLog: string[] = [];

const fakeNode = (kind: string): FakeNode => {
  const node: FakeNode = {
    kind,
    gain: { value: 1 },
    pan: { value: 0 },
    delayTime: { value: 0 },
    channelCount: 0,
    channelCountMode: 'unset',
    outputs: [],
    connect(to) { node.outputs.push(to); wireLog.push(`${node.kind}->${to.kind}`); return to; },
    disconnect() { node.outputs.length = 0; },
  };
  return node;
};

/** The per-track compensation delay, handed to `renderBounce` through
 *  `deps.makeCompDelay`. That seam exists because a `DelayNode` is the one node
 *  the render needs that this context does not hand out — the fakes here are
 *  plain recorders, and `ctx.createDelay` (the seam's default) belongs to a
 *  real context. Registered in `created` like every other node, so the order
 *  the strips were compensated in is assertable. */
const fakeCompDelay = (ctx: FakeCtx): FakeNode => {
  const n = fakeNode(`comp${ctx.created.length}`);
  ctx.created.push(n);
  return n;
};

/** A rendered buffer whose every sample IS its own index, so a trim is read off
 *  the values rather than inferred: after dropping `n` samples, sample 0 holds
 *  `n` and the tail holds zeros. */
const rampBuffer = (length: number, sampleRate: number, channels: number) => {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i += 1) d[i] = i;
    data.push(d);
  }
  return {
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: (ch: number) => data[ch],
  };
};

interface FakeCtx {
  sampleRate: number;
  length: number;
  destination: FakeNode;
  created: FakeNode[];
  createGain(): FakeNode;
  createStereoPanner(): FakeNode;
  createBufferSource(): FakeNode;
  suspend(t: number): Promise<void>;
  resume(): Promise<void>;
  startRendering(): Promise<unknown>;
}

const fakeCtx = (channels: number, length: number, sampleRate: number): FakeCtx => {
  const created: FakeNode[] = [];
  const ctx: FakeCtx = {
    sampleRate,
    length,
    destination: fakeNode('destination'),
    created,
    createGain() { const n = fakeNode(`gain${created.length}`); created.push(n); return n; },
    createStereoPanner() { const n = fakeNode(`pan${created.length}`); created.push(n); return n; },
    createBufferSource() { const n = fakeNode(`src${created.length}`); created.push(n); return n; },
    suspend() { return Promise.resolve(); },
    resume() { return Promise.resolve(); },
    async startRendering() { return rampBuffer(length, sampleRate, channels); },
  };
  return ctx;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

let nextBlob = 0;
const clip = (over: Partial<AudioClip> & { id: string; trackId: string }): AudioClip => ({
  label: over.id,
  audioBlob: new Blob([`${nextBlob++}`]),
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#fff',
  ...over,
});

const track = (over: Partial<EditorTrack> & { id: string }): EditorTrack => ({
  name: over.id,
  nameAutoGenerated: false,
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  color: '#fff',
  ...over,
});

const bus = (over: Partial<EditorBus> & { id: string }): EditorBus => ({
  name: over.id,
  fxChain: [],
  volume: 1,
  mute: false,
  ...over,
});

/** The real registry's declaration is what this suite measures against:
 *  `rackEffects` gives `compressor` the spec-mandated `latencySec: 0.006`. */
const compressor = (id: string): ChainEntry => ({
  id, effect: 'compressor', enabled: true, params: {},
});

interface ChainCall {
  input: FakeNode;
  output: FakeNode;
  entries: ChainEntry[];
  disposed: number;
}

interface Harness {
  ctxes: FakeCtx[];
  deps: RenderDeps;
  chain: { calls: ChainCall[] };
}

/** A `buildEffectChain` stand-in: records the call and wires input straight to
 *  output, which is what the real one does for a chain with nothing renderable
 *  in it. The nodes an effect would add are not this suite's subject. */
const buildChainSpy = () => {
  const calls: ChainCall[] = [];
  const build = (_ctx: unknown, input: unknown, output: unknown, entries: ChainEntry[]): ChainHandle => {
    const call: ChainCall = {
      input: input as FakeNode, output: output as FakeNode, entries, disposed: 0,
    };
    calls.push(call);
    (input as FakeNode).connect(output as FakeNode);
    return {
      rebuild: () => {},
      updateParams: () => {},
      instances: () => [],
      inertIds: () => [],
      dispose: () => { call.disposed += 1; },
    } as unknown as ChainHandle;
  };
  return { calls, build: build as unknown as RenderDeps['buildChain'] };
};

const harness = (
  over: Partial<Pick<RenderDeps, 'clips' | 'tracks' | 'masterFxChain' | 'routing' | 'buses'>> = {},
): Harness => {
  const ctxes: FakeCtx[] = [];
  const chain = buildChainSpy();
  return {
    ctxes,
    chain,
    deps: {
      clips: over.clips ?? [],
      tracks: over.tracks ?? [],
      masterFxChain: over.masterFxChain ?? [],
      automationLanes: [],
      routing: over.routing,
      buses: over.buses,
      decode: async () => rampBuffer(10 * SR, SR, 2) as unknown as AudioBuffer,
      buildChain: chain.build,
      // The per-clip wiring is `renderCore.test.ts`'s subject; this suite is
      // about the graph above it, so nothing is scheduled.
      scheduleSources: (() => {}) as unknown as RenderDeps['scheduleSources'],
      makeContext: (channels, length, rate) => {
        const c = fakeCtx(channels, length, rate);
        ctxes.push(c);
        return c as unknown as OfflineAudioContext;
      },
      makeCompDelay: (c) => fakeCompDelay(c as unknown as FakeCtx) as unknown as DelayNode,
      makeDecodeContext: () => ({ close: async () => {} }) as unknown as BaseAudioContext & {
        close(): Promise<void>;
      },
      ensureChop: async () => {},
      sliceChunks: () => [],
    },
  };
};

/** A low sample rate keeps a 30 s master render to 30 000 samples instead of
 *  1.3 M, and 6 ms is still a whole number of them (6). */
const SR = 1000;

const request = (scope: BounceScope, over: Partial<BounceRequest> = {}): BounceRequest => ({
  scope,
  sampleRate: SR,
  includeFx: true,
  includeAutomation: false,
  includeTrackMix: true,
  float32: false,
  ...over,
});

/** t1 -> b1 -> master, t2 -> master. */
function graphWithOneBus(): RoutingGraph {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'T1');
  g = ensureTrackNode(g, 't2', 'T2');
  g = addBus(g, 'b1', 'Drums');
  const res = setOutput(g, 't1', 'b1');
  assert.ok(res.ok, 't1 -> bus is a legal edge');
  return res.graph as RoutingGraph;
}

const panners = (ctx: FakeCtx): FakeNode[] => ctx.created.filter((n) => n.kind.startsWith('pan'));
const gains = (ctx: FakeCtx): FakeNode[] => ctx.created.filter((n) => n.kind.startsWith('gain'));
/** The comp delays, in the order the strips were compensated (= track order). */
const comps = (ctx: FakeCtx): FakeNode[] => ctx.created.filter((n) => n.kind.startsWith('comp'));

/* ── 1. A bus strip, built offline, in the live strip's shape ─────────────── */

async function aBusStripIsBuiltAndPlacedByTheGraph(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', volume: 0.5, fxChain: [compressor('b-fx')] })],
  });
  wireLog = [];
  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];

  // masterBus, then the bus strip's four gains, then the two track strips.
  // `createBusNodes` (state/liveMixer) is the shape being mirrored:
  // input -> [fx] -> gain -> muteGain -> output, the output left for the graph.
  const [masterBus, busIn, busGain, busMute, busOut] = ctx.created;
  assert.equal(busGain.gain.value, 0.5, 'the bus fader opens at the stored volume');
  assert.equal(busMute.gain.value, 1, 'an unmuted bus passes unity');
  assert.deepEqual(busGain.outputs, [busMute], 'fader feeds the mute gate');
  assert.deepEqual(busMute.outputs, [busOut], 'mute gate feeds the output');

  const busChain = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'b-fx'));
  assert.ok(busChain, 'the bus rack is built');
  assert.equal(busChain.input, busIn, 'spliced between the bus input');
  assert.equal(busChain.output, busGain, 'and the bus fader — a bus has PRE-fader inserts');

  // Track tails: t1 lands on the bus INPUT, t2 on the master bus, and the bus
  // output on the master bus — each through its own comp delay, which is where
  // the LIVE strip puts it too (`liveMixer.insertCompNode`: the graph places
  // the comp, not the panner). The compressed bus is downstream of t1, so it is
  // t2 — the dry path — that has to wait for it.
  const [t1Pan, t2Pan] = panners(ctx);
  const [t1Comp, t2Comp] = comps(ctx);
  assert.deepEqual(t1Pan.outputs, [t1Comp], 'the panner feeds the comp delay');
  assert.deepEqual(t1Comp.outputs, [busIn], 'and the COMP lands on the bus input, not on the master');
  assert.deepEqual(t2Pan.outputs, [t2Comp]);
  assert.deepEqual(t2Comp.outputs, [masterBus], 't2 lands on the master');
  assert.deepEqual(busOut.outputs, [masterBus], 'and the bus lands on the master');

  // topoOrder puts every source before the node that sums it.
  const placed = wireLog.filter((w) => w === `${t1Comp.kind}->${busIn.kind}` || w === `${busOut.kind}->${masterBus.kind}`);
  assert.deepEqual(
    placed, [`${t1Comp.kind}->${busIn.kind}`, `${busOut.kind}->${masterBus.kind}`],
    'the bus is placed after the track that feeds it',
  );
  assert.ok(
    h.chain.calls.every((c) => c.disposed === 1),
    'every chain — the bus rack included — is disposed after the render',
  );
}

async function busFxOnlyUnderIncludeFx(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', fxChain: [compressor('b-fx')] })],
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const ctx = h.ctxes[0];
  assert.equal(h.chain.calls.length, 0, 'includeFx = false builds no rack, on a bus either');
  const [, busIn, busGain] = ctx.created;
  assert.deepEqual(busIn.outputs, [busGain], 'the bus input feeds the fader directly');
}

async function busMixOnlyUnderIncludeTrackMix(): Promise<void> {
  const buses = [bus({ id: 'b1', volume: 0.25, mute: true })];
  const on = harness({
    tracks: [track({ id: 't1' })], clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(), buses,
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), on.deps);
  assert.equal(on.ctxes[0].created[2].gain.value, 0.25, 'the bus fader carries the stored volume');
  assert.equal(
    on.ctxes[0].created[3].gain.value, 0,
    'and a muted bus is muted on the first sample, not on the first live push',
  );

  const off = harness({
    tracks: [track({ id: 't1' })], clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(), buses,
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false, includeTrackMix: false }), off.deps);
  const offCtx = off.ctxes[0];
  assert.equal(offCtx.created[2].gain.value, 1, 'includeTrackMix = false leaves the bus fader at unity');
  assert.equal(offCtx.created[3].gain.value, 1, 'and does not honour its mute');

  // With no track mix there is no panner, so the strip's tail is an explicit
  // unity gain built FOR the graph to place. A regression to the old
  // `tail = panner ?? masterBus` would leave that gain as the master bus
  // itself, and the pass would then wire the MASTER into a bus input — audible
  // nonsense that every assertion above still passes through.
  assert.equal(panners(offCtx).length, 0, 'no track mix, no panner');
  const [masterBus, busIn] = offCtx.created;
  const tailGain = offCtx.created[6];
  assert.notEqual(tailGain, masterBus, 'the tail is a node of its own, not the master bus');
  assert.deepEqual(offCtx.created[5].outputs, [tailGain], 'the fader feeds the tail');
  assert.deepEqual(tailGain.outputs, [busIn], 'and the tail lands on the BUS input, as the graph says');
  assert.deepEqual(masterBus.outputs, [offCtx.destination], 'the master bus feeds only the destination');
}

/* ── 2. Sends: one gain node each, tapped off the main output ─────────────── */

async function eachSendGetsItsOwnGainNode(): Promise<void> {
  const added = addSend(graphWithOneBus(), 't2', 'b1', 0.25);
  assert.ok(added.ok);
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: added.graph as RoutingGraph,
    buses: [bus({ id: 'b1' })],
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const ctx = h.ctxes[0];
  const [masterBus, busIn] = ctx.created;
  const t2Pan = panners(ctx)[1];

  assert.equal(t2Pan.outputs.length, 2, 'the send TAPS the main output — it does not replace it');
  assert.equal(t2Pan.outputs[0], masterBus, 'the main path still reaches the master');
  const sendGain = t2Pan.outputs[1];
  assert.equal(sendGain.gain.value, 0.25, 'the send gain opens at the send amount');
  assert.deepEqual(sendGain.outputs, [busIn], 'and feeds the target bus input');
}

/* ── 3. A malformed graph degrades to every strip -> master ───────────────── */

/** `b1 -> b2 -> b1`, with a track pointed into the loop. No mutator can build
 *  it (`wouldCycle` refuses it), but a `.tasmo` or a hand-edited autosave
 *  manifest reaches the renderer without a mutator having vetted it — exactly
 *  as it reaches the live mixer. */
function cyclicGraph(): RoutingGraph {
  return {
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
}

async function aCyclicGraphFallsBackToTheMasterNeverToSilence(): Promise<void> {
  const g = cyclicGraph();
  const h = harness({
    // t2 is playing — it has a strip — but the damaged graph never named it.
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: g,
    buses: [bus({ id: 'b1' }), bus({ id: 'b2' })],
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const ctx = h.ctxes[0];
  const masterBus = ctx.created[0];
  const b1Out = ctx.created[4];
  const b2Out = ctx.created[8];
  const [t1Pan, t2Pan] = panners(ctx);

  assert.deepEqual(t1Pan.outputs, [masterBus], 'the track is audible on the master');
  assert.deepEqual(
    t2Pan.outputs, [masterBus],
    'including the track the damaged graph forgot — liveIds, not the file, decides',
  );
  assert.deepEqual(b1Out.outputs, [masterBus], 'so is every bus');
  assert.deepEqual(b2Out.outputs, [masterBus]);
  assert.equal(
    gains(ctx).length, 1 + 4 + 4 + 2,
    'and no send gain is allocated — the fallback is the plain pre-routing mix',
  );
}

/* ── 4. The scopes that are pre-routing by definition ─────────────────────── */

async function aStemIgnoresTheGraph(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', fxChain: [compressor('b-fx')] })],
  });
  await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeTrackMix: false, includeFx: false }),
    h.deps,
  );
  const ctx = h.ctxes[0];
  assert.deepEqual(
    ctx.created.map((n) => n.kind.replace(/\d+$/, '')), ['gain', 'gain'],
    'a stem is the track straight to the master bus: no bus strip, no send, no panner',
  );
  const [masterBus, tGain] = ctx.created;
  assert.deepEqual(tGain.outputs, [masterBus]);
  assert.deepEqual(masterBus.outputs, [ctx.destination]);
}

async function aSelectionIgnoresTheGraph(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1' })],
  });
  await renderBounce(
    request({ kind: 'selection', clipIds: ['c1'] }, { includeFx: false }),
    h.deps,
  );
  const ctx = h.ctxes[0];
  assert.equal(
    gains(ctx).length, 2,
    'the selection scope builds the master bus and the per-clip mix gain, and no bus strip',
  );
}

async function noRoutingIsTheFlatPreBatch6Render(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5 })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const ctx = h.ctxes[0];
  assert.deepEqual(
    ctx.created.map((n) => n.kind.replace(/\d+$/, '')), ['gain', 'gain', 'pan'],
    'absent routing: master bus, one fader, one panner — nothing extra is inserted',
  );
  assert.deepEqual(ctx.created[2].outputs, [ctx.created[0]], 'and the panner still feeds the master bus');

  // With no track mix there is no panner, and a MASTER strip still gets a tail
  // node of its own: it is what a comp delay splices onto, and a strip whose
  // tail were the master bus itself could not be compensated at all (it is
  // already inside the sum). A unity gain is exact, so the audio is the same
  // one node later. The two pre-routing scopes keep the old shape — see
  // `aStemIgnoresTheGraph`, which still asserts two nodes and no third.
  const bare = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  await renderBounce(
    request({ kind: 'master' }, { includeFx: false, includeTrackMix: false }), bare.deps,
  );
  const bareCtx = bare.ctxes[0];
  const [masterBus, tGain, tailGain] = bareCtx.created;
  assert.deepEqual(
    bareCtx.created.map((n) => n.kind.replace(/\d+$/, '')), ['gain', 'gain', 'gain'],
    'master bus, fader, and the strip tail',
  );
  assert.deepEqual(tGain.outputs, [tailGain], 'the fader feeds the tail');
  assert.deepEqual(tailGain.outputs, [masterBus], 'and the tail feeds the master bus');
}

/* ── 5. trimLeadingSec, on its own ────────────────────────────────────────── */

function theTrimIsAPureShiftThatKeepsTheLength(): void {
  const buf = rampBuffer(10, 100, 2) as unknown as AudioBuffer;
  const out = trimLeadingSec(buf, 0.03);
  assert.equal(out.length, 10, 'the length is preserved');
  assert.equal(out.numberOfChannels, 2);
  assert.equal(out.sampleRate, 100);
  assert.equal(out.duration, 0.1);
  assert.deepEqual(
    [...out.getChannelData(0)], [3, 4, 5, 6, 7, 8, 9, 0, 0, 0],
    'the first three samples are gone and the tail is zero-padded',
  );
  assert.deepEqual([...buf.getChannelData(0)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'the input is untouched');
  assert.equal(trimLeadingSec(buf, 0), buf, 'a zero trim hands back the very same buffer');
  assert.equal(trimLeadingSec(buf, -1), buf, 'and so does a negative one');
  assert.deepEqual(
    [...trimLeadingSec(buf, 1).getChannelData(1)], new Array(10).fill(0),
    'a trim past the end is silence, not a shorter buffer',
  );
}

/* ── 6. The render trim, end to end ───────────────────────────────────────── */

/** What `startRendering` handed back, after whatever trim `renderBounce` applied.
 *  The fake render is a ramp, so this IS the number of samples taken off. */
const firstSample = (out: AudioBuffer): number => out.getChannelData(0)[0];

/** And the LAST sample, which says what the tail is made of: the ramp carries
 *  on past the window when the render was padded, and reads 0 when the trim had
 *  to zero-fill a gap the context was too short to render. */
const lastSample = (out: AudioBuffer): number => out.getChannelData(0)[out.length - 1];

/** The window every master render here declares: the 30 s floor of
 *  `renderExtentSec`, in samples. The context may be LONGER (see the padding
 *  pin below); the file is always this. */
const MASTER_LEN = 30 * SR;

async function aCompressorChainTrimsItsDeclaredSixMilliseconds(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(
    firstSample(out), 6,
    'the slowest chain declares 6 ms, which at 1 kHz is 6 samples off the front',
  );
  assert.equal(out.length, MASTER_LEN, 'and the file is the length the request asked for');
}

/**
 * THE RENDER IS LONGER THAN THE FILE, by exactly the latency it trims.
 *
 * Every track sits `maxSec` late in the raw render — its own chain plus the
 * comp that makes up the difference — so a context sized to the window stops
 * `maxSec` before the end of the music and the trim then zero-fills what was
 * never rendered. On a project past the 30 s floor, where the window ends at
 * the last clip, that is the last 6 ms of the audio on EVERY track (before the
 * comps, only on the slowest one). So the context runs long and the file is cut
 * back to the window afterwards.
 *
 * Read off the ramp: sample i of the render is i, so the last sample of a
 * correctly padded file is `MASTER_LEN - 1 + 6` — the six samples that only
 * exist because the context was six samples longer. A zero there is the bug.
 */
async function theContextIsPaddedByTheLatencyItWillTrim(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 'tWet', fxChain: [compressor('e1')] }), track({ id: 'tDry' })],
    clips: [clip({ id: 'c1', trackId: 'tWet' }), clip({ id: 'c2', trackId: 'tDry' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(h.ctxes[0].length, MASTER_LEN + 6, 'the context is rendered 6 ms past the window');
  assert.equal(out.length, MASTER_LEN, 'and the file is still exactly the window');
  assert.equal(
    lastSample(out), MASTER_LEN - 1 + 6,
    'the file ends on audio the padding rendered — a dry track beside a compressed one '
      + 'keeps the last 6 ms that its comp delay pushed past the end of the window',
  );

  // No latency, no padding: the context is the window and the buffer handed
  // back is the very object the render produced.
  const flat = harness({
    tracks: [track({ id: 't1' })], clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  const flatOut = await renderBounce(request({ kind: 'master' }), flat.deps);
  assert.equal(flat.ctxes[0].length, MASTER_LEN, 'nothing declared, nothing padded');
  assert.equal(lastSample(flatOut), MASTER_LEN - 1, 'and the tail is where it always was');

  // A STEM IS NOT PADDED, deliberately. It carries no comp — it is one path —
  // but its own rack still prints it late and the trim still takes that off, so
  // its last 6 ms falls off the end exactly as it did before T18. That is T14's
  // behaviour and the A/B harness pins it: the legacy body the stem is compared
  // against truncates in the same place, so padding here would put case C over
  // the gate. Changing it is a call of its own, and this pins the current one so
  // that the change is deliberate when it comes.
  const stem = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 4 })],
  });
  const stemOut = await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeTrackMix: false }), stem.deps,
  );
  assert.equal(stem.ctxes[0].length, 4 * SR, 'the stem context is its extent, unpadded');
  assert.equal(stemOut.length, 4 * SR, 'so is the stem file');
  assert.equal(
    lastSample(stemOut), 0,
    'and its last 6 ms is the zero-fill T14 left there — unchanged by the comps',
  );
}

async function noFxMeansNoTrim(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  const out = await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  assert.equal(firstSample(out), 0, 'no rack was built, so nothing declared latency and nothing is trimmed');
}

async function aBypassedEntryDeclaresNothing(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [{ ...compressor('e1'), enabled: false }] })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(firstSample(out), 0, 'buildEffectChain routes a bypassed entry around, so it lags nothing');
}

async function aStemTrimsOnlyItsOwnChain(): Promise<void> {
  const tracks = [track({ id: 't1', fxChain: [compressor('e1')] }), track({ id: 't2' })];
  const dry = harness({ tracks, clips: [clip({ id: 'c2', trackId: 't2' })] });
  const dryOut = await renderBounce(
    request({ kind: 'track', trackId: 't2' }, { includeTrackMix: false }), dry.deps,
  );
  assert.equal(firstSample(dryOut), 0, "a dry stem is not trimmed by another track's compressor");

  const wet = harness({ tracks, clips: [clip({ id: 'c1', trackId: 't1' })] });
  const wetOut = await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeTrackMix: false }), wet.deps,
  );
  assert.equal(firstSample(wetOut), 6, 'and the compressed stem is trimmed by its own 6 ms');
}

async function aBusChainLagsEveryTrackThroughIt(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', fxChain: [compressor('b-fx')] })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(
    firstSample(out), 6,
    'the bus rack is downstream of t1, so t1 lags 6 ms with an empty chain of its own',
  );

  // The same project with the graph taken away: nothing is downstream of
  // anything, so the bus rack is in no path and there is nothing to trim.
  const flat = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  assert.equal(
    firstSample(await renderBounce(request({ kind: 'master' }), flat.deps)), 0,
    'and a routing-less render of it trims nothing',
  );
}

async function theTrimDegradesWithTheGraphItCouldNotOrder(): Promise<void> {
  // THE DESTRUCTIVE CASE. A graph that will not order is rendered flat — every
  // strip to the master, no bus rack in ANY path — so nothing downstream of a
  // track declares anything and the trim must be zero. Handed the cycle
  // instead, the latency walk follows `b1 -> b2 -> b1 -> …` until it runs out
  // of hops and bills each bus's compressor once per hop; the trim would then
  // cut tens of milliseconds off the head of a file that never had them.
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: cyclicGraph(),
    buses: [
      bus({ id: 'b1', fxChain: [compressor('b1-fx')] }),
      bus({ id: 'b2', fxChain: [compressor('b2-fx')] }),
    ],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(
    firstSample(out), 0,
    'a graph that could not be ordered renders no bus in any path, so it trims nothing',
  );

  // And the same two compressed buses in a graph that DOES order are counted
  // exactly once — so the gate above is a gate, not a silenced feature.
  const sound = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', fxChain: [compressor('b1-fx')] })],
  });
  assert.equal(
    firstSample(await renderBounce(request({ kind: 'master' }), sound.deps)), 6,
    'a valid graph with one compressed bus still trims its 6 ms',
  );
}

async function aMutedTracksChainIsNotInTheFile(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', mute: true, fxChain: [compressor('e1')] }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(
    firstSample(out), 0,
    'a muted track builds no rack, so its declaration is not in the file and must not move it',
  );
  assert.equal(comps(h.ctxes[0]).length, 0, 'and the one surviving strip has nothing to meet');
}

/* ── 6b. Per-track compensation delays (T18) ──────────────────────────────── */

/** `latency + comp == maxSec` for every strip, over the SAME pure math
 *  `renderBounce` writes its comps from. Returns the rows so a caller can go on
 *  to match them against the nodes the graph actually holds. */
function alignedRows(
  tracks: EditorTrack[], routing?: { graph: RoutingGraph; buses: EditorBus[] },
): TrackCompRow[] {
  const rows = trackCompDelays(tracks, undefined, SR, routing);
  const maxSec = Math.max(0, ...rows.map((r) => r.latencySec));
  for (const r of rows) {
    assert.equal(
      r.latencySec + r.compSec, maxSec,
      `${r.trackId}: latency + comp == maxSec, which is what makes ONE trim land every track`,
    );
  }
  return rows;
}

/**
 * THE TICKET. Two tracks, one compressed and one dry, and NO routing — comps do
 * not need a graph, only a bus path does. The dry strip holds the compressor's
 * 6 ms so both tracks reach the master together, and the one trim then lands
 * both. Before, it landed the compressed one and printed the dry one 6 ms early.
 */
async function everyStripIsCompensatedNotJustTheSlowest(): Promise<void> {
  const tracks = [track({ id: 'tWet', fxChain: [compressor('e1')] }), track({ id: 'tDry' })];
  const h = harness({
    tracks,
    clips: [clip({ id: 'c1', trackId: 'tWet' }), clip({ id: 'c2', trackId: 'tDry' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];

  const [wetComp, dryComp] = comps(ctx);
  assert.equal(comps(ctx).length, 2, 'one comp delay per strip, the slowest path included');
  assert.equal(wetComp.delayTime.value, 0, 'the compressed track IS the slowest path: it waits for nobody');
  assert.equal(dryComp.delayTime.value, 0.006, 'and the dry track holds the 6 ms the compressor declared');

  const rows = alignedRows(tracks);
  assert.deepEqual(
    rows.map((r) => [r.latencySec, r.compSec]), [[0.006, 0], [0, 0.006]],
    'which is exactly what the live mixer would hold for the same two tracks',
  );

  // Both comps carry the bounce's channel count EXPLICITLY. On the default
  // `'max'` a `DelayNode`'s count follows an input that goes inactive when the
  // clip sources run out, and Chrome loses whatever is still inside the delay
  // line — measured at a third of full scale over the last 247 samples of a
  // clip, through this very graph. See the splice in `renderCore.ts`.
  for (const comp of [wetComp, dryComp]) {
    assert.equal(comp.channelCount, 2, 'the comp is pinned to the bounce\'s stereo');
    assert.equal(comp.channelCountMode, 'explicit', 'and explicitly, so an idle input cannot move it');
  }

  // The splice is the live one's: panner -> comp -> the summing bus.
  const [masterBus] = ctx.created;
  const [wetPan, dryPan] = panners(ctx);
  assert.deepEqual(wetPan.outputs, [wetComp], 'the comp sits after the panner');
  assert.deepEqual(wetComp.outputs, [masterBus], 'and it, not the panner, feeds the master bus');
  assert.deepEqual(dryPan.outputs, [dryComp]);
  assert.deepEqual(dryComp.outputs, [masterBus]);

  assert.equal(
    firstSample(out), 6,
    'the file still moves by the slowest chain — but now every track is AT the slowest chain, '
      + 'so the trim lands all of them instead of only tWet',
  );
}

/**
 * THE COMP IS A WHOLE NUMBER OF SAMPLES, which this suite's 1 kHz rate cannot
 * show: 6 ms is exactly 6 samples there and the rounding is a no-op. At 44.1 kHz
 * it is 264.6, and the rounding is the whole point — `trimLeadingSec` takes a
 * whole 265 off the front, and a `DelayNode` asked for 264.6 would interpolate
 * between two samples, i.e. resample the track to place it 0.4 of a sample
 * better than the trim can take back. Whole samples move the audio; fractional
 * ones filter it.
 */
async function theCompHoldsAWholeNumberOfSamples(): Promise<void> {
  const RATE = 44100;
  const h = harness({
    tracks: [track({ id: 'tWet', fxChain: [compressor('e1')] }), track({ id: 'tDry' })],
    clips: [clip({ id: 'c1', trackId: 'tWet' }), clip({ id: 'c2', trackId: 'tDry' })],
  });
  await renderBounce(request({ kind: 'master' }, { sampleRate: RATE }), h.deps);
  const [, dryComp] = comps(h.ctxes[0]);
  assert.equal(0.006 * RATE, 264.6, 'the declaration is NOT a whole number of samples here');
  assert.equal(
    dryComp.delayTime.value, 265 / RATE,
    'so the comp holds the rounded 265 samples — the same 265 the trim takes off the front',
  );
  assert.notEqual(dryComp.delayTime.value, 0.006, 'which is not the raw declaration');
  assert.equal(
    Math.round(dryComp.delayTime.value * RATE), 265,
    'and it is a whole number of samples at the rate the file is at',
  );
}

/** Nothing to align, nothing inserted: a render whose strips all declare the
 *  same thing is the graph it has always been, node for node. This is what
 *  keeps a project that declares no latency bit-identical to its old bounce —
 *  and what `renderCore.test.ts`'s node-for-node pins are still counting on. */
async function nothingToAlignInsertsNoNode(): Promise<void> {
  const alone = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
  });
  await renderBounce(request({ kind: 'master' }), alone.deps);
  assert.equal(comps(alone.ctxes[0]).length, 0, 'one track has nobody to meet');

  const bothWet = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] }), track({ id: 't2', fxChain: [compressor('e2')] })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  const out = await renderBounce(request({ kind: 'master' }), bothWet.deps);
  assert.equal(
    comps(bothWet.ctxes[0]).length, 0,
    'and two equally slow tracks are already aligned — the gate is the alignment, not the track count',
  );
  assert.equal(firstSample(out), 6, 'the trim still moves the pair off the front together');
}

/** A bus's rack lags every track routed through it and nothing else, so it is
 *  the tracks going STRAIGHT to the master that have to wait for it. */
async function aBusChainIsCompensatedOnTheTracksThatBypassIt(): Promise<void> {
  const tracks = [track({ id: 't1' }), track({ id: 't2' })];
  const buses = [bus({ id: 'b1', fxChain: [compressor('b-fx')] })];
  const graph = graphWithOneBus();
  const h = harness({
    tracks,
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: graph,
    buses,
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  const [t1Comp, t2Comp] = comps(h.ctxes[0]);

  const rows = alignedRows(tracks, { graph, buses });
  assert.deepEqual(
    rows.map((r) => r.latencySec), [0.006, 0],
    't1 goes through the compressed bus and carries its 6 ms with an empty chain of its own',
  );
  assert.equal(t1Comp.delayTime.value, 0, 't1 is the slowest path');
  assert.equal(t2Comp.delayTime.value, 0.006, 'so t2, which bypasses the bus, waits for it');
  assert.equal(firstSample(out), 6, 'and the file is trimmed by the bus rack both of them now sit behind');
}

/** THE DESTRUCTIVE CASE, again. A graph that will not order renders with no bus
 *  in any path, so the comps must be computed the same way the trim is — over
 *  each track's OWN chain. Handed the cycle instead, the latency walk bills each
 *  bus's compressor once per hop, and the comps would hold tens of milliseconds
 *  that nothing in the file declares. */
async function theCompsDegradeWithTheGraphTheyCouldNotOrder(): Promise<void> {
  const tracks = [track({ id: 't1', fxChain: [compressor('t1-fx')] }), track({ id: 't2' })];
  const h = harness({
    tracks,
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
    routing: cyclicGraph(),
    buses: [
      bus({ id: 'b1', fxChain: [compressor('b1-fx')] }),
      bus({ id: 'b2', fxChain: [compressor('b2-fx')] }),
    ],
  });
  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  const [t1Comp, t2Comp] = comps(h.ctxes[0]);

  assert.equal(t1Comp.delayTime.value, 0, 't1 declares the only latency in the rendered file');
  assert.equal(
    t2Comp.delayTime.value, 0.006,
    "so t2 holds t1's own 6 ms and NOT a cycle's worth of bus racks that are in no path",
  );
  assert.equal(firstSample(out), 6, 'and the trim degrades with them, to the same 6 ms');

  // Same comps computed over the routing the degraded render actually has:
  // none. The invariant holds on the degraded path too.
  alignedRows(tracks);
}

/** A stem is ONE path: its own chain is the slowest and the fastest, so there
 *  is nothing to hold and no node to hold it. The stem scope is untouched. */
async function aStemBuildsNoCompDelay(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  const out = await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeTrackMix: false }), h.deps,
  );
  const ctx = h.ctxes[0];
  assert.equal(comps(ctx).length, 0, 'no comp delay is built for a stem');
  assert.deepEqual(
    ctx.created.map((n) => n.kind.replace(/\d+$/, '')), ['gain', 'gain'],
    'the stem graph is the master bus and the track fader, exactly as before',
  );
  assert.equal(firstSample(out), 6, 'and it is still trimmed by its own chain');
}

/** A selection is pre-routing by definition and takes no comps either — which
 *  costs it nothing today, because the one call site renders it without FX and
 *  so declares no latency to compensate for in the first place. */
async function aSelectionBuildsNoCompDelay(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('e1')] }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' }), clip({ id: 'c2', trackId: 't2' })],
  });
  await renderBounce(request({ kind: 'selection', clipIds: ['c1', 'c2'] }), h.deps);
  assert.equal(comps(h.ctxes[0]).length, 0, 'no comp delay is built for a selection');
}

/* ── 7. Chunk safety sees a bus rack ──────────────────────────────────────── */

function chunkSafetyCountsBusChains(): void {
  // `compressor` is `chunkUnsafe` (its envelope follower carries state across a
  // boundary). On a BUS it is just as unsafe, and since the master bounce now
  // builds bus racks the predicate has to look at them.
  const req = request({ kind: 'master' });
  assert.equal(bounceIsChunkSafe(req, [{ id: 't1' }], []).safe, true, 'nothing unsafe anywhere');

  const busted = bounceIsChunkSafe(req, [{ id: 't1' }], [], undefined, [
    { id: 'b1', fxChain: [compressor('b-fx')] },
  ]);
  assert.equal(busted.safe, false, 'a compressor on a BUS makes the master bounce unchunkable');
  assert.ok(busted.reasons.some((r) => r.includes('b-fx')), 'and the offending entry is named');

  const stem = bounceIsChunkSafe(
    request({ kind: 'track', trackId: 't1' }), [{ id: 't1' }], [], undefined,
    [{ id: 'b1', fxChain: [compressor('b-fx')] }],
  );
  assert.equal(stem.safe, true, 'a stem renders no bus rack, so a bus cannot make it unsafe');
}

/* ── run ──────────────────────────────────────────────────────────────────── */

/* ── The hall responses load before any rack is built ────────────────────── */

// A Reverb on a measured hall (lib/hallIrs) finds its response decoded only if
// the bounce loads it BEFORE the racks are built: the factory reads the cache
// once, at build. The shared hall of a symphony template is a BUS, so the bus
// racks are among the chains handed over.
async function theHallResponsesLoadBeforeTheRacksAreBuilt(): Promise<void> {
  const hall: ChainEntry = { id: 'hall-fx', effect: 'reverb', enabled: true, params: { hall: 1, position: 0, wet: 1 } };
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('t-fx')] }), track({ id: 't2' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    routing: graphWithOneBus(),
    buses: [bus({ id: 'b1', fxChain: [hall] })],
  });
  const order: string[] = [];
  let handed: ReadonlyArray<readonly ChainEntry[] | undefined> = [];
  h.deps.ensureHallIrs = async (_ctx, chains) => {
    handed = chains;
    order.push('ensure');
  };
  const build = h.deps.buildChain;
  h.deps.buildChain = ((...args: Parameters<typeof build>) => {
    order.push('build');
    return build(...args);
  }) as typeof build;
  await renderBounce(request({ kind: 'master' }), h.deps);
  assert.equal(order[0], 'ensure', 'the responses load before the first rack');
  assert.equal(order.filter((o) => o === 'ensure').length, 1, 'once per bounce');
  assert.ok(handed.some((c) => c?.includes(hall)), 'the bus rack is among the chains');
  assert.ok(handed.some((c) => c?.some((e) => e.id === 't-fx')), 'and so is every track rack');

  // Without FX nothing is built, so nothing loads.
  const noFx = harness({ tracks: [track({ id: 't1' })], clips: [clip({ id: 'c1', trackId: 't1' })], buses: [bus({ id: 'b1', fxChain: [hall] })], routing: graphWithOneBus() });
  let called = 0;
  noFx.deps.ensureHallIrs = async () => { called += 1; };
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), noFx.deps);
  assert.equal(called, 0, 'a bounce without FX loads no response');
}

async function main(): Promise<void> {
  await aBusStripIsBuiltAndPlacedByTheGraph();
  await busFxOnlyUnderIncludeFx();
  await busMixOnlyUnderIncludeTrackMix();
  await eachSendGetsItsOwnGainNode();
  await aCyclicGraphFallsBackToTheMasterNeverToSilence();
  await aStemIgnoresTheGraph();
  await aSelectionIgnoresTheGraph();
  await noRoutingIsTheFlatPreBatch6Render();
  theTrimIsAPureShiftThatKeepsTheLength();
  await aCompressorChainTrimsItsDeclaredSixMilliseconds();
  await theContextIsPaddedByTheLatencyItWillTrim();
  await noFxMeansNoTrim();
  await aBypassedEntryDeclaresNothing();
  await aStemTrimsOnlyItsOwnChain();
  await aBusChainLagsEveryTrackThroughIt();
  await theTrimDegradesWithTheGraphItCouldNotOrder();
  await aMutedTracksChainIsNotInTheFile();
  await everyStripIsCompensatedNotJustTheSlowest();
  await theCompHoldsAWholeNumberOfSamples();
  await nothingToAlignInsertsNoNode();
  await aBusChainIsCompensatedOnTheTracksThatBypassIt();
  await theCompsDegradeWithTheGraphTheyCouldNotOrder();
  await aStemBuildsNoCompDelay();
  await aSelectionBuildsNoCompDelay();
  chunkSafetyCountsBusChains();
  await theHallResponsesLoadBeforeTheRacksAreBuilt();
  console.log('renderCore.routing: ok');
}

await main();
