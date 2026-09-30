/**
 * followAction — the two pure functions behind a clip's follow action, driven by
 * a hand-stepped rng so every draw is pinned rather than sampled.
 *
 * `nextFollow` answers WHAT happens; `dueAt` answers WHEN. Nothing here touches
 * a clock, a queue or the DOM.
 */
import assert from 'node:assert/strict';
import {
  dueAt,
  nextFollow,
  parseFollowAction,
  type FollowAction,
  type FollowKind,
  type FollowState,
} from './followAction.ts';

/** An rng handing back the listed draws in order; a draw too many is a failure. */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('rng drawn more times than the test allows');
    return values[i++];
  };
};

/** For the kinds that must not consult the rng at all. */
const never = (): number => { throw new Error('rng must not be drawn'); };

const state = (over: Partial<FollowState> = {}): FollowState => ({
  sceneIndex: 1,
  occupiedScenes: [0, 1, 2, 3],
  playsDone: 1,
  elapsedSec: 2,
  lengthSec: 2,
  ...over,
});

const rule = (a: FollowKind, over: Partial<FollowAction> = {}): FollowAction => ({
  after: { bars: 1, beats: 0 },
  a,
  chance: 1,
  ...over,
});

/* ------------------------------- every kind -------------------------------- */

// `stop` is the one result that is not a launch.
assert.deepEqual(nextFollow(state(), rule('stop'), never), { kind: 'stop' });

// `again` relaunches the scene the clip is already in.
assert.deepEqual(nextFollow(state(), rule('again'), never), { kind: 'launch', sceneIndex: 1 });

// `next` / `prev` step through the OCCUPIED rows of that column, not every row:
// rows 2, 3, 5 and 6 are empty here, so `next` from row 1 is row 4.
assert.deepEqual(
  nextFollow(state({ sceneIndex: 1, occupiedScenes: [0, 1, 4, 7] }), rule('next'), never),
  { kind: 'launch', sceneIndex: 4 },
);
assert.deepEqual(
  nextFollow(state({ sceneIndex: 4, occupiedScenes: [0, 1, 4, 7] }), rule('prev'), never),
  { kind: 'launch', sceneIndex: 1 },
);

// WRAP-VS-STOP: neither wraps. At the last occupied row `next` yields no action
// at all — the clip is left alone, which is NOT the same as stopping it.
assert.equal(nextFollow(state({ sceneIndex: 7, occupiedScenes: [0, 1, 4, 7] }), rule('next'), never), null);
assert.equal(nextFollow(state({ sceneIndex: 0, occupiedScenes: [0, 1, 4, 7] }), rule('prev'), never), null);

// `first` / `last` are the ends of that same occupied list.
assert.deepEqual(
  nextFollow(state({ occupiedScenes: [2, 5, 9] }), rule('first'), never),
  { kind: 'launch', sceneIndex: 2 },
);
assert.deepEqual(
  nextFollow(state({ occupiedScenes: [2, 5, 9] }), rule('last'), never),
  { kind: 'launch', sceneIndex: 9 },
);

// `any` draws uniformly over the occupied rows, the current one INCLUDED.
{
  const occupiedScenes = [0, 1, 4, 7];
  const draws = [0, 0.24, 0.25, 0.49, 0.5, 0.74, 0.75, 0.999];
  const got = draws.map(
    (d) => nextFollow(state({ sceneIndex: 1, occupiedScenes }), rule('any'), seq(d)),
  );
  assert.deepEqual(got, [0, 0, 1, 1, 4, 4, 7, 7].map((sceneIndex) => ({ kind: 'launch', sceneIndex })));
}

// `other` draws uniformly over the occupied rows MINUS the current one, so the
// same four rows are three outcomes and row 1 is unreachable.
{
  const occupiedScenes = [0, 1, 4, 7];
  const draws = [0, 0.33, 0.34, 0.66, 0.67, 0.999];
  const got = draws.map(
    (d) => nextFollow(state({ sceneIndex: 1, occupiedScenes }), rule('other'), seq(d)),
  );
  assert.deepEqual(got, [0, 0, 4, 4, 7, 7].map((sceneIndex) => ({ kind: 'launch', sceneIndex })));
}

// `other` with ONE occupied row has nothing else to pick: no action, and it does
// not fall back to relaunching the row it was told to avoid.
assert.equal(nextFollow(state({ sceneIndex: 3, occupiedScenes: [3] }), rule('other'), never), null);

