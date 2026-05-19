import { create } from 'zustand';

export interface GenerateParamsState {
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  batch: number;
  shiftMode: string;
  initNoise: number;
  initType: string;
  initAudioFile: File | null;
  inpaintAudioFile: File | null;
  inpaintEnabled: boolean;
  maskStart: number;
  maskEnd: number;
  loras: Array<{ name: string; weight: number }>;
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
  shiftMode: 'Flux',
  initNoise: 1.0,
  initType: 'Audio',
  initAudioFile: null,
  inpaintAudioFile: null,
  inpaintEnabled: false,
  maskStart: 0,
  maskEnd: 0,
  loras: [{ name: 'Analog_Warmth', weight: 0.8 }],

  setField: (key, value) => set({ [key]: value } as Partial<GenerateParamsState>),
  patch: (partial) => set(partial),
}));
