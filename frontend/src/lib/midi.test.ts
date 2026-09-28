import assert from 'node:assert/strict';
import { encodeMidi, midiStartTempo, parseMidi, type MidiFileData } from './midi.ts';
import { meterMapToMidiEvents, midiEventsToMeterMap, normalizeMeterMap, type MeterSegment } from './meterMap.ts';
import { notesToRollSmf, notesToSmf } from './midiWrite.ts';
import { midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { DEFAULT_LANES, usePianoRollStore, withTicks, type PianoNote } from '../state/pianoRollStore.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** True when `needle` appears in `hay` as one run of bytes. */
const hasBytes = (hay: Uint8Array, needle: number[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (needle.every((b, j) => hay[i + j] === b)) return true;
  }
  return false;
};

/** A format-1 file built by hand from track bodies (each gets its end-of-track). */
const smf = (ppq: number, ...bodies: number[][]): Uint8Array => {
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, bodies.length, (ppq >>> 8) & 0xff, ppq & 0xff];
  for (const b of bodies) {
    const body = [...b, 0x00, 0xff, 0x2f, 0x00];
    const n = body.length;
    out.push(0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body);
  }
  return new Uint8Array(out);
};

const NOTES = [
  { tick: 0, note: 60, velocity: 100, durationTicks: 240, channel: 0 },
  { tick: 240, note: 64, velocity: 90, durationTicks: 480, channel: 0 },
  { tick: 960, note: 67, velocity: 127, durationTicks: 120, channel: 0 },
  { tick: 200000, note: 72, velocity: 50, durationTicks: 480, channel: 0 },
];
const KIT = [
  { tick: 0, note: 36, velocity: 110, durationTicks: 60, channel: 9 },
  { tick: 480, note: 38, velocity: 80, durationTicks: 60, channel: 9 },
];

// With no tempo or signature list, the bytes are the ones the writer produced
// before it could write either (captured from the unmodified encoder).
{
  const BEFORE =
    '4d546864000000060001000301e04d54726b0000001c00ff030554656d706f00ff510309703d00ff58040402180800ff2f00' +
    '4d54726b0000003200ff03044c65616400903c648170803c000090405a8360804000817090437f788043008c9208904832836080480000ff2f00' +
    '4d54726b0000001c00ff03034b69740099246e3c89240083249926503c89260000ff2f00';
  const file: MidiFileData = { ppq: 480, bpm: 97, tracks: [{ name: 'Lead', notes: NOTES }, { name: 'Kit', notes: KIT }] };
  assert.equal(hex(encodeMidi(file)), BEFORE);
  assert.equal(hex(encodeMidi({ ...file, timeSignatures: [], tempos: [] })), BEFORE);
}

// Meter changes with groups and several tempos round-trip at their ticks.
{
  const file: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [{ name: 'Lead', notes: NOTES }],
    // Out of order on purpose: the writer sorts.
    timeSignatures: [
      { tick: 3600, num: 5, den: 16 },
      { tick: 0, num: 4, den: 4 },
      { tick: 4200, num: 11, den: 8, groups: [3, 3, 3, 2] },
      { tick: 1920, num: 7, den: 8, groups: [3, 2, 2] },
    ],
    tempos: [{ tick: 3600, bpm: 140.5 }, { tick: 0, bpm: 120 }, { tick: 1920, bpm: 97 }],
  };
  const bytes = encodeMidi(file);
  // FF 58 04 num log2(den) 96/den 08
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 7, 3, 12, 8]));
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 5, 4, 6, 8]));
  assert.ok(hasBytes(bytes, [0xff, 0x01, 19, ...Array.from('theDAW:groups=3+2+2', (c) => c.charCodeAt(0))]));
  const parsed = parseMidi(bytes);
  assert.deepEqual(parsed.timeSignatures, [
    { tick: 0, num: 4, den: 4 },
    { tick: 1920, num: 7, den: 8, groups: [3, 2, 2] },
    { tick: 3600, num: 5, den: 16 },
    { tick: 4200, num: 11, den: 8, groups: [3, 3, 3, 2] },
  ]);
  assert.deepEqual(parsed.tempos, [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 97 }, { tick: 3600, bpm: 140.5 }]);
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.tracks[0].notes, NOTES);
}

