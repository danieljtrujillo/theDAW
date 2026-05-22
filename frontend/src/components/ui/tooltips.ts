/**
 * Tooltip content for all generation controls.
 * Sourced from docs/UI/hover-text-guide.md.
 *
 * "rich" = click-to-pin panel (sections, concepts, multi-line)
 * "hover" = lightweight hover-only (granular params)
 */

/* ── Rich (click-to-pin) tooltips ────────────────────────────────── */

export const RICH_TOOLTIPS: Record<string, { title: string; body: string }> = {
  prompt: {
    title: 'Prompt',
    body: `Describe the audio you want. Be specific: genre, instruments, tempo (BPM), mood, and texture.\n\nExample: "120 BPM house loop, deep sub bass, crispy hi-hats, vinyl crackle"`,
  },
  negativePrompt: {
    title: 'Negative Prompt',
    body: `Describe what you DON'T want. The model will actively avoid these qualities.\n\nExample: "poor quality, distortion, vocals, silence"\nOnly active when CFG scale is above 1.0.`,
  },
  samplerType: {
    title: 'Sampler Type',
    body: `The algorithm that progressively builds audio from noise.\n\n• Pingpong — Fast, excellent at 8 steps. Default for ARC models.\n• Euler — Fastest option. Good for quick drafts and RF models.\n• DPM++ — Medium speed, better quality per step. Best for RF models.\n• RK4 — Slowest (4x Euler), most mathematically precise.`,
  },
  scheduleShift: {
    title: 'Sampling Schedule Shift',
    body: `Controls where the model focuses its denoising effort across the generation process.\n\n• None — Equal effort at all stages.\n• LogSNR — Rebalances effort using a log curve. More focus on structure-forming stages. (Default)\n• Flux — Extra effort at high-noise stages. Good for longer audio.\n• Full — Combines both training and sampling shifts.\n\nLeave at default unless output sounds mushy (try more shift) or over-processed (try less).`,
  },
  initAudio: {
    title: 'Init Audio (Audio-to-Audio)',
    body: `Upload a recording as a starting point. The model transforms it based on your prompt.\n\nLower noise level = more of the original preserved.\n\n• Init Audio — Adds noise to your audio, then regenerates. Simple and effective.\n• RF-Inversion — Reverse-engineers your audio back into noise space more carefully, then regenerates. Better preserves timing and transients. RF models only.`,
  },
  inpainting: {
    title: 'Inpainting',
    body: `Regenerate a specific time region while keeping everything else untouched.\n\nFor continuation: set Mask Start to end of your audio and increase Seconds Total.\n\nEverything outside the mask region stays exactly as-is.`,
  },
  lora: {
    title: 'LoRA (Style Patches)',
    body: `Style patches trained on specific audio. Steer the model toward a particular sound without retraining.\n\nStack a style LoRA (full interval) with a detail LoRA (interval 0.0–0.5) for layered control.\n\nStrength 1.0 = full effect. Above 1.0 = amplified (can get weird above 2.0).`,
  },
  outputFormat: {
    title: 'Output Format',
    body: `• WAV — Lossless, perfect quality. Largest files. Best for final masters.\n• FLAC — Lossless, ~50% smaller than WAV. Great for archiving.\n• OGG — Lossy but good quality at smaller file sizes.`,
  },
  fileNaming: {
    title: 'File Naming',
    body: `• Verbose — Includes prompt, CFG, and seed in the filename. Best for tracking experiments.\n• Prompt — Just the prompt text. Cleaner but less info.\n• Seed — Just the seed number. For quick iteration.`,
  },
};

/* ── Hover-only tooltips ─────────────────────────────────────────── */

