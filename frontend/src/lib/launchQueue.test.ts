/**
 * launchQueue — the queued-launch state machine, driven by a fake clock whose
 * "now" the test moves by hand.
 *
 * The fake clock is the closed form `beatClock.nextGrid` uses while the meter
 * holds (anchor 0, 120 bpm, 4/4), so every `at` below is a number derived by
 * hand and pinned exactly rather than a tolerance.
 */
import assert from 'node:assert/strict';
import { createLaunchQueue, launchSlotId, type LaunchQueueClock } from './launchQueue.ts';
import { beatClock, type ClockGrid } from './beatClock.ts';
import { dueAt, nextFollow, type FollowAction } from './followAction.ts';

/** Seconds per grid line at 120 bpm, 4/4 — the same table `gridSec` builds. */
const GRID_SEC: Record<Exclude<ClockGrid, 'now'>, number> = {
  '16th': 0.125,
  '8th': 0.25,
  beat: 0.5,
  half: 1,
  bar: 2,
  '2bar': 4,
  '4bar': 8,
};

/** Starts a tenth of a second into bar 0, so "the next bar line" is bar 1. */
const makeClock = () => {
  let t = 0.1;
  const gridCalls: Array<{ grid: ClockGrid; from: number | undefined }> = [];
  const clock: LaunchQueueClock = {
    now: () => t,
    nextGrid(grid, from) {
      gridCalls.push({ grid, from });
      const base = from ?? t;
      if (grid === 'now') return base;
      const unit = GRID_SEC[grid];
      return Math.ceil(base / unit - 1e-6) * unit;
    },
  };
  return { clock, gridCalls, at: (next: number) => { t = next; } };
};

const ids = (ts: readonly { slotId: string }[]): string[] => ts.map((t) => t.slotId);
const ats = (ts: readonly { at: number }[]): number[] => ts.map((t) => t.at);

/* ------------------------- `at` comes from the clock ----------------------- */

// Every grid: `at` is exactly `nextGrid(grid, now())`, never a local anchor.
{
  const { clock, gridCalls, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(1.3);
  const grids: ClockGrid[] = ['now', '16th', '8th', 'beat', 'half', 'bar', '2bar', '4bar'];
  const got = grids.map((grid) => q.queue(`slot-${grid}`, { grid, action: 'play' }).at);
  assert.deepEqual(got, [1.3, 1.375, 1.5, 1.5, 2, 2, 4, 8]);
  // and each one asked the clock for that exact grid, measured from `now()`.
  assert.deepEqual(gridCalls.map((c) => c.grid), grids);
  assert.deepEqual(gridCalls.map((c) => c.from), grids.map(() => 1.3));
}

// Moving the clock moves the next line: the same press one bar later lands one
// bar later, with nothing remembered between the two calls.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(0.2);
  assert.equal(q.queue('a', { grid: 'bar', action: 'play' }).at, 2);
  at(2.2);
  assert.equal(q.queue('b', { grid: 'bar', action: 'play' }).at, 4);
}

// A clock that hands back a non-finite time never reaches `source.start()`:
// the ticket falls back to now rather than scheduling NaN.
{
  const { clock, at } = makeClock();
  at(3);
  const q = createLaunchQueue({ ...clock, nextGrid: () => Number.NaN });
  assert.equal(q.queue('a', { grid: 'bar', action: 'play' }).at, 3);
}

// A non-finite `now()` is the worse half of the same failure: a NaN `at`
// compares false against every deadline, so the ticket would never fire AND
// never be removed, and the pump driving `advance` would spin on it forever.
// It falls back to a finite time and fires on the next advance instead.
{
  const { clock } = makeClock();
  const q = createLaunchQueue({ ...clock, now: () => Number.NaN });
  const t = q.queue('a', { grid: 'bar', action: 'play' });
  assert.equal(Number.isFinite(t.at), true);
  assert.deepEqual(ids(q.advance(0)), ['a']);
  assert.deepEqual(q.pending(), []);
}

/* --------------------------- replace, never stack -------------------------- */

// A re-press before the grid MOVES the intent. One slot is one pending ticket.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(0.1);
  q.queue('a', { grid: 'bar', action: 'play' });
  at(0.4);
  const second = q.queue('a', { grid: 'beat', action: 'play' });
  assert.equal(q.pending().length, 1);
  assert.deepEqual(q.pending()[0], second);
  assert.equal(second.at, 0.5);
  assert.equal(second.grid, 'beat');
}

