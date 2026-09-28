/**
 * EDIT's live MIDI on the audio clock (lib/editMidiScheduler), replayed from an
 * arrangement built with the editor store calls EDIT makes, planned with the
 * function play() uses (liveMixer planLiveMidi) and ticked on a jittery timer
 * against a fake audio clock.
 *
 * Before this module every note-on and note-off was a window.setTimeout with no
 * audio-clock time: a note sounded whenever the timer ran, a note already
 * sounding at the start point was skipped, a clip's pitch bends, gain and fades
 * were ignored, and an edit while playing waited for the next Play. Here each
 * of those is replayed and checked against the time the clip's audio would
 * sound at. Run from `frontend/`:
 *   npx tsx src/lib/editMidiScheduler.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore, type AudioClip } from '../state/editorStore.ts';
import { planLiveMidi, liveMidiTrackStatus } from '../state/liveMixer.ts';
import {
  EDIT_MIDI_LOOKAHEAD_SEC,
  EDIT_MIDI_TICK_MS,
  EditMidiScheduler,
  clipLiveTiming,
  type EditMidiPass,
  type EnvelopeParam,
} from './editMidiScheduler.ts';
import { rollClipFields } from './rollClip.ts';
import { stepClock } from './rollTempo.ts';
import { BEND_CENTER, bendValueToRaw } from './pitchBend.ts';
import type { GlobalVoice } from './clipProgram.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';
import type { TempoEvent } from './tempoMap.ts';

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

const near = (a: number, b: number, eps: number, msg: string) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (|d| ${Math.abs(a - b)})`);

const ed = () => useEditorStore.getState();
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const BPM = 120;
const STEP = 60 / BPM / 4; // a 16th at 120

type Msg =
  | { k: 'on'; ch: number; program: number; midi: number; vel: number; t: number; at: number }
  | { k: 'off'; ch: number; midi: number; t: number; at: number }
  | { k: 'wheel'; ch: number; raw: number; t: number; at: number }
  | { k: 'range'; ch: number; semis: number; t: number; at: number }
  | { k: 'cc'; ch: number; controller: number; value: number; t: number; at: number };

/** A fake audio clock, a recording synth and a recording envelope per track. */
function rig(opts: { lookahead?: number } = {}) {
  const clock = { t: 100 };
  const msgs: Msg[] = [];
  const env = new Map<string, Array<{ op: string; v?: number; t: number }>>();
  const param = (id: string): EnvelopeParam => {
    const log = env.get(id) ?? [];
    env.set(id, log);
    return {
      setValueAtTime: (v: number, t: number) => log.push({ op: 'set', v, t }),
      linearRampToValueAtTime: (v: number, t: number) => log.push({ op: 'ramp', v, t }),
      cancelScheduledValues: (t: number) => log.push({ op: 'cancel', t }),
    };
  };
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (ch, program, midi, vel, t) => msgs.push({ k: 'on', ch, program, midi, vel, t, at: clock.t }),
      noteOff: (ch, midi, t) => msgs.push({ k: 'off', ch, midi, t, at: clock.t }),
      wheel: (ch, raw, t) => msgs.push({ k: 'wheel', ch, raw, t, at: clock.t }),
      wheelRange: (ch, semis, t) => msgs.push({ k: 'range', ch, semis, t, at: clock.t }),
      control: (ch, controller, value, t) => msgs.push({ k: 'cc', ch, controller, value, t, at: clock.t }),
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => SF,
    projectBpm: () => ed().bpm,
    envelope: param,
    lookaheadSec: () => opts.lookahead ?? EDIT_MIDI_LOOKAHEAD_SEC,
  });
  // A deterministic jittery timer: each tick is 25 ms late by up to 50 ms more.
  let seed = 7;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 0.05;
  };
  const runFor = (sec: number) => {
    const end = clock.t + sec;
    while (clock.t < end) {
      clock.t = Math.min(end, clock.t + EDIT_MIDI_TICK_MS / 1000 + jitter());
      sched.tick();
    }
  };
  return { clock, msgs, env, sched, runFor };
}

/** A MIDI clip as EDIT's insert adds it. */
function addMidi(trackId: string, fields: Partial<AudioClip>): string {
  return ed().addClipToTrack({
    trackId,
    label: 'part',
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 60,
    offsetIntoSource: 0,
    durationSec: 8,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [],
    sourceBpm: BPM,
    sourceTotalSteps: 64,
    ...fields,
  });
}

