/**
 * vstLive/bridgeWorkerClient + bridgeWorker — the live bridge, off the main thread.
 *
 * Every real audio host keeps the audio callback off the message thread. The
 * browser's main thread is theDAW's message thread: it lays out the timeline,
 * paints the meters and runs React, and a 50-120 ms stall there used to land
 * straight in the plugin's signal path, because every block crossed main twice
 * on its way to the host and back. The worker owns the socket instead, and main
 * carries nothing but control ops and events.
 *
 * So the two halves are tested for exactly that: the WORKER half must turn
 * commands into client calls and client events into messages (and must never
 * post audio to main), and the MAIN half must look like `VstBridgeClient` to
 * everything that already uses one.
 *
 * No real `Worker`, no real `WebSocket`, no real `MessagePort`: fakes, so the
 * whole thing runs under plain tsx.
 *
 * Run: npx tsx src/lib/vstLive/bridgeWorkerClient.test.ts
 */
import assert from 'node:assert/strict';

import {
  createBridgeWorker,
  BRIDGE_WORKER_STATS_MS,
  type BridgeAudioPort,
  type BridgeWorkerCommand,
  type BridgeWorkerEvent,
} from './bridgeWorker.ts';
import {
  createDefaultBridgeClient,
  VstBridgeWorkerClient,
  VST_MAIN_THREAD_BRIDGE_KEY,
  VST_BRIDGE_URL_PUSH_MS,
  type BridgeWorkerLike,
} from './bridgeWorkerClient.ts';
import { VstBridgeClient, type VstBridgeClientLike, type VstBridgeClientOptions, type VstBridgeStats } from './bridgeClient.ts';
import { LIVE_EDITOR_SUPPRESSED_LOG, NO_EDITOR_WINDOWS_KEY } from './editorWindowSwitch.ts';
import { FRAME_TYPE_AUDIO_IN, FLAG_PLAYING, type VstFrame, type VstFrameHeader } from './frames.ts';

/* ── fakes ─────────────────────────────────────────────────────────────────── */

/** A deterministic timer wheel: nothing runs until the test advances it. */
class FakeClock {
  private t = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  schedule = (fn: () => void, ms: number): number => {
    const id = this.next;
    this.next += 1;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  cancel = (id: number): void => {
    this.timers.delete(id);
  };
  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= until && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = until;
  }
  get pending(): number {
    return this.timers.size;
  }
}

