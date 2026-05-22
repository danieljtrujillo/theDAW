import assert from 'node:assert/strict';

import { handleStableDAWAction } from './actionHandlers.ts';
import { useGenerateParamsStore } from '../state/generateParamsStore.ts';
import { useGenerateStore, type GenerateParams } from '../state/generateStore.ts';

let captured: GenerateParams | null = null;
useGenerateStore.setState({
  submitGeneration: async (params) => {
    captured = params;
  },
});

useGenerateParamsStore.setState({
  prompt: 'dark industrial loop',
  negativePrompt: 'vocals',
  model: 'medium-rf',
  duration: 24,
  steps: 64,
  cfg: 7,
  seed: 99,
  batch: 3,
  samplerType: 'dpmpp',
  sigmaMax: 0.5,
  durationPaddingSec: 5,
  apgScale: 0.7,
  cfgRescale: 0.3,
  cfgNormThreshold: 9,
  cfgIntervalMin: 0.2,
  cfgIntervalMax: 0.85,
  shiftMode: 'Full',
  logsnrAnchorLength: 1900,
  logsnrAnchorLogsnr: -5.8,
  logsnrRate: 0.15,
  logsnrEnd: 2.2,
  fluxMinLen: 288,
  fluxMaxLen: 5000,
  fluxAlphaMin: 4,
  fluxAlphaMax: 9,
  fullBaseShift: 0.7,
  fullMaxShift: 1.4,
  fullMinLen: 288,
  fullMaxLen: 5000,
  initNoise: 0.45,
  initType: 'RF-Inversion',
  initAudioFile: null,
  initAudioEnabled: false,
  inversionSteps: 77,
  inversionGamma: 0.35,
  inversionUnconditional: true,
  inpaintAudioFile: null,
  inpaintEnabled: false,
  maskStart: 1.5,
  maskEnd: 3.25,
  fileFormat: 'ogg',
  fileNaming: 'seed',
  cutToDuration: false,
  autoplay: true,
  autoDownload: false,
  loras: [],
});

const message = handleStableDAWAction({ type: 'generate' });

assert.equal(message, 'Generation started');
assert.ok(captured, 'assistant generate action should submit generation params');
assert.equal(captured?.samplerType, 'dpmpp');
assert.equal(captured?.sigmaMax, 0.5);
assert.equal(captured?.durationPaddingSec, 5);
assert.equal(captured?.apgScale, 0.7);
assert.equal(captured?.cfgRescale, 0.3);
assert.equal(captured?.cfgNormThreshold, 9);
assert.equal(captured?.cfgIntervalMin, 0.2);
assert.equal(captured?.cfgIntervalMax, 0.85);
assert.equal(captured?.shiftMode, 'Full');
assert.equal(captured?.fullMaxShift, 1.4);
assert.equal(captured?.inversionSteps, 77);
assert.equal(captured?.inversionGamma, 0.35);
assert.equal(captured?.inversionUnconditional, true);
assert.equal(captured?.fileFormat, 'ogg');
assert.equal(captured?.fileNaming, 'seed');
assert.equal(captured?.cutToDuration, false);
assert.deepEqual(captured?.loras, []);

console.log('actionHandlers generation dispatch regression passed');
