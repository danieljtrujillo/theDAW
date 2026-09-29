// A .tasmo opened in PERFORM by itself, from its own path field, while EDIT
// holds another project, and saved from PERFORM: the file keeps its own buses,
// markers, loop, master chains, automation, controller mappings, roll voice and
// tuning, and each track still reaches its bus on reopen. The document of the
// project EDIT holds is not written into it.
//
// And a project EDIT does hold (opened in EDIT, which seeds PERFORM from the
// same load) saves from PERFORM with EDIT's document, so an edit made in EDIT
// since the open reaches the file.
//
// The app's order, replayed: loadProjectIntoEditor opens a project in EDIT;
// SessionView's path field opens another through
// useDawImportStore.loadTasmoAsSession; its "Save as .tasmo" opens the save
// dialog seeded with dawProjectToTasmo and the PERFORM routing; Save posts it;
// the file is opened again.
//
//   cd frontend && npx tsx src/lib/projectSave.performAlone.test.ts
import assert from 'node:assert/strict';
import { loadProjectIntoEditor } from './projectImport.ts';
import { dawProjectToTasmo, projectApi, type TasmoProjectInput, type TasmoProjectLoaded } from './projectClient.ts';
import { placesApi } from './placesClient.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { useProjectStore } from '../state/projectStore.ts';
import { useDawImportStore } from '../state/dawImportStore.ts';
import { capturePerformRouting } from '../state/performRouting.ts';
import { outputOf } from '../state/routingGraph.ts';

class FakeAudioContext {
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const SOURCES: Record<string, number> = { 'C:/set/loop.wav': 4, 'C:/other/pad.wav': 4 };
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
  const seconds = SOURCES[path];
  return seconds ? new Response(new Blob([new Uint8Array(seconds)], { type: 'audio/wav' }), { status: 200 }) : new Response('', { status: 404 });
}) as typeof fetch;
projectApi.recent = async () => [];
placesApi.recent = async () => [] as never;

const MANIFEST = { format: 'tasmo', format_version: 1, project_name: 'Set', audio_mode: 'linked', total_tracks: 1, sample_rate: 48000 };
const posted: TasmoProjectInput[] = [];
projectApi.save = async (project) => {
  posted.push(project);
  return { status: 'ok', path: 'Set.tasmo', manifest: MANIFEST };
};

/** The set PERFORM opens, as projectApi.load returns it. */
const SET: TasmoProjectLoaded = {
  project_name: 'Set',
  tempo: 120,
  time_signature: [4, 4],
  sample_rate: 48000,
  scenes: ['A'],
  buses: [{ id: 'bus-set', name: 'Set Bus', volume: 0.7, mute: false, output_routing: null, send_amounts: {}, effect_chain: [] }],
  locators: [{ id: 'loc-set', name: 'Drop', position: 8, color: null }],
  loop: { enabled: true, start_sec: 2, end_sec: 6 },
  master_fx_chain: [{ id: 'mfx-set', effect: 'compressor', params: { threshold: -12 }, enabled: true }],
  master_vst_chain: [],
  automation_lanes: [
    { id: 'lane-set', target: { kind: 'trackVolume', track_id: 'trk-set' }, points: [{ t: 0, v: 0.5 }, { t: 4, v: 0.9 }], enabled: true },
  ],
  roll_voice: { program: 33 },
  tracks: [
    {
      id: 'trk-set',
      name: 'Loop',
      type: 'audio',
      volume_db: 0,
      pan: 0,
      output_routing: 'bus-set',
      send_amounts: {},
      effect_chain: [],
      clips: [
        { id: 'clip-set', name: 'Loop', clip_type: 'audio', track_id: 'trk-set', start_time: 0, end_time: 4, audio_file: 'C:/set/loop.wav' },
      ],
    },
  ],
} as TasmoProjectLoaded;

/** The project EDIT holds: another bus, marker, loop and master chain. */
const OTHER: TasmoProjectLoaded = {
  project_name: 'Other',
  tempo: 100,
  time_signature: [4, 4],
  sample_rate: 48000,
  buses: [{ id: 'bus-other', name: 'Other Bus', volume: 1, mute: false, output_routing: null, send_amounts: {}, effect_chain: [] }],
  locators: [{ id: 'loc-other', name: 'Verse', position: 1, color: null }],
  loop: { enabled: false, start_sec: 0, end_sec: 1 },
  master_fx_chain: [{ id: 'mfx-other', effect: 'reverb', params: {}, enabled: true }],
  master_vst_chain: [],
  automation_lanes: [],
  roll_voice: { program: 0 },
  tracks: [
    {
      id: 'trk-other',
      name: 'Pad',
      type: 'audio',
      volume_db: 0,
      pan: 0,
      output_routing: 'bus-other',
      effect_chain: [],
      clips: [
        { id: 'clip-other', name: 'Pad', clip_type: 'audio', track_id: 'trk-other', start_time: 0, end_time: 4, audio_file: 'C:/other/pad.wav' },
      ],
    },
  ],
} as TasmoProjectLoaded;

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const st = () => useEditorStore.getState();

