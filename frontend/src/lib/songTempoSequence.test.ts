// The sequence a user runs, against the real editor store: send a separated
// stem of a library song to EDIT from the library's stems list, SYNC it to the
// project tempo, then "Use song tempo" on it. The stem carries its song's
// library entry and tempo, SYNC stretches it and keeps its place in the song's
// time, and after Use song tempo every downbeat of the song inside the clip
// has an EDIT bar line within 2 ms. One undo takes the tempo and meter back;
// SAVE and open keep the stem's place in the song and the maps.
//
// The song, its analysis and its stems are the running app's
// (lib/__fixtures__/rhythm-owl-grinned.json). The network and the audio
// decoder are stubbed at fetch and AudioContext; the stretch render returns
// audio of the stretched length, as the backend's time_pitch does.
//
//   cd frontend && npx tsx src/lib/songTempoSequence.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useEditorStore, clipStretchRate, type AudioClip } from '../state/editorStore.ts';
import { useProjectStore } from '../state/projectStore.ts';
import { sendAudioToEditor, stemRowToSendable } from './sendToTargets.ts';
import { fillSongTempo, songTempoPlanFor } from './songTimeLink.ts';
import { clipKnownBpm, runBeatMatch, type TimePitchRenderer } from './beatMatchRun.ts';
import { songSecToAudioSec } from './clipSongTime.ts';
import { editBarAtSec, editMeterLabel } from './editTimeMap.ts';
import { meterAtBar } from './meterMap.ts';
import { songDownbeats, songMeters, type RhythmAnalysis } from './rhythmSeed.ts';
import { loadProjectIntoEditor } from './projectImport.ts';
import type { TasmoProjectLoaded } from './projectClient.ts';
import type { SongTempoPlan } from './songTempo.ts';

interface Fixture {
  rhythm: RhythmAnalysis & { entry_id: string; duration_sec: number };
  analysis: { entry_id: string; bpm: number; beats: number[]; key: string; scale: string };
  stems: Array<{ id: string; entry_id: string; stem_name: string; role: string }>;
}
const fx = JSON.parse(readFileSync(new URL('./__fixtures__/rhythm-owl-grinned.json', import.meta.url), 'utf8')) as Fixture;
const SONG = fx.rhythm.entry_id;
const SONG_SEC = fx.rhythm.duration_sec;

