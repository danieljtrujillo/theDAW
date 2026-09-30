// Run with: npx tsx src/lib/roundTripProbe.test.ts
//
// The browser half, with no browser: a fake `AudioContext`, a fake worklet
// node and a virtual clock, injected through `ProbeEnv`.
//
// The thing worth testing here is the ALIGNMENT — `round(scheduledSec·sr) -
// startFrame`, the one line that decides whether a measurement means anything.
// Get it wrong by a buffer and every take is placed wrong by a buffer, and the
// number still LOOKS plausible, which is exactly the kind of bug that ships. So
// the fake world puts the probe back at a known lag, from a deliberately
// non-quantum-aligned frame origin on a context whose clock did not start at
// zero, and the suite insists the same lag comes out.
//
// The rest is the failure surface: an abort, a clock that stops, a worklet that
// will not build, a capture that never arrives — and, for every one of them,
// that the nodes came down and the microphone was released.
import assert from 'node:assert/strict';

import { makeProbe } from './roundTripLatency.ts';
import {
  CAPTURE_TIMEOUT_MS,
  PROBE_LEAD_SEC,
  PROBE_UI_MAX_LAG_SEC,
  RoundTripProbeError,
  contextOutputLatencySec,
  measureRoundTrip,
  openProbeStream,
  probeConstraints,
  runRoundTripProbe,
} from './roundTripProbe.ts';

const SR = 48000;
/** Deliberately not a multiple of the 128-sample render quantum, and nowhere
 *  near zero: the alignment must not quietly depend on either. */
const START_FRAME = 987_653;
const DURATION_SEC = 0.05;
const MAX_LAG_SEC = 0.05;

/* --------------------------------- the fakes -------------------------------- */

interface FakeNode {
  readonly kind: string;
  connections: number;
  disconnects: number;
}

interface FakeWorld {
  ctx: AudioContext;
  stream: MediaStream;
  seams: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    addModule: (ctx: AudioContext) => Promise<void>;
    makeRecorderNode: (ctx: AudioContext, maxSamples: number) => AudioWorkletNode;
  };
  nodes: FakeNode[];
  /** Every node this run built is disconnected. */
  allDisconnected(): boolean;
  /** Context seconds the probe scheduled itself for, once it has. */
  scheduledSec: number | null;
  /** Tracks still live on the stream. */
  liveTracks(): number;
  addModuleCalls: number;
  recorderMessages: unknown[];
  recorderOnMessageCleared(): boolean;
}

interface WorldOptions {
  /** Where the probe comes back, in samples after it was scheduled. */
  trueLagSamples?: number;
  /** How loud it comes back. 0 = an input that hears nothing. */
  gain?: number;
  /** Freeze `ctx.currentTime` so only the wall clock moves — a suspended
   *  device. */
  freezeAudioClock?: boolean;
  /** Never answer the `stop` message. */
  swallowCapture?: boolean;
  /** Throw when the recorder node is built. */
  failRecorderNode?: boolean;
  /** Reject the module load. */
  failAddModule?: boolean;
  /** Build the stream with no audio track. */
  noAudioTrack?: boolean;
  /** Called on every virtual sleep, so a test can abort mid-run. */
  onSleep?: (virtualMs: number) => void;
  outputLatency?: number;
}

