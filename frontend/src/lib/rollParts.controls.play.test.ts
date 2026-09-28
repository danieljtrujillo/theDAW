/**
 * An orchestral MIDI file with its controller changes, into 24 parts, played
 * live on the audio clock with every volume, pan, expression, modulation and
 * pedal change in time.
 *
 * The sequence: a type-1 file of 24 named tracks built on the notes of a real
 * quartet (bars 530-549 of Beethoven's Op. 132, tests/fixtures/quartet: the
 * 4/4 bars and the change to 3/8), more tracks than channels as orchestral
 * files have them, a setup-style controller stream on each channel (volume,
 * pan, expression swells, a harp pedal, violin vibrato), and a percussion
 * track on channel 16 whose bank select (General MIDI 2's 120) names a drum
 * kit. IMPORT must
 * give every part its channel's changes and put the kit on the percussion
 * channel. PLAY (lib/rollPartPlay, the scheduler PianoRoll's transport runs)
 * ticks every 25 ms with up to 18 ms of timer jitter: every change must go out
 * once on its part's live channel at the context time its tick has, and the
 * notes of all 24 parts too. Starting halfway sends the state each controller
 * has there first; a mute puts the part's channel back, pedal up first; STOP
 * puts every channel back after the last change sent; a loop sends the state
 * again each time it starts over.
 *
 *   cd frontend && npx tsx src/lib/rollParts.controls.play.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeMidi, parseMidi, type MidiControl, type MidiFileData, type MidiTrack } from './midi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { endRollGesture, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS, type ScheduledRollNote, type ScheduledWheel } from './rollPartPlay.ts';
import { stepClock } from './rollTempo.ts';
import { isPercussionPart, rollLiveChannels } from './rollTracks.ts';

const fixture = fileURLToPath(new URL('../../../tests/fixtures/quartet/op132_m530-640.mid', import.meta.url));
const quartet = parseMidi(new Uint8Array(readFileSync(fixture)));
const FPPQ = quartet.ppq; // 480
assert.equal(FPPQ, 480);
// Bars 530-541 are 4/4 (12 bars), 542 on 3/8: the first 20 bars reach 8 bars into the 3/8.
const END_TICK = 12 * 4 * FPPQ + 8 * 1.5 * FPPQ;

/** 24 parts: name, zero-based channel, GM program, bank, and the quartet part it plays. */
const ORCHESTRA: Array<{ name: string; channel: number; program: number; bank?: number; from: number }> = [
  { name: 'Flute 1', channel: 0, program: 73, from: 0 },
  { name: 'Flute 2', channel: 0, program: 73, from: 1 },
  { name: 'Oboe 1', channel: 1, program: 68, from: 0 },
  { name: 'Oboe 2', channel: 1, program: 68, from: 1 },
  { name: 'Clarinet in B♭ 1', channel: 2, program: 71, from: 1 },
  { name: 'Clarinet in B♭ 2', channel: 2, program: 71, from: 2 },
  { name: 'Bassoon 1', channel: 3, program: 70, from: 2 },
  { name: 'Bassoon 2', channel: 3, program: 70, from: 3 },
  { name: 'Horn in F 1', channel: 4, program: 60, from: 1 },
  { name: 'Horn in F 2', channel: 4, program: 60, from: 2 },
  { name: 'Trumpet in B♭', channel: 5, program: 56, from: 0 },
  { name: 'Trombone', channel: 6, program: 57, from: 2 },
  { name: 'Tuba', channel: 7, program: 58, from: 3 },
  { name: 'Timpani', channel: 8, program: 47, from: 3 },
  { name: 'Harp', channel: 10, program: 46, from: 2 },
  { name: 'Celesta', channel: 11, program: 8, from: 0 },
  { name: 'Violin I', channel: 12, program: 40, from: 0 },
  { name: 'Violin II', channel: 12, program: 40, from: 1 },
  { name: 'Viola', channel: 13, program: 41, from: 2 },
  { name: 'Violoncello', channel: 14, program: 42, from: 3 },
  { name: 'Contrabass', channel: 14, program: 43, from: 3 },
  { name: 'Soprano', channel: 11, program: 52, from: 0 },
  { name: 'Alto', channel: 13, program: 52, from: 1 },
  { name: 'Percussion', channel: 15, program: 0, bank: 120, from: 3 },
];

