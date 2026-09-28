/**
 * vstLive/bridgeClient — one WebSocket to one native VST host process.
 *
 * The client owns the control protocol of docs/design/vst-live-protocol.md:
 * `hello` -> `ready`, the `op` messages in both directions, and the binary
 * audio frames. It does NOT own audio timing — the worklet does — so nothing
 * here blocks, allocates per quantum, or keeps a queue of audio: a frame the
 * socket cannot take right now is DROPPED and counted, because buffering audio
 * on a control path is how a stream ends up permanently late.
 *
 * Failure is never silent. A socket that closes takes the session to `error`
 * immediately (the worklet is told, and falls back to dry signal), then the
 * client reconnects on an exponential backoff — 250 ms doubling to a 5 s cap,
 * forever, because a host that is being rebuilt or restarted should be picked
 * up again without the user touching anything. `resolveUrl` lets the session
 * registry re-create a host process that actually died and hand back its new
 * url; the last state the client saw is replayed after `ready`, so a respawned
 * plugin comes back dialed in rather than at its defaults.
 *
 * Everything external is injectable (`socketFactory`, `schedule`/`cancel`,
 * `now`), so the whole state machine is testable without a browser.
 *
 * Units: `*Samples` are sample frames; `rttMs` / `maxProcessMs` are
 * milliseconds; backoff options are milliseconds.
 */
import { editorWindowsSuppressed, LIVE_EDITOR_SUPPRESSED_LOG } from './editorWindowSwitch';
import {
  FRAME_TYPE_AUDIO_OUT,
  packFrame,
  readFrameHeader,
  unpackFrame,
  type VstFrame,
  type VstFrameHeader,
} from './frames';

/** The protocol version this client speaks (`hello.protocol`). */
export const VST_LIVE_PROTOCOL = 1;

/** The subset of `WebSocket` the client uses, so a fake can stand in. */
export interface BridgeSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type BridgeSocketFactory = (url: string) => BridgeSocketLike;

/** One parameter as the host describes it in a `params` event. */
export interface VstParamDescriptor {
  index: number;
  name: string;
  label: string;
  default: number;
  value: number;
  steps: number;
  automatable: boolean;
  discrete: boolean;
  boolean: boolean;
  /** The list holds EVERY parameter the plugin declares; these say what each is for. All
   *  optional: a host built before them sends none. */
  hidden?: boolean;
  read_only?: boolean;
  bypass?: boolean;
  program_change?: boolean;
  /** The plugin's own words for `value` ("-6.0 dB"). */
  text?: string;
}

/** The plugin identity block inside `ready`. */
export interface VstReadyPlugin {
  name: string;
  vendor: string;
  version: string;
  category: string;
  identifier: string;
  format: string;
}

/** The host's `ready` event. */
export interface VstReadyEvent {
  protocol: number;
  plugin: VstReadyPlugin;
  latency_samples: number;
  tail_seconds: number;
  sample_rate: number;
  block_size: number;
  channels_in: number;
  channels_out: number;
  has_editor: boolean;
  state_compat: boolean;
  /** The host takes the `midi` and `midi_panic` ops. Absent from a host built before them. */
  accepts_midi?: boolean;
  warnings: string[];
}

/** One MIDI channel voice message for the `midi` op: `pos` is timeline sample frames, -1 = now. */
export interface VstMidiEvent {
  pos: number;
  data: number[];
}

/** What the client tells its owner. Every handler is optional. */
export interface VstBridgeHandlers {
  /** `starting` on connect, `live` on `ready`, `error` on a loss or a fatal
   *  error, `off` after `close()`. */
  onStatus?: (status: 'starting' | 'live' | 'error' | 'off', reason?: string) => void;
  onReady?: (ready: VstReadyEvent) => void;
  /** One processed block, already ordered and de-duplicated. */
  onAudio?: (frame: VstFrame) => void;
  onLatency?: (latencySamples: number) => void;
  /** `text` is the plugin's own display string for the new value, when the host sent one. */
  onParam?: (index: number, value: number, text?: string) => void;
  /** The answer to `paramText()`: the plugin's words for `value` of parameter `index`. */
  onParamText?: (index: number, value: number, text: string) => void;
  /** The user grabbed (`begin`) or let go of a control in the plugin's own window. */
  onParamGesture?: (index: number, begin: boolean) => void;
  onParams?: (list: VstParamDescriptor[]) => void;
  onState?: (stateB64: string) => void;
  onEditor?: (e: { open: boolean; w: number; h: number }) => void;
  onXrun?: (lateBlocks: number, maxProcessMs: number) => void;
  onWarning?: (text: string) => void;
  onError?: (text: string, fatal: boolean) => void;
}

