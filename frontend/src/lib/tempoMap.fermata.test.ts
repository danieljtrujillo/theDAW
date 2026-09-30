/**
 * Fermatas in the tempo map (lib/tempoMap): a hold divides the tempo under it,
 * moves everything after it later by exactly the time it adds, and leaves
 * everything before it where it was; the inverse still inverts, and a hold on
 * a ramp keeps the ramp's shape. Run from `frontend/`:
 *   npx tsx src/lib/tempoMap.fermata.test.ts
 */
import assert from 'node:assert/strict';
import {
  TEMPO_BPM_MAX,
  TEMPO_BPM_MIN,
  beatToTime,
  clampTempoBpm,
  getTempoAtBeat,
  normalizeTempoMap,
  timeToBeat,
  type TempoEvent,
} from './tempoMap.ts';

const near = (a: number, b: number, eps = 1e-9, msg?: string): void =>
  assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} !~ ${b}`);

// The app's one tempo range lives here, and clamps to it.
{
  assert.equal(TEMPO_BPM_MIN, 20);
  assert.equal(TEMPO_BPM_MAX, 300);
  assert.equal(clampTempoBpm(10), 20);
  assert.equal(clampTempoBpm(97.3), 97.3);
  assert.equal(clampTempoBpm(420), 300);
}

// A fermata on beat 8 held for 2 beats at x2, at 60 bpm (a beat a second):
// beats before 8 do not move, the held beats take two seconds each, and every
// beat after the hold lands 2 seconds later than it would without it.
{
  const plain: TempoEvent[] = [{ beat: 0, bpm: 60 }];
  const held: TempoEvent[] = [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 0, fermata: { beats: 2, stretch: 2 } }];
  for (const b of [0, 3.5, 8]) assert.equal(beatToTime(held, b), beatToTime(plain, b), `beat ${b} is before the hold`);
  near(beatToTime(held, 9), 10, 1e-9, 'a held beat lasts two seconds');
  near(beatToTime(held, 10), 12);
  for (const b of [10, 11, 16.25, 40]) near(beatToTime(held, b), beatToTime(plain, b) + 2, 1e-9, `beat ${b} after the hold`);
  // The tempo inside the hold is the slowed one, and after it the one before.
  assert.equal(getTempoAtBeat(held, 8.5), 30);
  assert.equal(getTempoAtBeat(held, 10), 60);
  // The inverse inverts across the hold.
  for (const b of [0, 7.99, 8, 8.5, 9.75, 10, 10.01, 33]) near(timeToBeat(held, beatToTime(held, b)), b, 1e-9, `beat ${b}`);
  // A fermata never takes a tempo event's place on its beat.
  const both: TempoEvent[] = [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 120 }, { beat: 8, bpm: 0, fermata: { beats: 1, stretch: 3 } }];
  near(beatToTime(both, 9), 8 + 3 * 0.5, 1e-9, 'the hold stretches the new tempo');
  near(beatToTime(both, 10), 8 + 1.5 + 0.5);
}

// A fermata inside a ritardando: the ramp keeps its shape under the hold, so
// the beats after the hold are the ramp's own beats moved later by the time
// the hold added.
{
  const rit: TempoEvent[] = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 60 }];
  const held: TempoEvent[] = [...rit, { beat: 6, bpm: 0, fermata: { beats: 1, stretch: 2 } }];
  const added = beatToTime(rit, 7) - beatToTime(rit, 6);
  near(beatToTime(held, 6), beatToTime(rit, 6));
  near(beatToTime(held, 7), beatToTime(rit, 7) + added, 1e-9, 'the held beat lasts twice the ramp beat under it');
  for (const b of [7, 10, 16, 20]) near(beatToTime(held, b), beatToTime(rit, b) + added, 1e-9, `beat ${b}`);
  for (const b of [5.9, 6.3, 6.99, 7.5, 12]) near(timeToBeat(held, beatToTime(held, b)), b, 1e-9, `inverse at ${b}`);
}

// Junk fermatas hold nothing: no stretch past 1, no length, or a hold that
// starts inside an earlier one is cut to start where that one ends.
{
  const base: TempoEvent[] = [{ beat: 0, bpm: 60 }];
  for (const f of [{ beats: 0, stretch: 2 }, { beats: 2, stretch: 1 }, { beats: Number.NaN, stretch: 2 }]) {
    assert.deepEqual(normalizeTempoMap([...base, { beat: 4, bpm: 0, fermata: f }]), normalizeTempoMap(base));
  }
  const overlapping: TempoEvent[] = [...base, { beat: 4, bpm: 0, fermata: { beats: 2, stretch: 2 } }, { beat: 5, bpm: 0, fermata: { beats: 2, stretch: 3 } }];
  // 4..6 at x2 (4 s), then 6..7 at x3 (3 s).
  near(beatToTime(overlapping, 7), 4 + 4 + 3);
  near(beatToTime(overlapping, 8), 12);
}

console.log('tempoMap.fermata: ok');
