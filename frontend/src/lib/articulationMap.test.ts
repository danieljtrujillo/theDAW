/**
 * Articulations (stage 4.5): a roll note's articulation, what it resolves to
 * per instrument, and the three places it is split: the roll's PLAY, EDIT's
 * live MIDI and a clip's soundfont render; plus the VST3 keyswitches and the
 * .tasmo round trip.
 *
 * The sequence each block replays is the one the stage's listening check
 * names: a violin line of eight notes, the first four arco and the last four
 * pizzicato. Arco stays on the violin's program on its own channel; the
 * pizzicato plays GM 46 Pizzicato Strings (program 45) on a channel of its
 * own, in each player, and the part's controllers go to both channels.
 *
 *   cd frontend && npx tsx src/lib/articulationMap.test.ts
 */
import assert from 'node:assert/strict';
import {
  articulatedNotes,
  articulationFamily,
  articulationRuns,
  clipArticulationInstrument,
  shapeNote,
  soundfontArticulationTarget,
  vst3ArticulationSwitch,
  vst3SwitchEvents,
  DEFAULT_VST3_KEYSWITCHES,
  ORDINARIO_KEYSWITCH,
} from './articulationMap.ts';
import { articulatedRenderPlan } from './articulationRender.ts';
import { notesToSmf } from './midiWrite.ts';
import { parseMidi } from './midi.ts';
import { EditMidiScheduler, clipLiveSlots, clipLiveTiming, type EditMidiPass } from './editMidiScheduler.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, type ScheduledRollNote } from './rollPartPlay.ts';
import { activeTrackOf, endRollGesture, rollTracksOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import { pianoNoteToTasmo, tasmoNoteExtras } from './projectClient.ts';
import type { AudioClip, EditorTrack } from '../state/editorStore.ts';

const VIOLIN = { instrumentId: 'violin', program: 40 };

// ── What each articulation resolves to ──────────────────────────────────────
{
  assert.equal(articulationFamily(VIOLIN), 'strings');
  assert.equal(articulationFamily({ program: 48 }), 'strings', 'a string ensemble by its GM program');
  assert.equal(articulationFamily({ instrumentId: 'horn' }), 'brass');
  assert.equal(articulationFamily({ program: 73 }), 'woodwinds');
  assert.deepEqual(soundfontArticulationTarget('pizzicato', VIOLIN), { bank: 0, program: 45 }, 'pizzicato strings is GM 46');
  assert.deepEqual(soundfontArticulationTarget('tremolo', { instrumentId: 'cello' }), { bank: 0, program: 44 });
  assert.deepEqual(soundfontArticulationTarget('col-legno', VIOLIN), { bank: 0, program: 45 });
  assert.equal(soundfontArticulationTarget('staccato', VIOLIN), null, 'a staccato stays on the part’s own program');
  assert.deepEqual(soundfontArticulationTarget('con-sordino', { instrumentId: 'trumpet-bb' }), { bank: 0, program: 59 }, 'a muted trumpet');
  assert.equal(soundfontArticulationTarget('con-sordino', { instrumentId: 'horn' }), null, 'a stopped horn has no GM preset');
  assert.equal(soundfontArticulationTarget('pizzicato', { program: 73 }), null, 'a flute has no pizzicato');
  assert.equal(soundfontArticulationTarget(undefined, VIOLIN), null);

  const n: PianoNote = { id: 'a', note: 60, step: 0, length: 4, velocity: 100, tick: 0, ticks: 960 };
  const st = shapeNote(n, 'staccato');
  assert.equal(st.length, 2);
  assert.equal(st.ticks, 480, 'the ticks shrink with the length');
  assert.equal(n.length, 4, 'the written note stays as written');
  assert.equal(shapeNote(n, 'marcato').velocity, 114);
  assert.equal(shapeNote(n, 'pizzicato'), n, 'an articulation that does not shape leaves the note as it is');

  // A clip's instrument: its part's record while it plays the part's program, else the program it plays.
  assert.deepEqual(clipArticulationInstrument({ sourceRollPart: { instrumentId: 'violin', program: 40 } }, 40, false), { instrumentId: 'violin', program: 40, percussion: false });
  assert.deepEqual(clipArticulationInstrument({ sourceRollPart: { instrumentId: 'violin', program: 40 } }, 73, false), { program: 73, percussion: false });
}

// ── The line: four arco, four pizzicato ─────────────────────────────────────
const line: PianoNote[] = Array.from({ length: 8 }, (_, i) => ({
  id: `v${i}`,
  note: 67 + (i % 4),
  step: i * 4,
  length: 4,
  velocity: 90,
  tick: i * 960,
  ticks: 960,
  ...(i >= 4 ? { articulation: 'pizzicato' as const } : {}),
}));
{
  const arts = articulatedNotes(line, VIOLIN);
  assert.deepEqual(arts.targets, [{ bank: 0, program: 45 }]);
  assert.deepEqual(arts.notes.map((a) => a.slot), [-1, -1, -1, -1, 0, 0, 0, 0]);
  const runs = articulationRuns(line);
  assert.deepEqual(runs.map((r) => [r.articulation, r.startStep, r.endStep, r.ids.length]), [[null, 0, 16, 4], ['pizzicato', 16, 32, 4]], 'one marker per run');
}

// ── EDIT's live MIDI ────────────────────────────────────────────────────────
{
  const track = { id: 'vn', name: 'Violin', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 40 } as unknown as EditorTrack;
  const clip = {
    id: 'c',
    trackId: 'vn',
    label: 'Violin',
    mimeType: 'audio/wav',
    sourceDuration: 4,
    offsetIntoSource: 0,
    durationSec: 4,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourcePianoRoll: line,
    sourceBpm: 120,
    sourceTotalSteps: 32,
    sourceRollPart: {
      doc: 'd', id: 'p', order: 0, name: 'Violin', program: 40, bank: 0, channel: null, color: '#fff', mute: false, solo: false, instrumentId: 'violin',
      controls: [{ tick: 0, controller: 11, value: 90 }],
    },
  } as unknown as AudioClip;
  assert.equal(clipLiveSlots(clip, false, 40), 2, 'one channel for arco, one for the pizzicato preset');
  const timing = clipLiveTiming(clip, 120, false, 40);
  assert.equal(timing.slots, 2);
  assert.deepEqual(timing.notes.map((n) => [n.slot, n.program ?? null]), [[0, null], [0, null], [0, null], [0, null], [1, 45], [1, 45], [1, 45], [1, 45]]);
  assert.ok(timing.ctl.some((c) => c.slot === 1 && c.kind === 'cc' && c.controller === 11), 'the part’s expression reaches the pizzicato channel');

  const clock = { t: 5 };
  const ons: Array<{ ch: number; program: number; midi: number }> = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (ch, program, midi) => ons.push({ ch, program, midi }),
      noteOff: () => {},
      wheel: () => {},
      wheelRange: () => {},
      control: () => {},
    },
    clips: () => [clip],
    tracks: () => [track],
    global: () => ({ useSoundfont: true, activeProgram: 0 }),
    projectBpm: () => 120,
  });
  const pass: EditMidiPass = { liveClipIds: new Set(['c']), channelsOf: new Map([['vn', [3, 4]]]) };
  sched.start(pass, 0, 5);
  while (clock.t < 9.5) {
    clock.t += 0.025;
    sched.tick();
  }
  sched.stop();
  assert.deepEqual(ons.map((o) => [o.ch, o.program]), [[3, 40], [3, 40], [3, 40], [3, 40], [4, 45], [4, 45], [4, 45], [4, 45]], 'arco on the violin, pizzicato on GM 46 on the second channel');
}

