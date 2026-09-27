// Run with: npx tsx src/lib/grooveLanes.test.ts
//
// Stage 2's feel and lane work, replayed through the real store and the real
// file codec: APPLY on the snap grid (quintuplets stay quintuplets, lengths
// keep their cells), quantize lines measured from each bar line, grooves that
// follow each bar's groups (swing inside 7/8 3+2+2, notes inégales,
// double-dotting), slots looked up by exact place, grooves learned from a file
// sized to its bar, lanes with a meter and a tuplet ratio of their own (drawn,
// snapped, saved, undone, written to MIDI and read back), and polyrhythm's real
// 3:2, 4:3 and 5:4 notes.
import assert from 'node:assert/strict';
import { quantizeNotes } from './clipNotes/index.ts';
import {
  applyGroove,
  applyGrooveInMeter,
  builtinGrooves,
  fromVirtuosoTemplate,
  groupStartsForPulse,
  toVirtuosoTemplate,
  type GrooveTemplate,
} from './grooveTemplate.ts';
import { buildGrooveFromMidiBytes } from './grooveExtract.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { stepRenderRequest } from './midiSynth.ts';
import { barAt, laneGridLines, laneTimeOf, meterMapToMidiEvents, normalizeMeterMap, sanitizeTuplet, type MeterSegment, type PolyLane } from './meterMap.ts';
import { genTarget, laneBarSteps, laneMeterFromText, laneMeterFromValue, laneTimeLabel, canStepLaneTuplet, stepLaneTuplet, tupletLabel } from './meterFace.ts';
import { clipRollLoad, feelRollNotes, quantizeRollClip, rollClipFields } from './rollClip.ts';
import { midiFileToRoll, parseLaneMeta, rollToMidiFile } from './rollMidi.ts';
import { clipMeterToTasmo, tasmoMeterToClip } from './projectClient.ts';
import { TICKS_PER_STEP, clickPlacement, feelNoteTicks, laneSnapGrid, snapGrid } from './rollSnap.ts';
import { CROSS_ID_SUFFIX, crossSpans, humanize, polyrhythm, type GrooveTemplate as Pocket } from './virtuosoTransform.ts';
import { sanitizeLanes, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const M44 = { num: 4, den: 4, groups: [] as number[] };
const M34 = { num: 3, den: 4, groups: [] as number[] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M68 = { num: 6, den: 8, groups: [3, 3] };
const M732 = { num: 7, den: 32, groups: [] as number[] };
const STEP_PX = 16;
const close = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const grooveById = (id: string): GrooveTemplate => {
  const g = builtinGrooves().find((x) => x.id === id);
  assert.ok(g, `built-in groove ${id}`);
  return g;
};

/** A fresh roll: `map`, `pickupSteps`, `totalSteps`, lanes, no notes, empty history. */
const freshRoll = (map: MeterSegment[], totalSteps = 64, pickupSteps = 0, lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }]) => {
  usePianoRollStore.setState({
    meterMap: map,
    pickupSteps,
    totalSteps,
    lowestNote: 21,
    highestNote: 108,
    notes: [],
    selectedIds: new Set(),
    selectedNoteId: null,
    lanes,
    activeLane: 0,
    bends: [],
  });
  const s = st();
  usePianoRollStore.setState({
    _undo: [{ notes: s.notes, bpm: s.bpm, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends }],
    _redo: [],
  });
  st().undo();
};

/** A click at `tick` on the grid PianoRoll builds (the active lane's own when it has one), as handleGridClick adds the note. */
const click = (tick: number, midi = 60): string => {
  const s = st();
  const lt = laneTimeOf(s.lanes.find((l) => l.id === s.activeLane), s.meterMap, s.pickupSteps);
  const g = lt ? laneSnapGrid(lt, s.totalSteps, s.snap) : snapGrid(s.meterMap, s.pickupSteps, s.totalSteps, s.snap);
  const placed = clickPlacement(g, ((tick + 5) / TICKS_PER_STEP) * STEP_PX, STEP_PX);
  assert.ok(placed, `a click at tick ${tick} lands on the roll`);
  return s.addNote({ note: midi, step: placed.tick / TICKS_PER_STEP, length: placed.ticks / TICKS_PER_STEP, tick: placed.tick, ticks: placed.ticks, velocity: 96 });
};

/** PianoRollFeel's APPLY, as its handler calls it: the roll's snap, QUANT as strength, a named groove at QUANT's depth. */
const apply = (quantPct: number, groove: GrooveTemplate) => {
  const s = st();
  const q = quantPct / 100;
  s.replaceAll(feelRollNotes(s.notes, { meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, totalSteps: s.totalSteps }, { snap: s.snap, strength: q, groove, grooveStrength: q }));
};
const byTick = () => [...st().notes].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
/** A pause longer than the store's 300 ms coalesce window, as a user takes between drawing and pressing APPLY. */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 350));

