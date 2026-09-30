/**
 * Every constant-tempo number below was captured from beatClock BEFORE it was
 * rewired onto `tempoMap.ts` / `meterMap.ts`, and is pinned bit-for-bit
 * (`assert.equal`, not a tolerance). The clock is a module singleton, so the
 * blocks run in order and each one states the tempo/meter/anchor it needs.
 */
import assert from 'node:assert/strict';
import { CLOCK_BPM_MAX, CLOCK_BPM_MIN, CLOCK_LEAD_SEC, beatClock, clampClockBpm, type ClockGrid } from './beatClock.ts';
import type { MeterSegment } from './meterMap.ts';
import { beatToTime, type TempoEvent } from './tempoMap.ts';

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M44 = { num: 4, den: 4, groups: [] };

// Defaults.
{
  assert.equal(CLOCK_LEAD_SEC, 0.01);
  assert.deepEqual(beatClock.state, { bpm: 120, beatsPerBar: 4, anchor: null, source: 'internal' });
  assert.equal(beatClock.bpm, 120);
  assert.equal(beatClock.beatsPerBar, 4);
}

// A cold clock anchors itself on the first nextGrid, so the first launch is
// immediate. This has to run before anything else sets an anchor — nothing can
// put it back to null. It exercises the `anchor == null` branch: it mutates the
// anchor and emits.
{
  assert.equal(beatClock.state.anchor, null);
  const seen: (number | null)[] = [];
  const off = beatClock.subscribe((s) => seen.push(s.anchor));
  // Every grid returns `from` unchanged while cold, not a quantized line.
  assert.equal(beatClock.nextGrid('bar', 42.5), 42.5);
  assert.equal(beatClock.state.anchor, 42.5);
  assert.deepEqual(seen, [42.5], 'the cold-start anchor is emitted');
  // Warm now: the same call quantizes instead of re-anchoring.
  assert.equal(beatClock.nextGrid('bar', 43), 44.5);
  assert.equal(beatClock.state.anchor, 42.5);
  assert.deepEqual(seen, [42.5], 'a warm nextGrid emits nothing');
  assert.deepEqual(beatClock.phase(42.5), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  off();
}

// --- 120 bpm, 4/4, bar 0 at t = 10 -------------------------------------------
beatClock.setAnchor(10, 0);
{
  assert.equal(beatClock.state.anchor, 10);
  assert.equal(beatClock.beatSec(), 0.5);
  assert.equal(beatClock.barSec(), 2);
  const grids: [ClockGrid, number][] = [
    ['now', 0], ['16th', 0.125], ['8th', 0.25], ['beat', 0.5],
    ['half', 1], ['bar', 2], ['2bar', 4], ['4bar', 8],
  ];
  for (const [g, sec] of grids) assert.equal(beatClock.gridSec(g), sec, g);
}

// phase()
{
  const cases: [number, [number, number, number, number, number]][] = [
    [10, [0, 0, 0, 0, 0]],
    [10.25, [0, 0, 2, 0.5, 0.125]],
    [10.5, [0, 1, 0, 0, 0.25]],
    [11, [0, 2, 0, 0, 0.5]],
    [12.75, [1, 1, 2, 0.5, 0.375]],
    [13, [1, 2, 0, 0, 0.5]],
    [20.125, [5, 0, 1, 0.25, 0.0625]],
    [9.5, [0, 0, 0, 0, 0]], // before the anchor, beats clamp at 0
  ];
  for (const [t, [bar, beat, sixteenth, beatFrac, barFrac]] of cases) {
    assert.deepEqual(beatClock.phase(t), { bar, beat, sixteenth, beatFrac, barFrac }, `phase(${t})`);
  }
}

// nextGrid()
{
  const expected: Record<ClockGrid, number[]> = {
    now: [10, 10.3, 12, 14.7],
    '16th': [10, 10.375, 12, 14.75],
    '8th': [10, 10.5, 12, 14.75],
    beat: [10, 10.5, 12, 15],
    half: [10, 11, 12, 15],
    bar: [10, 12, 12, 16],
    '2bar': [10, 14, 14, 18],
    '4bar': [10, 18, 18, 18],
  };
  const from = [10, 10.3, 12, 14.7];
  for (const g of Object.keys(expected) as ClockGrid[]) {
    for (let i = 0; i < from.length; i += 1) {
      assert.equal(beatClock.nextGrid(g, from[i]), expected[g][i], `nextGrid(${g}, ${from[i]})`);
    }
  }
}

// timeOf()
{
  assert.equal(beatClock.timeOf(0, 0, 16), 10);
  assert.equal(beatClock.timeOf(1, 0, 16), 12);
  assert.equal(beatClock.timeOf(2, 4, 16), 14.5);
  assert.equal(beatClock.timeOf(3, 7, 16), 16.875);
  assert.equal(beatClock.timeOf(1, 3, 8), 12.75);
}

// --- setBpm re-anchors so the beat we are on stays the beat we are on --------
{
  beatClock.setBpm(140, 'loom');
  assert.deepEqual(beatClock.state, { bpm: 140, beatsPerBar: 4, anchor: 8.571428571428571, source: 'loom' });
  assert.equal(beatClock.beatSec(), 0.42857142857142855);
  // Same bpm, same source: no re-anchor, no event.
  const anchor = beatClock.state.anchor;
  beatClock.setBpm(140, 'loom');
  assert.equal(beatClock.state.anchor, anchor);
  // The clamp is unchanged: 20..300.
  beatClock.setBpm(1, 'loom');
  assert.equal(beatClock.bpm, 20);
  beatClock.setBpm(9999, 'loom');
  assert.equal(beatClock.bpm, 300);
  beatClock.setBpm(140, 'loom');
}

// --- 140 bpm, 7 beats to the bar (i.e. 7/4), bar 0 at t = 0 ------------------
beatClock.setAnchor(0, 0);
beatClock.setBeatsPerBar(7);
{
  assert.equal(beatClock.beatsPerBar, 7);
  assert.equal(beatClock.barSec(), 3);
  assert.equal(beatClock.gridSec('half'), 1.5);
  assert.equal(beatClock.gridSec('bar'), 3);
  assert.equal(beatClock.gridSec('2bar'), 6);
  assert.equal(beatClock.gridSec('4bar'), 12);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(1), { bar: 0, beat: 2, sixteenth: 1, beatFrac: 0.3333333333333335, barFrac: 0.33333333333333337 });
  assert.deepEqual(beatClock.phase(3.0001), { bar: 1, beat: 0, sixteenth: 0, beatFrac: 0.00023333333333397377, barFrac: 0.00003333333333342482 });
  assert.deepEqual(beatClock.phase(5), { bar: 1, beat: 4, sixteenth: 2, beatFrac: 0.6666666666666679, barFrac: 0.6666666666666669 });
  assert.deepEqual([0, 1, 3.0001, 5].map((t) => beatClock.nextGrid('bar', t)), [0, 3, 6, 6]);
  assert.deepEqual([0, 1, 3.0001, 5].map((t) => beatClock.nextGrid('beat', t)), [0, 1.2857142857142856, 3.4285714285714284, 5.142857142857142]);
  assert.equal(beatClock.timeOf(2, 8, 16), 7.5);
  // setBeatsPerBar still clamps to 1..16 whole beats.
  beatClock.setBeatsPerBar(0);
  assert.equal(beatClock.beatsPerBar, 1);
  beatClock.setBeatsPerBar(99);
  assert.equal(beatClock.beatsPerBar, 16);
  beatClock.setBeatsPerBar(7);
}

