import assert from 'node:assert/strict';
import { euclidPattern, GEN_DEFAULT_OPTS, GEN_KINDS } from './loomGen.ts';
import { dbToVelocity } from './rollLoom.ts';
import { roundUpToBar, type MeterSegment } from './meterMap.ts';
import type { RhythmAnalysis } from './rhythmSeed.ts';
import { migrateNotes, PPQ, ROLL_STEPS_PER_BEAT, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import {
  addChange, addChangeBar, addChangePastEnd, clampSelection, formatOption, genOptionSpecs, genPreview, genStatus, genTarget, genWrite,
  groupChoices, laneForms, lanePitches, matchApply, matchError, meterLabel, newLaneCycle, parseGroupsValue, parseMeterLabel,
  removeChange, replaceLaneNotes, sectionMeterChoices, SECTION_METERS, segmentAtStep, segmentLabel, setBeats, setGroups,
  setUnit, stepLoop, stepOption, laneSpanLabel, respanLane, spanIsSegment, toggleLaneSpan, writeMatch, type GenSettings,
} from './meterFace.ts';
import { beatToTime } from './tempoMap.ts';
import { grooveById } from './grooveTemplate.ts';
import { playedRollNotes } from './rollClip.ts';

const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M54 = { num: 5, den: 4, groups: [2, 3] };
const hitSteps = (pat: boolean[]): number[] => pat.flatMap((hit, i) => (hit ? [i] : []));
const st = () => usePianoRollStore.getState();
const note = (id: string, step: number, lane?: number): PianoNote => ({ id, note: 50, step, length: 1, velocity: 80, ...(lane !== undefined ? { lane } : {}) });
const LANE_A = { id: 0, name: 'A', cycleSteps: null };
const C_MAJOR = [60, 62, 64, 65, 67, 69, 71];
const euclid = (hits: number, steps: number, seed = 1): GenSettings =>
  ({ kind: 'euclid', opts: { ...GEN_DEFAULT_OPTS.euclid, hits }, steps, gate: { kind: 'open' }, seed });

/**
 * One undo step whose snapshot is the state as it stands, undone: the stacks
 * are empty and the coalesce clock is reset, so the next edit starts a step of
 * its own (the store folds edits closer than 300 ms into one).
 */
const freshStep = () => {
  const s = st();
  usePianoRollStore.setState({
    _undo: [{
      notes: s.notes, bpm: s.bpm, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote,
      meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends, tempoMap: s.tempoMap,
    }],
    _redo: [],
  });
  st().undo();
};

// The example song: 7/8 3+2+2 for bars 1-4 (14 steps), 5/4 2+3 for bars 5-6 (20), 4/4 from bar 7.
const SONG: MeterSegment[] = [{ bar: 0, meter: M78 }, { bar: 4, meter: M54 }, { bar: 6, meter: M44 }];

// Segment labels, the segment under the playhead, and clamping.
{
  assert.equal(segmentLabel(SONG, 0, 160), '1-4');
  assert.equal(segmentLabel(SONG, 1, 160), '5-6');
  assert.equal(segmentLabel(SONG, 2, 160), '7+');
  assert.equal(segmentLabel([{ bar: 0, meter: M44 }, { bar: 6, meter: M78 }, { bar: 7, meter: M44 }], 1, 160), '7');
  assert.equal(segmentLabel(SONG, 9, 160), '7+', 'an index past the end reads the last segment');
  assert.equal(segmentAtStep(SONG, 0), 0);
  assert.equal(segmentAtStep(SONG, 56), 1);
  assert.equal(segmentAtStep(SONG, 95), 1);
  assert.equal(segmentAtStep(SONG, 96), 2);
  assert.equal(segmentAtStep(SONG, 1, 4), 0, 'the pickup belongs to the first segment');
  assert.equal(clampSelection(SONG, 5), 2);
  assert.equal(clampSelection(SONG, -1), 0);
  assert.equal(clampSelection(SONG, Number.NaN), 0);
}

// ADD starts at the playhead's bar; the selected segment's first bar, and any other change, moves it on.
{
  assert.equal(addChangeBar(SONG, 31), 2, 'step 31 is in bar 3');
  assert.equal(addChangeBar(SONG, 0), 1, "the playhead in the first segment's first bar starts at bar 2");
  assert.equal(addChangeBar(SONG, 56), 5, 'bar 5 starts the 5/4 change, so ADD goes to bar 6');
  assert.equal(addChangeBar(SONG, 1, 4), 1, 'the pickup counts as bar 1');
  // A 64-step 4/4 roll whose last bar starts a change: ADD from there goes to bar 5, which starts at the roll's end.
  const LAST: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 3, meter: M44 }];
  assert.equal(addChangePastEnd(LAST, 48, 0, 64), true);
  assert.equal(addChangePastEnd(LAST, 32, 0, 64), false, 'ADD from bar 3 goes to bar 3, inside the roll');
  assert.equal(addChangePastEnd(LAST, 48, 0, 65), false);
  assert.equal(addChangePastEnd(SONG, 56, 0, 160), false);
  const added = addChange(SONG, 1, 56);
  assert.deepEqual(added.meterMap, [{ bar: 0, meter: M78 }, { bar: 4, meter: M54 }, { bar: 5, meter: M54 }, { bar: 6, meter: M44 }], 'the twin stays apart');
  assert.equal(added.selected, 2);
}