// ── APPLY lands on the snap grid ─────────────────────────────────────────────

// Five quintuplet 16ths drawn with the snap, then played a little loose: APPLY at
// 100% puts them back on the quintuplet lines, 192 ticks apart and 192 long, and
// they sound 0.1 s apart at 120 BPM. On 30a3edf APPLY quantized to 16ths from
// step 0 and pulled lengths to whole steps.
{
  freshRoll([{ bar: 0, meter: M44 }], 32);
  st().setSnap('1/16Q');
  const ids = [0, 1, 2, 3, 4].map((k) => click(1920 + k * 192, 60 + k));
  const loose = [13, -17, 21, -9, 15];
  st().setNoteTimes(ids.map((id, k) => ({ id, tick: 1920 + k * 192 + loose[k], ticks: 192 + loose[k] })));
  await pause();
  apply(100, grooveById('straight'));
  assert.deepEqual(byTick().map((n) => [n.tick, n.ticks]), [0, 1, 2, 3, 4].map((k) => [1920 + k * 192, 192]));
  const sounding = stepRenderRequest(st().notes, 120, st().totalSteps).notes.sort((a, b) => a.midi - b.midi);
  sounding.forEach((n, k) => close(n.startSec, 1 + k * 0.1, `quintuplet ${k} sounds on its line`));
  // One undo step takes APPLY back to the loose take.
  st().undo();
  assert.deepEqual(byTick().map((n) => n.tick), [0, 1, 2, 3, 4].map((k) => 1920 + k * 192 + loose[k]));
  // Half-strength APPLY goes half way, lengths too.
  apply(50, grooveById('straight'));
  byTick().forEach((n, k) => {
    close(n.tick ?? 0, Math.round(1920 + k * 192 + loose[k] / 2), `half-way start ${k}`, 1);
    close(n.ticks ?? 0, Math.round(192 + loose[k] / 2), `half-way length ${k}`, 1);
  });
  st().setSnap('1/16');
}

// A triplet 8th keeps its length on the 1/8 triplet grid; on the 1/16 grid APPLY
// rounds lengths to whole 16ths as it always has.
{
  freshRoll([{ bar: 0, meter: M44 }], 32);
  const g = snapGrid([{ bar: 0, meter: M44 }], 0, 32, '1/8T');
  assert.deepEqual(feelNoteTicks(g, 330, 300, 1), { tick: 320, ticks: 320 });
  assert.deepEqual(feelNoteTicks(snapGrid([{ bar: 0, meter: M44 }], 0, 32, '1/16'), 330, 300, 1), { tick: 240, ticks: 240 });
  assert.deepEqual(feelNoteTicks(g, 330, 300, 0), { tick: 330, ticks: 300 }, 'QUANT 0 moves nothing');
  // The GROUP snap: the end moves to the nearest pulse after the start.
  const group = snapGrid([{ bar: 0, meter: M78 }], 0, 28, 'group');
  assert.deepEqual(feelNoteTicks(group, 1500, 700, 1), { tick: 1440, ticks: 960 }, '7/8 3+2+2: group 2 starts at 8th 4 and lasts two 8ths');
}

// A 7/8 3+2+2 roll on the 1/8 triplet snap: APPLY puts each note on the triplet
// line of its own group, never on a line that runs on from the group before.
{
  freshRoll([{ bar: 0, meter: M78 }], 14);
  st().setSnap('1/8T');
  // Group 2 starts at 8th 4 (1440 ticks); its first triplet line after that is 1440 + 320.
  const id = click(1440 + 320);
  st().setNoteTimes([{ id, tick: 1440 + 320 + 30 }]);
  apply(100, grooveById('straight'));
  assert.equal(st().notes[0].tick, 1760);
  st().setSnap('1/16');
}

// ── quantize lines from each bar line ────────────────────────────────────────

