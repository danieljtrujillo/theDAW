/**
 * Every MIDI cell on the PERFORM grid renders with its own column's voice.
 *
 * The sequence: a project built in EDIT with a bass track, a lead track picked
 * from a bank, and a drum track is saved as .tasmo and opened in PERFORM
 * (lib/tasmoToSession). The grid renders each MIDI cell to audio before it can
 * launch it; that render goes through lib/sessionCellSpan `sessionMidiRender`
 * and then the soundfont's SMF (lib/soundfontEngine notesRenderSmf), read back
 * here with lib/midi parseMidi. The global instrument picker is on a piano, so
 * a cell that sounded the picker would show program 0.
 *
 * Before, the grid rendered every MIDI cell through the picker's one voice: the
 * file's track programs never reached the grid, and the grid's render options
 * named no program, no bank and no drum channel.
 *
 *   cd frontend && npx tsx src/lib/sessionCellVoice.test.ts
 */
import assert from 'node:assert/strict';

import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import { dawProjectToTasmo, type TasmoLoadedTrack, type TasmoProjectLoaded } from './projectClient.ts';
import { performTracks } from './performModel.ts';
import { sessionMidiRender } from './sessionCellSpan.ts';
import { notesRenderSmf } from './soundfontEngine.ts';
import { parseMidi } from './midi.ts';
import { DRUM_CHANNEL } from './editChannels.ts';
import type { GlobalVoice } from './clipProgram.ts';
import type { DawProject, DawTrack } from './dawImportClient.ts';
import type { RenderNote } from './midiSynth.ts';

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
      midi_notes: [
        { note: 40, step: 0, length: 4, velocity: 100 },
        { note: 43, step: 8, length: 4, velocity: 90 },
      ],
      scene_index: 0,
      slot_index: 0,
    },
  ],
  ...over,
});

const saved: TasmoProjectLoaded = {
  project_name: 'Three Columns',
  tempo: 120,
  time_signature: [4, 4],
  sample_rate: 44100,
  scenes: ['A'],
  tracks: [
    midiTrack('Bass', { instrument_program: 33 }),
    midiTrack('Lead', { instrument_program: 81, instrument_bank: 8 }),
    midiTrack('Drums', { instrument_program: 25, is_percussion: true }),
  ],
};

/** What the grid's render of one column's cell sends to the synth: the program
 *  change each channel gets (with its bank select) and the channels its notes play on. */
function rendered(track: DawTrack) {
  const clip = track.clips[0];
  const notes: RenderNote[] = (clip.midi_notes as Array<Record<string, number>>).map((n) => ({
    midi: n.pitch,
    startSec: n.start,
    durationSec: n.duration,
    velocity: n.velocity,
  }));
  const request = sessionMidiRender(clip, track, notes, PICKER_PIANO);
  const smf = parseMidi(notesRenderSmf(request.notes, request.options));
  const programs = smf.tracks.flatMap((t) => t.programs ?? []).map((p) => ({ channel: p.channel, program: p.program, bank: p.bank ?? 0 }));
  const channels = [...new Set(smf.tracks.flatMap((t) => t.notes.map((n) => n.channel)))];
  return { programs, channels, minDurationSec: request.options.minDurationSec };
}

function checkGrid(project: DawProject, label: string) {
  const [bass, lead, drums] = performTracks(project);
  assert.ok(bass && lead && drums, `${label}: three columns`);

  const b = rendered(bass);
  assert.deepEqual(b.programs, [{ channel: 0, program: 33, bank: 0 }], `${label}: the bass column renders on its own program`);
  assert.deepEqual(b.channels, [0]);
  assert.equal(b.minDurationSec, 2, `${label}: the cell still renders to the end of its window`);

  const l = rendered(lead);
  assert.deepEqual(l.programs, [{ channel: 0, program: 81, bank: 8 }], `${label}: the lead column renders on its program in its bank`);

  const d = rendered(drums);
  assert.deepEqual(d.channels, [DRUM_CHANNEL], `${label}: the drum column plays on the drum channel`);
  assert.equal(d.programs.find((p) => p.channel === DRUM_CHANNEL)?.program, 25, `${label}: with its own kit`);
}

// ── open the saved file in PERFORM ────────────────────────────────────────────
const opened = tasmoLoadedToDawProject(saved);
checkGrid(opened, 'open');

// ── a clip's own program wins over its column's ───────────────────────────────
{
  const project = tasmoLoadedToDawProject({
    ...saved,
    tracks: [
      midiTrack('Bass', {
        instrument_program: 33,
        clips: [{ ...midiTrack('x', {}).clips[0], instrument_program: 38, instrument_bank: 2 }],
      }),
    ],
  });
  const r = rendered(performTracks(project)[0]);
  assert.deepEqual(r.programs, [{ channel: 0, program: 38, bank: 2 }], 'the clip program and its bank');
}

// ── a column with no program of its own follows the picker ────────────────────
{
  const project = tasmoLoadedToDawProject({ ...saved, tracks: [midiTrack('Keys', {})] });
  const r = rendered(performTracks(project)[0]);
  assert.deepEqual(r.programs, [{ channel: 0, program: 0, bank: 0 }], 'the picker program');
}

// ── save from PERFORM, open again: the voices survive the round trip ──────────
{
  const out = dawProjectToTasmo(opened);
  const reopened = tasmoLoadedToDawProject({
    project_name: out.project_name,
    tempo: out.tempo,
    time_signature: out.time_signature,
    sample_rate: out.sample_rate,
    scenes: out.scenes,
    tracks: (out.tracks ?? []).map<TasmoLoadedTrack>((t) => ({
      ...t,
      clips: (t.clips ?? []).map((c) => ({ ...c, audio_file: c.audio_file ?? null, midi_notes: c.midi_notes as Array<Record<string, number>> | null })),
    })),
  });
  checkGrid(reopened, 'save then open');
}

console.log('sessionCellVoice: ok');