/** SessionView's "Save as .tasmo", then the dialog's Save. */
async function saveFromPerform(): Promise<TasmoProjectInput> {
  const perform = useDawImportStore.getState().project;
  assert.ok(perform, 'PERFORM holds a project');
  useProjectStore.setState({ savePath: 'Set.tasmo' });
  useProjectStore.getState().open('save', { ...dawProjectToTasmo(perform), perform_routing: capturePerformRouting() });
  await useProjectStore.getState().save();
  assert.equal(useProjectStore.getState().error, null, 'the PERFORM save went through');
  const sent = posted.pop();
  assert.ok(sent);
  return sent;
}

// ── EDIT holds another project; PERFORM opens the set from its own path ─────
await loadProjectIntoEditor(copy(OTHER));
projectApi.load = async () => ({ project: copy(SET), manifest: MANIFEST });
await useDawImportStore.getState().loadTasmoAsSession('C:/set/Set.tasmo');
assert.equal(useDawImportStore.getState().project?.name, 'Set');
assert.deepEqual(st().tracks.map((t) => t.id), ['trk-other'], 'EDIT still holds the other project');

{
  const saved = await saveFromPerform();
  assert.deepEqual(saved.buses?.map((b) => b.id), ['bus-set'], 'the set is written with its own bus');
  assert.deepEqual(saved.locators, SET.locators, 'its own markers');
  assert.deepEqual(saved.loop, SET.loop, 'its own loop');
  assert.deepEqual(saved.master_fx_chain, SET.master_fx_chain, 'its own master chain');
  assert.deepEqual(saved.master_vst_chain, []);
  assert.deepEqual(saved.automation_lanes, SET.automation_lanes, 'its own automation');
  assert.deepEqual(saved.roll_voice, { program: 33 }, 'and its own roll voice');
  assert.equal(saved.tracks?.[0].output_routing, 'bus-set');

  // Reopened, the track reaches its bus and the set's document is back.
  await loadProjectIntoEditor(copy(saved) as TasmoProjectLoaded);
  assert.equal(outputOf(st().routing, 'trk-set'), 'bus-set', 'the track still feeds its bus');
  assert.deepEqual(st().buses.map((b) => b.name), ['Set Bus']);
  assert.deepEqual(st().masterFxChain.map((e) => e.id), ['mfx-set']);
  assert.deepEqual(st().markers.map((m) => m.label), ['Drop']);
  assert.deepEqual([st().loopEnabled, st().loopStart, st().loopEnd], [true, 2, 6]);
  assert.deepEqual(st().automationLanes.map((l) => l.id), ['lane-set']);
}

// ── EDIT holds the set: an edit made in EDIT since the open is saved ────────
{
  // Opening in EDIT seeds PERFORM from the same load.
  await loadProjectIntoEditor(copy(SET));
  st().updateBus('bus-set', { name: 'Set Bus (edit)' });
  const saved = await saveFromPerform();
  assert.deepEqual(saved.buses?.map((b) => b.name), ['Set Bus (edit)'], 'the bus as EDIT holds it');
  assert.deepEqual(saved.master_fx_chain?.map((e) => e.id), ['mfx-set']);
}

// ── A save from PERFORM leaves EDIT's unsaved work marked unsaved ───────────
// The file holds PERFORM's tracks, not EDIT's timeline, so New Project and
// closing the app must still ask before EDIT's changes are thrown away. Only a
// save of the EDIT timeline clears that.
{
  let sessions = 0;
  projectApi.saveSession = async () => {
    sessions += 1;
    return { status: 'ok', path: 'Other.tasmo', manifest: { ...MANIFEST, audio_mode: 'embedded' } };
  };
  await loadProjectIntoEditor(copy(OTHER));
  assert.equal(st().dirty, false, 'a project just opened has nothing to save');
  useEditorStore.setState({ tracks: st().tracks.map((t) => ({ ...t, name: 'Pad (unsaved)' })) });
  assert.equal(st().dirty, true, 'the rename is unsaved');

  projectApi.load = async () => ({ project: copy(SET), manifest: MANIFEST });
  await useDawImportStore.getState().loadTasmoAsSession('C:/set/Set.tasmo');
  await saveFromPerform();
  assert.equal(st().dirty, true, 'saving the PERFORM set does not save the EDIT timeline');

  // Loaded in EDIT and edited there: the PERFORM save writes PERFORM's tracks,
  // so the EDIT rename is still unsaved after it.
  await loadProjectIntoEditor(copy(SET));
  useEditorStore.setState({ tracks: st().tracks.map((t) => ({ ...t, name: 'Loop (unsaved)' })) });
  await saveFromPerform();
  assert.equal(st().dirty, true, 'nor does it save an EDIT edit to the same project');

  // Ctrl+S from EDIT saves the timeline, and with it the unsaved work.
  useProjectStore.getState().open('save');
  await useProjectStore.getState().save();
  assert.equal(useProjectStore.getState().error, null);
  assert.equal(sessions, 1, 'EDIT saved its timeline');
  assert.equal(st().dirty, false, 'which leaves nothing unsaved');
}

console.log('projectSave.performAlone: ok');