// Replacing a queued play with a stop (and back) keeps the same single slot.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('a', { grid: 'bar', action: 'play' });
  q.queue('a', { grid: 'bar', action: 'stop' });
  assert.equal(q.pending().length, 1);
  assert.equal(q.pending()[0].action, 'stop');
  q.queue('a', { grid: 'bar', action: 'play' });
  assert.equal(q.pending().length, 1);
  assert.equal(q.pending()[0].action, 'play');
}

// Different slots DO stack — two clips queued on `bar` are two tickets at the
// same downbeat, which is the whole point of a quantized launch.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(0.9);
  q.queue('a', { grid: 'bar', action: 'play' });
  at(1.4);
  q.queue('b', { grid: 'bar', action: 'play' });
  assert.deepEqual(ids(q.pending()), ['a', 'b']);
  assert.deepEqual(ats(q.pending()), [2, 2]);
  at(2);
  assert.deepEqual(ids(q.advance(2)), ['a', 'b']);
}

// A slot re-pressed after its ticket fired queues a fresh one at the next line:
// play while playing is a retrigger, not a no-op.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(0.1);
  q.queue('a', { grid: 'bar', action: 'play' });
  at(2);
  assert.equal(q.advance(2).length, 1);
  at(2.5);
  const retrigger = q.queue('a', { grid: 'bar', action: 'play' });
  assert.equal(retrigger.at, 4);
  assert.deepEqual(q.pending(), [retrigger]);
}

/* ------------------------------- the lead window --------------------------- */

// A ticket fires once `at` is within `lead` of now, and not one tick before.
{
  const { clock } = makeClock();
  const q = createLaunchQueue({ ...clock, lead: 0.05 });
  q.queue('a', { grid: 'bar', action: 'play' });
  assert.equal(q.lead, 0.05);
  assert.deepEqual(q.advance(1.94), []);
  assert.deepEqual(q.advance(1.9499), []);
  assert.deepEqual(ids(q.advance(1.95)), ['a']);
}

// The default lead is the shared clock's own launch lead, so a ticket computed
// for "now" is never already past by the time the consumer schedules it.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  assert.equal(q.lead, 0.01);
  q.queue('a', { grid: 'bar', action: 'play' });
  assert.deepEqual(q.advance(1.98), []);
  assert.deepEqual(ids(q.advance(1.99)), ['a']);
}

// `now` fires on the very next advance, never inside the call that queued it.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(1.234);
  const t = q.queue('a', { grid: 'now', action: 'play' });
  assert.equal(t.at, 1.234);
  assert.deepEqual(q.pending(), [t]);
  assert.deepEqual(ids(q.advance(1.234)), ['a']);
  assert.deepEqual(q.pending(), []);
}

/* --------------------------------- ordering -------------------------------- */

// Fired tickets come back in `at` order however they were queued, so the
// consumer can stop the outgoing clip before starting the incoming one.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('late', { grid: '4bar', action: 'play' });
  q.queue('early', { grid: 'beat', action: 'play' });
  q.queue('mid', { grid: 'bar', action: 'play' });
  assert.deepEqual(ids(q.pending()), ['early', 'mid', 'late']);
  assert.deepEqual(ats(q.pending()), [0.5, 2, 8]);
  assert.deepEqual(ids(q.advance(8)), ['early', 'mid', 'late']);
}

// Ties keep the order they were queued in.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  for (const id of ['c', 'a', 'b']) q.queue(id, { grid: 'bar', action: 'play' });
  assert.deepEqual(ids(q.advance(2)), ['c', 'a', 'b']);
}

// Only the DUE tickets are taken; a later one stays queued.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('soon', { grid: 'beat', action: 'play' });
  q.queue('later', { grid: 'bar', action: 'play' });
  assert.deepEqual(ids(q.advance(0.5)), ['soon']);
  assert.deepEqual(ids(q.pending()), ['later']);
}

/* --------------------------- fires exactly once ---------------------------- */

// A fired ticket is gone: advancing again over the same instant returns nothing.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('a', { grid: 'bar', action: 'play' });
  assert.deepEqual(ids(q.advance(2)), ['a']);
  assert.deepEqual(q.advance(2), []);
  assert.deepEqual(q.advance(99), []);
  assert.deepEqual(q.pending(), []);
}

// Mutating what `pending()` handed back cannot corrupt the queue.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('a', { grid: 'bar', action: 'play' });
  const snapshot = q.pending();
  snapshot.length = 0;
  assert.equal(q.pending().length, 1);
  assert.throws(() => { (q.pending()[0] as { at: number }).at = 0; });
  assert.equal(q.pending()[0].at, 2);
}

/* ------------------------------ cancel and clear --------------------------- */

