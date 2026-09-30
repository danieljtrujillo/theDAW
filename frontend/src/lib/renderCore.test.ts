// renderCore — the shared offline bounce core (T11a).
//
// The three timeline renderers in WaveformEditor.tsx (`sendSelectionToInit`,
// `commitEdit`, `renderTrackStem`) were the same ~20-line graph three times
// over, differing only in fidelity. `lib/renderCore.ts` is that graph once,
// with the differences as flags. This suite is the pin: it drives the core
// through a stand-in OfflineAudioContext and asserts, per flag, exactly what
// today's three renderers put in the graph — including the three parts most
// easily lost in an extraction (the chop worklet registration, the spatializer
// teleport schedule, and the offline FX-automation stepping via suspend).
//
// The fake-context pattern is `state/liveMixer.schedule.test.ts`'s: a node that
// records connections, param calls and `start` arguments, and a context that
// hands them out. `scheduleSources` is the REAL `scheduleClipSources`, so the
// per-clip wiring under test is the shipped one.
import assert from 'node:assert/strict';
import { computeClipSchedule, scheduleClipSources } from '../state/liveMixer.ts';
import { clipPeakGain } from '../state/editorStore.ts';
import { applyFadeAutomation, type AudioParamLike } from './clipFade.ts';
import type { AudioClip, AutomationLane, EditorTrack } from '../state/editorStore.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';
import type { ChainHandle } from './rackEffects.ts';
import type { AudioChunk } from './audioAnalysis.ts';
import {
  BOUNCE_SAMPLE_RATE, clipsInScope, encodeBounce, renderBounce, renderExtentSec,
  type BounceRequest, type BounceScope, type RenderDeps,
} from './renderCore.ts';

/* ── Stand-ins ────────────────────────────────────────────────────────────── */

type ParamCall = [string, number, number];

interface FakeParam {
  value: number;
  calls: ParamCall[];
  /** `setValueCurveAtTime` carries a whole Float32Array, which does not fit the
   *  `[name, v, t]` tuple, so its values land here — while `calls` still gets a
   *  `['setValueCurveAtTime', start, duration]` entry, so a lane that mixes
   *  curved and straight segments is still ONE ordered list. */
  curves: { values: number[]; start: number; duration: number }[];
  setValueAtTime(v: number, t: number): FakeParam;
  linearRampToValueAtTime(v: number, t: number): FakeParam;
  setValueCurveAtTime(values: Float32Array, start: number, duration: number): FakeParam;
}

const fakeParam = (): FakeParam => {
  const calls: ParamCall[] = [];
  const curves: FakeParam['curves'] = [];
  const p: FakeParam = {
    value: 1,
    calls,
    curves,
    setValueAtTime(v, t) { calls.push(['setValueAtTime', v, t]); return p; },
    linearRampToValueAtTime(v, t) { calls.push(['linearRampToValueAtTime', v, t]); return p; },
    setValueCurveAtTime(values, start, duration) {
      calls.push(['setValueCurveAtTime', start, duration]);
      curves.push({ values: [...values], start, duration });
      return p;
    },
  };
  return p;
};

interface FakeNode {
  kind: string;
  gain: FakeParam;
  pan: FakeParam;
  playbackRate: { value: number };
  buffer: unknown;
  outputs: FakeNode[];
  disconnects: number;
  started: number[][];
  onended: (() => void) | null;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
  start(...args: number[]): void;
}

const fakeNode = (kind: string): FakeNode => {
  const node: FakeNode = {
    kind,
    gain: fakeParam(),
    pan: fakeParam(),
    playbackRate: { value: 1 },
    buffer: null,
    outputs: [],
    disconnects: 0,
    started: [],
    onended: null,
    connect(to: FakeNode) { node.outputs.push(to); return to; },
    disconnect() { node.disconnects += 1; },
    start(...args: number[]) { node.started.push(args); },
  };
  return node;
};

/** Enough of an AudioBuffer for `encodeWav` and for the schedule math. */
const fakeBuffer = (duration: number, sampleRate = BOUNCE_SAMPLE_RATE, channels = 2) => {
  const length = Math.round(duration * sampleRate);
  return {
    duration,
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: () => new Float32Array(length),
  };
};

interface FakeCtx {
  sampleRate: number;
  length: number;
  destination: FakeNode;
  created: FakeNode[];
  suspends: number[];
  resumes: number;
  createGain(): FakeNode;
  createStereoPanner(): FakeNode;
  createBufferSource(): FakeNode;
  suspend(t: number): Promise<void>;
  resume(): Promise<void>;
  startRendering(): Promise<unknown>;
}

