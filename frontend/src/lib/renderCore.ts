/**
 * renderCore — ONE offline bounce for the whole timeline.
 *
 * The editor grew three offline renderers, and all three were the same graph:
 * pin 44.1 kHz, size an `OfflineAudioContext` from the clip extents, decode
 * every clip through the shared cache, give each clip its schedule
 * (`computeClipSchedule`) + its fade envelope (`lib/clipFade`) + one
 * `BufferSource` per warp segment (`scheduleClipSources`), render, encode. What
 * actually differed between them was *fidelity*:
 *
 *   - `sendSelectionToInit`  — no insert FX, no automation, but track volume /
 *                              pan / mute DO apply. Ignores solo.
 *   - `commitEdit`           — everything: master + per-track racks, the
 *                              automation lanes, mute AND solo.
 *   - `renderTrackStem`      — the track's own rack (hosted VST3 entries
 *                              stripped, they print on the backend after), no
 *                              automation, and no track volume/pan/mute/solo
 *                              at all: a stem is the track's raw audio.
 *
 * So the graph lives here once and the differences are flags on a request. A
 * job queue can then own the request (T11c) rather than three call sites owning
 * three copies. Nothing about the rendered audio changes: every divergence the
 * three had is reproduced behind its flag (or, where the two are not separable,
 * behind the scope), and `renderCore.test.ts` pins each one.
 *
 * ONE deliberate difference, and it is an improvement: the three copies each
 * called `src.start(clip.startSec + seg.targetStart, …)` raw, so a clip at a
 * negative `startSec` threw a `RangeError` and failed the whole bounce. The
 * shared `scheduleClipSources` clamps that start to 0, so such a clip renders
 * from the top of the timeline instead.
 *
 * SINCE T14 the bounce is no longer flat. Buses and sends are edges of
 * `state/routingGraph`, and the offline graph is wired by the SAME pass the
 * live mixer uses (`liveMixer.wireRoutingGraph`) rather than by a second copy
 * of the rule — a mix that plays through a bus now prints through it. Only the
 * MASTER scope walks the graph: a track stem and a clip selection are
 * pre-routing by definition (see `renderBounce`). The printed file is then
 * shifted forward by the largest latency the chains it built declare
 * (`trimLeadingSec`), so the mix lands where live playback puts it.
 *
 * SINCE T18 that shift is exact for EVERY track rather than for the slowest one
 * alone. Live playback compensates PER TRACK (`liveMixer.applyCompDelays` holds
 * `max - own` on each strip), so every track arrives together, `maxSec` late,
 * and §3.8's transport reads back by `maxSec`. The master scope now splices the
 * same delay into each strip — `latency + comp == maxSec` on every path — so
 * one `maxSec` off the front lands all of them. Before, track i printed at
 * `own_i` and the single offset landed the slowest path exactly while printing
 * every other track `maxSec - own_i` EARLY: a dry track sitting next to one
 * compressed track was 6 ms out, which is the skew this closes.
 *
 * SINCE T19b the AUTOMATION is aligned too, and PER PARAM rather than per file.
 * The trim above is one number for the whole render, which is the right shape
 * for a track — everything on a strip moves together — and the wrong shape for
 * a param that sits partway down one. Two of them do:
 *   - A PAN lane. The panner is after the inserts, so a breakpoint authored for
 *     timeline `p.t` is written at `p.t + chainLatencySec(chain)`
 *     (`scheduleParamLane`'s `delaySec` → `liveMixer.laneEnvelopeEvents`). The
 *     fader is the chain INPUT and still takes none.
 *   - A RACK lane. The stepping loop writes into an effect that may have others
 *     ahead of it, so each target reads its lane at `t - prefix(entry)` and its
 *     step times move forward by the same prefix (`entryPrefixLatencies` →
 *     `fxLaneSampleTime`). The first entry in a chain has no prefix, which is
 *     why the un-compensated loop was exact for the common project and early
 *     for every other one.
 * Both are the functions `state/liveMixer.ts` drives the live engine with (T19),
 * called rather than re-derived, so a pan or track-FX breakpoint lands on the
 * same audio in the preview and in the printed file.
 * WHAT IS LEFT, for automation: a SEND's lane, which carries the latency of the
 * effect it is tapped off and nothing about the send's own path; and a
 * MASTER-RACK lane, whose input is the post-comp sum, so the audio reaching it
 * is a further `renderLatencySec(compRows)` behind — exactly the figure
 * `trimLeadingSec` takes off the front, and adding it to the master prefix is a
 * design call deliberately not taken here (it is the same residual the live
 * mixer's header records, measured against the trim rather than against the
 * output device).
 *
 * WHAT IS STILL OUTSIDE THE NUMBER, and deliberately:
 *   - SENDS are not compensated. A send is a second path of a different length,
 *     so equalising it needs a delay on the tap itself, not on the track
 *     (§3.6's T09b) — `trackCompDelays` says the same of live playback, and the
 *     bounce inherits its arithmetic rather than inventing another.
 *   - THE MASTER RACK, and the output device (T16). The master rack is
 *     downstream of the sum, so it lags every track equally and compensating
 *     for it would be compensating for the whole mix twice.
 *   - A SAMPLE. Offline the comps hold whole SAMPLES: the trim rounds to a
 *     sample (`trimLeadingSec`) and a `DelayNode` asked for a fraction of one
 *     interpolates — i.e. it resamples the track to place it a fraction of a
 *     sample better than the trim can take back. So a track lands within HALF a
 *     sample of the meeting point, and any two tracks land within ONE sample of
 *     each other, where the gap between them used to be the whole difference
 *     between their chains (6 ms = 264.6 samples at 44.1 kHz).
 * A freeze STEM is one path, so its trim was always exact; the stem scope
 * builds no comp delay and is untouched by this.
 *
 * SINCE F24 a MASTER bounce can be asked for a `range`: a window of the
 * timeline, preroll thrown away and a tail kept (`BounceRequest.range`,
 * `render/renderRangePlan.planRangeRender`). It reproduces a full render of
 * those same frames — clips, native/rack automation, takes/comps, sends and
 * latency compensation all behave exactly as they do today — with TWO KNOWN
 * LIMITS this ticket does not fix and does not paper over, both already true
 * of a full render and simply not made worse:
 *   - PER-SEND latency compensation, per "WHAT IS STILL OUTSIDE THE NUMBER"
 *     above — a range render inherits the same lack, not a new one.
 *   - MASTER-RACK and SEND automation timing is not re-aligned to the range's
 *     shifted origin — only native track volume/pan and per-track rack lanes
 *     are (`scheduleParamLane`, `applyFxAt` in `renderBounce`).
 *
 * SINCE T46C a COMPED clip prints what it previews, and it does so without a
 * line of scheduling maths living here. The comp model is `lib/clipComp`'s and
 * the segment walk is `scheduleClipSources`'s — the same function the live
 * mixer drives, reached offline through `deps.scheduleSources`. All this file
 * owns is the two halves the live engine owns for itself: having every take's
 * audio in RAM (the decode loop below decodes each take's Blob once, at the
 * bounce's rate, through the same `deps.decode` the clip's own blob goes
 * through) and handing the scheduler a `TakeBufferResolver` instead of one
 * buffer. A clip that is not comped passes the single buffer exactly as it
 * always has, so every non-comped render is unchanged node for node.
 *   - WHAT IS STILL THE ACTIVE TAKE, deliberately: the spatializer's teleport
 *     schedule, which slices `clip.audioBlob` (= the active take, by
 *     `AudioClip.takes`'s mirroring invariant). That matches live playback,
 *     whose `chunksFor` reads the same blob — onset-driven panning follows the
 *     clip's nominal audio rather than re-slicing per comp region.
 *   - A TAKE THAT IS NOT IN THE MAP is not a reason to fail a bounce or to
 *     print silence: the clip renders every segment from its active take, and
 *     says so in the log. Reachable ONLY if the take list mutates between the
 *     decode loop and the scheduling loop — a decode that fails rejects the
 *     whole bounce, so a take that was in the list when the loop ran is in the
 *     map. That is a DELIBERATE DIVERGENCE from live playback, which skips the
 *     segment whose take it cannot peek (`liveMixer.takeResolver` returns
 *     `undefined` and the scheduler builds no source for it). Live is right to:
 *     a buffer it cannot peek is one the decode budget evicted, and it will be
 *     back on the next pass. A bounce has no next pass and one file to hand the
 *     user, so a hole in the middle of a clip is the worst answer available —
 *     it degrades to the pre-comp render of that clip instead, which is audio
 *     the user has heard. The divergence is one clip's fallback, not a
 *     scheduling rule: the resolver still answers per take, so the moment every
 *     take IS in the map the two paths are the same again.
 *
 * DESIGN SOURCES (read for their design only — NO code was copied from either):
 *   - Tracktion Engine `modules/tracktion_engine/model/export/
 *     tracktion_Renderer.h`, `Renderer::Parameters` (GPL-3.0 or commercial) —
 *     the shape of the idea: one flat, copyable parameter object that names the
 *     scope (`tracksToDo` / `allowedClips`), the format (`sampleRateForAudio`,
 *     `bitDepth`) and the tail (`endAllowance`), handed to a renderer that owns
 *     no policy of its own. `BounceRequest` is that idea in this app's terms.
 *   - The summing/bus rule this file now renders is NOT re-derived here: it is
 *     `state/routingGraph.ts`'s and `state/liveMixer.ts`'s, whose headers cite
 *     Ardour `libs/ardour/internal_return.cc` (GPL-2.0-or-later) and Stargate
 *     `src/sglib/models/daw/routing/graph.py` (GPL-3.0) as the DESIGN source of
 *     "a bus is a normal node that sums its inputs, and a send is a post-fader
 *     tap with its own gain". Neither reference was reopened for this file, and
 *     nothing from either is present in it — this module calls the repo's own
 *     `wireRoutingGraph` and adds no routing rule of its own.
 * Those references are copyleft. Every line here was written from the described
 * behaviour, or moved across from this repo's own `WaveformEditor.tsx`.
 */
