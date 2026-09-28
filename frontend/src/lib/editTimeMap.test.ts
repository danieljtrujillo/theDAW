/**
 * editTimeMap: the EDIT arrangement's clock, bars, grid, ruler, snap, moves and
 * clip adoption under a tempo map and a meter map.
 *
 * The map most cases share: 4/4 for two bars at 120 BPM, then 7/8 3+2+2 from
 * bar 3, where the tempo drops to 60. Bar 3 starts at step 32 = 4 s; a 7/8 bar
 * is 14 steps, 3.5 s at 60 BPM, so bar 4 starts at 7.5 s and bar 5 at 11 s.
 * A single-tempo 4/4 grid would put bar 4 at 6 s.
 *
 *   cd frontend && npx tsx src/lib/editTimeMap.test.ts
 */
import assert from 'node:assert/strict';
import {
  adoptClipTimeMaps,
  describeClipTime,
  editBarAtSec,
  editBarPosToBeat,
  editBarStartSec,
  editBarStartStep,
  editBeatToBarPos,
  editClock,
  editGridLines,
  editGridStepSec,
  editMeterFlags,
  editMoveByBars,
  editMoveByBeats,
  editRulerBars,
  editSnapSec,
  editTempoAtSec,
  editTempoFlags,
  parseEditMeter,
  sameMeterMap,
  sameTempoMap,
  withStartBpm,
  withTempoEvent,
  withTempoEventMoved,
  withoutTempoEvent,
  type EditTimeMaps,
} from './editTimeMap.ts';
import { sanitizeRollTempoMap, stepClock } from './rollTempo.ts';
import { barAt, barStartStep, type MeterSegment } from './meterMap.ts';
import type { TempoEvent } from './tempoMap.ts';

const near = (a: number, b: number, eps = 1e-9, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

const tempo: TempoEvent[] = sanitizeRollTempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }], 120);
const meter: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 2, meter: { num: 7, den: 8, groups: [3, 2, 2] } }];
const maps: EditTimeMaps = { tempoMap: tempo, meterMap: meter };

/* ── clock and bars ───────────────────────────────────────────────────── */
{
  const clock = editClock(tempo);
  assert.equal(editClock(tempo), clock, 'one clock per map identity');
  near(clock.at(32), 4);
  near(clock.at(46), 7.5);
  near(editBarStartSec(maps, 2), 4);
  near(editBarStartSec(maps, 3), 7.5, 1e-9, 'bar 4 after a 7/8 bar at 60');
  near(editBarStartSec(maps, 4), 11);
  const b = editBarAtSec(maps, 5);
  assert.equal(b.bar, 2);
  assert.equal(b.meter.num, 7);
  near(b.startSec, 4);
  near(b.endSec, 7.5);
  near(editTempoAtSec(tempo, 3.9), 120);
  near(editTempoAtSec(tempo, 4.1), 60);
}

/* ── snap restarts at every bar line of the meter that holds ─────────── */
{
  near(editSnapSec(maps, 5.2, 4), 5, 1e-9, 'quarter grid inside 7/8');
  near(editSnapSec(maps, 7.3, 4), 7.5, 1e-9, 'the 7/8 bar line, not a straight quarter at step 48');
  near(editSnapSec(maps, 5, 'bar'), 4, 1e-9, 'bar grid');
  near(editSnapSec(maps, 6.1, 'bar'), 7.5, 1e-9);
  near(editSnapSec(maps, 1.06, 2), 1.0, 1e-9, '8th grid at 120');
  near(editSnapSec(maps, 3.33, 0), 3.33, 1e-12, 'off is the identity');
  near(editSnapSec(maps, -2, 4), 0, 1e-12, 'never before 0');
  // A triplet 8th (4/3 of a step) in 4/4 at 120: lines every 1/6 s.
  near(editSnapSec(maps, 0.18, 4 / 3), 1 / 6);
  near(editGridStepSec(maps, 5, 4) ?? NaN, 1, 1e-9, 'a quarter at 60 BPM');
  near(editGridStepSec(maps, 5, 'bar') ?? NaN, 3.5, 1e-9, 'a 7/8 bar at 60 BPM');
  near(editGridStepSec(maps, 1, 'bar') ?? NaN, 2, 1e-9, 'a 4/4 bar at 120 BPM');
  assert.equal(editGridStepSec(maps, 1, 0), null);
}

/* ── moves by bars and beats ─────────────────────────────────────────── */
{
  // Halfway through bar 1 (step 8), two bars on: halfway through the 7/8 bar 3.
  near(editMoveByBars(maps, 1, 2), 4 + 7 * 0.25);
  near(editMoveByBars(maps, 5.75, -2), 1, 1e-9, 'and back');
  near(editMoveByBars(maps, 1, -5), 0, 1e-12, 'clamped at 0');
  // Three 8ths from the top of the 7/8 bar at 60 BPM: 1.5 s.
  near(editMoveByBeats(maps, 4, 3), 5.5);
  near(editMoveByBeats(maps, 1, 1), 1.5, 1e-9, 'a quarter in 4/4 at 120');
}