// BEATS clamps and clears groups, UNIT keeps them, a segment stepped onto its neighbour's meter keeps its place, REMOVE merges.
{
  assert.equal(setBeats(SONG, 0, 40).meterMap[0].meter.num, 32);
  assert.equal(setBeats(SONG, 0, 0).meterMap[0].meter.num, 1);
  assert.deepEqual(setBeats(SONG, 0, 8).meterMap[0].meter, { num: 8, den: 8, groups: [] });
  assert.deepEqual(setUnit(SONG, 0, 4).meterMap[0].meter, { num: 7, den: 4, groups: [3, 2, 2] });
  assert.deepEqual(setGroups(SONG, 0, [5, 5]).meterMap[0].meter, { num: 7, den: 8, groups: [] }, 'groups that miss the numerator drop');
  const twin = setBeats([{ bar: 0, meter: M44 }, { bar: 4, meter: { num: 5, den: 4, groups: [] } }], 1, 4);
  assert.equal(twin.meterMap.length, 2);
  assert.equal(twin.selected, 1);
  assert.deepEqual(removeChange([{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }], 1), { meterMap: [{ bar: 0, meter: M44 }], selected: 0 });
  assert.equal(removeChange(SONG, 0), null, 'bar 1 always keeps a meter');
}

// GROUPS lists Even and LOOM's partitions, plus a grouping the partitions miss.
{
  assert.deepEqual(groupChoices(M54), [{ value: '', label: 'Even' }, { value: '3+2', label: '3+2' }, { value: '2+3', label: '2+3' }]);
  const seven = groupChoices(M78).map((c) => c.value);
  assert.ok(seven.includes('3+2+2') && seven.includes('2+2+3') && seven[0] === '');
  assert.deepEqual(groupChoices({ num: 3, den: 4, groups: [] }), [{ value: '', label: 'Even' }]);
  assert.deepEqual(groupChoices({ num: 12, den: 8, groups: [5, 7] }).at(-1), { value: '5+7', label: '5+7' });
  assert.deepEqual(parseGroupsValue('3+2+2'), [3, 2, 2]);
  assert.deepEqual(parseGroupsValue(''), []);
}

// Lanes: a new lane loops one bar of the first meter; LOOP steps, Shift steps a bar, the roll's length stops the loop.
{
  assert.equal(newLaneCycle(SONG), 14);
  assert.equal(stepLoop(16, -1, false, 14, 160), 15);
  assert.equal(stepLoop(12, 1, true, 14, 160), 26);
  assert.equal(stepLoop(1, -1, false, 14, 160), 1);
  assert.equal(stepLoop(null, -1, false, 16, 160), 159);
  assert.equal(stepLoop(150, 1, true, 16, 160), null);
  assert.equal(stepLoop(160, -1, false, 16, 160), 159, 'a loop the length of the roll steps inside it');
  assert.equal(stepLoop(300, -1, false, 16, 160), 159, 'a loop past the roll steps inside it, never off');
  assert.equal(stepLoop(300, -1, true, 16, 160), 144, 'Shift steps a bar down from the roll length');
  const forms = laneForms([LANE_A, { id: 1, name: 'B', cycleSteps: 12 }, { id: 2, name: 'C', cycleSteps: 10 }, { id: 3, name: 'D', cycleSteps: 9 }], 1);
  assert.deepEqual([...forms.entries()], [[0, 'outline'], [1, 'solid'], [2, 'stripe'], [3, 'hatch']]);
}

