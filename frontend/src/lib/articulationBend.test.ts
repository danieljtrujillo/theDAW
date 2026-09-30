/**
 * A pizzicato in a bent lane bends with the lane (stage 4.5 follow-up), in
 * each place the articulation plays on a channel of its own: EDIT's live
 * MIDI, the roll's PLAY, a clip's soundfont render, and both MIDI writers.
 *
 * The sequence: a violin roll with lanes A and B; lane B bends a whole octave
 * up over two beats. Lane A plays an arco note and a pizzicato; lane B plays
 * an arco note and a pizzicato. The two pizzicatos get two channels (one per
 * lane), and the one in lane B carries lane B's range and wheel, the same
 * messages at the same times as lane B's own channel; the one in lane A
 * stays at the centre.
 *
 *   cd frontend && npx tsx src/lib/articulationBend.test.ts
 */
import assert from 'node:assert/strict';
import { clipLiveSlots, clipLiveTiming } from './editMidiScheduler.ts';
import { rollClipFields } from './rollClip.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, type ScheduledRollNote, type ScheduledWheel } from './rollPartPlay.ts';
import { rollToMidiFile } from './rollMidi.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { articulatedRenderPlan } from './articulationRender.ts';
import { articulatedNotes } from './articulationMap.ts';
import { makeRollTrack } from './rollTracks.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';
import { BEND_CENTER, bendValueToRaw, type LaneBend } from './pitchBend.ts';
import { migrateNotes, rollTracksOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import type { AudioClip, EditorTrack } from '../state/editorStore.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';

const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null }];
const bends: LaneBend[] = [{ lane: 1, range: 12, points: [{ id: 'p0', step: 0, value: 0, shape: 'linear' }, { id: 'p1', step: 8, value: 1, shape: 'hold' }] }];
const notes: PianoNote[] = migrateNotes([
  { id: 'a', note: 60, step: 0, length: 8, velocity: 90 },
  { id: 'ap', note: 62, step: 8, length: 4, velocity: 90, articulation: 'pizzicato' },
  { id: 'b', note: 72, step: 0, length: 8, velocity: 90, lane: 1 },
  { id: 'bp', note: 74, step: 8, length: 4, velocity: 90, lane: 1, articulation: 'pizzicato' },
]);
const part = { doc: 'd', id: 'vn', order: 0, name: 'Violin', program: 40, bank: 0, channel: null, color: '#fff', mute: false, solo: false, instrumentId: 'violin' };

// ── EDIT's live MIDI ────────────────────────────────────────────────────────
{
  const fields = rollClipFields({ notes, bpm: 120, totalSteps: 16, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes, bends });
  const clip = { id: 'c', trackId: 't', label: 'Violin', mimeType: 'audio/wav', sourceDuration: 2, offsetIntoSource: 0, durationSec: 2, startSec: 0, color: '#fff', sourceKind: 'piano-roll', ...fields, sourceRollPart: part } as unknown as AudioClip;
  const timing = clipLiveTiming(clip, 120, false, 40);
  const slotOf = (midi: number) => timing.notes.find((n) => n.midi === midi)!.slot;
  assert.equal(timing.slots, 4, 'lane A, lane B, a pizzicato for each');
  assert.equal(clipLiveSlots(clip, false, 40), 4, 'the plan gives the track as many channels');
  assert.notEqual(slotOf(62), slotOf(74), 'the two pizzicatos are on two channels');
  const wheelOf = (slot: number) => timing.ctl.filter((c) => c.slot === slot && (c.kind === 'wheel' || c.kind === 'range')).map((c) => [c.t, c.kind, c.value]);
  assert.deepEqual(wheelOf(slotOf(74)), wheelOf(slotOf(72)), 'lane B’s pizzicato channel takes lane B’s range and wheel');
  assert.ok(wheelOf(slotOf(74)).some(([, kind, v]) => kind === 'wheel' && v === bendValueToRaw(1)), 'up to the top of the bend');
  assert.deepEqual(wheelOf(slotOf(62)).filter(([, kind]) => kind === 'wheel').map(([, , v]) => v), [BEND_CENTER], 'lane A’s pizzicato stays at the centre');
  assert.ok(timing.notes.filter((n) => n.midi === 62 || n.midi === 74).every((n) => n.program === 45), 'both on GM 46');

  // EDIT's arrangement export: the same channels, lane B's pizzicato with lane B's wheel.
  const track = { id: 't', name: 'Violin', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 40 } as unknown as EditorTrack;
  const out = arrangementToMidiFile({ tracks: [track], clips: [clip], bpm: 120 }).file.tracks[0];
  const chOf = (midi: number) => out.notes.find((x) => x.note === midi)!.channel;
  const wheelOn = (c: number) => (out.bends ?? []).filter((b) => b.channel === c).map((b) => [b.tick, b.value]);
  assert.ok(wheelOn(chOf(74)).length > 5, 'the arrangement writes lane B’s wheel on its pizzicato channel');
  assert.deepEqual(wheelOn(chOf(74)), wheelOn(chOf(72)));
  assert.equal(wheelOn(chOf(62)).length, 0);
}

