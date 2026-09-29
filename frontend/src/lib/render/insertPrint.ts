/**
 * insertPrint — one bounce with every hosted VST3 insert printed in its place.
 *
 * A VST3 insert cannot run in an `OfflineAudioContext`: the offline graph
 * builds it as a passthrough (lib/vstLive/vstLiveNode). The backend runs a
 * plugin over a file (`POST /api/vst/process-file`), one plugin per call, so a
 * chain that holds one is printed in STAGES, each stage an ordinary
 * `renderBounce` given an `InsertPrintStage`:
 *
 *   1. For each node (track or bus) whose chain holds a printed insert, the
 *      render runs up to the first one and hands back that point's audio (a
 *      `tap`). The hop runs the plugin over it. If more of the chain follows,
 *      the next stage plays the printed file into the next part of the chain
 *      (`sources`, `chains`) and taps again, until the last plugin has run.
 *   2. The mix is then rendered with each printed node playing its print into
 *      what is left of its chain, so everything after the last plugin, the
 *      pan, the sends, the buses and the master rack apply as they always do.
 *   3. The master VST chain runs over the finished mix, one hop per plugin, in
 *      the order the user set: it sits after the master rack.
 *
 * Nodes are printed upstream first (the routing graph's order), so a bus prints
 * what its tracks' plugins made, and a sidechain key hears its source's print.
 *
 * WHAT STAYS EXACT:
 *   - Order. A chain is split at each printed insert, and every rack entry and
 *     every plugin runs once, in the chain's own order, wherever the plugins
 *     sit in it.
 *   - Latency. Each tap is trimmed by the latency ahead of it, and both plugin
 *     hosts take the plugin's own latency off the front, so every print lands
 *     on the timeline. A printed track keeps its comp delay; a printed bus
 *     starts late by the same rule (renderCore `printLeadSec`).
 *   - Precision. Every hop is a 32-bit float WAV, and the caller encodes the
 *     returned buffer once, in the format it was asked for.
 *   - Tails. theDAW's own host renders a plugin's tail past the end of the
 *     audio it was given. A whole-timeline bounce grows to hold it, so a
 *     reverb on the last clip rings out, as the frozen master always kept it.
 *     A range bounce keeps the window the user chose (range plus tail), and a
 *     plugin rings into that window as the rack's effects do.
 *
 * WHAT IT DOES NOT PRINT, deliberately: a muted or soloed-out track, a track
 * with no audible clip in the bounce or, for a range, in the window the range
 * renders (its plugins would process silence), and a muted bus. A bus is printed only where the bounce walks the routing graph
 * (the master scope, a graph that orders), because nowhere else is a bus in any
 * path. A bounce that asks for no inserts (`includeFx: false`) prints none.
 *
 * A bounce with no printed insert anywhere is the one plain `renderBounce`,
 * called exactly as before.
 */
import type { ChainEntry } from '../../state/effectChainStore';
import type { AudioClip, EditorTrack } from '../../state/editorStore';
import { topoOrder, type RoutingGraph } from '../../state/routingGraph';
import {
  clipsInScope, isExternalMidiClip, renderBounce, renderExtentSec,
  type BounceRequest, type InsertPrintStage, type RenderDeps,
} from '../renderCore';
import { encodeWav } from '../wavEncode';
import { readWavSamples, readWavShape, type WavSamples } from '../wavSamples';
import { planRangeRender, sliceRangeBuffer } from './renderRangePlan';

/** A chain entry the print runs through a plugin host: an enabled VST3 that
 *  names its plugin's file. The live chain hosts an entry by the same rule
 *  (rackEffects `buildEffectChain`), so one it never hosts is never printed. */
export const printsThroughHost = (e: ChainEntry): boolean => e.enabled && e.effect === 'vst3' && !!e.vst?.plugin_path;

/** A master VST chain entry that prints: enabled, naming its plugin's file. */
const masterPrints = (e: ChainEntry): boolean => e.enabled && !!e.vst?.plugin_path;

/** Bytes read off the front of a printed file for its header. */
const HEADER_BYTES = 64 * 1024;

/**
 * One plugin hop: a 32-bit float WAV in, the plugin's WAV out. `where` names
 * the track, the bus or the master, for the log and for an error.
 */
export type VstHop = (wav: Blob, entry: ChainEntry, where: string) => Promise<Blob>;

export interface InsertPrintOptions {
  /** Runs one plugin over one file. */
  hop: VstHop;
  /** The master VST chain. It runs after the master rack, over the whole mix. */
  masterVstChain?: readonly ChainEntry[];
  /** The render each stage runs. `renderBounce` unless a test says otherwise. */
  render?: (req: BounceRequest, deps: RenderDeps) => Promise<AudioBuffer>;
  /** Asked before every render and every hop; once it says yes, nothing more runs. */
  isCancelled?: () => boolean;
  /** Hears each render and each hop as it finishes. */
  onProgress?: (done: number, total: number) => void;
  /** Hears each printed file a later stage plays, so its caller can free the decoded audio. */
  onPrinted?: (wav: Blob) => void;
}

