/**
 * morphEngine — main-thread controller for the granular identity-bleed morph
 * (Phase M). Holds the AudioWorkletNode, loads donor A + host B from the library,
 * builds their corpus/target tables (morphCorpus), pushes them and the live params
 * into the audio thread (granular-morph.worklet.js), and routes the output through
 * the shared engine master so the HUD/visualizer keep working.
 *
 * The panel (MetamorphPanel) is the only consumer; it binds to this Zustand store.
 * The audio node + decoded buffers live as module singletons (one morph at a time).
 */

import { create } from 'zustand';
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError, logInfo } from './logStore';
import { buildCorpus, buildTarget, type MorphCorpus, type MorphTarget } from '../lib/morphCorpus';
import { encodeWav } from '../lib/wavEncode';

export interface MorphParams {
  bleed: number;     // 0 = dry host, 1 = full A-mosaic
  grainSize: number; // seconds
  grainRate: number; // grains / second
  spray: number;     // 0..1 start + timing jitter
  match: number;     // 0..1 selection strictness (loose = more of A bleeds through)
  sync: number;      // 0 = free clock, 1 = lock grains to host B's beat grid
  favor: number;     // 0..1 bias toward salient (punchy/cool) donor grains
  gain: number;      // output trim
}

const DEFAULT_PARAMS: MorphParams = {
  bleed: 0.6, grainSize: 0.12, grainRate: 24, spray: 0.2, match: 0.7, sync: 0.5, favor: 0.4, gain: 0.9,
};

// ---- module singletons (audio graph + decoded sources) ----------------------
let node: AudioWorkletNode | null = null;
let outGain: GainNode | null = null;
let moduleP: Promise<void> | null = null;
let corpus: MorphCorpus | null = null;
let target: MorphTarget | null = null;
let loadedAId: string | null = null;
let loadedBId: string | null = null;
let sentAId: string | null = null; // which corpus the worklet currently holds
let sentBId: string | null = null;

function ensureModule(ctx: AudioContext): Promise<void> {
  if (!moduleP) {
    moduleP = ctx.audioWorklet.addModule('/granular-morph.worklet.js').catch((e) => {
      moduleP = null; // allow a later retry
      throw e;
    });
  }
  return moduleP;
}

/** A morph source: an audio blob with a stable id + label. The panel resolves
 *  these from editor clips (blob already in memory) or library entries (fetched),
 *  so A and B can be sounds that are already on the timeline. */
export interface MorphSource {
  id: string;
  title: string;
  blob: Blob;
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  return getEngineCtx().decodeAudioData(ab.slice(0));
}

function sendParams(p: MorphParams): void {
  node?.port.postMessage({ type: 'params', ...p });
}

interface MorphState {
  aId: string | null; aTitle: string;
  bId: string | null; bTitle: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  playing: boolean;
  posSec: number; durSec: number;
  params: MorphParams;
  loadA: (source: MorphSource) => Promise<void>;
  loadB: (source: MorphSource) => Promise<void>;
  play: () => Promise<void>;
  stop: () => void;
  setParam: (k: keyof MorphParams, v: number) => void;
  /** Offline-render one pass of the current morph to a WAV blob, or null if A/B
   *  aren't both loaded. The panel drops the result onto the timeline. */
  renderToBlob: () => Promise<Blob | null>;
  dispose: () => void;
}