// Audio whose byte length is its duration in milliseconds, so the stubbed
// decoder reads back the length the audio has.
const audioOf = (sec: number): Blob => new Blob([new Uint8Array(Math.round(sec * 1000))], { type: 'audio/wav' });
class FakeAudioContext {
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength / 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(256).fill(0.25) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

// The backend as the app reads it: the stem's audio, the library analysis row.
const requests: string[] = [];
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const u = String(url);
  requests.push(u);
  if (u.includes('/api/library/stems/') && u.endsWith('/audio')) return new Response(audioOf(SONG_SEC), { status: 200 });
  if (u.endsWith(`/api/analysis/${SONG}`)) {
    return new Response(JSON.stringify({ entry_id: SONG, bpm: fx.analysis.bpm, beats_json: JSON.stringify(fx.analysis.beats), key: fx.analysis.key, scale: fx.analysis.scale }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
}) as typeof fetch;

const ed = () => useEditorStore.getState();
const clipById = (id: string): AudioClip => {
  const c = ed().clips.find((x) => x.id === id);
  assert.ok(c, `clip ${id} is on the timeline`);
  return c;
};
const meters = songMeters(fx.rhythm);
assert.ok(meters);
const downs = songDownbeats(fx.rhythm, meters.songMap);

/** Every song downbeat sounding inside the clip has an EDIT bar line within 2 ms, one bar per song bar, in the song bar's meter. */
function assertBarsOnDownbeats(clip: AudioClip, label: string): number {
  const st = clip.songTime!;
  const play = clipStretchRate(clip);
  const maps = { tempoMap: ed().tempoMap, meterMap: ed().meterMap };
  let prev: number | null = null;
  let checked = 0;
  for (const d of downs) {
    // Where the downbeat sounds, from the clip's own fields.
    const t = clip.startSec + (songSecToAudioSec(st, d.sec) - clip.offsetIntoSource) / play;
    if (t < clip.startSec - 1e-6 || t > clip.startSec + clip.durationSec) continue;
    const bar = editBarAtSec(maps, t + 0.002);
    const err = Math.abs(bar.startSec - t);
    assert.ok(err <= 0.002, `${label}: song bar ${d.bar} at ${t.toFixed(4)} s is ${(err * 1000).toFixed(3)} ms from its bar line`);
    if (prev !== null) assert.equal(bar.bar, prev + 1, `${label}: song bar ${d.bar} is the next EDIT bar`);
    assert.equal(editMeterLabel(bar.meter), editMeterLabel(meterAtBar(meters!.songMap, d.bar)), `${label}: song bar ${d.bar}'s meter`);
    prev = bar.bar;
    checked += 1;
  }
  return checked;
}

// 1. A fresh project at 120 in 4/4, and the drums stem sent to EDIT from the
//    library's stems list ("Send to editor (new track)").
ed().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
const drums = fx.stems.find((s) => s.stem_name === 'drums');
assert.ok(drums);
const clipId = await sendAudioToEditor(stemRowToSendable({ ...drums, parent_title: 'The Owl Grinned' }), 'editor-new-track');
assert.ok(clipId, 'the stem landed');
{
  const clip = clipById(clipId);
  assert.ok(clip.songTime, 'the stem is tied to its song');
  assert.equal(clip.songTime.entryId, SONG, 'the song it was separated from');
  assert.deepEqual([clip.songTime.offsetSec, clip.songTime.rate], [0, 1]);
}

// 2. The song's tempo arrives from the library analysis and lands on the clip.
await fillSongTempo(SONG);
{
  const clip = clipById(clipId);
  assert.equal(clip.songTime?.bpm, fx.analysis.bpm, "the song's analysed tempo is on the clip");
  assert.equal(clipKnownBpm(clip), fx.analysis.bpm, 'SYNC knows the stem\'s tempo');
}

// 3. SYNC to the project tempo: the stem is stretched 120 / 103.36 and moved so
//    its first beat is on the grid; it keeps its place in the song's time.
const render: TimePitchRenderer = async (clip, tempo) => {
  const duration = clip.durationSec / tempo;
  return { blob: audioOf(duration), duration, peaks: new Float32Array(240) };
};
const outcome = await runBeatMatch([clipId], ed().bpm, true, render);
assert.equal(outcome.stretched, 1, 'the stem was stretched');
assert.equal(outcome.unknown, 0);
{
  const clip = clipById(clipId);
  assert.ok(Math.abs(clip.songTime!.rate - 120 / fx.analysis.bpm) < 1e-12, 'the tie follows the stretch');
  assert.equal(clip.songTime!.offsetSec, 0);
  assert.ok(Math.abs((clipKnownBpm(clip) ?? 0) - 120) < 1e-9, 'it now plays at 120');
  assert.ok(Math.abs(clip.durationSec - SONG_SEC * fx.analysis.bpm / 120) < 1e-6);
}

// 4. Use song tempo on the clip, as its context menu asks for it.
const tempoBefore = ed().tempoMap;
const meterBefore = ed().meterMap;
ed().requestSongTempo({ entryId: SONG, clipId });
const req = ed().songTempoRequest;
assert.deepEqual(req, { entryId: SONG, clipId });
const { clip: lined, plan } = songTempoPlanFor(req!, ed().clips, { tempoMap: ed().tempoMap, meterMap: ed().meterMap }, fx.rhythm);
assert.equal(lined?.id, clipId, 'lined up with the clip it was asked on');
assert.ok(plan.ok, plan.ok ? '' : plan.error);
const p = plan as SongTempoPlan;
// What the preview shows.
const clipNow = clipById(clipId);
const firstT = clipNow.startSec + songSecToAudioSec(clipNow.songTime!, 1.5557) / clipStretchRate(clipNow);
assert.ok(Math.abs(p.firstDownbeatSec - firstT) < 1e-9, 'the first downbeat is where the stretched clip plays it');
assert.ok(p.tempoChanges > 0 && p.perBar);
const undoDepth = ed()._undo.length;
assert.equal(ed().setTimeMaps(p.tempoMap, p.meterMap), true);
ed().dismissSongTempoRequest();
assert.equal(ed()._undo.length, undoDepth + 1, 'tempo and meter are one undo step');
const lanedBars = assertBarsOnDownbeats(clipById(clipId), 'after Use song tempo');
assert.ok(lanedBars > 200, `the whole song is barred (${lanedBars} downbeats)`);

// 5. One undo takes both maps back and leaves the SYNC in place; redo restores them.
const syncedStart = clipById(clipId).startSec;
ed().undo();
assert.equal(ed().tempoMap, tempoBefore, 'the tempo map is back');
assert.equal(ed().meterMap, meterBefore, 'the meter map is back');
assert.equal(clipById(clipId).startSec, syncedStart, 'the SYNC stays');
ed().redo();
assertBarsOnDownbeats(clipById(clipId), 'after redo');

// 6. SAVE and open: the stem keeps its song, its stretch in the song's time,
//    and the arrangement keeps the song's bars.
{
  useProjectStore.setState({ projectName: 'Song tempo', savePath: 'S.tasmo', pendingTracks: [] });
  let posted: FormData | null = null;
  const net = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/api/project/save-session')) {
      posted = init?.body as FormData;
      return new Response(JSON.stringify({ status: 'saved', path: 'S.tasmo', manifest: { audio_mode: 'embedded' } }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  await useProjectStore.getState().save();
  assert.equal(useProjectStore.getState().error, null, 'the save went through');
  const form = posted as FormData | null;
  assert.ok(form);
  const project = JSON.parse(await (form.get('project') as Blob).text()) as TasmoProjectLoaded;
  const files = form.getAll('files') as File[];
  const saved = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  assert.ok(saved?.song_time, 'the file holds the song tie');
  assert.equal(saved.song_time.entry_id, SONG);
  const mapsSaved = { tempoMap: ed().tempoMap, meterMap: ed().meterMap };

  ed().loadProject({ tracks: [], clips: [], bpm: 90 });
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const file = files.find((f) => path.endsWith(f.name));
    return file ? new Response(file, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    await loadProjectIntoEditor(project);
  } finally {
    globalThis.fetch = net;
  }
  const back = clipById(clipId);
  assert.equal(back.songTime?.entryId, SONG);
  assert.equal(back.songTime?.bpm, fx.analysis.bpm);
  assert.ok(Math.abs((back.songTime?.rate ?? 0) - 120 / fx.analysis.bpm) < 1e-12);
  assert.deepEqual(ed().tempoMap.map((e) => [e.beat, e.bpm]), mapsSaved.tempoMap.map((e) => [e.beat, e.bpm]), 'the tempo map reopened');
  assertBarsOnDownbeats(back, 'after SAVE and open');
}

// 7. New audio that is not the song's time drops the tie (a reverse, a bounce).
ed().updateClip(clipId, { audioBlob: audioOf(10) });
assert.equal(clipById(clipId).songTime, undefined, 'reversed or re-rendered audio no longer claims the song');

console.log('songTempoSequence: ok');
