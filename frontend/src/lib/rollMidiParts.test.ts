/**
 * The roll's parts through a .mid file and back (lib/rollMidi), as the roll's
 * EXPORT and IMPORT keys run them: rollToMidiFile, encodeMidi, parseMidi and
 * midiFileToRollParts.
 *
 *   cd frontend && npx tsx src/lib/rollMidiParts.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { makeRollTrack } from './rollTracks.ts';
import { DEFAULT_LANES, migrateNotes, type PianoNote } from '../state/pianoRollStore.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';

const n = (step: number, note: number, lane?: number): PianoNote => ({ id: `n${step}-${note}-${lane ?? 0}`, note, step, length: 2, velocity: 90, ...(lane ? { lane } : {}) });
const base = {
  bpm: 110,
  totalSteps: 64,
  meterMap: normalizeMeterMap([{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }]),
  pickupSteps: 0,
  lanes: [...DEFAULT_LANES] as PolyLane[],
  bends: [] as LaneBend[],
};
const sig = (notes: readonly PianoNote[]) => notes.map((x) => `${x.note}@${x.step}/${x.length}${x.lane ? `L${x.lane}` : ''}`).sort().join(' ');

// Three parts: each its own named track, channel and program, and back as the same parts.
{
  const tracks = [
    makeRollTrack({ id: 'fl', name: 'Flute', program: 73, notes: migrateNotes([n(0, 72), n(4, 74)]), instrumentId: 'flute', color: '#22d3ee' }, 0),
    makeRollTrack({ id: 'hn', name: 'Horn in F', program: 60, bank: 1, notes: migrateNotes([n(0, 60)]), mute: true }, 1),
    makeRollTrack({ id: 'kit', name: 'Kit', program: 0, channel: 10, notes: migrateNotes([n(0, 36), n(2, 38)]) }, 2),
  ];
  const file = rollToMidiFile({ ...base, notes: [], tracks });
  assert.deepEqual(file.tracks.map((t) => t.name), ['Flute', 'Horn in F', 'Kit'], 'a track per part, named after it');
  assert.deepEqual(file.tracks.map((t) => t.notes[0].channel), [0, 1, 9], 'the flute on 1, the horn on 2, the kit on 10');
  assert.deepEqual(file.tracks[1].programs, [{ tick: 0, channel: 1, program: 60, bank: 1 }], 'the program, with the bank select for bank 1');
  assert.deepEqual(file.tracks[2].programs, [{ tick: 0, channel: 9, program: 0 }]);
  const parsed = parseMidi(encodeMidi(file));
  assert.deepEqual(parsed.tracks[1].programs, [{ tick: 0, channel: 1, program: 60, bank: 1 }], 'the bank select and program come back from the bytes');
  const back = midiFileToRollParts(parsed, 'rt');
  assert.equal(back.parts.length, 3);
  back.parts.forEach((p, i) => {
    const t = tracks[i];
    assert.deepEqual(
      [p.track.name, p.track.program, p.track.bank, p.track.channel, p.track.color, p.track.mute, p.track.instrumentId],
      [t.name, t.program, t.bank, t.channel, t.color, t.mute, t.instrumentId],
      `${t.name} comes back with every setting`,
    );
    assert.equal(sig(p.notes), sig(t.notes), `${t.name} comes back with its notes`);
  });
  assert.deepEqual(back.meter.meterMap[0].meter, { num: 7, den: 8, groups: [3, 2, 2] }, 'the meter rides along');
  assert.equal(back.bpm, 110);
}

// Parts with lanes: a track per part and lane, carrying both texts; a bent lane on a channel of its own.
{
  const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 16 }];
  const bends: LaneBend[] = [{ lane: 1, range: 2, points: [{ id: 'b', step: 0, value: 0.5, shape: 'hold' }] }];
  const tracks = [
    makeRollTrack({ id: 'vn', name: 'Violin', program: 40, notes: migrateNotes([n(0, 76), n(2, 77, 1)]) }, 0),
    makeRollTrack({ id: 'va', name: 'Viola', program: 41, notes: migrateNotes([n(0, 64), n(4, 65, 1)]) }, 1),
  ];
  const file = rollToMidiFile({ ...base, lanes, bends, notes: [], tracks });
  assert.deepEqual(file.tracks.map((t) => t.name), ['Violin · Lane A', 'Violin · Lane B', 'Viola · Lane A', 'Viola · Lane B']);
  assert.ok(file.tracks.every((t) => t.partMeta && t.laneMeta));
  const bentChannels = [file.tracks[1], file.tracks[3]].map((t) => t.notes[0].channel);
  assert.equal(new Set([...bentChannels, file.tracks[0].notes[0].channel, file.tracks[2].notes[0].channel]).size, 4, "each part's bent lane on a channel of its own");
  assert.ok(file.tracks[1].bends?.length && file.tracks[3].bends?.length, 'with its wheel');
  const back = midiFileToRollParts(parseMidi(encodeMidi(file)), 'rt');
  assert.deepEqual(back.parts.map((p) => p.track.name), ['Violin', 'Viola'], 'the lane tracks join into their parts');
  assert.equal(sig(back.parts[0].notes), sig(tracks[0].notes), 'the violin keeps its notes and their lanes, repeats dropped');
  assert.equal(sig(back.parts[1].notes), sig(tracks[1].notes));
  assert.deepEqual(back.meter.lanes.map((l) => [l.id, l.cycleSteps]), [[0, null], [1, 16]], 'the lanes come back');
}

// A roll of one part writes what it always wrote, plus its program when it
// has one and its part text, so the part comes back as it was.
{
  const plain = rollToMidiFile({ ...base, notes: migrateNotes([n(0, 60)]) });
  assert.equal(plain.tracks.length, 1);
  assert.equal(plain.tracks[0].name, 'Piano Roll');
  assert.equal(plain.tracks[0].programs, undefined, 'no program for a roll that follows the picker');
  assert.equal(plain.tracks[0].partMeta, undefined, 'a caller that hands no parts writes no part text');
  const one = makeRollTrack({ id: 'o', name: 'Oboe', program: 68, notes: migrateNotes([n(0, 70)]) }, 0);
  const withProgram = rollToMidiFile({ ...base, notes: one.notes, tracks: [one], activeTrackId: 'o' });
  assert.deepEqual(withProgram.tracks[0].programs, [{ tick: 0, channel: 0, program: 68 }]);
  assert.equal(withProgram.tracks[0].name, 'Piano Roll', 'the track keeps the name it always had');
  assert.ok(withProgram.tracks[0].partMeta?.includes('"name":"Oboe"'), 'and carries the part');
  const oboe = midiFileToRollParts(parseMidi(encodeMidi(withProgram)), 'rt').parts;
  assert.deepEqual(oboe.map((p) => [p.track.name, p.track.program]), [['Oboe', 68]], 'the part comes back from the bytes');
  const drums = makeRollTrack({ id: 'd', name: 'Kit', program: 25, channel: 10, notes: migrateNotes([n(0, 36)]) }, 0);
  const kit = rollToMidiFile({ ...base, notes: drums.notes, tracks: [drums], activeTrackId: 'd' });
  assert.equal(kit.tracks[0].notes[0].channel, 9, 'a percussion part is written on channel 10');
  assert.deepEqual(kit.tracks[0].programs, [{ tick: 0, channel: 9, program: 25 }]);
}

// The store's own state passes as it is: the active part's notes are read from `notes`.
{
  const a = makeRollTrack({ id: 'a', name: 'A', notes: [] }, 0);
  const b = makeRollTrack({ id: 'b', name: 'B', program: 33, notes: migrateNotes([n(0, 40)]) }, 1);
  const file = rollToMidiFile({ ...base, notes: migrateNotes([n(0, 72), n(2, 74)]), tracks: [a, b], activeTrackId: 'a', voices: new Map([['a', { program: 19 }]]) });
  assert.equal(file.tracks[0].notes.length, 2, "the active part's live notes, not its stale list entry");
  assert.deepEqual(file.tracks[0].programs, [{ tick: 0, channel: 0, program: 19 }], 'a part that follows the roll voice is written with the program it plays');
}

// A format 0 file (one track, several channels) opens as one part per channel.
{
  const file: MidiFileData = {
    ppq: 480,
    bpm: 90,
    tracks: [
      {
        name: 'Song',
        notes: [
          { tick: 0, note: 60, velocity: 90, durationTicks: 240, channel: 0 },
          { tick: 0, note: 36, velocity: 90, durationTicks: 240, channel: 9 },
          { tick: 480, note: 43, velocity: 90, durationTicks: 240, channel: 2 },
        ],
        programs: [{ tick: 0, channel: 0, program: 40 }, { tick: 0, channel: 2, program: 32 }],
      },
    ],
  };
  const back = midiFileToRollParts(parseMidi(encodeMidi(file)), 'f0');
  assert.deepEqual(
    back.parts.map((p) => [p.track.name, p.track.program, p.track.channel, p.notes.length]),
    [['Violin', 40, 1, 1], ['Acoustic Bass', 32, 3, 1], ['Song drums', 0, 10, 1]],
    'one part per channel, named by its program, the drums on 10 on the Standard kit its name names',
  );
  assert.equal(back.parts[0].track.instrumentId, 'violin');
  assert.equal(back.parts[2].track.instrumentId, 'drum-kit');
}

// A track name that is not UTF-8 (an older writer's Latin-1) still reads.
{
  const bytes = encodeMidi({ ppq: 480, bpm: 120, tracks: [{ name: 'Flute', notes: [{ tick: 0, note: 60, velocity: 90, durationTicks: 10, channel: 0 }] }] });
  // Patch the name to Latin-1 "Flûte" (one byte for the u-circumflex) keeping its length.
  const at = bytes.findIndex((b, i) => b === 0x46 && bytes[i + 1] === 0x6c && bytes[i + 2] === 0x75);
  assert.ok(at > 0);
  bytes[at + 2] = 0xfb;
  assert.equal(parseMidi(bytes).tracks[0].name, 'Flûte');
}

console.log('rollMidiParts: ok');
