import { create } from 'zustand';

export interface LoraSlot {
  name: string;
  weight: number;
  file: File | null;
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
  inversionSteps: number;
  inversionGamma: number;
  inversionUnconditional: boolean;

  inpaintAudioFile: File | null;
  inpaintEnabled: boolean;
  maskStart: number;
  maskEnd: number;

  fileFormat: string;
  fileNaming: string;
  cutToDuration: boolean;
  autoplay: boolean;
  autoDownload: boolean;

  loras: LoraSlot[];
}

interface ParamsStore extends GenerateParamsState {
  setField: <K extends keyof GenerateParamsState>(key: K, value: GenerateParamsState[K]) => void;
  patch: (partial: Partial<GenerateParamsState>) => void;
}

export const useGenerateParamsStore = create<ParamsStore>()((set) => ({
  prompt: '',
  negativePrompt: '',
  model: 'medium',
  duration: 30,
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
  inversionSteps: 100,
  inversionGamma: 0.0,
  inversionUnconditional: false,

  inpaintAudioFile: null,
  inpaintEnabled: false,
  maskStart: 0,
  maskEnd: 0,

  fileFormat: 'wav',
  fileNaming: 'verbose',
  cutToDuration: true,
  autoplay: true,
  autoDownload: false,

  loras: [],

  setField: (key, value) => set({ [key]: value } as Partial<GenerateParamsState>),
  patch: (partial) => set(partial),
}));
