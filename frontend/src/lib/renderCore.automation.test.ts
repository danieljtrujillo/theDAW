// renderCore — OFFLINE AUTOMATION ALIGNMENT (T19b, plan §3.8 meets §3.9).
//
// T19 gave the LIVE mixer a per-param lead: a pan lane's envelope is scheduled
// `chainLatencySec(chain)` late because the panner sits after the inserts, and
// an FX lane is read at `t - prefix(entry)` because the audio arriving at
// effect k entered the chain the sum of the effects ahead of it ago. The
// offline bounce still scheduled pan at the timeline time and stepped every FX
// lane at the raw quantum, so a mix that PREVIEWED aligned PRINTED 6 ms out on
// exactly those two params. This suite is the offline half of T19's pins.
//
// Two rules, and this file is the pin on each:
//
//   1. PAN leads by the track's OWN insert chain; VOLUME does not lead at all.
//      The fader IS the chain input (`gain -> [fx] -> panner`), so a volume
//      breakpoint at timeline 1.0 stays at 1.0 while a pan breakpoint at the
//      same moment is written at 1.006 through a 6 ms chain. The number is the
//      chain that was actually BUILT: under `includeFx: false` there is no rack
//      in the graph, so there is nothing to lead.
//   2. An FX lane is READ BACK by everything ahead of its entry, and the step
//      times move FORWARD by the same figure. Both halves are needed and this
//      suite asserts both: an un-shifted union would suspend at `p.t` while the
//      sampler read `p.t - prefix`, so the breakpoint's own value would never be
//      written — it would be missed until the next breakpoint.
//
// LIVE/OFFLINE AGREEMENT is asserted directly rather than described: the two
// functions `state/liveMixer.ts` drives the live engine with
// (`laneEnvelopeEvents`'s `delaySec` and `fxLaneSampleTime`) are called here
// with the live numbers and compared against what the render actually wrote.
// The live counterparts are `liveMixer.envelope.test.ts`'s
// `delayShiftsEveryFutureEventButNotTheAnchor` (section 8) and
// `theFxFrameReadsTheLaneWhereTheArrivingAudioEnteredTheChain` (section 10).
//
// Fake-context pattern is `renderCore.test.ts`'s: params that record their
// calls, nodes that record their connections, a context that hands them out and
// lets the `suspend` callbacks run. `scheduleSources` is a no-op stub — the
// per-clip wiring is that file's subject, the automation is this one's.
//
// The latency figures are the REAL registry's: `rackEffects` gives `compressor`
// the Web Audio spec's 6 ms look-ahead and `reverb` no declaration at all, so
// `[compressor, reverb]` is a chain whose SECOND entry has 6 ms ahead of it.
//
// Run: npx tsx src/lib/renderCore.automation.test.ts
import assert from 'node:assert/strict';

import type { AudioClip, AutomationLane, EditorBus, EditorTrack } from '../state/editorStore.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';
import { chainLatencySec, type ChainHandle } from './rackEffects.ts';
import {
  entryPrefixLatencies, fxLaneSampleTime, laneEnvelopeEvents, trackCompDelays,
} from '../state/liveMixer.ts';
import {
  addBus, emptyGraph, ensureTrackNode, setOutput, type RoutingGraph,
} from '../state/routingGraph.ts';
import {
  renderBounce, type BounceRequest, type BounceScope, type RenderDeps,
} from './renderCore.ts';

/* ── Stand-ins ────────────────────────────────────────────────────────────── */

type ParamCall = [string, number, number];

interface FakeParam {
  value: number;
  calls: ParamCall[];
  setValueAtTime(v: number, t: number): FakeParam;
  linearRampToValueAtTime(v: number, t: number): FakeParam;
  setValueCurveAtTime(values: Float32Array, start: number, duration: number): FakeParam;
}

