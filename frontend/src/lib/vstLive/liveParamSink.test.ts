/**
 * vstLive/liveParamSink — the router-facing entry point over a fake lookup, a
 * fake clock and a fake client: no socket, no zustand, no AudioContext.
 *
 * Run: npx tsx src/lib/vstLive/liveParamSink.test.ts
 */
import assert from 'node:assert/strict';

import { createLiveParamSink, setLiveParamCommitSink, type LiveParamSink } from './liveParamSink.ts';
import type { LiveParamLookup } from './liveParamBinding.ts';
import type { LiveParamRouterDeps } from './liveParamRouter.ts';

/** A hand-rolled fake clock, the same shape `liveParamRouter.test.ts` uses:
 *  `now`/`schedule`/`cancel` for the sink's router to use, plus `tick(ms)` to
 *  advance virtual time and fire whatever falls due along the way. */
function makeClock(): Pick<LiveParamRouterDeps, 'now' | 'schedule' | 'cancel'> & { tick(ms: number): void } {
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

interface SetParamCall {
  entryId: string;
  index: number;
  value: number;
}

/** A fake live session + client recording every `setParam` call. `throwNext`
 *  makes the next call throw once, to simulate a dead socket. */
function makeFakeSession(entryId: string, calls: SetParamCall[]) {
  const state = { throwNext: false };
  const session = {
    client: {
      setParam: (index: number, value: number): void => {
        if (state.throwNext) {
          state.throwNext = false;
          throw new Error('dead socket');
        }
        calls.push({ entryId, index, value });
      },
    },
  };
  return { session, throwNextSetParam: () => (state.throwNext = true) };
}

/** A `LiveParamLookup` over a mutable table of sessions/statuses, so a test
 *  can add or drop a live entry without rebuilding the sink. */
function makeLookup(): {
  lookup: LiveParamLookup;
  setLive: (entryId: string, session: ReturnType<typeof makeFakeSession>['session']) => void;
  setOffline: (entryId: string) => void;
} {
  const sessions = new Map<string, ReturnType<typeof makeFakeSession>['session']>();
  const statuses = new Map<string, string>();
  return {
    lookup: {
      getSession: (entryId) => sessions.get(entryId),
      statusOf: (entryId) => ({ status: statuses.get(entryId) ?? 'off' }),
    },
    setLive: (entryId, session) => {
      sessions.set(entryId, session);
      statuses.set(entryId, 'live');
    },
    setOffline: (entryId) => {
      sessions.delete(entryId);
      statuses.set(entryId, 'off');
    },
  };
}

function makeSink(
  clock: ReturnType<typeof makeClock>,
  lookup: LiveParamLookup,
  markParamsChangedCalls: string[],
): LiveParamSink {
  return createLiveParamSink({
    lookup,
    markParamsChanged: (entryId) => markParamsChangedCalls.push(entryId),
    timers: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
  });
}

/* ── push returns false and records nothing when the entry has no live session ── */
{
  const clock = makeClock();
  const { lookup } = makeLookup(); // 'e1' never made live
  const marks: string[] = [];
  const sink = makeSink(clock, lookup, marks);

  const ok = sink.push('e1', 'p0', 0.5);
  assert.equal(ok, false, 'no session for the entry -> false');
  assert.equal(marks.length, 0, 'a rejected push must not mark params changed');
}

/* ── push returns true and the first value reaches setParam immediately ───── */
{
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const marks: string[] = [];
  const sink = makeSink(clock, lookup, marks);

  const ok = sink.push('e1', 'p3', 0.5);
  assert.equal(ok, true, 'a live session resolves -> true');
  assert.equal(calls.length, 1, 'the leading edge sends immediately, no timer needed');
  assert.deepEqual(calls[0], { entryId: 'e1', index: 3, value: 0.5 });
}

/* ── a burst is coalesced to the newest value at about 60 Hz ──────────────── */
{
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  sink.push('e1', 'p0', 0.1); // leading edge, sent now
  clock.tick(2);
  sink.push('e1', 'p0', 0.2); // pending
  clock.tick(2);
  sink.push('e1', 'p0', 0.3); // pending, overwrites 0.2
  clock.tick(2);
  sink.push('e1', 'p0', 0.4); // pending, overwrites 0.3
  assert.equal(calls.length, 1, 'still only the leading-edge send during the burst');

  clock.tick(20); // past the ~16 ms (60 Hz) interval: the trailing timer fires
  assert.equal(calls.length, 2, 'exactly one trailing send followed the leading one');
  assert.equal(calls[1]?.value, 0.4, 'carrying the newest value, not 0.2 or 0.3');
}

/* ── markParamsChanged is called for every accepted push ───────────────────── */
{
  const clock = makeClock();
  const { lookup, setLive, setOffline } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const marks: string[] = [];
  const sink = makeSink(clock, lookup, marks);

  sink.push('e1', 'p0', 0.1);
  clock.tick(2);
  sink.push('e1', 'p0', 0.2);
  clock.tick(2);
  sink.push('e1', 'p0', 0.3);
  assert.equal(marks.length, 3, 'once per accepted push, independent of throttling');

  setOffline('e1');
  sink.push('e1', 'p0', 0.4); // rejected: not live
  assert.equal(marks.length, 3, 'a rejected push adds nothing');
}

/* ── values outside 0..1 are clamped so setParam never sees an illegal value ── */
{
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  sink.push('e1', 'p0', 1.5); // leading edge
  assert.equal(calls[0]?.value, 1, 'clamped to the upper bound before setParam');

  clock.tick(100); // quiet gap: the next push is a fresh leading edge
  sink.push('e1', 'p0', -0.3);
  assert.equal(calls[1]?.value, 0, 'clamped to the lower bound before setParam');
}

/* ── a setParam that throws is swallowed and later pushes still work ──────── */
{
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session, throwNextSetParam } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  throwNextSetParam();
  const ok1 = sink.push('e1', 'p0', 0.5); // leading edge -> send throws, swallowed
  assert.equal(ok1, true, 'push still reports success even though the underlying send threw');
  assert.equal(calls.length, 0, 'the throwing send recorded nothing');

  clock.tick(100); // quiet gap: a fresh leading edge
  const ok2 = sink.push('e1', 'p0', 0.6);
  assert.equal(ok2, true);
  assert.equal(calls.length, 1, 'a later push still reaches setParam');
  assert.equal(calls[0]?.value, 0.6);
}