const note = (id: string, midi: number, step: number, length: number, lane?: number): PianoNote =>
  ({ id, note: midi, step, length, velocity: 100, ...(lane !== undefined ? { lane } : {}) }) as PianoNote;

function passOf(): EditMidiPass {
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  return { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
}

const ons = (msgs: Msg[]) => msgs.filter((m): m is Extract<Msg, { k: 'on' }> => m.k === 'on');
const offs = (msgs: Msg[]) => msgs.filter((m): m is Extract<Msg, { k: 'off' }> => m.k === 'off');

// ── 1. Every onset on the audio clock, 24 parts, a jittery timer ─────────────
run('24 parts: every note-on is stamped with the audio-clock time its clip sounds at, whatever the timer does', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const first = ed().tracks[0].id;
  const expected = new Map<string, number[]>();
  for (let p = 0; p < 24; p += 1) {
    const trackId = p === 0 ? first : ed().addTrack({ name: `Part ${p + 1}` });
    ed().updateTrack(trackId, { instrumentProgram: 40 + (p % 30) });
    // Each part: a note every 3 + p/8 steps across 16 s, so onsets fall everywhere.
    const notes: PianoNote[] = [];
    const period = 3 + p / 8;
    for (let s = 0; s * period < 120; s += 1) notes.push(note(`p${p}n${s}`, 48 + p, s * period, 1));
    const startSec = (p % 5) * 0.37;
    const id = addMidi(trackId, { startSec, durationSec: 16, sourcePianoRoll: notes, sourceTotalSteps: 128 });
    expected.set(id, notes.map((n) => startSec + n.step * STEP).filter((t) => t < startSec + 16));
  }
  const { clock, msgs, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  runFor(18);
  sched.stop();
  const on = ons(msgs);
  const total = [...expected.values()].reduce((a, b) => a + b.length, 0);
  assert.equal(on.length, total, 'every note is played exactly once');
  // Onset drift: the stamped time against the anchor's mapping of the note's transport time.
  const want = [...expected.values()].flat().map((t) => anchor + t).sort((a, b) => a - b);
  const got = on.map((m) => m.t).sort((a, b) => a - b);
  let worst = 0;
  got.forEach((t, i) => { worst = Math.max(worst, Math.abs(t - want[i])); });
  console.log(`    ${on.length} onsets over 24 parts, worst drift ${(worst * 1e3).toFixed(6)} ms`);
  assert.ok(worst < 1e-9, `worst onset drift ${worst}`);
  // Every message was handed over ahead of its time, never after it.
  for (const m of on) assert.ok(m.at <= m.t + 1e-12, `a note-on handed over ${(m.at - m.t) * 1e3} ms late`);
  // The timer never scheduled further than the lookahead ahead.
  for (const m of on) assert.ok(m.t - m.at <= EDIT_MIDI_LOOKAHEAD_SEC + 1e-9, 'within the lookahead');
  assert.deepEqual(sched.stats.late + sched.stats.skipped, 0);
});

// ── 2. Sub-step lengths, tempo maps, trims, held notes ───────────────────────
run('a triplet 32nd keeps its length; a tempo map times notes; a trimmed clip plays its window', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 0 });
  const third = 1 / 3;
  const ritard: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 120, curve: 'linear' }, { beat: 4, bpm: 60 }];
  const notes = [note('a', 60, 0, third), note('b', 62, third, third), note('c', 64, 12, 2), note('d', 65, 20, 1)];
  const id = addMidi(t0, { startSec: 1, durationSec: 5, offsetIntoSource: 0, sourcePianoRoll: notes, sourceTempoMap: ritard });
  const clock = stepClock(BPM, ritard);
  const { clock: c, msgs, sched, runFor } = rig();
  const anchor = c.t;
  sched.start(passOf(), 0, anchor);
  runFor(7);
  sched.stop();
  const on = ons(msgs);
  const off = offs(msgs);
  assert.equal(on.length, 4);
  notes.forEach((n, i) => {
    near(on[i].t, anchor + 1 + clock.at(n.step), 1e-9, `note ${n.id} onset through the map`);
    const o = off.find((m) => m.midi === n.note)!;
    near(o.t, anchor + 1 + clock.at(n.step + n.length), 1e-9, `note ${n.id} note-off`);
  });
  near(off[0].t - on[0].t, third * STEP, 1e-9, 'the triplet 32nd lasts a third of a 16th, not a 16th');
  assert.ok(ed().clips.some((x) => x.id === id));

  // Trimmed: the clip starts 2 steps into its source; a note running past its right edge is cut there.
  ed().loadProject({ tracks: [], clips: [] });
  const t1 = ed().tracks[0].id;
  ed().updateTrack(t1, { instrumentProgram: 0 });
  addMidi(t1, { startSec: 0, durationSec: 1, offsetIntoSource: 2 * STEP, sourcePianoRoll: [note('x', 60, 0, 1), note('y', 62, 4, 16)] });
  const r = rig();
  const a2 = r.clock.t;
  r.sched.start(passOf(), 0, a2);
  r.runFor(3);
  const on2 = ons(r.msgs);
  assert.equal(on2.length, 1, 'the note before the trim point is outside the window');
  near(on2[0].t, a2 + 2 * STEP, 1e-9, 'step 4 sounds 2 steps into the trimmed clip');
  near(offs(r.msgs).find((m) => m.midi === 62)!.t, a2 + 1, 1e-9, 'cut at the clip edge');
});

