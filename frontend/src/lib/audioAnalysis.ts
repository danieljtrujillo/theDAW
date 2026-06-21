/**
 * audioAnalysis — browser-side, FFT-free analysis of a decoded AudioBuffer.
 *
 * Two consumers share this:
 *   - the spatializer's Teleport motion (slice a clip on its transients and jump
 *     each chunk to a position chosen from its character), and
 *   - the granular identity-bleed morph engine (index a donor's grain pool and
 *     follow a host's onsets/energy).
 *
 * Everything here is time-domain so it stays cheap enough to run synchronously at
 * play/seek time: an energy-novelty onset detector with an adaptive threshold,
 * plus two per-chunk descriptors — loudness (RMS) and a brightness proxy (zero-
 * crossing rate, which tracks spectral centroid without an FFT). Results are
 * deterministic, so a live preview and the offline bounce slice identically.
 */

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export interface AudioChunk {
  /** Onset time in seconds, relative to the start of the analyzed buffer. */
  tSec: number;
  /** Span until the next onset (or buffer end), in seconds. */
  durSec: number;
  /** Loudness 0..1, normalized against the loudest chunk in the buffer. */
  loudness: number;
  /** Brightness 0..1 (zero-crossing rate proxy for spectral centroid). */
  brightness: number;
  /** Salience 0..1 — transient strength (energy rise at the onset). High = a
   *  punchy / distinctive chunk worth favouring when picking "cool" material. */
  salience: number;
}

export interface OnsetOptions {
  /** Peak-pick aggressiveness: higher = more onsets. Maps to a threshold scale. */
  sensitivity?: number; // 0..1, default 0.5
  /** Minimum gap between onsets (de-clusters dense transients). */
  minIntervalSec?: number; // default 0.07
  /** Window after each onset used to measure the chunk's loudness/brightness. */
  featureWindowSec?: number; // default 0.06
}

/** Sum a buffer's channels down to a single mono Float32Array. */
export function downmixMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i += 1) out[i] += data[i];
  }
  const inv = 1 / ch;
  for (let i = 0; i < n; i += 1) out[i] *= inv;
  return out;
}

/** RMS over a sample range. */
function rms(mono: Float32Array, start: number, end: number): number {
  let sum = 0;
  const a = Math.max(0, start);
  const b = Math.min(mono.length, end);
  for (let i = a; i < b; i += 1) sum += mono[i] * mono[i];
  const n = b - a;
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** Zero-crossing rate (fraction of adjacent samples that change sign) over a
 *  range — a cheap brightness proxy: more crossings ~ more high-frequency energy. */
function zeroCrossRate(mono: Float32Array, start: number, end: number): number {
  let crossings = 0;
  const a = Math.max(1, start);
  const b = Math.min(mono.length, end);
  let prev = mono[a - 1];
  for (let i = a; i < b; i += 1) {
    const cur = mono[i];
    if ((cur >= 0 && prev < 0) || (cur < 0 && prev >= 0)) crossings += 1;
    prev = cur;
  }
  const n = b - a;
  return n > 0 ? crossings / n : 0;
}

/**
 * Detect onset times (seconds) via an energy-novelty function with an adaptive
 * median threshold and a minimum inter-onset interval. Always reports an onset at
 * t=0 so the first chunk is covered even on a slow fade-in.
 */
export function detectOnsets(buffer: AudioBuffer, opts: OnsetOptions = {}): number[] {
  const sensitivity = clamp(opts.sensitivity ?? 0.5, 0, 1);
  const minInterval = Math.max(0.02, opts.minIntervalSec ?? 0.07);
  const sr = buffer.sampleRate;
  const mono = downmixMono(buffer);

  const frame = 1024;
  const hop = 512;
  const nFrames = Math.max(0, Math.floor((mono.length - frame) / hop) + 1);
  if (nFrames < 3) return [0];

  // Per-frame energy, then half-wave-rectified first difference (the novelty).
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f += 1) {
    const s = f * hop;
    let e = 0;
    for (let i = 0; i < frame; i += 1) {
      const v = mono[s + i];
      e += v * v;
    }
    energy[f] = Math.log1p(e); // log compress so quiet onsets still register
  }
  const novelty = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f += 1) novelty[f] = Math.max(0, energy[f] - energy[f - 1]);

  // Adaptive threshold: local median * scale + small floor. Lower scale = more
  // onsets, so higher sensitivity lowers it.
  const win = 16; // ~0.18 s at 44.1k / hop 512
  const scale = 2.4 - sensitivity * 1.6; // 0.8 (max sens) .. 2.4 (min sens)
  const sorted: number[] = [];
  const onsets: number[] = [0];
  let lastOnsetSec = -minInterval;
  for (let f = 1; f < nFrames; f += 1) {
    const lo = Math.max(0, f - win);
    const hi = Math.min(nFrames, f + win);
    sorted.length = 0;
    for (let k = lo; k < hi; k += 1) sorted.push(novelty[k]);
    sorted.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const thresh = median * scale + 1e-4;
    const isPeak = novelty[f] > thresh && novelty[f] >= novelty[f - 1] && novelty[f] >= novelty[f + 1 < nFrames ? f + 1 : f];
    if (isPeak) {
      const tSec = (f * hop) / sr;
      if (tSec - lastOnsetSec >= minInterval) {
        onsets.push(tSec);
        lastOnsetSec = tSec;
      }
    }
  }
  return onsets;
}

/**
 * Slice a buffer at its onsets and describe each chunk (loudness + brightness).
 * Loudness is normalized against the loudest chunk so the descriptors are usable
 * as 0..1 placement controls regardless of the source's absolute level.
 */
export function sliceChunks(buffer: AudioBuffer, opts: OnsetOptions = {}): AudioChunk[] {
  const sr = buffer.sampleRate;
  const mono = downmixMono(buffer);
  const featureWin = Math.max(0.01, opts.featureWindowSec ?? 0.06);
  const onsets = detectOnsets(buffer, opts);
  const total = buffer.duration;
  const winSamp = Math.floor(featureWin * sr);

  const raw = onsets.map((tSec, i) => {
    const next = i + 1 < onsets.length ? onsets[i + 1] : total;
    const start = Math.floor(tSec * sr);
    const end = Math.min(Math.floor((tSec + featureWin) * sr), Math.floor(next * sr), mono.length);
    const post = rms(mono, start, end);
    const pre = rms(mono, start - winSamp, start); // energy just before the onset
    return {
      tSec,
      durSec: Math.max(0, next - tSec),
      loudnessRaw: post,
      // ZCR fraction ~0..0.5; scale so typical bright content lands near 1.
      brightness: clamp(zeroCrossRate(mono, start, end) * 6, 0, 1),
      attackRaw: Math.max(0, post - pre), // rise at the onset = transient strength
    };
  });

  let peak = 0;
  let peakAtk = 0;
  for (const c of raw) { peak = Math.max(peak, c.loudnessRaw); peakAtk = Math.max(peakAtk, c.attackRaw); }
  const inv = peak > 0 ? 1 / peak : 0;
  const invAtk = peakAtk > 0 ? 1 / peakAtk : 0;
  return raw.map((c) => ({
    tSec: c.tSec,
    durSec: c.durSec,
    loudness: clamp(c.loudnessRaw * inv, 0, 1),
    brightness: c.brightness,
    salience: clamp(c.attackRaw * invAtk, 0, 1),
  }));
}
