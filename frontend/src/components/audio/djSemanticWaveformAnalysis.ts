/**
 * Pure analysis + canvas-drawing helpers behind `DJSemanticWaveform`.
 *
 * Split out of the component module (batch-12 T21 audit follow-up) so that
 * module only exports the component itself — a module that exports both a
 * component and other values breaks Vite's React Fast Refresh, forcing a
 * full reload on every edit instead of a hot patch.
 *
 * DJ-2 — the three costs this module used to pay per waveform INSTANCE, and
 * the default DJ layout mounts two per deck:
 *
 *  - **decode**: its own fetch + its own throwaway real `AudioContext`. Now
 *    one shared fetch/decode per URL via `lib/djAudioCache`.
 *  - **analysis**: ~51M inner iterations for a 3.5-minute track, run
 *    synchronously on the main thread. Now memoised per
 *    (url, normalize, binCount), run in a Worker when one exists, and sized
 *    from the width the whole track spans at the lane's zoom
 *    ({@link binCountFor}).
 *  - **repaint**: the whole canvas re-rendered on every viewport change
 *    (~6x/s/deck while playing). Now a lane that scrolls at a steady zoom
 *    draws the window around its viewport once and moves by blitting it
 *    ({@link drawWaveformCached}); {@link drawWaveform} itself is untouched.
 */
import { getDecodedAudio, measureSync, onEvict, type AudioDecodeContext } from '../../lib/djAudioCache';
import { applyCanvasBox, scaleContextToBox, type CanvasBox } from '../../lib/canvasScale';

export type WaveBin = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
  color: string;
  /** Samples in this bin, summed over channels, at or above
   *  {@link CLIP_SAMPLE_LEVEL} in magnitude. Counted over EVERY sample of each
   *  channel's raw data, never the strided mono mix and never rescaled by
   *  `normalize`, so it says whether the file itself reaches full scale. */
  clipped: number;
};

export const EMPTY_BINS: WaveBin[] = [];

/** How a waveform's body is coloured. 'semantic' (default): the frequency
 *  + beat classification below. 'plain': one flat colour, amplitude only.
 *  'clipping': plain, plus every column holding a sample at full scale in
 *  any channel ({@link WaveBin.clipped}) flagged in red.
 *  Owned here (the drawing module); `state/waveformStyleStore.ts` is the one
 *  global preference that picks it. */
export type WaveformDrawMode = 'semantic' | 'plain' | 'clipping';

/** A raw sample at or above this magnitude (about -0.01 dBFS) counts as
 *  clipped. The test used to be a bin's drawn peak at or above 0.985, which
 *  read the mono mix after `normalize` had rescaled it: the loudest bin of
 *  every normalised waveform is 1.0, so a track peaking at -12 dBFS showed
 *  red, while a file clipping in one channel averaged down to about half and
 *  never did. Exported for tests. */
export const CLIP_SAMPLE_LEVEL = 0.999;
/** The flat body colour for 'plain' and non-clipped bins in 'clipping' mode. */
const PLAIN_BODY = [188, 196, 214] as const;
/** Clipped-bin colour in 'clipping' mode. */
const CLIP_BODY = [255, 61, 79] as const;

/** The Goertzel frequencies (Hz) behind each band's energy. The legend names
 *  the bands from these, so what it says is what is measured. */
const LOW_BAND_HZ = [58, 88, 128, 180];
const MID_BAND_HZ = [420, 760, 1180, 1700];
const BRIGHT_BAND_HZ = [2600, 3600, 5200];

const SILENCE = 'rgba(72, 83, 100, 0.45)';
const BEAT = '#ff3f4f';
const VOCAL = '#72ee78';
const BASS = '#2ea9ff';
const BRIGHT = '#f5b84b';
const BODY = '#bca8ff';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `AudioBuffer.getChannelData(ch)` is allowed to copy on every call (it does
 * on several implementations); calling it per-sample inside the analysis
 * loop below re-copied a full channel's worth of data for every single
 * sample read. Fetch each channel's array once and index into the cached
 * arrays instead. Exported for tests (FE-008).
 */
export function getChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  return channels;
}

export function getMonoSample(channels: Float32Array[], index: number): number {
  let total = 0;
  for (let ch = 0; ch < channels.length; ch += 1) {
    total += channels[ch][index] ?? 0;
  }
  return total / Math.max(1, channels.length);
}

function bandPower(samples: Float32Array, sampleRate: number, freqs: number[]): number {
  let power = 0;
  for (const freq of freqs) {
    if (freq >= sampleRate * 0.45) continue;
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    power += Math.max(0, q1 * q1 + q2 * q2 - coeff * q1 * q2);
  }
  return power / Math.max(1, samples.length * samples.length * freqs.length);
}

function pickColor(peak: number, rms: number, low: number, mid: number, bright: number, zcr: number, transient: number): string {
  if (peak < 0.012 || rms < 0.004) return SILENCE;

  const total = low + mid + bright + 1e-9;
  const lowShare = low / total;
  const midShare = mid / total;
  const brightShare = bright / total;
  const noisyTop = clamp(zcr / 0.28, 0, 1);

  if (transient > 0.48 && (lowShare > 0.22 || peak > 0.72)) return BEAT;
  if (midShare > lowShare * 1.08 && midShare > brightShare * 0.86) return VOCAL;
  if (lowShare > 0.46) return BASS;
  if (brightShare > 0.34 || noisyTop > 0.58) return BRIGHT;
  return BODY;
}

function semanticRgb(color: string): [number, number, number] {
  switch (color) {
    case BEAT:
      return [255, 89, 64];
    case VOCAL:
      return [76, 241, 112];
    case BASS:
      return [46, 169, 255];
    case BRIGHT:
      return [255, 182, 65];
    case BODY:
      return [188, 168, 255];
    default:
      return [72, 83, 100];
  }
}

function hz(value: number): string {
  return value >= 1000 ? `${Number((value / 1000).toFixed(1))} kHz` : `${value} Hz`;
}
function bandRange(freqs: number[]): string {
  return `${hz(freqs[0])}–${hz(freqs[freqs.length - 1])}`;
}

/** One legend row: the colour a waveform draws and what it means. */
export type WaveformLegendItem = { rgb: readonly [number, number, number]; label: string };

/**
 * What each colour means, per mode — the one place the legend is written, next
 * to the code that picks the colours. Red is a beat in 'semantic' and a
 * clipped sample in 'clipping', so each mode's rows say which one it is, and
 * the green, blue and orange rows name the band they measure.
 */
export const WAVEFORM_LEGEND: Record<WaveformDrawMode, readonly WaveformLegendItem[]> = {
  semantic: [
    { rgb: semanticRgb(BEAT), label: 'Red: beat (sharp hit)' },
    { rgb: semanticRgb(VOCAL), label: `Green: mids ${bandRange(MID_BAND_HZ)}` },
    { rgb: semanticRgb(BASS), label: `Blue: bass ${bandRange(LOW_BAND_HZ)}` },
    { rgb: semanticRgb(BRIGHT), label: `Orange: highs ${bandRange(BRIGHT_BAND_HZ)} or noise` },
    { rgb: semanticRgb(BODY), label: 'Purple: no band leads' },
    { rgb: semanticRgb(SILENCE), label: 'Gray: silence' },
  ],
  plain: [{ rgb: PLAIN_BODY, label: 'Level only, no colour coding' }],
  clipping: [
    { rgb: PLAIN_BODY, label: 'Level' },
    { rgb: CLIP_BODY, label: 'Red: clipped (a channel at full scale)' },
  ],
};

