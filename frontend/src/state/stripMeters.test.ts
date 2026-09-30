/**
 * The per-strip meter registry (T24) — the READ side of the mixer drawer's
 * strip meters.
 *
 * `state/stripMeters` owns no audio graph. `state/liveMixer` builds one leaf
 * analyser per strip and publishes them through `getStripMeterNodes()`; this
 * module sizes a buffer per strip, folds each window down to a peak and an RMS,
 * and hands back objects it REUSES between calls so a 60 fps paint loop over N
 * strips allocates nothing.
 *
 * Everything that can silently rot about that arrangement is pinned here, with
 * fake taps rather than Web Audio:
 *
 *   1. Nothing attached -> `null`, so a caller can tell "no reading" from
 *      "silence" and feed its ballistics zeros instead of stalling them.
 *   2. The arithmetic: peak is the window's largest magnitude, RMS is the
 *      window's root-mean-square, both linear.
 *   3. Reuse: the same map and the same per-strip object come back every call.
 *   4. A REWIRE swaps the analyser object under a live strip id (`buildTrackNodes`
 *      rebuilds them wholesale) — the next sample must read the NEW node, and a
 *      strip that went away must stop being reported.
 *   5. The refcount: two holders share one registry and only the last release
 *      tears it down, which is what lets the drawer and anything else that wants
 *      strip levels coexist.
 *   6. The graph half, in `liveMixer`: the tap a strip is built with is a LEAF —
 *      it hangs off the end of the strip and feeds nothing — it carries the
 *      settings this module's arithmetic assumes, it is absent (rather than a
 *      crash) on a context that cannot make one, and teardown disconnects it.
 *
 * Run: npx tsx src/state/stripMeters.test.ts — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

import {
  configureStripMeters,
  disposeStripMeters,
  ensureStripMeters,
  resetStripMeterSource,
  sampleStripLevels,
  type StripMeterTap,
} from './stripMeters.ts';
import {
  createBusNodes,
  disposeBusNodes,
  type DisposableBus,
  type MixBus,
} from './liveMixer.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ── fake taps ────────────────────────────────────────────────────────────── */

interface FakeTap extends StripMeterTap {
  /** How many times the registry read this node. */
  reads: number;
  /** The window it hands back, zero-padded to `fftSize`. */
  window: number[];
}

const fakeTap = (window: number[], fftSize = 4): FakeTap => {
  const tap: FakeTap = {
    fftSize,
    reads: 0,
    window,
    getFloatTimeDomainData(into: Float32Array): void {
      tap.reads += 1;
      assert.equal(into.length, fftSize, 'the registry sizes its buffer from the tap');
      into.fill(0);
      for (let i = 0; i < tap.window.length && i < into.length; i += 1) into[i] = tap.window[i];
    },
  };
  return tap;
};

/** The live map `liveMixer.getStripMeterNodes()` stands in for. */
const taps = new Map<string, StripMeterTap>();
configureStripMeters({ taps: () => taps });

/** Drop every hold, whatever the previous block left behind. */
function releaseAll(): void {
  for (let i = 0; i < 8; i += 1) disposeStripMeters();
}

/* ── 1. Nothing attached ──────────────────────────────────────────────────── */

// No hold at all: the registry is not sampling, so there is no reading — NOT a
// reading of silence. The drawer's loop feeds its ballistics zeros on a null,
// which is how a bar decays away instead of freezing at its last value.
{
  releaseAll();
  taps.clear();
  assert.equal(sampleStripLevels(), null, 'no hold -> no reading');

  taps.set('t1', fakeTap([1, 0, 0, 0]));
  assert.equal(sampleStripLevels(), null, 'a tap without a hold is still no reading');
}

// Held, but the live mixer has no strips yet (nothing has played, or the session
// was disposed) — also no reading, rather than an empty map the caller has to
// special-case.
{
  taps.clear();
  ensureStripMeters();
  assert.equal(sampleStripLevels(), null, 'held, but no strips -> no reading');
  releaseAll();
}

/* ── 2. The arithmetic ────────────────────────────────────────────────────── */

// Peak is the largest MAGNITUDE (a negative sample peaks just as hard) and RMS
// is over the whole window including the zero padding, which is exactly what an
// analyser window contains when a strip goes quiet mid-window.
{
  taps.clear();
  taps.set('t1', fakeTap([1, -0.5, 0, 0]));
  taps.set('b1', fakeTap([-0.25, -0.25, -0.25, -0.25]));
  ensureStripMeters();

  const out = sampleStripLevels();
  assert.ok(out, 'a held registry with live taps reads');
  assert.deepEqual([...out.keys()], ['t1', 'b1'], 'every live strip is reported, in source order');

  const t1 = out.get('t1');
  assert.equal(t1.peak, 1, 'peak is the window maximum magnitude');
  assert.ok(close(t1.rms, Math.sqrt((1 + 0.25) / 4)), `rms folded the whole window (got ${t1.rms})`);

  const b1 = out.get('b1');
  assert.equal(b1.peak, 0.25, 'a window that is entirely negative still peaks at its magnitude');
  assert.ok(close(b1.rms, 0.25), 'a DC window meters rms == |level|');

  // Exactly one read per strip per sample: the loop calls this once a frame and
  // a second getFloatTimeDomainData would be a second window, not the same one.
  assert.equal((taps.get('t1') as FakeTap).reads, 1, 't1 read once');
  assert.equal((taps.get('b1') as FakeTap).reads, 1, 'b1 read once');
  releaseAll();
}

