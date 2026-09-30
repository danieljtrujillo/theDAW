/**
 * vstLive/vstLiveNode — a `vst3` chain entry as a live Web Audio node.
 *
 * `buildEffectChain` is SYNCHRONOUS and runs on every play / stop / seek, while
 * opening a plugin is seconds of async work (spawn a process, load the binary,
 * restore its state, negotiate buses). So this follows `makeChop`'s shape: the
 * factory returns a passthrough immediately, opens the session in the
 * background, and swaps the worklet in when the session goes live. The entry is
 * audible from the first quantum and NEVER silent — a plugin that cannot open
 * costs the user the effect, not their audio.
 *
 * ```
 *              ┌─ dry ──────────────────────────┐
 *   input ─────┤                                ├──► output
 *              └─ vst-bridge worklet ─► wet ────┘
 * ```
 *
 * The crossfade at the swap is a short linear ramp on the two gains. It is not
 * perfectly transparent — the worklet's output is the same signal delayed by
 * the bridge's fixed latency, so for the length of the ramp the two paths comb
 * — but the alternative is a hard switch between an undelayed and a delayed
 * copy, which is a click. A short ramp once per session is the cheaper artifact.
 *
 * The worklet does the audio; this module does the plumbing: quanta -> blocks
 * over the port, blocks -> WebSocket, processed blocks back. Transport state
 * (playing / position / tempo / discontinuity) is broadcast to every live node
 * through `broadcastVstTransport`, by liveMixer for EDIT and by
 * lib/performTransport for PERFORM's grid, except to an entry on a
 * transport of its own (`setVstEntryTransport`: a piano-roll part's instrument,
 * which plays on the roll's clock).
 *
 * Units: `positionSamples` is sample frames on the project timeline;
 * `tempoBpm` is beats per minute; `SWAP_RAMP_SEC` is seconds.
 */
import { headerFromBlock, type VstBlockMessage, type VstFrame } from './frames';
import type { VstBridgeClientLike } from './bridgeClient';
import {
  VST_LIVE_BLOCK_SIZE,
  VST_LIVE_BUFFER_BLOCKS,
  VST_LIVE_CHANNELS,
  vstSessions,
  type VstLiveSession,
  type VstSessionRegistry,
} from './sessionRegistry';
import { useVstLiveStore } from '../../state/vstLiveStore';
import type { RackEffectInstance } from '../rackEffects';
import type { ChainEntry } from '../../state/effectChainStore';
// From the storage module, NOT effectChainStore: that store imports
// rackEffects, which imports this module, and the cycle breaks initialization.
import { areVstStatesLoaded, loadedVstEntry, vstStatesLoaded } from '../vstStateStorage';
import { addWorkletModule, audioWorkletAvailable } from '../audioWorkletSupport';

/** Absolute URL of the worklet module, served from `frontend/public`. */
export const VST_BRIDGE_WORKLET_URL = '/vst-bridge.worklet.js';
/** The processor name `vst-bridge.worklet.js` registers. */
export const VST_BRIDGE_PROCESSOR = 'vst-bridge';
/** Length of the dry/wet crossfade when the worklet is spliced in, in seconds. */
export const SWAP_RAMP_SEC = 0.02;

/** What the mixer tells every live plugin about the transport. */
export interface VstTransportInfo {
  playing: boolean;
  /** Timeline position of the next quantum, in sample frames (at `atTime` when given). */
  positionSamples: number;
  /** 0 = unknown. */
  tempoBpm: number;
  /** Start / seek / loop wrap: the host resets the plugin. */
  discontinuity: boolean;
  /**
   * The AudioContext time `positionSamples` was read at. A node that goes live
   * while the transport plays is told the position advanced by the time since,
   * so a plugin whose host opened seconds into playback lands where the
   * transport is and not where it was. Left out, the position is replayed as sent.
   */
  atSec?: number;
  /**
   * The context time `positionSamples` holds at, in seconds. The worklet runs
   * the position on from there to the quantum the message lands in, so a
   * position computed for a moment ahead (PLAY's first downbeat) is exact.
   * Absent: the position is taken as the next quantum's.
   */
  atTime?: number;
  /**
   * Advance the position every quantum even while `playing` is false, so MIDI
   * stamped on the position keeps its time with the transport stopped (a
   * piano-roll part's audition). Absent: the position holds while stopped.
   */
  freeRun?: boolean;
}

