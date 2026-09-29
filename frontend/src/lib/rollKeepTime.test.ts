/**
 * KEEP TIME: a transcription keeps its seconds when the roll takes a new tempo.
 *
 * The sequence a user runs: a song's stem MIDI (basic-pitch writes it at a
 * stamped tempo) goes from the LIBRARY into the roll, then MATCH gives the
 * roll the song's real tempo. Every note must still sound at the second it was
 * transcribed at, or it drifts from the audio it came from. A part written on
 * the grid keeps its place in the bar through the same MATCH. The BPM field's
 * KEEP TIME does the same for every part on a typed tempo, as one undo step.
 * The part's audio mark survives a bounce, a .tasmo and a MIDI export, and a
 * generator's notes clear it.
 *
 *   cd frontend && npx tsx src/lib/rollKeepTime.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { sendMidiIdToTarget } from './sendToTargets.ts';
import { matchApply, writeMatch, keptTimeText } from './meterFace.ts';
import type { RhythmAnalysis } from './rhythmSeed.ts';
import { stepClock } from './rollTempo.ts';
import { cleanRollPartRef, clipPartsLoad, rollPartRef } from './rollClip.ts';
import { rollPartToTasmo, tasmoRollPart } from './projectClient.ts';
import { midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { activeTrackOf, rollTracksOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const roll = () => usePianoRollStore.getState();
/** A new one-part roll at 120 BPM with nothing in it. */
const fresh = (): void => {
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  usePianoRollStore.setState({ _undo: [], _redo: [] });
};
/** Past the store's 300 ms fold, so the next edit is an undo step of its own. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 350));
const near = (a: number, b: number, eps: number, msg: string): void => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** Each note's onset and end in seconds under the roll's own clock. */
const secondsOf = (notes: readonly PianoNote[]): Array<[number, number]> => {
  const clock = stepClock(roll().bpm, roll().tempoMap);
  return notes.map((n) => [clock.at(n.step), clock.at(n.step + n.length)]);
};

/** A stem MIDI the way the library's converter writes it: pretty_midi's 220 PPQ, one unnamed track on program 4, at `bpm`. */
const stemFile = (bpm: number, seconds: Array<[number, number, number]>): MidiFileData => {
  const ppq = 220;
  const tick = (sec: number) => Math.round((sec * bpm * ppq) / 60);
  return {
    ppq,
    bpm,
    tracks: [{
      name: '',
      programs: [{ tick: 0, channel: 0, program: 4 }],
      notes: seconds.map(([start, end, note]) => ({ tick: tick(start), durationTicks: Math.max(1, tick(end) - tick(start)), note, velocity: 90, channel: 0 })),
    }],
  };
};

// The library's MIDI row, fetched as LIBRARY's "Send to piano roll" fetches it.
const served = new Map<string, Uint8Array>();
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  const id = decodeURIComponent(String(url).split('/').pop() ?? '');
  const bytes = served.get(id);
  if (!bytes) return new Response('missing', { status: 404 });
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
};

/** A song at `bpm` in 4/4, steady, `bars` downbeats from 0 s. */
const steadySong = (bpm: number, bars: number): RhythmAnalysis => ({
  status: 'ready',
  tempo: { bpm, stable: true },
  downbeats: Array.from({ length: bars }, (_, i) => Math.round(((i * 4 * 60) / bpm) * 1e6) / 1e6),
  meter_map: [{ start_bar: 0, bars, numerator: 4, denominator: 4, grouping: [4], beats_per_bar: 4, beat_unit: 'quarter' }],
});

const BASS: Array<[number, number, number]> = [[0.5, 1.1, 40], [1.37, 1.9, 43], [2.8, 3.95, 45], [6.1, 6.4, 40]];

