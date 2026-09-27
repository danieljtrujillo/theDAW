// The sequence a roll in 7/8 with a looping lane goes through, in the order the
// app runs it: bounce to EDIT, open the clip in the roll, save the project
// (.tasmo JSON), reload, open in the roll again. The save and the reload replay
// the projectClient mappers projectImport.ts writes and reads a clip's notes with.
import assert from 'node:assert/strict';
import { clipRenderInput, clipRollLoad, midiFileClipFields, playedRollNotes, quantizeRollClip, rollClipFields, type RollClipInput, type RollLoadArgs } from './rollClip.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { clipNotesToTasmo, playedNotesFromRoll, tasmoMeterToClip } from './projectClient.ts';
import { migrateNotes, rollMeterOf, tickOfStep, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import { unrollLanes, type MeterSegment } from './meterMap.ts';
import { copyBends, type LaneBend } from './pitchBend.ts';

const st = () => usePianoRollStore.getState();
const M78: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }];
const M44: MeterSegment[] = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }];
const LANE_A = [{ id: 0, name: 'A', cycleSteps: null }];
const BPM = 96;
/** The pickup (4 steps) and four bars of 7/8 (14 steps each). */
const TOTAL = 60;
const withoutIds = (notes: readonly PianoNote[] = []) => notes.map(({ id: _id, ...n }) => n);
/** Bends with their point ids left out: the file stores none, so reloaded points get new ones. */
const withoutPointIds = (bends: readonly LaneBend[] = []) =>
  bends.map((b) => ({ ...b, points: b.points.map(({ id: _id, ...p }) => p) }));
/** Lane A ramps up and holds; lane B, which loops, eases down then ramps at a range of 12. */
const BENDS: LaneBend[] = [
  { lane: 0, range: 2, points: [{ id: 'bA0', step: 0, value: 0, shape: 'linear' }, { id: 'bA1', step: 6, value: 1, shape: 'hold' }] },
  { lane: 1, range: 12, points: [{ id: 'bB0', step: 3, value: -0.5, shape: 'smooth' }, { id: 'bB1', step: 9, value: 0.5, shape: 'linear' }] },
];

// 1. The roll: 7/8 3+2+2, a pickup of 4, lane B looping every 12 steps, notes and a pitch bend in both lanes.
st().setBpm(BPM);
st().setMeterMap(M78);
st().setPickupSteps(4);
st().setLanes(LANE_A);
assert.equal(st().addLane(12), 1);
st().replaceAll([
  { id: 'a0', note: 60, step: 0, length: 4, velocity: 100 },
  { id: 'a1', note: 67, step: 18, length: 2, velocity: 90 },
  { id: 'b0', note: 36, step: 2, length: 1, velocity: 110, lane: 1 },
  { id: 'b1', note: 38, step: 8, length: 2, velocity: 80, lane: 1 },
]);
st().setTotalSteps(TOTAL);
st().setBends(BENDS);

const original = { meter: rollMeterOf(st()), notes: st().notes.map((n) => ({ ...n })), bends: copyBends(st().bends) };
assert.deepEqual(original.bends, BENDS);
assert.deepEqual(original.meter.meterMap, M78);
assert.equal(original.meter.pickupSteps, 4);
assert.deepEqual(original.meter.lanes, [...LANE_A, { id: 1, name: 'B', cycleSteps: 12 }]);
// Lane B's two notes sound at every cycle before step 60: 5 times each.
const played = playedRollNotes(original.notes, original.meter.lanes, TOTAL);
assert.equal(played.length, 2 + 2 * 5);

