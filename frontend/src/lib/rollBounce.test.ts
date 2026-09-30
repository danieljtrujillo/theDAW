/**
 * The piano roll's EDIT key (lib/rollBounce) and the linked roll's voice
 * (lib/clipProgram rollVoice), replayed against the real editor and roll
 * stores and the real MIDI render queue with a stand-in synth.
 *
 * The sequence: the picker is on a soundfont program, the roll's notes are
 * sent to EDIT, the picker is changed, the part's track is given its own
 * instrument, the roll (still linked) is edited and saved again, the part
 * keeps a render and is saved again, and the track becomes a drum track. At
 * 8039b45 the new track got no program, so changing the picker re-voiced the
 * part; a linked save rendered through the picker and left renderedProgram
 * stale; and the roll auditioned every note on the picker's program.
 *
 * A clip's audio is an optional render (lib/midiRender), and the EDIT key
 * renders nothing for a part that plays live: a 24-part score sent part by
 * part holds no audio until an export. At 057f7499 every new part rendered at
 * once and kept its WAV, and a linked part holding a render re-rendered on
 * every send, outside the render queue. A part with no program cannot play
 * live: its render is queued, marked as made so it can be heard, and dropped
 * once the part plays live. Run from `frontend/`:
 *   npx tsx src/lib/rollBounce.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';
import { configureMidiRenderQueue, requestMidiRender } from '../state/midiRenderQueue.ts';
import { liveMidiIfHeard } from '../state/liveMixer.ts';
import { bounceRollToEditor, type RollBounceDeps } from './rollBounce.ts';
import { clipRenderIsStale, effectiveProgramFor, rollVoice, type GlobalVoice } from './clipProgram.ts';
import { midiClipNominalSec, midiRenderState, type MidiStepRender } from './midiRender.ts';

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();

let global: GlobalVoice = { useSoundfont: true, activeProgram: 1 };
const renders: Array<{ program?: number; percussion?: boolean; totalSteps: number; notes: number }> = [];
const render: MidiStepRender = (notes, _bpm, totalSteps, opts) => {
  renders.push({ program: opts.program, percussion: opts.percussion, totalSteps, notes: notes.length });
  return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: 2 });
};
configureMidiRenderQueue({
  render,
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
  global: () => global,
  ensureReady: () => Promise.resolve(),
  livePlan: liveMidiIfHeard,
});
const deps: RollBounceDeps = { global: () => global };

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

const clipOf = (id: string) => ed().clips.find((c) => c.id === id)!;
const trackOf = (id: string) => ed().tracks.find((t) => t.id === clipOf(id).trackId)!;
const voiceNow = () => rollVoice(roll().editingClipId, ed().clips, ed().tracks, global);
const stateOf = (id: string) => midiRenderState(clipOf(id), trackOf(id), global);
const playsLive = (id: string) => liveMidiIfHeard(ed().clips, ed().tracks, global).has(id);

async function main(): Promise<void> {
  ed().loadProject({ tracks: [], clips: [] });
  roll().clear();
  roll().setEditingClip(null);
  roll().addNote({ note: 60, step: 0, length: 4, velocity: 100 });
  roll().addNote({ note: 64, step: 4, length: 4, velocity: 100 });

  let clipId = '';
  await step('an unlinked send lands on a new track holding the picker\'s program and plays live with no render', async () => {
    assert.equal(voiceNow().program, 1, 'the unlinked roll auditions the picker');
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'created');
    clipId = done.clipId;
    assert.equal(renders.length, 0, 'nothing is rendered');
    assert.equal(done.rendering, false);
    assert.equal(trackOf(clipId).instrumentProgram, 1, 'the new track holds the program');
    assert.equal(clipOf(clipId).audioBlob, undefined, 'the part holds no audio');
    assert.equal(stateOf(clipId), 'none');
    assert.ok(playsLive(clipId), 'it plays live');
    assert.equal(roll().editingClipId, clipId, 'the roll is linked to the new clip');
    const nominal = midiClipNominalSec(clipOf(clipId), ed().bpm);
    assert.ok(Math.abs(clipOf(clipId).durationSec - nominal) < 1e-9, 'its window is its whole grid');
    assert.ok(Math.abs(done.duration - nominal) < 1e-9);
  });

  await step('changing the picker afterwards does not re-voice the part', () => {
    global = { useSoundfont: true, activeProgram: 48 };
    assert.equal(effectiveProgramFor(clipOf(clipId), trackOf(clipId), global), 1);
  });

  await step("the linked roll auditions through the clip's instrument, not the picker", () => {
    ed().updateTrack(trackOf(clipId).id, { instrumentProgram: 40 });
    assert.deepEqual(voiceNow(), { program: 40, percussion: false });
  });

  await step('a linked save writes the notes and renders nothing', async () => {
    roll().addNote({ note: 67, step: 8, length: 4, velocity: 100 });
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'updated' && done.clipId === clipId);
    assert.equal(renders.length, 0, 'still nothing rendered');
    assert.equal(clipOf(clipId).sourcePianoRoll?.length, 3, 'the new note is on the clip');
    assert.equal(stateOf(clipId), 'none');
  });

  await step('a part that keeps its render: a save leaves it stale and the queue brings it up to date, still kept', async () => {
    // "Keep rendered audio" in the clip's menu.
    await requestMidiRender(clipId, 'keep');
    assert.equal(renders.at(-1)?.program, 40, 'rendered through the track\'s instrument');
    assert.equal(stateOf(clipId), 'current');
    assert.equal(clipOf(clipId).renderAuto, undefined, 'kept on purpose');
    const before = renders.length;
    roll().addNote({ note: 72, step: 12, length: 4, velocity: 100 });
    await bounceRollToEditor(deps);
    assert.equal(renders.length, before, 'the send renders nothing');
    assert.equal(stateOf(clipId), 'stale', 'the kept render is out of date against the new notes');
    // EDIT's render upkeep ('cache'), as the effect queues it.
    await requestMidiRender(clipId, 'cache');
    assert.equal(renders.length, before + 1, 're-rendered once, through the queue');
    assert.equal(renders.at(-1)?.notes, 4, 'with the new note');
    assert.equal(stateOf(clipId), 'current');
    assert.equal(clipOf(clipId).renderAuto, undefined, 'and still kept');
    assert.ok(clipOf(clipId).audioBlob instanceof Blob);
  });

  await step('a drum track: the roll auditions on the drum channel with the track kit, and a save renders nothing new', async () => {
    ed().updateTrack(trackOf(clipId).id, { isPercussion: true, instrumentProgram: undefined });
    assert.deepEqual(voiceNow(), { program: 0, percussion: true });
    assert.equal(clipRenderIsStale(clipOf(clipId), trackOf(clipId), global), true, 'melodic audio on a drum track is stale');
    const before = renders.length;
    await bounceRollToEditor(deps);
    assert.equal(renders.length, before, 'the send renders nothing');
    await requestMidiRender(clipId, 'cache');
    assert.deepEqual(renders.at(-1), { program: 0, percussion: true, totalSteps: roll().totalSteps, notes: 4 }, 'the upkeep renders the kit on the drum channel');
    assert.equal(clipOf(clipId).renderedPercussion, true);
    assert.equal(stateOf(clipId), 'current');
  });

  await step('a roll whose linked clip is gone sends to a new track on the picker', async () => {
    ed().removeClip(clipId);
    assert.equal(voiceNow().program, 48);
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.kind === 'created' && done.clipId !== clipId);
    assert.equal(trackOf(done.clipId).instrumentProgram, 48);
    assert.equal(clipOf(done.clipId).audioBlob, undefined);
  });

  await step('with the picker on Basic the part has no program: its render is queued and marked as made to be heard', async () => {
    global = { useSoundfont: false, activeProgram: 48 };
    roll().setEditingClip(null);
    const before = renders.length;
    const done = await bounceRollToEditor(deps);
    assert.ok(done && done.rendering);
    assert.equal(renders.length, before + 1, 'one render, through the queue');
    assert.equal(renders.at(-1)?.program, undefined, 'no program: the render is the voice it has');
    assert.equal(trackOf(done.clipId).instrumentProgram, undefined);
    assert.ok(clipOf(done.clipId).audioBlob instanceof Blob, 'it can be heard');
    assert.equal(clipOf(done.clipId).renderAuto, true, 'made so it can be heard');
    assert.equal(stateOf(done.clipId), 'current');
    // The track is given an instrument: the part plays live, and EDIT's upkeep
    // drops the render instead of rendering it again after every edit.
    ed().updateTrack(trackOf(done.clipId).id, { instrumentProgram: 40 });
    assert.ok(playsLive(done.clipId));
    const out = await requestMidiRender(done.clipId, 'cache');
    assert.equal(out.kind, 'skipped');
    assert.equal(renders.length, before + 1, 'nothing rendered');
    assert.equal(clipOf(done.clipId).audioBlob, undefined, 'the automatic render is dropped');
    assert.equal(clipOf(done.clipId).renderAuto, undefined);
    assert.equal(stateOf(done.clipId), 'none', 'it plays live and renders when exported');
  });

  await step('a part split in EDIT: each half sent back from the roll keeps its window; a whole part takes the new grid', async () => {
    global = { useSoundfont: true, activeProgram: 1 };
    roll().clear();
    roll().setEditingClip(null);
    roll().setTotalSteps(64);
    for (let bar = 0; bar < 4; bar += 1) roll().addNote({ note: 60 + bar, step: bar * 16, length: 8, velocity: 100 });
    const sent = await bounceRollToEditor(deps);
    assert.ok(sent && sent.kind === 'created');
    const leftId = sent.clipId;
    const whole = clipOf(leftId);
    const rightId = ed().splitClipAt(leftId, whole.startSec + whole.durationSec / 2);
    assert.ok(rightId, 'the part splits in two');
    const left0 = { ...clipOf(leftId) };
    const right0 = { ...clipOf(rightId) };
    assert.ok(right0.offsetIntoSource > 0, 'the right half reads from the middle of the part');

    // Edit in Piano Roll on the left half, a note added inside it, EDIT.
    roll().setEditingClip(leftId);
    roll().addNote({ note: 72, step: 4, length: 4, velocity: 100 });
    const left = await bounceRollToEditor(deps);
    assert.ok(left && left.kind === 'updated' && left.clipId === leftId);
    assert.ok(Math.abs(clipOf(leftId).durationSec - left0.durationSec) < 1e-9, 'the left half keeps its window');
    assert.equal(clipOf(leftId).offsetIntoSource, 0);
    assert.ok(clipOf(leftId).startSec + clipOf(leftId).durationSec <= clipOf(rightId).startSec + 1e-9, 'and never covers the right half');
    assert.equal(clipOf(leftId).sourcePianoRoll?.length, 5, 'the new note is on the part');

    // The right half, sent back the same way, keeps its place, its offset and its window.
    roll().setEditingClip(rightId);
    roll().addNote({ note: 74, step: 52, length: 4, velocity: 100 });
    await bounceRollToEditor(deps);
    const right = clipOf(rightId);
    assert.ok(Math.abs(right.startSec - right0.startSec) < 1e-9);
    assert.ok(Math.abs(right.offsetIntoSource - right0.offsetIntoSource) < 1e-9, 'the right half still reads from the middle');
    assert.ok(Math.abs(right.durationSec - right0.durationSec) < 1e-9, 'and keeps its window');

    // A grid cut to before the right half's window: it shows the whole new grid.
    roll().setTotalSteps(16);
    await bounceRollToEditor(deps);
    assert.equal(clipOf(rightId).offsetIntoSource, 0);
    assert.ok(Math.abs(clipOf(rightId).durationSec - midiClipNominalSec(clipOf(rightId), ed().bpm)) < 1e-9);

    // An unsplit part shows its whole source, so a longer grid is its new window.
    roll().setEditingClip(null);
    roll().setTotalSteps(32);
    const fresh = await bounceRollToEditor(deps);
    assert.ok(fresh && fresh.kind === 'created');
    roll().setTotalSteps(64);
    await bounceRollToEditor(deps);
    const grown = clipOf(fresh.clipId);
    assert.ok(Math.abs(grown.durationSec - midiClipNominalSec(grown, ed().bpm)) < 1e-9, 'a whole part takes the whole new grid');
    assert.ok(grown.durationSec > fresh.duration + 1e-9, 'which is longer');
  });

  await step('an empty roll sends nothing', async () => {
    roll().clear();
    assert.equal(await bounceRollToEditor(deps), null);
  });

  console.log('rollBounce: ok');
}

await main();
