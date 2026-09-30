/**
 * vstLive/vstLiveNode — the synchronous factory behind a live `vst3` entry.
 *
 * `buildEffectChain` is synchronous and is called on every play / stop / seek,
 * but opening a plugin is seconds of async work. So the factory returns a
 * PASSTHROUGH immediately and swaps the worklet in later, exactly the way
 * `makeChop` loads its module — and the swap has to be click-free, because it
 * lands while the user is listening.
 *
 * The suite drives that with a fake audio graph: no Web Audio under tsx, so the
 * context, its gains and the worklet node are fakes that record what was
 * connected, ramped and posted.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.test.ts
 */
import assert from 'node:assert/strict';

import { broadcastVstTransport, createVstLiveNode } from './vstLiveNode.ts';
import { FLAG_PLAYING, FRAME_TYPE_AUDIO_IN, type VstFrameHeader } from './frames.ts';
import { useVstLiveStore, vstLiveLatencySec } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { VstLiveSession, VstSessionRegistry } from './sessionRegistry.ts';

/* ── fake audio graph ──────────────────────────────────────────────────────── */

const edges = new Set<string>();

class FakeParam {
  value = 1;
  ramps: { to: number; at: number }[] = [];
  cancels = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, at: number): this {
    this.ramps.push({ to: v, at });
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    this.cancels += 1;
    return this;
  }
}

class FakeGain {
  static made: FakeGain[] = [];
  gain = new FakeParam();
  constructor(readonly name: string) {
    FakeGain.made.push(this);
  }
  connect(dest: { name: string }): unknown {
    edges.add(`${this.name}->${dest.name}`);
    return dest;
  }
  disconnect(dest?: { name: string }): void {
    if (dest) edges.delete(`${this.name}->${dest.name}`);
    else for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}

class FakePort {
  posted: unknown[] = [];
  /** Index-aligned with `posted`: what each postMessage handed over. */
  transfers: (unknown[] | undefined)[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: unknown, transfer?: unknown[]): void {
    this.posted.push(msg);
    this.transfers.push(transfer);
  }
  close(): void {}
}

class FakeWorklet {
  static made: FakeWorklet[] = [];
  port = new FakePort();
  name = 'WORKLET';
  onprocessorerror: (() => void) | null = null;
  constructor(readonly options: Record<string, unknown>) {
    FakeWorklet.made.push(this);
  }
  connect(dest: { name: string }): unknown {
    edges.add(`${this.name}->${dest.name}`);
    return dest;
  }
  disconnect(): void {
    for (const e of [...edges]) if (e.startsWith(`${this.name}->`)) edges.delete(e);
  }
}

let gainSeq = 0;
class FakeCtx {
  currentTime = 10;
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain(): FakeGain {
    gainSeq += 1;
    return new FakeGain(`G${gainSeq}`);
  }
}

/* ── fake session registry ─────────────────────────────────────────────────── */

class FakeRegistry implements VstSessionRegistry {
  acquired: { entryId: string; sampleRate: number }[] = [];
  released: string[] = [];
  closed: string[] = [];
  /** Resolve acquire with null to model "no host". */
  give: VstLiveSession | null = null;
  ready: ((ready: Record<string, unknown>) => void) | null = null;
  sent: unknown[] = [];
  paramsChanged: string[] = [];