/* ── the grid: each bar in its own meter, at its own tempo ───────────── */
{
  const lines = editGridLines({ ...maps, startSec: 3.9, endSec: 8, zoom: 100 });
  assert.deepEqual(
    lines.map((l) => [Math.round(l.sec * 1000) / 1000, l.level, l.barIndex]),
    [
      [4, 'bar', 2], [4.5, 'sub', 2], [5, 'sub', 2], [5.5, 'beat', 2], [6, 'sub', 2], [6.5, 'beat', 2], [7, 'sub', 2],
      [7.5, 'bar', 3], [8, 'sub', 3],
    ],
    'the 7/8 bar draws its group starts (steps 6, 10) as beats and its other 8ths as subs',
  );
  // Zoomed far out, bars are thinned to every 2^k-th and nothing finer is drawn.
  const far = editGridLines({ ...maps, startSec: 0, endSec: 600, zoom: 0.5 });
  assert.ok(far.length > 0 && far.every((l) => l.level === 'bar'), 'only bar lines when zoomed out');
  assert.ok(far.every((l) => l.barIndex % 8 === 0 || l.barIndex % 4 === 0), 'thinned to a power-of-two stride');
  assert.ok(far.length < 200, `thinned (${far.length} lines)`);
  assert.deepEqual(editGridLines({ ...maps, startSec: 5, endSec: 4, zoom: 10 }), [], 'an inverted window draws nothing');
}

/* ── the ruler: bar numbers, meter flags, tempo flags ─────────────────── */
{
  assert.deepEqual(
    editRulerBars({ ...maps, startSec: 0, endSec: 12, zoom: 100 }).map((b) => [b.bar, Math.round(b.sec * 1000) / 1000]),
    [[1, 0], [2, 2], [3, 4], [4, 7.5], [5, 11]],
  );
  assert.deepEqual(editMeterFlags(maps, 0, 12).map((f) => [f.bar, f.sec, f.label]), [[0, 0, '4/4'], [2, 4, '7/8 3+2+2']]);
  assert.deepEqual(editMeterFlags(maps, 1, 12).map((f) => f.bar), [2], 'windowed');
  const withHold = withTempoEvent(tempo, { beat: 10, bpm: 60, fermata: { beats: 1, stretch: 3 } });
  assert.deepEqual(
    editTempoFlags({ tempoMap: withHold, meterMap: meter }, 0, 20).map((f) => [f.kind, f.beat, f.sec, f.label]),
    [['tempo', 0, 0, '120 BPM'], ['tempo', 8, 4, '60 BPM'], ['fermata', 10, 6, 'Hold x3']],
  );
}

/* ── positions a person types ────────────────────────────────────────── */
{
  assert.deepEqual(editBeatToBarPos(meter, 8), { bar: 3, beatInBar: 0 });
  assert.deepEqual(editBeatToBarPos(meter, 11.5), { bar: 4, beatInBar: 0 }, '7/8 is 3.5 quarters');
  assert.deepEqual(editBeatToBarPos(meter, 12), { bar: 4, beatInBar: 0.5 });
  assert.equal(editBarPosToBeat(meter, 4, 0.5), 12);
  assert.equal(editBarPosToBeat(meter, 1, 0), 0);
  assert.deepEqual(parseEditMeter('7/8 3+2+2'), { num: 7, den: 8, groups: [3, 2, 2] });
  assert.deepEqual(parseEditMeter(' 5/4 '), { num: 5, den: 4, groups: [] });
  assert.deepEqual(parseEditMeter('7/8 groups=2+2+3'), { num: 7, den: 8, groups: [2, 2, 3] });
  assert.equal(parseEditMeter('7/8 3+3'), null, 'groups that do not add up are refused, not dropped');
  assert.equal(parseEditMeter('7/5'), null);
  assert.equal(parseEditMeter('65/4'), null);
}

