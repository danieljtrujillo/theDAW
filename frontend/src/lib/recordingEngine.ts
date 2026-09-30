/**
 * recordingEngine — theDAW's take engine: per-track recorders whose takes are
 * anchored to TRANSPORT time rather than to wall-clock time.
 *
 * Why this exists (D13)
 * ---------------------
 * The only recorder in the app was `components/audio/MicRecorder.tsx`, a voice
 * memo: it measures elapsed time from `Date.now()` and hands its blob to
 * `sendAudioToEditor`, which drops the clip at the tail of the first track — or
 * at 0. Where the playhead was when the user hit record is never consulted, so
 * a take can only ever land in the wrong place. This module's whole reason to
 * exist is that a take carries the transport second it began at.
 *
 * And it takes that second at the moment the recorder's `start` EVENT fires,
 * not when `start()` was called. Per the MediaStream Recording spec (MDN,
 * `MediaRecorder: start event`) the `start` event is fired when `start()` is
 * called and "at this point, the data starts being gathered into a Blob" — but
 * it is a QUEUED TASK, so it lands some way after the synchronous `start()`
 * call returns: the recorder has to arm itself against the stream and the task
 * has to reach the front of the queue. (The device itself is already open by
 * then — `getUserMedia` resolved before any recorder was built.) That gap is
 * small, variable, and entirely unmeasurable from the call site, so stamping
 * there would bake an arbitrary early offset into every take. The same rule
 * runs the other end: `endSec` is taken in `onstop`. `stop()` queues a task
 * that stops capture, raises a final `dataavailable` with everything gathered
 * and THEN raises `stop`, so the blob assembled in `onstop` is complete (MDN,
 * `MediaRecorder.stop()`).
 *
 * What it is not
 * --------------
 * It draws nothing and touches no store. `onLevel` is the meter/live-waveform
 * feed a UI layer draws from; `takeClipPlacement` is how a take becomes clip
 * coordinates. Wiring those to the arm button, the footer's record press and
 * the count-in (`state/metronomeStore.ts` → `metronomeCountIn`) is a separate
 * piece of work.
 *
 * Seams
 * -----
 * The only browser APIs are `getUserMedia`, `MediaRecorder` and — for the level
 * feed — `AudioContext`, and each is a `RecordingDeps` entry that defaults to
 * the real thing. `now` is the transport clock: pass
 * `liveMixer.currentTransportSec`. `makeAnalyser` exists so a host can bind the
 * meter to the shared engine context instead of the private one the default
 * opens. The repeating-timer seam follows `lib/metronome.ts`, which injects its
 * timer for the same reason.
 *
 * Design sources (behaviour only — NO code from either is present here)
 * --------------------------------------------------------------------
 *   - `oss-refs/ACE-Step-DAW/src/engine/RecordingEngine.ts` (AGPL-3.0): the
 *     shape of a per-track recording session anchored to a transport time, with
 *     a live level/waveform feed alongside the recorder. Read for its design;
 *     note that it takes the transport time as an argument at the call site,
 *     which is precisely the anchoring bug fixed above.
 *   - Tracktion Engine `WaveAudioClip.cpp` / `TrackCompManager.h` (GPL-3.0 /
 *     commercial): takes belonging to the clip rather than to the recorder, so
 *     several passes over the same span stay addressable. Neither file was
 *     opened; the one-line description of that arrangement is all that was used
 *     and is why `Take` is a value handed to the caller, not engine state.
 *
 * The mime preference list and the chunked-`start(250)` / assemble-in-`onstop`
 * handling are theDAW's own, mirrored from `MicRecorder.tsx` (which is not
 * imported: it is a React component). `recordingEngine.test.ts` reads that file
 * and fails if the two lists drift.
 */

/* -------------------------------------------------------------------------- */
/*                                   types                                    */
/* -------------------------------------------------------------------------- */

/** Where a track's audio comes from. */
export type RecordingSource =
  | { kind: 'mic'; deviceId?: string }
  | { kind: 'stream'; stream: MediaStream };

