/**
 * The track menu's MIDI rows put a track's notes in the piano roll at the ticks
 * they were heard on. "Detect notes" sends the footer's audio to basic-pitch;
 * "Vocal melody to roll" reads the entry's vocal artifact. Both used to round
 * every edge to the nearest 16th with a one-step floor at one BPM, so a played
 * part (a flam, a late note, a 32nd) arrived quantised before the player chose to.
 *
 * Real rows through runTrackMenuRow, real piano-roll store, fake `fetch`.
 */
import assert from 'node:assert/strict';
import { runTrackMenuRow, type TrackMenuActionContext, type TrackMenuSubject } from './trackMenuActions.ts';
import { PPQ, usePianoRollStore } from '../../state/pianoRollStore.ts';
import type { TrackMenuRow } from './trackMenuModel.ts';
import type { ArtifactNote } from '../../lib/vocalExport.ts';
import type { LibraryEntry } from '../../state/libraryEntry.ts';

// The replace question the rows ask when the roll holds notes: answered yes.
(globalThis as { window?: unknown }).window = { confirm: () => true };

const HEARD: ArtifactNote[] = [
  { pitch: 60, start_ms: 0, end_ms: 480, velocity: 100 },
  { pitch: 64, start_ms: 20, end_ms: 480, velocity: 90 }, // a flam: 20 ms after the first
  { pitch: 67, start_ms: 540, end_ms: 800, velocity: 80 }, // 40 ms late
  { pitch: 72, start_ms: 1000, end_ms: 1062, velocity: 70 }, // a 32nd at 120 BPM
];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  requests.push(url);
  if (url === 'blob:footer-track') return new Response(new Blob(['RIFF'], { type: 'audio/wav' }), { status: 200 });
  if (url === '/api/vocal/audio-to-notes') return jsonResponse({ notes: HEARD });
  if (url === '/api/vocal/metadata/e1') return jsonResponse({ notes: HEARD, timing: { tempo_bpm: 97.6 } });
  return new Response('', { status: 404 });
}) as typeof fetch;

const row = (id: string): TrackMenuRow => ({
  id,
  label: id,
  icon: 'music',
  enabled: true,
  does: '',
  reason: null,
  title: '',
  longJob: false,
  goes: null,
  danger: false,
  chip: false,
  line: null,
});

const ctx: TrackMenuActionContext = {
  audioPath: null,
  stems: [],
  lyricsText: '',
  runningJob: { stems: false, vocalJobId: null },
  openLineage: () => {},
  openMetaEditor: () => {},
};

/** The roll's notes by pitch, as [start second, end second] at the roll's BPM. */
const playedSeconds = (): Array<[number, number]> => {
  const s = usePianoRollStore.getState();
  const secPerTick = 60 / s.bpm / PPQ;
  return [...s.notes]
    .sort((a, b) => a.note - b.note)
    .map((n) => [(n.tick ?? 0) * secPerTick, ((n.tick ?? 0) + (n.ticks ?? 0)) * secPerTick]);
};

const assertAsHeard = (what: string, bpm: number): void => {
  const halfTick = 60 / bpm / PPQ / 2;
  const got = playedSeconds();
  assert.equal(got.length, HEARD.length, `${what}: every note arrives`);
  got.forEach(([start, end], i) => {
    assert.ok(Math.abs(start - HEARD[i].start_ms / 1000) <= halfTick, `${what}: note ${HEARD[i].pitch} starts at ${HEARD[i].start_ms} ms (got ${start.toFixed(4)} s)`);
    assert.ok(Math.abs(end - HEARD[i].end_ms / 1000) <= 2 * halfTick, `${what}: note ${HEARD[i].pitch} ends at ${HEARD[i].end_ms} ms (got ${end.toFixed(4)} s)`);
  });
};

// Detect notes on the footer's loaded audio, with the roll at 120 BPM.
{
  usePianoRollStore.getState().setBpm(120);
  const subject: TrackMenuSubject = { kind: 'loose', label: 'Loaded', entry: null, loadedUrl: 'blob:footer-track' };
  await runTrackMenuRow(row('midi-detect'), subject, ctx);
  assert.ok(requests.includes('/api/vocal/audio-to-notes'), 'the audio went to note detection');
  assert.equal(usePianoRollStore.getState().bpm, 120);
  assertAsHeard('detect', 120);
}

// Vocal melody to roll, from an artifact detected at 97.6 BPM: the roll takes
// 98, and the notes convert at 98 so each plays at the second it was sung at.
{
  const entry = { id: 'e1', title: 'Song' } as LibraryEntry;
  const subject: TrackMenuSubject = { kind: 'library', label: 'Song', entry, loadedUrl: null };
  await runTrackMenuRow(row('melody-roll'), subject, ctx);
  assert.equal(usePianoRollStore.getState().bpm, 98);
  assertAsHeard('melody', 98);
}

console.log('trackMenuActions takes tests passed');
