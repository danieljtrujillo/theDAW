/**
 * The piano roll's CLICK, replayed the way PianoRoll.tsx's PLAY runs it: a
 * MetronomeScheduler over a fake AudioContext, its transport PLAY's own
 * seconds, its clicks planned by rollClickPlan from the lap clock that
 * startRollPlay / followRollPlay keep, ticked after each 25 ms note window with
 * the notes' 0.12 s lookahead. Every click's start time is read off the fake
 * oscillators and checked against the seconds worked out by hand.
 *
 *   - 7/8 grouped 3+2+2 at 120 in group mode clicks at 0, 0.75 and 1.25 s,
 *     then the next downbeat at 1.75 s, accented on each bar line.
 *   - a loop over one 7/8 bar clicks the same three every lap.
 *   - a ritardando in the tempo map moves the clicks to the ramp's closed-form
 *     seconds while they stay on the bar's group starts.
 *   - a seek re-anchors the lap and the click with it: no click sounds twice,
 *     none is out of order, and the next bar's downbeat lands on its new time.
 *   - a tempo point added during PLAY moves the clicks after it only.
 *   - a count-in in group mode counts one 7/8 bar in its groups, into the step
 *     PLAY starts on, and PLAY's first note and click sound on its downbeat.
 * Run from `frontend/`:
 *   npx tsx src/lib/rollClick.test.ts
 */
import assert from 'node:assert/strict';
import { MetronomeScheduler, type ClickMode, type MetronomeSettings } from './metronome.ts';
import { COUNT_IN_HANDOFF_SEC, rollClickPlan, rollClickSteps, rollPlayOrigin, type RollClick } from './rollClick.ts';
import { followRollPlay, lapAbsAt, lapTimeOf, startRollPlay, stepClock, type RollPlaySource, type RollPlayState } from './rollTempo.ts';
import { playStartLap, rollStepAt, windowOnsets } from './rollTransport.ts';
import type { MeterSegment } from './meterMap.ts';
import type { TempoEvent } from './tempoMap.ts';

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const MAP_78: MeterSegment[] = [{ bar: 0, meter: M78 }];
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const near = (a: number, b: number, eps: number, msg: string): void => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

class FakeParam {
  value = 0;
  setValueAtTime(): FakeParam { return this; }
  linearRampToValueAtTime(): FakeParam { return this; }
}
class FakeGain {
  readonly gain = new FakeParam();
  connect(d: unknown): unknown { return d; }
  disconnect(): void {}
}
class FakeOsc {
  type = '';
  readonly frequency = new FakeParam();
  startedAt: number | null = null;
  stopped = false;
  connect(d: unknown): unknown { return d; }
  disconnect(): void {}
  start(t: number): void { this.startedAt = t; }
  stop(t: number): void { if (this.startedAt !== null && t <= this.startedAt) this.stopped = true; }
}
class FakeCtx {
  currentTime = 0;
  state = 'running';
  readonly oscs: FakeOsc[] = [];
  createOscillator(): FakeOsc { const o = new FakeOsc(); this.oscs.push(o); return o; }
  createGain(): FakeGain { return new FakeGain(); }
}

interface Rig {
  ctx: FakeCtx;
  roll: RollPlaySource & { meterMap: MeterSegment[]; pickupSteps: number };
  mode: ClickMode;
  sched: MetronomeScheduler;
  /** Start PLAY as the play effect does: step 0 at rollPlayOrigin (60 ms ahead, or a counted downbeat still ahead). */
  play: (countedDownbeat?: number) => void;
  /** Advance the ctx to `until`, ticking every 25 ms like the roll's scheduler. */
  run: (until: number) => void;
  /** Sounding clicks, in scheduled order: [ctx seconds, accented]. */
  heard: () => Array<[number, boolean]>;
  origin: () => number;
  timers: Array<() => void>;
}