/** One end of a MessageChannel, as the worklet and the worker use it. */
class FakePort implements BridgeAudioPort {
  posted: { msg: unknown; transfer?: unknown[] }[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closes = 0;
  starts = 0;
  postMessage(msg: unknown, transfer?: unknown[]): void {
    this.posted.push({ msg, transfer });
  }
  close(): void {
    this.closes += 1;
  }
  start(): void {
    this.starts += 1;
  }
  /** Drive a message in, the way the worklet would. */
  say(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A stand-in for `VstBridgeClient`: records every call, and hands the test the
 *  handlers so it can play the host. */
class FakeClient implements VstBridgeClientLike {
  static made: FakeClient[] = [];
  calls: { name: string; args: unknown[] }[] = [];
  ready = false;
  blockSize = 0;
  sampleRate = 0;
  channelsOut = 0;
  pluginLatencySamples = 0;
  hasEditor = false;
  readonly stats: VstBridgeStats = {
    lateBlocks: 0,
    maxProcessMs: 0,
    rttMs: -1,
    outOfOrder: 0,
    droppedIn: 0,
    badFrames: 0,
    badMessages: 0,
    reconnects: 0,
  };
  constructor(readonly opts: VstBridgeClientOptions) {
    FakeClient.made.push(this);
  }
  private note(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
  connect(): void {
    this.note('connect');
  }
  close(): void {
    this.note('close');
    this.opts.handlers.onStatus?.('off');
  }
  retryNow(): void {
    this.note('retryNow');
  }
  sendAudio(header: VstFrameHeader, channels: readonly Float32Array[]): void {
    this.note('sendAudio', header, channels);
  }
  setParam(index: number, value: number): void {
    this.note('setParam', index, value);
  }
  getParams(): void {
    this.note('getParams');
  }
  paramText(index: number, value: number): void {
    this.note('paramText', index, value);
  }
  setState(stateB64: string): void {
    this.note('setState', stateB64);
  }
  getState(): void {
    this.note('getState');
  }
  openEditor(o: Record<string, unknown> = {}): void {
    this.note('openEditor', o);
  }
  editorRect(rect: { x: number; y: number; w: number; h: number }): void {
    this.note('editorRect', rect);
  }
  closeEditor(): void {
    this.note('closeEditor');
  }
  bypass(on: boolean): void {
    this.note('bypass', on);
  }
  ping(): void {
    this.note('ping');
  }
  /** Say the host answered `ready`, the way the socket would. */
  goLive(): void {
    this.ready = true;
    this.blockSize = 512;
    this.sampleRate = 48000;
    this.channelsOut = 2;
    this.pluginLatencySamples = 1024;
    this.hasEditor = true;
    this.opts.handlers.onStatus?.('live');
    this.opts.handlers.onReady?.(READY);
  }
}

/** A stand-in for the `Worker` the main-thread proxy owns. */
class FakeWorker implements BridgeWorkerLike {
  static made: FakeWorker[] = [];
  posted: { msg: BridgeWorkerCommand; transfer?: unknown[] }[] = [];
  terminated = 0;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(msg: unknown, transfer?: unknown[]): void {
    this.posted.push({ msg: msg as BridgeWorkerCommand, transfer });
  }
  terminate(): void {
    this.terminated += 1;
  }
  /** Drive an event out of the worker. */
  say(ev: BridgeWorkerEvent): void {
    this.onmessage?.({ data: ev });
  }
  cmds(): BridgeWorkerCommand[] {
    return this.posted.map((p) => p.msg);
  }
}

const READY = {
  protocol: 1,
  plugin: { name: 'Pro-Q 4', vendor: 'FabFilter', version: '4', category: 'Fx|EQ', identifier: 'ID', format: 'VST3' },
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

const block = (over: Record<string, unknown> = {}) => ({
  type: 'block',
  seq: 3,
  frames: 4,
  playing: true,
  discontinuity: false,
  positionSamples: 4096,
  tempoBpm: 120,
  channels: [Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])],
  ...over,
});

const frame = (seq: number): VstFrame => ({
  header: { type: 1, channels: 2, flags: 0, seq, frames: 4, positionSamples: 0, tempoBpm: 0 },
  channels: [Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])],
});

/** A worker entry wired to a fake client and a fake clock. */
function worker() {
  FakeClient.made = [];
  const clock = new FakeClock();
  const posted: BridgeWorkerEvent[] = [];
  const transfers: (unknown[] | undefined)[] = [];
  const entry = createBridgeWorker({
    post: (msg, transfer) => {
      posted.push(msg);
      transfers.push(transfer);
    },
    makeClient: (opts) => new FakeClient(opts),
    now: clock.now,
  });
  const init = (url = 'ws://127.0.0.1:1') => {
    entry.handle({ cmd: 'init', opts: { url } });
    return FakeClient.made[FakeClient.made.length - 1];
  };
  const evs = (kind: BridgeWorkerEvent['ev']) => posted.filter((p) => p.ev === kind);
  return { entry, clock, posted, transfers, init, evs };
}

/* ── the worker entry: init wires ONE client to the url it was given ───────── */
{
  const w = worker();
  const client = w.init('ws://127.0.0.1:60001');
  assert.equal(FakeClient.made.length, 1, 'one socket per worker');
  assert.equal(client.opts.url, 'ws://127.0.0.1:60001');
  assert.equal(client.opts.resolveUrl?.(), 'ws://127.0.0.1:60001', 'the client asks the worker for a url, not the network');

  w.entry.handle({ cmd: 'init', opts: { url: 'ws://127.0.0.1:2' } });
  assert.equal(FakeClient.made.length, 1, 'a second init cannot replace a live socket');

  w.entry.handle({ cmd: 'connect' });
  w.entry.handle({ cmd: 'retryNow' });
  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['connect', 'retryNow'],
    'connect and retryNow reach the client unchanged',
  );

