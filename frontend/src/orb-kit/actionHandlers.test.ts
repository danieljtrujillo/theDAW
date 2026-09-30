import assert from 'node:assert/strict';

import {
  editorToolNames,
  handletheDAWAction,
  handletheDAWActionResult,
  overrideEditorFacadeForTest,
  overrideEditorToolForTest,
  planStretch,
} from './actionHandlers.ts';
import { theDAW_ACTION_TYPES } from './assistantEvents.ts';
import { getToolTier } from './tool-tiers.ts';
import { useGenerateParamsStore } from '../state/generateParamsStore.ts';
import { useGenerateStore, type GenerateParams } from '../state/generateStore.ts';
import { useOnboardingStore } from '../onboarding/onboardingStore.ts';
import { useEditorStore } from '../state/editorStore.ts';
/** Bar 1's meter, as the single project meter read before the arrangement held a meter map. */
const barOneMeter = () => { const m = useEditorStore.getState().meterMap[0].meter; return { num: m.num, den: m.den }; };

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
  wavBitDepth: '32f',
  fileNaming: 'seed',
  cutToDuration: false,
  autoplay: true,
  autoDownload: false,
  loras: [],
});

// Through the result API, so both halves are proved at once: the app really
// started a generation (ok), and it said so in the sentence the model reads.
const started = handletheDAWActionResult({ type: 'generate' });

assert.deepEqual(started, { ok: true, message: 'Generation started' });
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
assert.equal(captured?.wavBitDepth, '32f');
assert.equal(captured?.fileNaming, 'seed');
assert.equal(captured?.cutToDuration, false);
assert.deepEqual(captured?.loras, []);

// The model writes a depth freehand; only the three tokens the backend knows
// may reach the store, and a 32 of any spelling means float.
const depthAfter = (value: unknown): string => {
  handletheDAWAction({ type: 'set_params', payload: { wav_bit_depth: value } });
  return useGenerateParamsStore.getState().wavBitDepth;
};
assert.equal(depthAfter('32f'), '32f');
assert.equal(depthAfter('24'), '24');
assert.equal(depthAfter('32-bit float'), '32f');
assert.equal(depthAfter(32), '32f');
assert.equal(depthAfter('lossless'), '16');

/** The dispatcher answers async for the tools that re-render audio or call the
 *  backend; these actions are synchronous and must stay that way. */
const saidNow = (action: Parameters<typeof handletheDAWAction>[0]): string => {
  const answer = handletheDAWAction(action);
  assert.equal(typeof answer, 'string', `${action.type} should answer synchronously`);
  return answer as string;
};

// locate_feature rings a real control, and declines the ids that have none
// rather than dimming the app around a ring that would never appear.
assert.equal(
  saidNow({ type: 'locate_feature', payload: { feature_id: 'make' } }),
  'Spotlighting MAKE (MAKE tab)',
);
assert.equal(useOnboardingStore.getState().soloFeatureId, 'make');

useOnboardingStore.getState().endSpotlight();
assert.match(
  saidNow({ type: 'locate_feature', payload: { feature_id: 'nope' } }),
  /^No feature "nope"\. Known ids: make, /,
);
assert.equal(useOnboardingStore.getState().soloFeatureId, null);

assert.match(
  saidNow({ type: 'locate_feature', payload: { feature_id: 'feature-tour' } }),
  /no one control to point at/,
);
assert.equal(useOnboardingStore.getState().soloFeatureId, null);

// A miss is a refusal, not a quiet success. The sentence above is what the
// model reads; `ok:false` is what tells a caller the app is UNCHANGED, and it
// is the only difference between "no feature "nope"" and a hit.
assert.deepEqual(handletheDAWActionResult({ type: 'not_a_real_action' }), {
  ok: false,
  message: 'Unknown action: not_a_real_action',
});
assert.equal(
  (handletheDAWActionResult({ type: 'locate_feature', payload: { feature_id: 'nope' } }) as { ok: boolean }).ok,
  false,
  'a feature that does not exist reports ok:false',
);
assert.equal(
  (handletheDAWActionResult({ type: 'locate_feature', payload: { feature_id: 'make' } }) as { ok: boolean }).ok,
  true,
  'a feature that does exist reports ok:true',
);
useOnboardingStore.getState().endSpotlight();