/* ── worklet module loading (one promise per context, as makeChop does) ─────── */

const moduleByCtx = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load `vst-bridge.worklet.js` into `ctx`, once per context. */
export function ensureVstBridgeModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleByCtx.get(ctx);
  if (!p) {
    p = addWorkletModule(ctx, VST_BRIDGE_WORKLET_URL).catch((e: unknown) => {
      moduleByCtx.delete(ctx); // a failed load must be retryable on the next build
      throw e;
    });
    moduleByCtx.set(ctx, p);
  }
  return p;
}

/* ── transport broadcast ───────────────────────────────────────────────────── */

/** Every live node's port, and the entry it hosts, so the transport reaches all of them in one call. */
const liveNodes = new Set<{ entryId: string; post: (msg: Record<string, unknown>) => void }>();
/**
 * Entries whose plugin follows a transport of its own rather than EDIT's: a
 * piano-roll part's instrument plays on the roll's clock (state/rollInstruments),
 * so EDIT's play, stop and seek never reach it. By entry id.
 */
const entryTransports = new Map<string, VstTransportInfo>();

/** The worklet message for `info`. */
const transportMessage = (info: VstTransportInfo): Record<string, unknown> => ({
  type: 'transport',
  playing: info.playing,
  positionSamples: info.positionSamples,
  tempoBpm: info.tempoBpm,
  discontinuity: info.discontinuity,
  ...(info.atTime !== undefined && Number.isFinite(info.atTime) ? { atTime: info.atTime } : {}),
  ...(info.freeRun ? { freeRun: true } : {}),
});
/** The last transport state, replayed into a node that appears mid-transport. */
let lastTransport: VstTransportInfo = {
  playing: false,
  positionSamples: 0,
  tempoBpm: 0,
  discontinuity: false,
};

/**
 * The transport a node that goes live on `ctx` is told: the last broadcast,
 * with its position carried forward to `ctx.currentTime` while it plays, and
 * always a discontinuity, since the plugin has never seen this stream before.
 */
function transportNow(ctx: BaseAudioContext, t: VstTransportInfo = lastTransport): Record<string, unknown> {
  let positionSamples = t.positionSamples;
  if (t.playing && t.atSec !== undefined && Number.isFinite(t.atSec)) {
    const elapsed = ctx.currentTime - t.atSec;
    if (elapsed > 0) positionSamples += Math.round(elapsed * ctx.sampleRate);
  }
  return { ...transportMessage(t), positionSamples, discontinuity: true };
}

/**
 * Tell every live plugin where the transport is. Called by liveMixer on start,
 * seek, loop wrap and stop, and by PERFORM's grid (lib/performTransport) on its
 * first launch, a tempo change and Stop; `discontinuity` is what makes the host
 * call the plugin's `reset()`, so a delay tail does not smear across a seek.
 */
export function broadcastVstTransport(info: VstTransportInfo): void {
  lastTransport = info;
  const msg = transportMessage(info);
  for (const n of liveNodes) if (!entryTransports.has(n.entryId)) n.post(msg);
}

/**
 * Put entry `entryId`'s plugin on a transport of its own (`info`), which EDIT's
 * broadcast then leaves alone; `null` hands it back to EDIT's transport, as a
 * jump. Reaches the entry's live node now, and one that goes live later.
 */
export function setVstEntryTransport(entryId: string, info: VstTransportInfo | null): void {
  if (info) entryTransports.set(entryId, info);
  else if (!entryTransports.delete(entryId)) return;
  const msg = transportMessage(info ?? { ...lastTransport, discontinuity: true });
  for (const n of liveNodes) if (n.entryId === entryId) n.post(msg);
}

/** The transport entry `entryId`'s plugin follows: its own, else EDIT's. */
export function vstEntryTransport(entryId: string): VstTransportInfo {
  return entryTransports.get(entryId) ?? lastTransport;
}

/* ── the factory ───────────────────────────────────────────────────────────── */

