/**
 * One channel's pitch wheel under chords, on import (lib/rollMidi).
 *
 * A pitch wheel bends every note sounding on its channel. A transcriber that
 * writes one channel (basic-pitch) puts each note's own bend on that wheel,
 * so where notes overlap the wheel's value belongs to one of them and bends
 * the rest with it. The import used to give the channel a lane of its own
 * with the wheel as one curve, which bent whole chords. Now a channel whose
 * notes overlap reads its wheel note by note: where one note sounds, the bend
 * becomes that note's own expression (its start value and its curve, at the
 * channel's range); where several sound, the bend is left out and the LOG
 * says how many chords lost one. A channel that plays one note at a time
 * keeps its lane curve, and the roll's own files keep their lanes as written.
 *
 *   cd frontend && npx tsx src/lib/rollMidiChordBend.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiFileToRoll, midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { bendRawToValue } from './pitchBend.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { loadMidiIntoPianoRoll } from './sendToTargets.ts';
import { importMidiAsTracks, importTracksReport } from './midiImportTracks.ts';
import { midiClipPlacedReport, placeMidiFileClip } from './midiClipPlace.ts';
import { useLogStore } from '../state/logStore.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';

const roll = () => usePianoRollStore.getState();

// A guitar stem as basic-pitch writes it at 480 PPQ: a bent single note, a chord under a moving wheel, a note bent down.
const guitar: MidiFileData = {
  ppq: 480,
  bpm: 120,
  tracks: [{
    name: 'Guitar',
    programs: [{ tick: 0, channel: 0, program: 4 }],
    notes: [
      { tick: 0, durationTicks: 480, note: 60, velocity: 90, channel: 0 },
      { tick: 480, durationTicks: 480, note: 64, velocity: 90, channel: 0 },
      { tick: 480, durationTicks: 480, note: 67, velocity: 90, channel: 0 },
      { tick: 1000, durationTicks: 200, note: 72, velocity: 90, channel: 0 },
    ],
    bends: [
      { tick: 0, channel: 0, value: 8192 },
      { tick: 120, channel: 0, value: 10000 },
      { tick: 240, channel: 0, value: 12000 },
      { tick: 360, channel: 0, value: 8192 },
      { tick: 600, channel: 0, value: 12000 },
      { tick: 840, channel: 0, value: 8192 },
      { tick: 1000, channel: 0, value: 6000 },
      { tick: 1100, channel: 0, value: 8192 },
    ],
  }],
};
const file = parseMidi(encodeMidi(guitar));

// The wheel becomes each lone note's own bend; the chord plays unbent.
{
  const read = midiFileToRoll(file, 'g');
  assert.deepEqual(read.meter.lanes.map((l) => l.id), [0], 'no lane is made for the channel');
  assert.equal(read.bends.filter((b) => b.points.length).length, 0, 'no lane curve bends the chord');
  const byNote = new Map(read.notes.map((n) => [n.note, n]));
  // 480 PPQ doubles to the roll's 960.
  assert.deepEqual(byNote.get(60)?.expr, {
    pitchBend: 0,
    bendRange: 2,
    curves: { pitchBend: [{ tick: 240, value: bendRawToValue(10000) }, { tick: 480, value: bendRawToValue(12000) }, { tick: 720, value: 0 }] },
  }, 'the first note carries the bend it was sung with');
  assert.equal(byNote.get(64)?.expr, undefined, 'the chord notes carry no bend');
  assert.equal(byNote.get(67)?.expr, undefined);
  assert.deepEqual(byNote.get(72)?.expr, { pitchBend: bendRawToValue(6000), bendRange: 2, curves: { pitchBend: [{ tick: 200, value: 0 }] } });
  assert.equal(read.chordBends, 1, 'one chord lost the wheel that moved under it');
  assert.equal(read.noteBends, 2, 'two notes took their bend as their own');
}

// A channel that plays one note at a time keeps its lane curve, as it always did.
{
  const mono = parseMidi(encodeMidi({
    ppq: 480,
    bpm: 120,
    tracks: [{
      name: 'Lead',
      notes: [{ tick: 0, durationTicks: 480, note: 60, velocity: 90, channel: 0 }, { tick: 480, durationTicks: 480, note: 62, velocity: 90, channel: 0 }],
      bends: [{ tick: 0, channel: 0, value: 8192 }, { tick: 240, channel: 0, value: 16383 }, { tick: 480, channel: 0, value: 8192 }],
    }],
  }));
  const read = midiFileToRoll(mono, 'm');
  assert.equal(read.bends.filter((b) => b.points.length).length, 1, 'the lead keeps its lane curve');
  assert.equal(read.notes.every((n) => !n.expr), true);
  assert.equal(read.chordBends, 0);
}

// The roll's own file of a bent chord (its lane A curve under a chord) comes back as the lane curve it wrote.
{
  roll().importParts([{ name: 'Pad', notes: [
    { id: 'c1', note: 60, step: 0, length: 16, velocity: 90 },
    { id: 'c2', note: 64, step: 0, length: 16, velocity: 90 },
  ] }], 120);
  const own = parseMidi(encodeMidi(rollToMidiFile({ ...roll(), bends: [{ lane: 0, range: 2, points: [{ id: 'a', step: 0, value: 0, shape: 'linear' }, { id: 'b', step: 8, value: 1, shape: 'hold' }] }] })));
  const back = midiFileToRollParts(own);
  assert.equal(back.bends.filter((b) => b.points.length).length, 1, "the roll's own bent chord keeps its curve");
  assert.equal(back.chordBends, 0);
}

// Every import says so in the LOG.
{
  const logged = (level: string) => useLogStore.getState().entries.filter((e) => e.level === level).map((e) => e.msg).join('\n');
  useLogStore.getState().clear();
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  const done = importMidiParts(file, 'imp');
  assert.equal(done.chordBends, 1);
  assert.equal(done.noteBends, 2);
  assert.equal(loadMidiIntoPianoRoll(encodeMidi(guitar), 'piano-roll', 'guitar.mid'), true);
  assert.match(logged('warn'), /"guitar\.mid": the pitch wheel moved under 1 chord; .* the chord plays unbent/, 'LIBRARY and the MIDI tab warn');
  assert.match(logged('info'), /2 notes of "guitar.mid" took their channel's pitch bend as their own/);

  useEditorStore.getState().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
  const tracks = importMidiAsTracks(file, { label: 'guitar', atSec: 0 }, { global: () => ({ useSoundfont: true, activeProgram: 0 }) });
  assert.ok(tracks);
  assert.match(importTracksReport(tracks, 'guitar', 0).warn.join('\n'), /pitch wheel moved under 1 chord/, 'Import as tracks warns');
  const clip = placeMidiFileClip(file, { label: 'guitar', startSec: 0 }, { global: () => ({ useSoundfont: true, activeProgram: 0 }) });
  assert.ok(clip);
  assert.match(midiClipPlacedReport(clip, 'guitar', 0).warn.join('\n'), /pitch wheel moved under 1 chord/, "EDIT's drop warns");
}

console.log('rollMidiChordBend: ok');
