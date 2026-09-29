/**
 * exportDialogModel's pure request builder: pins the export dialog's five
 * answers (what / range / format / destination / name+tail) to the exact
 * `BounceRequest` / `RenderRange` pairs the engine will run — no React, no
 * DOM, no store, so the whole suite runs under plain tsx.
 *
 * What is pinned here:
 *
 *  - mix / stems / clips each carry the fidelity flags WaveformEditor's
 *    mixdownRequest / stemRequest / selectionRequest use (renderCore.ts's
 *    header), restated as literals here rather than imported — this test,
 *    like the module it tests, stays free of anything under components/.
 *  - every field on ExportDialogState moves the built plan: flipping any one
 *    of them changes the JSON the plan serialises to.
 *  - range: 'project' is always null with no error; 'selection' and 'custom'
 *    go through rangeFromSeconds and report rangeError on an empty range
 *    without dropping the items.
 *  - tailSec is clamped the same way rangeFromSeconds clamps it.
 *
 * Run: npx tsx src/lib/render/exportDialogModel.test.ts
 */
import assert from 'node:assert/strict';

import { BOUNCE_SAMPLE_RATE } from '../renderCore.ts';
import {
  buildRenderRequest,
  defaultExportState,
  EXPORT_FORMATS,
  formatOf,
  SAMPLE_RATE_LABEL,
  type ExportDialogState,
} from './exportDialogModel.ts';
import { MAX_TAIL_SEC } from './renderRange.ts';

const baseState = (over: Partial<ExportDialogState> = {}): ExportDialogState => ({
  ...defaultExportState({ projectEndSec: 120, name: 'my session' }),
  ...over,
});