function fakeWorld(opts: WorldOptions = {}): FakeWorld {
  const {
    trueLagSamples = 1800,
    gain = 0.5,
    freezeAudioClock = false,
    swallowCapture = false,
    failRecorderNode = false,
    failAddModule = false,
    noAudioTrack = false,
    outputLatency = 0.012,
  } = opts;

  const nodes: FakeNode[] = [];
  const mkNode = (kind: string, extra: Record<string, unknown> = {}): FakeNode & Record<string, unknown> => {
    const node = {
      kind,
      connections: 0,
      disconnects: 0,
      connect() {
        node.connections += 1;
        return node;
      },
      disconnect() {
        node.disconnects += 1;
      },
      ...extra,
    } as FakeNode & Record<string, unknown>;
    nodes.push(node);
    return node;
  };

  let virtualMs = 0;
  let audioSec = START_FRAME / SR + 0.01;
  const world: FakeWorld = {
    ctx: null as unknown as AudioContext,
    stream: null as unknown as MediaStream,
    seams: null as unknown as FakeWorld['seams'],
    nodes,
    // `destination` is the CONTEXT's, not the run's: the probe never owns it
    // and must never disconnect it.
    allDisconnected: () => nodes.filter((n) => n.kind !== 'destination').every((n) => n.disconnects > 0),
    scheduledSec: null,
    liveTracks: () => 0,
    addModuleCalls: 0,
    recorderMessages: [],
    recorderOnMessageCleared: () => false,
  };

  const tracks = (noAudioTrack ? [] : ['mic']).map(() => {
    let live = true;
    return {
      stop() {
        live = false;
      },
      get live() {
        return live;
      },
    };
  });
  world.liveTracks = () => tracks.filter((t) => t.live).length;
  world.stream = {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;

  let recorderPort: { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null } | null = null;
  let maxSamplesAsked = 0;

  const ctx = {
    sampleRate: SR,
    state: 'running' as AudioContextState,
    outputLatency,
    baseLatency: 0.005,
    get currentTime() {
      return audioSec;
    },
    destination: mkNode('destination'),
    resume: async () => {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => mkNode('source'),
    createGain: () => mkNode('gain', { gain: { value: 1 } }),
    createBuffer: (_ch: number, length: number) => ({
      length,
      copyToChannel: () => {},
    }),
    createBufferSource: () =>
      mkNode('bufferSource', {
        buffer: null,
        start(at: number) {
          world.scheduledSec = at;
        },
        stop() {},
      }),
  } as unknown as AudioContext;
  world.ctx = ctx;

  const answerCapture = (): void => {
    if (swallowCapture || !recorderPort?.onmessage) return;
    const reference = makeProbe(SR, { durationSec: DURATION_SEC });
    const scheduledFrame = Math.round((world.scheduledSec ?? 0) * SR);
    const arrival = scheduledFrame + trueLagSamples;
    const needed = arrival + reference.length + SR * 0.05 - START_FRAME;
    const len = Math.max(0, Math.min(maxSamplesAsked, Math.ceil(needed)));
    const samples = new Float32Array(len);
    // A little room tone, so "nothing to find" is noise rather than a
    // suspiciously perfect digital silence.
    let seed = 99;
    for (let i = 0; i < len; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = (seed / 4294967296 - 0.5) * 0.02;
    }
    if (gain > 0) {
      const at = arrival - START_FRAME;
      for (let i = 0; i < reference.length && at + i < len; i += 1) samples[at + i] += reference[i] * gain;
    }
    recorderPort.onmessage({
      data: { type: 'capture', startFrame: START_FRAME, sampleRate: SR, samples },
    } as MessageEvent);
  };

  world.seams = {
    now: () => virtualMs,
    sleep: async (ms: number) => {
      virtualMs += ms;
      if (!freezeAudioClock) audioSec += ms / 1000;
      opts.onSleep?.(virtualMs);
    },
    addModule: async () => {
      world.addModuleCalls += 1;
      if (failAddModule) throw new Error('404 worklet');
    },
    makeRecorderNode: (_c, maxSamples) => {
      if (failRecorderNode) throw new Error('processor not registered');
      maxSamplesAsked = maxSamples;
      const port = {
        postMessage: (m: unknown) => {
          world.recorderMessages.push(m);
          if ((m as { type?: string })?.type === 'stop') answerCapture();
        },
        onmessage: null as ((e: MessageEvent) => void) | null,
      };
      recorderPort = port;
      const node = mkNode('recorder', { port, onprocessorerror: null });
      world.recorderOnMessageCleared = () => port.onmessage === null;
      return node as unknown as AudioWorkletNode;
    },
  };

  return world;
}

const run = (world: FakeWorld, extra: Record<string, unknown> = {}) =>
  runRoundTripProbe(world.ctx, world.stream, {
    durationSec: DURATION_SEC,
    maxLagSec: MAX_LAG_SEC,
    ...world.seams,
    ...extra,
  });

/* ----------------------------- the alignment -------------------------------- */

{
  const trueLag = 1800;
  const world = fakeWorld({ trueLagSamples: trueLag });
  const r = await run(world);

  assert.equal(r.lagSamples, trueLag, 'the probe is found exactly where it was put back');
  assert.ok(Math.abs(r.lagSec - trueLag / SR) < 1e-9);
  assert.ok(r.confidence > 0.8, `and confidently, got ${r.confidence}`);
  assert.equal(r.sampleRate, SR);
  assert.equal(r.contextOutputLatencySec, 0.012, 'the context reports its own output side');

  // The probe was scheduled a lead ahead of the clock, not at it.
  assert.ok(world.scheduledSec !== null);
  assert.ok(
    Math.abs(world.scheduledSec! - (START_FRAME / SR + 0.01 + PROBE_LEAD_SEC)) < 1e-9,
    'scheduled one lead after the clock it read',
  );
  assert.equal(world.addModuleCalls, 1, 'the module is loaded before anything is built');
  assert.ok(
    world.recorderMessages.some((m) => (m as { type?: string })?.type === 'stop'),
    'the recorder is told to stop',
  );
  assert.ok(world.allDisconnected(), 'every node built for the run is disconnected');
  assert.ok(world.recorderOnMessageCleared(), 'and the recorder port handler is released');
}

// The alignment survives a DIFFERENT lag and a different run — i.e. it is
// arithmetic, not a constant that happens to match. `0` is the boundary case
// that catches an off-by-one alignment: a probe that came back with no delay at
// all must read as lag 0, not as "one buffer".
for (const lag of [0, 137, 2100]) {
  const world = fakeWorld({ trueLagSamples: lag });
  assert.equal((await run(world)).lagSamples, lag, `lag ${lag} round-trips`);
}

/* --------------------------- an input that hears nothing -------------------- */

{
  // Room tone and no probe: a measurement is not invented.
  const world = fakeWorld({ gain: 0 });
  const r = await run(world);
  assert.ok(r.confidence < 0.5, `nothing heard is not a measurement, got ${r.confidence}`);
  assert.ok(world.allDisconnected(), 'and the run still tidies up');
}

/* ---------------------------------- abort ----------------------------------- */

{
  // Aborted before it starts: nothing is built at all.
  const world = fakeWorld();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run(world, { signal: controller.signal }),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'cancelled',
  );
  assert.equal(world.addModuleCalls, 0, 'an aborted run does not even load the module');
}

{
  // Aborted mid-flight: the wait loop notices, and the nodes come down.
  const controller = new AbortController();
  const world = fakeWorld({ onSleep: (ms) => { if (ms > 200) controller.abort(); } });
  await assert.rejects(
    () => run(world, { signal: controller.signal }),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'cancelled',
  );
  assert.ok(
    world.nodes.some((n) => n.kind === 'recorder'),
    'it had got as far as building the capture graph',
  );
  assert.ok(world.allDisconnected(), 'which is torn down on the way out of the abort');
  assert.equal(world.nodes.find((n) => n.kind === 'destination')!.disconnects, 0, "the context's own output is left alone");
}

/* --------------------------- the clock that stopped ------------------------- */

{
  // `ctx.currentTime` frozen — a suspended device, a backgrounded tab. Without
  // the wall-clock bound this loop never ends and the microphone stays open.
  const world = fakeWorld({ freezeAudioClock: true });
  await assert.rejects(
    () => run(world),
    (e: unknown) =>
      e instanceof RoundTripProbeError && e.kind === 'no-capture' && /audio clock stopped/i.test(e.message),
  );
  assert.ok(world.allDisconnected(), 'the bound reaches the teardown');
}

{
  // The bound is generous enough that an ordinary run is never cut short: it is
  // the run's own length plus the capture timeout.
  const world = fakeWorld({ trueLagSamples: 1800 });
  const r = await run(world);
  assert.equal(r.lagSamples, 1800);
  assert.ok(CAPTURE_TIMEOUT_MS >= 1000, 'the slack is seconds, not milliseconds');
}

/* ------------------------- a capture that never comes ----------------------- */

{
  const world = fakeWorld({ swallowCapture: true });
  await assert.rejects(
    () => run(world),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'no-capture',
  );
  assert.ok(world.allDisconnected());
}

/* ---------------------------- the worklet failing --------------------------- */

{
  const world = fakeWorld({ failAddModule: true });
  await assert.rejects(
    () => run(world),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'no-worklet',
  );
}

{
  const world = fakeWorld({ failRecorderNode: true });
  await assert.rejects(
    () => run(world),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'no-worklet',
  );
  assert.ok(world.allDisconnected(), 'the half-built graph is still torn down');
}

/* ------------------------------- no input track ----------------------------- */

{
  const world = fakeWorld({ noAudioTrack: true });
  await assert.rejects(
    () => run(world),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'no-device' && e.benign,
  );
  assert.equal(world.addModuleCalls, 0);
}

/* ------------------------- the microphone is released ----------------------- */

{
  // `measureRoundTrip` owns the stream it opened, so it stops the tracks — on
  // the way out of a SUCCESS...
  const world = fakeWorld({ trueLagSamples: 900 });
  const r = await measureRoundTrip(world.ctx, {
    durationSec: DURATION_SEC,
    maxLagSec: MAX_LAG_SEC,
    ...world.seams,
    getUserMedia: async () => world.stream,
  });
  assert.equal(r.lagSamples, 900);
  assert.equal(world.liveTracks(), 0, 'the microphone is not left hot after a good run');
}

{
  // ...and on the way out of a failure.
  const world = fakeWorld({ swallowCapture: true });
  await assert.rejects(() =>
    measureRoundTrip(world.ctx, {
      durationSec: DURATION_SEC,
      maxLagSec: MAX_LAG_SEC,
      ...world.seams,
      getUserMedia: async () => world.stream,
    }),
  );
  assert.equal(world.liveTracks(), 0, 'nor after a bad one');
}

/* ------------------------------ opening the input --------------------------- */

{
  // The three processors are OFF — echo cancellation in particular exists to
  // remove exactly the signal being measured.
  const audio = probeConstraints('mic-9').audio as Record<string, unknown>;
  assert.equal(audio.echoCancellation, false);
  assert.equal(audio.noiseSuppression, false);
  assert.equal(audio.autoGainControl, false);
  assert.equal(audio.deviceId, 'mic-9');
  assert.equal('deviceId' in (probeConstraints('').audio as Record<string, unknown>), false);

  // The failures are classified with `micErrors`' own vocabulary, so a machine
  // with no microphone is benign and a refusal is not.
  const reject = (name: string) => async () => {
    const err = new Error(name);
    err.name = name;
    throw err;
  };
  await assert.rejects(
    () => openProbeStream({ getUserMedia: reject('NotAllowedError') }),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'denied' && !e.benign,
  );
  await assert.rejects(
    () => openProbeStream({ getUserMedia: reject('NotFoundError') }),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'no-device' && e.benign,
  );
  await assert.rejects(
    () => openProbeStream({ getUserMedia: reject('NotReadableError') }),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'busy',
  );
  await assert.rejects(
    () => openProbeStream({}),
    (e: unknown) => e instanceof RoundTripProbeError && e.kind === 'unsupported',
  );
}

/* -------------------------------- odds and ends ----------------------------- */

{
  // `outputLatency` wins over `baseLatency`; a context with neither is 0 rather
  // than NaN.
  const asCtx = (o: Record<string, number>): BaseAudioContext => o as unknown as BaseAudioContext;
  assert.equal(contextOutputLatencySec(asCtx({ outputLatency: 0.02, baseLatency: 0.005 })), 0.02);
  assert.equal(contextOutputLatencySec(asCtx({ baseLatency: 0.005 })), 0.005);
  assert.equal(contextOutputLatencySec(asCtx({})), 0);
  assert.equal(contextOutputLatencySec(asCtx({ outputLatency: Number.NaN })), 0);

  // The interactive window is tighter than the pure default, because the
  // correlation is O(n·lag) on the main thread.
  assert.ok(PROBE_UI_MAX_LAG_SEC > 0 && PROBE_UI_MAX_LAG_SEC <= 0.25);
}

console.log('roundTripProbe tests passed');