// The tick-0 tempo wins: over a later tempo in the same track (the old parser
// kept the last one seen), over `bpm` in the writer, and across tracks.
{
  const parsed = parseMidi(encodeMidi({ ppq: 480, bpm: 60, tracks: [], tempos: [{ tick: 960, bpm: 90 }, { tick: 0, bpm: 132 }] }));
  assert.equal(parsed.bpm, 132);
  assert.deepEqual(parsed.tempos, [{ tick: 0, bpm: 132 }, { tick: 960, bpm: 90 }]);

  // Track 0: 90 BPM at tick 960. Track 1: 132 BPM at tick 0.
  const split = parseMidi(smf(480, [0x87, 0x40, 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2b], [0x00, 0xff, 0x51, 0x03, 0x06, 0xef, 0x91]));
  assert.equal(split.bpm, 132);
  assert.deepEqual(split.tempos, [{ tick: 0, bpm: 132 }, { tick: 960, bpm: 90 }]);
}

// No FF 58: no timeSignatures. No tempo at tick 0: the first tempo is the bpm.
{
  const parsed = parseMidi(
    smf(
      480,
      [0x83, 0x60, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0], // 100 BPM at tick 480
      [0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0],
    ),
  );
  assert.equal('timeSignatures' in parsed, false);
  assert.equal(parsed.bpm, 100);
  assert.deepEqual(parsed.tempos, [{ tick: 480, bpm: 100 }]);
  assert.equal(parsed.tracks[0].notes.length, 1);

  const bare = parseMidi(smf(96, [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0]));
  assert.equal(bare.bpm, 120);
  assert.equal('tempos' in bare, false);
  assert.equal('timeSignatures' in bare, false);
}

// A meter map with a pickup survives encode and parse.
{
  const MAP: MeterSegment[] = [
    { bar: 0, meter: { num: 4, den: 4, groups: [] } },
    { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } },
    { bar: 3, meter: { num: 5, den: 16, groups: [] } },
    { bar: 5, meter: { num: 8, den: 8, groups: [3, 3, 2] } },
  ];
  for (const pickupSteps of [4, 6]) {
    const events = meterMapToMidiEvents(MAP, 480, pickupSteps);
    const parsed = parseMidi(encodeMidi({ ppq: 480, bpm: 110, tracks: [{ name: 'Lead', notes: NOTES }], timeSignatures: events }));
    const back = midiEventsToMeterMap(parsed.timeSignatures ?? [], parsed.ppq);
    assert.deepEqual(back, { map: normalizeMeterMap(MAP), pickupSteps });
  }
}

