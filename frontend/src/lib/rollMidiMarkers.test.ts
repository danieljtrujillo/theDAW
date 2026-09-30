/**
 * The roll's named markers through a MIDI file: FF 06 markers every program
 * reads as names, and the roll's `theDAW:markers=` text with each marker's
 * kind and origin, back into the roll, into EDIT as tracks, and out of EDIT's
 * arrangement.
 *
 * Before: markers lived in the roll and in .tasmo files only; the roll's MIDI
 * export wrote none, an import brought none, and a new file cleared the ones
 * the roll had, so a symphony's sections and movements were lost the moment
 * it went out as MIDI or came in from a notation program.
 *
 *   cd frontend && npx tsx src/lib/rollMidiMarkers.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiFileMarkers, midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { importMidiAsTracks } from './midiImportTracks.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { isClipEditMarker } from './rollMarkers.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { configureMidiRenderQueue } from '../state/midiRenderQueue.ts';
import { liveMidiIfHeard } from '../state/liveMixer.ts';
import { endRollGesture, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const roll = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();
const GLOBAL = { useSoundfont: true, activeProgram: 0 };
configureMidiRenderQueue({
  render: async () => ({ blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), duration: 1 }),
  computePeaks: async () => ({ peaks: new Float32Array(4) }),
  global: () => GLOBAL,
  ensureReady: async () => undefined,
  livePlan: liveMidiIfHeard,
});
const n = (id: string, note: number, step: number): PianoNote => ({ id, note, step, length: 4, velocity: 90 });
const kinds = () => roll().markers.map((m) => [m.tick, m.name, m.kind, m.origin ?? null]);

// ── the codec: FF 06 at its tick, UTF-8 ─────────────────────────────────────
{
  const file: MidiFileData = {
    ppq: 960,
    bpm: 120,
    markers: [{ tick: 0, text: 'I. Allegro' }, { tick: 3840, text: 'II. Adagio – più mosso' }],
    tracks: [{ name: 'Flute', notes: [{ tick: 0, durationTicks: 960, note: 72, velocity: 90, channel: 0 }] }],
  };
  const back = parseMidi(encodeMidi(file));
  assert.deepEqual(back.markers, file.markers, 'each marker at its tick, the dash and the accent kept');
  assert.equal(parseMidi(encodeMidi({ ...file, markers: undefined })).markers, undefined, 'a file with none reads none');
}

// ── the roll's export and import: kinds and origins come back ──────────────
{
  roll().importParts([{ name: 'Flute', program: 73, notes: [n('a', 72, 0), n('b', 74, 16)] }, { name: 'Cello', program: 42, notes: [n('c', 36, 0)] }], 90);
  roll().setMarkers([
    { tick: 0, name: 'I', kind: 'movement' },
    { tick: 0, name: 'Intro', kind: 'section', origin: 'form' },
    { tick: 3840, name: 'A', kind: 'section' },
  ]);
  const want = kinds();
  const file = rollToMidiFile(roll());
  assert.deepEqual(file.markers?.map((m) => [m.tick, m.text]), [[0, 'I'], [0, 'Intro'], [3840, 'A']], 'each marker as FF 06');
  const parsed = parseMidi(encodeMidi(file));
  assert.deepEqual(midiFileMarkers(parsed).map((m) => [m.tick, m.name, m.kind, m.origin ?? null]), want, "the markers text brings each kind and origin back");
  // Into the roll: a file of several parts is a new document with the file's markers.
  roll().setMarkers([{ tick: 960, name: 'Old', kind: 'section' }]);
  // The import records a step of its own, however soon it follows (the store folds edits 300 ms apart).
  endRollGesture();
  importMidiParts(parsed, 'm');
  assert.deepEqual(kinds(), want, "the import gives the roll the file's markers");
  roll().undo();
  assert.deepEqual(roll().markers.map((m) => m.name), ['Old'], 'one undo puts the old markers back');
  // A file a notation program wrote: FF 06 alone, each a section. Two at one place are one section there
  // (lib/rollMarkers keeps one of a kind per place), the later one.
  const plain = parseMidi(encodeMidi({ ...file, dawMarkers: undefined }));
  assert.deepEqual(midiFileToRoll(plain).markers.map((m) => [m.tick, m.name, m.kind]), [[0, 'Intro', 'section'], [3840, 'A', 'section']]);
  // A markers text the file no longer matches (moved in another program) is not trusted.
  const edited = parseMidi(encodeMidi({ ...file, markers: [{ tick: 1920, text: 'A' }] }));
  assert.deepEqual(midiFileToRoll(edited).markers.map((m) => [m.tick, m.name, m.kind]), [[1920, 'A', 'section']], 'the FF 06 marker as it now is');
  // A 480 PPQ file scales its markers to the roll's clock.
  const half = parseMidi(encodeMidi({ ppq: 480, bpm: 120, markers: [{ tick: 1920, text: 'B' }], tracks: [{ name: 'x', notes: [{ tick: 0, durationTicks: 480, note: 60, velocity: 90, channel: 0 }] }] }));
  assert.deepEqual(midiFileToRoll(half).markers.map((m) => m.tick), [3840], "a 480 PPQ marker lands on the roll's 960 clock");
}

// ── a one-part file into a roll whose other parts hold notes keeps the roll's markers ─
{
  roll().importParts([{ name: 'Flute', notes: [n('a', 72, 0)] }, { name: 'Oboe', notes: [n('b', 70, 0)] }], 100);
  roll().setMarkers([{ tick: 0, name: 'Keep', kind: 'section' }]);
  const one = parseMidi(encodeMidi({ ppq: 960, bpm: 100, markers: [{ tick: 0, text: 'File' }], tracks: [{ name: 'Clarinet', notes: [{ tick: 0, durationTicks: 960, note: 65, velocity: 90, channel: 0 }] }] }));
  const done = importMidiParts(one, 'o');
  assert.equal(done.keptDocument, true);
  assert.deepEqual(roll().markers.map((m) => m.name), ['Keep'], "the roll's own markers stay with its document");
}

// ── Import as tracks: every clip carries them, EDIT's timeline shows them once ─
{
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Flute', program: 73, notes: [n('a', 72, 0), n('b', 74, 16)] }, { name: 'Cello', program: 42, notes: [n('c', 36, 0)] }], 120);
  roll().setMarkers([{ tick: 0, name: 'I', kind: 'movement' }, { tick: 3840, name: 'A', kind: 'section' }]);
  const file = parseMidi(encodeMidi(rollToMidiFile(roll())));
  const landed = importMidiAsTracks(file, { label: 'marks', atSec: 1 }, { global: () => GLOBAL });
  assert.ok(landed);
  const clips = landed.parts.map((p) => ed().clips.find((c) => c.id === p.clipId)!);
  assert.ok(clips.every((c) => c.sourceMarkers?.map((m) => `${m.kind}:${m.name}`).join() === 'movement:I,section:A'), 'each clip reopens the markers');
  const onTimeline = ed().markers.filter((m) => clips.some((c) => isClipEditMarker(m, c.id)));
  assert.deepEqual(onTimeline.map((m) => [m.label, Math.round(m.t * 1000) / 1000]), [['I', 1], ['A', 3]], 'once each, where the parts play them (bar 2 at 120 is 2 s in)');
  // Out of EDIT's arrangement: the timeline's markers as FF 06, through the arrangement's tempo map.
  const out = parseMidi(encodeMidi(arrangementToMidiFile(ed()).file));
  assert.deepEqual(out.markers?.map((m) => [m.tick, m.text]), [[1920, 'I'], [5760, 'A']], 'each marker at its second, as ticks of the arrangement');
}

console.log('rollMidiMarkers: ok');