/** loadFromClip's arguments carry the original roll. */
const assertLoad = (args: RollLoadArgs, clipId: string, source: 'roll' | 'tasmo') => {
  const [id, notes, bpm, total, meter, bends] = args;
  assert.equal(id, clipId);
  assert.equal(bpm, BPM);
  assert.equal(total, TOTAL);
  assert.deepEqual(meter, original.meter);
  // migrateNotes is a no-op for a note whose ticks agree with its steps, so the
  // wrap alone cannot tell a preserved tick from a reconstructed one.
  assert.deepEqual(withoutIds(migrateNotes(notes)), withoutIds(original.notes));
  // This says it: the in-memory clip arrives ticked, and so does the .tasmo
  // reload, whose notes carry `tick`/`ticks` (pianoNoteToTasmo). A reload that
  // lost them would re-derive a length under one step as a whole step.
  for (const n of notes) {
    assert.equal(n.tick, tickOfStep(n.step), `${n.id} reached the roll un-ticked (${source})`);
    assert.equal(n.ticks, tickOfStep(n.length), `${n.id} reached the roll without its length in ticks (${source})`);
  }
  assert.deepEqual(withoutPointIds(bends), withoutPointIds(original.bends));
};

/** The roll holds the original, and its notes unroll once. */
const assertRoll = (clipId: string) => {
  assert.equal(st().editingClipId, clipId);
  assert.deepEqual(rollMeterOf(st()), original.meter);
  assert.deepEqual(withoutIds(st().notes), withoutIds(original.notes));
  assert.deepEqual(withoutPointIds(st().bends), withoutPointIds(original.bends));
  assert.equal(st().totalSteps, TOTAL);
  assert.equal(st().bpm, BPM);
  const again = rollClipFields(st());
  assert.equal(again.sourcePianoRoll.length, played.length);
  assert.deepEqual(withoutIds(again.sourcePianoRoll), withoutIds(played));
};

// 2. Bounce to EDIT: the fields the clip stores.
const fields = rollClipFields(st());
assert.deepEqual(fields.sourceMeterMap, original.meter.meterMap);
assert.equal(fields.sourcePickupSteps, 4);
assert.deepEqual(fields.sourceLanes, original.meter.lanes);
assert.deepEqual(fields.sourceRollNotes, original.notes);
assert.equal(fields.sourceBpm, BPM);
assert.equal(fields.sourceTotalSteps, TOTAL);
assert.deepEqual(fields.sourceBends, original.bends);
assert.notEqual(fields.sourceBends, st().bends);
// EDIT plays the unrolled notes, with no lane left to loop.
assert.deepEqual(fields.sourcePianoRoll, played);
assert.equal(fields.sourcePianoRoll.some((n) => 'lane' in n), false);
// The fields are copies of the roll's state.
assert.notEqual(fields.sourceRollNotes[0], st().notes[0]);
assert.notEqual(fields.sourceMeterMap, st().meterMap);
assert.notEqual(fields.sourceLanes, st().lanes);

// 3. Open the clip in the roll.
const clip: RollClipInput = { id: 'clip-1', ...fields };
const firstLoad = clipRollLoad(clip);
assertLoad(firstLoad, 'clip-1', 'roll');
assert.deepEqual(firstLoad[1], original.notes);
assert.deepEqual(firstLoad[5], original.bends);

// The clip's audio renders each note in its lane, so each lane's bend is in the bounce and in a re-render.
{
  const input = clipRenderInput(clip, TOTAL);
  assert.deepEqual(input.notes, unrollLanes(original.notes, original.meter.lanes, TOTAL));
  assert.deepEqual([...(input.bends?.played.keys() ?? [])], [0, 1]);
  assert.deepEqual([...(input.bends?.channels ?? [])], [[0, 0], [1, 1]]);
  // A clip with no bend renders the notes it plays.
  assert.deepEqual(clipRenderInput({ ...clip, sourceBends: [] }, TOTAL), { notes: clip.sourcePianoRoll });
}

// 4. The roll has moved on to another clip in 4/4 when the user opens this one. It has lane A only,
// and the load brings no bends, so every point goes: lane B's with its lane, lane A's with the notes
// (lane A's range is the default, so nothing is left).
st().loadFromClip('other', [{ id: 'x', note: 60, step: 0, length: 1, velocity: 90 }], 120, 16, {
  meterMap: M44,
  pickupSteps: 0,
  lanes: LANE_A,
});
assert.deepEqual(st().bends, []);
st().loadFromClip(...firstLoad);
assertRoll('clip-1');
// A second bounce writes the same clip.
assert.deepEqual(rollClipFields(st()), fields);