import type { ChainEntry } from '../state/effectChainStore';
import {
  activeTrackInstrument, sampleLane, type AudioClip, type AutomationLane, type EditorBus, type EditorTrack,
} from '../state/editorStore';
import {
  applyEnvelopeEvents, entryPrefixLatencies, fxLaneSampleTime, laneEnvelopeEvents,
  scheduleClipSources, trackCompDelays, wireRoutingGraph,
  type RoutingEndpoints, type TakeBufferResolver, type TrackCompRow,
} from '../state/liveMixer';
import { logWarn } from '../state/logStore';
import { MASTER_ID, topoOrder, type RoutingGraph } from '../state/routingGraph';
import { sliceChunks as defaultSliceChunks, type AudioChunk } from './audioAnalysis';
import { isComped } from './clipComp';
import {
  SPATIAL_TELEPORT, buildEffectChain, chainLatencySec, ensureChopModule, teleportXYZ,
  type ChainHandle,
} from './rackEffects';
import { ensureHallIrsForChains } from './hallIrs';
import type { RenderRange } from './render/renderRange';
import { planRangeRender, sliceRangeBuffer } from './render/renderRangePlan';
import type { ArrangementMidiSource } from './arrangementMidi';
import type { GlobalVoice } from './clipProgram';
import {
  instrumentPrintPlan, isInstrumentClip, shapeInstrumentPrint, type InstrumentRenderResult, type InstrumentRenderTrack,
} from './vstInstrumentMidi';
import { encodeWav } from './wavEncode';

/** The rate every offline bounce pins. Decoded buffers are cached per rate
 *  (`lib/decodeCache`), so a bounce never inherits the output device's rate. */
export const BOUNCE_SAMPLE_RATE = 44100;

/** Channel count of every bounce. All three renderers hard-coded stereo. */
const BOUNCE_CHANNELS = 2;

/** Ceiling on a compensation `DelayNode`, in seconds — the same 1 s ceiling
 *  `liveMixer`'s `COMP_MAX_DELAY` gives the live strips (it is private there,
 *  so the number is restated rather than reached for). Orders of magnitude past
 *  any plausible insert-chain latency, and it costs only the node's lazily
 *  allocated buffer. */
const COMP_MAX_DELAY_SEC = 1.0;

/** What a bounce covers. The three variants are the three call sites:
 *  the whole timeline, one track (a freeze stem), or a hand-picked selection. */
export type BounceScope =
  | { kind: 'master' }
  | { kind: 'track'; trackId: string }
  | { kind: 'selection'; clipIds: string[] };

/**
 * Everything one bounce needs to know, and nothing about where the audio goes.
 *
 * The four booleans are the fidelity dial. They are independent, but today's
 * three call sites only use three of the combinations — see the module header.
 */
export interface BounceRequest {
  scope: BounceScope;
  /** 44100 today, everywhere. */
  sampleRate: number;
  /** Build the master + per-track insert racks. */
  includeFx: boolean;
  /** Bake the automation lanes: native volume/pan on an AudioParam timeline,
   *  rack params stepped through `suspend`/`resume`, and the spatializer's
   *  onset-driven teleport schedule — the three things the live engine drives
   *  in real time and an offline render has to write out in advance. */
  includeAutomation: boolean;
  /** Apply the track mix: volume, pan, mute (and solo — see `honoursSolo`). */
  includeTrackMix: boolean;
  /** Encode the result as 32-bit float rather than 16-bit PCM. Read only by
   *  `encodeBounce`; the render itself is float either way. */
  float32: boolean;
  /** Extra seconds past the clip extent, for tails to decay into. No call site
   *  sets it today, so it is 0 and the render length is unchanged. IGNORED
   *  when `range` is present — see `range` below. */
  tailSec?: number;
  /**
   * Render only these frames (F24). Absent = the whole timeline, exactly the
   * behaviour every existing call site keeps. When present, the offline
   * context starts at `startFrame - prerollFrames` (clamped at the project
   * start), the preroll is rendered and thrown away, and exactly
   * `keptFrameCount(range)` frames come back — see
   * `render/renderRangePlan.planRangeRender` / `sliceRangeBuffer`, and
   * `renderBounce`'s use of them.
   *
   * A DIFFERENT knob from `tailSec` above, not a redundant one: with a range
   * present, `range.tailFrames` decides the tail and `tailSec` is ignored.
   *
   * KNOWN LIMITS, not fixed here (see the module header): PER-SEND latency
   * compensation is exactly as un-compensated as it is in a full render, and
   * MASTER-RACK / SEND automation timing is not re-aligned to the range's
   * shifted origin.
   */
  range?: RenderRange;
}

/** An `AudioContext` used only to decode (and then closed). */
export type DecodeContext = BaseAudioContext & { close(): Promise<void> };

/**
 * The world the render reads. An explicit seam, so the graph can be driven by
 * a stand-in context in a test — the real `OfflineAudioContext`,
 * `AudioContext`, worklet registration and onset analysis are all unavailable
 * under Node.
 *
 * The first nine fields are what the app passes (two of them — the routing
 * graph and its buses — optional, and absent in a document that has neither).
 * The last four are optional and default to the real implementations, so a
 * production call site passes only the document and the three seams.
 */
export interface RenderDeps {
  clips: AudioClip[];
  tracks: EditorTrack[];
  masterFxChain: ChainEntry[];
  /** The raw lane list; `renderBounce` applies the same
   *  `enabled && points.length > 0` filter `commitEdit` did. */
  automationLanes: AutomationLane[];
  /**
   * Where the signal goes: `editorStore.routing`. OPTIONAL, and absent means
   * the pre-batch-6 flat render — every track straight to one master bus, no
   * bus strips, no sends. That is not a fallback nobody reaches: it is what a
   * caller with no document routing (a test, a tool) should get, and it is what
   * keeps a routing-less project bit-identical to what it always rendered.
   * Read ONLY by the master scope; see `renderBounce`.
   */
  routing?: RoutingGraph;
  /** The bus strips the graph refers to: `editorStore.buses`. Absent (or empty)
   *  with a `routing` present is legal — a graph of tracks and a master. */
  buses?: EditorBus[];
  decode: (ctx: BaseAudioContext, blob: Blob) => Promise<AudioBuffer>;
  buildChain: typeof buildEffectChain;
  scheduleSources: typeof scheduleClipSources;
  makeContext?: (channels: number, length: number, rate: number) => OfflineAudioContext;
  /** Decoding runs on a real `AudioContext`, not the offline one — more
   *  reliable than `OfflineAudioContext.decodeAudioData`, and it is what all
   *  three renderers did. Closed as soon as the last clip is decoded. */
  makeDecodeContext?: (rate: number) => DecodeContext;
  /** Register the chop worklet on the render context before the rack is built,
   *  so an enabled chop entry bakes in instead of degrading to passthrough. */
  ensureChop?: (ctx: BaseAudioContext) => Promise<void>;
  /** Load the measured hall responses the chains' Reverb entries play
   *  (lib/hallIrs), before the racks are built, so each Reverb renders its
   *  hall from the first sample instead of the synthesized room. */
  ensureHallIrs?: (ctx: BaseAudioContext, chains: ReadonlyArray<readonly ChainEntry[] | undefined>) => Promise<void>;
  /**
   * The per-track compensation delay, `liveMixer.insertCompNode`'s node in this
   * graph. A seam of its own rather than another `ctx.createGain()`-style call
   * because a `DelayNode` is the one node here that a stand-in context cannot
   * fake by shape: `delayTime` is an AudioParam, and a driver that hands out
   * plain recorders (`renderCore.routing.test.ts`) supplies its own. Defaults
   * to the real `ctx.createDelay`, so a production call site passes nothing.
   */
  makeCompDelay?: (ctx: BaseAudioContext) => DelayNode;
  /** Onset slicing, for the spatializer's teleport schedule. */
  sliceChunks?: (buf: AudioBuffer) => AudioChunk[];
}

