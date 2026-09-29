// Opening a project puts it in EDIT and in PERFORM. Saving it from PERFORM
// writes the project PERFORM holds, and nothing the grid does not show is lost:
// the track ids, each track's instrument and routing, each clip's trim, gain,
// fades, tempo and library entry, each insert's plugin state, where each clip
// sits (the arrangement, or a grid cell) and the scene names. PERFORM itself
// hosts each plugin at its saved state. A Save from EDIT afterwards writes the
// EDIT timeline, not the structure the PERFORM save left behind.
//
// The app's order, replayed: projectApi.load's JSON goes through
// loadProjectIntoEditor (EDIT, and PERFORM seeded from the same load);
// PERFORM's "Save as .tasmo" opens the save dialog seeded with
// dawProjectToTasmo; Save posts it; the file is opened again; then Ctrl+S
// (Shell) opens the dialog with no seed and Save posts again.
//
//   cd frontend && npx tsx src/lib/projectSave.perform.test.ts
import assert from 'node:assert/strict';
import { loadProjectIntoEditor } from './projectImport.ts';
import { dawProjectToTasmo, projectApi, type TasmoProjectInput, type TasmoProjectLoaded } from './projectClient.ts';
import { dawDeviceToChainEntry } from './dawEffectMap.ts';
import { placesApi } from './placesClient.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { useProjectStore } from '../state/projectStore.ts';
import { useDawImportStore } from '../state/dawImportStore.ts';
import { capturePerformRouting } from '../state/performRouting.ts';
import { outputOf, sendsFrom } from '../state/routingGraph.ts';

// A decoded buffer lasts one second per byte, so every source has a known length.
class FakeAudioContext {
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const SOURCES: Record<string, number> = { 'C:/set/lead.wav': 4, 'C:/set/hook.wav': 2, 'C:/set/bass.wav': 3 };
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
  const seconds = SOURCES[path];
  return seconds ? new Response(new Blob([new Uint8Array(seconds)], { type: 'audio/wav' }), { status: 200 }) : new Response('', { status: 404 });
}) as typeof fetch;
projectApi.recent = async () => [];
placesApi.recent = async () => [] as never;

const MANIFEST = { format: 'tasmo', format_version: 1, project_name: 'Set', audio_mode: 'linked', total_tracks: 2, sample_rate: 48000 };
const posted: Array<{ via: 'save' | 'save-session'; project: TasmoProjectInput }> = [];
projectApi.save = async (project) => {
  posted.push({ via: 'save', project });
  return { status: 'ok', path: 'Set.tasmo', manifest: MANIFEST };
};
projectApi.saveSession = async (project) => {
  posted.push({ via: 'save-session', project });
  return { status: 'ok', path: 'Set.tasmo', manifest: { ...MANIFEST, audio_mode: 'embedded' } };
};

const INSTRUMENT = {
  id: 'inst-lead',
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Surge XT.vst3', plugin_name: 'Surge XT', raw_state: 'SU5TVA==', state_host: 'thedaw' },
};