// The pickup text survives encode and parse, so a short first bar or a long pickup comes back as written.
{
  const M24 = { num: 2, den: 4, groups: [] };
  const M44 = { num: 4, den: 4, groups: [] };
  const M78 = { num: 7, den: 8, groups: [] };
  const roundTrip = (map: MeterSegment[], pickupSteps: number) => {
    const bytes = encodeMidi({ ppq: 480, bpm: 100, tracks: [{ name: 'Lead', notes: NOTES }], timeSignatures: meterMapToMidiEvents(map, 480, pickupSteps) });
    const parsed = parseMidi(bytes);
    return { bytes, parsed, back: midiEventsToMeterMap(parsed.timeSignatures ?? [], parsed.ppq) };
  };

  const short = roundTrip([{ bar: 0, meter: M24 }, { bar: 1, meter: M44 }], 0);
  assert.ok(hasBytes(short.bytes, [0xff, 0x01, 15, ...Array.from('theDAW:pickup=0', (c) => c.charCodeAt(0))]));
  assert.deepEqual(short.parsed.timeSignatures, [{ tick: 0, num: 2, den: 4, pickupSteps: 0 }, { tick: 960, num: 4, den: 4 }]);
  assert.deepEqual(short.back, { map: [{ bar: 0, meter: M24 }, { bar: 1, meter: M44 }], pickupSteps: 0 });

  const long = roundTrip([{ bar: 0, meter: M78 }], 20);
  assert.ok(hasBytes(long.bytes, [0xff, 0x01, 16, ...Array.from('theDAW:pickup=20', (c) => c.charCodeAt(0))]));
  assert.deepEqual(long.back, { map: [{ bar: 0, meter: M78 }], pickupSteps: 20 });

  // The same signatures from another app (no text events) keep the guess.
  const foreign = parseMidi(smf(480, [0x00, 0xff, 0x58, 0x04, 5, 2, 24, 8, 0x92, 0x60, 0xff, 0x58, 0x04, 7, 3, 12, 8]));
  assert.deepEqual(midiEventsToMeterMap(foreign.timeSignatures ?? [], foreign.ppq), { map: [{ bar: 0, meter: { num: 5, den: 4, groups: [] } }, { bar: 1, meter: M78 }], pickupSteps: 0 });
}

// The writer without a tempo or signatures writes the bytes it wrote before it
// took either (captured from the unmodified writer): the soundfont renderer's
// notesToSmf(notes, program) and the drum beat's notesToSmf(notes, 0, 9).
{
  const render = [
    { midi: 60, startSec: 0, durationSec: 0.25, velocity: 100 },
    { midi: 64.4, startSec: 0.4, durationSec: 0.2, velocity: 90 },
    { midi: 67, startSec: 1.2345, durationSec: 0.001, velocity: 200 },
    { midi: 72, startSec: 3.7, durationSec: 1.5, velocity: 0 },
  ];
  const tail = '903c648170803c00811090405a8140804000846190437f01804300923e9048018b2080480000ff2f00';
  const PLAIN = `4d546864000000060000000101e04d54726b0000003400ff510307a12000c00000${tail}`;
  const PROGRAM_41 = `4d546864000000060000000101e04d54726b0000003400ff510307a12000c02900${tail}`;
  const KIT_CHANNEL =
    '4d546864000000060000000101e04d54726b0000003400ff510307a12000c90000' +
    '993c648170893c00811099405a8140894000846199437f01894300923e9948018b2089480000ff2f00';
  assert.equal(hex(notesToSmf(render)), PLAIN);
  assert.equal(hex(notesToSmf(render, 41)), PROGRAM_41);
  assert.equal(hex(notesToSmf(render, 0, 9)), KIT_CHANNEL);
  assert.equal(hex(notesToSmf(render, 0, 0, [])), PLAIN);
  assert.equal(hex(notesToSmf(render, 0, 0, [], 120)), PLAIN);
}

