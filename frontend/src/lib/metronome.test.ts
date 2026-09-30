/**
 * metronome — the click grid's arithmetic and the rolling-lookahead scheduler,
 * driven by a fake AudioContext whose `currentTime` the test advances by hand.
 *
 * Every number below is derived from `tempoMap.ts` / `meterMap.ts` by hand and
 * pinned exactly (`assert.deepEqual` on the arrays, not a tolerance), so a
 * change in the click grid has to be argued for rather than absorbed.
 */
import assert from 'node:assert/strict';
import {
  CLICK_LEAD_SEC,
  COUNT_IN_POLL_MS,
  MetronomeScheduler,
  METRONOME_LOOKAHEAD_SEC,
  METRONOME_RESYNC_SEC,
  asClickMode,
  barClicks,
  clicksInWindow,
  countInClicks,
  type ClickMode,
  type MetronomeSettings,
} from './metronome.ts';
import type { MeterSegment } from './meterMap.ts';
import type { TempoEvent } from './tempoMap.ts';

const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };

const MAP_44: MeterSegment[] = [{ bar: 0, meter: M44 }];
const MAP_78: MeterSegment[] = [{ bar: 0, meter: M78 }];
/** 4/4 until bar 2, then 7/8 — the meter change the scheduler has to walk. */
const MAP_CHANGE: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }];

const T120: TempoEvent[] = [{ beat: 0, bpm: 120 }];
/** 120 bpm for one bar of 4/4, then half speed. */
const T_CHANGE: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }];

const round = (n: number): number => Math.round(n * 1e9) / 1e9;
const times = (cs: { sec: number }[]): number[] => cs.map((c) => round(c.sec));
const beats = (cs: { beat: number }[]): number[] => cs.map((c) => round(c.beat));
const accents = (cs: { accent: boolean }[]): boolean[] => cs.map((c) => c.accent);

/* ------------------------------ the click grid ----------------------------- */