/* ── Scope ────────────────────────────────────────────────────────────────── */

/** The clips a scope covers, in timeline order (the order `clips` is in — the
 *  selection scope filters, it does not reorder to match `clipIds`). */
export function clipsInScope(clips: AudioClip[], scope: BounceScope): AudioClip[] {
  if (scope.kind === 'master') return clips;
  if (scope.kind === 'track') return clips.filter((c) => c.trackId === scope.trackId);
  const wanted = new Set(scope.clipIds);
  return clips.filter((c) => wanted.has(c.id));
}

/**
 * How long the render is, in seconds — `max(startSec + durationSec)` over the
 * scope's clips, against a floor.
 *
 * The three renderers do NOT agree on that floor and this preserves all three:
 * the master bounce reads `editorStore.getTotalDurationSec` (60 s for an empty
 * timeline, otherwise at least 30 s), the selection bounce floors at 1 s, and a
 * track stem at 0.1 s. Each is the length its own consumer has always got.
 */
export function renderExtentSec(clips: AudioClip[], scope: BounceScope): number {
  const scoped = clipsInScope(clips, scope);
  if (scope.kind === 'master') {
    if (clips.length === 0) return 60;
    return Math.max(...scoped.map((c) => c.startSec + c.durationSec), 30);
  }
  const floor = scope.kind === 'selection' ? 1 : 0.1;
  if (scoped.length === 0) return floor;
  return Math.max(...scoped.map((c) => c.startSec + c.durationSec), floor);
}

/* ── Render ───────────────────────────────────────────────────────────────── */

/**
 * Write a lane onto a native AudioParam — the SAME event list live playback
 * puts on that param (`liveMixer.laneEnvelopeEvents`), with the offline
 * pinning: the render starts at t = 0 and the context clock IS the timeline, so
 * `startCtxTime` / `now` are always 0, and `fromSec` / `startOffset` are too
 * UNLESS this is a range render (F24): `renderOriginSec` is then
 * `plan.renderStartSec`, the timeline position context-time 0 actually is, and
 * `fromSec` and `startOffset` both take that value — the same pin
 * `laneEnvelopeEvents` documents for a live resume, just resuming at the
 * render's own origin instead of wherever the transport last was. Passing
 * `fromSec` alone and leaving `startOffset` at 0 would leave the two clocks
 * mismatched by `renderOriginSec` for every future breakpoint, so they always
 * move together.
 *
 * This used to be a hand-written loop here — a `setValueAtTime` for the first
 * value, a hold to its breakpoint, then one `linearRampToValueAtTime` per later
 * point. For a lane with no curves that loop and the envelope agree (a hold is
 * emitted as a flat ramp instead of a second `set`, which is the same audio),
 * but a CURVED breakpoint flattened to a straight line, and every mixdown and
 * VST freeze exported automation the user could not hear in preview. The
 * component's `commitEdit` had already been moved onto the envelope builder;
 * this had not, so adopting the core would have put the bug back. One rule, one
 * implementation: the clamp reaches inside a curve too, which is why it is
 * passed down rather than applied to the points up front.
 *
 * `delaySec` is how much AUDIO sits between the chain input and this param, and
 * it is the same argument the live writer passes (T19). A track's fader IS the
 * chain input, so a VOLUME lane passes 0 and emits exactly the list it always
 * has; the PANNER sits after the inserts (`gain -> [fx] -> panner`), so the
 * audio reaching it at render time `x` entered the strip at `x - latency(fx)`
 * and a breakpoint authored for timeline `p.t` belongs at `p.t + latency(fx)`.
 * Only FUTURE events move — the anchor is the value the param starts the render
 * holding — and with the offline pin `(0, 0, 0, 0)` that anchor is at 0, so the
 * lead cannot push anything off the front of the file. `trimLeadingSec` then
 * takes the SAME lead off the whole render, which is why this is not double
 * compensation: the audio and the envelope move together and land together.
 * A range render's anchor is at `renderOriginSec` instead of 0 for the same
 * reason `deps.scheduleSources`' clip clock is (see `renderBounce`): the
 * value the param starts THIS render holding is whatever a full render would
 * have it holding at the render's own origin, not at timeline 0.
 */
const scheduleParamLane = (
  param: AudioParam, lane: AutomationLane, clampFn: (v: number) => number, delaySec = 0,
  renderOriginSec = 0,
): void => {
  applyEnvelopeEvents(
    param,
    laneEnvelopeEvents(lane, renderOriginSec, 0, renderOriginSec, 0, delaySec),
    clampFn,
  );
};

interface TrackNodes {
  gain: GainNode;
  /** Only when `includeTrackMix`. A track stem has none — inserting a
   *  `StereoPannerNode` at pan 0 would still down-mix a mono source by 3 dB. */
  panner: StereoPannerNode | null;
  fx: ChainHandle | null;
  /** What this track FEEDS DOWNSTREAM before compensation — the panner when
   *  there is one, else an explicit unity gain (master scope) or the master bus
   *  itself. In the MASTER scope a comp `DelayNode` is spliced after it and it
   *  is the comp, not this, that `wireRoutingGraph` places — exactly the
   *  position the live strip puts it in (`liveMixer.insertCompNode`). */
  tail: AudioNode;
}

/** One bus strip, offline. The shape MIRRORS `liveMixer.createBusNodes`:
 *  `input -> [fx] -> gain -> muteGain -> output`, with the output left
 *  unconnected because where a bus goes is a property of the graph. It is
 *  mirrored rather than called because a bounce's rack builder is the injected
 *  `deps.buildChain` (a test drives a stand-in through it) and because the two
 *  fidelity flags apply: `includeFx` decides whether the rack exists at all and
 *  `includeTrackMix` whether the fader and the mute are honoured. */
interface BusStrip {
  input: GainNode;
  output: GainNode;
  /** The bus's rack, kept so a `CONN_SIDECHAIN` edge aimed at one of its entries
   *  can be handed that entry's key input. `null` under `includeFx: false`,
   *  where there is no rack to key. */
  fx: ChainHandle | null;
}

/** `-1 <= pan <= 1`, the clamp all three renderers applied. */
const clampPan = (v: number): number => Math.max(-1, Math.min(1, v));

/** `0 <= volume <= 1`, the clamp `liveMixer.createBusNodes` applies to a bus. */
const clampGain = (v: number): number => Math.max(0, Math.min(1, v));

/** A chain as the latency math reads it: an id and the entries that were built. */
interface RenderedChain {
  id: string;
  fxChain: ChainEntry[];
}

/**
 * How far the printed file lags the timeline, in seconds: the largest declared
 * latency along any path the render actually built, which is exactly what
 * `liveMixer.trackLatencyReport().maxSec` reports for live playback — and,
 * since every strip now holds `maxSec - own` (see `renderBounce`), where every
 * track in the file actually sits.
 *
 * Read off the SAME rows the comp delays are written from, so the two cannot
 * drift: the rows are computed over the chains that WERE built, not over the
 * document — a muted track, a track a solo silenced, and every chain under
 * `includeFx: false` contribute nothing to the file and so must not move it.
 *
 * The MASTER rack is deliberately absent, for the same reason it is absent from
 * the live figure — it is downstream of the sum, so it lags every track equally
 * and compensating for it would be compensating for the whole mix twice.
 */
function renderLatencySec(rows: readonly TrackCompRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.latencySec > max) max = row.latencySec;
  }
  return max;
}

/**
 * Whether a routing graph can be topologically ordered — i.e. whether
 * `wireRoutingGraph` will honour it or flatten it. Asked twice by one render
 * (once to size the context, once to decide whether a bus is in a track's
 * path), and it must answer the same both times, so it is one function rather
 * than two `try`s. A graph that will not order is rendered with every strip
 * straight to the master and NO bus in any path; billing its racks anyway would
 * put latency the file does not contain into both the comps and the trim.
 */
function graphOrders(graph?: RoutingGraph): boolean {
  if (!graph) return false;
  try {
    topoOrder(graph);
    return true;
  } catch {
    return false; // degraded: wireRoutingGraph logs it and flattens the graph
  }
}