  // The url main last resolved is what a retry dials; null means "no session
  // right now", which the client turns into more backoff rather than a dial.
  w.entry.handle({ cmd: 'url', url: 'ws://127.0.0.1:60002' });
  assert.equal(client.opts.resolveUrl?.(), 'ws://127.0.0.1:60002');
  w.entry.handle({ cmd: 'url', url: null });
  assert.equal(client.opts.resolveUrl?.(), null);
}

/* ── the worker entry: every control op reaches the client ─────────────────── */
{
  const w = worker();
  const client = w.init();
  w.entry.handle({ cmd: 'op', name: 'setParam', args: [3, 0.25] });
  w.entry.handle({ cmd: 'op', name: 'getParams', args: [] });
  w.entry.handle({ cmd: 'op', name: 'paramText', args: [3, 0.75] });
  w.entry.handle({ cmd: 'op', name: 'setState', args: ['c2F2ZWQ='] });
  w.entry.handle({ cmd: 'op', name: 'getState', args: [] });
  w.entry.handle({ cmd: 'op', name: 'openEditor', args: [{ title: 'Pro-Q 4' }] });
  w.entry.handle({ cmd: 'op', name: 'editorRect', args: [{ x: 1, y: 2, w: 3, h: 4 }] });
  w.entry.handle({ cmd: 'op', name: 'closeEditor', args: [] });
  w.entry.handle({ cmd: 'op', name: 'bypass', args: [true] });
  w.entry.handle({ cmd: 'op', name: 'ping', args: [] });
  assert.deepEqual(client.calls, [
    { name: 'setParam', args: [3, 0.25] },
    { name: 'getParams', args: [] },
    { name: 'paramText', args: [3, 0.75] },
    { name: 'setState', args: ['c2F2ZWQ='] },
    { name: 'getState', args: [] },
    { name: 'openEditor', args: [{ title: 'Pro-Q 4' }] },
    { name: 'editorRect', args: [{ x: 1, y: 2, w: 3, h: 4 }] },
    { name: 'closeEditor', args: [] },
    { name: 'bypass', args: [true] },
    { name: 'ping', args: [] },
  ]);
}

/* ── the worker entry: an op before init is dropped, not thrown ────────────── */
{
  const w = worker();
  w.entry.handle({ cmd: 'op', name: 'getParams', args: [] });
  w.entry.handle({ cmd: 'connect' });
  assert.deepEqual(w.posted, [], 'nothing to talk to yet, and nothing breaks');
}

/* ── the worker entry: every handler becomes exactly one message to main ───── */
{
  const w = worker();
  const client = w.init();
  const h = client.opts.handlers;
  h.onStatus?.('starting');
  h.onLatency?.(2048);
  h.onParam?.(4, 0.5, '-6.0 dB');
  h.onParamText?.(4, 0.25, '-12.0 dB');
  h.onParamGesture?.(4, true);
  h.onParams?.([]);
  h.onState?.('c2F2ZWQ=');
  h.onEditor?.({ open: true, w: 800, h: 600 });
  h.onXrun?.(2, 12.5);
  h.onWarning?.('a warning');
  h.onError?.('an error', false);

  assert.deepEqual(w.posted, [
    { ev: 'status', status: 'starting', reason: undefined },
    { ev: 'latency', latencySamples: 2048 },
    { ev: 'param', index: 4, value: 0.5, text: '-6.0 dB' },
    { ev: 'param_text', index: 4, value: 0.25, text: '-12.0 dB' },
    { ev: 'param_gesture', index: 4, begin: true },
    { ev: 'params', list: [] },
    { ev: 'state', stateB64: 'c2F2ZWQ=' },
    { ev: 'editor', open: true, w: 800, h: 600 },
    { ev: 'xrun', lateBlocks: 2, maxProcessMs: 12.5 },
    { ev: 'warning', text: 'a warning' },
    { ev: 'error', text: 'an error', fatal: false },
  ]);
}

