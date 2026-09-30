/**
 * "Edit Timeline" in PERFORM brings each column's voice into EDIT.
 *
 * The sequence: a .tasmo with a bass track, a lead picked from a bank and a
 * drum track is opened in PERFORM (lib/tasmoToSession), and PERFORM's "Edit
 * Timeline" hands the set to EDIT (lib/dawProjectToEditor
 * `importDawProjectToEditor`). EDIT's tracks come out with no program, so the
 * parts played and rendered on the global picker's one instrument and the drum
 * part on a melodic channel. Each MIDI clip's render in EDIT goes through
 * `dawMidiRender`, read back here through the soundfont's SMF.
 *
 *   cd frontend && npx tsx src/lib/dawProjectToEditor.voice.test.ts
 */
import assert from 'node:assert/strict';

import { dawMidiRender, importDawProjectToEditor } from './dawProjectToEditor.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import type { TasmoLoadedTrack } from './projectClient.ts';
import { notesRenderSmf } from './soundfontEngine.ts';
import { parseMidi } from './midi.ts';
import { DRUM_CHANNEL } from './editChannels.ts';
import { clipVoice, type GlobalVoice } from './clipProgram.ts';
import { useEditorStore } from '../state/editorStore.ts';

const PICKER_PIANO: GlobalVoice = { useSoundfont: true, activeProgram: 0 };

const midiTrack = (name: string, over: Partial<TasmoLoadedTrack>): TasmoLoadedTrack => ({
  id: name,
  name,
  type: 'midi',
  clips: [
    {
      id: `${name}-clip`,
      name: `${name} loop`,
      clip_type: 'midi',
      audio_file: null,
      start_time: 0,
      end_time: 2,
      midi_notes: [{ note: 40, step: 0, length: 4, velocity: 100 }],
      scene_index: 0,
      slot_index: 0,
    },
  ],
  ...over,
});

const project = tasmoLoadedToDawProject({
  project_name: 'Hand Off',
  tempo: 120,
  time_signature: [4, 4],
  sample_rate: 44100,
  scenes: ['A'],
  tracks: [
    midiTrack('Bass', { instrument_program: 33 }),
    midiTrack('Lead', { instrument_program: 81, instrument_bank: 8 }),
    midiTrack('Drums', { instrument_program: 25, is_percussion: true }),
    midiTrack('Keys', {}),
  ],
});

// The clip loads fail under node (no soundfont to fetch, no OfflineAudioContext)
// and are logged; the tracks are made before any clip loads.
await importDawProjectToEditor(project);
const byName = new Map(useEditorStore.getState().tracks.map((t) => [t.name, t]));
const bass = byName.get('Bass');
const lead = byName.get('Lead');
const drums = byName.get('Drums');
const keys = byName.get('Keys');
assert.ok(bass && lead && drums && keys, 'every column arrives as an EDIT track');
assert.equal(bass.instrumentProgram, 33, 'the bass track keeps its program');
assert.equal(lead.instrumentProgram, 81, 'the lead track keeps its program');
assert.equal(lead.instrumentBank, 8, 'in its bank');
assert.equal(drums.isPercussion, true, 'the drum track stays a drum track');
assert.equal(drums.instrumentProgram, 25, 'with its kit');
assert.equal(keys.instrumentProgram, undefined, 'a column with no program still follows the picker');

// Each clip renders in EDIT on its track's voice.
const renderOf = (trackIndex: number) => {
  const dawTrack = project.tracks[trackIndex];
  const editTrack = byName.get(dawTrack.name)!;
  const voice = clipVoice({ instrumentProgram: undefined, instrumentBank: undefined }, editTrack, PICKER_PIANO);
  const request = dawMidiRender(dawTrack.clips[0], voice);
  const smf = parseMidi(notesRenderSmf(request.notes, request.options));
  return {
    programs: smf.tracks.flatMap((t) => t.programs ?? []).map((p) => ({ channel: p.channel, program: p.program, bank: p.bank ?? 0 })),
    channels: [...new Set(smf.tracks.flatMap((t) => t.notes.map((n) => n.channel)))],
  };
};
assert.deepEqual(renderOf(0).programs, [{ channel: 0, program: 33, bank: 0 }], 'the bass renders on its program');
assert.deepEqual(renderOf(1).programs, [{ channel: 0, program: 81, bank: 8 }], 'the lead on its program in its bank');
assert.deepEqual(renderOf(2).channels, [DRUM_CHANNEL], 'the drums on the drum channel');
assert.equal(renderOf(2).programs.find((p) => p.channel === DRUM_CHANNEL)?.program, 25, 'with the kit');

console.log('dawProjectToEditor.voice: ok');