const fakeCtx = (channels: number, length: number, sampleRate: number): FakeCtx => {
  const created: FakeNode[] = [];
  const ctx: FakeCtx = {
    sampleRate,
    length,
    destination: fakeNode('destination'),
    created,
    suspends: [],
    resumes: 0,
    createGain() { const n = fakeNode('gain'); created.push(n); return n; },
    createStereoPanner() { const n = fakeNode('panner'); created.push(n); return n; },
    createBufferSource() { const n = fakeNode('source'); created.push(n); return n; },
    suspend(t: number) { ctx.suspends.push(t); return Promise.resolve(); },
    resume() { ctx.resumes += 1; return Promise.resolve(); },
    async startRendering() {
      // Let the suspend callbacks the core registered run, as a real offline
      // render would when it reaches each suspend point.
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      return fakeBuffer(length / sampleRate, sampleRate, channels);
    },
  };
  return ctx;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

let nextBlob = 0;
const clip = (over: Partial<AudioClip> & { id: string; trackId: string }): AudioClip => ({
  label: over.id,
  audioBlob: new Blob([`${nextBlob++}`]),
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#fff',
  ...over,
});

const track = (over: Partial<EditorTrack> & { id: string }): EditorTrack => ({
  name: over.id,
  nameAutoGenerated: false,
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  color: '#fff',
  ...over,
});

const entry = (over: Partial<ChainEntry> & { id: string; effect: string }): ChainEntry => ({
  params: {},
  enabled: true,
  ...over,
});

interface ChainCall {
  input: FakeNode;
  output: FakeNode;
  entries: ChainEntry[];
  updates: { entryId: string; params: Record<string, number> }[];
  disposed: number;
}

interface TeleportSpy {
  events: { when: number; x: number; y: number; z: number }[][];
}

/** A `buildEffectChain` stand-in: records the call, wires input straight to
 *  output (what the real one does for a chain with nothing renderable in it),
 *  and exposes whatever instances the test asks for. */
const buildChainSpy = (teleport?: { entryId: string; spy: TeleportSpy }) => {
  const calls: ChainCall[] = [];
  const build = (
    _ctx: unknown, input: unknown, output: unknown, entries: ChainEntry[],
  ): ChainHandle => {
    const call: ChainCall = {
      input: input as FakeNode,
      output: output as FakeNode,
      entries,
      updates: [],
      disposed: 0,
    };
    calls.push(call);
    (input as FakeNode).connect(output as FakeNode);
    return {
      rebuild: () => {},
      updateParams: (entryId, params) => { call.updates.push({ entryId, params }); },
      instances: () => (teleport && entries.some((e) => e.id === teleport.entryId)
        ? [{
            id: teleport.entryId,
            effect: 'spatializer',
            inst: {
              input: null as never,
              output: null as never,
              setParams: () => {},
              dispose: () => {},
              scheduleTeleport: (events: { when: number; x: number; y: number; z: number }[]) => {
                teleport.spy.events.push(events);
              },
            },
          }]
        : []),
      inertIds: () => [],
      dispose: () => { call.disposed += 1; },
    } as unknown as ChainHandle;
  };
  return { calls, build: build as unknown as RenderDeps['buildChain'] };
};

interface Harness {
  ctxes: FakeCtx[];
  decoded: Blob[];
  chop: number;
  deps: RenderDeps;
  chain: { calls: ChainCall[] };
}

const harness = (
  over: Partial<Pick<RenderDeps, 'clips' | 'tracks' | 'masterFxChain' | 'automationLanes'>> & {
    bufferDurationSec?: number;
    chunks?: AudioChunk[];
    teleport?: { entryId: string; spy: TeleportSpy };
  } = {},
): Harness => {
  const ctxes: FakeCtx[] = [];
  const decoded: Blob[] = [];
  const chain = buildChainSpy(over.teleport);
  const h: Harness = {
    ctxes,
    decoded,
    chop: 0,
    chain,
    deps: {
      clips: over.clips ?? [],
      tracks: over.tracks ?? [],
      masterFxChain: over.masterFxChain ?? [],
      automationLanes: over.automationLanes ?? [],
      decode: async (_ctx, blob) => {
        decoded.push(blob);
        return fakeBuffer(over.bufferDurationSec ?? 10) as unknown as AudioBuffer;
      },
      buildChain: chain.build,
      scheduleSources: scheduleClipSources,
      makeContext: (channels, length, rate) => {
        const c = fakeCtx(channels, length, rate);
        ctxes.push(c);
        return c as unknown as OfflineAudioContext;
      },
      makeDecodeContext: () => ({ close: async () => {} }) as unknown as BaseAudioContext & {
        close(): Promise<void>;
      },
      ensureChop: async () => { h.chop += 1; },
      sliceChunks: () => over.chunks ?? [],
    },
  };
  return h;
};

const request = (scope: BounceScope, over: Partial<BounceRequest> = {}): BounceRequest => ({
  scope,
  sampleRate: BOUNCE_SAMPLE_RATE,
  includeFx: true,
  includeAutomation: true,
  includeTrackMix: true,
  float32: false,
  ...over,
});

const kinds = (ctx: FakeCtx): string[] => ctx.created.map((n) => n.kind);

/* ── 1. Extent math ───────────────────────────────────────────────────────── */

function extentMath(): void {
  const clips = [
    clip({ id: 'c1', trackId: 't1', startSec: 0, durationSec: 2 }),
    clip({ id: 'c2', trackId: 't2', startSec: 3, durationSec: 4.5 }),
  ];

  // The three renderers do NOT agree: each has its own floor, and the master
  // bounce's floor is 30 s (editorStore.getTotalDurationSec), not the extent.
  assert.equal(renderExtentSec(clips, { kind: 'master' }), 30, 'master: max(extent, 30)');
  assert.equal(
    renderExtentSec(clips, { kind: 'selection', clipIds: ['c2'] }), 7.5,
    'selection: max(extent, 1) — the extent wins here',
  );
  assert.equal(
    renderExtentSec(clips, { kind: 'selection', clipIds: ['c1'] }), 2,
    'selection: still the extent when it is above the 1 s floor',
  );
  assert.equal(
    renderExtentSec([clip({ id: 'c3', trackId: 't1', durationSec: 0.4 })], { kind: 'selection', clipIds: ['c3'] }),
    1, 'selection: the 1 s floor lifts a short selection',
  );
  assert.equal(renderExtentSec(clips, { kind: 'track', trackId: 't2' }), 7.5, 'track: the track extent');
  assert.equal(
    renderExtentSec([clip({ id: 'c4', trackId: 't1', durationSec: 0.05 })], { kind: 'track', trackId: 't1' }),
    0.1, 'track: max(extent, 0.1)',
  );

  // Empty timeline: the master bounce shows 60 s, the other two fall to their floors.
  assert.equal(renderExtentSec([], { kind: 'master' }), 60, 'master: an empty timeline is 60 s');
  assert.equal(renderExtentSec([], { kind: 'selection', clipIds: [] }), 1);
  assert.equal(renderExtentSec([], { kind: 'track', trackId: 't1' }), 0.1);

  // The scope resolves the clip set the same way the three call sites do.
  assert.deepEqual(clipsInScope(clips, { kind: 'master' }).map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(clipsInScope(clips, { kind: 'track', trackId: 't1' }).map((c) => c.id), ['c1']);
  assert.deepEqual(
    clipsInScope(clips, { kind: 'selection', clipIds: ['c2', 'c1'] }).map((c) => c.id), ['c1', 'c2'],
    'selection keeps timeline order, not the order the ids were given in',
  );
}

/* ── 2. The full-fidelity graph (today's commitEdit) ──────────────────────── */

async function fullFidelityGraph(): Promise<void> {
  const chop = entry({ id: 'e-chop', effect: 'chop' });
  const h = harness({
    tracks: [
      track({ id: 'tA', volume: 0.5, pan: -0.25, fxChain: [chop] }),
      track({ id: 'tB', mute: true }),
    ],
    clips: [
      clip({ id: 'c1', trackId: 'tA', startSec: 1, durationSec: 2 }),
      clip({ id: 'c2', trackId: 'tB' }),
      clip({ id: 'c3', trackId: 'tA', muted: true }),
    ],
    masterFxChain: [entry({ id: 'm1', effect: 'reverb' })],
  });

  const out = await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];

  assert.equal(h.ctxes.length, 1, 'one offline context');
  assert.equal(ctx.length, Math.ceil(30 * BOUNCE_SAMPLE_RATE), 'sized from the master extent');
  assert.equal(ctx.sampleRate, BOUNCE_SAMPLE_RATE);
  assert.equal((out as unknown as { duration: number }).duration, 30);

  // Every clip in scope is decoded, muted ones included — a muted clip that
  // fails to decode fails the whole bounce, as it does today.
  assert.equal(h.decoded.length, 3, 'all three clips decode, the muted one too');

  assert.equal(h.chop, 1, 'an enabled chop entry registers the worklet on the offline context');

  // Master bus, then the audible track's gain + panner, then the one audible
  // clip's envelope + gate + source. The muted track builds nothing.
  assert.deepEqual(kinds(ctx), ['gain', 'gain', 'panner', 'gain', 'gain', 'source']);
  const [masterBus, tGain, tPan, clipGain, muteGate, src] = ctx.created;

  assert.equal(tGain.gain.value, 0.5, 'track volume lands on the track gain');
  assert.equal(tPan.pan.value, -0.25, 'track pan lands on the panner');
  assert.deepEqual(tPan.outputs, [masterBus], 'the panner feeds the master bus');
  assert.deepEqual(clipGain.outputs, [muteGate]);
  assert.deepEqual(muteGate.outputs, [tGain], 'the clip lands on the track gain');
  assert.deepEqual(src.started, [[1, 0, 2]], 'the source starts at the clip head');

  // Two chains: the master rack and the one audible track's rack.
  assert.equal(h.chain.calls.length, 2, 'the muted track builds no chain');
  const [master, trackChain] = h.chain.calls;
  assert.equal(master.input, masterBus);
  assert.equal(master.output, ctx.destination, 'the master rack feeds the destination');
  assert.deepEqual(master.entries.map((e) => e.id), ['m1']);
  assert.equal(trackChain.input, tGain);
  assert.equal(trackChain.output, tPan, 'the track rack sits between the fader and the panner');
  assert.deepEqual(trackChain.entries.map((e) => e.id), ['e-chop']);

  assert.deepEqual([master.disposed, trackChain.disposed], [1, 1], 'every chain is disposed after the render');
}

/* ── 3. Solo, mute, and the selection scope's blind spot ──────────────────── */

async function trackGating(): Promise<void> {
  const tracks = [
    track({ id: 'tSolo', solo: true }),
    track({ id: 'tQuiet' }),
    track({ id: 'tMuted', mute: true }),
  ];
  const clips = [
    clip({ id: 'cS', trackId: 'tSolo' }),
    clip({ id: 'cQ', trackId: 'tQuiet' }),
    clip({ id: 'cM', trackId: 'tMuted' }),
  ];

  const master = harness({ tracks, clips });
  await renderBounce(request({ kind: 'master' }, { includeFx: false }), master.deps);
  assert.deepEqual(
    kinds(master.ctxes[0]), ['gain', 'gain', 'panner', 'gain', 'gain', 'source'],
    'master scope: solo silences the un-soloed tracks, mute silences the muted one',
  );

  // The selection bounce (sendSelectionToInit) checks `track.mute` and NOTHING
  // else — an active solo elsewhere does not narrow it. Pinned, not fixed.
  const sel = harness({ tracks, clips });
  await renderBounce(
    request({ kind: 'selection', clipIds: ['cS', 'cQ', 'cM'] }, { includeFx: false, includeAutomation: false }),
    sel.deps,
  );
  assert.deepEqual(
    kinds(sel.ctxes[0]),
    ['gain', 'gain', 'panner', 'gain', 'gain', 'source', 'gain', 'panner', 'gain', 'gain', 'source'],
    'selection scope: two audible clips (solo ignored), the muted track\'s clip dropped',
  );
}

/* ── 3b. Where the pan law sits: per CLIP, or per TRACK ───────────────────── */

async function panPerClipForSelectionPerTrackForMaster(): Promise<void> {
  const tracks = [track({ id: 't1', volume: 0.75, pan: -0.5 })];
  const clips = [
    clip({ id: 'c1', trackId: 't1', startSec: 0, durationSec: 2 }),
    clip({ id: 'c2', trackId: 't1', startSec: 4, durationSec: 2 }),
  ];

  // The selection bounce gave every clip its own gain + panner. That is not a
  // cosmetic difference: a MONO clip sharing a track gain with a stereo one is
  // up-mixed to stereo before a shared panner and so hits the stereo pan law
  // instead of the mono one (~+3 dB at centre).
  const sel = harness({ tracks, clips });
  await renderBounce(
    request({ kind: 'selection', clipIds: ['c1', 'c2'] }, { includeFx: false, includeAutomation: false }),
    sel.deps,
  );
  const selCtx = sel.ctxes[0];
  const selPanners = selCtx.created.filter((n) => n.kind === 'panner');
  assert.equal(selPanners.length, 2, 'selection scope: one panner per clip');
  const selMixes = selCtx.created.filter((n, i) => n.kind === 'gain' && selCtx.created[i + 1]?.kind === 'panner');
  assert.deepEqual(selMixes.map((n) => n.gain.value), [0.75, 0.75], 'each clip carries the track volume');
  assert.deepEqual(selPanners.map((n) => n.pan.value), [-0.5, -0.5]);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(selMixes[i].outputs, [selPanners[i]], 'clip mix gain feeds its OWN panner');
    assert.deepEqual(selPanners[i].outputs, [selCtx.created[0]], 'which feeds the master bus');
  }

  // The master bounce has always summed the track first and panned once.
  const mst = harness({ tracks, clips });
  await renderBounce(request({ kind: 'master' }, { includeFx: false, includeAutomation: false }), mst.deps);
  const mstCtx = mst.ctxes[0];
  assert.equal(
    mstCtx.created.filter((n) => n.kind === 'panner').length, 1,
    'master scope: one panner per track, however many clips it holds',
  );
  assert.deepEqual(
    kinds(mstCtx), ['gain', 'gain', 'panner', 'gain', 'gain', 'source', 'gain', 'gain', 'source'],
    'both clips land on the one track fader',
  );
}