// 5. Save the project: captureEditorSession writes these keys through clipNotesToTasmo, and the file
// goes out and back as JSON. Lane B loops and both lanes bend, so the file keeps the roll notes, and
// beside them the played notes (their unroll) as midi_notes, the list every build reads.
const saved: ReturnType<typeof clipNotesToTasmo> = JSON.parse(JSON.stringify(clipNotesToTasmo(clip)));
assert.equal(saved.midi_notes?.length, clip.sourcePianoRoll.length, 'the played notes are written for older builds');
assert.deepEqual(saved.roll_notes?.map((n) => n.lane), [undefined, undefined, 1, 1]);
assert.deepEqual(saved.roll_bends?.map((b) => [b.lane, b.range, b.points.length]), [[0, 2, 2], [1, 12, 2]]);
// Each roll note carries its ticks, which agree with its steps.
assert.ok(saved.roll_notes?.every((n) => n.tick === tickOfStep(n.step) && n.ticks === tickOfStep(n.length)));

// 6. Reload: buildClip takes the project tempo and the mapped fields, and rebuilds the played notes
// from the roll notes the way the bounce built them.
const reloadedMeter = tasmoMeterToClip(saved);
const reloaded: RollClipInput = {
  id: 'clip-1',
  sourceBpm: BPM,
  sourcePianoRoll: playedNotesFromRoll(reloadedMeter),
  ...reloadedMeter,
};
assert.deepEqual(withoutIds(migrateNotes(reloaded.sourcePianoRoll ?? [])), withoutIds(played));
assert.ok((reloaded.sourcePianoRoll ?? []).every((n) => typeof n.tick === 'number' && typeof n.ticks === 'number'), 'the reload carries its ticks');
// A file written before the ticks (step and length only) migrates to the same
// notes, exactly as the store migrates them when the clip is opened in step 7.
const tickless = { ...saved, roll_notes: saved.roll_notes?.map(({ tick: _t, ticks: _ts, ...n }) => n) };
assert.deepEqual(withoutIds(migrateNotes(playedNotesFromRoll(tasmoMeterToClip(tickless)))), withoutIds(played));
assert.equal(reloaded.sourcePianoRoll?.some((n) => 'lane' in n), false);

// 7. Open the reloaded clip in the roll.
const secondLoad = clipRollLoad(reloaded);
assertLoad(secondLoad, 'clip-1', 'tasmo');
st().loadFromClip('other', [], 120, 16, { meterMap: M44, pickupSteps: 0, lanes: LANE_A });
st().loadFromClip(...secondLoad);
assertRoll('clip-1');

// A clip bounced before the roll had a meter: notes only. The roll still holds the 7/8 clip with lane B.
{
  const legacy: RollClipInput = {
    id: 'old',
    sourcePianoRoll: [
      { id: 'o0', note: 60, step: 0, length: 4, velocity: 100 },
      { id: 'o1', note: 64, step: 17, length: 3, velocity: 100 },
    ],
    sourceBpm: 110,
    sourceTotalSteps: 20,
  };
  const args = clipRollLoad(legacy);
  const [id, notes, bpm, total, meter] = args;
  assert.equal(id, 'old');
  assert.equal(bpm, 110);
  assert.deepEqual(notes, legacy.sourcePianoRoll);
  assert.deepEqual(meter, { meterMap: M44, pickupSteps: 0, lanes: LANE_A });
  // 20 steps rounds up to the end of the second 4/4 bar.
  assert.equal(total, 32);
  // A clip bounced before the roll had pitch bend loads unbent.
  assert.deepEqual(args[5], []);
  st().loadFromClip(...args);
  assert.deepEqual(st().bends, []);
  assert.deepEqual(rollMeterOf(st()), meter);
  assert.equal(st().totalSteps, 32);
  // With no grid length either, the notes' end rounds up to a bar; with no notes, one bar.
  assert.equal(clipRollLoad({ ...legacy, sourceTotalSteps: undefined })[3], 32);
  assert.equal(clipRollLoad({ id: 'empty' })[3], 16);
  // The same clip saved and reloaded from a file without meter fields stays 4/4.
  const fromFile: RollClipInput = { id: 'old', sourceBpm: 110, sourcePianoRoll: legacy.sourcePianoRoll, ...tasmoMeterToClip({}) };
  assert.deepEqual(clipRollLoad(fromFile)[4], meter);
}

