/* The hold-only lane repaint throttle.
 *
 * `advanceAutomationHolds` rewrites `automationLanes` on EVERY transport frame
 * while a latch/write pass holds a target, so a component subscribed to that
 * slice re-renders ~40x a second for a value that is only ever looked at. The
 * feed is the projection that sits between: it republishes at most once per
 * `AUTOMATION_LANE_REPAINT_MS` WHILE holds exist, and immediately the rest of
 * the time — an edit is a user action and must land on the very next paint.
 *
 * Everything here drives the real projection with an injected clock and a fake
 * store, so the throttle is pinned without a DOM, React or a real timer.
 */
import assert from 'node:assert/strict';
import {
  AUTOMATION_LANE_REPAINT_MS, createAutomationLaneFeed,
  type AutomationHold, type AutomationLane, type AutomationTarget,
} from './editorStore.ts';

const TARGET: AutomationTarget = { kind: 'trackVolume', trackId: 't1' };
const HOLD: AutomationHold = { target: TARGET, value: 0.5, lastT: 0, released: false };

/** A fresh lanes array, exactly as every store write produces one. */
const lanesAt = (v: number): AutomationLane[] => [
  { id: 'lane-1', target: TARGET, points: [{ t: 0, v }], enabled: true },
];

/** A clock + timer queue the test drives by hand. */
const makeClock = () => {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: number): void => { timers.delete(id); },
    pending: (): number => timers.size,
    advance: (ms: number): void => {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e;
        if (due === null) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
  };
};

/** The two store slices the feed reads, plus the notify the store does. */
const makeSource = () => {
  const state = {
    automationLanes: [] as AutomationLane[],
    automationHolds: {} as Record<string, AutomationHold>,
  };
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of [...listeners]) l(); };
  return {
    state,
    getState: () => state,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    subscribers: () => listeners.size,
    /** One store write that changed the lanes. */
    bump: (v: number) => { state.automationLanes = lanesAt(v); notify(); },
    /** A store write that left the lanes alone (a playhead move, say). */
    poke: () => notify(),
    hold: (on: boolean) => { state.automationHolds = on ? { 'trackVolume:t1': HOLD } : {}; },
  };
};