function rig(roll: Rig['roll'], mode: ClickMode): Rig {
  const ctx = new FakeCtx();
  const settings: MetronomeSettings = { enabled: true, volume: 1, accent: true, countInBars: 0 };
  let state: RollPlayState | null = null;
  let origin = 0;
  let cursor = -1e-4;
  let clicks: { of: unknown[]; list: RollClick[] } | null = null;
  const timers: Array<() => void> = [];
  const r: Rig = {
    ctx,
    roll,
    mode,
    timers,
    origin: () => origin,
    sched: new MetronomeScheduler({
      ctx: () => ctx as unknown as BaseAudioContext,
      destination: () => new FakeGain() as unknown as AudioNode,
      settings: () => settings,
      transportSec: () => (state ? ctx.currentTime - origin : 0),
      tempoMap: () => stepClock(roll.bpm, roll.tempoMap).map,
      meterMap: () => roll.meterMap,
      clickOpts: () => ({ mode: r.mode, pickupSteps: roll.pickupSteps }),
      lookaheadSec: 0.12,
      plan: (from, until) => {
        if (!state) return [];
        const of = [roll.meterMap, roll.pickupSteps, roll.totalSteps, r.mode];
        if (!clicks || clicks.of.some((v, i) => v !== of[i])) clicks = { of, list: rollClickSteps(roll.meterMap, roll.pickupSteps, roll.totalSteps, r.mode) };
        return rollClickPlan(state.clock, origin, clicks.list, from, until);
      },
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => undefined,
    }),
    play: (countedDownbeat) => {
      origin = rollPlayOrigin(ctx.currentTime, countedDownbeat);
      state = startRollPlay(roll, origin);
      cursor = -1e-4;
      r.sched.start();
    },
    run: (until) => {
      while (ctx.currentTime < until - 1e-9) {
        ctx.currentTime = round(ctx.currentTime + 0.025);
        if (!state) continue;
        state = followRollPlay(state, roll, cursor);
        // The notes' window: the cursor moves to the lookahead's absolute step.
        cursor = Math.max(cursor, lapAbs(state, ctx.currentTime + 0.12));
        r.sched.tick();
      }
    },
    heard: () => ctx.oscs.filter((o) => !o.stopped).map((o) => [round(o.startedAt ?? NaN), o.frequency.value > 1200]),
  };
  return r;
}

/** The absolute step sounding at `time`, through the play state's lap clock. */
const lapAbs = (s: RollPlayState, time: number): number => lapAbsAt(s.clock, time);

const baseRoll = (over: Partial<Rig['roll']> = {}): Rig['roll'] => ({
  currentStep: 0,
  seekId: 0,
  loop: null,
  loopOn: false,
  totalSteps: 28,
  bpm: 120,
  tempoMap: [{ beat: 0, bpm: 120 }],
  meterMap: MAP_78,
  pickupSteps: 0,
  ...over,
});

// The click steps: each bar's group starts, the downbeats accented.
assert.deepEqual(rollClickSteps(MAP_78, 0, 28, 'group'), [
  { step: 0, accent: true }, { step: 6, accent: false }, { step: 10, accent: false },
  { step: 14, accent: true }, { step: 20, accent: false }, { step: 24, accent: false },
]);

// 3+2+2 at 120: a 16th is 0.125 s, so the groups are 0.75, 0.5 and 0.5 s long.
{
  const r = rig(baseRoll(), 'group');
  r.ctx.currentTime = 10;
  r.play();
  r.run(13.5);
  const o = r.origin();
  assert.deepEqual(r.heard(), [
    [round(o), true], [round(o + 0.75), false], [round(o + 1.25), false],
    [round(o + 1.75), true], [round(o + 2.5), false], [round(o + 3), false],
    // The roll is 28 steps long, so the lap starts over at 3.5 s.
    [round(o + 3.5), true],
  ]);
}

