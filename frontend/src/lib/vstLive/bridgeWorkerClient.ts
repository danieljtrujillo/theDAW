/**
 * vstLive/bridgeWorkerClient — the main thread's handle on a bridge Worker.
 *
 * It looks exactly like `VstBridgeClient` to everything above it (see
 * `VstBridgeClientLike`), and does none of the work: the socket, the audio and
 * the retry state machine all live in `bridgeWorker.ts`. What crosses this
 * class is control ops one way and events the other — no audio, in either
 * direction, ever. That is the whole point: a main thread busy laying out the
 * timeline can no longer stall a plugin's signal path.
 *
 * Two things deliberately stay HERE rather than travelling to the worker:
 *
 *  - the plugin-window switch (`editorWindowSwitch.ts`), because it is read out
 *    of `localStorage` and a worker has none;
 *  - the answer to "which url should the next retry dial", because that is the
 *    session registry's business and the registry lives on this thread. The
 *    worker asks by losing the session; this class answers by pushing the url
 *    whenever it changes, until the session is live again.
 *
 * Units: `VST_BRIDGE_URL_PUSH_MS` is milliseconds; `*Samples` are sample frames.
 */
import { VstBridgeClient, type VstBridgeClientLike, type VstBridgeClientOptions, type VstBridgeStats, type VstEditorOpenOptions, type VstEditorRect, type VstMidiEvent } from './bridgeClient';
import type { BridgeAudioPort, BridgeWorkerCommand, BridgeWorkerEvent, BridgeWorkerOp } from './bridgeWorker';
import { editorWindowsSuppressed, LIVE_EDITOR_SUPPRESSED_LOG } from './editorWindowSwitch';
import type { VstFrameHeader } from './frames';

/** Set to `'1'` to put the bridge back on the main thread, for comparing the
 *  two paths or working around a browser bug in the worker one. */
export const VST_MAIN_THREAD_BRIDGE_KEY = 'thedaw.vst.mainThreadBridge';

/** How often a disconnected worker is offered a fresh url, in ms. Short enough
 *  that a re-created session is dialed on the client's first backoff step. */
export const VST_BRIDGE_URL_PUSH_MS = 250;