/** Seams for tests; the app passes none. */
/**
 * How long a disposed live node waits for the rebuild that usually follows it (ms).
 *
 * The engine rebuilds every FX chain on Play, on every seek while playing and on every loop wrap:
 * dispose, then create again for the same entry a few milliseconds later. A new bridge worklet
 * starts unprimed, so each of those used to let the DRY signal through for the 50-100 ms it takes
 * to refill the play-out buffer before the plugin ramped back in: an audible blip at every loop
 * point. A parked node keeps its worklet, its primed buffer and its claim on the session, and the
 * next `createVstLiveNode` for the same entry and context simply hands it back.
 */
export const VST_NODE_PARK_MS = 1500;

interface ParkedNode {
  ctx: BaseAudioContext;
  registry: VstSessionRegistry;
  /** The session the node is wired to; a revive is only valid while the registry still has it. */
  session: VstLiveSession;
  revive: (entry: ChainEntry) => RackEffectInstance;
  destroy: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const parkedNodes = new Map<string, ParkedNode>();

export interface VstLiveNodeDeps {
  registry?: VstSessionRegistry;
  /** Override {@link VST_NODE_PARK_MS}; 0 tears a disposed node down at once. */
  parkMs?: number;
  ensureModule?: (ctx: BaseAudioContext) => Promise<void>;
  makeWorklet?: (
    ctx: BaseAudioContext,
    name: string,
    options: Record<string, unknown>,
  ) => AudioWorkletNode;
}

/** An `OfflineAudioContext` in every runtime, without needing the constructor
 *  to exist (it does not under tsx). */
const isOffline = (ctx: BaseAudioContext): boolean =>
  typeof (ctx as unknown as { startRendering?: unknown }).startRendering === 'function';

const hasWorklet = (ctx: BaseAudioContext): boolean => audioWorkletAvailable(ctx);

/** `p<index>` is how a plugin parameter rides in `ChainEntry.params`, which is
 *  `Record<string, number>`: a VST3 parameter has an INDEX, not a name, and the
 *  entry has nowhere else to keep one. Values are normalized 0..1, as the
 *  protocol's `set_param` requires. */
const PARAM_KEY = /^p(\d+)$/;

/** A plain input -> output pass, for the cases that must not open a session. */
function passthrough(ctx: BaseAudioContext): RackEffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  return {
    input,
    output,
    setParams: () => {},
    dispose: () => {
      try {
        input.disconnect();
        output.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Whether `createVstLiveNode` will produce an instance for this entry. False
 * means the entry stays INERT and `buildEffectChain` reports it through
 * `inertIds()`, exactly as every `vst3` entry did before there was a live host:
 *
 *  - the entry carries no plugin path (a broken import),
 *  - the context has no `AudioWorklet` (a test double, a stripped runtime),
 *  - the host binary is known to be unavailable on this machine.
 *
 * An OFFLINE context answers TRUE and gets a passthrough: the offline render
 * keeps using `/api/vst/process-file`, and keeping the node shape identical
 * between preview and bounce means one less way for them to differ.
 *
 * `host.available === null` (not probed yet) is NOT a no: the node opens
 * optimistically and the registry corrects the row if the probe disagrees.
 */
export function canHostVstLive(ctx: BaseAudioContext, entry: ChainEntry): boolean {
  if (!entry.vst?.plugin_path) return false;
  if (!hasWorklet(ctx)) return false;
  if (isOffline(ctx)) return true;
  return useVstLiveStore.getState().host.available !== false;
}

/**
 * Build the live node for a `vst3` entry, or `null` when `canHostVstLive` says
 * the entry cannot be hosted here (the instance must then stay inert).
 */
export function createVstLiveNode(
  ctx: BaseAudioContext,
  entry: ChainEntry,
  deps: VstLiveNodeDeps = {},
): RackEffectInstance | null {
  if (!canHostVstLive(ctx, entry)) {
    // One case deserves a row: a real plugin on a real context that this
    // machine simply has no host binary for. The others are not about this
    // entry at all (no path, no worklet) and have nothing to report.
    const store = useVstLiveStore.getState();
    if (entry.vst?.plugin_path && hasWorklet(ctx) && !isOffline(ctx)) {
      store.setStatus(entry.id, 'unavailable', store.host.reason ?? 'live VST host is not available');
    }
    return null;
  }
  if (isOffline(ctx)) return passthrough(ctx);

  const registry = deps.registry ?? vstSessions;
  const parkMs = deps.parkMs ?? VST_NODE_PARK_MS;
  const waiting = parkedNodes.get(entry.id);
  if (waiting) {
    parkedNodes.delete(entry.id);
    clearTimeout(waiting.timer);
    // Same context, same registry, and the session it is wired to is still the entry's session
    // (a project close in between takes the sessions away): pick it up where it left off.
    if (waiting.ctx === ctx && waiting.registry === registry && registry.get(entry.id) === waiting.session) {
      return waiting.revive(entry);
    }
    waiting.destroy();
  }
  const ensureModule = deps.ensureModule ?? ensureVstBridgeModule;
  const makeWorklet =
    deps.makeWorklet ??
    ((c, name, options) => new AudioWorkletNode(c as AudioContext, name, options as AudioWorkletNodeOptions));

  const input = ctx.createGain();
  const dry = ctx.createGain();
  const output = ctx.createGain();
  input.connect(dry);
  dry.connect(output);

  let disposed = false;
  /** The entry as the chain last handed it over: a revive brings a newer object with the same id. */
  let currentEntry = entry;
  let session: VstLiveSession | null = null;
  let worklet: AudioWorkletNode | null = null;
  let wet: GainNode | null = null;
  let unsubStore: (() => void) | null = null;
  /** Last value sent per parameter index, so a rebuild's param re-push is not
   *  a burst of `set_param` for values the plugin already holds. */
  const sentParams = new Map<number, number>();
  let seq = 0;
  /** True while blocks travel worklet -> bridge worker over a MessageChannel,
   *  with this thread out of the audio path entirely. */
  let audioOnPort = false;
  /** The client that holds the other end of that channel. A reconnect onto a
   *  NEW client object needs a new channel; the same client does not. */
  let audioPortClient: VstBridgeClientLike | null = null;

  const portEntry = {
    entryId: entry.id,
    post: (msg: Record<string, unknown>) => {
      worklet?.port.postMessage(msg);
    },
  };

  /**
   * Send one accumulated block to the host, THROUGH THIS THREAD.
   *
   * Only the fallback path uses this: a runtime with no `Worker` (or no
   * `MessageChannel`) keeps the bridge where it always was. Everywhere else the
   * worklet posts its blocks straight to the bridge worker over a channel this
   * node never listens on — see `attachAudioPort`.
   */
  const onBlockFromWorklet = (data: VstBlockMessage): void => {
    const s = session;
    if (!s || disposed) return;
    s.client.sendAudio(headerFromBlock(data), data.channels);
  };

  /**
   * Give the worklet and the client the two ends of one MessageChannel, so a
   * block goes worklet -> worker -> host and back without this thread being
   * asked for anything. False when the client cannot take a port (the
   * main-thread client), which leaves the old path in place.
   *
   * The handover is posted the moment the node exists, before it is connected
   * or told it is live: until it lands the worklet falls back to posting blocks
   * here, and this node no longer forwards those.
   */
  const attachAudioPort = (s: VstLiveSession, node: AudioWorkletNode): boolean => {
    const attach = s.client.attachAudioPort;
    if (!attach || typeof MessageChannel === 'undefined') return false;
    const channel = new MessageChannel();
    node.port.postMessage({ type: 'audio-port', port: channel.port1 }, [channel.port1]);
    attach.call(s.client, channel.port2);
    audioPortClient = s.client;
    return true;
  };

  /** Hand a processed block back to the play-out buffer. FALLBACK PATH ONLY:
   *  with a channel in place the worker posts this to the worklet itself. */
  const onProcessed = (frame: VstFrame): void => {
    if (disposed || !worklet) return;
    const channels = frame.channels;
    worklet.port.postMessage(
      { type: 'processed', seq: frame.header.seq, frames: frame.header.frames, channels },
      channels.map((c) => c.buffer),
    );
  };

  /** Undo the crossfade so the dry path alone reaches the output, and tell
   *  the store this entry is no longer live. Used both when a worklet never
   *  makes it into the graph (`makeWorklet` throws) and when a live one dies
   *  (`onprocessorerror`) — in both cases the entry must keep making sound,
   *  and the store must stop claiming it is live, or PDC keeps compensating
   *  for a plugin that is not (or no longer) in the path. */
  const failLive = (reason: string): void => {
    if (disposed) return;
    const t = ctx.currentTime;
    dry.gain.cancelScheduledValues(t);
    dry.gain.setValueAtTime(dry.gain.value, t);
    dry.gain.linearRampToValueAtTime(1, t + SWAP_RAMP_SEC);
    if (wet) {
      wet.gain.cancelScheduledValues(t);
      wet.gain.setValueAtTime(wet.gain.value, t);
      wet.gain.linearRampToValueAtTime(0, t + SWAP_RAMP_SEC);
    }
    liveNodes.delete(portEntry);
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.onprocessorerror = null;
      try {
        input.disconnect(worklet); // only the input->worklet edge, not input->dry
      } catch {
        /* already gone */
      }
      try {
        worklet.disconnect();
      } catch {
        /* already gone */
      }
    }
    try {
      wet?.disconnect();
    } catch {
      /* already gone */
    }
    worklet = null;
    wet = null;
    if (session) session.audioSink = null;
    // Not 'live' from here on, so entryLatencySamples/vstLiveLatencySec read 0
    // for this entry — vstLiveStore's "0 unless live" rule, not a field this
    // function has to zero itself.
    useVstLiveStore.getState().setStatus(entry.id, 'error', reason);
  };

  /** Splice the worklet between input and output with a short crossfade. */
  const attachWorklet = (s: VstLiveSession): void => {
    if (disposed || worklet) return;
    const blockSize = s.client.blockSize || VST_LIVE_BLOCK_SIZE;
    let node: AudioWorkletNode;
    try {
      node = makeWorklet(ctx, VST_BRIDGE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [VST_LIVE_CHANNELS],
        processorOptions: {
          blockSize,
          bufferBlocks: VST_LIVE_BUFFER_BLOCKS,
          channels: VST_LIVE_CHANNELS,
        },
      });
    } catch {
      // The module is not registered on this context (a rebuild raced the
      // load), or construction otherwise failed. The dry path never left, so
      // nothing is silent — but the status flip to 'live' is what got this
      // call made, and the store still believes it: left alone, PDC would
      // compensate for a plugin that never reached the graph.
      failLive('failed to attach the live worklet');
      return;
    }
    worklet = node;
    wet = ctx.createGain();
    wet.gain.value = 0;
    // A processor exception ends the worklet's own output, not this function
    // — without a handler the entry would sit at dry-gain-0 with nothing
    // feeding wet: silence disguised as 'live'. Guard against a stale event
    // from a node that a previous failure/rebuild has already replaced.
    node.onprocessorerror = () => {
      if (worklet !== node) return;
      failLive('AudioWorklet processor error');
    };
    // Before anything is connected, so the window in which the worklet still
    // has to fall back to `node.port` for a block is as short as it can be.
    audioOnPort = attachAudioPort(s, node);
    // The worklet counts the dropouts the listener actually HEARS: a quantum it had to fill with
    // silence because no processed block had arrived in time (`underruns`, cumulative). Those are
    // what a main-thread stall causes, and they used to be posted here and ignored — the row's
    // dropout count only showed the host's own late blocks, so a glitching plugin looked clean.
    let reportedUnderruns = 0;
    node.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; underruns?: number } | undefined;
      // A block reaching THIS port while the channel is up is one the worklet
      // posted before the handover landed. Forwarding it would put audio back
      // on the main thread, which is the whole thing this avoids; the worklet
      // re-primes without it.
      if (data?.type === 'block') {
        if (!audioOnPort) onBlockFromWorklet(data as unknown as VstBlockMessage);
      } else if (data?.type === 'stats' && typeof data.underruns === 'number' && data.underruns > reportedUnderruns) {
        useVstLiveStore.getState().addXruns(entry.id, data.underruns - reportedUnderruns);
        reportedUnderruns = data.underruns;
      }
    };
    input.connect(node);
    node.connect(wet);
    wet.connect(output);

    // Crossfade, not a cut: see the module doc.
    const t = ctx.currentTime;
    dry.gain.cancelScheduledValues(t);
    dry.gain.setValueAtTime(dry.gain.value, t);
    dry.gain.linearRampToValueAtTime(0, t + SWAP_RAMP_SEC);
    wet.gain.cancelScheduledValues(t);
    wet.gain.setValueAtTime(0, t);
    wet.gain.linearRampToValueAtTime(1, t + SWAP_RAMP_SEC);

    liveNodes.add(portEntry);
    portEntry.post({ type: 'live', live: true });
    // The plugin has never seen this stream before: a discontinuity, on the
    // entry's own transport when it has one (a roll part's), else EDIT's.
    portEntry.post(transportNow(ctx, vstEntryTransport(entry.id)));
    if (!audioOnPort) s.audioSink = onProcessed;
    // Whatever the entry already holds has to reach a plugin that just started
    // from its state file; the diff map is empty, so this pushes everything.
    pushParams(currentEntry.params);
  };

