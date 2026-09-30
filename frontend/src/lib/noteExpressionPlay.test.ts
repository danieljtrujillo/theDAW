/**
 * A note's own expression curves and bend range (PianoNote `expr`: `curves`,
 * `bendRange`) reach the synth while the note sounds, from EDIT's live
 * scheduler (lib/editMidiScheduler, the MPE rotation) and from the roll's own
 * PLAY (lib/rollPartPlay).
 *
 * The note: a whole bar at 120 BPM (two seconds), starting at pressure 0.2
 * and a quarter of its bend, with a ±48 semitone bend range as an MPE file
 * imports it, its pressure rising to 0.8 one beat in (960 ticks, 0.5 s) and
 * its bend reaching the top two beats in (1920 ticks, 1 s). Its member
 * channel gets RPN 0 at 48 and the start values just before the note-on, then
 * the pressure and the wheel at their times. A second note with no bendRange
 * sets its member channel back to 2.
 *
 *   cd frontend && npx tsx src/lib/noteExpressionPlay.test.ts
 */
import assert from 'node:assert/strict';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiPass } from './editMidiScheduler.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, type ScheduledWheel } from './rollPartPlay.ts';
import { expressionCurveSteps, hasExpression, noteBendRange } from './mpeRotation.ts';
import { bendValueToRaw } from './pitchBend.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import { rollTracksOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { GlobalVoice } from './clipProgram.ts';

const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const TOL = 0.002;

const swell: PianoNote['expr'] = {
  pressure: 0.2,
  pitchBend: 0.25,
  bendRange: 48,
  curves: { pressure: [{ tick: 960, value: 0.8 }], pitchBend: [{ tick: 1920, value: 1 }] },
};
const plainRange: PianoNote['expr'] = { timbre: 0.5 };
const note = (id: string, midi: number, step: number, length: number, expr?: PianoNote['expr']): PianoNote =>
  ({ id, note: midi, step, length, velocity: 100, tick: step * 240, ticks: length * 240, ...(expr ? { expr } : {}) }) as PianoNote;

// ── the pure parts ─────────────────────────────────────────────────────────
{
  assert.equal(noteBendRange(swell), 48);
  assert.equal(noteBendRange(plainRange), 2, 'no bendRange: the General MIDI default');
  assert.equal(hasExpression({ curves: { pressure: [{ tick: 10, value: 1 }] } }), true, 'a curve alone is expression');
  assert.deepEqual(expressionCurveSteps(swell), [
    { tick: 960, kind: 'pressure', value: 102 },
    { tick: 1920, kind: 'wheel', value: 16383 },
  ]);
}

type Msg = { kind: string; ch: number; value?: number; controller?: number; midi?: number; t: number };
/** The messages on `ch`, times relative to `on`. */
const onChannel = (msgs: readonly Msg[], ch: number, on: number) =>
  msgs.filter((m) => m.ch === ch && m.kind !== 'on' && m.kind !== 'off').map((m) => ({ ...m, rel: m.t - on }));
const at = (list: ReturnType<typeof onChannel>, kind: string, rel: number, controller?: number) =>
  list.filter((m) => m.kind === kind && Math.abs(m.rel - rel) < TOL && (controller === undefined || m.controller === controller));

// ── EDIT's live scheduler ──────────────────────────────────────────────────
{
  const ed = () => useEditorStore.getState();
  ed().loadProject({ tracks: [], clips: [] });
  const trackId = ed().tracks[0].id;
  const clipId = ed().addClipToTrack({
    trackId,
    label: 'Swell',
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 60,
    offsetIntoSource: 0,
    durationSec: 4,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [note('swell', 60, 0, 16, swell), note('after', 64, 20, 4, plainRange)],
    sourceBpm: 120,
    sourceTotalSteps: 32,
  });
  ed().updateClip(clipId, { instrumentProgram: 73 });
  const clock = { t: 100 };
  const msgs: Msg[] = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (ch, _p, midi, _v, t) => msgs.push({ kind: 'on', ch, midi, t }),
      noteOff: (ch, midi, t) => msgs.push({ kind: 'off', ch, midi, t }),
      wheel: (ch, value, t) => msgs.push({ kind: 'wheel', ch, value, t }),
      wheelRange: (ch, value, t) => msgs.push({ kind: 'range', ch, value, t }),
      control: (ch, controller, value, t) => msgs.push({ kind: 'cc', ch, controller, value, t }),
      pressure: (ch, value, t) => msgs.push({ kind: 'pressure', ch, value, t }),
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => SF,
    projectBpm: () => ed().bpm,
  });
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  const pass: EditMidiPass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
  sched.start(pass, 0, clock.t);
  while (clock.t < 106) {
    clock.t += EDIT_MIDI_TICK_MS / 1000;
    sched.tick();
  }
  sched.stop();

  const on = msgs.find((m) => m.kind === 'on' && m.midi === 60)!;
  const list = onChannel(msgs, on.ch, on.t);
  assert.equal(at(list, 'range', 0).at(-1)?.value, 48, 'RPN 0 sets the member channel to ±48 at the note');
  assert.equal(at(list, 'wheel', 0).at(-1)?.value, bendValueToRaw(0.25), 'the bend it starts at');
  assert.equal(at(list, 'pressure', 0).at(-1)?.value, 25, 'the pressure it starts at');
  const onIndex = msgs.indexOf(on);
  for (const kind of ['range', 'wheel', 'pressure']) {
    const i = msgs.findIndex((m) => m.ch === on.ch && m.kind === kind && Math.abs(m.t - on.t) < TOL);
    assert.ok(i >= 0 && i < onIndex, `the ${kind} goes to the synth before the note-on`);
  }
  assert.deepEqual(at(list, 'pressure', 0.5).map((m) => m.value), [102], 'the pressure curve one beat in');
  assert.deepEqual(at(list, 'wheel', 1).map((m) => m.value), [16383], 'the bend curve two beats in');
  assert.equal(list.filter((m) => m.kind === 'pressure' && m.rel > TOL && m.rel < 2 - TOL).length, 1, 'no other pressure while it sounds');

  const after = msgs.find((m) => m.kind === 'on' && m.midi === 64)!;
  const afterList = onChannel(msgs, after.ch, after.t);
  assert.equal(at(afterList, 'range', 0).at(-1)?.value, 2, 'a note with no bendRange sets its member back to ±2');
  assert.equal(at(afterList, 'cc', 0, 74).at(-1)?.value, 64, 'and its timbre');
  console.log(`EDIT: range 48, pressure 25 -> 102 at +0.5 s, wheel ${bendValueToRaw(0.25)} -> 16383 at +1 s on member channel ${on.ch}`);
}