// A half-step pickup: the 1/8 grid restarts on bar 1 (step 0.5), so a note at 0.9
// lands on 0.5, not 0. Without a meter the lines run from step 0 as they did.
{
  const n = (step: number): PianoNote => ({ id: `n${step}`, note: 60, step, length: 1, velocity: 90 });
  const map = [{ bar: 0, meter: M44 }];
  assert.equal(quantizeNotes([n(0.9)], { grid: '1/8', meterMap: map, pickupSteps: 0.5 })[0].step, 0.5);
  assert.equal(quantizeNotes([n(0.9)], { grid: '1/8' })[0].step, 0, 'no meter: the old lines');
  // Inside the pickup the lines count back from bar 1: a 3-step pickup has lines at 1 and 3 (and its start).
  assert.equal(quantizeNotes([n(1.2)], { grid: '1/8', meterMap: map, pickupSteps: 3 })[0].step, 1);
  // Swing is counted from the bar line: the off 8th of bar 1 (step 2.5) is the swung one.
  close(quantizeNotes([n(3.2)], { grid: '1/8', swing: 0.5, meterMap: map, pickupSteps: 0.5 })[0].step, 3, 'swung off 8th at 2.5 + 0.5');
  // 7/32 bars are 3.5 steps: bar 2 starts at 3.5, so its 16ths sit on half steps.
  const m732 = [{ bar: 0, meter: M732 }];
  assert.equal(quantizeNotes([n(4.4)], { grid: '1/16', meterMap: m732 })[0].step, 4.5);
  assert.equal(quantizeNotes([n(4.4)], { grid: '1/16' })[0].step, 4, 'no meter: the old lines');
  // The last 16th of a 7/32 bar is a 32nd long: its end is the bar line.
  assert.equal(quantizeNotes([n(3.3)], { grid: '1/16', meterMap: m732 })[0].step, 3.5);
  // A roll clip with a pickup quantizes from its own bar lines.
  const clip = quantizeRollClip(
    { sourceRollNotes: [n(0.9)], sourcePianoRoll: [], sourceMeterMap: map, sourcePickupSteps: 0.5, sourceTotalSteps: 16.5 },
    { grid: '1/8', strength: 1 },
  );
  assert.equal(clip.sourceRollNotes[0].step, 0.5);
}

// ── grooves that follow each bar's groups ────────────────────────────────────

// Group swing 8ths in 7/8 3+2+2: the second 8th of each group lays back and no
// group downbeat moves. The bar groove Swing 8ths 66% delays two of the three
// group downbeats (steps 6 and 10), which is what the group groove is for.
{
  const map = [{ bar: 0, meter: M78 }];
  const eighths = [0, 2, 4, 6, 8, 10, 12].map((step) => ({ step }));
  const grouped = applyGrooveInMeter(eighths, grooveById('group8:66'), 1, map).map((n) => n.step);
  const late = 2 * (2 * 0.66 - 1);
  [0, 2 + late, 4, 6, 8 + late, 10, 12 + late].forEach((want, i) => close(grouped[i], want, `group swing 8th ${i}`));
  const barSwing = applyGrooveInMeter(eighths, grooveById('swing8:66'), 1, map).map((n) => n.step);
  assert.ok(barSwing[3] > 6 && barSwing[5] > 10, 'the bar groove moves the group downbeats');
  assert.deepEqual(groupStartsForPulse(M78, 2), [0, 6, 10]);
  assert.deepEqual(groupStartsForPulse(M44, 2), [0, 4, 8, 12], '4/4: each quarter is a group of two 8ths');
  assert.deepEqual(groupStartsForPulse({ num: 12, den: 8, groups: [] }, 2), [0, 6, 12, 18], 'a bare 12/8 counts dotted beats');
  // In 4/4 the group groove is the bar groove: the off 8ths lay back.
  const four = applyGrooveInMeter([0, 2, 4, 6].map((step) => ({ step })), grooveById('group8:66'), 1, [{ bar: 0, meter: M44 }]).map((n) => n.step);
  [0, 2 + late, 4, 6 + late].forEach((want, i) => close(four[i], want, `4/4 group swing ${i}`));
  // 6/8 3+3: long-short-plain in each dotted beat.
  const six = applyGrooveInMeter([0, 2, 4, 6, 8, 10].map((step) => ({ step })), grooveById('group8:66'), 1, [{ bar: 0, meter: M68 }]).map((n) => n.step);
  [0, 2 + late, 4, 6, 8 + late, 10].forEach((want, i) => close(six[i], want, `6/8 group swing ${i}`));
  // 7/16 3+2+2 swings its 16ths inside each group with the 16th groove.
  const s716 = applyGrooveInMeter([0, 1, 2, 3, 4, 5, 6].map((step) => ({ step })), grooveById('group16:66'), 1, [{ bar: 0, meter: { num: 7, den: 16, groups: [3, 2, 2] } }]).map((n) => n.step);
  const late16 = 2 * 0.66 - 1;
  [0, 1 + late16, 2, 3, 4 + late16, 5, 6 + late16].forEach((want, i) => close(s716[i], want, `7/16 group swing ${i}`));
}

// Notes inégales in 3/4: the halves of each beat long-short at 3:2 (the off 8th 0.4 of a step late).
{
  const out = applyGrooveInMeter([0, 2, 4, 6, 8, 10].map((step) => ({ step })), grooveById('inegales:60'), 1, [{ bar: 0, meter: M34 }]).map((n) => n.step);
  [0, 2.4, 4, 6.4, 8, 10.4].forEach((want, i) => close(out[i], want, `inégales ${i}`));
  // In 6/8 (beat unit an 8th) the 16ths are the unequal pair.
  const six = applyGrooveInMeter([0, 1, 2, 3].map((step) => ({ step })), grooveById('inegales:60'), 1, [{ bar: 0, meter: M68 }]).map((n) => n.step);
  [0, 1.2, 2, 3.2].forEach((want, i) => close(six[i], want, `6/8 inégales ${i}`));
}

