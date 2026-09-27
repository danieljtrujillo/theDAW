import assert from 'node:assert/strict';
import { seedFromRhythm, swingFromRhythm, tempoRuns, type RhythmAnalysis } from './rhythmSeed.ts';
import { barStartStep } from './meterMap.ts';
import { beatToTime } from './tempoMap.ts';

const base: RhythmAnalysis = {
  status: 'ready',
  tempo: { bpm: 120, stable: true },
  downbeats: [0.25, 2],
  meter_map: [
    { start_bar: 0, bars: 4, numerator: 7, denominator: 8, grouping: [3, 2, 2], beats_per_bar: 7 },
    { start_bar: 4, bars: 2, numerator: 6, denominator: 8, grouping: [1, 1], beats_per_bar: 2, uncertain: true },
  ],
  polymeter: [
    { segment: 0, layer: 'high', beats_per_bar: 3, grouping: [3], denominator: 8, confidence: 0.8 },
    { segment: 0, layer: 'low', beats_per_bar: 5, grouping: [5], denominator: 4, confidence: 0.9 },
    { segment: 0, layer: 'mid', beats_per_bar: 7, grouping: [3, 2, 2], denominator: 8, confidence: 0.95 },
    { segment: 1, layer: 'drums', beats_per_bar: 4, grouping: [4], confidence: 0.99 },
    { segment: 0, layer: 'bass', beats_per_bar: 10, grouping: [5, 5], denominator: 8, confidence: 0.7 },
  ],
};
const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// Meter segments, the compound 6/8 grouping, a 2-step pickup, and lanes from the named polymeter loops.
{
  const s = seedFromRhythm(base, 90);
  assert.ok(s);
  assert.deepEqual(s.meterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }, { bar: 4, meter: { num: 6, den: 8, groups: [3, 3] } }]);
  assert.equal(s.pickupSteps, 2);
  // mid repeats the segment's own bar; drums names no denominator; bass loops 20 like low.
  // Every loop was heard in segment 0, so each lane plays bars 1-4 only: from
  // step 0 to where bar 5 starts (the 2-step pickup plus four 14-step bars).
  assert.deepEqual(s.lanes, [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'Low', cycleSteps: 20, span: { start: 0, end: 58 } },
    { id: 2, name: 'High', cycleSteps: 6, span: { start: 0, end: 58 } },
  ]);
  assert.equal(s.bpm, 120);
  assert.deepEqual(s.tempoMap, [], 'one tempo holds the song, so no tempo changes');
  assert.equal(s.tempoFromDownbeats, true);
  assert.equal(s.tempoStable, true);
  assert.equal(s.uncertainBars, 2);
  assert.equal(s.swing, null);
}

// A first downbeat more than a bar in: the whole bars go ahead of bar 0, the rest is the pickup.
{
  const s = seedFromRhythm({ ...base, downbeats: [3.25] }, 120);
  assert.ok(s);
  assert.equal(s.pickupSteps, 12);
  assert.deepEqual(s.meterMap.map((seg) => seg.bar), [0, 5]);
  assert.equal(s.tempoFromDownbeats, false, 'one downbeat gives no tempo of its own');
  assert.equal(s.bpm, 120, 'the tracked tempo stands in');
}

// Pending, empty, or no tempo.
{
  assert.equal(seedFromRhythm({ status: 'pending' }, 120), null);
  assert.equal(seedFromRhythm({ status: 'ready', meter_map: [] }, 120), null);
  const s = seedFromRhythm({ ...base, tempo: undefined, downbeats: [0.5], polymeter: undefined }, 60);
  assert.ok(s);
  assert.equal(s.bpm, null);
  assert.equal(s.pickupSteps, 2);
  assert.deepEqual(s.lanes.map((l) => l.id), [0]);
  assert.equal(seedFromRhythm(base, 120, 1)?.lanes.length, 2);
}

// A ritardando: eight bars of 4/4 at 120, three bars that slow down, then four
// at the new tempo. The tempo map holds each run, and every bar line lands on
// its downbeat under it while the bar's step stays where the meter puts it.
{
  const durs = [2, 2, 2, 2, 2, 2, 2, 2, 2.2, 2.4, 2.6, 2.6, 2.6, 2.6];
  const downbeats = [0];
  for (const d of durs) downbeats.push(Math.round((downbeats[downbeats.length - 1] + d) * 1e6) / 1e6);
  const rit: RhythmAnalysis = {
    status: 'ready',
    tempo: { bpm: 110, stable: false },
    downbeats,
    meter_map: [{ start_bar: 0, bars: downbeats.length, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4 }],
  };
  const s = seedFromRhythm(rit, 120);
  assert.ok(s);
  assert.equal(s.pickupSteps, 0);
  assert.deepEqual(s.tempoMap, [
    { beat: 0, bpm: 120 },
    { beat: 32, bpm: 109.091 },
    { beat: 36, bpm: 100 },
    { beat: 40, bpm: 92.308 },
  ]);
  close(s.bpm ?? 0, (60 * 56) / 31, 1e-9, 'the song tempo is its average over the downbeats');
  downbeats.forEach((d, j) => {
    const step = barStartStep(s.meterMap, j, s.pickupSteps);
    assert.equal(step, j * 16, `bar ${j + 1} keeps its step`);
    close(beatToTime(s.tempoMap, step / 4), d, 1e-3, `bar ${j + 1} lands on its downbeat`);
  });
}

