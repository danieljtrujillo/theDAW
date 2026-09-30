/* The automation gesture bookkeeping: arm → begin → end, per lane, grouped by
 * the surface that reports the boundary.
 *
 * This is the state machine WaveformEditor drives from SlideTrack's
 * `onGestureStart` / `onGestureEnd` (and, for the schema-path controls that
 * report nothing, from an idle deadline). Every law here is one the store depends
 * on: a begin with no end leaves a hold overwriting the lane ahead of the
 * playhead for the rest of the pass.
 */
import assert from 'node:assert/strict';
import { createAutomationGesture, RACK_GESTURE_IDLE_MS } from './automationGesture.ts';

type T = { lane: string; group: string };
const target = (lane: string, group = lane): T => ({ lane, group });

/** A clock + timer queue the test drives by hand. */
const makeClock = () => {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    pending: (): number => timers.size,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: number): void => { timers.delete(id); },
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

const makeGesture = () => {
  const clock = makeClock();
  const log: string[] = [];
  const g = createAutomationGesture<T>({
    keyOf: (x) => x.lane,
    groupOf: (x) => x.group,
    onBegin: (x, v) => log.push(`begin ${x.lane}=${v}`),
    onMove: (x, v) => log.push(`move ${x.lane}=${v}`),
    onEnd: (x) => log.push(`end ${x.lane}`),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { g, log, clock };
};

const pairs = (log: string[]) => ({
  begins: log.filter((l) => l.startsWith('begin')).length,
  ends: log.filter((l) => l.startsWith('end')).length,
});

// ── The deadline belongs to this module ──────────────────────────────────────
assert.equal(RACK_GESTURE_IDLE_MS, 250, 'the fallback deadline for a control that reports no boundary');

// ── arm → first change begins → end ──────────────────────────────────────────
{
  const { g, log, clock } = makeGesture();
  const vol = target('trackVolume|t1');

  g.arm(vol.group);
  assert.deepEqual(log, [], 'arming records nothing: onGestureStart carries no value');
  assert.equal(clock.pending(), 0, 'a widget that reports its boundary never arms a deadline');

  g.change(vol, 0.5);
  g.change(vol, 0.6);
  g.change(vol, 0.7);
  assert.deepEqual(log, ['begin trackVolume|t1=0.5', 'move trackVolume|t1=0.6', 'move trackVolume|t1=0.7'],
    'the FIRST change is the begin; every later one moves');

  g.end(vol.group);
  assert.deepEqual(pairs(log), { begins: 1, ends: 1 }, 'one gesture, one pair');
  assert.equal(g.openGroups(), 0);

  // A second end for the same group is inert (pointerup then pointercancel).
  g.end(vol.group);
  assert.deepEqual(pairs(log), { begins: 1, ends: 1 }, 'a repeated end adds nothing');
}

// ── an end with no change only disarms ───────────────────────────────────────
{
  const { g, log } = makeGesture();
  const vol = target('trackVolume|t1');
  g.arm(vol.group);
  g.end(vol.group);
  assert.deepEqual(log, [], 'a press and release that moved nothing writes nothing');
  assert.equal(g.openGroups(), 0, 'and leaves nothing armed');

  // Tolerating an end for a group that was never armed is the widget's contract.
  g.end('never-armed');
  assert.deepEqual(log, []);
}

// ── arm closes a stale group ─────────────────────────────────────────────────
{
  const { g, log } = makeGesture();
  const vol = target('trackVolume|t1');
  g.arm(vol.group);
  g.change(vol, 0.4);
  g.arm(vol.group); // the previous end never arrived
  assert.deepEqual(pairs(log), { begins: 1, ends: 1 }, 'the new start closes the old gesture first');
  assert.equal(g.openGroups(), 1, 'and leaves exactly one armed');

  g.change(vol, 0.9);
  g.end(vol.group);
  assert.deepEqual(pairs(log), { begins: 2, ends: 2 }, 'two gestures, two pairs — never two opens at once');
}

// ── no arm: the idle deadline closes it, and it reopens cleanly ──────────────
{
  const { g, log, clock } = makeGesture();
  const knob = target('trackFx|t1|e1|drive', 'trackFx|t1|e1');

  g.change(knob, 0.2);
  assert.equal(clock.pending(), 1, 'a control with no boundary arms the fallback deadline');
  clock.advance(100);
  g.change(knob, 0.3);
  clock.advance(100);
  assert.deepEqual(pairs(log), { begins: 1, ends: 0 }, 'a change inside the window pushes the deadline out');

  clock.advance(RACK_GESTURE_IDLE_MS);
  assert.deepEqual(pairs(log), { begins: 1, ends: 1 }, 'silence closes it');
  assert.equal(g.openGroups(), 0);
  assert.equal(clock.pending(), 0, 'and the timer is gone, not re-armed');

  g.change(knob, 0.4);
  clock.advance(RACK_GESTURE_IDLE_MS);
  assert.deepEqual(pairs(log), { begins: 2, ends: 2 }, 'the next move is a fresh gesture, its own pair');
}

// ── one surface, many lanes: the end closes every key of the group ───────────
{
  const { g, log, clock } = makeGesture();
  const GROUP = 'trackFx|t1|owl';
  const x = target('trackFx|t1|owl|x', GROUP);
  const y = target('trackFx|t1|owl|y', GROUP);

  g.arm(GROUP);                 // the pad reports ONE boundary for the surface
  g.change(x, 0.1);
  g.change(y, 0.2);             // a drag writes both axes
  g.change(x, 0.15);
  assert.deepEqual(pairs(log), { begins: 2, ends: 0 }, 'a begin per LANE, on that lane\'s first change');
  assert.equal(clock.pending(), 0, 'the surface reports its boundary, so no deadline runs');

  g.end(GROUP);
  assert.deepEqual(pairs(log), { begins: 2, ends: 2 }, 'the one end closes both lanes');
  assert.deepEqual(log.slice(-2).sort(), ['end trackFx|t1|owl|x', 'end trackFx|t1|owl|y']);
  assert.equal(g.openGroups(), 0);
}

// ── dispose (unmount) closes whatever is open, exactly once ──────────────────
{
  const { g, log, clock } = makeGesture();
  const GROUP = 'trackFx|t1|owl';
  g.arm(GROUP);
  g.change(target('trackFx|t1|owl|x', GROUP), 0.1);
  g.change(target('trackFx|t1|owl|y', GROUP), 0.2);
  g.change(target('trackVolume|t1'), 0.7); // an unrelated, deadline-backed lane
  assert.equal(g.openGroups(), 2);

  g.dispose();
  assert.deepEqual(pairs(log), { begins: 3, ends: 3 }, 'every open lane is ended, none twice');
  assert.equal(g.openGroups(), 0);
  assert.equal(clock.pending(), 0, 'no timer survives the unmount');

  // The widget's own end arrives after ours — it must be inert, not a second end.
  g.end(GROUP);
  assert.deepEqual(pairs(log), { begins: 3, ends: 3 }, 'a late end after dispose adds nothing');

  // dispose is NOT terminal: StrictMode runs mount → cleanup → mount on the SAME
  // instance, so a machine that went inert here would leave every handler dead.
  g.arm(GROUP);
  g.change(target('trackFx|t1|owl|x', GROUP), 0.9);
  g.end(GROUP);
  assert.deepEqual(pairs(log), { begins: 4, ends: 4 }, 'the machine still works after a dispose');
}

console.log('automationGesture.test.ts: all assertions passed');