/* ── the worker entry: a field change is announced BEFORE the event ────────── */
{
  const w = worker();
  const client = w.init();
  client.goLive();

  assert.deepEqual(w.posted, [
    {
      ev: 'fields',
      fields: { ready: true, blockSize: 512, sampleRate: 48000, channelsOut: 2, pluginLatencySamples: 1024, hasEditor: true },
    },
    { ev: 'status', status: 'live', reason: undefined },
    { ev: 'ready', ready: READY },
  ], 'main reads blockSize off the client the moment it is told the session is live, so the snapshot goes first');

  // A second event that moves nothing re-posts nothing.
  client.opts.handlers.onWarning?.('nothing changed');
  assert.equal(w.evs('fields').length, 1, 'an unchanged snapshot is not re-sent');

  client.pluginLatencySamples = 64;
  client.opts.handlers.onLatency?.(64);
  assert.equal(w.evs('fields').length, 2, 'a field that really moved is announced again');
  assert.deepEqual(w.posted.at(-1), { ev: 'latency', latencySamples: 64 });
}

/* ── the worker entry: audio NEVER goes to main; it goes to the audio port ─── */
{
  const w = worker();
  const client = w.init();
  const port = new FakePort();
  w.entry.handle({ cmd: 'audio-port', port });
  assert.equal(port.starts, 1, 'the port is started, so blocks flow without waiting for anything');

  const f = frame(9);
  client.opts.handlers.onAudio?.(f);
  assert.deepEqual(w.posted, [], 'not one processed block is posted to the main thread');
  assert.equal(port.posted.length, 1);
  assert.deepEqual(port.posted[0].msg, { type: 'processed', seq: 9, frames: 4, channels: f.channels });
  assert.deepEqual(
    port.posted[0].transfer,
    f.channels.map((c) => c.buffer),
    'the channel buffers are transferred, not copied',
  );
}

/* ── the worker entry: a block from the port is sent on the socket ─────────── */
{
  const w = worker();
  const client = w.init();
  const port = new FakePort();
  w.entry.handle({ cmd: 'audio-port', port });

  const b = block();
  port.say(b);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, 'sendAudio');
  assert.deepEqual(client.calls[0].args[0], {
    type: FRAME_TYPE_AUDIO_IN,
    channels: 2,
    flags: FLAG_PLAYING,
    seq: 3,
    frames: 4,
    positionSamples: 4096,
    tempoBpm: 120,
  }, 'the header is built from the block exactly as the main-thread path built it');
  assert.equal(client.calls[0].args[1], b.channels, 'and carries the very buffers the worklet transferred');

  port.say({ type: 'stats', underruns: 4 });
  assert.equal(client.calls.length, 1, 'anything that is not a block is ignored');
}

/* ── the worker entry: a new audio port replaces and closes the old one ────── */
{
  const w = worker();
  const client = w.init();
  const first = new FakePort();
  const second = new FakePort();
  w.entry.handle({ cmd: 'audio-port', port: first });
  w.entry.handle({ cmd: 'audio-port', port: second });
  assert.equal(first.closes, 1, 'the port the old worklet held is closed, not left dangling');
  assert.equal(first.onmessage, null, 'and can no longer deliver a block');

  client.opts.handlers.onAudio?.(frame(1));
  assert.equal(first.posted.length, 0, 'processed audio follows the new port');
  assert.equal(second.posted.length, 1);
}

/* ── the worker entry: stats are throttled to one every 500 ms, on change ──── */
{
  const w = worker();
  const client = w.init();
  const port = new FakePort();
  w.entry.handle({ cmd: 'audio-port', port });

  client.stats.droppedIn = 1;
  port.say(block());
  assert.equal(w.evs('stats').length, 1, 'the first change goes out at once');
  assert.deepEqual((w.evs('stats')[0] as { stats: VstBridgeStats }).stats.droppedIn, 1);

  client.stats.droppedIn = 2;
  port.say(block());
  assert.equal(w.evs('stats').length, 1, 'a second change inside the window waits');

  w.clock.advance(BRIDGE_WORKER_STATS_MS);
  port.say(block());
  assert.equal(w.evs('stats').length, 2, 'and goes out once the window is over');

  w.clock.advance(BRIDGE_WORKER_STATS_MS * 4);
  port.say(block());
  assert.equal(w.evs('stats').length, 2, 'counters that never moved are not re-sent');
}

