/**
 * The piano roll's tempo map (lib/rollTempo): what the store may hold, the
 * clocks that turn steps into seconds, and PLAY replayed tick by tick through
 * the scheduler's own play state (startRollPlay / followRollPlay, the calls
 * PianoRollTransport makes) with the roll's real store.
 *
 * Heard at the end: a slow introduction moves into an Allegro, a ritardando
 * slows the notes while every note keeps its tick, a fermata holds, a loop
 * that holds a ritardando slows in the same place every time round, and a
 * tempo point added while the roll plays moves nothing already scheduled.
 * Run from `frontend/`:
 *   npx tsx src/lib/rollTempo.test.ts
 */
import assert from 'node:assert/strict';
import {
  followRollPlay,
  hasTempoChanges,
  lapAbsAt,
  lapOffsetSec,
  lapStepAt,
  lapTimeOf,
  playedTempoMap,
  sanitizeRollTempoMap,
  spanSec,
  startRollPlay,
  stepClock,
  tempoSpan,
  type RollPlayState,
} from './rollTempo.ts';
import { REANCHOR_STEPS, windowOnsets } from './rollTransport.ts';
import { bendEventTime, stepNotesToRender } from './pitchBendVoice.ts';
import { rollRenderBends } from './pitchBend.ts';
import { placeTake } from './rollTakes.ts';
import { unrollLanes } from './meterMap.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { TempoEvent } from './tempoMap.ts';