// Constant tempo, 4/4: a click on every quarter note, accent on beat 1.
{
  const cs = clicksInWindow(T120, MAP_44, 0, 2);
  assert.deepEqual(beats(cs), [0, 1, 2, 3, 4]);
  assert.deepEqual(times(cs), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(accents(cs), [true, false, false, false, true]);
}

// A window that starts mid-bar emits only the clicks inside it (both ends
// inclusive), and keeps the accent flag of the bar it lands in.
{
  const cs = clicksInWindow(T120, MAP_44, 1.25, 2.25);
  assert.deepEqual(beats(cs), [3, 4]);
  assert.deepEqual(times(cs), [1.5, 2]);
  assert.deepEqual(accents(cs), [false, true]);
}

// Across a tempo change: 60/120 = 0.5 s per beat until beat 4, 1 s after it.
{
  const cs = clicksInWindow(T_CHANGE, MAP_44, 0, 5);
  assert.deepEqual(beats(cs), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(times(cs), [0, 0.5, 1, 1.5, 2, 3, 4, 5]);
  assert.deepEqual(accents(cs), [true, false, false, false, true, false, false, false]);
}

// Across a meter change. A 7/8 bar is 3.5 quarter notes, so the grid is laid
// out FROM EACH BAR LINE: bar 2 starts at beat 8 and holds 8, 9, 10, 11; bar 3
// starts at 11.5. That is what puts a click — and the accent — on every
// downbeat, 3.5 beats apart, instead of letting a global quarter-note grid
// walk past the bar line.
{
  const cs = clicksInWindow(T120, MAP_CHANGE, 0, 8);
  assert.deepEqual(beats(cs), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11.5, 12.5, 13.5, 14.5, 15, 16]);
  assert.deepEqual(
    cs.filter((c) => c.accent).map((c) => round(c.beat)),
    [0, 4, 8, 11.5, 15],
    '7/8 accents every 3.5 beats once the meter changes',
  );
  // Seconds are the tempo map's, so at 120 bpm every beat is half a second.
  assert.deepEqual(times(cs).slice(0, 5), [0, 0.5, 1, 1.5, 2]);
  assert.equal(round(cs[cs.length - 1].sec), 8);
}

// An empty window emits nothing, and a backwards one cannot loop forever.
{
  assert.deepEqual(clicksInWindow(T120, MAP_44, 0.6, 0.9), []);
  assert.deepEqual(clicksInWindow(T120, MAP_44, 2, 1), []);
}

/* -------------------------------- count-in -------------------------------- */

// Two bars of 4/4 at 120 bpm = 8 clicks over 4 s, ending exactly at the start
// point, accented on each count-in downbeat.
{
  const { clicks, durationSec } = countInClicks(T120, MAP_44, 4, 2);
  assert.equal(clicks.length, 8);
  assert.equal(round(durationSec), 4);
  assert.deepEqual(beats(clicks), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(times(clicks), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  assert.deepEqual(accents(clicks), [true, false, false, false, true, false, false, false]);
}

// One bar of 7/8 is 3.5 quarter notes: four clicks, 1.75 s, still landing on
// the start point.
{
  const { clicks, durationSec } = countInClicks(T120, MAP_78, 4, 1);
  assert.equal(round(durationSec), 1.75);
  assert.deepEqual(beats(clicks), [4.5, 5.5, 6.5, 7.5]);
  assert.deepEqual(times(clicks), [2.25, 2.75, 3.25, 3.75]);
  assert.deepEqual(accents(clicks), [true, false, false, false]);
}

// Counting in from 0 walks the tempo map backwards past beat 0 rather than
// clamping, so the count-in is a whole bar wherever the playhead sits.
{
  const { clicks, durationSec } = countInClicks(T120, MAP_44, 0, 1);
  assert.equal(round(durationSec), 2);
  assert.deepEqual(beats(clicks), [-4, -3, -2, -1]);
  assert.deepEqual(times(clicks), [-2, -1.5, -1, -0.5]);
}

// No count-in asked for is no clicks and no delay.
{
  const { clicks, durationSec } = countInClicks(T120, MAP_44, 4, 0);
  assert.deepEqual(clicks, []);
  assert.equal(durationSec, 0);
}

/* ------------------------------- click modes ------------------------------- */

// Each bar's clicks in steps from its bar line: quarters, group starts, dotted quarters.
{
  const at = (m: { num: number; den: number; groups: number[] }, mode: ClickMode) => barClicks(m, mode).map((c) => c.at);
  assert.deepEqual(at(M78, 'group'), [0, 6, 10], '7/8 3+2+2 clicks its three group starts');
  assert.deepEqual(at({ num: 11, den: 16, groups: [3, 3, 3, 2] }, 'group'), [0, 3, 6, 9], '11/16 3+3+3+2');
  assert.deepEqual(at({ num: 5, den: 4, groups: [2, 3] }, 'group'), [0, 8], '5/4 2+3');
  assert.deepEqual(at({ num: 12, den: 8, groups: [] }, 'group'), [0, 6, 12, 18], '12/8 without groups clicks its dotted quarters');
  assert.deepEqual(at({ num: 7, den: 32, groups: [3, 2, 2] }, 'group'), [0, 1.5, 2.5], '7/32 groups land between steps, exactly');
  assert.deepEqual(at(M44, 'group'), [0, 4, 8, 12], 'a simple meter without groups clicks its written beat');
  assert.deepEqual(at({ num: 7, den: 8, groups: [] }, 'group'), [0, 2, 4, 6, 8, 10, 12], '7/8 without groups clicks its 8ths');
  assert.deepEqual(at(M44, 'dotted'), [0, 6, 12], '4/4 in dotted quarters: 1, 2-and, 4');
  assert.deepEqual(at({ num: 6, den: 8, groups: [] }, 'dotted'), [0, 6], '6/8 in dotted quarters');
  assert.deepEqual(at(M78, 'quarter'), [0, 4, 8, 12], 'quarters from the bar line');
  assert.deepEqual(barClicks(M78, 'group').map((c) => c.accent), [true, false, false], 'the downbeat is the accent');
  assert.equal(asClickMode('group'), 'group');
  assert.equal(asClickMode('swing'), 'quarter', 'a mode the app does not have reads as quarters');
}

// The window in group mode: 3+2+2 at 120 is 0.75 s, 0.5 s, 0.5 s, and the next downbeat.
{
  const cs = clicksInWindow(T120, MAP_78, 0, 1.75, { mode: 'group' });
  assert.deepEqual(beats(cs), [0, 1.5, 2.5, 3.5]);
  assert.deepEqual(times(cs), [0, 0.75, 1.25, 1.75]);
  assert.deepEqual(accents(cs), [true, false, false, true]);
  // Across the 4/4 -> 7/8 change the grid changes with the bar.
  const change = clicksInWindow(T120, MAP_CHANGE, 3.5, 6, { mode: 'group' });
  assert.deepEqual(beats(change), [7, 8, 9.5, 10.5, 11.5]);
  // Dotted quarters in 4/4: every bar line starts them again.
  assert.deepEqual(beats(clicksInWindow(T120, MAP_44, 0, 2.75, { mode: 'dotted' })), [0, 1.5, 3, 4, 5.5]);
}

// A pickup: its clicks count back from its end, unaccented, and bar 1 starts after it.
{
  const cs = clicksInWindow(T120, MAP_44, 0, 2.5, { pickupSteps: 4 });
  assert.deepEqual(beats(cs), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(accents(cs), [false, true, false, false, false, true]);
  // The pickup is the last four steps of a 7/8 bar, which start its second 2-group.
  const grouped = clicksInWindow(T120, MAP_78, 0, 1.5, { mode: 'group', pickupSteps: 4 });
  assert.deepEqual(beats(grouped), [0, 1, 2.5]);
  assert.deepEqual(accents(grouped), [false, true, false]);
}

// A count-in in group mode is whole bars of the meter at the start point, in its groups.
{
  const { clicks, durationSec } = countInClicks(T120, MAP_78, 4, 1, { mode: 'group' });
  assert.equal(round(durationSec), 1.75);
  assert.deepEqual(beats(clicks), [4.5, 6, 7]);
  assert.deepEqual(times(clicks), [2.25, 3, 3.5]);
  assert.deepEqual(accents(clicks), [true, false, false]);
}

/* ---------------------- a fake AudioContext for the rest ------------------- */

interface Ramp { kind: 'set' | 'ramp'; value: number; time: number }

class FakeParam {
  value = 0;
  readonly events: Ramp[] = [];
  setValueAtTime(value: number, time: number): FakeParam { this.events.push({ kind: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number): FakeParam { this.events.push({ kind: 'ramp', value, time }); return this; }
  cancelScheduledValues(): FakeParam { return this; }
}

class FakeGain {
  readonly gain = new FakeParam();
  connected: unknown = null;
  disconnected = false;
  connect(dest: unknown): unknown { this.connected = dest; return dest; }
  disconnect(): void { this.disconnected = true; }
}

class FakeOsc {
  type = '';
  readonly frequency = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  disconnected = false;
  connect(dest: unknown): unknown { return dest; }
  disconnect(): void { this.disconnected = true; }
  start(t: number): void { this.startedAt = t; }
  stop(t: number): void { this.stoppedAt = t; }
}

class FakeCtx {
  currentTime = 0;
  /** 'running' unless a test is exercising the first-gesture resume path. */
  state: 'suspended' | 'running' | 'closed' = 'running';
  resumeCalls = 0;
  /** Set to reject the resume, to exercise the "start anyway" branch. */
  resumeFails = false;
  readonly oscs: FakeOsc[] = [];
  readonly gains: FakeGain[] = [];
  createOscillator(): FakeOsc { const o = new FakeOsc(); this.oscs.push(o); return o; }
  createGain(): FakeGain { const g = new FakeGain(); this.gains.push(g); return g; }
  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeFails) return Promise.reject(new Error('blocked'));
    this.state = 'running';
    return Promise.resolve();
  }
}

/** Let every pending microtask (a resume chain) settle. */
const settle = (): Promise<void> => Promise.resolve().then(() => undefined).then(() => undefined);

const SETTINGS: MetronomeSettings = { enabled: true, volume: 0.8, accent: true, countInBars: 0 };

interface Rig {
  ctx: FakeCtx;
  out: FakeGain;
  sched: MetronomeScheduler;
  settings: MetronomeSettings;
  transport: { sec: number };
  timers: { fn: () => void; ms: number; id: number }[];
  /** Start times of every click scheduled so far, in order. */
  starts: () => number[];
  /** True for every click whose oscillator carries the accent pitch. */
  accented: () => boolean[];
}

function rig(opts: {
  tempo?: TempoEvent[];
  meter?: MeterSegment[];
  settings?: Partial<MetronomeSettings>;
  startSec?: number;
} = {}): Rig {
  const ctx = new FakeCtx();
  const out = new FakeGain();
  const transport = { sec: opts.startSec ?? 0 };
  const settings: MetronomeSettings = { ...SETTINGS, ...opts.settings };
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const sched = new MetronomeScheduler({
    ctx: () => ctx as unknown as BaseAudioContext,
    destination: () => out as unknown as AudioNode,
    transportSec: () => transport.sec,
    tempoMap: () => opts.tempo ?? T120,
    meterMap: () => opts.meter ?? MAP_44,
    settings: () => settings,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    ctx,
    out,
    sched,
    settings,
    transport,
    timers,
    starts: () => ctx.oscs.map((o) => round(o.startedAt ?? NaN)),
    accented: () => ctx.oscs.map((o) => o.frequency.value > 1200),
  };
}

/* ------------------------------- the scheduler ----------------------------- */

// A fresh start schedules exactly the clicks inside the lookahead window, at
// the ctx-time image of their transport time, and nothing beyond it.
{
  assert.equal(METRONOME_LOOKAHEAD_SEC, 0.25);
  const r = rig();
  r.ctx.currentTime = 10;
  r.sched.start();
  // Transport 0 maps to ctx 10. Only beat 0 falls inside the window 10 .. 10.25;
  // beat 1 is at transport 0.5 s, i.e. ctx 10.5, which is beyond it.
  assert.deepEqual(r.starts(), [10]);
  r.sched.tick();
  assert.deepEqual(r.starts(), [10], 'a tick with no time elapsed adds nothing');

  r.ctx.currentTime = 10.3;
  r.transport.sec = 0.3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [10, 10.5], 'beat 1 enters the window');

  // Beat 2 is at transport 1.0, so it only enters the window from 0.75 on —
  // the lookahead is a window, not a horizon.
  r.ctx.currentTime = 10.6;
  r.transport.sec = 0.6;
  r.sched.tick();
  assert.deepEqual(r.starts(), [10, 10.5], 'beat 2 is still 0.4 s beyond the window');

  r.ctx.currentTime = 10.8;
  r.transport.sec = 0.8;
  r.sched.tick();
  assert.deepEqual(r.starts(), [10, 10.5, 11]);
  assert.deepEqual(r.accented(), [true, false, false]);
}

// The click is routed click-gain -> metronome gain -> destination, and the
// metronome gain carries the store's volume.
{
  const r = rig({ settings: { volume: 0.4 } });
  r.sched.start();
  const bus = r.ctx.gains[0];
  assert.equal(round(bus.gain.value), 0.4);
  assert.equal(bus.connected, r.out);
  assert.equal(r.ctx.gains[1].connected, bus, 'the click envelope feeds the metronome bus');
}

// accent: false flattens the pitch — every click is the plain one.
{
  const r = rig({ settings: { accent: false } });
  r.sched.start();
  r.ctx.currentTime = 0.3;
  r.transport.sec = 0.3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [0, 0.5]);
  assert.equal(r.accented().some(Boolean), false, 'the downbeat keeps the plain pitch');
}

// enabled: false schedules nothing at all.
{
  const r = rig({ settings: { enabled: false } });
  r.sched.start();
  r.ctx.currentTime = 1;
  r.transport.sec = 1;
  r.sched.tick();
  assert.deepEqual(r.starts(), []);
}

// No beat is ever scheduled twice, however often the interval fires.
{
  const r = rig();
  r.sched.start();
  for (let i = 0; i < 12; i += 1) r.sched.tick();
  r.ctx.currentTime = 0.3;
  r.transport.sec = 0.3;
  for (let i = 0; i < 12; i += 1) r.sched.tick();
  assert.deepEqual(r.starts(), [0, 0.5]);
}

// A LATE tick (the tab was throttled) must not schedule beats that are already
// behind the context clock — it picks up from the present instead.
{
  const r = rig();
  r.sched.start();
  assert.deepEqual(r.starts(), [0]);
  r.ctx.currentTime = 3;
  r.transport.sec = 3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [0, 3], 'beats 1..5 are skipped, not fired late');
  assert.equal(r.ctx.oscs.every((o) => (o.startedAt ?? 0) >= 0), true);
}

// The mute hook is the extension point the "click while recording only" mode
// will hang off: it is asked about every candidate click and vetoes it without
// disturbing the beat cursor or the window.
{
  const muted: number[] = [];
  const r = rig();
  r.sched.setMuteTest((sec) => { muted.push(round(sec)); return sec >= 0.5; });
  r.sched.start();
  r.ctx.currentTime = 0.3;
  r.transport.sec = 0.3;
  r.sched.tick();
  r.ctx.currentTime = 0.8;
  r.transport.sec = 0.8;
  r.sched.tick();
  assert.deepEqual(muted, [0, 0.5, 1], 'every candidate beat is offered to the hook');
  assert.deepEqual(r.starts(), [0], 'the vetoed beats are silent');
}

// A seek past the resync tolerance drops the scheduled window: the clicks that
// had been queued for the old position are stopped and the grid restarts from
// the new one.
{
  assert.equal(METRONOME_RESYNC_SEC, 0.05);
  const r = rig();
  r.ctx.currentTime = 5;
  r.sched.start();
  r.ctx.currentTime = 5.3;
  r.transport.sec = 0.3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [5, 5.5]);
  const queued = r.ctx.oscs[1];

  // Jump the transport to 8.0 without moving the context clock.
  r.transport.sec = 8;
  r.sched.tick();
  assert.equal(queued.stoppedAt, 5.3, 'the click queued for the old position is cancelled');
  // Beat 16 is at transport 8.0, which is now ctx 5.3; beat 17 at 5.8 is outside
  // the 0.25 s window.
  assert.deepEqual(r.starts(), [5, 5.5, 5.3]);
  assert.deepEqual(r.accented(), [true, false, true], 'transport 8.0 is beat 16, a downbeat');

  r.ctx.currentTime = 5.6;
  r.transport.sec = 8.3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [5, 5.5, 5.3, 5.8]);
}