/* ── the worker entry: close shuts the client and always answers 'off' ─────── */
{
  const w = worker();
  const client = w.init();
  const port = new FakePort();
  w.entry.handle({ cmd: 'audio-port', port });
  w.entry.handle({ cmd: 'close' });
  assert.deepEqual(client.calls.map((c) => c.name), ['close']);
  assert.deepEqual(w.posted.at(-1), { ev: 'status', status: 'off', reason: undefined });
  assert.equal(port.closes, 1, 'the audio port goes with it');

  w.entry.handle({ cmd: 'op', name: 'getParams', args: [] });
  assert.deepEqual(client.calls.map((c) => c.name), ['close'], 'nothing is forwarded after a close');
}

/* ── the worker entry: closing before init still answers 'off' ─────────────── */
{
  // Main terminates the worker when this lands, so a worker that never got a
  // client must not swallow it — that would leak a thread per aborted session.
  const w = worker();
  w.entry.handle({ cmd: 'close' });
  assert.deepEqual(w.posted, [{ ev: 'status', status: 'off' }]);
}

/* ── the proxy: construction hands the worker the url and the backoff ─────── */
{
  FakeWorker.made = [];
  const client = new VstBridgeWorkerClient(
    { url: 'ws://127.0.0.1:60001', retryBaseMs: 10, retryMaxMs: 20, handlers: {} },
    () => new FakeWorker(),
  );
  const w = FakeWorker.made[0];
  assert.deepEqual(w.cmds(), [
    { cmd: 'init', opts: { url: 'ws://127.0.0.1:60001', retryBaseMs: 10, retryMaxMs: 20 } },
  ]);

  client.connect();
  client.retryNow();
  assert.deepEqual(w.cmds().slice(1), [{ cmd: 'connect' }, { cmd: 'retryNow' }]);
}

/* ── the proxy: every control op is forwarded as an op command ─────────────── */
{
  FakeWorker.made = [];
  const client = new VstBridgeWorkerClient({ url: 'ws://x', handlers: {} }, () => new FakeWorker());
  const w = FakeWorker.made[0];
  client.setParam(3, 0.25);
  client.getParams();
  client.setState('c2F2ZWQ=');
  client.getState();
  client.openEditor({ title: 'Pro-Q 4' });
  client.editorRect({ x: 1, y: 2, w: 3, h: 4 });
  client.closeEditor();
  client.bypass(true);
  client.ping();
  assert.deepEqual(w.cmds().slice(1), [
    { cmd: 'op', name: 'setParam', args: [3, 0.25] },
    { cmd: 'op', name: 'getParams', args: [] },
    { cmd: 'op', name: 'setState', args: ['c2F2ZWQ='] },
    { cmd: 'op', name: 'getState', args: [] },
    { cmd: 'op', name: 'openEditor', args: [{ title: 'Pro-Q 4' }] },
    { cmd: 'op', name: 'editorRect', args: [{ x: 1, y: 2, w: 3, h: 4 }] },
    { cmd: 'op', name: 'closeEditor', args: [] },
    { cmd: 'op', name: 'bypass', args: [true] },
    { cmd: 'op', name: 'ping', args: [] },
  ]);

  // The same contract `VstBridgeClient` enforces: a caller that has lost track
  // of its own parameter range hears about it HERE, on its own stack, not in a
  // worker where the throw would be invisible.
  const direct = new VstBridgeClient({ url: 'ws://x', socketFactory: () => { throw new Error('never opened'); }, handlers: {} });
  for (const bad of [[-1, 0.5], [1.5, 0.5], [0, 2], [0, -0.1], [0, Number.NaN]] as [number, number][]) {
    assert.throws(() => client.setParam(bad[0], bad[1]), RangeError, `proxy rejects ${JSON.stringify(bad)}`);
    assert.throws(() => direct.setParam(bad[0], bad[1]), RangeError, `and so does the direct client`);
  }
  assert.equal(w.cmds().length, 10, 'a refused parameter never reaches the worker');
}