// --- setAnchor with a bar offset ---------------------------------------------
{
  beatClock.setAnchor(0, 0);
  beatClock.setBpm(90, 'loom');
  assert.equal(beatClock.state.anchor, 0);
  beatClock.setAnchor(5, 2);
  assert.equal(beatClock.state.anchor, -4.333333333333332);
}

// --- the meter map: a bar is 7/8, not 7 quarter notes ------------------------
{
  beatClock.setBpm(120, 'loom');
  beatClock.setMeterMap([{ bar: 0, meter: M78 }]);
  beatClock.setAnchor(0, 0);
  // 7/8 is 3.5 quarter notes, so at 120 bpm a bar is 1.75 s — NOT 3.5 s.
  assert.equal(beatClock.beatsPerBar, 3.5);
  assert.equal(beatClock.beatsPerBarAt(0), 3.5);
  assert.equal(beatClock.barSec(), 1.75);
  assert.equal(beatClock.gridSec('bar'), 1.75);
  assert.equal(beatClock.gridSec('2bar'), 3.5);
  assert.equal(beatClock.gridSec('half'), 0.875);
  // The sub-beat grids are quarter-note subdivisions in every meter.
  assert.equal(beatClock.gridSec('beat'), 0.5);
  assert.equal(beatClock.gridSec('16th'), 0.125);
  assert.deepEqual([0, 0.1, 1.75, 1.8, 5].map((t) => beatClock.nextGrid('bar', t)), [0, 1.75, 1.75, 3.5, 5.25]);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(1.75), { bar: 1, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(2.25), { bar: 1, beat: 1, sixteenth: 0, beatFrac: 0, barFrac: 1 / 3.5 });
  assert.equal(beatClock.timeOf(2, 0, 16), 3.5);
  assert.equal(beatClock.timeOf(2, 8, 16), 4.375);
}

