/**
 * THROWAWAY A/B harness for ticket P-20260915-batch6-T11b.
 *
 * Renders the same synthetic project twice — once through the three inline
 * bodies `WaveformEditor.tsx` had at batch-6 baseline `cce9375`
 * (`./legacyBodies.ts`, a verbatim transcription of this repo's own code) and
 * once through `src/lib/renderCore.ts` — then decodes both WAVs and reports
 * max |Δ| and RMS Δ per channel.
 *
 * Runs in a real headless Chromium (see `run.mjs`); nothing here is shipped.
 *
 * DETERMINISM: `rackEffects.makeReverbIR` fills its impulse response with
 * `Math.random()`, so two builds of the same reverb are two different rooms.
 * Every render below therefore runs under a seeded `Math.random`, reset to the
 * same seed each time — the refactor is what is being measured, not the IR
 * noise the app deliberately re-rolls.
 *
 * T14 (plan §3.6 step 3b + §3.8 step 3a) adds two things to measure:
 *
 *   - THE RENDER TRIM. A bounce is now shifted forward by the latency its
 *     chains declare, so a case whose rack declares any is deliberately NOT
 *     sample-identical to the legacy body any more. `expectTrimSec` states that
 *     shift up front and the legacy side is shifted by the same amount before
 *     the diff — so the case still asserts "identical audio", it just says
 *     WHERE. A case that got trimmed by a different amount than it claimed goes
 *     straight over the gate, which is the regression this keeps.
 *   - THE ROUTING GRAPH (case D). The legacy bodies have no routing at all, so
 *     there is no legacy render to A/B a routed one against. Its reference is
 *     the core's own FLAT render of the same project, scaled by the gain the
 *     live graph is specified to apply — see `routedProject`.
 *
 * T18 (plan §3.8 step 3a, completion) makes that shift PER TRACK, and one
 * number per case can no longer state it. The master scope now holds
 * `maxSec - own` on each strip's compensation delay, so every track lands where
 * the timeline says rather than only the slowest one — a mix of a compressed
 * and a dry track is a DIFFERENT file from the legacy body's, by 6 ms on the
 * dry track, and that difference is the fix. Those cases state a shift per
 * LATENCY GROUP instead and their reference is assembled by
 * `alignedLegacyMix`: one legacy render per group, each shifted by its own
 * declared latency, summed. Case E is the two-track minimum of it.
 *
 * T46C adds CASE F, and it is not a legacy diff either — the legacy bodies
 * predate comping entirely, as they predate buses. Its reference is the LIVE
 * strip, built by hand here (`liveStripRender`): `gain -> muteGain -> panner`,
 * the shape `liveMixer.buildTrackNodes` makes, driven by the same
 * `scheduleClipSources` the live engine drives, with the same take resolver
 * (`takeIndex -> peekDecoded(takes[i].audioBlob)`) the live scheduler builds.
 * That is what `export == preview` means for a comped clip, asserted as
 * arithmetic rather than as a claim about the renderer: both sides decode
 * through the one `lib/decodeCache` at 44.1 kHz and therefore read the SAME
 * buffers, so any disagreement is the offline path resolving a different take
 * or placing a segment differently.
 */
import {
  BOUNCE_SAMPLE_RATE, encodeBounce, renderBounce, renderExtentSec, trimLeadingSec,
  type BounceRequest, type BounceScope, type RenderDeps,
} from '../../src/lib/renderCore';
import { isComped } from '../../src/lib/clipComp';
import { decodeClipBlob, peekDecoded } from '../../src/lib/decodeCache';
import { buildEffectChain } from '../../src/lib/rackEffects';
import { encodeWav } from '../../src/lib/wavEncode';
import { scheduleClipSources, type TakeBufferResolver } from '../../src/state/liveMixer';
import type {
  AudioClip, ClipTake, EditorBus, EditorTrack, AutomationLane as AutomationLaneT,
} from '../../src/state/editorStore';
import {
  addBus, addSend, emptyGraph, ensureTrackNode, setOutput, type RoutingGraph,
} from '../../src/state/routingGraph';
import type { ChainEntry } from '../../src/state/effectChainStore';
import {
  legacyCommitEdit, legacyRenderTrackStem, legacySendSelectionToInit,
  type Project, type Rendered,
} from './legacyBodies';

/* ── Deterministic RNG, so the convolution IR is the same room twice ──────── */

const REAL_RANDOM = Math.random;
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
async function seeded<T>(fn: () => Promise<T>): Promise<T> {
  Math.random = mulberry32(0x5eed);
  try { return await fn(); } finally { Math.random = REAL_RANDOM; }
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

const SR = 44100;

/** A deterministic WAV of `channels` channels: a sine plus a little seeded
 *  noise, different per channel so a pan law change is audible in the diff. */
function makeWav(channels: number, seconds: number, freq: number, seed: number): Blob {
  const rnd = mulberry32(seed);
  const len = Math.round(seconds * SR);
  const ctx = new OfflineAudioContext(channels, len, SR);
  const buf = ctx.createBuffer(channels, len, SR);
  for (let ch = 0; ch < channels; ch += 1) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i += 1) {
      d[i] = 0.55 * Math.sin((2 * Math.PI * (freq + ch * 37) * i) / SR) + 0.08 * (rnd() * 2 - 1);
    }
  }
  return encodeWav(buf, { float32: false });
}

const MONO = makeWav(1, 4.0, 220, 11);
const STEREO = makeWav(2, 4.0, 330, 22);
const MUTED_SRC = makeWav(2, 3.0, 440, 33);
const SOLO_SRC = makeWav(2, 3.0, 550, 44);
const VSTLESS_SRC = makeWav(1, 3.0, 660, 55);
const VSTED_SRC = makeWav(2, 3.0, 770, 66);