/* ── the proxy: the plugin-window switch is honoured HERE ──────────────────── */
{
  // localStorage does not exist in a worker, so this check cannot travel with
  // the op: the one place that can read the key is the main thread.
  const mem = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  const infos: string[] = [];
  const realInfo = console.info;
  console.info = (...a: unknown[]) => void infos.push(a.map(String).join(' '));
  try {
    FakeWorker.made = [];
    const client = new VstBridgeWorkerClient({ url: 'ws://x', handlers: {} }, () => new FakeWorker());
    const w = FakeWorker.made[0];
    mem.set(NO_EDITOR_WINDOWS_KEY, '1');
    client.openEditor({ title: 'Pro-Q 4' });
    client.getState();
    assert.deepEqual(w.cmds().slice(1), [{ cmd: 'op', name: 'getState', args: [] }], 'the window request is withheld; every other op still travels');
    assert.deepEqual(infos, [LIVE_EDITOR_SUPPRESSED_LOG], 'and one line says which editor was withheld');

    mem.delete(NO_EDITOR_WINDOWS_KEY);
    client.openEditor({ title: 'Pro-Q 4' });
    assert.deepEqual(w.cmds().at(-1), { cmd: 'op', name: 'openEditor', args: [{ title: 'Pro-Q 4' }] }, 'off again: the op is sent');
  } finally {
    console.info = realInfo;
    g.localStorage = previous;
  }
}

/* ── the proxy: every worker event reaches the handlers ────────────────────── */
{
  FakeWorker.made = [];
  const log: string[] = [];
  const client = new VstBridgeWorkerClient(
    {
      url: 'ws://x',
      handlers: {
        onStatus: (s, reason) => log.push(`status:${s}:${reason ?? ''}`),
        onReady: (r) => log.push(`ready:${r.plugin.name}`),
        onAudio: () => log.push('audio'),
        onLatency: (s) => log.push(`latency:${s}`),
        onParam: (i, v) => log.push(`param:${i}:${v}`),
        onParams: (l) => log.push(`params:${l.length}`),
        onState: (b) => log.push(`state:${b}`),
        onEditor: (e) => log.push(`editor:${e.open}:${e.w}x${e.h}`),
        onXrun: (l, m) => log.push(`xrun:${l}:${m}`),
        onWarning: (t) => log.push(`warning:${t}`),
        onError: (t, f) => log.push(`error:${t}:${f}`),
      },
    },
    () => new FakeWorker(),
  );
  const w = FakeWorker.made[0];
  w.say({ ev: 'status', status: 'live' });
  w.say({ ev: 'ready', ready: READY });
  w.say({ ev: 'latency', latencySamples: 2048 });
  w.say({ ev: 'param', index: 4, value: 0.5 });
  w.say({ ev: 'params', list: [] });
  w.say({ ev: 'state', stateB64: 'c2F2ZWQ=' });
  w.say({ ev: 'editor', open: true, w: 800, h: 600 });
  w.say({ ev: 'xrun', lateBlocks: 2, maxProcessMs: 12.5 });
  w.say({ ev: 'warning', text: 'a warning' });
  w.say({ ev: 'error', text: 'an error', fatal: false });
  assert.deepEqual(log, [
    'status:live:',
    'ready:Pro-Q 4',
    'latency:2048',
    'param:4:0.5',
    'params:0',
    'state:c2F2ZWQ=',
    'editor:true:800x600',
    'xrun:2:12.5',
    'warning:a warning',
    'error:an error:false',
  ]);
  assert.equal(log.includes('audio'), false, 'onAudio never fires on main: audio does not come this way any more');

  // The fields the app reads off a client are kept in step by their own snapshot.
  assert.equal(client.ready, false, 'nothing is assumed before the worker says so');
  w.say({
    ev: 'fields',
    fields: { ready: true, blockSize: 512, sampleRate: 48000, channelsOut: 2, pluginLatencySamples: 1024, hasEditor: true },
  });
  assert.equal(client.ready, true);
  assert.equal(client.blockSize, 512, 'the node sizes its worklet from this');
  assert.equal(client.sampleRate, 48000);
  assert.equal(client.channelsOut, 2);
  assert.equal(client.pluginLatencySamples, 1024);
  assert.equal(client.hasEditor, true);

  const stats = client.stats;
  w.say({
    ev: 'stats',
    stats: { lateBlocks: 3, maxProcessMs: 9, rttMs: 4, outOfOrder: 1, droppedIn: 2, badFrames: 0, badMessages: 0, reconnects: 1 },
  });
  assert.equal(client.stats, stats, 'the stats object keeps its identity, so a holder of it sees the update');
  assert.equal(client.stats.lateBlocks, 3);
  assert.equal(client.stats.droppedIn, 2);
}