// Each channel's controller stream, carried by the first track on the channel.
const quarter = FPPQ;
const cc = (tick: number, channel: number, controller: number, value: number): MidiControl => ({ tick, channel, controller, value });
const channelControls = (ch: number): MidiControl[] => {
  const out: MidiControl[] = [cc(0, ch, 7, 80 + ch), cc(0, ch, 10, (ch * 9) % 128)];
  // An expression swell every two bars of 4/4.
  for (let t = 0; t < END_TICK; t += 8 * quarter) out.push(cc(t + 4 * quarter, ch, 11, 100), cc(t + 6 * quarter, ch, 11, 64));
  if (ch === 10) for (let t = 0; t < END_TICK; t += 4 * quarter) out.push(cc(t, ch, 64, 127), cc(t + 3 * quarter, ch, 64, 0)); // the harp's pedal
  if (ch === 12) out.push(cc(2 * quarter, ch, 1, 40), cc(20 * quarter, ch, 1, 0)); // violin vibrato
  return out.sort((a, b) => a.tick - b.tick);
};

const firstOnChannel = new Map<number, number>();
ORCHESTRA.forEach((o, k) => {
  if (!firstOnChannel.has(o.channel)) firstOnChannel.set(o.channel, k);
});
const tracks: MidiTrack[] = ORCHESTRA.map((o, k) => ({
  name: o.name,
  notes: quartet.tracks[o.from].notes
    .filter((n) => n.tick < END_TICK)
    .map((n) => ({ ...n, channel: o.channel, note: o.channel === 15 ? [36, 38, 42, 49][n.note % 4] : n.note })),
  programs: [{ tick: 0, channel: o.channel, program: o.program, ...(o.bank !== undefined ? { bank: o.bank } : {}) }],
  ...(firstOnChannel.get(o.channel) === k ? { controls: channelControls(o.channel) } : {}),
}));
const file: MidiFileData = { ppq: FPPQ, bpm: quartet.bpm, tempos: quartet.tempos, timeSignatures: quartet.timeSignatures, tracks };
const parsed = parseMidi(encodeMidi(file));
assert.equal(parsed.tracks.length, 24);

// ── IMPORT ────────────────────────────────────────────────────────────────────
const done = importMidiParts(parsed, 'cc');
assert.equal(done.parts, 24);
const parts = rollTracksOf(usePianoRollStore.getState());
parts.forEach((p, k) => {
  const o = ORCHESTRA[k];
  assert.equal(p.name, o.name);
  const want = channelControls(o.channel).map((c) => ({ tick: c.tick * 2, controller: c.controller, value: c.value }));
  assert.deepEqual(p.controls, want, `${o.name} carries its channel's controller changes, on the roll's clock`);
  if (o.channel === 15) {
    assert.ok(isPercussionPart(p), 'the drum-bank track is percussion');
    assert.equal(p.bank, 0);
  } else assert.equal(p.program, o.program);
});
const roll0 = usePianoRollStore.getState();
assert.deepEqual(
  roll0.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]),
  [[0, 4, 4], [12, 3, 8], [65, 4, 4], [96, 3, 8]],
  "every time signature of the quartet's file is on the roll",
);

// ── PLAY from the top ─────────────────────────────────────────────────────────
usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
const voiceOf = (id: string) => {
  const p = rollTracksOf(usePianoRollStore.getState()).find((t) => t.id === id);
  return p ? { program: p.program ?? 0, bank: p.bank, percussion: isPercussionPart(p) } : undefined;
};
const live = rollLiveChannels(parts, roll0.lanes, roll0.bends);
const t0 = 20;
const origin = t0 + 0.06;
const start = usePianoRollStore.getState();
const clock = stepClock(start.bpm, start.tempoMap);
const totalSteps = start.totalSteps;
const endSec = clock.at(totalSteps);
const scheduler = createRollScheduler({ ...start, tracks: rollTracksOf(start) }, origin, ROLL_LOOKAHEAD_SEC);
let now = t0;
let seed = 11;
const jitter = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648) * 0.018;
};
const notes: ScheduledRollNote[] = [];
const controls: ScheduledWheel[] = [];
let ticks = 0;
while (now < origin + endSec - ROLL_LOOKAHEAD_SEC) {
  const st = usePianoRollStore.getState();
  const out = scheduler.tick(now, { ...st, tracks: rollTracksOf(st) }, voiceOf);
  for (const n of out.notes) if (n.abs < totalSteps - 1e-9) notes.push(n);
  for (const w of out.wheels) if (w.kind === 'control') controls.push(w);
  ticks += 1;
  now += ROLL_TICK_MS / 1000 + jitter();
}
const heardEnd = origin + endSec - ROLL_LOOKAHEAD_SEC;

