// renderCore — COMPING, offline (T46C).
//
// The claim this suite exists to hold is `export == preview`: a comped clip
// prints what it previews. renderCore's part in that is deliberately small, and
// small is the point — the segment walk, the crossfades and the source offsets
// are `liveMixer.scheduleClipSources`'s, which is the LIVE scheduler, reached
// offline through `deps.scheduleSources`. Duplicating any of it here is what
// would let the two drift apart, so what is pinned below is the two halves the
// bounce actually owns:
//
//   1. DECODE. Every take of a comped clip is decoded, once per distinct Blob,
//      through the same `deps.decode` the clip's own blob goes through. The
//      active take's blob IS the clip's blob (the `AudioClip.takes` mirroring
//      invariant), so it is never decoded twice.
//   2. THE RESOLVER. A comped clip hands the scheduler a
//      `(takeIndex) => AudioBuffer | undefined`; every other clip hands it the
//      single buffer, byte for byte the argument it was handed before comping
//      existed. A clip with takes but NO comp is take SWITCHING, not comping,
//      and must reach neither half.
//
// Plus the degraded paths: a take that is not in the decoded map renders EVERY
// segment from the active take and logs, rather than throwing or printing a
// hole (a deliberate divergence from live, which skips the segment it cannot
// peek — see `renderCore`'s header); a blob-less take row is skipped by the
// decode loop instead of failing the bounce; and an `activeTakeIndex` pointing
// past the take list still resolves to the clip's own buffer, the way
// `liveMixer.takeResolver` does.
//
// The fake-context pattern is `renderCore.test.ts`'s, trimmed to what these
// cases read. Deliberately NOT asserted here: how many sources a comped clip
// schedules, or where they start — that is `scheduleClipSources`'s contract and
// `state/liveMixer.comp.test.ts`'s to pin. Asserting it from this side would be
// this file re-deriving the scheduling maths it must not own.
import assert from 'node:assert/strict';
import { scheduleClipSources } from '../state/liveMixer.ts';
import { useLogStore } from '../state/logStore.ts';
import type { AudioClip, ClipTake, CompRegion, EditorTrack } from '../state/editorStore.ts';
import {
  BOUNCE_SAMPLE_RATE, renderBounce,
  type BounceRequest, type BounceScope, type RenderDeps,
} from './renderCore.ts';

/* ── Stand-ins ────────────────────────────────────────────────────────────── */

interface FakeNode {
  kind: string;
  gain: { value: number; setValueAtTime(): void; linearRampToValueAtTime(): void };
  pan: { value: number };
  playbackRate: { value: number };
  buffer: unknown;
  outputs: FakeNode[];
  started: number[][];
  onended: (() => void) | null;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
  start(...args: number[]): void;
}

const fakeParam = () => ({
  value: 1,
  setValueAtTime() { /* the envelope's calls are not what this suite reads */ },
  linearRampToValueAtTime() { /* ditto */ },
});

const fakeNode = (kind: string): FakeNode => {
  const node: FakeNode = {
    kind,
    gain: fakeParam(),
    pan: { value: 0 },
    playbackRate: { value: 1 },
    buffer: null,
    outputs: [],
    started: [],
    onended: null,
    connect(to: FakeNode) { node.outputs.push(to); return to; },
    disconnect() { /* teardown is the live path's business */ },
    start(...args: number[]) { node.started.push(args); },
  };
  return node;
};

/** Enough of an AudioBuffer for the schedule math and for `encodeWav`. `tag` is
 *  this suite's own field: it is what makes "the resolver returned the buffer
 *  decoded from THAT take's blob" an identity claim a failure message can read. */
const fakeBuffer = (tag: string, duration = 10) => {
  const length = Math.round(duration * BOUNCE_SAMPLE_RATE);
  return {
    tag,
    duration,
    sampleRate: BOUNCE_SAMPLE_RATE,
    numberOfChannels: 2,
    length,
    getChannelData: () => new Float32Array(length),
  };
};

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
  startRendering(): Promise<unknown>;
}