export interface VstBridgeClientOptions {
  /** `ws_url` from `POST /api/vst/live/session`. */
  url: string;
  handlers: VstBridgeHandlers;
  socketFactory?: BridgeSocketFactory;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  now?: () => number;
  /** Asked for a url before each retry. Return a new one when the session had
   *  to be re-created, the current one to reuse it, or null when there is no
   *  session to connect to right now (the client keeps backing off). */
  resolveUrl?: () => string | null;
  /** First backoff step (default 250 ms). */
  retryBaseMs?: number;
  /** Backoff ceiling (default 5000 ms). */
  retryMaxMs?: number;
}

/** Health counters the FX row and the logs read. */
export interface VstBridgeStats {
  /** Blocks the host reported as late (`xrun.late_blocks`), accumulated. */
  lateBlocks: number;
  /** Worst `process` time the host has reported, in ms. */
  maxProcessMs: number;
  /** Last `ping`/`pong` round trip, in ms; -1 until one completes. */
  rttMs: number;
  /** audio_out frames dropped as duplicate or out of order. */
  outOfOrder: number;
  /** audio_in blocks that could not be sent (no live socket). */
  droppedIn: number;
  /** Binary messages that were not a valid frame. */
  badFrames: number;
  /** Text messages that were not valid protocol JSON. */
  badMessages: number;
  /** Successful re-`ready` after a loss. */
  reconnects: number;
}

/** What `openEditor` accepts. All values are PHYSICAL px. */
export interface VstEditorOpenOptions {
  parentHwnd?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  title?: string;
}

/** Where an embedded editor sits. All values are PHYSICAL px. */
export interface VstEditorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One live host session, as everything above the transport sees it.
 *
 * There are two implementations and the app must not care which it holds:
 * `VstBridgeClient` (this file — the socket lives on the calling thread) and
 * `VstBridgeWorkerClient` (`bridgeWorkerClient.ts` — the socket lives in a
 * dedicated Worker and audio never touches the main thread). A runtime with no
 * `Worker` gets the first one and behaves exactly as it always did, so the
 * registry, the node and the editor store are all written against this.
 *
 * `attachAudioPort` is the one member that is NOT common: only the worker
 * client can take a `MessagePort` straight from the worklet, and a caller that
 * finds it missing keeps the main-thread path it has always used.
 */
export interface VstBridgeClientLike {
  readonly ready: boolean;
  readonly blockSize: number;
  readonly sampleRate: number;
  readonly channelsOut: number;
  readonly pluginLatencySamples: number;
  readonly hasEditor: boolean;
  /** The host said in `ready` that it takes MIDI (an instrument's notes). Optional: test fakes predate it. */
  readonly acceptsMidi?: boolean;
  readonly stats: VstBridgeStats;
  connect(): void;
  close(): void;
  retryNow(): void;
  sendAudio(header: VstFrameHeader, channels: readonly Float32Array[]): void;
  setParam(index: number, value: number): void;
  getParams(): void;
  /** Ask for the plugin's display string for a value WITHOUT moving the parameter. */
  paramText(index: number, value: number): void;
  setState(stateB64: string): void;
  getState(): void;
  openEditor(o?: VstEditorOpenOptions): void;
  editorRect(rect: VstEditorRect): void;
  closeEditor(): void;
  bypass(on: boolean): void;
  ping(): void;
  /** Hand the plugin MIDI to play at timeline positions (the `midi` op). Sent only while the
   *  session is ready: a note held back until a reconnect would land late, all at once. */
  sendMidi?(events: readonly VstMidiEvent[]): void;
  /** Drop the MIDI the host holds and release every sounding note (a stop, seek or loop wrap). */
  midiPanic?(): void;
  /** Take the worklet's end of a `MessageChannel` and carry audio over it
   *  instead of through the caller's thread. Absent on the main-thread client. */
  attachAudioPort?(port: MessagePort): void;
}

const defaultSocketFactory: BridgeSocketFactory = (url) =>
  new WebSocket(url) as unknown as BridgeSocketLike;