// Cancel drops one slot's intent and leaves every other slot alone.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('a', { grid: 'bar', action: 'play' });
  q.queue('b', { grid: 'bar', action: 'play' });
  assert.equal(q.cancel('a'), true);
  assert.equal(q.cancel('a'), false);
  assert.equal(q.cancel('nobody'), false);
  assert.deepEqual(ids(q.pending()), ['b']);
  assert.deepEqual(ids(q.advance(2)), ['b']);
}

// Stopping the transport clears every pending launch — nothing fires later.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  q.queue('a', { grid: 'bar', action: 'play' });
  q.queue('b', { grid: '4bar', action: 'stop' });
  q.clear();
  assert.deepEqual(q.pending(), []);
  assert.deepEqual(q.advance(99), []);
}

/* ------------------------------- the payload ------------------------------- */

// The ticket carries the whole intent, so the consumer needs no side channel
// for what to do when it fires.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(0.75);
  const t = q.queue('track:3', { grid: 'bar', action: 'play', offsetSec: 1.5 });
  assert.deepEqual({ ...t }, {
    slotId: 'track:3',
    at: 2,
    state: 'queued',
    action: 'play',
    grid: 'bar',
    offsetSec: 1.5,
  });
  assert.equal(q.advance(2)[0].offsetSec, 1.5);
}

// A stop ticket has no offset and says so, rather than carrying a stale one.
{
  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  const t = q.queue('track:3', { grid: 'beat', action: 'stop' });
  assert.equal(t.action, 'stop');
  assert.equal(t.offsetSec, undefined);
}

/* ------------------------- one slot id per column -------------------------- */

// A set whose clips carry a `track_index` that is NOT the mixer column (Live
// counts return/master tracks the grid does not show). Both launch paths must
// land on the SAME slot id, or one column gets two, and a scene's stop and a
// cell's play both fire on the line instead of the later press replacing the
// earlier one.
{
  const columns = [
    { mixIndex: 0, trackIndex: 3 },
    { mixIndex: 1, trackIndex: 7 },
  ];
  // Same column, two call sites, two different `track_index` values in play.
  assert.deepEqual(columns.map((c) => launchSlotId(c.mixIndex)), ['track:0', 'track:1']);
  assert.notDeepEqual(
    columns.map((c) => launchSlotId(c.mixIndex)),
    columns.map((c) => launchSlotId(c.trackIndex)),
  );

  const { clock } = makeClock();
  const q = createLaunchQueue(clock);
  // Scene launch stops column 0, then a cell press plays on the same column.
  q.queue(launchSlotId(columns[0].mixIndex), { grid: 'bar', action: 'stop' });
  q.queue(launchSlotId(columns[0].mixIndex), { grid: 'bar', action: 'play' });
  assert.equal(q.pending().length, 1);
  assert.equal(q.pending()[0].action, 'play');
  // Derived from `track_index` instead, the two would not collide at all and
  // both would fire: that is the defect this id exists to make impossible.
  q.queue(launchSlotId(columns[0].trackIndex), { grid: 'bar', action: 'stop' });
  assert.equal(q.pending().length, 2);
}

/* ----------------------- an explicit `at` on the spec ---------------------- */

// A follow action already knows the instant it wants — the boundary of the clip
// that is finishing — so it hands that over and the clock is never asked. Using
// the grid instead would round the handover up to the next launch line and put
// a hole the length of the quantization into the column.
{
  const { clock, gridCalls, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(1.3);
  assert.equal(q.queue('a', { grid: 'bar', action: 'play', at: 3.75 }).at, 3.75);
  assert.deepEqual(gridCalls, []);
}

// An `at` already in the past is honoured as given: `advance` then fires it on
// the very next pump, which is what a deadline the pump only just noticed means.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(5);
  assert.equal(q.queue('a', { grid: 'bar', action: 'play', at: 4.2 }).at, 4.2);
  assert.deepEqual(ids(q.advance(5)), ['a']);
}

