/**
 * A score or a one-track MIDI file into the roll's parts (lib/rollPartsImport).
 *
 * A score of several parts (the sheet importer's tracks) opens as one part
 * each, on the instrument the importer read (a registry id), else the one the
 * name names, else the GM program, with an unpitched part on channel 10. A
 * one-track file goes into the part being edited and keeps the other parts;
 * the part takes the file's instrument only when it has none of its own, in
 * the bank the file chose it in, as the same track in a larger file does. The
 * roll's own export of a part that follows the picker comes back as that
 * part, never as the piano its track name "Piano Roll" seems to name.
 *
 *   cd frontend && npx tsx src/lib/rollPartsImport.test.ts
 */
import assert from 'node:assert/strict';
import { applyRollParts, importMidiParts, importSheetParts, sheetScoreParts } from './rollPartsImport.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { rollToMidiFile } from './rollMidi.ts';
import { activeTrackOf, endRollGesture, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import type { SheetScore } from './sheetImportClient.ts';

const roll = () => usePianoRollStore.getState();
const sheetNote = (step: number, pitch: number) => ({ pitch, step, length: 2, velocity: 80 });

// A string quartet score as the backend returns it, plus a percussion part and a part from an older backend.
const score: SheetScore = {
  ok: true,
  name: 'Quartet',
  format: 'musicxml',
  bpm: 84,
  time_signature: [3, 4],
  detected_key: 'G major',
  track_count: 6,
  note_count: 11,
  steps_per_quarter: 4,
  tracks: [
    { name: 'Violin I', notes: [sheetNote(0, 79), sheetNote(4, 78)], instrument: 'violin', program: 40, percussion: false },
    { name: 'Violin II', notes: [sheetNote(0, 74)], instrument: 'violin', program: 40, percussion: false },
    { name: 'Viola', notes: [sheetNote(0, 67), sheetNote(8, 66)], instrument: 'viola', program: 41, percussion: false },
    { name: 'Violoncello', notes: [sheetNote(0, 43)], instrument: 'cello', program: 42, percussion: false },
    { name: 'Snare', notes: [sheetNote(0, 38), sheetNote(2, 38)], instrument: 'snare-drum', program: 48, percussion: true },
    // An older backend sends no instrument: the name names it.
    { name: 'Flute', notes: [sheetNote(0, 84), sheetNote(1, 86), sheetNote(2, 88)] },
  ],
};

// The parts, each on its instrument.
{
  const parts = sheetScoreParts(score);
  assert.deepEqual(
    parts.map((p) => [p.track.name, p.track.program, p.track.instrumentId, p.track.channel ?? null, p.notes.length]),
    [
      ['Violin I', 40, 'violin', null, 2],
      ['Violin II', 40, 'violin', null, 1],
      ['Viola', 41, 'viola', null, 2],
      ['Violoncello', 42, 'cello', null, 1],
      ['Snare', 48, 'snare-drum', 10, 2],
      ['Flute', 73, 'flute', null, 3],
    ],
  );
}

// The score into the roll: six parts, its meter and tempo, one undo step.
{
  roll().importNotes([{ id: 'x', note: 60, step: 0, length: 2, velocity: 90 }], 120);
  const done = importSheetParts(score);
  assert.equal(done.into, 'parts');
  assert.equal(done.parts, 6);
  assert.equal(roll().tracks.length, 6, 'one part per score part');
  assert.equal(roll().bpm, 84);
  assert.deepEqual(roll().meterMap[0].meter, { num: 3, den: 4, groups: [] });
  assert.deepEqual(rollTracksOf(roll()).map((t) => t.notes.length), [2, 1, 2, 1, 2, 3]);
  roll().undo();
  assert.equal(roll().tracks.length, 1, 'undo puts the one part back');
}

// A one-track MIDI file goes into the part being edited and names its instrument.
{
  roll().importParts([{ name: 'Part 1', notes: [] }, { name: 'Keep', program: 19, notes: [{ id: 'k', note: 50, step: 0, length: 2, velocity: 90 }] }], 120);
  roll().setActiveTrack(roll().tracks[0].id);
  const file = {
    ppq: 480,
    bpm: 100,
    tracks: [{ name: 'Clarinet', notes: [{ tick: 0, note: 62, velocity: 90, durationTicks: 240, channel: 0 }], programs: [{ tick: 0, channel: 0, program: 71 }] }],
  };
  const done = importMidiParts(file, 't');
  assert.equal(done.into, 'active');
  assert.equal(roll().tracks.length, 2, 'the other part stays');
  assert.equal(done.keptDocument, true, 'the other part holds notes, so the roll keeps its own tempo, meter and bends');
  assert.equal(roll().bpm, 120, "and the file's 100 BPM is not applied");
  const [first, keep] = rollTracksOf(roll());
  assert.equal(first.notes.length, 1, 'the notes are in the part being edited');
  assert.deepEqual([first.program, first.instrumentId, first.name], [71, 'clarinet-bb', 'Clarinet in B♭'], 'which takes the file’s clarinet');
  assert.equal(keep.notes.length, 1, 'the other part keeps its notes');
  // A part with a sound of its own keeps it.
  roll().setActiveTrack(keep.id);
  importMidiParts(file, 't2');
  assert.equal(rollTracksOf(roll())[1].program, 19, 'a part with its own program keeps it');
}

// A one-track file whose track selects bank 1 (LSB 2) before program 60, into a
// part that follows the roll voice: the part takes the program in the file's
// bank, as the same track beside a second one does (importParts keeps the whole
// part). Before: the one-part path carried the controls, instrument and
// program alone, so the part played the program in bank 0.
{
  const horn = {
    name: 'Horn',
    programs: [{ tick: 0, channel: 0, program: 60, bank: 1, bankLsb: 2 }],
    notes: [0, 480].map((tick) => ({ tick, durationTicks: 400, note: 60, velocity: 90, channel: 0 })),
  };
  const strings = {
    name: 'Strings',
    programs: [{ tick: 0, channel: 1, program: 48 }],
    notes: [0, 480].map((tick) => ({ tick, durationTicks: 400, note: 55, velocity: 90, channel: 1 })),
  };
  const voiceOf = (t: { program: number | null; bank: number; bankLsb?: number }) => [t.program, t.bank, t.bankLsb];
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  endRollGesture();
  const one = importMidiParts(parseMidi(encodeMidi({ ppq: 480, bpm: 120, tracks: [horn] })), 'one');
  assert.equal(one.into, 'active');
  assert.deepEqual(voiceOf(rollTracksOf(roll())[0]), [60, 1, 2], 'the one-track file: program 60 in bank 1, LSB 2');
  roll().undo();
  assert.deepEqual(voiceOf(rollTracksOf(roll())[0]), [null, 0, undefined], 'one undo puts the part back on the roll voice in bank 0');
  const two = importMidiParts(parseMidi(encodeMidi({ ppq: 480, bpm: 120, tracks: [horn, strings] })), 'two');
  assert.equal(two.into, 'parts');
  assert.deepEqual(voiceOf(rollTracksOf(roll())[0]), [60, 1, 2], 'the same track in a two-track file: the same voice');
  // A file whose program comes with no bank select is General MIDI: a part that followed the roll voice in Bank 1 takes bank 0.
  roll().importParts([{ name: 'Part 1', bank: 1, bankLsb: 5, notes: [] }], 120);
  endRollGesture();
  importMidiParts(parseMidi(encodeMidi({ ppq: 480, bpm: 120, tracks: [{ ...horn, name: 'Track 1', programs: [{ tick: 0, channel: 0, program: 71 }] }] })), 'gm');
  assert.deepEqual(voiceOf(rollTracksOf(roll())[0]), [71, 0, undefined], "the file's program in bank 0, and the old LSB gone with the old voice");
  // A part with a sound of its own keeps its program and its bank.
  roll().importParts([{ name: 'Violin', program: 40, bank: 2, notes: [] }], 120);
  endRollGesture();
  importMidiParts(parseMidi(encodeMidi({ ppq: 480, bpm: 120, tracks: [horn] })), 'own');
  assert.deepEqual(voiceOf(rollTracksOf(roll())[0]), [40, 2, undefined], 'its own voice stays');
}

// The roll's own export of a fresh roll (Part 1, following the picker) and
// back through the bytes: the part keeps its name and follows the picker
// still. A file the roll wrote before part texts (a "Piano Roll" track with no
// program) leaves the part as it is too.
{
  roll().importParts([{ name: 'Part 1', notes: [{ id: 'a', note: 60, step: 0, length: 2, velocity: 90 }, { id: 'b', note: 64, step: 4, length: 2, velocity: 90 }] }], 120);
  assert.equal(activeTrackOf(roll()).program, null);
  const bytes = encodeMidi(rollToMidiFile(roll()));
  const done = importMidiParts(parseMidi(bytes), 'rt');
  assert.equal(done.into, 'active');
  const part = rollTracksOf(roll())[0];
  assert.deepEqual([part.name, part.program, part.instrumentId], ['Part 1', null, undefined], 'the part still follows the picker, not Acoustic Grand');
  assert.equal(part.notes.length, 2);
  const legacy = { ppq: 480, bpm: 120, tracks: [{ name: 'Piano Roll', notes: [{ tick: 0, note: 60, velocity: 90, durationTicks: 240, channel: 0 }] }] };
  importMidiParts(legacy, 'old');
  assert.deepEqual([rollTracksOf(roll())[0].program, rollTracksOf(roll())[0].instrumentId], [null, undefined], 'an older roll export names no piano either');
  // A track a user named "Piano" still names the piano.
  importMidiParts({ ...legacy, tracks: [{ ...legacy.tracks[0], name: 'Piano' }] }, 'user');
  assert.equal(rollTracksOf(roll())[0].instrumentId, 'piano', "a user's own track name still names its instrument");
}

// Nothing to import changes nothing: the part being edited keeps its notes.
{
  const before = roll().notes;
  const done = applyRollParts([], 120, undefined, undefined, undefined);
  assert.equal(done.notes, 0);
  assert.equal(roll().notes, before, 'the notes are untouched');
}

console.log('rollPartsImport: ok');
