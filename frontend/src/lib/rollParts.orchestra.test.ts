/**
 * An orchestral MIDI file into the piano roll's parts, and 24 parts played
 * live on the audio clock.
 *
 * The sequence a user makes: IMPORT a type-1 orchestral file of 24 named
 * tracks (woodwinds, brass, timpani, a percussion track on MIDI channel 10,
 * harp, celesta, strings, choir), each with its own program change, three
 * tempos and three time signatures (4/4, 7/8 3+2+2, 5/4). More tracks than a
 * file has channels, so several share one, each with its own program, as
 * orchestral files do. Every track must open as its own part on its own
 * instrument, with the tempo map and the meter map intact. Then PLAY: the
 * roll's scheduler (lib/rollPartPlay, the code PianoRoll's transport runs)
 * ticks every 25 ms with timer jitter, and every note of every part must be
 * scheduled exactly once, on its part's own channel and program, at the
 * context time the tempo map gives its step. Onset drift against the audio
 * clock is measured and printed.
 *
 * Before parts, the import put every track into one flat layer on one
 * program, and the scheduler played that one layer on one program.
 *
 *   cd frontend && npx tsx src/lib/rollParts.orchestra.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, tempoMicros, tempoOfMicros, type MidiFileData, type MidiTrack } from './midi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS, type ScheduledRollNote } from './rollPartPlay.ts';
import { rollPartVoices } from './rollPartVoice.ts';
import { stepClock } from './rollTempo.ts';
import { isPercussionPart } from './rollTracks.ts';
import { useEditorStore } from '../state/editorStore.ts';

const PPQ = 480;
// Bars 1-4 in 4/4 at 120, bars 5-8 in 7/8 (3+2+2) at 96, bars 9-12 in 5/4 at 132.
const BAR_TICKS = [...Array(4).fill(4 * PPQ), ...Array(4).fill(3.5 * PPQ), ...Array(4).fill(5 * PPQ)] as number[];
const barStart = (bar: number) => BAR_TICKS.slice(0, bar).reduce((a, b) => a + b, 0);

/** The orchestra: name, zero-based channel, GM program, and a register to play in. */
const ORCHESTRA: Array<{ name: string; channel: number; program: number; low: number }> = [
  { name: 'Piccolo', channel: 0, program: 72, low: 76 },
  { name: 'Flute 1', channel: 1, program: 73, low: 72 },
  { name: 'Flute 2', channel: 1, program: 73, low: 67 },
  { name: 'Oboe 1', channel: 2, program: 68, low: 69 },
  { name: 'Oboe 2', channel: 2, program: 68, low: 64 },
  { name: 'Clarinet in B♭ 1', channel: 3, program: 71, low: 62 },
  { name: 'Clarinet in B♭ 2', channel: 3, program: 71, low: 57 },
  { name: 'Bassoon 1', channel: 4, program: 70, low: 48 },
  { name: 'Bassoon 2', channel: 4, program: 70, low: 43 },
  { name: 'Horn in F 1', channel: 5, program: 60, low: 60 },
  { name: 'Horn in F 2', channel: 5, program: 60, low: 55 },
  { name: 'Trumpet in B♭', channel: 6, program: 56, low: 67 },
  { name: 'Trombone', channel: 7, program: 57, low: 50 },
  { name: 'Tuba', channel: 8, program: 58, low: 36 },
  { name: 'Timpani', channel: 10, program: 47, low: 43 },
  { name: 'Percussion', channel: 9, program: 48, low: 38 },
  { name: 'Harp', channel: 11, program: 46, low: 55 },
  { name: 'Celesta', channel: 12, program: 8, low: 79 },
  { name: 'Violin I', channel: 13, program: 40, low: 76 },
  { name: 'Violin II', channel: 13, program: 40, low: 69 },
  { name: 'Viola', channel: 14, program: 41, low: 60 },
  { name: 'Violoncello', channel: 15, program: 42, low: 48 },
  // Two more parts than channels: these share channels with other programs.
  { name: 'Contrabass', channel: 15, program: 43, low: 36 },
  { name: 'Choir Aahs', channel: 14, program: 52, low: 60 },
];

