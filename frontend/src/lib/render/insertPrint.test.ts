// A bounce prints every hosted VST3 insert in its place (lib/render/insertPrint).
//
// The EDIT export dialog's render bounced and delivered with no plugin hop: in
// an `OfflineAudioContext` a hosted VST3 entry is a passthrough, so an export
// printed no track plugin, no bus plugin and no master plugin at all. These
// cases replay the export's own sequence (the real `renderBounce`, stage by
// stage, with a stand-in for the backend hop) and read what came out.
//
// The stand-in context EVALUATES the graph it is handed. Every node carries a
// steady value; a gain multiplies, a sum adds, and a rack entry is an affine
// step `x -> m*x + a`, so both the ORDER of the steps and how many times each
// ran change the answer. The stand-in hop applies its plugin's own step to the
// WAV it is sent. So the value the destination holds is the exact composition
// the chain order says, or a different number.
//
// A second mode hands back a RAMP (sample i holds i) whatever the graph, so a
// trim is read straight off the first sample a hop receives.
//
// Run: npx tsx src/lib/render/insertPrint.test.ts
import assert from 'node:assert/strict';

import type { AudioClip, EditorBus, EditorTrack } from '../../state/editorStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import { addBus, emptyGraph, ensureTrackNode, setOutput, type RoutingGraph } from '../../state/routingGraph.ts';
import type { ChainHandle } from '../rackEffects.ts';
import { renderBounce, type BounceRequest, type RenderDeps } from '../renderCore.ts';
import { readWavSamples, writeFloatWav } from '../wavSamples.ts';
import {
  printSites, renderWithInserts, splitAtInserts,
  type InsertPrintOptions, type InsertPrintResult, type VstHop,
} from './insertPrint.ts';
import type { RenderRange } from './renderRange.ts';

/** A low rate keeps a 30 s master render to 30 000 frames; 6 ms is 6 of them. */
const SR = 1000;

/* ── The stand-in context ─────────────────────────────────────────────────── */

interface FakeNode {
  kind: string;
  gain: { value: number };
  pan: { value: number };
  delayTime: { value: number };
  playbackRate: { value: number };
  channelCount: number;
  channelCountMode: string;
  outputs: FakeNode[];
  /** What the node does to the sum of its inputs. */
  step: (x: number) => number;
  /** A source's steady value; a source has no inputs. */
  value?: number;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
}

const fakeNode = (kind: string): FakeNode => {
  const n: FakeNode = {
    kind,
    gain: { value: 1 },
    pan: { value: 0 },
    delayTime: { value: 0 },
    playbackRate: { value: 1 },
    channelCount: 2,
    channelCountMode: 'max',
    outputs: [],
    step: (x) => x,
    connect(to) { n.outputs.push(to); return to; },
    disconnect() { n.outputs.length = 0; },
  };
  return n;
};

type Mode = 'value' | 'ramp';

interface FakeCtx {
  sampleRate: number;
  length: number;
  destination: FakeNode;
  created: FakeNode[];
  createGain(): FakeNode;
  createStereoPanner(): FakeNode;
  createBufferSource(): FakeNode;
  suspend(t: number): Promise<void>;
  resume(): Promise<void>;
  startRendering(): Promise<AudioBuffer>;
}

const bufferOf = (length: number, sampleRate: number, channels: number, at: (i: number) => number): AudioBuffer => {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i += 1) d[i] = at(i);
    data.push(d);
  }
  return {
    duration: length / sampleRate, length, sampleRate, numberOfChannels: channels,
    getChannelData: (ch: number) => data[ch],
  } as unknown as AudioBuffer;
};

