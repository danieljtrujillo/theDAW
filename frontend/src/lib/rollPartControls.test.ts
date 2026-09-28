/**
 * A part's controller changes (modulation, volume, pan, expression, the
 * sustain pedal) from a MIDI file into the roll, through the roll's undo, an
 * EDIT bounce, a .tasmo record and a render, and back out to a MIDI file.
 *
 * Before: the parser read past every controller, so an orchestral file's
 * pedal, balance and swells were gone on import, and a part could not carry
 * them anywhere. A roll export wrote none, and a render played none.
 *
 *   cd frontend && npx tsx src/lib/rollPartControls.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiControl, type MidiFileData, type MidiTrack } from './midi.ts';
import { notesToSmf } from './midiWrite.ts';
import { stepRenderRequest } from './midiSynth.ts';
import { midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { applyRollParts } from './rollPartsImport.ts';
import { clipPartsLoad, clipRenderInput, cleanRollPartRef, rollPartRef } from './rollClip.ts';
import { rollPartToTasmo, tasmoRollPart } from './projectClient.ts';
import { bounceRollToEditor, type RollBounceDeps } from './rollBounce.ts';
import { configureMidiRenderQueue, requestMidiRender } from '../state/midiRenderQueue.ts';
import { liveMidiIfHeard } from '../state/liveMixer.ts';
import type { MidiStepRender } from './midiRender.ts';
import { cleanPartControls, controlStateBefore, makeRollTrack, partControlCounts } from './rollTracks.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';
import { useEditorStore } from '../state/editorStore.ts';
import {
  DEFAULT_LANES,
  endRollGesture,
  migrateNotes,
  partLinkOf,
  rollTracksOf,
  usePianoRollStore,
  type PianoNote,
  type RollControl,
} from '../state/pianoRollStore.ts';

class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const roll = () => usePianoRollStore.getState();
/** The next roll edit records a step of its own, however soon it follows the last (the store folds edits 300 ms apart). */
const cut = () => endRollGesture();
const ed = () => useEditorStore.getState();
const n = (step: number, note: number, lane?: number): PianoNote => ({ id: `n${step}-${note}-${lane ?? 0}`, note, step, length: 2, velocity: 90, ...(lane ? { lane } : {}) });
const PEDAL: RollControl[] = [
  { tick: 0, controller: 7, value: 96 },
  { tick: 0, controller: 10, value: 40 },
  { tick: 480, controller: 64, value: 127 },
  { tick: 1920, controller: 64, value: 0 },
  { tick: 1920, controller: 11, value: 80 },
];
const base = {
  bpm: 96,
  totalSteps: 64,
  meterMap: normalizeMeterMap([{ bar: 0, meter: { num: 3, den: 4, groups: [] } }]),
  pickupSteps: 0,
  lanes: [...DEFAULT_LANES] as PolyLane[],
  bends: [] as LaneBend[],
};

// ── cleaning ────────────────────────────────────────────────────────────────
{
  assert.deepEqual(
    cleanPartControls([
      { tick: 10.4, controller: 64, value: 200 },
      { tick: -3, controller: 7, value: 50.6 },
      { tick: 5, controller: 91, value: 40 }, // reverb: not a part controller
      { tick: 10, controller: 64, value: 0 }, // the same controller at one tick: the later is in force
      'junk',
      { tick: 5, controller: 1 },
    ]),
    [
      { tick: 0, controller: 7, value: 51 },
      { tick: 10, controller: 64, value: 0 },
    ],
  );
  assert.equal(cleanPartControls([]), undefined, 'none is no field');
  assert.equal(makeRollTrack({ name: 'x' }, 0).controls, undefined, 'a part without controllers carries no field');
  assert.deepEqual(partControlCounts(PEDAL).map((c) => [c.controller.name, c.count]), [['Volume', 1], ['Pan', 1], ['Expression', 1], ['Sustain pedal', 2]]);
  assert.deepEqual([...controlStateBefore(PEDAL, 1000)], [[7, 96], [10, 40], [64, 127], [11, 127]], 'the pedal is down at tick 1000; expression is at its start');
  assert.deepEqual([...controlStateBefore(PEDAL, 1920)], [[7, 96], [10, 40], [64, 127], [11, 127]], 'changes AT the tick are the window’s, not the state’s');
}