export const useMorphStore = create<MorphState>()((set, get) => ({
  aId: null, aTitle: '',
  bId: null, bTitle: '',
  status: 'idle',
  playing: false,
  posSec: 0, durSec: 0,
  params: { ...DEFAULT_PARAMS },

  loadA: async (source) => {
    set({ status: 'loading', aId: source.id, aTitle: source.title });
    try {
      const buf = await decodeBlob(source.blob);
      corpus = buildCorpus(buf);
      loadedAId = source.id;
      logInfo('editor', `Metamorph: donor "${source.title}" -> ${corpus.count} grains`);
      set({ status: corpus && target ? 'ready' : 'idle' });
    } catch (e) {
      logError('editor', `Metamorph donor load failed: ${e instanceof Error ? e.message : String(e)}`);
      set({ status: 'error' });
    }
  },

  loadB: async (source) => {
    set({ status: 'loading', bId: source.id, bTitle: source.title });
    try {
      const buf = await decodeBlob(source.blob);
      target = buildTarget(buf);
      loadedBId = source.id;
      set({ status: corpus && target ? 'ready' : 'idle', durSec: buf.duration });
    } catch (e) {
      logError('editor', `Metamorph host load failed: ${e instanceof Error ? e.message : String(e)}`);
      set({ status: 'error' });
    }
  },

  play: async () => {
    if (!corpus || !target) {
      logError('editor', 'Metamorph: pick a donor (A) and a host (B) first');
      return;
    }
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* retry on gesture */ } }
    try {
      await ensureModule(ctx);
    } catch (e) {
      logError('editor', `Metamorph worklet unavailable: ${e instanceof Error ? e.message : String(e)}`);
      set({ status: 'error' });
      return;
    }
    if (!node) {
      node = new AudioWorkletNode(ctx, 'granular-morph', { numberOfInputs: 0, outputChannelCount: [2] });
      outGain = ctx.createGain();
      node.connect(outGain).connect(getMasterGain());
      node.port.onmessage = (e) => { if (e.data?.type === 'pos') set({ posSec: e.data.sec }); };
      sentAId = null; sentBId = null;
    }
    if (corpus && sentAId !== loadedAId) {
      node.port.postMessage({
        type: 'loadA', pcm: corpus.pcm, count: corpus.count,
        gOffset: corpus.gOffset, gLoud: corpus.gLoud, gBright: corpus.gBright, gSal: corpus.gSal,
      });
      sentAId = loadedAId;
    }
    if (target && sentBId !== loadedBId) {
      node.port.postMessage({
        type: 'loadB', pcm: target.pcm, frameHop: target.frameHop,
        frames: target.frames, fLoud: target.fLoud, fBright: target.fBright, onsets: target.onsets,
      });
      sentBId = loadedBId;
    }
    sendParams(get().params);
    node.port.postMessage({ type: 'play', on: true });
    set({ playing: true, status: 'ready' });
  },

  stop: () => {
    node?.port.postMessage({ type: 'play', on: false });
    set({ playing: false });
  },

  setParam: (k, v) => {
    const params = { ...get().params, [k]: v };
    set({ params });
    if (node) node.port.postMessage({ type: 'params', [k]: v });
  },

  renderToBlob: async () => {
    if (!corpus || !target) { logError('editor', 'Metamorph: load A + B before sending to editor'); return null; }
    const sr = getEngineCtx().sampleRate; // corpus/target PCM is already at this rate
    const frames = target.pcm.length;
    if (frames <= 0) return null;
    const offline = new OfflineAudioContext(2, frames, sr);
    try {
      await offline.audioWorklet.addModule('/granular-morph.worklet.js');
    } catch (e) {
      logError('editor', `Metamorph render worklet failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    // Seed via processorOptions (reaches the worklet constructor before the first
    // process() call). Port messages posted before startRendering() race the offline
    // render and arrive too late — proven live — which rendered a silent/blank clip.
    const n = new AudioWorkletNode(offline, 'granular-morph', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: {
        a: {
          pcm: corpus.pcm, count: corpus.count,
          gOffset: corpus.gOffset, gLoud: corpus.gLoud, gBright: corpus.gBright, gSal: corpus.gSal,
        },
        b: {
          pcm: target.pcm, frameHop: target.frameHop,
          frames: target.frames, fLoud: target.fLoud, fBright: target.fBright, onsets: target.onsets,
        },
        params: { ...get().params, loop: false }, // one pass, then it ends
        play: true,
      },
    });
    n.connect(offline.destination);
    const rendered = await offline.startRendering();
    return encodeWav(rendered);
  },

  dispose: () => {
    if (node) { try { node.port.postMessage({ type: 'play', on: false }); node.disconnect(); } catch { /* gone */ } }
    if (outGain) { try { outGain.disconnect(); } catch { /* gone */ } }
    node = null; outGain = null;
    sentAId = null; sentBId = null;
    set({ playing: false });
  },
}));