// --- a meter change mid-song: bar lines stop being evenly spaced -------------
{
  const MAP: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }];
  beatClock.setMeterMap(MAP);
  beatClock.setAnchor(0, 0);
  assert.equal(beatClock.beatsPerBar, 4);
  assert.equal(beatClock.beatsPerBarAt(2), 3.5);
  assert.equal(beatClock.beatsPerBarAt(4), 4);
  // 120 bpm: bars start at beats 0, 4, 8, 11.5, 15, 19 -> seconds 0, 2, 4, 5.75, 7.5, 9.5.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((b) => beatClock.timeOf(b)), [0, 2, 4, 5.75, 7.5, 9.5]);
  // A step into a bar is a fraction of THAT bar: half of a 7/8 bar is 0.875 s
  // at 120 bpm, not half of a 4/4 bar (1 s).
  assert.equal(beatClock.timeOf(2, 8, 16), 4.875);
  assert.equal(beatClock.timeOf(3, 4, 16), 6.1875);
  assert.equal(beatClock.timeOf(1, 8, 16), 3); // still a 4/4 bar
  assert.equal(beatClock.timeOf(4, 8, 16), 8.5); // 4/4 again after the change
  assert.deepEqual([0, 0.1, 4, 4.1, 5.75, 6, 7.6].map((t) => beatClock.nextGrid('bar', t)), [0, 2, 4, 5.75, 5.75, 7.5, 9.5]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('2bar', t)), [4, 7.5]);
  assert.deepEqual([0.1, 4.1, 5.8].map((t) => beatClock.nextGrid('half', t)), [1, 4.875, 6.625]);
  // Sub-beat grids are still uniform.
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('beat', t)), [0.5, 4.5]);
  assert.equal(beatClock.phase(4).bar, 2);
  assert.equal(beatClock.phase(5.75).bar, 3);
  assert.equal(beatClock.phase(7.5).bar, 4);
  assert.deepEqual(beatClock.meterMap, MAP);
}

// --- subscribers get every change, and an unsubscribed one gets none --------
{
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  const seen: number[] = [];
  const off = beatClock.subscribe((s) => seen.push(s.bpm));
  beatClock.setBpm(128, 'edit');
  assert.deepEqual(seen, [128]);
  off();
  beatClock.setBpm(120, 'edit');
  assert.deepEqual(seen, [128]);
}

