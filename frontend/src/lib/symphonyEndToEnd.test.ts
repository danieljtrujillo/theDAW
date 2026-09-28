/**
 * Stage 3 end to end: an orchestral MIDI file into the roll, each part on its
 * own instrument with the file's tempo, meter and markers; a marker added;
 * every part sent to EDIT; all 24 parts played live by EDIT's scheduler with
 * each onset measured against the audio clock; and the arrangement and the
 * roll written back out as type-1 MIDI and read in again.
 *
 * The sequence replays what a user does:
 *   1. IMPORT a type-1 file of 24 tracks (23 on their programs, eight of them
 *      sharing a channel with another, and a drum kit on channel 10) at 480
 *      PPQ, with tempos 96, 72 and 132, meters 4/4, 7/8 and 5/4, and two FF 06
 *      markers (lib/rollPartsImport importMidiParts).
 *   2. Add a section marker at bar 6 (pianoRollStore addMarker).
 *   3. EDIT: every part lands on a track of its own (lib/rollBounce), plays
 *      live, and the offer to take the roll's tempo and meter is accepted.
 *   4. PLAY: the pass play() plans (liveMixer planLiveMidi) runs through the
 *      live scheduler (lib/editMidiScheduler) on a timer up to 50 ms late,
 *      and every note-on's audio-clock time is checked against the second
 *      the file's own FF 51 tempos put it at, integrated here.
 *   5. EXPORT the arrangement (lib/arrangementMidi) and the roll
 *      (lib/rollMidi) as type-1 files and read each back.
 *
 *   cd frontend && npx tsx src/lib/symphonyEndToEnd.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, tempoMicros, type MidiFileData, type MidiTrack } from './midi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { bounceRollToEditor } from './rollBounce.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { EDIT_MIDI_LOOKAHEAD_SEC, EDIT_MIDI_TICK_MS, EditMidiScheduler } from './editMidiScheduler.ts';
import { clipVoice, type GlobalVoice } from './clipProgram.ts';
import { barStartStep } from './meterMap.ts';
import { isClipEditMarker } from './rollMarkers.ts';
import { isPercussionPart } from './rollTracks.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { configureMidiRenderQueue } from '../state/midiRenderQueue.ts';
import { liveMidiIfHeard, planLiveMidi } from '../state/liveMixer.ts';
import { partLinkOf, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();
const GLOBAL: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
let rendered = 0;
configureMidiRenderQueue({
  render: async () => {
    rendered += 1;
    return { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), duration: 1 };
  },
  computePeaks: async () => ({ peaks: new Float32Array(4) }),
  global: () => GLOBAL,
  ensureReady: async () => undefined,
  livePlan: liveMidiIfHeard,
});

// ── 1. The file ──────────────────────────────────────────────────────────────
const PPQ = 480;
const BAR44 = PPQ * 4;
const BAR78 = (PPQ / 2) * 7;
const BAR54 = PPQ * 5;
const T78 = BAR44 * 3;
const T54 = T78 + BAR78 * 2;
const END = T54 + BAR54 * 3;
const tempos = [{ tick: 0, bpm: 96 }, { tick: T78, bpm: 72 }, { tick: T54, bpm: 132 }];
// [name, program, the registry instrument its name names]
const PARTS: Array<[string, number, string]> = [
  ['Flute 1', 73, 'flute'], ['Flute 2', 73, 'flute'], ['Oboe', 68, 'oboe'], ['Cor anglais', 69, 'english-horn'],
  ['Clarinet in B♭', 71, 'clarinet-bb'], ['Bass clarinet', 71, 'bass-clarinet'], ['Bassoon', 70, 'bassoon'], ['Contrabassoon', 70, 'contrabassoon'],
  ['Horn 1', 60, 'horn'], ['Horn 2', 60, 'horn'], ['Trumpet 1', 56, 'trumpet-bb'], ['Trumpet 2', 56, 'trumpet-bb'],
  ['Trombone', 57, 'trombone'], ['Tuba', 58, 'tuba'], ['Timpani', 47, 'timpani'], ['Harp', 46, 'harp'],
  ['Celesta', 8, 'celesta'], ['Glockenspiel', 9, 'glockenspiel'], ['Violin I', 40, 'violin'], ['Violin II', 40, 'violin'],
  ['Viola', 41, 'viola'], ['Violoncello', 42, 'cello'], ['Contrabass', 43, 'contrabass'],
];
const MELODIC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
const tracks: MidiTrack[] = PARTS.map(([name, program], i) => {
  const channel = MELODIC[i % MELODIC.length];
  const pitch = 36 + ((i * 5) % 48);
  const notes = [];
  // An eighth note every eighth, through all eight bars, offset per part so the onsets fall everywhere.
  for (let tick = (i % 4) * 30; tick < END - 120; tick += PPQ / 2) notes.push({ tick, durationTicks: 180, note: pitch, velocity: 80, channel });
  return { name, programs: [{ tick: 0, channel, program }], notes };
});
tracks.push({
  name: 'Percussion',
  programs: [{ tick: 0, channel: 9, program: 0 }],
  notes: Array.from({ length: END / PPQ }, (_, k) => ({ tick: k * PPQ, durationTicks: 120, note: k % 2 ? 38 : 36, velocity: 100, channel: 9 })),
});
const file: MidiFileData = {
  ppq: PPQ,
  bpm: 96,
  tempos,
  timeSignatures: [{ tick: 0, num: 4, den: 4 }, { tick: T78, num: 7, den: 8 }, { tick: T54, num: 5, den: 4 }],
  markers: [{ tick: 0, text: 'I. Allegro' }, { tick: T78, text: 'B' }],
  tracks,
};
const data = parseMidi(encodeMidi(file));
assert.equal(data.tracks.length, 24, 'a type-1 file of 24 tracks');

/** The second a file tick sounds at under the file's own FF 51 tempos: whole microseconds a quarter, integrated here. */
function fileSec(tick: number): number {
  let sec = 0;
  for (let i = 0; i < tempos.length; i += 1) {
    const from = tempos[i].tick;
    const to = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
    if (tick <= from) break;
    sec += ((Math.min(tick, to) - from) / PPQ) * (tempoMicros(tempos[i].bpm) / 1e6);
  }
  return sec;
}
const heard = (bpm: number) => 60e6 / tempoMicros(bpm);

