// A KEYABLE effect: the compressor's sidechain follower (T64, wave 3).
//
// Before this, no rack effect took a key. `state/routingGraph` could express
// "the kick keys the compressor on the bass" — `CONN_SIDECHAIN`, its
// `targetEntryId`, its cycle refusal, all tested — and nothing on either side of
// the model could act on it: no effect had a second input to connect a key to.
//
// A `DynamicsCompressorNode` has exactly one input and no key, so the detector
// is BUILT. What this file pins is the build, and above all the two properties
// that make it usable in a DAW rather than merely audible:
//
//   1. THE BOUNCE IS THE PREVIEW. The whole follower is audio nodes — rectifier,
//      smoothing filter, depth gain, driving a gain on the audio path through an
//      `AudioParam` connection. No JavaScript is in the loop, so nothing about
//      it can depend on how fast the renderer runs. The alternative (a second
//      `DynamicsCompressorNode` whose `reduction` float a timer reads and
//      writes) would duck at DIFFERENT MOMENTS offline, where a 300 s bounce
//      renders in a fraction of a second and a timer fires a handful of times.
//      That is why the shape below is the shape, and why this file asserts the
//      shape and not just the numbers.
//   2. AN UNKEYED COMPRESSOR IS BIT-IDENTICAL to the one that existed before the
//      follower did. Silence into the rectifier has to come out as EXACTLY zero
//      reduction — not nearly zero — or every existing render of every
//      compressor in the app moves. The curve's centre sample is the reason it
//      does, so the curve is asserted sample by sample at that point.
//
// Plus: the follower adds NOTHING to the declared latency, and the zero is
// stated rather than omitted (`KEY_FOLLOWER_LATENCY_SEC`). Every node it adds is
// on the CONTROL path; the one node it adds to the audio path is a `GainNode`.
//
// There is no Web Audio under tsx, so the context here is fake — but the EFFECT
// is the real registry's `make`, not a stand-in: the whole point is what the
// shipped compressor builds.
//
// Run: npx tsx src/lib/rackEffects.sidechain.test.ts
import assert from 'node:assert/strict';

import {
  KEY_FOLLOWER_LATENCY_SEC, RACK_EFFECTS, chainLatencySec, getRackEffect,
  type RackEffectInstance,
} from './rackEffects.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/* ── a fake BaseAudioContext, enough for the real compressor factory ───────── */

interface FakeParam {
  value: number;
  /** Every `setValueAtTime` / `setTargetAtTime`, so a param write is assertable
   *  as a write and not merely as a final value. */
  writes: { kind: string; value: number }[];
  setValueAtTime(v: number, t: number): void;
  setTargetAtTime(v: number, t: number, tc: number): void;
}

const param = (initial: number): FakeParam => {
  const p: FakeParam = {
    value: initial,
    writes: [],
    setValueAtTime(v) { p.writes.push({ kind: 'set', value: v }); p.value = v; },
    setTargetAtTime(v) { p.writes.push({ kind: 'target', value: v }); p.value = v; },
  };
  return p;
};

interface FakeNode {
  kind: string;
  /** Targets of `connect`, which may be a node OR an `AudioParam` — the
   *  follower's last edge is into a param, and that IS the arithmetic. */
  outputs: unknown[];
  disconnects: number;
  gain: FakeParam;
  frequency: FakeParam;
  Q: FakeParam;
  threshold: FakeParam;
  ratio: FakeParam;
  knee: FakeParam;
  attack: FakeParam;
  release: FakeParam;
  type: string;
  curve: Float32Array | null;
  oversample: string;
  connect(to: unknown): unknown;
  disconnect(): void;
}

const fakeNode = (kind: string): FakeNode => {
  const n: FakeNode = {
    kind,
    outputs: [],
    disconnects: 0,
    gain: param(1),
    frequency: param(350),
    Q: param(1),
    threshold: param(-24),
    ratio: param(12),
    knee: param(30),
    attack: param(0.003),
    release: param(0.25),
    type: 'lowpass',
    curve: null,
    oversample: 'none',
    connect(to) { n.outputs.push(to); return to; },
    disconnect() { n.disconnects += 1; n.outputs.length = 0; },
  };
  return n;
};

interface FakeCtx {
  currentTime: number;
  sampleRate: number;
  created: FakeNode[];
  createGain(): FakeNode;
  createDynamicsCompressor(): FakeNode;
  createWaveShaper(): FakeNode;
  createBiquadFilter(): FakeNode;
}