/**
 * Shift a rendered bounce forward by `sec`, keeping its LENGTH.
 *
 * Live playback is latency-compensated (`liveMixer.applyCompDelays`): every
 * track is delayed to meet the slowest one, so the mix arrives `maxSec` late
 * and §3.8's transport reads back by the same amount. An offline render has no
 * transport to read back, so the lag its racks impose is printed into the file
 * and a bounce of a compressed mix lands late against the timeline it came
 * from. This takes it off the front.
 *
 * ONE offset for the WHOLE file, and since T18 that is all it has to be: the
 * master scope holds `maxSec - own` on every strip's comp delay before this
 * runs, so at `sec = maxSec` every track lands, not merely the slowest one. A
 * single-path render (a freeze stem) has no skew to have and needs no comp, so
 * its trim was exact before and is exact now.
 *
 * WHAT IT DOES NOT DO: sends, the master rack and the output device are all
 * outside `maxSec` by design — see the module header, which lists what is left
 * and why each one is left.
 *
 * PURE: no context, no store — a buffer and a number go in, a new buffer comes
 * out and the input is untouched. The OUTPUT LENGTH is the bounce's contract:
 * `renderExtentSec` is what the library entry, the freeze stem and the Save As
 * all report, and a file 265 samples short of it would disagree with every one
 * of them. `outLength` states it, and defaults to the input's — `renderBounce`
 * passes the requested window because it renders `maxSec` PAST that window (so
 * the last `maxSec` of the music exists to be shifted into place), and a caller
 * with an un-padded buffer wants the old "shift, keep the length" behaviour.
 * Either way a shortfall at the tail is zero-filled rather than shortening the
 * file.
 *
 * A zero shift that is also a no-op on the length hands back the SAME buffer,
 * so a project that declares no latency is not merely close to unchanged — it
 * is the identical object the context rendered, never copied and never
 * re-quantised.
 */
export function trimLeadingSec(buffer: AudioBuffer, sec: number, outLength?: number): AudioBuffer {
  // Nearest sample: a declaration is a time, not a sample count, and 6 ms at
  // 44.1 kHz is 264.6 samples. Rounding down would leave a fraction of the lag
  // in every file.
  const skip = Math.round(Math.max(0, sec) * buffer.sampleRate);
  const length = Math.max(0, outLength ?? buffer.length);
  if (skip <= 0 && length === buffer.length) return buffer;
  const { sampleRate, numberOfChannels } = buffer;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const out = new Float32Array(length); // zero-filled: the pad is free
    const src = buffer.getChannelData(ch);
    const take = Math.min(length, src.length - skip);
    if (take > 0) out.set(src.subarray(skip, skip + take), 0);
    channels.push(out);
  }
  // A plain object rather than `ctx.createBuffer`: this function is pure, and
  // the only surface a bounce is read through downstream is `lib/wavEncode`'s
  // (`numberOfChannels` / `length` / `sampleRate` / `getChannelData`) plus
  // `duration`, which the call sites report. One cast, stated here.
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

/**
 * Render one bounce and hand back the raw buffer. The caller owns what happens
 * next (library import, Save As, the backend VST3 hops, peaks) — this owns the
 * graph and nothing else.
 *
 * Rejects if any clip in scope fails to decode, exactly as the three renderers
 * did: they primed every clip through the cache up front, muted ones included,
 * so a clip that will not decode has always failed the whole bounce.
 *
 * RETURN TYPE, stated rather than narrowed: when the trim fires this is a
 * structural stand-in cast to `AudioBuffer` (see `trimLeadingSec`), not a real
 * one. It stays declared as `AudioBuffer` because the type is load-bearing for
 * `lib/wavEncode.encodeWav`, which takes an `AudioBuffer`; narrowing here would
 * push the same cast into that file and into every call site instead of keeping
 * it in the one function that creates the object. Everything downstream reads
 * only `duration`, `length`, `sampleRate`, `numberOfChannels` and
 * `getChannelData` — a consumer that reaches for `copyFromChannel` or
 * `copyToChannel` would be the first, and would need this widened to a real
 * buffer (an `OfflineAudioContext.createBuffer`) rather than the cast removed.
 */
