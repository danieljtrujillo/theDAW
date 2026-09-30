// Every bounce EDIT offers prints the VST3 inserts its audio plays through live.
//
// Each case replays a path as the app runs it: the request the UI builds (the
// export dialog's plan, Send Selection to Init's request, the Render range
// dialog's mixdown), queued on the app's render queue and run by the app's own
// job runner (`runRenderJob`), through the real document reads, the real staged
// print (lib/render/insertPrint), the real offline graph (lib/renderCore) and
// the real plugin hop (`processFileThroughVst`). Only the edges are stood in
// for: the Web Audio contexts, and the backend's `/api/vst/process-file`.
//
// The stand-in offline context EVALUATES the graph it is handed: every node
// carries a steady value, a gain multiplies, a sum adds, anything else passes
// its input on. The stand-in backend applies the named plugin's own step
// (`x -> m*x + a`) to the WAV it is sent. So the file a path delivers holds the
// composition of every insert its clips play through, in order, or a
// different number.
//
// Before the fix, a clip selection (the export dialog's, and Send Selection
// to Init) rendered with no insert at all: no track plugin, no bus plugin and
// no master plugin. Those two cases fail on that code.
//
// Run: npx tsx src/components/audio/bouncePaths.inserts.test.ts
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { AudioClip, EditorBus, EditorTrack } from '../../state/editorStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { ImportRequest, LibraryEntry } from '../../state/libraryEntry.ts';
import { addBus, emptyGraph, ensureTrackNode, setOutput, type RoutingGraph } from '../../state/routingGraph.ts';
import { readWavSamples, writeFloatWav } from '../../lib/wavSamples.ts';

const SR = 44100;

/* ── The stand-in Web Audio ───────────────────────────────────────────────── */

type Param = (() => Param) & { value: number; defaultValue: number } & Record<string, unknown>;

const param = (v: number): Param => {
  const p = (() => p) as Param;
  p.value = v;
  p.defaultValue = v;
  for (const m of [
    'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime',
    'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime',
  ]) p[m] = () => p;
  return p;
};

interface Node {
  kind: string;
  outputs: unknown[];
  buffer: FakeBuffer | null;
  started: boolean;
  [key: string]: unknown;
}

interface FakeBuffer {
  length: number;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(ch: number): Float32Array;
}

const fakeBuffer = (channels: Float32Array[], sampleRate: number): FakeBuffer => ({
  length: channels[0]?.length ?? 0,
  duration: (channels[0]?.length ?? 0) / sampleRate,
  sampleRate,
  numberOfChannels: channels.length,
  getChannelData: (ch: number) => channels[ch],
});

/** A node with whatever a caller reaches for: an unknown property is an
 *  AudioParam-like value that can also be called as a method. */
const makeNode = (kind: string, ctx: unknown): Node => {
  const target: Node = {
    kind,
    outputs: [],
    buffer: null,
    started: false,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    onended: null,
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    context: ctx,
    connect(to: unknown) { target.outputs.push(to); return to; },
    disconnect() { target.outputs.length = 0; },
    start() { target.started = true; },
    stop() {},
    addEventListener() {},
    removeEventListener() {},
    port: { postMessage() {}, onmessage: null, start() {}, close() {} },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(t, prop);
      if (!(prop in t)) t[prop] = param(prop === 'delayTime' ? 0 : 1);
      return t[prop];
    },
  });
};

/** How a node treats the sum of its inputs. */
const stepOf = (n: Node): ((x: number) => number) => {
  if (n.kind === 'gain') return (x) => x * (n.gain as Param).value;
  return (x) => x;
};

