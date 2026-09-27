// Pitch bend through Standard MIDI Files: the codec's wheel and RPN range, the
// soundfont render's writer, and the roll's export and import, with a generated
// roll that bends two of its three lanes (one of them looping).
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi } from './midi.ts';
import { meterMapToMidiEvents, normalizeMeterMap, unrollLanes, type MeterSegment, type PolyLane } from './meterMap.ts';
import { notesToSmf } from './midiWrite.ts';
import { MAX_BENT_LANES, bendValueAt, unrollBend, type BendPoint, type BendShape, type LaneBend } from './pitchBend.ts';
import { playedRollNotes } from './rollClip.ts';
import { ROLL_PPQ, midiFileNoteCount, midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { PPQ, migrateNotes, pianoNotesToMidiNotes, usePianoRollStore, withTicks, type PianoNote } from '../state/pianoRollStore.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const hasBytes = (hay: Uint8Array, needle: number[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((b, j) => hay[i + j] === b)) return true;
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
const P = (step: number, value: number, shape: BendShape = 'linear'): BendPoint => ({ id: `p${step}`, step, value, shape });
const near = (actual: number, expected: number, eps: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} is not within ${eps} of ${expected}`);

// The codec: ranges, wheel and notes at one tick go out in that order and come back as written.
{
  const bytes = encodeMidi({
    ppq: 480,
    bpm: 120,
    tracks: [{
      name: 'Bend',
      notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 480, channel: 2 }],
      bends: [{ tick: 0, channel: 2, value: 16383 }, { tick: 240, channel: 2, value: 0 }],
      bendRanges: [{ tick: 0, channel: 2, semitones: 7.25 }],
    }],
  });
  assert.ok(hasBytes(bytes, [
    0xb2, 101, 0, 0x00, 0xb2, 100, 0, 0x00, 0xb2, 6, 7, 0x00, 0xb2, 38, 25, 0x00, 0xb2, 101, 127, 0x00, 0xb2, 100, 127,
    0x00, 0xe2, 0x7f, 0x7f, 0x00, 0x92, 60, 100,
  ]));
  const [track] = parseMidi(bytes).tracks;
  assert.deepEqual(track.bends, [{ tick: 0, channel: 2, value: 16383 }, { tick: 240, channel: 2, value: 0 }]);
  assert.deepEqual(track.bendRanges, [{ tick: 0, channel: 2, semitones: 7.25 }]);
}

// The parser reads RPN 0/0 only: running status counts, a deselected RPN and an NRPN data entry do not set a range.
{
  const parsed = parseMidi(smf(96, [
    0x00, 0xb0, 101, 0, 0x00, 100, 0, 0x00, 6, 12, 0x00, 101, 127, 0x00, 100, 127, 0x00, 6, 3,
    0x00, 0xb0, 99, 1, 0x00, 98, 2, 0x00, 6, 7,
    0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0,
  ]));
  assert.deepEqual(parsed.tracks[0].bendRanges, [{ tick: 0, channel: 0, semitones: 12 }]);
  assert.equal('bends' in parsed.tracks[0], false);
  // A track that only bends is kept, so its channel's wheel reaches the notes another track holds.
  const split = parseMidi(smf(96, [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0], [0x30, 0xe0, 0x00, 0x60]));
  assert.equal(split.tracks.length, 2);
  assert.deepEqual(split.tracks[1].bends, [{ tick: 48, channel: 0, value: 12288 }]);
  // Running status carried across a meta event, as some writers do, keeps the events after it.
  const carried = parseMidi(smf(96, [
    0x00, 0x90, 60, 100, 0x00, 0xe0, 0x00, 0x60, 0x18, 0x00, 0x40,
    0x00, 0xff, 0x01, 0x03, 0x61, 0x62, 0x63,
    0x18, 0x7f, 0x7f, 0x30, 0x80, 60, 0,
  ]));
  assert.deepEqual(carried.tracks[0].bends, [{ tick: 0, channel: 0, value: 12288 }, { tick: 24, channel: 0, value: 8192 }, { tick: 48, channel: 0, value: 16383 }]);
  assert.deepEqual(carried.tracks[0].notes, [{ tick: 0, note: 60, velocity: 100, channel: 0, durationTicks: 96 }]);
  // Reset All Controllers leaves no parameter selected, so a data entry after it sets no range.
  const reset = parseMidi(smf(96, [0x00, 0xb0, 101, 0, 0x00, 100, 0, 0x00, 6, 7, 0x00, 121, 0, 0x00, 6, 9, 0x00, 0x90, 60, 100, 0x18, 0xe0, 0x00, 0x60, 0x30, 0x80, 60, 0]));
  assert.deepEqual(reset.tracks[0].bendRanges, [{ tick: 0, channel: 0, semitones: 7 }]);
}

// At one tick a note that ends there goes out before the wheel moves and a note that starts there after it; the same
// pitch back to back comes back as two notes.
{
  const bytes = encodeMidi({
    ppq: 96,
    bpm: 120,
    tracks: [{
      name: 'x',
      notes: [{ tick: 96, note: 62, velocity: 90, durationTicks: 96, channel: 0 }, { tick: 0, note: 60, velocity: 100, durationTicks: 96, channel: 0 }],
      bends: [{ tick: 96, channel: 0, value: 16383 }],
    }],
  });
  assert.ok(hasBytes(bytes, [0x80, 60, 0, 0x00, 0xe0, 0x7f, 0x7f, 0x00, 0x90, 62, 90]));
  const repeated = parseMidi(encodeMidi({
    ppq: 96,
    bpm: 120,
    tracks: [{ name: 'x', notes: [{ tick: 96, note: 60, velocity: 90, durationTicks: 96, channel: 0 }, { tick: 0, note: 60, velocity: 100, durationTicks: 96, channel: 0 }] }],
  }));
  assert.deepEqual(repeated.tracks[0].notes.map((n) => [n.tick, n.durationTicks, n.velocity]), [[0, 96, 100], [96, 96, 90]]);
}

// The soundfont render's writer: a note's channel, a wheel's range and messages on its channel, the program on every channel used.
{
  const bytes = notesToSmf(
    [{ midi: 60, startSec: 0, durationSec: 0.5, velocity: 100, channel: 1 }, { midi: 64, startSec: 0, durationSec: 0.5, velocity: 90 }],
    5,
    0,
    [],
    120,
    [{ channel: 1, range: 12, events: [{ sec: 0, raw: 8192 }, { sec: 0.25, raw: 16383 }] }],
  );
  const [track] = parseMidi(bytes).tracks;
  assert.deepEqual(track.bends, [{ tick: 0, channel: 1, value: 8192 }, { tick: 240, channel: 1, value: 16383 }]);
  assert.deepEqual(track.bendRanges, [{ tick: 0, channel: 1, semitones: 12 }]);
  assert.deepEqual(track.notes.map((n) => [n.note, n.channel]), [[60, 1], [64, 0]]);
  assert.ok(hasBytes(bytes, [0xc0, 5]) && hasBytes(bytes, [0xc1, 5]));
  // Wheel messages that land on one tick: the last one is the one written.
  const [dense] = parseMidi(notesToSmf([{ midi: 60, startSec: 0, durationSec: 0.5, velocity: 100, channel: 2 }], 0, 0, [], 120, [
    { channel: 2, range: 2, events: [{ sec: 0, raw: 8192 }, { sec: 0.0002, raw: 9000 }, { sec: 0.0004, raw: 10000 }, { sec: 0.25, raw: 16383 }] },
  ])).tracks;
  assert.deepEqual(dense.bends, [{ tick: 0, channel: 2, value: 10000 }, { tick: 240, channel: 2, value: 16383 }]);
}

// A generated roll: 4/4 then 7/8, lane A bends at a range of 2, lane B loops every 8 steps and bends at 12, lane C does not bend.
const MAP: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 1, meter: { num: 7, den: 8, groups: [3, 2, 2] } }];
const LANES: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 8 }, { id: 2, name: 'C', cycleSteps: null }];
const TOTAL = 30;
const NOTES: PianoNote[] = [
  { id: 'a0', note: 60, step: 0, length: 4, velocity: 100 },
  { id: 'a1', note: 62, step: 8, length: 2, velocity: 90 },
  { id: 'b0', note: 36, step: 1, length: 1, velocity: 110, lane: 1 },
  { id: 'b1', note: 38, step: 5, length: 2, velocity: 80, lane: 1 },
  { id: 'c0', note: 72, step: 3, length: 3, velocity: 70, lane: 2 },
  { id: 'c1', note: 74, step: 20, length: 4, velocity: 60, lane: 2 },
];
const BENDS: LaneBend[] = [
  { lane: 0, range: 2, points: [P(0, 0), P(4, 1, 'hold'), P(8, -0.5, 'smooth'), P(12, 0.25), P(16, 0, 'hold')] },
  { lane: 1, range: 12, points: [P(1, 0.5), P(5, -1, 'hold')] },
];
const ROLL = { notes: NOTES, lanes: LANES, totalSteps: TOTAL, bpm: 100, meterMap: MAP, pickupSteps: 0, bends: BENDS };
const canonical = (notes: readonly PianoNote[]) =>
  notes.map((n) => [n.step, n.note, n.length, n.velocity, n.lane ?? 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

// Export: one track per lane with its lane text, each bent lane on its own channel with its range and wheel, the
// unbent lane on the next channel.
const file = rollToMidiFile(ROLL);
const bytes = encodeMidi(file);
{
  assert.deepEqual(file.tracks.map((t) => t.name), ['Lane A', 'Lane B', 'Lane C']);
  assert.deepEqual(file.tracks.map((t) => JSON.parse(t.laneMeta ?? 'null')), LANES);
  const notes = file.tracks.flatMap((t) => t.notes);
  assert.deepEqual([0, 1, 2].map((ch) => notes.filter((n) => n.channel === ch).length), [2, 8, 2]);
  assert.deepEqual(file.tracks.map((t) => t.notes.length), [2, 8, 2], 'each lane in its own track, lane B written out');
  // The export's LOG line reports every lane's notes, not lane A's track alone.
  assert.equal(midiFileNoteCount(file), 12, 'the exported count is every track');
  assert.deepEqual(file.tracks.flatMap((t) => t.bendRanges ?? []), [{ tick: 0, channel: 0, semitones: 2 }, { tick: 0, channel: 1, semitones: 12 }]);
  assert.ok(hasBytes(bytes, [0xb0, 6, 2]) && hasBytes(bytes, [0xb1, 6, 12]));
  // Lane A at full up on channel 0, lane B at full down on channel 1.
  assert.ok(hasBytes(bytes, [0xe0, 0x7f, 0x7f]) && hasBytes(bytes, [0xe1, 0x00, 0x00]));
}

// Round trip: the same meter, lanes in the same order, every note in its lane, each lane's curve and range.
{
  const back = midiFileToRoll(parseMidi(bytes), 't');
  assert.equal(back.bpm, 100);
  assert.deepEqual(back.meter.meterMap, normalizeMeterMap(MAP));
  assert.equal(back.meter.pickupSteps, 0);
  // The lane texts bring every lane back, lane B still looping every 8 steps, and each lane's notes: the file holds
  // lane B's repeats written out, and the import keeps its first cycle, so the roll plays what it played.
  assert.deepEqual(back.meter.lanes, LANES);
  assert.deepEqual(canonical(back.notes), canonical(NOTES));
  assert.deepEqual(canonical(unrollLanes(back.notes, back.meter.lanes, TOTAL)), canonical(unrollLanes(NOTES, LANES, TOTAL)));
  assert.deepEqual(back.bends.map((b) => [b.lane, b.range]), [[0, 2], [1, 12]]);
  for (const original of BENDS) {
    const played = unrollBend(original.points, LANES[original.lane].cycleSteps, TOTAL);
    // Lane B's curve comes back as one cycle, which loops with the lane.
    const own = back.bends.find((b) => b.lane === original.lane)?.points ?? [];
    const curve = unrollBend(own, LANES[original.lane].cycleSteps, TOTAL);
    for (let s = 0; s <= TOTAL + 2; s += 1 / 16) {
      const want = bendValueAt(played, s);
      assert.ok(Math.abs(bendValueAt(curve, s) - want) <= 0.04, `lane ${original.lane} at step ${s}: ${bendValueAt(curve, s)} vs ${want}`);
    }
  }
  // Holds and ramps come back as points, not stairs.
  const a = back.bends[0].points;
  assert.deepEqual(a.slice(0, 3).map((p) => [p.step, p.value, p.shape]), [[0, 0, 'linear'], [4, 1, 'hold'], [8, -0.5, a[2].shape]]);
  // The corner where the ease meets the ramp down comes back within the import's 3 cents, so it may sit a little after step 12.
  const [corner, end] = a.slice(-2);
  assert.deepEqual([end.step, end.value, end.shape], [16, 0, 'hold']);
  assert.ok(corner.shape === 'linear' && Math.abs(corner.step - 12) <= 0.5, `corner at step ${corner.step}`);
  // A second trip keeps the notes, every hold, and the curve. The ease and its corner came back as ramps that
  // approximate them, and those may split at other steps the second time, within the same tolerance.
  const again = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile({ ...ROLL, notes: back.notes, lanes: back.meter.lanes, bends: back.bends }))), 't');
  assert.deepEqual(canonical(again.notes), canonical(back.notes));
  const holds = (points: readonly BendPoint[]) => points.filter((p) => p.shape === 'hold').map((p) => [p.step, p.value]);
  assert.deepEqual(again.bends.map((b) => holds(b.points)), back.bends.map((b) => holds(b.points)));
  for (const [i, b] of again.bends.entries()) {
    for (let s = 0; s <= TOTAL; s += 1 / 16) {
      assert.ok(Math.abs(bendValueAt(b.points, s) - bendValueAt(back.bends[i].points, s)) <= 0.04, `second trip, lane ${b.lane} at step ${s}`);
    }
  }
}

// A roll with lane A alone and no bend exports the file the roll wrote before it had bends or lanes; a file an older
// build wrote for a roll with lanes (one track, the lanes written out, no lane texts) imports into lane A alone.
{
  const laneA = NOTES.filter((n) => n.lane === undefined);
  const single = encodeMidi({
    ppq: 480,
    bpm: 100,
    tempos: [{ tick: 0, bpm: 100 }],
    timeSignatures: meterMapToMidiEvents(MAP, 480, 0),
    tracks: [{ name: 'Piano Roll', notes: pianoNotesToMidiNotes(laneA, 480) }],
  });
  assert.equal(hex(encodeMidi(rollToMidiFile({ ...ROLL, notes: laneA, lanes: [LANES[0]], bends: [] }))), hex(single));
  const legacy = encodeMidi({
    ppq: 480,
    bpm: 100,
    tempos: [{ tick: 0, bpm: 100 }],
    timeSignatures: meterMapToMidiEvents(MAP, 480, 0),
    tracks: [{ name: 'Piano Roll', notes: pianoNotesToMidiNotes(playedRollNotes(NOTES, LANES, TOTAL), 480) }],
  });
  const back = midiFileToRoll(parseMidi(legacy));
  assert.deepEqual(back.bends, []);
  assert.deepEqual(back.meter.lanes, [{ id: 0, name: 'A', cycleSteps: null }]);
  assert.equal(back.notes.some((n) => 'lane' in n), false);
  // A channel whose wheel only rests at the centre does not get a lane.
  const centred = midiFileToRoll(parseMidi(encodeMidi({
    ppq: 480,
    bpm: 120,
    tracks: [{
      name: 'x',
      notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 120, channel: 0 }, { tick: 0, note: 64, velocity: 100, durationTicks: 120, channel: 1 }],
      bends: [{ tick: 0, channel: 1, value: 8192 }],
    }],
  })));
  assert.deepEqual([centred.bends, centred.meter.lanes.length, centred.notes.some((n) => 'lane' in n)], [[], 1, false]);
}

// A file from another app: running status, a range with cents on channel 3, a bend there, and drums on channel 9 without one.
{
  const foreign = parseMidi(smf(96, [
    0x00, 0xb3, 101, 0, 0x00, 100, 0, 0x00, 6, 5, 0x00, 38, 50,
    0x00, 0x93, 60, 100,
    0x18, 0xe3, 0x00, 0x60,
    0x18, 0x83, 60, 0,
    0x00, 0x99, 36, 80,
    0x18, 0x89, 36, 0,
  ]));
  assert.deepEqual(foreign.tracks[0].bendRanges, [{ tick: 0, channel: 3, semitones: 5.5 }]);
  const roll = midiFileToRoll(foreign, 'f');
  // Channel 3 bends and has the lowest channel, so it is lane A; the drums share lane B.
  assert.deepEqual(roll.meter.lanes.map((l) => [l.id, l.name]), [[0, 'A'], [1, 'B']]);
  assert.deepEqual(roll.notes.map((n) => [n.note, n.step, n.length, n.lane]), [[60, 0, 2, undefined], [36, 2, 1, 1]]);
  assert.deepEqual(roll.bends, [{ lane: 0, range: 5.5, points: [{ id: 'bp0-0', step: 1, value: 0.5, shape: 'hold' }] }]);
}

// A range change partway through a file: the lane takes the widest range, and a bend sent at the narrower one keeps its pitch.
{
  const changed = midiFileToRoll(parseMidi(smf(96, [
    0x00, 0xb0, 101, 0, 0x00, 100, 0, 0x00, 6, 2,
    0x00, 0x90, 60, 100,
    0x18, 0xe0, 0x7f, 0x7f,
    0x48, 0xb0, 101, 0, 0x00, 100, 0, 0x00, 6, 12,
    0x18, 0xe0, 0x7f, 0x7f,
    0x30, 0x80, 60, 0,
  ])), 'c');
  assert.equal(changed.bends.length, 1);
  const [lane] = changed.bends;
  assert.equal(lane.range, 12);
  assert.deepEqual(lane.points.map((p) => [p.step, p.shape]), [[1, 'hold'], [5, 'hold']]);
  near(lane.points[0].value * lane.range, 2, 12 / 8192, 'the full bend at a range of 2 is two semitones');
  assert.equal(lane.points[1].value, 1);
}

// A wide range comes back within a few cents: the wheel moves about 3 cents a message, one message a tick, and the import
// strays about as far.
{
  for (const range of [12.5, 24, 48]) {
    const points = [P(0, -1, 'smooth'), P(40, 1), P(64, 0.2, 'hold')];
    const roll = {
      notes: [{ id: 'x', note: 60, step: 0, length: 64, velocity: 100 }],
      lanes: [LANES[0]],
      totalSteps: 64,
      bpm: 120,
      meterMap: [MAP[0]],
      pickupSteps: 0,
      bends: [{ lane: 0, range, points }],
    };
    const wide = rollToMidiFile(roll);
    const wheel = wide.tracks[0].bends ?? [];
    assert.ok(wheel.every((b, i) => i === 0 || b.tick > wheel[i - 1].tick), `range ${range}: one message a tick`);
    const back = midiFileToRoll(parseMidi(encodeMidi(wide)), 'w');
    assert.equal(back.bends[0].range, range);
    let worst = 0;
    for (let s = 0; s <= 64; s += 1 / 16) worst = Math.max(worst, Math.abs(bendValueAt(back.bends[0].points, s) - bendValueAt(points, s)) * range * 100);
    assert.ok(worst <= 4.2, `range ${range}: the import strays ${worst} cents`);
  }
}

// A file that bends more channels than lanes can bend: the lowest MAX_BENT_LANES get lanes, the rest play unbent in the
// shared lane, and the roll exports back with no two lanes on one channel.
{
  const body: number[] = [];
  for (let ch = 0; ch < 16; ch += 1) body.push(0x00, 0xe0 | ch, 0x00, 0x60, 0x00, 0x90 | ch, 40 + ch, 100);
  for (let ch = 0; ch < 16; ch += 1) body.push(ch === 0 ? 0x18 : 0x00, 0x80 | ch, 40 + ch, 0);
  const many = midiFileToRoll(parseMidi(smf(96, body)), 'm');
  assert.equal(many.bends.length, MAX_BENT_LANES);
  assert.equal(many.meter.lanes.length, MAX_BENT_LANES + 1);
  assert.deepEqual(many.notes.filter((n) => n.lane === MAX_BENT_LANES).map((n) => n.note).sort(), [53, 54, 55]);
  const again = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile({
    notes: many.notes,
    lanes: many.meter.lanes,
    totalSteps: 16,
    bpm: many.bpm,
    meterMap: many.meter.meterMap,
    pickupSteps: 0,
    bends: many.bends,
  }))), 'm2');
  assert.equal(again.meter.lanes.length, MAX_BENT_LANES + 1);
  assert.deepEqual(canonical(again.notes), canonical(many.notes));
}

// ── Ticks through the file ───────────────────────────────────────────────────

// A round trip at the model's own PPQ is EXACT, off-grid notes included: the
// export writes each note's ticks and the import reads them back, so nothing is
// quantised to the 16th grid in either direction.
{
  const notes: PianoNote[] = migrateNotes([
    { id: 'on-grid', note: 60, step: 0, length: 4, velocity: 100 },
    // 605 ticks is 2.52 steps — between two 16ths, where a swung or humanised
    // note lives. The old export rounded it to a step; this one does not.
    { id: 'off-grid', note: 64, velocity: 90, tick: 605, ticks: 61 } as PianoNote,
    { id: 'tiny', note: 67, velocity: 80, tick: 4801, ticks: 1 } as PianoNote,
  ]);
  const roll = { notes, lanes: [LANES[0]], totalSteps: 64, bpm: 120, meterMap: [MAP[0]], pickupSteps: 0, bends: [] };
  const exported = rollToMidiFile(roll, PPQ);
  assert.equal(exported.ppq, PPQ);
  assert.deepEqual(
    exported.tracks[0].notes.map((n) => [n.tick, n.durationTicks]),
    [[0, 960], [605, 61], [4801, 1]],
    'the file carries the notes\' own ticks, unrounded',
  );
  const back = midiFileToRoll(parseMidi(encodeMidi(exported)), 'x');
  assert.deepEqual(back.notes.map((n) => [n.tick, n.ticks]), notes.map((n) => [n.tick, n.ticks]), 'ticks survive a 960 PPQ trip exactly');
  // And the step view the roll draws is derived from those ticks, not re-snapped.
  assert.deepEqual(back.notes.map((n) => [n.step, n.length]), notes.map((n) => [n.step, n.length]));
  // The store keeps them as they came back.
  usePianoRollStore.getState().importNotes(back.notes);
  assert.deepEqual(usePianoRollStore.getState().notes.map((n) => n.tick), [0, 605, 4801]);
}

// A file at another PPQ scales into the model rather than snapping: 480 doubles,
// 96 is x10, and the step view follows.
{
  const at = (ppq: number, tick: number, durationTicks: number) =>
    midiFileToRoll(parseMidi(encodeMidi({
      ppq,
      bpm: 120,
      tracks: [{ name: 'x', notes: [{ tick, note: 60, velocity: 100, durationTicks, channel: 0 }] }],
    })), 's').notes[0];

  const half = at(480, 605, 61);
  assert.deepEqual([half.tick, half.ticks], [1210, 122], '480 PPQ doubles into 960');
  assert.equal(half.step, 1210 / 240);
  const coarse = at(96, 25, 7);
  assert.deepEqual([coarse.tick, coarse.ticks], [250, 70], '96 PPQ scales x10');
  assert.equal(coarse.step, 250 / 240, 'and lands between 16ths rather than on one');
  // A zero-length note is still a note: the codec gives it the file's shortest
  // tick, which scales to ten of the model's at 96 PPQ.
  assert.equal(at(96, 0, 0).ticks, 10);
  // A 480 PPQ export of a 480-grid roll is unchanged from what it always was.
  const whole = at(480, 960, 480);
  assert.deepEqual([whole.tick, whole.ticks, whole.step, whole.length], [1920, 960, 8, 4]);
}

// A looping lane's repeats are re-ticked from where the unroll put them, which
// is exact because a lane cycle is a whole number of steps — an off-grid note in
// a looping lane keeps its offset in every pass.
{
  const swung: PianoNote = withTicks({ id: 'sw', note: 48, velocity: 100, tick: 605, ticks: 60, lane: 1 } as PianoNote);
  const roll = {
    notes: [swung],
    lanes: [LANES[0], { id: 1, name: 'B', cycleSteps: 8 }],
    totalSteps: 32,
    bpm: 120,
    meterMap: [MAP[0]],
    pickupSteps: 0,
    bends: [],
  };
  const out = rollToMidiFile(roll, PPQ).tracks.find((t) => t.name === 'Lane B')?.notes ?? [];
  // 8 steps = 1920 ticks a pass, and the 5-tick offset off the grid rides along.
  assert.deepEqual(out.map((n) => n.tick), [605, 2525, 4445, 6365]);
  assert.deepEqual([...new Set(out.map((n) => n.durationTicks))], [60]);
  // The SHIPPED export (PianoRoll's .mid button) takes the default ppq, 480,
  // where an odd model tick has no exact home: it rounds by at most half a file
  // tick, which is one model tick. Nothing quantises to the grid.
  const atDefault = (rollToMidiFile(roll).tracks.find((t) => t.name === 'Lane B')?.notes[0].tick ?? Number.NaN) * (PPQ / ROLL_PPQ);
  assert.ok(Math.abs(atDefault - 605) <= 1, `default ppq put tick 605 at ${atDefault}`);
}

// A roll at a fractional tempo (a take imported at a detected 97.3) goes out
// as a .mid and comes back through the roll's IMPORT at 97.3, every note at
// the second it played at. parseMidi used to round the file's tempo to 97 and
// importNotes rounded again, so the file came back 0.3 % slow; a whole BPM
// still reads back whole, so a file an older build wrote opens as it did.
{
  const played: PianoNote[] = migrateNotes([
    { id: 'a', note: 60, step: 0, length: 1, velocity: 100, tick: 0, ticks: 170 },
    { id: 'b', note: 62, step: 0, length: 1, velocity: 90, tick: 38, ticks: 119 },
    { id: 'c', note: 64, step: 0, length: 1, velocity: 80, tick: 96_037, ticks: 480 },
  ]);
  const roll = usePianoRollStore.getState();
  roll.importNotes(played, 97.3);
  const s = usePianoRollStore.getState();
  assert.equal(s.bpm, 97.3, 'the roll keeps the tempo it was handed');
  const bytes = encodeMidi(rollToMidiFile({ ...s, totalSteps: s.totalSteps }));
  const parsed = parseMidi(bytes);
  assert.equal(parsed.bpm, 97.3, 'the file reads back at 97.3');
  const back = midiFileToRoll(parsed, 'rt');
  usePianoRollStore.getState().importNotes(back.notes, back.bpm, back.meter, back.bends);
  const again = usePianoRollStore.getState();
  assert.equal(again.bpm, 97.3, 'IMPORT puts the roll back at 97.3');
  const secs = (tick: number, bpm: number) => (tick / PPQ) * (60 / bpm);
  const sorted = [...again.notes].sort((x, y) => (x.tick ?? 0) - (y.tick ?? 0));
  sorted.forEach((n, i) => {
    assert.equal(n.tick, played[i].tick, `note ${i} keeps its tick`);
    assert.equal(n.ticks, played[i].ticks, `note ${i} keeps its length`);
    near(secs(n.tick ?? 0, again.bpm), secs(played[i].tick ?? 0, 97.3), 1e-9, `note ${i} plays at its second`);
  });
  // Whole BPMs, the only tempos an older build's roll wrote, read back whole.
  for (const bpm of [60, 97, 120, 133, 240]) {
    assert.equal(parseMidi(encodeMidi({ ppq: 480, bpm, tracks: [] })).bpm, bpm, `${bpm} BPM reads back as ${bpm}`);
  }
}

// Export count: one note in lane A and two in lane B is three notes exported, though lane A's track holds one.
{
  const two = rollToMidiFile({
    notes: [
      { id: 'x0', note: 60, step: 0, length: 2, velocity: 100 },
      { id: 'x1', note: 40, step: 2, length: 2, velocity: 100, lane: 1 },
      { id: 'x2', note: 41, step: 4, length: 2, velocity: 100, lane: 1 },
    ],
    lanes: [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null }],
    totalSteps: 16,
    bpm: 120,
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
    pickupSteps: 0,
    bends: [],
  });
  assert.equal(two.tracks[0].notes.length, 1);
  assert.equal(midiFileNoteCount(two), 3, 'a two-lane export reports 3 notes');
}

console.log('rollMidi: ok');
