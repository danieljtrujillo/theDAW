/**
 * vstLive/bridgeClient — one WebSocket to one native host process.
 *
 * Everything here runs against a FAKE socket and FAKE timers: the suite drives
 * the client the way a host would (open, `ready`, binary frames, `xrun`, a
 * close) and asserts what the client sends back and what it tells its handlers.
 *
 * The behaviours pinned down:
 *  - `hello` is the first thing on the wire, and control ops sent before
 *    `ready` are queued rather than dropped on the floor.
 *  - audio_out frames are delivered IN ORDER; a repeat or a straggler is
 *    counted and discarded instead of being played late.
 *  - a socket loss is never silent: status goes to 'error', the client stops
 *    accepting audio, and it reconnects on an exponential backoff, restoring
 *    the last state it knew so a respawned plugin comes back dialed in.
 *
 * Run: npx tsx src/lib/vstLive/bridgeClient.test.ts
 */
import assert from 'node:assert/strict';

import { LIVE_EDITOR_SUPPRESSED_LOG, NO_EDITOR_WINDOWS_KEY } from './editorWindowSwitch.ts';

import {
  FRAME_TYPE_AUDIO_IN,
  FRAME_TYPE_AUDIO_OUT,
  packFrame,
  readFrameHeader,
  type VstFrameHeader,
} from './frames.ts';
import {
  VstBridgeClient,
  type BridgeSocketLike,
  type VstBridgeHandlers,
} from './bridgeClient.ts';

/* ── fakes ─────────────────────────────────────────────────────────────────── */