/* ── 4. includeFx = false never touches buildEffectChain ──────────────────── */

async function noFxNeverBuildsAChain(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.25, pan: 1.5, fxChain: [entry({ id: 'e1', effect: 'chop' })] })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    masterFxChain: [entry({ id: 'm1', effect: 'reverb' })],
  });

  await renderBounce(
    request({ kind: 'selection', clipIds: ['c1'] }, { includeFx: false, includeAutomation: false }),
    h.deps,
  );

  assert.equal(h.chain.calls.length, 0, 'no rack is built when includeFx is false');
  assert.equal(h.chop, 0, 'and the chop worklet is not registered either');

  const ctx = h.ctxes[0];
  const [masterBus, mixGain, panner] = ctx.created;
  assert.deepEqual(masterBus.outputs, [ctx.destination], 'the bus wires straight to the destination');
  assert.deepEqual(mixGain.outputs, [panner], 'the fader wires straight to the panner');
  assert.deepEqual(panner.outputs, [masterBus]);
  assert.equal(mixGain.gain.value, 0.25, 'track volume still applies');
  assert.equal(panner.pan.value, 1, 'pan is clamped to +/-1');
}

/* ── 4b. The fade envelope, and where the track volume is NOT ─────────────── */

/** An AudioParam that only records, as `liveMixer.schedule.test.ts` uses. Its
 *  method set MUST match `fakeParam`'s: `applyEnvelopeEvents` and
 *  `applyFadeAutomation` both branch on whether `setValueCurveAtTime` exists,
 *  so a recorder missing it would record a different (degraded) call list than
 *  the graph under test and the comparison would pass for the wrong reason. */
