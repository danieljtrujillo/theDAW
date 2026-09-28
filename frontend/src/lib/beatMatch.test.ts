import assert from 'node:assert/strict';
import { alignedStart, alignedStartOn, beatMatchPlan, firstBeatInClip, stretchRatio } from './beatMatch';
import { editMoveByBeats, editSnapSec } from './editTimeMap';
import { sanitizeRollTempoMap } from './rollTempo';

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} != ${b}`);
};

// Plain ratio.
close(stretchRatio(120, 126), 1.05);
close(stretchRatio(126, 120), 120 / 126);

// A half-time or double-time reading is matched at the octave nearest unity.
close(stretchRatio(85, 170), 1);
close(stretchRatio(170, 85), 1);
close(stretchRatio(90, 170), 170 / 180);
close(stretchRatio(140, 75), 150 / 140);

// Bounds and bad input.
assert.equal(stretchRatio(0, 120), 1);
assert.equal(stretchRatio(120, 0), 1);
assert.equal(stretchRatio(10, 120), 4);

// The plan skips unknown tempos and clips already at the target.
const plan = beatMatchPlan(
  [
    { id: 'a', bpm: 120 },
    { id: 'b', bpm: null },
    { id: 'c', bpm: 128 },
    { id: 'd', bpm: 64 },
  ],
  128,
);
assert.deepEqual(plan.map((s) => s.id), ['a']);
close(plan[0].tempo, 128 / 120);
close(plan[0].bpm, 128);
assert.deepEqual(beatMatchPlan([{ id: 'a', bpm: 120 }], 0), []);

// First beat inside the played region, scaled by the stretch.
assert.equal(firstBeatInClip(null, 0, 10), null);
assert.equal(firstBeatInClip([], 0, 10), null);
close(firstBeatInClip([0.5, 1.0, 1.5], 0, 10), 0.5);
close(firstBeatInClip([0.5, 1.0, 1.5], 0.7, 10), 0.3);
close(firstBeatInClip([0.5, 1.0, 1.5], 0.7, 10, 2), 0.15);
assert.equal(firstBeatInClip([0.5, 1.0], 2, 10), null);

// The start moves so the first beat lands on the nearest grid line.
const beat = 0.5; // 120 bpm
close(alignedStart(1.1, 0.2, beat), 1.3);
close(alignedStart(1.4, 0.2, beat), 1.3);
close(alignedStart(0.05, 0.2, beat), 0.3);
close(alignedStart(3, null, beat), 3);
// Never before 0: a beat 0.45s in at start 0 goes to the 0.5 line.
close(alignedStart(0, 0.45, beat), 0.05);

// On the arrangement's grid through a tempo map: 120 BPM for 8 beats (4 s),
// then 60, so beats after 4 s are a second apart. A clip whose first beat is
// 0.3 s in, starting at 5.4 s, lands that beat on the 6 s line (not on a 0.5 s
// grid line), and one near 0 is pushed to the first line it can reach.
{
  const maps = {
    tempoMap: sanitizeRollTempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }], 120),
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  };
  const near = (sec: number) => editSnapSec(maps, sec, 4);
  const after = (line: number) => editMoveByBeats(maps, line, 1);
  close(alignedStartOn(5.4, 0.3, near, after), 5.7);
  close(alignedStartOn(3.1, 0.3, near, after), 3.2);
  close(alignedStartOn(0, 0.45, near, after), 0.05);
  close(alignedStartOn(2, null, near, after), 2);
}

console.log('beatMatch: ok');
