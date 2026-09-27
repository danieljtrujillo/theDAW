// A roll clip shorter than a 16th, the whole way from the roll to EDIT's
// playback: GEN writes a 24-step bar into the roll, SAVE writes it into an EDIT
// clip, EDIT plays and draws it, the project saves to .tasmo and reopens, and
// the Session grid converts it. Every note keeps its 0.667-step length at each
// hand-off, so the run stays detached. EDIT's live MIDI playback, its clip
// drawing, the .tasmo reload and the Session conversion each used to raise
// every note to a full 16th, so every note overlapped the next again.
import assert from 'node:assert/strict';
import { genWrite, type GenSettings } from './meterFace.ts';
import { GEN_DEFAULT_OPTS } from './loomGen.ts';
import { clipNoteSpan, rollClipFields } from './rollClip.ts';
import { captureEditorSession, tasmoMidiNotesToPiano } from './projectImport.ts';
import { tasmoLoadedToDawProject } from './tasmoToSession.ts';
import type { TasmoProjectLoaded } from './projectClient.ts';
import { midiClipNoteTimes, type MidiNoteTime } from '../state/liveMixer.ts';
import { useEditorStore, type AudioClip } from '../state/editorStore.ts';
import { usePianoRollStore } from '../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const THIRD = 16 / 24;
const BPM = 120;
const STEP_SEC = 60 / BPM / 4;
const EPS = 1e-9;

/** Each note ends at or before the next one starts, and lasts `dur` seconds. */
const detached = (times: readonly MidiNoteTime[], dur: number, where: string): void => {
  const sorted = [...times].sort((a, b) => a.onSec - b.onSec);
  for (const t of sorted) assert.ok(Math.abs(t.offSec - t.onSec - dur) < 1e-6, `${where}: a note lasts ${dur.toFixed(4)} s, got ${(t.offSec - t.onSec).toFixed(4)}`);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i - 1].offSec <= sorted[i].onSec + EPS, `${where}: note ${i - 1} ends before note ${i} starts`);
  }
};

// GEN: a bar of 24 euclid hits into one 4/4 bar of the roll.
st().importNotes([], BPM, { meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, []);
st().setTotalSteps(16);
const gen: GenSettings = { kind: 'euclid', opts: { ...GEN_DEFAULT_OPTS.euclid, hits: 24 }, steps: 24, gate: { kind: 'open' }, seed: 1 };
const res = genWrite(st(), 0, gen, [60, 62, 64], 'g24');
st().replaceAll(res.notes);
assert.equal(st().notes.length, 24);

// SAVE: the roll's fields as the EDIT clip holds them.
const fields = rollClipFields(st());
const clip: AudioClip = {
  id: 'roll-clip',
  trackId: 't1',
  label: 'roll',
  audioBlob: new Blob([new Uint8Array([0])], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 2,
  durationSec: 2,
  offsetIntoSource: 0,
  startSec: 0,
  color: '#a855f7',
  sourceKind: 'piano-roll',
  ...fields,
} as AudioClip;

// EDIT plays it (a soundfont or an instrument on the track takes the live MIDI path).
{
  const times = midiClipNoteTimes(clip, BPM, 0);
  assert.equal(times.length, 24, 'every note of the bar is scheduled');
  detached(times, THIRD * STEP_SEC, 'EDIT live MIDI');
  // Played from mid-bar: the notes already past are left out, the rest stay detached.
  const late = midiClipNoteTimes(clip, BPM, 1);
  assert.equal(late.length, 12);
  detached(late, THIRD * STEP_SEC, 'EDIT live MIDI from 1 s');
}

// EDIT draws it: the clip's note boxes are the same spans.
{
  const spans = (clip.sourcePianoRoll ?? []).map((n) => clipNoteSpan(n, STEP_SEC, 0)).sort((a, b) => a.relStart - b.relStart);
  for (let i = 1; i < spans.length; i += 1) assert.ok(spans[i - 1].relEnd <= spans[i].relStart + EPS, `EDIT clip box ${i - 1} ends before box ${i}`);
}

// The project saves (captureEditorSession writes midi_notes) and reopens
// (loadProjectIntoEditor reads them back through tasmoMidiNotesToPiano).
{
  useEditorStore.setState({
    bpm: BPM,
    tracks: [{ id: 't1', name: 'Roll', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' }] as never,
    clips: [clip] as never,
  });
  const saved = captureEditorSession().tracks[0].clips![0];
  assert.equal(saved.clip_type, 'midi');
  const midiNotes = JSON.parse(JSON.stringify(saved.midi_notes)) as Array<Record<string, number>>;
  const reopened = tasmoMidiNotesToPiano(midiNotes, BPM);
  assert.equal(reopened.length, 24);
  for (const n of reopened) assert.ok(Math.abs(n.length - THIRD) < 1e-9, `a reopened note keeps ${THIRD.toFixed(3)} steps, got ${n.length}`);
  detached(midiClipNoteTimes({ ...clip, sourcePianoRoll: reopened }, BPM, 0), THIRD * STEP_SEC, 'EDIT after reopening');

  // The Session grid's view of the same saved clip.
  const loaded: TasmoProjectLoaded = {
    project_name: 'Thirds',
    tempo: BPM,
    sample_rate: 48000,
    tracks: [{ id: 't1', name: 'Roll', type: 'midi', clips: [{ id: 'roll-clip', name: 'roll', clip_type: 'midi', start_time: 0, end_time: 2, midi_notes: midiNotes }] }],
  } as TasmoProjectLoaded;
  const session = tasmoLoadedToDawProject(loaded).tracks[0].clips[0].midi_notes as Array<{ start: number; duration: number }>;
  assert.equal(session.length, 24);
  detached(session.map((n) => ({ note: 0, velocity: 0, onSec: n.start, offSec: n.start + n.duration })), THIRD * STEP_SEC, 'Session grid');
}

// A file an older build wrote opens as it did: whole-step lengths stay, and a
// length of 0 or less still loads as one step.
{
  const old = tasmoMidiNotesToPiano([
    { note: 60, step: 0, length: 2, velocity: 90 },
    { note: 62, step: 2, length: 0, velocity: 90 },
    { note: 64, step: 4, velocity: 90 },
  ], BPM);
  assert.deepEqual(old.map((n) => [n.step, n.length]), [[0, 2], [2, 1], [4, 1]]);
  // A seconds-based note (a set saved from the Session grid) still snaps to whole steps.
  const secs = tasmoMidiNotesToPiano([{ pitch: 60, start: 0.26, duration: 0.05, velocity: 90 }], BPM);
  assert.deepEqual(secs.map((n) => [n.step, n.length]), [[2, 1]]);
}

console.log('rollClipPlayback: ok');