// Pitches: one octave of the scale from the root nearest middle C.
{
  assert.deepEqual(lanePitches('C', 'major'), C_MAJOR);
  assert.deepEqual(lanePitches('A', 'minor'), [57, 59, 60, 62, 64, 65, 67]);
  assert.deepEqual(lanePitches('F#', 'dorian'), [66, 68, 69, 71, 73, 75, 76]);
  assert.deepEqual(lanePitches('D', 'harmonic'), [62, 64, 65, 67, 69, 70, 73]);
  assert.deepEqual(lanePitches('C', 'no-such-mode'), C_MAJOR, 'an unknown mode plays the major scale');
}

// The GEN menu's steppers: euclid shows hits, steps and rotate; every rule has steps and one-word legends.
{
  assert.deepEqual(genOptionSpecs('euclid').map((s) => s.key), ['hits', 'steps', 'rotate']);
  assert.deepEqual(genOptionSpecs('fractal').map((s) => s.key), ['drift', 'depth', 'steps']);
  assert.equal(genOptionSpecs('fractal')[1].min, 1);
  assert.deepEqual(genOptionSpecs('accel').map((s) => s.key), ['from', 'to', 'curve', 'steps']);
  for (const kind of GEN_KINDS) {
    const specs = genOptionSpecs(kind);
    assert.ok(specs.some((s) => s.key === 'steps'), `${kind} has steps`);
    for (const s of specs) assert.match(s.legend, /^[A-Z][a-z]+$/, `${kind}.${s.key} legend is one word`);
  }
  const density = genOptionSpecs('life')[0];
  assert.equal(stepOption(0.35, density, 1), 0.4);
  assert.equal(stepOption(1, density, 1), 1);
  assert.equal(formatOption(0.35, density), '0.35');
  assert.equal(formatOption(0, { key: 'rows', step: 1 }), 'Auto');
}

// The preview is the first pass through the gate.
{
  assert.deepEqual(hitSteps(genPreview(euclid(5, 12), C_MAJOR)), hitSteps(euclidPattern(5, 12, 0)));
  assert.deepEqual(hitSteps(genPreview({ ...euclid(12, 12), gate: { kind: 'chance', pct: 0 } }, C_MAJOR)), []);
  assert.deepEqual(hitSteps(genPreview({ ...euclid(12, 12), gate: { kind: 'chance', pct: 100 } }, C_MAJOR)).length, 12);
  assert.deepEqual(hitSteps(genPreview({ ...euclid(12, 12), gate: { kind: 'lap', period: 2, laps: [2] } }, C_MAJOR)), [], 'the first pass is lap 1');
}

// Lane A writes the selected segment's bars, one pass per bar, accented on the meter's groups, and replaces only its own notes there.
{
  const roll = {
    meterMap: SONG, pickupSteps: 0, totalSteps: 160, activeLane: 0,
    lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 12 }],
    notes: [note('before', 55), note('gone', 60), note('lane-b', 60, 1), note('after', 96)],
  };
  const t = genTarget(roll, 1);
  assert.deepEqual(t, { lane: 0, name: 'A', start: 56, end: 96, passLen: 20, passes: 2, cycle: null, bars: { first: 4, last: 5 }, meter: M54 });
  const res = genWrite(roll, 1, euclid(5, 10, 3), C_MAJOR, 'w');
  assert.deepEqual(res.notes.slice(0, 3).map((n) => n.id), ['before', 'lane-b', 'after']);
  const written = res.notes.slice(3);
  assert.equal(res.written, 10);
  // Pass 1 (bar 5) plays E(5,10) on the even steps; pass 2 rotates one step. Steps are 2 roll steps.
  assert.deepEqual(written.map((n) => n.step), [56, 60, 64, 68, 72, 78, 82, 86, 90, 94]);
  assert.deepEqual(written.map((n) => n.note), [...C_MAJOR.slice(0, 5), ...C_MAJOR.slice(0, 5)]);
  const up = dbToVelocity(96, 1.5);
  assert.deepEqual(written.map((n) => n.velocity), [up, 96, up, 96, 96, 96, 96, 96, 96, 96], 'group starts 0 and 4 of 10 steps lift');
  assert.ok(written.every((n) => n.length === 2 && !('lane' in n)));
  // A lap gate on lap 2 writes only the second bar.
  const gated = genWrite(roll, 1, { ...euclid(5, 10, 3), gate: { kind: 'lap', period: 2, laps: [2] } }, C_MAJOR, 'g');
  assert.deepEqual(gated.notes.slice(3).map((n) => n.step), [78, 82, 86, 90, 94]);
  // The last segment stops at the roll's end.
  const tail = genWrite({ ...roll, totalSteps: 150 }, 2, euclid(16, 16), C_MAJOR, 't');
  assert.equal(tail.written, 16 * 3 + 6);
  assert.ok(tail.notes.slice(3).every((n) => n.step + n.length <= 150));
}

