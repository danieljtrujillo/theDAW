import { create } from 'zustand';

export interface LoraSlot {
  name: string;
  weight: number;
  file: File | null;
}

export interface ChimeraClip {
  id: string;
  blob: Blob;
  mimeType: string;
  label: string;
  noise: number;
  isBase: boolean;
  detectedBpm?: number | null;
  stretchRatio?: number;
}

export type ChimeraAlignMode = 'start' | 'downbeat' | 'weave';

export interface ChimeraPerClipMeta {
  index: number;
  label: string;
  detected_bpm: number | null;
  beats: number[];
  stretch_ratio: number;
  stretched_duration_sec: number;
  window_start_sec: number;
  window_end_sec: number;
  weight_used: number;
  note: string | null;
}

export interface ChimeraMashupMeta {
  sample_rate: number;
  duration_sec: number;
  target_bpm_used: number;
  target_bpm_source: 'user' | 'base_clip' | 'median' | 'fallback';
  align_mode_used: ChimeraAlignMode;
  per_clip: ChimeraPerClipMeta[];
  warnings: string[];
}

export interface ChimeraState {
  clips: ChimeraClip[];
  targetBpm: number | 'auto';
  alignMode: ChimeraAlignMode;
  weaveBars: number;
  weaveTotalBars: number;
  weaveMaxPolyphony: number;
  lastMeta: ChimeraMashupMeta | null;
}

export interface GenerateParamsState {
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  batch: number;

  samplerType: string;
  sigmaMax: number;
  durationPaddingSec: number;

  apgScale: number;
  cfgRescale: number;
  cfgNormThreshold: number;
  cfgIntervalMin: number;
  cfgIntervalMax: number;

  shiftMode: string;
  logsnrAnchorLength: number;
  logsnrAnchorLogsnr: number;
  logsnrRate: number;
  logsnrEnd: number;
  fluxMinLen: number;
  fluxMaxLen: number;
  fluxAlphaMin: number;
  fluxAlphaMax: number;
  fullBaseShift: number;
  fullMaxShift: number;
  fullMinLen: number;
  fullMaxLen: number;

  initNoise: number;
  initType: string;
  initAudioFile: File | null;
  initAudioEnabled: boolean;
  initAudioSourceLabel: string | null;
  initAudioSourceClipLabels: string[];
  inversionSteps: number;
  inversionGamma: number;
  inversionUnconditional: boolean;

  inpaintAudioFile: File | null;
  inpaintEnabled: boolean;
  maskStart: number;
  maskEnd: number;

  fileFormat: string;
  fileNaming: string;
  outputName: string;
  cutToDuration: boolean;
  autoplay: boolean;
  autoDownload: boolean;

  loras: LoraSlot[];

  chimera: ChimeraState;
  /** True when the Magenta RT2 sidecar probe succeeds (transient; re-probed each session). */
  magentaAvailable: boolean;

  // Magenta RT2 (text→music) sampling params — used when `model` starts with
  // "magenta-". These replace the SA3 sampler/schedule controls in the MAKE UI;
  // the central Chimera stack is shared across both engines.
  magTemperature: number;
  magTopK: number;
  magCfgMusiccoca: number;
  magCfgNotes: number;
  magCfgDrums: number;
  magDrums: number; // -1 auto · 0 off · 1 on
  magChunkFrames: number;
  magSeed: number; // -1 = fresh/random each run
  magExtend: boolean; // continue the current piece (morph without a cut)
  magNotes: number[]; // selected MIDI pitches that steer the melody
}

interface ParamsStore extends GenerateParamsState {
  setField: <K extends keyof GenerateParamsState>(key: K, value: GenerateParamsState[K]) => void;
  patch: (partial: Partial<GenerateParamsState>) => void;
  addChimeraClip: (clip: Omit<ChimeraClip, 'id' | 'noise' | 'isBase'> & { noise?: number }) => void;
  removeChimeraClip: (id: string) => void;
  updateChimeraClip: (id: string, patch: Partial<Omit<ChimeraClip, 'id'>>) => void;
  setChimeraField: <K extends keyof ChimeraState>(key: K, value: ChimeraState[K]) => void;
  moveChimeraClip: (id: string, direction: 'up' | 'down') => void;
  reorderChimeraClips: (orderedIds: string[]) => void;
  clearChimera: () => void;
}

