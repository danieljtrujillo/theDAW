// Run with: npx tsx src/lib/meterVocabulary.test.ts
//
// The roll's meter vocabulary: compound meters counted in dotted beats (the
// metrical weights, Virtuoso's oom-pah, the MIDI click), exact group starts in
// /32 bars, and the METER face's PICKUP and GROUPING edits replayed against the
// real store, through undo, a saved clip and a MIDI file and back.
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, signatureClocks } from './midi.ts';
import { accentLines, defaultGroups, groupLines, isCompound, midiEventsToMeterMap, pulseLines, roundUpToBar, type MeterSegment } from './meterMap.ts';
import { pickupLabel, setGroupingText, setUnit, stepPickup } from './meterFace.ts';
import { clipRollLoad, rollClipFields } from './rollClip.ts';
import { midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { metricalWeights } from './syncopation.ts';
import { accStride } from './virtuosoTransform.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const M44 = { num: 4, den: 4, groups: [] };
const SIX8 = { num: 6, den: 8, groups: [] };
const hasBytes = (hay: Uint8Array, needle: number[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((b, j) => hay[i + j] === b)) return true;
  return false;
};
/** Empty history and a reset coalesce clock (state/pianoRollHistory.test.ts beginBlock). */
const resetClock = () => {
  const s = st();
  usePianoRollStore.setState({
    _undo: [{ notes: s.notes, bpm: s.bpm, totalSteps: s.totalSteps, lowestNote: s.lowestNote, highestNote: s.highestNote, meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, bends: s.bends }],
    _redo: [],
  });
  st().undo();
};

// Compound meters: 6/8, 9/8, 12/8 and 15/16 count in dotted beats; 3/8, 7/8 and 6/4 do not.
{
  assert.equal(isCompound(SIX8), true);
  assert.equal(isCompound({ num: 15, den: 16 }), true);
  assert.equal(isCompound({ num: 3, den: 8 }), false);
  assert.equal(isCompound({ num: 7, den: 8 }), false);
  assert.equal(isCompound({ num: 6, den: 4 }), false);
  assert.deepEqual(defaultGroups(12, 8), [3, 3, 3, 3]);
  assert.deepEqual(defaultGroups(7, 8), []);
  assert.deepEqual(accentLines(SIX8), [0, 6]);
  assert.deepEqual(accentLines(M44), [0]);
  assert.deepEqual(pulseLines(M44), [0, 4, 8, 12], 'with one accent the pulse is the beat');
}

// The dotted-beat tier: a bare 6/8 weighs its second dotted beat as a group start, never as eighth 5 of 6.
{
  assert.deepEqual(metricalWeights(SIX8), [4, 1, 2, 1, 2, 1, 3, 1, 2, 1, 2, 1]);
  assert.deepEqual(metricalWeights(SIX8), metricalWeights({ num: 6, den: 8, groups: [3, 3] }), 'the same as 3+3');
  const w128 = metricalWeights({ num: 12, den: 8, groups: [] });
  assert.deepEqual([0, 6, 12, 18].map((i) => w128[i]), [4, 3, 3, 3]);
  assert.deepEqual(metricalWeights({ num: 15, den: 16, groups: [] }).filter((x) => x >= 3).length, 5, '15/16: five dotted 8ths');
  assert.deepEqual(metricalWeights({ num: 6, den: 8, groups: [2, 2, 2] }), [4, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1], 'chosen groups win');
}

// Virtuoso's oom-pah in a bare 6/8 lands on the dotted beats (8ths 1 and 4), not on 8ths 1, 3 and 5.
{
  const v = { bass: 36, voices: [60, 64, 67] };
  const ooms = (meter: { num: number; den: number; groups: number[] }) =>
    accStride(v, 0, 90, meter).filter((n) => n.note === 36 || n.note === 43).map((n) => n.step);
  assert.deepEqual(ooms(SIX8), [0, 6]);
  assert.deepEqual(ooms({ num: 12, den: 8, groups: [] }), [0, 6, 12, 18]);
  assert.deepEqual(ooms({ num: 6, den: 8, groups: [3, 3] }), [0, 6]);
  assert.deepEqual(ooms(M44), [0, 8], '4/4 keeps its oom on beats 1 and 3');
}

// /32 groups start on half steps and stay there bar after bar.
{
  assert.deepEqual(groupLines({ num: 7, den: 32, groups: [3, 2, 2] }), [0, 1.5, 2.5]);
  assert.deepEqual(groupLines({ num: 11, den: 32, groups: [3, 3, 3, 2] }), [0, 1.5, 3, 4.5]);
}

// The MIDI click: FF 58 carries a dotted quarter (36) for 6/8 3+3, a dotted 8th (18) for 12/16
// in threes, and one unit of the denominator otherwise.
{
  assert.equal(signatureClocks(6, 8, [3, 3]), 36);
  assert.equal(signatureClocks(12, 16, [3, 3, 3, 3]), 18);
  assert.equal(signatureClocks(6, 8, [2, 2, 2]), 24);
  assert.equal(signatureClocks(7, 8, [3, 2, 2]), 12);
  assert.equal(signatureClocks(4, 4), 24);
  assert.equal(signatureClocks(3, 2), 48);
  const bytes = encodeMidi({ ppq: 480, bpm: 90, tracks: [], timeSignatures: [{ tick: 0, num: 6, den: 8, groups: [3, 3] }, { tick: 1440, num: 7, den: 8, groups: [3, 2, 2] }] });
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 6, 3, 36, 8]), '6/8 3+3 clicks the dotted quarter');
  assert.ok(hasBytes(bytes, [0xff, 0x58, 0x04, 7, 3, 12, 8]), '7/8 clicks the 8th');
  const parsed = parseMidi(bytes);
  assert.deepEqual(parsed.timeSignatures?.[0], { tick: 0, num: 6, den: 8, clocks: 36, groups: [3, 3] });
}