/* ── the module commit sink receives exactly one commit per gesture ───────── */
{
  setLiveParamCommitSink(null);
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  const commits: { entryId: string; paramKey: string; value: number }[] = [];
  setLiveParamCommitSink((entryId, paramKey, value) => commits.push({ entryId, paramKey, value }));

  sink.push('e1', 'p0', 0.2); // leading edge
  clock.tick(1);
  sink.push('e1', 'p0', 0.6); // pending

  clock.tick(250); // default idleMs: quiet from here on -> flush + commit
  assert.equal(commits.length, 1, 'exactly one commit for the gesture');
  assert.deepEqual(commits[0], { entryId: 'e1', paramKey: 'p0', value: 0.6 });

  clock.tick(1000);
  assert.equal(commits.length, 1, 'no repeat commit without a further push');
  setLiveParamCommitSink(null);
}

/* ── a per-call commit callback wins over the module sink ─────────────────── */
{
  setLiveParamCommitSink(null);
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  const moduleCommits: number[] = [];
  setLiveParamCommitSink((_entryId, _paramKey, value) => moduleCommits.push(value));
  const perCallCommits: number[] = [];

  sink.push('e1', 'p0', 0.3, (value) => perCallCommits.push(value));
  clock.tick(250); // idle timeout

  assert.deepEqual(perCallCommits, [0.3], 'the per-call callback received the gesture value');
  assert.equal(moduleCommits.length, 0, 'the module sink must not also fire');
  setLiveParamCommitSink(null);
}

/* ── endGesture commits immediately with the final value ───────────────────── */
{
  setLiveParamCommitSink(null);
  const clock = makeClock();
  const { lookup, setLive } = makeLookup();
  const calls: SetParamCall[] = [];
  const { session } = makeFakeSession('e1', calls);
  setLive('e1', session);
  const sink = makeSink(clock, lookup, []);

  const commits: number[] = [];
  sink.push('e1', 'p0', 0.2, (value) => commits.push(value)); // leading edge
  clock.tick(1);
  sink.push('e1', 'p0', 0.9, (value) => commits.push(value)); // pending, timers armed but not fired

  sink.endGesture('e1', 'p0');
  assert.equal(calls[calls.length - 1]?.value, 0.9, 'endGesture flushed the pending value first');
  assert.deepEqual(commits, [0.9], 'committed immediately with the final value, not before');
}

console.log('vstLive/liveParamSink: ok');
