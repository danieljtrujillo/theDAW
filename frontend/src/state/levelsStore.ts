/**
 * Levels metering store.
 *
 * Persisted UI state (LUFS target + preset, true-peak ceiling) lives in the
 * Zustand store. The DSP tap is module-scope (like playerStore's engine) and
 * fans non-destructively off the meter tap — the end of the master chain,
 * pre-monitor-fader (see getMeterTap in playerStore):
 *
 *   meter tap ─┬─▶ levels-meter AudioWorklet ─▶ silent sink
 *              │      LUFS M / S / I, LRA, true peak, sample peak (one frame per ~100 ms)
 *              └─▶ stereo gain ─▶ ChannelSplitter ─┬─▶ AnalyserNode L
 *                                                  └─▶ AnalyserNode R
 *                     per-channel peak / RMS / correlation at display rate
 *
 * The worklet's latest frame, the 60 s short-term history ring and the max
 * holds are module variables read by the panel's rAF loop (never through
 * React), so metering never re-renders the tree. The two analysers exist only
 * because the L/R bar meters need per-channel readings at ~60 fps — the
 * worklet posts a single combined peak every 100 ms; they cost one
 * getFloatTimeDomainData per channel per frame.
 *
 * When AudioWorklet is unavailable the analysers still drive the bar meters;
 * the LUFS / true-peak fields come back NaN and the panel shows "RMS only".
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getEngineCtx, getMeterTap } from './playerStore';

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

// ── loudness target presets ─────────────────────────────────────────────────
export type LufsPresetId = 'streaming' | 'apple' | 'club' | 'broadcast' | 'custom';

export interface LufsPreset {
  id: LufsPresetId;
  label: string;
  /** Target in LUFS; null for the user-entered custom value. */
  lufs: number | null;
}

export const LUFS_PRESETS: readonly LufsPreset[] = [
  { id: 'streaming', label: 'Streaming', lufs: -14 },
  { id: 'apple', label: 'Apple Music', lufs: -16 },
  { id: 'club', label: 'Club', lufs: -8 },
  { id: 'broadcast', label: 'Broadcast R128', lufs: -23 },
  { id: 'custom', label: 'Custom', lufs: null },
];

export const LUFS_TARGET_MIN = -40;
export const LUFS_TARGET_MAX = 0;
export const TP_CEILING_MIN = -12;
export const TP_CEILING_MAX = 0;

const clampNum = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

const presetForTarget = (lufs: number): LufsPresetId =>
  LUFS_PRESETS.find((p) => p.lufs === lufs)?.id ?? 'custom';

interface LevelsState {
  lufsTarget: number;
  lufsPreset: LufsPresetId;
  truePeakCeiling: number;
  setLufsTarget: (v: number) => void;
  setLufsPreset: (id: LufsPresetId) => void;
  setTruePeakCeiling: (v: number) => void;
}

export const useLevelsStore = create<LevelsState>()(
  persist(
    (set) => ({
      lufsTarget: -14,
      lufsPreset: 'streaming',
      truePeakCeiling: -1,
      setLufsTarget: (v) =>
        set((s) => ({ lufsTarget: clampNum(v, LUFS_TARGET_MIN, LUFS_TARGET_MAX, s.lufsTarget) })),
      setLufsPreset: (id) =>
        set((s) => {
          const preset = LUFS_PRESETS.find((p) => p.id === id);
          if (!preset) return {};
          return { lufsPreset: id, lufsTarget: preset.lufs ?? s.lufsTarget };
        }),
      setTruePeakCeiling: (v) =>
        set((s) => ({ truePeakCeiling: clampNum(v, TP_CEILING_MIN, TP_CEILING_MAX, s.truePeakCeiling) })),
    }),
    {
      name: 'thedaw-levels-v1',
      version: 2,
      // v1 persisted the six-view switcher's `view`; v2 is the single meter
      // bridge, so drop it and derive the preset from the remembered target.
      migrate: (persisted, version) => {
        const p = { ...((persisted ?? {}) as Partial<LevelsState> & { view?: string }) };
        if (version < 2) {
          delete p.view;
          if (typeof p.lufsTarget === 'number') p.lufsPreset = presetForTarget(p.lufsTarget);
        }
        return p as unknown as LevelsState;
      },
      partialize: (s) => ({
        lufsTarget: s.lufsTarget,
        lufsPreset: s.lufsPreset,
        truePeakCeiling: s.truePeakCeiling,
      }),
    },
  ),
);

// ── module-scope DSP tap ────────────────────────────────────────────────────
let workletNode: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
let moduleAdded = false;
let latestFrame: LevelsFrame | null = null;