run('playing from the middle of a held chord starts the chord at the start point (not on a drum track)', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 48 });
  addMidi(t0, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('c', 60, 0, 32), note('e', 64, 0, 32), note('late', 67, 16, 4)] });
  const drums = ed().addTrack({ name: 'Drums' });
  ed().updateTrack(drums, { isPercussion: true });
  addMidi(drums, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('crash', 49, 0, 32)] });
  const { clock, msgs, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 1.5, anchor); // 1.5 s = step 12, inside the chord
  runFor(4);
  const on = ons(msgs);
  const chord = on.filter((m) => m.midi === 60 || m.midi === 64);
  assert.equal(chord.length, 2, 'both held notes start');
  for (const m of chord) near(m.t, anchor, 1e-9, 'at the start point');
  assert.equal(on.some((m) => m.midi === 49), false, 'the drum hit is its onset and is not struck again');
  near(on.find((m) => m.midi === 67)!.t, anchor + (16 * STEP - 1.5), 1e-9, 'the next note on time');
  near(offs(msgs).find((m) => m.midi === 60)!.t, anchor + (4 - 1.5), 1e-9, 'the chased note ends where it ends');
  assert.equal(sched.stats.chased, 2);
});

// ── 3. Bends ─────────────────────────────────────────────────────────────────
run('a clip whose lane bends plays that lane on a channel of its own with its range and wheel messages on time', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 56 });
  const lanes = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null }];
  const fields = rollClipFields({
    notes: [note('plain', 60, 0, 8, 0), note('bent', 72, 0, 8, 1)],
    bpm: BPM,
    totalSteps: 16,
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
    pickupSteps: 0,
    lanes,
    bends: [{ lane: 1, range: 12, points: [{ id: 'p0', step: 0, value: 0, shape: 'linear' }, { id: 'p1', step: 8, value: 1, shape: 'hold' }] }],
  });
  const clipId = addMidi(t0, { startSec: 0.5, durationSec: 2, ...fields });
  const pass = passOf();
  const chans = pass.channelsOf.get(t0)!;
  assert.equal(chans.length, 2, 'the track holds a second channel for its bent lane');
  assert.equal(liveMidiTrackStatus(ed().clips, ed().tracks, SF).get(t0)?.channels, 2, 'the header says so');
  const { clock, msgs, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(pass, 0, anchor);
  runFor(3);
  const on = ons(msgs);
  const bentOn = on.find((m) => m.midi === 72)!;
  const plainOn = on.find((m) => m.midi === 60)!;
  assert.notEqual(bentOn.ch, plainOn.ch, 'the bent lane is on its own channel');
  const ranges = msgs.filter((m): m is Extract<Msg, { k: 'range' }> => m.k === 'range' && m.ch === bentOn.ch);
  assert.equal(ranges[0].semis, 12, 'the lane\'s range');
  near(ranges[0].t, anchor + 0.5, 1e-9, 'set at the clip\'s start');
  const wheels = msgs.filter((m): m is Extract<Msg, { k: 'wheel' }> => m.k === 'wheel' && m.ch === bentOn.ch);
  assert.ok(wheels.length > 10, `a ramp sends a stair of wheel messages (${wheels.length})`);
  assert.equal(wheels[0].raw, BEND_CENTER, 'starting at the centre');
  const top = wheels[wheels.length - 1];
  assert.equal(top.raw, bendValueToRaw(1), 'ending at the top of the range');
  assert.ok(top.t <= anchor + 0.5 + 8 * STEP + 1e-9, 'the last message arrives by step 8');
  for (let i = 1; i < wheels.length; i += 1) assert.ok(wheels[i].t >= wheels[i - 1].t, 'in time order');
  // Each wheel message sits on the ramp at its own time.
  for (const w of wheels.slice(1, -1)) {
    const step = (w.t - anchor - 0.5) / STEP;
    const want = bendValueToRaw(Math.min(1, step / 8));
    assert.ok(Math.abs(w.raw - want) <= 700, `wheel ${w.raw} at step ${step.toFixed(3)} (curve ${want})`);
  }
  const plainWheels = msgs.filter((m) => m.k === 'wheel' && m.ch === plainOn.ch);
  assert.ok(plainWheels.every((m) => m.k === 'wheel' && m.raw === BEND_CENTER), 'the shared channel stays at the centre');
  assert.ok(clipId);
});