// A file from another app with a dotted-quarter click and no groups text reads as 3+3; one with an
// 8th click stays even; a roll's own bare 6/8 round-trips bare.
{
  assert.deepEqual(midiEventsToMeterMap([{ tick: 0, num: 6, den: 8, clocks: 36 }], 480).map, [{ bar: 0, meter: { num: 6, den: 8, groups: [3, 3] } }]);
  assert.deepEqual(midiEventsToMeterMap([{ tick: 0, num: 12, den: 8, clocks: 36 }], 480).map, [{ bar: 0, meter: { num: 12, den: 8, groups: [3, 3, 3, 3] } }]);
  assert.deepEqual(midiEventsToMeterMap([{ tick: 0, num: 6, den: 8 }], 480).map, [{ bar: 0, meter: SIX8 }]);
  const roll = { notes: [], lanes: [{ id: 0, name: 'A', cycleSteps: null }], totalSteps: 24, bpm: 100, pickupSteps: 0, bends: [] };
  const bare = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile({ ...roll, meterMap: [{ bar: 0, meter: SIX8 }] }))));
  assert.deepEqual(bare.meter.meterMap, [{ bar: 0, meter: SIX8 }], 'an older roll with a bare 6/8 comes back as it was');
  const threes = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile({ ...roll, meterMap: [{ bar: 0, meter: { num: 6, den: 8, groups: [3, 3] } }] }))));
  assert.deepEqual(threes.meter.meterMap, [{ bar: 0, meter: { num: 6, den: 8, groups: [3, 3] } }]);
}

// The METER face sequence: 4/2 by UNIT, a half-note pickup by PICKUP, a typed grouping on a later
// change, each one undo step; then SAVE to a clip, reopen, export MIDI and import it back.
{
  usePianoRollStore.setState({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0, totalSteps: 64, notes: [], lanes: [{ id: 0, name: 'A', cycleSteps: null }], activeLane: 0, bends: [], selectedIds: new Set(), selectedNoteId: null });
  st().addNote({ note: 60, step: 0, length: 4, velocity: 90 });
  resetClock();

  // UNIT /2: 4/2, then the PICKUP key once: one unit of /2, a half note.
  let edit = setUnit(st().meterMap, 0, 2);
  st().applyMeter({ meterMap: edit.meterMap }, false);
  assert.deepEqual(st().meterMap, [{ bar: 0, meter: { num: 4, den: 2, groups: [] } }]);
  assert.equal(roundUpToBar(st().meterMap, st().totalSteps, st().pickupSteps), st().totalSteps, 'the roll ends on a bar line of 4/2');
  resetClock();
  st().applyMeter({ pickupSteps: stepPickup(st().meterMap, st().pickupSteps, 1, false) });
  assert.equal(st().pickupSteps, 8, 'one half note');
  assert.equal(pickupLabel(st().pickupSteps), '1/2');
  assert.equal(st()._undo.length, 1, 'PICKUP is one undo step');
  st().undo();
  assert.equal(st().pickupSteps, 0, 'undo takes the pickup back');
  st().redo();
  assert.equal(st().pickupSteps, 8);

  // A change at bar 3 in 9/8, grouped 3+3+2+1 by typing it.
  const map: MeterSegment[] = [...st().meterMap, { bar: 2, meter: { num: 9, den: 8, groups: [] } }];
  st().applyMeter({ meterMap: map }, false);
  resetClock();
  const typed = setGroupingText(st().meterMap, 1, '3+3+2+1');
  assert.ok(typed);
  st().applyMeter({ meterMap: typed.meterMap }, false);
  assert.deepEqual(st().meterMap[1], { bar: 2, meter: { num: 9, den: 8, groups: [3, 3, 2, 1] } });
  st().undo();
  assert.deepEqual(st().meterMap[1].meter.groups, [], 'undo takes the typed grouping back');
  st().redo();

  // SAVE into a clip and reopen it: the meter, the grouping and the pickup come back.
  const fields = rollClipFields(st());
  const [, , , , meter] = clipRollLoad({ id: 'c1', ...fields });
  assert.deepEqual(meter, { meterMap: st().meterMap, pickupSteps: 8, lanes: st().lanes });
  // A clip saved by an older build (6/8 with no groups, no pickup field) still opens as it was.
  const [, , , , old] = clipRollLoad({ id: 'old', sourcePianoRoll: [], sourceMeterMap: [{ bar: 0, meter: SIX8 }], sourceTotalSteps: 24 });
  assert.deepEqual(old, { meterMap: [{ bar: 0, meter: SIX8 }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] });

  // Export and import: 4/2 with its half-note pickup, then 9/8 3+3+2+1, as they were.
  const back = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile(st()))));
  assert.deepEqual(back.meter.meterMap, st().meterMap);
  assert.equal(back.meter.pickupSteps, 8);
}

console.log('meterVocabulary: ok');