/* ── map edits keep the start at beat 0 ──────────────────────────────── */
{
  const a = withStartBpm(tempo, 90);
  assert.deepEqual(a.map((e) => [e.beat, e.bpm]), [[0, 90], [8, 60]], 'the start moves, the change stays');
  const moved = withTempoEventMoved(tempo, 8, 'tempo', { beat: 0 });
  assert.ok(moved && moved[1].beat > 0 && moved[0].bpm === 120, 'a change dragged onto beat 0 stops a tick after it');
  assert.equal(withTempoEventMoved(tempo, 99, 'tempo', { bpm: 70 }), null);
  assert.equal(withoutTempoEvent(tempo, 0, 'tempo'), null, 'the start is never removed');
  assert.deepEqual(withoutTempoEvent(tempo, 8, 'tempo')?.map((e) => e.beat), [0]);
  assert.ok(sameTempoMap(tempo, sanitizeRollTempoMap([{ beat: 8, bpm: 60 }, { beat: 0, bpm: 120 }], 120)));
  assert.ok(!sameTempoMap(tempo, a));
  assert.ok(sameMeterMap(meter, [...meter, { bar: 5, meter: { num: 7, den: 8, groups: [3, 2, 2] } }]), 'a repeated meter is no change');
}

/* ── adopting a clip's maps ──────────────────────────────────────────── */
const edit0: EditTimeMaps = { tempoMap: sanitizeRollTempoMap([], 120), meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }] };
const clipTempo = sanitizeRollTempoMap([{ beat: 0, bpm: 96 }, { beat: 16, bpm: 72, curve: 'linear' }, { beat: 32, bpm: 132 }], 96);
const clipMeter: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 4, meter: { num: 7, den: 8, groups: [3, 2, 2] } }, { bar: 8, meter: { num: 5, den: 4, groups: [] } }];
const clip = { startSec: 0, offsetIntoSource: 0, sourceBpm: 96, sourceTempoMap: clipTempo, sourceMeterMap: clipMeter };
const clipClock = stepClock(96, clipTempo);
{
  // At the timeline start the arrangement takes the clip's maps whole.
  const r = adoptClipTimeMaps(edit0, clip);
  assert.ok(r.ok && r.changes);
  if (!r.ok) throw new Error(r.error);
  assert.ok(sameTempoMap(r.tempoMap, clipTempo), 'tempo map is the clip\'s');
  assert.ok(sameMeterMap(r.meterMap, clipMeter), 'meter map is the clip\'s');
  assert.equal(r.firstBar, 0);
  // Every bar line of the clip is a bar line of the arrangement, at the same second.
  for (let bar = 0; bar < 14; bar += 1) {
    const clipStep = [0, 16, 32, 48, 64, 78, 92, 106, 120, 140, 160, 180, 200, 220][bar];
    near(editBarStartSec({ tempoMap: r.tempoMap, meterMap: r.meterMap }, bar), clipClock.at(clipStep), 1e-9, `bar ${bar + 1}`);
  }
  // Adopting it again changes nothing.
  const again = adoptClipTimeMaps({ tempoMap: r.tempoMap, meterMap: r.meterMap }, clip);
  assert.ok(again.ok && !again.changes);
}
{
  // Starting 3 s in (step 24, halfway through bar 2) cuts bar 2 to a 2/4 bar,
  // and the clip's bar 1 becomes the arrangement's bar 3.
  const r = adoptClipTimeMaps(edit0, { ...clip, startSec: 3 });
  if (!r.ok) throw new Error(r.error);
  assert.equal(r.firstBar, 2);
  assert.deepEqual(r.meterMap.map((s) => [s.bar, `${s.meter.num}/${s.meter.den}`]), [[0, '4/4'], [1, '2/4'], [2, '4/4'], [6, '7/8'], [10, '5/4']]);
  assert.deepEqual(r.tempoMap.slice(0, 2).map((e) => [e.beat, e.bpm]), [[0, 120], [6, 96]], 'the clip\'s tempo from beat 6');
  const m = { tempoMap: r.tempoMap, meterMap: r.meterMap };
  near(editBarStartSec(m, 1), 2);
  near(editBarStartSec(m, 2), 3, 1e-9, 'the clip\'s first bar sits where the clip starts');
  // Through the clip's ramp and meter changes, each clip bar lands on its second.
  for (const [clipBar, clipStep] of [[1, 16], [4, 64], [5, 78], [8, 120], [9, 140]] as const) {
    near(editBarStartSec(m, clipBar + 2), 3 + clipClock.at(clipStep), 1e-9, `clip bar ${clipBar + 1}`);
  }
}
{
  // A pickup of one quarter becomes a 1/4 bar before the clip's bar 1.
  const r = adoptClipTimeMaps(edit0, { ...clip, sourcePickupSteps: 4 });
  if (!r.ok) throw new Error(r.error);
  assert.equal(r.firstBar, 1);
  assert.deepEqual(r.meterMap.slice(0, 2).map((s) => [s.bar, `${s.meter.num}/${s.meter.den}`]), [[0, '1/4'], [1, '4/4']]);
}
{
  // A ramp running into the clip's start holds a tick before it, so every
  // second before the clip stays where it was.
  const ramp: EditTimeMaps = { tempoMap: sanitizeRollTempoMap([{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 60 }], 120), meterMap: edit0.meterMap };
  const anchor = editClock(ramp.tempoMap).at(32); // beat 8, mid-ramp
  const r = adoptClipTimeMaps(ramp, { ...clip, startSec: anchor });
  if (!r.ok) throw new Error(r.error);
  for (const step of [4, 16, 24, 31]) near(editClock(r.tempoMap).at(step), editClock(ramp.tempoMap).at(step), 1e-9, `step ${step} before the clip`);
  near(editClock(r.tempoMap).at(32), anchor, 1e-3, 'the clip start within a tick of the ramp');
}
{
  const trimmed = adoptClipTimeMaps(edit0, { ...clip, startSec: 1, offsetIntoSource: 2 });
  assert.ok(!trimmed.ok && /trimmed past the start/.test(trimmed.error));
  const between = adoptClipTimeMaps(edit0, { ...clip, startSec: 3.03125 }); // 8.25 steps into bar 2
  assert.ok(!between.ok && /between 32nd notes/.test(between.error));
  const same = adoptClipTimeMaps(edit0, { startSec: 4, offsetIntoSource: 0, sourceBpm: 120 });
  assert.ok(same.ok && !same.changes, 'a 4/4 clip at the arrangement tempo on a bar line changes nothing');
}
assert.equal(describeClipTime(clip), '4/4 then 7/8 3+2+2 then 5/4, 72-132 BPM');
assert.equal(describeClipTime({ sourceBpm: 97.333 }), '4/4, 97.33 BPM');