class FakeOfflineContext {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly currentTime = 0;
  state = 'suspended';
  readonly created: Node[] = [];
  readonly destination: Node;
  readonly listener = param(0);
  readonly audioWorklet = { addModule: async () => {} };

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = makeNode('destination', this);
    return new Proxy(this, {
      get(t, prop, recv) {
        if (typeof prop === 'string' && prop.startsWith('create') && !(prop in t)) {
          const kind = prop.slice('create'.length).replace(/^./, (c) => c.toLowerCase());
          return () => t.make(kind === 'bufferSource' ? 'source' : kind);
        }
        return Reflect.get(t, prop, recv);
      },
    });
  }

  make(kind: string): Node {
    const n = makeNode(kind, this);
    this.created.push(n);
    return n;
  }

  createGain(): Node { return this.make('gain'); }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return fakeBuffer(Array.from({ length: channels }, () => new Float32Array(length)), sampleRate);
  }
  suspend(): Promise<void> { return Promise.resolve(); }
  resume(): Promise<void> { return Promise.resolve(); }
  addEventListener(): void {}
  removeEventListener(): void {}

  async startRendering(): Promise<FakeBuffer> {
    const inputs = new Map<unknown, Node[]>();
    for (const n of this.created) {
      for (const o of n.outputs) {
        const list = inputs.get(o) ?? [];
        list.push(n);
        inputs.set(o, list);
      }
    }
    const memo = new Map<Node, number>();
    const valueOf = (n: Node): number => {
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      memo.set(n, 0); // a feedback loop reads as silence rather than recursing
      const sum = n.kind === 'source'
        ? (n.started && n.buffer ? n.buffer.getChannelData(0)[0] : 0)
        : (inputs.get(n) ?? []).reduce((s, u) => s + valueOf(u), 0);
      const v = stepOf(n)(sum);
      memo.set(n, v);
      return v;
    };
    const out = valueOf(this.destination);
    return fakeBuffer(
      Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length).fill(out)),
      this.sampleRate,
    );
  }
}

class FakeDecodeContext {
  readonly sampleRate: number;
  constructor(opts: { sampleRate?: number } = {}) { this.sampleRate = opts.sampleRate ?? SR; }
  async decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    const s = readWavSamples(bytes);
    return fakeBuffer(s.channels, s.sampleRate);
  }
  async close(): Promise<void> {}
}

/* ── The stand-in backend ─────────────────────────────────────────────────── */

/** Each plugin's step, by the name the entry gives it. */
const PLUGINS: Record<string, { m: number; a: number }> = {
  V1: { m: 2, a: 0 },
  V2: { m: 3, a: 0 },
  VB: { m: 1, a: 0.1 },
  VB2: { m: 1, a: 0.2 },
  MV: { m: 0.5, a: 0 },
};