  /** Re-arm an already-attached worklet after a drop-and-reconnect. A dropped
   *  session leaves the worklet in the graph passing dry signal through (see
   *  the `live: false` branch below) rather than tearing it out, so the
   *  return to 'live' must NOT go through `attachWorklet` — its own
   *  `if (disposed || worklet) return;` guard would make that a no-op, which
   *  used to be exactly the bug: a reconnected host kept passing dry signal
   *  for the life of the node, because nothing ever posted `live: true`
   *  again. */
  const relive = (s: VstLiveSession): void => {
    if (disposed || !worklet) return;
    // The session object — and with it the client — may have been re-created
    // underneath. A NEW client holds no end of the old channel, so it needs a
    // fresh one; the same client's channel is still wired and re-opening it
    // would strand the port the worklet is already posting to.
    if (!audioOnPort || s.client !== audioPortClient) audioOnPort = attachAudioPort(s, worklet);
    if (!audioOnPort) s.audioSink = onProcessed;
    portEntry.post({ type: 'live', live: true });
    // The respawned plugin has never seen this stream before.
    portEntry.post(transportNow(ctx, vstEntryTransport(entry.id)));
    // A respawned plugin starts from its state file, not from whatever the
    // diff map remembers sending last time, so the map must not suppress
    // this re-push the way it does a same-session param rebuild.
    sentParams.clear();
    pushParams(currentEntry.params);
  };