const recorder = (): AudioParamLike & { calls: ParamCall[] } => {
  const calls: ParamCall[] = [];
  return {
    calls,
    setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); return this; },
    linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); return this; },
    setValueCurveAtTime(_values: Float32Array, start: number, duration: number) {
      calls.push(['setValueCurveAtTime', start, duration]);
      return this;
    },
  };
};

async function fadeEnvelopeAndClipGain(): Promise<void> {
  // The riskiest numeric claim in the extraction: `sendSelectionToInit` used to
  // fold the track volume INTO the fade-envelope peak
  // (`peak = track.volume * clipPeakGain(clip)`), and the core does not — the
  // envelope peaks at the clip's own gain and the volume is a node of its own.
  // The product is the same because `peak` is a pure linear scalar on every
  // branch of lib/clipFade; what must be pinned is that the envelope itself is
  // still the one lib/clipFade writes, at the clip's gain and no more.
  const c = clip({
    id: 'c1', trackId: 't1', startSec: 1, durationSec: 2,
    gain: 0.25, fadeInSec: 0.5, fadeOutSec: 0.5,
  });
  const expected = recorder();
  const schedule = computeClipSchedule(c, 10);
  assert.ok(schedule);
  applyFadeAutomation(expected, c, c.startSec, 0, {
    peak: clipPeakGain(c), effectiveDurationSec: schedule.durationSec,
  });
  assert.equal(clipPeakGain(c), 0.25);

  const scopes: BounceScope[] = [{ kind: 'selection', clipIds: ['c1'] }, { kind: 'master' }];
  for (const scope of scopes) {
    const h = harness({ tracks: [track({ id: 't1', volume: 0.4 })], clips: [c] });
    await renderBounce(request(scope, { includeFx: false, includeAutomation: false }), h.deps);
    const ctx = h.ctxes[0];
    const mixGain = ctx.created[1];
    const clipGain = ctx.created[3];
    assert.equal(mixGain.gain.value, 0.4, `${scope.kind}: the track volume is on its own node`);
    assert.deepEqual(
      clipGain.gain.calls, expected.calls,
      `${scope.kind}: the envelope is exactly lib/clipFade's, peaking at the CLIP gain`,
    );
    // Only the `set` / `ramp` tuples carry a VALUE in slot 1; a
    // `setValueCurveAtTime` tuple carries its START TIME there, and reading
    // that as a value would compare the wrong number. Its samples live in
    // `curves` and are checked on their own.
    assert.ok(
      clipGain.gain.calls
        .filter(([name]) => name !== 'setValueCurveAtTime')
        .every(([, v]) => v === 0 || v === 0.25),
      `${scope.kind}: 0.4 * 0.25 never appears — the volume is not folded into the peak`,
    );
    assert.ok(
      clipGain.gain.curves.every((c) => c.values.every((v) => v >= 0 && v <= 0.25)),
      `${scope.kind}: nor inside a curved fade's samples`,
    );
  }
}