class FakeSocket implements BridgeSocketLike {
  static live: FakeSocket[] = [];
  binaryType = 'blob';
  readyState = 0; // CONNECTING
  sent: (string | ArrayBuffer)[] = [];
  closed: { code?: number } | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.live.push(this);
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = { code };
    this.readyState = 3;
  }

  /* — driving it from the host's side — */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  say(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  sendFrame(header: VstFrameHeader, channels: Float32Array[]): void {
    this.onmessage?.({ data: packFrame(header, channels) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** Text ops it received, parsed. */
  ops(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** Binary frames it received, as headers. */
  frames(): VstFrameHeader[] {
    return this.sent
      .filter((s): s is ArrayBuffer => typeof s !== 'string')
      .map((b) => readFrameHeader(b));
  }
}

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

const READY = {
  ev: 'ready',
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

interface Log {
  status: { status: string; reason?: string }[];
  ready: number;
  audio: number[];
  latency: number[];
  params: { index: number; value: number }[];
  state: string[];
  editor: { open: boolean }[];
  errors: string[];
  warnings: string[];
}

function makeClient(over: Partial<VstBridgeHandlers> = {}) {
  FakeSocket.live = [];
  const clock = new FakeClock();
  const log: Log = { status: [], ready: 0, audio: [], latency: [], params: [], state: [], editor: [], errors: [], warnings: [] };
  const client = new VstBridgeClient({
    url: 'ws://127.0.0.1:51515',
    socketFactory: (url) => new FakeSocket(url),
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
    handlers: {
      onStatus: (status, reason) => log.status.push({ status, reason }),
      onReady: () => { log.ready += 1; },
      onAudio: (f) => log.audio.push(f.header.seq),
      onLatency: (s) => log.latency.push(s),
      onParam: (index, value) => log.params.push({ index, value }),
      onState: (b64) => log.state.push(b64),
      onEditor: (e) => log.editor.push(e),
      onError: (text) => log.errors.push(text),
      onWarning: (text) => log.warnings.push(text),
      ...over,
    },
  });
  return { client, clock, log, sock: () => FakeSocket.live[FakeSocket.live.length - 1] };
}

const inHeader = (seq: number, frames = 4): VstFrameHeader => ({
  type: FRAME_TYPE_AUDIO_IN,
  channels: 2,
  flags: 0,
  seq,
  frames,
  positionSamples: 0,
  tempoBpm: 120,
});

const outHeader = (seq: number, frames = 4): VstFrameHeader => ({ ...inHeader(seq, frames), type: FRAME_TYPE_AUDIO_OUT });
const pcm = (frames = 4) => [new Float32Array(frames), new Float32Array(frames)];

/* ── hello is first, and the socket is put in binary mode before anything ──── */
{
  const { client, log, sock } = makeClient();
  client.connect();
  const s = sock();
  assert.equal(s.url, 'ws://127.0.0.1:51515');
  assert.equal(s.binaryType, 'arraybuffer', 'binary frames must not arrive as Blobs');
  assert.deepEqual(log.status, [{ status: 'starting', reason: undefined }]);
  assert.equal(s.sent.length, 0, 'nothing is sent before the socket opens');

  s.open();
  assert.deepEqual(s.ops(), [{ op: 'hello', protocol: 1 }], 'hello is the first message');
  assert.equal(client.ready, false);

  s.say(READY);
  assert.equal(client.ready, true);
  assert.equal(log.ready, 1);
  assert.deepEqual(log.status.at(-1), { status: 'live', reason: undefined });
  assert.equal(client.blockSize, 512, 'the host tells the client what block size it agreed to');
  assert.equal(client.sampleRate, 48000);
  assert.equal(client.pluginLatencySamples, 1024);
  client.close();
}

/* ── control ops before `ready` are queued, then flushed in order ──────────── */
{
  const { client, sock } = makeClient();
  client.connect();
  client.setParam(3, 0.25);
  client.bypass(true);
  const s = sock();
  s.open();
  assert.deepEqual(s.ops(), [{ op: 'hello', protocol: 1 }], 'still only hello — the host has not said ready');

  client.getParams(); // queued after open but before ready, too
  s.say(READY);
  assert.deepEqual(
    s.ops().slice(1),
    [
      { op: 'set_param', index: 3, value: 0.25 },
      { op: 'bypass', on: true },
      { op: 'get_params' },
    ],
    'queued ops flush in the order they were asked for',
  );

  client.setParam(1, 1);
  assert.deepEqual(s.ops().at(-1), { op: 'set_param', index: 1, value: 1 }, 'and later ops go straight out');
  client.close();
}

/* ── the whole control surface ─────────────────────────────────────────────── */
{
  const { client, clock, sock } = makeClient();
  client.connect();
  const s = sock();
  s.open();
  s.say(READY);
  const from = s.ops().length;

  client.setParam(2, 0.5);
  client.getParams();
  client.setState('Zm9v');
  client.getState();
  client.openEditor({ parentHwnd: '12345', x: 10, y: 20, w: 640, h: 480, title: 'Pro-Q 4' });
  client.editorRect({ x: 11, y: 21, w: 641, h: 481 });
  client.closeEditor();
  client.bypass(false);
  client.ping();

  assert.deepEqual(s.ops().slice(from), [
    { op: 'set_param', index: 2, value: 0.5 },
    { op: 'get_params' },
    { op: 'set_state', state_b64: 'Zm9v' },
    { op: 'get_state' },
    { op: 'open_editor', parent_hwnd: '12345', x: 10, y: 20, w: 640, h: 480, title: 'Pro-Q 4' },
    { op: 'editor_rect', x: 11, y: 21, w: 641, h: 481 },
    { op: 'close_editor' },
    { op: 'bypass', on: false },
    { op: 'ping', t: 0 },
  ]);

  // A normalized param outside 0..1 is a caller bug the host should never see.
  assert.throws(() => client.setParam(0, 1.5), RangeError);
  assert.throws(() => client.setParam(0, Number.NaN), RangeError);
  assert.throws(() => client.setParam(-1, 0.5), RangeError);

  clock.advance(12);
  s.say({ ev: 'pong', t: 0 });
  assert.equal(client.stats.rttMs, 12, 'the round trip is measured from the echoed stamp');
  client.close();
}

/* ── audio: in flight one way, in order the other ──────────────────────────── */
{
  const { client, log, sock } = makeClient();
  client.connect();
  const s = sock();

  client.sendAudio(inHeader(1), pcm());
  assert.equal(s.frames().length, 0, 'audio before ready is dropped, not buffered');
  assert.equal(client.stats.droppedIn, 1, 'and counted — silently buffering audio would drift the stream');

  s.open();
  s.say(READY);
  // The SOCKET numbers the blocks (0, 1, 2 ...), whatever number the producer put in the header.
  client.sendAudio(inHeader(41), pcm());
  client.sendAudio(inHeader(42), pcm());
  assert.deepEqual(s.frames().map((h) => h.seq), [0, 1]);
  assert.deepEqual(s.frames().map((h) => h.type), [FRAME_TYPE_AUDIO_IN, FRAME_TYPE_AUDIO_IN]);

  s.sendFrame(outHeader(0), pcm()); // the host echoes the number it was sent
  s.sendFrame(outHeader(1), pcm());
  assert.deepEqual(log.audio, [0, 1]);

  s.sendFrame(outHeader(1), pcm()); // duplicate
  s.sendFrame(outHeader(0), pcm()); // straggler
  assert.deepEqual(log.audio, [0, 1], 'neither reaches the play-out buffer');
  assert.equal(client.stats.outOfOrder, 2);

  // A REBUILT producer: the engine makes a new audio worklet on every Play, every seek while
  // playing and every loop wrap, and each one counts from 0 again. Its blocks used to go out with
  // those low numbers, come back echoed, and be thrown away as stragglers — the plugin fell out of
  // the path and the track played dry while the row said LIVE. Numbered by the socket, they simply
  // carry on from where the stream was.
  client.sendAudio(inHeader(0), pcm());
  client.sendAudio(inHeader(1), pcm());
  assert.deepEqual(s.frames().map((h) => h.seq), [0, 1, 2, 3], 'the numbering never goes back');
  s.sendFrame(outHeader(2), pcm());
  s.sendFrame(outHeader(3), pcm());
  assert.deepEqual(log.audio, [0, 1, 2, 3], 'so the rebuilt producer is heard at once');
  assert.equal(client.stats.outOfOrder, 2, 'and nothing of it is counted as out of order');

  // A frame the host had no business sending is refused without killing the
  // connection: one bad message must not take the session down.
  s.onmessage?.({ data: new ArrayBuffer(4) });
  assert.equal(client.stats.badFrames, 1);
  assert.equal(client.ready, true, 'the session survives a malformed frame');
  client.close();
}

/* ── host events reach the handlers ────────────────────────────────────────── */
{
  const { client, log, sock } = makeClient();
  client.connect();
  const s = sock();
  s.open();
  s.say(READY);

  s.say({ ev: 'latency', latency_samples: 2048 });
  assert.deepEqual(log.latency, [2048]);
  assert.equal(client.pluginLatencySamples, 2048, 'the client tracks it too, for a reconnect');

  s.say({ ev: 'param', index: 4, value: 0.75 });
  assert.deepEqual(log.params, [{ index: 4, value: 0.75 }]);

  s.say({ ev: 'state', state_b64: 'YmFy' });
  assert.deepEqual(log.state, ['YmFy']);

  s.say({ ev: 'editor', open: true, w: 800, h: 600 });
  assert.deepEqual(log.editor, [{ open: true, w: 800, h: 600 }]);

  s.say({ ev: 'xrun', late_blocks: 3, max_process_ms: 9.5 });
  s.say({ ev: 'xrun', late_blocks: 2, max_process_ms: 4 });
  assert.equal(client.stats.lateBlocks, 5, 'xruns accumulate');
  assert.equal(client.stats.maxProcessMs, 9.5, 'and the worst process time is kept');

  s.say({ ev: 'warning', text: 'bus layout fell back to stereo' });
  assert.deepEqual(log.warnings, ['bus layout fell back to stereo']);
  assert.equal(client.ready, true, 'a warning is not a failure');

  s.say({ ev: 'error', text: 'plugin refused the sample rate', fatal: false });
  assert.deepEqual(log.errors, ['plugin refused the sample rate']);
  assert.equal(client.ready, true, 'a non-fatal error leaves the session running');

  // Garbage on the text channel is ignored, loudly enough to count.
  s.onmessage?.({ data: '{not json' });
  assert.equal(client.stats.badMessages, 1);
  assert.equal(client.ready, true, 'and does not take the session down either');

  s.say({ ev: 'error', text: 'plugin crashed', fatal: true });
  assert.equal(client.ready, false, 'a fatal one does not');
  assert.deepEqual(log.status.at(-1), { status: 'error', reason: 'plugin crashed' });
  // The dead socket is detached, so nothing the old host says can reach the
  // handlers after the failure.
  s.onmessage?.({ data: '{also not json' });
  assert.equal(client.stats.badMessages, 1);
  client.close();
}

/* ── a socket loss: error, dry, backoff, and the state restored on return ──── */
{
  const { client, log, clock, sock } = makeClient();
  client.connect();
  const first = sock();
  first.open();
  first.say(READY);
  client.setState('c3RhdGU='); // the state this session is dialed in with
  first.say({ ev: 'state', state_b64: 'bmV3ZXI=' }); // ...and a newer one from the editor

  first.drop();
  assert.equal(client.ready, false, 'the node must fall back to dry immediately');
  assert.deepEqual(log.status.at(-1)?.status, 'error');
  assert.ok(/closed|1006/i.test(log.status.at(-1)?.reason ?? ''), `the reason names the close: ${log.status.at(-1)?.reason}`);
  client.sendAudio(inHeader(9), pcm());
  assert.equal(client.stats.droppedIn, 1, 'audio during the outage goes nowhere');

  assert.equal(FakeSocket.live.length, 1, 'it does not hammer the host — the retry is on a timer');
  clock.advance(249);
  assert.equal(FakeSocket.live.length, 1, 'first backoff is 250 ms');
  clock.advance(1);
  assert.equal(FakeSocket.live.length, 2, 'and then it reconnects');

  const second = sock();
  second.open();
  second.say(READY);
  assert.equal(client.ready, true);
  assert.equal(client.stats.reconnects, 1);
  assert.deepEqual(
    second.ops(),
    [{ op: 'hello', protocol: 1 }, { op: 'set_state', state_b64: 'bmV3ZXI=' }],
    'a respawned plugin is restored to the LAST state the client saw, not the first',
  );
  client.close();
}

/* ── the backoff actually backs off, and caps ──────────────────────────────── */
{
  const { client, clock } = makeClient();
  client.connect();
  FakeSocket.live[0].open();
  FakeSocket.live[0].say(READY);

  const waits: number[] = [];
  let attempts = 1;
  for (let i = 0; i < 7; i += 1) {
    FakeSocket.live[FakeSocket.live.length - 1].drop();
    let waited = 0;
    while (FakeSocket.live.length === attempts && waited < 60000) {
      clock.advance(10);
      waited += 10;
    }
    waits.push(waited);
    attempts += 1;
    // Never reaches `ready`, so the backoff keeps growing.
    FakeSocket.live[FakeSocket.live.length - 1].open();
  }
  assert.deepEqual(waits.slice(0, 5), [250, 500, 1000, 2000, 4000], 'doubling backoff');
  assert.deepEqual(waits.slice(5), [5000, 5000], 'capped at 5 s so a dead host is retried, not abandoned');
  client.close();
}

/* ── a successful ready resets the backoff ─────────────────────────────────── */
{
  const { client, clock } = makeClient();
  client.connect();
  const drop = () => FakeSocket.live[FakeSocket.live.length - 1].drop();
  const revive = () => {
    const s = FakeSocket.live[FakeSocket.live.length - 1];
    s.open();
    s.say(READY);
  };
  FakeSocket.live[0].open();
  FakeSocket.live[0].say(READY);

  drop();
  clock.advance(250);
  revive();
  drop();
  assert.equal(FakeSocket.live.length, 2);
  clock.advance(250);
  assert.equal(FakeSocket.live.length, 3, 'after a healthy session the backoff starts over at 250 ms');
  client.close();
}

/* ── the registry can hand it a NEW url when the host process died ─────────── */
{
  FakeSocket.live = [];
  const clock = new FakeClock();
  const urls: string[] = [];
  let next: string | null = 'ws://127.0.0.1:60001';
  const client = new VstBridgeClient({
    url: 'ws://127.0.0.1:51515',
    socketFactory: (url) => {
      urls.push(url);
      return new FakeSocket(url);
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
    resolveUrl: () => next,
    handlers: {},
  });
  client.connect();
  FakeSocket.live[0].open();
  FakeSocket.live[0].say(READY);
  FakeSocket.live[0].drop();
  clock.advance(250);
  assert.deepEqual(urls, ['ws://127.0.0.1:51515', 'ws://127.0.0.1:60001'], 'the retry uses the re-created session');

  // A registry that cannot re-create the session says so, and the client waits
  // rather than spinning on a url it knows is dead.
  next = null;
  FakeSocket.live[1].open();
  FakeSocket.live[1].drop();
  clock.advance(250);
  assert.equal(urls.length, 2, 'no socket is opened when there is no session to open it on');
  clock.advance(500);
  assert.equal(urls.length, 2, 'and it keeps backing off instead of retrying instantly');
  client.close();
}

/* ── retryNow(): the FX row's retry button jumps the backoff ───────────────── */
{
  const { client, clock, sock } = makeClient();
  client.connect();
  sock().open();
  sock().say(READY);

  // Fail twice so the backoff has grown to something a user would notice.
  sock().drop();
  clock.advance(250);
  sock().open();
  sock().drop();
  assert.equal(FakeSocket.live.length, 2);

  client.retryNow();
  assert.equal(FakeSocket.live.length, 3, 'it connects immediately rather than waiting out 500 ms');
  assert.equal(clock.pending, 0, 'and cancels the timer it replaced');

  // The backoff starts over, so a user who retried once is not punished with
  // the old interval when the retry also fails.
  sock().drop();
  clock.advance(249);
  assert.equal(FakeSocket.live.length, 3);
  clock.advance(1);
  assert.equal(FakeSocket.live.length, 4, 'back to a 250 ms first step');

  // Healthy or closed, it does nothing.
  sock().open();
  sock().say(READY);
  const live = FakeSocket.live.length;
  client.retryNow();
  assert.equal(FakeSocket.live.length, live, 'a live session is not torn down by a retry');
  client.close();
  client.retryNow();
  assert.equal(FakeSocket.live.length, live, 'and a closed one stays closed');
}

/* ── close() is final: no reconnect, no pending timer, socket shut ─────────── */
{
  const { client, clock, log, sock } = makeClient();
  client.connect();
  const s = sock();
  s.open();
  s.say(READY);
  s.drop();
  client.close();
  assert.equal(clock.pending, 0, 'close cancels the retry timer');
  clock.advance(60000);
  assert.equal(FakeSocket.live.length, 1, 'and nothing reconnects afterwards');
  assert.deepEqual(log.status.at(-1)?.status, 'off', 'a deliberate close is not an error');

  const { client: c2, sock: s2 } = makeClient();
  c2.connect();
  s2().open();
  s2().say(READY);
  c2.close();
  assert.ok(s2().closed, 'the socket itself is closed');
  c2.close(); // idempotent
  assert.equal(c2.ready, false);
  c2.sendAudio(inHeader(1), pcm()); // must not throw after close
}

/* ── parameters: the plugin's own words for a value, and the gestures of its own window ── */
{
  const seen: unknown[] = [];
  const { client, sock } = makeClient({
    onParam: (index, value, text) => seen.push(['param', index, value, text]),
    onParamText: (index, value, text) => seen.push(['text', index, value, text]),
    onParamGesture: (index, begin) => seen.push(['gesture', index, begin]),
  });
  client.connect();
  const s = sock();
  s.open();
  s.say(READY);
  const from = s.ops().length;

  client.paramText(3, 0.25);
  client.paramText(3, 7); // clamped, never sent raw
  client.paramText(-1, 0.5); // not a parameter: nothing goes out
  client.paramText(3, Number.NaN);
  assert.deepEqual(s.ops().slice(from), [
    { op: 'param_text', index: 3, value: 0.25 },
    { op: 'param_text', index: 3, value: 1 },
  ]);

  s.say({ ev: 'param_gesture', index: 3, begin: true });
  s.say({ ev: 'param', index: 3, value: 0.5, text: '-6.0 dB' });
  s.say({ ev: 'param', index: 3, value: 0.6 }); // a host built before `text` existed
  s.say({ ev: 'param_gesture', index: 3, begin: false });
  s.say({ ev: 'param_text', index: 3, value: 0.25, text: '-12.0 dB' });
  assert.deepEqual(seen, [
    ['gesture', 3, true],
    ['param', 3, 0.5, '-6.0 dB'],
    ['param', 3, 0.6, undefined],
    ['gesture', 3, false],
    ['text', 3, 0.25, '-12.0 dB'],
  ]);
  client.close();
}

/* ── the "no plugin windows" switch withholds open_editor and nothing else ─── */
{
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
    const { client, sock } = makeClient();
    client.connect();
    const s = sock();
    s.open();
    s.say(READY);
    const from = s.ops().length;

    mem.set(NO_EDITOR_WINDOWS_KEY, '1');
    client.openEditor({ title: 'Pro-Q 4' });
    client.getState();
    client.closeEditor();
    assert.deepEqual(
      s.ops().slice(from),
      [{ op: 'get_state' }, { op: 'close_editor' }],
      'the window request never reaches the host; every other op still does',
    );
    assert.deepEqual(infos, [LIVE_EDITOR_SUPPRESSED_LOG], 'one line says a LIVE editor was withheld');

    mem.delete(NO_EDITOR_WINDOWS_KEY);
    client.openEditor({ title: 'Pro-Q 4' });
    assert.deepEqual(s.ops().slice(from + 2), [{ op: 'open_editor', title: 'Pro-Q 4' }], 'off again: the op is sent');
  } finally {
    console.info = realInfo;
    g.localStorage = previous;
  }
}

console.log('vstLive/bridgeClient: ok');
