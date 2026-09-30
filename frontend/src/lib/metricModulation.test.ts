/**
 * metricModulation — the tempo a note-value equation gives, from the tempo in
 * force before the bar line, and the replay a user makes: a 4/4 roll changes to
 * 12/8 at bar 3 with "quarter = dotted quarter" (the beat stays the beat), the
 * modulation goes into the roll's tempo map, bar 3's dotted quarter lasts as
 * long as bar 2's quarter, a MIDI export carries the new tempo on bar 3's
 * line, the file reads back to the same map, and undo takes the point back.
 * Run from `frontend/`:
 *   npx tsx src/lib/metricModulation.test.ts
 */
import assert from 'node:assert/strict';
import {
  NOTE_VALUES,
  equationText,
  metricModulation,
  modulatedTempo,
  noteValue,
  tempoInForceBefore,
} from './metricModulation.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { ROLL_PPQ, midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { stepClock } from './rollTempo.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { TempoEvent } from './tempoMap.ts';

const near = (a: number, b: number, eps: number, msg: string): void => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const v = noteValue;

// The values are their lengths in quarter notes, longest first, with unique ids.
assert.equal(new Set(NOTE_VALUES.map((n) => n.id)).size, NOTE_VALUES.length);
for (let i = 1; i < NOTE_VALUES.length; i += 1) assert.ok(NOTE_VALUES[i].quarters < NOTE_VALUES[i - 1].quarters, `${NOTE_VALUES[i].id} is shorter than the one before`);
assert.equal(v('no-such').id, 'quarter', 'an unknown id reads as the quarter');

// The equation: the value on the left at the old tempo lasts as long as the one on the right at the new.
near(modulatedTempo(120, v('dotted-quarter'), v('quarter')), 80, 1e-12, 'dotted quarter = quarter slows by 2/3');
near(modulatedTempo(120, v('quarter'), v('dotted-quarter')), 180, 1e-12, 'quarter = dotted quarter');
near(modulatedTempo(120, v('eighth'), v('eighth-triplet')), 80, 1e-12, '8th = 8th triplet');
near(modulatedTempo(90, v('quarter'), v('eighth-quintuplet')), 36, 1e-12, 'quarter = 8th quintuplet: five 8ths in the old beat become two new quarters');
near(modulatedTempo(100, v('sixteenth-septuplet'), v('sixteenth')), 175, 1e-12, 'a septuplet 16th = 16th');
// Seconds agree: the old value's length at the old tempo is the new value's at the new.
for (const [a, b] of [['dotted-quarter', 'quarter'], ['half-triplet', 'dotted-eighth'], ['whole', 'thirty-second']] as const) {
  const bpm = modulatedTempo(72, v(a), v(b));
  near((60 / 72) * v(a).quarters, (60 / bpm) * v(b).quarters, 1e-12, `${a} = ${b} keeps the length`);
}
assert.equal(equationText(v('dotted-quarter'), v('quarter')), 'Dotted quarter = Quarter');

// The tempo in force before a bar line.
{
  const map: TempoEvent[] = [
    { beat: 0, bpm: 60 },
    { beat: 8, bpm: 120, curve: 'linear' },
    { beat: 16, bpm: 80 },
    { beat: 24, bpm: 100 },
    { beat: 26, bpm: 100, fermata: { beats: 1, stretch: 4 } },
  ];
  assert.equal(tempoInForceBefore(map, 0), 60, 'bar 1 reads the starting tempo');
  assert.equal(tempoInForceBefore(map, 4), 60, 'a step holds');
  assert.equal(tempoInForceBefore(map, 8), 60, 'a point on the line is what a modulation there replaces');
  near(tempoInForceBefore(map, 12), 100, 1e-12, 'a ramp running through the line: its value there');
  assert.equal(tempoInForceBefore(map, 16), 80, 'a ramp ending on the line has arrived');
  assert.equal(tempoInForceBefore(map, 26.5), 100, 'a fermata is a hold, not a tempo');
  assert.equal(tempoInForceBefore([], 4), 120, 'an empty map reads as the default tempo');
}

// Past the app's range the tempo is held to its edge, and says so.
{
  const fast = metricModulation([{ beat: 0, bpm: 250 }], 4, v('eighth'), v('quarter'));
  assert.deepEqual([fast.from, fast.bpm, fast.clamped, fast.exact], [250, 300, true, 500]);
  const slow = metricModulation([{ beat: 0, bpm: 30 }], 4, v('quarter'), v('eighth'));
  assert.deepEqual([slow.bpm, slow.clamped], [20, true]);
  const fraction = metricModulation([{ beat: 0, bpm: 97 }], 4, v('dotted-quarter'), v('quarter'));
  assert.equal(fraction.bpm, 64.67, 'kept to the hundredth');
  assert.equal(fraction.clamped, false);
}

// The replay: 4/4 into 12/8 at bar 3 with the beat kept.
{
  const roll = () => usePianoRollStore.getState();
  const notes: PianoNote[] = [];
  for (let s = 0; s < 32; s += 4) notes.push({ id: `q${s}`, note: 60, step: s, length: 4, velocity: 90 });
  for (let s = 32; s < 56; s += 2) notes.push({ id: `e${s}`, note: 67, step: s, length: 2, velocity: 90 });
  roll().importNotes(notes, 120, {
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 2, meter: { num: 12, den: 8, groups: [3, 3, 3, 3] } }],
    pickupSteps: 0,
    lanes: [{ id: 0, name: 'A', cycleSteps: null }],
  });
  await new Promise((done) => setTimeout(done, 350)); // a pause, so the next edit is its own undo step
  const before = roll().tempoMap;
  const beat = 32 / 4;
  const mod = metricModulation(roll().tempoMap, beat, v('quarter'), v('dotted-quarter'));
  assert.equal(mod.bpm, 180);
  roll().addTempoEvent({ beat: mod.beat, bpm: mod.bpm, curve: 'step' });
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [8, 180]]);

  const clock = stepClock(roll().bpm, roll().tempoMap);
  const quarterBar2 = clock.at(20) - clock.at(16);
  const dottedBar3 = clock.at(38) - clock.at(32);
  near(dottedBar3, quarterBar2, 1e-12, "bar 3's dotted quarter lasts bar 2's quarter");
  near(quarterBar2, 0.5, 1e-12, 'a quarter at 120');

  // MIDI: the modulation is a tempo on bar 3's line, and the file reads back to the same map.
  const file = rollToMidiFile(roll());
  assert.deepEqual((file.tempos ?? []).map((t) => [t.tick, t.bpm]), [[0, 120], [8 * ROLL_PPQ, 180]]);
  const back = midiFileToRoll(parseMidi(encodeMidi(file)));
  assert.deepEqual(back.tempoMap?.map((e) => [e.beat, e.bpm]), [[0, 120], [8, 180]]);

  roll().undo();
  assert.deepEqual(roll().tempoMap, before, 'undo takes the modulation back');
}

console.log('metricModulation: ok');
