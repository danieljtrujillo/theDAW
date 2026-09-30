/**
 * Round-trip latency: the probe signal, and the cross-correlation that finds it
 * again in what the microphone heard.
 *
 * The question this answers is the one the TAP calibrator
 * (`components/layout/score/playAlong/latencyMath.ts`) cannot: a tap measures a
 * HUMAN against a click and is therefore a visual offset, good to a few tens of
 * milliseconds. Placing a recorded take on the grid needs the machine's own
 * loop — scheduled sample out of the DAC, through the air (or a cable), back in
 * through the ADC and into a capture buffer — which is a fixed property of the
 * device stack and is measurable to the sample.
 *
 * The method is a matched filter, i.e. textbook normalized cross-correlation:
 * play a signal we already hold in an array, capture, and slide the two past
 * each other looking for the lag where they line up. Written here from the
 * mathematical definition of the Pearson correlation coefficient — nothing is
 * taken from any reference DAW under `oss-refs/`; none of their files were
 * opened for this module.
 *
 * Why a direct (FFT-free) correlation
 * -----------------------------------
 * It is O(n·lag): the probe's length times the number of lags searched. A
 * 0.25 s probe against a 0.5 s window at 48 kHz is 12000 × 24001 ≈ 2.9e8
 * multiply-adds — a second or so of one worker-free main-thread pass, run ONCE
 * when the user presses a button, and that is the whole budget. An FFT would be
 * faster and much more code to be wrong in. `maxLagSec` is capped at
 * `MAX_LAG_CAP_SEC` precisely so this cost cannot be asked to grow without
 * bound; a device stack whose round trip exceeds one second is broken, not slow.
 *
 * Pure: no DOM, no audio nodes, no timers. `roundTripProbe.ts` is the half that
 * touches the browser. Keeping the arithmetic here is what lets it be tested
 * against synthetic captures under `node:assert` — see `roundTripLatency.test.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                                  the probe                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which signal to play.
 *   - `chirp` — a linear sweep. Its energy is spread over the whole duration
 *     and over the band, so it survives a quiet mic and a room; the default.
 *   - `clicks` — a handful of short bursts with silence between them. Quieter
 *     overall and much less annoying to sit through, and its correlation peak
 *     is just as sharp, but it needs a better SNR.
 */
export type ProbeKind = 'chirp' | 'clicks';

/** Probe length when the caller does not say, seconds. */
export const PROBE_DEFAULT_DURATION_SEC = 0.25;
/** Peak sample of the generated probe. Leaves headroom on the way out; the
 *  caller applies whatever further gain it wants. */
export const PROBE_PEAK = 0.5;
/** Raised-cosine fade at each end of the chirp, seconds. A step into a sweep is
 *  an audible click AND a wideband smear across the correlation. */
export const PROBE_FADE_SEC = 0.005;
/** Sweep band. Clamped down on a low sample rate — see `makeProbe`. */
export const CHIRP_START_HZ = 200;
export const CHIRP_END_HZ = 8000;
/** One burst, seconds. */
export const CLICK_LENGTH_SEC = 0.003;
/**
 * Where the bursts sit, as fractions of the probe's duration.
 *
 * DELIBERATELY not evenly spaced: an evenly spaced train correlates with itself
 * at every multiple of its period, so a capture with a poor SNR can peak a
 * whole period away from the truth and look just as confident. Unequal gaps
 * mean only one alignment ever lines all four up.
 */
export const CLICK_OFFSETS: readonly number[] = [0, 0.23, 0.51, 0.86];

export interface ProbeOptions {
  kind?: ProbeKind;
  durationSec?: number;
}

/** A 32-bit LCG. Deterministic, so a probe is the SAME array every run — the
 *  reference has to be reproducible or a capture cannot be matched to it. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Hann window value at `i` of `n`. */
const hann = (i: number, n: number): number =>
  n <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

/**
 * One burst: a Hann-windowed pseudo-random noise burst, normalized to
 * `PROBE_PEAK`. Noise rather than a tone because a tone correlates with itself
 * once per cycle — at 2 kHz that is an ambiguity every half millisecond — while
 * a noise burst has a single spike.
 */
function clickBurst(lengthSamples: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  if (lengthSamples <= 0) return out;
  const rand = lcg(0x5eed1234);
  let peak = 0;
  for (let i = 0; i < lengthSamples; i += 1) {
    const v = (rand() * 2 - 1) * hann(i, lengthSamples);
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = PROBE_PEAK / peak;
    for (let i = 0; i < lengthSamples; i += 1) out[i] *= g;
  }
  return out;
}

/**
 * The reference signal, and the thing to play. An unusable sample rate or
 * duration gives an EMPTY array rather than a buffer of NaN: the caller then
 * has nothing to play and nothing to correlate, which is the honest outcome.
 */