const fakeParam = (): FakeParam => {
  const calls: ParamCall[] = [];
  const p: FakeParam = {
    value: 1,
    calls,
    setValueAtTime(v, t) { calls.push(['setValueAtTime', v, t]); return p; },
    linearRampToValueAtTime(v, t) { calls.push(['linearRampToValueAtTime', v, t]); return p; },
    setValueCurveAtTime(_values, start, duration) {
      calls.push(['setValueCurveAtTime', start, duration]);
      return p;
    },
  };
  return p;
};

interface FakeNode {
  kind: string;
  gain: FakeParam;
  pan: FakeParam;
  delayTime: { value: number };
  outputs: FakeNode[];
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
}

const fakeNode = (kind: string): FakeNode => {
  const node: FakeNode = {
    kind,
    gain: fakeParam(),
    pan: fakeParam(),
    delayTime: { value: 0 },
    outputs: [],
    connect(to) { node.outputs.push(to); return to; },
    disconnect() { node.outputs.length = 0; },
  };
  return node;
};

/** Enough of an AudioBuffer for `trimLeadingSec` to shift and for `encodeWav`
 *  never to see — the render's SAMPLES are the A/B harness's subject, not this
 *  suite's, which only ever reads the param calls and the `updateParams` log. */
const fakeBuffer = (length: number, sampleRate: number, channels: number) => ({
  duration: length / sampleRate,
  sampleRate,
  numberOfChannels: channels,
  length,
  getChannelData: () => new Float32Array(length),
});

interface FakeCtx {
  sampleRate: number;
  length: number;
  destination: FakeNode;
  created: FakeNode[];
  suspends: number[];
  resumes: number;
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
    suspends: [],
    resumes: 0,
    createGain() { const n = fakeNode('gain'); created.push(n); return n; },
    createStereoPanner() { const n = fakeNode('panner'); created.push(n); return n; },
    createBufferSource() { const n = fakeNode('source'); created.push(n); return n; },
    suspend(t: number) { ctx.suspends.push(t); return Promise.resolve(); },
    resume() { ctx.resumes += 1; return Promise.resolve(); },
    async startRendering() {
      // Let the suspend callbacks the core registered run, as a real offline
      // render would when it reaches each suspend point.
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      return fakeBuffer(length, sampleRate, channels);
    },
  };
  return ctx;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