/** The project as projectApi.load returns it: the backend's full model dump. */
const opened = (): TasmoProjectLoaded => ({
  project_name: 'Set',
  tempo: 120,
  time_signature: [4, 4],
  tempo_map: [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }],
  meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  sample_rate: 48000,
  scenes: ['Intro', 'Drop'],
  buses: [
    { id: 'bus-a', name: 'Drums', volume: 0.9, mute: false, output_routing: null, effect_chain: [] },
    { id: 'bus-b', name: 'Verb', volume: 1, mute: false, output_routing: null, effect_chain: [] },
  ],
  tracks: [
    {
      id: 'trk-lead',
      name: 'Lead',
      type: 'audio',
      volume_db: -3,
      pan: 0.25,
      mute: false,
      solo: false,
      color: '#123456',
      output_routing: 'bus-a',
      send_amounts: { 'bus-b': 0.25 },
      instrument_program: 81,
      instrument: INSTRUMENT,
      effect_chain: [
        {
          id: 'fx-lead-eq',
          node_type: 'vst3',
          effect_name: 'Pro-Q 3',
          parameters: { 3: 0.5 },
          bypass: false,
          vst_state: { plugin_path: 'C:/VST3/Pro-Q 3.vst3', plugin_name: 'Pro-Q 3', parameters: { 3: 0.5 }, raw_state: 'U1RBVEU=', state_host: 'thedaw' },
        },
        { id: 'fx-lead-verb', node_type: 'builtin', effect_name: 'reverb', parameters: {}, bypass: true },
      ],
      clips: [
        {
          id: 'clip-verse',
          name: 'Verse',
          clip_type: 'audio',
          track_id: 'trk-lead',
          start_time: 2,
          end_time: 3,
          audio_file: 'C:/set/lead.wav',
          offset_into_source: 1.5,
          gain: 0.5,
          fade_in: 0.1,
          fade_out: 0.2,
          bpm: 124,
          library_entry_id: 'lib-9',
          source_bpm: 120,
          track_index: null,
          scene_index: null,
          slot_index: null,
        },
        {
          id: 'clip-hook',
          name: 'Hook',
          clip_type: 'audio',
          track_id: 'trk-lead',
          start_time: 0,
          end_time: 2,
          audio_file: 'C:/set/hook.wav',
          gain: 0.7,
          track_index: 0,
          scene_index: 1,
          slot_index: 1,
        },
      ],
    },
    {
      id: 'trk-bass',
      name: 'Bass',
      type: 'audio',
      volume_db: 0,
      pan: 0,
      clips: [
        {
          id: 'clip-bass',
          name: 'Bass',
          clip_type: 'audio',
          track_id: 'trk-bass',
          start_time: 0,
          end_time: 2,
          audio_file: 'C:/set/bass.wav',
          offset_into_source: 0.5,
          fade_out: 0.3,
        },
      ],
    },
  ],
});

const st = () => useEditorStore.getState();

// ── Open: EDIT and PERFORM both hold the project ─────────────────────────────
await loadProjectIntoEditor(opened());
const perform = useDawImportStore.getState().project;
assert.ok(perform, 'PERFORM was seeded from the same load');

// PERFORM hosts each insert at the state it was saved with.
{
  const eq = dawDeviceToChainEntry(perform.tracks[0].devices[0], 'perform-0-0');
  assert.equal(eq.effect, 'vst3');
  assert.deepEqual(
    eq.vst,
    { plugin_path: 'C:/VST3/Pro-Q 3.vst3', plugin_name: 'Pro-Q 3', raw_state: 'U1RBVEU=', state_host: 'thedaw' },
    'the PERFORM chain entry carries the saved plugin state and its host',
  );
  assert.equal(dawDeviceToChainEntry(perform.tracks[0].devices[1], 'perform-0-1').enabled, false, 'a bypassed insert stays off');
}

// ── Save from PERFORM ────────────────────────────────────────────────────────
useProjectStore.setState({ savePath: 'Set.tasmo' });
useProjectStore.getState().open('save', { ...dawProjectToTasmo(perform), perform_routing: capturePerformRouting() });
await useProjectStore.getState().save();
assert.equal(useProjectStore.getState().error, null, 'the PERFORM save went through');
assert.equal(posted.length, 1);
assert.equal(posted[0].via, 'save', 'PERFORM saves its own structure');
const performSave = posted[0].project;

{
  const [lead, bass] = performSave.tracks ?? [];
  assert.deepEqual([lead.id, bass.id], ['trk-lead', 'trk-bass'], 'the tracks keep their ids');
  assert.deepEqual(lead.instrument, INSTRUMENT, 'the track instrument is written with its state');
  assert.equal(lead.instrument_program, 81);
  assert.equal(lead.output_routing, 'bus-a', 'the track output is written');
  assert.deepEqual(lead.send_amounts, { 'bus-b': 0.25 }, 'and its sends');
  assert.equal(lead.effect_chain?.[0].id, 'fx-lead-eq', 'the insert keeps its id');
  assert.equal(lead.effect_chain?.[0].vst_state?.raw_state, 'U1RBVEU=', 'and its plugin state');
  assert.equal(lead.effect_chain?.[0].vst_state?.state_host, 'thedaw');
  assert.equal(lead.effect_chain?.[1].bypass, true);

  const verse = lead.clips?.find((c) => c.id === 'clip-verse');
  assert.ok(verse, 'the clip keeps its id');
  assert.equal(verse.offset_into_source, 1.5, 'its trim');
  assert.equal(verse.gain, 0.5, 'its gain');
  assert.equal(verse.fade_in, 0.1, 'its fades');
  assert.equal(verse.fade_out, 0.2);
  assert.equal(verse.bpm, 124, 'its tempo');
  assert.equal(verse.source_bpm, 120);
  assert.equal(verse.library_entry_id, 'lib-9', 'and its library entry');
  assert.equal(verse.scene_index ?? null, null, 'an arrangement clip stays on the arrangement');
  assert.equal(verse.slot_index ?? null, null);

  const hook = lead.clips?.find((c) => c.id === 'clip-hook');
  assert.deepEqual([hook?.track_index, hook?.scene_index, hook?.slot_index], [0, 1, 1], 'a grid clip keeps its cell');
  assert.equal(hook?.gain, 0.7);

  const bassClip = bass.clips?.[0];
  assert.equal(bassClip?.id, 'clip-bass');
  assert.equal(bassClip?.scene_index ?? null, null, 'the grid laying out an arrangement-only track is not a placement');
  assert.equal(bassClip?.offset_into_source, 0.5);
  assert.equal(bassClip?.fade_out, 0.3);

  assert.deepEqual(performSave.scenes, ['Intro', 'Drop'], 'the scene names are written');
  assert.deepEqual(performSave.tempo_map, [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }], 'and the tempo map');
  assert.deepEqual(performSave.buses?.map((b) => b.id), ['bus-a', 'bus-b']);
}