// ── The roll's PLAY ─────────────────────────────────────────────────────────
{
  const roll = usePianoRollStore.getState();
  roll.importParts([{ name: 'Violin', program: 40, instrumentId: 'violin', notes: notes.map((n) => ({ ...n })) }], 120, { meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0, lanes }, bends);
  usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false, totalSteps: 16 });
  const s0 = usePianoRollStore.getState();
  assert.equal(s0.bends.length, 1, 'the roll bends lane B');
  const sched = createRollScheduler({ ...s0, tracks: rollTracksOf(s0) }, 1, ROLL_LOOKAHEAD_SEC);
  const heard: ScheduledRollNote[] = [];
  const wheels: ScheduledWheel[] = [];
  for (let now = 1; now < 2.9; now += 0.025) {
    const s = usePianoRollStore.getState();
    const out = sched.tick(now, { ...s, tracks: rollTracksOf(s) }, () => ({ program: 40, percussion: false }));
    heard.push(...out.notes.filter((n) => n.abs < 16));
    wheels.push(...out.wheels);
  }
  const chOf = (midi: number) => heard.find((n) => n.note === midi)!.channel;
  assert.notEqual(chOf(74), chOf(62), 'one pizzicato channel per lane');
  assert.equal(heard.find((n) => n.note === 74)!.program, 45);
  const wheelOn = (ch: number) => wheels.filter((w) => w.channel === ch && w.kind === 'wheel').map((w) => [w.time, w.value]);
  assert.ok(wheelOn(chOf(74)).length > 5, 'lane B’s pizzicato channel gets the wheel');
  assert.deepEqual(wheelOn(chOf(74)), wheelOn(chOf(72)), 'the same messages as lane B’s own channel');
  assert.equal(wheelOn(chOf(62)).length, 0, 'lane A’s pizzicato gets none');
}

// ── A render ────────────────────────────────────────────────────────────────
{
  const arts = articulatedNotes(notes, { instrumentId: 'violin', program: 40 });
  // Lane B's notes on channel 1, where its wheel is; lane A on 0.
  const render = notes.map((n, i) => ({ midi: n.note, velocity: 90, startSec: i * 0.5, durationSec: 0.5, channel: n.lane === 1 ? 1 : 0 }));
  const wheel = [{ channel: 1, range: 12, events: [{ sec: 0, raw: BEND_CENTER }, { sec: 1, raw: bendValueToRaw(1) }] }];
  const plan = articulatedRenderPlan(render, arts.notes, arts.targets, [], wheel);
  const ch = (i: number) => plan.notes[i].channel ?? 0;
  assert.notEqual(ch(1), ch(3), 'one pizzicato channel per lane in the render');
  assert.deepEqual(plan.wheel.find((w) => w.channel === ch(3))?.events, wheel[0].events, 'lane B’s wheel on its pizzicato channel');
  assert.equal(plan.wheel.find((w) => w.channel === ch(1)), undefined, 'lane A’s pizzicato has none');
}

// ── The roll's .mid export ──────────────────────────────────────────────────
{
  const violin = makeRollTrack({ id: 'vn', name: 'Violin', program: 40, instrumentId: 'violin', notes }, 0);
  const file = rollToMidiFile({ notes: [], lanes, totalSteps: 16, bpm: 120, meterMap: normalizeMeterMap([]), pickupSteps: 0, bends, tracks: [violin] });
  const all = file.tracks.flatMap((t) => t.notes);
  const chOf = (midi: number) => all.find((n) => n.note === midi)!.channel;
  const wheelOn = (c: number) => file.tracks.flatMap((t) => t.bends ?? []).filter((b) => b.channel === c).map((b) => [b.tick, b.value]);
  assert.notEqual(chOf(74), chOf(62));
  assert.ok(wheelOn(chOf(74)).length > 5, 'lane B’s pizzicato channel carries its wheel in the file');
  assert.deepEqual(wheelOn(chOf(74)), wheelOn(chOf(72)), 'the same wheel as lane B');
  assert.ok(file.tracks.flatMap((t) => t.bendRanges ?? []).some((r) => r.channel === chOf(74) && r.semitones === 12), 'and its range');
  assert.equal(wheelOn(chOf(62)).length, 0);
  // Read back: two lanes, lane B still bent, the pizzicatos marked in their lanes.
  const back = parseMidi(encodeMidi(file));
  const imported = (await import('./rollMidi.ts')).midiFileToRoll(back);
  assert.equal(imported.meter.lanes.length, 2);
  assert.equal(imported.bends.length, 1, 'one bent lane, as written');
  assert.deepEqual(imported.notes.filter((n) => n.articulation === 'pizzicato').map((n) => [n.note, n.lane ?? 0]).sort(), [[62, 0], [74, 1]]);
}

console.log('articulationBend: ok');
