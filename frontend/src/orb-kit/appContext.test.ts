import assert from 'node:assert/strict';

import { formattheDAWAppContext } from './appContext.ts';

const context = formattheDAWAppContext({
  ui: {
    activeTab: 'make',
    isLeftPanelOpen: true,
    docsOpen: false,
  },
  editor: {
    trackCount: 1,
    clipCount: 1,
    bpm: 120,
    playheadSec: 0,
    isPlaying: false,
    selectedClipId: null,
    loop: null,
    tracks: [{ id: 't1', name: 'Track 1', volume: 1, pan: 0, mute: false, solo: false, clipCount: 1 }],
    clips: [{ id: 'c1', label: 'Clip', trackId: 't1', startSec: 0, durationSec: 4, muted: false }],
    clipsTruncated: false,
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
assert.match(context, /"activeTab": "make"/);
assert.match(context, /"trackCount": 1/);
assert.match(context, /"prompt": "dark cinematic drums"/);
assert.match(context, /If the user asks to navigate/);
assert.match(context, /If the user asks for settings help/);

console.log('appContext runtime context regression passed');