// A looping lane's range is its cycle, so every note it holds is replaced.
{
  const notes = [note('b2', 2, 1), note('b13', 13, 1), note('b30', 30, 1), note('a', 3)];
  assert.deepEqual(replaceLaneNotes(notes, 1, 0, 12, [], 'x', 12).map((n) => n.id), ['a']);
  assert.deepEqual(replaceLaneNotes(notes, 1, 0, 12, [], 'x').map((n) => n.id), ['b13', 'b30', 'a']);
}

// Status lines.
{
  assert.equal(genStatus(20, 'B'), 'GEN WROTE 20 NOTES IN LANE B.');
  assert.equal(genStatus(1, 'Low'), 'GEN WROTE 1 NOTE IN LANE LOW.');
  assert.equal(genStatus(0, 'A'), 'GEN WROTE NO NOTES IN LANE A. ADD HITS OR OPEN THE GATE.');
  assert.equal(matchError(new TypeError('Failed to fetch')), 'MATCH COULD NOT REACH THE BACKEND. START THE BACKEND AND PRESS MATCH AGAIN.');
  assert.equal(
    matchError(new Error("Reading the rhythm analysis failed with 404: entry 'not a real song' not found")),
    'MATCH FOUND NO SUCH SONG IN THE LIBRARY. CHOOSE THE SONG FROM THE LIST, THEN PRESS MATCH.',
  );
  assert.equal(matchError(new Error('Reading the rhythm analysis failed with 502')), 'THE BACKEND IS NOT ANSWERING. START THE BACKEND AND PRESS MATCH AGAIN.');
  assert.equal(
    matchError(new Error('Analyzing the rhythm failed with 500: rhythm analysis failed: boom')),
    'MATCH FAILED: ANALYZING THE RHYTHM FAILED WITH 500: RHYTHM ANALYSIS FAILED: BOOM. ANALYZE THE SONG, THEN PRESS MATCH AGAIN.',
  );
}