// A FROZEN transport report is a stall, not a seek. `currentTransportSec()`
// clamps to the project duration and liveMixer only ends playback from its rAF
// frame, so a song that runs off its end in a hidden tab (rAF parked, this
// interval still firing) reports the same second forever while ctx.currentTime
// keeps moving. Every tick trips the resync — and before the stall check, every
// tick re-anchored, dropped the cursor and re-scheduled the SAME beats: a click
// repeating once a second, after the song ended, until the tab came back.
{
  const r = rig({ startSec: 10 });
  r.sched.start();
  assert.deepEqual(r.starts(), [0], 'transport 10.0 is beat 20, on the window edge');
  // Four ticks, 0.1 s of context each, transport pinned at 10.0.
  for (const t of [0.1, 0.2, 0.3, 0.4]) {
    r.ctx.currentTime = t;
    r.sched.tick();
  }
  assert.deepEqual(r.starts(), [0], 'a stalled transport schedules nothing at all');
  // Its natural end (0 + CLICK_LENGTH_SEC + 0.02), not a tick time — so the
  // stall re-anchored without running cancelPending over the queue.
  assert.equal(round(r.ctx.oscs[0].stoppedAt ?? NaN), 0.05);

  // A real seek still restarts the window from the new position.
  r.transport.sec = 20;
  r.sched.tick();
  assert.deepEqual(r.starts(), [0, 0.4], 'a moving transport is a seek again');
  assert.deepEqual(r.accented(), [true, true], 'transport 20.0 is beat 40, a downbeat');
}