async function main(): Promise<void> {
  /* ── defaultExportState ──────────────────────────────────────────────────── */
  {
    const state = defaultExportState({ projectEndSec: 90 });
    assert.deepEqual(state.what, { kind: 'mix' });
    assert.equal(state.rangeMode, 'project');
    assert.equal(state.format, 'wav16');
    assert.equal(state.destination, 'both');
    assert.equal(state.name, 'mixdown', 'name defaults to mixdown when not given');
    assert.equal(state.tailSec, 0);
    assert.equal(state.selectionSec, null);
    assert.deepEqual(state.customSec, { startSec: 0, endSec: 90 }, 'custom starts at the full project');

    assert.equal(defaultExportState({ projectEndSec: 90, name: 'take 3' }).name, 'take 3');
    assert.deepEqual(
      defaultExportState({ projectEndSec: 90, selectionSec: { startSec: 2, endSec: 8 } }).selectionSec,
      { startSec: 2, endSec: 8 },
    );
  }

  /* ── mix builds one master request with the full fidelity flags ─────────── */
  {
    const plan = buildRenderRequest(baseState());
    assert.equal(plan.items.length, 1, 'mix builds exactly one item');
    assert.equal(plan.rangeError, null);
    const [item] = plan.items;
    assert.equal(item.kind, 'mixdown');
    assert.equal(item.trackId, undefined);
    assert.deepEqual(
      item.request,
      {
        scope: { kind: 'master' },
        sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: true,
        includeAutomation: true,
        includeTrackMix: true,
        float32: false,
        tailSec: 0,
      },
      'mirrors mixdownRequest: master + per-track racks, automation, mute AND solo',
    );
    assert.equal(item.label, 'my session.wav');
    assert.equal(item.range, null, 'project range stays null');
    assert.equal(item.formatId, 'wav16');
    assert.equal(item.destination, 'both');
  }

  /* ── stems build one track request per selected track id ────────────────── */
  {
    const plan = buildRenderRequest(baseState({ what: { kind: 'stems', trackIds: ['t1', 't2'] } }));
    assert.equal(plan.items.length, 2, 'one item per track id');
    assert.deepEqual(plan.items.map((i) => i.trackId), ['t1', 't2']);
    assert.deepEqual(plan.items.map((i) => i.label), ['my session — t1.wav', 'my session — t2.wav']);
    for (const item of plan.items) {
      assert.equal(item.kind, 'stem');
      assert.deepEqual(
        item.request,
        {
          scope: { kind: 'track', trackId: item.trackId },
          sampleRate: BOUNCE_SAMPLE_RATE,
          includeFx: true,
          includeAutomation: false,
          includeTrackMix: false,
          float32: false,
          tailSec: 0,
        },
        "mirrors stemRequest: the track's own rack, no automation, no track mix",
      );
    }
  }

  /* ── clips build one selection request carrying the clip ids ────────────── */
  {
    const plan = buildRenderRequest(baseState({ what: { kind: 'clips', clipIds: ['c1', 'c2'] } }));
    assert.equal(plan.items.length, 1, 'one item carrying every clip id');
    const [item] = plan.items;
    assert.equal(item.kind, 'selection');
    assert.equal(item.trackId, undefined);
    assert.deepEqual(
      item.request,
      {
        scope: { kind: 'selection', clipIds: ['c1', 'c2'] },
        sampleRate: BOUNCE_SAMPLE_RATE,
        includeFx: true,
        includeAutomation: true,
        includeTrackMix: true,
        float32: false,
        tailSec: 0,
      },
      'mirrors selectionRequest: the clips as they play, inserts, automation and the track mix',
    );
    assert.equal(item.label, 'my session.wav');
  }

  /* ── every enabled control changes the request ───────────────────────────── */
  {
    let state = baseState();
    let prevJson = JSON.stringify(buildRenderRequest(state));

    const step = (label: string, patch: Partial<ExportDialogState>): void => {
      state = { ...state, ...patch };
      const nextJson = JSON.stringify(buildRenderRequest(state));
      assert.notEqual(nextJson, prevJson, `changing ${label} changes the built plan`);
      prevJson = nextJson;
    };

    step('what', { what: { kind: 'stems', trackIds: ['t7'] } });
    step('rangeMode (project -> custom)', { rangeMode: 'custom' });
    step('customSec', { customSec: { startSec: 10, endSec: 40 } });
    step('format', { format: 'wav32' });
    step('destination', { destination: 'library' });
    step('name', { name: 'take two' });
    step('tailSec', { tailSec: 4 });
  }

  /* ── project range yields range null and no rangeError ───────────────────── */
  {
    const plan = buildRenderRequest(baseState({ rangeMode: 'project' }));
    assert.equal(plan.rangeError, null);
    assert.ok(plan.items.every((i) => i.range === null));
  }

  /* ── an empty custom range reports rangeError and leaves range null ──────── */
  {
    const plan = buildRenderRequest(
      baseState({ rangeMode: 'custom', customSec: { startSec: 10, endSec: 10 } }),
    );
    assert.equal(plan.rangeError, 'The chosen range is empty — set an end after the start.');
    assert.equal(plan.items.length, 1, 'the item is still built despite the range error');
    assert.equal(plan.items[0].range, null);

    // A reversed but unequal pair is not empty: rangeFromSeconds normalises
    // start/end (renderRange.ts), so 40..10 is the same span as 10..40.
    const reversed = buildRenderRequest(
      baseState({ rangeMode: 'custom', customSec: { startSec: 40, endSec: 10 } }),
    );
    assert.equal(reversed.rangeError, null, 'a reversed pair is normalised, not treated as empty');
    assert.ok(reversed.items[0].range, 'and it still produces a real range');

    // 'selection' with nothing selected reports the same error rather than
    // throwing on a null selectionSec.
    const noSelection = buildRenderRequest(baseState({ rangeMode: 'selection', selectionSec: null }));
    assert.equal(noSelection.rangeError, 'The chosen range is empty — set an end after the start.');
    assert.equal(noSelection.items[0].range, null);

    // A valid selection range does resolve, and carries no error.
    const withSelection = buildRenderRequest(
      baseState({ rangeMode: 'selection', selectionSec: { startSec: 5, endSec: 15 } }),
    );
    assert.equal(withSelection.rangeError, null);
    assert.ok(withSelection.items[0].range, 'a real selection produces a real range');
  }

  /* ── format wav32 sets float32 true, wav16 sets it false ─────────────────── */
  {
    assert.equal(buildRenderRequest(baseState({ format: 'wav32' })).items[0].request.float32, true);
    assert.equal(buildRenderRequest(baseState({ format: 'wav16' })).items[0].request.float32, false);

    // Two audio formats (encodeBounce is the whole audio encoder) and MIDI, which renders nothing.
    assert.equal(EXPORT_FORMATS.length, 3, 'the two WAVs encodeBounce writes, and MIDI');
    assert.deepEqual(EXPORT_FORMATS.map((f) => f.id), ['wav16', 'wav32', 'midi']);
    assert.deepEqual(EXPORT_FORMATS.filter((f) => f.kind === 'audio').map((f) => f.id), ['wav16', 'wav32']);
    assert.equal(formatOf('wav16').label, 'WAV · 16-bit PCM');
    assert.equal(formatOf('wav32').label, 'WAV · 32-bit float');
    assert.equal(formatOf('wav16').float32, false);
    assert.equal(formatOf('wav32').float32, true);
    assert.equal(formatOf('midi').kind, 'midi');
    assert.equal(formatOf('midi').ext, 'mid');
    assert.equal(SAMPLE_RATE_LABEL, '44.1 kHz · stereo (fixed)');
    // An audio plan has no MIDI file.
    assert.deepEqual(buildRenderRequest(baseState({ format: 'wav16' })).midiItems, []);
  }

  /* ── MIDI: one file of the notes, whatever WHAT picks, over the range ────── */
  {
    const mix = buildRenderRequest(baseState({ format: 'midi', name: 'symphony' }));
    assert.deepEqual(mix.items, [], 'MIDI renders nothing');
    assert.deepEqual(mix.midiItems, [{ label: 'symphony.mid', scope: { kind: 'all' }, rangeSec: null }]);
    const stems = buildRenderRequest(baseState({ format: 'midi', name: 'winds.midi', what: { kind: 'stems', trackIds: ['fl', 'ob'] } }));
    assert.deepEqual(stems.midiItems, [{ label: 'winds.midi', scope: { kind: 'tracks', trackIds: ['fl', 'ob'] }, rangeSec: null }], 'one file with the picked tracks; .midi is not doubled');
    const clips = buildRenderRequest(
      baseState({ format: 'midi', name: 'bars', what: { kind: 'clips', clipIds: ['c9'] }, rangeMode: 'custom', customSec: { startSec: 4, endSec: 12 } }),
    );
    assert.deepEqual(clips.midiItems, [{ label: 'bars.mid', scope: { kind: 'clips', clipIds: ['c9'] }, rangeSec: { startSec: 4, endSec: 12 } }]);
    const empty = buildRenderRequest(baseState({ format: 'midi', rangeMode: 'custom', customSec: { startSec: 5, endSec: 5 } }));
    assert.equal(empty.rangeError, 'The chosen range is empty — set an end after the start.');
    assert.equal(empty.midiItems[0].rangeSec, null, 'an empty range reaches no file');
  }

  /* ── tailSec is clamped to MAX_TAIL_SEC ───────────────────────────────────── */
  {
    assert.equal(
      buildRenderRequest(baseState({ tailSec: 999 })).items[0].request.tailSec,
      MAX_TAIL_SEC,
      'clamped up at the ceiling',
    );
    assert.equal(
      buildRenderRequest(baseState({ tailSec: -5 })).items[0].request.tailSec,
      0,
      'clamped down at zero',
    );
  }

  /* ── label formatting: trimmed, and .wav is never doubled ────────────────── */
  {
    assert.equal(
      buildRenderRequest(baseState({ name: '  padded  ' })).items[0].label,
      'padded.wav',
      'the name is trimmed before the extension is appended',
    );
    assert.equal(
      buildRenderRequest(baseState({ name: 'take1.wav' })).items[0].label,
      'take1.wav',
      'an existing .wav extension is not doubled',
    );
  }

  console.log('exportDialogModel: all assertions passed');
}

await main();
