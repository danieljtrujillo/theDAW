// Run with: npx tsx src/lib/rollSnap.test.ts
//
// The roll's snap grid and the editing gestures that land on it, replayed in
// the order and with the arguments PianoRoll.tsx uses against the REAL store:
// a click that adds a note, a note drag, a resize, the arrow nudge, the note
// menu, a paste, and TUPLET. Then a quintuplet drawn with the snap goes out as
// a MIDI file, comes back in, and plays at its own times. The component itself
// cannot mount in node (its module graph reads import.meta.env); the wiring is
// what the browser pass covers.
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi } from './midi.ts';
import { gridLines, type MeterSegment } from './meterMap.ts';
import { stepRenderRequest } from './midiSynth.ts';
import { copyNotes, pasteNotes } from './noteClipboard.ts';
import { midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import {
  DEFAULT_ROLL_SNAP,
  ROLL_SNAPS,
  TICKS_PER_STEP,
  cellAt,
  clickPlacement,
  defaultTupletM,
  floorLine,
  isRollSnapId,
  lengthenTicks,
  menuNudgeTick,
  moveBlock,
  nearestLine,
  nextLine,
  nudgeTicks,
  resizeTicks,
  selectedOnsets,
  shortenTicks,
  snapGrid,
  snapLineSteps,
  tupletUpdates,
} from './rollSnap.ts';
import { beginRollGesture, endRollGesture, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const STEP_PX = 16;
const NOTE_HEIGHT = 12;
/** The x (px) a click lands at for `tick`, a little inside its cell. */
const xAt = (tick: number): number => ((tick + 10) / TICKS_PER_STEP) * STEP_PX;

/** A fresh roll: `map`, no pickup, `totalSteps`, the full piano, no notes, nothing selected, empty history. */
const freshRoll = (map: MeterSegment[], totalSteps = 64, pickupSteps = 0) => {
  usePianoRollStore.setState({
    meterMap: map,
    pickupSteps,
    totalSteps,
    lowestNote: 21,
    highestNote: 108,
    notes: [],
    selectedIds: new Set(),
    selectedNoteId: null,
    lanes: [{ id: 0, name: 'A', cycleSteps: null }],
    activeLane: 0,
    bends: [],
  });
  resetClock();
};

/** Empty history and a reset coalesce clock, the document untouched. */
const resetClock = () => {
  // Seed one step whose snapshot is the state just written and undo it: the
  // stacks are empty and the recorder's coalesce clock is reset, so the block's
  // first edit starts a fresh undo step (state/pianoRollHistory.test.ts).
  const s = st();
  usePianoRollStore.setState({
    _undo: [{
      notes: s.notes, bpm: s.bpm, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote,
      meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, voiceProgram: s.voiceProgram, tempoMap: s.tempoMap,
    }],
    _redo: [],
  });
  st().undo();
};

/** A click on empty grid at `tick` and `midi`, as handleGridClick adds it. */
const click = (tick: number, midi = 60): string => {
  const g = snapGrid(st().meterMap, st().pickupSteps, st().totalSteps, st().snap);
  const placed = clickPlacement(g, xAt(tick), STEP_PX);
  assert.ok(placed, `a click at tick ${tick} lands on the roll`);
  return st().addNote({ note: midi, step: placed.tick / TICKS_PER_STEP, length: placed.ticks / TICKS_PER_STEP, tick: placed.tick, ticks: placed.ticks, velocity: 96 });
};
const ticksOf = (ids: string[]) => ids.map((id) => st().notes.find((n) => n.id === id)!).map((n) => [n.tick, n.ticks]);

// The select's choices: every division the ticket names, 1/16 first by default.
{
  assert.deepEqual(ROLL_SNAPS.map((d) => d.id), ['1/4', '1/8', '1/16', '1/32', '1/64', '1/8T', '1/16T', '1/16Q', '1/16S', '1/8D', 'group']);
  assert.equal(DEFAULT_ROLL_SNAP, '1/16');
  assert.equal(st().snap, '1/16', 'a roll with no saved snap opens on 1/16');
  assert.equal(isRollSnapId('1/16Q'), true);
  assert.equal(isRollSnapId('1/7'), false);
  st().setSnap('1/16Q');
  assert.equal(st().snap, '1/16Q');
  st().setSnap('nonsense' as never);
  assert.equal(st().snap, '1/16Q', 'an unknown snap leaves the grid as it is');
  st().setSnap('1/16');
}

// The 1/16 grid is the roll's old grid: a line every step, a click draws an 8th on the cell.
{
  const g = snapGrid([{ bar: 0, meter: M44 }], 0, 32, '1/16');
  assert.deepEqual(g.lines, Array.from({ length: 33 }, (_, i) => i * 240));
  assert.deepEqual(clickPlacement(g, 5.5 * STEP_PX, STEP_PX), { tick: 5 * 240, ticks: 480 });
  assert.equal(clickPlacement(g, 32 * STEP_PX, STEP_PX), null, 'past the end is off the roll');
}

// Triplets restart on every group of 7/8 3+2+2, so they never drift across the bar.
{
  const g = snapGrid([{ bar: 0, meter: M78 }], 0, 14, '1/8T');
  // Groups start at 0, 1440 and 2400 ticks; the bar ends at 3360.
  assert.deepEqual(g.lines, [0, 320, 640, 960, 1280, 1440, 1760, 2080, 2400, 2720, 3040, 3360]);
  assert.deepEqual(cellAt(g, 1300), { start: 1280, end: 1440 }, 'the group before a group start ends on it');
  const q = snapGrid([{ bar: 0, meter: M78 }], 0, 14, '1/16Q');
  assert.ok([1440, 1440 + 192, 2400, 2400 + 192].every((t) => q.lines.includes(t)), 'quintuplets restart on each group');
}

// A /32 bar's groups start on half steps, and its grid keeps them (no rounding drift).
{
  const m732 = { num: 7, den: 32, groups: [3, 2, 2] };
  // 7/32 is 3.5 steps (840 ticks); 3+2+2 32nds start at 0, 1.5 and 2.5 steps.
  assert.deepEqual(gridLines([{ bar: 0, meter: m732 }], 7, 0).group, [1.5, 2.5, 5, 6], 'group lines on half steps, bar after bar');
  const g = snapGrid([{ bar: 0, meter: m732 }], 0, 7, '1/32');
  assert.deepEqual(g.lines, [0, 120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200, 1320, 1440, 1560, 1680]);
}

// A pickup counts its grid back from bar 1; GROUP puts one cell on each pulse.
{
  const g = snapGrid([{ bar: 0, meter: M44 }], 3, 19, '1/8');
  assert.deepEqual(g.lines.slice(0, 4), [0, 240, 720, 1200], 'a dotted-8th pickup: 16th, then 8ths up to bar 1');
  const grp = snapGrid([{ bar: 0, meter: M78 }], 0, 14, 'group');
  assert.deepEqual(grp.lines, [0, 1440, 2400, 3360], '7/8 3+2+2: its three groups');
  const six = snapGrid([{ bar: 0, meter: { num: 6, den: 8, groups: [] } }], 0, 12, 'group');
  assert.deepEqual(six.lines, [0, 1440, 2880], 'a bare 6/8 pulses on its dotted beats');
  const four = snapGrid([{ bar: 0, meter: M44 }], 0, 16, 'group');
  assert.deepEqual(four.lines, [0, 960, 1920, 2880, 3840], '4/4 with no groups pulses on its beats');
}

// Line lookups: floor, nearest, next either way, and the roll's edges.
{
  const g = snapGrid([{ bar: 0, meter: M44 }], 0, 16, '1/16T');
  assert.equal(floorLine(g, 170), 160);
  assert.equal(nearestLine(g, 250), 320);
  assert.equal(nearestLine(g, 240), 160, 'a tie goes to the earlier line');
  assert.equal(nextLine(g, 160, 1), 320);
  assert.equal(nextLine(g, 160, -1), 0);
  assert.equal(nextLine(g, 170, -1), 160, 'from between lines, back is the line before');
  assert.equal(nextLine(g, 0, -1), null);
  assert.equal(nextLine(g, g.end, 1), null);
}

// Drawing: the snap's own lines less the tiers, only where a cell is wide enough.
{
  const map = [{ bar: 0, meter: M44 }];
  const g = snapGrid(map, 0, 16, '1/16T');
  const t = gridLines(map, 16, 0);
  const drawn = new Set([...t.bar, ...t.group, ...t.beat]);
  const steps = snapLineSteps(g, 24, drawn, 10);
  assert.ok(steps.includes(2 / 3) && steps.includes(4 / 3) && !steps.includes(4), 'triplet lines, not the beat lines');
  assert.deepEqual(snapLineSteps(g, 12, drawn, 10), [], 'a 2/3-step cell at 12px is 8px: too narrow to draw');
}

// A quintuplet drawn with the snap: five clicks in bar 2 land on 192-tick cells, go out as a
// MIDI file and come back on the same ticks, and play 0.1 s apart at 120 BPM.
{
  freshRoll([{ bar: 0, meter: M44 }], 64);
  st().setSnap('1/16Q');
  const bar2 = 16 * TICKS_PER_STEP;
  const ids = [0, 1, 2, 3, 4].map((k) => click(bar2 + k * 192, 60 + k));
  assert.deepEqual(ticksOf(ids), [0, 1, 2, 3, 4].map((k) => [bar2 + k * 192, 192]));
  const file = rollToMidiFile({ ...st(), bpm: 120 });
  const back = midiFileToRoll(parseMidi(encodeMidi(file)));
  const byPitch = [...back.notes].sort((a, b) => a.note - b.note);
  assert.deepEqual(byPitch.map((n) => [n.tick, n.ticks]), [0, 1, 2, 3, 4].map((k) => [bar2 + k * 192, 192]), 'the MIDI round trip keeps every quintuplet tick');
  const sounding = stepRenderRequest(st().notes, 120, st().totalSteps).notes.sort((a, b) => a.midi - b.midi);
  sounding.forEach((n, k) => {
    assert.ok(Math.abs(n.startSec - (2 + k * 0.1)) < 1e-9, `quintuplet ${k} sounds at ${2 + k * 0.1}s, not ${n.startSec}s`);
    assert.ok(Math.abs(n.durationSec - 0.1) < 1e-9);
  });
  st().setSnap('1/16');
}

// A note drag moves the selection on the grid as one block; each move measures from the origins.
// The moves come half a second apart, a slow drag, and the gesture is still one undo step.
{
  freshRoll([{ bar: 0, meter: M78 }], 28);
  st().setSnap('1/8T');
  const a = click(0, 60);
  const b = click(320, 64);
  st().setSelection([a, b], a);
  const g = snapGrid(st().meterMap, 0, st().totalSteps, '1/8T');
  const origins = st().notes.map((n) => ({ id: n.id, tick: n.tick!, note: n.note }));
  resetClock();
  const realNow = performance.now;
  let clock = 10_000;
  performance.now = () => clock;
  const bounds = { endTick: g.end, lowestNote: 21, highestNote: 108 };
  beginRollGesture();
  // 330 ticks right (22px at 16px a step) and one row up: the primary lands on 320, b keeps its 320 offset.
  st().setNoteTimes(moveBlock(g, origins, a, (330 / TICKS_PER_STEP) * STEP_PX, -NOTE_HEIGHT, STEP_PX, NOTE_HEIGHT, bounds));
  assert.deepEqual(st().notes.map((n) => [n.tick, n.note]), [[320, 61], [640, 65]]);
  clock += 500;
  // Past the group start at 1440 the primary rides the next group's grid.
  st().setNoteTimes(moveBlock(g, origins, a, (1500 / TICKS_PER_STEP) * STEP_PX, 0, STEP_PX, NOTE_HEIGHT, bounds));
  assert.equal(st().notes[0].tick, 1440);
  clock += 500;
  // Left past the roll's start: the block stops at 0 without losing its shape.
  st().setNoteTimes(moveBlock(g, origins, b, -40 * STEP_PX, 0, STEP_PX, NOTE_HEIGHT, bounds));
  assert.deepEqual(st().notes.map((n) => n.tick), [0, 320]);
  assert.deepEqual([...st().selectedIds], [a, b], 'the dragged notes stay selected');
  endRollGesture();
  assert.equal(st()._undo.length, 1, 'a drag is one undo step however long it pauses between lines');
  // The next edit, even inside 300 ms of the drop, is a step of its own.
  clock += 50;
  st().nudgeSelected(1, 0);
  assert.equal(st()._undo.length, 2, 'an edit right after the drop is its own step');
  st().undo();
  st().undo();
  assert.deepEqual(st().notes.map((n) => [n.tick, n.note]), [[0, 60], [320, 64]], 'undo puts the notes back where the drag found them');
  // A slow resize, the note's end crossing two lines a second apart: one step too.
  resetClock();
  beginRollGesture();
  st().setNoteTimes([{ id: a, ticks: 320 }]);
  clock += 1000;
  st().setNoteTimes([{ id: a, ticks: 480 }]);
  endRollGesture();
  assert.equal(st()._undo.length, 1, 'a slow resize is one undo step');
  // The same writes a second apart with no gesture open are two steps, which is what the gesture changes.
  resetClock();
  clock += 1000;
  st().setNoteTimes([{ id: a, ticks: 160 }]);
  clock += 1000;
  st().setNoteTimes([{ id: a, ticks: 320 }]);
  assert.equal(st()._undo.length, 2, 'writes a second apart outside a gesture are separate steps');
  performance.now = realNow;
  st().setSnap('1/16');
}

// A resize lands the end on the grid; a note shorter than a cell keeps its length until the drag makes it longer.
{
  const g = snapGrid([{ bar: 0, meter: M44 }], 0, 16, '1/16T');
  assert.equal(resizeTicks(g, 0, 160, (330 / TICKS_PER_STEP) * STEP_PX, STEP_PX), 480, 'two cells more');
  assert.equal(resizeTicks(g, 0, 160, -200, STEP_PX), 160, 'never shorter than a cell');
  assert.equal(resizeTicks(g, 0, 60, -4, STEP_PX), 60, 'a 64th on the triplet grid keeps its length while its end is nearer the start');
  assert.equal(resizeTicks(g, 0, 60, 1.2 * STEP_PX, STEP_PX), 320);
}

// The arrow nudge moves the selection a cell of the snap along the primary note's grid.
{
  freshRoll([{ bar: 0, meter: M78 }], 14);
  st().setSnap('1/16Q');
  const a = click(1440, 60);
  st().setSelection([a], a);
  const g = snapGrid(st().meterMap, 0, st().totalSteps, '1/16Q');
  st().nudgeSelected(nudgeTicks(g, st().notes[0].tick!, 1) / TICKS_PER_STEP, 0);
  assert.equal(st().notes[0].tick, 1440 + 192);
  st().nudgeSelected(nudgeTicks(g, st().notes[0].tick!, -1, 4) / TICKS_PER_STEP, 0);
  // Back from 1632: 1440 (the group start), then the first group's own quintuplets 1344, 1152, 960.
  assert.equal(st().notes[0].tick, 960, 'Shift: four lines back, across the group start onto the grid of the first group');
  st().setSnap('1/16');
}

// The note menu: Lengthen, Shorten and the nudges step to the neighbouring lines.
{
  const g = snapGrid([{ bar: 0, meter: M44 }], 0, 16, '1/16T');
  assert.equal(lengthenTicks(g, { tick: 160, ticks: 160 }), 320);
  assert.equal(shortenTicks(g, { tick: 160, ticks: 320 }), 160);
  assert.equal(shortenTicks(g, { tick: 160, ticks: 160 }), null, 'one cell cannot shorten');
  assert.equal(menuNudgeTick(g, 160, -1), 0);
  assert.equal(menuNudgeTick(g, 0, -1), null);
  assert.equal(menuNudgeTick(g, 170, 1), 320, 'an off-grid note nudges onto the next line');
}

// A paste keeps its fractional landing step: a copy lands on a triplet line, not the 16th before it.
{
  freshRoll([{ bar: 0, meter: M44 }], 32);
  const id = st().addNote({ note: 60, step: 0, length: 1, velocity: 90 });
  const payload = copyNotes(st().notes, [id])!;
  const added = pasteNotes(payload, 800 / TICKS_PER_STEP, { lowestNote: 21, highestNote: 108, totalSteps: 32 });
  st().appendNotes(added);
  assert.equal(st().notes.find((n) => n.id === added[0].id)!.tick, 800);
}

// TUPLET: five 16ths respaced 5 in the time of 4 16ths, a chord moving as one, in one undo step.
{
  freshRoll([{ bar: 0, meter: M44 }], 32);
  const ids = [0, 1, 2, 3, 4].map((k) => st().addNote({ note: 60 + k, step: k, length: 1, velocity: 90 }));
  const chord = st().addNote({ note: 50, step: 2, length: 1, velocity: 90 });
  st().setSelection([...ids, chord]);
  resetClock();
  assert.deepEqual(selectedOnsets(st().notes, st().selectedIds), [0, 240, 480, 720, 960]);
  assert.equal(defaultTupletM(5), 4);
  assert.equal(defaultTupletM(3), 2);
  assert.equal(defaultTupletM(2), 3);
  assert.equal(defaultTupletM(7), 4);
  const undoBefore = st()._undo.length;
  st().setNoteTimes(tupletUpdates(st().notes, st().selectedIds, 5, 4, 240));
  assert.deepEqual(ids.map((id) => st().notes.find((n) => n.id === id)!.tick), [0, 192, 384, 576, 768]);
  assert.ok(ids.every((id) => st().notes.find((n) => n.id === id)!.ticks === 192));
  assert.equal(st().notes.find((n) => n.id === chord)!.tick, 384, 'the chord note moves with its onset');
  assert.equal(st()._undo.length, undoBefore + 1, 'one undo step');
  assert.equal(st().selectedIds.size, 6, 'the selection stays');
  st().undo();
  assert.deepEqual(ids.map((id) => st().notes.find((n) => n.id === id)!.tick), [0, 240, 480, 720, 960]);
  // A septuplet: 7 in 4 16ths, rounded from the first onset, never accumulated.
  const sept = tupletUpdates(st().notes, new Set(ids), 7, 4, 240).map((u) => u.tick);
  assert.deepEqual(sept, [0, 137, 274, 411, 549]);
  assert.deepEqual(tupletUpdates(st().notes, new Set(), 3, 2, 240), [], 'nothing selected, nothing moves');
}

// setNoteTimes: nothing moved is no write, and no undo step.
{
  freshRoll([{ bar: 0, meter: M44 }], 16);
  const id = st().addNote({ note: 60, step: 0, length: 1, velocity: 90 });
  resetClock();
  const before = st().notes;
  const undo = st()._undo.length;
  st().setNoteTimes([{ id, tick: 0, ticks: 240 }]);
  assert.equal(st().notes, before);
  assert.equal(st()._undo.length, undo);
  const n: PianoNote = st().notes[0];
  assert.equal(n.step, 0);
}

console.log('rollSnap: ok');
