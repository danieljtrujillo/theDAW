import assert from 'node:assert/strict';

import { buildGenerateJobFormData, type GenerateParams } from './generateStore.ts';

const loraFile = new File(['synthetic-lora'], 'style.safetensors', { type: 'application/octet-stream' });

const params: GenerateParams = {
  prompt: '  cinematic techno drums  ',
  negativePrompt: 'vocals, hiss',
  model: 'small-rf',
  duration: 12.5,
  steps: 42,
  cfg: 6.5,
  seed: 123,
  batch: 2,
  initNoise: 0.33,
  initType: 'RF-Inversion',
  initAudioEnabled: true,
  samplerType: 'rk4',
  sigmaMax: 0.75,
  durationPaddingSec: 4,
  apgScale: 0.8,
  cfgRescale: 0.2,
  cfgNormThreshold: 12,
  cfgIntervalMin: 0.15,
  cfgIntervalMax: 0.9,
  shiftMode: 'Flux',
  logsnrAnchorLength: 1800,
  logsnrAnchorLogsnr: -5.5,
  logsnrRate: 0.1,
  logsnrEnd: 2.5,
  fluxMinLen: 300,
  fluxMaxLen: 5000,
  fluxAlphaMin: 4.5,
  fluxAlphaMax: 8.5,
  fullBaseShift: 0.6,
  fullMaxShift: 1.3,
  fullMinLen: 300,
  fullMaxLen: 5000,
  inversionSteps: 88,
  inversionGamma: 0.25,
  inversionUnconditional: true,
  fileFormat: 'flac',
  fileNaming: 'prompt',
  cutToDuration: false,
  loras: [{ file: loraFile, weight: 0.65 }],
};

const form = buildGenerateJobFormData(params, params.prompt.trim());

assert.equal(form.get('model_name'), 'small-rf');
assert.equal(form.get('prompt'), 'cinematic techno drums');
assert.equal(form.get('negative_prompt'), 'vocals, hiss');
assert.equal(form.get('sampler_type'), 'rk4');
assert.equal(form.get('sigma_max'), '0.75');
assert.equal(form.get('duration_padding_sec'), '4');
assert.equal(form.get('apg_scale'), '0.8');
assert.equal(form.get('cfg_rescale'), '0.2');
assert.equal(form.get('cfg_norm_threshold'), '12');
assert.equal(form.get('cfg_interval_min'), '0.15');
assert.equal(form.get('cfg_interval_max'), '0.9');
assert.equal(form.get('dist_shift_type'), 'Flux');
assert.equal(form.get('flux_alpha_max'), '8.5');
assert.equal(form.get('inversion_steps'), '88');
assert.equal(form.get('inversion_gamma'), '0.25');
assert.equal(form.get('inversion_unconditional'), 'true');
assert.equal(form.get('file_format'), 'flac');
assert.equal(form.get('file_naming'), 'prompt');
assert.equal(form.get('cut_to_duration'), 'false');
assert.equal(form.get('lora_weight_0'), '0.65');
assert.equal((form.get('lora_file_0') as File).name, 'style.safetensors');

const initAudioFile = new File(['audio'], 'source.wav', { type: 'audio/wav' });
const disabledInitAudioForm = buildGenerateJobFormData(
  { ...params, initAudioFile, initAudioEnabled: false },
  params.prompt.trim(),
);
const enabledInitAudioForm = buildGenerateJobFormData(
  { ...params, initAudioFile, initAudioEnabled: true },
  params.prompt.trim(),
);

assert.equal(disabledInitAudioForm.has('init_audio'), false);
assert.equal((enabledInitAudioForm.get('init_audio') as File).name, 'source.wav');

console.log('generateStore form contract regression passed');