// 8. quantizeRollClip — T37B: quantize/swing/groove on the roll clip document
// (there was none in rollClip.ts; the math is clipNotes.quantizeNotes and
// grooveTemplate.applyGroove, not reimplemented here).
{
  const qnotes: PianoNote[] = [
    { id: 'q0', note: 60, step: 0.2, length: 1.1, velocity: 100 },
    { id: 'q1', note: 62, step: 3.9, length: 0.6, velocity: 90 },
  ];

  // A clip bounced before the roll had its own note list: only sourcePianoRoll
  // exists, so that is what gets quantized, and sourceRollNotes stays empty —
  // exactly what clipRollLoad already treats as "no roll document".
  const legacyClip: RollClipInput = { id: 'q-legacy', sourcePianoRoll: qnotes, sourceBpm: 120, sourceTotalSteps: 8 };
  const legacyOut = quantizeRollClip(legacyClip, { grid: '1/16', strength: 1, quantizeEnds: true });
  assert.deepEqual(legacyOut.sourceRollNotes, []);
  assert.deepEqual(legacyOut.sourcePianoRoll.map((n) => n.step), [0, 4]);
  assert.deepEqual(legacyOut.sourcePianoRoll.map((n) => n.length), [1, 1]);
  // The input list is untouched.
  assert.deepEqual(qnotes.map((n) => n.step), [0.2, 3.9]);

  // A clip with its own lane-based document: sourceRollNotes is quantized and
  // sourcePianoRoll is re-derived from the result, so the two never drift.
  const ownClip: RollClipInput = {
    id: 'q-own',
    sourceRollNotes: qnotes,
    sourcePianoRoll: [],
    sourceLanes: LANE_A,
    sourceMeterMap: M44,
    sourcePickupSteps: 0,
    sourceTotalSteps: 8,
    sourceBpm: 120,
  };
  const ownOut = quantizeRollClip(ownClip, { grid: '1/16', strength: 1, quantizeEnds: true });
  assert.deepEqual(ownOut.sourceRollNotes.map((n) => n.step), [0, 4]);
  assert.deepEqual(ownOut.sourceRollNotes.map((n) => n.length), [1, 1]);
  // Lane A has no cycle, so the played list is the same notes unrolled once
  // with the lane id dropped.
  assert.deepEqual(ownOut.sourcePianoRoll.map((n) => n.step), [0, 4]);
  assert.equal(ownOut.sourcePianoRoll.some((n) => 'lane' in n), false);

  // A groove nudges the already-quantized grid: a flat lateness of +0.5 step on
  // slot 0 (16 slots/bar; both notes' quantized steps land on-the-beat slots)
  // pushes a note landing on that slot forward by 0.5 step at full strength.
  const groove = { id: 'g', name: 'g', slots: 16, lateness: [0.5, ...new Array(15).fill(0)] };
  const groovedOut = quantizeRollClip(ownClip, { grid: '1/16', strength: 1, groove, grooveStrength: 1 });
  assert.equal(groovedOut.sourceRollNotes.find((n) => n.id === 'q0')?.step, 0.5);
  // Slot 4 (q1's quantized step) has no lateness in this groove, so it is untouched.
  assert.equal(groovedOut.sourceRollNotes.find((n) => n.id === 'q1')?.step, 4);

  // grooveStrength scales the groove independently of the grid quantize's own strength.
  const halfGrooved = quantizeRollClip(ownClip, { grid: '1/16', strength: 1, groove, grooveStrength: 0.5 });
  assert.equal(halfGrooved.sourceRollNotes.find((n) => n.id === 'q0')?.step, 0.25);

  // An empty roll's own notes (never any lane document) quantize to nothing and stay that way.
  const emptyOut = quantizeRollClip({}, { grid: '1/16', strength: 1 });
  assert.deepEqual(emptyOut, { sourceRollNotes: [], sourcePianoRoll: [] });
}

