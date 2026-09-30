import assert from 'node:assert/strict';
import { gridLines, type GridLine } from './gridLines';

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const secs = (ls: GridLine[], level?: GridLine['level']): number[] =>
  ls.filter((l) => level === undefined || l.level === level).map((l) => l.sec);

// 120 bpm 4/4, 4 subs per beat, at a zoom where every tier fits:
// beat = 0.5 s, bar = 2 s, sub = 0.125 s. zoom 100 px/s puts subs 12.5 px apart.
{
  const ls = gridLines({ startSec: 0, endSec: 4, bpm: 120, zoom: 100 });
  // 0..4 s inclusive at 0.125 s steps -> 33 lines, one per position.
  assert.equal(ls.length, 33);
  assert.deepEqual(secs(ls, 'bar'), [0, 2, 4]);
  assert.deepEqual(secs(ls, 'beat'), [0.5, 1, 1.5, 2.5, 3, 3.5]);
  assert.equal(secs(ls, 'sub').length, 24);
  assert.ok(near(secs(ls, 'sub')[0], 0.125));
  // Sorted, and unique positions (the highest level wins where tiers coincide).
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i].sec > ls[i - 1].sec);
  // barIndex names the bar each line sits in.
  assert.equal(ls.find((l) => near(l.sec, 0))?.barIndex, 0);
  assert.equal(ls.find((l) => near(l.sec, 1.875))?.barIndex, 0);
  assert.equal(ls.find((l) => near(l.sec, 2))?.barIndex, 1);
  assert.equal(ls.find((l) => near(l.sec, 3.5))?.barIndex, 1);
  assert.equal(ls.find((l) => near(l.sec, 4))?.barIndex, 2);
}