// Double-dotting: a dotted 8th and 16th becomes a double-dotted 8th and 32nd.
{
  const figure = [{ step: 0 }, { step: 3 }, { step: 4 }, { step: 7 }];
  const out = applyGrooveInMeter(figure, grooveById('ddot:8'), 1, [{ bar: 0, meter: M44 }]).map((n) => n.step);
  assert.deepEqual(out, [0, 3.5, 4, 7.5]);
  const quarters = applyGrooveInMeter([{ step: 0 }, { step: 6 }], grooveById('ddot:4'), 1, [{ bar: 0, meter: M44 }]).map((n) => n.step);
  assert.deepEqual(quarters, [0, 7], 'a dotted quarter and 8th: the 8th moves to the last 16th');
  // Through APPLY with the store: the figure drawn on the 1/16 grid, APPLY at 100%.
  freshRoll([{ bar: 0, meter: M44 }], 16);
  click(0);
  click(3 * 240);
  apply(100, grooveById('ddot:8'));
  assert.deepEqual(byTick().map((n) => n.tick), [0, 840]);
  // A group groove sampled onto Virtuoso's 16 slots lands the same way.
  assert.equal(toVirtuosoTemplate(grooveById('ddot:8')).timing[3], 0.5);
}

// ── slots by exact place ─────────────────────────────────────────────────────

// A half-step pickup puts bar 1 on step 0.5: the note at 2.5 is bar 1's off 8th
// (slot 2, not swung by Swing 16ths). On 30a3edf applyGroove rounded it to step
// 3 first and swung it as an off 16th.
{
  const map = [{ bar: 0, meter: M44 }];
  const s16 = grooveById('swing16:66');
  const legacy = applyGroove([{ step: 2.5 }, { step: 3.5 }], s16, 4, 1, (s) => barAt(map, s, 0.5).start);
  assert.deepEqual(legacy.map((n) => n.step), [2.5, 3.5 + (2 * 0.66 - 1)]);
  const metered = applyGrooveInMeter([{ step: 2.5 }, { step: 3.5 }], s16, 1, map, 0.5);
  assert.deepEqual(metered.map((n) => n.step), [2.5, 3.5 + (2 * 0.66 - 1)]);
  // A 7/32 bar (3.5 steps): its second bar starts at 3.5, where slot 0 sits.
  const m732 = [{ bar: 0, meter: M732 }];
  const bar2 = applyGrooveInMeter([{ step: 3.5 }, { step: 4.5 }], s16, 1, m732).map((n) => n.step);
  assert.deepEqual(bar2, [3.5, 4.5 + (2 * 0.66 - 1)]);
}

// ── grooves learned from a file, sized to its bar ────────────────────────────

/** A one-track file in `num/den` with a note on every 16th for `bars` bars, each `late` of a step behind, after `pickup` steps. */
const fileIn = (num: number, den: number, bars: number, late: (slot: number) => number, pickup = 0): Uint8Array => {
  const barSteps = (num * 16) / den;
  const slotSteps = Number.isInteger(barSteps) ? 1 : 0.5;
  const notes = [];
  for (let b = 0; b < bars; b += 1) {
    for (let s = 0; s * slotSteps < barSteps - 1e-9; s += 1) {
      const step = pickup + b * barSteps + s * slotSteps + late(s);
      notes.push({ tick: Math.round(step * 120), note: 60, velocity: 90, durationTicks: 60, channel: 0 });
    }
  }
  const timeSignatures = meterMapToMidiEvents([{ bar: 0, meter: { num, den, groups: [] } }], 480, pickup);
  return encodeMidi({ ppq: 480, bpm: 120, timeSignatures, tracks: [{ name: 'ref', notes }] });
};