// MATCH: meter map, pickup and tempo always; the song's lanes only onto a roll with lane A alone.
{
  const analysis: RhythmAnalysis = {
    status: 'ready',
    tempo: { bpm: 120, stable: true },
    downbeats: [0.25, 2],
    meter_map: [
      { start_bar: 0, bars: 4, numerator: 7, denominator: 8, grouping: [3, 2, 2], beats_per_bar: 7 },
      { start_bar: 4, bars: 2, numerator: 6, denominator: 8, grouping: [1, 1], beats_per_bar: 2, uncertain: true },
    ],
    polymeter: [
      { segment: 0, layer: 'low', beats_per_bar: 5, grouping: [5], denominator: 4, confidence: 0.9 },
      { segment: 0, layer: 'high', beats_per_bar: 3, grouping: [3], denominator: 8, confidence: 0.8 },
    ],
  };
  const alone = matchApply({ lanes: [LANE_A], bpm: 90 }, analysis);
  assert.deepEqual(alone.apply, {
    meterMap: [{ bar: 0, meter: M78 }, { bar: 4, meter: { num: 6, den: 8, groups: [3, 3] } }],
    pickupSteps: 2,
    bpm: 120,
    tempoMap: [],
    swing: null,
    // Both loops were heard in bars 1-4 only: the pickup and four 14-step bars.
    lanes: [LANE_A, { id: 1, name: 'Low', cycleSteps: 20, span: { start: 0, end: 58 } }, { id: 2, name: 'High', cycleSteps: 6, span: { start: 0, end: 58 } }],
  });
  assert.equal(
    alone.status,
    'MATCH SET 2 METERS, A 2-STEP PICKUP, 120 BPM AND 2 LANES. A LANE HEARD IN PART OF THE SONG PLAYS ONLY THERE. 2 BARS ARE UNCERTAIN.',
  );
  assert.equal(alone.level, 'info');
  // The tempo keeps its fraction: bars of 3.5 quarters that last 60 * 3.5 / 97.333 seconds.
  const slow = { ...analysis, tempo: { bpm: 97.333, stable: false }, downbeats: [0.25, 0.25 + (60 * 3.5) / 97.333] };
  const kept = matchApply({ lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 12 }], bpm: 90 }, slow);
  assert.equal(kept.apply?.lanes, null);
  assert.ok(Math.abs((kept.apply?.bpm ?? 0) - 97.333) < 1e-9, `the tempo keeps its fraction: ${kept.apply?.bpm}`);
  assert.equal(kept.level, 'info', 'the downbeats carry the tempo, so nothing drifts');
  assert.match(kept.status, /97\.33 BPM/);
  assert.match(kept.status, /THE ROLL KEPT ITS OWN LANES\. 2 BARS ARE UNCERTAIN\.$/);
  // No downbeats to read a moving tempo from: the tracked tempo with its fraction, and the drift warning.
  const blind = matchApply({ lanes: [LANE_A], bpm: 90 }, { ...analysis, downbeats: undefined, tempo: { bpm: 101.456, stable: false } });
  assert.equal(blind.apply?.bpm, 101.456);
  assert.equal(blind.apply?.tempoMap, null, 'no tempo read off downbeats, so the roll keeps its own tempo changes');
  assert.equal(blind.level, 'warn');
  assert.match(blind.status, /101\.46 BPM/);
  assert.match(blind.status, /THE SONG'S TEMPO MOVES, SO BAR LINES DRIFT FROM THE NOTES\.$/);
  assert.equal(matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'pending' }).apply, null);
  assert.equal(matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'ready', meter_map: [] }).level, 'warn');
  const plain = matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'ready', meter_map: [analysis.meter_map![0]] });
  assert.equal(plain.status, 'MATCH SET 7/8 3+2+2 THROUGHOUT AND NO PICKUP.');
}