const clip = (o: Partial<AudioClip> & Pick<AudioClip, 'id' | 'trackId' | 'audioBlob'>): AudioClip => ({
  label: o.id,
  mimeType: 'audio/wav',
  sourceDuration: 4,
  offsetIntoSource: 0,
  durationSec: 3,
  startSec: 0,
  color: '#888',
  ...o,
} as AudioClip);

const track = (o: Partial<EditorTrack> & Pick<EditorTrack, 'id'>): EditorTrack => ({
  name: o.id,
  nameAutoGenerated: false,
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  color: '#888',
  ...o,
});

const COMPRESSOR: ChainEntry = {
  id: 'fx-comp',
  effect: 'compressor',
  enabled: true,
  params: { threshold: -24, ratio: 4, knee: 6, attack: 10, release: 150, makeup: 3 },
};
/** What the compressor DECLARES, written out here rather than read back from
 *  `rackEffects`: the Web Audio spec gives `DynamicsCompressorNode` a fixed
 *  6 ms look-ahead pre-delay. It is the only effect in this project that
 *  declares any latency at all, so it is the whole of every case's expected
 *  render trim — a chain of a compressor and a reverb still declares 6 ms. */
const COMPRESSOR_LATENCY_SEC = 0.006;
const REVERB: ChainEntry = {
  id: 'fx-verb',
  effect: 'reverb',
  enabled: true,
  params: { decay: 1.8, predelay: 20, tone: 8000, wet: 0.35 },
};
/** A hosted VST3 entry. It never runs in the browser — both the old body and
 *  the core strip it from the rack, and the real consumer posts the stem
 *  through it on the backend afterwards. Its only effect on a bounce is that
 *  `renderTrackStem` then encodes the stem as float32 so the backend hops do
 *  not requantize, which is the branch the C cases below need covered. No
 *  request is made: neither side does the backend hops. */
const VST3: ChainEntry = {
  id: 'fx-vst3',
  effect: 'vst3',
  enabled: true,
  params: {},
  vst: { plugin_path: 'C:/fake/NotLoaded.vst3', plugin_name: 'NotLoaded' },
};

/** The project the ticket specifies: a mono clip and a stereo clip on one
 *  track, a fade in/out, a muted track, a soloed track, a track carrying the
 *  compressor and the reverb, a volume lane and an FX-param lane, and a
 *  VST-less track for the stem render. `solo` and `laneCurve` are the two
 *  dials the cases below turn. */
function buildProject(opts: { solo: boolean; laneCurve: number }): Project {
  // T1 is soloed alongside T3 in the solo variant, so the solo case still
  // renders the rack, the lanes and the mono/stereo pair instead of silencing
  // every interesting track.
  const tMain = track({
    id: 'T1', name: 'main', volume: 0.8, pan: -0.3, solo: opts.solo, fxChain: [COMPRESSOR, REVERB],
  });
  const tMuted = track({ id: 'T2', name: 'muted', mute: true, volume: 0.9, pan: 0.4 });
  const tSolo = track({ id: 'T3', name: 'soloed', solo: opts.solo, volume: 0.7, pan: 0.2 });
  const tVstless = track({ id: 'T4', name: 'vstless', volume: 0.6, pan: 0.5, fxChain: [COMPRESSOR] });
  // The float32 branch of the stem render: a rack entry the core keeps and a
  // hosted VST3 entry it strips.
  const tVsted = track({ id: 'T5', name: 'vsted', volume: 0.55, pan: -0.2, fxChain: [COMPRESSOR, VST3] });

  const clips: AudioClip[] = [
    clip({
      id: 'C1-mono', trackId: 'T1', audioBlob: MONO,
      startSec: 0.5, durationSec: 3, fadeInSec: 0.4, fadeOutSec: 0.6, gain: 0.9,
    }),
    clip({ id: 'C2-stereo', trackId: 'T1', audioBlob: STEREO, startSec: 2.0, durationSec: 3 }),
    clip({ id: 'C3-muted-track', trackId: 'T2', audioBlob: MUTED_SRC, startSec: 1.0, durationSec: 2.5 }),
    clip({ id: 'C4-solo-track', trackId: 'T3', audioBlob: SOLO_SRC, startSec: 0.8, durationSec: 2.5 }),
    clip({ id: 'C5-vstless', trackId: 'T4', audioBlob: VSTLESS_SRC, startSec: 1.5, durationSec: 2.0 }),
    clip({
      id: 'C6-vsted', trackId: 'T5', audioBlob: VSTED_SRC,
      startSec: 0.3, durationSec: 2.4, fadeInSec: 0.3, fadeOutSec: 0.3,
    }),
  ];

  const automationLanes: AutomationLaneT[] = [
    {
      id: 'L-vol', enabled: true,
      target: { kind: 'trackVolume', trackId: 'T1' },
      points: [
        { t: 0, v: 0.3, curve: opts.laneCurve },
        { t: 2.5, v: 1.0, curve: opts.laneCurve },
        { t: 5.0, v: 0.5 },
      ],
    },
    {
      // The other caller of renderCore's `scheduleParamLane`, so both are
      // measured. Out of range on purpose: the clamp has to reach inside the
      // rasterised curve, not just its endpoints.
      id: 'L-pan', enabled: true,
      target: { kind: 'trackPan', trackId: 'T1' },
      points: [
        { t: 0.2, v: -1.4, curve: -opts.laneCurve },
        { t: 3.5, v: 1.4 },
      ],
    },
    {
      id: 'L-fx', enabled: true,
      target: { kind: 'trackFx', trackId: 'T1', entryId: 'fx-comp', paramKey: 'threshold' },
      points: [
        { t: 0, v: -12 },
        { t: 3.0, v: -40 },
      ],
    },
  ];

  return {
    clips,
    tracks: [tMain, tMuted, tSolo, tVstless, tVsted],
    masterFxChain: [REVERB],
    automationLanes,
  };
}

