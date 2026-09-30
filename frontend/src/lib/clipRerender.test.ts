/**
 * EDIT's instrument re-render (lib/clipRerender), replayed against the real
 * editor store.
 *
 * The sequence: a piano part is bounced to EDIT and its clip is as long as the
 * piano render; the track is set to Strings, so the clip is stale and is
 * re-rendered, and the string render rings 1.5 s longer. At 8039b45 the
 * re-render wrote the new blob and left the clip's window at the piano
 * render's length, so export cut the string chord's release. Then the clip is
 * trimmed and set to Harp: a trimmed window is kept. A clip whose own program
 * carries a bank (a roll part's Bank) renders in that bank, and a render that
 * says no bank leaves none recorded. Run from `frontend/`:
 *   npx tsx src/lib/clipRerender.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { rerenderStaleMidiClip, type ClipRerenderDeps } from './clipRerender.ts';
import { clipRenderIsStale, type GlobalVoice } from './clipProgram.ts';

const ed = () => useEditorStore.getState();
const global: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
let renderSec = 0;
let beforeWrite: () => void = () => {};
const renders: Array<{ program?: number; bank?: number; totalSteps: number }> = [];
const deps: ClipRerenderDeps = {
  render: (_notes, _bpm, totalSteps, opts) => {
    renders.push({ program: opts.program, totalSteps, ...(opts.bank !== undefined ? { bank: opts.bank } : {}) });
    return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: renderSec });
  },
  computePeaks: () => {
    beforeWrite();
    return Promise.resolve({ peaks: new Float32Array(4) });
  },
  global: () => global,
  ensureReady: () => Promise.resolve(true),
};

const near = (a: number | undefined, b: number, msg: string): void => {
  assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
};

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

async function main(): Promise<void> {
  ed().loadProject({ tracks: [], clips: [] });
  const trackId = ed().addTrack({ name: 'Cue', instrumentProgram: 0 });
  // Two bars at 120 BPM (4 s) and the piano's ring-out: the length the bounce gave it.
  const clipId = ed().addClipToTrack({
    trackId,
    label: 'cue',
    audioBlob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 4.6,
    offsetIntoSource: 0,
    durationSec: 4.6,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [{ id: 'n1', note: 60, step: 16, length: 16, velocity: 100 }],
    sourceBpm: 120,
    sourceTotalSteps: 32,
    renderedProgram: 0,
  });
  const clip = () => ed().clips.find((c) => c.id === clipId)!;
  const track = () => ed().tracks.find((t) => t.id === trackId)!;

  await step('a clip that is current is not re-rendered', async () => {
    assert.equal(await rerenderStaleMidiClip(clipId, deps), false);
    assert.equal(renders.length, 0);
  });

  await step('the track set to Strings: the re-render rings longer and the clip grows to hold it', async () => {
    ed().updateTrack(trackId, { instrumentProgram: 48 });
    assert.equal(clipRenderIsStale(clip(), track(), global), true);
    renderSec = 6.1;
    assert.equal(await rerenderStaleMidiClip(clipId, deps), true);
    assert.deepEqual(renders.at(-1), { program: 48, totalSteps: 32 });
    assert.equal(clip().renderedProgram, 48);
    near(clip().sourceDuration, 6.1, 'the source is the new render');
    near(clip().durationSec, 6.1, 'and the window holds its ring-out');
  });

  await step('a trimmed clip set to Harp keeps the window the user gave it', async () => {
    ed().updateClip(clipId, { durationSec: 3 });
    ed().updateTrack(trackId, { instrumentProgram: 46 });
    renderSec = 9;
    assert.equal(await rerenderStaleMidiClip(clipId, deps), true);
    assert.equal(clip().renderedProgram, 46);
    near(clip().sourceDuration, 9, 'the source is the new render');
    near(clip().durationSec, 3, 'the trimmed window is kept');
  });

  await step('a clip re-assigned while it renders is left for the next pass', async () => {
    ed().updateTrack(trackId, { instrumentProgram: 40 });
    beforeWrite = () => ed().updateTrack(trackId, { instrumentProgram: 41 });
    assert.equal(await rerenderStaleMidiClip(clipId, deps), false);
    beforeWrite = () => {};
    assert.equal(clip().renderedProgram, 46, 'nothing was written');
  });

  await step("a clip's own program in bank 1 renders in bank 1, and is current after", async () => {
    ed().updateClip(clipId, { instrumentProgram: 60, instrumentBank: 1 });
    assert.equal(clipRenderIsStale(clip(), track(), global), true, 'the bank makes the render stale');
    assert.equal(await rerenderStaleMidiClip(clipId, deps), true);
    assert.deepEqual(renders.at(-1), { program: 60, bank: 1, totalSteps: 32 });
    assert.deepEqual([clip().renderedProgram, clip().renderedBank], [60, 1]);
    assert.equal(clipRenderIsStale(clip(), track(), global), false);
  });

  await step('a render that names no bank clears the recorded one', async () => {
    ed().applyClipRender(clipId, { renderedProgram: 60 });
    assert.equal(clip().renderedBank, undefined, 'a bank stamp from an earlier render does not survive it');
    assert.equal(clipRenderIsStale(clip(), track(), global), true, 'so the clip is rendered in its bank again');
  });

  console.log('clipRerender: ok');
}

await main();