// Every change of every part, once, on the part's live channel, at its tick's context time.
let expected = 0;
let maxDrift = 0;
for (const p of parts) {
  const ch = live.get(p.id)!.base;
  for (const c of p.controls ?? []) {
    const at = origin + clock.at(c.tick / 240);
    if (at >= heardEnd) continue;
    expected += 1;
    const hits = controls.filter((w) => w.channel === ch && w.controller === c.controller && Math.abs((w.time ?? 0) - at) < 1e-6 && w.value === c.value);
    assert.ok(hits.length >= 1, `${p.name}: controller ${c.controller} = ${c.value} at ${at.toFixed(4)} s`);
    maxDrift = Math.max(maxDrift, ...hits.map((w) => Math.abs((w.time ?? 0) - at)));
  }
}
// Parts on one file channel play on live channels of their own, so each gets the changes: no message is doubled on a live channel.
const keys = controls.map((w) => `${w.channel}|${w.controller}|${w.value}|${(w.time ?? 0).toFixed(9)}`);
assert.equal(new Set(keys).size, keys.length, 'no controller message is sent twice');
// Past the start only the file's own changes go out: each part's changes once per live channel.
const later = controls.filter((w) => (w.time ?? 0) > origin + 1e-9).length;
const laterExpected = parts.reduce((s, p) => s + (p.controls ?? []).filter((c) => c.tick > 0 && origin + clock.at(c.tick / 240) < heardEnd).length, 0);
assert.equal(later, laterExpected, `every later change once (${later} of ${laterExpected})`);
console.log(`  24 parts, ${expected} controller changes over ${ticks} ticks with up to 18 ms timer jitter: max drift ${(maxDrift * 1e6).toFixed(3)} us`);
assert.ok(maxDrift < 1e-6, 'every controller change lands on the audio clock');
// The notes too.
let noteDrift = 0;
for (const n of notes) noteDrift = Math.max(noteDrift, Math.abs(n.when - (origin + clock.at(n.abs))));
const totalNotes = parts.reduce((s, p) => s + p.notes.filter((x) => origin + clock.at(x.step) < heardEnd).length, 0);
assert.ok(notes.length >= totalNotes, `every note sounds (${notes.length} of ${totalNotes})`);
console.log(`  ${notes.length} notes of 24 parts: max onset drift ${(noteDrift * 1e6).toFixed(3)} us`);
assert.ok(noteDrift < 1e-6);

// ── STOP puts every channel back, pedal up first, after the last change sent ─
{
  const lastSent = Math.max(...controls.map((w) => w.time ?? 0));
  const released = scheduler.release(now).filter((w) => w.kind === 'control');
  const harp = live.get(parts[14].id)!.base;
  const harpReset = released.filter((w) => w.channel === harp);
  assert.equal(harpReset[0].controller, 64, "the harp's pedal comes up first");
  assert.equal(harpReset[0].value, 0);
  assert.deepEqual(new Set(harpReset.map((w) => w.controller)), new Set([64, 7, 10, 11]));
  assert.deepEqual(harpReset.find((w) => w.controller === 7)?.value, 100, 'volume back to where a channel starts');
  assert.ok(released.every((w) => (w.time ?? 0) > lastSent), 'after the last change sent');
  assert.equal(new Set(released.map((w) => w.channel)).size, 24, 'every live channel the playback touched');
}

// ── Starting halfway: each controller's state there first ────────────────────
{
  const from = 4 * 4 * 4 + 5; // step 69: inside bar 5, the harp's pedal down, a swell up
  usePianoRollStore.setState({ currentStep: from });
  const st = usePianoRollStore.getState();
  const s2 = createRollScheduler({ ...st, tracks: rollTracksOf(st) }, origin, ROLL_LOOKAHEAD_SEC);
  const out = s2.tick(t0, { ...st, tracks: rollTracksOf(st) }, voiceOf);
  const harp = parts[14];
  const ch = live.get(harp.id)!.base;
  const at = out.wheels.filter((w) => w.kind === 'control' && w.channel === ch && Math.abs((w.time ?? 0) - origin) < 1e-9);
  const tick = from * 240;
  const state = (controller: number) => [...(harp.controls ?? [])].filter((c) => c.controller === controller && c.tick < tick).pop()?.value;
  for (const controller of [7, 10, 11, 64]) {
    assert.equal(at.find((w) => w.controller === controller)?.value, state(controller), `controller ${controller} starts at its value at step ${from}`);
  }
  assert.equal(state(64), 127, 'the pedal is down there, so PLAY starts with it down');
  usePianoRollStore.setState({ currentStep: 0 });
}