/* ===================== the clock holds a tempo MAP ======================== */

// The app's one tempo clamp, exported so the store reuses it instead of
// inventing a third range. The numbers are the ones `setBpm` has always had.
{
  assert.equal(CLOCK_BPM_MIN, 20);
  assert.equal(CLOCK_BPM_MAX, 300);
  assert.equal(clampClockBpm(1), 20);
  assert.equal(clampClockBpm(9999), 300);
  assert.equal(clampClockBpm(128.5), 128.5);
}

// --- a tempo CHANGE: 120 until beat 8, then 60, 4/4, bar 0 at t = 0 ---------
{
  const MAP: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }];
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  beatClock.setTempoMap(MAP);
  beatClock.setAnchor(0, 0);
  assert.deepEqual(beatClock.tempoMap, MAP);
  // The scalar reports where the map STARTS; it cannot say more than that.
  assert.equal(beatClock.bpm, 120);
  assert.equal(beatClock.beatSec(), 0.5);
  // Bars start at beats 0, 4, 8, 12, 16 -> 0, 2, 4, 8, 12 s (4 s of 120 bpm,
  // then 1 s a beat). The old scalar closed form would say 0, 2, 4, 6, 8.
  assert.deepEqual([0, 1, 2, 3, 4].map((b) => beatClock.timeOf(b)), [0, 2, 4, 8, 12]);
  // A step INTO a bar is a fraction of the bar's beats, converted — not a
  // fraction of a bar length computed at the starting tempo.
  assert.equal(beatClock.timeOf(2, 8, 16), 6);
  assert.equal(beatClock.timeOf(1, 8, 16), 3); // still inside the 120 bpm run
  // nextGrid walks the map: bar 3 is at 8 s, not at the 6 s even spacing.
  assert.deepEqual([0, 0.1, 4, 4.1, 8].map((t) => beatClock.nextGrid('bar', t)), [0, 2, 4, 8, 8]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('2bar', t)), [4, 12]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('half', t)), [1, 6]);
  // ... and so do the sub-beat grids, which used to be uniform in seconds.
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('beat', t)), [0.5, 5]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('8th', t)), [0.25, 4.5]);
  assert.deepEqual([0.1, 4.1].map((t) => beatClock.nextGrid('16th', t)), [0.125, 4.25]);
  assert.equal(beatClock.nextGrid('now', 4.1), 4.1);
  // phase reads through the map too: 6 s is beat 10, i.e. bar 2 beat 2.
  assert.deepEqual(beatClock.phase(6), { bar: 2, beat: 2, sixteenth: 0, beatFrac: 0, barFrac: 0.5 });
  assert.deepEqual(beatClock.phase(4), { bar: 2, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
}

// --- a RAMP: 60 bpm rising linearly to 120 over 16 beats --------------------
{
  const RAMP: TempoEvent[] = [{ beat: 0, bpm: 60, curve: 'linear' }, { beat: 16, bpm: 120 }];
  beatClock.setTempoMap(RAMP);
  beatClock.setAnchor(0, 0);
  const at = (beat: number): number => beatToTime(RAMP, beat);
  // Every grid line is the seconds of a grid BEAT under the ramp — the whole
  // point of the map reaching nextGrid.
  for (const [grid, unit] of [['bar', 4], ['2bar', 8], ['half', 2], ['beat', 1], ['8th', 0.5], ['16th', 0.25]] as const) {
    for (const beat of [0.5, 3.9, 7, 15.5, 20]) {
      const t = at(beat);
      const line = beatClock.nextGrid(grid, t);
      const n = Math.ceil(beat / unit - 1e-9);
      assert.ok(Math.abs(line - at(n * unit)) < 1e-9, `nextGrid(${grid}) at beat ${beat}: ${line} !~ ${at(n * unit)}`);
      assert.ok(line >= t - 1e-9, `nextGrid(${grid}) must not land in the past`);
    }
  }
  // A ramp is slower at the start, so the first bar takes longer than the last:
  // the lines are NOT evenly spaced, which the scalar form could never produce.
  const bars = [0, 1, 2, 3, 4].map((b) => beatClock.timeOf(b));
  const gaps = bars.slice(1).map((s, i) => s - bars[i]);
  for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] < gaps[i - 1], 'a rising ramp shortens every bar');
  assert.equal(bars[0], 0);
  assert.ok(Math.abs(bars[4] - at(16)) < 1e-12);
  // phase runs forward through it without a jump.
  let prevBar = -1;
  for (let i = 0; i <= 200; i += 1) {
    const p = beatClock.phase((i / 200) * at(16));
    assert.ok(p.bar >= prevBar && p.bar <= 4, `bar must not go backwards: ${p.bar} after ${prevBar}`);
    assert.ok(p.beatFrac >= 0 && p.barFrac >= 0);
    prevBar = p.bar;
  }
}