// A non-finite `at` falls back to the grid exactly as if none had been given —
// the same guard the clock's own output already has, since a NaN `at` compares
// false against every deadline and would spin the pump forever.
{
  const { clock, gridCalls, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(1.3);
  assert.equal(q.queue('a', { grid: 'bar', action: 'play', at: Number.NaN }).at, 2);
  assert.equal(q.queue('b', { grid: 'bar', action: 'play', at: Number.POSITIVE_INFINITY }).at, 2);
  assert.equal(q.queue('c', { grid: 'bar', action: 'play', at: undefined }).at, 2);
  assert.deepEqual(gridCalls.map((c) => c.grid), ['bar', 'bar', 'bar']);
}

// Replace-not-stack is unchanged by it: a user press landing between a follow's
// deadline and its line replaces the follow, it does not queue behind it.
{
  const { clock, at } = makeClock();
  const q = createLaunchQueue(clock);
  at(1.3);
  q.queue('track:0', { grid: 'bar', action: 'play', at: 3.75 });
  q.queue('track:0', { grid: 'bar', action: 'play' });
  assert.equal(q.pending().length, 1);
  assert.deepEqual(ats(q.pending()), [2]);
}

/* ------------------ against the real clock, outside 4/4 -------------------- */

// The grid hands `beatClock` the set's meter as a MAP, not a beats-per-bar
// count: `setBeatsPerBar` builds n/4, which rounds 7/8 to 4/4 and puts the bar
// line in the wrong place. A 7/8 bar is 3.5 quarter notes, so at 120 bpm its
// lines are 1.75 s apart.
{
  beatClock.setMeterMap([{ bar: 0, meter: { num: 7, den: 8, groups: [] } }]);
  beatClock.setBpm(120, 'perform');
  beatClock.setAnchor(0, 0);
  assert.equal(beatClock.beatsPerBar, 3.5);
  assert.equal(beatClock.barSec(0), 1.75);

  const q = createLaunchQueue({
    nextGrid: (grid, from) => beatClock.nextGrid(grid, from),
    now: () => 0.1,
    lead: 0.05,
  });
  assert.equal(q.queue('track:0', { grid: 'bar', action: 'play' }).at, 1.75);
  assert.equal(q.queue('track:1', { grid: '2bar', action: 'play' }).at, 3.5);
  // A beat stays a quarter note whatever the meter, so `beat` is unmoved.
  assert.equal(q.queue('track:2', { grid: 'beat', action: 'play' }).at, 0.5);
  // All three land on real 7/8 bar/beat lines, in `at` order.
  assert.deepEqual(ats(q.pending()), [0.5, 1.75, 3.5]);
}

/* ------------- a follow action, end to end against the real clock ---------- */

// The handover the grid's pump performs: a clip launched on a bar line, a rule
// of "Next after 1 bar", and the deadline that comes out of it. The point of the
// explicit `at` is that the follow lands ON the clip's boundary rather than
// being re-quantized to the next launch line — so the outgoing clip's stop and
// the incoming clip's start are the same instant and the column has no gap.
{
  beatClock.setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
  beatClock.setBpm(120, 'perform');
  beatClock.setAnchor(0, 0);
  assert.equal(beatClock.barSec(0), 2);

  // Row 0 was launched on the bar line at t=4 and is 2 s long.
  const startedAt = 4;
  const armed: FollowAction = { after: { bars: 1, beats: 0 }, a: 'next', chance: 1 };
  const deadline = dueAt(armed, startedAt, 2, beatClock.barSec(), beatClock.gridSec('beat'));
  assert.equal(deadline, 6);
  // and 6 is a real bar line on the shared clock, not merely 2 s later.
  assert.equal(beatClock.nextGrid('bar', 5.9), 6);

  // The rule picks the next OCCUPIED row of that column (row 1 here).
  const result = nextFollow(
    { sceneIndex: 0, occupiedScenes: [0, 1], playsDone: 1, elapsedSec: 1.95, lengthSec: 2 },
    armed,
    () => 0,
  );
  assert.deepEqual(result, { kind: 'launch', sceneIndex: 1 });

  // The pump notices it one lead early and queues it with that exact deadline.
  let t = 5.96;
  const q = createLaunchQueue({
    nextGrid: (grid, from) => beatClock.nextGrid(grid, from),
    now: () => t,
    lead: 0.05,
  });
  const ticket = q.queue(launchSlotId(0), { grid: 'bar', action: 'play', at: deadline });
  assert.equal(ticket.at, 6);
  // It fires on this same pump, with its whole lead left to schedule in.
  assert.deepEqual(ats(q.advance(t)), [6]);

  // Going through the launch grid instead is what leaves the hole, in the two
  // ways it happens: the set is quantized coarser than the rule's period...
  t = 5.96;
  assert.equal(q.queue(launchSlotId(0), { grid: '4bar', action: 'play' }).at, 8);
  // ...and the pump noticing a deadline a hair after it passed, which rounds a
  // handover that was due NOW up to a whole bar of silence.
  t = 6.001;
  assert.equal(q.queue(launchSlotId(0), { grid: 'bar', action: 'play' }).at, 8);
  assert.equal(q.queue(launchSlotId(0), { grid: 'bar', action: 'play', at: deadline }).at, 6);
}

console.log('launchQueue: ok');
