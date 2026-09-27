import assert from 'node:assert/strict';
import { buildComposePrompt, composeGrid, composeMeterSummary, parseComposeResponse } from './aiComposeGrid.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import type { MeterSegment } from './meterMap.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M54 = { num: 5, den: 4, groups: [] as number[] };
// 7/8 3+2+2 for bars 1-2, then 5/4, with a 2-step pickup.
const MAP: MeterSegment[] = [{ bar: 0, meter: M78 }, { bar: 2, meter: M54 }];

// The grid: the pickup, then each bar's steps in its own meter and its group starts.
{
  const g = composeGrid({ bars: 3, meterMap: MAP, pickupSteps: 2 });
  assert.equal(g.totalSteps, 2 + 14 + 14 + 20);
  assert.deepEqual(g.rows.map((r) => [r.bar, r.start, r.end, r.groupStarts]), [
    [1, 2, 16, [2, 8, 12]],
    [2, 16, 30, [16, 22, 26]],
    [3, 30, 50, [30, 34, 38, 42, 46]],
  ]);
  // No meter given: 4/4, no pickup, 16 steps a bar as before.
  const plain = composeGrid({ bars: 2 });
  assert.equal(plain.totalSteps, 32);
  assert.deepEqual(plain.rows[1].groupStarts, [16, 20, 24, 28]);
  assert.equal(composeGrid({ bars: 99 }).bars, 32, 'at most 32 bars');
  assert.equal(composeMeterSummary(MAP, 2), '7/8 grouped 3+2+2, 5/4 from bar 3, pickup 2 steps');
  assert.equal(composeMeterSummary(undefined, 0), '4/4');
}

// The prompt names the pickup, every bar's steps, meter and groups, the length, and fractional tuplet steps.
{
  const prompt = buildComposePrompt({ prompt: 'a rondo', key: 'D', mode: 'minor', bars: 3, bpm: 97.5, meterMap: MAP, pickupSteps: 2, complexity: 0.5 });
  assert.match(prompt, /pickup \(anacrusis\) of 2 steps, steps 0 to 2, before bar 1\./);
  assert.match(prompt, /Bar 1: steps 2 to 16 \(14 steps\), 7\/8 grouped 3\+2\+2; groups start at steps 2, 8, 12\./);
  assert.match(prompt, /Bar 3: steps 30 to 50 \(20 steps\), 5\/4; groups start at steps 30, 34, 38, 42, 46\./);
  assert.match(prompt, /Total length: 3 bars after the pickup = 50 steps\. Write no note at or after step 50\./);
  assert.match(prompt, /quintuplet 16ths 0\.8 steps apart/);
  assert.match(prompt, /Tempo: 97\.5 BPM/);
  assert.match(prompt, /step: number >= 0, in 16th-note steps, fractions allowed/);
  assert.doesNotMatch(prompt, /16 steps per bar/, 'no 4/4 assumption left in the prompt');
}

// The sequence the AI key runs: a 7/8 roll with a pickup sends its meter, the
// model answers with a quintuplet on the 5/4 bar and a triplet in bar 1, the
// roll imports it with the request's meter, and the part survives a MIDI file
// export and reimport on the same steps.
{
  usePianoRollStore.setState({ meterMap: MAP, pickupSteps: 2, totalSteps: 64 });
  const grid = composeGrid({ bars: 3, meterMap: st().meterMap, pickupSteps: st().pickupSteps });
  const quint = [30, 30.8, 31.6, 32.4, 33.2];
  const trip = [2, 3.333, 4.667];
  const answer = JSON.stringify({
    bpm: 96,
    summary: 'a test',
    notes: [
      ...trip.map((step) => ({ note: 62, step, length: 1.333, velocity: 90 })),
      ...quint.map((step) => ({ note: 69, step, length: 0.8, velocity: 80 })),
      { note: 50, step: 49.5, length: 4, velocity: 70 },
      { note: 51, step: 50, length: 1, velocity: 70 },
    ],
  });
  const res = parseComposeResponse(answer, grid, 120, (i) => `ai-${i}`);
  assert.deepEqual(res.notes.filter((n) => n.note === 69).map((n) => n.step), quint, 'the quintuplet keeps its fractional steps');
  assert.deepEqual(res.notes.filter((n) => n.note === 62).map((n) => n.step), trip);
  assert.equal(res.notes.find((n) => n.note === 50)?.length, 0.5, 'a length runs to the end at most');
  assert.equal(res.notes.some((n) => n.note === 51), false, 'a note at the end is dropped');
  assert.equal(res.bpm, 96);
  assert.deepEqual([res.meterMap, res.pickupSteps], [MAP, 2]);

  // The roll changes meter while the request runs; the part still lands in the meter it was written for.
  usePianoRollStore.setState({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  st().importNotes(res.notes, res.bpm, { meterMap: res.meterMap, pickupSteps: res.pickupSteps });
  assert.deepEqual(st().meterMap, MAP);
  assert.equal(st().pickupSteps, 2);
  assert.equal(st().bpm, 96);
  const quintTicks = st().notes.filter((n) => n.note === 69).map((n) => n.tick);
  assert.deepEqual(quintTicks, [7200, 7392, 7584, 7776, 7968], 'quintuplet 16ths are 192 ticks apart at 960 to the quarter');

  const back = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile(st()))), 'imp');
  assert.deepEqual(back.notes.filter((n) => n.note === 69).map((n) => n.tick), quintTicks, 'the quintuplet survives the MIDI file');
  assert.deepEqual(back.notes.filter((n) => n.note === 62).map((n) => n.step), st().notes.filter((n) => n.note === 62).map((n) => n.step));
  assert.deepEqual(back.meter.meterMap, MAP);
  assert.equal(back.meter.pickupSteps, 2);
}

// Bad JSON and an empty answer are errors the card reports.
{
  const g = composeGrid({ bars: 1 });
  assert.throws(() => parseComposeResponse('{nope', g, 120, String), /invalid JSON/);
  assert.throws(() => parseComposeResponse('{"notes": []}', g, 120, String), /no notes/);
  assert.equal(parseComposeResponse('{"notes":[{"note":60,"step":0,"length":1,"velocity":90}]}', g, 101.25, String).bpm, 101.25, "no tempo in the answer keeps the request's");
}

console.log('aiComposeGrid: ok');
