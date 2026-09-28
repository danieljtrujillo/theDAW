/**
 * A score into the roll on the roll's own clock: every note at its tick,
 * every time signature with the pickup, every tempo mark, and the sustain
 * pedal its pedal marks give each part
 * (lib/rollPartsImport importSheetParts over the sheet importer's answer).
 *
 * Before: the roll took the score's notes on whole 16th steps (a quintuplet
 * moved to the grid), its FIRST time signature for the whole roll and its
 * FIRST tempo, so a movement that changes meter and tempo came in wrong from
 * its second section on, and a pickup shifted every bar line.
 *
 *   cd frontend && npx tsx src/lib/sheetScoreImport.test.ts
 */
import assert from 'node:assert/strict';
import { importSheetParts, sheetScoreMeter, sheetScoreParts, sheetScoreTempoMap } from './rollPartsImport.ts';
import type { SheetScore } from './sheetImportClient.ts';
import { endRollGesture, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';

const roll = () => usePianoRollStore.getState();
const t = (tick: number, ticks: number, pitch: number, velocity = 80) => ({ pitch, tick, ticks, step: tick / 240, length: ticks / 240, velocity });

// The importer's answer for a flute and a cello: a one-beat pickup in 3/4, a
// quintuplet of 16ths (192 ticks each) in bar 1, bar 2 in 7/8 (2+2+3); Allegro
// (a word: 132) at the start, Molto adagio (40) on beat 3 of bar 1, and an
// eighth at 240 (120 a quarter) at bar 2.
const score: SheetScore = {
  ok: true,
  name: 'Sketch',
  format: 'musicxml',
  bpm: 132,
  time_signature: [3, 4],
  detected_key: 'G major',
  track_count: 2,
  note_count: 9,
  steps_per_quarter: 4,
  ppq: 960,
  pickup_ticks: 960,
  time_signatures: [
    { tick: 0, num: 3, den: 4, groups: [], measure: 0 },
    { tick: 3840, num: 7, den: 8, groups: [2, 2, 3], measure: 2 },
  ],
  tempos: [
    { tick: 0, bpm: 132, text: 'Allegro', implicit: true },
    { tick: 2880, bpm: 40, text: 'Molto adagio', implicit: true },
    { tick: 3840, bpm: 120, text: '', implicit: false },
  ],
  tracks: [
    {
      name: 'Flute',
      instrument: 'flute',
      program: 73,
      percussion: false,
      notes: [t(0, 960, 74), t(960, 192, 76), t(1152, 192, 77), t(1344, 192, 79), t(1536, 192, 81), t(1728, 192, 83), t(3840, 1440, 84)],
    },
    { name: 'Violoncello', instrument: 'cello', program: 42, percussion: false, notes: [t(960, 2880, 43), t(3840, 3360, 36)] },
  ],
};

// Each note keeps its tick: a quintuplet 16th is 192 ticks, not a 16th step.
{
  const parts = sheetScoreParts(score);
  assert.deepEqual(parts.map((p) => p.track.instrumentId), ['flute', 'cello']);
  assert.deepEqual(parts[0].notes.slice(1, 6).map((n) => [n.tick, n.ticks, n.step, n.length]), [
    [960, 192, 4, 0.8],
    [1152, 192, 4.8, 0.8],
    [1344, 192, 5.6, 0.8],
    [1536, 192, 6.4, 0.8],
    [1728, 192, 7.2, 0.8],
  ], 'a quintuplet at its ticks');
}

// The meter: a one-beat pickup, bar 1 in 3/4, bar 2 in 7/8 (2+2+3).
{
  const meter = sheetScoreMeter(score);
  assert.equal(meter.pickupSteps, 4, 'the pickup is one beat');
  assert.deepEqual(meter.meterMap, [
    { bar: 0, meter: { num: 3, den: 4, groups: [] } },
    { bar: 1, meter: { num: 7, den: 8, groups: [2, 2, 3] } },
  ]);
  // No pickup: bar 1 is the first bar, and a short first bar followed by a change is not taken for one.
  const plain = sheetScoreMeter({ ...score, pickup_ticks: 0, time_signatures: [{ tick: 0, num: 2, den: 4 }, { tick: 1920, num: 4, den: 4 }] });
  assert.equal(plain.pickupSteps, 0);
  assert.deepEqual(plain.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 2, 4], [1, 4, 4]]);
}

