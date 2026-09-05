// Run with: npx tsx src/components/layout/score/playAlong/latencyMath.test.ts
import assert from 'node:assert/strict';
import {
  CALIBRATION_CLICKS,
  CALIBRATION_PERIOD_SEC,
  clickTimes,
  estimateOffsetMs,
  median,
  nearestClickIndex,
  spread,
  TAP_WINDOW_SEC,
  tapDelta,
} from './latencyMath.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// clickTimes: 12 clicks, 0.6 s apart, starting at t0.
{
  const clicks = clickTimes(10);
  assert.equal(clicks.length, CALIBRATION_CLICKS);
  near(clicks[0], 10);
  near(clicks[1], 10 + CALIBRATION_PERIOD_SEC);
  near(clicks[11], 10 + 11 * CALIBRATION_PERIOD_SEC);
  assert.deepEqual(clickTimes(0, 0), []);
  assert.deepEqual(clickTimes(1, 3, 1), [1, 2, 3]);
}

// nearestClickIndex: binary search with the earlier click winning a tie.
{
  const clicks = [0, 1, 2, 3];
  assert.equal(nearestClickIndex(clicks, -5), 0);
  assert.equal(nearestClickIndex(clicks, 0.4), 0);
  assert.equal(nearestClickIndex(clicks, 0.6), 1);
  assert.equal(nearestClickIndex(clicks, 0.5), 0); // tie -> earlier
  assert.equal(nearestClickIndex(clicks, 2.9), 3);
  assert.equal(nearestClickIndex(clicks, 99), 3);
  assert.equal(nearestClickIndex([], 1), -1);
  assert.equal(nearestClickIndex(clicks, Number.NaN), -1);
}

// tapDelta: signed distance to the nearest click, null beyond the tap window
// (0.2 s by default: an off-beat key press is not a tap).
{
  const clicks = clickTimes(0);
  assert.equal(TAP_WINDOW_SEC, 0.2);
  near(tapDelta(clicks, 0.05)!, 0.05);
  near(tapDelta(clicks, 0.6 - 0.02)!, -0.02);
  near(tapDelta(clicks, 6.6 + 0.1)!, 0.1);
  near(tapDelta(clicks, 0.19)!, 0.19);
  assert.equal(tapDelta(clicks, 0.21), null); // 0.21 from click 0, 0.39 from click 0.6
  assert.equal(tapDelta(clicks, 0.31), null); // 0.29 from click 0.6: still off-beat
  assert.equal(tapDelta(clicks, 6.6 + 0.25), null); // after the last click
  assert.equal(tapDelta(clicks, -0.25), null); // before the first
  assert.equal(tapDelta([], 1), null);
  near(tapDelta(clicks, 0.31, 0.4)!, -0.29); // wider window accepts it
}

// median / spread.
{
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([3]), 3);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, Number.NaN, 3]), 2);
  assert.equal(spread([]), 0);
  assert.equal(spread([2]), 0);
  assert.equal(spread([2, 5, 1]), 4);
}

// estimateOffsetMs: median of the last N minus the output latency, in ms.
{
  assert.equal(estimateOffsetMs([], 0.01), null);
  const e1 = estimateOffsetMs([0.05], 0.01)!;
  near(e1.ms, 40);
  assert.equal(e1.spreadMs, 0);
  assert.equal(e1.count, 1);

  // 12 taps, the last 8 are 0.03 +- 0.005; the first 4 are outliers and must
  // not count.
  const deltas = [0.5, -0.4, 0.3, 0.25, 0.03, 0.035, 0.025, 0.03, 0.03, 0.035, 0.025, 0.03];
  const e2 = estimateOffsetMs(deltas, 0.02)!;
  assert.equal(e2.count, 8);
  near(e2.ms, (0.03 - 0.02) * 1000, 1e-6);
  near(e2.spreadMs, 10, 1e-6);

  // A non-finite latency counts as zero.
  const e3 = estimateOffsetMs([0.03], Number.NaN)!;
  near(e3.ms, 30);

  // Negative offsets (taps ahead of the click) are allowed.
  const e4 = estimateOffsetMs([-0.02, -0.02, -0.02], 0)!;
  near(e4.ms, -20);

  // lastN below 1 is treated as 1.
  const e5 = estimateOffsetMs([0.1, 0.2], 0, 0)!;
  assert.equal(e5.count, 1);
  near(e5.ms, 200);
}

console.log('latencyMath tests passed');
