/**
 * A MIDI row dragged from the LIBRARY into EDIT keeps the file's program and
 * its drums (lib/midiClipPlace, what WaveformEditor's drop and add-to-track
 * menu place a MIDI file with).
 *
 * Before: the drop made a clip on the picker's program with no drum flag, so
 * a drum MIDI (channel 10) played its kick and snare keys as pitched notes on
 * a piano, and a bass stem played Electric Piano. Now a drum file lands on a
 * drum track and plays its kit, a stem plays its stem's instrument, a blank
 * lane takes the file's kind, a lane of the other kind that holds clips keeps
 * its voice and the file gets a track of its own, and the clip reopens in the
 * roll as a percussion part.
 *
 *   cd frontend && npx tsx src/lib/midiClipPlace.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiClipPlacedReport, placeMidiFileClip } from './midiClipPlace.ts';
import { clipVoice, type GlobalVoice } from './clipProgram.ts';
import { clipPartsLoad } from './rollClip.ts';

const ed = () => useEditorStore.getState();
const picker: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const deps = { global: () => picker };
const fresh = () => ed().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
const voiceOf = (clipId: string) => {
  const clip = ed().clips.find((c) => c.id === clipId)!;
  return clipVoice(clip, ed().tracks.find((t) => t.id === clip.trackId), picker);
};

/** The drum engine's file: pretty_midi's is_drum instrument, channel 10, kick and snare keys. */
const drumFile = parseMidi(encodeMidi({
  ppq: 220,
  bpm: 100,
  tracks: [{
    name: 'Drums',
    programs: [{ tick: 0, channel: 9, program: 0 }],
    notes: [36, 38, 36, 38].map((note, i) => ({ tick: i * 220, durationTicks: 50, note, velocity: 100, channel: 9 })),
  }],
} satisfies MidiFileData));

/** basic-pitch's bass stem: one unnamed track on program 4. */
const bassFile = parseMidi(encodeMidi({
  ppq: 220,
  bpm: 100,
  tracks: [{ name: '', programs: [{ tick: 0, channel: 0, program: 4 }], notes: [40, 43].map((note, i) => ({ tick: i * 440, durationTicks: 400, note, velocity: 90, channel: 0 })) }],
} satisfies MidiFileData));

// A drum MIDI dropped under every lane: a drum track, and the clip plays its kit.
{
  fresh();
  const done = placeMidiFileClip(drumFile, { label: 'Song · drums', startSec: 0, fromAudio: true }, deps);
  assert.ok(done);
  const track = ed().tracks.find((t) => t.id === done.trackId)!;
  assert.equal(track.isPercussion, true, 'the drum MIDI lands on a drum track');
  assert.deepEqual(voiceOf(done.clipId), { program: 0, percussion: true }, 'and plays the Standard kit on the drum channel');
  assert.equal(done.newTrack, true);
  // Opened in the roll, it is a percussion part timed against the song's audio.
  const clip = ed().clips.find((c) => c.id === done.clipId)!;
  const load = clipPartsLoad(clip, ed().clips, ed().tracks);
  assert.equal(load[8]?.tracks[0].channel, 10, 'the roll opens it on channel 10');
  assert.equal(load[8]?.tracks[0].fromAudio, true, "and knows it was timed against the song's audio");
  assert.match(midiClipPlacedReport(done, 'Song · drums', 0).info[0], /a new drum track/);
}

// A bass stem's MIDI on a new track: the electric bass, on the clip and on its track.
{
  fresh();
  const done = placeMidiFileClip(bassFile, { label: 'Song · bass', startSec: 1, fromAudio: true }, deps);
  assert.ok(done);
  assert.equal(ed().tracks.find((t) => t.id === done.trackId)?.instrumentProgram, 33);
  assert.equal(ed().clips.find((c) => c.id === done.clipId)?.instrumentProgram, 33);
  assert.deepEqual(voiceOf(done.clipId), { program: 33, percussion: false });
}

// A drum MIDI dropped on a blank lane: the lane becomes a drum track.
{
  fresh();
  const lane = ed().addTrack({ name: 'Track 1' });
  const tracksBefore = ed().tracks.length;
  const done = placeMidiFileClip(drumFile, { label: 'Song · drums', startSec: 0, targetTrackId: lane }, deps);
  assert.ok(done);
  assert.equal(done.trackId, lane, 'it lands on the lane pointed at');
  assert.equal(ed().tracks.find((t) => t.id === lane)?.isPercussion, true, 'which is a drum track now');
  assert.equal(done.turned, true);
  assert.equal(voiceOf(done.clipId).percussion, true);
  assert.equal(ed().tracks.length, tracksBefore, 'no other track was made');
  assert.equal(ed().tracks.find((t) => t.id === lane)?.instrumentProgram, 0, "and plays the file's kit");
}