/** Each part plays a quarter-note line through all twelve bars, a different pitch per beat. */
const tracks: MidiTrack[] = ORCHESTRA.map((o, k) => {
  const notes = [];
  for (let bar = 0; bar < BAR_TICKS.length; bar += 1) {
    for (let t = 0; t < BAR_TICKS[bar]; t += PPQ) {
      const beat = t / PPQ;
      notes.push({
        tick: barStart(bar) + t,
        note: o.channel === 9 ? [36, 38, 42, 49][beat % 4] : o.low + ((bar + beat + k) % 5),
        velocity: 60 + ((bar * 7 + beat * 5 + k) % 60),
        durationTicks: PPQ / 2,
        channel: o.channel,
      });
    }
  }
  return { name: o.name, notes, programs: [{ tick: 0, channel: o.channel, program: o.program }] };
});
const file: MidiFileData = {
  ppq: PPQ,
  bpm: 120,
  tempos: [{ tick: 0, bpm: 120 }, { tick: barStart(4), bpm: 96 }, { tick: barStart(8), bpm: 132 }],
  timeSignatures: [
    { tick: 0, num: 4, den: 4 },
    { tick: barStart(4), num: 7, den: 8, groups: [3, 2, 2] },
    { tick: barStart(8), num: 5, den: 4 },
  ],
  tracks,
};
const totalNotes = tracks.reduce((n, t) => n + t.notes.length, 0);

// ── IMPORT ───────────────────────────────────────────────────────────────────
useEditorStore.getState().loadProject({ tracks: [], clips: [] });
const bytes = encodeMidi(file);
const parsed = parseMidi(bytes);
assert.equal(parsed.tracks.length, 24, 'the file has 24 tracks');
assert.equal(parsed.tracks[5].name, 'Clarinet in B♭ 1', 'a track name keeps its flat sign through the file (UTF-8)');
assert.deepEqual(parsed.tracks[3].programs, [{ tick: 0, channel: 2, program: 68 }], "a track's program change is read");

const done = importMidiParts(parsed, 'orch');
assert.equal(done.into, 'parts', 'a file of 24 tracks replaces the parts');
assert.equal(done.parts, 24);
assert.equal(done.notes, totalNotes, 'every note arrives');
const roll = usePianoRollStore.getState();
const parts = rollTracksOf(roll);
assert.equal(parts.length, 24, 'one part per track');
ORCHESTRA.forEach((o, k) => {
  const p = parts[k];
  assert.equal(p.name, o.name, `part ${k + 1} is named after its track`);
  assert.equal(p.program, o.program, `${o.name} plays program ${o.program}, its own track's, even on a shared channel`);
  assert.equal(p.channel, o.channel === 9 ? 10 : o.channel + 1, `${o.name} keeps its channel`);
  assert.equal(isPercussionPart(p), o.channel === 9, `${o.name} is ${o.channel === 9 ? '' : 'not '}percussion`);
  assert.equal(p.notes.length, tracks[k].notes.length, `${o.name} holds its own notes`);
  assert.ok(p.notes.every((n) => tracks[k].notes.some((m) => m.note === n.note)), `${o.name} holds no other part's pitches`);
});
assert.equal(parts[1].instrumentId, 'flute', 'a registry instrument by name');
assert.equal(parts[9].instrumentId, 'horn');
assert.equal(parts[18].instrumentId, 'violin');
assert.equal(parts[15].instrumentId, 'drum-kit', 'the channel-10 track is the drum kit');
// The tempo map: 120 at beat 0, 96 at bar 5 (beat 16), 132 at bar 9 (beat 30),
// each as its FF 51 holds it (132 is 454545 us, 132.000132 BPM).
const ff51 = (bpm: number): number => tempoOfMicros(tempoMicros(bpm));
assert.deepEqual(
  roll.tempoMap.map((e) => [e.beat, e.bpm]),
  [[0, 120], [16, ff51(96)], [30, ff51(132)]],
  'every tempo change is on the roll, at its beat',
);
assert.deepEqual(
  roll.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den, s.meter.groups.join('+')]),
  [[0, 4, 4, ''], [4, 7, 8, '3+2+2'], [8, 5, 4, '']],
  'every time signature is on the roll, with its grouping',
);
const totalSteps = BAR_TICKS.reduce((a, b) => a + b, 0) / (PPQ / 4);
assert.equal(roll.totalSteps, totalSteps, 'the grid ends on the last bar line');