// The dialog's Tempo field still sets the tempo the saved set starts at: the
// tempo map the file carries starts at it too, and its later change is kept.
{
  useProjectStore.getState().open('save', { ...dawProjectToTasmo(perform), perform_routing: capturePerformRouting() });
  useProjectStore.getState().setTempo(100);
  await useProjectStore.getState().save();
  const retimed = posted.pop()?.project;
  assert.equal(retimed?.tempo, 100);
  assert.deepEqual(retimed?.tempo_map, [{ beat: 0, bpm: 100 }, { beat: 16, bpm: 90 }]);
  assert.equal(posted.length, 1);
}

// ── Open that file again: EDIT has everything back ───────────────────────────
await loadProjectIntoEditor(JSON.parse(JSON.stringify(performSave)) as TasmoProjectLoaded);
{
  const lead = st().tracks.find((t) => t.id === 'trk-lead');
  assert.equal(lead?.instrument?.vst?.raw_state, 'SU5TVA==', 'the instrument reopens with its state');
  assert.equal(lead?.fxChain?.[0].vst?.raw_state, 'U1RBVEU=', 'the insert reopens with its state');
  assert.equal(outputOf(st().routing, 'trk-lead'), 'bus-a', 'the track still feeds its bus');
  assert.deepEqual(sendsFrom(st().routing, 'trk-lead').map((e) => [e.to, e.gain]), [['bus-b', 0.25]]);
  const clips = new Map(st().clips.map((c) => [c.id, c]));
  assert.deepEqual([...clips.keys()].sort(), ['clip-bass', 'clip-verse'], 'EDIT holds the arrangement clips and not the grid clip');
  const verse = clips.get('clip-verse');
  assert.equal(verse?.offsetIntoSource, 1.5);
  assert.equal(verse?.gain, 0.5);
  assert.equal(verse?.fadeInSec, 0.1);
  assert.equal(verse?.fadeOutSec, 0.2);
  assert.equal(verse?.bpm, 124);
  assert.equal(verse?.libraryEntryId, 'lib-9');
  assert.equal(clips.get('clip-bass')?.offsetIntoSource, 0.5);
  assert.equal(st().tempoMap.length, 2, 'the tempo change is back');
}

// ── Then Ctrl+S from EDIT ────────────────────────────────────────────────────
{
  const lead = st().tracks.find((t) => t.id === 'trk-lead');
  assert.ok(lead);
  useEditorStore.setState({
    tracks: st().tracks.map((t) => (t.id === 'trk-lead' ? { ...t, name: 'Lead (edit)' } : t)),
  });
  // Shell's Ctrl+S handler and the App menu's Save both call open('save').
  useProjectStore.getState().open('save');
  assert.deepEqual(useProjectStore.getState().pendingTracks, [], 'an unseeded Save lets go of the PERFORM structure');
  await useProjectStore.getState().save();
  assert.equal(useProjectStore.getState().error, null, 'the EDIT save went through');
  assert.equal(posted.length, 2);
  assert.equal(posted[1].via, 'save-session', 'EDIT saves its timeline');
  assert.equal(
    posted[1].project.tracks?.find((t) => t.id === 'trk-lead')?.name,
    'Lead (edit)',
    'with the edit made in EDIT',
  );
}

console.log('projectSave.perform: ok');
