// Run with: npx tsx src/lib/rollSelection.test.ts
//
// The roll's marquee geometry and its velocity lane maths: pixels to grid
// points, the rectangle a drag spans in either direction, which notes it takes,
// the bar a velocity draws and the velocity a pointer means, and which notes a
// lane sweep writes.
import assert from 'node:assert/strict';
import {
  MARQUEE_MIN_PX,
  VELOCITY_LANE_HEIGHT,
  VELOCITY_MAX,
  VELOCITY_MIN,
  clampVelocity,
  gridPointAt,
  marqueeBox,
  marqueeRect,
  notesInMarquee,
  notesInStepSpan,
  velocityBarHeight,
  velocityNudgeWrites,
  velocityTargets,
  velocityToY,
  yToVelocity,
} from './rollSelection.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const GEO = { stepPx: 16, noteHeight: 12, highestNote: 108 };
const n = (id: string, note: number, step: number, length = 2, velocity = 90): PianoNote =>
  ({ id, note, step, length, velocity });

// (a) Pixels to a grid point: x keeps its fraction so a marquee edge can fall
// mid-step; y is a whole row counted down from the top note.
{
  assert.deepEqual(gridPointAt(0, 0, GEO), { step: 0, note: 108 });
  assert.deepEqual(gridPointAt(24, 0, GEO), { step: 1.5, note: 108 });
  assert.deepEqual(gridPointAt(0, 11, GEO), { step: 0, note: 108 });
  assert.deepEqual(gridPointAt(0, 12, GEO), { step: 0, note: 107 });
  assert.deepEqual(gridPointAt(0, 60, GEO), { step: 0, note: 103 });
  // A pointer dragged off the left edge never reports a negative step.
  assert.equal(gridPointAt(-40, 0, GEO).step, 0);
  // Nothing here throws on a garbage coordinate.
  assert.deepEqual(gridPointAt(Number.NaN, Number.NaN, GEO), { step: 0, note: 108 });
}

// (b) The rectangle is normalised whichever way the drag ran, and its box in
// pixels covers whole rows (a one-row marquee is one note tall, not zero).
{
  const down = marqueeRect({ step: 2, note: 64 }, { step: 6, note: 60 });
  const up = marqueeRect({ step: 6, note: 60 }, { step: 2, note: 64 });
  assert.deepEqual(down, { fromStep: 2, toStep: 6, lowNote: 60, highNote: 64 });
  assert.deepEqual(down, up, 'either drag direction spans the same rectangle');

  assert.deepEqual(marqueeBox(down, GEO), {
    left: 32,
    top: (108 - 64) * 12,
    width: 64,
    height: 5 * 12,
  });
  const oneRow = marqueeRect({ step: 1, note: 60 }, { step: 1.5, note: 60 });
  assert.equal(marqueeBox(oneRow, GEO).height, 12, 'one row is one note tall');
}

// (c) Which notes a marquee takes: pitch inclusive, steps half-open at BOTH
// ends, so a marquee that starts exactly where a note ends leaves it alone and
// a zero-width marquee takes nothing at all.
{
  const notes = [
    n('a', 60, 0, 4), //  steps 0..4
    n('b', 64, 2, 2), //  steps 2..4
    n('c', 72, 8, 2), //  out of the pitch range below
    n('d', 60, 10, 2), // out of the step range
  ];
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 1, note: 66 }, { step: 3, note: 58 })), ['a', 'b']);
  // Touching only the pitch row of `a`.
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 1, note: 60 }, { step: 3, note: 60 })), ['a']);
  // The left edge exactly at a note's end: not taken.
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 4, note: 66 }, { step: 6, note: 58 })), []);
  // The right edge exactly at a note's start: not taken.
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 0, note: 74 }, { step: 8, note: 70 })), []);
  // A zero-width marquee (a click) selects nothing — the component's own
  // MARQUEE_MIN_PX keeps a click from ever getting here, and this is the floor.
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 1, note: 60 }, { step: 1, note: 60 })), []);
  assert.ok(MARQUEE_MIN_PX > 0);
  // Order follows the note list, not the rectangle.
  assert.deepEqual(notesInMarquee(notes, marqueeRect({ step: 0, note: 127 }, { step: 20, note: 0 })), ['a', 'b', 'c', 'd']);
  // A stored length of 0 still has a start, and a marquee over that start takes it.
  assert.deepEqual(notesInMarquee([n('z', 60, 5, 0)], marqueeRect({ step: 4, note: 60 }, { step: 6, note: 60 })), ['z']);
}