// ---------------------------------------------------------------------------
// Every editor_* / dj_* name the browser allows is actually dispatched.
//
// The allowlist in assistantEvents.ts is what lets a tool call through; a name
// on it with no handler reaches the `default` branch and answers "Unknown
// action", which the model reads as the app being broken rather than as its own
// mistake. This walks the whole vocabulary rather than spot-checking it,
// because the failure mode is one forgotten entry out of sixty-three.
// ---------------------------------------------------------------------------
const dawNames = [...theDAW_ACTION_TYPES].filter((n) => n.startsWith('editor_') || n.startsWith('dj_'));
assert.ok(dawNames.length >= 60, `expected the full editor/dj vocabulary, got ${dawNames.length}`);

// Called with an empty payload: every tool must answer with its own validation
// message. Anything that throws, or reports "Unknown action", is a wiring bug.
const unrouted: string[] = [];
for (const name of dawNames) {
  let answer: string;
  try {
    answer = await handletheDAWAction({ type: name });
  } catch (error) {
    unrouted.push(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (typeof answer !== 'string' || !answer) unrouted.push(`${name} returned ${JSON.stringify(answer)}`);
  else if (answer.startsWith('Unknown action')) unrouted.push(`${name} is allowlisted but has no handler`);
}
assert.deepEqual(unrouted, [], `unrouted tools:\n${unrouted.join('\n')}`);

// Every tool has a stated tier. Without one it silently falls back to
// T2_confirm, so a read-only tool would sit behind a 60s countdown.
const untiered = dawNames.filter((n) => getToolTier(n) === 'T2_confirm');
assert.deepEqual(
  untiered.sort(),
  [
    'editor_freeze_track',
    'editor_merge_clips',
    'editor_remove_clip',
    'editor_remove_marker',
    'editor_remove_track',
    'editor_reorder_tracks',
    'editor_restore',
  ],
  'only the destructive tools may be T2_confirm — anything else here is missing a tier',
);

// The table and the allowlist are the same set, minus the names the switch
// above still owns. A table key that is not allowlisted can never be called.
const notAllowlisted = editorToolNames().filter((n) => !theDAW_ACTION_TYPES.has(n));
assert.deepEqual(notAllowlisted, [], 'handlers the allowlist would reject');

// ---------------------------------------------------------------------------
// The arguments actually arrive.
//
// Each table entry narrows the payload to the keys its tool declares before
// handing it on (the facade's argument types carry test seams that a model must
// never be able to set). Narrowing to the WRONG keys silently drops them and
// the tool reports "nothing to change", so a few store-only tools are driven
// end to end through the dispatcher and the store is read back. The audio tools
// are covered against their seams in state/editorTools.test.ts and
// orb-kit/editorToolBridge.test.ts; here it is the wiring under test.
// ---------------------------------------------------------------------------
useEditorStore.getState().loadProject({
  tracks: [
    { id: 'tk', name: 'Keys', nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#8b5cf6' },
  ],
  clips: [],
  bpm: 120,
});

// editor_set_track: armed and instrument_program are exactly what T13 added to
// this declaration, and the previous inline handler ignored both.
assert.match(
  saidNow({ type: 'editor_set_track', payload: { track_id: 'Keys', armed: true, instrument_program: 33, pan: -0.5 } }),
  /armed=true/,
);
const keys = useEditorStore.getState().tracks[0];
assert.equal(keys.armed, true);
assert.equal(keys.instrumentProgram, 33);
assert.equal(keys.pan, -0.5);

// Freezing is UI-only, and the tool says so instead of reporting an empty edit.
assert.match(
  saidNow({ type: 'editor_set_track', payload: { track_id: 'Keys', frozen: true } }),
  /freeze button in the EDIT track header/,
);

assert.match(saidNow({ type: 'editor_set_time_signature', payload: { num: 7, den: 8 } }), /7\/8/);
assert.deepEqual(barOneMeter(), { num: 7, den: 8 });

// Bars come off that meter: bar 3 at 120bpm in 7/8 is 2 * 7 * (0.5 * 4/8) s.
assert.match(saidNow({ type: 'editor_seek_bar', payload: { bar: 3 } }), /bar 3/);
assert.ok(Math.abs(useEditorStore.getState().playheadSec - 3.5) < 1e-9);

assert.match(saidNow({ type: 'editor_snapshot', payload: { name: 'before' } }), /snapshot "before"/);
useEditorStore.getState().setBpm(90);
assert.match(saidNow({ type: 'editor_restore', payload: { name: 'before' } }), /Restored snapshot "before"/);
assert.equal(useEditorStore.getState().bpm, 120);
assert.match(saidNow({ type: 'editor_restore', payload: { name: 'nope' } }), /no snapshot called "nope"/);

assert.match(saidNow({ type: 'editor_set_snap', payload: { snap: '1/16' } }), /Snap is now 1\/16/);
assert.equal(useEditorStore.getState().snap, '1/16');
assert.match(saidNow({ type: 'editor_set_tool', payload: { tool: 'split' } }), /Tool is now "split"/);
assert.equal(useEditorStore.getState().tool, 'split');

// Freeze has no implementation at all — it must name the real path, never
// pretend, and never throw.
assert.match(saidNow({ type: 'editor_freeze_track', payload: { track_id: 'Keys' } }), /freeze button in the EDIT track header/);

// ---------------------------------------------------------------------------
// V4-3 — a tool that throws still answers.
//
// The facade promises never to throw, but a promise is not a proof: a bug in a
// clip op, a store action that throws on a bad record, or a rejected dynamic
// import all escape it. Whatever escapes must come back to the model as a
// sentence in the same turn — a thrown dispatcher takes the whole relay call
// down and the model sees a timeout instead of a reason.
// ---------------------------------------------------------------------------
{
  const restore = overrideEditorToolForTest('editor_get_notes', () => {
    throw new Error('facade exploded');
  });
  let threw = false;
  let answer: string | Promise<string>;
  try {
    answer = handletheDAWAction({ type: 'editor_get_notes', payload: { clip_id: 'x' } });
  } catch {
    threw = true;
  } finally {
    restore();
  }
  assert.equal(threw, false, 'a synchronous throw must not escape the dispatcher');
  assert.equal(answer, 'editor_get_notes: facade exploded', 'and it answers synchronously');
}
{
  const restore = overrideEditorToolForTest('editor_quantize_clip', async () => {
    throw new Error('render crashed');
  });
  try {
    assert.equal(await handletheDAWAction({ type: 'editor_quantize_clip', payload: {} }), 'editor_quantize_clip: render crashed');
  } finally {
    restore();
  }
}
{
  // Not every throw is an Error.
  const restore = overrideEditorToolForTest('editor_bounce_clip', () => Promise.reject('plain string'));
  try {
    assert.equal(await handletheDAWAction({ type: 'editor_bounce_clip', payload: {} }), 'editor_bounce_clip: plain string');
  } finally {
    restore();
  }
}
// The override is gone again: the real entry answers.
assert.match(await handletheDAWAction({ type: 'editor_get_notes', payload: { clip_id: 'nope' } }), /No clip "nope"/);

// ---------------------------------------------------------------------------
// V4-4 — the argument mapping, entry by entry.
// ---------------------------------------------------------------------------
const pianoBlob = new Blob([new Uint8Array(8)], { type: 'audio/wav' });
useEditorStore.getState().loadProject({
  tracks: [
    { id: 'tk', name: 'Keys', nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#8b5cf6' },
    { id: 'td', name: 'Drums', nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#22d3ee' },
  ],
  clips: [
    {
      id: 'mk', trackId: 'tk', label: 'keys', audioBlob: pianoBlob, mimeType: 'audio/wav',
      sourceDuration: 2, offsetIntoSource: 0, durationSec: 2, startSec: 0, color: '#8b5cf6',
      sourceKind: 'piano-roll', sourceBpm: 120, sourceTotalSteps: 16,
      sourcePianoRoll: [{ id: 'n1', note: 60, step: 0, length: 4, velocity: 100 }],
    },
    {
      id: 'x1', trackId: 'td', label: 'loop a', audioBlob: pianoBlob, mimeType: 'audio/wav',
      sourceDuration: 4, offsetIntoSource: 0, durationSec: 4, startSec: 0, color: '#22d3ee', sourceBpm: 100,
    },
    {
      id: 'x2', trackId: 'td', label: 'loop b', audioBlob: pianoBlob, mimeType: 'audio/wav',
      sourceDuration: 4, offsetIntoSource: 0, durationSec: 4, startSec: 4, color: '#22d3ee',
    },
  ],
  bpm: 120,
});
const clipNow = (id: string) => useEditorStore.getState().clips.find((c) => c.id === id);

// pick() — the facade's argument types carry seams that replace the MIDI synth
// and the audio context. A model that writes `render` or `ctxFactory` into a
// tool call must not reach them. Both are stubs that would throw loudly if
// called; the real renderer runs instead (and, having no Web Audio in Node,
// fails in its own words).
{
  let renderCalls = 0;
  let ctxCalls = 0;
  const seams = {
    render: async () => {
      renderCalls += 1;
      throw new Error('the model reached the render seam');
    },
    ctxFactory: () => {
      ctxCalls += 1;
      throw new Error('the model reached the ctxFactory seam');
    },
    sample_rate: 8000,
  };
  const midi = await handletheDAWAction({ type: 'editor_bounce_clip', payload: { clip_id: 'mk', ...seams } });
  assert.equal(renderCalls, 0, `render was handed to the facade: ${midi}`);
  assert.doesNotMatch(midi, /reached the/);
  const audio = await handletheDAWAction({ type: 'editor_bounce_clip', payload: { clip_id: 'x1', ...seams } });
  assert.equal(ctxCalls, 0, `ctxFactory was handed to the facade: ${audio}`);
  assert.doesNotMatch(audio, /reached the/);
}

// editor_crossfade_clips: the catalog's clip_id_a / clip_id_b are the facade's
// clip_a / clip_b. Mapped wrong, both resolve to nothing and the fade is refused.
assert.match(
  saidNow({ type: 'editor_crossfade_clips', payload: { clip_id_a: 'x1', clip_id_b: 'loop b', overlap_sec: 1 } }),
  /Crossfaded over 1s at 3s/,
);
assert.equal(clipNow('x1').fadeOutSec, 1);
assert.equal(clipNow('x2').fadeInSec, 1);
assert.equal(clipNow('x2').startSec, 3, 'the later clip slides back into the overlap');

// editor_rename_marker: `name` is the NEW label. Passed through as `name` it
// would be read as the marker to find, and the rename would have no label.
useEditorStore.getState().addMarker(16, 'Drop');
assert.match(saidNow({ type: 'editor_rename_marker', payload: { marker_id: 'Drop', name: 'Drop 2' } }), /Renamed marker "Drop" to "Drop 2"/);
assert.deepEqual(useEditorStore.getState().markers.map((m) => m.label), ['Drop 2']);

// editor_stretch_clip routes on what the clip IS.
assert.deepEqual(planStretch({ clip_id: 'x1', target_bpm: 125 }), {
  route: 'backend',
  args: { clip_id: 'x1', target_bpm: 125 },
});
// A MIDI clip is re-rendered locally, and the facade has no ratio target — a
// ratio is a duration: 2s x 1.5 = 3s.
assert.deepEqual(planStretch({ clip_id: 'keys', ratio: 1.5 }), {
  route: 'facade',
  args: { clip_id: 'keys', target_duration_sec: 3 },
});
assert.deepEqual(planStretch({ clip_id: 'mk', target_bpm: 90 }), { route: 'facade', args: { clip_id: 'mk', target_bpm: 90 } });
// An unknown clip goes to the facade so the "No clip X. Known clips: …" sentence
// is written in one place.
assert.equal(planStretch({ clip_id: 'nope', ratio: 2 }).route, 'facade');
assert.match(
  (planStretch({ clip_id: 'mk', ratio: 1.5, target_bpm: 90 }) as { error: string }).error,
  /exactly one of ratio, target_bpm or target_duration_sec \(got ratio and target_bpm\)/,
);
assert.match((planStretch({ clip_id: 'mk', ratio: 0 }) as { error: string }).error, /ratio must be a positive number/);

// And through the dispatcher: the audio clip reaches /stretch, the MIDI clip
// never touches the network.
{
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ detail: 'stub backend' }), { status: 500 });
  }) as typeof fetch;
  try {
    const toBackend = await handletheDAWAction({ type: 'editor_stretch_clip', payload: { clip_id: 'x1', target_bpm: 125 } });
    assert.deepEqual(urls, ['/api/editor-tools/stretch']);
    assert.match(toBackend, /stub backend/);
    urls.length = 0;
    // The MIDI half is answered by a stubbed facade: what is under test is that
    // the call is routed there with the ratio already turned into a duration —
    // not what the real renderer does in Node, which is none of this test's
    // business and would make the outcome depend on it.
    const received: unknown[] = [];
    const restoreFacade = overrideEditorFacadeForTest('stretchClip', async (args) => {
      received.push(args);
      return { ok: true, message: 'stub facade stretched it' };
    });
    let local: string;
    try {
      local = await handletheDAWAction({ type: 'editor_stretch_clip', payload: { clip_id: 'mk', ratio: 1.5 } });
    } finally {
      restoreFacade();
    }
    assert.deepEqual(urls, [], `a MIDI stretch went to the network: ${local}`);
    assert.equal(local, 'stub facade stretched it', 'answered by the facade');
    assert.deepEqual(received, [{ clip_id: 'mk', target_duration_sec: 3 }]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// editor_bounce_clip, deterministically: the facade is stubbed, so the entry's
// own mapping is what is observed. A payload carrying all three seams reaches
// the facade with none of them — and with the arguments it does declare intact.
{
  const received: unknown[] = [];
  const restoreFacade = overrideEditorFacadeForTest('bounceClip', async (args) => {
    received.push(args);
    return { ok: true, message: 'stub facade bounced it' };
  });
  let answer: string;
  try {
    answer = await handletheDAWAction({
      type: 'editor_bounce_clip',
      payload: {
        clip_id: 'mk',
        flatten: true,
        render: async () => {
          throw new Error('the model reached the render seam');
        },
        ctxFactory: () => {
          throw new Error('the model reached the ctxFactory seam');
        },
        sample_rate: 8000,
      },
    });
  } finally {
    restoreFacade();
  }
  assert.equal(answer, 'stub facade bounced it');
  assert.deepEqual(received, [{ clip_id: 'mk', flatten: true }]);
}

// The facade seam restores cleanly and refuses names the facade does not have.
assert.throws(() => overrideEditorFacadeForTest('notAFacadeFunction' as never, (() => null) as never), /no facade function/);

console.log('actionHandlers generation dispatch regression passed');