// ── a roll's parts through a MIDI file ──────────────────────────────────────
{
  const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: null }];
  const tracks = [
    // Two unbent lanes share the piano's channel: its changes are written once there.
    makeRollTrack({ id: 'pno', name: 'Piano', program: 0, controls: PEDAL, notes: migrateNotes([n(0, 48), n(4, 55, 1)]) }, 0),
    makeRollTrack({ id: 'hn', name: 'Horn in F', program: 60, controls: [{ tick: 960, controller: 11, value: 64 }], notes: migrateNotes([n(0, 60)]) }, 1),
  ];
  const file = rollToMidiFile({ ...base, lanes, notes: [], tracks });
  const pianoTracks = file.tracks.filter((t) => t.name.startsWith('Piano'));
  assert.equal(pianoTracks.length, 2, 'a track per lane');
  assert.deepEqual(pianoTracks[0].controls?.map((c) => [c.tick, c.channel, c.controller, c.value]), PEDAL.map((c) => [c.tick, 0, c.controller, c.value]), "the piano's changes on its channel at 960 PPQ");
  assert.equal(pianoTracks[1].controls, undefined, 'lane B shares the channel, so it writes none again');
  const back = midiFileToRollParts(parseMidi(encodeMidi(file)), 'rt');
  assert.deepEqual(back.parts.map((p) => p.track.controls), [PEDAL, [{ tick: 960, controller: 11, value: 64 }]], 'each part gets its own changes back');

  // A bent lane plays on a channel of its own, so the pedal goes there too; the copies fold into one on import.
  const bends: LaneBend[] = [{ lane: 1, range: 2, points: [{ id: 'b', step: 0, value: 0.5, shape: 'hold' }] }];
  const bent = rollToMidiFile({ ...base, lanes, bends, notes: [], tracks });
  const pianoBent = bent.tracks.filter((t) => t.name.startsWith('Piano'));
  const channels = pianoBent.map((t) => t.notes[0].channel);
  assert.notEqual(channels[0], channels[1], "the bent lane has a channel of its own");
  assert.deepEqual(pianoBent.map((t) => new Set((t.controls ?? []).map((c) => c.channel))), [new Set([channels[0]]), new Set([channels[1]])]);
  assert.deepEqual(midiFileToRollParts(parseMidi(encodeMidi(bent)), 'rt2').parts[0].track.controls, PEDAL);

  // A roll of one part writes its changes with it.
  const one = rollToMidiFile({ ...base, notes: [], tracks: [tracks[0]] });
  assert.deepEqual(one.tracks[0].controls?.length, PEDAL.length);
}

// ── a file from another program: channels, setup tracks, drum banks ─────────
{
  const cc = (tick: number, channel: number, controller: number, value: number): MidiControl => ({ tick, channel, controller, value });
  const track = (name: string, channel: number, extra: Partial<MidiTrack> = {}): MidiTrack => ({
    name,
    notes: [{ tick: 0, note: channel === 15 ? 38 : 60 + channel, velocity: 90, durationTicks: 480, channel }],
    ...extra,
  });
  const data: MidiFileData = {
    ppq: 480,
    bpm: 100,
    tracks: [
      { name: 'Setup', notes: [], controls: [cc(0, 1, 7, 70), cc(0, 1, 10, 100), cc(0, 0, 7, 110)] },
      track('Flute', 0, { programs: [{ tick: 0, channel: 0, program: 73 }], controls: [cc(960, 0, 1, 50)] }),
      track('Viola', 1, { programs: [{ tick: 0, channel: 1, program: 41 }] }),
      // A drum kit on channel 16 through General MIDI 2's rhythm bank (120).
      track('Kit', 15, { programs: [{ tick: 0, channel: 15, program: 0, bank: 120 }], controls: [cc(0, 15, 7, 90)] }),
      // Bank 127 on channel 15: XG's kits and GS's MT-32 melodic map share the number, so it stays a melodic part.
      track('Bank 127', 14, { programs: [{ tick: 0, channel: 14, program: 16, bank: 127 }] }),
    ],
  };
  const parts = midiFileToRollParts(parseMidi(encodeMidi(data)), 'f').parts;
  assert.deepEqual(parts.map((p) => p.track.name), ['Flute', 'Viola', 'Kit', 'Bank 127'], 'the setup track has no notes, so it is no part');
  assert.deepEqual(parts[0].track.controls, [{ tick: 0, controller: 7, value: 110 }, { tick: 1920, controller: 1, value: 50 }], "the flute's channel volume from the setup track, and its own modulation, at 960 PPQ");
  assert.deepEqual(parts[1].track.controls, [{ tick: 0, controller: 7, value: 70 }, { tick: 0, controller: 10, value: 100 }]);
  assert.deepEqual([parts[2].track.channel, parts[2].track.bank, parts[2].track.program], [10, 0, 0], "General MIDI 2's rhythm bank makes a percussion part on channel 10");
  assert.deepEqual(parts[2].track.controls, [{ tick: 0, controller: 7, value: 90 }]);
  assert.deepEqual([parts[3].track.channel, parts[3].track.bank, parts[3].track.program], [15, 127, 16], 'bank 127 keeps its channel and program');
}