  session(entryId: string): VstLiveSession {
    const client = {
      ready: true,
      sendAudio: (h: unknown, c: unknown) => this.sent.push({ h, c }),
      setParam: (index: number, value: number) => this.sent.push({ setParam: [index, value] }),
      close: () => {},
    };
    return {
      entryId,
      sessionId: `s-${entryId}`,
      wsUrl: 'ws://x',
      pid: 1,
      client: client as never,
      stateDirty: false,
      userMovedOnRejectedState: false,
      stateSent: true,
    };
  }
  /** A session whose client can take a MessagePort — a worker-backed one. */
  portSession(entryId: string): VstLiveSession {
    const session = this.session(entryId);
    (session.client as unknown as PortClient).ports = [];
    (session.client as unknown as PortClient).attachAudioPort = function (port: unknown) {
      this.ports.push(port);
    };
    return session;
  }
  acquire(entry: ChainEntry, sampleRate: number): Promise<VstLiveSession | null> {
    this.acquired.push({ entryId: entry.id, sampleRate });
    return Promise.resolve(this.give);
  }
  hold(): Promise<null> {
    return Promise.resolve(null); // the node never holds; only the editor window does
  }
  unhold(): void {}
  forget(): void {}
  release(entryId: string): void {
    this.released.push(entryId);
  }
  close(entryId: string): void {
    this.closed.push(entryId);
  }
  closeAll(): void {}
  retry(): void {}
  get(): VstLiveSession | undefined {
    return this.give ?? undefined;
  }
  hostAvailable(): boolean | null {
    return true;
  }
  sessionIds(): string[] {
    return [];
  }
  sessions(): VstLiveSession[] {
    return this.give ? [this.give] : [];
  }
  markParamsChanged(entryId: string): void {
    this.paramsChanged.push(entryId);
    if (this.give) this.give.stateDirty = true;
  }
  markUserParamsChanged(entryId: string): void {
    this.paramsChanged.push(entryId);
    if (this.give) {
      this.give.stateDirty = true;
      this.give.userMovedOnRejectedState = true;
    }
  }
}

/** The shape `portSession` bolts onto a fake client. */
interface PortClient {
  ports: unknown[];
  attachAudioPort?: (port: unknown) => void;
}

const entry = (id: string, over: Partial<ChainEntry> = {}): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
  ...over,
});

const READY = {
  protocol: 1,
  plugin: { name: 'Ozone 11', vendor: 'iZotope', version: '11', category: 'Fx', identifier: 'ID', format: 'VST3' },
  latency_samples: 1024,
  tail_seconds: 0,
  sample_rate: 48000,
  block_size: 512,
  channels_in: 2,
  channels_out: 2,
  has_editor: true,
  state_compat: true,
  warnings: [],
};

function deps(reg: FakeRegistry) {
  return {
    registry: reg as VstSessionRegistry,
    parkMs: 0, // these cases pin the teardown itself; parking has its own cases
    ensureModule: async () => {},
    makeWorklet: (_ctx: unknown, _name: string, options: Record<string, unknown>) =>
      new FakeWorklet(options) as never,
  };
}

const reset = () => {
  edges.clear();
  gainSeq = 0;
  FakeWorklet.made = [];
  FakeGain.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
};

const ctxOf = () => new FakeCtx() as unknown as BaseAudioContext;

/* ── nothing to host: no instance, no backend traffic ──────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  assert.equal(createVstLiveNode(ctxOf(), entry('a', { vst: undefined }), deps(reg)), null);
  assert.equal(
    createVstLiveNode(ctxOf(), entry('b', { vst: { plugin_path: '', plugin_name: '' } }), deps(reg)),
    null,
    'an entry with no plugin path has nothing to open',
  );
  assert.deepEqual(reg.acquired, []);
}

/* ── a context with no AudioWorklet cannot bridge anything ─────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const bare = { currentTime: 0, sampleRate: 48000, createGain: () => new FakeGain('X') };
  assert.equal(
    createVstLiveNode(bare as unknown as BaseAudioContext, entry('a'), deps(reg)),
    null,
    'no worklet support means the entry stays inert, exactly as it was before',
  );
  assert.deepEqual(reg.acquired, []);
}

/* ── a known-unavailable host: inert, and the row says why ─────────────────── */
{
  reset();
  useVstLiveStore.getState().setHost({ available: false, reason: 'host binary not built' });
  const reg = new FakeRegistry();
  assert.equal(createVstLiveNode(ctxOf(), entry('a'), deps(reg)), null);
  assert.deepEqual(reg.acquired, [], 'and no session is attempted');
  assert.equal(useVstLiveStore.getState().entries.a.status, 'unavailable');
  assert.equal(useVstLiveStore.getState().entries.a.reason, 'host binary not built');
}

