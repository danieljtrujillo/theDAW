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

// A 1/32 take at a detected 97.3 BPM: the column quantises at 97.3, and the
// roll takes 97.3 with its fraction, so every note sits on a 32nd (120 ticks)
// however far into the take it is. The roll used to take a whole 97 and
// convert at it, so only 3 of 400 notes sat on a 32nd, up to 60 ticks off.
{
  const long: NoteEvent[] = Array.from({ length: 400 }, (_, i) => ({
    midiNote: 60 + (i % 12),
    startTime: i * 0.4513 + 0.017,
    duration: 0.09 + (i % 5) * 0.05,
    velocity: 90,
  }));
  const quantised = quantizeNotes(long, 97.3, QuantizeValue.Q_1_32);
  const bpm = applyVocalNotesToRoll(quantised, 97.3, false);
  const notes = usePianoRollStore.getState().notes;
  assert.equal(notes.length, 400);
  const off = notes.filter((n) => (n.tick ?? -1) % 120 !== 0 || (n.ticks ?? -1) % 120 !== 0);
  assert.equal(off.length, 0, `every note starts and ends on a 32nd (${off.length} off the grid)`);
  assert.equal(bpm, 97.3);
  assert.equal(usePianoRollStore.getState().bpm, 97.3, 'the roll plays at the tempo the column quantised at');
  // And plays at the second the column put it on.
  const halfTick = 60 / 97.3 / PPQ / 2;
  secondsInRoll().forEach(([start], i) => {
    assert.ok(Math.abs(start - quantised[i].startTime) <= halfTick, `note ${i} plays at its quantised second (${start} s)`);
  });
}

// Quantize off at a detected 97.3 BPM: the roll takes 97.3 and the notes
// convert at it, so each plays at the second it was sung at.
{
  const bpm = applyVocalNotesToRoll(sung, 97.3, false);
  assert.equal(bpm, 97.3);
  assert.equal(usePianoRollStore.getState().bpm, 97.3);
  const halfTick = 60 / 97.3 / PPQ / 2;
  secondsInRoll().forEach(([start, dur], i) => {
    assert.ok(Math.abs(start - sung[i].startTime) <= halfTick, `note ${i} starts where it was sung (${start} s)`);
    assert.ok(Math.abs(dur - sung[i].duration) <= 2 * halfTick, `note ${i} lasts as long as it was sung (${dur} s)`);
  });
  assert.ok(usePianoRollStore.getState().bends.every((b) => b.points.length === 0), 'no slides with Pitch bend off');
}

// Into one part of a roll whose Violin part holds notes, with a tempo change
// and a bend drawn: the take converts through the roll's map, the roll keeps
// its tempo and its bend, and the slides stay out with a line in the log.
{
  const { useLogStore } = await import('../../../state/logStore.ts');
  const roll = () => usePianoRollStore.getState();
  roll().importParts(
    [
      { name: 'Violin', program: 40, notes: [{ id: 'v1', note: 76, step: 0, length: 4, velocity: 90 }] },
      { name: 'Voice', notes: [] },
    ],
    120,
  );
  roll().setTempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 80 }]);
  roll().addBendPoint(0, { step: 0, value: 0.25 });
  roll().setActiveTrack(roll().tracks[1].id);
  const logged = useLogStore.getState().entries.length;
  const bpm = applyVocalNotesToRoll(sung, 97.3, true);
  assert.equal(bpm, 120, "the roll's own tempo");
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [8, 80]], 'the tempo map stays');
  assert.deepEqual(roll().bends.find((b) => b.lane === 0)?.points.map((p) => p.value), [0.25], "the Violin's bend stays; the slides are not written");
  // Each note plays at the second it was sung at, on the roll's 120 BPM (all before beat 8).
  const halfTick = 60 / 120 / PPQ / 2;
  secondsInRoll().forEach(([start], i) => {
    assert.ok(Math.abs(start - sung[i].startTime) <= halfTick, `note ${i} starts where it was sung (${start} s)`);
  });
  const lines = useLogStore.getState().entries.slice(logged).map((e) => e.msg);
  assert.ok(lines.some((m) => /slides were not written/.test(m)), `the log says why the slides are missing (${lines.join(' | ')})`);
}

console.log('vocal2midi rollBridge tests passed');