  const pushParams = (params: Record<string, number>): void => {
    const s = session;
    if (!s) return;
    let moved = false;
    for (const [key, value] of Object.entries(params)) {
      const m = PARAM_KEY.exec(key);
      if (!m) continue; // not a plugin parameter (a rack key, a UI flag)
      if (!Number.isFinite(value) || value < 0 || value > 1) continue; // never send garbage
      const index = Number(m[1]);
      if (sentParams.get(index) === value) continue;
      sentParams.set(index, value);
      s.client.setParam(index, value);
      moved = true;
    }
    // The plugin is now somewhere its stored `raw_state` does not describe, so
    // the save-time capture pass has to ask it for a fresh one. Gated on a
    // value that ACTUALLY changed: every chain rebuild re-pushes the entry's
    // params, and marking on those would queue a `get_state` — which parks the
    // audio thread — on every play, stop and seek.
    if (moved) registry.markParamsChanged(entry.id);
  };

  // The session is opened in the background; `ready` arrives through the store,
  // which is the same thing plugin-delay compensation reads — so the worklet
  // and the mixer's alignment can never disagree about when a plugin went live.
  void (async () => {
    try {
      await ensureModule(ctx);
    } catch {
      // No module, no bridge. The dry path stands and the row keeps whatever
      // the registry reported; nothing is silent.
      return;
    }
    if (disposed) return;
    // The host is spawned with the entry's `raw_state`. A MIX entry's saved
    // state arrives from IndexedDB a moment after startup, and until then it
    // reads as the plugin's defaults — so wait, then spawn with the entry as
    // it is once loaded. A node torn down while waiting never acquires.
    let spawnEntry = entry;
    if (!areVstStatesLoaded()) {
      await vstStatesLoaded;
      if (disposed) return;
      spawnEntry = loadedVstEntry(entry.id) ?? currentEntry;
    }
    const s = await registry.acquire(spawnEntry, ctx.sampleRate);
    if (!s) return;
    if (disposed) {
      // The node was disposed while the host was still spawning. The process
      // exists now and nobody holds it, so hand it to the grace timer rather
      // than leaking it until the project closes.
      registry.release(entry.id);
      return;
    }
    session = s;
    // Subscribe FIRST, unconditionally — sessionRegistry.acquire hands a
    // cached session straight back on every chain rebuild (play/stop/seek)
    // without touching the store, so finding the entry already 'live' here is
    // the COMMON case, not an edge case. A `return` before subscribing would
    // leave this node with no listener at all: a later error (processor
    // crash) has nowhere to send a recovered 'live' back to, so a reconnect
    // (bridgeClient's own backoff, or the user's retry) could never re-splice
    // the worklet, leaving the row falsely claiming 'live' over a dry signal.
    unsubStore = useVstLiveStore.subscribe(
      (state) => state.entries[entry.id]?.status,
      (status) => {
        if (status === 'live') {
          // No worklet yet: the normal first go-live. A worklet already in
          // the graph means this is a reconnect — a reconnected host used to
          // keep passing dry signal for the life of the node, because
          // attachWorklet's own guard made this a no-op; relive() is the
          // branch that re-arms it instead.
          if (!worklet) attachWorklet(s);
          else relive(s);
        }
        // A session that drops tells the worklet to pass dry signal through;
        // the client is already reconnecting underneath.
        else if (worklet) portEntry.post({ type: 'live', live: false });
      },
    );
    // `subscribe` only fires on FUTURE transitions, so an entry that is
    // already live by the time we get here needs this explicit check too;
    // `attachWorklet`'s own `if (disposed || worklet) return;` guard makes a
    // duplicate call from a subsequent notification a no-op.
    if (useVstLiveStore.getState().entries[entry.id]?.status === 'live') {
      attachWorklet(s);
    }
  })();