// A 7/8 reference: 14 slots, one per 16th, each with its own lateness. On
// 30a3edf the pocket had 16 slots, so a 7/8 bar's pocket never filled slots 14
// and 15 and a 12/8 bar wrapped onto the first 8 slots.
{
  const pocket = buildGrooveFromMidiBytes(fileIn(7, 8, 3, (s) => (s % 2 ? 0.25 : 0)), '7/8 ref');
  assert.ok(pocket);
  assert.equal(pocket.timing.length, 14);
  assert.equal(pocket.slotSteps, 1);
  pocket.timing.forEach((t, s) => close(t, s % 2 ? 0.25 : 0, `7/8 slot ${s}`, 1 / 120));
  const twelve = buildGrooveFromMidiBytes(fileIn(12, 8, 2, (s) => (s === 20 ? 0.3 : 0)), '12/8 ref');
  assert.ok(twelve);
  assert.equal(twelve.timing.length, 24);
  close(twelve.timing[20], 0.3, '12/8 slot 20', 1 / 120);
  close(twelve.timing[4], 0, '12/8 slot 4 does not take slot 20', 1 / 120);
  // A 7/32 reference: seven 32nd slots, a half step each.
  const small = buildGrooveFromMidiBytes(fileIn(7, 32, 4, (s) => (s === 6 ? 0.1 : 0)), '7/32 ref');
  assert.ok(small);
  assert.deepEqual([small.timing.length, small.slotSteps], [7, 0.5]);
  close(small.timing[6], 0.1, '7/32 slot 6', 1 / 120);
  // A half-step pickup: onsets are read from their own bar lines, so a file played dead on reads flat.
  const picked = buildGrooveFromMidiBytes(fileIn(4, 4, 2, () => 0, 0.5), 'pickup ref');
  assert.ok(picked);
  assert.ok(picked.timing.every((t) => Math.abs(t) < 1e-9), `a dead-on file with a half-step pickup reads flat: ${picked.timing}`);

  // The roll's template spans the reference bar, and applies slot for slot in 7/8.
  const g = fromVirtuosoTemplate(pocket);
  assert.deepEqual([g.slots, g.barSteps], [14, 14]);
  const moved = applyGrooveInMeter([{ step: 13 }, { step: 14 }, { step: 15 }], g, 1, [{ bar: 0, meter: M78 }]).map((n) => n.step);
  close(moved[0], 13.25, '7/8 slot 13');
  close(moved[1], 14, 'the next bar starts on slot 0');
  close(moved[2], 15.25, 'and slot 1');
  // Back to Virtuoso's pocket, it keeps its 14 slots.
  const back = toVirtuosoTemplate(g);
  assert.deepEqual([back.timing.length, back.slotSteps], [14, 1]);
  // An older 16-slot pocket (no slotSteps) still converts as it did.
  assert.equal(fromVirtuosoTemplate({ name: 'old', timing: new Array(16).fill(0.1), accent: new Array(16).fill(1) }).barSteps, undefined);

  // Virtuoso's humanize reads a 24-slot 12/8 pocket at slot 20, where 30a3edf wrapped at 16.
  const only20: Pocket = { name: '20', timing: Array.from({ length: 24 }, (_, i) => (i === 20 ? 0.3 : 0)), accent: new Array(24).fill(0.5), slotSteps: 1 };
  const opts = { meterMap: [{ bar: 0, meter: { num: 12, den: 8, groups: [3, 3, 3, 3] } }] };
  const src: PianoNote[] = [{ id: 'h', note: 60, step: 20, length: 1, velocity: 90 }];
  const drift = humanize(src, 1, 3, only20, opts)[0].step - 20;
  close(drift, 0.3, 'humanize takes slot 20 of a 12/8 pocket', 0.02);
}

// ── lanes with their own time ────────────────────────────────────────────────

