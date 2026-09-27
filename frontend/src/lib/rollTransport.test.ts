// rollTransport: where the piano roll's PLAY starts, what it loops, and what it
// leaves silent, replayed through the same calls PianoRoll.tsx's scheduler
// makes each tick: read the store, followLap, unrollLanes, windowOnsets, then
// write the playhead back with shownStep. The component itself is not mounted
// (its module graph reads `import.meta.env`, which a node test cannot load), so
// the JSX wiring (the ruler's pointer handlers, the LOOP key) is what the
// browser pass covers; everything they call is driven here, and a source pin
// below holds PLAY's key to the store action this file drives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REANCHOR_STEPS,
  followLap,
  lapAt,
  loopLabel,
  noteOnsets,
  playRange,
  playStartLap,
  rulerKeyStep,
  rulerLoop,
  rulerSeekStep,
  sanitizeLoop,
  shownStep,
  startLap,
  windowOnsets,
} from './rollTransport.ts';
import { unrollLanes, type MeterSegment } from './meterMap.ts';
import { addChange, addChangeBar } from './meterFace.ts';
import { bendAutomation, bendValueAt, shiftBend, shiftPlayedBends, type BendPoint } from './pitchBend.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const note = (step: number, id = `n${step}`, length = 1): PianoNote => ({ id, note: 60, step, length, velocity: 90 });

/** A roll of `total` steps in 4/4 holding `notes`, stopped, the playhead at 0 and no loop. */
const roll = (total: number, notes: PianoNote[]) => {
  st().importNotes(notes, 120, { meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, []);
  usePianoRollStore.setState({ totalSteps: total, currentStep: 0, loop: null, loopOn: false, isPlaying: false });
};

interface Heard { id: string; step: number; abs: number }

/**
 * PLAY, as PianoRollTransport runs it: the PLAY key calls the store's play(),
 * the scheduler's lap starts from the store (playStartLap), then each tick reads the store, follows it (a seek, a new length, a new
 * loop), schedules the starts in its window, and writes the playhead back.
 * `window` steps are scheduled per tick; the playhead shown lags the cursor by
 * half a window, as the audio clock lags the lookahead. `onTick` runs before
 * tick `i` reads the store: an edit, a seek, a loop change while playing.
 */
function play(ticks: number, window = 1, onTick?: (i: number) => void): { heard: Heard[]; shown: number[] } {
  st().play();
  assert.equal(st().isPlaying, true);
  let lap = playStartLap(st());
  let cursor = -REANCHOR_STEPS;
  const heard: Heard[] = [];
  const shown: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(i);
    const r = st();
    const total = Math.max(1, r.totalSteps);
    lap = followLap(lap, { range: playRange(r.loop, r.loopOn, total), seekId: r.seekId, playhead: r.currentStep }, cursor);
    const target = cursor + window;
    for (const { note: n, abs } of windowOnsets(unrollLanes(r.notes, r.lanes, total), lap.lap, cursor, target)) {
      heard.push({ id: n.id, step: n.step, abs: Math.round(abs * 1e6) / 1e6 });
    }
    cursor = target;
    const at = shownStep(lap, cursor - window / 2);
    shown.push(at);
    st().setCurrentStep(at);
  }
  return { heard, shown };
}