export interface InsertPrintResult {
  /** The bounce, in float. The caller encodes it. */
  buffer: AudioBuffer;
  /** Plugin hops run. 0 means the buffer is the plain bounce. */
  hops: number;
}

/** A node whose chain holds an insert the print runs through a host. */
export interface PrintSite {
  id: string;
  kind: 'track' | 'bus';
  name: string;
  /** The chain between the printed inserts: one more part than there are inserts. */
  segments: ChainEntry[][];
  /** The printed inserts, in chain order. */
  inserts: ChainEntry[];
}

/** `chain` cut at each printed insert: the parts around them, and the inserts, in order. */
export function splitAtInserts(chain: readonly ChainEntry[]): Pick<PrintSite, 'segments' | 'inserts'> {
  const segments: ChainEntry[][] = [[]];
  const inserts: ChainEntry[] = [];
  for (const e of chain) {
    if (printsThroughHost(e)) {
      inserts.push(e);
      segments.push([]);
    } else {
      segments[segments.length - 1].push(e);
    }
  }
  return { segments, inserts };
}

/** The graph's node order, or null for a graph that does not order (the bounce then flattens it). */
function orderOf(graph: RoutingGraph | undefined): string[] | null {
  if (!graph) return null;
  try {
    return topoOrder(graph);
  } catch {
    return null;
  }
}

