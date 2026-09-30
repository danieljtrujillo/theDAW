/**
 * vstLive/vstLiveNode — re-arming the worklet when a dropped host reconnects.
 *
 * A dropped session (`error`) leaves the worklet passing dry signal through
 * (`{type:'live', live:false}`) without tearing it out of the graph — see
 * `vstLiveNode.test.ts`'s processor-error case for the OTHER kind of drop,
 * where the worklet really is torn out. Before this fix, the return to
 * `live` found `attachWorklet`'s own `if (worklet) return;` guard already
 * satisfied and did nothing: the entry stayed dry for the rest of the node's
 * life. `relive` is the branch taken when a worklet already exists — it
 * re-posts the live flag, resyncs the transport and re-pushes every plugin
 * parameter to the (possibly respawned) session.
 *
 * Fakes copied from vstLiveNode.test.ts.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.reconnect.test.ts
 */
import assert from 'node:assert/strict';

import { createVstLiveNode } from './vstLiveNode.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { VstLiveSession, VstSessionRegistry } from './sessionRegistry.ts';

/* ── fakes (copied from vstLiveNode.test.ts) ──────────────────────────────── */

class FakeParam {
  value = 1;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
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
    return dest;
  }
  disconnect(): void {}
}

class FakePort {
  posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: unknown): void {
    this.posted.push(msg);
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
    return dest;
  }
  disconnect(): void {}
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
  give: VstLiveSession | null = null;
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

const entry = (id: string, over: Partial<ChainEntry> = {}): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
  ...over,
});

const READY = {
  plugin: { name: 'Ozone 11', vendor: 'iZotope', version: '11', category: 'Fx', identifier: 'ID', format: 'VST3' },
  latency_samples: 1024,
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
  gainSeq = 0;
  FakeWorklet.made = [];
  FakeGain.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
};

const ctxOf = () => new FakeCtx() as unknown as BaseAudioContext;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The registry's `onReady` handler on a real reconnect — same call the
 *  bridge client makes whether this is the FIRST go-live or a respawn. */
const goLive = () =>
  useVstLiveStore.getState().setReady('a', {
    plugin: READY.plugin,
    pluginLatencySamples: READY.latency_samples,
    bridgeLatencySamples: 512 * 3,
    sampleRate: 48000,
    hasEditor: true,
  });

/* ── cases 1-3: drop, then reconnect, then the resync that follows it ─────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await tick(); // ensureModule + acquire settle, subscription registers

  goLive();
  await tick();
  assert.equal(FakeWorklet.made.length, 1, 'the worklet attaches on the first go-live');
  const port = FakeWorklet.made[0].port;
  const afterAttach = port.posted.length;

  // Case 1: "a dropped session posts live:false once"
  useVstLiveStore.getState().setStatus('a', 'error', 'host socket closed');
  await tick();
  assert.deepEqual(
    port.posted.slice(afterAttach),
    [{ type: 'live', live: false }],
    'exactly one live:false, and nothing else, on the drop',
  );

  // Case 2: "a reconnected session posts live:true again" — fails on baseline,
  // where attachWorklet's `if (worklet) return;` guard eats this silently.
  const beforeReconnect = port.posted.length;
  goLive();
  await tick();
  assert.equal(FakeWorklet.made.length, 1, 'the SAME worklet is reused — this is a re-arm, not a rebuild');
  const reconnectMsgs = port.posted.slice(beforeReconnect);
  assert.deepEqual(
    reconnectMsgs[0],
    { type: 'live', live: true },
    'a reconnect posts live:true again, after the earlier live:false',
  );

  // Case 3: "the reconnect resyncs the transport"
  assert.deepEqual(
    reconnectMsgs[1],
    { type: 'transport', playing: false, positionSamples: 0, tempoBpm: 0, discontinuity: true },
    'the message right after live:true is a transport resync with discontinuity',
  );

  inst.dispose();
}

/* ── case 4: the reconnect re-pushes the entry's plugin params ─────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a', { params: { p3: 0.25 } }), deps(reg))!;
  await tick();

  goLive();
  await tick();
  assert.deepEqual(reg.sent, [{ setParam: [3, 0.25] }], 'the first go-live pushes the saved param');

  useVstLiveStore.getState().setStatus('a', 'error', 'host socket closed');
  await tick();
  reg.sent.length = 0; // only care about what the RECONNECT itself sends

  goLive();
  await tick();
  assert.deepEqual(
    reg.sent,
    [{ setParam: [3, 0.25] }],
    'a respawned plugin starts from its state file, so the diff map must not suppress the re-push',
  );

  inst.dispose();
}

/* ── case 5: a reconnect on a disposed node posts nothing ──────────────────── */
{
  reset();
  const reg = new FakeRegistry();
  reg.give = reg.session('a');
  const inst = createVstLiveNode(ctxOf(), entry('a'), deps(reg))!;
  await tick();

  goLive();
  await tick();
  const port = FakeWorklet.made[0].port;

  useVstLiveStore.getState().setStatus('a', 'error', 'host socket closed');
  await tick();

  inst.dispose();
  const afterDispose = port.posted.length;

  goLive();
  await tick();
  assert.equal(port.posted.length, afterDispose, 'dispose unsubscribed — a later reconnect reaches nothing');
}

console.log('vstLive/vstLiveNode.reconnect: ok');
