/**
 * lib/editTimeMap arrangementClipTime / arrangementClipTimeAtSec — the time a
 * new MIDI part takes from the arrangement where it starts, so its bar lines
 * and seconds are the arrangement's: its meters from its first bar, the tempo
 * sounding there, a ramp that runs through its start still ramping, later
 * changes moved by its start, and a fermata held before it left out.
 *
 * Each case checks the part's own clock (lib/rollTempo stepClock over its
 * sourceBpm and sourceTempoMap, what EDIT plays and renders it with) against
 * the arrangement's bar seconds.
 *
 *   cd frontend && npx tsx src/lib/editTimeMap.partTime.test.ts
 */
import assert from 'node:assert/strict';
import { arrangementClipTime, arrangementClipTimeAtSec, editBarStartSec, type EditTimeMaps } from './editTimeMap.ts';
import { barStartStep, stepsPerBar } from './meterMap.ts';
import { stepClock } from './rollTempo.ts';

const near = (a: number, b: number, msg: string, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

/** The part's bar k starts at the arrangement's bar (first + k), for every bar it holds. */
function barsLineUp(maps: EditTimeMaps, first: number, bars: number, what: string): void {
  const part = arrangementClipTime(maps, first, bars);
  const clock = stepClock(part.sourceBpm, part.sourceTempoMap);
  near(part.startSec, editBarStartSec(maps, first), `${what}: starts on its bar`);
  for (let k = 0; k <= bars; k += 1) {
    near(part.startSec + clock.at(barStartStep(part.sourceMeterMap, k)), editBarStartSec(maps, first + k), `${what}: bar ${k + 1}`);
  }
  near(clock.at(part.sourceTotalSteps), editBarStartSec(maps, first + bars) - part.startSec, `${what}: ends on the bar line after its last bar`);
}

// 4/4 at 120, a ramp from bar 3 (beat 8) down to 60 at bar 5 (beat 16), 7/8 3+2+2 from bar 6.
const ramp: EditTimeMaps = {
  meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 5, meter: { num: 7, den: 8, groups: [3, 2, 2] } }],
  tempoMap: [{ beat: 0, bpm: 120, curve: 'step' }, { beat: 8, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 60, curve: 'step' }],
};

{
  // Starting inside the ramp: the part starts at the tempo sounding there and keeps ramping.
  const part = arrangementClipTime(ramp, 3, 4);
  assert.ok(part.sourceBpm < 120 && part.sourceBpm > 60, `the tempo sounding at bar 4 (${part.sourceBpm})`);
  assert.equal(part.sourceTempoMap?.[0].curve, 'linear', 'its first event keeps ramping');
  assert.deepEqual(part.sourceTempoMap?.slice(1).map((e) => [e.beat, e.bpm]), [[4, 60]], 'the ramp ends 4 quarters in, at 60');
  assert.deepEqual(part.sourceMeterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 4, 4], [2, 7, 8]], 'the 7/8 arrives at its third bar');
  assert.equal(part.sourceTotalSteps, 2 * 16 + 2 * 14);
  barsLineUp(ramp, 3, 4, 'inside a ramp');
  barsLineUp(ramp, 0, 8, 'from the top');
  barsLineUp(ramp, 6, 3, 'in 7/8 after the ramp');
}

{
  // At one tempo the part needs no tempo map of its own.
  const flat: EditTimeMaps = { meterMap: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }], tempoMap: [{ beat: 0, bpm: 90 }] };
  const part = arrangementClipTime(flat, 2, 4);
  assert.equal(part.sourceTempoMap, undefined);
  assert.equal(part.sourceBpm, 90);
  assert.equal(part.sourceTotalSteps, 4 * 12);
  barsLineUp(flat, 2, 4, 'one tempo');
}

{
  // A fermata before the part is left out; one inside it moves with it.
  const held: EditTimeMaps = {
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
    tempoMap: [{ beat: 0, bpm: 100 }, { beat: 3, bpm: 100, fermata: { beats: 1, stretch: 3 } }, { beat: 14, bpm: 100, fermata: { beats: 1, stretch: 2 } }],
  };
  const part = arrangementClipTime(held, 2, 2);
  assert.deepEqual(part.sourceTempoMap?.filter((e) => e.fermata).map((e) => e.beat), [6], 'only the fermata inside it, 6 quarters in');
  barsLineUp(held, 2, 2, 'with a fermata');
}

{
  // Inside a bar: the part holds the meter sounding there for all its bars.
  const at = editBarStartSec(ramp, 6) + 0.4;
  const part = arrangementClipTimeAtSec(ramp, at, 3);
  near(part.startSec, at, 'it starts where it was asked');
  assert.deepEqual(part.sourceMeterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]), [[0, 7, 8, '3+2+2']]);
  assert.equal(part.sourceTotalSteps, 3 * stepsPerBar({ num: 7, den: 8, groups: [3, 2, 2] }));
  assert.equal(part.sourceBpm, 60);
  // On a bar line it is the bar-aligned part.
  assert.deepEqual(arrangementClipTimeAtSec(ramp, editBarStartSec(ramp, 3), 4), arrangementClipTime(ramp, 3, 4));
}

console.log('editTimeMap.partTime: ok');
