import assert from 'node:assert/strict';

import { formatStableDAWAppContext } from './appContext.ts';

const context = formatStableDAWAppContext({
  ui: {
    activeView: 'advanced',
    isLeftPanelOpen: true,
    docsOpen: false,
  },
  chat: {
    selectedProvider: 'gemini',
    selectedModel: 'gemini-flash-recent',
  },
  generation: {
    isGenerating: false,
    jobStatus: 'idle',
    statusLabel: 'READY',
    progressPct: 0,
    error: null,
  },
  params: {
    prompt: 'dark cinematic drums',
    negativePrompt: '',
    model: 'medium',
    duration: 30,
    steps: 8,
    cfg: 1,
    seed: -1,
    batch: 1,
    samplerType: 'pingpong',
    sigmaMax: 1,
    durationPaddingSec: 6,
    apgScale: 1,
    cfgRescale: 0,
    cfgNormThreshold: 0,
    cfgIntervalMin: 0,
    cfgIntervalMax: 1,
    shiftMode: 'LogSNR',
    initNoise: 0.7,
    initType: 'Audio',
    initAudioLoaded: false,
    inpaintEnabled: false,
    inpaintAudioLoaded: false,
    maskStart: 0,
    maskEnd: 0,
    fileFormat: 'wav',
    fileNaming: 'verbose',
    cutToDuration: true,
    loraSlotCount: 0,
  },
  attachments: [],
});

assert.match(context, /<current_app_context>/);
assert.match(context, /"assistant_is_inside_running_app": true/);
assert.match(context, /"activeView": "advanced"/);
assert.match(context, /"prompt": "dark cinematic drums"/);
assert.match(context, /If the user asks to navigate/);
assert.match(context, /If the user asks for settings help/);

console.log('appContext runtime context regression passed');