const fakeCtx = (channels: number, length: number, sampleRate: number): FakeCtx => {
  const created: FakeNode[] = [];
  const ctx: FakeCtx = {
    sampleRate,
    length,
    destination: fakeNode('destination'),
    created,
    createGain() { const n = fakeNode('gain'); created.push(n); return n; },
    createStereoPanner() { const n = fakeNode('panner'); created.push(n); return n; },
    createBufferSource() { const n = fakeNode('source'); created.push(n); return n; },
    suspend() { return Promise.resolve(); },
    resume() { return Promise.resolve(); },
    async startRendering() {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      return fakeBuffer('rendered', length / sampleRate);
    },
  };
  return ctx;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

let nextBlob = 0;
const blob = (): Blob => new Blob([`blob-${nextBlob++}`]);

const take = (over: Partial<ClipTake> & { id: string; audioBlob: Blob }): ClipTake => ({
  label: over.id,
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 0,
  ...over,
});

const clip = (over: Partial<AudioClip> & { id: string; trackId: string }): AudioClip => ({
  label: over.id,
  audioBlob: over.audioBlob ?? blob(),
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 0,
  durationSec: 4,
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

/**
 * A clip with three takes and a comp across them, ACTIVE TAKE 1 — not 0, so the
 * mirroring invariant (`clip.audioBlob === takes[activeTakeIndex].audioBlob`) is
 * doing real work in every assertion below rather than being hidden by the
 * default. `comp` names all three regions with one crossfade at the second
 * boundary.
 */
function compedClip(id: string, trackId: string): {
  clip: AudioClip; takes: ClipTake[]; comp: CompRegion[];
} {
  const takes = [
    take({ id: `${id}-t0`, audioBlob: blob() }),
    take({ id: `${id}-t1`, audioBlob: blob() }),
    take({ id: `${id}-t2`, audioBlob: blob() }),
  ];
  const comp: CompRegion[] = [
    { startSec: 0, takeIndex: 1 },
    { startSec: 1.5, takeIndex: 0 },
    { startSec: 3, takeIndex: 2, crossfadeSec: 0.2 },
  ];
  return {
    clip: clip({
      id, trackId, durationSec: 4, audioBlob: takes[1].audioBlob, takes, comp, activeTakeIndex: 1,
    }),
    takes,
    comp,
  };
}

/** What `deps.scheduleSources` was handed, per call. */
interface ScheduleCall {
  clip: AudioClip;
  source: Parameters<typeof scheduleClipSources>[2];
  destination: unknown;
  nowSec: number;
  fromSec: number;
}

interface Harness {
  ctxes: FakeCtx[];
  /** Every blob `deps.decode` was asked for, in order. */
  decoded: Blob[];
  /** The buffer this harness handed back for each blob. */
  bufferOf: Map<Blob, AudioBuffer>;
  calls: ScheduleCall[];
  deps: RenderDeps;
}

/** `spy: false` puts the REAL `scheduleClipSources` in the deps, so the graph
 *  under test is the shipped one; `spy: true` records the arguments instead,
 *  which is how the resolver itself is inspected. */
const harness = (over: {
  clips?: AudioClip[];
  tracks?: EditorTrack[];
  spy?: boolean;
  onDecode?: (blob: Blob) => void;
} = {}): Harness => {
  const ctxes: FakeCtx[] = [];
  const decoded: Blob[] = [];
  const bufferOf = new Map<Blob, AudioBuffer>();
  const calls: ScheduleCall[] = [];
  let tag = 0;
  return {
    ctxes,
    decoded,
    bufferOf,
    calls,
    deps: {
      clips: over.clips ?? [],
      tracks: over.tracks ?? [],
      masterFxChain: [],
      automationLanes: [],
      decode: async (_ctx, b) => {
        decoded.push(b);
        over.onDecode?.(b);
        const buf = fakeBuffer(`buf-${tag++}`) as unknown as AudioBuffer;
        bufferOf.set(b, buf);
        return buf;
      },
      buildChain: (() => { throw new Error('no rack in these cases'); }) as unknown as RenderDeps['buildChain'],
      scheduleSources: over.spy
        ? ((_ctx, c, source, destination, nowSec, fromSec) => {
            calls.push({ clip: c as AudioClip, source, destination, nowSec, fromSec });
            return null;
          }) as unknown as RenderDeps['scheduleSources']
        : scheduleClipSources,
      makeContext: (channels, length, rate) => {
        const c = fakeCtx(channels, length, rate);
        ctxes.push(c);
        return c as unknown as OfflineAudioContext;
      },
      makeDecodeContext: () => ({ close: async () => {} }) as unknown as BaseAudioContext & {
        close(): Promise<void>;
      },
    },
  };
};

const request = (scope: BounceScope, over: Partial<BounceRequest> = {}): BounceRequest => ({
  scope,
  sampleRate: BOUNCE_SAMPLE_RATE,
  includeFx: false,
  includeAutomation: false,
  includeTrackMix: true,
  float32: false,
  ...over,
});

/** The warn entries this render added, so a case can claim "and logs" or
 *  "and says nothing" without depending on what ran before it. */
function warnsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const before = useLogStore.getState().entries.length;
  return fn().then((result) => ({
    result,
    warns: useLogStore.getState().entries
      .slice(before)
      .filter((e) => e.level === 'warn')
      .map((e) => e.msg),
  }));
}

/* ── 1. Decode: every take, once per distinct Blob ────────────────────────── */

async function everyTakeDecodesOnce(): Promise<void> {
  const comped = compedClip('c-comp', 't1');
  const plain = clip({ id: 'c-plain', trackId: 't1' });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [comped.clip, plain] });

  await renderBounce(request({ kind: 'master' }), h.deps);

  assert.deepEqual(
    h.decoded,
    [
      // The comped clip's own blob first — that is the loop the three renderers
      // had, untouched — then the takes it does not already cover.
      comped.clip.audioBlob,
      comped.takes[0].audioBlob,
      comped.takes[2].audioBlob,
      plain.audioBlob,
    ],
    'every take decodes, and the ACTIVE take is not decoded a second time under its own name',
  );
  assert.equal(comped.clip.audioBlob, comped.takes[1].audioBlob, 'the fixture holds the mirroring invariant');
  assert.equal(new Set(h.decoded).size, h.decoded.length, 'no Blob is decoded twice');
}