// A 7/8 the engine tracked in eighths reports 190 BPM; its bars last 7 eighths
// at 190, which is 95 to the quarter. The pickup counts at 95 as well.
{
  const bar = (7 * 60) / 190;
  const odd: RhythmAnalysis = {
    status: 'ready',
    tempo: { bpm: 190, stable: true },
    downbeats: [0.3, 0.3 + bar, 0.3 + 2 * bar, 0.3 + 3 * bar],
    meter_map: [{ start_bar: 0, bars: 4, numerator: 7, denominator: 8, grouping: [2, 2, 3], beats_per_bar: 7, beat_unit: 'eighth' }],
  };
  const s = seedFromRhythm(odd, 120);
  assert.ok(s);
  close(s.bpm ?? 0, 95, 1e-6, 'a quarter-note tempo');
  assert.equal(s.pickupSteps, 2, '0.3 s at 95 is two sixteenths');
  assert.deepEqual(s.tempoMap, []);
}

// Tempo runs stay inside the tolerance and break where the tempo moves.
{
  assert.deepEqual(tempoRuns([0, 4, 8, 12], [0, 2, 4.01, 6]), [{ from: 0, to: 3, bpm: 120 }], '10 ms off stays one run');
  const runs = tempoRuns([0, 4, 8, 12], [0, 2, 4, 6.5]);
  assert.deepEqual(runs.map((r) => [r.from, r.to]), [[0, 2], [2, 3]]);
  assert.deepEqual(tempoRuns([0], [0]), []);
}

// Swing: the long off-beat's share of the beat, on 8ths under a quarter-note
// beat and on 16ths under an eighth-note beat; a straight song leaves the groove alone.
{
  const m44 = [{ start_bar: 0, bars: 8, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4, beat_unit: 'quarter' }];
  const sw = swingFromRhythm({ status: 'ready', meter_map: m44, syncopation: { swing_ratio: 1.6 } });
  assert.deepEqual(sw, { ratio: 1.6, pct: 61.5, unit: 8, grooveId: 'swing8:61.5' });
  assert.equal(swingFromRhythm({ status: 'ready', meter_map: m44, syncopation: { swing_ratio: 1.02 } }), null, '50.5% is straight');
  assert.equal(swingFromRhythm({ status: 'ready', meter_map: m44, syncopation: { swing_ratio: null } }), null);
  const fast = [{ ...m44[0], numerator: 7, denominator: 8, beat_unit: 'eighth' }];
  assert.equal(swingFromRhythm({ status: 'ready', meter_map: fast, syncopation: { swing_ratio: 2 } })?.grooveId, 'swing16:66.7');
  assert.equal(swingFromRhythm({ status: 'ready', meter_map: m44, syncopation: { swing_ratio: 9 } })?.pct, 75, 'held to 75%');
  assert.equal(seedFromRhythm({ ...base, syncopation: { swing_ratio: 1.6 } }, 120)?.swing?.grooveId, 'swing16:61.5', "7/8 at the tracked beat swings its 16ths");
}

// Lanes cover the segments their loop was heard in: one heard in the middle
// segment only plays there, one heard in the first and the last runs the whole roll.
{
  const three: RhythmAnalysis = {
    status: 'ready',
    tempo: { bpm: 120, stable: true },
    downbeats: [0, 2],
    meter_map: [
      { start_bar: 0, bars: 4, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4 },
      { start_bar: 4, bars: 4, numerator: 7, denominator: 8, grouping: [3, 2, 2], beats_per_bar: 7 },
      { start_bar: 8, bars: 4, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4 },
    ],
    polymeter: [
      { segment: 1, layer: 'low', beats_per_bar: 3, grouping: [3], denominator: 4, confidence: 0.9 },
      { segment: 0, layer: 'high', beats_per_bar: 3, grouping: [3], denominator: 8, confidence: 0.8 },
      { segment: 2, layer: 'hats', beats_per_bar: 3, grouping: [3], denominator: 8, confidence: 0.6 },
    ],
  };
  const s = seedFromRhythm(three, 120);
  assert.ok(s);
  assert.deepEqual(s.lanes, [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'Low', cycleSteps: 12, span: { start: 64, end: 120 } },
    { id: 2, name: 'High', cycleSteps: 6 },
  ]);
}

console.log('rhythmSeed: ok');
