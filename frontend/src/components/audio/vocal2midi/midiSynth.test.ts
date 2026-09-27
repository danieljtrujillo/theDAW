/**
 * The Vocal2MIDI panel's voice reaches the roll it fills and nothing else.
 *
 * The sequence: the picker is on a program, EDIT holds a MIDI clip with no
 * program of its own (so it follows the picker), the panel's assistant picks
 * "strings", the panel's notes go to the (unlinked) roll, and the roll's EDIT
 * key bounces them. At 8039b45 setInstrument wrote the global picker (program
 * 48 and soundfonts on), so the EDIT clip was re-voiced and re-rendered as
 * strings. Keeping the picker alone must not lose what that write did for the
 * roll: the roll auditions and bounces the notes as strings, on a new track
 * that holds strings. Run from `frontend/`:
 *   npx tsx src/components/audio/vocal2midi/midiSynth.test.ts
 */
import assert from 'node:assert/strict';
import { getGlobalVoice, useSoundfontStore } from '../../../lib/soundfontEngine.ts';
import { getMidiSynth, vocalVoiceProgram } from './midiSynth.ts';
import { effectiveProgramFor, rollVoice } from '../../../lib/clipProgram.ts';
import { usePianoRollStore } from '../../../state/pianoRollStore.ts';
import { useEditorStore } from '../../../state/editorStore.ts';
import { bounceRollToEditor } from '../../../lib/rollBounce.ts';

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => console.log(`  ok - ${name}`));
}

async function main(): Promise<void> {
  useSoundfontStore.getState().setActiveProgram(1);
  useSoundfontStore.getState().setUseSoundfont(false);
  const editClip = {};
  const editTrack = {};

  await run("the assistant's instrument sets the panel voice and leaves the picker alone", async () => {
    await getMidiSynth().setInstrument('strings');
    const sf = useSoundfontStore.getState();
    assert.equal(sf.activeProgram, 1, 'the picker keeps its program');
    assert.equal(sf.useSoundfont, false, 'the picker stays on Basic');
    assert.equal(vocalVoiceProgram(), 48, 'the panel previews strings');
    assert.equal(
      effectiveProgramFor(editClip, editTrack, { useSoundfont: sf.useSoundfont, activeProgram: sf.activeProgram }),
      undefined,
      'an EDIT clip following the picker is not re-voiced',
    );
  });

  await run('the roll the panel fills auditions and bounces as strings on a track that holds strings', async () => {
    const roll = usePianoRollStore.getState();
    useEditorStore.getState().loadProject({ tracks: [], clips: [] });
    roll.setEditingClip(null);
    roll.importNotes([{ id: 'v1', note: 60, step: 0, length: 4, velocity: 100 }], 120);
    const ed = useEditorStore.getState();
    assert.deepEqual(
      rollVoice(usePianoRollStore.getState().editingClipId, ed.clips, ed.tracks, getGlobalVoice(), usePianoRollStore.getState().voiceProgram),
      { program: 48, percussion: false },
      'the roll auditions strings',
    );
    const rendered: Array<number | undefined> = [];
    const done = await bounceRollToEditor({
      render: (_n, _b, _t, o) => {
        rendered.push(o.program);
        return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: 2 });
      },
      computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
      global: getGlobalVoice,
    });
    assert.ok(done && done.kind === 'created');
    assert.deepEqual(rendered, [48], 'the bounce renders strings');
    const clip = useEditorStore.getState().clips.find((c) => c.id === done.clipId)!;
    assert.equal(useEditorStore.getState().tracks.find((t) => t.id === clip.trackId)?.instrumentProgram, 48, 'the new track holds strings');
    assert.equal(useSoundfontStore.getState().activeProgram, 1, 'the picker still has its program');
  });

  await run('the Roll voice select back on "Same as the instrument" follows the picker', () => {
    usePianoRollStore.getState().setVoiceProgram(null);
    useSoundfontStore.getState().setActiveProgram(33);
    assert.equal(vocalVoiceProgram(), 33);
  });

  console.log('vocal2midi midiSynth: ok');
}

await main();
