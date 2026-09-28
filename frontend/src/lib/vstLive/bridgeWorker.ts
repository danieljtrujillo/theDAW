/**
 * vstLive/bridgeWorker — the Worker that owns one live plugin's WebSocket.
 *
 * Every real audio host keeps the audio callback off the message thread: JUCE
 * runs `processBlock` on the driver's own thread and never lets the message
 * thread block it. The browser's main thread is theDAW's message thread — it
 * lays out the timeline, paints the meters, runs React — and until this file
 * existed every block crossed it twice:
 *
 *   worklet -> MAIN -> socket -> host -> socket -> MAIN -> worklet
 *
 * A 50-120 ms main-thread stall (a zoom, a panel opening) therefore stalled the
 * audio path too, and the worklet's play-out reserve is only 32-43 ms: about six
 * audible dry blips a second per plugin under load. Here the path is
 *
 *   worklet <-MessageChannel-> THIS WORKER <-socket-> host
 *
 * and main carries nothing but control ops and events. A stalled main thread
 * now costs a late meter, not a dropout.
 *
 * `createBridgeWorker` is the whole of it, and takes its `post`, its client and
 * its clock as arguments, so the message handling is testable with no Worker,
 * no socket and no timers. The `self.onmessage` wiring at the bottom is the
 * only part that needs a real worker scope.
 *
 * Units: `*Samples` are sample frames; `BRIDGE_WORKER_STATS_MS` is milliseconds.
 */
import {
  VstBridgeClient,
  type VstBridgeClientLike,
  type VstBridgeClientOptions,
  type VstBridgeStats,
  type VstEditorOpenOptions,
  type VstEditorRect,
  type VstMidiEvent,
  type VstParamDescriptor,
  type VstReadyEvent,
} from './bridgeClient';
import { headerFromBlock, type VstBlockMessage, type VstFrame, type VstFrameHeader } from './frames';

/** Shortest gap between two `stats` snapshots, in ms. The counters are a health
 *  readout on a row nobody stares at frame by frame; posting one per audio
 *  block would put ~94 messages a second on main for no one's benefit. */
export const BRIDGE_WORKER_STATS_MS = 500;

/** The worklet's end of the audio channel, as little of a `MessagePort` as this
 *  module needs — so a test can hand it a plain object. */
export interface BridgeAudioPort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown, transfer?: unknown[]): void;
  close?(): void;
  start?(): void;
}

/** The control methods main can ask this worker's client to call. */
export type BridgeWorkerOp =
  | 'setParam'
  | 'getParams'
  | 'paramText'
  | 'setState'
  | 'getState'
  | 'openEditor'
  | 'editorRect'
  | 'closeEditor'
  | 'bypass'
  | 'ping'
  | 'sendMidi'
  | 'midiPanic'
  | 'sendAudio';

/** Main -> worker. */
export type BridgeWorkerCommand =
  | { cmd: 'init'; opts: { url: string; retryBaseMs?: number; retryMaxMs?: number } }
  | { cmd: 'connect' }
  | { cmd: 'close' }
  | { cmd: 'retryNow' }
  | { cmd: 'url'; url: string | null }
  | { cmd: 'op'; name: BridgeWorkerOp; args: unknown[] }
  | { cmd: 'audio-port'; port: BridgeAudioPort };

/** The client fields the app reads directly, mirrored to main on every change. */
export interface BridgeWorkerFields {
  ready: boolean;
  blockSize: number;
  sampleRate: number;
  channelsOut: number;
  pluginLatencySamples: number;
  hasEditor: boolean;
}

/** Worker -> main. One per handler, plus the two snapshots. */
export type BridgeWorkerEvent =
  | { ev: 'status'; status: 'starting' | 'live' | 'error' | 'off'; reason?: string }
  | { ev: 'ready'; ready: VstReadyEvent }
  | { ev: 'latency'; latencySamples: number }
  | { ev: 'param'; index: number; value: number; text?: string }
  | { ev: 'param_text'; index: number; value: number; text: string }
  | { ev: 'param_gesture'; index: number; begin: boolean }
  | { ev: 'params'; list: VstParamDescriptor[] }
  | { ev: 'state'; stateB64: string }
  | { ev: 'editor'; open: boolean; w: number; h: number }
  | { ev: 'xrun'; lateBlocks: number; maxProcessMs: number }
  | { ev: 'warning'; text: string }
  | { ev: 'error'; text: string; fatal: boolean }
  | { ev: 'fields'; fields: BridgeWorkerFields }
  | { ev: 'stats'; stats: VstBridgeStats };

export interface BridgeWorkerDeps {
  /** Send one event to main. `transfer` is honoured where it matters. */
  post: (msg: BridgeWorkerEvent, transfer?: unknown[]) => void;
  /** Test seam: build the socket client. */
  makeClient?: (opts: VstBridgeClientOptions) => VstBridgeClientLike;
  now?: () => number;
}