const near = (a: number, b: number, eps = 1e-6, msg = ''): void => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b}`);
const st = () => usePianoRollStore.getState();

// ── What the store may hold ─────────────────────────────────────────────────
{
  // A start at beat 0 always exists, at the fallback tempo when none is given.
  assert.deepEqual(sanitizeRollTempoMap([], 97.3), [{ beat: 0, bpm: 97.3, curve: 'step' }]);
  // Sorted, one per beat (the later one wins), beats on ticks, tempi in 20..300,
  // fermatas kept beside a tempo on the same beat, junk dropped.
  const map = sanitizeRollTempoMap(
    [
      { beat: 8, bpm: 400 },
      { beat: 0, bpm: 60, curve: 'linear' },
      { beat: 8, bpm: 132 },
      { beat: 4.0001, bpm: 10 },
      { beat: 8, bpm: 0, fermata: { beats: 0.5, stretch: 20 } },
      { beat: Number.NaN, bpm: 90 },
      { beat: 2, bpm: -5 },
      null,
    ],
    120,
  );
  assert.deepEqual(map.map((e) => [e.beat, e.bpm, e.curve ?? null, e.fermata ?? null]), [
    [0, 60, 'linear', null],
    [Math.round(4.0001 * 960) / 960, 20, 'step', null],
    [8, 132, 'step', null],
    // A fermata is not a tempo: its bpm is not read, and one given as 0 is written as the fallback.
    [8, 120, null, { beats: 0.5, stretch: 8 }],
  ]);
  assert.ok(Object.isFrozen(map), 'a map the store holds is frozen, so a clock may key on its identity');
  assert.equal(hasTempoChanges(map), true);
  assert.equal(hasTempoChanges(sanitizeRollTempoMap([], 120)), false);
  assert.deepEqual(tempoSpan(60, map), [20, 132]);
}

// A clip's map scales with its `sourceBpm`: a stretch or a retag rewrites only
// the start tempo, and every change keeps its proportion to it.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 90 }];
  assert.deepEqual(playedTempoMap(120, map).map((e) => e.bpm), [120, 240, 180]);
  assert.deepEqual(playedTempoMap(60, map).map((e) => e.bpm), [60, 120, 90]);
  assert.deepEqual(playedTempoMap(88, null), [{ beat: 0, bpm: 88 }]);
}

// A one-tempo clock is the product every caller computed before, bit for bit.
{
  for (const bpm of [60, 97.3, 120, 133.5, 240]) {
    const clock = stepClock(bpm);
    const stepSec = 60 / bpm / 4;
    assert.equal(clock.stepSec, stepSec);
    for (const step of [0, 1, 7.5, 2 / 3, 1234.25]) {
      assert.equal(clock.at(step), step * stepSec);
      assert.equal(spanSec(clock, step, 3), 3 * stepSec);
    }
  }
  // Out of range tempi hold to 20..300, not to the old 40.
  assert.equal(stepClock(30).stepSec, 60 / 30 / 4);
  assert.equal(stepClock(10).stepSec, 60 / 20 / 4);
}

// The lap clock: continuous, increasing, and its inverse inverts, with a lap
// that holds a ritardando.
{
  const clock = stepClock(120, [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 8, bpm: 60 }]);
  const lap = { base: -4, start: 16, len: 16 };
  let prev = -Infinity;
  for (let abs = -4; abs < 60; abs += 0.37) {
    const sec = lapOffsetSec(lap, clock, abs);
    assert.ok(sec > prev, 'time rises with the absolute step');
    prev = sec;
    near(lapStepAt(lap, clock, sec), abs, 1e-7, `inverse at ${abs}`);
  }
  // One lap lasts as long as its roll steps: steps 16..32 at the map's own tempi.
  near(lapOffsetSec(lap, clock, lap.base + 16) - lapOffsetSec(lap, clock, lap.base), clock.at(32) - clock.at(16));
}

// ── PLAY, replayed ──────────────────────────────────────────────────────────

const LOOKAHEAD = 0.12;
const TICK = 0.025;
const START = 10; // the context time PLAY starts at

interface Heard { id: string; step: number; at: number; dur: number }

/**
 * PLAY as PianoRollTransport runs it: startRollPlay, then every 25 ms tick
 * reads the store, follows it (followRollPlay), schedules the starts in its
 * lookahead window at the lap clock's times, and moves the cursor on.
 * `onTick` runs before tick `i` reads the store: an edit while playing.
 */
function play(seconds: number, onTick?: (i: number, heard: Heard[]) => void): Heard[] {
  st().play();
  let state: RollPlayState = startRollPlay(st(), START);
  let cursor = -REANCHOR_STEPS;
  const heard: Heard[] = [];
  const ticks = Math.ceil(seconds / TICK);
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(i, heard);
    const now = START - 0.06 + i * TICK;
    const r = st();
    state = followRollPlay(state, r, cursor);
    const target = lapAbsAt(state.clock, now + LOOKAHEAD);
    const total = Math.max(1, r.totalSteps);
    for (const { note: n, abs } of windowOnsets(unrollLanes(r.notes, r.lanes, total), state.lapState.lap, cursor, target)) {
      heard.push({ id: n.id, step: n.step, at: lapTimeOf(state.clock, abs) - START, dur: spanSec(state.steps, n.step, n.length) });
    }
    cursor = Math.max(cursor, target);
  }
  st().setPlaying(false);
  return heard;
}

/** A roll of `totalSteps` in 4/4 with a note on every beat, a 16th long. */
const beatsRoll = (totalSteps: number, tempoMap: TempoEvent[], bpm: number): PianoNote[] => {
  const notes: PianoNote[] = [];
  for (let s = 0; s < totalSteps; s += 4) notes.push({ id: `b${s / 4}`, note: 60, step: s, length: 1, velocity: 90 });
  st().importNotes(notes, bpm, { meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, [], tempoMap);
  usePianoRollStore.setState({ totalSteps, loop: null, loopOn: false });
  st().seek(0);
  return st().notes;
};

// A slow introduction moves into an Allegro: two bars of Adagio at 60, then
// 132 from bar 3. Every beat of the introduction lasts a second; every beat of
// the Allegro 60/132 of one.
{
  beatsRoll(64, [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 132 }], 60);
  assert.equal(st().bpm, 60, 'the header reads the starting tempo');
  // The roll lasts 8 + 8 x 60/132 s; PLAY stops short of its second time round.
  const heard = play(11.4);
  assert.equal(heard.length, 16, 'every beat of the roll sounds once');
  assert.equal(new Set(heard.map((h) => h.step)).size, 16);
  for (const h of heard) {
    const beat = h.step / 4;
    const want = beat < 8 ? beat : 8 + (beat - 8) * (60 / 132);
    near(h.at, want, 1e-9, `beat ${beat}`);
    near(h.dur, beat < 8 ? 0.25 : 0.25 * (60 / 132), 1e-9, `beat ${beat} lasts a 16th at its tempo`);
  }
}

// A ritardando written as tempo: 120 ramping to 60 across bars 5-6. Each
// beat lands at the ramp's closed-form second, t = t0 + (60/k) ln(bpm/120),
// and every note keeps the tick it was written at: its bar line is where it was.
{
  const notes = beatsRoll(128, [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 120, curve: 'linear' }, { beat: 24, bpm: 60 }], 120);
  const ticksBefore = notes.map((n) => n.tick);
  const heard = play(20);
  const k = (60 - 120) / 8; // bpm per beat
  const ramp = (beat: number) => 8 + (60 / k) * Math.log((120 + k * (beat - 16)) / 120);
  for (const h of heard) {
    const beat = h.step / 4;
    const want = beat <= 16 ? beat * 0.5 : beat <= 24 ? ramp(beat) : ramp(24) + (beat - 24);
    near(h.at, want, 1e-9, `beat ${beat}`);
  }
  // The ritardando slows: each beat of the ramp is longer than the one before.
  const gaps = heard.filter((h) => h.step >= 64 && h.step <= 96).map((h, i, a) => (i ? h.at - a[i - 1].at : 0)).slice(1);
  for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] > gaps[i - 1], 'each beat of the ritardando is longer than the last');
  assert.deepEqual(st().notes.map((n) => n.tick), ticksBefore, 'no note moved: the ritardando is tempo, not late notes');
}

// A fermata on beat 4 at 60 bpm, held one beat twice as long: beat 5 sounds a
// second later than it would, and the note under the hold lasts twice as long.
{
  beatsRoll(32, [{ beat: 0, bpm: 60 }, { beat: 4, bpm: 60, fermata: { beats: 1, stretch: 2 } }], 60);
  const heard = play(10);
  const at = (beat: number) => heard.find((h) => h.step === beat * 4)?.at;
  near(at(4) ?? Number.NaN, 4);
  near(at(5) ?? Number.NaN, 6, 1e-9, 'the beat after the hold');
  near(at(7) ?? Number.NaN, 8);
  near(heard.find((h) => h.step === 16)?.dur ?? Number.NaN, 0.5, 1e-9, 'the held 16th lasts twice its length');
}

// A loop over bars 5-6, which hold the ritardando: every time round the notes
// fall at the same offsets from the lap's start, and a lap lasts the ramp's time.
{
  beatsRoll(128, [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 120, curve: 'linear' }, { beat: 24, bpm: 60 }], 120);
  st().setLoop({ start: 64, end: 96 });
  st().seek(64);
  const heard = play(30);
  const laps: Heard[][] = [];
  for (const h of heard) {
    if (h.step === 64) laps.push([]);
    laps[laps.length - 1]?.push(h);
  }
  assert.ok(laps.length >= 3, `the loop came round (${laps.length} laps)`);
  const lapSec = stepClock(120, st().tempoMap).at(96) - stepClock(120, st().tempoMap).at(64);
  for (let l = 1; l < laps.length; l += 1) {
    near(laps[l][0].at - laps[l - 1][0].at, lapSec, 1e-9, `lap ${l} lasts the ramp's time`);
    const offsets = (lap: Heard[]) => lap.map((h) => h.at - lap[0].at);
    const a = offsets(laps[l - 1]);
    offsets(laps[l]).forEach((o, i) => near(o, a[i], 1e-9, `lap ${l} note ${i}`));
  }
  st().setLoop(null);
}