export function makeProbe(sampleRate: number, opts: ProbeOptions = {}): Float32Array<ArrayBuffer> {
  const { kind = 'chirp', durationSec = PROBE_DEFAULT_DURATION_SEC } = opts;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return new Float32Array(0);
  const n = Math.round(sampleRate * durationSec);
  if (n <= 0) return new Float32Array(0);
  const out = new Float32Array(n);

  if (kind === 'clicks') {
    const len = Math.max(1, Math.round(sampleRate * CLICK_LENGTH_SEC));
    const burst = clickBurst(len);
    for (const off of CLICK_OFFSETS) {
      const at = Math.round(off * n);
      for (let i = 0; i < len && at + i < n; i += 1) out[at + i] = burst[i];
    }
    return out;
  }

  // A linear sweep: instantaneous frequency f0 + (f1 - f0)·t/T, so the phase is
  // the integral of that. Both ends are clamped under Nyquist, because a
  // context running at 16 kHz would otherwise be handed a sweep that aliases
  // into a signal the capture cannot contain.
  const nyq = sampleRate * 0.45;
  const f1 = Math.min(CHIRP_END_HZ, nyq);
  const f0 = Math.min(CHIRP_START_HZ, f1 * 0.5);
  const T = n / sampleRate;
  const fade = Math.min(Math.floor(n / 2), Math.max(1, Math.round(sampleRate * PROBE_FADE_SEC)));
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T));
    // Raised cosine in, raised cosine out; both ends land on exactly zero.
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    const fromEnd = n - 1 - i;
    if (fromEnd < fade) env = Math.min(env, 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fade));
    out[i] = Math.sin(phase) * env * PROBE_PEAK;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                             the correlation                                */
/* -------------------------------------------------------------------------- */

/** Hard ceiling on the searched window, seconds. See the header on cost. */
export const MAX_LAG_CAP_SEC = 1.0;
/** Searched window when the caller does not say, seconds. Half a second is far
 *  beyond any working device stack and still half the cap's cost. */
export const DEFAULT_MAX_LAG_SEC = 0.5;
/**
 * Lags this close to the peak are part of the SAME arrival and are excluded
 * from the "how much does it stand clear" average, seconds. A chirp's main lobe
 * is ~1/bandwidth wide (well under 0.2 ms here); 2 ms also swallows the first
 * room reflection off a desk.
 */
export const PEAK_GUARD_SEC = 0.002;
/**
 * An earlier arrival at least this fraction of the peak is preferred over the
 * peak itself — see `estimateOffset`'s note on echoes.
 */
export const EARLY_PEAK_FRACTION = 0.9;
/** Below this ratio the peak is indistinguishable from the correlation floor. */
export const PEAK_RATIO_FLOOR = 1.5;
/** At or above this ratio the peak is as clear as it needs to be. */
export const PEAK_RATIO_GOOD = 5;
/** |sample| at or above this counts as clipped. */
export const CLIP_LEVEL = 0.999;
/** Confidence at or above which a measurement may be saved and used. */
export const MIN_USABLE_CONFIDENCE = 0.5;
/** Clipped fraction above which the user is told to turn the input down. */
export const CLIPPING_WARN_FRACTION = 0.001;

export interface OffsetOptions {
  /** Widest lag to search, seconds. Clamped to `MAX_LAG_CAP_SEC`, and further
   *  to whatever the capture can actually hold. */
  maxLagSec?: number;
}