/* ── Case E's project: the two-track minimum of the skew T18 closes ───────── */

/** One compressed track and one dry one, nothing else — no master rack, no
 *  automation, no routing. Two tracks is the whole bug: the compressor lags S1
 *  by 6 ms, so before T18 the bounce printed S1 late, took `maxSec` off the
 *  front, landed S1 and threw S2 6 ms EARLY. Nothing else is in the project
 *  because nothing else needs to be, and because the master rack is the one
 *  thing that would stop the per-track reference below being exact (see
 *  `alignedLegacyMix`).
 *
 *  `S2-tail` ends ON the render's last sample (the 30 s floor of
 *  `renderExtentSec`), and it is on the DRY track — the one whose comp delay
 *  pushes it 6 ms past the end of the window. A context sized to the window
 *  stops before that audio is rendered and the trim then zero-fills it, so this
 *  clip is what asserts the context is padded by the latency it will trim. */
function skewProject(): Project {
  const wet = track({ id: 'S1', name: 'compressed', volume: 0.8, pan: -0.3, fxChain: [COMPRESSOR] });
  const dry = track({ id: 'S2', name: 'dry', volume: 0.7, pan: 0.35 });
  const clips: AudioClip[] = [
    clip({
      id: 'S1-mono', trackId: 'S1', audioBlob: MONO,
      startSec: 0.25, durationSec: 3, fadeInSec: 0.3, fadeOutSec: 0.4, gain: 0.9,
    }),
    clip({ id: 'S2-stereo', trackId: 'S2', audioBlob: STEREO, startSec: 0.5, durationSec: 3 }),
    clip({ id: 'S2-tail', trackId: 'S2', audioBlob: STEREO, startSec: 27, durationSec: 3 }),
  ];
  return { clips, tracks: [wet, dry], masterFxChain: [], automationLanes: [] };
}

/* ── Case F's project: a COMPED clip, two takes, one crossfaded boundary ──── */

/** The two takes' audio, deliberately far apart in pitch: if the offline render
 *  resolved the wrong take for a region, the diff is a whole tone generator out,
 *  not a rounding difference. `TAKE_B` is also a different channel count, which
 *  is the other thing a wrong resolution would show up as. */
const TAKE_A = makeWav(2, 4.0, 220, 77);
const TAKE_B = makeWav(1, 4.0, 880, 88);
/** A third clip on the comped track that has NO takes at all, so the case also
 *  asserts the ordinary path is untouched by the comped one beside it. */
const PLAIN_SRC = makeWav(2, 4.0, 330, 99);

const takeOf = (id: string, audioBlob: Blob): ClipTake => ({
  id, label: id, audioBlob, mimeType: 'audio/wav', sourceDuration: 4, offsetIntoSource: 0,
});

/**
 * One track carrying a comped clip and a plain one, and a second track carrying
 * a plain clip — no rack anywhere, so nothing declares latency and the render
 * trim is 0, which keeps the case about the comp and nothing else.
 *
 * The comp is the minimum the ticket names and the one that exercises both
 * kinds of boundary: take A from the clip head, take B from 1.5 s with a 0.3 s
 * crossfade at that boundary. ACTIVE TAKE 1, so the clip's mirrored fields hold
 * take B — the invariant is then load-bearing in the reference as well as in
 * the renderer, instead of being hidden by a default of 0.
 */
function compedProject(): Project {
  const takes = [takeOf('K1-a', TAKE_A), takeOf('K1-b', TAKE_B)];
  const tComp = track({ id: 'K1', name: 'comped', volume: 0.8, pan: -0.3 });
  const tPlain = track({ id: 'K2', name: 'plain', volume: 0.7, pan: 0.35 });
  const clips: AudioClip[] = [
    clip({
      id: 'K1-comped', trackId: 'K1', audioBlob: takes[1].audioBlob,
      startSec: 0.25, durationSec: 3.5, fadeInSec: 0.3, fadeOutSec: 0.4, gain: 0.9,
      takes,
      activeTakeIndex: 1,
      comp: [
        { startSec: 0, takeIndex: 0 },
        { startSec: 1.5, takeIndex: 1, crossfadeSec: 0.3 },
      ],
    }),
    clip({ id: 'K1-plain', trackId: 'K1', audioBlob: PLAIN_SRC, startSec: 5, durationSec: 2.5 }),
    clip({ id: 'K2-plain', trackId: 'K2', audioBlob: STEREO, startSec: 1, durationSec: 3 }),
  ];
  return { clips, tracks: [tComp, tPlain], masterFxChain: [], automationLanes: [] };
}

/**
 * THE LIVE REFERENCE. `liveMixer.buildTrackNodes` builds `gain -> muteGain ->
 * [fx] -> panner -> comp -> routing`, and `liveMixer.scheduleClips` hands each
 * clip to `scheduleClipSources` with the buffer (or, for a comped clip, the take
 * resolver) it peeked out of `lib/decodeCache`. With no rack, no mute, no solo
 * and no routing, that strip is `gain -> muteGain -> panner -> master`, and
 * every node of it but the fader and the panner is unity — so this renders the
 * live graph, offline, from the top of the timeline.
 *
 * NOTHING HERE READS `renderCore`. The clip scheduling is the shared seam on
 * purpose — that IS the thing being asserted — but the strip, the decode, the
 * resolver and the summing are written out here from the live mixer's described
 * shape, so a change to `renderCore`'s own graph cannot move this side with it.
 *
 * `nowSec = fromSec = 0`: playback from the top, where the context clock IS the
 * timeline — the same pin the offline render makes.
 */
