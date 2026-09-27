/**
 * Stage 2's pieces played together, the way the roll's own controls write
 * them: a 7/8 3+2+2 roll whose TEMPO lane holds a ritardando (the lane's store
 * actions), a line of eighths swung by APPLY with a group groove, then a
 * quintuplet drawn with the Quintuplet snap inside the slowing bar (rollSnap
 * clickPlacement, then the store's addNote, as a click on the grid does), and
 * the CLICK in Groups.
 *
 * Then: the live scheduler's clock (startRollPlay, windowOnsets, rollClickPlan)
 * puts every click on its group start and every note where the render puts it;
 * the bounce (rollBounce through the render request and SpessaSynth, as in
 * tempoBounce.audio.test) sounds each note within 10 ms of its time under the
 * map; the MIDI export read back into the roll (the MIDI tab's import) brings
 * back the map, the meter and every note, and bounces to the same seconds.
 *
 * Run from `frontend/`:
 *   npx tsx src/lib/symphonyTime.audio.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { stepRenderRequest } from './midiSynth.ts';
import { notesRenderSmf } from './soundfontEngine.ts';
import { bounceRollToEditor } from './rollBounce.ts';
import { clickPlacement, snapGrid, TICKS_PER_STEP } from './rollSnap.ts';
import { feelRollNotes } from './rollClip.ts';
import { grooveById } from './grooveTemplate.ts';
import { rollClickPlan, rollClickSteps } from './rollClick.ts';
import { lapTimeOf, startRollPlay, stepClock } from './rollTempo.ts';
import { windowOnsets } from './rollTransport.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { midiFileToRoll, rollToMidiFile } from './rollMidi.ts';
import { unrollLanes } from './meterMap.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';
import { useEditorStore } from '../state/editorStore.ts';

const SR = 44100;
const WOODBLOCK = 115;
const sfBytes = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const sf = sfBytes.buffer.slice(sfBytes.byteOffset, sfBytes.byteOffset + sfBytes.byteLength) as ArrayBuffer;

/** Render a MIDI file through SpessaSynth's processor for `seconds`, left channel. */
async function renderMidi(bytes: Uint8Array, seconds: number): Promise<Float32Array> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false, eventsEnabled: false });
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf.slice(0)), 'main');
  await synth.processorInitialized;
  const midi = BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const events: Array<{ sample: number; data: Uint8Array }> = [];
  for (const track of midi.tracks) {
    for (const e of track.events) {
      if (e.statusByte < 0x80 || e.statusByte >= 0xf0) continue;
      events.push({ sample: Math.round(midi.midiTicksToSeconds(e.ticks) * SR), data: new Uint8Array([e.statusByte, ...e.data]) });
    }
  }
  events.sort((a, b) => a.sample - b.sample);
  const total = Math.ceil(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let next = 0;
  for (let at = 0; at < total; at += 128) {
    while (next < events.length && events[next].sample <= at) synth.processMessage(events[next++].data);
    synth.process(left, right, at, Math.min(128, total - at));
  }
  return left;
}

/** Where the sound first rises past a quarter of its peak within `win` seconds after `from`. */
function onsetAfter(audio: Float32Array, from: number, win: number): number {
  const a = Math.max(0, Math.floor(from * SR));
  const b = Math.min(audio.length, a + Math.floor(win * SR));
  let peak = 0;
  for (let i = a; i < b; i += 1) peak = Math.max(peak, Math.abs(audio[i]));
  for (let i = a; i < b; i += 1) if (Math.abs(audio[i]) >= peak / 4) return i / SR;
  return Number.NaN;
}

/** Bounce the roll to EDIT as the app does, keeping the soundfont MIDI the render plays. */
async function bounce(): Promise<{ smf: Uint8Array; seconds: number; starts: number[] }> {
  let smf: Uint8Array | null = null;
  let seconds = 0;
  let starts: number[] = [];
  const done = await bounceRollToEditor({
    render: (n, bpm, total, opts) => {
      const req = stepRenderRequest(n, bpm, total, { ...opts, program: WOODBLOCK });
      smf = notesRenderSmf(req.notes, req.options);
      seconds = req.nominalSec;
      starts = req.notes.map((r) => r.startSec).sort((x, y) => x - y);
      return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: req.nominalSec });
    },
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
    global: () => ({ useSoundfont: true, activeProgram: WOODBLOCK }),
  });
  assert.ok(done && smf, 'the roll bounced');
  return { smf: smf as Uint8Array, seconds, starts };
}