async function aWarpedClipGetsOneSourcePerSegment(): Promise<void> {
  const warped = clip({
    id: 'c1', trackId: 't1', startSec: 10, offsetIntoSource: 5, durationSec: 4, fadeOutSec: 1,
    warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }],
  });
  const h = harness({
    tracks: [track({ id: 't1' })], clips: [warped], bufferDurationSec: 20,
  });
  await renderBounce(request({ kind: 'master' }, { includeFx: false, includeAutomation: false }), h.deps);

  const ctx = h.ctxes[0];
  assert.deepEqual(
    kinds(ctx), ['gain', 'gain', 'panner', 'gain', 'gain', 'source', 'source'],
    'two warp segments share one envelope gain and one gate',
  );
  const [, , , clipGain, , s0, s1] = ctx.created;
  assert.deepEqual(s0.started, [[10, 5, 2]], 'segment 1 starts at the clip head');
  assert.equal(s0.playbackRate.value, 2, 'at its own rate');
  assert.deepEqual(s1.started, [[11, 7, 2]], 'segment 2 one second later');
  assert.deepEqual([s0.outputs, s1.outputs], [[clipGain], [clipGain]], 'both feed the one envelope');
}

/* ── 5. Track scope: no mix, no master bus rack, no hosted VSTs ───────────── */

async function trackScope(): Promise<void> {
  const fxChain = [
    entry({ id: 'e1', effect: 'chop' }),
    entry({ id: 'e-vst', effect: 'vst3' }),
    entry({ id: 'e2', effect: 'reverb' }),
  ];
  const h = harness({
    // Muted AND un-soloed, and it renders anyway: a track stem is the track's
    // own audio, not what the master bus would hear.
    tracks: [track({ id: 't1', mute: true, volume: 0.5, pan: -1, fxChain }), track({ id: 't2', solo: true })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 3 }), clip({ id: 'c2', trackId: 't2' })],
    masterFxChain: [entry({ id: 'm1', effect: 'reverb' })],
  });

  await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeAutomation: false, includeTrackMix: false }),
    h.deps,
  );

  const ctx = h.ctxes[0];
  assert.equal(ctx.length, Math.ceil(3 * BOUNCE_SAMPLE_RATE), 'sized from the track extent');
  assert.equal(h.decoded.length, 1, 'only the track\'s own clips decode');
  assert.deepEqual(kinds(ctx), ['gain', 'gain', 'gain', 'gain', 'source'], 'no panner is created');

  assert.equal(h.chain.calls.length, 1, 'the master rack is not built for a track stem');
  const [only] = h.chain.calls;
  assert.deepEqual(
    only.entries.map((e) => e.id), ['e1', 'e2'],
    'hosted VST3 entries are stripped — they print on the backend afterwards',
  );
  const [masterBus, tGain] = ctx.created;
  assert.equal(only.input, tGain);
  assert.equal(only.output, masterBus, 'with no panner the rack feeds the bus, which feeds the destination');
  assert.deepEqual(masterBus.outputs, [ctx.destination]);
  assert.equal(tGain.gain.value, 1, 'includeTrackMix = false leaves the fader at unity');
  assert.equal(h.chop, 1, 'the chop worklet is still registered from the surviving rack chain');
}