export interface BridgeWorkerHandler {
  handle(msg: BridgeWorkerCommand): void;
}

/**
 * Build the worker's message handling around one bridge client.
 *
 * Nothing here is allowed to forward audio to main: `onAudio` goes to the audio
 * port and only to the audio port. That is the entire point of the file, so it
 * is the one rule with a test of its own.
 */
export function createBridgeWorker(deps: BridgeWorkerDeps): BridgeWorkerHandler {
  const post = deps.post;
  const now = deps.now ?? (() => Date.now());
  const makeClient = deps.makeClient ?? ((opts: VstBridgeClientOptions) => new VstBridgeClient(opts));

  let client: VstBridgeClientLike | null = null;
  let audioPort: BridgeAudioPort | null = null;
  let closed = false;
  /** The last url main resolved. The client asks for it before every retry, so
   *  a session that had to be re-created is dialed at its NEW port without the
   *  worker knowing anything about sessions. */
  let url: string | null = null;

  const fields: BridgeWorkerFields = {
    ready: false,
    blockSize: 0,
    sampleRate: 0,
    channelsOut: 0,
    pluginLatencySamples: 0,
    hasEditor: false,
  };
  const stats: VstBridgeStats = {
    lateBlocks: 0,
    maxProcessMs: 0,
    rttMs: -1,
    outOfOrder: 0,
    droppedIn: 0,
    badFrames: 0,
    badMessages: 0,
    reconnects: 0,
  };
  let statsPostedAt = Number.NEGATIVE_INFINITY;

  /** Mirror the client's fields to main if any of them moved. */
  const syncFields = (): void => {
    const c = client;
    if (!c) return;
    if (
      c.ready === fields.ready &&
      c.blockSize === fields.blockSize &&
      c.sampleRate === fields.sampleRate &&
      c.channelsOut === fields.channelsOut &&
      c.pluginLatencySamples === fields.pluginLatencySamples &&
      c.hasEditor === fields.hasEditor
    ) {
      return;
    }
    fields.ready = c.ready;
    fields.blockSize = c.blockSize;
    fields.sampleRate = c.sampleRate;
    fields.channelsOut = c.channelsOut;
    fields.pluginLatencySamples = c.pluginLatencySamples;
    fields.hasEditor = c.hasEditor;
    post({ ev: 'fields', fields: { ...fields } });
  };

  /**
   * Announce one event.
   *
   * The field snapshot goes FIRST, always: the node reads `client.blockSize`
   * the moment the store tells it the session is live, and the store is only
   * told by the handler this is about to run. Out of order, the first worklet
   * of every session would be built at the default block size.
   */
  const emit = (event: BridgeWorkerEvent): void => {
    syncFields();
    post(event);
  };

  /** Post the health counters, at most one every {@link BRIDGE_WORKER_STATS_MS}
   *  and only when one of them actually moved. */
  const maybeStats = (): void => {
    const c = client;
    if (!c) return;
    const t = now();
    if (t - statsPostedAt < BRIDGE_WORKER_STATS_MS) return;
    const s = c.stats;
    if (
      s.lateBlocks === stats.lateBlocks &&
      s.maxProcessMs === stats.maxProcessMs &&
      s.rttMs === stats.rttMs &&
      s.outOfOrder === stats.outOfOrder &&
      s.droppedIn === stats.droppedIn &&
      s.badFrames === stats.badFrames &&
      s.badMessages === stats.badMessages &&
      s.reconnects === stats.reconnects
    ) {
      // Nothing moved. The window is deliberately NOT restarted, so the next
      // real change is announced the moment it happens.
      return;
    }
    Object.assign(stats, s);
    statsPostedAt = t;
    post({ ev: 'stats', stats: { ...stats } });
  };

  /** Hand one processed block back to the worklet, buffers and all. */
  const sendProcessed = (frame: VstFrame): void => {
    const port = audioPort;
    // No port means nobody is playing this back. Posting it to main instead is
    // exactly the thing this worker exists to stop, so the block is dropped —
    // the worklet is passing delayed dry signal in that state anyway.
    if (!port) return;
    port.postMessage(
      { type: 'processed', seq: frame.header.seq, frames: frame.header.frames, channels: frame.channels },
      frame.channels.map((c) => c.buffer),
    );
  };

  /** One accumulated block from the worklet goes straight onto the socket. */
  const onAudioPortMessage = (data: unknown): void => {
    const msg = data as { type?: string } | null | undefined;
    if (!msg || msg.type !== 'block') return;
    const b = msg as unknown as VstBlockMessage;
    client?.sendAudio(headerFromBlock(b), b.channels);
    maybeStats();
  };

  const setAudioPort = (next: BridgeAudioPort | null): void => {
    const previous = audioPort;
    audioPort = next;
    if (previous && previous !== next) {
      previous.onmessage = null;
      try {
        previous.close?.();
      } catch {
        /* already gone */
      }
    }
    if (next) {
      next.onmessage = (ev) => onAudioPortMessage(ev.data);
      next.start?.();
    }
  };

  /** Run one control op. Written out rather than dispatched by name so an
   *  unknown message can never reach a method of something else. */
  const runOp = (name: BridgeWorkerOp, args: unknown[]): void => {
    const c = client;
    if (!c) return;
    switch (name) {
      case 'setParam':
        c.setParam(args[0] as number, args[1] as number);
        break;
      case 'getParams':
        c.getParams();
        break;
      case 'setState':
        c.setState(args[0] as string);
        break;
      case 'getState':
        c.getState();
        break;
      case 'openEditor':
        c.openEditor((args[0] ?? {}) as VstEditorOpenOptions);
        break;
      case 'editorRect':
        c.editorRect(args[0] as VstEditorRect);
        break;
      case 'closeEditor':
        c.closeEditor();
        break;
      case 'bypass':
        c.bypass(Boolean(args[0]));
        break;
      case 'paramText':
        c.paramText(Number(args[0]), Number(args[1]));
        break;
      case 'ping':
        c.ping();
        break;
      case 'sendMidi':
        c.sendMidi?.(args[0] as VstMidiEvent[]);
        break;
      case 'midiPanic':
        c.midiPanic?.();
        break;
      case 'sendAudio':
        c.sendAudio(args[0] as VstFrameHeader, args[1] as Float32Array[]);
        break;
      default:
        return;
    }
    syncFields();
    maybeStats();
  };

  const init = (opts: { url: string; retryBaseMs?: number; retryMaxMs?: number }): void => {
    // One socket per worker, for the life of the worker: a second init would
    // orphan the first client with its socket still open.
    if (client || closed) return;
    url = opts.url;
    client = makeClient({
      url: opts.url,
      retryBaseMs: opts.retryBaseMs,
      retryMaxMs: opts.retryMaxMs,
      resolveUrl: () => url,
      handlers: {
        onStatus: (status, reason) => {
          emit({ ev: 'status', status, reason });
          maybeStats();
        },
        onReady: (ready) => emit({ ev: 'ready', ready }),
        onAudio: (frame) => sendProcessed(frame),
        onLatency: (latencySamples) => emit({ ev: 'latency', latencySamples }),
        onParam: (index, value, text) => emit({ ev: 'param', index, value, text }),
        onParamText: (index, value, text) => emit({ ev: 'param_text', index, value, text }),
        onParamGesture: (index, begin) => emit({ ev: 'param_gesture', index, begin }),
        onParams: (list) => emit({ ev: 'params', list }),
        onState: (stateB64) => emit({ ev: 'state', stateB64 }),
        onEditor: (e) => emit({ ev: 'editor', open: e.open, w: e.w, h: e.h }),
        onXrun: (lateBlocks, maxProcessMs) => {
          emit({ ev: 'xrun', lateBlocks, maxProcessMs });
          maybeStats();
        },
        onWarning: (text) => emit({ ev: 'warning', text }),
        onError: (text, fatal) => emit({ ev: 'error', text, fatal }),
      },
    });
  };

  return {
    handle(msg: BridgeWorkerCommand): void {
      if (!msg) return;
      switch (msg.cmd) {
        case 'init':
          init(msg.opts);
          return;
        case 'connect':
          if (!closed) client?.connect();
          return;
        case 'close': {
          if (closed) return;
          closed = true;
          // Main terminates this worker when the `off` lands, so one must
          // always land — including when there is no client to produce it.
          if (client) client.close();
          else post({ ev: 'status', status: 'off' });
          setAudioPort(null);
          return;
        }
        case 'retryNow':
          if (!closed) client?.retryNow();
          return;
        case 'url':
          url = msg.url;
          return;
        case 'op':
          if (!closed) runOp(msg.name, msg.args ?? []);
          return;
        case 'audio-port':
          if (!closed) setAudioPort(msg.port ?? null);
          return;
        default:
          return;
      }
    },
  };
}

/* ── the worker scope ──────────────────────────────────────────────────────── */

interface BridgeWorkerScope {
  onmessage: ((ev: { data: BridgeWorkerCommand }) => void) | null;
  postMessage?: (msg: unknown, transfer?: unknown[]) => void;
}

const scope = globalThis as unknown as BridgeWorkerScope;

// Wired only where this module really is a worker's global scope. A worker has
// no `document`, and only a worker (or a port) has a global `postMessage` — so
// importing this file from a test under tsx, where neither holds, defines the
// handler and touches nothing else.
if (
  typeof (globalThis as { document?: unknown }).document === 'undefined' &&
  typeof scope.postMessage === 'function'
) {
  const send = scope.postMessage.bind(scope);
  const handler = createBridgeWorker({ post: (msg, transfer) => send(msg, transfer) });
  scope.onmessage = (ev) => handler.handle(ev.data);
}