export class VstBridgeClient implements VstBridgeClientLike {
  private readonly opts: VstBridgeClientOptions;
  private readonly makeSocket: BridgeSocketFactory;
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancelTimer: (handle: number) => void;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private socket: BridgeSocketLike | null = null;
  private url: string;
  private _ready = false;
  private closed = false;
  private everReady = false;
  private retryAttempt = 0;
  private retryHandle: number | null = null;
  /** Control ops asked for before `ready`, flushed in order when it arrives. */
  private pending: string[] = [];
  /** Highest audio_out seq delivered, so a repeat cannot be played twice. */
  private lastOutSeq = -1;
  /** The sequence number the next outgoing block carries. Owned HERE, by the socket, and only
   *  ever counts up: see `sendAudio`. */
  private nextInSeq = 0;
  /** The most recent plugin state the client knows, replayed on a reconnect. */
  private lastStateB64: string | null = null;
  private pingSentAt: number | null = null;

  /** Block size the host agreed to, from `ready`; 0 until then. */
  blockSize = 0;
  /** Sample rate the host is running at, from `ready`; 0 until then. */
  sampleRate = 0;
  /** Channels the host negotiated on its output bus; 0 until `ready`. */
  channelsOut = 0;
  /** The plugin's currently reported latency, in sample frames. */
  pluginLatencySamples = 0;
  /** The plugin has an editor view. */
  hasEditor = false;
  acceptsMidi = false;

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

  constructor(opts: VstBridgeClientOptions) {
    this.opts = opts;
    this.url = opts.url;
    this.makeSocket = opts.socketFactory ?? defaultSocketFactory;
    this.schedule = opts.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.cancelTimer = opts.cancel ?? ((h) => globalThis.clearTimeout(h as unknown as number));
    this.now = opts.now ?? (() => Date.now());
    this.retryBaseMs = opts.retryBaseMs ?? 250;
    this.retryMaxMs = opts.retryMaxMs ?? 5000;
  }

  /** True only while the host has answered `ready` and the socket is open. */
  get ready(): boolean {
    return this._ready;
  }

  /** Open the socket. Safe to call once; later calls while connected are no-ops. */
  connect(): void {
    if (this.closed || this.socket) return;
    this.openSocket();
  }

  private openSocket(): void {
    const s = this.makeSocket(this.url);
    this.socket = s;
    // Binary frames must arrive as ArrayBuffers: the default `blob` would make
    // every block an async read on the main thread.
    s.binaryType = 'arraybuffer';
    s.onopen = () => {
      if (this.socket !== s) return;
      // `hello` must be the FIRST message on the wire; nothing queued jumps it.
      this.raw(JSON.stringify({ op: 'hello', protocol: VST_LIVE_PROTOCOL }));
    };
    s.onmessage = (ev) => {
      if (this.socket === s) this.onMessage(ev.data);
    };
    s.onerror = () => {
      if (this.socket === s) this.fail('socket error');
    };
    s.onclose = (ev) => {
      if (this.socket === s) this.fail(`socket closed (${ev?.code ?? 'no code'})`);
    };
    this.opts.handlers.onStatus?.('starting');
  }

  private raw(data: string | ArrayBuffer): boolean {
    const s = this.socket;
    if (!s || s.readyState !== 1) return false;
    try {
      s.send(data);
      return true;
    } catch {
      // A send that throws means the socket died between the readyState read
      // and the call; the close handler will drive the reconnect.
      return false;
    }
  }

  /** Send a control op now, or queue it until `ready`. */
  private op(body: Record<string, unknown>): void {
    if (this.closed) return;
    const text = JSON.stringify(body);
    if (this._ready) {
      this.raw(text);
      return;
    }
    this.pending.push(text);
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.onText(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.onBinary(data);
      return;
    }
    this.stats.badMessages += 1;
  }

  private onBinary(buf: ArrayBuffer): void {
    let frame: VstFrame;
    try {
      const header = readFrameHeader(buf);
      if (header.type !== FRAME_TYPE_AUDIO_OUT) {
        this.stats.badFrames += 1;
        return;
      }
      frame = unpackFrame(buf);
    } catch {
      // One malformed message must not take a working session down.
      this.stats.badFrames += 1;
      return;
    }
    // The host echoes the channel count it was sent and leaves `flags` at 0 on
    // the way back, so nothing in an `audio_out` header is read here beyond
    // `seq` and the payload shape — the transport state that matters travels
    // client -> host, not back.
    if (frame.header.seq <= this.lastOutSeq) {
      // The contract promises one audio_out per audio_in, in order. A repeat or
      // a straggler is a host bug; playing it would put the stream out of step.
      this.stats.outOfOrder += 1;
      return;
    }
    this.lastOutSeq = frame.header.seq;
    this.opts.handlers.onAudio?.(frame);
  }