/* ── 6. Automation: native params, and the offline FX stepping ────────────── */

/** `commitEdit`'s quantiser, transcribed: FX breakpoints are stepped on render
 *  quantum boundaries because `suspend` can only stop the render there. */
const quantise = (t: number, sampleRate: number): number => {
  const q = 128 / sampleRate;
  return Math.ceil(t / q) * q;
};

async function automationReachesTheGraph(): Promise<void> {
  const fxEntry = entry({ id: 'e1', effect: 'chop', params: { mix: 0.1, rate: 4 } });
  const lanes: AutomationLane[] = [
    {
      id: 'l-vol', enabled: true, target: { kind: 'trackVolume', trackId: 't1' },
      points: [{ t: 0, v: 0.2 }, { t: 1, v: 0.9 }],
    },
    {
      id: 'l-pan', enabled: true, target: { kind: 'trackPan', trackId: 't1' },
      points: [{ t: 0.5, v: -2 }, { t: 1.5, v: 2 }],
    },
    {
      id: 'l-fx', enabled: true, target: { kind: 'trackFx', trackId: 't1', entryId: 'e1', paramKey: 'mix' },
      points: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
    },
    { id: 'l-off', enabled: false, target: { kind: 'trackVolume', trackId: 't1' }, points: [{ t: 0, v: 0 }] },
  ];
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5, pan: 0.5, fxChain: [fxEntry] })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: lanes,
  });

  await renderBounce(request({ kind: 'master' }), h.deps);
  const ctx = h.ctxes[0];
  const [, tGain, tPan] = ctx.created;

  assert.deepEqual(
    tGain.gain.calls,
    [['setValueAtTime', 0.2, 0], ['linearRampToValueAtTime', 0.9, 1]],
    'a volume lane rides an AudioParam timeline instead of the static fader value',
  );
  assert.equal(tGain.gain.value, 1, 'and the static value is left alone');
  assert.deepEqual(
    tPan.pan.calls,
    [
      ['setValueAtTime', -1, 0],
      ['linearRampToValueAtTime', -1, 0.5],
      ['linearRampToValueAtTime', 1, 1.5],
    ],
    // The hold is a FLAT RAMP rather than a second `setValueAtTime` — that is
    // what `laneEnvelopeEvents` emits, and -1 ramped to -1 is the same audio as
    // -1 held. Every other literal is the hand-written loop's, unchanged.
    'a pan lane holds its first value to its first breakpoint, clamped to +/-1',
  );
  assert.deepEqual(tPan.pan.curves, [], 'a lane with no curves schedules no value curve');

  // The FX lane cannot ride an AudioParam (rack params are plain numbers), so
  // the render is suspended on each breakpoint's quantum and the params pushed.
  const t1 = quantise(1, BOUNCE_SAMPLE_RATE);
  assert.deepEqual(ctx.suspends, [t1], 'one suspend, at the quantised breakpoint (t = 0 is applied up front)');
  assert.equal(ctx.resumes, 1, 'and the render is resumed again');

  const trackChain = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'e1'));
  assert.ok(trackChain);
  assert.deepEqual(
    trackChain.updates,
    [
      { entryId: 'e1', params: { mix: 0, rate: 4 } },
      { entryId: 'e1', params: { mix: 1, rate: 4 } },
    ],
    'the lane value is merged over the entry\'s own params at t = 0 and at the step',
  );
}