// MATCH on a song that slows down, run the way the METER face runs it: the
// analysis, matchApply, writeMatch into the piano roll store. The ritardando
// becomes tempo changes, the notes keep their steps, the swing lands in the
// feel's groove, and one undo takes the whole MATCH back.
//
// A DATA check of the tempo map: it reads each bar line's time through
// lib/tempoMap beatToTime, the way a player that follows the map will. The
// roll's scheduler, bounce and MIDI export still play at the one BPM, which
// is why the status line warns that bar lines drift.
{
  const durs = [2, 2, 2, 2, 2.4, 2.8, 2.8, 2.8];
  const downbeats = [0];
  for (const d of durs) downbeats.push(Math.round((downbeats[downbeats.length - 1] + d) * 1e6) / 1e6);
  const rit: RhythmAnalysis = {
    status: 'ready',
    tempo: { bpm: 110, stable: false },
    downbeats,
    meter_map: [{ start_bar: 0, bars: downbeats.length, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4, beat_unit: 'quarter' }],
    syncopation: { swing_ratio: 1.6, swing_confidence: 1 },
  };
  usePianoRollStore.setState({
    meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [LANE_A], activeLane: 0, totalSteps: 160, bpm: 120, tempoMap: [], grooveId: 'swing',
  });
  st().replaceAll([note('bar1', 0), note('bar5', 64), note('bar7', 96)]);
  freshStep();
  const stepsBefore = st().notes.map((n) => n.step);

  const res = matchApply(st(), rit);
  assert.ok(res.apply);
  writeMatch(st(), res.apply);
  assert.deepEqual(st().tempoMap, [
    { beat: 0, bpm: 120 },
    { beat: 16, bpm: 100 },
    { beat: 20, bpm: 85.714 },
  ]);
  assert.deepEqual(st().notes.map((n) => n.step), stepsBefore, 'MATCH moves no note');
  // Times through the tempo map: bar 5 at 8 s, bar 7 at 8 + 2.4 + 2.8 s, the song's downbeats.
  for (const n of st().notes) {
    const onset = beatToTime(st().tempoMap, n.step / 4);
    const bar = n.step / 16;
    assert.ok(Math.abs(onset - downbeats[bar]) < 1e-3, `the note on bar ${bar + 1} sounds at ${onset}, the downbeat is ${downbeats[bar]}`);
  }
  assert.equal(st().grooveId, 'swing8:61.5');
  assert.equal(grooveById(st().grooveId)?.name, 'Swing 8ths 61.5%', "the feel's groove list resolves the song's swing");
  assert.match(res.status, /3 TEMPO CHANGES/);
  assert.match(res.status, /SWING 8THS 61\.5%/);
  // The roll still plays one tempo, so MATCH says the bar lines drift.
  assert.match(res.status, /THE ROLL STILL PLAYS AND SAVES ONE TEMPO, 102\.13 BPM, SO BAR LINES DRIFT FROM THE SONG WHERE ITS TEMPO MOVES\.$/);
  assert.equal(res.level, 'warn');
  assert.equal(st()._undo.length, 1, 'MATCH is one undo step');
  st().undo();
  assert.deepEqual(st().tempoMap, [], 'undo takes the tempo changes back');
  assert.equal(st().bpm, 120);
  st().redo();
  assert.equal(st().tempoMap.length, 3, 'redo brings them back');
  // A MATCH on a song that holds one tempo clears tempo changes an earlier MATCH wrote.
  writeMatch(st(), matchApply(st(), { ...rit, downbeats: [0, 2, 4, 6], syncopation: undefined }).apply!);
  assert.deepEqual(st().tempoMap, []);
  assert.equal(st().bpm, 120);
  usePianoRollStore.setState({ grooveId: 'swing' });
}

// SPAN, as the METER face runs it: lane B limited to the selected change's bars,
// its repeats written out only there, its loop starting at the first of them;
// GEN writes that first cycle; pressing SPAN again gives the whole roll back.
{
  usePianoRollStore.setState({ meterMap: SONG, pickupSteps: 0, lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 6 }], activeLane: 1, totalSteps: 160 });
  st().replaceAll([note('b0', 56, 1)]);
  const sel = 1; // 5/4 in bars 5-6: steps 56 to 96
  let lanes = toggleLaneSpan(st().meterMap, st().lanes, sel, 1, st().pickupSteps);
  st().applyMeter({ lanes });
  assert.deepEqual(st().lanes[1], { id: 1, name: 'B', cycleSteps: 6, span: { start: 56, end: 96 } });
  assert.equal(spanIsSegment(st().meterMap, sel, st().lanes[1].span, 0), true);
  assert.equal(laneSpanLabel(st().meterMap, st().lanes[1].span!, 0), '5-6');
  const played = playedRollNotes(st().notes, st().lanes, st().totalSteps).map((n) => n.step);
  assert.deepEqual(played, [56, 62, 68, 74, 80, 86, 92], 'the lane loops from bar 5 and stops where bar 7 starts');
  const target = genTarget(st(), sel);
  assert.deepEqual([target.start, target.end, target.cycle], [56, 62, 6], "GEN writes the lane's first cycle inside its span");
  const written = genWrite(st(), sel, euclid(2, 6), C_MAJOR, 'sp');
  assert.deepEqual(written.notes.filter((n) => n.lane === 1).map((n) => n.step).sort((a, b) => a - b), [56, 59], "GEN's cycle replaced the old note");
  freshStep();
  lanes = toggleLaneSpan(st().meterMap, st().lanes, sel, 1, st().pickupSteps);
  st().applyMeter({ lanes });
  assert.deepEqual(st().lanes[1], { id: 1, name: 'B', cycleSteps: 6 }, 'SPAN again: the whole roll');
  st().undo();
  assert.deepEqual(st().lanes[1].span, { start: 56, end: 96 }, 'undo brings the span back');
}