  private onText(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.stats.badMessages += 1;
      return;
    }
    const h = this.opts.handlers;
    switch (msg.ev) {
      case 'ready': {
        const ready = msg as unknown as VstReadyEvent;
        this._ready = true;
        this.blockSize = ready.block_size;
        this.sampleRate = ready.sample_rate;
        this.channelsOut = ready.channels_out;
        this.pluginLatencySamples = ready.latency_samples;
        this.hasEditor = ready.has_editor;
        this.acceptsMidi = ready.accepts_midi === true;
        this.lastOutSeq = -1; // a new host process restarts the sequence
        this.retryAttempt = 0; // a healthy session earns a fresh backoff
        if (this.everReady) this.stats.reconnects += 1;
        this.everReady = true;
        // A respawned plugin starts at its defaults; give it back what the user
        // had dialed in before anything else queued is flushed.
        if (this.stats.reconnects > 0 && this.lastStateB64) {
          this.raw(JSON.stringify({ op: 'set_state', state_b64: this.lastStateB64 }));
        }
        const queued = this.pending;
        this.pending = [];
        for (const q of queued) this.raw(q);
        h.onStatus?.('live');
        h.onReady?.(ready);
        return;
      }
      case 'latency':
        this.pluginLatencySamples = Number(msg.latency_samples) || 0;
        h.onLatency?.(this.pluginLatencySamples);
        return;
      case 'params':
        h.onParams?.((msg.list ?? []) as VstParamDescriptor[]);
        return;
      case 'param':
        h.onParam?.(Number(msg.index), Number(msg.value), typeof msg.text === 'string' ? msg.text : undefined);
        break;
      case 'param_text':
        h.onParamText?.(Number(msg.index), Number(msg.value), typeof msg.text === 'string' ? msg.text : '');
        break;
      case 'param_gesture':
        h.onParamGesture?.(Number(msg.index), msg.begin === true);
        return;
      case 'state':
        this.lastStateB64 = String(msg.state_b64 ?? '');
        h.onState?.(this.lastStateB64);
        return;
      case 'editor':
        h.onEditor?.({ open: Boolean(msg.open), w: Number(msg.w) || 0, h: Number(msg.h) || 0 });
        return;
      case 'xrun': {
        const late = Number(msg.late_blocks) || 0;
        const worst = Number(msg.max_process_ms) || 0;
        this.stats.lateBlocks += late;
        if (worst > this.stats.maxProcessMs) this.stats.maxProcessMs = worst;
        h.onXrun?.(late, worst);
        return;
      }
      case 'pong':
        if (this.pingSentAt !== null) {
          this.stats.rttMs = this.now() - this.pingSentAt;
          this.pingSentAt = null;
        }
        return;
      case 'warning':
        h.onWarning?.(String(msg.text ?? ''));
        return;
      case 'error': {
        const fatal = Boolean(msg.fatal);
        const textMsg = String(msg.text ?? 'host error');
        h.onError?.(textMsg, fatal);
        if (fatal) this.fail(textMsg);
        return;
      }
      default:
        this.stats.badMessages += 1;
    }
  }

  /** Drop to `error`, tear the socket down, and arm the next retry. */
  private fail(reason: string): void {
    if (this.closed) return;
    const was = this.socket;
    this.socket = null;
    this._ready = false;
    if (was) {
      was.onopen = was.onclose = was.onerror = was.onmessage = null;
      try {
        was.close();
      } catch {
        /* already gone */
      }
    }
    this.pending = [];
    this.opts.handlers.onStatus?.('error', reason);
    this.armRetry();
  }

  private armRetry(): void {
    if (this.closed || this.retryHandle !== null) return;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      if (this.closed) return;
      // The session may have died with its process; the registry gets the
      // chance to re-create it and name the new socket.
      const next = this.opts.resolveUrl ? this.opts.resolveUrl() : this.url;
      if (!next) {
        // No session to connect to. Keep backing off rather than spinning.
        this.armRetry();
        return;
      }
      this.url = next;
      this.openSocket();
    }, delay);
  }

  /* ── outgoing ───────────────────────────────────────────────────────────── */

  /**
   * Send one block of input audio. Dropped (and counted) whenever the session
   * is not live — the worklet is passing dry signal in that state, so a block
   * that arrived late would be audio the user already heard.
   */
  sendAudio(header: VstFrameHeader, channels: readonly Float32Array[]): void {
    if (!this._ready) {
      this.stats.droppedIn += 1;
      return;
    }
    // The block is numbered by the SOCKET, not by whoever produced it. The producer is an audio
    // worklet, and the engine builds a new one on every Play, every seek while playing and every
    // loop wrap — each counting from 0 again — while this client (and its `lastOutSeq`) lives as
    // long as the session. The host echoes the number it was sent, so after the first rebuild
    // every processed block came back numbered BELOW the last one delivered and was thrown away as
    // a straggler: the plugin dropped out of the path, the track played dry, and the row went on
    // saying LIVE, until the new worklet had counted past the old one's total.
    const seq = this.nextInSeq;
    this.nextInSeq = seq >= 0xffffffff ? 0 : seq + 1;
    if (seq === 0) this.lastOutSeq = -1; // first block, or the u32 wrapped: the echo starts over too
    if (!this.raw(packFrame({ ...header, seq }, channels))) this.stats.droppedIn += 1;
  }

  /** Set one parameter by index. `value` is NORMALIZED (0..1), per the contract. */
  setParam(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`vstLive/bridgeClient: param index must be a non-negative integer, got ${index}`);
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`vstLive/bridgeClient: param value must be normalized 0..1, got ${value}`);
    }
    this.op({ op: 'set_param', index, value });
  }

  getParams(): void {
    this.op({ op: 'get_params' });
  }

  sendMidi(events: readonly VstMidiEvent[]): void {
    if (this.closed || !this._ready || events.length === 0) return;
    this.raw(JSON.stringify({ op: 'midi', events }));
  }

  midiPanic(): void {
    if (this.closed || !this._ready) return;
    this.raw(JSON.stringify({ op: 'midi_panic' }));
  }

  paramText(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(value)) return;
    this.op({ op: 'param_text', index, value: Math.max(0, Math.min(1, value)) });
  }

  /** Restore the plugin from a base64 state container (the same blob the
   *  offline pedalboard path stores in `ChainEntry.vst.raw_state`). */
  setState(stateB64: string): void {
    this.lastStateB64 = stateB64;
    this.op({ op: 'set_state', state_b64: stateB64 });
  }

  getState(): void {
    this.op({ op: 'get_state' });
  }

  openEditor(o: VstEditorOpenOptions = {}): void {
    // The one place a LIVE plugin window can be asked for (see editorWindowSwitch.ts).
    if (editorWindowsSuppressed()) {
      console.info(LIVE_EDITOR_SUPPRESSED_LOG);
      return;
    }
    const body: Record<string, unknown> = { op: 'open_editor' };
    if (o.parentHwnd !== undefined) body.parent_hwnd = o.parentHwnd;
    if (o.x !== undefined) body.x = o.x;
    if (o.y !== undefined) body.y = o.y;
    if (o.w !== undefined) body.w = o.w;
    if (o.h !== undefined) body.h = o.h;
    if (o.title !== undefined) body.title = o.title;
    this.op(body);
  }

  /** Move or clip an embedded editor. All values are PHYSICAL px. */
  editorRect(rect: VstEditorRect): void {
    this.op({ op: 'editor_rect', ...rect });
  }

  closeEditor(): void {
    this.op({ op: 'close_editor' });
  }

  bypass(on: boolean): void {
    this.op({ op: 'bypass', on });
  }

  /**
   * Try to reconnect NOW instead of waiting out the backoff, and start the
   * backoff over.
   *
   * The automatic retry already recovers a host that comes back on its own, but
   * it can be up to 5 s away, and a user who has just fixed the thing that broke
   * (restarted the backend, built the host binary) should not have to wait or
   * press stop/play to force a chain rebuild. No-op while the session is
   * healthy or after `close()`.
   */
  retryNow(): void {
    if (this.closed || this._ready || this.socket) return;
    if (this.retryHandle !== null) {
      this.cancelTimer(this.retryHandle);
      this.retryHandle = null;
    }
    this.retryAttempt = 0;
    const next = this.opts.resolveUrl ? this.opts.resolveUrl() : this.url;
    if (!next) {
      // Nothing to connect to yet (the session is being re-created); fall back
      // to the timer rather than spinning.
      this.armRetry();
      return;
    }
    this.url = next;
    this.openSocket();
  }

  /** Measure the round trip. The answer lands in `stats.rttMs`. */
  ping(): void {
    const t = this.now();
    this.pingSentAt = t;
    this.op({ op: 'ping', t });
  }

  /**
   * Close for good: no reconnect, no pending timer, socket shut. Idempotent,
   * and safe to call from a `dispose()` that races an in-flight open.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._ready = false;
    if (this.retryHandle !== null) {
      this.cancelTimer(this.retryHandle);
      this.retryHandle = null;
    }
    const s = this.socket;
    this.socket = null;
    this.pending = [];
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      try {
        s.close();
      } catch {
        /* already gone */
      }
    }
    this.opts.handlers.onStatus?.('off');
  }
}