// ── The roll's PLAY ─────────────────────────────────────────────────────────
{
  usePianoRollStore.getState().importParts([{ name: 'Violin', program: 40, instrumentId: 'violin', notes: line.map((n) => ({ ...n })) }], 120);
  usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
  const state = usePianoRollStore.getState();
  assert.equal(rollTracksOf(state)[0].notes.filter((n) => n.articulation === 'pizzicato').length, 4, 'an import keeps the articulation');
  const sched = createRollScheduler({ ...state, tracks: rollTracksOf(state) }, 1, ROLL_LOOKAHEAD_SEC);
  const heard: ScheduledRollNote[] = [];
  for (let now = 1; now < 6; now += 0.025) {
    const s = usePianoRollStore.getState();
    // The first lap: the roll loops back to its start once its grid has played.
    heard.push(...sched.tick(now, { ...s, tracks: rollTracksOf(s) }, () => ({ program: 40, percussion: false })).notes.filter((n) => n.abs < 32));
  }
  const arco = heard.filter((n) => n.step < 16);
  const pizz = heard.filter((n) => n.step >= 16);
  assert.equal(arco.length, 4);
  assert.equal(pizz.length, 4);
  assert.ok(arco.every((n) => n.program === 40), 'arco on the violin');
  assert.ok(pizz.every((n) => n.program === 45), 'pizzicato on GM 46');
  assert.equal(new Set(pizz.map((n) => n.channel)).size, 1);
  assert.notEqual(pizz[0].channel, arco[0].channel, 'on a channel of its own');
}