async function aCurvedLaneBouncesAsACurve(): Promise<void> {
  // The regression this pins: the hand-written loop that used to live in
  // `scheduleParamLane` emitted one linear ramp per breakpoint, so a CURVED
  // segment exported as a straight line — the bounce did not sound like the
  // preview. Measured at 0.163 peak / 1.3e-2 RMS on a real render before the
  // fix. The lane now goes through `liveMixer.laneEnvelopeEvents`, which
  // rasterises a curved segment into `setValueCurveAtTime`.
  const lanes: AutomationLane[] = [
    {
      id: 'l-vol', enabled: true, target: { kind: 'trackVolume', trackId: 't1' },
      points: [{ t: 0, v: 0.2, curve: 0.7 }, { t: 1, v: 0.9 }],
    },
    {
      // Curved AND out of range, so the clamp is proven to reach INSIDE the
      // rasterised values rather than only the `set` / `ramp` endpoints.
      id: 'l-pan', enabled: true, target: { kind: 'trackPan', trackId: 't1' },
      points: [{ t: 0, v: -3, curve: -0.6 }, { t: 2, v: 3 }],
    },
  ];
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5, pan: 0.5 })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
    automationLanes: lanes,
  });

  await renderBounce(request({ kind: 'master' }, { includeFx: false }), h.deps);
  const [, tGain, tPan] = h.ctxes[0].created;

  assert.deepEqual(
    tGain.gain.calls,
    [['setValueAtTime', 0.2, 0], ['setValueCurveAtTime', 0, 1]],
    'a curved volume segment is one value curve over the segment, not a ramp',
  );
  assert.equal(tGain.gain.curves.length, 1);
  const vol = tGain.gain.curves[0];
  // The values ride a Float32Array, so the endpoints are compared to float32
  // precision rather than exactly — 0.9 stored as a float32 reads back as
  // 0.89999997.
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  assert.ok(vol.values.length >= 2, 'a value curve needs at least two samples');
  assert.ok(near(vol.values[0], 0.2), 'the curve starts at the left breakpoint');
  assert.ok(near(vol.values[vol.values.length - 1], 0.9), 'and ends exactly on the right one');
  assert.ok(
    vol.values.some((v, i) => {
      const u = i / (vol.values.length - 1);
      return Math.abs(v - (0.2 + 0.7 * u)) > 1e-3;
    }),
    'and it is not the straight line the old loop drew',
  );

  assert.deepEqual(
    tPan.pan.calls,
    [['setValueAtTime', -1, 0], ['setValueCurveAtTime', 0, 2]],
    'a curved pan segment likewise',
  );
  const pan = tPan.pan.curves[0];
  assert.ok(near(pan.values[0], -1), 'clamped at the start');
  assert.ok(near(pan.values[pan.values.length - 1], 1), 'clamped at the end');
  assert.ok(
    pan.values.every((v) => v >= -1 && v <= 1),
    'and every sample BETWEEN them is clamped too — the clamp reaches inside the curve',
  );
}

async function masterFxAutomationAndTheEndClamp(): Promise<void> {
  // The `masterFx` half of the lane grouping: a master rack entry's lanes are
  // matched by entryId alone (there is no trackId on a master lane).
  const masterEntry = entry({ id: 'm1', effect: 'reverb', params: { mix: 0.3, decay: 2 } });
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    masterFxChain: [masterEntry, entry({ id: 'm2', effect: 'chop', enabled: false })],
    automationLanes: [
      {
        id: 'l-master', enabled: true,
        target: { kind: 'masterFx', entryId: 'm1', paramKey: 'mix' },
        points: [{ t: 0, v: 0 }, { t: 20, v: 1 }, { t: 29.999, v: 1 }],
      },
      {
        // A lane on a DISABLED entry is never grouped, so it schedules nothing.
        id: 'l-off-entry', enabled: true,
        target: { kind: 'masterFx', entryId: 'm2', paramKey: 'mix' },
        points: [{ t: 5, v: 1 }],
      },
    ],
  });

  await renderBounce(request({ kind: 'master' }), h.deps);

  // The master extent floor is 30 s, and the last render quantum cannot be
  // suspended in, so a breakpoint that quantises to (or past) the end is pulled
  // back to `lengthSec - q`.
  const q = 128 / BOUNCE_SAMPLE_RATE;
  assert.deepEqual(
    h.ctxes[0].suspends,
    [quantise(20, BOUNCE_SAMPLE_RATE), Math.min(30 - q, quantise(29.999, BOUNCE_SAMPLE_RATE))],
    'both breakpoints step, and the last is clamped to one quantum before the end',
  );
  assert.ok(
    h.ctxes[0].suspends[1] < 30 && h.ctxes[0].suspends[1] < quantise(29.999, BOUNCE_SAMPLE_RATE),
    'the clamp actually moved it — its own quantum lands at or past the end',
  );
  assert.equal(h.ctxes[0].resumes, 2);

  const master = h.chain.calls.find((c) => c.entries.some((e) => e.id === 'm1'));
  assert.ok(master);
  assert.equal(master.output, h.ctxes[0].destination, 'it is the master rack, not a track one');
  assert.deepEqual(
    master.updates,
    [
      { entryId: 'm1', params: { mix: 0, decay: 2 } },
      { entryId: 'm1', params: { mix: 1, decay: 2 } },
      { entryId: 'm1', params: { mix: 1, decay: 2 } },
    ],
    'a master lane is grouped by entryId alone and merged over the entry params',
  );
  assert.ok(
    master.updates.every((u) => u.entryId === 'm1'),
    'the lane on the bypassed entry m2 is never applied',
  );
}

async function automationOffSchedulesNothing(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1', volume: 0.5, fxChain: [entry({ id: 'e1', effect: 'chop' })] })],
    clips: [clip({ id: 'c1', trackId: 't1' })],
    automationLanes: [{
      id: 'l', enabled: true, target: { kind: 'trackVolume', trackId: 't1' }, points: [{ t: 0, v: 0.1 }],
    }],
  });
  await renderBounce(request({ kind: 'master' }, { includeAutomation: false }), h.deps);
  const ctx = h.ctxes[0];
  assert.deepEqual(ctx.created[1].gain.calls, [], 'no lane is scheduled');
  assert.equal(ctx.created[1].gain.value, 0.5, 'the static fader value stands');
  assert.deepEqual(ctx.suspends, [], 'and the render is never suspended');
}

/* ── 7. Spatializer teleport ──────────────────────────────────────────────── */