async function twoCompedClipsSharingATakeDecodeItOnce(): Promise<void> {
  const a = compedClip('c-a', 't1');
  // B reuses A's take 0 — the same Blob on a second clip, which is what a
  // duplicated (copy/pasted) clip looks like.
  const shared = a.takes[0];
  const bTakes = [shared, take({ id: 'c-b-t1', audioBlob: blob() })];
  const b = clip({
    id: 'c-b', trackId: 't1', startSec: 5, durationSec: 4,
    audioBlob: bTakes[1].audioBlob, takes: bTakes, activeTakeIndex: 1,
    comp: [{ startSec: 0, takeIndex: 1 }, { startSec: 2, takeIndex: 0 }],
  });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [a.clip, b] });

  await renderBounce(request({ kind: 'master' }), h.deps);

  assert.equal(
    h.decoded.filter((x) => x === shared.audioBlob).length, 1,
    'a take two comped clips share is decoded once, not once per clip',
  );
  assert.equal(
    h.decoded.length, 4,
    'three blobs for A, and only B\'s own new one — B\'s other take is A\'s, already decoded',
  );
}

async function takesWithoutACompDecodeNothingExtra(): Promise<void> {
  // TAKE SWITCHING, not comping: two takes and no comp. The clip's own blob
  // already IS the active take, so nothing else is needed and nothing else is
  // decoded — this is what keeps a project with takes rendering exactly as it
  // did before comping existed.
  const takes = [take({ id: 't0', audioBlob: blob() }), take({ id: 't1', audioBlob: blob() })];
  const c = clip({
    id: 'c1', trackId: 't1', audioBlob: takes[1].audioBlob, takes, activeTakeIndex: 1, comp: [],
  });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [c], spy: true });

  await renderBounce(request({ kind: 'master' }), h.deps);

  assert.deepEqual(h.decoded, [c.audioBlob], 'only the clip\'s own blob decodes');
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0].source, h.bufferOf.get(c.audioBlob),
    'and the scheduler gets the single buffer, not a resolver',
  );
}

/* ── 2. The resolver ──────────────────────────────────────────────────────── */

