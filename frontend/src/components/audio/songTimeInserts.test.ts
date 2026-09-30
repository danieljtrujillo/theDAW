// Every way a library song or a stem of it enters EDIT ties the clip to the
// song's analysis (AudioClip.songTime), so SYNC and "Use song tempo" read the
// song's tempo, beats and downbeats for it. Each block runs the real path the
// app runs, against the real editor store, with the network and the audio
// decoder stubbed:
//
//   - the library menu's "Own lane in EDIT" (runTrackMenuRow edit-new-track)
//   - the library menu's "Stems as EDIT tracks" (edit-stems)
//   - a stem key in the library menu, "Send to EDIT" (stem:edit:<id>)
//   - EDIT's "All stems" beside a library clip (applyAllStemsInsert)
//   - the library menu's "Song tempo in EDIT" (edit-song-tempo)
//
//   cd frontend && npx tsx src/components/audio/songTimeInserts.test.ts
import assert from 'node:assert/strict';
import { runTrackMenuRow, type TrackMenuActionContext, type TrackMenuSubject } from './trackMenuActions.ts';
import { stemRowId, type TrackMenuRow } from './trackMenuModel.ts';
import { applyAllStemsInsert } from './WaveformEditor.tsx';
import { useEditorStore, type AudioClip } from '../../state/editorStore.ts';
import { useLibraryStore } from '../../state/libraryStore.ts';
import { useAppUiStore } from '../../state/appUiStore.ts';
import { useDjAnalysisStore } from '../../state/djAnalysisStore.ts';
import { clipKnownBpm } from '../../lib/beatMatchRun.ts';
import { stemsSongTime } from '../../lib/songTimeLink.ts';
import type { LibraryEntry } from '../../state/libraryEntry.ts';

const SONG = '5b4390f8ff1c4de0af3e3e0533f0d152';
const SONG_BPM = 103.359375;

const audioOf = (sec: number): Blob => new Blob([new Uint8Array(Math.round(sec * 1000))], { type: 'audio/wav' });
class FakeAudioContext {
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength / 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(256).fill(0.25) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext, confirm: () => true, setTimeout, clearTimeout };

const stemRows = ['bass', 'drums', 'vocals'].map((name) => ({
  id: `${SONG}__${name}`, entry_id: SONG, stem_name: name, role: 'part', gain_normalized: false,
}));
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === `/api/stems/${SONG}`) return new Response(JSON.stringify({ entry_id: SONG, stems: stemRows }), { status: 200 });
  if (url.startsWith('/api/library/stems/') && url.endsWith('/audio')) return new Response(audioOf(30), { status: 200 });
  if (url === `/api/analysis/${SONG}`) return new Response(JSON.stringify({ entry_id: SONG, bpm: SONG_BPM, beats_json: '[1.1378, 1.5557]' }), { status: 200 });
  return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
}) as typeof fetch;

const entry = { id: SONG, title: 'The Owl Grinned', mimeType: 'audio/ogg', duration: 30, audioUrl: `/api/library/audio/${SONG}` } as LibraryEntry;
useLibraryStore.setState({ fetchAudioBlob: async () => audioOf(30) });
// The song's tempo is known to the library analysis cache before anything lands.
await useDjAnalysisStore.getState().fetch(SONG);