export async function renderBounce(req: BounceRequest, deps: RenderDeps): Promise<AudioBuffer> {
  const { scope } = req;
  const sr = req.sampleRate;
  const scoped = clipsInScope(deps.clips, scope);
  // `range.tailFrames`, not `tailSec`, decides the tail once a range is
  // present (F24) — the two are different knobs (see `BounceRequest.range`),
  // and adding both would double the tail a `planRangeRender` already sized.
  const lengthSec = renderExtentSec(deps.clips, scope)
    + (req.range ? 0 : Math.max(0, req.tailSec ?? 0));
  /** The length the FILE is, and the bounce's contract — see `trimLeadingSec`.
   *  Superseded by `plan.contextFrames` / `plan.keepFrames` below when a
   *  range is present; kept as-is so the rangeless path is untouched. */
  const outLength = Math.ceil(lengthSec * sr);
  /**
   * The F24 frame plan for a windowed render, or null for the whole timeline.
   * Pure frame arithmetic (`render/renderRangePlan`), fixed before any node
   * exists — everything below that schedules a time shifts it by
   * `renderOriginSec` so that context-time 0 is `plan.renderStartSec` on the
   * timeline instead of timeline 0.
   */
  const plan = req.range ? planRangeRender(req.range, sr) : null;
  /** The timeline position context-time 0 actually is: 0 for a whole-timeline
   *  render, `plan.renderStartSec` for a range. The one number every clip,
   *  automation and suspend time below is shifted by. */
  const renderOriginSec = plan?.renderStartSec ?? 0;

  // ── Which tracks, and which of their entries ─────────────────────────────
  // Ahead of the context because the context's LENGTH depends on their chains.
  const trackUniverse = scope.kind === 'track'
    ? deps.tracks.filter((t) => t.id === scope.trackId)
    : deps.tracks;

  /** A track stem strips hosted VST3 entries: they cannot run in the browser
   *  and the consumer posts the stem through them on the backend afterwards.
   *  The master bounce leaves them in — `buildEffectChain` reports them as
   *  inert passthroughs, which is what the UI reads. */
  const chainFor = (t: EditorTrack): ChainEntry[] => (scope.kind === 'track'
    ? (t.fxChain ?? []).filter((e) => e.effect !== 'vst3')
    : (t.fxChain ?? []));

  /**
   * HOW MUCH PAST THE WINDOW THE RENDER HAS TO RUN, in seconds.
   *
   * Every track's audio sits `maxSec` late in the RAW render — its own chain
   * plus the comp delay that makes up the difference — so the last `maxSec` of
   * the requested window falls past the end of a context sized to the window
   * and is never rendered at all. `trimLeadingSec` then zero-fills the gap it
   * left. Before T18 that cost the SLOWEST track its tail; with the comps in it
   * costs EVERY track one, which on a project past the 30 s floor (where the
   * window ends at the last clip) is the last 6 ms of the music. So the context
   * runs `maxSec` longer and the trim cuts back to `outLength` afterwards: the
   * extra is rendered, read and dropped, and the file's length is unchanged.
   *
   * THE MASTER SCOPE ONLY, which is where the comps are. A stem and a selection
   * are printed `own` late by their own racks and trimmed by the same figure, so
   * their last `own` falls off the end too — but that is T14's behaviour, not
   * this change's, and the legacy bodies the A/B harness compares against
   * truncate identically (padding a stem puts case C over the gate, which is the
   * harness correctly reporting that the bounce and the body it replaced no
   * longer agree). Fixing it there is a call of its own; this ticket leaves the
   * stem path exactly as it found it.
   *
   * An UPPER BOUND, deliberately, and not the figure the trim uses. It has to
   * be known before the context exists, while the real rows are computed after
   * the strips are built — over the chains that were actually built, at
   * `ctx.sampleRate`. So this is measured over every track in the scope with
   * mute, solo and `perClipMix` ignored, at the REQUESTED rate: a superset of
   * the built chains, so never short. Over-padding costs render time and
   * nothing else, since the output is cut to `outLength` either way.
   */
  const padSec = req.includeFx && scope.kind === 'master'
    ? renderLatencySec(trackCompDelays(
      trackUniverse.map((t) => ({ id: t.id, fxChain: chainFor(t) })),
      undefined,
      sr,
      // A bus rack is in a track's path only where the graph is walked AND
      // orderable — the same two conditions `routingActive` / `routedPaths`
      // put on the real rows below.
      graphOrders(deps.routing)
        ? { graph: deps.routing as RoutingGraph, buses: deps.buses ?? [] }
        : undefined,
    ))
    : 0;

  const makeContext = deps.makeContext
    ?? ((channels, length, rate) => new OfflineAudioContext(channels, length, rate));
  // `plan.contextFrames` in place of `outLength` for a range (F24): the
  // preroll + kept window + tail, not the whole timeline. `padSec` is added
  // exactly as it is for a full render — it is measured over the same
  // `trackUniverse` either way.
  const ctx = makeContext(BOUNCE_CHANNELS, (plan?.contextFrames ?? outLength) + Math.ceil(padSec * sr), sr);

  // ── Decode ───────────────────────────────────────────────────────────────
  const makeDecodeContext = deps.makeDecodeContext
    ?? ((rate: number) => new AudioContext({ sampleRate: rate }) as DecodeContext);
  const decodeCtx = makeDecodeContext(sr);
  const buffers = new Map<Blob, AudioBuffer>();
  try {
    for (const clip of scoped) {
      // A piano-roll clip with no render has no audio. The callers hand this a
      // clip list whose MIDI clips were rendered first (state/midiRenderQueue
      // clipsWithMidiAudio); one still without audio (an empty roll) is silent.
      if (!clip.audioBlob) continue;
      // The clip's OWN blob, unconditionally — this is the loop the three
      // renderers had, and a second clip on the same Blob has always asked for
      // it again (`deps.decode` is `lib/decodeCache`, which answers the second
      // ask from RAM).
      buffers.set(clip.audioBlob, await deps.decode(decodeCtx, clip.audioBlob));
      // A COMPED clip plays more than one of its takes, so every take's audio
      // has to be resident before the scheduler asks for it. ONE decode per
      // distinct Blob: the active take's blob IS `clip.audioBlob` (the
      // mirroring invariant), so it is already in the map and is not decoded
      // twice — and a take shared with an earlier clip is not decoded again
      // either. A clip with takes but NO comp is not comped: it plays its
      // active take and reaches none of this.
      if (!isComped(clip)) continue;
      for (const take of clip.takes ?? []) {
        // A take with no blob is a malformed entry off disk, not a decode
        // failure: asking `deps.decode` for `undefined` would reject the whole
        // bounce over one bad row. It is skipped here and resolves to nothing
        // below, which is what a take with no audio should do.
        if (!take?.audioBlob || buffers.has(take.audioBlob)) continue;
        buffers.set(take.audioBlob, await deps.decode(decodeCtx, take.audioBlob));
      }
    }
  } finally {
    decodeCtx.close().catch(() => {});
  }

  /**
   * What the clip scheduler is handed: ONE buffer for an ordinary clip (exactly
   * as before), a take resolver for a comped one.
   *
   * The resolver is the whole of this file's part in comping — the segments,
   * their crossfades and their source offsets are `scheduleClipSources`'s, which
   * is the live scheduler, so the printed file and the preview cannot diverge
   * without one of them being rewritten.
   *
   * A take whose buffer is missing degrades the CLIP, not the bounce: rendering
   * the comp with a hole in it would print silence where the user hears audio,
   * so every segment is played from the single active buffer — the pre-comp
   * render of that clip — and the log says which clip and how many takes were
   * short. See the header for why this diverges from live's skip-the-segment.
   */
  const sourceFor = (clip: AudioClip, active: AudioBuffer): AudioBuffer | TakeBufferResolver => {
    if (!isComped(clip)) return active;
    const takes = clip.takes ?? [];
    const takeBuffers = takes.map((t) => (t?.audioBlob ? buffers.get(t.audioBlob) : undefined));
    const missing = takeBuffers.filter((b) => !b).length;
    if (missing > 0) {
      logWarn(
        'editor',
        `Bounce: comped clip "${clip.label}" is missing ${missing} of ${takes.length} decoded `
        + 'takes — rendering every segment from its active take.',
      );
      return active;
    }
    const activeIndex = clip.activeTakeIndex ?? 0;
    // THE ACTIVE INDEX ANSWERS FROM THE CLIP'S OWN BUFFER, whatever the take
    // list says — `liveMixer.takeResolver` resolves it off `clip.audioBlob`
    // rather than off `takes[i]` for exactly this reason. An `activeTakeIndex`
    // that points past the list is a broken document, not a silent clip: the
    // mirrored fields still hold real audio, and both paths play it. Every
    // OTHER index comes from the take list, and one outside it resolves to
    // nothing — which schedules no source, the answer a missing buffer has
    // always given. (`clipComp.normalizeComp` drops out-of-range regions, so
    // the comp itself should never ask.)
    return (takeIndex: number) => takeBuffers[takeIndex]
      ?? (takeIndex === activeIndex ? active : undefined);
  };

  /** A track stem has no master bus to run a master rack on. */
  const useMasterFx = req.includeFx && scope.kind !== 'track';

  /**
   * How late this track's PAN envelope is written, in seconds: the track's OWN
   * insert chain and nothing else.
   *
   * The strip is `gain -> [fx] -> panner -> comp -> routed`, so everything
   * downstream of the panner — the compensation delay, a bus's rack, the master
   * rack — is BEHIND the param and cannot make it early. That is why this is
   * `chainLatencySec(chainFor(trk))` and NOT the `latencySec` on the track's
   * `TrackCompRow`, which is the whole path to the sum and too big by the buses'
   * share. (Live playback draws the same distinction: `liveMixer`'s pan delay is
   * the track chain, its comp row is the path.)
   *
   * Measured over the chain that is actually BUILT, like the comp rows and the
   * trim: under `includeFx: false` there is no rack in the graph, so there is
   * nothing for the panner to wait for. A `track` scope's stem strips its hosted
   * VST3 entries before the render and they declare nothing either way, but the
   * question is moot there — a stem has no track mix and so no panner.
   */
  const panLeadSec = (trk: EditorTrack): number => (req.includeFx
    ? chainLatencySec(chainFor(trk), { sampleRate: ctx.sampleRate })
    : 0);

  const anySolo = deps.tracks.some((t) => t.solo);
  const honoursMute = req.includeTrackMix;
  /** Solo is a monitoring decision about the master bus, and only the master
   *  bounce has ever acted on it — `sendSelectionToInit` bounces exactly what
   *  was selected and checks `track.mute` alone. Preserved, not fixed. */
  const honoursSolo = req.includeTrackMix && scope.kind === 'master';

  // ── The chop worklet, before any rack is built ───────────────────────────
  if (req.includeFx) {
    const candidates = [
      ...(useMasterFx ? [deps.masterFxChain] : []),
      ...trackUniverse.map(chainFor),
    ];
    if (candidates.some((ch) => ch.some((e) => e.effect === 'chop' && e.enabled))) {
      const ensureChop = deps.ensureChop ?? ensureChopModule;
      try { await ensureChop(ctx); } catch { /* falls back to passthrough */ }
    }
    // The measured hall responses, bus racks included (a shared hall send is a bus).
    const ensureHallIrs = deps.ensureHallIrs ?? ensureHallIrsForChains;
    await ensureHallIrs(ctx, [...candidates, ...(scope.kind === 'master' ? (deps.buses ?? []).map((b) => b.fxChain) : [])]);
  }

  // ── Master bus ───────────────────────────────────────────────────────────
  const chains: ChainHandle[] = [];
  const masterBus = ctx.createGain();
  let masterFx: ChainHandle | null = null;
  if (useMasterFx) {
    masterFx = deps.buildChain(ctx, masterBus, ctx.destination, deps.masterFxChain);
    chains.push(masterFx);
  } else {
    masterBus.connect(ctx.destination);
  }

  /**
   * Whether this bounce walks the routing graph.
   *
   * ONLY the master scope does, and the other two are not oversights:
   *
   *  - A `track` scope is a freeze STEM, and a stem is pre-routing by
   *    definition — it is the track's own audio, to be re-summed by whatever
   *    consumes it, so sending it through the drum bus (and that bus's rack,
   *    and its fader) would print the bus twice the moment the stem is played
   *    back through the same mix. It also renders with no master bus rack and
   *    ignores mute and solo for the same reason.
   *  - A `selection` scope is Send Selection to Init: the picked clips, mixed
   *    as the user balanced them, handed to MAKE as a source. It has always
   *    been a per-clip mix straight to the master (see `perClipMix` below), and
   *    the selection is not a mix position — it is a set of clips that may not
   *    even share a destination.
   *
   * Absent `deps.routing`, the master scope renders the pre-batch-6 flat graph.
   */
  const routingActive = scope.kind === 'master' && !!deps.routing;

  // ── Bus strips ───────────────────────────────────────────────────────────
  // Built before the tracks so every destination exists by the time the wiring
  // pass runs. Each is `liveMixer.createBusNodes`'s shape (see `BusStrip`).
  const busStrips = new Map<string, BusStrip>();
  const renderedBusChains: RenderedChain[] = [];
  if (routingActive) {
    for (const b of deps.buses ?? []) {
      const input = ctx.createGain();
      const gain = ctx.createGain();
      gain.gain.value = req.includeTrackMix ? clampGain(b.volume) : 1;
      const muteGain = ctx.createGain();
      // Opened at the stored value, as the live strip is: a bounce of a project
      // with a muted bus is muted from its first sample.
      muteGain.gain.value = req.includeTrackMix && b.mute ? 0 : 1;
      const output = ctx.createGain();
      const chain = b.fxChain ?? [];
      let fx: ChainHandle | null = null;
      if (req.includeFx) {
        fx = deps.buildChain(ctx, input, gain, chain); // input -> [fx] -> gain
        chains.push(fx);
        renderedBusChains.push({ id: b.id, fxChain: chain });
      } else {
        input.connect(gain);
      }
      gain.connect(muteGain).connect(output);
      busStrips.set(b.id, { input, output, fx });
    }
  }

  const lanes = req.includeAutomation
    ? deps.automationLanes.filter((l) => l.enabled && l.points.length > 0)
    : [];

  /**
   * The selection bounce built a gain AND a panner for every CLIP, not one pair
   * per track, and that is not the same audio: a mono clip sharing a track
   * gain with a stereo one is up-mixed to stereo (`channelCountMode: 'max'`)
   * before it reaches a shared panner, so it hits the stereo pan law instead of
   * the mono one — about +3 dB at centre. So the per-clip shape is kept for the
   * selection scope. It is only possible without a rack: an insert chain is a
   * per-track object, so `includeFx` puts the mix back on the track.
   */
  const perClipMix = scope.kind === 'selection' && req.includeTrackMix && !req.includeFx;

  /** gain (track volume) -> panner (track pan) -> master bus, for ONE clip. */
  const makeClipMix = (trk: EditorTrack): GainNode => {
    const gain = ctx.createGain();
    gain.gain.value = trk.volume;
    const panner = ctx.createStereoPanner();
    panner.pan.value = clampPan(trk.pan);
    gain.connect(panner).connect(masterBus);
    return gain;
  };

  // ── One fader + rack + panner per audible track ──────────────────────────
  const audibleTracks = new Map<string, EditorTrack>();
  const trackNodeById = new Map<string, TrackNodes>();
  const renderedTrackChains: RenderedChain[] = [];
  for (const trk of trackUniverse) {
    if (honoursMute && trk.mute) continue;
    if (honoursSolo && anySolo && !trk.solo) continue;
    audibleTracks.set(trk.id, trk);
    if (perClipMix) continue; // the mix nodes are built per clip instead

    const gain = ctx.createGain();
    let panner: StereoPannerNode | null = null;
    if (req.includeTrackMix) {
      const volLane = lanes.find((l) => l.target.kind === 'trackVolume' && l.target.trackId === trk.id);
      if (volLane) scheduleParamLane(gain.gain, volLane, (v) => Math.max(0, v), 0, renderOriginSec);
      else gain.gain.value = trk.volume;

      panner = ctx.createStereoPanner();
      const panLane = lanes.find((l) => l.target.kind === 'trackPan' && l.target.trackId === trk.id);
      // The one lane on this strip that is NOT written on the clip scheduler's
      // clock: the panner is downstream of the inserts (see `panLeadSec`).
      if (panLane) scheduleParamLane(panner.pan, panLane, clampPan, panLeadSec(trk), renderOriginSec);
      else panner.pan.value = clampPan(trk.pan);
    }

    // gain -> [rack] -> panner -> (the comp delay, then wherever the graph
    // says), with the panner dropped when the track mix is off. The tail is
    // left unconnected here and placed below, after the comps exist.
    //
    // A strip with no panner gets an explicit unity gain to be placed BY
    // whenever this render could have to place it — every MASTER strip (the
    // comp splices onto it, and where the strip goes is the graph's business
    // when there is one), where `masterBus` would be a hard-wired destination
    // that can be neither compensated nor routed. A unity `GainNode` is
    // transparent (`gain` defaults to 1 and multiplying by 1 is exact). The two
    // pre-routing scopes keep feeding the master bus directly, exactly as
    // before: a stem and a selection have no graph and nothing to align.
    const tail: AudioNode = panner ?? (scope.kind === 'master' ? ctx.createGain() : masterBus);
    let fx: ChainHandle | null = null;
    if (req.includeFx) {
      const chain = chainFor(trk);
      fx = deps.buildChain(ctx, gain, tail, chain);
      chains.push(fx);
      renderedTrackChains.push({ id: trk.id, fxChain: chain });
    } else {
      gain.connect(tail);
    }
    trackNodeById.set(trk.id, { gain, panner, fx, tail });
  }

  // ── How late each strip is, and how late the file will be ────────────────
  // `routedPaths` is whether the graph ACTUALLY ordered. `wireRoutingGraph`
  // degrades a graph it cannot order to every strip straight to the master with
  // no bus in any path, and the alignment has to degrade with it: handed the
  // unvetted graph, `trackCompDelays` would walk a cycle until it runs out of
  // hops and bill a bus's rack once per hop — tens of milliseconds of "latency"
  // for racks that are not in the rendered file at all. The comps would hold it
  // and the trim would then delete that much of the head of the user's audio.
  // Asked here rather than taken from the pass because `wireRoutingGraph`
  // reports its verdict by logging, not by returning it — and asked through the
  // same `graphOrders` the context's padding asked, so the two cannot disagree
  // about whether a bus is in anybody's path.
  const routedPaths = routingActive && graphOrders(deps.routing);

  // Measured off the chains this render built AND the paths it actually wired.
  // A selection, a stem, and a graph that could not be ordered are all unrouted
  // (see `routingActive` / `routedPaths`), so none of them carries a bus's
  // latency: a stem is its own chain alone, and a damaged graph is exactly what
  // the degraded mix put in the path. ONE row set feeds both the comp delays
  // and the trim, so the file's offset and the strips' delays cannot disagree.
  const compRows = trackCompDelays(
    renderedTrackChains,
    undefined, // the real rack registry
    ctx.sampleRate, // the rate the file is actually at, not the one requested
    routedPaths ? { graph: deps.routing as RoutingGraph, buses: renderedBusChains } : undefined,
  );

  // ── Per-track compensation delays ────────────────────────────────────────
  // `liveMixer.insertCompNode`'s splice, offline: `tail -> comp -> (wherever
  // the strip goes)`, holding `maxSec - own` so every track meets the slowest
  // one and the single trim below lands all of them. Only the MASTER scope: a
  // stem is one path and a selection is pre-routing (see `routingActive`), and
  // a BUS needs none either — a bus's rack is counted on every track path
  // through it, so equalising at the tracks equalises at the bus as well.
  //
  // Set, not ramped: `applyCompDelays` uses `setTargetAtTime` because a jump on
  // a live `DelayNode` re-reads the delay line and clicks. An offline context
  // starts at 0 with nothing in the line to click, and a ramp would BE audible
  // — it would slide the track into place over the first 10 ms of the file.
  //
  // Rounded to whole samples, because the trim is (`trimLeadingSec`): a
  // `DelayNode` asked for 264.6 samples interpolates between two of them, so an
  // un-rounded comp would resample the track to place it a fraction of a sample
  // better than the trim can take back. Whole samples leave the audio bit for
  // bit what it was, moved.
  //
  // Nothing to align, nothing inserted: when every comp is 0 no delay node is
  // built at all, so a project that declares no latency renders exactly what it
  // rendered before. Node for node too, with ONE stated exception — a master
  // render with `includeTrackMix: false` now always allocates the unity gain
  // that a strip without a panner is placed by (see the strip builder), where
  // before it fed the master bus directly. Unity gain is exact, so the audio is
  // identical; the graph is one node per strip heavier.
  const compDelays = new Map<string, DelayNode>();
  if (scope.kind === 'master' && compRows.some((r) => r.compSec > 0)) {
    const makeCompDelay = deps.makeCompDelay
      ?? ((c: BaseAudioContext) => c.createDelay(COMP_MAX_DELAY_SEC));
    for (const row of compRows) {
      const nodes = trackNodeById.get(row.trackId);
      if (!nodes) continue;
      const comp = makeCompDelay(ctx);
      // PINNED TO THE BOUNCE'S CHANNEL COUNT, and this is not cosmetic. A
      // `DelayNode` defaults to `channelCountMode: 'max'`, so its channel count
      // follows its input — and when the clip sources upstream of a strip run
      // out, that input goes INACTIVE and the count it computes drops. Chrome
      // reallocates the delay's per-channel lines on that change and the
      // samples still inside them are lost.
      //
      // MEASURED, twice, on a real Chromium: through this file's own graph with
      // `includeTrackMix: true` (so the comp's upstream is a StereoPannerNode,
      // permanently 2-channel while it is running) and again in a hand-built
      // `source -> gain -> panner -> delay` graph. Both lost the last 247
      // samples of the clip — max |Δ| 3.3e-1, a third of full scale, neither
      // the delayed signal nor silence — and both were exact with these two
      // lines. A 2-channel upstream does NOT protect the node: what drops is
      // the count the delay computes from an input it no longer considers
      // active, not the panner's own output. A bounce is stereo from end to end
      // (`BOUNCE_CHANNELS`), so saying so explicitly keeps the node a pure time
      // shift for its whole tail. Case E of the A/B harness is the pin.
      comp.channelCount = BOUNCE_CHANNELS;
      comp.channelCountMode = 'explicit';
      comp.delayTime.value = Math.round(row.compSec * ctx.sampleRate) / ctx.sampleRate;
      nodes.tail.connect(comp);
      compDelays.set(row.trackId, comp);
    }
  }

  /** What a strip hands downstream: its comp delay when it has one, else its
   *  own tail. The one place the rest of this function asks. */
  const stripOutput = (id: string): AudioNode | undefined => {
    const nodes = trackNodeById.get(id);
    return nodes && (compDelays.get(id) ?? nodes.tail);
  };

  // ── Where everything goes ────────────────────────────────────────────────
  // ONE wiring pass for the whole app: the same `wireRoutingGraph` the live
  // mixer runs, over offline endpoints. It brings its own contract with it —
  // topological order, one gain node per send tapped off the SAME output as the
  // main path, and a graph it cannot order degrading to every strip straight to
  // the master (logged, never silent). Re-deriving any of that here is what
  // would let the bounce and the preview drift apart again.
  if (routingActive) {
    const ends: RoutingEndpoints = {
      outputNodeOf: (id) => stripOutput(id) ?? busStrips.get(id)?.output,
      inputNodeOf: (id) => (id === MASTER_ID ? masterBus : busStrips.get(id)?.input),
      makeSendGain: (amount) => {
        const g = ctx.createGain();
        g.gain.value = amount;
        return g;
      },
      // Every strip this render actually built. On the degraded path it is
      // these, not the damaged file, that decide who reaches the master.
      liveIds: () => [...trackNodeById.keys(), ...busStrips.keys()],
      // SIDECHAIN KEYS, resolved off the racks THIS render built — which is what
      // makes the bounce key exactly as the preview does: both engines hand the
      // one wiring pass a lookup from (node, entry) to that instance's `keyIn`,
      // and the follower behind it is pure Web Audio, so the same key samples
      // produce the same gain here and live. Under `includeFx: false` there is
      // no rack on either side, so there is nothing to key and nothing resolves.
      keyInputOf: (nodeId, entryId) => {
        const fx = trackNodeById.get(nodeId)?.fx ?? busStrips.get(nodeId)?.fx;
        return fx?.instances().find((i) => i.id === entryId)?.inst.keyIn;
      },
    };
    wireRoutingGraph(deps.routing as RoutingGraph, ends);
  } else {
    // No graph to walk: every strip lands on the master bus, as it always has.
    // Deferred to here rather than done as each strip is built, so the comp
    // delay goes BETWEEN the two rather than being spliced onto a live edge.
    // A strip whose tail IS the master bus (a stem, a selection with no track
    // mix) is already connected and carries no comp.
    for (const id of trackNodeById.keys()) {
      const out = stripOutput(id);
      if (out && out !== masterBus) out.connect(masterBus);
    }
  }

  // ── The clips ────────────────────────────────────────────────────────────
  for (const clip of scoped) {
    if (clip.muted) continue; // muted clips are excluded, matching live playback
    const trk = audibleTracks.get(clip.trackId);
    if (!trk) continue; // no such track, or it is muted / hidden by a solo
    const buf = buffers.get(clip.audioBlob);
    if (!buf) continue;
    const destination = perClipMix ? makeClipMix(trk) : trackNodeById.get(trk.id)?.gain;
    if (!destination) continue;
    // `nowSec` = 0: the offline context always renders from its own top.
    // `fromSec` = `renderOriginSec` — 0 for a whole-timeline render (a clip's
    // timeline time IS its context time), or `plan.renderStartSec` for a
    // range (F24): the SAME "resume playback at this timeline position" seam
    // the live engine uses (`liveMixer.scheduleClipSources`'s `into` and
    // `clipStartCtx`), so a clip that started before the render's own origin
    // still plays into it, clamped to start at context time 0, exactly as a
    // clip straddling a live seek does. The clip's own gain rides the fade
    // envelope (`clipPeakGain`, NOT the track volume); the track fader is a
    // node of its own, so per-track inserts process the post-fade signal.
    // `sourceFor` is `buf` itself for every clip that is not comped.
    deps.scheduleSources(ctx, clip, sourceFor(clip, buf), destination, 0, renderOriginSec);
  }

  // ── Spatializer teleport ─────────────────────────────────────────────────
  // The live preview jumps the panner on each onset; offline there is no rAF
  // loop, so the same jumps are written out as scheduled values.
  if (req.includeFx && req.includeAutomation) {
    const slice = deps.sliceChunks ?? defaultSliceChunks;
    const chunkCache = new Map<Blob, AudioChunk[]>();
    for (const trk of trackUniverse) {
      const nodes = trackNodeById.get(trk.id);
      if (!nodes?.fx) continue;
      const teleEntries = chainFor(trk).filter(
        (e) => e.enabled && e.effect === 'spatializer'
          && Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
      );
      if (teleEntries.length === 0) continue;
      const insts = nodes.fx.instances();
      // Muted clips render no audio, so their onsets must not drive jumps.
      const trackClips = scoped.filter((c) => c.trackId === trk.id && !c.muted);
      for (const teleEntry of teleEntries) {
        const li = insts.find((x) => x.id === teleEntry.id);
        if (!li?.inst.scheduleTeleport) continue;
        const spread = teleEntry.params?.motionDepth ?? 5;
        const events: { when: number; x: number; y: number; z: number }[] = [];
        let idx = 0;
        for (const c of trackClips) {
          // The ACTIVE take, even on a comped clip — `liveMixer.chunksFor`
          // slices the same blob, so preview and print agree (see the header).
          const buf = buffers.get(c.audioBlob);
          if (!buf) continue;
          const offset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
          const cdur = Math.min(c.durationSec, buf.duration - offset);
          if (cdur <= 0) continue;
          let chunks = chunkCache.get(c.audioBlob);
          if (!chunks) { chunks = slice(buf); chunkCache.set(c.audioBlob, chunks); }
          for (const chunk of chunks) {
            if (chunk.tSec < offset || chunk.tSec >= offset + cdur) continue;
            const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
            // Shifted by `renderOriginSec` (F24, 0 outside a range render) so
            // an onset's timeline position lands at the matching context
            // time. A shifted time before context-time 0 (an onset in the
            // discarded preroll or earlier) is not filtered out here:
            // `scheduleTeleport` already clamps every `when` to its own
            // `t0`, the same clamp `deps.scheduleSources` applies to a
            // clip's start.
            events.push({
              when: c.startSec + (chunk.tSec - offset) - renderOriginSec, x: pos.x, y: pos.y, z: pos.z,
            });
            idx += 1;
          }
        }
        if (events.length > 0) {
          events.sort((a, b) => a.when - b.when);
          li.inst.scheduleTeleport(events);
        }
      }
    }
  }

  // ── Rack-param automation ────────────────────────────────────────────────
  // Rack params are plain numbers, not AudioParams, so they cannot ride a
  // timeline. The render is suspended on each breakpoint's render quantum and
  // the merged params pushed in. Native volume/pan were scheduled above.
  const fxTargets: {
    handle: ChainHandle;
    entryId: string;
    baseParams: Record<string, number>;
    lanes: AutomationLane[];
    /** Seconds of declared latency AHEAD of this entry in its own chain — the
     *  amount the audio arriving at it right now is behind the render clock.
     *  See `groupFx`; 0 for the first entry in every chain. */
    prefixSec: number;
  }[] = [];
  if (req.includeAutomation && req.includeFx) {
    const groupFx = (
      kind: 'trackFx' | 'masterFx', handle: ChainHandle, chain: ChainEntry[], trackId?: string,
    ) => {
      // ONCE PER CHAIN, not once per step: a prefix sum is a walk of the whole
      // chain through the rack registry, and the stepping loop below asks for
      // every target's figure at every breakpoint of every lane.
      const prefix = entryPrefixLatencies(chain, { sampleRate: ctx.sampleRate });
      for (const e of chain) {
        if (!e.enabled) continue;
        const entryLanes = lanes.filter(
          (l) => l.target.kind === kind && l.target.entryId === e.id
            && (kind === 'masterFx' || l.target.trackId === trackId),
        );
        if (entryLanes.length > 0) {
          fxTargets.push({
            handle, entryId: e.id, baseParams: e.params, lanes: entryLanes,
            prefixSec: prefix[e.id] ?? 0,
          });
        }
      }
    };
    if (masterFx) groupFx('masterFx', masterFx, deps.masterFxChain);
    for (const trk of trackUniverse) {
      const nodes = trackNodeById.get(trk.id);
      if (!nodes?.fx) continue;
      groupFx('trackFx', nodes.fx, chainFor(trk), trk.id);
    }
  }

  if (fxTargets.length > 0) {
    // EACH TARGET READS ITS LANE AT ITS OWN TIME. The audio a step writes into
    // an effect with `prefixSec` of chain ahead of it entered the strip that
    // long ago, so the value to write at render time `t` is the one the lane
    // held at `t - prefixSec` — `liveMixer.fxLaneSampleTime`, the same function
    // the live ~40 Hz writer reads its lanes through. It clamps into
    // `[0, lengthSec]`, so a step near the top of the render reads the lane's
    // value AT 0 rather than going behind the start of the timeline.
    const applyFxAt = (t: number) => {
      for (const tgt of fxTargets) {
        const at = fxLaneSampleTime(t, tgt.prefixSec, lengthSec);
        const merged: Record<string, number> = { ...tgt.baseParams };
        for (const lane of tgt.lanes) {
          const v = sampleLane(lane, at);
          if (v != null && lane.target.paramKey) merged[lane.target.paramKey] = v;
        }
        tgt.handle.updateParams(tgt.entryId, merged);
      }
    };
    // The top of THIS render, timeline-wise: 0 for a whole-timeline render,
    // `renderOriginSec` for a range (F24) — `applyFxAt` reads its lanes in
    // timeline seconds (see above), so the initial state has to be sampled at
    // wherever this render's context-time 0 actually falls on that timeline,
    // exactly like the clip and native-lane scheduling above it.
    applyFxAt(renderOriginSec);
    // Union of breakpoint times, quantised to the render quantum, in (0, length).
    //
    // SHIFTED BY THE SAME PREFIX, and that half is not optional: a breakpoint
    // authored for timeline `p.t` takes effect on this entry at render time
    // `p.t + prefixSec`, so an un-shifted union would suspend at `p.t` while the
    // sampler above read `p.t - prefixSec` — the breakpoint's own value would
    // never be written and the lane would jump to it at the NEXT breakpoint.
    // Clipped to `(0, lengthSec)` after the shift, so a point the lead carries
    // into the render gets a step and one it carries past the end does not.
    const q = 128 / sr;
    const times = new Set<number>();
    for (const tgt of fxTargets) {
      for (const lane of tgt.lanes) {
        for (const p of lane.points) {
          const at = p.t + tgt.prefixSec;
          if (at <= 0 || at >= lengthSec) continue;
          times.add(Math.min(lengthSec - q, Math.ceil(at / q) * q));
        }
      }
    }
    for (const tq of [...times].sort((a, b) => a - b)) {
      if (tq <= 0 || tq >= lengthSec) continue;
      // `tq` stays a TIMELINE position for `applyFxAt` (it reads lanes in
      // timeline seconds), but `ctx.suspend` takes a CONTEXT time, which is
      // `tq - renderOriginSec` (0 outside a range render, so unchanged
      // there). A step whose shifted time falls before this render's own
      // start (still in the discarded preroll, or earlier) or at/after this
      // context's own end (past this render's window, only reachable with a
      // range shorter than the full timeline) is dropped rather than handed
      // to `ctx.suspend`, which rejects for either — the same boundary
      // `fxLaneSampleTime`'s own clamp enforces for a read, just applied here
      // to the schedule instead.
      const suspendAt = tq - renderOriginSec;
      if (suspendAt < 0 || suspendAt >= ctx.length / sr) continue;
      ctx.suspend(suspendAt).then(() => { applyFxAt(tq); ctx.resume(); }).catch(() => {});
    }
  }

  // How late the file is: the slowest path in the rows the comps were written
  // from, which — because they were — is now where EVERY track sits.
  const trimSec = req.includeFx ? renderLatencySec(compRows) : 0;

  try {
    // `outLength` (or `plan.contextFrames` for a range), not the context's:
    // the render ran `padSec` past the window so that the last `maxSec` of
    // the music would exist to be pulled into place, and that overshoot is
    // dropped here rather than shipped.
    const rendered = trimLeadingSec(await ctx.startRendering(), trimSec, plan?.contextFrames ?? outLength);
    // F24: cut the preroll off the front and the tail down to exactly
    // `plan.keepFrames`, so a range render's contract is the buffer LENGTH,
    // the same way `outLength` is the whole-timeline render's. Absent a
    // range this is a no-op pass-through — `plan` is null.
    return plan ? sliceRangeBuffer(rendered, plan) : rendered;
  } finally {
    // `renderTrackStem` disposed its chain and the other two leaked theirs.
    // Disposal happens after the render has finished, so it cannot change a
    // sample — it only stops the oscillators and worklets the rack built.
    for (const handle of chains) {
      try { handle.dispose(); } catch { /* already gone */ }
    }
  }
}