async function theResolverAnswersPerTake(): Promise<void> {
  const comped = compedClip('c-comp', 't1');
  const h = harness({ tracks: [track({ id: 't1' })], clips: [comped.clip], spy: true });

  const { warns } = await warnsDuring(() => renderBounce(request({ kind: 'master' }), h.deps));

  assert.equal(h.calls.length, 1);
  const { source, nowSec, fromSec } = h.calls[0];
  assert.equal(typeof source, 'function', 'a comped clip is scheduled through a take resolver');
  assert.deepEqual([nowSec, fromSec], [0, 0], 'the offline pin is unchanged: the render starts at t = 0');

  const resolve = source as (i: number) => AudioBuffer | undefined;
  for (let i = 0; i < comped.takes.length; i += 1) {
    assert.equal(
      resolve(i), h.bufferOf.get(comped.takes[i].audioBlob),
      `take ${i} resolves to the buffer decoded from take ${i}'s own blob`,
    );
  }
  assert.notEqual(resolve(0), resolve(1), 'and the three takes are three different buffers');
  assert.notEqual(resolve(1), resolve(2));
  assert.equal(resolve(3), undefined, 'a take index outside the list resolves to nothing');
  assert.equal(resolve(-1), undefined);
  assert.deepEqual(warns, [], 'a fully decoded comp warns about nothing');
}

async function anOutOfRangeActiveIndexStillPlays(): Promise<void> {
  // A broken document: `activeTakeIndex` points past the take list. The clip's
  // mirrored fields still hold real audio, and `liveMixer.takeResolver` answers
  // the ACTIVE index off `clip.audioBlob` rather than off `takes[i]` for exactly
  // this reason — so the offline resolver does the same, and the clip renders
  // instead of going silent.
  const takes = [take({ id: 't0', audioBlob: blob() }), take({ id: 't1', audioBlob: blob() })];
  const c = clip({
    id: 'c-broken', trackId: 't1', durationSec: 4,
    audioBlob: takes[1].audioBlob, takes, activeTakeIndex: 7,
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 2, takeIndex: 1 }],
  });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [c], spy: true });

  const { warns } = await warnsDuring(() => renderBounce(request({ kind: 'master' }), h.deps));

  assert.deepEqual(warns, [], 'every take decoded, so nothing is degraded');
  const resolve = h.calls[0].source as (i: number) => AudioBuffer | undefined;
  assert.equal(
    resolve(7), h.bufferOf.get(c.audioBlob),
    'the out-of-range ACTIVE index resolves to the clip\'s own buffer, not to silence',
  );
  assert.equal(resolve(0), h.bufferOf.get(takes[0].audioBlob), 'the real takes still answer themselves');
  assert.equal(resolve(1), h.bufferOf.get(takes[1].audioBlob));
  assert.equal(resolve(6), undefined, 'and an out-of-range index that is NOT the active one still resolves to nothing');
}

async function aTakeWithNoBlobIsSkippedNotDecoded(): Promise<void> {
  // A malformed row off disk. Asking `deps.decode` for `undefined` would reject
  // the whole bounce over one bad entry, so the decode loop skips it; the clip
  // then falls back to its active take, because a take with no audio is a take
  // that is not in the map.
  const good = take({ id: 't0', audioBlob: blob() });
  const broken = { id: 't-broken', label: 't-broken', mimeType: 'audio/wav', sourceDuration: 10, offsetIntoSource: 0 } as unknown as ClipTake;
  const active = take({ id: 't2', audioBlob: blob() });
  const c = clip({
    id: 'c-malformed', trackId: 't1', durationSec: 4,
    audioBlob: active.audioBlob, takes: [good, broken, active], activeTakeIndex: 2,
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 2, takeIndex: 1 }],
  });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [c] });

  const { warns } = await warnsDuring(() => renderBounce(request({ kind: 'master' }), h.deps));

  assert.deepEqual(
    h.decoded, [c.audioBlob, good.audioBlob],
    'the blob-less take is never handed to decode — the bounce does not fail over it',
  );
  assert.equal(warns.length, 1, 'it counts as a missing take and the clip degrades');
  assert.match(warns[0], /1 of 3/);
  assert.match(warns[0], /every segment from its active take/);
  const activeBuf = h.bufferOf.get(c.audioBlob);
  const sources = h.ctxes[0].created.filter((n) => n.kind === 'source');
  assert.ok(sources.length > 0, 'and the clip still renders');
  assert.ok(sources.every((s) => s.buffer === activeBuf), 'every source off the active take');
}

