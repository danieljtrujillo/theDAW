import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  /** Library entry id when the clip came from the library (enables cached analysis). */
  entryId?: string;
  /** Immediate per-clip analysis (BPM badge, key badge, CRISPR beat rungs). */
  keyNote?: string | null;
  keyScale?: string | null;
  beats?: number[] | null;
  durationSec?: number | null;
  /** v2 analysis extras (all optional; absent on older rows). */
  keyConfidence?: number | null;
  keyStrength?: number | null;
  /** Opaque extra keys /api/chimera/analyze returned (downbeat_phase, ...,
   *  bars, sha256) — echoed back verbatim inside known_analysis so the
   *  mashup can skip recomputing them. */
  analysisExtras?: Record<string, unknown>;
}

export type ChimeraAlignMode = 'start' | 'downbeat' | 'weave';
export type ChimeraHarmonyMode = 'auto' | 'off';
export type ChimeraArc = 'song' | 'rise' | 'flat';
export type ChimeraHealMode = 'off' | 'preserve' | 'polish';
export type ChimeraEngine = 'v2' | 'v1';
export type ChimeraLane = 'lead' | 'support';

export interface ChimeraChunkPlacement {
  output_start_sec: number;
  output_end_sec: number;
  window_start_sec: number;
  window_end_sec: number;
  chunk_idx?: number;
  rms?: number;
  // v2 additive (absent on v1 meta)
  lane?: ChimeraLane;
  role?: 'full' | 'hp' | 'stem_found' | 'stem_layer';
  run_id?: number;
  gain_db?: number;
  phrase_idx?: number;
  fade_in_sec?: number;
  fade_out_sec?: number;
  /** OUTPUT slot edges without the transition tails. */
  nominal_start_sec?: number;
  nominal_end_sec?: number;
}

export interface ChimeraPhraseMeta {
  idx: number;
  start_sec: number;
  end_sec: number;
  bars: number;
  lufs: number;
  energy: number;
  section_label: string;
}

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
  /** CRISPR weave: the actual chunks pulled from this clip and where they land. */
  placements?: ChimeraChunkPlacement[];
  note: string | null;
  // v2 additive (absent on v1 meta)
  tempo_multiplier?: number;
  pitch_shift_semitones?: number;
  key?: string | null;
  scale?: string | null;
  key_confidence?: number | null;
  key_strength?: number | null;
  camelot?: string | null;
  harmonic_outlier?: boolean;
  atonal?: boolean;
  downbeat_phase?: number;
  downbeat_confidence?: number;
  phrase_phase?: number;
  phrase_confidence?: number;
  grid_locked?: boolean;
  lock_residual_ms?: number | null;
  /** CONFORMED (source / ratio) seconds, on-grid. */
  beats_stretched?: number[];
  sources_used?: 'full' | 'stems';
  conform_engine?: 'rubberband' | 'atempo';
  conform_preset?: string;
  phrases?: ChimeraPhraseMeta[];
}

export interface ChimeraSeam {
  /** OUTPUT seconds. */
  sec: number;
  kind: 'lead_switch' | 'drop' | 'support_in' | 'support_out';
  transition: 'blend' | 'cut' | 'fade';
  bars: number;
  heal_start_sec: number;
  heal_end_sec: number;
  clips: number[];
  lanes?: ChimeraLane[];
}

export interface ChimeraSection {
  start_sec: number;
  end_sec: number;
  label: string;
  target_energy: number;
}

export interface ChimeraMashupMeta {
  sample_rate: number;
  duration_sec: number;
  target_bpm_used: number;
  target_bpm_source: 'user' | 'base_clip' | 'median' | 'fallback';
  align_mode_used: ChimeraAlignMode;
  per_clip: ChimeraPerClipMeta[];
  warnings: string[];
  // v2 additive (absent on v1 meta)
  engine_used?: ChimeraEngine;
  harmony_mode_used?: ChimeraHarmonyMode;
  arc_used?: ChimeraArc;
  phrase_bars_used?: number;
  total_bars_used?: number;
  tempo_fit_pct?: number;
  bar_sec?: number;
  target_key?: string | null;
  target_scale?: string | null;
  target_camelot?: string | null;
  /** e.g. '124 BPM, key of A minor' — appended to the prompt when usePromptHint. */
  prompt_hint?: string | null;
  sections?: ChimeraSection[];
  seams?: ChimeraSeam[];
  lane_lufs?: { lead?: number | null; support?: number | null };
  master_lufs?: number | null;
  true_peak_db?: number | null;
  limiter_gr_db?: number | null;
  analysis_sources?: string[];
}

export interface ChimeraState {
  clips: ChimeraClip[];
  targetBpm: number | 'auto';
  alignMode: ChimeraAlignMode;
  weaveBars: number;
  weaveTotalBars: number;
  weaveMaxPolyphony: number;
  lastMeta: ChimeraMashupMeta | null;
  /** v2: Camelot key solver ('auto') or leave every clip at its own key. */
  harmony: ChimeraHarmonyMode;
  /** v2: energy arc of the arrangement. */
  arc: ChimeraArc;
  /** Seam healing at CREATE: off (init audio only), preserve (one inpaint
   *  pass on the seams), polish (a second pass on the result). */
  heal: ChimeraHealMode;
  /** Weave engine for A/B listening; only matters when alignMode === 'weave'. */
  engine: ChimeraEngine;
  /** Append the mashup's prompt_hint ('124 BPM, key of A minor') to the prompt. */
  usePromptHint: boolean;
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
  /** Extra inpaint spans [[start_sec, end_sec], ...] (Chimera seam healing);
   *  sent as the `inpaint_regions` form field. */
  inpaintRegions: [number, number][];

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
  /** Lifecycle of the WSL2 engine behind the Magenta option — drives the
   *  dropdown pill. The swap runs automatically on Model-dropdown change.
   *  'setup' means the WSL side was never installed (run Setup-MRT2 once). */
  magentaEngine: 'off' | 'starting' | 'ready' | 'error' | 'setup';
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

export const useGenerateParamsStore = create<ParamsStore>()(persist((set) => ({
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
  inpaintRegions: [],

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
    // 0 = match the generation Length (backend falls back to 90 bars when the
    // request carries neither a total nor a target duration)
    weaveTotalBars: 0,
    weaveMaxPolyphony: 3,
    lastMeta: null,
    harmony: 'auto',
    arc: 'song',
    heal: 'off',
    engine: 'v2',
    usePromptHint: false,
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
  magentaEngine: 'off',

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
          entryId: clip.entryId,
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
    inpaintRegions: [],
  })),
}), {
  name: 'thedaw-generate-params-v1',
  // Only the model choice persists. It used to reset to 'medium' on every
  // reload, so a user who had switched to 'small' (the only ungated model on
  // a fresh install) silently went back to requesting the gated one — and the
  // next inpaint or generate failed with no obvious cause (GH-132). Nothing
  // else is persisted: the store holds File/Blob objects that cannot be
  // serialised, and prompt/params are session state by design.
  partialize: (s) => ({ model: s.model }),
}));