  /** Tear everything down and give the session claim back. */
  const destroy = (): void => {
    if (disposed) return;
    disposed = true;
    unsubStore?.();
    unsubStore = null;
    liveNodes.delete(portEntry);
    if (session) session.audioSink = null;
    try {
      if (worklet) {
        worklet.port.onmessage = null;
        worklet.disconnect();
      }
      wet?.disconnect();
      input.disconnect();
      dry.disconnect();
      output.disconnect();
    } catch {
      /* already gone */
    }
    worklet = null;
    wet = null;
    // The PROCESS is not killed here: a rebuild (play / stop / seek) disposes
    // every instance and re-makes it milliseconds later, and respawning a
    // plugin host on every transport press would be unusable. The registry's
    // grace timer decides whether this was a rebuild or a real removal.
    if (session) registry.release(entry.id);
    session = null;
  };

  /** One handle per owner: the chain that disposes it must not be able to reach a node that has
   *  since been handed to the next chain. */
  const makeHandle = (): RackEffectInstance => {
    let released = false;
    return {
      input,
      output,
      setParams: (p) => {
        if (!released) pushParams(p);
      },
      dispose: () => {
        if (released) return;
        released = true;
        // Only a node that is actually carrying the plugin is worth keeping: one still waiting
        // for its host has no primed buffer to lose.
        if (disposed || parkMs <= 0 || !worklet || !session) {
          destroy();
          return;
        }
        // The chain has already cut its own edges; this one is the node's own way out. The
        // INTERNAL graph (input -> worklet -> wet -> output) stays exactly as it is.
        try {
          output.disconnect();
        } catch {
          /* already gone */
        }
        const older = parkedNodes.get(entry.id); // never two parked nodes for one entry
        if (older) {
          clearTimeout(older.timer);
          parkedNodes.delete(entry.id);
          older.destroy();
        }
        const parked: ParkedNode = {
          ctx,
          registry,
          session,
          revive: (next) => {
            currentEntry = next;
            pushParams(next.params); // only values that actually moved reach the plugin
            return makeHandle();
          },
          destroy,
          timer: setTimeout(() => {
            if (parkedNodes.get(entry.id) === parked) parkedNodes.delete(entry.id);
            destroy();
          }, parkMs),
        };
        parkedNodes.set(entry.id, parked);
      },
    };
  };

  return makeHandle();
}