function semanticRgba(color: string, alpha: number): string {
  const [r, g, b] = semanticRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The decoded audio behind `audioUrl`.
 *
 * Delegates to the DJ-wide {@link getDecodedAudio} cache: one fetch and one
 * `decodeAudioData` per URL for every consumer on the page, decoded through a
 * shared `OfflineAudioContext` (or the engine's context) rather than a
 * throwaway real `AudioContext` per waveform instance.
 *
 * `signal` withdraws THIS caller only: the request is shared, so an
 * unmounting instance leaves the download to anyone else still waiting on it,
 * and the cache aborts the download when nobody is.
 */
export function decodeAudio(
  audioUrl: string,
  context?: AudioDecodeContext | null,
  signal?: AbortSignal | null,
): Promise<AudioBuffer> {
  return getDecodedAudio(audioUrl, context, { signal });
}

export interface AnalyzeOptions {
  /** `true` (default): rescale every bin's peak/min/max/rms to the BUFFER's
   *  own loudest sample, exactly as this always did — the DJ decks want two
   *  tracks of very different mastering loudness to still fill the same
   *  visual height so they are easy to beatmatch by eye.
   *  `false`: absolute amplitude, clamped to [0, 1] / [-1, 1] (a float WAV's
   *  samples can exceed unity) but never rescaled — a quiet clip draws quiet
   *  and a loud one draws loud, which is what REAPER does by default and what
   *  D16 fixed `editorStore.computePeaks` (the EDIT timeline) to do; this is
   *  the same fix for the DJ-deck / SemanticWave waveform (audit MAJOR #2). */
  normalize?: boolean;
  /** Width in CSS px that the WHOLE buffer spans where these bins are drawn:
   *  a lane's width divided by the fraction of the track it shows. Omitted
   *  (or 0, i.e. not measured yet) keeps the historical count. See
   *  {@link binCountFor}. */
  width?: number;
  /** The bin count itself, when the caller already has it from
   *  {@link binCountFor}. Wins over `width`. */
  bins?: number;
  /** Aborting withdraws this caller: its promise rejects with an
   *  `AbortError`, and once no caller is waiting the analysis is dropped
   *  (a Worker still computing it is stopped). */
  signal?: AbortSignal | null;
}

/** Lower bound on bins, unchanged: below this the wave stops being readable
 *  even on a narrow lane. */
const MIN_BINS = 900;
/** Absolute upper bound on bins, unchanged from before DJ-2. */
const MAX_BINS = 6400;
/** Bins per pixel of the whole track's width. Above ~4 the extra bins are
 *  averaged away by `sliceStats` before anything is drawn. */
const BINS_PER_PX = 4;

/**
 * How many analysis bins a buffer of `duration` seconds gets when the WHOLE
 * buffer spans `fullWidth` CSS px — a lane's width over the fraction of the
 * track it shows, `width / (viewportEnd - viewportStart)`.
 *
 * The count is the historical `round(duration * 32)` clamped to [900, 6400]
 * (main's resolution), lowered only when {@link BINS_PER_PX} per pixel of the
 * whole track's width needs fewer. That ceiling is rounded UP to a power of
 * two, so the count moves in at most a handful of steps however the lane is
 * resized or zoomed, and a lane never gets fewer than 4 bins per pixel.
 *
 * The width used to be the lane's own width, which ignored zoom: the DJ
 * detail lane at zoom 8 showed 480 bins across 900 px where main showed 800,
 * and a trimmed EDIT clip got a tenth of what it had. Exported for tests.
 */
export function binCountFor(duration: number, fullWidth?: number): number {
  const natural = clamp(Math.round(duration * 32), MIN_BINS, MAX_BINS);
  if (fullWidth === undefined || !Number.isFinite(fullWidth) || fullWidth <= 0) return natural;
  const wanted = Math.max(MIN_BINS, fullWidth * BINS_PER_PX);
  return Math.min(natural, 2 ** Math.ceil(Math.log2(wanted)));
}

function binsFor(buffer: AudioBuffer, opts?: AnalyzeOptions): number {
  if (opts?.bins !== undefined && Number.isFinite(opts.bins) && opts.bins > 0) return Math.round(opts.bins);
  return binCountFor(buffer.duration, opts?.width);
}

/**
 * The analysis loop itself, over raw channel data rather than an
 * `AudioBuffer` — an `AudioBuffer` cannot cross a `postMessage` boundary but
 * `Float32Array`s can, so this is the half that runs inside the Worker.
 * Identical arithmetic to the in-process path; the Worker is fed copies of
 * the very same Float32Arrays.
 */
export function analyzeChannels(
  channels: Float32Array[],
  length: number,
  sampleRate: number,
  bins: number,
  normalize: boolean,
): WaveBin[] {
  const samplesPerBin = Math.max(1, Math.floor(length / bins));
  const maxAnalysisSamples = 512;
  const out: WaveBin[] = [];
  let globalPeak = 0;
  let globalLow = 0;
  let globalMid = 0;
  let globalBright = 0;

  for (let i = 0; i < bins; i += 1) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? length : Math.min(length, start + samplesPerBin);
    const stride = Math.max(1, Math.floor((end - start) / maxAnalysisSamples));
    const analysisCount = Math.max(1, Math.floor((end - start) / stride));
    const samples = new Float32Array(analysisCount);

    let peak = 0;
    let min = 0;
    let max = 0;
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;

    for (let n = 0; n < analysisCount; n += 1) {
      const sample = getMonoSample(channels, Math.min(length - 1, start + n * stride));
      samples[n] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
      sumSq += sample * sample;
      if (n > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) crossings += 1;
      prev = sample;
    }

    // Clipping is read from every raw sample of every channel: the strided
    // mono read above can step over a short run at full scale, and averaging
    // the channels halves a clip that is in one channel only.
    let clipped = 0;
    for (let ch = 0; ch < channels.length; ch += 1) {
      const data = channels[ch];
      const stop = Math.min(end, data.length);
      for (let n = start; n < stop; n += 1) {
        const v = data[n];
        if (v >= CLIP_SAMPLE_LEVEL || v <= -CLIP_SAMPLE_LEVEL) clipped += 1;
      }
    }

    const rms = Math.sqrt(sumSq / analysisCount);
    const zcr = crossings / Math.max(1, analysisCount - 1);
    const analysisRate = sampleRate / stride;
    const low = bandPower(samples, analysisRate, LOW_BAND_HZ);
    const mid = bandPower(samples, analysisRate, MID_BAND_HZ);
    const bright = bandPower(samples, analysisRate, BRIGHT_BAND_HZ);
    const crest = peak / Math.max(0.0001, rms);
    const transient = clamp((crest - 1.45) / 3.2, 0, 1);

    out.push({
      peak,
      rms,
      min,
      max,
      low,
      mid,
      bright,
      transient,
      color: pickColor(peak, rms, low, mid, bright, zcr, transient),
      clipped,
    });
    if (peak > globalPeak) globalPeak = peak;
    if (low > globalLow) globalLow = low;
    if (mid > globalMid) globalMid = mid;
    if (bright > globalBright) globalBright = bright;
  }

  if (normalize) {
    if (globalPeak > 0) {
      for (const bin of out) {
        bin.peak = clamp(bin.peak / globalPeak, 0, 1);
        bin.min = clamp(bin.min / globalPeak, -1, 1);
        bin.max = clamp(bin.max / globalPeak, -1, 1);
        bin.rms = clamp(bin.rms / globalPeak, 0, 1);
      }
    }
  } else {
    // Absolute amplitude — never rescaled to this buffer's own peak, only
    // clamped: a float WAV's samples are not guaranteed to stay within [-1, 1].
    for (const bin of out) {
      bin.peak = clamp(bin.peak, 0, 1);
      bin.min = clamp(bin.min, -1, 1);
      bin.max = clamp(bin.max, -1, 1);
      bin.rms = clamp(bin.rms, 0, 1);
    }
  }
  for (const bin of out) {
    bin.low = clamp(Math.sqrt(bin.low / Math.max(globalLow, 1e-9)), 0, 1);
    bin.mid = clamp(Math.sqrt(bin.mid / Math.max(globalMid, 1e-9)), 0, 1);
    bin.bright = clamp(Math.sqrt(bin.bright / Math.max(globalBright, 1e-9)), 0, 1);
  }

  return out;
}

/**
 * Analyse a decoded buffer in-process. Unchanged behaviour and unchanged
 * signature; `opts.width` / `opts.bins` are the only additions (see
 * {@link binCountFor}).
 *
 * This is the SYNCHRONOUS path — it blocks the main thread for the length of
 * the analysis. Components should go through {@link analyzeBufferAsync},
 * which memoises and offloads to a Worker where one exists.
 */
export function analyzeBuffer(buffer: AudioBuffer, opts?: AnalyzeOptions): WaveBin[] {
  return analyzeChannels(
    getChannels(buffer),
    buffer.length,
    buffer.sampleRate,
    binsFor(buffer, opts),
    opts?.normalize ?? true,
  );
}

// ── memo + Worker offload ──────────────────────────────────────────────────

/**
 * Analysed bins, keyed by `${url}|${normalize}|${binCount}` — the full set of
 * inputs that decide the result. The second `DJSemanticWaveform` instance for
 * a deck therefore costs nothing at all, and re-mounting a deck's lane after a
 * layout change is free too.
 *
 * Small and LRU for the same reason as the decode cache: each entry is up to
 * 6,400 objects.
 */
const analysisMemo = new Map<string, WaveBin[]>();
const ANALYSIS_MEMO_MAX = 8;

/** One analysis in flight, shared by every caller of the same key. */
type AnalysisFlight = {
  promise: Promise<WaveBin[]>;
  /** Aborted once every caller has walked away. */
  controller: AbortController;
  /** Callers still waiting; one with no signal can never leave. */
  waiters: number;
};
/** In-flight analyses, so two instances mounting together share one. */
const analysisInFlight = new Map<string, AnalysisFlight>();

/** `analysisRate` belongs in the key: `analyzeChannels` feeds `sampleRate /
 *  stride` to `bandPower`, so the SAME file decoded at 44.1k and at 48k does
 *  not yield the same bands — and with the decode cache now able to hold both
 *  (see `djAudioCache`'s `cacheKeyFor`), both can reach this memo. */
function memoKey(url: string, normalize: boolean, bins: number, analysisRate: number): string {
  return `${url}|${normalize ? 'n' : 'a'}|${bins}|${analysisRate}`;
}

function rememberAnalysis(key: string, bins: WaveBin[]): WaveBin[] {
  analysisMemo.delete(key);
  analysisMemo.set(key, bins);
  while (analysisMemo.size > ANALYSIS_MEMO_MAX) {
    const oldest = analysisMemo.keys().next();
    if (oldest.done) break;
    analysisMemo.delete(oldest.value);
  }
  return bins;
}

/** Drop every memoised analysis for `url` (any normalize / any bin count),
 *  and disown any analysis of it still in flight. */
export function evictAnalysis(url: string): void {
  const prefix = `${url}|`;
  for (const key of [...analysisMemo.keys()]) if (key.startsWith(prefix)) analysisMemo.delete(key);
  for (const key of [...analysisInFlight.keys()]) if (key.startsWith(prefix)) analysisInFlight.delete(key);
}

function abortError(): Error {
  const err = new Error('The waveform analysis was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Memoised, in-process analysis. Returns the SAME array instance for repeat
 * calls with the same (url, normalize, binCount).
 *
 * Instrumented as `dj:analyze:<url>` so the main-thread cost of a miss shows
 * up on the DevTools timeline.
 */
export function analyzeBufferMemo(url: string, buffer: AudioBuffer, opts?: AnalyzeOptions): WaveBin[] {
  const normalize = opts?.normalize ?? true;
  const bins = binsFor(buffer, opts);
  const key = memoKey(url, normalize, bins, buffer.sampleRate);
  const hit = analysisMemo.get(key);
  if (hit) {
    analysisMemo.delete(key);
    analysisMemo.set(key, hit);
    return hit;
  }
  const result = measureSync(`dj:analyze:${url}`, () =>
    analyzeChannels(getChannels(buffer), buffer.length, buffer.sampleRate, bins, normalize),
  );
  return rememberAnalysis(key, result);
}

/** What the main thread posts to the Worker. `channels` rides along only when
 *  the Worker does not already hold `dataKey`'s audio; `drop` tells it to let
 *  go of what it holds. */
export type AnalyzeRequest =
  | {
      type: 'analyze';
      id: number;
      dataKey: string;
      channels?: Float32Array[];
      length: number;
      sampleRate: number;
      bins: number;
      normalize: boolean;
    }
  | { type: 'drop'; dataKey: string | null };
/** What the Worker answers. `missing`: it no longer holds the audio for the
 *  request's `dataKey`, so the channel data has to be sent. */
export type AnalyzeResponse =
  | { id: number; bins: WaveBin[] }
  | { id: number; error: string }
  | { id: number; missing: true };

/** How long the Worker keeps the channel data of the last buffer it
 *  analysed. A resize, a zoom or a `normalize` flip that asks for another
 *  analysis of the same audio inside that window sends no audio at all; the
 *  main thread used to copy the whole decoded buffer (~74 MB for a 3.5-minute
 *  stereo track) on every one of them. One buffer, briefly, so the Worker
 *  never holds decoded audio nobody is looking at. */
export const WORKER_RETAIN_MS = 15_000;
/** The main thread stops counting on the Worker's copy this long before the
 *  Worker drops it, so the two clocks never disagree about who holds what. */
const WORKER_RETAIN_MARGIN_MS = 2_000;
/** A Worker that has requests to answer and says nothing for this long is
 *  stuck. One analysis is bounded by {@link MAX_BINS} bins of at most 512
 *  samples each — well under a second — so this is generous. */
export const WORKER_SILENCE_MS = 15_000;
/** Worker deaths (an `error`, an undeliverable reply, silence) tolerated per
 *  session. Each one is retried on a fresh Worker; after this many the
 *  in-process path is used for good. One error used to end the Worker for the
 *  rest of the session. */
export const MAX_WORKER_FAILURES = 3;

let analysisWorker: Worker | null = null;
let workerUnavailable = false;
let workerFailures = 0;
let nextRequestId = 1;
/** The audio the Worker holds, and until when the main thread counts on it. */
let workerHeld: { dataKey: string; url: string; until: number } | null = null;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

type PendingAnalysis = {
  resolve: (bins: WaveBin[]) => void;
  reject: (err: Error) => void;
  /** The Worker answered `missing`: send the channel data (once). */
  onMissing: () => void;
};
const pendingRequests = new Map<number, PendingAnalysis>();

/** How many analyses are waiting on the Worker right now. Introspection for
 *  tests only — a request that is registered and never resolved, rejected or
 *  removed is a leaked closure pair, and nothing else can observe that. */
export function pendingAnalysisCount(): number {
  return pendingRequests.size;
}

/** How many times the Worker has died this session. Introspection for tests. */
export function analysisWorkerFailures(): number {
  return workerFailures;
}

/** The Worker died; callers that were waiting on it retry on a fresh one. */
class WorkerDied extends Error {}

/** (Re)start the silence watch: while anything is pending, a Worker that
 *  says nothing for {@link WORKER_SILENCE_MS} is treated as dead. */
function armSilenceWatch(): void {
  if (silenceTimer !== null) clearTimeout(silenceTimer);
  silenceTimer = null;
  if (pendingRequests.size === 0 || !analysisWorker) return;
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    if (pendingRequests.size > 0) failWorker('the waveform analysis worker stopped answering');
  }, WORKER_SILENCE_MS);
}

/** TERMINATE the Worker (dereferencing alone leaves the thread and its copy
 *  of the channel data alive). Not a failure: the next analysis builds a new
 *  one. */
function stopWorker(): void {
  analysisWorker?.terminate();
  analysisWorker = null;
  workerHeld = null;
  if (silenceTimer !== null) clearTimeout(silenceTimer);
  silenceTimer = null;
}

/**
 * The Worker died (an `error`, an undeliverable reply, or silence): terminate
 * it and fail everything waiting on it with {@link WorkerDied}, which the
 * callers retry on a fresh Worker. After {@link MAX_WORKER_FAILURES} deaths
 * no more Workers are built and callers use the synchronous path.
 */
function failWorker(reason: string): void {
  workerFailures += 1;
  if (workerFailures >= MAX_WORKER_FAILURES) workerUnavailable = true;
  stopWorker();
  const waiting = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const request of waiting) request.reject(new WorkerDied(reason));
}