/* ── 3. Reuse ─────────────────────────────────────────────────────────────── */

// The map and every StripLevels in it are the SAME objects call after call. A
// fresh object per strip per frame would be ~N garbage objects a second for as
// long as the drawer is open, which is precisely what this module exists to
// avoid; the contract is that a caller reads the values inside the frame and
// never holds the object.
{
  taps.clear();
  const t = fakeTap([0.5, 0, 0, 0]);
  taps.set('t1', t);
  ensureStripMeters();

  const first = sampleStripLevels();
  const firstT1 = first.get('t1');
  t.window = [0.25, 0, 0, 0];
  const second = sampleStripLevels();

  assert.equal(second, first, 'the same map comes back');
  assert.equal(second.get('t1'), firstT1, 'and the same per-strip object');
  assert.equal(firstT1.peak, 0.25, 'which now carries the newest window');
  releaseAll();
}

/* ── 4. A rewire ──────────────────────────────────────────────────────────── */

// `buildTrackNodes` throws the whole strip away and builds a new one, analyser
// included, and `wireRouting` disconnects and re-attaches the taps under a live
// id. The registry re-reads the source every sample rather than caching nodes,
// so the replacement is picked up with nothing to notify.
{
  taps.clear();
  taps.set('t1', fakeTap([0.5, 0, 0, 0]));
  taps.set('t2', fakeTap([0.125, 0, 0, 0]));
  ensureStripMeters();

  const before = sampleStripLevels();
  assert.equal(before.get('t1').peak, 0.5, 'the first graph reads');

  // Same id, brand-new node — and a wider window, so a stale buffer would be
  // caught by the length assertion inside the fake.
  const rebuilt = fakeTap([0, 0, 0, 0, 0.75, 0, 0, 0], 8);
  taps.set('t1', rebuilt);
  // t2 was removed by the rebuild (the user deleted the track).
  taps.delete('t2');

  const after = sampleStripLevels();
  assert.equal(after.get('t1').peak, 0.75, 'the replacement analyser is what gets read');
  assert.equal(rebuilt.reads, 1, 'and it was read, not skipped');
  assert.equal(after.has('t2'), false, 'a strip that no longer exists is dropped, not frozen');
  assert.deepEqual([...after.keys()], ['t1'], 'nothing stale is left in the map');
  releaseAll();
}

/* ── 5. The refcount ──────────────────────────────────────────────────────── */

// Two holders, one registry: the first release must NOT stop the second holder's
// readings. This mirrors levelsStore's ensureMeter/disposeMeter so the two can
// be paired independently by different components.
{
  taps.clear();
  taps.set('t1', fakeTap([1, 0, 0, 0]));
  ensureStripMeters();
  ensureStripMeters();

  assert.ok(sampleStripLevels(), 'two holds, reading');
  disposeStripMeters();
  assert.ok(sampleStripLevels(), 'one hold released, the other still reads');
  disposeStripMeters();
  assert.equal(sampleStripLevels(), null, 'the last release stops the reading');

  // An unbalanced extra release must not drive the count negative — the next
  // ensure would then be a no-op and the drawer would open to dead meters.
  disposeStripMeters();
  disposeStripMeters();
  ensureStripMeters();
  const back = sampleStripLevels();
  assert.ok(back, 'a fresh hold reads again after an over-release');
  assert.equal(back.get('t1').peak, 1, 'and the buffers it dropped are rebuilt');
  releaseAll();
}

/* ── 6. The graph half: the tap a strip is built with ─────────────────────── */

/* `createBusNodes` is the one strip builder that takes its context as an
   argument, so it is the one that can be driven with fakes. `buildTrackNodes`
   (and `wireRouting`, and `reconnectLeafTaps`) read the module's private
   `trackNodes` / `busNodes` maps and get their context from
   `playerStore.getEngineCtx()`, so NONE of them can be driven from here — the
   re-attach after `wireRouting`'s disconnect sweep is covered by the browser
   check in the ticket's report, not by this file. What IS pinned below is the
   shape every tap has, which is what that re-attach restores. */

