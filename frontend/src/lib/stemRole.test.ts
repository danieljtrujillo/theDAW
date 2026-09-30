/**
 * A song's stem MIDI arrives on the instrument of its stem.
 *
 * basic-pitch writes every transcription on General MIDI program 4 (Electric
 * Piano 1), so before this a bass line, a guitar part and a sung melody all
 * came into the roll and onto EDIT as an electric piano. The stem's name (the
 * library row, the file name) says what it is: the part takes that role's
 * instrument, in each place a stem MIDI comes in: LIBRARY's "Send to piano
 * roll", the MIDI tab's IMPORT of a file, and "Import as tracks". A file that
 * carries a program of its own, and a stem that names no instrument, keep
 * the file's program.
 *
 *   cd frontend && npx tsx src/lib/stemRole.test.ts
 */
import assert from 'node:assert/strict';
import { BASIC_PITCH_PROGRAM, stemPartName, stemRoleOf, stemRoleVoice } from './stemRole.ts';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { loadMidiIntoPianoRoll, sendMidiIdToTarget } from './sendToTargets.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { midiFileToRollParts } from './rollMidi.ts';
import { importMidiAsTracks } from './midiImportTracks.ts';
import { activeTrackOf, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { useEditorStore } from '../state/editorStore.ts';

const roll = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();

/** A transcription as basic-pitch writes it: one unnamed track on program 4, channel 1. */
const transcription = (notes: number[], program = BASIC_PITCH_PROGRAM, channel = 0): MidiFileData => ({
  ppq: 220,
  bpm: 120,
  tracks: [{
    name: '',
    programs: [{ tick: 0, channel, program }],
    notes: notes.map((note, i) => ({ tick: i * 220, durationTicks: 200, note, velocity: 90, channel })),
  }],
});
const bytesOf = (f: MidiFileData) => encodeMidi(f);

// The names a stem comes under.
{
  assert.equal(stemRoleOf('bass.mid'), 'bass');
  assert.equal(stemRoleOf('3fa2c9e1__bass_midi'), 'bass', 'a library row id');
  assert.equal(stemRoleOf('My Song · lead_vocals'), 'vocals', 'a library label');
  assert.equal(stemRoleOf('Blue Guitar · other'), null, 'the stem comes after the title: "other" names no instrument');
  assert.equal(stemRoleOf('Song · no_vocals'), null, 'the instrumental is not vocals');
  assert.equal(stemRoleOf('entry__full'), null, 'the full mix names no instrument');
  assert.equal(stemRoleOf('hi-hat.mid'), 'hihat');
  assert.equal(stemRoleOf('Song · guitar'), 'guitar');
  assert.equal(stemRoleOf(''), null);
  assert.deepEqual(stemRoleVoice('bass'), { role: 'bass', instrumentId: 'electric-bass', program: 33, bank: 0, percussion: false, name: 'Bass' });
  assert.equal(stemRoleVoice('vocals')?.instrumentId, 'voice');
  assert.equal(stemRoleVoice('guitar')?.program, 26);
  assert.deepEqual(stemRoleVoice('kick'), { role: 'kick', instrumentId: 'drum-kit', program: 0, bank: 0, percussion: true, name: 'Kick' });
  assert.equal(stemPartName('lead_vocals'), 'Vocals');
  assert.equal(stemPartName('other'), 'Other');
  assert.equal(stemPartName('no_vocals'), 'No vocals');
}

// The file read into parts: a stem's name gives its program-4 part the stem's instrument.
{
  const file = parseMidi(bytesOf(transcription([40, 43])));
  const plain = midiFileToRollParts(file).parts[0].track;
  assert.equal(plain.program, BASIC_PITCH_PROGRAM, 'a file with no stem name keeps its program');
  const bass = midiFileToRollParts(file, 'imp', { stem: 'bass.mid' }).parts[0].track;
  assert.equal(bass.program, 33, 'Electric Bass (finger)');
  assert.equal(bass.instrumentId, 'electric-bass');
  assert.equal(bass.name, 'Bass', 'the unnamed track takes the stem as its name');
  assert.equal(bass.channel, 1);
  const kick = midiFileToRollParts(file, 'imp', { stem: 'kick.mid' }).parts[0].track;
  assert.equal(kick.channel, 10, 'a kit piece plays on the drum channel');
  assert.equal(kick.program, 0);
  // A file that chose its own program keeps it, stem name or not.
  const own = midiFileToRollParts(parseMidi(bytesOf(transcription([40], 38))), 'imp', { stem: 'bass.mid' }).parts[0].track;
  assert.equal(own.program, 38, 'Synth Bass 1 stays');
  // "other" names no instrument: the file's program stays.
  assert.equal(midiFileToRollParts(file, 'imp', { stem: 'Song · other' }).parts[0].track.program, BASIC_PITCH_PROGRAM);
}

// The library's "Send to piano roll", as LIBRARY sends a stem's MIDI row.
const served = new Map<string, Uint8Array>();
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  const bytes = served.get(decodeURIComponent(String(url).split('/').pop() ?? ''));
  return bytes ? new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 }) : new Response('missing', { status: 404 });
};
{
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  served.set('e1__vocals_midi', bytesOf(transcription([67, 69, 71])));
  await sendMidiIdToTarget('e1__vocals_midi', 'piano-roll');
  const part = activeTrackOf(roll());
  assert.equal(part.program, 53, 'the vocal stem sings on the voice, not on an electric piano');
  assert.equal(part.instrumentId, 'voice');
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  served.set('e1__guitar_midi', bytesOf(transcription([52, 55])));
  await sendMidiIdToTarget('e1__guitar_midi', 'piano-roll');
  assert.equal(activeTrackOf(roll()).program, 26);
}

