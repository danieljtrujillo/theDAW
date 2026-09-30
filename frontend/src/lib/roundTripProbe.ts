/**
 * The browser half of the round-trip measurement: open an input, play the
 * probe, capture what comes back, and hand the two arrays to
 * `roundTripLatency.estimateOffset`.
 *
 * The arithmetic is next door in `roundTripLatency.ts` and is tested under
 * node; everything that needs a real `AudioContext`, a real `MediaStream` and a
 * real worklet is here, and is deliberately thin — a wiring layer, not a place
 * where a decision is made.
 *
 * The timebase, which is the whole trick
 * --------------------------------------
 * The probe is scheduled to leave at a KNOWN context time `tStart`, and the
 * `roundtrip-recorder` worklet stamps its capture with the context frame of its
 * first sample. So sample `j` of the capture is context frame
 * `startFrame + j`, and the capture index that corresponds to `tStart` is
 * `round(tStart · sampleRate) - startFrame`. Correlating from THERE means the
 * lag that comes back is measured from the instant the signal was asked for —
 * i.e. it already contains the DAC's own buffering, the air (or the cable), and
 * the ADC's buffering, which together are the number a recorded take has to be
 * slid back by.
 *
 * `MediaRecorder` is not an option for this: its container's first sample has
 * no stated relationship to the context clock, so the alignment above cannot be
 * done at all. See the worklet's own header.
 *
 * What it will NOT do
 * -------------------
 * Monitor. The capture path ends at a zero-gain sink; nothing here ever routes
 * an input to an output. `recordingEngine`'s analyser tap carries the same rule
 * in its header, for the same reason: a monitor that appears by accident during
 * a loopback measurement is a feedback loop with the speakers.
 */

import { describeMicFailure, type MicFailureKind } from './micErrors';
import { micConstraints } from './recordingEngine';
import { addWorkletModule, audioWorkletAvailable } from './audioWorkletSupport';
import {
  DEFAULT_MAX_LAG_SEC,
  MAX_LAG_CAP_SEC,
  PROBE_DEFAULT_DURATION_SEC,
  estimateOffset,
  makeProbe,
  type OffsetResult,
  type ProbeKind,
} from './roundTripLatency';

/** Where the capture worklet lives, served from `frontend/public`. */
export const ROUND_TRIP_WORKLET_URL = '/worklets/roundtrip-recorder.js';
/** The name it registers itself under. */
export const ROUND_TRIP_PROCESSOR = 'roundtrip-recorder';

/** Silence between opening the capture and the probe leaving, seconds. The
 *  capture has to be running (and the context awake) before the signal goes. */
export const PROBE_LEAD_SEC = 0.3;
/** Room kept after the probe plus the searched window, seconds. */
export const PROBE_TAIL_SEC = 0.15;
/** How long to wait for the worklet's capture message after asking it to stop,
 *  and the slack on the run's own wall-clock deadline. */
export const CAPTURE_TIMEOUT_MS = 2000;
/** Gain the probe is played at, on top of `PROBE_PEAK`. */
export const PROBE_GAIN = 0.7;
/**
 * Searched window for an interactive run, seconds.
 *
 * Tighter than the pure module's `DEFAULT_MAX_LAG_SEC` on purpose: the
 * correlation is O(n·lag) on the MAIN THREAD, so halving the window halves the
 * freeze. 250 ms is still an order of magnitude past any working device stack
 * (a bad USB interface is 40 ms), and a stack slower than this has a problem no
 * compensation number is going to fix. The pure module keeps its own 1.0 s cap
 * for a caller that knows it needs the room.
 */
export const PROBE_UI_MAX_LAG_SEC = 0.25;

/* -------------------------------------------------------------------------- */
/*                                   errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * What went wrong, in the terms the UI has to act in. The microphone cases
 * reuse `micErrors.MicFailureKind` verbatim rather than inventing a second
 * vocabulary for the same three `getUserMedia` rejections — `describeMicFailure`
 * already knows that "no microphone on a machine with no microphone" is not a
 * fault, and that distinction is exactly the one this dialog must not get wrong.
 */
export type RoundTripProbeErrorKind =
  | MicFailureKind
  /** No `AudioContext`, or no `audioWorklet` on it. */
  | 'unsupported-audio'
  /** The worklet module would not load or would not construct. */
  | 'no-worklet'
  /** The worklet never handed a capture back. */
  | 'no-capture'
  /** The caller aborted. */
  | 'cancelled';