// A bass stem dropped on a blank melodic lane: the lane takes the stem's instrument, as a new track would,
// so its header names what its clip plays.
{
  fresh();
  const lane = ed().addTrack({ name: 'Track 1' });
  const done = placeMidiFileClip(bassFile, { label: 'Song · bass', startSec: 0, targetTrackId: lane, fromAudio: true }, deps);
  assert.ok(done);
  assert.equal(done.trackId, lane);
  assert.equal(ed().tracks.find((t) => t.id === lane)?.instrumentProgram, 33, 'the blank lane plays the electric bass');
  assert.deepEqual(voiceOf(done.clipId), { program: 33, percussion: false });
  // A lane that holds a clip keeps its own voice: the next file's program goes on its clip only.
  const other = placeMidiFileClip(drumFile, { label: 'Song · drums', startSec: 0, targetTrackId: done.trackId }, deps);
  assert.ok(other);
  assert.equal(ed().tracks.find((t) => t.id === lane)?.instrumentProgram, 33);
}

// A drum MIDI dropped on a piano lane that holds clips: the piano keeps its voice, the drums get a drum track.
{
  fresh();
  const piano = ed().addTrack({ name: 'Piano', nameAutoGenerated: false, instrumentProgram: 0 });
  const bassOnPiano = placeMidiFileClip(bassFile, { label: 'Song · bass', startSec: 0, targetTrackId: piano }, deps);
  assert.ok(bassOnPiano);
  assert.equal(bassOnPiano.trackId, piano, 'a pitched file goes on the pitched lane pointed at');
  assert.equal(voiceOf(bassOnPiano.clipId).program, 33, "its clip plays the file's electric bass over the track's piano");
  assert.equal(ed().tracks.find((t) => t.id === piano)?.instrumentProgram, 0, 'the track keeps its piano');
  const undoBefore = ed()._undo.length;
  const drums = placeMidiFileClip(drumFile, { label: 'Song · drums', startSec: 0, targetTrackId: piano }, deps);
  assert.ok(drums);
  assert.notEqual(drums.trackId, piano, 'the drums do not play on the piano lane');
  assert.equal(ed().tracks.find((t) => t.id === drums.trackId)?.isPercussion, true);
  assert.equal(ed().tracks.find((t) => t.id === piano)?.isPercussion, undefined, 'the piano lane stays melodic');
  assert.equal(drums.movedFrom, 'Piano');
  assert.match(midiClipPlacedReport(drums, 'Song · drums', 0).warn[0], /"Song · drums" is a drum part and "Piano" plays pitched notes, so it went on a new track/);
  assert.equal(ed()._undo.length, undoBefore + 1, 'the track and the clip are one undo step');
}

// A drum MIDI dropped on a drum track that plays a kit of its own (the TR-808, 25): the drum engine's file
// names no kit (pretty_midi writes program 0, the Standard kit, on channel 10), so the clip plays the track's kit.
{
  fresh();
  const kit = ed().addTrack({ name: '808', nameAutoGenerated: false, isPercussion: true, instrumentProgram: 25 });
  const done = placeMidiFileClip(drumFile, { label: 'Song · drums', startSec: 0, targetTrackId: kit, fromAudio: true }, deps);
  assert.ok(done);
  assert.equal(done.trackId, kit, 'the drums land on the drum track pointed at');
  assert.deepEqual(voiceOf(done.clipId), { program: 25, percussion: true }, "and play the track's TR-808 kit");
  // A file that names a kit of its own (Brush, 40) plays it on any drum track.
  const brush = parseMidi(encodeMidi({
    ppq: 220,
    bpm: 100,
    tracks: [{ name: 'Brushes', programs: [{ tick: 0, channel: 9, program: 40 }], notes: [{ tick: 0, durationTicks: 50, note: 38, velocity: 90, channel: 9 }] }],
  } satisfies MidiFileData));
  const brushed = placeMidiFileClip(brush, { label: 'brushes.mid', startSec: 4, targetTrackId: kit }, deps);
  assert.ok(brushed);
  assert.deepEqual(voiceOf(brushed.clipId), { program: 40, percussion: true }, 'a kit the file names plays');
}

// A file of a drum part and a pitched part: one clip, pitched, and the LOG says so.
{
  fresh();
  const both = parseMidi(encodeMidi({
    ppq: 480,
    bpm: 120,
    tracks: [
      { name: 'Drums', notes: [{ tick: 0, durationTicks: 60, note: 36, velocity: 100, channel: 9 }] },
      { name: 'Keys', programs: [{ tick: 0, channel: 0, program: 5 }], notes: [{ tick: 0, durationTicks: 480, note: 60, velocity: 90, channel: 0 }, { tick: 480, durationTicks: 480, note: 64, velocity: 90, channel: 0 }] },
    ],
  } satisfies MidiFileData));
  const done = placeMidiFileClip(both, { label: 'mix.mid', startSec: 0 }, deps);
  assert.ok(done);
  assert.equal(done.file.mixed, true);
  assert.deepEqual(voiceOf(done.clipId), { program: 5, percussion: false });
  assert.match(midiClipPlacedReport(done, 'mix.mid', 0).warn.join('\n'), /Import as tracks gives each part a track of its own/);
}

console.log('midiClipPlace: ok');
