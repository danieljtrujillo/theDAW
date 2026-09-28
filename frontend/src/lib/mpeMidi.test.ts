/**
 * MPE in MIDI files (lib/mpeMidi): an MPE file read into one part whose notes
 * carry their own expression.
 *
 * The sequence: a Seaboard-style file declares a lower zone of three member
 * channels (RPN 6 on channel 0) and plays a chord across them, each member
 * with its own pressure, CC 74 and wheel before the note and moving inside it.
 * Read, the notes sit on channel 0 in one part and one lane, each note's start
 * values and curves are its own channel's, the bend is read at the members'
 * 48 semitones, and no member wheel is left to make a lane. The same notes
 * without the configuration message are found by their shape; a plain
 * multi-channel file with bends alone is not taken for MPE.
 *
 *   cd frontend && npx tsx src/lib/mpeMidi.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData, type MidiTrack } from './midi.ts';
import { midiFileToRoll, midiFileToRollParts } from './rollMidi.ts';

const near = (a: number | undefined, b: number, eps: number, msg: string) => assert.ok(a !== undefined && Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

const seaboard = (withZone: boolean): MidiFileData => {
  const track: MidiTrack = {
    name: 'Seaboard',
    notes: [
      { tick: 0, note: 60, velocity: 100, durationTicks: 960, channel: 1 },
      { tick: 0, note: 64, velocity: 90, durationTicks: 960, channel: 2 },
      { tick: 480, note: 67, velocity: 80, durationTicks: 480, channel: 3 },
    ],
    // Each member set before its note, then moving inside it.
    pressures: [
      { tick: 0, channel: 1, value: 20 },
      { tick: 240, channel: 1, value: 100 },
      { tick: 0, channel: 2, value: 64 },
      { tick: 480, channel: 3, value: 127 },
    ],
    controls: [
      { tick: 0, channel: 1, controller: 74, value: 30 },
      { tick: 480, channel: 1, controller: 74, value: 90 },
      { tick: 0, channel: 2, controller: 74, value: 64 },
      { tick: 480, channel: 3, controller: 74, value: 10 },
    ],
    bends: [
      { tick: 0, channel: 1, value: 8192 },
      { tick: 600, channel: 1, value: 8192 + 4096 },
      { tick: 0, channel: 2, value: 8192 },
      { tick: 480, channel: 3, value: 0 },
    ],
    ...(withZone ? { mpeZones: [{ tick: 0, channel: 0, members: 3 }] } : {}),
  };
  return { ppq: 480, bpm: 120, tracks: [track] };
};

for (const withZone of [true, false]) {
  const what = withZone ? 'with its configuration message' : 'found by its shape';
  const back = parseMidi(encodeMidi(seaboard(withZone)));
  const t = back.tracks[0];
  if (withZone) assert.deepEqual(t.mpeZones, [{ tick: 0, channel: 0, members: 3 }], 'the MCM reads back');
  assert.ok(t.notes.every((n) => n.channel === (withZone ? 0 : 1)), `${what}: the notes sit on the part's channel`);
  assert.equal(t.bends, undefined, `${what}: no member wheel is left`);
  assert.equal(t.pressures, undefined);
  const c = t.notes.find((n) => n.note === 60)!.expr!;
  near(c.pressure, 20 / 127, 1e-9, 'the pressure where the note starts');
  near(c.timbre, 30 / 127, 1e-9, 'its timbre');
  near(c.pitchBend, 0, 1e-9, 'its bend');
  assert.equal(c.bendRange, 48, 'at the members’ 48 semitones');
  assert.deepEqual(c.curves?.pressure?.map((p) => [p.tick, Math.round(p.value * 127)]), [[240, 100]], 'the pressure moves inside it');
  assert.deepEqual(c.curves?.timbre?.map((p) => [p.tick, Math.round(p.value * 127)]), [[480, 90]]);
  near(c.curves?.pitchBend?.[0].value, 4096 / 8191, 1e-9, 'half the range up');
  const g = t.notes.find((n) => n.note === 67)!.expr!;
  near(g.pressure, 1, 1e-9, 'the G has its own channel’s pressure');
  near(g.pitchBend, -1, 1e-9, 'and its own full bend down');
  assert.equal(t.notes.find((n) => n.note === 64)!.expr!.curves, undefined, 'the E does not move');

  const roll = midiFileToRoll(back);
  assert.equal(roll.meter.lanes.length, 1, `${what}: one lane`);
  assert.equal(roll.bends.length, 0, 'no lane bend');
  const rc = roll.notes.find((n) => n.note === 60)!.expr!;
  assert.deepEqual(rc.curves?.pressure?.map((p) => p.tick), [480], 'curves on the roll’s 960 clock');
  const parts = midiFileToRollParts(back);
  assert.equal(parts.parts.length, 1, `${what}: one part`);
  assert.equal(parts.parts[0].notes.length, 3);
}

// A multi-channel file whose channels only bend is not MPE: its channels stay.
{
  const plain: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [
      {
        name: 'GM',
        notes: [0, 1, 2].map((ch) => ({ tick: 0, note: 50 + ch, velocity: 90, durationTicks: 480, channel: ch })),
        bends: [0, 1, 2].map((ch) => ({ tick: 0, channel: ch, value: 9000 })),
      },
    ],
  };
  const back = parseMidi(encodeMidi(plain));
  assert.deepEqual(back.tracks[0].notes.map((n) => n.channel), [0, 1, 2]);
  assert.equal(back.tracks[0].notes[0].expr, undefined);
}

console.log('mpeMidi: ok');
