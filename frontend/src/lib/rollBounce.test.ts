/**
 * The piano roll's EDIT key (lib/rollBounce) and the linked roll's voice
 * (lib/clipProgram rollVoice), replayed against the real editor and roll
 * stores.
 *
 * The sequence: the picker is on a soundfont program, the roll's notes are
 * bounced to EDIT, the picker is changed, the part's track is given its own
 * instrument, the roll (still linked) is edited and saved again, and the track
 * becomes a drum track. At 8039b45 the new track got no program, so changing
 * the picker re-voiced the part; the clip got no renderedProgram, so EDIT
 * re-rendered it at once; a linked save rendered through the picker and left
 * renderedProgram stale; and the roll auditioned every note on the picker's
 * program. Run from `frontend/`:
 *   npx tsx src/lib/rollBounce.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';
import { bounceRollToEditor, type RollBounceDeps } from './rollBounce.ts';
import { clipRenderIsStale, effectiveProgramFor, rollVoice, type GlobalVoice } from './clipProgram.ts';

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();

let global: GlobalVoice = { useSoundfont: true, activeProgram: 1 };
const renders: Array<{ program?: number; percussion?: boolean; totalSteps: number }> = [];
const deps: RollBounceDeps = {
  render: (_notes, _bpm, totalSteps, opts) => {
    renders.push({ program: opts.program, percussion: opts.percussion, totalSteps });
    return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: 2 });
  },
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
  global: () => global,
};

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

const clipOf = (id: string) => ed().clips.find((c) => c.id === id)!;
const trackOf = (id: string) => ed().tracks.find((t) => t.id === clipOf(id).trackId)!;
const voiceNow = () => rollVoice(roll().editingClipId, ed().clips, ed().tracks, global);

async function main(): Promise<void> {
  ed().loadProject({ tracks: [], clips: [] });
  roll().clear();
  roll().setEditingClip(null);
  roll().addNote({ note: 60, step: 0, length: 4, velocity: 100 });
  roll().addNote({ note: 64, step: 4, length: 4, velocity: 100 });

  let clipId = '';
  await step('an unlinked bounce renders through the picker and the new track holds that program', async () => {
    assert.equal(voiceNow().program, 1, 'the unlinked roll auditions the picker');
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'created');
    clipId = done.clipId;
    assert.equal(renders.at(-1)?.program, 1);
    assert.equal(trackOf(clipId).instrumentProgram, 1);
    assert.equal(clipOf(clipId).renderedProgram, 1);
    assert.equal(roll().editingClipId, clipId, 'the roll is linked to the new clip');
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), false, 'EDIT has nothing to re-render');
  });

  await step('changing the picker afterwards does not re-voice the part', () => {
    global = { useSoundfont: true, activeProgram: 48 };
    assert.equal(effectiveProgramFor(clipOf(clipId), trackOf(clipId), global), 1);
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), false);
  });

  await step("the linked roll auditions through the clip's instrument, not the picker", () => {
    ed().updateTrack(trackOf(clipId).id, { instrumentProgram: 40 });
    assert.deepEqual(voiceNow(), { program: 40, percussion: false });
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), true, 'the old audio is now stale');
  });

  await step("a linked save renders through the clip's instrument and records it", async () => {
    roll().addNote({ note: 67, step: 8, length: 4, velocity: 100 });
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'updated' && done.clipId === clipId);
    assert.equal(renders.at(-1)?.program, 40);
    assert.equal(clipOf(clipId).renderedProgram, 40);
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), false);
  });

  await step('a drum track: the roll auditions and saves on the drum channel with the track kit', async () => {
    ed().updateTrack(trackOf(clipId).id, { isPercussion: true, instrumentProgram: undefined });
    assert.deepEqual(voiceNow(), { program: 0, percussion: true });
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), true, 'melodic audio on a drum track is stale');
    await bounceRollToEditor(deps);
    assert.deepEqual(renders.at(-1), { program: 0, percussion: true, totalSteps: roll().totalSteps });
    assert.equal(clipOf(clipId).renderedProgram, 0);
    assert.equal(clipOf(clipId).renderedPercussion, true);
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), false);
  });

  await step('a later melodic render clears the drum stamp, so the clip reads as melodic audio', () => {
    ed().applyClipRender(clipId, { renderedProgram: 5 });
    assert.equal(clipOf(clipId).renderedPercussion, undefined);
  });

  await step('a roll whose linked clip is gone bounces to a new track on the picker', async () => {
    ed().removeClip(clipId);
    assert.equal(voiceNow().program, 48);
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'created' && done.clipId !== clipId);
    assert.equal(trackOf(done.clipId).instrumentProgram, 48);
    assert.equal(clipOf(done.clipId).renderedProgram, 48);
  });

  await step('with the picker on Basic the bounce has no program and follows the picker later', async () => {
    global = { useSoundfont: false, activeProgram: 48 };
    roll().setEditingClip(null);
    const done = await bounceRollToEditor(deps);
    assert.ok(done);
    assert.equal(renders.at(-1)?.program, undefined);
    assert.equal(trackOf(done.clipId).instrumentProgram, undefined);
    assert.equal(clipOf(done.clipId).renderedProgram, undefined);
  });

  await step('an empty roll bounces nothing', async () => {
    roll().clear();
    assert.equal(await bounceRollToEditor(deps), null);
  });

  console.log('rollBounce: ok');
}

await main();
