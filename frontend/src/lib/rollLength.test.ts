/**
 * A symphony movement's length in the roll: MAX_ROLL_STEPS and MAX_BEND_STEP
 * are one limit, 65,536 sixteenths (4,096 bars of 4/4).
 *
 * The sequence: IMPORT a type-1 file of three parts running 3,000 bars in
 * changing meters (4/4, 7/8 3+2+2, 5/4) and tempos; the grid must end on the
 * file's last bar line with every note where the file put it (the old 4,096-step
 * cap stopped the grid at bar 256 and the scheduler folded the rest into
 * earlier bars). A bend point near the end keeps its step. The roll's length
 * grows to 65,536 and no further. Then PLAY from the last bars: the scheduler
 * plays their notes at the times the tempo map gives them.
 *
 *   cd frontend && npx tsx src/lib/rollLength.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData, type MidiTrack } from './midi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { MAX_ROLL_STEPS, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { MAX_BEND_STEP } from './pitchBend.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS, type ScheduledRollNote } from './rollPartPlay.ts';
import { stepClock } from './rollTempo.ts';
import { useEditorStore } from '../state/editorStore.ts';

assert.equal(MAX_ROLL_STEPS, 65536, 'the roll holds 65,536 steps');
assert.equal(MAX_BEND_STEP, MAX_ROLL_STEPS, 'a bend point can sit wherever a note can');

const PPQ = 480;
const STEP = PPQ / 4;
// 1,000 bars of 4/4, 1,000 of 7/8 (3+2+2), 1,000 of 5/4.
const barTicks = (bar: number) => (bar < 1000 ? 16 : bar < 2000 ? 14 : 20) * STEP;
const starts: number[] = [0];
for (let b = 0; b < 3000; b += 1) starts.push(starts[b] + barTicks(b));
const endTick = starts[3000];
const endSteps = endTick / STEP;
assert.ok(endSteps > 4096 * 10, `the movement runs ${endSteps} steps`);

const tracks: MidiTrack[] = [
  { name: 'Violin I', channel: 0, program: 40, low: 72 },
  { name: 'Viola', channel: 1, program: 41, low: 60 },
  { name: 'Violoncello', channel: 2, program: 42, low: 48 },
].map((p, k) => ({
  name: p.name,
  programs: [{ tick: 0, channel: p.channel, program: p.program }],
  notes: Array.from({ length: 3000 }, (_, bar) => ({
    tick: starts[bar] + k * STEP,
    note: p.low + ((bar + k) % 7),
    velocity: 80,
    durationTicks: 4 * STEP,
    channel: p.channel,
  })),
}));
const file: MidiFileData = {
  ppq: PPQ,
  bpm: 120,
  tempos: [{ tick: 0, bpm: 120 }, { tick: starts[1000], bpm: 144 }, { tick: starts[2000], bpm: 100 }],
  timeSignatures: [
    { tick: 0, num: 4, den: 4 },
    { tick: starts[1000], num: 7, den: 8, groups: [3, 2, 2] },
    { tick: starts[2000], num: 5, den: 4 },
  ],
  tracks,
};

// ── IMPORT ───────────────────────────────────────────────────────────────────
useEditorStore.getState().loadProject({ tracks: [], clips: [] });
const done = importMidiParts(parseMidi(encodeMidi(file)), 'long');
assert.equal(done.parts, 3);
const roll = usePianoRollStore.getState();
assert.equal(roll.totalSteps, endSteps, `the grid ends on the file's last bar line (${endSteps} steps)`);
const parts = rollTracksOf(roll);
parts.forEach((p, k) => {
  assert.equal(p.notes.length, 3000, `${p.name} keeps every note`);
  const last = p.notes.reduce((m, n) => (n.step > m.step ? n : m));
  assert.equal(last.step, starts[2999] / STEP + k, `${p.name}'s last note sits in bar 3000`);
});
assert.deepEqual(roll.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 4, 4], [1000, 7, 8], [2000, 5, 4]]);
assert.deepEqual(roll.tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [4000, 144], [7500, 100]]);

// A bend point near the end keeps its step; the grid grows to the limit and no further.
roll.setBendPoints(0, [{ step: 0, value: 0 }, { step: 60000, value: 0.5 }]);
assert.deepEqual(usePianoRollStore.getState().bends.find((b) => b.lane === 0)?.points.map((p) => p.step), [0, 60000]);
roll.setTotalSteps(65536);
assert.equal(usePianoRollStore.getState().totalSteps, 65536);
roll.setTotalSteps(100000);
assert.equal(usePianoRollStore.getState().totalSteps, 65536, 'no further than 65,536');
roll.setTotalSteps(endSteps);
assert.equal(usePianoRollStore.getState().totalSteps, endSteps);

// ── PLAY the last four bars on the audio clock ───────────────────────────────
const from = starts[2996] / STEP;
usePianoRollStore.setState({ currentStep: from, loop: null, loopOn: false });
const start = usePianoRollStore.getState();
const origin = 5.06;
const scheduler = createRollScheduler({ ...start, tracks: rollTracksOf(start) }, origin, ROLL_LOOKAHEAD_SEC);
const clock = stepClock(start.bpm, start.tempoMap);
const heard: ScheduledRollNote[] = [];
let now = 5;
const until = origin + (clock.at(endSteps) - clock.at(from));
while (now < until) {
  const s = usePianoRollStore.getState();
  const out = scheduler.tick(now, { ...s, tracks: rollTracksOf(s) }, () => undefined);
  for (const n of out.notes) heard.push(n);
  now += ROLL_TICK_MS / 1000;
}
const played = heard.filter((n) => n.abs + from < endSteps);
assert.ok(played.length >= 9, `the last bars' notes play (${played.length})`);
for (const n of played) {
  const step = from + n.abs;
  const bar = starts.findIndex((t) => t / STEP > step + 1e-9) - 1;
  assert.ok(bar >= 2996 && bar < 3000, `a note from bar ${bar + 1}, where the file put it`);
  const expected = origin + (clock.at(step) - clock.at(from));
  assert.ok(Math.abs(n.when - expected) < 1e-6, `on the tempo map's time (${n.when} vs ${expected})`);
}

console.log(`rollLength: ok (${endSteps} steps, ${played.length} notes played from bar 2997)`);