// A loop over bar 2 plays the same three clicks every lap.
{
  const r = rig(baseRoll({ currentStep: 14, loop: { start: 14, end: 28 }, loopOn: true }), 'group');
  r.ctx.currentTime = 5;
  r.play();
  r.run(5 + 1.75 * 3 - 0.2);
  const o = r.origin();
  const lap = [0, 0.75, 1.25];
  assert.deepEqual(r.heard().map(([t]) => t), [0, 1, 2].flatMap((k) => lap.map((x) => round(o + k * 1.75 + x))));
  assert.deepEqual(r.heard().map(([, a]) => a), [true, false, false, true, false, false, true, false, false]);
}

// A ritardando over bar 1 (120 down to 60 across its 3.5 quarter notes): each click at the
// ramp's closed-form seconds, t(b) = 60 B / (v1 - v0) ln(1 + (v1 - v0) b / (B v0)).
{
  const tempoMap: TempoEvent[] = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 3.5, bpm: 60 }];
  const r = rig(baseRoll({ tempoMap }), 'group');
  r.ctx.currentTime = 1;
  r.play();
  r.run(5);
  const o = r.origin();
  const t = (b: number): number => ((60 * 3.5) / (60 - 120)) * Math.log(1 + ((60 - 120) * b) / (3.5 * 120));
  const heard = r.heard().map(([s]) => s);
  assert.deepEqual(heard.slice(0, 4), [0, 1.5, 2.5, 3.5].map((b) => round(o + t(b))), 'the groups slow down with the ramp');
  // Bar 2 runs at 60: its groups are 1.5 and 1 s long.
  assert.equal(heard[4], round(o + t(3.5) + 1.5));
}

// A seek to bar 2 mid-bar-1: the click follows the new place, once each, in order.
{
  const roll = baseRoll();
  const r = rig(roll, 'group');
  r.ctx.currentTime = 2;
  r.play();
  r.run(2.5);
  roll.currentStep = 14;
  roll.seekId = 1;
  r.run(4.5);
  const heard = r.heard().map(([s]) => s);
  for (let i = 1; i < heard.length; i += 1) assert.ok(heard[i] > heard[i - 1], `click ${i} is after the one before (${heard.join(', ')})`);
  // Before the seek (0.44 s into bar 1, lookahead 0.12 s) only bar 1's downbeat was scheduled.
  const o = r.origin();
  assert.equal(heard[0], round(o), 'the downbeat before the seek');
  // After it, bar 2 plays from its start: its downbeat accented, then its groups 0.75 and 1.25 s later.
  const accented = r.heard().filter(([, a]) => a).map(([s]) => s);
  assert.equal(accented.length, 3, 'the first downbeat, bar 2 after the seek, and bar 1 when the lap starts over');
  const bar2 = accented[1];
  const after = heard.filter((s) => s > bar2);
  near(after[0], bar2 + 0.75, 2e-6, 'the first group after the seek');
  near(after[1], bar2 + 1.25, 2e-6, 'the second group after the seek');
  assert.ok(bar2 < 2.5 + 0.2, 'bar 2 starts right after the seek');
  near(accented[2], bar2 + 1.75, 2e-6, 'the lap starts over a bar later');
}

// A tempo point added during PLAY moves the clicks after it; the ones already scheduled stay.
{
  const roll = baseRoll();
  const r = rig(roll, 'group');
  r.ctx.currentTime = 0;
  r.play();
  r.run(1.0);
  roll.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 3.5, bpm: 60 }];
  r.run(4.5);
  const o = r.origin();
  const heard = r.heard().map(([s]) => s);
  assert.deepEqual(heard.slice(0, 4), [0, 0.75, 1.25, 1.75].map((x) => round(o + x)), 'bar 1 as it was');
  // Bar 2 at 60: groups of 1.5 and 1 s.
  assert.deepEqual(heard.slice(4, 6), [round(o + 1.75 + 1.5), round(o + 1.75 + 2.5)]);
}

