/**
 * morphCorpus — turns two decoded AudioBuffers into the data the granular morph
 * worklet needs (Phase M, identity-bleed).
 *
 *   - the CORPUS (sound A, the donor / "identity"): mono PCM + a grain table
 *     (each onset-sliced grain's start offset and its descriptors), and
 *   - the TARGET (sound B, the host / structure): mono PCM + per-frame descriptors
 *     the worklet indexes by playhead to choose, moment to moment, which A grain
 *     best matches what B is doing right now.
 *
 * v1 matches on loudness + brightness only (the cheap, robust pair). Pitch-match
 * and harmonize are Phase M3. Everything is plain typed arrays so the controller
 * can transfer them into the audio thread with zero copies.
 */

import { downmixMono, sliceChunks, detectOnsets, type OnsetOptions } from './audioAnalysis';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export interface MorphCorpus {
  sampleRate: number;
  pcm: Float32Array;     // mono donor samples
  gOffset: Float32Array; // grain start, in samples
  gLoud: Float32Array;   // 0..1
  gBright: Float32Array; // 0..1
  gSal: Float32Array;    // 0..1 transient salience (favour the punchy/cool grains)
  count: number;
}

export interface MorphTarget {
  sampleRate: number;
  pcm: Float32Array;   // mono host samples
  frameHop: number;    // samples between frames
  fLoud: Float32Array; // per-frame loudness 0..1
  fBright: Float32Array; // per-frame brightness 0..1
  frames: number;
  onsets: Float32Array; // host onset positions in samples (for beat-locked triggering)
}

/** Cap so the worklet's per-grain nearest-neighbour scan stays cheap and the
 *  transfer stays small; long sources just get a coarser grain pool. */
const MAX_GRAINS = 2000;

/** Slice donor A into a grain pool with a loudness/brightness descriptor each. */
export function buildCorpus(buffer: AudioBuffer, opts: OnsetOptions = {}): MorphCorpus {
  const sr = buffer.sampleRate;
  const pcm = new Float32Array(downmixMono(buffer)); // copy so it can be transferred
  let chunks = sliceChunks(buffer, opts);
  if (chunks.length > MAX_GRAINS) {
    // Keep an even spread across the source rather than just the head.
    const step = chunks.length / MAX_GRAINS;
    const thinned = [];
    for (let i = 0; i < MAX_GRAINS; i += 1) thinned.push(chunks[Math.floor(i * step)]);
    chunks = thinned;
  }
  const count = chunks.length;
  const gOffset = new Float32Array(count);
  const gLoud = new Float32Array(count);
  const gBright = new Float32Array(count);
  const gSal = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    gOffset[i] = Math.floor(chunks[i].tSec * sr);
    gLoud[i] = chunks[i].loudness;
    gBright[i] = chunks[i].brightness;
    gSal[i] = chunks[i].salience;
  }
  return { sampleRate: sr, pcm, gOffset, gLoud, gBright, gSal, count };
}

/** Frame host B and describe each frame (loudness + brightness), so the worklet
 *  can look up B's current character by playhead position. */
export function buildTarget(buffer: AudioBuffer, frameHop = 256): MorphTarget {
  const sr = buffer.sampleRate;
  const pcm = new Float32Array(downmixMono(buffer));
  const win = Math.max(frameHop, 512);
  const frames = Math.max(1, Math.floor(pcm.length / frameHop));
  const fLoud = new Float32Array(frames);
  const fBright = new Float32Array(frames);

  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    const start = f * frameHop;
    const end = Math.min(start + win, pcm.length);
    let sum = 0;
    let crossings = 0;
    let prev = pcm[start] || 0;
    for (let i = start; i < end; i += 1) {
      const v = pcm[i];
      sum += v * v;
      if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) crossings += 1;
      prev = v;
    }
    const n = Math.max(1, end - start);
    fLoud[f] = Math.sqrt(sum / n);
    fBright[f] = clamp((crossings / n) * 6, 0, 1);
    peak = Math.max(peak, fLoud[f]);
  }
  // Normalize loudness against the host's own peak (matches the corpus's 0..1).
  const inv = peak > 0 ? 1 / peak : 0;
  for (let f = 0; f < frames; f += 1) fLoud[f] = clamp(fLoud[f] * inv, 0, 1);

  // Host onsets (seconds -> sample offsets) so the worklet can lock grain spawns
  // to B's beat grid.
  const onsetSec = detectOnsets(buffer);
  const onsets = new Float32Array(onsetSec.length);
  for (let i = 0; i < onsetSec.length; i += 1) onsets[i] = Math.floor(onsetSec[i] * sr);

  return { sampleRate: sr, pcm, frameHop, fLoud, fBright, frames, onsets };
}