// SPAN on a lane already written from step 0: its notes and bend points move
// into the span's first cycle, each keeping its place in the cycle, so the
// downbeat note still starts every cycle. One undo takes all three back.
{
  usePianoRollStore.setState({ meterMap: SONG, pickupSteps: 0, lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 6 }], activeLane: 1, totalSteps: 160 });
  st().replaceAll([{ ...note('down', 0, 1), note: 60 }, { ...note('off', 3, 1), note: 62 }, note('a', 5)]);
  st().setBends([{ lane: 1, range: 2, points: [
    { id: 'p0', step: 0, value: 0, shape: 'linear' },
    { id: 'p1', step: 3, value: 0.5, shape: 'linear' },
    { id: 'p2', step: 6, value: 0, shape: 'hold' },
  ] }]);
  freshStep();
  const sel = 1; // 5/4 in bars 5-6: steps 56 to 96
  const next = respanLane(st(), sel, 1);
  st().applyMeter({ lanes: next.lanes });
  if (next.notes) st().replaceAll(next.notes);
  if (next.bends) st().setBends(next.bends);
  assert.deepEqual(st().lanes[1].span, { start: 56, end: 96 });
  const played = playedRollNotes(st().notes, st().lanes, st().totalSteps).filter((n) => n.note !== 50).map((n) => `${n.note}@${n.step}`);
  assert.deepEqual(played.slice(0, 4), ['60@56', '62@59', '60@62', '62@65'], 'the downbeat note starts every cycle from the span');
  assert.equal(st().notes.find((n) => n.id === 'a')?.step, 5, "lane A's note stays");
  assert.equal(st().notes.find((n) => n.id === 'down')?.tick, 56 * (PPQ / ROLL_STEPS_PER_BEAT), 'the moved note is ticked from its new step');
  assert.deepEqual(st().bends[0].points.map((p) => [p.step, p.value]), [[56, 0], [59, 0.5], [62, 0]], 'the bend moved with its notes, its cycle end kept');
  assert.equal(st()._undo.length, 1, 'SPAN is one undo step');
  st().undo();
  assert.deepEqual(st().notes.filter((n) => n.lane === 1).map((n) => n.step), [0, 3]);
  assert.deepEqual(st().bends[0].points.map((p) => p.step), [0, 3, 6]);
  assert.equal(st().lanes[1].span, undefined);
  // SPAN off moves them back to step 0.
  st().redo();
  const back = respanLane(st(), sel, 1);
  assert.equal(back.lanes[1].span, undefined);
  assert.deepEqual(back.notes?.filter((n) => n.lane === 1).map((n) => n.step), [0, 3]);
  // A lane whose cycle is longer than its span still plays only inside it.
  usePianoRollStore.setState({ lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 48, span: { start: 56, end: 96 } }] });
  st().replaceAll([{ ...note('x', 56, 1), note: 60 }, { ...note('y', 100, 1), note: 62 }]);
  assert.deepEqual(playedRollNotes(st().notes, st().lanes, st().totalSteps).map((n) => n.step), [56], 'a note that folds past the span end is not played');
  assert.deepEqual(genTarget(st(), sel).end, 96, 'GEN writes up to the span end');
}

// FORM section meters: the list, round trips, and a section's own meter the list lacks.
{
  assert.deepEqual(SECTION_METERS.map(meterLabel), ['4/4', '3/4', '2/4', '6/8', '5/4', '5/8', '7/8 3+2+2', '7/8 2+2+3', '9/8 2+2+2+3', '11/8 3+3+3+2', '12/8']);
  for (const x of SECTION_METERS) assert.deepEqual(parseMeterLabel(meterLabel(x)), x);
  assert.equal(parseMeterLabel(''), null);
  assert.deepEqual(sectionMeterChoices({ num: 13, den: 8, groups: [] }).at(-1), { value: '13/8', label: '13/8' });
  assert.equal(sectionMeterChoices(M78).length, SECTION_METERS.length, 'a meter the list holds adds no option');
}