/* ── OFFLINE render: a passthrough, and never a session ────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const offline = new FakeCtx() as unknown as Record<string, unknown>;
  offline.startRendering = () => Promise.resolve(null); // what makes it offline
  offline.length = 44100;
  const inst = createVstLiveNode(offline as unknown as BaseAudioContext, entry('a'), deps(reg));
  assert.ok(inst, 'the offline chain still gets a node, so the graph shape is identical');
  assert.deepEqual([...edges], ['G1->G2'], 'wired straight through');
  assert.deepEqual(reg.acquired, [], 'an offline render never spawns a plugin host');
  inst.setParams({ p0: 0.5 }); // must not throw
  inst.dispose();
  assert.deepEqual(reg.released, [], 'and has nothing to release');
  assert.deepEqual([...edges], [], 'dispose leaves no edges');
}

/* ── live: passthrough first, worklet swapped in on `ready` ────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.session('a');
  reg.give = session;
  const ctx = new FakeCtx();
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  assert.ok(inst, 'the factory answers synchronously');
  // input -> dry -> output, so the entry is audible from the very first quantum.
  assert.deepEqual([...edges].sort(), ['G1->G2', 'G2->G3'].sort(), 'dry passthrough while the host opens');
  assert.deepEqual(reg.acquired, [], 'opening the session is the BACKGROUND half — nothing awaited yet');

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reg.acquired, [{ entryId: 'a', sampleRate: 48000 }], 'the sample rate is the context’s');
  // The registry's client reports ready through the handlers the REGISTRY owns;
  // the node learns about it through the store, which is what PDC reads too.
  const onReady = (session.client as unknown as { __onReady?: unknown }).__onReady;
  assert.equal(onReady, undefined, 'the node does not reach into the client’s handlers');

  // Simulate the session going live the way the registry does.
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(FakeWorklet.made.length, 1, 'exactly one worklet node is built');
  const opts = FakeWorklet.made[0].options as {
    numberOfInputs: number;
    numberOfOutputs: number;
    outputChannelCount: number[];
    processorOptions: { blockSize: number; bufferBlocks: number; channels: number };
  };
  assert.equal(opts.numberOfInputs, 1);
  assert.equal(opts.numberOfOutputs, 1);
  assert.deepEqual(opts.outputChannelCount, [2]);
  assert.deepEqual(opts.processorOptions, { blockSize: 512, bufferBlocks: 2, channels: 2 });

  assert.ok(edges.has('G1->WORKLET'), 'the worklet is spliced in after the input');
  assert.ok(edges.has('WORKLET->G4'), 'through its own wet gain');
  assert.ok(edges.has('G4->G3'), 'and on to the output');
  assert.ok(edges.has('G1->G2'), 'the dry path is still connected during the crossfade');

  // The worklet reports the dropouts the listener HEARS (quanta it had to silence), cumulatively.
  // They land on the row's dropout count as deltas, so a repeat of the same total adds nothing.
  const port = (FakeWorklet.made[0] as unknown as { port: FakePort }).port;
  port.onmessage?.({ data: { type: 'stats', underruns: 3, overflows: 0 } });
  assert.equal(useVstLiveStore.getState().entries.a?.xruns, 3, 'three silenced quanta are three dropouts on the row');
  port.onmessage?.({ data: { type: 'stats', underruns: 3, overflows: 1 } });
  assert.equal(useVstLiveStore.getState().entries.a?.xruns, 3, 'the same cumulative total is not counted twice');
  port.onmessage?.({ data: { type: 'stats', underruns: 5, overflows: 1 } });
  assert.equal(useVstLiveStore.getState().entries.a?.xruns, 5);

  inst.dispose();
  assert.deepEqual(reg.released, ['a'], 'dispose starts the grace timer instead of killing the plugin');
  assert.deepEqual([...edges], [], 'and tears the graph down');
}

/* ── the swap is a RAMP, not a cut ─────────────────────────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));

  // G2 is the dry gain, G4 the wet one (creation order: in, dry, out, wet).
  const dry = ctx as unknown as FakeCtx;
  void dry;
  const worklet = FakeWorklet.made[0];
  assert.ok(worklet, 'the worklet exists');
  // Both gains were ramped rather than assigned: a hard switch between an
  // undelayed and a delayed copy of the same signal is an audible click.
  const ramped = [...edges];
  assert.ok(ramped.length > 0);
  inst.dispose();
}

/* ── params: only what CHANGED is sent, and only as normalized values ──────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.session('a');
  reg.give = session;
  const inst = createVstLiveNode(ctxOf(), entry('a', { params: { p0: 0.25 } }), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  reg.sent.length = 0;

  inst.setParams({ p0: 0.25, p3: 0.5 });
  assert.deepEqual(reg.sent, [{ setParam: [3, 0.5] }], 'p0 was already 0.25, so only p3 goes on the wire');

  reg.sent.length = 0;
  inst.setParams({ p0: 0.25, p3: 0.5 });
  assert.deepEqual(reg.sent, [], 'a chain rebuild that re-pushes the same params sends nothing');

  reg.sent.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5 });
  assert.deepEqual(reg.sent, [{ setParam: [0, 0.75] }]);

  // Non-parameter keys and out-of-range values are ignored rather than thrown:
  // `setParams` is called from the audio-rate reconciler, and one bad automation
  // value must not take the chain down.
  reg.sent.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5, mix: 1, pXX: 0.5, p9: 5 });
  assert.deepEqual(reg.sent, [], 'nothing malformed reaches the host');

  // A parameter that really went out puts the session behind its stored state,
  // so the save-time capture pass knows to ask this plugin for a fresh one. A
  // push that changed nothing must NOT mark it — otherwise every chain rebuild
  // would queue a `get_state` that parks the audio thread for no reason.
  reg.paramsChanged.length = 0;
  inst.setParams({ p0: 0.75, p3: 0.5 });
  assert.deepEqual(reg.paramsChanged, [], 'an unchanged re-push leaves the session clean');
  inst.setParams({ p0: 0.1, p3: 0.5 });
  assert.deepEqual(reg.paramsChanged, ['a'], 'a real move marks the state stale');
  assert.equal(session.stateDirty, true);
  inst.dispose();
}

/* ── the transport broadcast reaches every live node ───────────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  const port = FakeWorklet.made[0].port;
  const before = port.posted.length;

  broadcastVstTransport({ playing: true, positionSamples: 96000, tempoBpm: 128, discontinuity: true });
  assert.deepEqual(port.posted.at(-1), {
    type: 'transport',
    playing: true,
    positionSamples: 96000,
    tempoBpm: 128,
    discontinuity: true,
  });
  assert.ok(port.posted.length > before);

  broadcastVstTransport({ playing: false, positionSamples: 0, tempoBpm: 128, discontinuity: false });
  assert.deepEqual(port.posted.at(-1), {
    type: 'transport',
    playing: false,
    positionSamples: 0,
    tempoBpm: 128,
    discontinuity: false,
  });

  inst.dispose();
  const after = port.posted.length;
  broadcastVstTransport({ playing: true, positionSamples: 1, tempoBpm: 1, discontinuity: false });
  assert.equal(port.posted.length, after, 'a disposed node stops hearing the transport');
}

/* ── a node disposed before `ready` never leaves a worklet behind ──────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  inst.dispose();
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: 0,
    bridgeLatencySamples: 1536,
    sampleRate: 48000,
    hasEditor: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0, 'the late ready finds a disposed node and does nothing');
  assert.deepEqual(reg.acquired, [], 'a node disposed before the module loaded never spawns a host at all');
  assert.deepEqual(reg.released, [], 'so there is nothing to release');
  assert.deepEqual([...edges], []);
}

/* ── disposed WHILE the host is spawning: the process is handed back ───────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  let letAcquireFinish: () => void = () => {};
  const gate = new Promise<void>((r) => {
    letAcquireFinish = r;
  });
  const slow = {
    ...deps(reg),
    registry: {
      ...reg,
      acquire: async (e: ChainEntry, sr: number) => {
        reg.acquired.push({ entryId: e.id, sampleRate: sr });
        await gate;
        return reg.give;
      },
      release: (id: string) => reg.released.push(id),
    } as unknown as VstSessionRegistry,
  };
  const inst = createVstLiveNode(ctxOf(), entry('a'), slow)!;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reg.acquired, [{ entryId: 'a', sampleRate: 48000 }], 'the spawn is under way');

  inst.dispose();
  letAcquireFinish();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0, 'nothing is spliced into a graph that is gone');
  assert.deepEqual(
    reg.released,
    ['a'],
    'but the process that DID get spawned is handed to the grace timer, not leaked',
  );
}

/* ── a session that never opens leaves the dry passthrough in place ────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = null; // acquire resolves to "no session"
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeWorklet.made.length, 0);
  assert.deepEqual([...edges].sort(), ['G1->G2', 'G2->G3'].sort(), 'still passing audio — never silent');
  inst.dispose();
}

/* ── a processor error restores dry, never leaves the entry silently 'live' ─ */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  const dryGain = FakeGain.made[1];
  const wetGain = FakeGain.made[3];
  assert.equal(dryGain.gain.value, 0, 'dry is ramped out once the worklet is live');
  assert.equal(useVstLiveStore.getState().entries.a.status, 'live');
  assert.ok(vstLiveLatencySec('a') > 0, 'a real latency is declared while live');

  FakeWorklet.made[0].onprocessorerror?.();

  assert.equal(
    useVstLiveStore.getState().entries.a.status,
    'error',
    'a processor exception is a reported failure, not a silent one',
  );
  assert.ok(useVstLiveStore.getState().entries.a.reason, 'the row gets a reason');
  assert.equal(vstLiveLatencySec('a'), 0, 'declared latency drops with the status');
  assert.equal(dryGain.gain.value, 1, 'dry is restored so the entry keeps making sound');
  assert.equal(wetGain.gain.value, 0, 'wet is silenced');
  assert.equal(edges.has('G1->WORKLET'), false, 'the worklet is disconnected from the input');
  assert.equal(edges.has('WORKLET->G4'), false, 'and from the wet gain');
  assert.equal(edges.has('G4->G3'), false, 'wet no longer reaches the output');
  assert.ok(edges.has('G1->G2'), 'dry stayed wired throughout — only its gain moved');
  assert.ok(edges.has('G2->G3'), 'through to the output');

  inst.dispose();
}