/** The nodes a bounce of `req` prints through a host, upstream first. */
export function printSites(
  req: BounceRequest,
  deps: Pick<RenderDeps, 'clips' | 'tracks' | 'buses' | 'routing'>,
): PrintSite[] {
  if (!req.includeFx) return [];
  const { scope } = req;
  const universe = scope.kind === 'track' ? deps.tracks.filter((t) => t.id === scope.trackId) : deps.tracks;
  const anySolo = deps.tracks.some((t) => t.solo);
  const honoursMute = req.includeTrackMix;
  const honoursSolo = req.includeTrackMix && scope.kind === 'master';
  const scoped = clipsInScope(deps.clips, scope);
  // A range renders from its preroll to the end of its tail, and nothing
  // outside that window reaches the file.
  const plan = req.range ? planRangeRender(req.range, req.sampleRate) : null;
  const inWindow = (c: AudioClip): boolean => !plan || (
    c.startSec < plan.renderStartSec + plan.contextFrames / req.sampleRate
    && c.startSec + c.durationSec > plan.renderStartSec
  );
  const sounds = (t: EditorTrack): boolean => scoped.some(
    (c) => c.trackId === t.id && !c.muted && !!c.audioBlob && !isExternalMidiClip(c, deps.tracks) && inWindow(c),
  );
  const sites: PrintSite[] = [];
  for (const t of universe) {
    if (honoursMute && t.mute) continue;
    if (honoursSolo && anySolo && !t.solo) continue;
    const split = splitAtInserts(t.fxChain ?? []);
    if (split.inserts.length === 0 || !sounds(t)) continue;
    sites.push({ id: t.id, kind: 'track', name: t.name, ...split });
  }
  const order = scope.kind === 'master' ? orderOf(deps.routing) : null;
  if (!order) return sites;
  const placed = new Set(order);
  for (const b of deps.buses ?? []) {
    if (req.includeTrackMix && b.mute) continue;
    if (!placed.has(b.id)) continue; // a bus the graph does not name reaches nothing
    const split = splitAtInserts(b.fxChain ?? []);
    if (split.inserts.length > 0) sites.push({ id: b.id, kind: 'bus', name: b.name, ...split });
  }
  // Upstream first. A node the graph does not name has no edge, so nothing
  // depends on it: it goes first, in document order (the sort is stable).
  const rank = new Map(order.map((id, i): [string, number] => [id, i]));
  return sites.sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

/** A printed file as the clip a later stage plays. */
const printClip = (site: PrintSite, wav: Blob, startSec: number, durationSec: number): AudioClip => ({
  id: `insert-print:${site.id}`,
  trackId: site.id,
  label: `${site.name} (printed inserts)`,
  audioBlob: wav,
  mimeType: 'audio/wav',
  sourceDuration: durationSec,
  offsetIntoSource: 0,
  durationSec,
  startSec,
  color: '#000000',
});

/** Planar samples as the buffer shape a bounce is read through (see renderCore `trimLeadingSec`).
 *  A mono answer is heard on both sides, as Web Audio up-mixes it: a bounce is stereo. */
const bufferOf = (s: WavSamples): AudioBuffer => {
  const channels = s.channels.length === 1 ? [s.channels[0], s.channels[0]] : s.channels;
  return {
    duration: s.frames / s.sampleRate,
    length: s.frames,
    sampleRate: s.sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
};

/**
 * How long a printed stem lasts on the timeline, in seconds: the extent of the
 * clips it was rendered from (`extentSec`), or the whole print when a plugin
 * host rang out past them. A whole-timeline bounce grows to hold that tail (see
 * the header), and a freeze that cut the stem back to its clips' extent would
 * drop the ring-out that live playback lets ring. A render is rounded up to a
 * whole frame, which is not a tail.
 */
export function printedStemSec(
  extentSec: number,
  buffer: Pick<AudioBuffer, 'length' | 'sampleRate' | 'duration'>,
): number {
  return buffer.length > Math.ceil(extentSec * buffer.sampleRate) ? buffer.duration : extentSec;
}

/**
 * Render `req` over `deps` with every enabled VST3 insert on every track, every
 * bus and the master VST chain printed in its place (see the header). Resolves
 * null when `isCancelled` said yes; rejects with the host's own words when a
 * plugin cannot print, naming where it sits.
 */
export async function renderWithInserts(
  req: BounceRequest,
  deps: RenderDeps,
  opts: InsertPrintOptions,
): Promise<InsertPrintResult | null> {
  const render = opts.render ?? renderBounce;
  const cancelled = opts.isCancelled ?? (() => false);
  const sites = printSites(req, deps);
  const masterInserts = req.includeFx && req.scope.kind !== 'track'
    ? (opts.masterVstChain ?? []).filter(masterPrints)
    : [];
  if (sites.length === 0 && masterInserts.length === 0) {
    return { buffer: await render(req, deps), hops: 0 };
  }

  const plan = req.range ? planRangeRender(req.range, req.sampleRate) : null;
  /** Where every stage's audio starts on the timeline: the range's first rendered frame, or 0. */
  const originSec = plan?.renderStartSec ?? 0;
  const extentSec = renderExtentSec(deps.clips, req.scope);
  /** How far a whole-timeline stage renders once a plugin's tail has widened
   *  it, or null while nothing has: the request then renders as it was asked. */
  let grownSec: number | null = null;
  const stageRequest = (): BounceRequest => (plan || grownSec === null ? req : { ...req, tailSec: grownSec - extentSec });

  const chains = new Map<string, ChainEntry[]>();
  const sources = new Map<string, AudioClip>();
  const stageDeps = (extra: Pick<InsertPrintStage, 'tap' | 'keepPreroll'>): RenderDeps => ({
    ...deps,
    stage: { chains: new Map(chains), sources: new Map(sources), ...extra },
  });

  const total = sites.reduce((n, s) => n + 2 * s.inserts.length, 0) + 1 + masterInserts.length;
  let done = 0;
  const step = (): void => {
    done += 1;
    opts.onProgress?.(done, total);
  };
  let hops = 0;

  for (const site of sites) {
    chains.set(site.id, site.segments[0]);
    if (cancelled()) return null;
    let audio = await render(stageRequest(), stageDeps({ tap: site.id, keepPreroll: true }));
    step();
    for (let i = 0; i < site.inserts.length; i += 1) {
      if (cancelled()) return null;
      const wav = await opts.hop(encodeWav(audio, { float32: true }), site.inserts[i], site.name);
      hops += 1;
      step();
      opts.onPrinted?.(wav);
      const shape = readWavShape(await wav.slice(0, HEADER_BYTES).arrayBuffer(), wav.size);
      const printSec = shape.frames / shape.sampleRate;
      // A tail the host rendered past the audio it was given widens every later stage.
      if (!plan && shape.frames > audio.length) {
        grownSec = Math.max(grownSec ?? extentSec + Math.max(0, req.tailSec ?? 0), printSec);
      }
      sources.set(site.id, printClip(site, wav, originSec, printSec));
      chains.set(site.id, site.segments[i + 1]);
      if (i + 1 < site.inserts.length) {
        if (cancelled()) return null;
        audio = await render(stageRequest(), stageDeps({ tap: site.id, keepPreroll: true }));
        step();
      }
    }
  }

  if (cancelled()) return null;
  // A range that the master chain runs over keeps its preroll until the master
  // plugins have heard it, as the rack's effects do.
  const keepPreroll = !!plan && masterInserts.length > 0;
  const mix = await render(
    stageRequest(),
    sites.length > 0 || keepPreroll ? stageDeps({ keepPreroll }) : deps,
  );
  step();
  if (masterInserts.length === 0) return { buffer: mix, hops };

  let wav = encodeWav(mix, { float32: true });
  for (const entry of masterInserts) {
    if (cancelled()) return null;
    wav = await opts.hop(wav, entry, 'Master');
    hops += 1;
    step();
  }
  const out = bufferOf(readWavSamples(await wav.arrayBuffer()));
  if (out.sampleRate !== mix.sampleRate) {
    throw new Error(`the plugin host answered at ${out.sampleRate} Hz for a bounce at ${mix.sampleRate} Hz`);
  }
  return { buffer: plan ? sliceRangeBuffer(out, plan) : out, hops };
}