// A drift smaller than the tolerance is absorbed, not treated as a seek.
{
  const r = rig();
  r.sched.start();
  r.ctx.currentTime = 0.3;
  r.transport.sec = 0.3 + METRONOME_RESYNC_SEC / 2;
  r.sched.tick();
  assert.deepEqual(r.starts(), [0, 0.5], 'still on the original anchor');
}

// stop() cancels the pending clicks and every later tick is inert.
{
  const r = rig();
  r.ctx.currentTime = 2;
  r.sched.start();
  r.ctx.currentTime = 2.3;
  r.transport.sec = 0.3;
  r.sched.tick();
  assert.deepEqual(r.starts(), [2, 2.5]);
  r.sched.stop();
  assert.equal(r.ctx.oscs[1].stoppedAt, 2.3);
  assert.equal(r.ctx.oscs[1].disconnected, true);
  r.ctx.currentTime = 3;
  r.transport.sec = 1;
  r.sched.tick();
  assert.deepEqual(r.starts(), [2, 2.5], 'a tick after stop schedules nothing');
}

/* ---------------------- count-in through the scheduler --------------------- */

// Two bars at 120 bpm: eight clicks up front, then the transport is released —
// not before. Nothing touches the transport during the count.
{
  assert.equal(CLICK_LEAD_SEC, 0.02);
  const r = rig({ settings: { countInBars: 2 }, startSec: 4 });
  r.ctx.currentTime = 100;
  let started = 0;
  r.sched.countIn(2, () => { started += 1; });
  assert.equal(started, 0, 'the transport does not start during the count-in');
  assert.deepEqual(
    r.starts(),
    [100.02, 100.52, 101.02, 101.52, 102.02, 102.52, 103.02, 103.52],
    'eight clicks, a lead in front, ending where the transport starts',
  );
  assert.deepEqual(r.accented(), [true, false, false, false, true, false, false, false]);

  // The release rides the AUDIO clock, not wall-clock: the poll fires at its
  // own rate and does nothing until ctx.currentTime reaches the target, so a
  // late timer cannot start the transport off the beat just counted.
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, COUNT_IN_POLL_MS);
  const poll = r.timers[0].fn;
  poll();
  assert.equal(started, 0, 'polled at ctx 100, target is 104.02');
  r.ctx.currentTime = 104.019;
  poll();
  assert.equal(started, 0, 'a hair short is still short');
  r.ctx.currentTime = 104.02;
  poll();
  assert.equal(started, 1, 'released when the audio clock arrives');
  assert.equal(r.timers.length, 0, 'and the poll stops itself');
  poll();
  assert.equal(started, 1, 'a stray poll after release does nothing');
}