// ── An edit while playing re-reads the parts and sends no controller twice ──
{
  // One part with no controllers at all (its changes cleared), so the plan holds parts of both kinds.
  endRollGesture();
  usePianoRollStore.getState().setTrackControls(parts[23].id, null);
  const st = usePianoRollStore.getState();
  const s5 = createRollScheduler({ ...st, tracks: rollTracksOf(st) }, origin, ROLL_LOOKAHEAD_SEC);
  s5.tick(t0, { ...st, tracks: rollTracksOf(st) }, voiceOf);
  // A note drawn in the part being edited gives the scheduler new parts to read (its own undo step, taken back after).
  endRollGesture();
  usePianoRollStore.getState().addNote({ note: 72, step: 40, length: 2, velocity: 90 });
  const cur = usePianoRollStore.getState();
  const out = s5.tick(t0 + 0.03, { ...cur, tracks: rollTracksOf(cur) }, voiceOf);
  // Every controller message of that window is one of the file's changes at its own time: no state sent again, no reset.
  const own = new Set(
    rollTracksOf(cur).flatMap((p) => (p.controls ?? []).map((c) => `${live.get(p.id)!.base}|${c.controller}|${c.value}|${(origin + clock.at(c.tick / 240)).toFixed(9)}`)),
  );
  const sent = out.wheels.filter((w) => w.kind === 'control');
  assert.ok(sent.every((w) => own.has(`${w.channel}|${w.controller}|${w.value}|${(w.time ?? 0).toFixed(9)}`)), 'only the changes the window reaches');
  usePianoRollStore.getState().undo();
  usePianoRollStore.getState().undo();
  assert.equal(rollTracksOf(usePianoRollStore.getState())[23].controls?.length, channelControls(15).length, 'both edits taken back');
}

// ── A mute puts the part's channel back while the others play on ──────────────
{
  const st = usePianoRollStore.getState();
  const s3 = createRollScheduler({ ...st, tracks: rollTracksOf(st) }, origin, ROLL_LOOKAHEAD_SEC);
  s3.tick(t0, { ...st, tracks: rollTracksOf(st) }, voiceOf);
  const harp = parts[14];
  usePianoRollStore.getState().setTrackMute(harp.id, true);
  const muted = usePianoRollStore.getState();
  const out = s3.tick(t0 + 0.03, { ...muted, tracks: rollTracksOf(muted) }, voiceOf);
  const ch = live.get(harp.id)!.base;
  const resets = out.wheels.filter((w) => w.kind === 'control' && w.channel === ch);
  assert.equal(resets[0]?.controller, 64, "the muted harp's pedal comes up first");
  assert.equal(resets[0]?.value, 0);
  assert.ok(out.notes.every((n) => n.partId !== harp.id), 'the muted harp is silent');
  usePianoRollStore.getState().setTrackMute(harp.id, false);
}

// ── A loop sends the state where it starts each time it starts over ───────────
{
  // Bars 2-3 (steps 16-48): the harp's pedal goes down at each bar line, up three beats later.
  usePianoRollStore.getState().setLoop({ start: 18, end: 34 });
  usePianoRollStore.setState({ currentStep: 18 });
  const st = usePianoRollStore.getState();
  const s4 = createRollScheduler({ ...st, tracks: rollTracksOf(st) }, origin, ROLL_LOOKAHEAD_SEC);
  const harp = parts[14];
  const ch = live.get(harp.id)!.base;
  const got: ScheduledWheel[] = [];
  for (let t = t0; t < t0 + 20; t += 0.025) {
    const cur = usePianoRollStore.getState();
    for (const w of s4.tick(t, { ...cur, tracks: rollTracksOf(cur) }, voiceOf).wheels) if (w.kind === 'control' && w.channel === ch && w.controller === 64) got.push(w);
  }
  // Step 18 sits inside bar 2 (starting at step 16), two steps after the pedal went down: each lap starts with it down.
  const lapSec = clock.at(34) - clock.at(18);
  const lapStarts = got.filter((w) => w.value === 127 && Math.abs((((w.time ?? 0) - origin) % lapSec + lapSec) % lapSec) < 1e-6);
  assert.ok(lapStarts.length >= 3, `the pedal is sent down at each lap start (${lapStarts.length})`);
  usePianoRollStore.getState().setLoop(null);
}

console.log('rollParts.controls.play: ok');