// Stems sent one after another into the part being edited, as LIBRARY's "Send to piano roll" is used:
// each replaces the part's notes and brings its own stem's instrument, not the one the stem before it gave the part.
{
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  served.set('e2__vocals_midi', bytesOf(transcription([67, 69])));
  served.set('e2__bass_midi', bytesOf(transcription([40, 43])));
  served.set('e2__other_midi', bytesOf(transcription([72])));
  await sendMidiIdToTarget('e2__vocals_midi', 'piano-roll');
  assert.equal(activeTrackOf(roll()).name, 'Voice');
  await sendMidiIdToTarget('e2__bass_midi', 'piano-roll');
  const bass = activeTrackOf(roll());
  assert.deepEqual(roll().notes.map((n) => n.note), [40, 43], 'the bass notes replaced the vocal notes');
  assert.equal(bass.program, 33, 'the bass plays the electric bass, not the voice the vocal stem gave the part');
  assert.equal(bass.instrumentId, 'electric-bass');
  assert.equal(bass.name, 'Electric Bass', 'the name the vocal stem gave the part follows the new instrument');
  // A stem that names no instrument leaves the part's instrument as it is.
  await sendMidiIdToTarget('e2__other_midi', 'piano-roll');
  assert.equal(activeTrackOf(roll()).program, 33);
  // A part the user named keeps its name under a stem's instrument.
  roll().importParts([{ name: 'Low line', program: 0, notes: [] }], 120);
  await sendMidiIdToTarget('e2__bass_midi', 'piano-roll');
  assert.equal(activeTrackOf(roll()).program, 33, "the stem's notes are a bass line, so the part plays the electric bass");
  assert.equal(activeTrackOf(roll()).name, 'Low line');
}

// A stem transcribed on its role's own program (bass 33, guitar 25, as the MIDI engine writes them now), sent into
// a part that already plays an instrument: the part takes the file's program, not the instrument it had.
{
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  served.set('e3__vocals_midi', bytesOf(transcription([67, 69], 53)));
  served.set('e3__bass_midi', bytesOf(transcription([40, 43], 33)));
  served.set('e3__guitar_midi', bytesOf(transcription([52, 55], 25)));
  await sendMidiIdToTarget('e3__vocals_midi', 'piano-roll');
  assert.equal(activeTrackOf(roll()).instrumentId, 'voice', 'the vocal stem on Voice Oohs plays the voice');
  await sendMidiIdToTarget('e3__bass_midi', 'piano-roll');
  const bass = activeTrackOf(roll());
  assert.equal(bass.program, 33, "the bass stem's own program replaces the voice the vocal stem gave the part");
  assert.equal(bass.instrumentId, 'electric-bass');
  assert.equal(bass.name, 'Electric Bass', 'the name the vocal stem gave the part follows the new instrument');
  await sendMidiIdToTarget('e3__guitar_midi', 'piano-roll');
  const guitar = activeTrackOf(roll());
  assert.equal(guitar.program, 25, "Acoustic Guitar (steel), the guitar stem's own program, replaces the electric bass");
  assert.equal(guitar.instrumentId, undefined, 'the registry has no instrument on program 25');
  assert.equal(guitar.name, 'Acoustic Guitar (steel)', 'the name the bass stem gave the part follows the new program');
  // A file on basic-pitch's stock program still takes the role's program.
  loadMidiIntoPianoRoll(bytesOf(transcription([40])), 'piano-roll', 'bass.mid');
  assert.equal(activeTrackOf(roll()).program, 33, 'program 4 on a bass stem plays the role program');
}

// LIBRARY's MIDI IN, a stem file saved from the library ("bass.mid") picked off the disk.
{
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  assert.equal(loadMidiIntoPianoRoll(bytesOf(transcription([40, 43])), 'piano-roll', 'bass.mid'), true);
  assert.equal(activeTrackOf(roll()).program, 33, 'the file named for its stem plays the electric bass');
}

// The MIDI tab's IMPORT of a stem file saved from the library.
{
  roll().importParts([{ name: 'Part 1', notes: [] }], 120);
  const done = importMidiParts(parseMidi(bytesOf(transcription([36, 38]))), 'imp', { stem: 'bass.mid' });
  assert.equal(done.notes, 2);
  assert.equal(rollTracksOf(roll())[0].program, 33);
}

// "Import as tracks": the EDIT track and its clip play the stem's instrument.
{
  ed().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
  const done = importMidiAsTracks(parseMidi(bytesOf(transcription([40, 43]))), { label: 'Song · bass', atSec: 0 }, { global: () => ({ useSoundfont: true, activeProgram: 0 }) });
  assert.ok(done);
  assert.equal(done.parts[0].program, 33, 'the clip sounds the electric bass');
  assert.equal(done.parts[0].name, 'Bass');
  const track = ed().tracks.find((t) => t.id === done.parts[0].trackId);
  assert.equal(track?.instrumentProgram, 33, "and so does its track");
  assert.equal(track?.isPercussion, undefined);
}

console.log('stemRole: ok');