async function liveStripRender(p: Project, req: BounceRequest): Promise<Rendered> {
  const sr = BOUNCE_SAMPLE_RATE;
  const lengthSec = renderExtentSec(p.clips, req.scope);
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * sr), sr);

  // Decode every blob the clips can play — the clip's own and, for a comped
  // clip, each take's — at the bounce rate, through the one shared cache.
  const decodeCtx = new AudioContext({ sampleRate: sr });
  try {
    for (const c of p.clips) {
      await decodeClipBlob(decodeCtx, c.audioBlob);
      if (!isComped(c)) continue;
      for (const t of c.takes ?? []) await decodeClipBlob(decodeCtx, t.audioBlob);
    }
  } finally {
    decodeCtx.close().catch(() => {});
  }

  const anySolo = p.tracks.some((t) => t.solo);
  const strips = new Map<string, GainNode>();
  for (const t of p.tracks) {
    const gain = ctx.createGain();
    gain.gain.value = t.volume;
    const muteGain = ctx.createGain();
    muteGain.gain.value = t.mute || (anySolo && !t.solo) ? 0 : 1;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, t.pan));
    gain.connect(muteGain).connect(panner).connect(ctx.destination);
    strips.set(t.id, gain);
  }

  for (const c of p.clips) {
    if (c.muted) continue;
    const gain = strips.get(c.trackId);
    if (!gain) continue;
    const takes = c.takes ?? [];
    const resolver: TakeBufferResolver = (i) => {
      const t = takes[i];
      return t ? peekDecoded(ctx, t.audioBlob) : undefined;
    };
    const source = isComped(c) ? resolver : peekDecoded(ctx, c.audioBlob);
    if (!source) continue;
    scheduleClipSources(ctx, c, source, gain, 0, 0);
  }

  const rendered = await ctx.startRendering();
  return { blob: encodeBounce(rendered, req), rendered };
}

/* ── Case D's project: ONE track, so the whole render is on the routed path ── */

const ROUTED_SEND_GAIN = 0.5;
const ROUTED_BUS_VOLUME = 0.5;

/** Deliberately one track and no rack anywhere. A second track feeding the
 *  master directly would be unscaled while the routed one is scaled, and there
 *  would be no single factor to state; a rack would declare latency and put the
 *  render trim into a case that is about the graph. */
function routedProject(): Project {
  const t = track({ id: 'R1', name: 'routed', volume: 0.8, pan: -0.3 });
  const clips: AudioClip[] = [
    clip({
      id: 'R1-mono', trackId: 'R1', audioBlob: MONO,
      startSec: 0.25, durationSec: 3, fadeInSec: 0.3, fadeOutSec: 0.4, gain: 0.9,
    }),
    clip({ id: 'R1-stereo', trackId: 'R1', audioBlob: STEREO, startSec: 1.5, durationSec: 2.5 }),
  ];
  return { clips, tracks: [t], masterFxChain: [], automationLanes: [] };
}

/** R1 -> RB, plus a send R1 -> RB. Built through the model's own mutators, so
 *  an edge this harness asserts on is an edge the app can actually make. */
const ROUTED: Routed = (() => {
  let g = emptyGraph();
  g = ensureTrackNode(g, 'R1', 'routed');
  g = addBus(g, 'RB', 'Routed bus');
  const out = setOutput(g, 'R1', 'RB');
  if (!out.ok) throw new Error(`ab: R1 -> RB refused (${out.reason})`);
  const send = addSend(out.graph as RoutingGraph, 'R1', 'RB', ROUTED_SEND_GAIN);
  if (!send.ok) throw new Error(`ab: send R1 -> RB refused (${send.reason})`);
  const buses: EditorBus[] = [
    { id: 'RB', name: 'Routed bus', fxChain: [], volume: ROUTED_BUS_VOLUME, mute: false },
  ];
  return { routing: send.graph as RoutingGraph, buses };
})();

/* ── The new path: exactly the deps `WaveformEditor.renderDeps()` builds ──── */

interface Routed { routing: RoutingGraph; buses: EditorBus[] }

const depsFor = (p: Project, routed?: Routed): RenderDeps => ({
  clips: p.clips,
  tracks: p.tracks,
  masterFxChain: p.masterFxChain,
  automationLanes: p.automationLanes,
  routing: routed?.routing,
  buses: routed?.buses,
  decode: decodeClipBlob,
  buildChain: buildEffectChain,
  scheduleSources: scheduleClipSources,
});

async function core(p: Project, req: BounceRequest, routed?: Routed): Promise<Rendered> {
  const rendered = await renderBounce(req, depsFor(p, routed));
  return { blob: encodeBounce(rendered, req), rendered };
}

/** A rendered buffer times a constant, as a `Rendered` the comparison can eat.
 *  Used to build case D's reference: the gain a routed path is SPECIFIED to
 *  apply, written out by hand rather than taken from the code under test. */