let stereoIn: GainNode | null = null;
let splitter: ChannelSplitterNode | null = null;
let anL: AnalyserNode | null = null;
let anR: AnalyserNode | null = null;
let bufL = new Float32Array(0);
let bufR = new Float32Array(0);

/** ensureMeter()/disposeMeter() refcount, so a dispose that races the async
 *  worklet module load still ends with nothing attached. */
let wanted = 0;
let ensuring: Promise<void> | null = null;

// ── holds + history (cleared by resetMeter / disposeMeter) ──────────────────
export interface MeterHolds {
  /** Highest true peak (dBTP) since the last reset. */
  maxTruePeakDb: number;
  /** Highest sample peak (dBFS) since the last reset. */
  maxSamplePeakDb: number;
}
const holds: MeterHolds = { maxTruePeakDb: -Infinity, maxSamplePeakDb: -Infinity };

/** Short-term loudness history: one slot per worklet frame (~100 ms) → 60 s. */
export const HISTORY_SLOTS = 600;

export interface LoudnessHistory {
  /** Ring buffer of short-term LUFS (-Infinity while silent). */
  readonly buf: Float32Array;
  /** Next write index; the newest sample sits at head - 1. */
  readonly head: number;
  /** Number of valid samples (≤ slots). */
  readonly count: number;
  readonly slots: number;
}
const historyBuf = new Float32Array(HISTORY_SLOTS).fill(-Infinity);
const history = { buf: historyBuf, head: 0, count: 0, slots: HISTORY_SLOTS };

function clearHolds(): void {
  holds.maxTruePeakDb = -Infinity;
  holds.maxSamplePeakDb = -Infinity;
  historyBuf.fill(-Infinity);
  history.head = 0;
  history.count = 0;
}

function onFrame(e: MessageEvent): void {
  const f = e.data as LevelsFrame;
  latestFrame = f;
  if (f.truePeakDb > holds.maxTruePeakDb) holds.maxTruePeakDb = f.truePeakDb;
  if (f.samplePeakDb > holds.maxSamplePeakDb) holds.maxSamplePeakDb = f.samplePeakDb;
  historyBuf[history.head] = f.short;
  history.head = (history.head + 1) % HISTORY_SLOTS;
  if (history.count < HISTORY_SLOTS) history.count += 1;
}

function attachAnalysers(ctx: AudioContext, tap: AudioNode): void {
  // Force a stereo, speaker-interpreted signal into the splitter so a mono
  // source meters as L = R instead of a silent right channel.
  const g = ctx.createGain();
  g.channelCount = 2;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  const sp = ctx.createChannelSplitter(2);
  const mk = (): AnalyserNode => {
    const a = ctx.createAnalyser();
    a.fftSize = 2048; // ≈46 ms at 44.1 kHz: windows overlap at 60 fps, so no peak slips between reads
    return a;
  };
  const l = mk();
  const r = mk();
  tap.connect(g);
  g.connect(sp);
  sp.connect(l, 0);
  sp.connect(r, 1);
  stereoIn = g;
  splitter = sp;
  anL = l;
  anR = r;
  bufL = new Float32Array(l.fftSize);
  bufR = new Float32Array(r.fftSize);
}

function detachAnalysers(tap: AudioNode | null): void {
  try {
    if (stereoIn && tap) tap.disconnect(stereoIn);
  } catch {
    /* already gone */
  }
  try {
    stereoIn?.disconnect();
    splitter?.disconnect();
  } catch {
    /* already gone */
  }
  stereoIn = null;
  splitter = null;
  anL = null;
  anR = null;
  channelsSampled = false;
}