let nextBlob = 0;
const clip = (over: Partial<AudioClip> & { id: string; trackId: string }): AudioClip => ({
  label: over.id,
  audioBlob: new Blob([`${nextBlob++}`]),
  mimeType: 'audio/wav',
  sourceDuration: 30,
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

const entry = (id: string, effect: string, params: Record<string, number> = {}): ChainEntry => ({
  id, effect, enabled: true, params,
});

const bus = (over: Partial<EditorBus> & { id: string }): EditorBus => ({
  name: over.id,
  fxChain: [],
  volume: 1,
  mute: false,
  ...over,
});

/** The panners, in the order the strips were built (= track order). Found by
 *  KIND rather than by index: a project whose tracks declare different
 *  latencies also builds compensation delays, which land in the same list. */
const panners = (ctx: FakeCtx): FakeNode[] => ctx.created.filter((n) => n.kind === 'panner');

interface ChainCall {
  entries: ChainEntry[];
  updates: { entryId: string; params: Record<string, number> }[];
}

/** A `buildEffectChain` stand-in: records the call and the param pushes, and
 *  wires input straight to output (what the real one does for a chain with
 *  nothing renderable in it). The effect NODES are not this suite's subject —
 *  what the stepping loop pushes into them is. */
const buildChainSpy = () => {
  const calls: ChainCall[] = [];
  const build = (
    _ctx: unknown, input: unknown, output: unknown, entries: ChainEntry[],
  ): ChainHandle => {
    const call: ChainCall = { entries, updates: [] };
    calls.push(call);
    (input as FakeNode).connect(output as FakeNode);
    return {
      rebuild: () => {},
      updateParams: (entryId: string, params: Record<string, number>) => {
        call.updates.push({ entryId, params });
      },
      instances: () => [],
      inertIds: () => [],
      dispose: () => {},
    } as unknown as ChainHandle;
  };
  return { calls, build: build as unknown as RenderDeps['buildChain'] };
};

interface Harness {
  ctxes: FakeCtx[];
  deps: RenderDeps;
  chain: { calls: ChainCall[] };
}

const harness = (
  over: Partial<Pick<
    RenderDeps, 'clips' | 'tracks' | 'masterFxChain' | 'automationLanes' | 'routing' | 'buses'
  >> = {},
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
      automationLanes: over.automationLanes ?? [],
      routing: over.routing,
      buses: over.buses,
      decode: async () => fakeBuffer(30 * SR, SR, 2) as unknown as AudioBuffer,
      buildChain: chain.build,
      scheduleSources: (() => {}) as unknown as RenderDeps['scheduleSources'],
      makeContext: (channels, length, rate) => {
        const c = fakeCtx(channels, length, rate);
        ctxes.push(c);
        return c as unknown as OfflineAudioContext;
      },
      makeCompDelay: (c) => {
        const n = fakeNode('comp');
        (c as unknown as FakeCtx).created.push(n);
        return n as unknown as DelayNode;
      },
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

/** The render quantum at `SR`: `suspend` can only stop the render on one. */
const Q = 128 / SR;

/** `rackEffects` gives the compressor the Web Audio spec's fixed look-ahead. */
const COMP_SEC = 0.006;

const request = (scope: BounceScope, over: Partial<BounceRequest> = {}): BounceRequest => ({
  scope,
  sampleRate: SR,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: true,
  float32: false,
  ...over,
});

/** Times and lane values are compared with a tolerance: they are sums and
 *  differences of doubles that cannot hold 0.006 exactly. */
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/** The `mix` value pushed at each step, in order, for one entry. */
const mixes = (call: ChainCall, entryId: string): number[] => call.updates
  .filter((u) => u.entryId === entryId)
  .map((u) => u.params.mix);

/* ── 1. Pan leads its chain; volume does not ──────────────────────────────── */

const VOL_POINTS = [{ t: 0, v: 0.2 }, { t: 1, v: 0.9 }];
const PAN_POINTS = [{ t: 0, v: -1 }, { t: 1, v: 1 }];

const mixLanes = (trackId: string): AutomationLane[] => [
  { id: `l-vol-${trackId}`, enabled: true, target: { kind: 'trackVolume', trackId }, points: VOL_POINTS },
  { id: `l-pan-${trackId}`, enabled: true, target: { kind: 'trackPan', trackId }, points: PAN_POINTS },
];

async function panIsWrittenLateByItsOwnChainAndVolumeIsNot(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5, pan: 0.5, fxChain: [entry('c-comp', 'compressor')] })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: mixLanes('t1'),
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const [, tGain, tPan] = h.ctxes[0].created;

  // VOLUME is the chain input. Byte for byte the list it emitted before T19b.
  assert.deepEqual(
    tGain.gain.calls,
    [['setValueAtTime', 0.2, 0], ['linearRampToValueAtTime', 0.9, 1]],
    'a volume breakpoint at timeline 1.0 is written at 1.0 — the fader leads nothing',
  );

  // PAN sits after the 6 ms rack, so its whole envelope moves out by 6 ms —
  // except the anchor, which is the value under the param at the top of the
  // render and cannot be moved anywhere.
  const [panSet, panRamp] = tPan.pan.calls;
  assert.deepEqual(panSet, ['setValueAtTime', -1, 0], 'the anchor stays at the top of the render');
  assert.equal(panRamp[0], 'linearRampToValueAtTime');
  assert.equal(panRamp[1], 1, 'the VALUE is untouched — a delay changes only when it is written');
  assert.ok(close(panRamp[2], 1.006), `the pan breakpoint at 1.0 lands at 1.006: ${panRamp[2]}`);
  assert.equal(tPan.pan.calls.length, 2, 'and nothing else is scheduled');
}

/** The lead is the chain that was actually BUILT. With `includeFx: false` there
 *  is no rack in the graph at all, so the panner is fed straight from the fader
 *  and a pan breakpoint belongs exactly where the clip that carries it is —
 *  the same rule the comp delays and the trim are measured by. */
async function withNoRackInTheGraphPanLeadsNothing(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [entry('c-comp', 'compressor')] })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: mixLanes('t1'),
  });

  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const [, tGain, tPan] = h.ctxes[0].created;

  assert.deepEqual(tGain.gain.calls, [['setValueAtTime', 0.2, 0], ['linearRampToValueAtTime', 0.9, 1]]);
  assert.deepEqual(
    tPan.pan.calls,
    [['setValueAtTime', -1, 0], ['linearRampToValueAtTime', 1, 1]],
    'no rack, no lead: the pan breakpoint at 1.0 is written at 1.0',
  );
}