/**
 * The shared analysis Worker, or `null` where Workers do not exist — inside a
 * Worker itself (no `document`), under node/tsx in the test suite, if
 * construction throws (a CSP that forbids worker blobs, say), or once
 * {@link MAX_WORKER_FAILURES} Workers have died. Every caller falls back to
 * the synchronous path in that case.
 */
function getAnalysisWorker(): Worker | null {
  if (analysisWorker) return analysisWorker;
  if (workerUnavailable) return null;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    workerUnavailable = true;
    return null;
  }
  try {
    const worker = new Worker(new URL('./djSemanticWaveform.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      // A reply from a Worker that was stopped in the meantime answers
      // nothing anyone is still waiting for.
      if (worker !== analysisWorker) return;
      const data = event.data;
      const waiting = pendingRequests.get(data.id);
      if (waiting) {
        if ('missing' in data) {
          waiting.onMissing();
        } else {
          pendingRequests.delete(data.id);
          if ('error' in data) waiting.reject(new Error(data.error));
          else waiting.resolve(data.bins);
        }
      }
      armSilenceWatch();
    };
    // BOTH error channels, not just `onerror`. `onmessageerror` fires when a
    // reply cannot be DESERIALISED on this side; it never reaches `onmessage`,
    // so an unhandled one leaves the request that caused it pending forever
    // and the lane blank.
    const died = () => {
      if (worker === analysisWorker) failWorker('the waveform analysis worker failed');
    };
    worker.onerror = died;
    worker.onmessageerror = died;
    analysisWorker = worker;
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** Which audio a request is about: one decoded buffer of one URL. */
function dataKeyOf(url: string, buffer: AudioBuffer): string {
  return `${url}@${buffer.sampleRate}@${buffer.length}`;
}

/** Tell the Worker to let go of the audio it holds for `url` (every URL for
 *  `null`), e.g. because the decode cache evicted it. */
function dropWorkerAudio(url: string | null): void {
  if (!workerHeld || (url !== null && workerHeld.url !== url)) return;
  const request: AnalyzeRequest = { type: 'drop', dataKey: workerHeld.dataKey };
  workerHeld = null;
  try {
    analysisWorker?.postMessage(request);
  } catch {
    /* a Worker that cannot take a message is stopped on its next failure */
  }
}

/**
 * Post one analysis to `worker` and wait for its bins.
 *
 * The channel data is COPIED (the copies are transferred, never the
 * `AudioBuffer`'s own arrays — transferring those would detach them and
 * destroy the buffer the engine is playing), and only when the Worker does
 * not already hold this buffer's audio (see {@link WORKER_RETAIN_MS}). A
 * Worker that turns out not to have it answers `missing` and gets it once.
 *
 * Aborting `signal` withdraws the request; when nothing else is waiting on
 * the Worker it is stopped, so an analysis nobody wants stops using a core.
 */
function postToWorker(
  worker: Worker,
  url: string,
  buffer: AudioBuffer,
  bins: number,
  normalize: boolean,
  signal: AbortSignal,
): Promise<WaveBin[]> {
  return new Promise<WaveBin[]>((resolve, reject) => {
    const id = nextRequestId++;
    const dataKey = dataKeyOf(url, buffer);
    let resent = false;

    const send = (withAudio: boolean) => {
      const channels = withAudio ? getChannels(buffer).map((ch) => new Float32Array(ch)) : undefined;
      const request: AnalyzeRequest = {
        type: 'analyze',
        id,
        dataKey,
        channels,
        length: buffer.length,
        sampleRate: buffer.sampleRate,
        bins,
        normalize,
      };
      worker.postMessage(request, channels ? channels.map((ch) => ch.buffer) : []);
      const until = Date.now() + WORKER_RETAIN_MS - WORKER_RETAIN_MARGIN_MS;
      if (withAudio) workerHeld = { dataKey, url, until };
      else if (workerHeld?.dataKey === dataKey) workerHeld.until = until;
    };

    const settle = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (!pendingRequests.delete(id)) return;
      reject(abortError());
      if (pendingRequests.size === 0) stopWorker();
      else armSilenceWatch();
    };

    pendingRequests.set(id, {
      resolve: (result) => {
        settle();
        resolve(result);
      },
      reject: (err) => {
        settle();
        reject(err);
      },
      onMissing: () => {
        const give = (err: Error) => {
          pendingRequests.delete(id);
          settle();
          reject(err);
        };
        if (resent) {
          give(new Error('the waveform analysis worker lost the audio twice'));
          return;
        }
        resent = true;
        try {
          send(true);
        } catch (err) {
          give(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const held = workerHeld !== null && workerHeld.dataKey === dataKey && Date.now() < workerHeld.until;
      send(!held);
    } catch (err) {
      // Structured clone can refuse the payload outright (a detached buffer,
      // say) and throws SYNCHRONOUSLY. The entry was registered above and no
      // reply will ever clear it, so it has to come back out here.
      pendingRequests.delete(id);
      settle();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    armSilenceWatch();
  });
}

/** The analysis on a Worker, retried on a fresh Worker each time one dies,
 *  until {@link MAX_WORKER_FAILURES}; throws when no Worker can do it. */
async function analyzeOffThread(
  url: string,
  buffer: AudioBuffer,
  bins: number,
  normalize: boolean,
  signal: AbortSignal,
): Promise<WaveBin[]> {
  for (;;) {
    const worker = getAnalysisWorker();
    if (!worker) throw new Error('no waveform analysis worker');
    try {
      return await postToWorker(worker, url, buffer, bins, normalize, signal);
    } catch (err) {
      if (err instanceof WorkerDied && !signal.aborted) continue;
      throw err;
    }
  }
}

/** Join `flight` as one more waiter; see `djAudioCache`'s `join`, which this
 *  mirrors: the last caller out aborts the shared work. */
function joinAnalysis(flight: AnalysisFlight, key: string, signal: AbortSignal | null): Promise<WaveBin[]> {
  flight.waiters += 1;
  if (!signal) return flight.promise;
  return new Promise<WaveBin[]>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      flight.waiters -= 1;
      if (flight.waiters <= 0) {
        if (analysisInFlight.get(key) === flight) analysisInFlight.delete(key);
        flight.controller.abort();
      }
      reject(abortError());
    };
    signal.addEventListener('abort', leave, { once: true });
    flight.promise.then(
      (result) => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', leave);
        resolve(result);
      },
      (err: unknown) => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', leave);
        reject(err);
      },
    );
  });
}

/**
 * Analysed bins for `url`, off the main thread wherever that is possible.
 *
 * Order of preference:
 *  1. the memo — a repeat (url, normalize, binCount) costs nothing;
 *  2. an in-flight request for the same key — the deck's two waveform
 *     instances mount together and must not analyse the same audio twice;
 *  3. the Worker (see {@link postToWorker}), retried on a fresh Worker when
 *     one dies;
 *  4. the synchronous path, when no Worker exists, every retry failed, or the
 *     Worker reported an error for this analysis.
 *
 * `opts.signal` withdraws this caller; the analysis itself stops once nobody
 * is waiting for it, and nothing is memoised for it.
 */
export function analyzeBufferAsync(url: string, buffer: AudioBuffer, opts?: AnalyzeOptions): Promise<WaveBin[]> {
  const normalize = opts?.normalize ?? true;
  const bins = binsFor(buffer, opts);
  const key = memoKey(url, normalize, bins, buffer.sampleRate);
  const signal = opts?.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortError());

  const hit = analysisMemo.get(key);
  if (hit) {
    analysisMemo.delete(key);
    analysisMemo.set(key, hit);
    return Promise.resolve(hit);
  }

  let flight = analysisInFlight.get(key);
  if (!flight) {
    const controller = new AbortController();
    // Declared above the task because TypeScript 7 reports TS2448 when the
    // immediately invoked task reads a const declared below it. The task
    // reads `created` only after its first await (analyzeOffThread is async,
    // so even a failure settles on a later microtask), and the assignment
    // below has always run by then.
    let created: AnalysisFlight | null = null;
    const promise = (async () => {
      let result: WaveBin[];
      try {
        result = await analyzeOffThread(url, buffer, bins, normalize, controller.signal);
      } catch {
        if (controller.signal.aborted) throw abortError();
        // Worker refused, reported an error, or died too often — analyse
        // in-process rather than show nothing.
        result = measureSync(`dj:analyze:${url}`, () =>
          analyzeChannels(getChannels(buffer), buffer.length, buffer.sampleRate, bins, normalize),
        );
      }
      // An eviction while this ran disowned it: answer the callers, keep
      // nothing.
      return analysisInFlight.get(key) === created ? rememberAnalysis(key, result) : result;
    })().finally(() => {
      if (analysisInFlight.get(key) === created) analysisInFlight.delete(key);
    });
    // Every caller may have walked away; the abort must not surface as an
    // unhandled rejection.
    promise.catch(() => undefined);
    created = { promise, controller, waiters: 0 };
    flight = created;
    analysisInFlight.set(key, created);
  }
  return joinAnalysis(flight, key, signal);
}