function scaled(r: Rendered, factor: number, req: BounceRequest): Rendered {
  const chans: Float32Array[] = [];
  for (let ch = 0; ch < r.rendered.numberOfChannels; ch += 1) {
    const src = r.rendered.getChannelData(ch);
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 1) out[i] = src[i] * factor;
    chans.push(out);
  }
  const rendered = {
    duration: r.rendered.duration,
    length: r.rendered.length,
    sampleRate: r.rendered.sampleRate,
    numberOfChannels: r.rendered.numberOfChannels,
    getChannelData: (ch: number) => chans[ch],
  } as unknown as AudioBuffer;
  return { blob: encodeBounce(rendered, req), rendered };
}

/** One set of tracks that all declare the same latency, and what they declare.
 *  The unit `alignedLegacyMix` shifts by — per TRACK is the same thing with one
 *  track in each group. */
interface LatencyGroup { ownSec: number; trackIds: string[] }

/**
 * The legacy mix, re-assembled with every track where the compensation delays
 * now put it: ONE legacy render per latency group (the project's clips filtered
 * to that group's tracks), each shifted forward by that group's own declared
 * latency, summed.
 *
 * That is the definition of per-track compensation, written out as arithmetic
 * the harness owns: a track that declares `own` is `own` late in the legacy
 * body, and the core now delays it by `maxSec - own` and takes `maxSec` off the
 * whole file, so it should land exactly where the legacy render of that track
 * alone lands after `own` is shifted off it. Nothing here reads the renderer.
 *
 * WHY IT IS SOUND, and where it is not exact. Every track's own strip is
 * independent — its rack, fader and panner see nothing but that track — and the
 * summing bus is a plain add: adding two float32 parts here rounds exactly as
 * the master bus's own add does, so a split-and-re-summed mix with no master
 * rack is bit-identical to the whole one — measured at 0.000e+0 over all
 * 1 323 000 samples of case E's project while this was being built.
 * What is NOT split cleanly is a MASTER rack: the core convolves the sum while
 * this convolves each part. Convolution is linear so the two agree, but through
 * a different order of float32 FFT rounding, so case B lands a shade off
 * bit-identical while case E (no master rack) is exact. The gate is 1e-4 and
 * the residual is the FFT's, not the renderer's — which is the reason case E
 * exists as its own case at all.
 *
 * Solo and mute need no special handling: each part goes through the same
 * `legacyCommitEdit`, which applies them exactly as it does for the whole mix,
 * so a group whose tracks a solo silences contributes silence to the sum — as
 * it does to the core render.
 */
async function alignedLegacyMix(
  p: Project, groups: LatencyGroup[], req: BounceRequest,
): Promise<Rendered> {
  // A track left out of every group would be missing from the reference and
  // the diff would blame the renderer for it. Muted ones are legitimately out
  // (they are in neither side); a solo is not checked here because it silences
  // a track INSIDE its part, exactly as it does in the core render.
  const covered = new Set(groups.flatMap((g) => g.trackIds));
  const missed = p.tracks.filter((t) => !t.mute && !covered.has(t.id)).map((t) => t.id);
  if (missed.length > 0) {
    throw new Error(`ab: latency groups do not cover unmuted track(s) ${missed.join(', ')}`);
  }

  const parts: AudioBuffer[] = [];
  for (const g of groups) {
    const ids = new Set(g.trackIds);
    const clips = p.clips.filter((c) => ids.has(c.trackId));
    // An empty group would render the 60 s empty-timeline length instead of the
    // mix's, and the shape mismatch would read as a renderer bug.
    if (clips.length === 0) throw new Error(`ab: latency group [${g.trackIds.join(', ')}] has no clips`);
    // A PAN LANE MOVES WITH THE TRACK, and shifting the rendered buffer is not
    // enough to say so. Since T19b the core writes a pan breakpoint at
    // `p.t + chainLatencySec(track chain)` — the panner is after the inserts, so
    // a lane authored for timeline `p.t` has to wait for them — while the legacy
    // body writes it at `p.t` flat. Shifting the whole part forward by `ownSec`
    // moves the legacy-placed envelope along with the audio it was applied to,
    // which puts it `ownSec` EARLY against the audio. Pre-shifting the points by
    // the same `ownSec` reproduces the new placement, and the part's own shift
    // then lands both together.
    //
    // `ownSec` is the right number for these projects because a group's figure
    // IS each member's own track-chain latency: no case here routes a compressed
    // track through a bus, so nothing downstream of the panner is in it. Add a
    // bus to a case and this has to split into path latency (the part's shift)
    // and chain latency (the lane's).
    //
    // FX lanes need no shift today: case B's is on the FIRST entry of its chain,
    // whose prefix is 0, and `fxLaneSampleTime` moves a step only by the entries
    // AHEAD of the one it writes.
    const lanes = g.ownSec > 0
      ? p.automationLanes.map((l) => (l.target.kind === 'trackPan' && ids.has(l.target.trackId)
        ? { ...l, points: l.points.map((pt) => ({ ...pt, t: pt.t + g.ownSec })) }
        : l))
      : p.automationLanes;
    const part = await seeded(() => legacyCommitEdit({ ...p, clips, automationLanes: lanes }));
    parts.push(trimLeadingSec(part.rendered, g.ownSec));
  }
  const [first] = parts;
  for (const part of parts) {
    if (part.length !== first.length || part.numberOfChannels !== first.numberOfChannels) {
      throw new Error('ab: latency groups rendered different shapes');
    }
  }
  const chans: Float32Array[] = [];
  for (let ch = 0; ch < first.numberOfChannels; ch += 1) {
    const out = new Float32Array(first.length);
    for (const part of parts) {
      const d = part.getChannelData(ch);
      for (let i = 0; i < out.length; i += 1) out[i] += d[i];
    }
    chans.push(out);
  }
  const rendered = {
    duration: first.duration,
    length: first.length,
    sampleRate: first.sampleRate,
    numberOfChannels: first.numberOfChannels,
    getChannelData: (ch: number) => chans[ch],
  } as unknown as AudioBuffer;
  return { blob: encodeBounce(rendered, req), rendered };
}

