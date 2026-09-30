/**
 * vstLive/liveParamRouter — leading + trailing throttle, per-key coalescing,
 * final-value guarantee, gesture-end commit.
 *
 * Run: npx tsx src/lib/vstLive/liveParamRouter.test.ts
 */
import assert from 'node:assert/strict';

import { createLiveParamRouter, type LiveParamRouterDeps } from './liveParamRouter.ts';

/** A hand-rolled fake clock: `now`/`schedule`/`cancel` for the router to use,
 *  plus `tick(ms)` to advance virtual time and fire whatever falls due along
 *  the way, in the order it would have fired for real. */
function makeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => time,
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    cancel: (id: number): void => {
      timers.delete(id);
    },
    tick(ms: number): void {
      const end = time + ms;
      for (;;) {
        let dueId: number | null = null;
        let due: { at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (due === null || dueId === null) break;
        timers.delete(dueId);
        time = due.at;
        due.fn();
      }
      time = end;
    },
  };
}

interface Call {
  entryId: string;
  paramKey: string;
  value: number;
}

/** A router wired to `clock`, recording every `send`/`commit` it makes. */
function makeRouter(clock: ReturnType<typeof makeClock>, overrides: Partial<LiveParamRouterDeps> = {}) {
  const sends: Call[] = [];
  const commits: Call[] = [];
  const router = createLiveParamRouter({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    send: (entryId, paramKey, value) => sends.push({ entryId, paramKey, value }),
    commit: (entryId, paramKey, value) => commits.push({ entryId, paramKey, value }),
    ...overrides,
  });
  return { router, sends, commits };
}

/* ── leading edge sends immediately ────────────────────────────────────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.5);
  assert.equal(sends.length, 1, 'the first push for a key sends immediately');
  assert.deepEqual(sends[0], { entryId: 'e1', paramKey: 'cutoff', value: 0.5 });
  assert.equal(router.pendingCount(), 0, 'nothing left pending after a leading-edge send');

  // "No send within intervalMs" is not only true for a brand-new key: a key
  // that has gone quiet for a full interval gets a fresh leading edge too,
  // sent synchronously rather than waiting on a trailing timer.
  clock.tick(100);
  router.push('e1', 'cutoff', 0.6);
  assert.equal(sends.length, 2, 'a push after a quiet gap is a second leading edge, not a pending value');
  assert.deepEqual(sends[1], { entryId: 'e1', paramKey: 'cutoff', value: 0.6 });
  assert.equal(router.pendingCount(), 0, 'sent immediately, so nothing is left pending');
}

/* ── a burst inside one interval collapses to ONE trailing send carrying the
   newest value ─────────────────────────────────────────────────────────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1); // leading edge, sent now
  clock.tick(2);
  router.push('e1', 'cutoff', 0.2); // pending
  clock.tick(2);
  router.push('e1', 'cutoff', 0.3); // pending, overwrites 0.2
  clock.tick(2);
  router.push('e1', 'cutoff', 0.4); // pending, overwrites 0.3
  assert.equal(sends.length, 1, 'still only the leading-edge send so far');
  assert.equal(router.pendingCount(), 1, 'the burst collapsed to one pending value');

  clock.tick(20); // past the 16 ms interval: the trailing timer fires
  assert.equal(sends.length, 2, 'exactly one trailing send followed the leading one');
  assert.deepEqual(sends[1], { entryId: 'e1', paramKey: 'cutoff', value: 0.4 }, 'carrying the newest value, not 0.2 or 0.3');
}

/* ── steady 5 ms pushes over 100 ms produce about 6 sends, not 20 ─────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  for (let i = 0; i < 20; i += 1) {
    router.push('e1', 'cutoff', i / 20);
    clock.tick(5);
  }
  assert.ok(sends.length >= 5 && sends.length <= 8, `expected roughly one send per 16 ms interval, got ${sends.length}`);
  assert.ok(sends.length < 20, 'never one send per push');
}

/* ── two parameters on the same entry coalesce independently ──────────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1); // leading edge
  router.push('e1', 'resonance', 0.9); // different key: also leading edge
  assert.equal(sends.length, 2, 'each param on the entry gets its own leading edge');

  clock.tick(2);
  router.push('e1', 'cutoff', 0.15); // pending on cutoff only
  assert.equal(sends.length, 2, 'a cutoff push does not touch resonance');
  assert.equal(router.pendingCount(), 1);

  clock.tick(20);
  assert.equal(sends.length, 3);
  assert.deepEqual(sends[2], { entryId: 'e1', paramKey: 'cutoff', value: 0.15 });
}

/* ── the same paramKey on two entries coalesces independently ─────────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  router.push('e1', 'mix', 0.2);
  router.push('e2', 'mix', 0.8);
  assert.equal(sends.length, 2, 'each entry gets its own leading edge');

  clock.tick(2);
  router.push('e1', 'mix', 0.25);
  router.push('e1', 'mix', 0.3);
  assert.equal(router.pendingCount(), 1, 'only e1/mix has a pending value');

  clock.tick(20);
  assert.equal(sends.length, 3);
  assert.deepEqual(sends[2], { entryId: 'e1', paramKey: 'mix', value: 0.3 });
}

/* ── the final value is always delivered after the last push ──────────────── */
{
  const clock = makeClock();
  const { router, sends } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1);
  clock.tick(1);
  router.push('e1', 'cutoff', 0.2);
  clock.tick(1);
  router.push('e1', 'cutoff', 0.9); // the gesture's actual last value
  assert.equal(router.pendingCount(), 1);

  router.flush();
  assert.equal(sends[sends.length - 1]?.value, 0.9, 'flush delivered the last pushed value, not an intermediate one');
  assert.equal(router.pendingCount(), 0);
}

