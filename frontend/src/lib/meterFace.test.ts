import assert from 'node:assert/strict';
import { euclidPattern, GEN_DEFAULT_OPTS, GEN_KINDS } from './loomGen.ts';
import { dbToVelocity } from './rollLoom.ts';
import { roundUpToBar, type MeterSegment } from './meterMap.ts';
import type { RhythmAnalysis } from './rhythmSeed.ts';
import { migrateNotes, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import {
  addChange, addChangeBar, addChangePastEnd, clampSelection, formatOption, genOptionSpecs, genPreview, genStatus, genTarget, genWrite,
  groupChoices, laneForms, lanePitches, matchApply, matchError, meterLabel, newLaneCycle, parseGroupsValue, parseMeterLabel,
  removeChange, replaceLaneNotes, sectionMeterChoices, SECTION_METERS, segmentAtStep, segmentLabel, setBeats, setGroups,
  setUnit, stepLoop, stepOption, parseGroupingText, pickupLabel, pickupMax, setGroupingText, stepPickup, UNITS, type GenSettings,
} from './meterFace.ts';

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
  assert.deepEqual(groupChoices({ num: 3, den: 4, groups: [] }).map((c) => c.value), ['', '2+1', '1+2'], 'three beats can lean 2+1 or 1+2');
  assert.deepEqual(groupChoices({ num: 2, den: 4, groups: [] }), [{ value: '', label: 'Even' }]);
  assert.deepEqual(groupChoices({ num: 12, den: 8, groups: [5, 7] }).at(-1), { value: '5+7', label: '5+7' });
  assert.deepEqual(parseGroupsValue('3+2+2'), [3, 2, 2]);
  assert.deepEqual(parseGroupsValue(''), []);
}

// UNIT runs /1 to /32; a compound meter starts in threes from BEATS and from UNIT, and groups a meter has stay.
{
  assert.deepEqual([...UNITS], [1, 2, 4, 8, 16, 32]);
  const cut = [{ bar: 0, meter: M44 }];
  assert.deepEqual(setUnit(cut, 0, 2).meterMap[0].meter, { num: 4, den: 2, groups: [] }, '4/2');
  assert.deepEqual(setBeats(setUnit(cut, 0, 2).meterMap, 0, 2).meterMap[0].meter, { num: 2, den: 2, groups: [] }, '2/2, cut time');
  assert.deepEqual(setUnit(cut, 0, 32).meterMap[0].meter, { num: 4, den: 32, groups: [] });
  const six8 = setBeats([{ bar: 0, meter: { num: 5, den: 8, groups: [] } }], 0, 6).meterMap[0].meter;
  assert.deepEqual(six8, { num: 6, den: 8, groups: [3, 3] }, 'BEATS to 6 over 8 counts in two');
  assert.deepEqual(setBeats([{ bar: 0, meter: six8 }], 0, 9).meterMap[0].meter, { num: 9, den: 8, groups: [3, 3, 3] });
  assert.deepEqual(setBeats([{ bar: 0, meter: six8 }], 0, 12).meterMap[0].meter, { num: 12, den: 8, groups: [3, 3, 3, 3] });
  assert.deepEqual(setBeats([{ bar: 0, meter: six8 }], 0, 7).meterMap[0].meter, { num: 7, den: 8, groups: [] }, '7/8 is not compound');
  assert.deepEqual(setBeats([{ bar: 0, meter: { num: 5, den: 4, groups: [] } }], 0, 6).meterMap[0].meter, { num: 6, den: 4, groups: [] }, '6/4 keeps its choice open');
  assert.deepEqual(setUnit([{ bar: 0, meter: { num: 6, den: 4, groups: [] } }], 0, 8).meterMap[0].meter, { num: 6, den: 8, groups: [3, 3] }, '6/4 to /8 starts in threes');
  assert.deepEqual(setUnit([{ bar: 0, meter: { num: 6, den: 8, groups: [2, 2, 2] } }], 0, 16).meterMap[0].meter, { num: 6, den: 16, groups: [2, 2, 2] }, 'chosen groups stay');
}

// The GROUPING field: any grouping typed, a new sum sets the beats, bad text changes nothing.
{
  assert.deepEqual(parseGroupingText('3+3+2+1', { num: 9, den: 8, groups: [] }), { num: 9, groups: [3, 3, 2, 1] });
  assert.deepEqual(parseGroupingText(' 2 + 2 + 3 ', { num: 4, den: 8, groups: [] }), { num: 7, groups: [2, 2, 3] }, 'the sum sets the beats');
  assert.deepEqual(parseGroupingText('', M78), { num: 7, groups: [] }, 'empty is Even');
  assert.deepEqual(parseGroupingText('5', M78), { num: 5, groups: [] }, 'one number is Even at that many beats');
  assert.equal(parseGroupingText('3+x', M78), null);
  assert.equal(parseGroupingText('3+0+4', M78), null, 'a group of none');
  assert.equal(parseGroupingText('16+17', M78), null, 'past 32 beats');
  const typed = setGroupingText(SONG, 1, '2+2+2+2+2');
  assert.deepEqual(typed?.meterMap[1], { bar: 4, meter: { num: 10, den: 4, groups: [2, 2, 2, 2, 2] } }, 'five parts, typed');
  assert.equal(setGroupingText(SONG, 1, '2++2'), null);
}