/* ── Compare ─────────────────────────────────────────────────────────────── */

interface Delta { channel: number; maxAbs: number; rms: number; samples: number }

interface Diff {
  deltas: Delta[];
  /** Set when the two sides are not the same shape. A truncating compare would
   *  otherwise report a tiny delta over the overlap and say nothing about the
   *  samples one side does not have — so this is a hard FAILURE in `run.mjs`,
   *  never a note. A render that is the wrong LENGTH is the wrong render. */
  mismatch?: string;
}

/** Diff two AudioBuffers — the render itself, before the 16-bit encode. A
 *  difference of exactly 2^-15 (3.05e-5) in the file domain is one PCM16 LSB
 *  and says nothing about the render; this says what the render actually did. */
function diffBuffers(label: string, a: AudioBuffer, b: AudioBuffer): Diff {
  const mismatch = (a.length !== b.length || a.numberOfChannels !== b.numberOfChannels)
    ? `SHAPE MISMATCH (${label}) legacy=${a.numberOfChannels}x${a.length} core=${b.numberOfChannels}x${b.length}`
    : undefined;
  const chans = Math.min(a.numberOfChannels, b.numberOfChannels);
  const n = Math.min(a.length, b.length);
  const deltas: Delta[] = [];
  for (let ch = 0; ch < chans; ch += 1) {
    const da = a.getChannelData(ch);
    const db = b.getChannelData(ch);
    let maxAbs = 0;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const d = Math.abs(da[i] - db[i]);
      if (d > maxAbs) maxAbs = d;
      sum += d * d;
    }
    deltas.push({ channel: ch, maxAbs, rms: Math.sqrt(sum / n), samples: n });
  }
  return { deltas, mismatch };
}

/** `trimSec` shifts the LEGACY side forward before the diff, so a case can
 *  claim the render trim T14 introduced and still assert identical audio. The
 *  shift is the same pure function the bounce uses, applied to the 16-bit
 *  decode — quantise-then-shift and shift-then-quantise are the same samples,
 *  because the shift moves samples and never computes one. */
async function compare(a: Blob, b: Blob, trimSec: number): Promise<Diff> {
  const ctx = new AudioContext({ sampleRate: SR });
  try {
    const [ba, bb] = await Promise.all([
      ctx.decodeAudioData(await a.arrayBuffer()),
      ctx.decodeAudioData(await b.arrayBuffer()),
    ]);
    return diffBuffers('wav', trimLeadingSec(ba, trimSec), bb);
  } finally {
    ctx.close().catch(() => {});
  }
}

/* ── Cases ───────────────────────────────────────────────────────────────── */

interface CaseResult {
  renderer: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  /** Diff of the WAV files the app writes (16-bit PCM for all three today). */
  deltas: Delta[];
  /** Diff of the rendered AudioBuffers, before any encode. */
  floatDeltas: Delta[];
  /** Every shape disagreement found, in either domain. Non-empty = the case
   *  FAILS, whatever the deltas over the overlap say. */
  mismatches: string[];
  extra?: string;
  error?: string;
}