function attachWorklet(ctx: AudioContext, tap: AudioNode): void {
  try {
    const node = new AudioWorkletNode(ctx, 'levels-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = onFrame;
    tap.connect(node);
    // A silent sink keeps the graph pulling the worklet without altering the audio.
    const s = ctx.createGain();
    s.gain.value = 0;
    node.connect(s);
    s.connect(ctx.destination);
    workletNode = node;
    sink = s;
  } catch {
    workletNode = null;
    sink = null;
  }
}

function detachWorklet(tap: AudioNode | null): void {
  try {
    if (workletNode && tap) tap.disconnect(workletNode);
  } catch {
    /* already gone */
  }
  try {
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    sink?.disconnect();
  } catch {
    /* already gone */
  }
  workletNode = null;
  sink = null;
  latestFrame = null;
}

function safeTap(): AudioNode | null {
  try {
    return getMeterTap();
  } catch {
    return null;
  }
}

async function setup(): Promise<void> {
  const ctx = getEngineCtx();
  if (ctx.audioWorklet && !moduleAdded) {
    try {
      await ctx.audioWorklet.addModule('/worklets/levels-meter.js');
      moduleAdded = true;
    } catch {
      // analyser-only: the bar meters still work; LUFS / true peak read "—"
    }
  }
  if (wanted <= 0) return; // disposed while the module was loading
  const tap = getMeterTap();
  if (!anL) attachAnalysers(ctx, tap);
  if (moduleAdded && !workletNode) attachWorklet(ctx, tap);
}

/** Attach the meter tap. Refcounted — pair every call with disposeMeter(). */
export function ensureMeter(): Promise<void> {
  wanted += 1;
  if (anL) return Promise.resolve();
  if (!ensuring) {
    ensuring = setup().finally(() => {
      ensuring = null;
    });
  }
  return ensuring;
}

/** Release one ensureMeter() hold; the tap detaches when the last one goes. */
export function disposeMeter(): void {
  wanted = Math.max(0, wanted - 1);
  if (wanted > 0) return;
  const tap = safeTap();
  detachWorklet(tap);
  detachAnalysers(tap);
  clearHolds();
}

/** Restart the integrated / LRA measurement and clear the max holds + history. */
export function resetMeter(): void {
  clearHolds();
  latestFrame = null;
  if (!workletNode) return;
  // The worklet has no reset message; a fresh node restarts its gating blocks.
  const ctx = getEngineCtx();
  const tap = getMeterTap();
  detachWorklet(tap);
  attachWorklet(ctx, tap);
}

// ── per-channel readings (analysers) ────────────────────────────────────────
export interface ChannelLevels {
  /** Window sample peaks, linear (1.0 = 0 dBFS). */
  peakL: number;
  peakR: number;
  /** Window RMS, linear. */
  rmsL: number;
  rmsR: number;
  /** Correlation of L and R over the window, -1 … +1; NaN while silent. */
  correlation: number;
}
const channels: ChannelLevels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, correlation: NaN };
let channelsSampled = false;

/**
 * Read both analysers once. Call once per animation frame from the paint
 * loop; the returned object is reused between calls. Null until the tap exists.
 */
export function sampleChannelLevels(): ChannelLevels | null {
  if (!anL || !anR) return null;
  anL.getFloatTimeDomainData(bufL);
  anR.getFloatTimeDomainData(bufR);
  const n = bufL.length;
  let pl = 0;
  let pr = 0;
  let ll = 0;
  let rr = 0;
  let lr = 0;
  for (let i = 0; i < n; i += 1) {
    const l = bufL[i];
    const r = bufR[i];
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (al > pl) pl = al;
    if (ar > pr) pr = ar;
    ll += l * l;
    rr += r * r;
    lr += l * r;
  }
  channels.peakL = pl;
  channels.peakR = pr;
  channels.rmsL = Math.sqrt(ll / n);
  channels.rmsR = Math.sqrt(rr / n);
  const den = Math.sqrt(ll * rr);
  // Below ≈ -100 dBFS RMS on both channels the ratio is noise: report silence.
  channels.correlation = den > n * 1e-10 ? lr / den : NaN;
  channelsSampled = true;
  return channels;
}

const EMPTY_SCOPE = new Float32Array(0);
const toDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fallbackFrame: LevelsFrame = {
  momentary: NaN,
  short: NaN,
  integrated: NaN,
  lra: 0,
  samplePeakDb: -Infinity,
  truePeakDb: NaN,
  rmsDb: -Infinity,
  crestDb: 0,
  correlation: 0,
  bands: [],
  bandFreqs: [],
  scope: EMPTY_SCOPE,
};

/** Latest worklet readings, or an RMS/peak-only frame built from the analysers. */
export function getLevelsFrame(): LevelsFrame | null {
  if (workletNode) return latestFrame;
  if (!anL) return null;
  if (!channelsSampled) sampleChannelLevels();
  const c = channels;
  const peakDb = toDb(Math.max(c.peakL, c.peakR));
  const rmsDb = toDb(Math.sqrt((c.rmsL * c.rmsL + c.rmsR * c.rmsR) * 0.5));
  fallbackFrame.samplePeakDb = peakDb;
  fallbackFrame.rmsDb = rmsDb;
  fallbackFrame.crestDb = Number.isFinite(peakDb) && Number.isFinite(rmsDb) ? peakDb - rmsDb : 0;
  fallbackFrame.correlation = Number.isFinite(c.correlation) ? c.correlation : 0;
  return fallbackFrame;
}

/** Max true-peak / sample-peak since the last reset (the live object; read-only). */
export function getMeterHolds(): Readonly<MeterHolds> {
  return holds;
}

/** The 60 s short-term loudness ring (the live object; read-only). */
export function getLoudnessHistory(): LoudnessHistory {
  return history;
}

/** True when the BS.1770 worklet is running (vs the RMS/peak-only analyser fallback). */
export function isWorkletMeter(): boolean {
  return !!workletNode;
}
