/**
 * Levels metering store.
 *
 * Persisted UI state (which view, LUFS target, true-peak ceiling) lives in the
 * Zustand store. The DSP tap is module-scope (like playerStore's engine): a
 * single AudioWorklet fanned non-destructively off the master gain, its output
 * feeding a silent sink so the graph pulls it without altering the audio. The
 * latest readings frame is held in a module variable and read by the panel's
 * rAF loop (never through React), so metering never triggers re-renders.
 *
 * When AudioWorklet is unavailable, an AnalyserNode fallback supplies RMS/peak
 * only (no gated LUFS); the LUFS fields come back NaN and the views degrade.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getEngineCtx, getMeterTap } from './playerStore';

export type LevelsView = 'radial' | 'lufs' | 'peak' | 'dr' | 'stereo' | 'bass';

export interface LevelsFrame {
  momentary: number;
  short: number;
  integrated: number;
  lra: number;
  samplePeakDb: number;
  truePeakDb: number;
  rmsDb: number;
  crestDb: number;
  correlation: number;
  bands: number[];
  bandFreqs: number[];
  scope: Float32Array;
}

interface LevelsState {
  view: LevelsView;
  lufsTarget: number;
  truePeakCeiling: number;
  setView: (v: LevelsView) => void;
  setLufsTarget: (v: number) => void;
  setTruePeakCeiling: (v: number) => void;
}

export const useLevelsStore = create<LevelsState>()(
  persist(
    (set) => ({
      view: 'radial',
      lufsTarget: -14,
      truePeakCeiling: -1,
      setView: (v) => set({ view: v }),
      setLufsTarget: (v) => set({ lufsTarget: v }),
      setTruePeakCeiling: (v) => set({ truePeakCeiling: v }),
    }),
    { name: 'thedaw-levels-v1', version: 1 },
  ),
);

// ── module-scope DSP tap ────────────────────────────────────────────────────
let workletNode: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
let moduleAdded = false;
let latestFrame: LevelsFrame | null = null;

let fbAnalyser: AnalyserNode | null = null;
let fbBuf: Float32Array | null = null;

let ensuring: Promise<void> | null = null;

async function setup(): Promise<void> {
  if (workletNode || fbAnalyser) return;
  const ctx = getEngineCtx();
  // Meter the END of the processing chain, pre-monitor-fader — not the pre-FX
  // summing bus. See getMeterTap() in playerStore.
  const master = getMeterTap();
  if (ctx.audioWorklet) {
    try {
      if (!moduleAdded) {
        await ctx.audioWorklet.addModule('/worklets/levels-meter.js');
        moduleAdded = true;
      }
      const node = new AudioWorkletNode(ctx, 'levels-meter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => {
        latestFrame = e.data as LevelsFrame;
      };
      master.connect(node);
      const s = ctx.createGain();
      s.gain.value = 0;
      node.connect(s);
      s.connect(ctx.destination);
      workletNode = node;
      sink = s;
      return;
    } catch {
      // fall through to the analyser fallback
    }
  }
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  master.connect(an);
  fbAnalyser = an;
  fbBuf = new Float32Array(an.fftSize);
}

/** Ensure the meter tap exists. Idempotent + concurrency-safe. */
export function ensureMeter(): Promise<void> {
  if (workletNode || fbAnalyser) return Promise.resolve();
  if (!ensuring) ensuring = setup().finally(() => (ensuring = null));
  return ensuring;
}

/** Detach the meter from the master path. */
export function disposeMeter(): void {
  try {
    if (workletNode) getMeterTap().disconnect(workletNode);
  } catch {
    /* already gone */
  }
  try {
    if (fbAnalyser) getMeterTap().disconnect(fbAnalyser);
  } catch {
    /* already gone */
  }
  try {
    if (workletNode && sink) workletNode.disconnect(sink);
    if (sink) sink.disconnect();
  } catch {
    /* already gone */
  }
  workletNode = null;
  sink = null;
  fbAnalyser = null;
  fbBuf = null;
  latestFrame = null;
}

const EMPTY_SCOPE = new Float32Array(0);

/** Latest readings frame (worklet) or a live RMS/peak-only frame (fallback). */
export function getLevelsFrame(): LevelsFrame | null {
  if (workletNode) return latestFrame;
  if (fbAnalyser && fbBuf) {
    fbAnalyser.getFloatTimeDomainData(fbBuf);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < fbBuf.length; i += 1) {
      const v = fbBuf[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / fbBuf.length);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    return {
      momentary: NaN,
      short: NaN,
      integrated: NaN,
      lra: 0,
      samplePeakDb: peakDb,
      truePeakDb: peakDb,
      rmsDb,
      crestDb: Number.isFinite(peakDb) && Number.isFinite(rmsDb) ? peakDb - rmsDb : 0,
      correlation: 0,
      bands: [],
      bandFreqs: [],
      scope: EMPTY_SCOPE,
    };
  }
  return null;
}

/** True when the full BS.1770 worklet is running (vs the RMS-only fallback). */
export function isWorkletMeter(): boolean {
  return !!workletNode;
}