async function runCases(): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const add = async (
    renderer: 'A' | 'B' | 'C' | 'D' | 'E' | 'F', name: string,
    run: () => Promise<{
      legacy: Rendered; core: Rendered; extra?: string;
      /** How far forward T14's render trim is EXPECTED to have moved the core
       *  side, in seconds, over and above whatever the reference already
       *  accounts for. Stated by the case, never read off the renderer. A case
       *  whose tracks declare DIFFERENT latencies cannot say it in one number —
       *  it hands `alignedLegacyMix` a shift per latency group and leaves this
       *  at 0, because the reference is then already aligned. */
      expectTrimSec?: number;
    }>,
  ) => {
    try {
      const { legacy, core: c, extra, expectTrimSec } = await run();
      const trim = expectTrimSec ?? 0;
      const wav = await compare(legacy.blob, c.blob, trim);
      const floats = diffBuffers('render', trimLeadingSec(legacy.rendered, trim), c.rendered);
      out.push({
        renderer, name, deltas: wav.deltas, floatDeltas: floats.deltas, extra,
        mismatches: [wav.mismatch, floats.mismatch].filter((m): m is string => m != null),
      });
    } catch (e) {
      out.push({
        renderer, name, deltas: [], floatDeltas: [], mismatches: [],
        error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
      });
    }
  };

  /* A — selection. `includeTrackMix: true`, and solo must be IGNORED, so the
     soloed project is the one that proves it. */
  for (const solo of [false, true]) {
    await add('A', `selection · mono+stereo+fades+muted-track · solo=${solo}`, async () => {
      const p = buildProject({ solo, laneCurve: 0 });
      // The selection the editor would hand over: both T1 clips, plus the clip
      // on the muted track (A honours mute) and the one on the soloed track
      // (A ignores solo).
      const selection = p.clips.filter((c) => ['C1-mono', 'C2-stereo', 'C3-muted-track', 'C4-solo-track'].includes(c.id));
      const scope: BounceScope = { kind: 'selection', clipIds: selection.map((c) => c.id) };
      const req: BounceRequest = {
        scope, sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: false, includeAutomation: false, includeTrackMix: true, float32: false,
      };
      const legacy = await seeded(() => legacySendSelectionToInit(p, selection));
      const c = await seeded(() => core(p, req));
      return { legacy, core: c };
    });
  }

  /* B — master. Two solo states, and a linear vs curved volume lane.

     The mix is MIXED-LATENCY: T1, T4 and T5 carry the compressor and T3 carries
     nothing, so since T18 the core holds 6 ms on T3's strip and lands all four
     where the timeline says. The legacy body cannot do that, so the reference is
     assembled per latency group (`alignedLegacyMix`) and the case's own further
     shift is 0 — the groups have already been shifted by their own figures.
     Sending T4/T5 into the wet group in the soloed variant is harmless: the
     solo silences them inside each part exactly as it does in the core. */
  for (const solo of [false, true]) {
    for (const laneCurve of [0, 0.7]) {
      await add('B', `master · compressor+reverb · volLane(curve=${laneCurve}) + fxLane · solo=${solo}`, async () => {
        const p = buildProject({ solo, laneCurve });
        const req: BounceRequest = {
          scope: { kind: 'master' }, sampleRate: BOUNCE_SAMPLE_RATE,
          includeFx: true, includeAutomation: true, includeTrackMix: true, float32: false,
        };
        const legacy = await alignedLegacyMix(p, [
          { ownSec: COMPRESSOR_LATENCY_SEC, trackIds: ['T1', 'T4', 'T5'] },
          { ownSec: 0, trackIds: ['T3'] },
        ], req);
        const c = await seeded(() => core(p, req));
        return {
          legacy,
          core: c,
          expectTrimSec: 0,
          extra: 'reference = the legacy mix re-assembled per latency group: the compressed '
            + 'tracks shifted by 6 ms, the dry one by 0. The master reverb is convolved per '
            + 'part rather than over the sum, so the residual is the FFT\'s rounding — about '
            + '3e-7, one float32 ULP at these amplitudes. Case E is the same assertion with '
            + 'no master rack, and is exact.',
        };
      });
    }
  }

  /* C — track stem, on the VST-less track (float32 === false) and on the
     rack-heavy track. Automation must NOT apply, the track mix must NOT apply. */
  const stemCases: Record<string, string> = {
    T4: 'VST-less, compressor — float32=false',
    T1: 'compressor+reverb — float32=false',
    T5: 'compressor + an enabled VST3 entry — float32=TRUE',
  };
  for (const trackId of ['T4', 'T1', 'T5']) {
    await add('C', `stem · ${trackId} · ${stemCases[trackId]}`, async () => {
      const p = buildProject({ solo: false, laneCurve: 0 });
      const trk = p.tracks.find((t) => t.id === trackId)!;
      const vsts = (trk.fxChain ?? []).filter((e) => e.enabled && e.effect === 'vst3' && e.vst);
      const scope: BounceScope = { kind: 'track', trackId };
      const req: BounceRequest = {
        scope, sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: true, includeAutomation: false, includeTrackMix: false,
        float32: vsts.length > 0,
      };
      const legacy = await seeded(() => legacyRenderTrackStem(p, trackId));
      const c = await seeded(() => core(p, req));
      const coreDur = renderExtentSec(p.clips, scope);
      return {
        legacy, core: c,
        // Every stem track here carries the compressor, and a stem trims by its
        // OWN chain only — the hosted VST3 on T5 is stripped before the render
        // and declares nothing either way.
        expectTrimSec: COMPRESSOR_LATENCY_SEC,
        extra: `durationSec legacy=${legacy.durationSec} core=${coreDur} float32=${vsts.length > 0}`,
      };
    });
  }

  /* D — the routing graph. There is no legacy body to A/B against: the three
     inline renderers predate buses entirely and every one of them summed
     straight to the master. So the reference is the core's own FLAT render of
     the same project, times the gain the LIVE graph is specified to apply.

     R1 -> RB (main output) AND R1 -> RB (send at 0.5), RB at volume 0.5:

       - `wireRoutingGraph` taps a send off the SAME output node as the main
         path rather than replacing it (pinned in
         `state/liveMixer.routing.test.ts`), so RB's input sums R1 twice —
         1.0 through the output edge and 0.5 through the send.
       - a bus strip is `input -> [fx] -> gain -> muteGain -> output`, and with
         an empty rack, an unmuted gate and volume 0.5 that is one 0.5 fader.

     Expected: flat x (1 + 0.5) x 0.5 = flat x 0.75, sample for sample. No rack
     anywhere, so no chain declares latency and the render trim is 0. */
  await add('D', 'routed · R1 -> bus(vol 0.5) with a send(0.5) into the same bus', async () => {
    const p = routedProject();
    const req: BounceRequest = {
      scope: { kind: 'master' }, sampleRate: BOUNCE_SAMPLE_RATE,
      includeFx: false, includeAutomation: false, includeTrackMix: true, float32: false,
    };
    const flat = await seeded(() => core(p, req));
    const routed = await seeded(() => core(p, req, ROUTED));
    return {
      legacy: scaled(flat, (1 + ROUTED_SEND_GAIN) * ROUTED_BUS_VOLUME, req),
      core: routed,
      extra: `reference = the core's own routing-less render x ${(1 + ROUTED_SEND_GAIN) * ROUTED_BUS_VOLUME}`,
    };
  });

  /* E — THE T18 CASE, stated per TRACK. One compressed track, one dry one, and
     nothing else in the project: no master rack, so the reference decomposes
     exactly (see `alignedLegacyMix`) and the case can claim bit-identity rather
     than "within the gate".

     S1 declares 6 ms and S2 declares nothing, so:

       - S1 is the slowest path. Its comp holds 0, the file is trimmed by 6 ms,
         and it lands where the legacy render of S1 alone lands once 6 ms is
         shifted off it.
       - S2 is the one T14 could not place. Its comp holds the 6 ms, so after
         the same trim it lands on its legacy render shifted by EXACTLY 0 —
         where before T18 it printed 6 ms early. That zero is the whole ticket.

     Run the same case against a core with the comp splice removed and S2's
     delta is the dry track itself, six milliseconds out — far over the gate. */
  await add('E', 'master · one compressed + one dry track · per-track compensation', async () => {
    const p = skewProject();
    const req: BounceRequest = {
      scope: { kind: 'master' }, sampleRate: BOUNCE_SAMPLE_RATE,
      includeFx: true, includeAutomation: false, includeTrackMix: true, float32: false,
    };
    const legacy = await alignedLegacyMix(p, [
      { ownSec: COMPRESSOR_LATENCY_SEC, trackIds: ['S1'] },
      { ownSec: 0, trackIds: ['S2'] },
    ], req);
    const c = await seeded(() => core(p, req));
    return {
      legacy,
      core: c,
      expectTrimSec: 0,
      extra: 'reference = legacy(S1) shifted by 0.006 + legacy(S2) shifted by 0 — '
        + 'each track where per-track compensation puts it, summed. S2 also holds a clip '
        + 'ending on the render\'s last sample, so this asserts the padded context too: '
        + 'un-padded, S2\'s comp pushes that clip\'s last 6 ms past the end of the window '
        + 'and the trim zero-fills it.',
    };
  });

  /* F — COMPING. `export == preview` for a clip that plays more than one take.
     There is no legacy body: the three inline renderers predate takes entirely.
     The reference is the LIVE strip (`liveStripRender`) — the node shape
     `liveMixer.buildTrackNodes` makes, the resolver `liveMixer.scheduleClips`
     builds, rendered offline from the top of the timeline — so the case asserts
     the preview against the print rather than the renderer against itself.

     Two takes (220 Hz stereo and 880 Hz MONO), one boundary at 1.5 s with a
     0.3 s crossfade, ACTIVE TAKE 1. Beside it on the same track, and on a second
     track, plain clips with no takes: those must come out untouched, so the case
     is also a statement that the comped clip changes nothing around it.

     WHAT MAKES IT BITE. Both sides read the SAME decoded buffers (one
     `lib/decodeCache`, one rate), so the only way to differ is to resolve a
     different take or to place a segment differently — and the takes are a
     whole tone generator and a channel count apart, so either is max |Δ| near
     full scale, not a rounding residual. Measured: with renderCore's resolver
     mutated to answer take 0 for every index, this case reads max |Δ| 1.247
     (ch0) / 7.980e-1 (ch1) — OVER GATE — while every other case stays
     bit-identical.

     WHAT IT ASSERTS, in full: the decode (both sides hold every take), the
     resolution (each region reads its own take), the segment placement (the
     boundary at 1.5 s) and the crossfade across it — because the same
     `scheduleClipSources` walks `compSegments` on both sides, and a bounce that
     placed a segment or a fade differently would land off the live strip. That
     is the point of putting the shared behaviour in one function rather than
     two: this case cannot go stale against the scheduler, because it IS the
     scheduler on both sides of the diff.

     No rack anywhere, so nothing declares latency and the render trim is 0. */
  await add('F', 'comped · two takes, one 0.3 s crossfade · offline vs the live strip', async () => {
    const p = compedProject();
    const req: BounceRequest = {
      scope: { kind: 'master' }, sampleRate: BOUNCE_SAMPLE_RATE,
      includeFx: false, includeAutomation: false, includeTrackMix: true, float32: false,
    };
    const live = await seeded(() => liveStripRender(p, req));
    const c = await seeded(() => core(p, req));
    return {
      legacy: live,
      core: c,
      expectTrimSec: 0,
      extra: 'reference = the LIVE strip (gain -> muteGain -> panner) driven by the same '
        + 'scheduleClipSources and the same take resolver, rendered offline from t = 0. '
        + 'Both sides decode through the one decodeCache at 44.1 kHz, so they read the same '
        + 'buffers and any delta is a take resolved or a segment placed differently.',
    };
  });

  /* F2 — the same project with the comp REMOVED from the clip (its takes left
     in place). A clip with takes and no comp is take SWITCHING: it plays its
     active take and nothing about the render may change. Asserted against the
     live strip the same way, so the non-comped path is pinned on both sides. */
  await add('F', 'takes without a comp · take switching changes nothing', async () => {
    const p = compedProject();
    const comped = p.clips.find((c) => c.id === 'K1-comped')!;
    comped.comp = [];
    const req: BounceRequest = {
      scope: { kind: 'master' }, sampleRate: BOUNCE_SAMPLE_RATE,
      includeFx: false, includeAutomation: false, includeTrackMix: true, float32: false,
    };
    const live = await seeded(() => liveStripRender(p, req));
    const c = await seeded(() => core(p, req));
    return {
      legacy: live,
      core: c,
      expectTrimSec: 0,
      extra: 'the same project with comp = [] — the clip plays takes[activeTakeIndex] (its own '
        + 'mirrored blob) on both sides, through the single-buffer path.',
    };
  });

  return out;
}

declare global {
  interface Window { __AB__?: CaseResult[]; __AB_ERR__?: string }
}

runCases()
  .then((r) => { window.__AB__ = r; })
  .catch((e) => { window.__AB_ERR__ = e instanceof Error ? `${e.message}\n${e.stack}` : String(e); });