// A 3:2 lane in a 4/4 roll: its beats are two thirds of the roll's, its 16ths
// 160 ticks, its bars 10.67 steps; a lane with a 7/8 3+2+2 meter draws its own
// group lines while the roll stays in 4/4.
{
  const map = [{ bar: 0, meter: M44 }];
  const triplet: PolyLane = { id: 1, name: 'B', cycleSteps: null, tuplet: { n: 3, m: 2 } };
  const lt = laneTimeOf(triplet, map, 0);
  assert.ok(lt);
  close(lt.scale, 2 / 3, '3:2 scale');
  const tiers = laneGridLines(lt, 32);
  close(tiers.bar[1], 32 / 3, 'lane bar 2 starts at 10.67 steps');
  assert.deepEqual(laneSnapGrid(lt, 32, '1/16').lines.slice(0, 5), [0, 160, 320, 480, 640]);
  assert.equal(laneBarSteps(triplet, map), 10.67);
  const odd: PolyLane = { id: 2, name: 'C', cycleSteps: null, meterMap: [{ bar: 0, meter: M78 }] };
  const oddTime = laneTimeOf(odd, map, 0);
  assert.ok(oddTime);
  assert.deepEqual(laneGridLines(oddTime, 28).group, [6, 10, 20, 24]);
  assert.equal(laneTimeOf({ id: 0, name: 'A', cycleSteps: null, tuplet: { n: 3, m: 2 } }, map), null, 'lane A reads the roll');
  assert.equal(laneTimeOf({ id: 3, name: 'D', cycleSteps: null }, map), null, 'a lane with no time of its own reads the roll');
  // A roll pickup is the lane's pickup too: its bar 1 is the roll's bar 1.
  const withPickup = laneTimeOf(triplet, map, 4);
  assert.ok(withPickup);
  close(laneGridLines(withPickup, 32).bar[1], 4, 'lane bar 1 on the roll bar 1');
  // Ratios: whole 1..16, n equal to m is straight.
  assert.deepEqual(sanitizeTuplet({ n: 5, m: 4 }), { n: 5, m: 4 });
  assert.equal(sanitizeTuplet({ n: 4, m: 4 }), undefined);
  assert.equal(sanitizeTuplet({ n: 17, m: 4 }), undefined);
  assert.equal(sanitizeTuplet({ n: 2.5, m: 4 }), undefined);
  assert.deepEqual(stepLaneTuplet(undefined, 'n', 1), { n: 2, m: 1 });
  // In + from 3:2 steps over 3:3 to 3:4, and the lane keeps its 3; In - comes back to 3:2.
  assert.deepEqual(stepLaneTuplet({ n: 3, m: 2 }, 'm', 1), { n: 3, m: 4 }, 'the press steps over straight');
  assert.deepEqual(stepLaneTuplet(stepLaneTuplet({ n: 3, m: 2 }, 'm', 1), 'm', 1), { n: 3, m: 5 }, 'the next press keeps the 3');
  assert.deepEqual(stepLaneTuplet({ n: 3, m: 4 }, 'm', -1), { n: 3, m: 2 });
  assert.deepEqual(stepLaneTuplet({ n: 4, m: 3 }, 'n', -1), { n: 2, m: 3 });
  // Nowhere to go: 2:1 cannot lower its 2 past the 1, 16:15 cannot raise its 15 past 16; the arrow is off.
  assert.deepEqual(stepLaneTuplet({ n: 2, m: 1 }, 'n', -1), { n: 2, m: 1 });
  assert.equal(canStepLaneTuplet({ n: 2, m: 1 }, 'n', -1), false);
  assert.deepEqual(stepLaneTuplet({ n: 16, m: 15 }, 'm', 1), { n: 16, m: 15 });
  assert.equal(canStepLaneTuplet({ n: 16, m: 15 }, 'm', 1), false);
  assert.equal(canStepLaneTuplet(undefined, 'n', -1), false, 'straight cannot go below 1:1');
  assert.equal(canStepLaneTuplet({ n: 3, m: 2 }, 'm', 1), true);
  assert.equal(tupletLabel({ n: 3, m: 2 }), '3:2');
  assert.equal(tupletLabel(undefined), 'Straight');
  assert.equal(laneTimeLabel({ ...odd, tuplet: { n: 3, m: 2 } }), '7/8 3+2+2 · 3:2');
  assert.equal(laneTimeLabel(triplet), 'Roll meter · 3:2');
  assert.deepEqual(laneMeterFromValue('7/8 3+2+2'), [{ bar: 0, meter: M78 }]);
  assert.equal(laneMeterFromValue(''), null);
  // The typed meter takes any meter the roll can hold, 11/16 3+3+3+2 included.
  assert.deepEqual(laneMeterFromText(' 11/16  3+3+3+2 '), [{ bar: 0, meter: { num: 11, den: 16, groups: [3, 3, 3, 2] } }]);
  assert.deepEqual(laneMeterFromText('5/4'), [{ bar: 0, meter: { num: 5, den: 4, groups: [] } }]);
  assert.equal(laneMeterFromText(''), null, 'empty reads the roll');
  assert.equal(laneMeterFromText('11/12'), undefined, 'no /12 unit');
  assert.equal(laneMeterFromText('7/8 3+3'), undefined, 'groups that miss the beats');
  assert.equal(laneMeterFromText('seven'), undefined);
}