// (d) The velocity scale: 127 fills the strip, 1 is a sliver at the floor, and
// a pointer at the floor or below still means a playable note, never 0.
{
  const H = VELOCITY_LANE_HEIGHT;
  assert.equal(velocityBarHeight(VELOCITY_MAX, H), H - 2);
  assert.equal(velocityToY(VELOCITY_MAX, H), 2);
  assert.ok(velocityBarHeight(VELOCITY_MIN, H) > 0 && velocityBarHeight(VELOCITY_MIN, H) < 1);
  assert.equal(yToVelocity(H, H), VELOCITY_MIN, 'the floor is velocity 1, not 0');
  assert.equal(yToVelocity(H + 50, H), VELOCITY_MIN, 'dragged below the strip');
  assert.equal(yToVelocity(0, H), VELOCITY_MAX);
  assert.equal(yToVelocity(-50, H), VELOCITY_MAX, 'dragged above the strip');
  // y and velocity are inverses to the rounding.
  for (const v of [1, 32, 64, 100, 127]) {
    assert.equal(yToVelocity(velocityToY(v, H), H), v, `round trip at ${v}`);
  }
  assert.equal(clampVelocity(0), 1);
  assert.equal(clampVelocity(-9), 1);
  assert.equal(clampVelocity(1000), 127);
  assert.equal(clampVelocity(63.6), 64);
  assert.equal(clampVelocity(Number.NaN), 1);
}

// (e) A lane sweep reports every note it crossed, including the one under a
// stationary press, and never one that ended before the sweep began.
{
  const notes = [n('a', 60, 0, 4), n('b', 64, 0, 4), n('c', 60, 8, 2)];
  assert.deepEqual(notesInStepSpan(notes, 2, 2), ['a', 'b'], 'a press inside a chord takes both');
  assert.deepEqual(notesInStepSpan(notes, 4, 4), [], 'the step a note ends on is past it');
  assert.deepEqual(notesInStepSpan(notes, 0, 9), ['a', 'b', 'c'], 'a sweep across the lane');
  assert.deepEqual(notesInStepSpan(notes, 9, 0), ['a', 'b', 'c'], 'and the same sweep backwards');
  assert.deepEqual(notesInStepSpan(notes, 8, 8), ['c']);
}

// (f) A sweep that passes over a selected note writes only the selected notes it
// passed, so a selection isolates one voice of a chord; a sweep that passes over
// none writes everything it passed.
{
  const notes = [n('a', 60, 0, 4), n('b', 64, 0, 4), n('c', 67, 0, 4)];
  assert.deepEqual(velocityTargets(notes, 1, 1, new Set()), ['a', 'b', 'c']);
  assert.deepEqual(velocityTargets(notes, 1, 1, new Set(['b'])), ['b']);
  assert.deepEqual(velocityTargets(notes, 1, 1, new Set(['b', 'c'])), ['b', 'c']);
  // A selection somewhere else in the roll does not narrow a sweep that never met it.
  assert.deepEqual(velocityTargets(notes, 1, 1, new Set(['zzz'])), ['a', 'b', 'c']);
}

// (g) An arrow nudge moves every selected note by the same amount, so the
// selection keeps its shape, and lands in as few writes as there are velocities.
{
  const notes = [n('a', 60, 0, 2, 40), n('b', 62, 2, 2, 80), n('c', 64, 4, 2, 40), n('d', 66, 6, 2, 90)];
  assert.deepEqual(velocityNudgeWrites(notes, new Set(['a', 'b', 'c']), 10), [
    { velocity: 50, ids: ['a', 'c'] },
    { velocity: 90, ids: ['b'] },
  ]);
  assert.deepEqual(velocityNudgeWrites(notes, new Set(['a', 'c']), -10), [{ velocity: 30, ids: ['a', 'c'] }]);
  assert.deepEqual(velocityNudgeWrites(notes, new Set(), 10), [], 'nothing selected, nothing to write');
  // A note already at the wall it is heading for drops out instead of holding
  // the rest of its group at the wall with it.
  const loud = [n('a', 60, 0, 2, 127), n('b', 62, 2, 2, 120)];
  assert.deepEqual(velocityNudgeWrites(loud, new Set(['a', 'b']), 10), [{ velocity: 127, ids: ['b'] }]);
  const quiet = [n('a', 60, 0, 2, 1), n('b', 62, 2, 2, 5)];
  assert.deepEqual(velocityNudgeWrites(quiet, new Set(['a', 'b']), -10), [{ velocity: 1, ids: ['b'] }]);
  assert.deepEqual(velocityNudgeWrites(notes, new Set(['a']), 0), []);
}

console.log('rollSelection: ok');
