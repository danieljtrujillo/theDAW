/**
 * A recorded take survives SAVE and OPEN at its own ticks.
 *
 * A take converted at its ticks (lib/takeNotes) holds notes shorter than a 16th
 * and notes between 16ths. The .tasmo wrote each note as step / length only,
 * and a length in steps floored at one step when it came back, so a 32nd or a
 * flam note reopened a whole 16th long, and the sounding copy (midi_notes)
 * rounded the same way. The file now carries `tick` / `ticks` beside the steps.
 *
 * The sequence replayed: a take lands as a piano-roll clip, the session is
 * captured the way SAVE captures it, the payload goes through JSON, the project
 * is opened the way OPEN opens it, and the clip is opened in the roll.
 */
import assert from 'node:assert/strict';
import { takeToRoll } from './takeNotes.ts';
import { captureEditorSession, loadProjectIntoEditor } from './projectImport.ts';
import { tasmoNotesToPiano } from './projectClient.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

// computePeaks needs an AudioContext: this one decodes any blob to one second.
class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const timing = (notes: readonly PianoNote[] = []) => notes.map((n) => [n.note, n.tick, n.ticks, n.step, n.length]);

// At 120 BPM a tick is 1/1920 s and a 16th is 240 ticks.
const { rollNotes, totalSteps } = takeToRoll(
  [
    { note: 60, velocity: 100, startSec: 0, endSec: 0.25 }, // a whole 8th
    { note: 64, velocity: 90, startSec: 0.02, endSec: 0.25 }, // a flam, 38 ticks late
    { note: 72, velocity: 70, startSec: 0.5, endSec: 0.5625 }, // a 32nd: 120 ticks
  ],
  { bpm: 120, idPrefix: 'mc' },
);
assert.deepEqual(timing(rollNotes), [
  [60, 0, 480, 0, 2],
  [64, 38, 442, 38 / 240, 442 / 240],
  [72, 960, 120, 4, 0.5],
]);

useEditorStore.setState({
  bpm: 120,
  tracks: [{ id: 't1', name: 'Keys', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
  clips: [
    {
      id: 'c1',
      trackId: 't1',
      label: 'MIDI take 1',
      audioBlob: new Blob(['WAVE'], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      startSec: 0,
      durationSec: 1,
      sourceDuration: 1,
      offsetIntoSource: 0,
      color: '#fff',
      sourceKind: 'piano-roll',
      sourcePianoRoll: rollNotes.map((n) => ({ ...n })),
      sourceRollNotes: rollNotes.map((n) => ({ ...n })),
      sourceBpm: 120,
      sourceTotalSteps: totalSteps,
    },
  ] as never,
  markers: [],
  loopEnabled: false,
  loopStart: 0,
  loopEnd: 0,
});

// SAVE: both note lists carry the ticks, and the steps a build that reads only
// steps would use.
const session = captureEditorSession();
const saved = JSON.parse(JSON.stringify(session.tracks[0].clips![0])) as {
  midi_notes: Array<Record<string, number>>;
  roll_notes: Array<Record<string, number>>;
};
for (const list of [saved.midi_notes, saved.roll_notes]) {
  assert.deepEqual(
    list.map((n) => [n.note, n.tick, n.ticks, n.step, n.length]),
    timing(rollNotes),
    'each note is written with its ticks and the steps they make',
  );
}

// OPEN: serve the embedded audio back the way /clip-audio does.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
  const file = session.files.find((f) => path.endsWith(f.name));
  return file ? new Response(file.blob, { status: 200 }) : new Response('', { status: 404 });
}) as typeof fetch;
try {
  await loadProjectIntoEditor({
    project_name: 'Take',
    tempo: 120,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Keys', type: 'midi', clips: [saved as never] }],
  });
} finally {
  globalThis.fetch = realFetch;
}
const loaded = useEditorStore.getState().clips[0];
assert.ok(loaded, 'the clip opened');
assert.deepEqual(timing(loaded.sourceRollNotes), timing(rollNotes), 'the roll notes come back at their ticks');
assert.deepEqual(timing(loaded.sourcePianoRoll), timing(rollNotes), 'and so does the sounding copy');

// Edit in Piano Roll: the roll holds the 32nd and the flam as they were played.
usePianoRollStore.getState().loadFromClip(loaded.id, loaded.sourceRollNotes ?? [], loaded.sourceBpm ?? 120, loaded.sourceTotalSteps ?? 16);
assert.deepEqual(timing(usePianoRollStore.getState().notes), timing(rollNotes), 'the roll opens the take as it was played');

// The Session tab plays the same file's notes at their own lengths: the 32nd
// lasts 1/16 s at 120 BPM, where a length in steps alone floored it at a 16th.
{
  const project = tasmoLoadedToDawProject({
    project_name: 'Take',
    tempo: 120,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Keys', type: 'midi', clips: [{ ...saved, name: 'MIDI take 1', clip_type: 'midi' }] }],
  } as never);
  const grid = project.tracks[0].clips[0].midi_notes as Array<{ pitch: number; start: number; duration: number }>;
  assert.deepEqual(
    grid.map((n) => [n.pitch, n.start, n.duration]),
    [
      [60, 0, 0.25],
      [64, (38 / 240) * 0.125, (442 / 240) * 0.125],
      [72, 0.5, 0.0625],
    ],
  );
}

// A file written before the ticks (step / length only) keeps its lengths: the
// roll floors a length in steps at its one tick, so the 32nd stays a 32nd.
{
  const legacy = saved.roll_notes.map(({ tick: _t, ticks: _ts, ...n }) => n);
  const notes = tasmoNotesToPiano(legacy);
  assert.deepEqual(notes.map((n) => [n.tick, n.ticks]), [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  usePianoRollStore.getState().loadFromClip('legacy', notes, 120, 16);
  assert.deepEqual(
    usePianoRollStore.getState().notes.map((n) => [n.step, n.length]),
    [[0, 2], [38 / 240, 442 / 240], [4, 0.5]],
    'the 32nd in an old file keeps its length',
  );
}

// Ticks that disagree with the steps beside them (a hand-edited file) are not
// used: the steps win, as they did before the file carried ticks.
{
  const [n] = tasmoNotesToPiano([{ note: 60, step: 2, length: 1, velocity: 90, tick: 999, ticks: 7 }]);
  assert.deepEqual([n.tick, n.ticks, n.step, n.length], [undefined, undefined, 2, 1]);
}

console.log('takeNotes .tasmo round-trip tests passed');