const fakeCtx = (): FakeCtx => {
  const created: FakeNode[] = [];
  const make = (kind: string) => { const n = fakeNode(kind); created.push(n); return n; };
  return {
    currentTime: 0,
    sampleRate: 44100,
    created,
    createGain: () => make('gain'),
    createDynamicsCompressor: () => make('comp'),
    createWaveShaper: () => make('shaper'),
    createBiquadFilter: () => make('biquad'),
  };
};

type Ctx = Parameters<NonNullable<ReturnType<typeof getRackEffect>>['make']>[0];

/** Build the SHIPPED compressor over the fake context. */
function buildCompressor(params: Record<string, number> = {}): {
  ctx: FakeCtx; inst: RackEffectInstance;
} {
  const def = getRackEffect('compressor');
  assert.ok(def, 'the compressor is in the rack');
  const ctx = fakeCtx();
  // Through `withDefaults`' contract: the chain builder always hands a factory a
  // COMPLETE param set, so the defaults are merged here the same way.
  const full: Record<string, number> = {};
  for (const p of def.params) full[p.key] = p.default;
  const inst = def.make(ctx as unknown as Ctx, { ...full, ...params });
  return { ctx, inst };
}

const nodesOfKind = (ctx: FakeCtx, kind: string): FakeNode[] =>
  ctx.created.filter((n) => n.kind === kind);

/* ── 1. The registry declares which effects take a key ────────────────────── */

function theRegistryNamesTheKeyableEffects(): void {
  assert.deepEqual(
    RACK_EFFECTS.filter((d) => d.keyInput).map((d) => d.id),
    ['compressor'],
    'the compressor is the one keyable effect — asserted over the WHOLE registry, so an '
      + 'effect that gains a key later cannot do it without this list being updated',
  );

  // Two effects a sidechain UI usually also offers are deliberately absent, and
  // this says WHY rather than leaving their absence to look like an oversight.
  assert.equal(
    getRackEffect('gater')?.keyInput, undefined,
    "`gater` is an LFO tremolo: its opening is a PHASE, not a detector, so there is nothing "
      + 'for a key to drive',
  );
  assert.equal(
    RACK_EFFECTS.some((d) => d.id === 'sidechain-compressor'), false,
    'and no separate ducker is added: a compressor keyed from another strip IS the ducker',
  );

  // The declaration is a PROMISE about the instance, so it is checked against
  // one rather than taken on trust.
  for (const def of RACK_EFFECTS.filter((d) => d.keyInput)) {
    const ctx = fakeCtx();
    const full: Record<string, number> = {};
    for (const p of def.params) full[p.key] = p.default;
    const inst = def.make(ctx as unknown as Ctx, full);
    assert.ok(inst.keyIn, `${def.id} declares keyInput, so its instance must expose keyIn`);
  }
  for (const def of RACK_EFFECTS.filter((d) => !d.keyInput && d.id === 'parametric_eq')) {
    const ctx = fakeCtx();
    const inst = def.make(ctx as unknown as Ctx, {});
    assert.equal(inst.keyIn, undefined, 'an effect that takes no key exposes none');
  }
}

/* ── 2. The follower's shape, which is what makes the bounce the preview ──── */

