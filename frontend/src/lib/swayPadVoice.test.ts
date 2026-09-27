/**
 * What a Sway pad plays (lib/swayPadVoice), replayed pad by pad.
 *
 * The sequence: the pads are in track mode, a drum track with the Brush kit
 * (40) is selected and pad 1 is hit; then a string track, then a track with no
 * instrument of its own, then sustain is latched. At 8039b45 track mode played
 * the track's program as a melodic program, so the Brush kit's 40 played GM
 * program 40 (Violin) as pitched notes, and a track with no program played a
 * piano while EDIT played it through the picker. Run from `frontend/`:
 *   npx tsx src/lib/swayPadVoice.test.ts
 */
import assert from 'node:assert/strict';
import { GM_DRUM_FOR_PAD, PAD_LO, PIANO_PAD_CH, SUSTAIN_PROGRAM, TRACK_PAD_CH, swayPadVoice } from './swayPadVoice.ts';
import { DRUM_CHANNEL } from './editChannels.ts';
import { GM_STANDARD_KIT, type GlobalVoice } from './clipProgram.ts';

const picker: GlobalVoice = { useSoundfont: true, activeProgram: 33 };

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

run('track mode on a drum track plays its kit on the drum channel with the drum layout', () => {
  const brush = { isPercussion: true, instrumentProgram: 40 };
  assert.deepEqual(swayPadVoice('track', 0, false, brush, picker), { channel: DRUM_CHANNEL, program: 40, note: GM_DRUM_FOR_PAD[0] });
  assert.deepEqual(swayPadVoice('track', 1, true, brush, picker), { channel: DRUM_CHANNEL, program: 40, note: GM_DRUM_FOR_PAD[1] }, 'sustain keeps the kit');
  assert.equal(swayPadVoice('track', 2, false, { isPercussion: true }, picker).program, GM_STANDARD_KIT, 'no kit: the Standard kit');
});

run('track mode on a melodic track plays its instrument, else the picker, as pitched notes', () => {
  assert.deepEqual(swayPadVoice('track', 3, false, { instrumentProgram: 48 }, picker), { channel: TRACK_PAD_CH, program: 48, note: PAD_LO + 3 });
  assert.equal(swayPadVoice('track', 3, false, {}, picker).program, 33, 'the picker, as EDIT plays the track');
  assert.equal(swayPadVoice('track', 3, false, {}, { useSoundfont: false, activeProgram: 33 }).program, 0, 'on Basic, the piano');
  assert.equal(swayPadVoice('track', 3, true, { instrumentProgram: 48 }, picker).program, SUSTAIN_PROGRAM, 'sustain rings an organ');
});

run('drums and piano modes are unchanged', () => {
  assert.deepEqual(swayPadVoice('drums', 5, false, null, picker), { channel: DRUM_CHANNEL, program: GM_STANDARD_KIT, note: GM_DRUM_FOR_PAD[5] });
  assert.deepEqual(swayPadVoice('piano', 5, false, null, picker), { channel: PIANO_PAD_CH, program: 0, note: PAD_LO + 5 });
  assert.equal(swayPadVoice('piano', 5, true, null, picker).program, SUSTAIN_PROGRAM);
});

console.log('swayPadVoice: ok');
