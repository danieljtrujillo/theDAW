// Waveform-peak extraction + cache for the Chimera DNA strands. Each clip's
// blob is decoded once to a normalised peaks array so its strand takes on the
// rough shape of the actual audio. Decode failures fall back to a synthesised
// envelope so a strand always renders.

type WinAudio = typeof window & { webkitAudioContext?: typeof AudioContext };

let actx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (!actx) {
    const AC = window.AudioContext || (window as WinAudio).webkitAudioContext;
    if (!AC) throw new Error('AudioContext unavailable');
    actx = new AC();
  }
  return actx;
}

const BINS = 180;
const cache = new Map<string, Float32Array>();
const inflight = new Set<string>();

export const getPeaks = (id: string): Float32Array | undefined => cache.get(id);

function synthPeaks(seed: string, bins = BINS): Float32Array {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const phase = ((h >>> 0) / 4294967295) * Math.PI * 2;
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const u = i / bins;
    const v =
      0.35 +
      0.3 * Math.sin(u * 22 + phase) +
      0.2 * Math.sin(u * 7 + phase * 1.7) +
      0.15 * Math.sin(u * 53 + phase * 0.3);
    out[i] = Math.max(0.05, Math.min(1, Math.abs(v)));
  }
  return out;
}

async function decodePeaks(blob: Blob, bins = BINS): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const audio = await getCtx().decodeAudioData(buf);
  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const out = new Float32Array(bins);
  const step = Math.max(1, Math.floor(ch0.length / bins));
  let max = 0;
  for (let b = 0; b < bins; b++) {
    let peak = 0;
    const s = b * step;
    const e = Math.min(ch0.length, s + step);
    for (let i = s; i < e; i++) {
      let v = Math.abs(ch0[i]);
      if (ch1) {
        const v2 = Math.abs(ch1[i]);
        if (v2 > v) v = v2;
      }
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let b = 0; b < bins; b++) out[b] /= max;
  return out;
}

// Fire-and-forget: populate the cache for a clip. The draw loop reads getPeaks
// each frame, so no React state is needed to pick the result up.
export function ensurePeaks(id: string, blob: Blob): void {
  if (cache.has(id) || inflight.has(id)) return;
  inflight.add(id);
  decodePeaks(blob)
    .then((p) => {
      cache.set(id, p);
    })
    .catch(() => {
      cache.set(id, synthPeaks(id));
    })
    .finally(() => {
      inflight.delete(id);
    });
}