// ── the roll's undo: set, clear, import ─────────────────────────────────────
{
  roll().importParts([{ name: 'Piano', notes: [n(0, 60)] }, { name: 'Cello', notes: [n(0, 48)] }], 100);
  const [pno] = roll().tracks.map((t) => t.id);
  cut();
  const steps = roll()._undo.length;
  roll().setTrackControls(pno, PEDAL);
  assert.deepEqual(roll().tracks[0].controls, PEDAL);
  assert.equal(roll()._undo.length, steps + 1, 'one undo step');
  cut();
  roll().setTrackControls(pno, PEDAL.map((c) => ({ ...c })));
  assert.equal(roll()._undo.length, steps + 1, 'the same list again is no step');
  // Switching parts, renaming and moving keep them.
  roll().setActiveTrack(roll().tracks[1].id);
  cut();
  roll().renameTrack(pno, 'Grand');
  cut();
  roll().moveTrack(pno, 1);
  assert.deepEqual(roll().tracks.find((t) => t.id === pno)?.controls, PEDAL, 'the controllers stay with their part');
  roll().undo();
  roll().undo();
  roll().undo();
  assert.equal(roll().tracks[0].controls, undefined, 'undo takes them away');
  roll().redo();
  assert.deepEqual(roll().tracks[0].controls, PEDAL, 'redo brings them back');
  // CLEAR removes the part's notes and its controllers together, as one step.
  roll().setActiveTrack(pno);
  cut();
  const before = roll()._undo.length;
  roll().clear();
  assert.equal(roll().notes.length, 0);
  assert.equal(roll().tracks.find((t) => t.id === pno)?.controls, undefined, 'CLEAR takes the controllers with the notes');
  assert.equal(roll()._undo.length, before + 1);
  roll().undo();
  assert.deepEqual(roll().tracks.find((t) => t.id === pno)?.controls, PEDAL, 'and undo brings both back');
  assert.equal(roll().notes.length, 1);

  // A one-part file into the active part: its notes, its controllers and its instrument in ONE step.
  roll().importParts([{ name: 'Part 1', notes: [n(0, 60)] }, { name: 'Other', notes: [n(0, 50)] }], 100);
  const target = roll().activeTrackId;
  cut();
  const s0 = roll()._undo.length;
  applyRollParts(
    [{ track: { name: 'Clarinet', program: 71, instrumentId: 'clarinet-bb', controls: [{ tick: 0, controller: 11, value: 70 }] }, notes: migrateNotes([n(0, 62), n(4, 64)]) }],
    100,
    undefined,
    undefined,
    undefined,
  );
  const part = rollTracksOf(roll()).find((t) => t.id === target)!;
  assert.deepEqual([part.notes.length, part.program, part.instrumentId, part.controls], [2, 71, 'clarinet-bb', [{ tick: 0, controller: 11, value: 70 }]]);
  assert.equal(roll()._undo.length, s0 + 1, 'the import is one undo step');
  roll().undo();
  const undone = rollTracksOf(roll()).find((t) => t.id === target)!;
  assert.deepEqual([undone.notes.length, undone.program, undone.controls], [1, null, undefined], 'one undo puts notes, sound and controllers back');
}