export const HOVER_TOOLTIPS: Record<string, string> = {
  duration:
    'How long the generated audio will be. Longer clips use more VRAM. Small model max: ~2 min. Medium model max: ~4.75 min.',
  steps:
    'Refinement passes. ARC models: leave at 8. RF models: start at 50. Below 20 sounds noticeably worse on RF.',
  cfg:
    'How strictly the model follows your prompt. 1.0 = freestyle (ARC default). 7.0 = strong adherence (RF default). Above 15 risks artifacts.',
  seed:
    'Random starting point for generation. Same seed + same settings = identical output. -1 = random every time.',
  batch:
    'How many audio clips to generate at once from the same settings.',
  sigmaMax:
    'Starting noise level. Default: 1.0. Below 1.0 with init audio = more of the original survives. Leave at 1.0 for normal generation.',
  durationPadding:
    'Extra seconds added internally so reverb tails don’t get cut off. Default: 6s. Increase for ambient content, decrease for tight loops.',
  apg:
    'Anti-saturation filter for guidance. 1.0 = full protection. 0.0 = raw guidance. Only matters when CFG > 1.',
  cfgIntervalMin:
    'Skip guidance during the noisiest stages. Raising this (try 0.2) can reduce artifacts. Only matters when CFG > 1.',
  cfgIntervalMax:
    'Skip guidance during the cleanest stages. Lowering this (try 0.8) can reduce over-processing. Only matters when CFG > 1.',
  cfgRescale:
    'Tames the volume/saturation boost from high CFG. Turn up (0.3–0.7) if output sounds overblown. Only matters when CFG > 1.',
  cfgNormThreshold:
    'Safety valve capping how large guidance correction can get. Raise if you hear pops/clicks with high CFG. Only matters when CFG > 1.',
  initNoise:
    '0.1 = subtle remix. 0.3 = loose cover. 0.5 = inspired by. 0.7 = heavy remix. 0.9 = almost from scratch. 1.0 = original ignored.',
  inversionSteps:
    'How carefully the model analyzes your input audio before regenerating. More steps = more faithful to the original.',
  inversionGamma:
    'Creative freedom during analysis. 0.0 = max faithfulness. 0.3 = slight creative liberty. 1.0 = max reinterpretation.',
  inversionUnconditional:
    'When ON: model ignores your text prompt during analysis, reconstructing purely from the audio’s structure. Best for prompt-based restyling.',
  maskStart:
    'Where the region to regenerate begins. Everything before this point is preserved untouched.',
  maskEnd:
    'Where the region to regenerate ends. Everything after this point is preserved untouched.',
  cutToDuration:
    'Trim the output to exactly your requested duration, removing silent padding at the end.',
  autoplay:
    'Automatically play the audio as soon as generation finishes.',
  autoDownload:
    'Automatically save each generated file to your downloads folder.',
  // Schedule shift sub-params
  logsnrAnchorLength:
    'Reference sequence length the shift curve is calibrated around. Default: 2000. Advanced — leave at default.',
  logsnrAnchorLogsnr:
    'How much effort goes to structure-forming stages. More negative = more effort on structure. Default: -6.2.',
  logsnrRate:
    'How quickly the shift scales with audio duration. Positive = more shift for longer audio. Default: 0.0.',
  logsnrEnd:
    'Where the shift tapers off at the end of generation. Default: 2.0.',
  fluxMinLen:
    'Shortest sequence length the shift is calibrated for. Default: 256. Only change for very short clips.',
  fluxMaxLen:
    'Longest sequence length the shift is calibrated for. Default: 4096. Only change for very long clips.',
  fluxAlphaMin:
    'Shift strength at short durations. Default: 6.93. Higher = stronger shift for short audio.',
  fluxAlphaMax:
    'Shift strength at long durations. Default: 6.93. Higher = stronger shift for long audio.',
  fullBaseShift:
    'Minimum schedule shift at short sequence lengths. Default: 0.5.',
  fullMaxShift:
    'Maximum schedule shift at long sequence lengths. Default: 1.15.',
  fullMinLen:
    'Sequence length where the base (minimum) shift applies. Default: 256.',
  fullMaxLen:
    'Sequence length where the max shift applies. Default: 4096.',
  // LoRA per-slot
  loraStrength:
    'How much this style patch influences the output. 0.0 = off. 1.0 = full effect. Above 1.0 = amplified (can get weird above 2.0).',
};