// ── the roll's own PLAY ────────────────────────────────────────────────────
{
  usePianoRollStore.getState().importParts([{ name: 'Lead', program: 81, notes: [note('swell', 60, 0, 16, swell), note('after', 64, 20, 4, plainRange)] }], 120);
  usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
  const state = usePianoRollStore.getState();
  assert.deepEqual(rollTracksOf(state)[0].notes.find((n) => n.note === 60)?.expr, swell, 'the part keeps the note\'s expression');
  const origin = 1;
  const sched = createRollScheduler({ ...state, tracks: rollTracksOf(state) }, origin, ROLL_LOOKAHEAD_SEC);
  const msgs: Msg[] = [];
  const toMsg = (w: ScheduledWheel, now: number): Msg => ({ kind: w.kind === 'control' ? 'cc' : w.kind, ch: w.channel, value: w.value, controller: w.controller, t: w.time ?? now });
  for (let now = origin; now < origin + 5.9; now += 0.025) {
    const s = usePianoRollStore.getState();
    const out = sched.tick(now, { ...s, tracks: rollTracksOf(s) }, () => ({ program: 81, percussion: false }));
    // The transport sends the window's wheels, then its notes.
    for (const w of out.wheels) msgs.push(toMsg(w, now));
    for (const n of out.notes) if (n.abs < 32) msgs.push({ kind: 'on', ch: n.channel, midi: n.note, t: n.when });
  }
  const rest = sched.release(origin + 6).map((w) => toMsg(w, origin + 6));

  const on = msgs.find((m) => m.kind === 'on' && m.midi === 60)!;
  const base = rollTracksOf(state)[0];
  assert.ok(on, 'the note plays');
  const list = onChannel(msgs, on.ch, on.t);
  assert.equal(at(list, 'range', 0).at(-1)?.value, 48, 'RPN 0 sets the member channel to ±48 at the note');
  assert.equal(at(list, 'wheel', 0).at(-1)?.value, bendValueToRaw(0.25));
  assert.equal(at(list, 'pressure', 0).at(-1)?.value, 25);
  const onIndex = msgs.indexOf(on);
  for (const kind of ['range', 'wheel', 'pressure']) {
    const i = msgs.findIndex((m) => m.ch === on.ch && m.kind === kind && Math.abs(m.t - on.t) < TOL);
    assert.ok(i >= 0 && i < onIndex, `the ${kind} is sent before the note`);
  }
  assert.deepEqual(at(list, 'pressure', 0.5).map((m) => m.value), [102], 'the pressure curve one beat in');
  assert.deepEqual(at(list, 'wheel', 1).map((m) => m.value), [16383], 'the bend curve two beats in');
  const after = msgs.find((m) => m.kind === 'on' && m.midi === 64)!;
  assert.equal(at(onChannel(msgs, after.ch, after.t), 'range', 0).at(-1)?.value, 2, 'a note with no bendRange: ±2');
  // STOP puts the member channels back at rest.
  for (const ch of new Set([on.ch, after.ch])) {
    const mine = rest.filter((m) => m.ch === ch);
    assert.deepEqual(
      mine.map((m) => [m.kind, m.controller ?? null, m.value]),
      [['wheel', null, 8192], ['range', null, 2], ['cc', 74, 64], ['pressure', null, 0]],
      `member channel ${ch} rests after STOP`,
    );
  }
  assert.ok(base.notes.length === 2);
  console.log(`roll PLAY: range 48, pressure 25 -> 102 at +0.5 s, wheel -> 16383 at +1 s on member channel ${on.ch}`);
}

console.log('noteExpressionPlay: ok');