/** The subset of `Worker` this class uses, so a fake can stand in. */
export interface BridgeWorkerLike {
  postMessage(msg: unknown, transfer?: unknown[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type BridgeWorkerFactory = () => BridgeWorkerLike;

/** The real thing. Vite resolves this URL at build time and emits the worker as
 *  its own module chunk. */
const defaultWorkerFactory: BridgeWorkerFactory = () =>
  new Worker(new URL('./bridgeWorker.ts', import.meta.url), { type: 'module' }) as unknown as BridgeWorkerLike;

export class VstBridgeWorkerClient implements VstBridgeClientLike {
  private readonly opts: VstBridgeClientOptions;
  private readonly worker: BridgeWorkerLike;
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancelTimer: (handle: number) => void;

  /** close() has been asked for: nothing more is sent, and the worker is
   *  terminated as soon as it has answered with its `off`. */
  private closing = false;
  private terminated = false;
  private urlTimer: number | null = null;
  /** The last url pushed to the worker, so an unchanged one costs no message. */
  private lastUrlPushed: string | null;
  private _ready = false;

  blockSize = 0;
  sampleRate = 0;
  channelsOut = 0;
  pluginLatencySamples = 0;
  hasEditor = false;
  acceptsMidi = false;

  /** Mutated in place, never replaced: the FX row and the logs hold on to this
   *  object the same way they hold `VstBridgeClient.stats`. */
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

  constructor(opts: VstBridgeClientOptions, makeWorker: BridgeWorkerFactory = defaultWorkerFactory) {
    this.opts = opts;
    this.schedule = opts.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.cancelTimer = opts.cancel ?? ((h) => globalThis.clearTimeout(h as unknown as number));
    this.lastUrlPushed = opts.url;
    this.worker = makeWorker();
    this.worker.onmessage = (ev) => this.onWorkerMessage(ev.data as BridgeWorkerEvent);
    this.worker.onerror = (e) => this.onWorkerError(e);
    this.post({
      cmd: 'init',
      opts: { url: opts.url, retryBaseMs: opts.retryBaseMs, retryMaxMs: opts.retryMaxMs },
    });
  }

  /** True only while the worker says the host has answered `ready`. */
  get ready(): boolean {
    return this._ready;
  }

  private post(cmd: BridgeWorkerCommand, transfer?: unknown[]): void {
    if (this.closing) return;
    this.worker.postMessage(cmd, transfer);
  }

  private op(name: BridgeWorkerOp, args: unknown[]): void {
    this.post({ cmd: 'op', name, args });
  }

  /* ── worker -> main ──────────────────────────────────────────────────────── */

  private onWorkerMessage(msg: BridgeWorkerEvent): void {
    if (!msg) return;
    const h = this.opts.handlers;
    switch (msg.ev) {
      case 'fields': {
        const f = msg.fields;
        this._ready = f.ready;
        this.blockSize = f.blockSize;
        this.sampleRate = f.sampleRate;
        this.channelsOut = f.channelsOut;
        this.pluginLatencySamples = f.pluginLatencySamples;
        this.hasEditor = f.hasEditor;
        // A session that came up needs no url; one that went down is already
        // being polled by the status branch below.
        if (f.ready) this.stopUrlPolling();
        return;
      }
      case 'stats':
        Object.assign(this.stats, msg.stats);
        return;
      case 'status': {
        h.onStatus?.(msg.status, msg.reason);
        if (this.closing) {
          // The close we asked for has completed: the socket is shut and the
          // thread can go, rather than idling for the life of the page.
          if (msg.status === 'off') this.shutdownWorker();
          return;
        }
        if (msg.status === 'live') this.stopUrlPolling();
        else this.startUrlPolling();
        return;
      }
      case 'ready':
        this.acceptsMidi = msg.ready.accepts_midi === true;
        h.onReady?.(msg.ready);
        return;
      case 'latency':
        h.onLatency?.(msg.latencySamples);
        return;
      case 'param':
        h.onParam?.(msg.index, msg.value, msg.text);
        break;
      case 'param_text':
        h.onParamText?.(msg.index, msg.value, msg.text);
        break;
      case 'param_gesture':
        h.onParamGesture?.(msg.index, msg.begin);
        return;
      case 'params':
        h.onParams?.(msg.list);
        return;
      case 'state':
        h.onState?.(msg.stateB64);
        return;
      case 'editor':
        h.onEditor?.({ open: msg.open, w: msg.w, h: msg.h });
        return;
      case 'xrun':
        h.onXrun?.(msg.lateBlocks, msg.maxProcessMs);
        return;
      case 'warning':
        h.onWarning?.(msg.text);
        return;
      case 'error':
        h.onError?.(msg.text, msg.fatal);
        return;
      default:
        return;
    }
  }

  /**
   * The worker script itself could not run (blocked, failed to parse, out of
   * memory). Nothing will recover from that, so it is reported rather than left
   * to look like a session that is still starting.
   */
  private onWorkerError(e: unknown): void {
    const detail = (e as { message?: unknown } | null)?.message;
    const text = `the live bridge worker could not run${detail ? `: ${String(detail)}` : ''}`;
    console.error(`[vstLive] ${text}`);
    this.opts.handlers.onError?.(text, true);
    this.opts.handlers.onStatus?.('error', text);
  }

  /* ── the url the worker's next retry should dial ─────────────────────────── */

  private pushUrl(): void {
    const resolve = this.opts.resolveUrl;
    if (!resolve) return; // the url never changes: the worker already has it
    const next = resolve();
    if (next === this.lastUrlPushed) return;
    this.lastUrlPushed = next;
    this.post({ cmd: 'url', url: next });
  }

  private startUrlPolling(): void {
    this.pushUrl();
    if (this.urlTimer !== null) return;
    const tick = (): void => {
      this.urlTimer = null;
      if (this.closing || this._ready) return;
      this.pushUrl();
      this.urlTimer = this.schedule(tick, VST_BRIDGE_URL_PUSH_MS);
    };
    this.urlTimer = this.schedule(tick, VST_BRIDGE_URL_PUSH_MS);
  }

  private stopUrlPolling(): void {
    if (this.urlTimer === null) return;
    this.cancelTimer(this.urlTimer);
    this.urlTimer = null;
  }

  private shutdownWorker(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
  }

  /* ── the VstBridgeClientLike surface ─────────────────────────────────────── */

  connect(): void {
    this.post({ cmd: 'connect' });
  }

  close(): void {
    if (this.closing) return;
    this.stopUrlPolling();
    // Sent BEFORE the flag, because `post` refuses to send once it is set.
    this.worker.postMessage({ cmd: 'close' } satisfies BridgeWorkerCommand);
    this.closing = true;
  }

  retryNow(): void {
    this.post({ cmd: 'retryNow' });
  }

  /**
   * The fallback path's send: only a node that could not hand the worklet a
   * MessagePort ever calls this. The channel buffers are TRANSFERRED, not
   * copied — they came straight off the worklet's own transfer and nobody on
   * this thread reads them again.
   */
  sendAudio(header: VstFrameHeader, channels: readonly Float32Array[]): void {
    const list = channels as Float32Array[];
    this.post({ cmd: 'op', name: 'sendAudio', args: [header, list] }, list.map((c) => c.buffer));
  }

  /** Set one parameter by index. `value` is NORMALIZED (0..1), per the contract.
   *  Checked here so a caller that has lost track of its own range hears about
   *  it on its own stack, exactly as the main-thread client tells it. */
  setParam(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`vstLive/bridgeWorkerClient: param index must be a non-negative integer, got ${index}`);
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`vstLive/bridgeWorkerClient: param value must be normalized 0..1, got ${value}`);
    }
    this.op('setParam', [index, value]);
  }