function theDetectorIsAudioNodesAndNothingElse(): void {
  const { ctx, inst } = buildCompressor();
  const gains = nodesOfKind(ctx, 'gain');
  const [shaper] = nodesOfKind(ctx, 'shaper');
  const [smooth] = nodesOfKind(ctx, 'biquad');
  const [comp] = nodesOfKind(ctx, 'comp');

  // gain0 input, gain1 makeup, gain2 keyIn, gain3 depth, gain4 audio out.
  assert.equal(gains.length, 5, 'input, makeup, keyIn, depth and the key-driven output gain');
  const [input, makeup, keyIn, depth, audioOut] = gains;

  assert.equal(inst.input, input as unknown, 'the effect input is unchanged');
  assert.equal(inst.keyIn, keyIn as unknown, 'the key input is its own gain node');
  assert.equal(inst.output, audioOut as unknown, 'and the output is now the key-driven gain');
  assert.notEqual(inst.keyIn, inst.input, 'a key is a SECOND input, not the signal input');

  // The audio path: input -> comp -> makeup -> audioOut. Post-makeup is where a
  // console puts a sidechain, and it leaves the internal detector's behaviour
  // exactly what it is on an unkeyed compressor.
  assert.deepEqual(input.outputs, [comp], 'input feeds the native compressor');
  assert.deepEqual(comp.outputs, [makeup], 'which feeds the makeup gain');
  assert.deepEqual(makeup.outputs, [audioOut], 'which feeds the key-driven gain');

  // The control path: keyIn -> shaper -> smooth -> depth -> audioOut.gain.
  assert.deepEqual(keyIn.outputs, [shaper], 'the key is rectified first');
  assert.deepEqual(shaper.outputs, [smooth], 'then smoothed');
  assert.deepEqual(smooth.outputs, [depth], 'then scaled by the depth');
  assert.deepEqual(
    depth.outputs, [audioOut.gain],
    'and lands on the output gain\'s PARAM — an AudioParam sums its inputs with its intrinsic '
      + 'value, so the gain computes 1 - reduction with no JavaScript in the loop',
  );
  assert.equal(
    audioOut.gain.value, 1,
    'the intrinsic value the reduction is subtracted from is 1, set explicitly',
  );

  assert.equal(smooth.type, 'lowpass', 'the smoothing stage is a lowpass');
  assert.equal(
    smooth.Q.value, 0.5,
    'at Q = 0.5 — the critically damped double pole, whose step response does not overshoot; '
      + 'that is what bounds the envelope by the rectifier and keeps the gain out of negative '
      + '(phase-inverting) territory',
  );
  assert.equal(
    shaper.oversample, 'none',
    'and the rectifier does not oversample: oversampling adds resampling latency to a path '
      + 'that has none',
  );
}

/* ── 3. Unkeyed is EXACTLY transparent ───────────────────────────────────── */

function aSilentKeyIsExactlyZeroReduction(): void {
  const { ctx } = buildCompressor();
  const [shaper] = nodesOfKind(ctx, 'shaper');
  const curve = shaper.curve;
  assert.ok(curve, 'the rectifier has a curve');
  assert.equal(curve.length % 2, 1, 'of ODD length, so one sample is exactly x = 0');

  const mid = (curve.length - 1) / 2;
  assert.equal(
    curve[mid], 0,
    'and that sample is 0 — a silent key therefore produces EXACTLY zero reduction, the param '
      + 'computes 1 + 0 = 1, and a multiply by 1 is exact in float: every existing compressor '
      + 'render is untouched by the existence of this follower',
  );
  assert.equal(curve[0], 1, 'x = -1 rectifies to 1');
  assert.equal(curve[curve.length - 1], 1, 'x = +1 rectifies to 1');
  assert.ok(close(curve[mid + 1], 2 / (curve.length - 1)), 'and the curve is |x| in between');

  // The bound that keeps the gain non-negative: nothing on the curve exceeds 1,
  // so the smoothed envelope cannot either (see the Q assertion above).
  let maxAbs = 0;
  for (let i = 0; i < curve.length; i += 1) {
    assert.ok(curve[i] >= 0, `the rectifier is non-negative at ${i}`);
    if (curve[i] > maxAbs) maxAbs = curve[i];
  }
  assert.equal(maxAbs, 1, 'and it is bounded by 1, which bounds the reduction by the depth');
}

/* ── 4. The three key params ─────────────────────────────────────────────── */