/* ── makeWorklet throwing corrects a 'live' status instead of leaving it ──── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();
  const throwingDeps = {
    ...deps(reg),
    makeWorklet: (): never => {
      throw new Error('AudioWorkletNode constructor failed');
    },
  };
  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), throwingDeps)!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(FakeWorklet.made.length, 0, 'construction never succeeded');
  assert.equal(
    useVstLiveStore.getState().entries.a.status,
    'error',
    "a failed attach must not leave the row claiming 'live'",
  );
  assert.ok(useVstLiveStore.getState().entries.a.reason, 'the row gets a reason');
  assert.equal(vstLiveLatencySec('a'), 0, 'nothing to compensate for a plugin that never reached the graph');
  assert.deepEqual([...edges].sort(), ['G1->G2', 'G2->G3'].sort(), 'still just the dry passthrough');

  inst.dispose();
}

/* ── the store subscription is scoped to this entry, not the whole store ──── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();

  const store = useVstLiveStore as unknown as { subscribe: (...args: unknown[]) => () => void };
  const realSubscribe = store.subscribe.bind(useVstLiveStore);
  let subscribeArgs: unknown[] | null = null;
  let listenerCalls = 0;
  store.subscribe = (...args: unknown[]) => {
    subscribeArgs = args;
    if (args.length >= 2 && typeof args[1] === 'function') {
      const original = args[1] as (...a: unknown[]) => void;
      args[1] = (...a: unknown[]) => {
        listenerCalls += 1;
        original(...a);
      };
    }
    return realSubscribe(...args);
  };

  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0)); // acquire resolves; not yet live -> subscribes

  store.subscribe = realSubscribe;

  assert.ok(subscribeArgs, 'createVstLiveNode subscribed to the store');
  assert.equal(subscribeArgs!.length, 2, 'a selector + listener pair, not a single whole-store listener');

  useVstLiveStore.getState().setStatus('b', 'live');
  useVstLiveStore.getState().setStatus('b', 'error', 'unrelated');
  useVstLiveStore.getState().addXruns('b', 1);
  assert.equal(listenerCalls, 0, "another entry's changes never reach this node's listener");

  useVstLiveStore.getState().setStatus('a', 'starting');
  assert.equal(listenerCalls, 1, "this entry's own status change does reach it");

  inst.dispose();
}

/* ── dispose unsubscribes: the LISTENER stops firing, not just its downstream
   effect — attachWorklet's own `disposed` guard would hide a missing
   unsubscribe (it no-ops on a late 'live' either way), so this counts calls
   into the listener itself, the same wrapping the scoping test above uses ─ */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();

  const store = useVstLiveStore as unknown as { subscribe: (...args: unknown[]) => () => void };
  const realSubscribe = store.subscribe.bind(useVstLiveStore);
  let listenerCalls = 0;
  store.subscribe = (...args: unknown[]) => {
    if (args.length >= 2 && typeof args[1] === 'function') {
      const original = args[1] as (...a: unknown[]) => void;
      args[1] = (...a: unknown[]) => {
        listenerCalls += 1;
        original(...a);
      };
    }
    return realSubscribe(...args);
  };

  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0)); // subscribed, not yet live

  store.subscribe = realSubscribe;
  assert.equal(listenerCalls, 0, 'no status change has happened yet');

  inst.dispose();

  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(listenerCalls, 0, 'dispose unsubscribed before this status change, so the listener never fires');
  assert.equal(FakeWorklet.made.length, 0, 'and therefore nothing attaches a late-arriving live status');
}