// ── PLAY: 24 parts on the audio clock ────────────────────────────────────────
usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
const start = usePianoRollStore.getState();
const t0 = 10;
const origin = t0 + 0.06; // rollPlayOrigin: 60 ms after PLAY
const scheduler = createRollScheduler({ ...start, tracks: rollTracksOf(start) }, origin, ROLL_LOOKAHEAD_SEC);
const clock = stepClock(start.bpm, start.tempoMap);
const endSec = clock.at(totalSteps);
const heard: ScheduledRollNote[] = [];
// Timer ticks every 25 ms, each late by up to 18 ms (a busy main thread), deterministic.
let now = t0;
let seed = 7;
const jitter = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648) * 0.018;
};
let ticks = 0;
// What one tick costs on the main thread: the store read, every part's voice and the scheduling.
const tickMs: number[] = [];
while (now < origin + endSec - ROLL_LOOKAHEAD_SEC) {
  const began = performance.now();
  const state = usePianoRollStore.getState();
  const voices = rollPartVoices();
  const out = scheduler.tick(now, { ...state, tracks: rollTracksOf(state) }, (id) => voices.get(id));
  tickMs.push(performance.now() - began);
  for (const n of out.notes) if (n.abs < totalSteps - 1e-9) heard.push(n);
  ticks += 1;
  now += ROLL_TICK_MS / 1000 + jitter();
}
const sortedMs = [...tickMs].sort((a, b) => a - b);
console.log(`  tick cost over ${ticks} ticks: median ${sortedMs[Math.floor(ticks / 2)].toFixed(3)} ms, 99th percentile ${sortedMs[Math.floor(ticks * 0.99)].toFixed(3)} ms (the first tick unrolls every part)`);
assert.ok(ticks > 700, `the scheduler ran ${ticks} ticks`);
assert.equal(heard.length, totalNotes, `every note of every part is scheduled once (${heard.length} of ${totalNotes})`);
const keys = new Set(heard.map((n) => `${n.partId}|${n.abs}|${n.note}`));
assert.equal(keys.size, heard.length, 'no note is scheduled twice');

// Each note at the context time its step has under the tempo map.
let maxDrift = 0;
let late = 0;
for (const n of heard) {
  const expected = origin + clock.at(n.abs);
  const drift = Math.abs(n.when - expected);
  maxDrift = Math.max(maxDrift, drift);
  if (n.when > expected + 1e-9) late += 1;
}
console.log(`  24 parts, ${heard.length} notes, ${ticks} ticks with up to 18 ms timer jitter: max onset drift ${(maxDrift * 1e6).toFixed(3)} us, ${late} late`);
assert.equal(late, 0, 'no note sounds late');
assert.ok(maxDrift < 1e-6, `onsets land on the audio clock (max drift ${maxDrift} s)`);

// Each part on its own channel and program.
const byPart = new Map<string, ScheduledRollNote[]>();
for (const n of heard) byPart.set(n.partId, [...(byPart.get(n.partId) ?? []), n]);
assert.equal(byPart.size, 24, 'all 24 parts sound');
const channelOf = new Map<string, number>();
parts.forEach((p, k) => {
  const notes = byPart.get(p.id) ?? [];
  const channels = new Set(notes.map((n) => n.channel));
  assert.equal(channels.size, 1, `${p.name} plays on one channel`);
  const ch = [...channels][0];
  channelOf.set(p.id, ch);
  assert.ok(notes.every((n) => n.program === ORCHESTRA[k].program), `${p.name} plays program ${ORCHESTRA[k].program}`);
  if (isPercussionPart(p)) assert.ok(notes.every((n) => n.percussion) && ch % 16 === 9, 'the percussion part plays on a drum channel');
  else assert.ok(ch % 16 !== 9, `${p.name} is never on a drum channel`);
});
assert.equal(new Set(channelOf.values()).size, 24, 'no two parts share a live channel');

// A mute while playing silences that part from the next window on, and every other part plays on.
{
  const muteState = usePianoRollStore.getState();
  const s2 = createRollScheduler({ ...muteState, tracks: rollTracksOf(muteState) }, origin, ROLL_LOOKAHEAD_SEC);
  usePianoRollStore.getState().setTrackMute(parts[18].id, true);
  const st = usePianoRollStore.getState();
  const voices = rollPartVoices();
  const out = s2.tick(t0, { ...st, tracks: rollTracksOf(st) }, (id) => voices.get(id));
  assert.ok(out.notes.length > 0);
  assert.ok(out.notes.every((n) => n.partId !== parts[18].id), 'the muted Violin I is silent');
  assert.equal(new Set(out.notes.map((n) => n.partId)).size, 23, 'the 23 others sound');
  usePianoRollStore.getState().setTrackMute(parts[18].id, false);
}

console.log('rollParts.orchestra: ok');