const row = (id: string): TrackMenuRow => ({
  id, label: id, icon: 'music', enabled: true, does: '', reason: null, title: '', longJob: false, goes: null, danger: false, chip: false, line: null,
});
const ctx: TrackMenuActionContext = {
  audioPath: null,
  stems: stemRows.map((s) => ({ id: s.id, name: s.stem_name })) as TrackMenuActionContext['stems'],
  lyricsText: '',
  runningJob: { stems: false, vocalJobId: null },
  stemOptions: { stems: 2, device: 'auto', quality: 'fast' },
  openLineage: () => {},
  openMetaEditor: () => {},
};
const subject: TrackMenuSubject = { kind: 'library', label: entry.title, entry, loadedUrl: null };
const ed = () => useEditorStore.getState();
const fresh = () => ed().loadProject({ tracks: [], clips: [], bpm: 120 });
const tiedToSong = (c: AudioClip, what: string) => {
  assert.ok(c.songTime, `${what}: tied to its song`);
  assert.equal(c.songTime.entryId, SONG, `${what}: the song's entry`);
  assert.deepEqual([c.songTime.offsetSec, c.songTime.rate], [0, 1], `${what}: the song's own time`);
  assert.equal(c.songTime.bpm, SONG_BPM, `${what}: the song's tempo`);
  assert.equal(clipKnownBpm(c), SONG_BPM, `${what}: SYNC knows its tempo`);
};

// The library menu's "Own lane in EDIT": the song itself.
{
  fresh();
  await runTrackMenuRow(row('edit-new-track'), subject, ctx);
  assert.equal(ed().clips.length, 1);
  const c = ed().clips[0];
  assert.equal(c.libraryEntryId, SONG);
  tiedToSong(c, 'own lane');
}

// The library menu's "Stems as EDIT tracks": every stem.
{
  fresh();
  await runTrackMenuRow({ ...row('edit-stems'), longJob: true }, subject, ctx);
  assert.equal(ed().clips.length, 3, 'one clip per stem');
  for (const c of ed().clips) tiedToSong(c, `stem ${c.label}`);
}

// A stem key's "Send to EDIT" in the library menu.
{
  fresh();
  await runTrackMenuRow(row(stemRowId('edit', `${SONG}__drums`)), subject, ctx);
  assert.equal(ed().clips.length, 1);
  tiedToSong(ed().clips[0], 'stem key');
}

// EDIT's "All stems" beside a clip of the song: the stems are the song's time.
{
  fresh();
  const trackId = ed().addTrack({ name: 'Song' });
  const parentId = ed().addClipToTrack({
    trackId, label: 'Song', audioBlob: audioOf(30), mimeType: 'audio/wav', sourceDuration: 30, offsetIntoSource: 2,
    durationSec: 20, startSec: 4, color: '#fff', libraryEntryId: SONG,
    songTime: { entryId: SONG, bpm: SONG_BPM, offsetSec: 0, rate: 1 },
  });
  const decoded = stemRows.map((s) => ({ ref: { name: s.stem_name, url: `/api/library/stems/${s.id}/audio`, role: 'part' }, blob: audioOf(30), peaks: new Float32Array(1), duration: 30 }));
  const result = applyAllStemsInsert(parentId, decoded, []);
  assert.ok(result);
  const stems = ed().clips.filter((c) => c.id !== parentId);
  assert.equal(stems.length, 3);
  for (const c of stems) {
    tiedToSong(c, `all stems ${c.label}`);
    assert.equal(c.offsetIntoSource, 2, 'framed like the parent');
  }
}

// Stems of an entry imported from a clip's own audio keep the clip's tie: they
// are that audio's time, stretched or not.
{
  const parent = { songTime: { entryId: SONG, bpm: SONG_BPM, offsetSec: 0.5, rate: 1.16 } };
  assert.deepEqual(stemsSongTime(parent, 'imported-entry', true), parent.songTime);
  assert.equal(stemsSongTime({}, 'imported-entry', true), undefined);
  assert.equal(stemsSongTime({}, null), undefined);
}

// The library menu's "Song tempo in EDIT": EDIT opens with the song's preview asked for.
{
  fresh();
  await runTrackMenuRow(row('edit-song-tempo'), subject, ctx);
  assert.deepEqual(ed().songTempoRequest, { entryId: SONG });
  assert.equal(useAppUiStore.getState().centerTab, 'edit');
  ed().dismissSongTempoRequest();
  assert.equal(ed().songTempoRequest, null);
}

console.log('songTimeInserts: ok');