const makeFeed = () => {
  const src = makeSource();
  const clock = makeClock();
  const feed = createAutomationLaneFeed({
    getState: src.getState,
    subscribe: src.subscribe,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { src, clock, feed };
};

// ── The window is the one this module owns ───────────────────────────────────
assert.equal(AUTOMATION_LANE_REPAINT_MS, 100, 'ten repaints a second while a pass holds');

// ── No hold: every change paints at once ─────────────────────────────────────
{
  const { src, clock, feed } = makeFeed();
  let paints = 0;
  const off = feed.subscribe(() => { paints += 1; });

  src.bump(0.1);
  assert.equal(paints, 1, 'an edit outside a record pass paints immediately');
  assert.equal(feed.getSnapshot(), src.state.automationLanes, 'and the snapshot is the store value');
  assert.equal(clock.pending(), 0, 'no timer is armed when nothing is held');

  clock.advance(5);
  src.bump(0.2);
  assert.equal(paints, 2, 'two edits 5 ms apart are two paints — the throttle is hold-only');

  // A store write that did not touch the lanes must wake nobody: the snapshot is
  // compared by reference, exactly as zustand does.
  src.poke();
  assert.equal(paints, 2, 'an unrelated store write does not repaint the lanes');
  off();
}

// ── Holding: 40 Hz of hold writes become 10 Hz of paints ─────────────────────
{
  const { src, clock, feed } = makeFeed();
  let paints = 0;
  const off = feed.subscribe(() => { paints += 1; });
  src.hold(true);

  // 40 frames over one second — what advanceAutomationHolds produces.
  for (let i = 1; i <= 40; i += 1) {
    clock.advance(25);
    src.bump(i / 100);
  }
  assert.equal(paints, 10, 'one second of a record pass repaints ten times, not forty');
  assert.equal(clock.pending(), 1, 'the frames since the last paint are still due');

  // The snapshot React reads must NOT move between paints — that is the whole
  // point: a changed reference is a re-render.
  const held = feed.getSnapshot();
  clock.advance(10);
  src.bump(0.99);
  assert.equal(feed.getSnapshot(), held, 'a frame inside the window leaves the snapshot alone');
  assert.notEqual(src.state.automationLanes, held, 'even though the store has moved on');

  // The trailing edge lands the final lanes, so the pass never ends on a stale
  // paint.
  clock.advance(AUTOMATION_LANE_REPAINT_MS);
  assert.equal(paints, 11, 'the trailing repaint fires with no further writes');
  assert.equal(feed.getSnapshot(), src.state.automationLanes, 'and it carries the latest lanes');
  assert.equal(clock.pending(), 0, 'nothing is left armed once the feed has caught up');

  // Letting go clears the holds; the next change is an edit again.
  src.hold(false);
  src.bump(0.5);
  assert.equal(paints, 12, 'the first change after the pass paints at once');
  assert.equal(feed.getSnapshot(), src.state.automationLanes);
  off();
}

// ── A repaint window that elapses after the feed caught up paints nothing ────
//
// The deferred repaint fires on a deadline, not on a change. If an immediate
// publish overtakes it — the holds cleared and an edit landed inside the window —
// there is nothing left to paint, and a second paint of the same array would wake
// every subscriber for nothing. Two things stop it: the overtaking publish
// disarms the timer, and `publish` itself returns early when the store and the
// snapshot are already the same reference. The first is what this reaches; the
// second is defence behind it.
{
  const { src, clock, feed } = makeFeed();
  let paints = 0;
  const off = feed.subscribe(() => { paints += 1; });

  src.hold(true);
  clock.advance(10);
  src.bump(0.3);                       // deferred: a repaint is now due
  assert.equal(clock.pending(), 1);
  assert.equal(paints, 0);

  src.hold(false);
  src.bump(0.4);                       // the holds cleared, so this one is immediate
  assert.equal(paints, 1, 'the immediate publish overtakes the pending one');
  assert.equal(clock.pending(), 0, 'and takes its timer with it');

  // And letting the whole window elapse afterwards paints nothing either.
  src.hold(true);
  clock.advance(10);
  src.bump(0.5);
  assert.equal(clock.pending(), 1);
  src.hold(false);
  src.bump(0.6);
  const caughtUp = paints;
  clock.advance(AUTOMATION_LANE_REPAINT_MS * 2);
  assert.equal(paints, caughtUp, 'nothing republishes once the snapshot is current');
  assert.equal(feed.getSnapshot(), src.state.automationLanes);
  off();
}

// ── Unmount: no subscription, no timer, no late paint ────────────────────────
{
  const { src, clock, feed } = makeFeed();
  let paints = 0;
  const off = feed.subscribe(() => { paints += 1; });
  src.hold(true);
  clock.advance(1);
  src.bump(0.6);
  assert.equal(paints, 0, 'the first frame of a pass is deferred');
  assert.equal(clock.pending(), 1);
  assert.equal(src.subscribers(), 1);

  off();
  assert.equal(clock.pending(), 0, 'unmount disarms the pending repaint');
  assert.equal(src.subscribers(), 0, 'and drops the store subscription');
  clock.advance(500);
  src.bump(0.7);
  assert.equal(paints, 0, 'nothing paints after unmount');

  // A fresh mount re-syncs: the lanes moved on while nothing was subscribed, and
  // a stale snapshot would paint the old document.
  const off2 = feed.subscribe(() => { paints += 1; });
  assert.equal(feed.getSnapshot(), src.state.automationLanes, 'a fresh mount reads the current lanes');
  off2();
}

console.log('editorStore.automationLaneFeed.test.ts: all assertions passed');