/** One recorded pass over the timeline. */
export interface TakeMeta {
  id: string;
  trackId: string;
  /** Transport second the recorder actually began gathering data at. */
  startSec: number;
  /** Transport second it stopped at. Absent until the take has finished. */
  endSec?: number;
  /** Rate the input reported, or `0` when the UA does not report one. Purely
   *  informational — a consumer that decodes the blob gets the true rate. */
  sampleRate: number;
  mime: string;
  /** The recorder faulted mid-take. The take is still delivered — the spec
   *  flushes a final `dataavailable` and then `stop` — but the audio may be
   *  short or damaged, so this is here rather than swallowed. */
  error?: RecordingError;
}

export interface Take {
  meta: TakeMeta;
  blob: Blob;
}

/** One meter frame, both linear 0..1. */
export interface LevelFrame {
  peak: number;
  rms: number;
}

/** The level tap over one input stream. */
export interface LevelAnalyser {
  levels(): LevelFrame;
  dispose(): void;
}

/**
 * The slice of `MediaRecorder` this module uses. Handler properties rather
 * than `addEventListener`, matching `MicRecorder.tsx`, so a fake is a plain
 * object with four slots. A real `MediaRecorder` satisfies it as-is.
 */
export interface MediaRecorderLike {
  start(timesliceMs?: number): void;
  stop(): void;
  readonly state?: string;
  readonly mimeType?: string;
  onstart: ((ev?: unknown) => void) | null;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

/** Everything the engine reaches outside itself. Every entry but `now` has a
 *  real-browser default; tests inject fakes. */
export interface RecordingDeps {
  /** TRANSPORT seconds — pass `liveMixer.currentTransportSec`. */
  now: () => number;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  makeRecorder?: (stream: MediaStream, mime: string) => MediaRecorderLike;
  makeAnalyser?: (stream: MediaStream) => LevelAnalyser;
  /** REPEATING timer (setInterval-shaped) driving the level feed and bounding
   *  the `onstart` wait. Injectable for tests, as in `lib/metronome.ts`;
   *  defaults to the window's. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** How long `start()` waits for every recorder's `start` event before giving
   *  up and releasing the inputs. Defaults to `DEFAULT_START_TIMEOUT_MS`. */
  startTimeoutMs?: number;
}

export type RecordingErrorCode = 'nothing-armed' | 'permission' | 'unsupported' | 'busy';

const ERROR_MESSAGE: Record<RecordingErrorCode, string> = {
  'nothing-armed': 'No track is record-armed.',
  permission: 'The audio input could not be opened.',
  unsupported: 'Recording is not supported in this browser.',
  busy: 'A recording is already starting or running.',
};

/** Every failure this module raises. The originating error is always kept on
 *  `cause`; nothing is swallowed. */
export class RecordingError extends Error {
  readonly code: RecordingErrorCode;

