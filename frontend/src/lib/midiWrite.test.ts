// midiWrite as the note model sees it: the seconds-based SMF writer sits on a
// 480 PPQ grid, which is exactly half the model's 960, so a note held in ticks
// crosses into it and comes back through rollMidi without a second quantise.
//
// (The writer's own byte-level goldens — program change, channels, wheels, the
// meter metas — live in midi.test.ts and bendRangeSpessa.test.ts and are not
// repeated here.)
import assert from 'node:assert/strict';
import { parseMidi } from './midi.ts';
import { SMF_PPQ, notesToRollSmf, notesToSmf, rollMeterToSmfEvents } from './midiWrite.ts';
import { midiFileToRoll } from './rollMidi.ts';
import { PPQ, migrateNotes, noteTick, noteTicks, type PianoNote } from '../state/pianoRollStore.ts';

const BPM = 120;
/** Seconds one model tick lasts at `BPM` — a quarter is 0.5 s at 120. */
const SEC_PER_TICK = 60 / BPM / PPQ;

// The two grids are a clean 2:1, so model ticks convert with no remainder.
{
  assert.equal(SMF_PPQ, 480);
  assert.equal(PPQ / SMF_PPQ, 2);
}

// A roll note carried into the writer by SECONDS and read back by rollMidi keeps
// its ticks, on the grid and off it — the writer's 480 halves them and the
// import doubles them back.
{
  const notes: PianoNote[] = migrateNotes([
    { id: 'a', note: 60, step: 0, length: 4, velocity: 100 },
    { id: 'b', note: 64, step: 6, length: 2, velocity: 90 },
    // Off-grid, but on an even model tick, so the 480 grid still holds it exactly.
    { id: 'c', note: 67, velocity: 80, tick: 606, ticks: 60 } as PianoNote,
  ]);
  const render = notes.map((n) => ({
    midi: n.note,
    startSec: noteTick(n) * SEC_PER_TICK,
    durationSec: noteTicks(n) * SEC_PER_TICK,
    velocity: n.velocity,
  }));
  const back = midiFileToRoll(parseMidi(notesToSmf(render, 0, 0, [], BPM)), 'w');
  // The import hands the notes back in step order, so both sides are sorted.
  const byTick = (a: number[], b: number[]) => a[0] - b[0];
  assert.deepEqual(
    back.notes.map((n) => [n.tick, n.ticks]).sort(byTick),
    notes.map((n) => [n.tick as number, n.ticks as number]).sort(byTick),
    'seconds in, the same model ticks out',
  );
  assert.deepEqual(
    back.notes.map((n) => [n.step, n.length]).sort(byTick),
    notes.map((n) => [n.step, n.length]).sort(byTick),
  );
  assert.equal(back.bpm, BPM);
}

// An ODD model tick is the one thing the 480 grid cannot hold: it lands halfway
// between two of the writer's ticks and rounds. Half a model tick at 120 BPM is
// a quarter of a millisecond, but the loss is real. Going through seconds adds
// nothing to it: the roll's own .mid export (rollMidi.rollToMidiFile) writes
// ticks directly, but at the FILE's PPQ — 480 by default, so an odd model tick
// rounds there by at most half a file tick too. Only a caller that asks
// rollToMidiFile for the model's own PPQ moves nothing at all.
{
  const odd: PianoNote[] = migrateNotes([{ id: 'odd', note: 60, velocity: 100, tick: 605, ticks: 61 } as PianoNote]);
  const back = midiFileToRoll(
    parseMidi(notesToSmf(odd.map((n) => ({
      midi: n.note,
      startSec: noteTick(n) * SEC_PER_TICK,
      durationSec: noteTicks(n) * SEC_PER_TICK,
      velocity: n.velocity,
    })), 0, 0, [], BPM)),
    'o',
  );
  assert.deepEqual(back.notes.map((n) => [n.tick, n.ticks]), [[606, 60]]);
  assert.ok(Math.abs(back.notes[0].tick - 605) <= 1, 'within one model tick');
}

// The roll's meter rides the same grid: a bar line is its roll step x (PPQ / 4),
// so a signature lands where the notes placed against it do.
{
  const events = rollMeterToSmfEvents([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } }], 0);
  assert.deepEqual(events.map((e) => [e.tick, e.num, e.den]), [[0, 4, 4], [2 * 16 * (SMF_PPQ / 4), 7, 8]]);
  // notesToRollSmf puts those signatures in the file it writes.
  const parsed = parseMidi(notesToRollSmf(
    [{ midi: 60, startSec: 0, durationSec: 0.5, velocity: 100 }],
    { meterMap: [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }], pickupSteps: 0, bpm: BPM },
  ));
  assert.equal(parsed.ppq, SMF_PPQ);
  assert.deepEqual(parsed.timeSignatures?.map((s) => [s.tick, s.num, s.den]), [[0, 7, 8]]);
}

// A bank past 0 is selected (CC 0) just before the program change on every
// channel the file uses, so the render plays that bank's preset; bank 0 writes
// the bytes it always wrote.
{
  const notes = [
    { midi: 60, startSec: 0, durationSec: 0.5, velocity: 100 },
    { midi: 64, startSec: 0.5, durationSec: 0.5, velocity: 90, channel: 3 },
  ];
  const plain = notesToSmf(notes, 60, 0, [], BPM);
  assert.deepEqual(notesToSmf(notes, 60, 0, [], BPM, [], 0), plain, 'bank 0 changes no byte');
  const horn = notesToSmf(notes, 60, 0, [], BPM, [], 1);
  const hex = Buffer.from(horn).toString('hex');
  assert.ok(hex.includes('00b0000100b3000100c03c00c33c'), `bank select then program on channels 1 and 4 (${hex})`);
  const parsed = parseMidi(horn);
  assert.deepEqual(parsed.tracks[0].programs, [{ tick: 0, channel: 0, program: 60, bank: 1 }, { tick: 0, channel: 3, program: 60, bank: 1 }], 'a reader sees the bank with each program');
}

console.log('midiWrite: ok');