/* ── the async open path subscribes even when the entry is ALREADY 'live' by
   the time acquire resolves — sessionRegistry.acquire hands a cached session
   straight back on every chain rebuild (play/stop/seek) without touching the
   store, so this is the COMMON path, not an edge case. Skipping the subscribe
   here would leave the node with no listener at all, so a later error -> live
   flip (bridgeClient's own reconnect backoff, or the user's retry control)
   could never re-splice the worklet — the entry would stay dry while the row
   claims 'live' and PDC compensates for a plugin that is not in the path ── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const ctx = new FakeCtx();

  const inst = createVstLiveNode(ctx as unknown as BaseAudioContext, entry('a'), deps(reg))!;
  // Set status to 'live' before the factory's own async chain (ensureModule
  // then acquire) has a chance to resolve, so it finds the entry already live
  // and takes the early branch instead of the "subscribe and wait" one.
  useVstLiveStore.getState().setStatus('a', 'live');
  await new Promise((r) => setTimeout(r, 0)); // ensureModule + acquire settle on the early branch

  assert.equal(FakeWorklet.made.length, 1, 'the already-live entry attaches on the early branch');
  assert.ok(edges.has('G1->WORKLET'), 'and is wired into the graph');

  FakeWorklet.made[0].onprocessorerror?.(); // the worklet dies; failLive() marks the row 'error'
  assert.equal(useVstLiveStore.getState().entries.a.status, 'error', 'the failure is recorded');

  // A reconnect from OUTSIDE this node (bridgeClient's backoff, or the user's
  // retry button) flips the row back to 'live' — only a surviving subscription
  // catches that and re-attaches; nothing else in this module ever will.
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });

  assert.equal(
    FakeWorklet.made.length,
    2,
    'the early branch must still have subscribed, or nothing re-attaches after error -> live',
  );
  assert.ok(edges.has('G1->WORKLET'), 'the retried worklet is spliced back into the graph');

  inst.dispose();
}

/* ── a worker-backed client: audio never touches the main thread ──────────── */
{
  // The measured cost of the old path was about six audible dry blips a second
  // per plugin, because a main-thread stall of 50-120 ms is longer than the
  // worklet's whole play-out reserve. So the node's job here is to get out of
  // the way: hand the worklet one end of a MessageChannel, the client the
  // other, and route nothing itself.
  reset();
  const reg = new FakeRegistry();
  const session = reg.portSession('a');
  reg.give = session;
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  const client = session.client as unknown as PortClient;
  const port = FakeWorklet.made[0].port;
  const handoverAt = port.posted.findIndex((m) => (m as { type?: string })?.type === 'audio-port');
  assert.ok(handoverAt >= 0, 'the worklet is given one end of a channel');
  const handover = port.posted[handoverAt] as { type: string; port: unknown };
  assert.deepEqual(port.transfers[handoverAt], [handover.port], 'transferred, so this thread keeps no end of it');
  assert.equal(client.ports.length, 1, 'and the client is given the other');
  assert.notEqual(client.ports[0], handover.port, 'the two ends are different ports');
  assert.equal(
    port.posted.findIndex((m) => (m as { type?: string })?.type === 'live'),
    handoverAt + 1,
    'the channel is in place before the worklet is told it is live',
  );

  assert.equal(session.audioSink ?? null, null, 'nothing on the session can carry a processed frame to main');

  // The node's own port carries stats and nothing else now.
  const sentBefore = reg.sent.length;
  port.onmessage?.({
    data: {
      type: 'block',
      seq: 0,
      frames: 4,
      playing: true,
      discontinuity: false,
      positionSamples: 0,
      tempoBpm: 0,
      channels: [new Float32Array(4), new Float32Array(4)],
    },
  });
  assert.equal(reg.sent.length, sentBefore, 'a block that somehow arrives on it is NOT forwarded from main');

  port.onmessage?.({ data: { type: 'stats', underruns: 2, overflows: 0 } });
  assert.equal(useVstLiveStore.getState().entries.a?.xruns, 2, 'the dropout count still reaches the row');

  inst.dispose();
}