// Audio the decode cache lets go of is not analysed or held any more either.
onEvict((url) => {
  if (url === null) {
    analysisMemo.clear();
    analysisInFlight.clear();
  } else {
    evictAnalysis(url);
  }
  dropWorkerAudio(url);
});

type SliceStats = {
  peak: number;
  rms: number;
  min: number;
  max: number;
  low: number;
  mid: number;
  bright: number;
  transient: number;
  color: string;
  clipped: number;
};

function sliceStats(bins: WaveBin[], start: number, end: number): SliceStats {
  const first = bins[start] ?? bins[0];
  let strongest = first;
  let peak = 0;
  let rms = 0;
  let min = 0;
  let max = 0;
  let low = 0;
  let mid = 0;
  let bright = 0;
  let transient = 0;
  let clipped = 0;
  let count = 0;

  for (let i = start; i < end; i += 1) {
    const bin = bins[i] ?? first;
    count += 1;
    if (bin.peak > peak) {
      peak = bin.peak;
      strongest = bin;
    }
    rms += bin.rms;
    if (bin.min < min) min = bin.min;
    if (bin.max > max) max = bin.max;
    if (bin.low > low) low = bin.low;
    mid += bin.mid;
    bright += bin.bright;
    if (bin.transient > transient) transient = bin.transient;
    clipped += bin.clipped;
  }

  return {
    peak,
    rms: rms / Math.max(1, count),
    min,
    max,
    low,
    mid: mid / Math.max(1, count),
    bright: bright / Math.max(1, count),
    transient,
    color: strongest.color,
    clipped,
  };
}