// Cancelling a count-in stops its clicks and never releases the transport.
{
  const r = rig({ settings: { countInBars: 1 } });
  let started = 0;
  const cancel = r.sched.countIn(1, () => { started += 1; });
  assert.equal(r.ctx.oscs.length, 4);
  cancel();
  assert.equal(started, 0);
  assert.deepEqual(r.ctx.oscs.map((o) => o.disconnected), [true, true, true, true]);
  assert.equal(r.timers.length, 0, 'the release timer is cleared');
}

// countIn(0) releases the transport immediately, with no clicks and no timer.
{
  const r = rig();
  let started = 0;
  r.sched.countIn(0, () => { started += 1; });
  assert.equal(started, 1);
  assert.equal(r.ctx.oscs.length, 0);
  assert.equal(r.timers.length, 0);
}

// A count-in is the metronome speaking, so with the metronome OFF there is no
// count and no wait: a persisted countInBars must not sit four silent seconds
// in front of every play with nothing on screen to explain it.
{
  const r = rig({ settings: { enabled: false, countInBars: 1 } });
  let started = 0;
  r.sched.countIn(1, () => { started += 1; });
  assert.equal(r.ctx.oscs.length, 0, 'nothing is scheduled');
  assert.equal(r.timers.length, 0, 'and nothing is waited on');
  assert.equal(started, 1, 'the transport goes straight in');
}