// ── 4. Clip gain and fades ───────────────────────────────────────────────────
run('clip gain and fades ride the track\'s envelope at the clip\'s times', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  addMidi(t0, { startSec: 1, durationSec: 4, gain: 0.5, fadeInSec: 1, fadeOutSec: 0.5, sourcePianoRoll: [note('a', 60, 0, 16)] });
  const { clock, env, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  runFor(1.2);
  const log = env.get(t0)!;
  assert.ok(log.length > 0, 'the envelope was scheduled');
  const ramps = log.filter((e) => e.op === 'ramp');
  const peak = Math.max(...log.filter((e) => e.v !== undefined).map((e) => e.v as number));
  near(peak, 0.5, 1e-9, 'the envelope rises to the clip gain');
  near(log.find((e) => e.op === 'set')!.t, anchor + 1, 1e-9, 'the fade-in starts at the clip start');
  near(ramps[0].t, anchor + 2, 1e-9, 'and reaches the gain one second later');
  assert.ok(ramps.some((e) => Math.abs(e.t - (anchor + 5)) < 1e-9 && e.v === 0), 'the fade-out lands on the clip end');

  // Changing the clip gain while it plays reschedules the envelope from now.
  const clipId = ed().clips[0].id;
  ed().updateClip(clipId, { gain: 0.25 });
  runFor(0.1);
  const after = log.slice(log.findIndex((e) => e.op === 'cancel' && e.t > anchor + 1.1));
  assert.ok(after.length > 1, 'cancelled and scheduled again');
  assert.ok(after.some((e) => e.v !== undefined && Math.abs((e.v as number) - 0.25) < 1e-9), 'to the new gain');
});

// ── 5. Re-read every tick ────────────────────────────────────────────────────
run('edits while playing land on the next tick: a moved note, a new program, a muted clip', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  const id = addMidi(t0, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('a', 60, 0, 30), note('b', 62, 16, 1), note('c', 64, 40, 1)] });
  const { clock, msgs, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  runFor(1);
  // Move b from step 16 (2 s) to step 20 (2.5 s), and switch the track to a cello.
  const clip = ed().clips.find((c) => c.id === id)!;
  ed().updateClip(id, { sourcePianoRoll: clip.sourcePianoRoll!.map((n) => (n.id === 'b' ? { ...n, step: 20 } : n)) });
  ed().updateTrack(t0, { instrumentProgram: 42 });
  runFor(2);
  const b = ons(msgs).find((m) => m.midi === 62)!;
  near(b.t, anchor + 20 * STEP, 1e-9, 'the moved note plays at its new place');
  assert.equal(b.program, 42, 'on the new program');
  // Mute the clip while note a is still held: it ends now and c never plays.
  ed().updateClip(id, { muted: true });
  const mutedAt = clock.t;
  runFor(2);
  const aOff = offs(msgs).find((m) => m.midi === 60)!;
  assert.ok(aOff.t >= mutedAt - 1e-9 && aOff.t < mutedAt + 0.1, 'the held note ends when the clip is muted');
  assert.equal(ons(msgs).some((m) => m.midi === 64), false, 'the muted clip plays nothing more');
  // A note added ahead of the cursor plays.
  ed().updateClip(id, { muted: false, sourcePianoRoll: [...ed().clips.find((c) => c.id === id)!.sourcePianoRoll!, note('n', 70, 56, 1)] });
  runFor(3);
  near(ons(msgs).find((m) => m.midi === 70)!.t, anchor + 56 * STEP, 1e-9, 'the added note plays on time');
});

