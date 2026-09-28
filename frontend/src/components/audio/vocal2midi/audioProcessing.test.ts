// The Vocal2MIDI experimental slides. generateMidiFile writes the bytes it wrote
// before its slides were shared with the piano roll (captured from the
// unmodified function), and the slides reach the roll as a curve that passes
// through every wheel message the file plays.
import assert from 'node:assert/strict';
import { generateMidiFile, slideBendEvents, slideBendPoints, V2M_BEND_RANGE } from './audioProcessing.ts';
import { SOUND_PROFILES } from './constants.ts';
import { parseMidi } from '../../../lib/midi.ts';
import { midiFileTempoMap } from '../../../lib/rollMidi.ts';
import { bendRawToValue, bendValueAt } from '../../../lib/pitchBend.ts';

const NOTES = [
  { midiNote: 60, startTime: 0, duration: 0.45, velocity: 100 },
  { midiNote: 62, startTime: 0.5, duration: 0.3, velocity: 90 },
  { midiNote: 67, startTime: 0.82, duration: 0.2, velocity: 110 },
  { midiNote: 55, startTime: 1.4, duration: 0.5, velocity: 80 },
  { midiNote: 56, startTime: 1.92, duration: 0.4, velocity: 70 },
];
const hex = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString('hex');

const OFF =
  '4d546864000000060001000201e04d54726b0000000b00ff510309703d00ff2f004d54726b0000004200b0494000b0484000b04a4000b05b2800903c64825d903c0027903e5a8169903e000f90436e811c9043008226903750830490370010903846823690380000ff2f00';
const ON =
  '4d546864000000060001000201e04d54726b0000000b00ff510309703d00ff2f004d54726b000000be00b0494000b0484000b04a4000b05b2800e0004000903c648236e000400ae000480ae0005009e000580ae0006000903c000ae000680ae0007009e000780ae07f7f00903e5a10e000408132e0004007e0004807e0005006e0005807e0006007e0006805903e0002e0007006e0007807e07f7f0090436e10e00040810c9043008226903750825ee0004007e0004407e0004806e0004c07e0005007e000540490370003e0005806e0005c07e00060009038460fe00040822790380000ff2f00';
const ON_NO_PROFILE =
  '4d546864000000060001000201e04d54726b0000000b00ff510307a12000ff2f004d54726b000000ae00e0004000903c648300e000400ce000480ce000500ce000580ce0006000903c000ce000680ce000700ce000780ce07f7f00903e5a13e00040815de0004008e0004809e0005008e0005809e0006008e0006806903e0002e0007009e0007808e07f7f0090436e13e00040812d904300826d9037508330e0004008e0004409e0004808e0004c09e0005008e000540690370002e0005809e0005c08e000600090384613e00040826d90380000ff2f00';

// At 97 BPM, which FF 51 cannot hold (618557 us reads back as 96.99997), the
// tempo track also carries the roll's tempo map text; every other byte is the
// one captured before. At 120 (500000 us) the file is as it was.
const TEMPO_97 = '4d54726b0000000b00ff510309703d00ff2f00';
const TEXT_97 = Buffer.from('theDAW:tempomap=0:97', 'ascii').toString('hex');
const DATA_97 = `00ff510309703d00ff01${(TEXT_97.length / 2).toString(16).padStart(2, '0')}${TEXT_97}00ff2f00`;
const WITH_TEXT_97 = `4d54726b${(DATA_97.length / 2).toString(16).padStart(8, '0')}${DATA_97}`;

// The file's bytes, with the option off and on.
{
  assert.equal(await hex(generateMidiFile(NOTES, 97, SOUND_PROFILES.DEFAULT)), OFF.replace(TEMPO_97, WITH_TEXT_97));
  assert.equal(await hex(generateMidiFile(NOTES, 97, SOUND_PROFILES.DEFAULT, { experimentalPitchBend: true })), ON.replace(TEMPO_97, WITH_TEXT_97));
  assert.equal(await hex(generateMidiFile(NOTES, 120, undefined, { experimentalPitchBend: true })), ON_NO_PROFILE);
  assert.deepEqual(slideBendEvents([NOTES[0]], (sec) => sec), []);
}

// The roll's curve: at every tick the file sends a wheel message, the curve is at the value in force there,
// to within a slide message's tick rounding; each slide is one ramp to its interval and a jump back.
for (const bpm of [97, 120]) {
  const file = parseMidi(new Uint8Array(await generateMidiFile(NOTES, bpm, undefined, { experimentalPitchBend: true }).arrayBuffer()));
  const wheel = file.tracks.flatMap((t) => t.bends ?? []);
  assert.ok(wheel.length > 0, `${bpm} BPM writes slides`);
  const points = slideBendPoints(NOTES, bpm);
  const inForce = new Map<number, number>();
  for (const b of wheel) inForce.set(b.tick, b.value);
  for (const [tick, value] of inForce) {
    const at = bendValueAt(points, tick / 120);
    assert.ok(Math.abs(at - bendRawToValue(value)) <= 0.021, `${bpm} BPM tick ${tick}: ${at} vs ${bendRawToValue(value)}`);
  }
  // 60 to 62 and 62 to 67 bend the full 2 semitones, 55 to 56 one.
  assert.deepEqual(points.filter((p) => p.shape === 'hold' && p.value !== 0).map((p) => p.value), [1, 1, 0.5]);
  assert.deepEqual(points.filter((p) => p.shape === 'linear').map((p) => p.value), [0, 0, 0]);
  assert.ok(points[0].step > 0, 'the centre at tick 0 is left out');
}
assert.equal(V2M_BEND_RANGE, 2);

// A Vocal2MIDI export reopens at the tempo it was made at: 90 BPM (666667 us,
// 89.999955 read from FF 51 alone) and 97 come back as 90 and 97, and 120 BPM
// needs no text.
for (const bpm of [90, 97, 120]) {
  const file = parseMidi(new Uint8Array(await generateMidiFile(NOTES, bpm).arrayBuffer()));
  assert.deepEqual(midiFileTempoMap(file).map((e) => [e.beat, e.bpm]), [[0, bpm]], `${bpm} BPM reopens as ${bpm}`);
  assert.equal(file.dawTempoMap === undefined, bpm === 120, `${bpm} BPM ${bpm === 120 ? 'needs no' : 'writes the'} tempo text`);
}

console.log('vocal2midi audioProcessing: ok');
