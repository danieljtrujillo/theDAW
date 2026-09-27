/**
 * The vocal2midi column writes its notes into the piano roll at the ticks they
 * arrive on. The column quantises its own seconds when its Quantize setting
 * asks (1/4 to 1/32, or off); the roll used to round every edge again to the
 * nearest 16th with a one-step floor, so a 1/32 take and an unquantised one
 * both reached the roll on 16ths.
 *
 * The sequence replayed: the column quantises a sung take to 1/32 at its
 * detected BPM (midiEditor.quantizeNotes, as its process step does), then
 * applyVocalNotesToRoll writes it with Pitch bend on; the roll then plays each
 * note at tick / PPQ beats at its own BPM.
 */
import assert from 'node:assert/strict';
import { applyVocalNotesToRoll } from './rollBridge.ts';
import { quantizeNotes } from './midiEditor.ts';
import { QuantizeValue, type NoteEvent } from './types.ts';
import { V2M_BEND_RANGE, slideBendPoints } from './audioProcessing.ts';
import { PPQ, usePianoRollStore } from '../../../state/pianoRollStore.ts';

const sung: NoteEvent[] = [
  { midiNote: 60, startTime: 0.5, duration: 0.2, velocity: 90 },
  { midiNote: 62, startTime: 0.83, duration: 0.07, velocity: 80 }, // a 32nd-long grace note
  { midiNote: 61, startTime: 0.9, duration: 0.61, velocity: 85 }, // a slide down a semitone
];

const secondsInRoll = (): Array<[number, number]> => {
  const s = usePianoRollStore.getState();
  const secPerTick = 60 / s.bpm / PPQ;
  return [...s.notes]
    .sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0))
    .map((n) => [(n.tick ?? 0) * secPerTick, (n.ticks ?? 0) * secPerTick]);
};

// A 1/32 take at 120 BPM stays on its 32nds.
{
  const quantised = quantizeNotes(sung, 120, QuantizeValue.Q_1_32);
  const bpm = applyVocalNotesToRoll(quantised, 120, true);
  assert.equal(bpm, 120);
  const halfTick = 60 / 120 / PPQ / 2;
  const got = secondsInRoll();
  assert.equal(got.length, 3);
  got.forEach(([start, dur], i) => {
    assert.ok(Math.abs(start - quantised[i].startTime) <= halfTick, `note ${i} starts on its 32nd (${start} s)`);
    assert.ok(Math.abs(dur - quantised[i].duration) <= 2 * halfTick, `note ${i} lasts its 32nds (${dur} s)`);
  });
  // The grace note is one 32nd: half a 16th, which the roll holds as it is.
  assert.equal([...usePianoRollStore.getState().notes].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0))[1].ticks, 120);
  // With Pitch bend on, lane A holds the slides at the export's range, at the same BPM.
  const laneA = usePianoRollStore.getState().bends.find((b) => b.lane === 0);
  assert.equal(laneA?.range, V2M_BEND_RANGE);
  assert.ok((laneA?.points.length ?? 0) > 0, 'the slide is there');
  assert.deepEqual(laneA?.points.map((p) => p.step), slideBendPoints(quantised, 120).map((p) => p.step));
}

// Quantize off at a detected 97.3 BPM: the roll takes 97 and the notes convert
// at 97, so each plays at the second it was sung at.
{
  const bpm = applyVocalNotesToRoll(sung, 97.3, false);
  assert.equal(bpm, 97);
  assert.equal(usePianoRollStore.getState().bpm, 97);
  const halfTick = 60 / 97 / PPQ / 2;
  secondsInRoll().forEach(([start, dur], i) => {
    assert.ok(Math.abs(start - sung[i].startTime) <= halfTick, `note ${i} starts where it was sung (${start} s)`);
    assert.ok(Math.abs(dur - sung[i].duration) <= 2 * halfTick, `note ${i} lasts as long as it was sung (${dur} s)`);
  });
  assert.ok(usePianoRollStore.getState().bends.every((b) => b.points.length === 0), 'no slides with Pitch bend off');
}

console.log('vocal2midi rollBridge tests passed');