  constructor(code: RecordingErrorCode, message?: string, cause?: unknown) {
    super(message ?? ERROR_MESSAGE[code], cause === undefined ? undefined : { cause });
    this.name = 'RecordingError';
    this.code = code;
  }
}

/** How a take is laid out on the timeline. `offsetIntoSource` is 0 because a
 *  take IS its source: nothing is trimmed off the front. */
export interface TakePlacement {
  trackId: string;
  startSec: number;
  durationSec: number;
  offsetIntoSource: 0;
}

/* -------------------------------------------------------------------------- */
/*                                 constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * Container preference, in order. MUST equal `MicRecorder.tsx`'s `candidates`
 * list: Chrome/Edge take webm/opus, Firefox ogg/opus, Safari mp4/aac, and the
 * backend stores whichever arrives verbatim.
 */
export const RECORDING_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

/** Used when the UA negotiated nothing we can name. */
export const DEFAULT_RECORDING_MIME = 'audio/webm';

/** Chunk period handed to `MediaRecorder.start`, as in `MicRecorder.tsx`, so a
 *  long take grows in pieces instead of one buffer held to the end. */
export const RECORDING_TIMESLICE_MS = 250;

/** Level-feed period. 25 Hz, comfortably the "≥ 20 Hz" a meter needs. */
export const RECORDING_LEVEL_INTERVAL_MS = 40;

/** Window size of the default analyser's time-domain read. */
export const RECORDING_ANALYSER_FFT_SIZE = 2048;

/**
 * How long `start()` waits for the recorders' `start` events. The event is a
 * queued task that normally lands in single-digit milliseconds; a wait this
 * long means the UA has swallowed it, and an unbounded wait would leave the
 * inputs open with `start()` pending forever.
 */
export const DEFAULT_START_TIMEOUT_MS = 5000;

/** What `micConstraints` is being asked for. */
export interface MicConstraintOptions {
  /** SOFT device id (see below). */
  deviceId?: string;
  /**
   * MUSICAL profile: the three processors OFF. Echo cancellation, noise
   * suppression and AGC are tuned for speech — they duck sustained tones,
   * gate quiet tails and ride the level under a crescendo, and AGC alone makes
   * a take's own dynamics unusable. A performance is recorded flat; a voice
   * memo is not.
   */
  musical?: boolean;
}

/**
 * Mic constraints, mirrored from `MicRecorder.tsx`: the device id is a SOFT
 * constraint so a mic that vanished between the enumerate and the open falls
 * back to the OS default instead of throwing, and the voice-memo processing
 * chain is on by default. Exported so a host can see exactly what it is
 * getting — the pitch paths deliberately force all three off, because they
 * distort f0, and `{ musical: true }` is that same profile named, for a host
 * recording a performance rather than a memo.
 *
 * A bare string is still the device id, which is what this engine's own
 * `openGroup` passes: the DEFAULT stays the memo profile so nothing that
 * already calls it changes behaviour, and the profile is the caller's choice.
 */
export function micConstraints(opts?: string | MicConstraintOptions): MediaStreamConstraints {
  const { deviceId, musical = false } = typeof opts === 'string' ? { deviceId: opts } : (opts ?? {});
  const processing = !musical;
  return {
    audio: {
      ...(deviceId ? { deviceId } : {}),
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               pure helpers                                 */
/* -------------------------------------------------------------------------- */

/**
 * First container in `RECORDING_MIME_CANDIDATES` that `supported` admits, or
 * `''` when none does (in which case the recorder is constructed without a
 * `mimeType` and the UA picks). A throwing predicate is survived rather than
 * allowed to abort the walk — `MediaRecorder.isTypeSupported` has thrown on
 * malformed types in the wild, and `MicRecorder` guards it the same way.
 */
export function chooseMime(supported: (mime: string) => boolean): string {
  for (const mime of RECORDING_MIME_CANDIDATES) {
    try {
      if (supported(mime)) return mime;
    } catch {
      /* keep trying the rest of the list */
    }
  }
  return '';
}

/** Assemble the gathered chunks into the take's blob. An unknown mime is left
 *  unset rather than guessed at. */
export function mergeChunks(chunks: readonly BlobPart[], mime: string): Blob {
  return mime ? new Blob([...chunks], { type: mime }) : new Blob([...chunks]);
}

/**
 * Peak and RMS of one time-domain window, both linear. Non-finite samples
 * count as silence: a single glitched value must not turn the whole frame into
 * NaN and blank a meter.
 */
export function levelFrame(samples: Float32Array): LevelFrame {
  const n = samples.length;
  if (n === 0) return { peak: 0, rms: 0 };
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}

/**
 * Where a finished take belongs on the timeline.
 *
 * `latencyCompSec` is the input round trip: what the performer heard was
 * already that far behind, so the recorded audio is that far late and the clip
 * slides EARLIER to line up. The timeline has no negative time, so a comp
 * larger than the take's own start clamps at 0 — the take keeps its full
 * length there rather than being trimmed, since `offsetIntoSource` stays 0 by
 * definition.
 */
export function takeClipPlacement(
  take: Take,
  opts: { latencyCompSec?: number } = {},
): TakePlacement {
  const { startSec, endSec, trackId } = take.meta;
  const comp = Number.isFinite(opts.latencyCompSec) ? (opts.latencyCompSec as number) : 0;
  const start = Math.max(0, startSec - comp);
  const duration = typeof endSec === 'number' ? Math.max(0, endSec - startSec) : 0;
  return { trackId, startSec: start, durationSec: duration, offsetIntoSource: 0 };
}

/* -------------------------------------------------------------------------- */
/*                             browser defaults                               */
/* -------------------------------------------------------------------------- */

function defaultGetUserMedia(): ((c: MediaStreamConstraints) => Promise<MediaStream>) | null {
  if (typeof navigator === 'undefined') return null;
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return null;
  return (c) => md.getUserMedia(c);
}

function defaultIsTypeSupported(mime: string): boolean {
  if (typeof MediaRecorder === 'undefined') return false;
  return MediaRecorder.isTypeSupported(mime);
}

function defaultMakeRecorder(stream: MediaStream, mime: string): MediaRecorderLike {
  if (typeof MediaRecorder === 'undefined') {
    throw new RecordingError('unsupported', 'MediaRecorder is not available in this browser.');
  }
  return new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * The default level tap: its own `AudioContext`, a source node and an analyser,
 * connected to NOTHING else — a meter must never become monitoring, or the take
 * feeds back through the speakers. A host with a shared context should inject
 * `makeAnalyser` instead. Returns `null` (rather than a stub) where there is no
 * AudioContext at all, so the level feed simply does not run.
 */
function defaultMakeAnalyser(): ((stream: MediaStream) => LevelAnalyser) | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  return (stream) => {
    const ctx = new Ctor();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createAnalyser();
    node.fftSize = RECORDING_ANALYSER_FFT_SIZE;
    src.connect(node);
    const buf = new Float32Array(node.fftSize);
    return {
      levels(): LevelFrame {
        node.getFloatTimeDomainData(buf);
        return levelFrame(buf);
      },
      dispose(): void {
        try { src.disconnect(); } catch { /* already torn down */ }
        try { node.disconnect(); } catch { /* already torn down */ }
        void ctx.close();
      },
    };
  };
}

/* -------------------------------------------------------------------------- */
/*                                  engine                                    */
/* -------------------------------------------------------------------------- */

export interface RecordingEngine {
  /** Arm a track. Re-arming replaces its source. Takes effect at the next
   *  `start()`; the live sessions are fixed once recording begins. */
  arm(trackId: string, source: RecordingSource): void;
  disarm(trackId: string): void;
  /** Armed track ids, in the order they were armed. */
  armed(): string[];
  /** Open one recorder per armed track and resolve once every one of them has
   *  actually started. Rejects with a `RecordingError` — `'busy'` if a start is
   *  already in flight or running — and leaves nothing open when it does. */
  start(): Promise<void>;
  /** Stop every recorder and resolve with one take each, in arming order. */
  stop(): Promise<Take[]>;
  isRecording(): boolean;
  /** Meter frames per armed track while recording, at
   *  `RECORDING_LEVEL_INTERVAL_MS`. Returns an unsubscribe. */
  onLevel(cb: (trackId: string, frame: LevelFrame) => void): () => void;
  /** Each take as it finishes — including one that ends by itself, before
   *  `stop()` is called. Returns an unsubscribe. */
  onTake(cb: (take: Take) => void): () => void;
}

interface StreamGroup {
  stream: MediaStream;
  /** True only for a stream this engine opened, and so may close. */
  owned: boolean;
  analyser: LevelAnalyser | null;
}

interface Session {
  trackId: string;
  rec: MediaRecorderLike;
  group: StreamGroup;
  chunks: BlobPart[];
  /** Mime asked for; the recorder's own `mimeType` wins when it has one. */
  askedMime: string;
  sampleRate: number;
  id: string;
  startSec: number;
  /** True once this recorder's `start` event has landed. */
  live: boolean;
  settled: boolean;
  /** Last fault the recorder reported AFTER it started, carried onto the take. */
  fault: RecordingError | null;
  take: Promise<Take>;
  finish: (take: Take) => void;
}

const takeId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `take-${crypto.randomUUID()}`
    : `take-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** The `name` of an error, reaching through an event wrapper's `error`. */
function errorName(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; error?: unknown };
    if (typeof o.name === 'string' && o.name) return o.name;
    if (o.error !== undefined && o.error !== null) return errorName(o.error);
  }
  return '';
}

function errorText(e: unknown): string {
  const name = errorName(e);
  const msg = e instanceof Error ? e.message : String(e);
  return name ? `${name}: ${msg}` : msg;
}

/**
 * Which failure an input or recorder error is. ONLY a denial is a permission
 * failure: `NotAllowedError` (the user said no) and `SecurityError` (the page
 * or the stream is not allowed to record). `NotFoundError` (no microphone at
 * all), `NotReadableError` (the OS has it) and `OverconstrainedError` (nothing
 * matches the requested device) are not denials — `micErrors.describeMicFailure`
 * treats a machine with no mic as an ordinary state rather than a fault, and
 * telling that user to grant permission is a dead end. They land on
 * `unsupported`, with the original name carried in the message and on `cause`.
 */
function inputErrorCode(e: unknown): RecordingErrorCode {
  const name = errorName(e);
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission' : 'unsupported';
}

function streamSampleRate(stream: MediaStream): number {
  try {
    const track = stream.getAudioTracks()[0];
    const rate = track ? track.getSettings().sampleRate : undefined;
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 0;
  } catch {
    return 0;
  }
}

/** One key per distinct input, so tracks sharing a mic share its stream. */
function sourceKey(source: RecordingSource, streamKeys: Map<MediaStream, string>): string {
  if (source.kind === 'mic') return `mic:${source.deviceId ?? ''}`;
  let key = streamKeys.get(source.stream);
  if (!key) {
    key = `stream:${streamKeys.size}`;
    streamKeys.set(source.stream, key);
  }
  return key;
}

export function createRecordingEngine(deps: RecordingDeps): RecordingEngine {
  const armedMap = new Map<string, RecordingSource>();
  const streamKeys = new Map<MediaStream, string>();
  const levelSubs = new Set<(trackId: string, frame: LevelFrame) => void>();
  const takeSubs = new Set<(take: Take) => void>();

  let sessions: Session[] = [];
  let groups: StreamGroup[] = [];
  let recording = false;
  /** True from the first line of `start()` until it settles, so an overlapping
   *  press cannot open a second set of inputs behind the first one's back. */
  let starting = false;
  let levelTimer: number | null = null;
  let deadlineTimer: number | null = null;

  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
  const clearTimer = deps.clearTimer ?? ((id) => { clearInterval(id as unknown as ReturnType<typeof setInterval>); });

  function closeGroups(list: StreamGroup[]): void {
    for (const g of list) {
      if (g.analyser) {
        try { g.analyser.dispose(); } catch { /* already gone */ }
        g.analyser = null;
      }
      if (!g.owned) continue;
      try {
        for (const t of g.stream.getTracks()) t.stop();
      } catch {
        /* a stream the UA already tore down */
      }
    }
  }

  function stopLevelPoll(): void {
    if (levelTimer === null) return;
    clearTimer(levelTimer);
    levelTimer = null;
  }

  function startLevelPoll(): void {
    if (levelTimer !== null) return;
    levelTimer = setTimer(() => {
      // One read per INPUT per tick, shared by every track on it: reading the
      // same analyser twice in a tick costs twice and — worse — reports two
      // different levels for one microphone.
      const frames = new Map<StreamGroup, LevelFrame>();
      for (const s of sessions) {
        const analyser = s.group.analyser;
        if (!analyser || s.settled) continue;
        let frame = frames.get(s.group);
        if (!frame) {
          frame = analyser.levels();
          frames.set(s.group, frame);
        }
        for (const cb of levelSubs) cb(s.trackId, frame);
      }
    }, RECORDING_LEVEL_INTERVAL_MS);
  }

  /** Assemble a session's take exactly once, whoever got here first. */
  function settle(s: Session): void {
    if (s.settled) return;
    s.settled = true;
    const mime = s.rec.mimeType || s.askedMime || DEFAULT_RECORDING_MIME;
    const take: Take = {
      meta: {
        id: s.id,
        trackId: s.trackId,
        startSec: s.startSec,
        endSec: deps.now(),
        sampleRate: s.sampleRate,
        mime,
        ...(s.fault ? { error: s.fault } : {}),
      },
      blob: mergeChunks(s.chunks, mime),
    };
    s.finish(take);
    // A recording can also end WITHOUT `stop()` — the UA ends the stream, the
    // device is unplugged, every recorder faults. When the last session has
    // settled that way there is nothing left to meter and nothing left to
    // stop, so the engine says so rather than claiming to record silence.
    if (sessions.length > 0 && sessions.every((other) => other.settled)) {
      recording = false;
      stopLevelPoll();
    }
    for (const cb of takeSubs) cb(take);
  }

  async function openGroup(source: RecordingSource): Promise<StreamGroup> {
    if (source.kind === 'stream') {
      return { stream: source.stream, owned: false, analyser: null };
    }
    const gum = deps.getUserMedia ?? defaultGetUserMedia();
    if (!gum) {
      throw new RecordingError('unsupported', 'getUserMedia is not available in this browser.');
    }
    let stream: MediaStream;
    try {
      stream = await gum(micConstraints(source.deviceId));
    } catch (e) {
      // A missing or busy microphone is not a denial; see `inputErrorCode`.
      throw new RecordingError(
        inputErrorCode(e),
        `Could not open the audio input: ${errorText(e)}`,
        e,
      );
    }
    return { stream, owned: true, analyser: null };
  }

  async function start(): Promise<void> {
    // Claimed BEFORE the first await. Two overlapping presses used to both get
    // past the old `if (recording)` check — `recording` was only set after the
    // `onstart` wait — so both opened the inputs, and the loser's StreamGroup
    // was overwritten: the mic stayed lit with nothing able to close it and
    // its takes were never delivered.
    if (recording || starting) throw new RecordingError('busy');
    const entries = [...armedMap.entries()];
    if (entries.length === 0) throw new RecordingError('nothing-armed');
    starting = true;

    const makeRecorder = deps.makeRecorder ?? defaultMakeRecorder;
    const makeAnalyser = deps.makeAnalyser ?? defaultMakeAnalyser();
    const mime = chooseMime(defaultIsTypeSupported);

    const byKey = new Map<string, StreamGroup>();
    const opened: StreamGroup[] = [];
    const next: Session[] = [];
    const starts: Promise<void>[] = [];

    try {
      // One open per distinct input — several tracks on one mic must never
      // light the device twice.
      for (const [, source] of entries) {
        const key = sourceKey(source, streamKeys);
        if (byKey.has(key)) continue;
        const group = await openGroup(source);
        byKey.set(key, group);
        opened.push(group);
        if (makeAnalyser) {
          try {
            group.analyser = makeAnalyser(group.stream);
          } catch {
            group.analyser = null; // no meter is survivable; no take is not
          }
        }
      }

      for (const [trackId, source] of entries) {
        const group = byKey.get(sourceKey(source, streamKeys));
        if (!group) continue;
        let rec: MediaRecorderLike;
        try {
          rec = makeRecorder(group.stream, mime);
        } catch (e) {
          throw e instanceof RecordingError
            ? e
            : new RecordingError('unsupported', `Could not open a recorder: ${errorText(e)}`, e);
        }
        let finish!: (take: Take) => void;
        const takePromise = new Promise<Take>((res) => { finish = res; });
        const session: Session = {
          trackId,
          rec,
          group,
          chunks: [],
          askedMime: mime,
          sampleRate: streamSampleRate(group.stream),
          id: takeId(),
          startSec: deps.now(),
          live: false,
          settled: false,
          fault: null,
          take: takePromise,
          finish,
        };

        const started = new Promise<void>((res, rej) => {
          rec.onstart = () => {
            // THE anchor. `deps.now()` read HERE, not at the `rec.start()` call
            // below: the `start` event is a queued task, so an unknown slice of
            // arming-and-dispatch sits between the two and would otherwise be
            // baked into every take as a fixed early offset.
            session.startSec = deps.now();
            session.live = true;
            res();
          };
          rec.onerror = (ev) => {
            const err = new RecordingError(
              inputErrorCode(ev),
              session.live
                ? `The recorder faulted mid-take: ${errorText(ev)}`
                : `The recorder failed before it started: ${errorText(ev)}`,
              ev,
            );
            if (!session.live) {
              // Fatal: the `start` event this is waiting on will never come.
              rej(err);
              return;
            }
            // Mid-take the spec still flushes a final `dataavailable` and then
            // `stop`, so the take completes through `onstop` below — but the
            // audio may be short or damaged, so the fault rides along on the
            // take's meta instead of being dropped on the floor.
            session.fault = err;
          };
        });
        rec.ondataavailable = (ev) => {
          const data = ev && ev.data;
          if (data && data.size > 0) session.chunks.push(data);
        };
        rec.onstop = () => { settle(session); };

        next.push(session);
        starts.push(started);
        rec.start(RECORDING_TIMESLICE_MS);
      }

      try {
        await Promise.race([Promise.all(starts), startDeadline(next)]);
      } finally {
        clearDeadline();
      }
    } catch (e) {
      for (const s of next) {
        s.rec.onstart = null;
        s.rec.ondataavailable = null;
        s.rec.onstop = null;
        s.rec.onerror = null;
        try {
          if (s.rec.state !== 'inactive') s.rec.stop();
        } catch {
          /* a recorder that never opened */
        }
      }
      closeGroups(opened);
      starting = false;
      throw e;
    }

    sessions = next;
    groups = opened;
    recording = true;
    starting = false;
    // Only once every recorder is live, so a meter never reads an input that
    // is not yet being captured.
    startLevelPoll();
  }

  /**
   * Rejects if the recorders have not all started within `startTimeoutMs`. A
   * `start` event that never arrives would otherwise leave `start()` pending
   * forever with the inputs open — the caller could neither record nor stop.
   */
  function startDeadline(pending: readonly Session[]): Promise<never> {
    const ms = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    return new Promise<never>((_res, rej) => {
      // `setTimer` is setInterval-shaped; cleared on its first fire — and by
      // `clearDeadline` when the recorders win the race — it is a one-shot.
      deadlineTimer = setTimer(() => {
        clearDeadline();
        const stalled = pending.filter((s) => !s.live).map((s) => s.trackId);
        rej(new RecordingError(
          'unsupported',
          `The recorder never started after ${ms}ms (${stalled.join(', ') || 'unknown'}).`,
        ));
      }, ms);
    });
  }

  function clearDeadline(): void {
    if (deadlineTimer === null) return;
    clearTimer(deadlineTimer);
    deadlineTimer = null;
  }

  async function stop(): Promise<Take[]> {
    if (sessions.length === 0) {
      recording = false;
      return [];
    }
    const live = sessions;
    const openedGroups = groups;
    sessions = [];
    groups = [];
    recording = false;
    stopLevelPoll();

    // Every recorder is asked to stop BEFORE anything is awaited, so the takes
    // end together rather than one microtask apart.
    for (const s of live) {
      if (s.settled) continue;
      try {
        if (s.rec.state !== 'inactive') {
          s.rec.stop();
        } else {
          // Already inactive but never settled: the UA ended capture without
          // ever raising `stop` (a stream that vanished, a faulted recorder).
          // No further event is coming, so waiting on `s.take` would hang
          // `stop()` forever. End the take here with what it gathered.
          settle(s);
        }
      } catch {
        // `stop()` threw — on an inactive recorder that is an InvalidStateError
        // saying only that it already ended. Same treatment. `settle` is
        // idempotent, so a real `onstop` in flight is still harmless.
        settle(s);
      }
    }

    const takes = await Promise.all(live.map((s) => s.take));
    closeGroups(openedGroups);
    return takes;
  }

  return {
    arm(trackId, source) {
      armedMap.set(trackId, source);
    },
    disarm(trackId) {
      const source = armedMap.get(trackId);
      armedMap.delete(trackId);
      // `streamKeys` exists only to give a caller-supplied MediaStream a stable
      // grouping key. Holding the entry after the last track on that stream is
      // disarmed keeps the stream itself reachable from this map for the life
      // of the engine, so drop it. A live session keeps its own reference to
      // the group, so this never disturbs a recording in progress.
      if (source?.kind !== 'stream') return;
      for (const other of armedMap.values()) {
        if (other.kind === 'stream' && other.stream === source.stream) return;
      }
      streamKeys.delete(source.stream);
    },
    armed() {
      return [...armedMap.keys()];
    },
    start,
    stop,
    isRecording() {
      return recording;
    },
    onLevel(cb) {
      levelSubs.add(cb);
      return () => { levelSubs.delete(cb); };
    },
    onTake(cb) {
      takeSubs.add(cb);
      return () => { takeSubs.delete(cb); };
    },
  };
}