async function teleportBakes(): Promise<void> {
  const spy: TeleportSpy = { events: [] };
  const tele = entry({ id: 'e-tele', effect: 'spatializer', params: { motion: 10, motionDepth: 5 } });
  const chunks: AudioChunk[] = [
    { tSec: 0.25, durSec: 0.25, loudness: 0.8, brightness: 0.5, salience: 0.5 },
    { tSec: 0.75, durSec: 0.25, loudness: 0.2, brightness: 0.1, salience: 0.5 },
    { tSec: 9.5, durSec: 0.5, loudness: 0.5, brightness: 0.5, salience: 0.5 }, // past the clip
  ];
  const h = harness({
    tracks: [track({ id: 't1', fxChain: [tele] })],
    clips: [
      clip({ id: 'c1', trackId: 't1', startSec: 4, durationSec: 2 }),
      clip({ id: 'c2', trackId: 't1', startSec: 0, durationSec: 2, muted: true }),
    ],
    chunks,
    teleport: { entryId: 'e-tele', spy },
  });

  await renderBounce(request({ kind: 'master' }), h.deps);

  assert.equal(spy.events.length, 1, 'one schedule, for the one teleport entry');
  const events = spy.events[0];
  assert.deepEqual(
    events.map((e) => e.when), [4.25, 4.75],
    'onsets inside the clip are placed at their timeline time; a muted clip contributes none',
  );
  assert.ok(events.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)));
  assert.ok(
    events[0].x !== events[1].x || events[0].y !== events[1].y || events[0].z !== events[1].z,
    'successive onsets jump to different positions',
  );

  // The track-stem path does not bake teleport today, and neither does the
  // selection bounce: both run with includeAutomation = false.
  const off: TeleportSpy = { events: [] };
  const h2 = harness({
    tracks: [track({ id: 't1', fxChain: [tele] })],
    clips: [clip({ id: 'c1', trackId: 't1', startSec: 4, durationSec: 2 })],
    chunks,
    teleport: { entryId: 'e-tele', spy: off },
  });
  await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeAutomation: false, includeTrackMix: false }),
    h2.deps,
  );
  assert.deepEqual(off.events, [], 'includeAutomation = false leaves the panner where the rack put it');
}

/* ── 8. The tail, and the encoder ─────────────────────────────────────────── */

async function tailExtendsTheRender(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 2 })],
  });
  await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeFx: false, includeAutomation: false, includeTrackMix: false, tailSec: 1.5 }),
    h.deps,
  );
  assert.equal(
    h.ctxes[0].length, Math.ceil(3.5 * BOUNCE_SAMPLE_RATE),
    'tailSec is added to the extent (today every call site leaves it unset, so it is 0)',
  );
}

function encoderCarriesFloat32(): void {
  const buf = fakeBuffer(0.001, 8000, 1) as unknown as AudioBuffer;
  const pcm = encodeBounce(buf, { float32: false });
  const flt = encodeBounce(buf, { float32: true });
  assert.ok(pcm.size > 44 && flt.size > 44);
  assert.ok(flt.size > pcm.size, 'float32 samples are twice the size of 16-bit ones');
}

async function encoderReadsTheRenderedBuffer(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1', durationSec: 0.01 })],
  });
  const req = request({ kind: 'track', trackId: 't1' }, {
    includeFx: false, includeAutomation: false, includeTrackMix: false, float32: true,
  });
  const rendered = await renderBounce(req, h.deps);
  const blob = encodeBounce(rendered, req);
  const head = new DataView(await blob.arrayBuffer());
  assert.equal(head.getUint16(20, true), 3, 'req.float32 reaches the encoder as WAVE_FORMAT_IEEE_FLOAT');
  const pcm = encodeBounce(rendered, { ...req, float32: false });
  assert.equal(
    new DataView(await pcm.arrayBuffer()).getUint16(20, true), 1,
    'and the same buffer without it is WAVE_FORMAT_PCM',
  );
  assert.ok(blob.size > pcm.size, 'float32 is the larger of the two');
}

/* ── 9. A failed decode fails the bounce ──────────────────────────────────── */

async function decodeFailureAborts(): Promise<void> {
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [clip({ id: 'c1', trackId: 't1', muted: true }), clip({ id: 'c2', trackId: 't1' })],
  });
  let closed = 0;
  h.deps.decode = async () => { throw new Error('decode blew up'); };
  h.deps.makeDecodeContext = () => ({
    close: async () => { closed += 1; },
  }) as unknown as BaseAudioContext & { close(): Promise<void> };

  await assert.rejects(
    () => renderBounce(request({ kind: 'master' }, { includeFx: false, includeAutomation: false }), h.deps),
    /decode blew up/,
    'a clip that will not decode fails the whole bounce, muted or not',
  );
  assert.equal(closed, 1, 'and the decode context is still closed');
}

/* ── run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  extentMath();
  await fullFidelityGraph();
  await trackGating();
  await panPerClipForSelectionPerTrackForMaster();
  await noFxNeverBuildsAChain();
  await fadeEnvelopeAndClipGain();
  await aWarpedClipGetsOneSourcePerSegment();
  await trackScope();
  await automationReachesTheGraph();
  await aCurvedLaneBouncesAsACurve();
  await masterFxAutomationAndTheEndClamp();
  await automationOffSchedulesNothing();
  await teleportBakes();
  await tailExtendsTheRender();
  encoderCarriesFloat32();
  await encoderReadsTheRenderedBuffer();
  await decodeFailureAborts();
  console.log('renderCore: ok');
}

await main();