function fillSymmetricBar(ctx: CanvasRenderingContext2D, x: number, center: number, topHalf: number, bottomHalf: number, width: number): void {
  ctx.fillRect(x, center - topHalf, width, Math.max(1, topHalf + bottomHalf));
}

/** The opaque panel background. Skipped for `transparentBg` callers (FE-021). */
function paintBackgroundGradient(ctx: CanvasRenderingContext2D, width: number, pixelHeight: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  bg.addColorStop(0, '#06070d');
  bg.addColorStop(0.5, '#0e1018');
  bg.addColorStop(1, '#05060a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, pixelHeight);
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  box: CanvasBox,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  transparent = false,
  decodeError: string | null = null,
  mode: WaveformDrawMode = 'semantic',
): void {
  // The canvas stretches with `absolute inset-0 h-full w-full`, so only the
  // backing store is set here; an inline width in viewport px would apply the
  // shell zoom a second time and shrink the wave away from the playhead.
  applyCanvasBox(canvas, box);
  // Kept unrounded so the painted extent matches the backing store exactly; the
  // per-column loop below still steps in whole units.
  const width = box.cssWidth;
  const pixelHeight = box.cssHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  scaleContextToBox(ctx, box);
  ctx.clearRect(0, 0, width, pixelHeight);

  // `transparentBg` callers (e.g. SemanticWave embedded over an already
  // coloured panel) need the caller's background to actually show through;
  // painting this gradient unconditionally defeated that (FE-021).
  if (!transparent) paintBackgroundGradient(ctx, width, pixelHeight);

  if (decodeError) {
    // A failed decode used to fall through to the exact same thin centre
    // line as "no data yet", so a broken audio URL was silently invisible
    // (FE-011). Paint a distinct, visible failure state instead.
    ctx.fillStyle = 'rgba(255, 89, 64, 0.16)';
    ctx.fillRect(0, 0, width, pixelHeight);
    ctx.strokeStyle = 'rgba(255, 89, 64, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, pixelHeight - 1));
    if (width >= 60) {
      ctx.fillStyle = 'rgba(255, 210, 200, 0.9)';
      // Bold 12 px at the least: a 9 px label on a short lane was too small
      // to read, and the failure state exists to be seen.
      ctx.font = `bold ${Math.max(12, Math.min(14, pixelHeight * 0.4))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waveform unavailable', width / 2, pixelHeight / 2);
    }
    return;
  }

  if (bins.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, pixelHeight / 2 - 0.5, width, 1);
    return;
  }

  const center = pixelHeight / 2;
  paintGuides(ctx, width, center);
  drawWaveBody(ctx, width, pixelHeight, bins, viewportStart, viewportEnd, mode);
  paintSpine(ctx, width, center);
  paintVignette(ctx, width, pixelHeight);
}

/** The three faint horizontal rules under the wave. */
function paintGuides(ctx: CanvasRenderingContext2D, width: number, center: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, Math.floor(center * 0.5), width, 1);
  ctx.fillRect(0, Math.floor(center * 1.5), width, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.055)';
  ctx.fillRect(0, center - 0.5, width, 1);
}

/**
 * The per-column waveform render — everything between the guide rules and the
 * spine, exactly as it always was.
 *
 * Extracted (DJ-2) so {@link drawWaveformCached} can render the window around
 * a moving viewport ONCE into an offscreen canvas and then blit slices as the
 * viewport moves. `drawWaveform` calls it in the same place with the same
 * arguments, so its output is unchanged.
 *
 * `mode` defaults to 'semantic' and that branch is byte-for-byte what this
 * function always did — every existing caller that doesn't pass it keeps
 * its exact output (the pre-DJ-2 golden in DJSemanticWaveform.b12.test.ts
 * pins this). 'plain'/'clipping' are a deliberately cheaper second path:
 * one flat body colour, no frequency-glow layers, no beat rail.
 */
function drawWaveBody(
  ctx: CanvasRenderingContext2D,
  width: number,
  pixelHeight: number,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  mode: WaveformDrawMode = 'semantic',
): void {
  const center = pixelHeight / 2;
  const maxBar = Math.max(3, pixelHeight * 0.47);
  if (mode !== 'semantic') {
    drawWaveBodyFlat(ctx, width, pixelHeight, bins, viewportStart, viewportEnd, mode, center, maxBar);
    return;
  }

  const spanNorm = Math.max(0.001, viewportEnd - viewportStart);

  ctx.globalCompositeOperation = 'lighter';
  for (let x = 0; x < width; x += 1) {
    const startNorm = viewportStart + (x / width) * spanNorm;
    const endNorm = viewportStart + ((x + 1) / width) * spanNorm;
    if (endNorm <= 0 || startNorm >= 1) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.13)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }
    const start = Math.floor(clamp(startNorm, 0, 0.999) * bins.length);
    const end = Math.max(start + 1, Math.ceil(clamp(endNorm, 0.001, 1) * bins.length));
    const bin = sliceStats(bins, start, end);
    const amp = Math.pow(clamp(bin.peak, 0, 1), 0.58);
    const minHalf = Math.max(1, Math.abs(bin.min) * maxBar);
    const maxHalf = Math.max(1, Math.abs(bin.max) * maxBar);
    const fallbackHalf = Math.max(1.25, amp * maxBar);
    const upper = Math.max(maxHalf, fallbackHalf * 0.72);
    const lower = Math.max(minHalf, fallbackHalf * 0.72);

    if (amp < 0.012) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.24)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }

    const semanticAlpha = clamp(0.26 + amp * 0.34 + bin.rms * 0.22, 0.28, 0.86);
    const lowAlpha = clamp(0.04 + bin.low * 0.34 + amp * 0.08, 0.05, 0.48);
    const midAlpha = clamp(0.04 + bin.mid * 0.44 + bin.rms * 0.28, 0.06, 0.6);
    const brightAlpha = clamp(0.03 + bin.bright * 0.5 + bin.transient * 0.16, 0.04, 0.62);
    const transientAlpha = clamp((bin.transient - 0.24) * 0.82 + amp * 0.08, 0, 0.66);

    ctx.fillStyle = semanticRgba(bin.color, semanticAlpha);
    fillSymmetricBar(ctx, x, center, upper, lower, 1);

    const lowHalf = Math.max(1, fallbackHalf * clamp(0.52 + bin.low * 0.34, 0.42, 0.86));
    ctx.fillStyle = `rgba(30, 144, 255, ${lowAlpha})`;
    fillSymmetricBar(ctx, x, center, lowHalf, lowHalf, 1);

    const midHalf = Math.max(1, fallbackHalf * clamp(0.34 + bin.mid * 0.42, 0.28, 0.72));
    ctx.fillStyle = `rgba(76, 241, 112, ${midAlpha})`;
    fillSymmetricBar(ctx, x, center, midHalf, midHalf, 1);

    const brightHalf = Math.max(1, fallbackHalf * clamp(0.16 + bin.bright * 0.36, 0.14, 0.5));
    ctx.fillStyle = `rgba(255, 182, 65, ${brightAlpha})`;
    fillSymmetricBar(ctx, x, center, brightHalf, brightHalf, 1);

    if (transientAlpha > 0.03) {
      ctx.fillStyle = `rgba(255, 246, 210, ${transientAlpha})`;
      fillSymmetricBar(ctx, x, center, Math.max(1, upper * 0.96), Math.max(1, lower * 0.96), 1);
    }

    if (bin.color === BEAT) {
      const rail = Math.max(1, Math.round(1 + bin.low * 3 + bin.transient * 2));
      ctx.fillStyle = `rgba(255, 89, 64, ${clamp(0.18 + bin.low * 0.4 + bin.transient * 0.34, 0.2, 0.86)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    } else if (bin.low > 0.56) {
      const rail = Math.max(1, Math.round(1 + bin.low * 2));
      ctx.fillStyle = `rgba(46, 169, 255, ${clamp(0.12 + bin.low * 0.35, 0.18, 0.58)})`;
      ctx.fillRect(x, pixelHeight - rail - 1, 1, rail);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** 'plain'/'clipping' body: the same per-column amplitude bar as the
 *  semantic path, one flat colour, no frequency-glow layers or beat rail.
 *  'clipping' recolours a column red when any bin under it holds a clipped
 *  sample ({@link WaveBin.clipped}) — everything else about the shape is
 *  identical between the two modes, so switching modes never moves a single
 *  pixel of the outline, only its colour. */
function drawWaveBodyFlat(
  ctx: CanvasRenderingContext2D,
  width: number,
  pixelHeight: number,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  mode: 'plain' | 'clipping',
  center: number,
  maxBar: number,
): void {
  const spanNorm = Math.max(0.001, viewportEnd - viewportStart);
  const [pr, pg, pb] = PLAIN_BODY;
  const [cr, cg, cb] = CLIP_BODY;

  for (let x = 0; x < width; x += 1) {
    const startNorm = viewportStart + (x / width) * spanNorm;
    const endNorm = viewportStart + ((x + 1) / width) * spanNorm;
    if (endNorm <= 0 || startNorm >= 1) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.13)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }
    const start = Math.floor(clamp(startNorm, 0, 0.999) * bins.length);
    const end = Math.max(start + 1, Math.ceil(clamp(endNorm, 0.001, 1) * bins.length));
    const bin = sliceStats(bins, start, end);
    const amp = Math.pow(clamp(bin.peak, 0, 1), 0.58);

    if (amp < 0.012) {
      ctx.fillStyle = 'rgba(72, 83, 100, 0.24)';
      fillSymmetricBar(ctx, x, center, 1, 1, 1);
      continue;
    }

    const minHalf = Math.max(1, Math.abs(bin.min) * maxBar);
    const maxHalf = Math.max(1, Math.abs(bin.max) * maxBar);
    const fallbackHalf = Math.max(1.25, amp * maxBar);
    const upper = Math.max(maxHalf, fallbackHalf * 0.72);
    const lower = Math.max(minHalf, fallbackHalf * 0.72);
    const alpha = clamp(0.3 + amp * 0.4 + bin.rms * 0.22, 0.32, 0.92);

    const clipped = mode === 'clipping' && bin.clipped > 0;
    const [r, g, b] = clipped ? [cr, cg, cb] : [pr, pg, pb];
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${clipped ? Math.max(alpha, 0.7) : alpha})`;
    fillSymmetricBar(ctx, x, center, upper, lower, 1);
  }
}

function paintSpine(ctx: CanvasRenderingContext2D, width: number, center: number): void {
  const spine = ctx.createLinearGradient(0, 0, width, 0);
  spine.addColorStop(0, 'rgba(255,255,255,0.04)');
  spine.addColorStop(0.5, 'rgba(255,255,255,0.32)');
  spine.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.fillStyle = spine;
  ctx.fillRect(0, center - 0.5, width, 1);
}

function paintVignette(ctx: CanvasRenderingContext2D, width: number, pixelHeight: number): void {
  const vignette = ctx.createLinearGradient(0, 0, 0, pixelHeight);
  vignette.addColorStop(0, 'rgba(0,0,0,0.34)');
  vignette.addColorStop(0.12, 'rgba(0,0,0,0)');
  vignette.addColorStop(0.88, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.36)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, pixelHeight);
}

// ── viewport repaint: draw the window around the viewport, blit thereafter ──

/** Widest canvas this module draws into, in device px — the window render
 *  below and, through {@link canvasWindowFor}, the visible canvas itself.
 *  Browsers refuse a backing store much past 32,767 px, and the old 8,192 px
 *  clamp resampled the zoomed lane and EDIT chops into a blur; this is wide
 *  enough for any real lane at full resolution. */
export const MAX_CANVAS_DEVICE_WIDTH = 16384;

/** How far past the viewport the window render reaches, in viewport widths:
 *  a little behind and most of the way ahead of the direction of travel, so a
 *  playing deck re-renders about once every 1.75 screens of audio. */
const WINDOW_BEHIND = 0.25;
const WINDOW_AHEAD = 1.75;

/** One rendered window of a lane's waveform. */
type LaneWindow = {
  canvas: HTMLCanvasElement;
  /** The track range it covers, in 0..1, aligned to whole device px. */
  start: number;
  end: number;
  /** Device px per unit of track at this zoom. */
  devicePerNorm: number;
  deviceWidth: number;
};

/** What a lane drew last: its geometry (everything but where the viewport
 *  starts), the bins, the viewport start, and the window, when there is one. */
type LaneState = {
  geometry: string;
  bins: WaveBin[];
  lastStart: number;
  window: LaneWindow | null;
};

/**
 * Per visible canvas, so one lane's zoom never touches another lane's render.
 * The old cache was one 4-entry LRU for every waveform on the page keyed by
 * zoom: continuous wheel zoom minted a new key per wheel event and pushed the
 * other deck's render out, which then re-rendered its whole track on its next
 * frame. A WeakMap entry goes away with its canvas.
 */
const laneStates = new WeakMap<HTMLCanvasElement, LaneState>();

/**
 * Render the window around the viewport, `[start - behind, end + ahead]`
 * viewport widths, at the lane's own zoom and device resolution. One column
 * per CSS px, exactly the columns {@link drawWaveBody} draws on the lane, so
 * blitting a slice is a 1:1 copy.
 */
function renderWindow(
  box: CanvasBox,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  mode: WaveformDrawMode,
  forward: boolean,
  reuse: HTMLCanvasElement | null,
): LaneWindow | null {
  if (typeof document === 'undefined') return null;
  const span = viewportEnd - viewportStart;
  const laneDevice = box.cssWidth * box.scale;
  const devicePerNorm = laneDevice / span;
  let behind = forward ? WINDOW_BEHIND : WINDOW_AHEAD;
  let ahead = forward ? WINDOW_AHEAD : WINDOW_BEHIND;
  // Shrink the margins, never the lane itself, when the window would not fit.
  const room = MAX_CANVAS_DEVICE_WIDTH / laneDevice - 1;
  if (behind + ahead > room) {
    const scale = Math.max(0, room) / (behind + ahead);
    behind *= scale;
    ahead *= scale;
  }
  const startDevice = Math.floor(clamp(viewportStart - behind * span, 0, 1) * devicePerNorm);
  const endDevice = Math.ceil(clamp(viewportEnd + ahead * span, 0, 1) * devicePerNorm);
  const deviceWidth = endDevice - startDevice;
  if (deviceWidth <= 0) return null;

  const canvas = reuse ?? document.createElement('canvas');
  canvas.width = deviceWidth;
  canvas.height = box.deviceHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const start = startDevice / devicePerNorm;
  const end = endDevice / devicePerNorm;
  const cssWidth = deviceWidth / box.scale;
  ctx.setTransform(box.scale, 0, 0, box.scale, 0, 0);
  ctx.clearRect(0, 0, cssWidth, box.cssHeight);
  // The body only — background, guides, spine and vignette are painted per
  // frame on the real canvas so they stay anchored to the visible lane rather
  // than scrolling with the audio.
  drawWaveBody(ctx, cssWidth, box.cssHeight, bins, start, end, mode);
  return { canvas, start, end, devicePerNorm, deviceWidth };
}

/**
 * {@link drawWaveform} for a lane whose viewport moves.
 *
 * A playing deck moves its viewport ~6 times a second, and every one of those
 * used to re-run the full per-column render. Here, once a lane has scrolled
 * at a steady zoom, the window around its viewport (see {@link renderWindow})
 * is drawn once into an offscreen canvas at full device resolution, and every
 * frame after that is one `drawImage` from it until the viewport leaves the
 * window. Everything else is drawn directly, which costs exactly what the
 * visible lane costs:
 *
 *  - a viewport covering the WHOLE track, a decode error, no bins;
 *  - the first frame after the zoom, the size, the mode or the bins changed —
 *    so continuous wheel zoom costs one lane-width of columns per event, not
 *    a render of the whole track at the new zoom;
 *  - a lane whose viewport does not move (an EDIT clip's trim window), which
 *    therefore never allocates an offscreen canvas at all.
 *
 * The detail lane over-scrolls half a screen past both ends of the track
 * (`viewMin = -visibleFrac / 2`); the blit covers only the part with audio
 * behind it and the rest of the lane keeps its background, exactly as
 * `drawWaveBody`'s own out-of-range columns look.
 *
 * State is kept per visible canvas, so nothing one lane does can evict or
 * repaint another.
 *
 * @param cacheKey identifies the ANALYSIS behind `bins` — `${audioUrl}|${normalize}`.
 */
export function drawWaveformCached(
  canvas: HTMLCanvasElement,
  box: CanvasBox,
  bins: WaveBin[],
  viewportStart: number,
  viewportEnd: number,
  transparent: boolean,
  decodeError: string | null,
  cacheKey: string,
  mode: WaveformDrawMode = 'semantic',
): void {
  const width = box.cssWidth;
  const pixelHeight = box.cssHeight;
  const span = viewportEnd - viewportStart;
  const visibleStart = clamp(viewportStart, 0, 1);
  const visibleEnd = clamp(viewportEnd, 0, 1);
  const visibleSpan = visibleEnd - visibleStart;

  const windowable =
    !decodeError &&
    bins.length > 0 &&
    span > 0 &&
    visibleSpan > 0 &&
    width > 0 &&
    !(viewportStart <= 0 && viewportEnd >= 1);
  if (!windowable) {
    laneStates.delete(canvas);
    drawWaveform(canvas, box, bins, viewportStart, viewportEnd, transparent, decodeError, mode);
    return;
  }

  // `mode` in the geometry: a rendered window is rasterised body, and a body
  // rendered in one mode is the wrong pixels for another. The span is taken
  // to 9 significant digits: callers pass `viewStart + visibleFrac` as the
  // end, so the raw difference wobbles in its last bits as the viewport moves
  // (0.335 - 0.21 is 0.12500000000000003) and a raw key would call every
  // frame of a steady zoom a new zoom.
  const geometry = `${cacheKey}|${width}|${pixelHeight}|${box.scale}|${span.toPrecision(9)}|${mode}`;
  const prev = laneStates.get(canvas);
  const steady = prev !== undefined && prev.geometry === geometry && prev.bins === bins;
  let win = steady ? prev.window : null;
  if (!win || visibleStart < win.start || visibleEnd > win.end) {
    const scrolling = steady && prev.lastStart !== viewportStart;
    win = scrolling
      ? renderWindow(box, bins, viewportStart, viewportEnd, mode, viewportStart >= prev.lastStart, prev.window?.canvas ?? null)
      : null;
    if (!win) {
      laneStates.set(canvas, { geometry, bins, lastStart: viewportStart, window: null });
      drawWaveform(canvas, box, bins, viewportStart, viewportEnd, transparent, decodeError, mode);
      return;
    }
  }
  laneStates.set(canvas, { geometry, bins, lastStart: viewportStart, window: win });

  applyCanvasBox(canvas, box);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  scaleContextToBox(ctx, box);
  ctx.clearRect(0, 0, width, pixelHeight);
  if (!transparent) paintBackgroundGradient(ctx, width, pixelHeight);
  paintGuides(ctx, width, pixelHeight / 2);

  // Source: whole device pixels of the in-range slice, 1:1 with the lane.
  const sx = clamp(Math.round((visibleStart - win.start) * win.devicePerNorm), 0, Math.max(0, win.deviceWidth - 1));
  const sw = Math.max(1, Math.min(Math.round(visibleSpan * win.devicePerNorm), win.deviceWidth - sx));
  // Destination: the slice of the LANE that in-range part occupies. Anything
  // the viewport covers beyond either end of the track is left as the
  // background painted above.
  const dx = ((visibleStart - viewportStart) / span) * width;
  const dw = (visibleSpan / span) * width;
  // The body was composited additively onto transparency; replaying it over
  // the background with the same operator keeps the blend it was drawn with.
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(win.canvas, sx, 0, sw, box.deviceHeight, dx, 0, dw, pixelHeight);
  ctx.globalCompositeOperation = 'source-over';

  paintSpine(ctx, width, pixelHeight / 2);
  paintVignette(ctx, width, pixelHeight);
}

/**
 * Where to put a waveform's visible canvas inside a lane wrapper that is too
 * wide to back with one canvas, in the wrapper's own CSS px — or `null` when
 * the wrapper fits and the canvas should simply fill it.
 *
 * The EDIT timeline sizes a clip's box to its duration times the zoom, so a
 * 220 s clip at 400 px/s is an 88,000 px box. A canvas that fills it asks for
 * a backing store no browser will allocate, and the clip drew as a blank
 * rectangle. The canvas instead covers the part of the wrapper that is on
 * screen, plus up to one visible width either side so small scrolls need no
 * redraw, never more than {@link MAX_CANVAS_DEVICE_WIDTH} device px.
 *
 * All inputs but `zoom` and `dpr` are viewport px (`getBoundingClientRect`);
 * `visibleLeft`/`visibleRight` are the on-screen part of the wrapper after
 * every clipping ancestor. Exported for tests.
 */
export function canvasWindowFor(opts: {
  wrapLeft: number;
  wrapWidth: number;
  visibleLeft: number;
  visibleRight: number;
  zoom: number;
  dpr: number;
}): { left: number; width: number } | null {
  const zoom = opts.zoom > 0 ? opts.zoom : 1;
  const scale = zoom * (opts.dpr > 0 ? opts.dpr : 1);
  const cssWrap = opts.wrapWidth / zoom;
  if (!(cssWrap > 0) || cssWrap * scale <= MAX_CANVAS_DEVICE_WIDTH) return null;
  const maxCss = MAX_CANVAS_DEVICE_WIDTH / scale;
  const visLeft = clamp((opts.visibleLeft - opts.wrapLeft) / zoom, 0, cssWrap);
  const visRight = clamp((opts.visibleRight - opts.wrapLeft) / zoom, 0, cssWrap);
  const visible = Math.max(0, visRight - visLeft);
  const width = Math.max(1, Math.min(maxCss, visible * 3, cssWrap));
  const margin = Math.max(0, (width - visible) / 2);
  const left = clamp(visLeft - margin, 0, Math.max(0, cssWrap - width));
  return { left, width };
}