// Bars every 2 s at 120 bpm 4/4, over a longer window.
{
  const ls = gridLines({ startSec: 0, endSec: 20, bpm: 120, zoom: 100 });
  const bars = ls.filter((l) => l.level === 'bar');
  assert.deepEqual(bars.map((l) => l.sec), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.deepEqual(bars.map((l) => l.barIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

// Custom meter and subdivision: 3 beats per bar, 2 subs per beat at 60 bpm.
{
  const ls = gridLines({ startSec: 0, endSec: 3, bpm: 60, beatsPerBar: 3, subdivisionsPerBeat: 2, zoom: 100 });
  assert.deepEqual(secs(ls, 'bar'), [0, 3]);
  assert.deepEqual(secs(ls, 'beat'), [1, 2]);
  assert.deepEqual(secs(ls, 'sub'), [0.5, 1.5, 2.5]);
}

// Level suppression thresholds (default minSpacingPx 6).
{
  // sub = 0.125 s. zoom 48 -> 6 px exactly: kept. zoom 47 -> 5.875 px: dropped.
  assert.ok(gridLines({ startSec: 0, endSec: 2, bpm: 120, zoom: 48 }).some((l) => l.level === 'sub'));
  const noSub = gridLines({ startSec: 0, endSec: 2, bpm: 120, zoom: 47 });
  assert.ok(!noSub.some((l) => l.level === 'sub'));
  assert.deepEqual(secs(noSub, 'beat'), [0.5, 1, 1.5]);
  assert.deepEqual(secs(noSub, 'bar'), [0, 2]);

  // beat = 0.5 s. zoom 12 -> 6 px: kept. zoom 11 -> 5.5 px: dropped, bars stay.
  assert.ok(gridLines({ startSec: 0, endSec: 4, bpm: 120, zoom: 12 }).some((l) => l.level === 'beat'));
  const barsOnly = gridLines({ startSec: 0, endSec: 4, bpm: 120, zoom: 11 });
  assert.ok(barsOnly.every((l) => l.level === 'bar'));
  assert.deepEqual(secs(barsOnly), [0, 2, 4]);

  // A custom minSpacingPx moves the thresholds.
  assert.ok(!gridLines({ startSec: 0, endSec: 2, bpm: 120, zoom: 100, minSpacingPx: 13 }).some((l) => l.level === 'sub'));
  assert.ok(gridLines({ startSec: 0, endSec: 2, bpm: 120, zoom: 100, minSpacingPx: 12 }).some((l) => l.level === 'sub'));
}

// 2^k bar thinning: bar = 2 s at 120 bpm.
{
  // zoom 3 -> bars 6 px apart: every bar (k = 0).
  assert.deepEqual(secs(gridLines({ startSec: 0, endSec: 8, bpm: 120, zoom: 3 })), [0, 2, 4, 6, 8]);
  // zoom 2 -> bars 4 px apart; 2 bars = 8 px fits: every 2nd bar (k = 1).
  const k1 = gridLines({ startSec: 0, endSec: 16, bpm: 120, zoom: 2 });
  assert.deepEqual(secs(k1), [0, 4, 8, 12, 16]);
  assert.deepEqual(k1.map((l) => l.barIndex), [0, 2, 4, 6, 8]);
  assert.ok(k1.every((l) => l.level === 'bar'));
  // zoom 0.5 -> bars 1 px apart; 4 bars = 4 px is short, 8 bars = 8 px fits (k = 3).
  const k3 = gridLines({ startSec: 0, endSec: 64, bpm: 120, zoom: 0.5 });
  assert.deepEqual(secs(k3), [0, 16, 32, 48, 64]);
  assert.deepEqual(k3.map((l) => l.barIndex), [0, 8, 16, 24, 32]);
  // Thinned bars stay anchored to bar 0, whatever the window start.
  assert.deepEqual(secs(gridLines({ startSec: 1, endSec: 20, bpm: 120, zoom: 2 })), [4, 8, 12, 16, 20]);
}

// Window clipping: only lines inside [startSec, endSec], both ends inclusive.
{
  const ls = gridLines({ startSec: 1.9, endSec: 2.6, bpm: 120, zoom: 100 });
  assert.deepEqual(secs(ls), [2, 2.125, 2.25, 2.375, 2.5]);
  assert.equal(ls[0].level, 'bar');
  assert.equal(ls[0].barIndex, 1);
  // Window between two lines -> nothing.
  assert.deepEqual(gridLines({ startSec: 2.01, endSec: 2.1, bpm: 120, zoom: 100 }), []);
  // Zero-width window on a line -> that line.
  assert.deepEqual(gridLines({ startSec: 2, endSec: 2, bpm: 120, zoom: 100 }), [{ sec: 2, level: 'bar', barIndex: 1 }]);
  // Float-rounded bounds still include the line they sit on.
  assert.deepEqual(secs(gridLines({ startSec: 0.1 + 0.2 + 1.7, endSec: 2, bpm: 120, zoom: 100 })), [2]);
}

// Guards.
{
  const base = { startSec: 0, endSec: 10, bpm: 120, zoom: 100 };
  assert.throws(() => gridLines({ ...base, bpm: 0.5 }), RangeError);
  assert.throws(() => gridLines({ ...base, bpm: 1000 }), RangeError);
  assert.throws(() => gridLines({ ...base, bpm: Number.NaN }), RangeError);
  assert.doesNotThrow(() => gridLines({ ...base, bpm: 1 }));
  assert.doesNotThrow(() => gridLines({ ...base, bpm: 999, zoom: 1 }));
  assert.throws(() => gridLines({ ...base, zoom: 0 }), RangeError);
  assert.throws(() => gridLines({ ...base, zoom: -5 }), RangeError);
  assert.throws(() => gridLines({ ...base, zoom: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => gridLines({ ...base, startSec: 5, endSec: 4 }), RangeError);
  assert.throws(() => gridLines({ ...base, startSec: Number.NaN }), RangeError);
  assert.throws(() => gridLines({ ...base, endSec: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => gridLines({ ...base, beatsPerBar: 0 }), RangeError);
  assert.throws(() => gridLines({ ...base, beatsPerBar: 2.5 }), RangeError);
  assert.throws(() => gridLines({ ...base, subdivisionsPerBeat: 0 }), RangeError);
  assert.throws(() => gridLines({ ...base, subdivisionsPerBeat: 1.5 }), RangeError);
  assert.throws(() => gridLines({ ...base, minSpacingPx: -1 }), RangeError);
  assert.throws(() => gridLines({ ...base, minSpacingPx: Number.NaN }), RangeError);
}

// Output cap: 5000 lines is allowed, 5001 throws (the caller must window).
{
  // 120 bpm, 4 subs, zoom 100: one line per 0.125 s. [0, 624.875] -> exactly 5000 lines.
  assert.equal(gridLines({ startSec: 0, endSec: 624.875, bpm: 120, zoom: 100 }).length, 5000);
  assert.throws(() => gridLines({ startSec: 0, endSec: 625, bpm: 120, zoom: 100 }), RangeError);
  // Suppression reduces the count, so a coarse zoom over the same span is fine.
  assert.doesNotThrow(() => gridLines({ startSec: 0, endSec: 625, bpm: 120, zoom: 1 }));
}

console.log('gridLines: ok');