// A stem MIDI from the LIBRARY, then MATCH to the song's 92 BPM: every note keeps its second.
{
  fresh();
  served.set('song1__bass_midi', encodeMidi(stemFile(120, BASS)));
  await sendMidiIdToTarget('song1__bass_midi', 'piano-roll');
  assert.equal(roll().bpm, 120, 'the file comes in at the tempo it was stamped at');
  const before = secondsOf(roll().notes);
  BASS.forEach(([start], i) => near(before[i][0], start, 0.01, `note ${i} arrives at its transcribed second`));
  assert.equal(activeTrackOf(roll()).fromAudio, true, "a library song's MIDI is marked as timed against audio");

  // MATCH is pressed a while after the import, so it is an undo step of its own.
  await settle();
  const res = matchApply(roll(), steadySong(92, 12));
  assert.ok(res.apply, 'MATCH reads the song');
  const undoBefore = roll()._undo.length;
  const written = writeMatch(roll(), res.apply);
  near(roll().bpm, 92, 0.01, "the roll takes the song's tempo");
  const after = secondsOf(roll().notes);
  after.forEach(([start, end], i) => {
    near(start, before[i][0], 0.002, `note ${i} starts at the same second after MATCH`);
    near(end, before[i][1], 0.002, `note ${i} ends at the same second after MATCH`);
  });
  assert.equal(written.keptTime, BASS.length, 'MATCH reports the notes that kept their time');
  assert.match(keptTimeText(written.keptTime), /4 NOTES FROM THE SONG'S AUDIO KEPT THEIR TIME/);
  assert.equal(roll()._undo.length, undoBefore + 1, 'MATCH with KEEP TIME is one undo step');
  roll().undo();
  near(roll().bpm, 120, 1e-9, 'undo gives the stamped tempo back');
  secondsOf(roll().notes).forEach(([start], i) => near(start, before[i][0], 0.002, `undo puts note ${i} back`));
}

// A roll of two parts: the stem part keeps its seconds, a part written on the grid keeps its steps.
{
  fresh();
  served.set('song2__vocals_midi', encodeMidi(stemFile(120, [[0.25, 0.75, 64], [3.0, 3.5, 67]])));
  await sendMidiIdToTarget('song2__vocals_midi', 'piano-roll');
  const audioId = roll().activeTrackId;
  const handId = roll().addTrack({ name: 'Keys' });
  assert.ok(handId);
  roll().replaceAll([{ id: 'k1', note: 60, step: 16, length: 4, velocity: 80 }, { id: 'k2', note: 62, step: 48, length: 4, velocity: 80 }]);
  roll().setActiveTrack(audioId);
  const vocalSec = secondsOf(roll().notes);
  const handSteps = rollTracksOf(roll()).find((t) => t.id === handId)!.notes.map((n) => n.step);
  const written = writeMatch(roll(), matchApply(roll(), steadySong(100, 10)).apply!);
  assert.equal(written.keptTime, 2);
  secondsOf(roll().notes).forEach(([start], i) => near(start, vocalSec[i][0], 0.002, `vocal note ${i} keeps its second`));
  assert.deepEqual(rollTracksOf(roll()).find((t) => t.id === handId)!.notes.map((n) => n.step), handSteps, 'the grid part keeps its steps');
}

// The BPM field's KEEP TIME on a roll written on the grid: every part keeps its seconds, one undo step.
{
  fresh();
  usePianoRollStore.setState({ bpm: 120, tempoMap: [{ beat: 0, bpm: 120, curve: 'step' }] });
  roll().replaceAll([
    { id: 'a', note: 60, step: 4, length: 2, velocity: 80, expr: { pitchBend: 0, curves: { pitchBend: [{ tick: 240, value: 0.5 }] } } },
    { id: 'b', note: 64, step: 20, length: 6, velocity: 80 },
  ]);
  usePianoRollStore.setState({ _undo: [], _redo: [] });
  await settle();
  const before = secondsOf(roll().notes);
  const moved = roll().setTempoKeepingTime({ bpm: 90 }, { parts: 'all' });
  assert.equal(moved, 2);
  assert.equal(roll().bpm, 90);
  secondsOf(roll().notes).forEach(([start, end], i) => {
    near(start, before[i][0], 0.002, `note ${i} keeps its start`);
    near(end, before[i][1], 0.002, `note ${i} keeps its end`);
  });
  // The note's bend curve point, 240 ticks in at 120 BPM (0.125 s), is 0.125 s in at 90 BPM too: 180 ticks.
  assert.deepEqual(roll().notes[0].expr?.curves?.pitchBend, [{ tick: 180, value: 0.5 }]);
  assert.equal(roll()._undo.length, 1, 'one undo step');
  assert.equal(roll().setTempoKeepingTime({ bpm: 90 }, { parts: 'all' }), 0, 'the same tempo changes nothing');
  assert.equal(roll()._undo.length, 1, 'and adds no step');
  roll().undo();
  assert.equal(roll().bpm, 120);
  assert.deepEqual(roll().notes.map((n) => n.step), [4, 20]);
}

// The audio mark rides a bounce's part record, a .tasmo and a MIDI export; a generator's notes clear it.
{
  fresh();
  served.set('song3__guitar_midi', encodeMidi(stemFile(120, [[0.5, 1, 52]])));
  await sendMidiIdToTarget('song3__guitar_midi', 'piano-roll');
  const part = activeTrackOf(roll());
  const ref = rollPartRef({ ...part, notes: roll().notes }, 0, 'doc-1');
  assert.equal(ref.fromAudio, true, "the bounce's part record keeps the mark");
  assert.equal(cleanRollPartRef(JSON.parse(JSON.stringify(ref)), { name: 'x', color: '#000000' })?.fromAudio, true, 'an autosave keeps it');
  assert.equal(tasmoRollPart(rollPartToTasmo(ref), { name: 'x', color: '#000000' })?.fromAudio, true, 'a .tasmo keeps it');
  const reopened = clipPartsLoad(
    { id: 'c1', trackId: 't1', label: 'g', color: '#000000', startSec: 0, sourceKind: 'piano-roll', sourceRollPart: ref, sourcePianoRoll: roll().notes, sourceRollNotes: roll().notes, sourceBpm: 120, sourceTotalSteps: 64, sourceMeterMap: roll().meterMap, sourcePickupSteps: 0, sourceLanes: roll().lanes, sourceBends: [] },
    [],
    [],
  );
  assert.equal(reopened[8]?.tracks[0].fromAudio, true, 'the clip reopens in the roll as a part timed against audio');
  const file = parseMidi(encodeMidi(rollToMidiFile({ ...roll(), tracks: rollTracksOf(roll()) })));
  assert.equal(midiFileToRollParts(file).parts[0].track.fromAudio, true, "the roll's own MIDI file keeps the mark");
  roll().importNotes([{ id: 'gen', note: 60, step: 0, length: 4, velocity: 80 }], 120);
  assert.equal(activeTrackOf(roll()).fromAudio, undefined, "a generator's notes are not a transcription");
}

console.log('rollKeepTime: ok');
