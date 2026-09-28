import assert from 'node:assert/strict';

import { formattheDAWAppContext } from './appContext.ts';

const context = formattheDAWAppContext({
  ui: {
    activeTab: 'make',
    isLeftPanelOpen: true,
    docsOpen: false,
  },
  editor: {
    trackCount: 2,
    clipCount: 2,
    midiClipCount: 1,
    audioClipCount: 1,
    bpm: 120,
    timeSignature: { num: 7, den: 8 },
    snap: '1/8',
    tool: 'move',
    playheadSec: 0,
    isPlaying: false,
    selectedClipId: null,
    selectedClipIds: ['c1', 'c2'],
    snapshotNames: ['before the chorus rewrite'],
    loop: null,
    markers: [{ id: 'm1', sec: 16, label: 'Drop' }],
    tracks: [
      { id: 't1', name: 'Track 1', kind: 'audio', volume: 1, pan: 0, mute: false, solo: false, armed: false, frozen: false, instrumentProgram: null, drums: false, fxChain: [], clipCount: 1 },
      { id: 't2', name: 'Keys', kind: 'midi', volume: 1, pan: 0, mute: false, solo: false, armed: false, frozen: false, instrumentProgram: 4, drums: false, fxChain: ['reverb'], clipCount: 1 },
    ],
    clips: [
      { id: 'c1', label: 'Clip', trackId: 't1', kind: 'audio', startSec: 0, durationSec: 4, muted: false, gain: 1, fadeInSec: 0, fadeOutSec: 0, instrumentProgram: null, noteCount: null, sourceBpm: null },
      { id: 'c2', label: 'Keys', trackId: 't2', kind: 'midi', startSec: 0, durationSec: 8, muted: false, gain: 1, fadeInSec: 0, fadeOutSec: 0, instrumentProgram: 4, noteCount: 37, sourceBpm: 120 },
    ],
    clipsTruncated: false,
    automationLaneCount: 0,
    masterFxChain: [],
    dirty: false,
  },
  locatableFeatures: ['make', 'panel-levels'],
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
    wavBitDepth: '16',
    fileNaming: 'verbose',
    cutToDuration: true,
    loraSlotCount: 0,
  },
  attachments: [],
});

assert.match(context, /<current_app_context>/);
assert.match(context, /"assistant_is_inside_running_app": true/);
assert.match(context, /"activeTab": "make"/);
assert.match(context, /"trackCount": 2/);
// MIDI must be distinguishable from audio: this is the field the assistant reads.
assert.match(context, /"kind": "midi"/);
assert.match(context, /"noteCount": 37/);
assert.match(context, /"midiClipCount": 1/);
assert.match(context, /"snap": "1\/8"/);
assert.match(context, /"label": "Drop"/);
assert.match(context, /Never assume a track is audio/);
assert.match(context, /"prompt": "dark cinematic drums"/);
assert.match(context, /If the user asks to navigate/);
assert.match(context, /If the user asks for settings help/);
assert.match(context, /locate_feature/);
assert.match(context, /"locatableFeatures"/);
assert.match(context, /"wavBitDepth": "16"/);

// The three fields the overdrive tools need to be usable without a guess:
// editor_seek_bar counts bars from the meter, editor_loop_selection acts on the
// whole selection (not selectedClipId), and editor_restore only accepts a name
// that already exists.
assert.match(context, /"timeSignature": \{\s*"num": 7,\s*"den": 8\s*\}/);
assert.match(context, /"selectedClipIds": \[\s*"c1",\s*"c2"\s*\]/);
assert.match(context, /"snapshotNames": \[\s*"before the chorus rewrite"\s*\]/);

console.log('appContext runtime context regression passed');