// The sequence the METER face runs, against the piano roll store: ADD at bar 5, BEATS to 7, UNIT /8,
// GROUPS 3+2+2, add lane B, LOOP to 12, WRITE euclid 5 of 12, then REMOVE the change.
{
  usePianoRollStore.setState({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, lanes: [LANE_A], activeLane: 0, totalSteps: 160, currentStep: 64 });
  st().replaceAll([note('a3', 3)]);
  let sel = segmentAtStep(st().meterMap, st().currentStep, st().pickupSteps);
  assert.equal(sel, 0);

  // ADD with the playhead in bar 5 (step 64).
  let edit = addChange(st().meterMap, sel, st().currentStep, st().pickupSteps);
  st().applyMeter({ meterMap: edit.meterMap }, false);
  sel = edit.selected;
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }, { bar: 4, meter: M44 }]);
  assert.equal(sel, 1);
  assert.equal(segmentLabel(st().meterMap, sel, st().totalSteps), '5+');

  // BEATS + three times: 4 -> 7.
  for (let k = 0; k < 3; k += 1) {
    edit = setBeats(st().meterMap, sel, st().meterMap[sel].meter.num + 1);
    st().applyMeter({ meterMap: edit.meterMap }, false);
    sel = edit.selected;
  }
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }, { bar: 4, meter: { num: 7, den: 4, groups: [] } }]);

  edit = setUnit(st().meterMap, sel, 8);
  st().applyMeter({ meterMap: edit.meterMap }, false);
  assert.deepEqual(st().meterMap[1], { bar: 4, meter: { num: 7, den: 8, groups: [] } });

  assert.ok(groupChoices(st().meterMap[sel].meter).some((c) => c.value === '3+2+2'));
  edit = setGroups(st().meterMap, sel, parseGroupsValue('3+2+2'));
  st().applyMeter({ meterMap: edit.meterMap }, false);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }, { bar: 4, meter: M78 }]);

  // + lane: one bar of the first meter (4/4 = 16 steps), made active.
  const b = st().addLane(newLaneCycle(st().meterMap));
  st().setActiveLane(b);
  assert.deepEqual(st().lanes, [LANE_A, { id: 1, name: 'B', cycleSteps: 16 }]);
  assert.equal(st().activeLane, 1);
  st().replaceAll([...st().notes, note('b2', 2, 1), note('b13', 13, 1)]);

  // LOOP - four times: 16 -> 12.
  for (let k = 0; k < 4; k += 1) {
    const lane = st().lanes.find((l) => l.id === st().activeLane)!;
    st().setLaneCycle(lane.id, stepLoop(lane.cycleSteps, -1, false, 14, st().totalSteps));
  }
  assert.deepEqual(st().lanes[1], { id: 1, name: 'B', cycleSteps: 12 });

  // WRITE euclid 5 of 12 into lane B: one cycle from step 0, lane B's old notes replaced, lane A's kept.
  const res = genWrite(st(), sel, euclid(5, 12), lanePitches('C', 'major'), 'w1');
  st().replaceAll(res.notes);
  // Through migrateNotes because the store ticks every note it takes in, and
  // these literals are written in steps.
  assert.deepEqual(st().notes, migrateNotes([
    note('a3', 3),
    { id: 'w1-0', note: 60, step: 0, length: 1, velocity: 96, lane: 1 },
    { id: 'w1-1', note: 62, step: 3, length: 1, velocity: 96, lane: 1 },
    { id: 'w1-2', note: 64, step: 5, length: 1, velocity: 96, lane: 1 },
    { id: 'w1-3', note: 65, step: 8, length: 1, velocity: 96, lane: 1 },
    { id: 'w1-4', note: 67, step: 10, length: 1, velocity: 96, lane: 1 },
  ]));
  assert.deepEqual([0, 3, 5, 8, 10], hitSteps(euclidPattern(5, 12, 0)));
  assert.equal(genStatus(res.written, res.target.name), 'GEN WROTE 5 NOTES IN LANE B.');

  // REMOVE the change at bar 5.
  const removed = removeChange(st().meterMap, sel)!;
  st().applyMeter({ meterMap: removed.meterMap }, false);
  sel = removed.selected;
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: M44 }]);
  assert.equal(roundUpToBar(st().meterMap, st().totalSteps, st().pickupSteps), st().totalSteps, 'every face write leaves the roll on a bar line');
  assert.equal(sel, 0);
  assert.equal(segmentLabel(st().meterMap, sel, st().totalSteps), '1+');
  assert.deepEqual(st().lanes, [LANE_A, { id: 1, name: 'B', cycleSteps: 12 }]);
  assert.equal(st().notes.length, 6);
}

console.log('meterFace: all assertions passed');