// PLAY starts at the playhead. A click on the ruler (seek) puts the playhead at
// step 64; PLAY then sounds the note at 64 first, at once, and the note at 0
// only when the roll comes round again. PLAY used to reset the playhead to 0.
{
  roll(128, [note(0), note(64), note(96)]);
  st().seek(64);
  assert.equal(st().currentStep, 64);
  // play() starts the transport and leaves the playhead where the seek put it.
  const seekId = st().seekId;
  st().play();
  assert.deepEqual([st().isPlaying, st().currentStep, st().seekId], [true, 64, seekId], 'PLAY leaves the playhead at 64');
  assert.equal(windowOnsets(unrollLanes(st().notes, st().lanes, 128), playStartLap(st()).lap, -REANCHOR_STEPS, 0.5)[0]?.note.step, 64, "the scheduler's first onset is the note at 64");
  usePianoRollStore.setState({ isPlaying: false });
  const { heard } = play(80);
  assert.deepEqual(heard.slice(0, 3).map((h) => [h.step, h.abs]), [[64, 0], [96, 32], [0, 64]]);

  // The PLAY key and the scheduler in PianoRoll.tsx run exactly these two calls:
  // the key starts the transport with play() and never moves the playhead, and
  // the scheduler's lap starts from playStartLap(the store).
  const src = readFileSync(new URL('../components/audio/PianoRoll.tsx', import.meta.url), 'utf8');
  const toggle = src.slice(src.indexOf('const handlePlayToggle = () => {'), src.indexOf('// LOOP: turns the loop range on and off.'));
  assert.ok(toggle.length > 0 && /(?<![.\w])play\(\);/.test(toggle), 'the PLAY key calls the store action play()');
  assert.equal(/setCurrentStep\(|seek\(|setPlaying\(true\)/.test(toggle), false, 'the PLAY key never moves the playhead');
  assert.ok(src.includes('let lapState: LapState = playStartLap(usePianoRollStore.getState());'), "the scheduler's lap starts from the store");
}

// The playhead stays where playback stopped, so PLAY after STOP carries on
// from there rather than from the top.
{
  roll(64, [note(0), note(20), note(40)]);
  play(30);
  const stopped = st().currentStep;
  assert.ok(stopped > 20 && stopped < 40, `stopped at ${stopped}`);
  const { heard } = play(14);
  assert.deepEqual(heard.map((h) => [h.step, h.abs]), [[40, Math.round((40 - stopped) * 1e6) / 1e6]], 'PLAY again starts where STOP left the playhead');
}

// A note at or past the roll's end stays silent. A roll shortened under its
// notes (64 steps, a note at 80) used to fold that note into the roll: the
// scheduler played it at step 16 of every lap.
{
  roll(64, [note(0), note(80, 'past'), note(63.5, 'last', 0.5)]);
  const { heard } = play(130);
  assert.equal(heard.some((h) => h.id === 'past'), false, 'the note past the end never plays');
  assert.deepEqual(heard.map((h) => [h.id, h.abs]), [['n0', 0], ['last', 63.5], ['n0', 64], ['last', 127.5], ['n0', 128]]);
  // The same holds straight from noteOnsets: nothing at or past the lap's end.
  const lap = lapAt(0, 0, { start: 0, end: 64 });
  assert.deepEqual(noteOnsets(lap, 64, -1, 200), []);
  assert.deepEqual(noteOnsets(lap, 80, -1, 200), []);
  assert.deepEqual(noteOnsets(lap, 16, -1, 200), [16, 80, 144]);
}

// A loop range plays its steps over and over. With the playhead outside it,
// PLAY starts at the loop's start; the notes outside it stay silent.
{
  roll(64, [note(0), note(16), note(20), note(31), note(32)]);
  st().setLoop({ start: 16, end: 32 });
  assert.equal(st().loopOn, true, 'setting a range turns the loop on');
  const { heard, shown } = play(40);
  assert.deepEqual(heard.map((h) => [h.step, h.abs]), [[16, 0], [20, 4], [31, 15], [16, 16], [20, 20], [31, 31], [16, 32], [20, 36]]);
  assert.ok(shown.every((s) => s >= 16 && s < 32), 'the playhead stays inside the loop');
  // With the playhead inside the loop, PLAY starts at the playhead.
  st().seek(20);
  const inside = play(20);
  assert.deepEqual(inside.heard.map((h) => [h.step, h.abs]), [[20, 0], [31, 11], [16, 12], [20, 16]]);
}

// LOOP off mid-play keeps the playhead's place and plays on past the range; on
// again with the playhead outside it starts the range over.
{
  roll(64, [note(0), note(16), note(24), note(40)]);
  st().setLoop({ start: 16, end: 32 });
  const { heard } = play(40, 1, (i) => {
    if (i === 10) st().setLoopOn(false);
    if (i === 30) st().setLoopOn(true);
  });
  // 16 at 0 and 24 at 8; the loop goes off at tick 10 (the playhead near 26)
  // and the roll plays on to 40; on again at tick 30 (near 46) restarts at 16.
  assert.deepEqual(heard.slice(0, 3).map((h) => [h.step, h.abs]), [[16, 0], [24, 8], [40, 24]]);
  const restart = heard[3];
  assert.equal(restart.step, 16, 'turning the loop back on outside the range starts the range over');
  assert.ok(Math.abs(restart.abs - 30) < 1e-6, `restart at ${restart.abs}`);
}

// A seek while playing: playback jumps to the new playhead on the next tick,
// and the playhead shows the new place at once, not the old lap's tail.
{
  roll(128, [note(0), note(8), note(100), note(104)]);
  const { heard, shown } = play(20, 1, (i) => {
    if (i === 10) st().seek(100);
  });
  assert.deepEqual(heard.map((h) => h.step), [0, 8, 100, 104]);
  assert.ok(Math.abs(heard[2].abs - 10) < 1e-6, `the jump plays 100 right after the seek, at ${heard[2].abs}`);
  assert.ok(shown[10] >= 100 && shown[10] < 101, `the playhead shows the new place at once (${shown[10]})`);
}

// A length change under the playhead: the playhead keeps its place when the new
// roll holds it, and starts over when the roll now ends before it.
{
  roll(128, [note(0), note(40), note(90)]);
  const kept = play(70, 1, (i) => {
    if (i === 50) st().setTotalSteps(64);
  });
  assert.deepEqual(kept.heard.map((h) => [h.step, h.abs]), [[0, 0], [40, 40], [0, 64]], 'at 50 of a 64-step roll the lap goes on to 64');
  roll(128, [note(0), note(40), note(90)]);
  const over = play(90, 1, (i) => {
    if (i === 80) st().setTotalSteps(64);
  });
  assert.deepEqual(over.heard.map((h) => h.step), [0, 40, 0]);
  assert.ok(Math.abs(over.heard[2].abs - 80) < 1e-6, 'the roll now ends before the playhead: it starts over at once');
  assert.equal(over.heard.some((h) => h.step === 90), false);
}

// The METER face's ADD starts a change in the playhead's bar. A click on the
// ruler in bar 150 puts the playhead there, so ADD writes the change at bar
// 150 with the roll stopped. Before the ruler took clicks, the playhead only
// got to bar 150 by playing up to it.
{
  roll(4096, [note(0)]);
  st().seek(rulerSeekStep(149 * 16 + 5.4, st().totalSteps));
  assert.equal(st().currentStep, 149 * 16 + 5);
  assert.equal(st().isPlaying, false);
  const r = st();
  assert.equal(addChangeBar(r.meterMap, r.currentStep, r.pickupSteps), 149);
  const edit = addChange(r.meterMap, 0, r.currentStep, r.pickupSteps);
  r.applyMeter({ meterMap: edit.meterMap }, false);
  assert.deepEqual(st().meterMap.map((seg) => seg.bar), [0, 149], 'the change starts at bar 150');
}

// The store's transport state: seek holds the playhead inside the roll, LOOP
// with no range stays off, a clip load clears the loop and puts the playhead
// back at the top.
{
  roll(64, [note(0)]);
  st().seek(500);
  assert.equal(st().currentStep, 63);
  st().seek(-4);
  assert.equal(st().currentStep, 0);
  const seekId = st().seekId;
  st().seek(Number.NaN);
  assert.deepEqual([st().currentStep, st().seekId], [0, seekId + 1]);
  st().setLoop(null);
  st().setLoopOn(true);
  assert.equal(st().loopOn, false, 'LOOP needs a range');
  st().setLoop({ start: 12, end: 4 });
  assert.deepEqual([st().loop, st().loopOn], [{ start: 4, end: 12 }, true], 'a range dragged right to left is swapped');
  st().setLoopOn(false);
  assert.deepEqual([st().loop, st().loopOn], [{ start: 4, end: 12 }, false], 'LOOP off keeps the range');
  st().seek(30);
  st().loadFromClip('clip', [note(0)], 120, 32);
  assert.deepEqual([st().loop, st().loopOn, st().currentStep], [null, false, 0]);
}

// sanitizeLoop and playRange.
{
  assert.equal(sanitizeLoop(null), null);
  assert.equal(sanitizeLoop({ start: 3, end: 3.5 }), null, 'shorter than a step');
  assert.equal(sanitizeLoop({ start: Number.NaN, end: 8 }), null);
  assert.deepEqual(sanitizeLoop({ start: -4, end: 8 }), { start: 0, end: 8 });
  assert.deepEqual(playRange({ start: 16, end: 32 }, false, 64), { start: 0, end: 64 }, 'a loop that is off plays the whole roll');
  assert.deepEqual(playRange({ start: 48, end: 80 }, true, 64), { start: 48, end: 64 }, 'cut at the roll end');
  assert.deepEqual(playRange({ start: 64, end: 80 }, true, 64), { start: 0, end: 64 }, 'a loop past the end leaves the whole roll');
}

// The ruler's gestures: a click seeks to the cell under the pointer; a drag
// sets a loop between the step lines nearest its ends; the keys move the
// playhead by a step or to a bar line.
{
  assert.equal(rulerSeekStep(12.9, 64), 12);
  assert.equal(rulerSeekStep(70, 64), 63);
  assert.equal(rulerSeekStep(-2, 64), 0);
  assert.deepEqual(rulerLoop(15.6, 32.2, 64), { start: 16, end: 32 });
  assert.deepEqual(rulerLoop(32.2, 15.6, 64), { start: 16, end: 32 }, 'a drag to the left');
  assert.deepEqual(rulerLoop(60, 90, 64), { start: 60, end: 64 }, 'held inside the roll');
  assert.equal(rulerLoop(16.2, 15.8, 64), null, 'the same step line is still a click');
  const map: MeterSegment[] = [{ bar: 0, meter: M78 }, { bar: 2, meter: M44 }];
  assert.equal(rulerKeyStep('ArrowRight', false, 5, 64, map), 6);
  assert.equal(rulerKeyStep('ArrowLeft', false, 0, 64, map), 0);
  assert.equal(rulerKeyStep('ArrowRight', true, 5, 64, map), 14, 'Shift+Right: the next bar line of 7/8');
  assert.equal(rulerKeyStep('ArrowRight', true, 20, 64, map), 28, 'the second 7/8 bar ends at 28');
  assert.equal(rulerKeyStep('ArrowRight', true, 30, 64, map), 44, 'then bars of 4/4');
  assert.equal(rulerKeyStep('ArrowLeft', true, 20, 64, map), 14, 'Shift+Left: back to the bar line');
  assert.equal(rulerKeyStep('ArrowLeft', true, 14, 64, map), 0, 'from a bar line: the one before');
  assert.equal(rulerKeyStep('ArrowRight', true, 60, 64, map), 63, 'held inside the roll');
  assert.equal(rulerKeyStep('End', false, 5, 64, map), 63);
  assert.equal(rulerKeyStep('Home', false, 5, 64, map), 0);
  assert.equal(rulerKeyStep('a', false, 5, 64, map), null);
}

// The loop in words, for the LOOP key's description.
{
  const map: MeterSegment[] = [{ bar: 0, meter: M44 }];
  assert.equal(loopLabel({ start: 32, end: 48 }, map), 'bar 3');
  assert.equal(loopLabel({ start: 32, end: 64 }, map), 'bars 3-4');
  assert.equal(loopLabel({ start: 5, end: 12 }, map), 'steps 6-12');
  assert.equal(loopLabel({ start: 0, end: 4 }, map, 4), 'the pickup');
  assert.equal(loopLabel({ start: 0, end: 20 }, map, 4), 'bars pickup-1');
}

// A loop that starts past step 0 plays each bent lane's curve re-based to the
// loop's start: at every step of the loop the re-based curve is where the
// roll's curve is, holds and ramps exactly and eases on its own divisions.
{
  const pts: BendPoint[] = [
    { id: 'a', step: 4, value: 0, shape: 'linear' },
    { id: 'b', step: 12, value: 1, shape: 'hold' },
    { id: 'c', step: 20, value: -0.5, shape: 'smooth' },
    { id: 'd', step: 36, value: 0.5, shape: 'hold' },
  ];
  for (const from of [2, 4, 8, 16, 24, 40]) {
    const moved = shiftBend(pts, from);
    for (let s = 0; s <= 30; s += 0.25) {
      const want = bendValueAt(pts, from + s);
      const got = bendValueAt(moved, s);
      const smooth = from + s > 20 && from + s < 36 && from > 20;
      assert.ok(Math.abs(got - want) < (smooth ? 0.02 : 1e-9), `from ${from} at ${s}: ${got} vs ${want}`);
    }
  }
  // A note's automation over the loop matches the roll's own from the same place.
  const auto = bendAutomation(shiftBend(pts, 8), 2, 0, 6);
  const own = bendAutomation(pts, 2, 8, 14);
  assert.deepEqual(auto.map((e) => [e.step + 8, Math.round(e.cents * 1e6) / 1e6]), own.map((e) => [e.step, Math.round(e.cents * 1e6) / 1e6]));
  const played = new Map([[0, { range: 2, points: pts }]]);
  assert.equal(shiftPlayedBends(played, 0), played, 'a loop from step 0 plays the curves as they are');
  assert.deepEqual(shiftPlayedBends(played, 8).get(0)?.points, shiftBend(pts, 8));
}

console.log('rollTransport: ok');