// --- clamping, empty maps, and collapsing back to a constant tempo ----------
{
  // Every event is clamped to the clock's range, and only the events that
  // needed it are rewritten (the caller's array is never mutated).
  const wild: TempoEvent[] = [{ beat: 0, bpm: 9999 }, { beat: 8, bpm: 1 }, { beat: 16, bpm: 174 }];
  beatClock.setTempoMap(wild);
  assert.deepEqual(beatClock.tempoMap.map((e) => e.bpm), [300, 20, 174]);
  assert.deepEqual(wild.map((e) => e.bpm), [9999, 1, 174], 'the input array is left alone');
  assert.equal(beatClock.bpm, 300);
  // An already-legal map is stored by identity, so `tempoMap.ts`'s cache hits
  // and pushing the SAME array again is a true no-op: no re-anchor, and — the
  // part a subscriber can see — no event. `tempoStore` pushes on every store
  // change, so a store edit that left the map alone must not wake the app.
  const legal: TempoEvent[] = [{ beat: 0, bpm: 90 }, { beat: 16, bpm: 140 }];
  beatClock.setTempoMap(legal);
  assert.equal(beatClock.bpm, 90);
  let emits = 0;
  const offNoop = beatClock.subscribe(() => { emits += 1; });
  const anchor = beatClock.state.anchor;
  for (let i = 0; i < 5; i += 1) beatClock.setTempoMap(legal);
  assert.equal(emits, 0, 'the same array five times emits nothing');
  assert.equal(beatClock.state.anchor, anchor, 'and does not re-anchor');
  // A DIFFERENT array with the same content is a real install (identity is all
  // the clock can cheaply know), so it emits exactly once per call.
  beatClock.setTempoMap([...legal]);
  assert.equal(emits, 1);
  beatClock.setTempoMap([{ beat: 0, bpm: 128 }]);
  assert.equal(emits, 2);
  // setBpm's own no-op survives: one event, the same bpm, and the same source
  // (the block above left it on 'edit'), so there is nothing to do.
  assert.equal(beatClock.state.source, 'edit');
  beatClock.setBpm(128, 'edit');
  assert.equal(emits, 2, 'same bpm, same source, one event: nothing happens');
  // A MULTI-event map collapses even at the same starting tempo, though —
  // `setBpm` means constant tempo, and the map is not.
  beatClock.setTempoMap([{ beat: 0, bpm: 128 }, { beat: 8, bpm: 90 }]);
  assert.equal(emits, 3);
  beatClock.setBpm(128, 'edit');
  assert.equal(emits, 4, 'the map collapses back to one event');
  assert.equal(beatClock.tempoMap.length, 1);
  offNoop();
  beatClock.setTempoMap(legal);
  assert.equal(emits, 4, 'an unsubscribed listener hears nothing');
  // An empty or missing map leaves the tempo where it is, as one event.
  beatClock.setTempoMap([]);
  assert.deepEqual(beatClock.tempoMap, [{ beat: 0, bpm: 90 }]);
  beatClock.setTempoMap(legal);
  beatClock.setTempoMap(null);
  assert.equal(beatClock.bpm, 90);
  // setBpm is the constant-tempo shorthand: it replaces the whole map, even
  // when the bpm it is handed is the one already showing.
  beatClock.setTempoMap(legal);
  assert.equal(beatClock.tempoMap.length, 2);
  beatClock.setBpm(90, 'edit');
  assert.deepEqual(beatClock.tempoMap, [{ beat: 0, bpm: 90 }]);
  assert.equal(beatClock.bpm, 90);
}