// ── 6. Late ticks, the loop end, stop and seek ───────────────────────────────
run('a stalled timer chases held notes and skips finished ones, and counts them', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  addMidi(t0, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('short', 60, 4, 1), note('long', 62, 5, 20)] });
  const { clock, msgs, sched } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  clock.t = anchor + 1.5; // the tab was hidden for 1.5 s
  sched.tick();
  const on = ons(msgs);
  assert.equal(on.some((m) => m.midi === 60), false, 'the finished note is skipped, not fired late');
  const long = on.find((m) => m.midi === 62)!;
  near(long.t, clock.t, 1e-9, 'the held note starts now');
  assert.deepEqual({ late: sched.stats.late, skipped: sched.stats.skipped }, { late: 1, skipped: 1 });
});

run('nothing is scheduled at or past the loop end', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  addMidi(t0, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('in', 60, 6, 1), note('edge', 62, 8, 1), note('out', 64, 10, 1)] });
  const { clock, msgs, sched, runFor } = rig();
  sched.start(passOf(), 0, clock.t, () => 8 * STEP);
  runFor(2);
  const on = ons(msgs).map((m) => m.midi);
  assert.deepEqual(on, [60], 'only the note before the loop end');
});

run('stop cancels queued note-ons; a seek strikes its own note again after a cancel that would cut it', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  addMidi(t0, { startSec: 0, durationSec: 8, sourcePianoRoll: [note('a', 60, 8, 4)] });
  const { clock, msgs, sched } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  clock.t = anchor + 8 * STEP - 0.06; // the note is inside the lookahead now
  sched.tick();
  const queued = ons(msgs).find((m) => m.midi === 60)!;
  assert.ok(queued.t > clock.t, 'queued ahead of the clock');
  sched.stop();
  const cancel = offs(msgs).find((m) => m.midi === 60)!;
  near(cancel.t, queued.t, 1e-12, 'a note-off at the queued note-on\'s own time');
  // Seek back 0.02 s while the cancel is still queued: the pass's own note at the
  // same key falls before the cancel, so it is struck again right after it.
  const n0 = msgs.length;
  sched.start(passOf(), 8 * STEP - 0.02, clock.t);
  const again = ons(msgs.slice(n0)).filter((m) => m.midi === 60);
  assert.equal(again.length, 2, 'struck, then struck again after the cancel');
  assert.ok(again[1].t >= cancel.t - 1e-12);
});

// ── 7. Status for the header ─────────────────────────────────────────────────
run('the header status says which MIDI tracks play live and which play their bounce', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 40 });
  addMidi(t0, { sourcePianoRoll: [note('a', 60, 0, 1)] });
  const plain = ed().addTrack({ name: 'Plain' });
  addMidi(plain, { sourcePianoRoll: [note('a', 60, 0, 1)] });
  const status = liveMidiTrackStatus(ed().clips, ed().tracks, { useSoundfont: false, activeProgram: 0 });
  assert.equal(status.get(t0)?.mode, 'live');
  assert.equal(status.get(plain)?.mode, 'bounce', 'no program anywhere: its bounce');
  assert.match(status.get(plain)!.reason, /rendered audio/);
});