// The VOCAL export at the roll's tempo: 7/8 3+2+2 after a 4-step pickup, then
// 5/4 from bar 2, at 90 BPM. A roll step is 120 ticks there, so the signatures
// sit on the bar lines the notes are placed against, the file reads back with
// the roll's tempo, map and pickup (the 5/4 on bar 2, not a bar late), and each
// note keeps its time in seconds.
{
  const bpm = 90;
  const stepSec = 60 / bpm / 4;
  const map: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }, { bar: 2, meter: { num: 5, den: 4, groups: [] } }];
  const pickupSteps = 4;
  // Downbeats of the pickup, bars 0 and 1 (14 steps of 7/8 each) and the 5/4 bar, then one note off the grid.
  const downbeats = [0, 4, 18, 32];
  const render = [
    ...downbeats.map((s, i) => ({ midi: 60 + i, startSec: s * stepSec, durationSec: 2 * stepSec, velocity: 90 })),
    { midi: 72, startSec: 0.4, durationSec: 0.2, velocity: 80 },
  ];
  const parsed = parseMidi(notesToRollSmf(render, { meterMap: map, pickupSteps, bpm }));

  assert.equal(parsed.bpm, bpm);
  assert.deepEqual(parsed.tempos, [{ tick: 0, bpm }]);
  assert.deepEqual(parsed.timeSignatures, [
    { tick: 0, num: 1, den: 4, pickupSteps },
    { tick: 4 * 120, num: 7, den: 8, groups: [3, 2, 2] },
    { tick: 32 * 120, num: 5, den: 4 },
  ]);
  assert.deepEqual(midiEventsToMeterMap(parsed.timeSignatures ?? [], parsed.ppq), { map: normalizeMeterMap(map), pickupSteps });

  const secPerTick = 60 / bpm / parsed.ppq;
  const notes = parsed.tracks[0].notes;
  // A note on a roll step lands on that step's tick, the one its bar line is written at.
  downbeats.forEach((s, i) => {
    const n = notes.find((m) => m.note === 60 + i);
    assert.equal(n?.tick, s * (parsed.ppq / 4));
    assert.equal(n?.durationTicks, 2 * (parsed.ppq / 4));
  });
  for (const r of render) {
    const n = notes.find((m) => m.note === r.midi);
    assert.ok(n);
    assert.ok(Math.abs(n.tick * secPerTick - r.startSec) <= secPerTick / 2);
    assert.ok(Math.abs((n.tick + n.durationTicks) * secPerTick - (r.startSec + r.durationSec)) <= secPerTick / 2);
  }
}

/** The roll's EXPORT then IMPORT, as PianoRoll's keys run them: the roll's
 *  state through rollToMidiFile and encodeMidi (what downloadMidi writes), the
 *  bytes back through parseMidi and midiFileToRoll into importNotes. */
const exportThenImport = (notes: PianoNote[]): { bytes: Uint8Array; back: PianoNote[] } => {
  usePianoRollStore.getState().importNotes(notes, 120, { meterMap: normalizeMeterMap(null), pickupSteps: 0, lanes: [...DEFAULT_LANES] }, []);
  const bytes = encodeMidi(rollToMidiFile(usePianoRollStore.getState()));
  const { notes: imported, bpm, meter, bends } = midiFileToRoll(parseMidi(bytes), 'imp');
  usePianoRollStore.getState().importNotes(imported, bpm, meter, bends);
  return { bytes, back: usePianoRollStore.getState().notes };
};
const timing = (notes: readonly PianoNote[]) => notes.map((n) => [n.note, n.step, n.length, n.velocity]);

// Two notes of one pitch that overlap on one channel (a unison between two
// voices, a repeated note played legato) both survive EXPORT then IMPORT. The
// parser pairs each note-off with the OLDEST held note of its channel and
// pitch. Keyed to one open note, the second note-on replaced the first, which
// was lost, and the first note-off ended the second one early.
{
  const roll = [
    withTicks({ id: 'a', note: 60, step: 0, length: 4, velocity: 100 }),
    withTicks({ id: 'b', note: 60, step: 2, length: 4, velocity: 70 }),
    withTicks({ id: 'c', note: 64, step: 8, length: 2, velocity: 90 }),
  ];
  const { back } = exportThenImport(roll);
  assert.deepEqual(timing(back), timing(roll), 'both unison notes come back at their own steps and lengths');
}

// A repeated note from a writer that puts the new note-on before the old
// note-off at one tick (on 0, on 480, off 480, off 960) is two whole notes.
{
  const parsed = parseMidi(smf(480, [0x00, 0x90, 60, 100, 0x83, 0x60, 0x90, 60, 80, 0x00, 0x80, 60, 0, 0x83, 0x60, 0x80, 60, 0]));
  assert.deepEqual(parsed.tracks[0].notes, [
    { tick: 0, note: 60, velocity: 100, channel: 0, durationTicks: 480 },
    { tick: 480, note: 60, velocity: 80, channel: 0, durationTicks: 480 },
  ]);
}