/* ── the proxy: it answers the worker's need for a url ─────────────────────── */
{
  FakeWorker.made = [];
  const clock = new FakeClock();
  let url: string | null = 'ws://127.0.0.1:60001';
  const client = new VstBridgeWorkerClient(
    {
      url: 'ws://127.0.0.1:60001',
      resolveUrl: () => url,
      schedule: clock.schedule,
      cancel: clock.cancel,
      handlers: {},
    },
    () => new FakeWorker(),
  );
  const w = FakeWorker.made[0];
  const urls = () => w.cmds().filter((c) => c.cmd === 'url');

  w.say({ ev: 'status', status: 'error', reason: 'socket closed' });
  assert.deepEqual(urls(), [], 'the url has not moved, so nothing is pushed');

  url = null; // the registry is re-creating the session: nothing to dial yet
  clock.advance(VST_BRIDGE_URL_PUSH_MS);
  assert.deepEqual(urls(), [{ cmd: 'url', url: null }], 'the loss puts the proxy on a 250 ms poll');

  clock.advance(VST_BRIDGE_URL_PUSH_MS * 3);
  assert.equal(urls().length, 1, 'a url that has not changed is not re-sent');

  url = 'ws://127.0.0.1:60002'; // the respawned host
  clock.advance(VST_BRIDGE_URL_PUSH_MS);
  assert.deepEqual(urls().at(-1), { cmd: 'url', url: 'ws://127.0.0.1:60002' });

  w.say({ ev: 'status', status: 'live' });
  w.say({
    ev: 'fields',
    fields: { ready: true, blockSize: 512, sampleRate: 48000, channelsOut: 2, pluginLatencySamples: 0, hasEditor: false },
  });
  const settled = urls().length;
  url = 'ws://127.0.0.1:60003';
  clock.advance(VST_BRIDGE_URL_PUSH_MS * 10);
  assert.equal(urls().length, settled, 'a live session needs no url, so the poll stops');
  assert.equal(clock.pending, 0, 'and leaves no timer behind');
  void client;
}

/* ── the proxy: attachAudioPort hands the port straight to the worker ──────── */
{
  FakeWorker.made = [];
  const client = new VstBridgeWorkerClient({ url: 'ws://x', handlers: {} }, () => new FakeWorker());
  const w = FakeWorker.made[0];
  const port = new FakePort();
  client.attachAudioPort(port as unknown as MessagePort);
  const sent = w.posted.at(-1)!;
  assert.deepEqual(sent.msg, { cmd: 'audio-port', port });
  assert.deepEqual(sent.transfer, [port], 'the port is TRANSFERRED: main keeps no end of it');
}

/* ── the proxy: sendAudio transfers rather than copying ────────────────────── */
{
  FakeWorker.made = [];
  const client = new VstBridgeWorkerClient({ url: 'ws://x', handlers: {} }, () => new FakeWorker());
  const w = FakeWorker.made[0];
  const channels = [Float32Array.from([1, 2]), Float32Array.from([3, 4])];
  const header: VstFrameHeader = { type: FRAME_TYPE_AUDIO_IN, channels: 2, flags: 0, seq: 1, frames: 2, positionSamples: 0, tempoBpm: 0 };
  client.sendAudio(header, channels);
  const sent = w.posted.at(-1)!;
  assert.deepEqual(sent.msg, { cmd: 'op', name: 'sendAudio', args: [header, channels] });
  assert.deepEqual(sent.transfer, channels.map((c) => c.buffer));
}