// The tempo map: every mark at its beat.
assert.deepEqual(sheetScoreTempoMap(score)?.map((e) => [e.beat, e.bpm]), [[0, 132], [3, 40], [4, 120]]);
assert.equal(sheetScoreTempoMap({ ...score, tempos: [{ tick: 0, bpm: 132 }] }), undefined, 'one tempo is no map');

// Into the roll: two parts, the meter map with its pickup, the tempo map, the ticks. One undo step.
{
  roll().importNotes([{ id: 'x', note: 60, step: 0, length: 2, velocity: 90 }], 100);
  // The import records a step of its own, however soon it follows (the store folds edits 300 ms apart).
  endRollGesture();
  const done = importSheetParts(score);
  assert.equal(done.into, 'parts');
  assert.deepEqual([done.meterChanges, done.tempoChanges], [1, 2]);
  assert.equal(roll().pickupSteps, 4);
  assert.deepEqual(roll().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]), [[0, 3, 4, ''], [1, 7, 8, '2+2+3']]);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 132], [3, 40], [4, 120]]);
  assert.equal(roll().bpm, 132);
  const flute = rollTracksOf(roll())[0];
  assert.deepEqual(flute.notes.map((n) => n.tick), [0, 960, 1152, 1344, 1536, 1728, 3840], "the flute's notes at their ticks");
  roll().undo();
  assert.equal(roll().tracks.length, 1, 'one undo puts the roll back');
  assert.equal(roll().bpm, 100);
}

// A piano score's sustain pedal (the importer's controller 64 changes) comes in as the part's controls,
// on both staves of a split piano, and one part into the part being edited sets them in the same undo step.
{
  const pedal = [
    { tick: 0, controller: 64, value: 127 },
    { tick: 1920, controller: 64, value: 0 },
    { tick: 1980, controller: 64, value: 127 },
    { tick: 3840, controller: 64, value: 0 },
  ];
  const piano: SheetScore = {
    ...score,
    tempos: [{ tick: 0, bpm: 90 }],
    time_signatures: [{ tick: 0, num: 4, den: 4, groups: [] }],
    pickup_ticks: 0,
    tracks: [
      { name: 'Piano', instrument: 'piano', program: 0, notes: [t(0, 1920, 72), t(1920, 1920, 74)], controls: pedal },
      { name: 'Piano', instrument: 'piano', program: 0, notes: [t(0, 3840, 48)], controls: pedal },
    ],
  };
  const parts = sheetScoreParts(piano);
  assert.deepEqual(parts.map((p) => p.track.controls), [pedal, pedal], 'each staff with the pedal');
  assert.equal(sheetScoreParts({ ...piano, tracks: [{ ...piano.tracks[0], controls: undefined }] })[0].track.controls, undefined, 'no pedal, no controls');
  // An importer at 480 PPQ: the pedal lands on the roll's 960 like the notes.
  assert.deepEqual(sheetScoreParts({ ...piano, ppq: 480 })[0].track.controls?.map((c) => c.tick), [0, 3840, 3960, 7680]);
  importSheetParts(piano);
  assert.deepEqual(rollTracksOf(roll()).map((p) => p.controls), [pedal, pedal], 'the roll parts hold it');
  endRollGesture();
  // One part into the part being edited: its notes and its pedal are one undo step.
  roll().importNotes([{ id: 'y', note: 60, step: 0, length: 2, velocity: 90 }], 90, undefined, undefined, undefined, { controls: [] });
  endRollGesture();
  importSheetParts({ ...piano, tracks: [piano.tracks[0]] });
  assert.deepEqual(rollTracksOf(roll()).find((p) => p.id === roll().activeTrackId)?.controls, pedal);
  roll().undo();
  assert.equal(rollTracksOf(roll()).find((p) => p.id === roll().activeTrackId)?.controls, undefined, 'one undo takes the pedal back out with the notes');
  assert.deepEqual(roll().notes.map((n) => n.note), [60]);
}

// An answer from an older backend (whole steps, the first signature and tempo alone) comes in as it always did.
{
  const older: SheetScore = {
    ...score,
    ppq: undefined,
    pickup_ticks: undefined,
    time_signatures: undefined,
    tempos: undefined,
    tracks: [{ name: 'Flute', notes: [{ pitch: 72, step: 0, length: 4, velocity: 80 }, { pitch: 74, step: 4, length: 4, velocity: 80 }] }],
  };
  importSheetParts(older);
  assert.deepEqual(roll().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 3, 4]]);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 132]]);
  assert.deepEqual(roll().notes.map((n) => [n.step, n.length, n.tick]), [[0, 4, 0], [4, 4, 960]]);
}

console.log('sheetScoreImport: ok');