// A note still held when its track ends lasts to the track's last tick, the
// tick of its end-of-track event. It used to get a quarter note (ppq ticks)
// wherever the track ended.
{
  // On 60 at 0; at 960 on 64 and two 67s; at 1440 one off for 67 (the older
  // one); a text event at 1920 and the end of the track right after it.
  const parsed = parseMidi(
    smf(
      480,
      [0x00, 0x90, 60, 100, 0x87, 0x40, 0x90, 64, 90, 0x00, 0x90, 67, 80, 0x00, 0x90, 67, 81, 0x83, 0x60, 0x80, 67, 0, 0x83, 0x60, 0xff, 0x01, 0x00],
    ),
  );
  assert.deepEqual(parsed.tracks[0].notes, [
    { tick: 0, note: 60, velocity: 100, channel: 0, durationTicks: 1920 },
    { tick: 960, note: 67, velocity: 80, channel: 0, durationTicks: 480 },
    { tick: 960, note: 64, velocity: 90, channel: 0, durationTicks: 960 },
    { tick: 960, note: 67, velocity: 81, channel: 0, durationTicks: 960 },
  ]);
  // A note that starts on the last tick still has its one tick.
  const last = parseMidi(smf(480, [0x00, 0x90, 60, 100]));
  assert.equal(last.tracks[0].notes[0].durationTicks, 1);
}

// A roll of 20,000 notes exports and imports. encodeMidi appended each track
// chunk with out.push(...chunk), which passes every byte as an argument, and V8
// throws a RangeError past about 125,000 of them, so a one-track roll of about
// 13,000 notes or more failed to export. The bytes now grow in one buffer.
{
  const roll: PianoNote[] = [];
  for (let i = 0; i < 20_000; i += 1) {
    roll.push(withTicks({ id: `n${i}`, note: 36 + (i % 48), step: i, length: 1 + (i % 3), velocity: 1 + (i % 127) }));
  }
  const { bytes, back } = exportThenImport(roll);
  assert.ok(bytes.length > 160_000, `one track chunk of ${bytes.length} bytes, past the old limit`);
  assert.deepEqual(timing(back), timing(roll), 'every note comes back');
}

// With tempos, signatures, groups, a pickup, bends and ranges, the writer's
// bytes are the ones it wrote before it grew a buffer (captured from the
// unmodified encoder at 8039b45).
{
  const file: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [
      {
        name: 'Lead',
        notes: NOTES,
        bends: [{ tick: 0, channel: 0, value: 12000 }, { tick: 480, channel: 0, value: 8192 }],
        bendRanges: [{ tick: 0, channel: 0, semitones: 12 }],
      },
      { name: 'Kit', notes: KIT },
    ],
    timeSignatures: [{ tick: 0, num: 7, den: 8, groups: [3, 2, 2], pickupSteps: 2 }, { tick: 1680, num: 4, den: 4 }],
    tempos: [{ tick: 0, bpm: 120 }, { tick: 960, bpm: 96.5 }],
  };
  const BEFORE_RICH =
    '4d546864000000060001000301e04d54726b0000005700ff030554656d706f00ff510307a12000ff580407030c0800ff0113746865444157' +
    '3a67726f7570733d332b322b3200ff010f7468654441573a7069636b75703d328740ff5103097cc28550ff58040402180800ff2f00' +
    '4d54726b0000005300ff03044c65616400b0650000b0640000b0060c00b0260000b0657f00b0647f00e0605d00903c648170803c000090405a' +
    '8170e000408170804000817090437f788043008c9208904832836080480000ff2f00' +
    '4d54726b0000001c00ff03034b69740099246e3c89240083249926503c89260000ff2f00';
  assert.equal(hex(encodeMidi(file)), BEFORE_RICH);
}

