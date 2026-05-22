import type { GenerateParamsState } from '../state/generateParamsStore';

export interface GenerationPreset {
  id: string;
  name: string;
  description: string;
  color: string;
  params: Partial<GenerateParamsState>;
}

export const GENERATION_PRESETS: GenerationPreset[] = [
  {
    id: 'arc-default',
    name: 'ARC Default',
    description: 'Standard ARC preset. 8-step pingpong, no guidance. Fast, high-quality generation out of the box. Best starting point for most use cases.',
    color: '#8b5cf6',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'rf-quality',
    name: 'RF Quality',
    description: 'Full RF pipeline with 50 steps, DPM++ sampler, CFG 7. Maximum prompt adherence and detail. Slower but highest fidelity. Use with RF models only.',
    color: '#06b6d4',
    params: {
      model: 'medium-rf', steps: 50, cfg: 7.0, samplerType: 'dpmpp',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'rf-draft',
    name: 'RF Draft',
    description: 'Quick RF generation for previewing ideas. 20 steps with Euler sampler and moderate guidance. Fastest RF config that still sounds decent.',
    color: '#22c55e',
    params: {
      model: 'medium-rf', steps: 20, cfg: 5.0, samplerType: 'euler',
      sigmaMax: 1.0, durationPaddingSec: 4.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'long-ambient',
    name: 'Long Ambient',
    description: 'Optimized for long-form ambient and atmospheric content (3+ min). Flux shift for better structure over long durations. Extra padding so reverb tails breathe.',
    color: '#a855f7',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 12.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'Flux', duration: 180, batch: 1,
      fluxMinLen: 256, fluxMaxLen: 4096, fluxAlphaMin: 6.93, fluxAlphaMax: 6.93,
      cutToDuration: false, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'tight-loop',
    name: 'Tight Loop',
    description: 'Short, punchy loops for beat-making and sampling. 8-bar territory. Minimal padding for clean cuts. No shift needed at short durations.',
    color: '#f97316',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 2.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'None', duration: 8, batch: 1,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'batch-explore',
    name: 'Batch Explore',
    description: 'Generate 4 variations at once for rapid A/B comparison. ARC speed with batch=4. Random seed so each output is unique. Great for finding directions.',
    color: '#eab308',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 4, seed: -1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'rf-precise',
    name: 'RF Surgical',
    description: 'Maximum mathematical precision with RK4 sampler (4x evaluations per step). 100 steps for extreme detail. Use when quality trumps everything and you have time to wait.',
    color: '#ef4444',
    params: {
      model: 'medium-rf', steps: 100, cfg: 7.0, samplerType: 'rk4',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.3, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'flac', initNoise: 0.7,
    },
  },
  {
    id: 'subtle-remix',
    name: 'Subtle Remix',
    description: 'Audio-to-audio with low noise (0.2) — preserves most of the original while adding stylistic flavor from the prompt. Like applying a filter to a finished track.',
    color: '#14b8a6',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      initNoise: 0.2, initType: 'Audio', initAudioEnabled: true,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav',
    },
  },
  {
    id: 'heavy-remix',
    name: 'Heavy Remix',
    description: 'Aggressive audio-to-audio transformation. High noise (0.85) keeps just the skeleton of the original. The prompt drives most of the output. Good for creative reinterpretation.',
    color: '#ec4899',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      initNoise: 0.85, initType: 'Audio', initAudioEnabled: true,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav',
    },
  },
  {
    id: 'rf-creative',
    name: 'RF Creative',
    description: 'RF model with relaxed guidance (CFG 3) for more creative freedom. APG at 0.8 softens artifacts. The model improvises more while still respecting the prompt direction.',
    color: '#6366f1',
    params: {
      model: 'medium-rf', steps: 50, cfg: 3.0, samplerType: 'dpmpp',
      sigmaMax: 1.0, durationPaddingSec: 6.0, apgScale: 0.8,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.1, cfgIntervalMax: 0.9,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'small-fast',
    name: 'Small Fast',
    description: 'Small ARC model for instant generation on any GPU. Lower quality ceiling than medium but generates in seconds. Great for rapid prototyping and CPU-viable inference.',
    color: '#84cc16',
    params: {
      model: 'small', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 4.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'LogSNR', duration: 30, batch: 1,
      logsnrAnchorLength: 2000, logsnrAnchorLogsnr: -6.2, logsnrRate: 0.0, logsnrEnd: 2.0,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
  {
    id: 'full-shift-long',
    name: 'Full Shift',
    description: 'Most aggressive schedule shift (Full mode) for maximum structure control on longer content. Combines training + sampling shifts. Use when LogSNR alone sounds mushy.',
    color: '#d946ef',
    params: {
      model: 'medium', steps: 8, cfg: 1.0, samplerType: 'pingpong',
      sigmaMax: 1.0, durationPaddingSec: 8.0, apgScale: 1.0,
      cfgRescale: 0.0, cfgNormThreshold: 0.0, cfgIntervalMin: 0.0, cfgIntervalMax: 1.0,
      shiftMode: 'Full', duration: 60, batch: 1,
      fullBaseShift: 0.5, fullMaxShift: 1.15, fullMinLen: 256, fullMaxLen: 4096,
      cutToDuration: true, fileFormat: 'wav', initNoise: 0.7,
    },
  },
];