// ── IMPORT into the roll ─────────────────────────────────────────────────────
ed().loadProject({ tracks: [], clips: [] });
const done = importMidiParts(data, 'sym');
assert.equal(done.into, 'parts');
assert.equal(done.parts, 24, 'one part per track');
const parts = rollTracksOf(roll());
PARTS.forEach(([name, program, inst], k) => {
  assert.equal(parts[k].name, name, `part ${k + 1} is named after its track`);
  assert.equal(parts[k].program, program, `${name} plays program ${program}, even on a channel it shares`);
  assert.equal(parts[k].instrumentId, inst, `${name} is the registry's ${inst}`);
  assert.equal(parts[k].notes.length, tracks[k].notes.length, `${name} holds its own notes`);
});
assert.ok(isPercussionPart(parts[23]) && parts[23].channel === 10, 'the channel-10 track is a percussion part');
assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, heard(96)], [12, heard(72)], [19, heard(132)]], 'every tempo, at the value its FF 51 holds');
assert.deepEqual(roll().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 4, 4], [3, 7, 8], [5, 5, 4]], 'every meter');
assert.deepEqual(roll().markers.map((m) => [m.tick, m.name]), [[0, 'I. Allegro'], [T78 * 2, 'B']], "the file's markers, on the roll's 960 clock");

// ── Add a marker at bar 6 ────────────────────────────────────────────────────
const bar6 = barStartStep(roll().meterMap, 5, roll().pickupSteps);
roll().addMarker({ step: bar6, name: 'C', kind: 'section' });
assert.deepEqual(roll().markers.map((m) => m.name), ['I. Allegro', 'B', 'C']);

// ── EDIT: every part on a track of its own, live ─────────────────────────────
const tracksBefore = ed().tracks.length;
const sent = await bounceRollToEditor({ global: () => GLOBAL });
assert.ok(sent);
assert.equal(sent.parts.length, 24);
assert.equal(ed().tracks.length, tracksBefore + 24, 'a track per part');
assert.equal(rendered, 0, 'every part plays live: nothing rendered');
const clipOf = (partId: string) => ed().clips.find((c) => c.id === partLinkOf(roll(), partId))!;
const trackOf = (partId: string) => ed().tracks.find((t) => t.id === clipOf(partId).trackId)!;
parts.forEach((p, k) => {
  const v = clipVoice(clipOf(p.id), trackOf(p.id), GLOBAL);
  assert.equal(v.program, k === 23 ? 0 : PARTS[k][1], `${p.name}'s EDIT voice is its program`);
  assert.equal(v.percussion, k === 23, `${p.name} ${k === 23 ? 'is' : 'is not'} on the drum channel`);
});
const timeline = ed().markers.filter((m) => ed().clips.some((c) => isClipEditMarker(m, c.id)));
assert.deepEqual(timeline.map((m) => m.label), ['I. Allegro', 'B', 'C'], "the markers on EDIT's timeline, once each");
// The offer above the timeline, accepted: the arrangement takes the roll's tempo and meter.
assert.deepEqual(ed().adoptClipTimeMaps(sent.clipId), { ok: true });
assert.deepEqual(ed().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 4, 4], [3, 7, 8], [5, 5, 4]]);
near(timeline[1].t, fileSec(T78), 1e-9, 'marker B at the second bar 4 starts');
near(timeline[2].t, fileSec(T54), 1e-9, 'marker C at the second bar 6 starts');