export class RoundTripProbeError extends Error {
  readonly kind: RoundTripProbeErrorKind;
  /** True when this is an ordinary state of the machine, not a fault — a
   *  laptop with no microphone attached. The UI says so quietly. */
  readonly benign: boolean;

  constructor(kind: RoundTripProbeErrorKind, message: string, benign = false) {
    super(message);
    this.name = 'RoundTripProbeError';
    this.kind = kind;
    this.benign = benign;
  }
}

/* -------------------------------------------------------------------------- */
/*                                the input                                   */
/* -------------------------------------------------------------------------- */

export interface ProbeStreamOptions {
  /** Which input to open. `''` / omitted lets the OS decide. */
  deviceId?: string;
  /** Seam for tests and for a host with its own permission flow. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

/**
 * The constraints a loopback measurement needs: the three processors OFF.
 *
 * This is `recordingEngine.micConstraints({ musical: true })` and deliberately
 * not a second copy of the same object — that function is already the repo's
 * one statement of the flat profile, and it makes the device id a SOFT
 * constraint so a mic that vanished between the enumerate and the open falls
 * back to the OS default instead of rejecting.
 *
 * All three are fatal here, not merely undesirable: echo cancellation exists
 * specifically to REMOVE the output signal from the input, which is the entire
 * thing being measured; noise suppression gates a short burst as noise; AGC
 * changes the level under the probe mid-sweep.
 */
export const probeConstraints = (deviceId?: string): MediaStreamConstraints =>
  micConstraints({ deviceId, musical: true });

/** Open an input for the probe, with the failure classified. */
export async function openProbeStream(opts: ProbeStreamOptions = {}): Promise<MediaStream> {
  const gum =
    opts.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : null);
  if (!gum) {
    throw new RoundTripProbeError(
      'unsupported',
      'This build cannot open a microphone, so the loopback test is off.',
    );
  }
  try {
    return await gum(probeConstraints(opts.deviceId));
  } catch (err) {
    const failure = describeMicFailure(err, 'the loopback latency test');
    throw new RoundTripProbeError(failure.kind, failure.message, failure.benign);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the run                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four things this module cannot do without a browser, made injectable.
 *
 * `AudioWorkletNode` is a GLOBAL constructor and `addModule` fetches a URL, so
 * without these seams the wiring below could only ever be exercised by hand in
 * a real browser — which is how the alignment arithmetic would have shipped
 * unverified. The clock pair is here for the same reason: a test that has to
 * wait three real seconds to watch a deadline fire does not get written.
 * `recordingEngine` carries the same shape (`now`, `setTimer`, `makeRecorder`)
 * for the same reason.
 */
export interface ProbeEnv {
  /** Wall clock, milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Delay. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Put the recorder module into the context. Defaults to `addModule` of
   *  `ROUND_TRIP_WORKLET_URL`, once per context. */
  addModule?: (ctx: AudioContext) => Promise<void>;
  /** Build the capture node. Defaults to `new AudioWorkletNode(...)`. */
  makeRecorderNode?: (ctx: AudioContext, maxSamples: number) => AudioWorkletNode;
}

export interface RunProbeOptions extends ProbeEnv {
  kind?: ProbeKind;
  durationSec?: number;
  maxLagSec?: number;
  /**
   * Where the probe is played. Defaults to `ctx.destination`. Pass the app's
   * master gain to measure the path the MUSIC takes, which is what a performer
   * is actually playing against — the tap calibrator schedules its clicks the
   * same way and for the same reason.
   */
  output?: AudioNode;
  /** 0..1 while the run is in flight. Called from a timer, not per sample. */
  onProgress?: (progress: number) => void;
  /** Abort a run in flight. The nodes are torn down either way. */
  signal?: AbortSignal;
}

export interface RoundTripMeasurement extends OffsetResult {
  /** The context's rate — the probe and the capture are both at it. */
  sampleRate: number;
  /** Context second the probe was scheduled to leave at. */
  scheduledSec: number;
  /** How many samples the capture window actually held after alignment. */
  capturedSamples: number;
  /** What the context itself reports its output side costs, seconds. Feed it to
   *  `roundTripLatency.roundTripMs` as the declared output half. */
  contextOutputLatencySec: number;
}

/**
 * `outputLatency` when the UA has it (Chromium does, and it is the real device
 * figure), else `baseLatency` (the graph's own buffering, a floor rather than
 * the truth), else 0. Same order `LatencyCalibrator` already reads them in.
 */
export function contextOutputLatencySec(ctx: BaseAudioContext): number {
  const c = ctx as BaseAudioContext & { outputLatency?: number; baseLatency?: number };
  const v = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : c.baseLatency;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Contexts whose `audioWorklet` already holds the recorder module. `addModule`
 *  is idempotent but not free, and a probe may be run repeatedly. */
const modulesLoaded = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: AudioContext, inject?: (ctx: AudioContext) => Promise<void>): Promise<void> {
  // Only the real load is cached: an injected loader is the caller's business
  // and must run every time it is passed.
  if (!inject && modulesLoaded.has(ctx)) return;
  if (!inject && !audioWorkletAvailable(ctx)) {
    throw new RoundTripProbeError(
      'unsupported-audio',
      'This browser has no AudioWorklet, so the loopback test cannot capture accurately.',
    );
  }
  try {
    if (inject) await inject(ctx);
    else await addWorkletModule(ctx, ROUND_TRIP_WORKLET_URL);
  } catch (err) {
    if (err instanceof RoundTripProbeError) throw err;
    throw new RoundTripProbeError(
      'no-worklet',
      `The loopback recorder could not load (${ROUND_TRIP_WORKLET_URL}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!inject) modulesLoaded.add(ctx);
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Play the probe, capture it, and report where it came back.
 *
 * The stream is NOT closed here — the caller opened it and may want it for a
 * second run; `openProbeStream`'s tracks are the caller's to stop. Everything
 * this function created (the worklet node, the sink, the source) is torn down
 * on every path out, including a throw and an abort.
 */
export async function runRoundTripProbe(
  ctx: AudioContext,
  stream: MediaStream,
  opts: RunProbeOptions = {},
): Promise<RoundTripMeasurement> {
  const durationSec = Math.max(0.02, opts.durationSec ?? PROBE_DEFAULT_DURATION_SEC);
  const maxLagSec = Math.min(MAX_LAG_CAP_SEC, Math.max(0.02, opts.maxLagSec ?? DEFAULT_MAX_LAG_SEC));
  const kind: ProbeKind = opts.kind ?? 'chirp';
  const nowMs = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;

  if (opts.signal?.aborted) throw new RoundTripProbeError('cancelled', 'The loopback test was cancelled.');
  if (stream.getAudioTracks().length === 0) {
    throw new RoundTripProbeError('no-device', 'That input has no audio track, so there is nothing to capture.', true);
  }
  await ensureWorklet(ctx, opts.addModule);
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* a context the UA will not resume still gets a run; it just captures silence */
    }
  }

  const sampleRate = ctx.sampleRate;
  const reference = makeProbe(sampleRate, { kind, durationSec });
  if (reference.length === 0) {
    throw new RoundTripProbeError('unsupported-audio', 'The audio context reports no usable sample rate.');
  }

  const windowSec = PROBE_LEAD_SEC + durationSec + maxLagSec + PROBE_TAIL_SEC;
  const maxSamples = Math.ceil(sampleRate * (windowSec + 0.5));

  let recorder: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let sink: GainNode | null = null;
  let player: AudioBufferSourceNode | null = null;
  let playerGain: GainNode | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  const teardown = (): void => {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    for (const node of [player, playerGain, source, recorder, sink]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* already torn down */
      }
    }
    if (player) {
      try {
        player.stop();
      } catch {
        /* never started, or already stopped */
      }
    }
    if (recorder) recorder.port.onmessage = null;
    player = null;
    playerGain = null;
    source = null;
    recorder = null;
    sink = null;
  };

  try {
    try {
      recorder = opts.makeRecorderNode
        ? opts.makeRecorderNode(ctx, maxSamples)
        : new AudioWorkletNode(ctx, ROUND_TRIP_PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { maxSamples },
          });
    } catch (err) {
      throw new RoundTripProbeError(
        'no-worklet',
        `The loopback recorder would not start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    source = ctx.createMediaStreamSource(stream);
    // A silent sink: the node has to be reachable from the destination to be
    // pulled at all, and it must not be audible. This is the ONLY place the
    // capture path touches an output, and it is at gain 0.
    sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(recorder);
    recorder.connect(sink);
    sink.connect(ctx.destination);

    const capture = new Promise<{ startFrame: number; samples: Float32Array }>((resolve, reject) => {
      const node = recorder;
      if (!node) {
        reject(new RoundTripProbeError('no-worklet', 'The loopback recorder vanished before it started.'));
        return;
      }
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; startFrame?: number; samples?: Float32Array } | null;
        if (!data || data.type !== 'capture' || !(data.samples instanceof Float32Array)) return;
        resolve({ startFrame: Number(data.startFrame) || 0, samples: data.samples });
      };
      node.onprocessorerror = () => {
        reject(new RoundTripProbeError('no-worklet', 'The loopback recorder faulted while capturing.'));
      };
    });

    // The probe itself, scheduled far enough ahead that the capture is running.
    const buffer = ctx.createBuffer(1, reference.length, sampleRate);
    buffer.copyToChannel(reference, 0);
    player = ctx.createBufferSource();
    player.buffer = buffer;
    playerGain = ctx.createGain();
    playerGain.gain.value = PROBE_GAIN;
    player.connect(playerGain);
    playerGain.connect(opts.output ?? ctx.destination);
    const scheduledSec = ctx.currentTime + PROBE_LEAD_SEC;
    player.start(scheduledSec);

    const endsAt = scheduledSec + durationSec + maxLagSec + PROBE_TAIL_SEC;
    const startedAt = ctx.currentTime;
    if (opts.onProgress) {
      const report = opts.onProgress;
      progressTimer = setInterval(() => {
        const span = endsAt - startedAt;
        const p = span > 0 ? (ctx.currentTime - startedAt) / span : 1;
        report(p < 0 ? 0 : p > 1 ? 1 : p);
      }, 100);
    }

    // Wall-clock wait for a context-clock DEADLINE — and a wall-clock bound on
    // top of it, because `ctx.currentTime` is not guaranteed to advance. A
    // context the OS suspended (the tab went to the background, the audio
    // device was pulled) stops its clock dead, and without this bound the loop
    // spins until the tab is closed while holding the microphone open. The
    // throw goes out through `finally`, so the nodes come down and
    // `measureRoundTrip` releases the device.
    const deadlineMs = nowMs() + (endsAt - startedAt) * 1000 + CAPTURE_TIMEOUT_MS;
    while (ctx.currentTime < endsAt) {
      if (opts.signal?.aborted) throw new RoundTripProbeError('cancelled', 'The loopback test was cancelled.');
      if (nowMs() > deadlineMs) {
        throw new RoundTripProbeError(
          'no-capture',
          'The audio clock stopped during the loopback test — the device may have been suspended. Try again.',
        );
      }
      await sleep(Math.min(120, Math.max(10, (endsAt - ctx.currentTime) * 1000)));
    }
    recorder.port.postMessage({ type: 'stop' });

    const captured = await Promise.race([
      capture,
      sleep(CAPTURE_TIMEOUT_MS).then(() => {
        throw new RoundTripProbeError('no-capture', 'The loopback recorder never handed back a capture.');
      }),
    ]);
    opts.onProgress?.(1);

    // Line the capture up with the instant the probe was asked for.
    const alignAt = Math.round(scheduledSec * sampleRate) - captured.startFrame;
    if (!Number.isFinite(alignAt) || alignAt < 0 || alignAt >= captured.samples.length) {
      throw new RoundTripProbeError(
        'no-capture',
        'The capture does not cover the moment the probe was played — try again.',
      );
    }
    const window = captured.samples.subarray(alignAt);
    const result = estimateOffset(reference, window, sampleRate, { maxLagSec });
    return {
      ...result,
      sampleRate,
      scheduledSec,
      capturedSamples: window.length,
      contextOutputLatencySec: contextOutputLatencySec(ctx),
    };
  } finally {
    teardown();
  }
}

/**
 * Open an input, measure, and close what was opened. The one call a UI needs.
 *
 * The stream opened here IS stopped here — a probe that left a microphone hot
 * would show the OS recording indicator for the rest of the session.
 */
export async function measureRoundTrip(
  ctx: AudioContext,
  opts: RunProbeOptions & ProbeStreamOptions = {},
): Promise<RoundTripMeasurement> {
  const stream = await openProbeStream(opts);
  try {
    return await runRoundTripProbe(ctx, stream, opts);
  } finally {
    try {
      for (const track of stream.getTracks()) track.stop();
    } catch {
      /* a stream the UA already tore down */
    }
  }
}
