/**
 * The roll's tempo map through a Standard MIDI File (lib/rollMidi, lib/midi):
 * export writes every tempo event, a ramp as a tempo every 32nd and a fermata
 * as its slowed tempo, so a reader that only knows FF 51 plays each note at
 * the second the roll does; the `theDAW:tempomap=` text brings the ramps and
 * fermatas back on import; a file edited elsewhere comes in as its tempos; a
 * library file with tempo changes renders and loads with them; and a tempo
 * reads back as written without two tempos ever reading as one.
 * Run from `frontend/`:
 *   npx tsx src/lib/rollMidiTempo.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, tempoMicros, tempoOfMicros, type MidiFileData } from './midi.ts';
import { ROLL_PPQ, midiFileToRoll, parseTempoMapText, rollToMidiFile, tempoMapText } from './rollMidi.ts';
import { midiFileRenderNotes } from './midiSynth.ts';
import { stepClock } from './rollTempo.ts';
import { loadMidiIntoPianoRoll } from './sendToTargets.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { TempoEvent } from './tempoMap.ts';

const near = (a: number, b: number, eps: number, msg = ''): void => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b}`);
const shape = (map: readonly TempoEvent[]) =>
  map.map((e) => (e.fermata ? `f${e.beat}:${e.fermata.beats}x${e.fermata.stretch}` : `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`)).join(' ');

/** Seconds of every note in a parsed file the way a plain MIDI reader plays it: FF 51 steps, nothing else. */
const readerSeconds = (file: MidiFileData): number[] => {
  const tempos = [...(file.tempos ?? [{ tick: 0, bpm: file.bpm }])].sort((a, b) => a.tick - b.tick);
  const secOf = (tick: number) => {
    let sec = 0;
    let at = 0;
    let micros = tempoMicros(tempos[0].bpm);
    for (const t of tempos) {
      if (t.tick >= tick) break;
      sec += ((t.tick - at) * micros) / 1e6 / file.ppq;
      at = t.tick;
      micros = tempoMicros(t.bpm);
    }
    return sec + ((tick - at) * micros) / 1e6 / file.ppq;
  };
  return file.tracks.flatMap((t) => t.notes).map((n) => secOf(n.tick));
};

const M44 = [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }];
const LANE = [{ id: 0, name: 'A', cycleSteps: null }];
const notes: PianoNote[] = [];
for (let s = 0; s < 96; s += 2) notes.push({ id: `n${s}`, note: 60 + (s % 7), step: s, length: 2, velocity: 90, tick: s * 240, ticks: 480 });
// A slow introduction, an Allegro, a ritardando, and a fermata on the last chord.
const MAP: TempoEvent[] = [
  { beat: 0, bpm: 54, curve: 'step' },
  { beat: 4, bpm: 132, curve: 'step' },
  { beat: 12, bpm: 132, curve: 'linear' },
  { beat: 20, bpm: 72, curve: 'step' },
  { beat: 22, bpm: 72, fermata: { beats: 1, stretch: 3 } },
];
const ROLL = { notes, lanes: LANE, totalSteps: 96, bpm: 54, meterMap: M44, pickupSteps: 0, bends: [], tempoMap: MAP };

// Export: every tempo event, and a plain reader hears every note at the roll's second.
{
  const file = rollToMidiFile(ROLL);
  const tempos = file.tempos ?? [];
  assert.deepEqual(tempos.slice(0, 2).map((t) => [t.tick, t.bpm]), [[0, 54], [4 * ROLL_PPQ, 132]], 'the introduction and the Allegro');
  const ramp = tempos.filter((t) => t.tick >= 12 * ROLL_PPQ && t.tick < 20 * ROLL_PPQ);
  assert.equal(ramp.length, 8 * 8, 'the ramp is written as a tempo every 32nd');
  for (let i = 1; i < ramp.length; i += 1) assert.ok(ramp[i].bpm < ramp[i - 1].bpm, 'the ritardando slows');
  assert.ok(tempos.some((t) => t.tick === 22 * ROLL_PPQ && Math.abs(t.bpm - 24) < 1e-9), 'the fermata holds at a third of the tempo');
  assert.ok(tempos.some((t) => t.tick === 23 * ROLL_PPQ && t.bpm === 72), 'and the tempo comes back after it');
  assert.equal(file.dawTempoMap, tempoMapText(MAP));

  const parsed = parseMidi(encodeMidi(file));
  const clock = stepClock(54, MAP);
  const heard = readerSeconds(parsed);
  // Microsecond tempos: a reader drifts by at most a few microseconds a beat.
  heard.forEach((sec, i) => near(sec, clock.at(notes[i].step), 2e-4, `note ${i} at step ${notes[i].step}`));
}

// Import: the text brings the map back exactly, ramps and fermata included.
{
  const bytes = encodeMidi(rollToMidiFile(ROLL));
  const back = midiFileToRoll(parseMidi(bytes));
  assert.equal(shape(back.tempoMap), shape(MAP));
  assert.equal(back.bpm, 54);
  assert.deepEqual(back.notes.map((n) => n.tick), notes.map((n) => n.tick), 'the notes keep their ticks');
  // And through the roll's own import, as the MIDI tab's Load does it.
  usePianoRollStore.getState().importNotes(back.notes, back.bpm, back.meter, back.bends, back.tempoMap);
  assert.equal(shape(usePianoRollStore.getState().tempoMap), shape(MAP));
  assert.equal(usePianoRollStore.getState().bpm, 54);
  // A second export writes the same file.
  const again = encodeMidi(rollToMidiFile({ ...usePianoRollStore.getState(), notes }));
  assert.deepEqual(parseMidi(again).tempos, parseMidi(bytes).tempos);
}