// A column with no playable clip at all: every row-relative kind is a no-op,
// while `stop` and `again` still mean what they say.
{
  const empty = state({ sceneIndex: 0, occupiedScenes: [] });
  const kinds: FollowKind[] = ['next', 'prev', 'first', 'last', 'any', 'other'];
  for (const kind of kinds) assert.equal(nextFollow(empty, rule(kind), never), null, kind);
  assert.deepEqual(nextFollow(empty, rule('stop'), never), { kind: 'stop' });
  assert.deepEqual(nextFollow(empty, rule('again'), never), { kind: 'launch', sceneIndex: 0 });
}

// The occupied list is read in ascending order whatever order it arrives in.
assert.deepEqual(
  nextFollow(state({ sceneIndex: 4, occupiedScenes: [7, 0, 4, 1] }), rule('next'), never),
  { kind: 'launch', sceneIndex: 7 },
);

/* --------------------------------- chance ---------------------------------- */

// No `b`: `a` always, and the rng is never touched — a one-sided rule is
// deterministic no matter what `chance` says.
assert.deepEqual(nextFollow(state(), rule('again', { chance: 0 }), never), { kind: 'launch', sceneIndex: 1 });
assert.deepEqual(nextFollow(state(), rule('again', { chance: 0.5 }), never), { kind: 'launch', sceneIndex: 1 });

// With a `b`, `chance` is P(a): the draw is compared against it, so a draw below
// chance is `a` and a draw at or above it is `b`.
{
  const r = rule('again', { b: 'stop', chance: 0.75 });
  assert.deepEqual(nextFollow(state(), r, seq(0)), { kind: 'launch', sceneIndex: 1 });
  assert.deepEqual(nextFollow(state(), r, seq(0.749)), { kind: 'launch', sceneIndex: 1 });
  assert.deepEqual(nextFollow(state(), r, seq(0.75)), { kind: 'stop' });
  assert.deepEqual(nextFollow(state(), r, seq(0.999)), { kind: 'stop' });
}

// chance 1 / chance 0 are the degenerate ends, still one draw each.
assert.deepEqual(nextFollow(state(), rule('again', { b: 'stop', chance: 1 }), seq(0.999)), { kind: 'launch', sceneIndex: 1 });
assert.deepEqual(nextFollow(state(), rule('again', { b: 'stop', chance: 0 }), seq(0)), { kind: 'stop' });

// The a/b draw comes FIRST, then the chosen kind's own draw — so a random `b`
// takes exactly two numbers off the rng, in that order.
{
  const r = rule('stop', { b: 'any', chance: 0.25 });
  assert.deepEqual(
    nextFollow(state({ sceneIndex: 1, occupiedScenes: [0, 1, 4, 7] }), r, seq(0.9, 0.5)),
    { kind: 'launch', sceneIndex: 4 },
  );
}

/* --------------------------------- dueAt ----------------------------------- */

// `{bars, beats}` is measured from the clip's own start, in the bar and beat
// lengths the caller reads off the shared clock (2 s bar, 0.5 s beat here).
assert.equal(dueAt(rule('next', { after: { bars: 1, beats: 0 } }), 10, 4, 2, 0.5), 12);
assert.equal(dueAt(rule('next', { after: { bars: 2, beats: 3 } }), 10, 4, 2, 0.5), 15.5);
assert.equal(dueAt(rule('next', { after: { bars: 0, beats: 1 } }), 10, 4, 2, 0.5), 10.5);
// A 7/8 bar is 1.75 s at 120 bpm; the deadline follows the bar length it is given.
assert.equal(dueAt(rule('next', { after: { bars: 2, beats: 0 } }), 0, 4, 1.75, 0.5), 3.5);

// `{plays}` is measured in clip lengths instead.
assert.equal(dueAt(rule('next', { after: { plays: 1 } }), 10, 4, 2, 0.5), 14);
assert.equal(dueAt(rule('next', { after: { plays: 3 } }), 10, 4, 2, 0.5), 22);

// A rule that asks for nothing would come due on the tick it was armed and
// refire every pump tick after it, so each form has a floor of its own smallest
// unit: one beat, or one play.
assert.equal(dueAt(rule('next', { after: { bars: 0, beats: 0 } }), 10, 4, 2, 0.5), 10.5);
assert.equal(dueAt(rule('next', { after: { plays: 0 } }), 10, 4, 2, 0.5), 14);
assert.equal(dueAt(rule('next', { after: { bars: -3, beats: -1 } }), 10, 4, 2, 0.5), 10.5);