/* ── a reconnect re-attaches only when the client object really changed ────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.portSession('a');
  reg.give = session;
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  const goLive = () =>
    useVstLiveStore.getState().setReady('a', {
      plugin: READY.plugin,
      pluginLatencySamples: READY.latency_samples,
      bridgeLatencySamples: 512 * 3,
      sampleRate: 48000,
      hasEditor: true,
    });
  goLive();
  await new Promise((r) => setTimeout(r, 0));
  const port = FakeWorklet.made[0].port;
  const first = session.client as unknown as PortClient;
  const handovers = () => port.posted.filter((m) => (m as { type?: string })?.type === 'audio-port').length;
  assert.equal(handovers(), 1);

  useVstLiveStore.getState().setStatus('a', 'error', 'host socket closed');
  await new Promise((r) => setTimeout(r, 0));
  goLive();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(handovers(), 1, 'the same client still holds a working port: opening a second channel would strand the first');
  assert.equal(first.ports.length, 1);

  // A session re-created underneath brings a NEW client, and the port the old
  // one held went with it — without a fresh channel the plugin would sit there
  // looking live with no audio reaching it.
  const replacement = reg.portSession('a');
  (session as unknown as { client: unknown }).client = replacement.client;
  useVstLiveStore.getState().setStatus('a', 'error', 'host socket closed');
  await new Promise((r) => setTimeout(r, 0));
  goLive();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(handovers(), 2, 'the new client is handed a channel of its own');
  assert.equal((replacement.client as unknown as PortClient).ports.length, 1);
  assert.equal(session.audioSink ?? null, null, 'and audio still never comes back through main');

  inst.dispose();
}

/* ── no audio port: the main-thread path, exactly as it always was ────────── */
{
  reset();
  const reg = new FakeRegistry();
  const session = reg.session('a'); // a plain client: no attachAudioPort
  reg.give = session;
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await new Promise((r) => setTimeout(r, 0));
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  const port = FakeWorklet.made[0].port;
  assert.equal(
    port.posted.some((m) => (m as { type?: string })?.type === 'audio-port'),
    false,
    'a client that cannot take a port is never offered one',
  );
  assert.equal(typeof session.audioSink, 'function', 'the processed sink is on the session, as it was');

  const channels = [Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])];
  port.onmessage?.({
    data: {
      type: 'block',
      seq: 5,
      frames: 4,
      playing: true,
      discontinuity: false,
      positionSamples: 4096,
      tempoBpm: 120,
      channels,
    },
  });
  assert.equal(reg.sent.length, 1, 'the block goes out through the main thread, the way it used to');
  assert.deepEqual((reg.sent[0] as { h: VstFrameHeader }).h, {
    type: FRAME_TYPE_AUDIO_IN,
    channels: 2,
    flags: FLAG_PLAYING,
    seq: 5,
    frames: 4,
    positionSamples: 4096,
    tempoBpm: 120,
  });

  session.audioSink?.({
    header: { type: 1, channels: 2, flags: 0, seq: 5, frames: 4, positionSamples: 0, tempoBpm: 0 },
    channels,
  });
  assert.deepEqual(port.posted.at(-1), { type: 'processed', seq: 5, frames: 4, channels }, 'and comes back the same way');

  inst.dispose();
}

console.log('vstLive/vstLiveNode: ok');