const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const BAR = 14; // steps in a 7/8 bar
const TOTAL = 4 * BAR;

async function main(): Promise<void> {
  useEditorStore.getState().loadProject({ tracks: [], clips: [] });
  const roll = () => usePianoRollStore.getState();
  roll().clear();
  roll().setEditingClip(null);
  roll().importNotes([], 120, { meterMap: [{ bar: 0, meter: M78 }], pickupSteps: 0, lanes: [{ id: 0, name: 'A', cycleSteps: null }] }, []);
  roll().setTotalSteps(TOTAL);
  assert.equal(roll().totalSteps, TOTAL);

  // The TEMPO lane: 120 until bar 3, then a ramp down to 60 at the roll's end.
  roll().addTempoEvent({ beat: 7, bpm: 120, curve: 'linear' });
  roll().addTempoEvent({ beat: 14, bpm: 60 });
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm, e.curve]), [[0, 120, 'step'], [7, 120, 'linear'], [14, 60, 'step']]);

  // One woodblock on every group start: 0, 6 and 10 in each bar.
  const groupStarts: number[] = [];
  for (let b = 0; b < 4; b += 1) for (const g of [0, 6, 10]) groupStarts.push(b * BAR + g);
  for (const step of groupStarts) roll().addNote({ note: 76, step, length: 1, velocity: 110 });

  // Bar 4's eighths swung by APPLY on the 1/8 snap with Group swing 8ths 66%: the swing follows 3+2+2.
  roll().setSnap('1/8');
  const eighths = [44, 46, 50, 54];
  for (const step of eighths) roll().addNote({ note: 72, step, length: 1, velocity: 110 });
  const groove = grooveById('group8:66');
  assert.ok(groove, 'the group groove resolves');
  const s = roll();
  roll().replaceAll(feelRollNotes(s.notes, { meterMap: s.meterMap, pickupSteps: s.pickupSteps, lanes: s.lanes, totalSteps: s.totalSteps }, { snap: s.snap, strength: 1, groove, grooveStrength: 1 }));
  const swung = new Map(roll().notes.filter((n) => n.note === 72).map((n) => [Math.round(n.step), n.step]));
  const late = 0.64; // 66% of a pair of 8ths puts the off-8th 0.64 steps late, kept on whole ticks
  assert.ok(Math.abs((swung.get(45) ?? 0) - (44 + late)) <= 1 / TICKS_PER_STEP, `44 is the short of 42-44: ${[...swung.values()]}`);
  assert.equal(swung.get(46), 46, "46 is the 3-group's plain third");
  assert.ok(Math.abs((swung.get(51) ?? 0) - (50 + late)) <= 1 / TICKS_PER_STEP, '50 is the short of 48-50');
  assert.ok(Math.abs((swung.get(55) ?? 0) - (54 + late)) <= 1 / TICKS_PER_STEP, '54 is the short of 52-54');
  for (const step of groupStarts) assert.ok(roll().notes.some((n) => n.note === 76 && n.step === step), `the group start ${step} did not move`);
  // A quintuplet drawn with the snap in bar 3's second group (step 34), inside the ritardando.
  roll().setSnap('1/16Q');
  const stepPx = 20;
  const grid = snapGrid(roll().meterMap, roll().pickupSteps, roll().totalSteps, roll().snap);
  const quint: Array<{ tick: number; ticks: number }> = [];
  for (let k = 0; k < 5; k += 1) {
    const x = (34 * TICKS_PER_STEP + k * 192 + 20) / TICKS_PER_STEP * stepPx; // a little past each line, as a hand lands
    const placed = clickPlacement(grid, x, stepPx);
    assert.ok(placed);
    quint.push(placed);
    // Only the group start already holds a note at pitch 76; the quintuplet is drawn a fifth higher.
    roll().addNote({ note: 83, step: placed.tick / TICKS_PER_STEP, length: placed.ticks / TICKS_PER_STEP, tick: placed.tick, ticks: placed.ticks, velocity: 110 } as Omit<PianoNote, 'id'>);
  }
  assert.deepEqual(quint.map((q) => q.tick), [0, 1, 2, 3, 4].map((k) => 34 * TICKS_PER_STEP + k * 192), 'five cells in a quarter');
  assert.ok(quint.every((q) => q.ticks === 192));

  const ticksBefore = roll().notes.map((n) => n.tick).sort((a, b) => a - b);

  // The clock the live scheduler builds: clicks in Groups land on each group start at its time under the map.
  const clock = stepClock(roll().bpm, roll().tempoMap);
  const play = startRollPlay(roll(), 0);
  const clicks = rollClickSteps(roll().meterMap, roll().pickupSteps, roll().totalSteps, 'group');
  assert.deepEqual(clicks.map((c) => c.step), groupStarts, 'the click counts 3+2+2');
  assert.deepEqual(clicks.filter((c) => c.accent).map((c) => c.step), [0, 14, 28, 42]);
  const plan = rollClickPlan(play.clock, 0, clicks, 0, clock.at(TOTAL) - 1e-6);
  assert.equal(plan.length, groupStarts.length);
  plan.forEach((p, i) => assert.ok(Math.abs(p.sec - clock.at(groupStarts[i])) < 1e-9, `click ${i} at ${p.sec}`));
  const gaps = plan.map((p, i) => (i ? p.sec - plan[i - 1].sec : 0));
  // Steps 20-24 and 34-38 are both four 16ths: the second, inside the ramp, lasts longer.
  assert.ok(gaps[8] > gaps[5] * 1.05, 'bar 3 clicks slow down through the ramp');
  const played = unrollLanes(roll().notes, roll().lanes, roll().totalSteps);
  const live = windowOnsets(played, play.lapState.lap, -1, TOTAL - 1e-6).map(({ abs }) => lapTimeOf(play.clock, abs));

  // Bounced: every onset under the map, heard in the audio.
  const first = await bounce();
  const want = played.map((n) => clock.at(n.step)).sort((a, b) => a - b);
  assert.equal(first.starts.length, want.length);
  first.starts.forEach((t, i) => assert.ok(Math.abs(t - want[i]) < 1e-6, `render ${i}: ${t} vs ${want[i]}`));
  live.sort((a, b) => a - b).forEach((t, i) => assert.ok(Math.abs(t - want[i]) < 1e-6, `live ${i}: ${t} vs ${want[i]}`));
  const audio = await renderMidi(first.smf, first.seconds + 0.5);
  const onsets = [...new Set(want.map((t) => Math.round(t * 1e6) / 1e6))];
  onsets.forEach((t, i) => {
    const gap = i + 1 < onsets.length ? onsets[i + 1] - t : 0.2;
    const heard = onsetAfter(audio, Math.max(0, t - 0.005), Math.min(0.1, gap));
    assert.ok(Math.abs(heard - t) < 0.01, `onset ${i}: heard at ${heard.toFixed(4)} s, written for ${t.toFixed(4)} s`);
  });
  const q0 = clock.at(34);
  const quintHeard = [0, 1, 2, 3, 4].map((k) => clock.at(34 + (k * 192) / TICKS_PER_STEP) - q0);
  assert.ok(quintHeard[4] - quintHeard[3] > quintHeard[1] - quintHeard[0], 'the quintuplet itself slows with the ramp');
  assert.deepEqual(roll().notes.map((n) => n.tick).sort((a, b) => a - b), ticksBefore, 'the bounce moved no note');

  // Exported, read back through the MIDI tab's import, and bounced again.
  const file = midiFileToRoll(parseMidi(encodeMidi(rollToMidiFile(roll()))), 'imp');
  roll().importNotes(file.notes, file.bpm, file.meter, file.bends, file.tempoMap);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm, e.curve]), [[0, 120, 'step'], [7, 120, 'linear'], [14, 60, 'step']]);
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M78 }]);
  const ticksBack = roll().notes.map((n) => n.tick).sort((a, b) => a - b);
  // ROLL_PPQ 480: the quintuplet (96 file ticks a cell) comes back exactly, and a swung 8th to within half a file tick.
  assert.equal(ticksBack.length, ticksBefore.length);
  ticksBack.forEach((t, i) => assert.ok(Math.abs(t - ticksBefore[i]) <= 1, `note ${i}: tick ${t} came back for ${ticksBefore[i]}`));
  for (const q of quint) assert.ok(ticksBack.includes(q.tick), `quintuplet tick ${q.tick} came back exactly`);
  const again = await bounce();
  again.starts.forEach((t, i) => assert.ok(Math.abs(t - first.starts[i]) < 1.1e-3, `re-import ${i}: ${t} vs ${first.starts[i]}`));
  console.log(`symphonyTime.audio: ok (${onsets.length} onsets, last at ${onsets.at(-1)?.toFixed(3)} s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
