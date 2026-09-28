/**
 * A 24-part orchestral score in EDIT with no rendered audio: it opens, plays
 * live, saves, reopens and exports, and a project saved with renders still
 * opens with them.
 *
 * The sequence: a type-1 MIDI file with 24 parts, tempos 96 / 72 / 132 and
 * meters 4/4, 7/8 3+2+2, 5/4 is written (lib/midi encodeMidi) and read back
 * (parseMidi). Each part lands on its own track holding its instrument, the way
 * a MIDI file dropped into EDIT lands (lib/rollClip midiFileClipFields, no
 * audio of its own). Every part plays live (liveMixer planLiveMidi) and nothing
 * is rendered. SAVE (projectStore.save) writes 24 parts and no audio file;
 * OPEN (loadProjectIntoEditor) brings them back live with their instruments,
 * tempos and meters, again rendering nothing. An export (the render queue's
 * clipsWithMidiAudio, what every bounce job reads) renders each part once, one
 * at a time, through its own instrument and tempo map, and leaves the parts
 * without audio. A project saved with each part's render opens with those
 * renders, reads them as current, and exports without rendering again.
 *
 * At 13657cdc a MIDI clip had to hold a render: opening this file rendered all
 * 24 parts first (in node, with no OfflineAudioContext, that throws and drops
 * the parts), and a saved project carried a WAV per part.
 *
 *   cd frontend && npx tsx src/lib/midiLiveScore.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData, type MidiTrack } from './midi.ts';
import { midiFileClipFields } from './rollClip.ts';
import { stepClock } from './rollTempo.ts';
import { midiRenderSig, midiRenderState, type MidiStepRender } from './midiRender.ts';
import { loadProjectIntoEditor } from './projectImport.ts';
import type { TasmoProjectLoaded } from './projectClient.ts';
import { useEditorStore, type AudioClip } from '../state/editorStore.ts';
import { useProjectStore } from '../state/projectStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import { clipsWithMidiAudio, configureMidiRenderQueue } from '../state/midiRenderQueue.ts';
import type { GlobalVoice } from './clipProgram.ts';

class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, numberOfChannels: 1, length: 64, sampleRate: 44100, getChannelData: () => new Float32Array(64).fill(0.25) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const PPQ = 480;
const PARTS = 24;
const PICKER_OFF: GlobalVoice = { useSoundfont: false, activeProgram: 0 };
const ORCHESTRA = [45, 45, 45, 45, 46, 46, 56, 56, 57, 58, 60, 60, 68, 69, 70, 71, 72, 73, 11, 12, 13, 9, 8, 0];

// ── the file ─────────────────────────────────────────────────────────────────
const BAR44 = PPQ * 4;
const BAR78 = (PPQ / 2) * 7;
const BAR54 = PPQ * 5;
const T78 = BAR44 * 2;
const T54 = T78 + BAR78 * 2;
const END = T54 + BAR54 * 2;
const tempos = [{ tick: 0, bpm: 96 }, { tick: T78, bpm: 72 }, { tick: T54, bpm: 132 }];
const timeSignatures = [{ tick: 0, num: 4, den: 4 }, { tick: T78, num: 7, den: 8, groups: [3, 2, 2] }, { tick: T54, num: 5, den: 4 }];
const tracks: MidiTrack[] = ORCHESTRA.map((_, p) => {
  const notes = [];
  for (let tick = (p % 4) * 60; tick + PPQ / 2 <= END; tick += PPQ * 2) notes.push({ tick, note: 48 + p, velocity: 90, durationTicks: PPQ / 2, channel: p % 16 === 9 ? 10 : p % 16 });
  return { name: `Part ${p + 1}`, notes };
});
const file = parseMidi(encodeMidi({ ppq: PPQ, bpm: 96, tracks, tempos, timeSignatures } as MidiFileData));
assert.equal(file.tracks.length, PARTS, 'the file reads back with its 24 parts');

// ── the renderer every render goes through ───────────────────────────────────
let active = 0;
let maxActive = 0;
const renders: Array<{ program?: number; tempoMap: number; notes: number }> = [];
const render: MidiStepRender = async (notes, bpm, totalSteps, opts) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  renders.push({ program: opts.program, tempoMap: opts.tempoMap?.length ?? 0, notes: notes.length });
  await new Promise((r) => setTimeout(r, 1));
  active -= 1;
  const bytes = new Uint8Array(44 + notes.length * 4);
  return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: stepClock(bpm, opts.tempoMap).at(totalSteps) + 1 };
};
configureMidiRenderQueue({ render, computePeaks: async (_b, bins) => ({ peaks: new Float32Array(bins ?? 240) }), global: () => PICKER_OFF, ensureReady: async () => true });

const ed = () => useEditorStore.getState();
const midiClips = (): AudioClip[] => ed().clips.filter((c) => c.sourceKind === 'piano-roll');
const heldBytes = (): number => midiClips().reduce((sum, c) => sum + (c.audioBlob?.size ?? 0), 0);

function checkParts(where: string): void {
  const clips = midiClips();
  assert.equal(clips.length, PARTS, `${where}: 24 parts`);
  for (const c of clips) {
    const p = Number(c.label.replace('Part ', '')) - 1;
    const track = ed().tracks.find((t) => t.id === c.trackId)!;
    assert.equal(track.instrumentProgram, ORCHESTRA[p], `${where}: ${c.label} is on its own instrument`);
    assert.deepEqual((c.sourceTempoMap ?? []).map((e) => [e.beat, e.bpm]), [[0, 96], [T78 / PPQ, 72], [T54 / PPQ, 132]], `${where}: ${c.label} keeps its tempos`);
    assert.deepEqual((c.sourceMeterMap ?? []).map((s) => `${s.bar}:${s.meter.num}/${s.meter.den}${s.meter.groups.length ? ` ${s.meter.groups.join('+')}` : ''}`), ['0:4/4', '2:7/8 3+2+2', '4:5/4'], `${where}: ${c.label} keeps its meters`);
    assert.equal(midiRenderState(c, track, PICKER_OFF), 'none', `${where}: ${c.label} holds no render`);
  }
  const plan = planLiveMidi(ed().clips, ed().tracks, PICKER_OFF);
  assert.equal(plan.liveClipIds.size, PARTS, `${where}: every part plays live`);
  assert.deepEqual(plan.channels.dropped, [], `${where}: none past the last live channel`);
}

// ── the parts land the way a dropped MIDI file lands ────────────────────────
ed().loadProject({ tracks: [], clips: [] });
file.tracks.forEach((t, p) => {
  const trackId = ed().addTrack({ name: t.name, nameAutoGenerated: false, instrumentProgram: ORCHESTRA[p] });
  const fields = midiFileClipFields({ ...file, tracks: [t] }, `p${p}`);
  const nominal = stepClock(fields.sourceBpm, fields.sourceTempoMap).at(fields.sourceTotalSteps);
  ed().addClipToTrack({
    trackId, label: t.name, mimeType: 'audio/wav', sourceDuration: nominal, offsetIntoSource: 0, durationSec: nominal, startSec: 0,
    color: '#a855f7', sourceKind: 'piano-roll', ...fields,
  });
});
checkParts('dropped in');
assert.equal(heldBytes(), 0, 'no part holds audio');
assert.equal(renders.length, 0, 'and nothing was rendered');

// ── SAVE ──────────────────────────────────────────────────────────────────────
async function save(): Promise<{ project: TasmoProjectLoaded; files: File[] }> {
  useProjectStore.setState({ projectName: 'Symphony', savePath: 'S.tasmo', pendingTracks: [] });
  let posted: FormData | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/api/project/save-session')) {
      posted = init?.body as FormData;
      return new Response(JSON.stringify({ status: 'saved', path: 'S.tasmo', manifest: { audio_mode: 'embedded' } }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    await useProjectStore.getState().save();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(useProjectStore.getState().error, null, 'the save went through');
  const form = posted as FormData | null;
  assert.ok(form, 'SAVE posted to /save-session');
  return { project: JSON.parse(await (form.get('project') as Blob).text()) as TasmoProjectLoaded, files: form.getAll('files') as File[] };
}

async function open(project: TasmoProjectLoaded, files: File[]): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const hit = files.find((f) => path.endsWith(f.name));
    return hit ? new Response(hit, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    await loadProjectIntoEditor(project);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const live = await save();
const savedClips = live.project.tracks.flatMap((t) => t.clips ?? []);
assert.equal(savedClips.length, PARTS);
assert.ok(savedClips.every((c) => c.audio_file === null), 'each part saves no audio file');
assert.ok(savedClips.every((c) => (c.midi_notes?.length ?? 0) > 0 || (c as { roll_notes?: unknown[] }).roll_notes?.length), 'and its notes');
assert.equal(live.files.length, 0, 'the project carries no audio at all');

// ── OPEN ─────────────────────────────────────────────────────────────────────
ed().loadProject({ tracks: [], clips: [] });
await open(live.project, live.files);
checkParts('reopened');
assert.equal(heldBytes(), 0, 'the reopened parts hold no audio');
assert.equal(renders.length, 0, 'opening rendered nothing');

// ── EXPORT ───────────────────────────────────────────────────────────────────
const t0 = performance.now();
const bounce = await clipsWithMidiAudio();
const exportMs = performance.now() - t0;
assert.equal(renders.length, PARTS, 'the export renders each part once');
assert.equal(maxActive, 1, 'one at a time');
assert.deepEqual(renders.map((r) => r.program), midiClips().map((c) => ed().tracks.find((t) => t.id === c.trackId)!.instrumentProgram), 'each through its own instrument');
assert.ok(renders.every((r) => r.tempoMap === 3), 'and its own tempo map');
assert.equal(bounce.transient.length, PARTS, 'every render was made for the export only');
assert.ok(bounce.clips.filter((c) => c.sourceKind === 'piano-roll').every((c) => c.audioBlob instanceof Blob), 'the export reads every part with audio');
assert.equal(heldBytes(), 0, 'and the parts themselves still hold none');
bounce.release();
console.log(`  export: ${PARTS} parts rendered one at a time through the stand-in synth in ${exportMs.toFixed(1)} ms of queue time; 0 bytes of audio held by the parts before and after`);

// ── a project saved with renders still opens with them ───────────────────────
for (const c of midiClips()) {
  const track = ed().tracks.find((t) => t.id === c.trackId)!;
  ed().applyClipRender(c.id, { audioBlob: new Blob([new Uint8Array(64)], { type: 'audio/wav' }), renderedProgram: track.instrumentProgram });
}
const rendered = await save();
assert.equal(rendered.files.length, PARTS, 'a project whose parts hold renders embeds one file each');
ed().loadProject({ tracks: [], clips: [] });
await open(rendered.project, rendered.files);
assert.equal(midiClips().length, PARTS);
for (const c of midiClips()) {
  const track = ed().tracks.find((t) => t.id === c.trackId)!;
  assert.ok(c.audioBlob instanceof Blob, `${c.label} opens with its render`);
  assert.equal(c.renderSig, midiRenderSig(c), 'which it reads as made from the notes saved beside it');
  assert.equal(midiRenderState(c, track, PICKER_OFF), 'current');
}
const again = await clipsWithMidiAudio();
assert.equal(renders.length, PARTS, 'an export of the reopened renders renders nothing');
assert.equal(again.transient.length, 0);

console.log('midiLiveScore: ok');
