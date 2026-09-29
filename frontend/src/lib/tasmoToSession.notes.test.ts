/**
 * A MIDI cell saved from PERFORM reopens in PERFORM with its notes where they were.
 *
 * The sequence: an Ableton set whose MIDI clip carries its notes in seconds
 * (the importer's shape: pitch, start, duration) is opened in PERFORM, saved
 * as .tasmo from PERFORM (lib/projectClient `dawProjectToTasmo`), and the file
 * is opened in PERFORM again (lib/tasmoToSession `tasmoLoadedToDawProject`).
 * The reader took every saved note for the roll's step shape, so a note with
 * no `step` landed on step 0 and every note of the cell sounded at once.
 *
 *   cd frontend && npx tsx src/lib/tasmoToSession.notes.test.ts
 */
import assert from 'node:assert/strict';

import { dawProjectToTasmo, type TasmoLoadedTrack, type TasmoProjectLoaded } from './projectClient.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import type { DawProject } from './dawImportClient.ts';

const notesIn = [
  { pitch: 36, start: 0, duration: 0.25, velocity: 110 },
  { pitch: 38, start: 0.5, duration: 0.25, velocity: 96 },
  { pitch: 42, start: 1.25, duration: 0.125, velocity: 70 },
];

const imported: DawProject = {
  source_daw: 'ableton',
  source_version: '12',
  name: 'Beat',
  tempo: 120,
  time_signature: [4, 4],
  sample_rate: 44100,
  tracks: [
    {
      name: 'Beat',
      type: 'midi',
      volume_db: 0,
      pan: 0,
      mute: false,
      solo: false,
      devices: [],
      clips: [{ name: 'Groove', start_time: 0, end_time: 2, file_path: null, midi_notes: notesIn, track_index: 0, scene_index: 0, slot_index: 0 }],
    },
  ],
  locators: [],
  controller_mappings: [],
  scenes: ['A'],
  plugins_used: [],
  warnings: [],
  missing_files: [],
};

/** The save payload read back as the loader sees it. */
const reopen = (project: DawProject): DawProject => {
  const saved = dawProjectToTasmo(project);
  const loaded: TasmoProjectLoaded = {
    project_name: saved.project_name,
    tempo: saved.tempo,
    time_signature: saved.time_signature,
    sample_rate: saved.sample_rate,
    scenes: saved.scenes,
    tracks: (saved.tracks ?? []).map<TasmoLoadedTrack>((t) => ({
      ...t,
      clips: (t.clips ?? []).map((c) => ({
        ...c,
        audio_file: c.audio_file ?? null,
        midi_notes: c.midi_notes as Array<Record<string, number>> | null,
      })),
    })),
  };
  return tasmoLoadedToDawProject(loaded);
};

const played = (project: DawProject) =>
  (project.tracks[0].clips[0].midi_notes as Array<Record<string, number>>).map((n) => ({
    pitch: n.pitch,
    start: n.start,
    duration: n.duration,
    velocity: n.velocity,
  }));

const once = reopen(imported);
assert.deepEqual(played(once), notesIn, 'the cell reopens with each note at its own time and length');

// A second save and open changes nothing.
assert.deepEqual(played(reopen(once)), notesIn, 'and stays there across saves');

console.log('tasmoToSession.notes: ok');