export interface OffsetResult {
  /** Where the probe FIRST arrived, seconds after the capture window's first
   *  sample — which is not always the loudest arrival; see the echo note in
   *  `estimateOffset`. 0 when there was nothing to find. */
  lagSec: number;
  /** The same lag in samples — what the caller checks against its own window. */
  lagSamples: number;
  /** 0 (nothing was found) .. 1 (a clean, unambiguous arrival). */
  confidence: number;
  /** Peak correlation over the mean correlation away from the peak: how much
   *  the arrival stands clear of the floor. */
  peakRatio: number;
  /** The LARGEST |r| found, 0..1. 1 is a scaled copy of the probe and nothing
   *  else. When an echo was louder than the direct path this is the echo's, and
   *  `lagSec` is the direct path's — the two are allowed to disagree. */
  peak: number;
  /** Fraction of captured samples at or past `CLIP_LEVEL`. A hot input still
   *  measures, but the user should be told. */
  clippedFraction: number;
  /** How many lags were actually searched. 0 means the capture was too short
   *  to hold the reference at all. */
  searchedLags: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function clippedFractionOf(captured: Float32Array): number {
  if (captured.length === 0) return 0;
  let hot = 0;
  for (let i = 0; i < captured.length; i += 1) {
    const v = captured[i];
    if (Number.isFinite(v) && (v >= CLIP_LEVEL || v <= -CLIP_LEVEL)) hot += 1;
  }
  return hot / captured.length;
}

/**
 * Where `reference` sits inside `captured`, by normalized cross-correlation.
 *
 * At each lag L the Pearson coefficient between the reference and the capture
 * window starting at L is computed:
 *
 *     r(L) = Σ ref'ᵢ·capᵢ₊ᴸ / √( Σ ref'ᵢ² · Σ (capᵢ₊ᴸ − mean(cap|ᴸ))² )
 *
 * with `ref'` the mean-removed reference — which is why the numerator needs no
 * mean removal of its own (Σ ref'ᵢ is zero, so any DC in the capture
 * contributes nothing to it), while the denominator uses running sums so the
 * window's variance costs O(1) per lag rather than O(n).
 *
 * `|r|`, not `r`: plenty of interfaces and every unbalanced-to-balanced adapter
 * invert polarity, and a flipped copy of the probe is still the probe arriving.
 *
 * Normalization is what makes the answer level-independent — a mic 26 dB down
 * peaks at the same lag with the same `r` — and it is also what makes SILENCE
 * report nothing: a window with no variance has a zero denominator, r is 0 at
 * every lag, and the result is confidence 0 rather than lag 0 stated firmly.
 */
export function estimateOffset(
  reference: Float32Array,
  captured: Float32Array,
  sampleRate: number,
  opts: OffsetOptions = {},
): OffsetResult {
  const clipped = clippedFractionOf(captured);
  const none: OffsetResult = {
    lagSec: 0,
    lagSamples: 0,
    confidence: 0,
    peakRatio: 0,
    peak: 0,
    clippedFraction: clipped,
    searchedLags: 0,
  };
  const n = reference.length;
  const m = captured.length;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return none;
  if (n === 0 || m < n) return none;

  const askedLagSec = Number.isFinite(opts.maxLagSec as number)
    ? (opts.maxLagSec as number)
    : DEFAULT_MAX_LAG_SEC;
  const lagSec = Math.min(MAX_LAG_CAP_SEC, Math.max(0, askedLagSec));
  const maxLag = Math.min(Math.round(sampleRate * lagSec), m - n);
  if (maxLag < 0) return none;
  const searchedLags = maxLag + 1;

  // Centre the reference once: see the formula above.
  let refSum = 0;
  for (let i = 0; i < n; i += 1) refSum += Number.isFinite(reference[i]) ? reference[i] : 0;
  const refMean = refSum / n;
  const ref = new Float64Array(n);
  let refEnergy = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (Number.isFinite(reference[i]) ? reference[i] : 0) - refMean;
    ref[i] = v;
    refEnergy += v * v;
  }
  if (refEnergy <= 0) return { ...none, searchedLags };