// PICKUP: a unit of the first meter a time, a half step with Shift, up to half a step short of a bar.
{
  const six8 = [{ bar: 0, meter: { num: 6, den: 8, groups: [3, 3] } }];
  assert.equal(stepPickup(six8, 0, 1, false), 2, 'an 8th');
  assert.equal(stepPickup(six8, 2, 1, false), 4);
  assert.equal(stepPickup(six8, 2, -1, false), 0);
  assert.equal(stepPickup(six8, 0, -1, false), 0, 'no pickup is the floor');
  assert.equal(stepPickup(six8, 3, 1, false), 4, 'an off-unit pickup lands on the unit grid');
  assert.equal(stepPickup(six8, 3, -1, false), 2);
  assert.equal(stepPickup(six8, 2, 1, true), 2.5, 'Shift: half a step');
  assert.equal(pickupMax(six8), 11.5);
  assert.equal(stepPickup(six8, 10, 1, false), 11.5, 'never a full bar');
  assert.equal(stepPickup([{ bar: 0, meter: M44 }], 0, 1, false), 4, 'a quarter in 4/4');
  assert.equal(stepPickup([{ bar: 0, meter: { num: 7, den: 32, groups: [] } }], 0, 1, false), 0.5, 'a 32nd');
  assert.equal(pickupLabel(0), 'Off');
  assert.equal(pickupLabel(6), '3/8');
  assert.equal(pickupLabel(4), '1/4');
  assert.equal(pickupLabel(2.5), '5/32');
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
    lanes: [LANE_A, { id: 1, name: 'Low', cycleSteps: 20 }, { id: 2, name: 'High', cycleSteps: 6 }],
  });
  assert.equal(alone.status, 'MATCH SET 2 METERS, A 2-STEP PICKUP, 120 BPM AND 2 LANES. 2 BARS ARE UNCERTAIN.');
  assert.equal(alone.level, 'info');
  const kept = matchApply({ lanes: [LANE_A, { id: 1, name: 'B', cycleSteps: 12 }], bpm: 90 }, { ...analysis, tempo: { bpm: 97.333, stable: false } });
  assert.equal(kept.apply?.lanes, null);
  assert.equal(kept.apply?.bpm, 97, 'the tempo lands on a whole BPM');
  assert.equal(matchApply({ lanes: [LANE_A], bpm: 90 }, { ...analysis, tempo: { bpm: 101.456, stable: false } }).apply?.bpm, 101);
  assert.equal(kept.level, 'warn');
  assert.match(kept.status, /THE ROLL KEPT ITS OWN LANES\. 2 BARS ARE UNCERTAIN\. THE SONG'S TEMPO MOVES, SO BAR LINES DRIFT FROM THE NOTES\.$/);
  assert.equal(matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'pending' }).apply, null);
  assert.equal(matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'ready', meter_map: [] }).level, 'warn');
  const plain = matchApply({ lanes: [LANE_A], bpm: 120 }, { status: 'ready', meter_map: [analysis.meter_map![0]] });
  assert.equal(plain.status, 'MATCH SET 7/8 3+2+2 THROUGHOUT AND NO PICKUP.');
}

// FORM section meters: the list, round trips, and a section's own meter the list lacks.
{
  // 6/8, 9/8 and 12/8 carry their threes, so Virtuoso's oom-pah lands on the dotted beats; 2/2 and 3/2 are choosable.
  assert.deepEqual(SECTION_METERS.map(meterLabel), [
    '4/4', '3/4', '2/4', '2/2', '3/2', '6/8 3+3', '9/8 3+3+3', '5/4', '5/8', '7/8 3+2+2', '7/8 2+2+3', '9/8 2+2+2+3', '11/8 3+3+3+2', '12/8 3+3+3+3',
  ]);
  // A section saved with a bare "6/8" by an older build still opens, as its own option.
  assert.deepEqual(parseMeterLabel('6/8'), { num: 6, den: 8, groups: [] });
  assert.deepEqual(sectionMeterChoices({ num: 6, den: 8, groups: [] }).at(-1), { value: '6/8', label: '6/8' });
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