function theKeyParamsDriveTheRightNodes(): void {
  const def = getRackEffect('compressor');
  assert.ok(def);
  const keyParams = def.params.filter((p) => p.group === 'Key').map((p) => p.key);
  assert.deepEqual(
    keyParams, ['keyDuck', 'keySens', 'keySmooth'],
    'the key section is duck, sensitivity and smoothing',
  );

  {
    const { ctx } = buildCompressor({ keyDuck: 12, keySens: 12, keySmooth: 80 });
    const [, , keyIn, depth] = nodesOfKind(ctx, 'gain');
    const [smooth] = nodesOfKind(ctx, 'biquad');
    assert.ok(
      close(keyIn.gain.value, Math.pow(10, 12 / 20), 1e-6),
      'keySens is gain INTO the rectifier, in dB',
    );
    assert.ok(
      close(depth.gain.value, -(1 - Math.pow(10, -12 / 20)), 1e-9),
      'keyDuck is the fraction of the signal removed at full envelope, NEGATED — it is '
        + 'subtracted from unity, so 12 dB is a floor of 0.251 and never an inversion',
    );
    assert.ok(
      close(smooth.frequency.value, 1 / (2 * Math.PI * 0.08), 1e-9),
      'keySmooth is a time constant, written as the corner frequency 1/(2*pi*tau)',
    );
  }

  {
    // 0 dB of duck is a KEYED but transparent effect: the picker can be set
    // while nothing happens yet, which is what makes the control discoverable.
    const { ctx } = buildCompressor({ keyDuck: 0 });
    const [, , , depth] = nodesOfKind(ctx, 'gain');
    assert.equal(depth.gain.value, -0, 'a 0 dB duck removes nothing');
  }

  {
    // A damaged param set cannot drive the follower out of range: every value is
    // clamped before it reaches a node, because these land on AudioParams.
    const { ctx } = buildCompressor({ keyDuck: 1e6, keySens: -50, keySmooth: 1e9 });
    const [, , keyIn, depth] = nodesOfKind(ctx, 'gain');
    const [smooth] = nodesOfKind(ctx, 'biquad');
    assert.ok(close(depth.gain.value, -(1 - Math.pow(10, -48 / 20)), 1e-9), 'duck clamps at 48 dB');
    assert.equal(keyIn.gain.value, 1, 'sensitivity clamps at 0 dB');
    assert.ok(smooth.frequency.value >= 0.05, 'and the smoothing corner stays above 0.05 Hz');
    assert.ok(Number.isFinite(smooth.frequency.value), 'finite, always — this is an AudioParam');
  }
}

function aLiveParamPushReachesTheFollower(): void {
  const { ctx, inst } = buildCompressor({ keyDuck: 12 });
  const [, , keyIn, depth] = nodesOfKind(ctx, 'gain');
  const before = depth.gain.value;
  inst.setParams({ threshold: -20, ratio: 4, keyDuck: 24, keySens: 24, keySmooth: 40 });
  assert.notEqual(depth.gain.value, before, 'a live push moves the depth');
  assert.ok(close(depth.gain.value, -(1 - Math.pow(10, -24 / 20)), 1e-9), 'to the new duck');
  assert.ok(close(keyIn.gain.value, Math.pow(10, 24 / 20), 1e-6), 'and the new sensitivity');
  assert.ok(
    ctx.created.some((n) => n.kind === 'comp' && n.threshold.value === -20),
    'while the compressor\'s own params still land — the follower is added, not substituted',
  );
}

/* ── 5. Latency: the follower's contribution is zero, and it is STATED ────── */

function theFollowerDeclaresNoLatency(): void {
  assert.equal(
    KEY_FOLLOWER_LATENCY_SEC, 0,
    'every node the follower adds is on the CONTROL path; the one node it adds to the AUDIO '
      + 'path is a GainNode, which the spec gives no latency. The smoothing filter\'s group '
      + 'delay is real but it delays the ENVELOPE, and declaring it would push the whole chain '
      + 'late for a lag nothing downstream experiences',
  );

  const def = getRackEffect('compressor');
  assert.ok(def);
  const entry = (params: Record<string, number>): ChainEntry =>
    ({ id: 'c', effect: 'compressor', enabled: true, params });

  assert.equal(
    chainLatencySec([entry({})]), 0.006 + KEY_FOLLOWER_LATENCY_SEC,
    'so a compressor declares the DynamicsCompressor look-ahead plus the follower\'s zero',
  );
  assert.equal(
    chainLatencySec([entry({ keyDuck: 48, keySens: 48, keySmooth: 500 })]), 0.006,
    'and no key setting moves it — which is why the declaration stays a constant',
  );
}

/* ── 6. Teardown ─────────────────────────────────────────────────────────── */

function disposeTakesTheFollowerWithIt(): void {
  const { ctx, inst } = buildCompressor();
  inst.dispose();
  for (const n of ctx.created) {
    assert.ok(
      n.disconnects >= 1,
      `${n.kind} is disconnected — a follower left behind would keep an edge into a param of a `
        + 'node the chain has stopped using',
    );
  }
}

theRegistryNamesTheKeyableEffects();
theDetectorIsAudioNodesAndNothingElse();
aSilentKeyIsExactlyZeroReduction();
theKeyParamsDriveTheRightNodes();
aLiveParamPushReachesTheFollower();
theFollowerDeclaresNoLatency();
disposeTakesTheFollowerWithIt();

console.log('rackEffects.sidechain: ok');