// A tempo point added while the roll plays: what was already scheduled keeps
// its time, and the notes after the point are timed by the new map.
{
  beatsRoll(64, [{ beat: 0, bpm: 120 }], 120);
  const heard = play(10, (i) => {
    if (i === 20) st().addTempoEvent({ beat: 8, bpm: 60 });
  });
  const scheduledAtEdit = heard.filter((h) => h.at < 20 * TICK + LOOKAHEAD - 0.06);
  for (const h of scheduledAtEdit) near(h.at, (h.step / 4) * 0.5, 1e-9, `beat ${h.step / 4} scheduled before the edit`);
  for (const h of heard) {
    const beat = h.step / 4;
    near(h.at, beat <= 8 ? beat * 0.5 : 4 + (beat - 8), 1e-9, `beat ${beat}`);
  }
}

// One tempo: PLAY times every note as it always has, step x 60 / bpm / 4.
{
  beatsRoll(32, [], 97.3);
  const heard = play(4.5);
  assert.equal(heard.length, 8);
  for (const h of heard) near(h.at, h.step * (60 / 97.3 / 4), 1e-9, `step ${h.step}`);
}

// ── Bends and takes under the map ───────────────────────────────────────────

// A bent lane renders under a ritardando: each note at its step's second, and
// its bend's automation at the seconds of the automation's own steps, as the
// built-in voice schedules it (bendEventTime); the soundfont's wheel messages
// sit at their steps' seconds too. A one-tempo clock renders exactly as its
// 16th's seconds always did.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 8, bpm: 60 }];
  const lanes = [{ id: 0, name: 'A', cycleSteps: null }];
  const bends = rollRenderBends([{ lane: 0, range: 2, points: [{ id: 'a', step: 0, value: 0, shape: 'linear' }, { id: 'b', step: 24, value: 1, shape: 'linear' }] }], lanes, 32)!;
  const notes = [{ note: 60, velocity: 90, step: 4, length: 16 }, { note: 64, velocity: 90, step: 20, length: 8 }];
  const clock = stepClock(120, map);
  const out = stepNotesToRender(notes, clock, bends);
  out.notes.forEach((r, i) => {
    near(r.startSec, clock.at(notes[i].step), 1e-12, `note ${i}`);
    near(r.durationSec, clock.at(notes[i].step + notes[i].length) - clock.at(notes[i].step), 1e-12);
    assert.ok(r.bend, `note ${i} follows its lane's bend`);
    for (const e of r.bend.events) near(bendEventTime(r.bend, r.startSec, e.step), clock.at(e.step), 1e-12, `bend event at step ${e.step}`);
  });
  for (const w of out.wheel[0].events) assert.ok(w.sec >= 0);
  assert.ok(out.wheel[0].events.some((w) => Math.abs(w.sec - clock.at(24)) < 1e-12), 'the wheel reaches the end of the curve at the second of step 24');
  // One tempo: the clock and the 16th's seconds give the same render.
  const flat = stepClock(97.3);
  assert.deepEqual(stepNotesToRender(notes, flat, bends), stepNotesToRender(notes, 60 / 97.3 / 4, bends));
}

// A take recorded against a roll that slows down lands on the beats it was
// played on: a note played at the second beat 10 sounds at goes to beat 10.
{
  st().importNotes([], 120, undefined, [], [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]);
  const clock = stepClock(120, st().tempoMap);
  const take = [
    { note: 60, velocity: 100, startSec: clock.at(4), endSec: clock.at(8) },
    { note: 62, velocity: 100, startSec: clock.at(40), endSec: clock.at(44) },
  ];
  assert.equal(placeTake(take, clock.at(48), 'rec'), 2);
  assert.deepEqual(st().notes.map((n) => [n.tick, n.ticks]), [[960, 960], [9600, 960]], 'beat 1 and beat 10, a quarter each');
  assert.deepEqual(st().recordedRange, { startStep: 0, endStep: 48 });
}

console.log('rollTempo: ok');