/** Encode a rendered bounce, per the request that produced it. 16-bit PCM
 *  unless `float32`, which is for the hops where the audio is handed straight
 *  to another processor (the VST3 chain) rather than stored. Taking the request
 *  rather than a loose boolean keeps the format decision on the request object,
 *  so a job queue that owns the request owns the encoding too. */
export function encodeBounce(buffer: AudioBuffer, req: Pick<BounceRequest, 'float32'>): Blob {
  return encodeWav(buffer, { float32: req.float32 });
}

/* ── The instrument slot ──────────────────────────────────────────────────── */

/** Renders one track's instrument print (POST /api/vst/render-midi). */
export type InstrumentRenderer = (track: InstrumentRenderTrack, sampleRate: number) => Promise<InstrumentRenderResult>;

export interface InstrumentPrintOptions {
  /** The picker's voice, for clips whose program decides nothing but their channel's bank select. */
  global?: GlobalVoice;
  /** The rate the prints render at; the bounce's own. */
  sampleRate?: number;
  /** Asked before each track; once it says yes no more tracks render. */
  isCancelled?: () => boolean;
  /** Hears each track as its print lands. */
  onProgress?: (done: number, total: number, trackName: string) => void;
  /** Hears the backend's warnings (a state or parameter the instrument did not take). */
  onWarning?: (trackName: string, warning: string) => void;
}