/* ── the proxy: close waits for the worker's 'off' before terminating ──────── */
{
  FakeWorker.made = [];
  const statuses: string[] = [];
  const client = new VstBridgeWorkerClient(
    { url: 'ws://x', handlers: { onStatus: (s) => statuses.push(s) } },
    () => new FakeWorker(),
  );
  const w = FakeWorker.made[0];
  client.close();
  assert.deepEqual(w.cmds().at(-1), { cmd: 'close' });
  assert.equal(w.terminated, 0, 'the socket gets its chance to close cleanly first');

  client.getParams();
  assert.deepEqual(w.cmds().at(-1), { cmd: 'close' }, 'nothing is sent after a close');

  w.say({ ev: 'status', status: 'off' });
  assert.deepEqual(statuses, ['off'], 'the owner still hears the close');
  assert.equal(w.terminated, 1, 'and the thread is reclaimed rather than left running');

  client.close();
  assert.equal(w.terminated, 1, 'close is idempotent');
}

/* ── the proxy: a worker that cannot run is reported, never silent ─────────── */
{
  FakeWorker.made = [];
  const log: string[] = [];
  const realError = console.error;
  console.error = () => {};
  try {
    new VstBridgeWorkerClient(
      {
        url: 'ws://x',
        handlers: {
          onStatus: (s, reason) => log.push(`status:${s}:${reason ?? ''}`),
          onError: (t, fatal) => log.push(`error:${fatal}`),
        },
      },
      () => new FakeWorker(),
    );
    FakeWorker.made[0].onerror?.({ message: 'failed to load' });
  } finally {
    console.error = realError;
  }
  assert.equal(log.length, 2, 'the row hears about it twice over rather than sitting on "starting" for ever');
  assert.ok(log.some((l) => l.startsWith('status:error')));
  assert.ok(log.includes('error:true'));
}

/* ── the default client: a worker when there is one, main thread when not ──── */
{
  const opts: VstBridgeClientOptions = { url: 'ws://x', handlers: {} };
  const main = new FakeClient(opts);
  const workerClient = new FakeClient(opts);
  const seams = {
    makeWorkerClient: () => workerClient as VstBridgeClientLike,
    makeMainClient: () => main as VstBridgeClientLike,
  };

  assert.equal(
    createDefaultBridgeClient(opts, { ...seams, hasWorker: () => false }),
    main,
    'no Worker in this runtime: the main-thread client, exactly as before',
  );
  assert.equal(createDefaultBridgeClient(opts, { ...seams, hasWorker: () => true }), workerClient, 'a runtime with workers keeps audio off main');

  // The escape hatch: one key puts the bridge back on the main thread, for
  // anyone who has to compare the two or hits a browser bug in the worker path.
  const mem = new Map<string, string>([[VST_MAIN_THREAD_BRIDGE_KEY, '1']]);
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null };
  try {
    assert.equal(createDefaultBridgeClient(opts, { ...seams, hasWorker: () => true }), main, 'the switch wins over the worker');
  } finally {
    g.localStorage = previous;
  }

  // A worker that will not construct is not a dead plugin: fall back, say so once.
  const warnings: string[] = [];
  const boom = {
    ...seams,
    hasWorker: () => true,
    makeWorkerClient: () => {
      throw new Error('Worker is blocked by policy');
    },
    warn: (t: string) => void warnings.push(t),
  };
  assert.equal(createDefaultBridgeClient(opts, boom), main, 'the session still opens, on the main thread');
  assert.equal(warnings.length, 1, 'and the reason is logged');
  assert.equal(createDefaultBridgeClient(opts, boom), main);
  assert.equal(warnings.length, 1, 'once, not once per plugin');
}

console.log('vstLive/bridgeWorkerClient: ok');