/* ── commit fires once at idle timeout with the last sent value ───────────── */
{
  const clock = makeClock();
  const { router, sends, commits } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1);
  clock.tick(1);
  router.push('e1', 'cutoff', 0.6);

  clock.tick(250); // idleMs default: quiet from here on
  assert.equal(sends[sends.length - 1]?.value, 0.6, 'the trailing send fired before the idle commit');
  assert.equal(commits.length, 1, 'exactly one commit for the gesture');
  assert.deepEqual(commits[0], { entryId: 'e1', paramKey: 'cutoff', value: 0.6 });

  clock.tick(1000);
  assert.equal(commits.length, 1, 'no repeat commit without a further push');
}

/* ── endGesture flushes and commits immediately, and a second endGesture does
   nothing ──────────────────────────────────────────────────────────────────── */
{
  const clock = makeClock();
  const { router, sends, commits } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1);
  clock.tick(1);
  router.push('e1', 'cutoff', 0.7); // pending; trailing timer armed, not yet fired
  assert.equal(router.pendingCount(), 1);

  router.endGesture('e1', 'cutoff');
  assert.equal(sends[sends.length - 1]?.value, 0.7, 'endGesture flushed the pending value');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], { entryId: 'e1', paramKey: 'cutoff', value: 0.7 });
  assert.equal(router.pendingCount(), 0);

  const sendCountAfterEnd = sends.length;
  router.endGesture('e1', 'cutoff'); // nothing left to end
  assert.equal(commits.length, 1, 'a second endGesture does not commit again');
  assert.equal(sends.length, sendCountAfterEnd, 'and does not send again');

  clock.tick(1000); // the idle timer was cancelled by the first endGesture
  assert.equal(commits.length, 1, 'no delayed commit either');
}

/* ── flush() delivers every pending value across keys ──────────────────────── */
{
  const clock = makeClock();
  const { router, sends, commits } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1);
  router.push('e2', 'mix', 0.2);
  clock.tick(2);
  router.push('e1', 'cutoff', 0.15);
  router.push('e2', 'mix', 0.25);
  assert.equal(router.pendingCount(), 2);

  router.flush();
  assert.equal(router.pendingCount(), 0, 'flush cleared every key');
  assert.equal(commits.length, 0, 'flush never commits');
  const last = sends.slice(-2);
  assert.ok(last.some((s) => s.entryId === 'e1' && s.paramKey === 'cutoff' && s.value === 0.15));
  assert.ok(last.some((s) => s.entryId === 'e2' && s.paramKey === 'mix' && s.value === 0.25));
}

/* ── dispose() cancels without sending or committing and later pushes are
   inert ─────────────────────────────────────────────────────────────────────── */
{
  const clock = makeClock();
  const { router, sends, commits } = makeRouter(clock);
  router.push('e1', 'cutoff', 0.1);
  clock.tick(1);
  router.push('e1', 'cutoff', 0.7); // pending; trailing + idle timers armed
  const sendsBefore = sends.length;

  router.dispose();
  assert.equal(sends.length, sendsBefore, 'dispose does not flush the pending value');
  assert.equal(commits.length, 0, 'dispose does not commit');

  clock.tick(1000); // long past both the interval and the idle window
  assert.equal(sends.length, sendsBefore, 'the cancelled timers never fired');
  assert.equal(commits.length, 0);

  router.push('e1', 'cutoff', 0.9); // inert
  clock.tick(1000);
  assert.equal(sends.length, sendsBefore, 'a push after dispose does nothing');
  assert.equal(commits.length, 0);
  assert.equal(router.pendingCount(), 0);
}

/* ── push rejects a non-finite value and empty ids with RangeError ────────── */
{
  const clock = makeClock();
  const { router } = makeRouter(clock);
  assert.throws(
    () => router.push('e1', 'cutoff', Number.NaN),
    (err: unknown) => err instanceof RangeError && err.message === 'liveParamRouter: value must be a finite number, got NaN',
  );
  assert.throws(
    () => router.push('e1', 'cutoff', Number.POSITIVE_INFINITY),
    (err: unknown) => err instanceof RangeError && err.message === 'liveParamRouter: value must be a finite number, got Infinity',
  );
  assert.throws(
    () => router.push('', 'cutoff', 0.5),
    (err: unknown) => err instanceof RangeError && err.message === 'liveParamRouter: entryId and paramKey must be non-empty',
  );
  assert.throws(
    () => router.push('e1', '', 0.5),
    (err: unknown) => err instanceof RangeError && err.message === 'liveParamRouter: entryId and paramKey must be non-empty',
  );
}

console.log('vstLive/liveParamRouter: ok');