/** What a bounce reads once the instrument tracks are printed. */
export interface InstrumentPrint {
  /** The document's clips with each instrument track's piano-roll clips in scope replaced by its print. */
  clips: AudioClip[];
  /** The printed audio, one per instrument track rendered. */
  printed: Blob[];
}

/** The tracks whose instrument slot plays MIDI clips a bounce of `scope` covers. */
export function instrumentTracksInScope(
  clips: readonly AudioClip[],
  tracks: readonly EditorTrack[],
  scope: BounceScope,
): EditorTrack[] {
  const scoped = clipsInScope([...clips], scope);
  return tracks.filter(
    (t) => !t.isFolder && activeTrackInstrument(t) !== null && scoped.some((c) => c.trackId === t.id && isInstrumentClip(c) && !c.muted),
  );
}

/**
 * Print every instrument track a bounce of `scope` covers, ahead of the bounce.
 *
 * The instrument slot sits ahead of the track's inserts, so its print takes
 * the place of the track's piano-roll clips: one audio clip per track, from
 * the first clip's start, holding what the instrument played for all of them
 * (their notes, controllers and bends, lib/vstInstrumentMidi). The bounce then
 * runs that audio through the track's rack, fader and pan like any clip, and a
 * freeze prints it into the stem. A selection prints only the selected clips.
 *
 * Rejects, naming the track, when a print fails: an export never prints
 * silence where a part should sound.
 */