// --- the clock's map carries NO authoritative seconds -----------------------
// A single event that pinned beat 4 at 10 s would put beat 0 at 8 s, and then
// `nextGrid`'s constant-tempo closed form (which measures from the anchor)
// would disagree with `timeOf` / `phase` (which measure through the map) by a
// constant 8 s. The clock is a live phase, not a score: it rebases.
{
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  beatClock.setTempoMap([{ beat: 4, bpm: 120, timeSec: 10 }]);
  beatClock.setAnchor(0, 0);
  assert.deepEqual(beatClock.tempoMap, [{ beat: 4, bpm: 120 }], 'the seconds are dropped on the way in');
  assert.equal(beatClock.bpm, 120);
  // Beat 0 is at the anchor, so all three agree.
  assert.equal(beatClock.timeOf(0), 0);
  assert.equal(beatClock.timeOf(1), 2);
  assert.equal(beatClock.nextGrid('bar', 0.1), 2);
  assert.equal(beatClock.nextGrid('beat', 0.1), 0.5);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.deepEqual(beatClock.phase(2), { bar: 1, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  // Every grid line agrees with the map it was quantized against.
  for (const t of [0, 0.1, 1.9, 2, 5.5]) {
    assert.equal(beatClock.nextGrid('bar', t), beatClock.timeOf(Math.ceil(t / 2 - 1e-9)), `bar line at ${t}`);
  }
  // The same is true of a MULTI-event map: seconds are dropped from every event.
  beatClock.setTempoMap([{ beat: 0, bpm: 120, timeSec: 99 }, { beat: 8, bpm: 60, timeSec: 199 }]);
  beatClock.setAnchor(0, 0);
  assert.deepEqual(beatClock.tempoMap, [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]);
  assert.deepEqual([0, 1, 2, 3].map((b) => beatClock.timeOf(b)), [0, 2, 4, 8]);
  // A curve survives the rewrite even though the seconds do not.
  beatClock.setTempoMap([{ beat: 0, bpm: 60, curve: 'linear', timeSec: 5 }, { beat: 16, bpm: 120 }]);
  assert.deepEqual(beatClock.tempoMap, [{ beat: 0, bpm: 60, curve: 'linear' }, { beat: 16, bpm: 120 }]);
  assert.equal(beatClock.timeOf(0), beatClock.state.anchor);
}

// --- timeOf INTO a bar under a ramp, and under a changing meter as well -----
{
  const RAMP: TempoEvent[] = [{ beat: 0, bpm: 60, curve: 'linear' }, { beat: 16, bpm: 120 }];
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  beatClock.setTempoMap(RAMP);
  beatClock.setAnchor(0, 0);
  // A step into the bar is a fraction of its BEATS, converted through the ramp
  // — not a fraction of a bar length computed at the starting tempo, which is
  // what the closed form would have said (and is 0.5 s longer here).
  assert.equal(beatClock.timeOf(1, 8, 16), beatToTime(RAMP, 6));
  assert.equal(beatClock.timeOf(2, 4, 16), beatToTime(RAMP, 9));
  assert.equal(beatClock.timeOf(3, 12, 8), beatToTime(RAMP, 12 + 6)); // 12 of 8 steps = 1.5 bars on
  assert.notEqual(beatClock.timeOf(1, 8, 16), beatClock.timeOf(1) + 0.5 * beatClock.barSec(1));
  // Zero steps is still the bar line itself, on the same path as before.
  assert.equal(beatClock.timeOf(2, 0, 16), beatToTime(RAMP, 8));

  // ... and with a meter map that CHANGES as well: 4/4, 7/8 at bar 2, 4/4 at
  // bar 4 -> bars start at beats 0, 4, 8, 11.5, 15, 19. Both maps are read at
  // once: the bar line comes from the meter, its seconds from the ramp.
  const BARS = [0, 4, 8, 11.5, 15, 19];
  beatClock.setMeterMap([{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }]);
  beatClock.setAnchor(0, 0);
  assert.deepEqual(BARS.map((_, b) => beatClock.timeOf(b)), BARS.map((beat) => beatToTime(RAMP, beat)));
  // Half of a 7/8 bar is 1.75 quarter notes, and those are ramped too.
  assert.equal(beatClock.timeOf(2, 8, 16), beatToTime(RAMP, 8 + 1.75));
  assert.equal(beatClock.timeOf(4, 8, 16), beatToTime(RAMP, 15 + 2)); // 4/4 again
  // nextGrid walks the same uneven bar lines. Ask from the MIDDLE of each bar:
  // `nextBarLine` snaps anything within ~1e-6 of a line onto it, so a query a
  // microsecond past a bar line would legitimately return that line again.
  for (let b = 1; b < BARS.length; b += 1) {
    const mid = beatToTime(RAMP, (BARS[b - 1] + BARS[b]) / 2);
    assert.equal(beatClock.nextGrid('bar', mid), beatToTime(RAMP, BARS[b]), `bar ${b}`);
  }
  // The bars are neither equal in beats nor equal in seconds: the two maps are
  // both really being read, and a ramp keeps shortening what the meter sets.
  const secs = BARS.map((beat) => beatToTime(RAMP, beat));
  const gaps = secs.slice(1).map((s, i) => s - secs[i]);
  assert.ok(gaps[1] < gaps[0], 'same meter, faster ramp: bar 1 is shorter than bar 0');
  assert.ok(gaps[2] < gaps[1], 'the 7/8 bar is shorter again — fewer beats AND faster');
  assert.ok(gaps[3] < gaps[2], 'two 7/8 bars, same beats: only the ramp separates them');
  // Back in 4/4 the bar grows despite the faster tempo, because it is half a
  // beat longer. If the meter were being ignored this would shrink.
  assert.ok(gaps[4] > gaps[3], 'the 4/4 bar after the change is longer than the 7/8 before it');
}

// --- installing a map preserves the phase, exactly as setBpm does -----------
{
  beatClock.setMeterMap([{ bar: 0, meter: M44 }]);
  beatClock.setBpm(120, 'edit');
  beatClock.setAnchor(0, 0);
  // now() is 0 with no AudioContext, so the clock is 0 beats in; re-anchoring
  // must keep it there whatever map arrives.
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  beatClock.setTempoMap([{ beat: 0, bpm: 174 }, { beat: 8, bpm: 60 }]);
  assert.deepEqual(beatClock.phase(0), { bar: 0, beat: 0, sixteenth: 0, beatFrac: 0, barFrac: 0 });
  assert.equal(beatClock.state.anchor, 0);
  // A subscriber hears the map land, just as it hears a bpm change.
  const seen: number[] = [];
  const off = beatClock.subscribe((s) => seen.push(s.bpm));
  beatClock.setTempoMap([{ beat: 0, bpm: 128 }, { beat: 8, bpm: 96 }]);
  assert.deepEqual(seen, [128]);
  off();
  beatClock.setBpm(120, 'edit');
  assert.deepEqual(seen, [128]);
  assert.equal(beatClock.bpm, 120);
}

console.log('beatClock: ok');