  // A non-finite capture sample would poison every window it touches (and, via
  // the running sums, every window after it), so it is read as silence once.
  const cap = new Float64Array(m);
  for (let i = 0; i < m; i += 1) cap[i] = Number.isFinite(captured[i]) ? captured[i] : 0;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    sum += cap[i];
    sumSq += cap[i] * cap[i];
  }

  const corr = new Float64Array(searchedLags);
  let peak = 0;
  let peakLag = 0;
  for (let L = 0; L <= maxLag; L += 1) {
    // Rounding can drive the variance a hair below zero on a constant window.
    const variance = Math.max(0, sumSq - (sum * sum) / n);
    let num = 0;
    for (let i = 0; i < n; i += 1) num += ref[i] * cap[i + L];
    const den = Math.sqrt(refEnergy * variance);
    const r = den > 1e-20 ? Math.abs(num / den) : 0;
    corr[L] = r > 1 ? 1 : r;
    if (corr[L] > peak) {
      peak = corr[L];
      peakLag = L;
    }
    if (L < maxLag) {
      const out = cap[L];
      const inn = cap[L + n];
      sum += inn - out;
      sumSq += inn * inn - out * out;
    }
  }

  const guard = Math.max(1, Math.round(sampleRate * PEAK_GUARD_SEC));

  // The DIRECT path, not the loudest one.
  //
  // A microphone in front of a speaker hears the sound twice: straight from the
  // cone, then off the desk a millisecond or two later. Put the mic near a hard
  // surface and the reflection can arrive STRONGER than the direct path, at
  // which point the largest correlation is the echo and the answer is a couple
  // of milliseconds too late — a bias, not noise, so averaging runs will not
  // remove it. So within the guard neighbourhood BEFORE the peak, an earlier
  // arrival worth at least `EARLY_PEAK_FRACTION` of it wins.
  //
  // "Arrival" means a LOCAL MAXIMUM, which is the part that matters: the rising
  // shoulder of the peak's own main lobe also clears 0.9·peak a sample or two
  // early, and preferring that would drag every measurement — including a clean
  // single-path one — earlier by the lobe's width. A lobe shoulder is
  // monotonic by definition and so is never a local maximum; a second arrival
  // always is.
  let reportedLag = peakLag;
  if (peak > 0) {
    const threshold = peak * EARLY_PEAK_FRACTION;
    const from = Math.max(0, peakLag - guard);
    for (let L = from; L < peakLag; L += 1) {
      if (corr[L] < threshold) continue;
      const risingInto = L === 0 || corr[L] >= corr[L - 1];
      const fallingOut = corr[L] > corr[L + 1];
      if (risingInto && fallingOut) {
        reportedLag = L;
        break;
      }
    }
  }

  // How far the peak stands clear of everything that is not the same arrival —
  // where "the same arrival" spans the reported one through the peak, so a
  // reflection inside the guard is never counted as part of the floor it is
  // being compared against.
  const excludeFrom = Math.min(reportedLag, peakLag) - guard;
  const excludeTo = Math.max(reportedLag, peakLag) + guard;
  let offSum = 0;
  let offCount = 0;
  for (let L = 0; L < searchedLags; L += 1) {
    if (L >= excludeFrom && L <= excludeTo) continue;
    offSum += corr[L];
    offCount += 1;
  }
  let peakRatio: number;
  if (offCount === 0) {
    // One arrival's worth of window and nothing else in it: there is nothing
    // for the peak to stand clear OF, so the peak alone decides.
    peakRatio = peak > 0 ? PEAK_RATIO_GOOD : 0;
  } else {
    const floorMean = offSum / offCount;
    peakRatio = floorMean > 1e-12 ? peak / floorMean : peak > 0 ? PEAK_RATIO_GOOD : 0;
  }

  const distinct = clamp01((peakRatio - PEAK_RATIO_FLOOR) / (PEAK_RATIO_GOOD - PEAK_RATIO_FLOOR));
  const confidence = clamp01(peak) * distinct;

  return {
    lagSec: reportedLag / sampleRate,
    lagSamples: reportedLag,
    confidence,
    peakRatio,
    peak,
    clippedFraction: clipped,
    searchedLags,
  };
}

/* -------------------------------------------------------------------------- */
/*                          what placement must remove                        */
/* -------------------------------------------------------------------------- */

export interface RoundTripSplit {
  /** The whole loop, ms. */
  totalMs: number;
  /** The part of it the mixer already declares on the output side, ms. */
  outputMs: number;
  /** `totalMs - outputMs`, floored at 0: the DAC, the air and the ADC, ms. */
  inputMs: number;
  /** What `recordingEngine.takeClipPlacement` must remove from a take's start,
   *  ms. This is the WHOLE loop — see below. */
  compMs: number;
  /** True when there was no usable measurement and the number is the sum of the
   *  declared halves instead. Surface it: a guess must not be shown as a
   *  measurement. */
  estimated: boolean;
}

const declared = (sec: number): number =>
  Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;

/**
 * Split a measured loop into the halves a user can act on, and name the part
 * take placement removes.
 *
 * `compMs` is the WHOLE loop, not half of it, and that is not an oversight.
 * A take is anchored at the TRANSPORT second the recorder started
 * (`recordingEngine.ts:300-319` and its header). The performer played against
 * what they HEARD, which left the transport `outputMs` ago; the sound they made
 * then took the rest of the loop to reach the capture buffer. Both halves put
 * the recorded audio LATE against the grid by the same sign, so the clip slides
 * earlier by their sum — which is exactly the measured lag.
 *
 * The split is therefore diagnostic rather than arithmetic: it tells the user
 * which end to go and fix (a 40 ms loop of which 30 ms is the buffer size is a
 * different problem from one of which 30 ms is a plugin chain). When the
 * measurement is missing or impossible (`NaN`, or a negative lag, which is not
 * a round trip), the two declared halves are added up instead and `estimated`
 * says so.
 */
export function roundTripMs(
  lagSec: number,
  outputLatencySec: number,
  inputLatencyGuessSec: number,
): RoundTripSplit {
  const outMs = declared(outputLatencySec);
  const guessMs = declared(inputLatencyGuessSec);
  const measured = Number.isFinite(lagSec) && lagSec >= 0 ? lagSec * 1000 : null;
  const totalMs = measured === null ? outMs + guessMs : measured;
  const outputMs = Math.min(outMs, totalMs);
  return {
    totalMs,
    outputMs,
    inputMs: Math.max(0, totalMs - outputMs),
    compMs: totalMs,
    estimated: measured === null,
  };
}