async function aStemRendersACompedClipTheSameWay(): Promise<void> {
  // The stem/freeze path is the SAME decode loop and the SAME scheduling call —
  // `renderBounce` has exactly one of each and the scope only decides which
  // clips are in `scoped` (`clipsInScope`). There is no second loop to extend.
  const comped = compedClip('c-comp', 't1');
  const other = clip({ id: 'c-other', trackId: 't2' });
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })],
    clips: [comped.clip, other],
    spy: true,
  });

  await renderBounce(
    request({ kind: 'track', trackId: 't1' }, { includeTrackMix: false }),
    h.deps,
  );

  assert.deepEqual(
    h.decoded,
    [comped.clip.audioBlob, comped.takes[0].audioBlob, comped.takes[2].audioBlob],
    'a stem decodes its own clip\'s takes and nothing off other tracks',
  );
  assert.equal(h.calls.length, 1);
  const resolve = h.calls[0].source as (i: number) => AudioBuffer | undefined;
  assert.equal(typeof resolve, 'function', 'a stem schedules the comp through the resolver too');
  assert.equal(resolve(0), h.bufferOf.get(comped.takes[0].audioBlob));
  assert.equal(resolve(2), h.bufferOf.get(comped.takes[2].audioBlob));
}

/* ── 3. The non-comped path is the same call it always was ────────────────── */

async function nonCompedScheduleIsUnchanged(): Promise<void> {
  // A project with no takes anywhere: every clip must reach the scheduler with
  // the plain AudioBuffer, at the offline pin, on its own track's fader — which
  // is `deps.scheduleSources(ctx, clip, buffers.get(clip.audioBlob), gain, 0, 0)`,
  // argument for argument the call this file made before comping existed.
  const clips = [
    clip({ id: 'c1', trackId: 't1', startSec: 1, durationSec: 2 }),
    clip({ id: 'c2', trackId: 't2', startSec: 4, durationSec: 3 }),
    clip({ id: 'c3', trackId: 't1', startSec: 8, durationSec: 2 }),
  ];
  const h = harness({
    tracks: [track({ id: 't1' }), track({ id: 't2' })], clips, spy: true,
  });

  await renderBounce(request({ kind: 'master' }), h.deps);

  assert.deepEqual(
    h.calls.map((c) => ({
      id: c.clip.id,
      sameBuffer: c.source === h.bufferOf.get(c.clip.audioBlob),
      isResolver: typeof c.source === 'function',
      nowSec: c.nowSec,
      fromSec: c.fromSec,
    })),
    [
      { id: 'c1', sameBuffer: true, isResolver: false, nowSec: 0, fromSec: 0 },
      { id: 'c2', sameBuffer: true, isResolver: false, nowSec: 0, fromSec: 0 },
      { id: 'c3', sameBuffer: true, isResolver: false, nowSec: 0, fromSec: 0 },
    ],
    'every non-comped clip is handed its own single decoded buffer, unchanged',
  );

  // And the destinations are the per-track faders, one per track, as before.
  const ctx = h.ctxes[0];
  const gains = ctx.created.filter((n) => n.kind === 'gain');
  const destinations = h.calls.map((c) => c.destination);
  assert.equal(new Set(destinations).size, 2, 'two tracks, two destinations');
  assert.equal(destinations[0], destinations[2], 'both t1 clips land on the one t1 fader');
  assert.ok(gains.includes(destinations[0] as FakeNode), 'and the destination is a node this context made');
}