/* ── 2. An FX lane is read back by everything ahead of its entry ──────────── */
//
// The lane below is the IDENTITY over the render (`v === t` at every point and,
// because the three points are collinear, between them too), so the value that
// reaches `updateParams` IS the time the lane was sampled at, read off directly
// instead of inferred. The middle point at 0.125 s sits one quantum boundary
// below its shifted self, so the same lane steps at a different time depending
// on how much chain is ahead of the entry.

const FX_POINTS = [{ t: 0, v: 0 }, { t: 0.125, v: 0.125 }, { t: 25, v: 25 }];

const fxLane = (trackId: string, entryId: string): AutomationLane => ({
  id: 'l-fx', enabled: true, target: { kind: 'trackFx', trackId, entryId, paramKey: 'mix' },
  points: FX_POINTS,
});

async function aLaneOnTheSecondEntryIsSampledBehindTheStep(): Promise<void> {
  const chain = [entry('c-comp', 'compressor'), entry('r-verb', 'reverb', { mix: 0.3, decay: 2 })];
  assert.deepEqual(
    entryPrefixLatencies(chain, { sampleRate: SR }),
    { 'c-comp': 0, 'r-verb': COMP_SEC },
    'the fixture: 6 ms of compressor sits between the chain input and the reverb',
  );

  const h = harness({
    tracks: [track({ id: 't1', fxChain: chain })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: [fxLane('t1', 'r-verb')],
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const call = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'r-verb'));
  assert.ok(call, 'the track rack was built');

  // STEP TIMES move forward by the prefix before quantising. The breakpoint at
  // 0.125 takes effect at 0.131 and so steps a whole quantum later than it
  // would with nothing ahead of it; the one at t = 0, which the un-shifted
  // union drops as "already covered by the initial state", now enters the
  // render at 0.006 and gets a step of its own. That step is NOT a repeat of
  // the initial state: it reads the lane at `Q - prefix` (0.122 below), a value
  // the un-shifted loop would not have written until its own next breakpoint.
  assert.deepEqual(
    ctx.suspends,
    [Q, 2 * Q, 25.088],
    'each breakpoint steps at ceil((p.t + 0.006) / q) * q',
  );
  assert.equal(ctx.resumes, 3);

  // SAMPLE TIMES are the step times pulled BACK by the same prefix, so the
  // value written is the one the audio arriving at the reverb was drawn for.
  const written = mixes(call, 'r-verb');
  assert.equal(written.length, 4, 'the initial state, then one push per step');
  assert.equal(written[0], 0, 'the top of the render reads the lane at 0, never before it');
  assert.ok(close(written[1], Q - COMP_SEC), `step at ${Q} reads 0.122: ${written[1]}`);
  assert.ok(close(written[2], 2 * Q - COMP_SEC), `step at ${2 * Q} reads 0.25: ${written[2]}`);
  // The LAST breakpoint's own step is the one place the read-back cannot show:
  // `ceil((p.t + prefix) / q) * q - prefix` is never below `p.t`, so it always
  // lands past the end of the lane and `sampleLane` holds the final value.
  assert.equal(written[3], 25, 'past the last breakpoint the lane holds, read back or not');

  // The entry's own static params ride along untouched, as they always did.
  assert.equal(call.updates[0].params.decay, 2);
}

/** The FIRST entry in a chain has nothing ahead of it, so it is exact — which
 *  is why the un-compensated loop was right for the common project and early
 *  for every other one. Same lane, same track, one entry: the step times are
 *  the raw quantised breakpoints and the sampled time IS the step time. */
async function aSingleEntryChainIsSampledAtTheStep(): Promise<void> {
  const chain = [entry('r-verb', 'reverb', { mix: 0.3, decay: 2 })];
  const h = harness({
    tracks: [track({ id: 't1', fxChain: chain })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: [fxLane('t1', 'r-verb')],
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const call = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'r-verb'));
  assert.ok(call);

  assert.deepEqual(ctx.suspends, [Q, 25.088], 'the breakpoint at t = 0 is covered by the initial state');
  const written = mixes(call, 'r-verb');
  assert.deepEqual(
    written.map((v) => Number(v.toFixed(6))),
    // The step at Q is the whole claim, held against the two-entry chain's
    // 0.122 at the very same step time. (25 is the lane holding its last value
    // past its last breakpoint, as it does with a prefix too.)
    [0, Q, 25],
    'no prefix, no read-back: each step samples the lane at its own time',
  );
}

/* ── 2b. A master-rack lane is read back by the master chain ─────────────── */

/** A master lane carries no `trackId` — it is matched by `entryId` alone — and
 *  its prefix comes from the MASTER chain rather than from any track's. Same
 *  claim as section 2, on the other half of `groupFx`. */
const masterFxLane = (entryId: string): AutomationLane => ({
  id: 'l-master-fx', enabled: true, target: { kind: 'masterFx', entryId, paramKey: 'mix' },
  points: FX_POINTS,
});

async function aMasterLaneIsSampledBehindTheMasterChain(): Promise<void> {
  const master = [entry('m-comp', 'compressor'), entry('m-verb', 'reverb', { mix: 0.3, decay: 2 })];
  const h = harness({
    // No track chain and no track lanes, so the master rack is the only target.
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    masterFxChain: master,
    automationLanes: [masterFxLane('m-verb')],
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const call = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'm-verb'));
  assert.ok(call, 'the master rack was built');

  assert.deepEqual(ctx.suspends, [Q, 2 * Q, 25.088], 'the master chain shifts the steps too');
  const written = mixes(call, 'm-verb');
  assert.equal(written[0], 0, 'the initial state clamps to the top of the timeline');
  assert.ok(close(written[1], Q - COMP_SEC), `step at ${Q} reads 0.122: ${written[1]}`);
  assert.ok(close(written[2], 2 * Q - COMP_SEC), `step at ${2 * Q} reads 0.25: ${written[2]}`);
  assert.equal(written[3], 25, 'past the last breakpoint the lane holds');

  // The MASTER RACK'S OWN LAG is a separate, un-taken compensation: this chain's
  // input is the post-comp sum, so the audio reaching `m-verb` is `prefix` PLUS
  // the whole mix's `renderLatencySec` behind. `trimLeadingSec` is that second
  // figure and the header says so; nothing here claims to close it.
  assert.equal(
    ctx.suspends.length, 3,
    'and no extra step is scheduled for the trim — the master lane carries its prefix only',
  );
}

/* ── 2c. The lead is the track's OWN chain, not its path to the master ────── */

/** t1 -> b1 -> master, so the track's path declares its own rack PLUS the bus's
 *  while the PANNER, which sits on the track strip before either the comp delay
 *  or the bus, waits only for its own. This is the case the single-track suites
 *  above cannot see: with no bus the two figures are the same number, so a
 *  renderer that reached for `TrackCompRow.latencySec` would pass every one of
 *  them and be wrong by the bus's rack the moment a mix has one. */
function graphWithOneBus(): RoutingGraph {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'T1');
  g = addBus(g, 'b1', 'Bus');
  const res = setOutput(g, 't1', 'b1');
  assert.ok(res.ok, 't1 -> bus is a legal edge');
  return res.graph as RoutingGraph;
}

async function panLeadsByItsOwnChainNotByItsPathToTheMaster(): Promise<void> {
  const trackChain = [entry('t-comp', 'compressor')];
  const buses = [bus({ id: 'b1', fxChain: [entry('b-comp', 'compressor')] })];
  const routing = graphWithOneBus();

  // The fixture, stated before it is used: the two candidate figures DIFFER, so
  // the assertion below can tell them apart. Every other case in this file is
  // single-track and un-routed, where they are the same number.
  assert.ok(close(chainLatencySec(trackChain, { sampleRate: SR }), COMP_SEC), 'own chain: 6 ms');
  const pathRows = trackCompDelays(
    [{ id: 't1', fxChain: trackChain }], undefined, SR, { graph: routing, buses },
  );
  assert.ok(
    close(pathRows[0].latencySec, 2 * COMP_SEC),
    `the PATH to the master declares 12 ms: ${pathRows[0].latencySec}`,
  );

  const h = harness({
    tracks: [track({ id: 't1', fxChain: trackChain })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: mixLanes('t1'),
    routing,
    buses,
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const [tPan] = panners(ctx);

  // The bus is REALLY in this render: without it the case would degrade to the
  // single-track shape every other case already has and pass for the wrong
  // reason. (`renderBounce` walks the graph only for the master scope, and only
  // when one is supplied and orders.)
  assert.ok(
    h.chain.calls.some((c) => c.entries.some((e) => e.id === 'b-comp')),
    'the bus rack was built, so the track really is routed through it',
  );

  const ramp = tPan.pan.calls[1];
  assert.equal(ramp[0], 'linearRampToValueAtTime');
  assert.ok(close(ramp[2], 1.006), `the pan breakpoint at 1.0 lands at 1 + own = 1.006: ${ramp[2]}`);
  assert.ok(
    !close(ramp[2], 1 + 2 * COMP_SEC, 1e-6),
    'and NOT at 1 + own + bus = 1.012 — the bus is downstream of the panner and cannot make it early',
  );
}

/* ── 2d. Each track leads by its own chain, in one render ─────────────────── */

async function eachTrackLeadsByItsOwnChain(): Promise<void> {
  const h = harness({
    tracks: [
      track({ id: 't1', fxChain: [entry('t1-comp', 'compressor')] }),
      track({ id: 't2', fxChain: [] }),
    ],
    clips: [
      clip({ id: 'c1', trackId: 't1', durationSec: 2 }),
      clip({ id: 'c2', trackId: 't2', durationSec: 2 }),
    ],
    automationLanes: [...mixLanes('t1'), ...mixLanes('t2')],
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const [t1Pan, t2Pan] = panners(ctx);

  // The mixed-latency shape is really here: T18 gave the dry strip a comp delay
  // so the two SUM aligned. That is the per-FILE alignment; the per-PARAM one
  // below is a different number and this case is where they can disagree.
  assert.equal(ctx.created.filter((n) => n.kind === 'comp').length, 2, 'both strips are compensated');

  assert.ok(close(t1Pan.pan.calls[1][2], 1.006), `the compressed track: ${t1Pan.pan.calls[1][2]}`);
  assert.equal(t2Pan.pan.calls[1][2], 1, 'the dry track sitting next to it leads nothing');
  // The two figures are per PARAM, not per file: the dry track still holds a
  // 6 ms compensation delay so the two strips SUM aligned (T18), and the trim
  // still takes one number off the front. Neither of those moved the envelope.
  assert.deepEqual(
    [t1Pan.pan.calls[0], t2Pan.pan.calls[0]],
    [['setValueAtTime', -1, 0], ['setValueAtTime', -1, 0]],
    'both anchors stay at the top of the render',
  );
}

/* ── 3. The live and offline numbers are the same numbers ─────────────────── */
//
// Both halves of T19's contract are functions in `state/liveMixer.ts`, and the
// render calls those functions rather than a second copy of the rule. Asserted
// by driving them with the LIVE arguments (a rolling context clock, a transport
// that started at some arbitrary moment) and checking the offset the render
// wrote is the offset they describe.
//
// Live counterparts, both in `state/liveMixer.envelope.test.ts`:
//   - `delayShiftsEveryFutureEventButNotTheAnchor` — a pan breakpoint at
//     timeline 1.0 through a 6 ms chain is scheduled at `startCtxTime + 1.006`
//     while the volume lane's is at `startCtxTime + 1.0`.
//   - `theFxFrameReadsTheLaneWhereTheArrivingAudioEnteredTheChain` —
//     `fxLaneSampleTime(2, 0.006, 10) === 1.994`, and a zero prefix is exact.

async function theOfflineNumbersAreTheLiveOnes(): Promise<void> {
  const h = harness({
    tracks: [track({
      id: 't1',
      fxChain: [entry('c-comp', 'compressor'), entry('r-verb', 'reverb', { mix: 0.3 })],
    })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: [...mixLanes('t1'), fxLane('t1', 'r-verb')],
  });
  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const [, tGain, tPan] = ctx.created;

  // PAN. The live engine schedules against a rolling context clock; the render
  // pins all four of `laneEnvelopeEvents`'s time arguments to 0, so the offline
  // event time IS the offset from the anchor. Same lane, same 6 ms, same shift.
  const livePan = laneEnvelopeEvents({ points: PAN_POINTS }, 0, 100, 0, 100, COMP_SEC);
  const liveVol = laneEnvelopeEvents({ points: VOL_POINTS }, 0, 100, 0, 100, 0);
  const panRamp = livePan[1];
  const volRamp = liveVol[1];
  assert.ok(panRamp.kind === 'ramp' && volRamp.kind === 'ramp');
  assert.ok(close(panRamp.when - 100, tPan.pan.calls[1][2]), 'the pan breakpoint agrees live and offline');
  assert.ok(close(volRamp.when - 100, tGain.gain.calls[1][2]), 'and so does the volume breakpoint');
  assert.ok(
    close(panRamp.when - volRamp.when, COMP_SEC),
    'both sides put exactly the chain between the two lanes',
  );

  // FX. The live frame reads the lane at `fxLaneSampleTime(t, prefix, total)`;
  // the render reads it at the same function of its own step time. The lane is
  // the identity, so the value written IS the time it was read at.
  const call = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'r-verb'));
  assert.ok(call);
  const written = mixes(call, 'r-verb');
  const lengthSec = ctx.length / ctx.sampleRate;
  // Only a step that lands INSIDE the lane can show its sample time in the
  // value it wrote; past the last breakpoint the lane holds whatever time it is
  // read at (section 2 pins that case). These two are inside it.
  for (const i of [0, 1]) {
    const t = ctx.suspends[i];
    const live = fxLaneSampleTime(t, COMP_SEC, lengthSec);
    assert.ok(
      close(written[i + 1], live),
      `the step at ${t} read the lane at ${written[i + 1]}; the live frame reads it at ${live}`,
    );
  }
  assert.equal(
    written[0], fxLaneSampleTime(0, COMP_SEC, lengthSec),
    'including the initial state, which clamps to the top of the timeline rather than going behind it',
  );
}

await panIsWrittenLateByItsOwnChainAndVolumeIsNot();
await withNoRackInTheGraphPanLeadsNothing();
await aLaneOnTheSecondEntryIsSampledBehindTheStep();
await aSingleEntryChainIsSampledAtTheStep();
await aMasterLaneIsSampledBehindTheMasterChain();
await panLeadsByItsOwnChainNotByItsPathToTheMaster();
await eachTrackLeadsByItsOwnChain();
await theOfflineNumbersAreTheLiveOnes();

console.log('renderCore.automation: ok');