// Nothing non-finite ever reaches a queue deadline and from there
// `source.start()`: a bad number falls back to the floor.
assert.equal(dueAt(rule('next', { after: { bars: Number.NaN, beats: 0 } }), 10, 4, 2, 0.5), 10.5);
assert.equal(dueAt(rule('next', { after: { plays: 2 } }), 10, Number.NaN, 2, 0.5), 10.5);
assert.equal(dueAt(rule('next', { after: { bars: 1, beats: 0 } }), 10, 4, Number.POSITIVE_INFINITY, 0.5), 10.5);

// A bad BEAT length does not poison a rule whose bars are fine: the sanitised
// beat is what the offset is built from, so `beats: 0` contributes 0 rather than
// multiplying out to NaN and dragging the whole rule down to the floor.
assert.equal(dueAt(rule('next', { after: { bars: 1, beats: 0 } }), 10, 4, 2, Number.NaN), 12);
assert.equal(dueAt(rule('next', { after: { bars: 1, beats: 0 } }), 10, 4, 2, 0), 12);
// With a real beats term and no usable beat length, one beat falls back to the
// 120 bpm default rather than to nothing.
assert.equal(dueAt(rule('next', { after: { bars: 0, beats: 2 } }), 10, 4, 2, Number.NaN), 11);

/* ------------------------------ parseFollowAction -------------------------- */

// The wire shape a .tasmo file carries, back to the in-app rule.
assert.deepEqual(parseFollowAction({ after: { bars: 2, beats: 1 }, a: 'next', b: 'stop', chance: 0.4 }), {
  after: { bars: 2, beats: 1 },
  a: 'next',
  b: 'stop',
  chance: 0.4,
});
assert.deepEqual(parseFollowAction({ after: { plays: 2 }, a: 'again', chance: 1 }), {
  after: { plays: 2 },
  a: 'again',
  chance: 1,
});

// Absent, malformed or unknown: no rule at all, rather than a rule that means
// something the file never said.
assert.equal(parseFollowAction(null), undefined);
assert.equal(parseFollowAction(undefined), undefined);
assert.equal(parseFollowAction({}), undefined);
assert.equal(parseFollowAction({ after: { bars: 1, beats: 0 }, a: '' }), undefined);
assert.equal(parseFollowAction({ after: { bars: 1, beats: 0 }, a: 'sideways' }), undefined);
// An unknown `b` drops only `b`: the primary action is still what the file said.
assert.deepEqual(parseFollowAction({ after: { bars: 1, beats: 0 }, a: 'next', b: 'sideways' }), {
  after: { bars: 1, beats: 0 },
  a: 'next',
  chance: 1,
});
// `chance` is a probability: out-of-range and non-numeric values are clamped, so
// a bad file can never make a one-sided rule silently stop firing.
assert.equal(parseFollowAction({ after: { plays: 1 }, a: 'next', chance: 5 })?.chance, 1);
assert.equal(parseFollowAction({ after: { plays: 1 }, a: 'next', chance: -2 })?.chance, 0);
assert.equal(parseFollowAction({ after: { plays: 1 }, a: 'next', chance: 'x' })?.chance, 1);
// `plays` wins over `bars`/`beats` when a file somehow carries both.
assert.deepEqual(parseFollowAction({ after: { bars: 1, beats: 0, plays: 2 }, a: 'next' })?.after, { plays: 2 });

// NULL IS ABSENT, NOT ZERO. The backend defaults all three keys to None and
// dumps them, so a rule written without a period arrives fully null-filled —
// and `Number(null)` is a perfectly finite 0, which would have loaded it as a
// rule with no period at all and fired it on `dueAt`'s one-beat floor, every
// beat, forever.
assert.equal(parseFollowAction({ after: { bars: null, beats: null, plays: null }, a: 'next', chance: 1 }), undefined);
assert.deepEqual(
  parseFollowAction({ after: { bars: 2, beats: null, plays: null }, a: 'next', chance: 1 })?.after,
  { bars: 2, beats: 0 },
);
assert.deepEqual(
  parseFollowAction({ after: { bars: null, beats: null, plays: 3 }, a: 'next', chance: 1 })?.after,
  { plays: 3 },
);

console.log('followAction: ok');