// ── A render: the pizzicato on a channel of its own, the controllers copied ──
{
  const arts = articulatedNotes(line, VIOLIN);
  const renderNotes = arts.notes.map((a, i) => ({ midi: a.played.note, velocity: a.played.velocity, startSec: i * 0.5, durationSec: 0.5 }));
  const plan = articulatedRenderPlan(renderNotes, arts.notes, arts.targets, [{ sec: 0, channel: 0, controller: 11, value: 70 }]);
  assert.deepEqual(plan.notes.map((n) => n.channel ?? 0), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(plan.channelPrograms, [{ channel: 1, program: 45, bank: 0 }]);
  assert.deepEqual(plan.controls.map((c) => [c.channel, c.controller, c.value]), [[0, 11, 70], [1, 11, 70]]);
  const smf = parseMidi(notesToSmf(plan.notes, 40, 0, [], 120, [], { controls: plan.controls, channelPrograms: plan.channelPrograms }));
  const programs = smf.tracks[0].programs ?? [];
  assert.deepEqual(programs.map((p) => [p.channel, p.program]).sort(), [[0, 40], [1, 45]], 'the file plays the violin on 1 and pizzicato strings on 2');
  const drums = articulatedRenderPlan(renderNotes, arts.notes, arts.targets, [], [{ channel: 1, range: 2, events: [] }]);
  assert.deepEqual(drums.channelPrograms, [{ channel: 2, program: 45, bank: 0 }], 'a channel a bent lane holds is skipped');
}

// ── VST3: keyswitches and UACC ──────────────────────────────────────────────
{
  const events = vst3SwitchEvents([...line, { ...line[0], id: 'back', step: 32, tick: 7680 }]);
  assert.deepEqual(events.map((e) => [e.tick, e.switch]), [
    [3839, { kind: 'keyswitch', note: DEFAULT_VST3_KEYSWITCHES.pizzicato }],
    [7679, { kind: 'keyswitch', note: ORDINARIO_KEYSWITCH }],
  ], 'a keyswitch a tick before the first pizzicato, and back to ordinario');
  assert.deepEqual(vst3ArticulationSwitch('pizzicato', 'uacc'), { kind: 'cc', controller: 32, value: 56 }, 'UACC pizzicato');
  assert.deepEqual(vst3ArticulationSwitch('harmonics', 'uacc'), { kind: 'keyswitch', note: DEFAULT_VST3_KEYSWITCHES.harmonics }, 'no checked UACC value: its keyswitch');
  assert.deepEqual(vst3ArticulationSwitch('staccato', 'keyswitch', { staccato: 30 }), { kind: 'keyswitch', note: 30 }, 'a library’s own keyswitch');
}

// ── The store and the .tasmo file ───────────────────────────────────────────
{
  const roll = () => usePianoRollStore.getState();
  endRollGesture();
  const before = roll()._undo.length;
  roll().setArticulation(['v0', 'v1'], 'staccato');
  assert.deepEqual(roll().notes.filter((n) => n.articulation === 'staccato').map((n) => n.id), ['v0', 'v1']);
  assert.equal(roll()._undo.length, before + 1, 'one undo step');
  roll().setArticulation(['v0', 'v1'], 'staccato');
  assert.equal(roll()._undo.length, before + 1, 'none when nothing changes');
  endRollGesture();
  roll().setArticulation(['v1'], null);
  assert.equal(roll().notes.find((n) => n.id === 'v1')?.articulation, undefined, 'ordinario takes it away');
  assert.ok(!('articulation' in (roll().notes.find((n) => n.id === 'v1') as object)), 'with no key left behind');
  roll().updateNote('v2', { articulation: 'bogus' as never });
  assert.equal(roll().notes.find((n) => n.id === 'v2')?.articulation, undefined, 'a name the map does not know is dropped');
  assert.equal(activeTrackOf(roll()).name, 'Violin');

  const file = pianoNoteToTasmo(line[5]);
  assert.equal(file.articulation, 'pizzicato');
  assert.equal(tasmoNoteExtras(file as unknown as Record<string, unknown>).articulation, 'pizzicato', 'it reads back');
  assert.equal(tasmoNoteExtras({ articulation: 'nonsense' }).articulation, undefined);
  assert.equal(pianoNoteToTasmo(line[0]).articulation, undefined, 'an ordinario note writes no key');
}

console.log('articulationMap: ok');
