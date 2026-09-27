/**
 * The Vocal2MIDI panel's voice stays its own.
 *
 * The sequence: the picker is on a program, EDIT holds a MIDI clip with no
 * program of its own (so it follows the picker), and the panel's assistant
 * picks "strings". At 8039b45 setInstrument wrote the global picker (program
 * 48 and soundfonts on), so the EDIT clip was re-voiced and re-rendered as
 * strings. Run from `frontend/`:
 *   npx tsx src/components/audio/vocal2midi/midiSynth.test.ts
 */
import assert from 'node:assert/strict';
import { useSoundfontStore } from '../../../lib/soundfontEngine.ts';
import { getMidiSynth, useVocalVoiceStore, vocalVoiceProgram } from './midiSynth.ts';
import { effectiveProgramFor } from '../../../lib/clipProgram.ts';

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

  await run('the Preview voice select back on "Same as the instrument" follows the picker', () => {
    useVocalVoiceStore.getState().setProgram(null);
    useSoundfontStore.getState().setActiveProgram(33);
    assert.equal(vocalVoiceProgram(), 33);
  });

  console.log('vocal2midi midiSynth: ok');
}

await main();