// The session's first interaction can find the engine context still suspended
// (playerStore arms its resume from a window listener, which runs after React's
// handler). Scheduling against a stopped clock would put the whole count in the
// past and fire it as one burst on resume, so the context is resumed first.
{
  const r = rig({ settings: { countInBars: 1 } });
  r.ctx.state = 'suspended';
  r.ctx.currentTime = 50;
  let started = 0;
  r.sched.countIn(1, () => { started += 1; });
  assert.equal(r.ctx.oscs.length, 0, 'nothing is scheduled against a stopped clock');
  assert.equal(r.ctx.resumeCalls, 1);
  await settle();
  assert.equal(r.ctx.state, 'running');
  assert.deepEqual(r.starts(), [50.02, 50.52, 51.02, 51.52]);
  assert.equal(started, 0, 'and the count still runs before the transport');
}

// A cancel that lands during the resume wins: nothing is scheduled afterwards
// and the transport is never released.
{
  const r = rig({ settings: { countInBars: 1 } });
  r.ctx.state = 'suspended';
  let started = 0;
  const cancel = r.sched.countIn(1, () => { started += 1; });
  cancel();
  await settle();
  assert.equal(r.ctx.oscs.length, 0, 'the resumed count never arms');
  assert.equal(started, 0);
  assert.equal(r.timers.length, 0);
}