/* ── a movement-sized map stays cheap to draw ────────────────────────── */
{
  // 1200 bars with a meter change on every bar and a tempo change (every other
  // one a ramp) every two bars: far denser than any real score.
  const METERS = [{ num: 7, den: 8, groups: [3, 2, 2] }, { num: 5, den: 4, groups: [] }, { num: 3, den: 4, groups: [] }, { num: 11, den: 16, groups: [3, 3, 3, 2] }];
  const bigMeter: MeterSegment[] = Array.from({ length: 1200 }, (_, bar) => ({ bar, meter: METERS[bar % METERS.length] }));
  const bigTempo = sanitizeRollTempoMap(Array.from({ length: 600 }, (_, i) => ({ beat: i * 6, bpm: 60 + (i % 7) * 20, curve: i % 2 ? 'linear' as const : 'step' as const })), 60);
  const big: EditTimeMaps = { tempoMap: bigTempo, meterMap: bigMeter };
  const end = editBarStartSec(big, 1199);
  // The indexed lookups agree with lib/meterMap's own walk, bar for bar.
  for (let bar = 0; bar < 1300; bar += 7) assert.equal(editBarStartStep(bigMeter, bar), barStartStep(bigMeter, bar), `bar ${bar} start`);
  const bigClock = editClock(bigTempo);
  for (let i = 0; i < 400; i += 1) {
    const step = i * 37.3;
    const mine = editBarAtSec(big, bigClock.at(step));
    const theirs = barAt(bigMeter, bigClock.stepAt(bigClock.at(step)));
    assert.equal(mine.bar, theirs.bar, `the bar holding step ${step}`);
    near(mine.startStep, theirs.start, 1e-9);
  }
  const time = (fn: () => unknown): number => {
    fn(); // warm the clock cache and the JIT
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) fn();
    return (performance.now() - t0) / 5;
  };
  // A zoomed-in window three viewports wide (1920 px each at 100 px/s) in the middle of the song.
  const mid = end / 2;
  const tIn = time(() => editGridLines({ ...big, startSec: mid, endSec: mid + 57.6, zoom: 100 }));
  // The whole movement on screen at once.
  const tOut = time(() => editGridLines({ ...big, startSec: 0, endSec: end, zoom: 5760 / end }));
  const tRuler = time(() => editRulerBars({ ...big, startSec: 0, endSec: end, zoom: 5760 / end }));
  const tFlags = time(() => { editMeterFlags(big, 0, end); editTempoFlags(big, 0, end); });
  const tSnap = time(() => { for (let i = 0; i < 1000; i += 1) editSnapSec(big, (i / 1000) * end, 4); });
  console.log(`  1200-bar map: grid in view ${tIn.toFixed(2)} ms, whole song ${tOut.toFixed(2)} ms, ruler ${tRuler.toFixed(2)} ms, flags ${tFlags.toFixed(2)} ms, 1000 snaps ${tSnap.toFixed(2)} ms`);
  // Generous bounds: a frame is 16 ms, and each of these runs on a scroll or zoom, not per frame.
  for (const [what, ms] of [['grid in view', tIn], ['whole-song grid', tOut], ['ruler', tRuler], ['flags', tFlags], ['1000 snaps', tSnap]] as const) {
    assert.ok(ms < 100, `${what} took ${ms.toFixed(2)} ms`);
  }
}

console.log('editTimeMap: ok');