// A file whose tempos were edited elsewhere comes in as its tempos, each a step.
{
  const file = rollToMidiFile(ROLL);
  const edited: MidiFileData = { ...file, tempos: [{ tick: 0, bpm: 54 }, { tick: 8 * ROLL_PPQ, bpm: 100 }] };
  const back = midiFileToRoll(parseMidi(encodeMidi(edited)));
  // 54 is 1111111 us in FF 51, and an edited file reads at those microseconds.
  assert.equal(shape(back.tempoMap), `0:${60_000_000 / 1_111_111} 8:100`);
  // A text that does not read is left alone too.
  assert.equal(parseTempoMapText('0:54;oops'), null);
  assert.equal(parseTempoMapText('0:0'), null);
}

// A file from anywhere else: every tempo at its tick, the first at beat 0.
{
  const foreign: MidiFileData = {
    ppq: 96,
    bpm: 80,
    tempos: [{ tick: 0, bpm: 80 }, { tick: 384, bpm: 96.5 }, { tick: 768, bpm: 60 }],
    tracks: [{ name: 'Strings', notes: [{ tick: 0, note: 60, velocity: 90, durationTicks: 96, channel: 0 }, { tick: 768, note: 64, velocity: 90, durationTicks: 96, channel: 0 }] }],
  };
  const bytes = encodeMidi(foreign);
  const back = midiFileToRoll(parseMidi(bytes));
  // 96.5 is 621762 us in FF 51, and the file reads at exactly those microseconds.
  const at965 = 60_000_000 / 621_762;
  assert.equal(shape(back.tempoMap), `0:80 4:${at965} 8:60`);
  // The built-in voice renders a library file at its own tempo changes.
  const rendered = midiFileRenderNotes(parseMidi(bytes));
  near(rendered[1].startSec, 4 * (60 / 80) + 4 * 0.621762, 1e-9, 'the second note after the change, to the microsecond');
  near(rendered[1].durationSec, 1, 1e-6, 'a beat at 60');
  // Send to piano roll from the library: the roll takes the file's map.
  assert.equal(loadMidiIntoPianoRoll(bytes, 'piano-roll', 'strings'), true);
  assert.equal(shape(usePianoRollStore.getState().tempoMap), `0:80 4:${at965} 8:60`);
}

// Every tempo reads at its exact microsecond value, with no rounding path: a
// quarter lasts exactly the microseconds FF 51 holds, and writing that tempo
// again gives the same microseconds, so no round trip moves it. The build
// before this read 97 as 97 (three decimals) while its quarter lasted
// 618557 us, which is 96.99995 BPM.
{
  for (const bpm of [20, 20.5, 33.333, 60, 97, 97.3, 133.5, 240, 300]) {
    const micros = tempoMicros(bpm);
    const read = parseMidi(encodeMidi({ ppq: 480, bpm, tracks: [] })).bpm;
    assert.equal(read, 60_000_000 / micros, `${bpm} reads at exactly ${micros} us`);
    assert.equal(tempoMicros(read), micros, `${bpm} written again keeps ${micros} us`);
    assert.equal(parseMidi(encodeMidi({ ppq: 480, bpm: read, tracks: [] })).bpm, read, `${bpm} survives a second trip`);
  }
  assert.equal(tempoOfMicros(618_557), 60_000_000 / 618_557, 'no three-decimal rounding: 618557 us is not 97');
  assert.notEqual(tempoOfMicros(618_557), 97);
  // Around 20 bpm one thousandth of a bpm spans several microseconds; each still reads as its own tempo.
  const seen = new Set<number>();
  for (let micros = 2_999_990; micros <= 3_000_010; micros += 1) {
    const bpm = tempoOfMicros(micros);
    assert.equal(tempoMicros(bpm), micros, `${micros} us reads back to itself`);
    seen.add(bpm);
  }
  assert.equal(seen.size, 21, 'twenty-one microsecond values, twenty-one tempos');
  // A fermata below 20 bpm is written at its own tempo, not raised to 20.
  assert.equal(tempoMicros(7.5), 8_000_000);
}

// A roll with more than lane A writes one track per lane; its tempo map rides
// with them and comes back on import with every lane, ramp and fermata.
{
  const map: TempoEvent[] = [
    { beat: 0, bpm: 96, curve: 'step' },
    { beat: 4, bpm: 96, curve: 'linear' },
    { beat: 12, bpm: 72, curve: 'step' },
    { beat: 14, bpm: 72, fermata: { beats: 1, stretch: 3 } },
  ];
  const lanes = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 6 }];
  const notes: PianoNote[] = [
    { id: 'a', note: 60, step: 0, length: 4, velocity: 100 },
    { id: 'b', note: 67, step: 0, length: 2, velocity: 100, lane: 1 } as PianoNote,
  ];
  const file = rollToMidiFile({ notes, bpm: 96, tempoMap: map, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes, bends: [], totalSteps: 64 });
  assert.equal(file.tracks.length, 2, 'one track per lane');
  const back = midiFileToRoll(parseMidi(encodeMidi(file)));
  assert.deepEqual(back.meter.lanes.map((l) => [l.id, l.cycleSteps]), [[0, null], [1, 6]], 'both lanes come back');
  assert.equal(shape(back.tempoMap), shape(map), 'the lanes file keeps its tempo map');
  assert.equal(back.bpm, 96);
}

console.log('rollMidiTempo: ok');