// A context that refuses to resume must not strand the transport waiting on a
// clock that will never advance — it starts, silently.
{
  const r = rig({ settings: { countInBars: 1 } });
  r.ctx.state = 'suspended';
  r.ctx.resumeFails = true;
  let started = 0;
  r.sched.countIn(1, () => { started += 1; });
  await settle();
  assert.equal(r.ctx.oscs.length, 0);
  assert.equal(started, 1, 'the transport starts rather than hanging');
}

// The FIRST play of a session: nothing has ever started, so the scheduler has
// never run and the app's transport entry is still whatever was loaded before.
// A count-in depends on none of that — only on the context, the tempo and the
// meter — so it plays its bars in full and then releases.
{
  const r = rig({ settings: { countInBars: 2 }, startSec: 0 });
  assert.equal(r.sched.isRunning, false, 'no play has happened yet');
  r.ctx.currentTime = 7;
  let started = 0;
  r.sched.countIn(2, () => { started += 1; });
  assert.equal(started, 0);
  assert.equal(r.sched.isRunning, false, 'counting in is not playing');
  assert.deepEqual(r.starts(), [7.02, 7.52, 8.02, 8.52, 9.02, 9.52, 10.02, 10.52]);
  assert.deepEqual(r.accented(), [true, false, false, false, true, false, false, false]);
  r.ctx.currentTime = 11.02; // t0 (7.02) + two bars at 120 bpm (4 s)
  r.timers[0].fn();
  assert.equal(started, 1, 'and only then is the transport released');
}

/* ------------------------- the service's count-in gate --------------------- */