run('24 parts of 4000 notes: a clip is timed once per edit, and a tick costs a binary search per clip', () => {
  ed().loadProject({ tracks: [], clips: [] });
  const first = ed().tracks[0].id;
  for (let p = 0; p < 24; p += 1) {
    const trackId = p === 0 ? first : ed().addTrack({ name: `Part ${p + 1}` });
    ed().updateTrack(trackId, { instrumentProgram: 40 + p });
    const many: PianoNote[] = Array.from({ length: 4000 }, (_, i) => note(`p${p}n${i}`, 40 + ((i + p) % 40), i * 0.5, 0.5));
    addMidi(trackId, { durationSec: 300, sourcePianoRoll: many, sourceTotalSteps: 2048 });
  }
  const timing = clipLiveTiming(ed().clips[0], BPM);
  assert.equal(timing.notes.length, 4000);
  for (let i = 1; i < timing.notes.length; i += 1) assert.ok(timing.notes[i].on >= timing.notes[i - 1].on, 'sorted by onset');
  const { clock, sched } = rig();
  const pass = passOf();
  const t0 = performance.now();
  sched.prepare(pass); // liveMixer runs this before it takes the pass's anchor
  const prep = performance.now() - t0;
  const t1 = performance.now();
  sched.start(pass, 0, clock.t);
  const firstTick = performance.now() - t1;
  const ticks = 400;
  const t2 = performance.now();
  for (let i = 0; i < ticks; i += 1) {
    clock.t += EDIT_MIDI_TICK_MS / 1000;
    sched.tick();
  }
  const warm = (performance.now() - t2) / ticks;
  console.log(`    96000 notes: prepare ${prep.toFixed(1)} ms, first tick ${firstTick.toFixed(3)} ms, then ${warm.toFixed(3)} ms per tick`);
  assert.ok(firstTick < prep, 'the first tick reuses the prepared timing');
  assert.ok(firstTick < 5 && warm < 5, `a tick stays well inside the ${EDIT_MIDI_TICK_MS} ms timer`);
});

// ── 9. A part's controllers play live ───────────────────────────────────────
run("a roll part's controllers play live at their times, and each goes back to its default where the clip ends", () => {
  ed().loadProject({ tracks: [], clips: [] });
  const t0 = ed().tracks[0].id;
  ed().updateTrack(t0, { instrumentProgram: 0 });
  // Volume 96 and pan 40 from the start, the pedal down at beat 0.5 and up at beat 2, expression 80 at beat 2.
  const controls = [
    { tick: 0, controller: 7, value: 96 },
    { tick: 0, controller: 10, value: 40 },
    { tick: 480, controller: 64, value: 127 },
    { tick: 1920, controller: 64, value: 0 },
    { tick: 1920, controller: 11, value: 80 },
  ];
  const sourceRollPart = { doc: 'd', id: 'p', order: 0, name: 'Piano', program: 0, bank: 0, channel: 1, color: '#a855f7', mute: false, solo: false, controls };
  addMidi(t0, { startSec: 1, durationSec: 4, sourcePianoRoll: [note('a', 60, 0, 4), note('b', 64, 8, 4)], sourceRollPart });
  const { clock, msgs, sched, runFor } = rig();
  const anchor = clock.t;
  sched.start(passOf(), 0, anchor);
  runFor(6);
  sched.stop();
  const cc = msgs.filter((m): m is Extract<Msg, { k: 'cc' }> => m.k === 'cc');
  const at = (sec: number) => anchor + 1 + sec;
  assert.deepEqual(
    cc.map((m) => [Math.round((m.t - anchor) * 1000) / 1000, m.controller, m.value]),
    [
      // At the clip's start, every controller the part uses at the value it holds there: the pedal
      // up and expression at its default (their changes come later), then volume and pan's own changes.
      [1, 64, 0],
      [1, 11, 127],
      [1, 7, 96],
      [1, 10, 40],
      // The changes at their seconds: beat 0.5 is 0.25 s at 120, beat 2 is 1 s.
      [1.25, 64, 127],
      [2, 64, 0],
      [2, 11, 80],
      // The clip ends at 5 s: volume, pan and expression go back to their defaults (the pedal is already up).
      [5, 7, 100],
      [5, 10, 64],
      [5, 11, 127],
    ],
    'each change on the audio clock',
  );
  for (const m of cc) assert.ok(m.at <= m.t + 1e-12, 'handed over ahead of its time');
  near(cc[4].t, at(0.25), 1e-9, 'the pedal goes down on its tick');
  // Playback starting inside the clip, after the pedal went down: the chase sets the pedal and the volume there.
  const r = rig();
  const a2 = r.clock.t;
  r.sched.start(passOf(), 1.5, a2);
  r.runFor(1);
  r.sched.stop();
  const chased = r.msgs.filter((m): m is Extract<Msg, { k: 'cc' }> => m.k === 'cc' && m.t <= a2 + 1e-9);
  assert.deepEqual(
    chased.map((m) => [m.controller, m.value]).sort((x, y) => x[0] - y[0]),
    [[7, 96], [10, 40], [11, 127], [64, 127]],
    'the pedal is down and the volume, pan and expression are set where playback starts',
  );
});

console.log('editMidiScheduler: ok');