  getParams(): void {
    this.op('getParams', []);
  }

  /** Sent only while ready, as the main-thread client does. */
  sendMidi(events: readonly VstMidiEvent[]): void {
    if (!this._ready || events.length === 0) return;
    this.op('sendMidi', [events]);
  }

  midiPanic(): void {
    if (!this._ready) return;
    this.op('midiPanic', []);
  }

  setState(stateB64: string): void {
    this.op('setState', [stateB64]);
  }

  getState(): void {
    this.op('getState', []);
  }

  openEditor(o: VstEditorOpenOptions = {}): void {
    // The one place a LIVE plugin window can be asked for on this path: the
    // worker cannot make this call, because the switch lives in localStorage
    // and a worker has none (see editorWindowSwitch.ts).
    if (editorWindowsSuppressed()) {
      console.info(LIVE_EDITOR_SUPPRESSED_LOG);
      return;
    }
    this.op('openEditor', [o]);
  }

  editorRect(rect: VstEditorRect): void {
    this.op('editorRect', [rect]);
  }

  closeEditor(): void {
    this.op('closeEditor', []);
  }

  bypass(on: boolean): void {
    this.op('bypass', [on]);
  }

  paramText(index: number, value: number): void {
    this.op('paramText', [index, value]);
  }

  ping(): void {
    this.op('ping', []);
  }

  /** Give the worker the worklet's end of the audio channel. From here on no
   *  audio block touches this thread at all. */
  attachAudioPort(port: MessagePort): void {
    this.post({ cmd: 'audio-port', port: port as unknown as BridgeAudioPort }, [port]);
  }
}

/* ── which client the app should build ─────────────────────────────────────── */

/** True when the main-thread bridge has been asked for explicitly. Storage that
 *  cannot be read at all is not a request for it. */
export function mainThreadBridgeForced(): boolean {
  try {
    return globalThis.localStorage?.getItem(VST_MAIN_THREAD_BRIDGE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface DefaultBridgeClientDeps {
  hasWorker?: () => boolean;
  forced?: () => boolean;
  makeWorkerClient?: (opts: VstBridgeClientOptions) => VstBridgeClientLike;
  makeMainClient?: (opts: VstBridgeClientOptions) => VstBridgeClientLike;
  warn?: (text: string) => void;
}

/** One line per page, not one per plugin: a runtime that refuses workers
 *  refuses all of them. */
let warnedWorkerFailed = false;

/**
 * Build the bridge client for one session: the worker one wherever the runtime
 * can run it, the main-thread one everywhere else.
 *
 * `MessageChannel` is part of the test because the worker path needs one to
 * carry audio: with a Worker but no channel, blocks would have nowhere to go
 * but main, which is the situation this whole change exists to end.
 */
export function createDefaultBridgeClient(
  opts: VstBridgeClientOptions,
  deps: DefaultBridgeClientDeps = {},
): VstBridgeClientLike {
  const hasWorker =
    deps.hasWorker ?? (() => typeof Worker !== 'undefined' && typeof MessageChannel !== 'undefined');
  const makeMain = deps.makeMainClient ?? ((o: VstBridgeClientOptions) => new VstBridgeClient(o));
  const forced = deps.forced ?? mainThreadBridgeForced;
  if (!hasWorker() || forced()) return makeMain(opts);
  try {
    return (deps.makeWorkerClient ?? ((o: VstBridgeClientOptions) => new VstBridgeWorkerClient(o)))(opts);
  } catch (e: unknown) {
    // A refused Worker must not cost the user their plugin: the main-thread
    // bridge still works, it just puts the audio back through this thread.
    if (!warnedWorkerFailed) {
      warnedWorkerFailed = true;
      const text = `[vstLive] the bridge worker could not be created (${e instanceof Error ? e.message : String(e)}); live plugins fall back to the main-thread bridge`;
      (deps.warn ?? console.warn)(text);
    }
    return makeMain(opts);
  }
}
