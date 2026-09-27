// A piano-roll clip's tempo map survives a .tasmo save and open, and a file
// written before clips had one opens at one tempo, as it always did.
//
// Each block replays the app's own order: the roll is bounced to EDIT
// (lib/rollBounce), captureEditorSession builds the payload,
// projectApi.saveSession posts it, the JSON comes back from the backend,
// loadProjectIntoEditor opens it, and "Edit in Piano Roll" (clipRollLoad)
// puts the map back in the roll. PERFORM's reading of the same save
// (tasmoLoadedToDawProject) times the notes through the map too.
// Run from `frontend/`:
//   npx tsx src/lib/projectImport.tempo.test.ts
import assert from 'node:assert/strict';
import { captureEditorSession, loadProjectIntoEditor } from './projectImport.ts';
import { clipMeterToTasmo, projectApi, tasmoMeterToClip, type TasmoProjectInput, type TasmoProjectLoaded } from './projectClient.ts';
import { clipRollLoad } from './rollClip.ts';
import { bounceRollToEditor } from './rollBounce.ts';
import { stepClock } from './rollTempo.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { TempoEvent } from './tempoMap.ts';

// computePeaks needs an AudioContext. The fake decodes any blob to one second.
class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b}`);
const shape = (map: readonly TempoEvent[] = []) =>
  map.map((e) => (e.fermata ? `f${e.beat}:${e.fermata.beats}x${e.fermata.stretch}` : `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`)).join(' ');

async function saveThroughTheWire(): Promise<{ project: TasmoProjectLoaded; files: Array<{ name: string; blob: Blob }> }> {
  const session = captureEditorSession();
  const input: TasmoProjectInput = { project_name: 'Symphony', tempo: session.bpm, tracks: session.tracks, buses: session.buses };
  let posted: FormData | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    posted = init?.body as FormData;
    return new Response(JSON.stringify({ status: 'saved', path: 'S.tasmo', manifest: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await projectApi.saveSession(input, 'S.tasmo', session.files);
  } finally {
    globalThis.fetch = realFetch;
  }
  const part = (posted as FormData | null)?.get('project');
  assert.ok(part instanceof Blob);
  return { project: JSON.parse(await (part as Blob).text()) as TasmoProjectLoaded, files: session.files };
}

async function openWithFiles(project: TasmoProjectLoaded, files: Array<{ name: string; blob: Blob }>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const file = files.find((f) => path.endsWith(f.name));
    return file ? new Response(file.blob, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    await loadProjectIntoEditor(project);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const MAP: TempoEvent[] = [
  { beat: 0, bpm: 50 },
  { beat: 4, bpm: 126 },
  { beat: 8, bpm: 126, curve: 'linear' },
  { beat: 12, bpm: 63 },
  { beat: 14, bpm: 63, fermata: { beats: 2, stretch: 2 } },
];

async function main(): Promise<void> {
  // ── The roll's map rides the clip into the file and back ──────────────────
  ed().loadProject({ tracks: [], clips: [] });
  roll().clear();
  roll().setEditingClip(null);
  const notes: PianoNote[] = [];
  for (let s = 0; s < 64; s += 4) notes.push({ id: `n${s}`, note: 60, step: s, length: 3, velocity: 100 });
  roll().importNotes(notes, 50, undefined, [], MAP);
  usePianoRollStore.setState({ totalSteps: 64 });
  const done = await bounceRollToEditor({
    render: (_n, _bpm, _total, _opts) => Promise.resolve({ blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), duration: 30 }),
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
    global: () => ({ useSoundfont: true, activeProgram: 48 }),
  });
  assert.ok(done);

  const { project, files } = await saveThroughTheWire();
  const trackIndex = project.tracks.findIndex((t) => t.clips.some((c) => c.id === done.clipId));
  const saved = project.tracks[trackIndex].clips[0];
  assert.deepEqual(saved.tempo_map, [
    { beat: 0, bpm: 50 },
    { beat: 4, bpm: 126 },
    { beat: 8, bpm: 126, curve: 'linear' },
    { beat: 12, bpm: 63 },
    { beat: 14, bpm: 63, fermata: { beats: 2, stretch: 2 } },
  ], 'the file holds the map: a curve only on the ramp, the fermata as a hold');
  assert.equal(saved.source_bpm, 50);

  // Reopen over a different session.
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(project, files);
  const reopened = ed().clips.find((c) => c.id === done.clipId);
  assert.ok(reopened, 'the clip is back');
  assert.equal(shape(reopened.sourceTempoMap), shape(MAP), 'with its tempo map');
  // Edit in Piano Roll: the roll gets the map back, and the header its start.
  roll().setTempoMap([{ beat: 0, bpm: 140 }]);
  roll().loadFromClip(...clipRollLoad(reopened));
  assert.equal(shape(roll().tempoMap), shape(MAP));
  assert.equal(roll().bpm, 50);

  // PERFORM opens the same save and times the notes through the map.
  const session = tasmoLoadedToDawProject(project);
  const cell = session.tracks[trackIndex].clips[0];
  const clock = stepClock(50, MAP);
  // A session cell's notes are seconds-shaped ({pitch, start, duration, velocity}), typed loosely by the importer.
  ((cell.midi_notes ?? []) as Array<{ start: number; duration: number }>).forEach((n, i) => {
    near(n.start, clock.at(notes[i].step), 1e-9, `PERFORM note ${i}`);
    near(n.duration, clock.at(notes[i].step + 3) - clock.at(notes[i].step), 1e-9);
  });

  // ── A file written before clips had a map opens at one tempo ──────────────
  const older = JSON.parse(JSON.stringify(project)) as TasmoProjectLoaded;
  delete older.tracks[trackIndex].clips[0].tempo_map;
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(older, files);
  const plain = ed().clips.find((c) => c.id === done.clipId);
  assert.ok(plain);
  assert.equal(plain.sourceTempoMap, undefined, 'no map');
  roll().loadFromClip(...clipRollLoad(plain));
  assert.equal(shape(roll().tempoMap), '0:50', 'the roll opens at the clip\'s one tempo');

  // ── The project tempo of a slow introduction survives a save and open ─────
  // EDIT's BPM at 24.25 goes into the file as the project tempo and comes back
  // at 24.25. Up to cb4f3e20 EDIT held its tempo to 40-240, so it reopened at 40.
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(project, files);
  ed().setBpm(24.25);
  const slow = await saveThroughTheWire();
  assert.equal(slow.project.tempo, 24.25, 'the file holds the project tempo with its fraction');
  ed().loadProject({ tracks: [], clips: [], bpm: 120 });
  await openWithFiles(slow.project, slow.files);
  assert.equal(ed().bpm, 24.25, 'and the song reopens at it');

  // ── The file shape, both ways, and what a damaged one does ────────────────
  assert.deepEqual(clipMeterToTasmo({ sourceTempoMap: [{ beat: 0, bpm: 90 }] }), {}, 'a clip at one tempo writes no map');
  const read = tasmoMeterToClip({
    tempo_map: [
      { beat: 0, bpm: 90 },
      { beat: 4, bpm: 999 },
      { beat: Number.NaN, bpm: 90 } as unknown as { beat: number; bpm: number },
      { beat: 6, bpm: 90, fermata: { beats: -1, stretch: 2 } },
    ],
  });
  assert.equal(shape(read.sourceTempoMap), '0:90 4:300', 'junk dropped, tempi held to 20-300');
  assert.equal(tasmoMeterToClip({ tempo_map: [{ beat: 0, bpm: 90 }] }).sourceTempoMap, undefined);
  assert.equal(tasmoMeterToClip({ tempo_map: null }).sourceTempoMap, undefined);

  console.log('projectImport.tempo: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