export async function printInstrumentTracks(
  source: ArrangementMidiSource & { clips: readonly AudioClip[]; tracks: readonly EditorTrack[] },
  scope: BounceScope,
  render: InstrumentRenderer,
  opts: InstrumentPrintOptions = {},
): Promise<InstrumentPrint> {
  const global = opts.global ?? { useSoundfont: false, activeProgram: 0 };
  const sampleRate = opts.sampleRate ?? BOUNCE_SAMPLE_RATE;
  const scoped = clipsInScope([...source.clips], scope);
  const targets = instrumentTracksInScope(source.clips, source.tracks, scope);
  const replaced = new Set<string>();
  const prints: AudioClip[] = [];
  const printed: Blob[] = [];
  let done = 0;
  for (const track of targets) {
    if (opts.isCancelled?.()) break;
    const plan = instrumentPrintPlan(source, track, scoped, global);
    if (!plan) continue;
    let result: InstrumentRenderResult;
    try {
      result = await render(plan.request, sampleRate);
    } catch (e) {
      throw new Error(`Track "${track.name}" could not be printed through its instrument: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const w of result.warnings) opts.onWarning?.(track.name, w);
    // The gain and fades of each clip, over the print, as live playback puts them on the
    // instrument's output: the print lands on the track as one clip at unity.
    const audio = await shapeInstrumentPrint(result.audio, plan.startSec, plan.clips);
    const durationSec = result.frames / (result.sampleRate || sampleRate);
    for (const c of scoped) if (c.trackId === track.id && isInstrumentClip(c)) replaced.add(c.id);
    prints.push({
      id: `instrument-print:${track.id}`,
      trackId: track.id,
      label: `${track.name} (${track.instrument?.vst?.plugin_name || 'instrument'})`,
      audioBlob: audio,
      mimeType: 'audio/wav',
      sourceDuration: durationSec,
      offsetIntoSource: 0,
      durationSec,
      startSec: plan.startSec,
      color: track.color,
    });
    printed.push(audio);
    done += 1;
    opts.onProgress?.(done, targets.length, track.name);
  }
  return { clips: [...source.clips.filter((c) => !replaced.has(c.id)), ...prints], printed };
}