const fakeCtx = (channels: number, length: number, sampleRate: number, mode: Mode): FakeCtx => {
  const created: FakeNode[] = [];
  const make = (kind: string): FakeNode => {
    const n = fakeNode(`${kind}${created.length}`);
    created.push(n);
    return n;
  };
  const ctx: FakeCtx = {
    sampleRate,
    length,
    destination: fakeNode('destination'),
    created,
    createGain() {
      const n = make('gain');
      n.step = (x) => x * n.gain.value;
      return n;
    },
    createStereoPanner() { return make('pan'); }, // every track here is centred
    createBufferSource() { return make('src'); },
    suspend() { return Promise.resolve(); },
    resume() { return Promise.resolve(); },
    async startRendering() {
      const inputs = new Map<FakeNode, FakeNode[]>();
      for (const n of created) {
        for (const o of n.outputs) {
          const list = inputs.get(o) ?? [];
          list.push(n);
          inputs.set(o, list);
        }
      }
      const memo = new Map<FakeNode, number>();
      const valueOf = (n: FakeNode): number => {
        const hit = memo.get(n);
        if (hit !== undefined) return hit;
        const sum = n.value !== undefined ? n.value : (inputs.get(n) ?? []).reduce((s, u) => s + valueOf(u), 0);
        const v = n.step(sum);
        memo.set(n, v);
        return v;
      };
      const out = valueOf(ctx.destination);
      return bufferOf(length, sampleRate, channels, (i) => (mode === 'ramp' ? i : out));
    },
  };
  return ctx;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const affine = (e: ChainEntry) => (x: number): number => (e.params.m ?? 1) * x + (e.params.a ?? 0);

/** A rack entry: `x -> m*x + a`. Its id is no rack effect, so it declares no latency. */
const fx = (id: string, m: number, a: number): ChainEntry => ({
  id, effect: `test-${id}`, enabled: true, params: { m, a },
});

/** A hosted VST3 insert. The stand-in hop applies `x -> m*x + a`, and adds
 *  `tail` frames past the audio it is sent, as theDAW's own host does. */
const vst = (id: string, m: number, a: number, tail = 0): ChainEntry => ({
  id,
  effect: 'vst3',
  enabled: true,
  params: { m, a, tail },
  vst: { plugin_path: `C:/Plugins/${id}.vst3`, plugin_name: id, raw_state: `state-of-${id}`, state_host: 'thedaw' },
});

/** The real registry's `compressor` declares 6 ms. */
const compressor = (id: string): ChainEntry => ({ id, effect: 'compressor', enabled: true, params: {} });

const track = (over: Partial<EditorTrack> & { id: string }): EditorTrack => ({
  name: over.id.toUpperCase(),
  nameAutoGenerated: false,
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  color: '#fff',
  ...over,
});

const bus = (over: Partial<EditorBus> & { id: string }): EditorBus => ({
  name: over.id.toUpperCase(), fxChain: [], volume: 1, mute: false, ...over,
});

interface Harness {
  deps: RenderDeps;
  /** Every clip a render scheduled, and which render scheduled it. */
  scheduled: { clip: AudioClip; render: number }[];
  /** The entry ids each chain build was handed, and which render built it. */
  built: { entries: string[]; render: number }[];
  hops: { where: string; entry: ChainEntry; first: number; frames: number }[];
  hop: VstHop;
  renders: () => number;
}

const harness = (opts: {
  tracks: EditorTrack[];
  clips: { id: string; trackId: string; value: number; startSec?: number; durationSec?: number; muted?: boolean }[];
  buses?: EditorBus[];
  routing?: RoutingGraph;
  masterFxChain?: ChainEntry[];
  mode?: Mode;
}): Harness => {
  const mode = opts.mode ?? 'value';
  const valueOf = new Map<Blob, number>();
  const clips: AudioClip[] = opts.clips.map((c) => {
    const blob = new Blob([c.id]);
    valueOf.set(blob, c.value);
    return {
      id: c.id, trackId: c.trackId, label: c.id, audioBlob: blob, mimeType: 'audio/wav',
      sourceDuration: 60, offsetIntoSource: 0, durationSec: c.durationSec ?? 2, startSec: c.startSec ?? 0,
      color: '#fff', ...(c.muted ? { muted: true } : {}),
    };
  });
  let render = -1;
  const scheduled: Harness['scheduled'] = [];
  const built: Harness['built'] = [];
  const hops: Harness['hops'] = [];
  const buildChain = (c: unknown, input: unknown, output: unknown, entries: ChainEntry[]): ChainHandle => {
    const ctx = c as FakeCtx;
    built.push({ entries: entries.map((e) => e.id), render });
    let prev = input as FakeNode;
    for (const e of entries) {
      if (!e.enabled) continue;
      if (e.effect === 'vst3') continue; // offline, a hosted plugin is a passthrough
      const n = ctx.createGain();
      n.kind = `fx:${e.id}`;
      n.step = affine(e);
      prev.connect(n);
      prev = n;
    }
    prev.connect(output as FakeNode);
    return {
      rebuild: () => {}, updateParams: () => {}, instances: () => [], inertIds: () => [], dispose: () => {},
    } as unknown as ChainHandle;
  };
  const hop: VstHop = async (wav, entry, where) => {
    const s = readWavSamples(await wav.arrayBuffer());
    hops.push({ where, entry, first: s.channels[0][0], frames: s.frames });
    const step = affine(entry);
    const frames = s.frames + (entry.params.tail ?? 0);
    const channels = s.channels.map((ch) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < s.frames; i += 1) out[i] = step(ch[i]);
      return out;
    });
    return writeFloatWav({ sampleRate: s.sampleRate, channels, frames });
  };
  return {
    scheduled,
    built,
    hops,
    hop,
    renders: () => render + 1,
    deps: {
      clips,
      tracks: opts.tracks,
      masterFxChain: opts.masterFxChain ?? [],
      automationLanes: [],
      routing: opts.routing,
      buses: opts.buses,
      decode: async (_c, blob) => {
        const v = valueOf.get(blob);
        if (v !== undefined) return bufferOf(60 * SR, SR, 2, () => v);
        const s = readWavSamples(await blob.arrayBuffer());
        return bufferOf(s.frames, s.sampleRate, s.channels.length, (i) => s.channels[0][i]);
      },
      buildChain: buildChain as unknown as RenderDeps['buildChain'],
      scheduleSources: ((c: unknown, clip: AudioClip, buf: AudioBuffer, dest: FakeNode) => {
        const src = (c as FakeCtx).createBufferSource();
        src.value = buf.getChannelData(0)[0];
        src.connect(dest);
        scheduled.push({ clip, render });
        return null;
      }) as unknown as RenderDeps['scheduleSources'],
      makeContext: (channels, length, rate) => {
        render += 1;
        return fakeCtx(channels, length, rate, mode) as unknown as OfflineAudioContext;
      },
      makeDecodeContext: () => ({ close: async () => {} }) as unknown as BaseAudioContext & { close(): Promise<void> },
      makeCompDelay: (c) => (c as unknown as FakeCtx).createBufferSource() as unknown as DelayNode,
      ensureChop: async () => {},
      ensureHallIrs: async () => {},
      sliceChunks: () => [],
    },
  };
};