// The TIME card's sequence through the store: set lane B to 5/8 in 3:2, draw
// into it with the snap, undo and redo the time, save the roll as a clip and
// open it, open a clip an older build saved, and send it through MIDI.
{
  freshRoll([{ bar: 0, meter: M44 }], 32, 0, [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 16 }]);
  st().setActiveLane(1);
  st().setLaneTime(1, { meterMap: laneMeterFromValue('5/8'), tuplet: { n: 3, m: 2 } });
  const laneB = () => st().lanes.find((l) => l.id === 1)!;
  assert.deepEqual(laneB().meterMap, [{ bar: 0, meter: { num: 5, den: 8, groups: [] } }]);
  assert.deepEqual(laneB().tuplet, { n: 3, m: 2 });
  // A click on the 1/8 snap lands on lane B's own 8ths: 480 × 2/3 = 320 ticks apart.
  st().setSnap('1/8');
  const a = click(320);
  const b = click(640 + 20);
  assert.deepEqual([a, b].map((id) => st().notes.find((n) => n.id === id)!.tick), [320, 640]);
  assert.deepEqual([a, b].map((id) => st().notes.find((n) => n.id === id)!.lane), [1, 1]);
  st().setSnap('1/16');
  // GEN writes one lane bar per pass: 5/8 is 10 steps, 3:2 makes it 6.67 roll steps. Lane B loops, so GEN takes its cycle.
  st().setLaneCycle(1, null);
  const t = genTarget(st(), 0);
  close(t.passLen, 20 / 3, 'GEN pass is a lane bar');
  assert.equal(t.meter?.num, 5);
  st().setLaneCycle(1, 16);
  // Clearing the ratio a moment later is its own undo step; redo clears it again.
  await pause();
  const before = st().lanes;
  st().setLaneTime(1, { tuplet: null });
  assert.equal(laneB().tuplet, undefined);
  assert.deepEqual(laneB().meterMap, [{ bar: 0, meter: { num: 5, den: 8, groups: [] } }], 'a field left out stays');
  st().undo();
  assert.deepEqual(st().lanes, before);
  st().redo();
  assert.equal(laneB().tuplet, undefined);
  st().undo();
  // Lane A keeps the roll's time.
  st().setLaneTime(0, { tuplet: { n: 3, m: 2 } });
  assert.equal(st().lanes[0].tuplet, undefined);

  // Saved as a clip and opened again: the lane keeps its meter and ratio.
  const fields = rollClipFields(st());
  const saved = JSON.parse(JSON.stringify({ id: 'clip-lanes', ...fields }));
  const [, , , , meter] = clipRollLoad(saved);
  assert.deepEqual(meter.lanes.find((l) => l.id === 1), { id: 1, name: 'B', cycleSteps: 16, meterMap: [{ bar: 0, meter: { num: 5, den: 8, groups: [] } }], tuplet: { n: 3, m: 2 } });
  st().loadFromClip(...clipRollLoad(saved));
  assert.deepEqual(laneB().tuplet, { n: 3, m: 2 });
  // Saved in a .tasmo project (the file's snake_case) and loaded again: the lane keeps its time.
  const tasmo = JSON.parse(JSON.stringify(clipMeterToTasmo(fields)));
  assert.deepEqual(tasmo.lanes[1], { id: 1, name: 'B', cycle_steps: 16, meter_map: [{ bar: 0, meter: { num: 5, den: 8, groups: [] } }], tuplet: { n: 3, m: 2 } });
  assert.deepEqual(tasmo.lanes[0], { id: 0, name: 'A', cycle_steps: null }, 'lane A writes the keys it always wrote');
  const reopened = tasmoMeterToClip(tasmo);
  assert.deepEqual(clipRollLoad({ id: 'tasmo', ...reopened })[4].lanes, st().lanes);
  // A .tasmo lane written before lanes had a time loads in the roll's time.
  assert.deepEqual(tasmoMeterToClip({ lanes: [{ id: 0, name: 'A', cycle_steps: null }, { id: 1, name: 'B', cycle_steps: 16 }] }).sourceLanes, [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'B', cycleSteps: 16 },
  ]);
  // A clip an older build saved has lanes with no time: they open as they did.
  const older = { ...saved, sourceLanes: [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 16 }] };
  assert.deepEqual(clipRollLoad(older)[4].lanes, [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 16 }]);
  // Junk in a saved lane's time is dropped, the lane kept.
  assert.deepEqual(sanitizeLanes([{ id: 1, name: 'B', cycleSteps: 8, tuplet: { n: 0, m: 2 }, meterMap: [] }]), [
    { id: 0, name: 'A', cycleSteps: null },
    { id: 1, name: 'B', cycleSteps: 8 },
  ]);

  // Through MIDI: one track per lane with its lane text, and every lane back on import.
  const file = rollToMidiFile(st());
  assert.deepEqual(file.tracks.map((tr) => tr.name), ['Lane A', 'Lane B']);
  const back = midiFileToRoll(parseMidi(encodeMidi(file)), 'rt');
  assert.deepEqual(back.meter.lanes, st().lanes);
  // Lane B loops every 16 steps; the file holds its repeats, the import its first cycle.
  assert.equal(file.tracks[1].notes.length, 4);
  assert.deepEqual(back.notes.filter((n) => n.lane === 1).map((n) => n.tick).sort((x, y) => x - y), [320, 640]);
  st().importNotes(back.notes, back.bpm, back.meter, back.bends);
  assert.deepEqual(laneB().meterMap, [{ bar: 0, meter: { num: 5, den: 8, groups: [] } }]);
}

// A lane with no notes and a lane name past ASCII both survive the file.
{
  const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }, { id: 2, name: 'Ωmega', cycleSteps: null, tuplet: { n: 5, m: 4 } }];
  const roll = { notes: [{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }] as PianoNote[], lanes, totalSteps: 16, bpm: 120, meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, bends: [] };
  const bytes = encodeMidi(rollToMidiFile(roll));
  assert.ok(bytes.every((x) => x <= 0xff));
  const back = midiFileToRoll(parseMidi(bytes), 'e');
  assert.deepEqual(back.meter.lanes, lanes);
  assert.equal(parseLaneMeta('not json'), null);
  assert.equal(parseLaneMeta('{"id":-1}'), null);
}