// ── EDIT: the clip keeps them and a render plays them ───────────────────────
{
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Piano', program: 0, controls: PEDAL, notes: [n(0, 48), n(8, 52)] }, { name: 'Cello', program: 42, notes: [n(0, 36)] }], 96);
  const renders: Array<{ controls?: readonly RollControl[] }> = [];
  const global = { useSoundfont: true, activeProgram: 0 };
  // EDIT's MIDI render queue with a stand-in synth: the one place a part's audio is rendered.
  const render: MidiStepRender = (_notes, _bpm, _total, opts) => {
    renders.push({ controls: opts.controls });
    return Promise.resolve({ blob: new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' }), duration: 2 });
  };
  configureMidiRenderQueue({
    render,
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
    global: () => global,
    ensureReady: () => Promise.resolve(),
    livePlan: liveMidiIfHeard,
  });
  const deps: RollBounceDeps = { global: () => global };
  await bounceRollToEditor(deps);
  assert.equal(renders.length, 0, 'both parts play live: the EDIT key renders nothing');
  const [pno, vc] = rollTracksOf(roll()).map((t) => t.id);
  const clip = ed().clips.find((c) => c.id === partLinkOf(roll(), pno))!;
  // Keep rendered audio on each part: the render plays the part's controllers.
  await requestMidiRender(clip.id, 'keep');
  await requestMidiRender(partLinkOf(roll(), vc) as string, 'keep');
  assert.deepEqual(renders.map((r) => r.controls), [PEDAL, undefined], 'the piano renders with its pedal and volume; the cello has none');
  assert.deepEqual(clip.sourceRollPart?.controls, PEDAL, "the clip's part record keeps them");
  assert.deepEqual(clipRenderInput(clip, 64).controls, PEDAL, 'a re-render reads them from the clip');
  // Into the .tasmo shape and back, and a hand-edited record cleaned.
  const saved = JSON.parse(JSON.stringify(rollPartToTasmo(clip.sourceRollPart!)));
  assert.deepEqual(saved.controls, PEDAL);
  assert.deepEqual(tasmoRollPart(saved, { name: 'x', color: '#000000' })?.controls, PEDAL);
  assert.equal(tasmoRollPart({ ...saved, controls: undefined }, { name: 'x', color: '#000000' })?.controls, undefined, 'a file written before controllers opens without them');
  assert.deepEqual(cleanRollPartRef({ ...saved, controls: [{ tick: 3, controller: 64, value: 999 }, { tick: 1, controller: 3, value: 1 }] }, { name: 'x', color: '#000' })?.controls, [{ tick: 3, controller: 64, value: 127 }]);
  // Opening the clip in the roll gives the part its controllers again.
  roll().importParts([{ name: 'Else', notes: [n(0, 60)] }], 120);
  roll().loadFromClip(...clipPartsLoad(clip, ed().clips, ed().tracks));
  assert.deepEqual(rollTracksOf(roll())[0].controls, PEDAL, 'Edit in Piano Roll brings them back');
  assert.deepEqual(rollPartRef(rollTracksOf(roll())[0], 0, 'd').controls, PEDAL);
}

// ── a render plays them at their seconds, on every channel the notes use ────
{
  const tempoMap = [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 60 }];
  const req = stepRenderRequest([{ note: 60, velocity: 90, step: 0, length: 16 }], 120, 32, { program: 0, controls: PEDAL, tempoMap });
  // Tick 480 is beat 0.5 (0.25 s at 120); tick 1920 is beat 2 (1 s).
  assert.deepEqual(req.options.controls?.map((c) => [c.sec, c.channel, c.controller, c.value]), [
    [0, 0, 7, 96],
    [0, 0, 10, 40],
    [0.25, 0, 64, 127],
    [1, 0, 64, 0],
    [1, 0, 11, 80],
  ]);
  const drums = stepRenderRequest([{ note: 36, velocity: 90, step: 0, length: 4 }], 120, 16, { percussion: true, controls: [{ tick: 0, controller: 7, value: 80 }] });
  assert.deepEqual(drums.options.controls?.map((c) => c.channel), [9], 'a drum render sets the drum channel');
  assert.equal(stepRenderRequest([{ note: 60, velocity: 90, step: 0, length: 4 }], 120, 16, {}).options.controls, undefined, 'no controllers, no field');
  // The render's MIDI carries them.
  const smf = notesToSmf([{ midi: 60, startSec: 0, durationSec: 1, velocity: 90 }], 0, 0, [], 120, [], { controls: req.options.controls ?? [] });
  assert.deepEqual(parseMidi(smf).tracks[0].controls?.map((c) => [c.tick, c.controller, c.value]), [[0, 7, 96], [0, 10, 40], [240, 64, 127], [960, 64, 0], [960, 11, 80]]);
}

console.log('rollPartControls: ok');