// ── PLAY: 24 parts on the audio clock ────────────────────────────────────────
{
  const clock = { t: 50 };
  const onsets: number[] = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (_ch, _program, _midi, _vel, time) => onsets.push(time),
      noteOff: () => undefined,
      wheel: () => undefined,
      wheelRange: () => undefined,
      control: () => undefined,
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => GLOBAL,
    projectBpm: () => ed().bpm,
  });
  const plan = planLiveMidi(ed().clips, ed().tracks, GLOBAL);
  assert.equal(plan.liveClipIds.size, 24, 'all 24 parts play live');
  // A timer 25 ms apart, each tick late by up to 50 ms more (a busy main thread).
  let seed = 11;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 0.05;
  };
  const anchor = clock.t;
  const endSec = fileSec(END) + 1;
  const started = performance.now();
  sched.start({ liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf }, 0, anchor);
  while (clock.t < anchor + endSec) {
    clock.t += EDIT_MIDI_TICK_MS / 1000 + jitter();
    sched.tick();
  }
  sched.stop();
  const wall = performance.now() - started;
  const want = tracks.flatMap((t) => t.notes.map((n) => anchor + fileSec(n.tick))).sort((a, b) => a - b);
  const got = [...onsets].sort((a, b) => a - b);
  assert.equal(got.length, want.length, `every note of every part plays once (${got.length} of ${want.length})`);
  let worst = 0;
  got.forEach((t, i) => { worst = Math.max(worst, Math.abs(t - want[i])); });
  console.log(`  24 parts, ${got.length} notes over ${endSec.toFixed(1)} s: worst onset drift against the file's own tempos ${(worst * 1e6).toFixed(3)} us; ${sched.stats.late} late, ${sched.stats.skipped} skipped; scheduling took ${wall.toFixed(0)} ms`);
  assert.ok(worst < 1e-6, `every onset within a microsecond of its second (worst ${worst * 1e6} us)`);
  assert.equal(sched.stats.late + sched.stats.skipped, 0, 'nothing late or skipped with the lookahead');
  assert.ok(EDIT_MIDI_LOOKAHEAD_SEC > 0);
}

// ── EXPORT the arrangement and read it back ──────────────────────────────────
{
  const out = arrangementToMidiFile(ed(), { global: GLOBAL });
  assert.equal(out.file.tracks.length, 24, 'a MIDI track per part');
  const back = midiFileToRollParts(parseMidi(encodeMidi(out.file)), 'back');
  assert.deepEqual(back.parts.map((p) => p.track.program), [...PARTS.map((p) => p[1]), 0], 'every program');
  assert.deepEqual(back.parts.map((p) => p.notes.length), tracks.map((t) => t.notes.length), 'every note');
  assert.ok(back.parts[23].track.channel === 10, 'the kit on channel 10');
  assert.deepEqual(back.meter.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 4, 4], [3, 7, 8], [5, 5, 4]], 'every meter');
  assert.deepEqual(back.tempoMap.map((e) => e.beat), [0, 12, 19], 'every tempo change at its beat');
  back.tempoMap.forEach((e, i) => near(e.bpm, heard([96, 72, 132][i]), 1e-9, `tempo ${i + 1} at the value its FF 51 holds`));
  assert.deepEqual(back.markers.map((m) => m.name), ['I. Allegro', 'B', 'C'], 'the markers, as FF 06');
}

// ── EXPORT the roll and read it back: every part, meter, tempo and marker kind ─
{
  const bytes = encodeMidi(rollToMidiFile(roll()));
  const back = midiFileToRollParts(parseMidi(bytes), 'rt');
  assert.deepEqual(back.parts.map((p) => [p.track.name, p.track.program]), parts.map((p) => [p.name, p.program]), 'every part on its program');
  assert.deepEqual(back.parts.map((p) => p.notes.length), parts.map((p) => p.notes.length));
  assert.deepEqual(back.tempoMap.map((e) => [e.beat, e.bpm]), roll().tempoMap.map((e) => [e.beat, e.bpm]), 'the tempo map exactly');
  assert.deepEqual(back.meter.meterMap, roll().meterMap, 'the meter map exactly');
  assert.deepEqual(back.markers.map((m) => [m.tick, m.name, m.kind]), roll().markers.map((m) => [m.tick, m.name, m.kind]), 'each marker with its place and kind');
}

function near(a: number, b: number, eps: number, msg: string): void {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
}

console.log('symphonyEndToEnd: ok');