// APPLY in a 3:2 lane quantizes onto the lane's own 16ths.
{
  freshRoll([{ bar: 0, meter: M44 }], 32, 0, [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null, tuplet: { n: 3, m: 2 } }]);
  st().setActiveLane(1);
  const id = click(480);
  st().setNoteTimes([{ id, tick: 500 }]);
  apply(100, grooveById('straight'));
  assert.equal(st().notes[0].tick, 480, "the lane's 16th line (3 × 160)");
  // The same note in lane A goes to the roll's 16th.
  usePianoRollStore.setState({ notes: st().notes.map((n) => ({ ...n, lane: undefined, tick: 500, step: 500 / 240 })) });
  apply(100, grooveById('straight'));
  assert.equal(st().notes[0].tick, 480);
  usePianoRollStore.setState({ notes: st().notes.map((n) => ({ ...n, tick: 390, step: 390 / 240 })) });
  apply(100, grooveById('straight'));
  assert.equal(st().notes[0].tick, 480, 'lane A: nearest roll 16th to 390 is 480');
}

// ── polyrhythm writes real cross-rhythms ─────────────────────────────────────

{
  assert.deepEqual(crossSpans(M78), [{ start: 0, len: 6, beats: 3 }, { start: 6, len: 4, beats: 2 }, { start: 10, len: 4, beats: 2 }]);
  assert.deepEqual(crossSpans(M44), [{ start: 0, len: 8, beats: 2 }, { start: 8, len: 8, beats: 2 }]);
  assert.deepEqual(crossSpans(M34), [{ start: 0, len: 12, beats: 3 }]);
  assert.deepEqual(crossSpans({ num: 5, den: 4, groups: [] }), [{ start: 0, len: 8, beats: 2 }, { start: 8, len: 12, beats: 3 }]);
  assert.deepEqual(crossSpans(M68).map((s) => s.beats), [3, 3]);
  assert.deepEqual(crossSpans({ num: 4, den: 4, groups: [] }).length, 2);

  // A held chord across a bar of 4/4 at amount 1: 3:2 over each half bar, the
  // cross notes a third of a half bar apart, above the bass.
  const chord: PianoNote[] = [48, 55, 64].map((note, i) => ({ id: `c${i}`, note, step: 0, length: 16, velocity: 80 }));
  const out = polyrhythm(chord, 1, { key: 'C', mode: 'major', meterMap: [{ bar: 0, meter: M44 }] }, 1);
  const cross = out.filter((n) => n.id.endsWith(CROSS_ID_SUFFIX));
  assert.deepEqual(cross.map((n) => n.step), [2.667, 5.333, 10.667, 13.333], 'the chord still sounds in the second half, so it takes one too');
  assert.deepEqual(cross.map((n) => n.note), [67, 76, 67, 76], 'the chord tones above the bass, an octave up');
  // In 7/8 3+2+2 each group takes its own ratio: 4:3 over the 3, 3:2 over each 2.
  const long: PianoNote[] = [{ id: 'd', note: 50, step: 0, length: 14, velocity: 80 }, { id: 'e', note: 57, step: 0, length: 14, velocity: 80 }];
  const seven = polyrhythm(long, 1, { key: 'C', mode: 'major', meterMap: [{ bar: 0, meter: M78 }] }, 1).filter((n) => n.id.endsWith(CROSS_ID_SUFFIX));
  assert.deepEqual(seven.map((n) => n.step), [1.5, 3, 4.5, 7.333, 8.667, 11.333, 12.667]);
  // Into the roll the cross notes land on exact ticks: 7.333 steps is 1760 ticks.
  freshRoll([{ bar: 0, meter: M78 }], 14);
  st().importNotes(polyrhythm(long, 1, { key: 'C', mode: 'major', meterMap: [{ bar: 0, meter: M78 }] }, 1));
  const ticks = st().notes.filter((n) => n.id.endsWith(CROSS_ID_SUFFIX)).map((n) => n.tick).sort((x, y) => (x ?? 0) - (y ?? 0));
  assert.deepEqual(ticks, [360, 720, 1080, 1760, 2080, 2720, 3040]);
  // Amount 0 writes nothing new.
  assert.equal(polyrhythm(long, 0, { key: 'C', mode: 'major' }, 1).some((n) => n.id.endsWith(CROSS_ID_SUFFIX)), false);
}

// Normalized maps and the store agree on a lane's saved meter.
assert.deepEqual(normalizeMeterMap([{ bar: 0, meter: M78 }]), [{ bar: 0, meter: M78 }]);

console.log('grooveLanes: ok');