interface FakeGraphNode {
  kind: string;
  /** Everything this node was connected TO, in order. */
  outputs: FakeGraphNode[];
  disconnects: number;
  gain: { value: number; setTargetAtTime(v: number, t: number, tc: number): void };
  connect(to: FakeGraphNode): FakeGraphNode;
  disconnect(): void;
}

const graphNode = (kind: string): FakeGraphNode => {
  const node: FakeGraphNode = {
    kind,
    outputs: [],
    disconnects: 0,
    gain: { value: 1, setTargetAtTime(v) { node.gain.value = v; } },
    connect(to) { node.outputs.push(to); return to; },
    disconnect() { node.disconnects += 1; node.outputs.length = 0; },
  };
  return node;
};

/** A fake analyser: a graph node plus the four settings `makeStripMeter` pins. */
const graphAnalyser = () =>
  Object.assign(graphNode('analyser'), {
    fftSize: 0,
    channelCount: 0,
    channelCountMode: '',
    channelInterpretation: '',
  });

type FakeAnalyser = ReturnType<typeof graphAnalyser>;

const graphCtx = (withAnalyser: boolean) => {
  const gains: FakeGraphNode[] = [];
  const analysers: FakeAnalyser[] = [];
  const ctx: Record<string, unknown> = {
    gains,
    analysers,
    createGain() { const n = graphNode(`gain${gains.length}`); gains.push(n); return n; },
    createDelay() { return graphNode('delay'); },
  };
  // A context that cannot make one simply does not have the method — which is
  // the case `liveMixer.routing.test.ts`'s fakes exercise from the other side.
  if (withAnalyser) ctx.createAnalyser = () => { const a = graphAnalyser(); analysers.push(a); return a; };
  return ctx as typeof ctx & { gains: FakeGraphNode[]; analysers: FakeAnalyser[] };
};

type BusCtx = Parameters<typeof createBusNodes>[0];
const aBus = (id: string): MixBus => ({ id, fxChain: [], volume: 0.8, mute: false });

// The tap is a LEAF hung off the END of the strip. Two halves to that claim:
// the bus's `output` feeds the analyser and NOTHING else (where the bus really
// goes is an edge `wireRoutingGraph` adds afterwards), and the analyser itself
// feeds nothing at all — so `topoOrder` and the send taps, which only ever see
// `output`, cannot reach it and it can never become part of the routing.
{
  const ctx = graphCtx(true);
  const nodes = createBusNodes(ctx as unknown as BusCtx, aBus('b1'));

  assert.equal(ctx.analysers.length, 1, 'exactly one tap per strip');
  assert.equal(nodes.meter, ctx.analysers[0], 'and the strip carries it');

  const output = nodes.output as unknown as FakeGraphNode;
  assert.deepEqual(output.outputs, [nodes.meter], 'the output feeds the tap and nothing else yet');
  assert.deepEqual(ctx.analysers[0].outputs, [], 'the tap feeds nothing — it is a leaf');

  // The settings this module's arithmetic assumes: a mono window of the length
  // `sampleStripLevels` sizes its buffer from.
  const meter = ctx.analysers[0];
  assert.equal(meter.fftSize, 2048, 'a 2048-sample window, so windows overlap at 60 fps');
  assert.equal(meter.channelCount, 1, 'mono');
  assert.equal(meter.channelCountMode, 'explicit', 'explicit, or the count is ignored');
  assert.equal(meter.channelInterpretation, 'speakers', 'folded as speakers, not discretely');
}

// Teardown takes the tap with the strip. A tap left connected to a disposed
// strip would keep that strip's chain alive for the analyser to pull on.
{
  const ctx = graphCtx(true);
  const nodes = createBusNodes(ctx as unknown as BusCtx, aBus('b1'));
  const meter = ctx.analysers[0];
  const wrapped = { ...nodes, fx: { dispose: () => {} } } as unknown as DisposableBus;

  assert.equal(meter.disconnects, 0, 'still connected before teardown');
  disposeBusNodes([wrapped], []);
  assert.equal(meter.disconnects, 1, 'the tap is disconnected exactly once with its strip');
}

// A context with no `createAnalyser` builds the strip anyway, tapless. The strip
// then never appears in `getStripMeterNodes()` and its bar sits at silence —
// which is what keeps the routing-pass fakes (gains and delays only) working.
{
  const ctx = graphCtx(false);
  const nodes = createBusNodes(ctx as unknown as BusCtx, aBus('b1'));
  assert.equal(nodes.meter, undefined, 'no tap, and no crash');
  assert.deepEqual((nodes.output as unknown as FakeGraphNode).outputs, [], 'nothing hung off the output');
}

/* ── teardown ─────────────────────────────────────────────────────────────── */

resetStripMeterSource();
taps.clear();

console.log('stripMeters registry: all assertions passed');