const request = (over: Partial<BounceRequest> = {}): BounceRequest => ({
  scope: { kind: 'master' },
  sampleRate: SR,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: true,
  float32: false,
  ...over,
});

const print = async (
  h: Harness, req: BounceRequest, over: Partial<InsertPrintOptions> = {},
): Promise<InsertPrintResult> => {
  const out = await renderWithInserts(req, h.deps, { hop: h.hop, ...over });
  assert.ok(out, 'the print ran to the end');
  return out as InsertPrintResult;
};

const first = (r: InsertPrintResult): number => r.buffer.getChannelData(0)[0];

const near = (actual: number, expected: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${what}: expected ${expected}, got ${actual}`);
};

/** t1 -> b1 -> master, t2 -> master. */
function graphWithOneBus(): RoutingGraph {
  let g = emptyGraph();
  g = ensureTrackNode(g, 't1', 'T1');
  g = ensureTrackNode(g, 't2', 'T2');
  g = addBus(g, 'b1', 'B1');
  const res = setOutput(g, 't1', 'b1');
  assert.ok(res.ok);
  return res.graph as RoutingGraph;
}

/* ── 1. A track's chain: every plugin once, among its rack effects, in order ── */

async function aTrackChainPrintsEveryPluginOnceInChainOrder(): Promise<void> {
  const A = fx('A', 2, 1);
  const V1 = vst('V1', 3, 0);
  const B = fx('B', 1, 5);
  const V2 = vst('V2', 0.5, 2);
  const C = fx('C', 2, -1);
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5, fxChain: [A, V1, B, V2, C] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
  });
  const progress: string[] = [];
  const out = await print(h, request(), { onProgress: (d, t) => progress.push(`${d}/${t}`) });

  // 1 through the fader (0.5), A (2x+1) = 2, V1 (3x) = 6, B (x+5) = 11,
  // V2 (0.5x+2) = 7.5, C (2x-1) = 14. With the plugins as passthroughs, as the
  // export printed them, the same chain comes to 13.
  near(first(out), 14, 'the mix is the chain applied once, in the order the user set');
  assert.deepEqual(h.hops.map((x) => `${x.where}:${x.entry.id}`), ['T1:V1', 'T1:V2'], 'each plugin prints once, in order');
  near(h.hops[0].first, 2, 'V1 hears the fader and A, nothing else');
  near(h.hops[1].first, 11, 'V2 hears V1 printed, then B');
  assert.equal(out.hops, 2);

  // Stage by stage: the first render builds only what sits ahead of V1, the
  // second only what sits between the plugins, and the mix only what follows.
  const t1Chains = h.built.filter((b) => b.entries.some((id) => ['A', 'B', 'C'].includes(id)));
  assert.deepEqual(t1Chains.map((b) => b.entries.join(',')), ['A', 'B', 'C'], 'every rack entry is built in exactly one stage');
  assert.deepEqual(progress, ['1/5', '2/5', '3/5', '4/5', '5/5'], 'three renders and two hops, each reported');

  // The mix plays the print, and not the clip it replaces.
  const mixClips = h.scheduled.filter((s) => s.render === h.renders() - 1).map((s) => s.clip.id);
  assert.deepEqual(mixClips, ['insert-print:t1'], 'the last render plays the print in place of the clip');
}

/* ── 2. A bus: prints what its tracks' plugins made, once, and nothing twice ─ */

async function aBusPrintsWhatItsTracksPrinted(): Promise<void> {
  const VT = vst('VT', 2, 0);
  const VB1 = vst('VB1', 1, 3);
  const D = fx('D', 2, 0);
  const VB2 = vst('VB2', 1, -1);
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [VT] }), track({ id: 't2' })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }, { id: 'c2', trackId: 't2', value: 10 }],
    buses: [bus({ id: 'b1', fxChain: [VB1, D, VB2] })],
    routing: graphWithOneBus(),
  });
  const out = await print(h, request());

  // t1: 1 -> VT (2x) = 2 -> b1: VB1 (x+3) = 5 -> D (2x) = 10 -> VB2 (x-1) = 9.
  // t2: 10 straight to the master. The sum is 19. A bus that still took t1's
  // routed audio as well as its print would count t1 twice.
  near(first(out), 19, 'the mix holds the bus print once and t2 once');
  assert.deepEqual(
    h.hops.map((x) => `${x.where}:${x.entry.id}`),
    ['T1:VT', 'B1:VB1', 'B1:VB2'],
    'the track prints before the bus that sums it, and each plugin prints once',
  );
  near(h.hops[1].first, 2, "the bus's first plugin hears t1's print and nothing from t2");
  near(h.hops[2].first, 10, "the bus's second plugin hears the first one, then D");
}

/* ── 3. The master VST chain: after the master rack, in the chain's order ───── */

async function theMasterChainPrintsAfterTheMasterRack(): Promise<void> {
  const MR = fx('MR', 2, 0);
  const MV1 = vst('MV1', 1, 1);
  const MV2 = vst('MV2', 3, 0);
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
    masterFxChain: [MR],
  });
  const out = await print(h, request(), { masterVstChain: [MV1, MV2] });
  // 1 -> MR (2x) = 2 -> MV1 (x+1) = 3 -> MV2 (3x) = 9.
  near(first(out), 9, 'the master plugins run over the finished mix, after the master rack');
  assert.deepEqual(h.hops.map((x) => `${x.where}:${x.entry.id}`), ['Master:MV1', 'Master:MV2']);
  near(h.hops[0].first, 2, 'MV1 hears the master rack');
  assert.equal(h.renders(), 1, 'nothing upstream prints, so the mix is rendered once');
}

/* ── 4. One export: track, bus and master, each once, upstream first ───────── */

async function oneExportPrintsTrackBusAndMasterOnceEach(): Promise<void> {
  const A = fx('A', 1, 1);
  const VT = vst('VT', 2, 0);
  const VB = vst('VB', 1, 1);
  const D = fx('D', 3, 0);
  const MR = fx('MR', 1, -2);
  const MV = vst('MV', 0.5, 0);
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [A, VT] }), track({ id: 't2', volume: 0.5 })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }, { id: 'c2', trackId: 't2', value: 4 }],
    buses: [bus({ id: 'b1', fxChain: [VB, D], volume: 0.5 })],
    routing: graphWithOneBus(),
    masterFxChain: [MR],
  });
  const out = await print(h, request(), { masterVstChain: [MV] });
  // t1: 1 -> A = 2 -> VT = 4 -> b1: VB = 5 -> D = 15 -> bus fader 0.5 = 7.5.
  // t2: 4 * 0.5 = 2. Sum 9.5 -> MR = 7.5 -> MV = 3.75.
  near(first(out), 3.75, 'every insert on the track, the bus and the master, applied once, in order');
  assert.deepEqual(h.hops.map((x) => `${x.where}:${x.entry.id}`), ['T1:VT', 'B1:VB', 'Master:MV']);
  for (const x of h.hops) {
    assert.equal(x.entry.vst?.raw_state, `state-of-${x.entry.id}`, `${x.entry.id} carries its own raw_state to the hop`);
    assert.equal(x.entry.vst?.state_host, 'thedaw', `${x.entry.id} carries the host that captured it`);
  }
}

/* ── 5. No printed insert: the bounce it always was ────────────────────────── */

async function withNoPrintedInsertTheBounceIsTheOneItWasBefore(): Promise<void> {
  const cases: { name: string; h: Harness; req: BounceRequest; master?: ChainEntry[] }[] = [
    {
      name: 'a rack-only project',
      h: harness({
        tracks: [track({ id: 't1', fxChain: [fx('A', 2, 1)] })],
        clips: [{ id: 'c1', trackId: 't1', value: 1 }],
        masterFxChain: [fx('MR', 3, 0)],
      }),
      req: request(),
    },
    {
      name: 'a bypassed plugin',
      h: harness({
        tracks: [track({ id: 't1', fxChain: [{ ...vst('V', 5, 5), enabled: false }] })],
        clips: [{ id: 'c1', trackId: 't1', value: 1 }],
      }),
      req: request(),
      master: [{ ...vst('MV', 5, 5), enabled: false }],
    },
    {
      name: 'a plugin entry with no plugin (a broken import)',
      h: harness({
        tracks: [track({ id: 't1', fxChain: [{ id: 'V', effect: 'vst3', enabled: true, params: {} }] })],
        clips: [{ id: 'c1', trackId: 't1', value: 1 }],
      }),
      req: request(),
    },
    {
      name: 'a plugin on a muted track',
      h: harness({
        tracks: [track({ id: 't1', mute: true, fxChain: [vst('V', 5, 5)] }), track({ id: 't2' })],
        clips: [{ id: 'c1', trackId: 't1', value: 1 }, { id: 'c2', trackId: 't2', value: 1 }],
      }),
      req: request(),
    },
    {
      name: 'a clip selection, which bounces no inserts at all',
      h: harness({
        tracks: [track({ id: 't1', fxChain: [vst('V', 5, 5)] })],
        clips: [{ id: 'c1', trackId: 't1', value: 1 }],
      }),
      req: request({ scope: { kind: 'selection', clipIds: ['c1'] }, includeFx: false, includeAutomation: false }),
      master: [vst('MV', 5, 5)],
    },
  ];
  for (const c of cases) {
    const calls: [BounceRequest, RenderDeps][] = [];
    let returned: AudioBuffer | null = null;
    const out = await print(c.h, c.req, {
      masterVstChain: c.master,
      render: async (r, d) => {
        calls.push([r, d]);
        returned = await renderBounce(r, d);
        return returned;
      },
    });
    assert.equal(c.h.hops.length, 0, `${c.name}: no plugin hop`);
    assert.equal(calls.length, 1, `${c.name}: one render`);
    assert.equal(calls[0][0], c.req, `${c.name}: the request as it was asked`);
    assert.equal(calls[0][1], c.h.deps, `${c.name}: the document as it was read, with no stage`);
    assert.equal(out.buffer, returned, `${c.name}: the rendered buffer itself, not a copy`);
    assert.equal(out.hops, 0);
  }
  // And the value is the one the plain bounce renders.
  const direct = harness({
    tracks: [track({ id: 't1', fxChain: [fx('A', 2, 1)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
    masterFxChain: [fx('MR', 3, 0)],
  });
  near((await renderBounce(request(), direct.deps)).getChannelData(0)[0], 9, 'the plain bounce: (2*1+1)*3');
}

/* ── 6. A range: the plugins hear the preroll, the file keeps the range ────── */

async function aRangeKeepsItsPrerollForThePluginsAndCutsAfter(): Promise<void> {
  const range: RenderRange = { startFrame: 5 * SR, endFrame: 10 * SR, prerollFrames: SR, tailFrames: 0 };
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [vst('VT', 2, 0, 500)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1, durationSec: 20 }],
  });
  const out = await print(h, request({ range }), { masterVstChain: [vst('MV', 1, 1, 700)] });
  assert.deepEqual(h.hops.map((x) => x.frames), [6 * SR, 6 * SR], 'every hop gets the preroll and the range: 6 s from 4 s');
  const printed = h.scheduled.find((s) => s.clip.id === 'insert-print:t1');
  assert.ok(printed, 'the mix plays the track print');
  assert.equal(printed.clip.startSec, 4, 'the print starts where its stage did, at the preroll');
  assert.equal(out.buffer.length, 5 * SR, 'the file is the range, whatever tail a host added past it');
  near(first(out), 3, '1 -> VT (2x) -> MV (x+1)');
}

/* ── 7. A whole-timeline bounce grows to hold a host's tail ────────────────── */

async function aHostTailWidensAWholeTimelineBounce(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [vst('VT', 1, 0, 500)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
  });
  const lengths: number[] = [];
  const out = await print(h, request(), {
    render: async (r, d) => { const b = await renderBounce(r, d); lengths.push(b.length); return b; },
  });
  assert.deepEqual(lengths, [30 * SR, 30 * SR + 500], 'the mix after the print renders the tail the host rang out');
  assert.equal(out.buffer.length, 30 * SR + 500);

  const dry = harness({
    tracks: [track({ id: 't1', fxChain: [vst('VT', 1, 0)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
  });
  const asked = request();
  const seen: BounceRequest[] = [];
  await print(dry, asked, { render: async (r, d) => { seen.push(r); return renderBounce(r, d); } });
  assert.ok(seen.every((r) => r === asked), 'a host that adds no tail leaves every stage at the length asked for');
}

/* ── 8. Latency: each tap lands on the timeline ────────────────────────────── */

async function eachTapLandsOnTheTimeline(): Promise<void> {
  // A compressor (6 ms) ahead of the plugin: the tap is trimmed by it.
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('cmp'), vst('VT', 1, 0)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
    mode: 'ramp',
  });
  await print(h, request());
  assert.equal(h.hops[0].first, 6, "the plugin hears the track trimmed by the 6 ms ahead of it");

  // A bus: t1 carries the compressor into b1, t2 is dry. t1 reaches the bus
  // 6 ms late, so the bus tap is trimmed by 6 ms, and in the mix the bus print
  // starts 6 ms late, to meet t2, whose comp holds the same 6 ms.
  const b = harness({
    tracks: [track({ id: 't1', fxChain: [compressor('cmp')] }), track({ id: 't2' })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }, { id: 'c2', trackId: 't2', value: 1 }],
    buses: [bus({ id: 'b1', fxChain: [vst('VB', 1, 0)] })],
    routing: graphWithOneBus(),
    mode: 'ramp',
  });
  await print(b, request());
  assert.equal(b.hops[0].first, 6, 'the bus plugin hears its input where the timeline has it');
  const busPrint = b.scheduled.find((s) => s.clip.id === 'insert-print:b1');
  assert.ok(busPrint, 'the mix plays the bus print');
  near(busPrint.clip.startSec, 0.006, 'the bus print starts as late as the slowest path, less its own');
}

/* ── 9. A cancel stops between stages ──────────────────────────────────────── */

async function aCancelStopsBetweenHops(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [vst('V1', 1, 0), fx('B', 1, 0), vst('V2', 1, 0)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
  });
  const out = await renderWithInserts(request(), h.deps, { hop: h.hop, isCancelled: () => h.hops.length > 0 });
  assert.equal(out, null, 'called off, the print hands back nothing');
  assert.equal(h.hops.length, 1, 'and runs no plugin after the call');
}

/* ── 10. Which nodes print, in which order ─────────────────────────────────── */

async function sitesAreUpstreamFirstAndOnlyWhereAudible(): Promise<void> {
  // b1 -> b2 -> master, listed downstream first.
  let g = graphWithOneBus();
  g = addBus(g, 'b2', 'B2');
  g = addBus(g, 'b3', 'B3');
  const res = setOutput(g, 'b1', 'b2');
  assert.ok(res.ok);
  const deps = {
    clips: harness({ tracks: [], clips: [{ id: 'c1', trackId: 't1', value: 1 }] }).deps.clips,
    tracks: [track({ id: 't1', fxChain: [vst('VT', 1, 0)] }), track({ id: 't2', fxChain: [vst('V2', 1, 0)] })],
    buses: [
      bus({ id: 'b2', fxChain: [vst('VB2', 1, 0)] }),
      bus({ id: 'b1', fxChain: [vst('VB1', 1, 0)] }),
      bus({ id: 'b3', mute: true, fxChain: [vst('VB3', 1, 0)] }),
      bus({ id: 'b4', fxChain: [vst('VB4', 1, 0)] }),
    ],
    routing: res.graph as RoutingGraph,
  };
  assert.deepEqual(
    printSites(request(), deps).map((s) => s.id),
    ['t1', 'b1', 'b2'],
    'a bus after every node that feeds it; t2 has no clip, b3 is muted and b4 is not in the graph, so none of them prints',
  );
  assert.deepEqual(
    printSites(request({ scope: { kind: 'track', trackId: 't1' }, includeTrackMix: false }), deps).map((s) => s.id),
    ['t1'],
    'a stem prints its own track and no bus',
  );
  assert.deepEqual(printSites(request({ includeFx: false }), deps), [], 'no inserts asked for, none printed');

  const split = splitAtInserts([fx('A', 1, 0), vst('V1', 1, 0), vst('V2', 1, 0), fx('B', 1, 0)]);
  assert.deepEqual(split.segments.map((s) => s.map((e) => e.id)), [['A'], [], ['B']]);
  assert.deepEqual(split.inserts.map((e) => e.id), ['V1', 'V2']);
}

/* ── 11. A stem: its plugins among its rack, in chain order ────────────────── */

async function aStemPrintsItsChainInOrder(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.25, fxChain: [vst('V1', 2, 0), fx('B', 1, 3)] })],
    clips: [{ id: 'c1', trackId: 't1', value: 1 }],
  });
  const out = await print(h, request({ scope: { kind: 'track', trackId: 't1' }, includeAutomation: false, includeTrackMix: false }));
  // No fader on a stem: 1 -> V1 (2x) = 2 -> B (x+3) = 5. Printed after the
  // rack, as the stem used to be, it would be (1+3)*2 = 8.
  near(first(out), 5, 'a stem runs its plugin where the chain has it');
  assert.deepEqual(h.hops.map((x) => x.entry.id), ['V1']);
}

async function main(): Promise<void> {
  await aTrackChainPrintsEveryPluginOnceInChainOrder();
  await aBusPrintsWhatItsTracksPrinted();
  await theMasterChainPrintsAfterTheMasterRack();
  await oneExportPrintsTrackBusAndMasterOnceEach();
  await withNoPrintedInsertTheBounceIsTheOneItWasBefore();
  await aRangeKeepsItsPrerollForThePluginsAndCutsAfter();
  await aHostTailWidensAWholeTimelineBounce();
  await eachTapLandsOnTheTimeline();
  await aCancelStopsBetweenHops();
  await sitesAreUpstreamFirstAndOnlyWhereAudible();
  await aStemPrintsItsChainInOrder();
  console.log('insertPrint: ok');
}

await main();