export const useGenerateParamsStore = create<ParamsStore>()((set) => ({
  prompt: '',
  negativePrompt: '',
  model: 'medium',
  duration: 110,
  steps: 8,
  cfg: 1.0,
  seed: -1,
  batch: 1,

  samplerType: 'pingpong',
  sigmaMax: 1.0,
  durationPaddingSec: 6.0,

  apgScale: 1.0,
  cfgRescale: 0.0,
  cfgNormThreshold: 0.0,
  cfgIntervalMin: 0.0,
  cfgIntervalMax: 1.0,

  shiftMode: 'LogSNR',
  logsnrAnchorLength: 2000,
  logsnrAnchorLogsnr: -6.2,
  logsnrRate: 0.0,
  logsnrEnd: 2.0,
  fluxMinLen: 256,
  fluxMaxLen: 4096,
  fluxAlphaMin: 6.93,
  fluxAlphaMax: 6.93,
  fullBaseShift: 0.5,
  fullMaxShift: 1.15,
  fullMinLen: 256,
  fullMaxLen: 4096,

  initNoise: 0.7,
  initType: 'Audio',
  initAudioFile: null,
  initAudioEnabled: false,
  initAudioSourceLabel: null,
  initAudioSourceClipLabels: [],
  inversionSteps: 100,
  inversionGamma: 0.0,
  inversionUnconditional: false,

  inpaintAudioFile: null,
  inpaintEnabled: false,
  maskStart: 0,
  maskEnd: 0,

  fileFormat: 'wav',
  fileNaming: 'verbose',
  outputName: '',
  cutToDuration: true,
  autoplay: true,
  autoDownload: false,

  loras: [],

  chimera: {
    clips: [],
    targetBpm: 'auto',
    alignMode: 'weave',
    weaveBars: 8,
    weaveTotalBars: 90,
    weaveMaxPolyphony: 3,
    lastMeta: null,
  },

  magentaAvailable: false,

  magTemperature: 1.3,
  magTopK: 40,
  magCfgMusiccoca: 3.0,
  magCfgNotes: 1.0,
  magCfgDrums: 1.0,
  magDrums: -1,
  magChunkFrames: 25,
  magSeed: -1,
  magExtend: false,
  magNotes: [],

  setField: (key, value) => set({ [key]: value } as Partial<GenerateParamsState>),
  patch: (partial) => set(partial),

  addChimeraClip: (clip) => set((state) => ({
    chimera: {
      ...state.chimera,
      clips: [
        ...state.chimera.clips,
        {
          id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
            ? crypto.randomUUID()
            : `chimera-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          blob: clip.blob,
          mimeType: clip.mimeType,
          label: clip.label,
          noise: clip.noise ?? 0.5,
          isBase: false,
        },
      ],
    },
  })),

  removeChimeraClip: (id) => set((state) => ({
    chimera: {
      ...state.chimera,
      clips: state.chimera.clips.filter((c) => c.id !== id),
    },
  })),

  updateChimeraClip: (id, patch) => set((state) => ({
    chimera: {
      ...state.chimera,
      clips: state.chimera.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    },
  })),

  setChimeraField: (key, value) => set((state) => ({
    chimera: { ...state.chimera, [key]: value },
  })),

  moveChimeraClip: (id, direction) => set((state) => {
    const clips = [...state.chimera.clips];
    const idx = clips.findIndex((c) => c.id === id);
    if (idx === -1) return state;
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= clips.length) return state;
    [clips[idx], clips[target]] = [clips[target], clips[idx]];
    return { chimera: { ...state.chimera, clips } };
  }),

  reorderChimeraClips: (orderedIds) => set((state) => {
    const byId = new Map(state.chimera.clips.map((c) => [c.id, c]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((c): c is ChimeraClip => Boolean(c));
    // Append any not in orderedIds (defensive).
    const seen = new Set(orderedIds);
    state.chimera.clips.forEach((c) => {
      if (!seen.has(c.id)) reordered.push(c);
    });
    return { chimera: { ...state.chimera, clips: reordered } };
  }),

  clearChimera: () => set((state) => ({
    chimera: { ...state.chimera, clips: [], lastMeta: null },
  })),
}));