async function theRealSchedulerStillBuildsTheSameGraph(): Promise<void> {
  // The same project through the REAL `scheduleClipSources`, so the graph under
  // test is the shipped one. A warped clip, because warp is the branch with the
  // most to lose: one source per segment, each with its own offsets and rate.
  const warped = clip({
    id: 'c1', trackId: 't1', startSec: 10, offsetIntoSource: 5, durationSec: 4, fadeOutSec: 1,
    warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }],
  });
  const h = harness({ tracks: [track({ id: 't1' })], clips: [warped] });

  await renderBounce(request({ kind: 'master' }), h.deps);

  const ctx = h.ctxes[0];
  const sources = ctx.created.filter((n) => n.kind === 'source');
  const buf = h.bufferOf.get(warped.audioBlob);
  assert.deepEqual(
    sources.map((s) => ({ started: s.started, rate: s.playbackRate.value, sameBuffer: s.buffer === buf })),
    [
      { started: [[10, 5, 2]], rate: 2, sameBuffer: true },
      { started: [[11, 7, 2]], rate: 1, sameBuffer: true },
    ],
    'a warped non-comped clip schedules exactly what it always did, off the one buffer',
  );
}

/* ── 4. A take that is not in the map ─────────────────────────────────────── */

async function aMissingTakeFallsBackToTheActiveTake(): Promise<void> {
  // The take list changing UNDER the render is the only way to reach this: the
  // decode loop puts every take in the map and a decode that fails rejects the
  // whole bounce. So the clip is grown a third take while the NEXT clip is
  // being decoded — after the first clip's own takes have already gone through.
  const comped = compedClip('c-comp', 't1');
  const late = take({ id: 'c-comp-t3', audioBlob: blob() });
  const second = clip({ id: 'c-second', trackId: 't1', startSec: 6 });
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [comped.clip, second],
    onDecode: (b) => {
      if (b !== second.audioBlob) return;
      comped.clip.takes = [...comped.takes, late];
      comped.clip.comp = [...comped.comp, { startSec: 3.5, takeIndex: 3 }];
    },
  });

  const { warns } = await warnsDuring(() => renderBounce(request({ kind: 'master' }), h.deps));

  assert.ok(
    h.decoded.every((b) => b !== late.audioBlob),
    'the late take really is missing from the decoded map — the case is real',
  );
  assert.equal(warns.length, 1, 'exactly one warning, for the one damaged clip');
  assert.match(warns[0], /c-comp/, 'which names the clip');
  assert.match(warns[0], /1 of 4/, 'and how many of its takes were short');
  assert.match(warns[0], /every segment from its active take/, 'and what it did instead');

  // It rendered, and it rendered the ACTIVE take: every source the clip built
  // reads the buffer decoded from the clip's own blob. (How MANY sources is
  // `scheduleClipSources`'s business — a butt-cut comp handed one buffer plays
  // that buffer across every segment — so the claim is over all of them.)
  const ctx = h.ctxes[0];
  const active = h.bufferOf.get(comped.clip.audioBlob);
  const sources = ctx.created.filter((n) => n.kind === 'source');
  assert.ok(sources.length >= 2, 'both clips still scheduled');
  assert.ok(
    sources.every((s) => s.buffer === active || s.buffer === h.bufferOf.get(second.audioBlob)),
    'no source reads a take that is not there — the comped clip fell back to its active take',
  );
}

async function anOrdinaryRenderIsSilentInTheLog(): Promise<void> {
  const comped = compedClip('c-comp', 't1');
  const h = harness({
    tracks: [track({ id: 't1' })],
    clips: [comped.clip, clip({ id: 'c-plain', trackId: 't1', startSec: 6 })],
  });
  const { warns } = await warnsDuring(() => renderBounce(request({ kind: 'master' }), h.deps));
  assert.deepEqual(warns, [], 'a healthy render — comped clip and all — warns about nothing');
}

/* ── run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  await everyTakeDecodesOnce();
  await twoCompedClipsSharingATakeDecodeItOnce();
  await takesWithoutACompDecodeNothingExtra();
  await theResolverAnswersPerTake();
  await anOutOfRangeActiveIndexStillPlays();
  await aTakeWithNoBlobIsSkippedNotDecoded();
  await aStemRendersACompedClipTheSameWay();
  await nonCompedScheduleIsUnchanged();
  await theRealSchedulerStillBuildsTheSameGraph();
  await aMissingTakeFallsBackToTheActiveTake();
  await anOrdinaryRenderIsSilentInTheLog();
  console.log('renderCore.comp: ok');
}

await main();