// The count-in: one bar of 7/8 in its groups, into the step PLAY starts on.
{
  const roll = baseRoll({ currentStep: 14 });
  const r = rig(roll, 'group');
  r.ctx.currentTime = 3;
  let released = false;
  const startStep = rollStepAt(playStartLap(roll).lap, 0);
  assert.equal(startStep, 14);
  r.sched.countIn(1, () => { released = true; }, stepClock(roll.bpm, roll.tempoMap).at(startStep));
  const starts = r.ctx.oscs.map((x) => round(x.startedAt ?? NaN));
  assert.deepEqual(starts, [round(3.02), round(3.02 + 0.75), round(3.02 + 1.25)]);
  assert.deepEqual(r.ctx.oscs.map((x) => x.frequency.value > 1200), [true, false, false]);
  r.ctx.currentTime = 3.02 + 1.75 - 0.01;
  r.timers[0]();
  assert.equal(released, false, 'PLAY waits for the bar to end');
  r.ctx.currentTime = 3.02 + 1.75;
  r.timers[0]();
  assert.equal(released, true, 'PLAY starts on the next downbeat');
}

// Count-in then PLAY, as PianoRoll.tsx runs them: the count hands over
// COUNT_IN_HANDOFF_SEC before its downbeat, the render that starts PLAY takes a
// while, and PLAY's first note and running click still sound on the downbeat.
{
  const roll = baseRoll({ currentStep: 14 });
  const r = rig(roll, 'group');
  r.ctx.currentTime = 3;
  let downbeat: number | undefined;
  let calls = 0;
  const startStep = rollStepAt(playStartLap(roll).lap, 0);
  r.sched.countIn(1, (at) => { calls += 1; downbeat = at; }, stepClock(roll.bpm, roll.tempoMap).at(startStep), COUNT_IN_HANDOFF_SEC);
  const counted = 3.02 + 1.75;
  r.ctx.currentTime = counted - COUNT_IN_HANDOFF_SEC - 0.01;
  r.timers[0]();
  assert.equal(calls, 0, 'the handover waits for its lead');
  r.ctx.currentTime = counted - COUNT_IN_HANDOFF_SEC + 0.004;
  r.timers[0]();
  r.timers[0]();
  assert.equal(calls, 1, 'the handover happens once');
  near(downbeat ?? NaN, counted, 1e-9, 'it reports the counted downbeat');
  // The render that sets PLAY going.
  r.ctx.currentTime += 0.04;
  r.play(downbeat);
  near(r.origin(), counted, 1e-9, 'PLAY anchors step 0 on the counted downbeat');
  // The play effect's first window, over the roll's notes on steps 14 and 20.
  const notes = [{ id: 'a', note: 60, step: 14, length: 2, velocity: 90 }, { id: 'b', note: 62, step: 20, length: 2, velocity: 90 }];
  const state = startRollPlay(roll, r.origin());
  const first = windowOnsets(notes, state.clock.lap, -1e-4, lapAbsAt(state.clock, r.ctx.currentTime + 0.12));
  assert.equal(first.length, 1, 'the first window holds the note on the downbeat');
  near(Math.max(r.ctx.currentTime, lapTimeOf(state.clock, first[0].abs)), counted, 1e-9, 'the first note sounds on the counted downbeat');
  r.run(counted + 1.3);
  const heard = r.heard();
  assert.deepEqual(heard.map(([t]) => t), [3.02, 3.77, 4.27, counted, counted + 0.75, counted + 1.25].map(round), 'the count, then the bar in its groups, none twice');
  assert.deepEqual(heard.map(([, a]) => a), [true, false, false, true, false, false], 'the counted downbeat is the accent of the running click');
}

// A handover so late the downbeat has passed starts PLAY 60 ms from then.
{
  near(rollPlayOrigin(5, 4.99), 5.06, 1e-9, 'a passed downbeat falls back');
  near(rollPlayOrigin(5, null), 5.06, 1e-9, 'no count-in');
  near(rollPlayOrigin(5, 5.05), 5.05, 1e-9, 'a downbeat still ahead');
}

console.log('rollClick: ok');