// These reach past the pure scheduler into the wiring, which imports the store
// graph. It loads under plain node; what it cannot supply is an AudioContext,
// so the assertions below are about the DECISION to count in — the part that
// regressed — and the audible half is covered by the scheduler blocks above.
{
  const {
    shouldCountIn, shouldRun, metronomeCountIn, editTempoMap, editMeterMap, useMetronomeStore,
  } = await import('../state/metronomeStore.ts');
  const { usePlayerStore } = await import('../state/playerStore.ts');
  const { useEditorStore } = await import('../state/editorStore.ts');

  const ON = { editor: true, playing: false, bars: 2, enabled: true };

  // The regression: the gate used to be `currentEntryId === 'editor-timeline'`,
  // and liveMixer only writes that id once it has STARTED. EDIT is the live
  // surface long before that — on the first play of a session, and on every
  // play after a library track — so a configured count-in was silently skipped.
  // The decision must hold whatever the entry id says.
  for (const entry of ['library-track-42', null, 'editor-timeline']) {
    usePlayerStore.setState({ currentEntryId: entry });
    assert.equal(shouldCountIn(ON), true, `EDIT start press counts in with currentEntryId = ${String(entry)}`);
  }

  // The four things that DO stop a count-in.
  usePlayerStore.setState({ currentEntryId: 'editor-timeline' });
  assert.equal(shouldCountIn({ ...ON, playing: true }), false, 'a pause never counts in');
  assert.equal(shouldCountIn({ ...ON, editor: false }), false, 'another surface never counts in');
  assert.equal(shouldCountIn({ ...ON, bars: 0 }), false, 'no bars configured');
  assert.equal(shouldCountIn({ ...ON, enabled: false }), false, 'the metronome is off');

  // metronomeCountIn takes both values from the store and releases the transport
  // immediately for a press that does not count in.
  useMetronomeStore.setState({ enabled: true, countInBars: 0 });
  let released = 0;
  const noop = metronomeCountIn(() => { released += 1; }, { editor: true, playing: false });
  assert.equal(released, 1, 'nothing to count: the transport goes at once');
  noop();
  assert.equal(released, 1, 'and its cancel is inert');

  useMetronomeStore.setState({ countInBars: 2 });
  released = 0;
  metronomeCountIn(() => { released += 1; }, { editor: false, playing: false });
  assert.equal(released, 1, 'a press off the EDIT surface goes straight through');

  useMetronomeStore.setState({ enabled: false });
  released = 0;
  metronomeCountIn(() => { released += 1; }, { editor: true, playing: false });
  assert.equal(released, 1, 'and so does one with the metronome off');

  // The running click IS gated on the entry id, and needs BOTH playing flags:
  // playerStore's also covers the <audio> element, whose position
  // currentTransportSec() does not describe.
  useMetronomeStore.setState({ enabled: true });
  usePlayerStore.setState({ currentEntryId: 'editor-timeline', isPlaying: true });
  assert.equal(shouldRun(true), true);
  assert.equal(shouldRun(false), false, 'the live mixer is not the thing playing');
  usePlayerStore.setState({ isPlaying: false });
  assert.equal(shouldRun(true), false, 'the player store says stopped');
  usePlayerStore.setState({ isPlaying: true, currentEntryId: 'library-track-42' });
  assert.equal(shouldRun(true), false, 'a library track is not the editor transport');
  usePlayerStore.setState({ currentEntryId: 'editor-timeline' });
  useMetronomeStore.setState({ enabled: false });
  assert.equal(shouldRun(true), false, 'the metronome is off');
  useMetronomeStore.setState({ enabled: true });

  // The tempo map handed to tempoMap.ts must keep its IDENTITY while the map
  // holds: normalizeTempoMap caches on array identity, so a fresh array every
  // tick would re-sort and re-allocate on every conversion. It is the
  // arrangement's map, read through tempoStore.
  useEditorStore.getState().setBpm(120);
  const first = editTempoMap();
  assert.equal(editTempoMap(), first, 'same map, same array');
  assert.deepEqual(first.map((e) => [e.beat, e.bpm]), [[0, 120]]);
  useEditorStore.getState().setBpm(90);
  const next = editTempoMap();
  assert.notEqual(next, first, 'a new bpm is a new map');
  assert.deepEqual(next.map((e) => [e.beat, e.bpm]), [[0, 90]]);
  // A tempo change in the arrangement reaches the click, ramp and all.
  useEditorStore.getState().addTempoEvent({ beat: 8, bpm: 60, curve: 'linear' });
  useEditorStore.getState().addTempoEvent({ beat: 16, bpm: 140 });
  assert.deepEqual(editTempoMap().map((e) => [e.beat, e.bpm, e.curve ?? 'step']), [[0, 90, 'step'], [8, 60, 'linear'], [16, 140, 'step']]);
  useEditorStore.getState().setTempoMap([{ beat: 0, bpm: 120 }]);

  // The meter half is the arrangement's meter map, identity-stable between edits.
  const m1 = editMeterMap();
  assert.equal(editMeterMap(), m1, 'an unchanged meter map is the same array');
  assert.equal(m1.length > 0, true);
  useEditorStore.getState().setMeterAt(2, { num: 7, den: 8, groups: [3, 2, 2] });
  assert.deepEqual(editMeterMap().map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]), [[0, 4, 4, ''], [2, 7, 8, '3+2+2']]);
  useEditorStore.getState().setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
}

console.log('metronome: ok');