interface Hop { plugin: string; path: string; state: string | null }
const hops: Hop[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/api/vst/process-file') {
    const form = init?.body as FormData;
    const plugin = String(form.get('plugin_name'));
    hops.push({ plugin, path: String(form.get('plugin_path')), state: form.get('raw_state') as string | null });
    const step = PLUGINS[plugin];
    if (!step) {
      return new Response(JSON.stringify({ detail: `${plugin}.vst3 could not be loaded` }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    const s = readWavSamples(await (form.get('audio') as Blob).arrayBuffer());
    const channels = s.channels.map((ch) => ch.map((x) => step.m * x + step.a));
    return new Response(writeFloatWav({ sampleRate: s.sampleRate, channels, frames: s.frames }), {
      status: 200, headers: { 'Content-Type': 'audio/wav' },
    });
  }
  if (url === '/api/storage/pick-save') {
    return new Response(JSON.stringify({ path: null, cancelled: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const g = globalThis as unknown as Record<string, unknown>;
g.OfflineAudioContext = FakeOfflineContext;
g.AudioContext = FakeDecodeContext;

// Loaded after the stand-ins are in place.
const { runRenderJob, runExportPlanItem, selectionRequest, mixdownRequest } = await import('./WaveformEditor.tsx');
const { startRenderRunner, useRenderJobs } = await import('../../state/renderJobs.ts');
const { useEditorStore } = await import('../../state/editorStore.ts');
const { useLibraryStore } = await import('../../state/libraryStore.ts');
const { useGenerateParamsStore } = await import('../../state/generateParamsStore.ts');
const { buildRenderRequest, defaultExportState } = await import('../../lib/render/exportDialogModel.ts');
const { rangeFromSeconds } = await import('../../lib/render/renderRange.ts');

// A window on this machine's own address, as the app runs: a mixdown's Save As
// then asks the backend (stood in above, answering "cancelled").
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
for (const key of ['window', 'document']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}

/* ── The document ─────────────────────────────────────────────────────────── */

const vst = (id: string, name: string): ChainEntry => ({
  id,
  effect: 'vst3',
  enabled: true,
  params: {},
  label: name,
  vst: { plugin_path: `C:/Plugins/${name}.vst3`, plugin_name: name, raw_state: `state-of-${name}`, state_host: 'thedaw' },
});

const track = (id: string, fxChain: ChainEntry[]): EditorTrack => ({
  id, name: id.toUpperCase(), nameAutoGenerated: false, volume: 1, pan: 0, mute: false, solo: false, color: '#fff', fxChain,
});

const bus = (id: string, fxChain: ChainEntry[]): EditorBus => ({ id, name: id.toUpperCase(), fxChain, volume: 1, mute: false });

/** A clip that holds `value` in every sample. */
const clip = (id: string, trackId: string, value: number): AudioClip => {
  const frames = 3 * SR;
  const ch = new Float32Array(frames).fill(value);
  return {
    id, trackId, label: id, audioBlob: writeFloatWav({ sampleRate: SR, channels: [ch, ch], frames }),
    mimeType: 'audio/wav', sourceDuration: 3, offsetIntoSource: 0, durationSec: 2, startSec: 0, color: '#fff',
  };
};

/** t1 -> b1 -> master, t2 -> b2 -> master. */
function routing(): RoutingGraph {
  let graph = emptyGraph();
  graph = ensureTrackNode(graph, 't1', 'T1');
  graph = ensureTrackNode(graph, 't2', 'T2');
  graph = addBus(graph, 'b1', 'B1');
  graph = addBus(graph, 'b2', 'B2');
  for (const [from, to] of [['t1', 'b1'], ['t2', 'b2']]) {
    const res = setOutput(graph, from, to);
    assert.ok(res.ok);
    graph = res.graph as RoutingGraph;
  }
  return graph;
}

/** Opens the document: two tracks, each with its plugin, each into a bus
 *  with its plugin, and a plugin on the master. `t1Plugin` names t1's. */
const openDocument = (t1Plugin = 'V1'): void => {
  useEditorStore.setState({
    tracks: [track('t1', [vst('v1', t1Plugin)]), track('t2', [vst('v2', 'V2')])],
    clips: [clip('c1', 't1', 0.1), clip('c2', 't2', 0.05)],
    buses: [bus('b1', [vst('vb', 'VB')]), bus('b2', [vst('vb2', 'VB2')])],
    routing: routing(),
    masterFxChain: [],
    masterVstChain: [vst('mv', 'MV')],
    automationLanes: [],
  });
};

/* ── What each path hands over ────────────────────────────────────────────── */

const imported: ImportRequest[] = [];
useLibraryStore.setState({
  importEntry: async (req: ImportRequest) => { imported.push(req); return {} as LibraryEntry; },
});

const stopRunner = startRenderRunner({ run: runRenderJob });

const firstSample = async (blob: Blob): Promise<number> => readWavSamples(await blob.arrayBuffer()).channels[0][0];

const near = (actual: number, expected: number, what: string): void => {
  // 16-bit files hold a step of 1/32768.
  assert.ok(Math.abs(actual - expected) < 1e-3, `${what}: expected ${expected}, got ${actual}`);
};

const fresh = (): void => {
  hops.length = 0;
  imported.length = 0;
  useGenerateParamsStore.getState().patch({ initAudioFile: null, initAudioEnabled: false });
};

/** The one delivery an export-dialog item makes: its library import. */
const exported = async (): Promise<Blob> => {
  const deadline = Date.now() + 5000;
  while (imported.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(imported.length, 1, 'the export delivered one file to the library');
  return imported[0].blob;
};

const dialogItem = (over: Partial<ReturnType<typeof defaultExportState>>) => {
  const plan = buildRenderRequest({
    ...defaultExportState({ projectEndSec: 30, selectionSec: null, name: 'take' }),
    destination: 'library',
    ...over,
  });
  assert.equal(plan.rangeError, null);
  assert.equal(plan.items.length, 1);
  return plan.items[0];
};

/* ── 1. The export dialog: a clip selection ───────────────────────────────── */

async function theDialogsClipSelectionPrintsEveryInsertItPlaysThrough(): Promise<void> {
  openDocument();
  fresh();
  await runExportPlanItem(dialogItem({ what: { kind: 'clips', clipIds: ['c1'] } }));
  // c1 plays 0.1 -> V1 (2x) = 0.2 -> b1: VB (x+0.1) = 0.3 -> master: MV (0.5x) = 0.15.
  // Rendered dry, as it was, the file held 0.1.
  near(await firstSample(await exported()), 0.15, 'the file is c1 through its track, its bus and the master');
  assert.deepEqual(
    hops.map((h) => h.plugin), ['V1', 'VB', 'MV'],
    "t1's plugin, then b1's, then the master's: t2 and b2 hear nothing of c1, so theirs do not run",
  );
  assert.deepEqual(hops.map((h) => h.state), ['state-of-V1', 'state-of-VB', 'state-of-MV'], 'each at the state the user set');
}

/* ── 2. Send Selection to Init ────────────────────────────────────────────── */

async function sendSelectionToInitPrintsEveryInsertItPlaysThrough(): Promise<void> {
  openDocument();
  fresh();
  // What the clip menu's "Send Selection to Init" queues.
  const job = await useRenderJobs.getState().enqueueAndWait({
    kind: 'selection', label: 'Selection → Init', request: selectionRequest(['c2']),
  });
  assert.equal(job.status, 'done', `the job finished (${job.error ?? ''})`);
  const init = useGenerateParamsStore.getState().initAudioFile;
  assert.ok(init, 'MAKE holds the bounce as its init audio');
  // c2 plays 0.05 -> V2 (3x) = 0.15 -> b2: VB2 (x+0.2) = 0.35 -> MV (0.5x) = 0.175.
  near(await firstSample(init), 0.175, 'the init audio is c2 through its track, its bus and the master');
  assert.deepEqual(hops.map((h) => h.plugin), ['V2', 'VB2', 'MV']);
}

/* ── 3. A plugin that cannot load fails the bounce, naming it ─────────────── */

async function aPluginThatCannotLoadFailsTheBounceNamingIt(): Promise<void> {
  openDocument('Broken');
  fresh();
  const sent = await useRenderJobs.getState().enqueueAndWait({
    kind: 'selection', label: 'Selection → Init', request: selectionRequest(['c1']),
  });
  assert.equal(sent.status, 'failed', 'Send Selection to Init fails rather than sending the clip dry');
  assert.match(sent.error ?? '', /Broken on T1 could not be printed: Broken\.vst3 could not be loaded/);
  assert.equal(useGenerateParamsStore.getState().initAudioFile, null, 'and MAKE is handed nothing');

  fresh();
  await runExportPlanItem(dialogItem({ what: { kind: 'clips', clipIds: ['c1'] } }));
  const failed = useRenderJobs.getState().jobs.filter((j) => j.kind === 'export').at(-1);
  assert.equal(failed?.status, 'failed', 'the clip export fails too');
  assert.match(failed?.error ?? '', /Broken on T1 could not be printed/);
  assert.equal(imported.length, 0, 'and writes no file');
}

/* ── 4. The paths the branch already printed, replayed the same way ───────── */

async function theMixStemsAndRangesPrintTheirInserts(): Promise<void> {
  // The whole mix: t1 0.3 on b1, t2 0.35 on b2, 0.65 -> MV = 0.325.
  openDocument();
  fresh();
  await runExportPlanItem(dialogItem({ rangeMode: 'custom', customSec: { startSec: 0.5, endSec: 1.5 } }));
  near(await firstSample(await exported()), 0.325, 'a time range of the mix');
  assert.deepEqual(hops.map((h) => h.plugin).sort(), ['MV', 'V1', 'V2', 'VB', 'VB2']);
  assert.equal(hops.at(-1)?.plugin, 'MV', 'the master plugin runs last');

  // One file per track: t1's own chain, no bus and no master.
  fresh();
  await runExportPlanItem(dialogItem({ what: { kind: 'stems', trackIds: ['t1'] } }));
  near(await firstSample(await exported()), 0.2, "a stem is its track's chain alone");
  assert.deepEqual(hops.map((h) => h.plugin), ['V1']);

  // The timeline's Render range…: a mixdown with frame bounds.
  fresh();
  const range = rangeFromSeconds(0.5, 1.5);
  assert.ok(range);
  const job = await useRenderJobs.getState().enqueueAndWait({
    kind: 'mixdown', label: 'range.wav', request: { ...mixdownRequest(), range }, range,
  });
  assert.equal(job.status, 'done', `the range render finished (${job.error ?? ''})`);
  near(await firstSample(job.result?.blob as Blob), 0.325, 'Render range…');
  assert.equal(hops.length, 5);
}

async function main(): Promise<void> {
  try {
    await theDialogsClipSelectionPrintsEveryInsertItPlaysThrough();
    await sendSelectionToInitPrintsEveryInsertItPlaysThrough();
    await aPluginThatCannotLoadFailsTheBounceNamingIt();
    await theMixStemsAndRangesPrintTheirInserts();
  } finally {
    stopRunner();
    globalThis.fetch = realFetch;
  }
  console.log('bouncePaths.inserts: ok');
}

await main();