// A .mid dropped into EDIT (addMidiClipFromBytes): the bytes are parsed, the
// clip takes midiFileClipFields, the clip renders (clipRenderInput) and then
// opens in the roll (clipRollLoad -> loadFromClip). The file is 480 PPQ at
// 97.3 BPM in 7/8, with a flam, a 32nd and a slide on channel 1. EDIT used to
// round each note to the nearest 16th with a one-step floor, round the tempo
// to 97 and drop the slide, so the clip neither played nor reopened as written.
{
  const bytes = encodeMidi({
    ppq: 480,
    bpm: 97.3,
    timeSignatures: [{ tick: 0, num: 7, den: 8, groups: [3, 2, 2] }],
    tracks: [
      {
        name: 'Lead',
        notes: [
          { tick: 0, note: 60, velocity: 100, durationTicks: 480, channel: 0 },
          { tick: 19, note: 64, velocity: 90, durationTicks: 461, channel: 0 }, // a flam
          { tick: 540, note: 67, velocity: 80, durationTicks: 60, channel: 0 }, // a 32nd, off the grid
          { tick: 960, note: 55, velocity: 85, durationTicks: 480, channel: 1 }, // the slide's note
        ],
        bends: [
          { tick: 960, channel: 1, value: 8192 },
          { tick: 1200, channel: 1, value: 12288 },
          { tick: 1440, channel: 1, value: 8192 },
        ],
        bendRanges: [{ tick: 0, channel: 1, semitones: 2 }],
      },
    ],
  });
  const fields = midiFileClipFields(parseMidi(bytes), 'imp');
  assert.equal(fields.sourceBpm, 97.3, 'the clip plays at the file tempo');
  // 960 PPQ in the model: every file tick doubles, nothing snaps.
  const byTick = [...fields.sourcePianoRoll].sort((x, y) => (x.tick ?? 0) - (y.tick ?? 0) || x.note - y.note);
  assert.deepEqual(byTick.map((n) => [n.note, n.tick, n.ticks]), [[60, 0, 960], [64, 38, 922], [67, 1080, 120], [55, 1920, 960]]);
  assert.equal(byTick[2].length, 0.5, 'the 32nd is half a 16th long');
  assert.deepEqual(fields.sourceMeterMap, M78, 'the clip keeps the 7/8');
  // The last note ends at step 12; the clip ends on the bar line after it.
  assert.equal(fields.sourceTotalSteps, 14);
  // The slide rides its own lane with its curve, and the render bends that lane.
  assert.equal(fields.sourceLanes.length, 2, 'the bending channel has its own lane');
  const bent = fields.sourceBends.find((b) => b.points.length > 0);
  assert.ok(bent && bent.lane === 1, 'lane B carries the slide');
  const render = clipRenderInput(fields, fields.sourceTotalSteps);
  assert.ok(render.bends, 'the clip audio renders the slide');
  // Open the clip in the roll: the same ticks, tempo, meter and slide.
  usePianoRollStore.getState().loadFromClip(...clipRollLoad({ id: 'mid-clip', ...fields }));
  const roll = st();
  assert.equal(roll.bpm, 97.3);
  assert.deepEqual(
    [...roll.notes].sort((x, y) => (x.tick ?? 0) - (y.tick ?? 0) || x.note - y.note).map((n) => [n.note, n.tick, n.ticks, n.lane ?? 0]),
    [[60, 0, 960, 0], [64, 38, 922, 0], [67, 1080, 120, 0], [55, 1920, 960, 1]],
  );
  assert.ok(roll.bends.some((b) => b.lane === 1 && b.points.length > 0), 'the roll bends lane B');
}

console.log('rollClip: ok');
