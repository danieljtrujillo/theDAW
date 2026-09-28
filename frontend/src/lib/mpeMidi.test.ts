/**
 * MPE in MIDI files (lib/mpeMidi): an MPE file read into one part whose notes
 * carry their own expression.
 *
 * The sequence: a Seaboard-style file declares a lower zone of three member
 * channels (RPN 6 on channel 0) and plays a chord across them, each member
 * with its own pressure, CC 74 and wheel before the note and moving inside it.
 * Read, the notes sit on channel 0 in one part and one lane, each note's start
 * values and curves are its own channel's, the bend is read at the members'
 * 48 semitones, and no member wheel is left to make a lane. The same notes
 * without the configuration message are found by their shape; a plain
 * multi-channel file with bends alone is not taken for MPE.
 *
 *   cd frontend && npx tsx src/lib/mpeMidi.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData, type MidiTrack } from './midi.ts';
import { midiFileToRoll, midiFileToRollParts } from './rollMidi.ts';

const near = (a: number | undefined, b: number, eps: number, msg: string) => assert.ok(a !== undefined && Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

const seaboard = (withZone: boolean): MidiFileData => {
  const track: MidiTrack = {
    name: 'Seaboard',
    notes: [
      { tick: 0, note: 60, velocity: 100, durationTicks: 960, channel: 1 },
      { tick: 0, note: 64, velocity: 90, durationTicks: 960, channel: 2 },
      { tick: 480, note: 67, velocity: 80, durationTicks: 480, channel: 3 },
    ],
    // Each member set before its note, then moving inside it.
    pressures: [
      { tick: 0, channel: 1, value: 20 },
      { tick: 240, channel: 1, value: 100 },
      { tick: 0, channel: 2, value: 64 },
      { tick: 480, channel: 3, value: 127 },
    ],
    controls: [
      { tick: 0, channel: 1, controller: 74, value: 30 },
      { tick: 480, channel: 1, controller: 74, value: 90 },
      { tick: 0, channel: 2, controller: 74, value: 64 },
      { tick: 480, channel: 3, controller: 74, value: 10 },
    ],
    bends: [
      { tick: 0, channel: 1, value: 8192 },
      { tick: 600, channel: 1, value: 8192 + 4096 },
      { tick: 0, channel: 2, value: 8192 },
      { tick: 480, channel: 3, value: 0 },
    ],
    ...(withZone ? { mpeZones: [{ tick: 0, channel: 0, members: 3 }] } : {}),
  };
  return { ppq: 480, bpm: 120, tracks: [track] };
};

for (const withZone of [true, false]) {
  const what = withZone ? 'with its configuration message' : 'found by its shape';
  const back = parseMidi(encodeMidi(seaboard(withZone)));
  const t = back.tracks[0];
  if (withZone) assert.deepEqual(t.mpeZones, [{ tick: 0, channel: 0, members: 3 }], 'the MCM reads back');
  assert.ok(t.notes.every((n) => n.channel === (withZone ? 0 : 1)), `${what}: the notes sit on the part's channel`);
  assert.equal(t.bends, undefined, `${what}: no member wheel is left`);
  assert.equal(t.pressures, undefined);
  const c = t.notes.find((n) => n.note === 60)!.expr!;
  near(c.pressure, 20 / 127, 1e-9, 'the pressure where the note starts');
  near(c.timbre, 30 / 127, 1e-9, 'its timbre');
  near(c.pitchBend, 0, 1e-9, 'its bend');
  assert.equal(c.bendRange, 48, 'at the members’ 48 semitones');
  assert.deepEqual(c.curves?.pressure?.map((p) => [p.tick, Math.round(p.value * 127)]), [[240, 100]], 'the pressure moves inside it');
  assert.deepEqual(c.curves?.timbre?.map((p) => [p.tick, Math.round(p.value * 127)]), [[480, 90]]);
  near(c.curves?.pitchBend?.[0].value, 4096 / 8191, 1e-9, 'half the range up');
  const g = t.notes.find((n) => n.note === 67)!.expr!;
  near(g.pressure, 1, 1e-9, 'the G has its own channel’s pressure');
  near(g.pitchBend, -1, 1e-9, 'and its own full bend down');
  assert.equal(t.notes.find((n) => n.note === 64)!.expr!.curves, undefined, 'the E does not move');

  const roll = midiFileToRoll(back);
  assert.equal(roll.meter.lanes.length, 1, `${what}: one lane`);
  assert.equal(roll.bends.length, 0, 'no lane bend');
  const rc = roll.notes.find((n) => n.note === 60)!.expr!;
  assert.deepEqual(rc.curves?.pressure?.map((p) => p.tick), [480], 'curves on the roll’s 960 clock');
  const parts = midiFileToRollParts(back);
  assert.equal(parts.parts.length, 1, `${what}: one part`);
  assert.equal(parts.parts[0].notes.length, 3);
}

// A multi-channel file whose channels only bend is not MPE: its channels stay.
{
  const plain: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [
      {
        name: 'GM',
        notes: [0, 1, 2].map((ch) => ({ tick: 0, note: 50 + ch, velocity: 90, durationTicks: 480, channel: ch })),
        bends: [0, 1, 2].map((ch) => ({ tick: 0, channel: ch, value: 9000 })),
      },
    ],
  };
  const back = parseMidi(encodeMidi(plain));
  assert.deepEqual(back.tracks[0].notes.map((n) => n.channel), [0, 1, 2]);
  assert.equal(back.tracks[0].notes[0].expr, undefined);
}

// ── three instruments a channel each, each with a brightness, are three parts ──
{
  const line = (ch: number, base: number) => [0, 480, 960, 1440].map((t, i) => ({ tick: t, note: base + i, velocity: 90, durationTicks: 480, channel: ch }));
  const trio: MidiFileData = {
    ppq: 480,
    bpm: 120,
    tracks: [
      {
        name: 'Trio',
        notes: [...line(0, 72), ...line(1, 67), ...line(2, 60)].sort((a, b) => a.tick - b.tick),
        programs: [{ tick: 0, channel: 0, program: 73 }, { tick: 0, channel: 1, program: 68 }, { tick: 0, channel: 2, program: 71 }],
        controls: [0, 1, 2].map((ch) => ({ tick: 0, channel: ch, controller: 74, value: 70 })),
      },
    ],
  } as MidiFileData;
  const back = parseMidi(encodeMidi(trio));
  assert.deepEqual([...new Set(back.tracks[0].notes.map((n) => n.channel))].sort(), [0, 1, 2], 'each line keeps its channel');
  assert.ok(back.tracks[0].notes.every((n) => n.expr === undefined), 'no note is taken for an MPE note');
  assert.equal(midiFileToRollParts(back).parts.length, 3, 'flute, oboe and clarinet');
}

// ── a dense file reads in linear time ─────────────────────────────────────
{
  // 40 000 notes on one channel took 5.5 s when each note copied its channel's list.
  const notes = Array.from({ length: 40000 }, (_, i) => ({ tick: i * 60, note: 40 + (i % 40), velocity: 90, durationTicks: 50, channel: 0 }));
  const bytes = encodeMidi({ ppq: 480, bpm: 120, tracks: [{ name: 'dense', notes }] } as never);
  const t0 = performance.now();
  const read = parseMidi(bytes);
  const ms = performance.now() - t0;
  assert.equal(read.tracks[0].notes.length, 40000);
  assert.ok(ms < 1500, `40 000 notes read in ${ms.toFixed(0)} ms`);
}

console.log('mpeMidi: ok');

// ── Export: both writers write expressive notes as MPE, and they read back ───
{
  const { rollToMidiFile } = await import('./rollMidi.ts');
  const { arrangementToMidiFile } = await import('./arrangementMidi.ts');
  const { makeRollTrack } = await import('./rollTracks.ts');
  const { planMpeExport } = await import('./mpeMidi.ts');
  const { migrateNotes, DEFAULT_LANES } = await import('../state/pianoRollStore.ts');
  const { normalizeMeterMap } = await import('./meterMap.ts');
  const notes = migrateNotes([
    { id: 'a', note: 60, step: 0, length: 8, velocity: 100, expr: { pressure: 0.2, timbre: 0.5, pitchBend: 0, bendRange: 48, curves: { pressure: [{ tick: 960, value: 0.9 }], pitchBend: [{ tick: 1440, value: 0.25 }] } } },
    { id: 'b', note: 64, step: 0, length: 8, velocity: 90, expr: { pressure: 0.6 } },
    { id: 'c', note: 67, step: 8, length: 4, velocity: 80 },
  ]);
  const part = makeRollTrack({ id: 'sb', name: 'Seaboard', program: 88, notes }, 0);
  const file = rollToMidiFile({ notes: [], lanes: [...DEFAULT_LANES], totalSteps: 16, bpm: 120, meterMap: normalizeMeterMap([]), pickupSteps: 0, bends: [], tracks: [part] });
  const written = file.tracks[0];
  assert.deepEqual(written.mpeZones, [{ tick: 0, channel: 15, members: 2 }], 'the upper zone, two members: the chord overlaps two notes');
  const chOf = (note: number) => written.notes.find((n) => n.note === note)!.channel;
  assert.deepEqual([chOf(60), chOf(64)].sort(), [13, 14], 'the expressive notes on the members');
  assert.equal(chOf(67), 0, 'the plain note on the part’s channel');
  assert.ok((written.programs ?? []).some((p) => p.channel === chOf(60) && p.program === 88), 'each member plays the part’s program');
  assert.ok((written.pressures ?? []).some((p) => p.channel === chOf(60) && p.value === Math.round(0.9 * 127) && p.tick === 960), 'the swell on its member at its tick');

  const back = parseMidi(encodeMidi(file));
  assert.ok(back.tracks[0].notes.every((n) => n.channel === 0), 'read back, every note on the part’s channel');
  const a = back.tracks[0].notes.find((n) => n.note === 60)!.expr!;
  near(a.pressure, 0.2, 1 / 127, 'the start pressure');
  near(a.timbre, 0.5, 1 / 127, 'the timbre');
  assert.equal(a.bendRange, 48, 'the range it was written at');
  near(a.curves?.pressure?.[0].value, 0.9, 1 / 127, 'the swell');
  assert.equal(a.curves?.pressure?.[0].tick, 960);
  near(a.curves?.pitchBend?.[0].value, 0.25, 1 / 8000, 'the bend a quarter up');
  near(back.tracks[0].notes.find((n) => n.note === 64)!.expr!.pressure, 0.6, 1 / 127, 'the E’s own pressure');
  assert.equal(back.tracks[0].notes.find((n) => n.note === 67)!.expr, undefined);
  const roll = midiFileToRoll(back);
  assert.equal(roll.meter.lanes.length, 1);
  assert.equal(midiFileToRollParts(back).parts.length, 1, 'one part');

  // EDIT's arrangement export writes them the same way.
  const track = { id: 't', name: 'Seaboard', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 88 };
  const clip = { id: 'c', trackId: 't', label: 'x', mimeType: 'audio/wav', sourceDuration: 2, offsetIntoSource: 0, durationSec: 2, startSec: 0, color: '#fff', sourceKind: 'piano-roll', sourcePianoRoll: notes, sourceBpm: 120, sourceTotalSteps: 16 };
  const arr = arrangementToMidiFile({ tracks: [track as never], clips: [clip as never], bpm: 120 });
  assert.deepEqual(arr.file.tracks[0].mpeZones, [{ tick: 0, channel: 15, members: 2 }]);
  const arrBack = parseMidi(encodeMidi(arr.file)).tracks[0].notes;
  near(arrBack.find((n) => n.note === 60)!.expr!.curves?.pressure?.[0].value, 0.9, 1 / 127, 'the arrangement’s swell reads back');
  assert.ok(arrBack.every((n) => n.channel === arrBack.find((x) => x.note === 67)!.channel), 'on the track’s channel');
  assert.equal(arr.mpeNoRoom, undefined);

  // No member free (a part on channel 15): the notes stay home, and the plan says so.
  assert.equal(planMpeExport([{ key: 'x', start: 0, end: 10 }], new Set([15])).noRoom, true);
  assert.deepEqual(planMpeExport([{ key: 'x', start: 0, end: 10 }], new Set([12])).members, [14], 'one member for one note');
}

// ── the part's controllers reach the member channels, in both writers and in the roll's PLAY ──
{
  const { rollToMidiFile } = await import('./rollMidi.ts');
  const { arrangementToMidiFile } = await import('./arrangementMidi.ts');
  const { makeRollTrack } = await import('./rollTracks.ts');
  const { memberPartControls } = await import('./mpeMidi.ts');
  const { migrateNotes, DEFAULT_LANES, usePianoRollStore, rollTracksOf, activeTrackOf } = await import('../state/pianoRollStore.ts');
  const { normalizeMeterMap } = await import('./meterMap.ts');
  const { createRollScheduler, ROLL_LOOKAHEAD_SEC } = await import('./rollPartPlay.ts');
  const notes = migrateNotes([
    { id: 'e', note: 60, step: 0, length: 8, velocity: 100, expr: { pressure: 0.5 } },
    { id: 'p', note: 67, step: 0, length: 8, velocity: 80 },
  ]);
  // The pedal down at 0 and up at the next bar, volume 50.
  const controls = [{ tick: 0, controller: 64, value: 127 }, { tick: 0, controller: 7, value: 50 }, { tick: 3840, controller: 64, value: 0 }];
  const part = makeRollTrack({ id: 'lead', name: 'Lead', program: 0, notes, controls }, 0);
  const file = rollToMidiFile({ notes: [], lanes: [...DEFAULT_LANES], totalSteps: 32, bpm: 120, meterMap: normalizeMeterMap([]), pickupSteps: 0, bends: [], tracks: [part] });
  const t = file.tracks[0];
  const member = t.notes.find((n) => n.note === 60)!.channel;
  assert.notEqual(member, 0);
  const onMember = (t.controls ?? []).filter((c) => c.channel === member && c.controller !== 74).map((c) => [c.tick, c.controller, c.value]);
  assert.deepEqual(onMember, [[0, 64, 127], [0, 7, 50], [3840, 64, 0]], "the member takes the part's pedal and volume, and the pedal's release after the note");
  assert.equal(midiFileToRollParts(parseMidi(encodeMidi(file))).parts[0].track.controls?.length, 3, 'read back, the part keeps its three changes');

  const track = { id: 't', name: 'Lead', color: '#fff', volume: 0.5, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 0 };
  const clip = { id: 'c', trackId: 't', label: 'x', mimeType: 'audio/wav', sourceDuration: 4, offsetIntoSource: 0, durationSec: 4, startSec: 0, color: '#fff', sourceKind: 'piano-roll', sourcePianoRoll: notes, sourceBpm: 120, sourceTotalSteps: 32, sourceRollPart: { ...part, doc: 'd', order: 0 } };
  const arr = arrangementToMidiFile({ tracks: [track as never], clips: [clip as never], bpm: 120 }).file.tracks[0];
  const arrMember = arr.notes.find((n) => n.note === 60)!.channel;
  const home = arr.notes.find((n) => n.note === 67)!.channel;
  const cc = (ch: number, controller: number) => (arr.controls ?? []).filter((c) => c.channel === ch && c.controller === controller).map((c) => c.value);
  assert.ok(cc(home, 64).length > 0 && cc(home, 7).length > 0, 'the track channel has the pedal and the fader');
  assert.deepEqual(cc(arrMember, 64), cc(home, 64), 'the member channel takes the pedal the track channel has');
  assert.deepEqual(cc(arrMember, 7), cc(home, 7), 'and its fader volume');

  // A member the next note takes stops following the part there.
  assert.deepEqual(memberPartControls({ tick: 10 }, 14, [{ tick: 0, controller: 1, value: 5 }, { tick: 20, controller: 1, value: 9 }, { tick: 40, controller: 1, value: 3 }], 30).map((c) => [c.tick, c.value]), [[10, 5], [20, 9]]);

  // The roll's PLAY: the member channel hears the part's pedal and volume.
  usePianoRollStore.getState().importParts([{ name: 'Lead', program: 0, notes }] as never, 120);
  const st0 = usePianoRollStore.getState();
  st0.setTrackControls(activeTrackOf(st0).id, controls.slice(0, 2));
  usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
  const state = usePianoRollStore.getState();
  const sched = createRollScheduler({ ...state, tracks: rollTracksOf(state) }, 1, ROLL_LOOKAHEAD_SEC);
  const heard = new Set<string>();
  const noteCh = new Map<number, number>();
  for (let now = 1; now < 2; now += 0.025) {
    const s = usePianoRollStore.getState();
    const out = sched.tick(now, { ...s, tracks: rollTracksOf(s) }, () => ({ program: 0, percussion: false }));
    for (const w of out.wheels) if (w.kind === 'control') heard.add(`${w.channel}:${w.controller}=${w.value}`);
    for (const n of out.notes) noteCh.set(n.note, n.channel);
  }
  const playMember = noteCh.get(60)!;
  assert.notEqual(playMember, noteCh.get(67));
  assert.ok(heard.has(`${playMember}:64=127`) && heard.has(`${playMember}:7=50`), "PLAY sends the part's pedal and volume to the expressive note's channel");
}

console.log('mpeMidi export: ok');