// Controllers: modulation, volume, pan, expression and the pedal are kept per
// track and written back; the bank select LSB rides on the program change it
// precedes; other controllers are read past as before.
{
  const file: MidiFileData = {
    ppq: 960,
    bpm: 90,
    tracks: [
      {
        name: 'Piano',
        notes: [{ tick: 0, note: 48, velocity: 80, durationTicks: 1920, channel: 2 }],
        programs: [{ tick: 0, channel: 2, program: 0, bank: 121, bankLsb: 1 }],
        controls: [
          { tick: 0, channel: 2, controller: 7, value: 100 },
          { tick: 0, channel: 2, controller: 10, value: 30 },
          { tick: 480, channel: 2, controller: 64, value: 127 },
          { tick: 1920, channel: 2, controller: 64, value: 0 },
          { tick: 1920, channel: 2, controller: 11, value: 90 },
          { tick: 2400, channel: 2, controller: 1, value: 64 },
        ],
      },
    ],
  };
  const bytes = encodeMidi(file);
  const back = parseMidi(bytes);
  assert.deepEqual(back.tracks[0].controls, file.tracks[0].controls, 'every kept controller comes back at its tick');
  assert.deepEqual(back.tracks[0].programs, [{ tick: 0, channel: 2, program: 0, bank: 121, bankLsb: 1 }], 'with the bank MSB and LSB');
  // At tick 0: CC 0, CC 32 and the program change, then volume and pan, then the note-on.
  assert.ok(
    hasBytes(bytes, [0xb2, 0, 121, 0x00, 0xb2, 32, 1, 0x00, 0xc2, 0, 0x00, 0xb2, 7, 100, 0x00, 0xb2, 10, 30, 0x00, 0x92, 48, 80]),
    'bank, program, controllers, then the note',
  );

  // A file from elsewhere: reverb (91) and chorus (93) are read past; Reset All
  // Controllers is kept as the three changes RP-015 makes (volume and pan stay).
  const foreign = parseMidi(
    smf(480, [0x00, 0xb0, 91, 40, 0x00, 0xb0, 93, 20, 0x00, 0xb0, 7, 110, 0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0x00, 0xb0, 121, 0]),
  );
  assert.deepEqual(foreign.tracks[0].controls, [
    { tick: 0, channel: 0, controller: 7, value: 110 },
    { tick: 480, channel: 0, controller: 1, value: 0 },
    { tick: 480, channel: 0, controller: 11, value: 127 },
    { tick: 480, channel: 0, controller: 64, value: 0 },
  ]);

  // A setup track that only sets volume and pan for channels other tracks play is kept.
  const setup = parseMidi(
    smf(480, [0x00, 0xb1, 7, 90, 0x00, 0xb1, 10, 100], [0x00, 0xff, 0x03, 0x04, 0x48, 0x6f, 0x72, 0x6e, 0x00, 0x91, 60, 90, 0x83, 0x60, 0x81, 60, 0]),
  );
  assert.equal(setup.tracks.length, 2);
  assert.deepEqual(setup.tracks[0].controls, [
    { tick: 0, channel: 1, controller: 7, value: 90 },
    { tick: 0, channel: 1, controller: 10, value: 100 },
  ]);
  assert.equal(setup.tracks[0].notes.length, 0);
}

// The tempo a file plays at from tick 0: its tick-0 tempo; 120 (SMF's default)
// until a first tempo that comes later than a 64th note; the first tempo when a
// writer put it a few ticks in.
{
  assert.equal(midiStartTempo({ ppq: 480, bpm: 60, tempos: [{ tick: 0, bpm: 72 }, { tick: 960, bpm: 60 }] }), 72);
  assert.equal(midiStartTempo({ ppq: 480, bpm: 60, tempos: [{ tick: 120720, bpm: 60 }] }), 120, 'a mark 251 beats in does not play from the start');
  assert.equal(midiStartTempo({ ppq: 480, bpm: 96, tempos: [{ tick: 12, bpm: 96 }] }), 96, 'a tempo 12 ticks in is the start tempo');
  assert.equal(midiStartTempo({ ppq: 480, bpm: 100, tempos: [] }), 100);
  assert.equal(midiStartTempo({ ppq: 480, bpm: NaN }), 120);
}

console.log('midi tests passed');
