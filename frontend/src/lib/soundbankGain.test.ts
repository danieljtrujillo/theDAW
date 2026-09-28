/**
 * soundbankGain: a preset whose samples sit 10 dB under gm.sf3 plays at the
 * gm.sf3 level once its manifest's playback gain is registered, live and in
 * a render.
 *
 * The quiet preset is gm.sf3's own violin (0:40) with 10 dB of preset
 * attenuation added, so the only difference from the reference is the
 * shortfall. Live is the engine's path: the channel's program, then
 * applyChannelGain on the synth. The render is the offline worklet's path,
 * run on spessasynth_core: the bank, the snapshot from renderGainSnapshot,
 * then the sequencer plays the MIDI file.
 *
 * Run: `npx tsx src/lib/soundbankGain.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicMIDI, GeneratorTypes, SpessaSynthProcessor, SpessaSynthSequencer, type BasicSoundBank } from 'spessasynth_core';
import {
  applyChannelGain,
  clearSoundbankGains,
  midiChannelSelections,
  registerSoundbankGains,
  renderChannelGains,
  renderGainSnapshot,
  selectionGainDb,
  setBundledKits,
  soundbankGainDb,
} from './soundbankGain.ts';
import { LEVEL_SAMPLE_RATE, loadBank, maxWindowRmsDb, measureLevel } from './soundbankLevels.ts';
import { notesToSmf } from './midiWrite.ts';

const TOLERANCE_DB = 1.5;
const here = dirname(fileURLToPath(import.meta.url));
const gmBytes = readFileSync(join(here, '..', '..', 'public', 'soundfonts', 'gm.sf3'));
const load = (): BasicSoundBank => loadBank(gmBytes.buffer.slice(gmBytes.byteOffset, gmBytes.byteOffset + gmBytes.byteLength) as ArrayBuffer);

/** gm.sf3 with preset 0:40 made quieter by `centibels` of preset attenuation. */
function quietViolinBank(centibels: number): BasicSoundBank {
  const bank = load();
  const violin = bank.presets.find((p) => p.program === 40 && p.bankMSB === 0 && !p.isGMGSDrum);
  assert.ok(violin, 'gm.sf3 has a violin at 0:40');
  violin!.globalZone.setGenerator(GeneratorTypes.initialAttenuation, centibels);
  return bank;
}

const job = { bank: 0, program: 40, note: 67, velocity: 100, cc1: 127, seconds: 1.5 };

// ── the lookup ────────────────────────────────────────────────────────────
{
  clearSoundbankGains();
  assert.equal(registerSoundbankGains('orchestra', { playback_gain: { '0:40': 10, '1:73': 12.5, '128:48': 3, 'x': 4, '2:40': Number.NaN } }), 3);
  assert.equal(soundbankGainDb('orchestra', 0, 40), 10);
  assert.equal(soundbankGainDb('orchestra', 0, 41), 0);
  assert.equal(soundbankGainDb('gm', 0, 40), 0);
  assert.equal(selectionGainDb(1, 73), 12.5);
  // The drum channel selects the kit bank whatever CC 0 says.
  assert.equal(selectionGainDb(0, 48, 9), 3);
  assert.equal(selectionGainDb(0, 48, 3), 0);
  // A bank loaded with an offset answers bank selects shifted by it.
  registerSoundbankGains('orchestra', { playback_gain: { '1:73': 12.5 } }, 20);
  assert.equal(selectionGainDb(1, 73), 0);
  assert.equal(selectionGainDb(21, 73), 12.5);
  clearSoundbankGains();
}

// ── two program changes one lookahead window queues: each brings its gain ──
{
  clearSoundbankGains();
  registerSoundbankGains('orch', { playback_gain: { '0:73': 6 } }, 40);
  const calls: number[] = [];
  const target = { midiChannels: [{ setSystemParameter: (_p: 'gain', v: number) => calls.push(Number(v.toFixed(3))) }] };
  applyChannelGain(target, 0, 40, 73, 0.05); // the lifted flute from +50 ms
  applyChannelGain(target, 0, 40, 71, 0.1); // a clarinet with no gain from +100 ms
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(calls, [1.995, 1], 'the flute plays lifted, then the clarinet at unity');
  clearSoundbankGains();
}

// ── a kit the bundled bank also has: the bundled kit plays, at unity ──────
{
  clearSoundbankGains();
  registerSoundbankGains('orchestra', { playback_gain: { '128:48': 4, '128:50': 2 } }, 40);
  // SpessaSynth takes the first bank's kit: gm.sf3's, where it has one.
  const kits = load().presets.filter((p) => p.isGMGSDrum).map((p) => p.program);
  assert.ok(kits.includes(48) && !kits.includes(50));
  setBundledKits(kits);
  assert.equal(selectionGainDb(0, 48, 9), 0, "gm.sf3's Orchestral kit plays at 48: the user kit's lift is not applied to it");
  assert.equal(selectionGainDb(0, 50, 9), 2, 'a kit only the user bank has keeps its gain');
  setBundledKits([]);
  clearSoundbankGains();
}

// ── what a MIDI file's channels select ────────────────────────────────────
{
  const smf = notesToSmf([{ midi: 67, startSec: 0, durationSec: 1, velocity: 100 }], 73, 0, [], 120, [], { bank: 1 });
  const midi = BasicMIDI.fromArrayBuffer(smf.buffer.slice(smf.byteOffset, smf.byteOffset + smf.byteLength) as ArrayBuffer, 'sel');
  assert.deepEqual([...midiChannelSelections(midi)], [[0, { bank: 1, program: 73 }]]);
  registerSoundbankGains('orchestra', { playback_gain: { '1:73': 6 } });
  assert.ok(Math.abs((renderChannelGains(midi).get(0) ?? 0) - 10 ** (6 / 20)) < 1e-9);
  clearSoundbankGains();
  assert.equal(renderGainSnapshot(midi, LEVEL_SAMPLE_RATE), undefined, 'no gain, no snapshot: the render is untouched');
}

const gm = load();
const reference = await measureLevel(gm, job);
// The attenuation that leaves the violin 10 dB short: SpessaSynth scales a
// zone's attenuation and clamps the sum, so it is found by measuring.
let quiet = quietViolinBank(250);
let short = await measureLevel(quiet, job);
for (let cb = 275; reference.rmsDb - short.rmsDb < 9.8 && cb <= 1000; cb += 25) {
  quiet = quietViolinBank(cb);
  short = await measureLevel(quiet, job);
}
const shortfall = reference.rmsDb - short.rmsDb;
assert.ok(Math.abs(shortfall - 10) < 1, `the quiet violin sits 10 dB under gm.sf3: ${shortfall.toFixed(2)} dB`);

registerSoundbankGains('orchestra', { playback_gain: { '0:40': 10 } });

// ── live: the program switch applies the channel gain ────────────────────
{
  const live = await measureLevel(quiet, job, (synth, ch) => applyChannelGain(synth, ch, 0, 40));
  const diff = live.rmsDb - reference.rmsDb;
  assert.ok(Math.abs(diff) <= TOLERANCE_DB, `live plays ${diff.toFixed(2)} dB from gm.sf3`);
  console.log(`live: short ${shortfall.toFixed(2)} dB, with the gain ${diff.toFixed(2)} dB from gm.sf3`);
  // Switching the channel to a preset without a gain puts it back to unity.
  const back = await measureLevel(quiet, { ...job, program: 41 }, (synth, ch) => {
    applyChannelGain(synth, ch, 0, 40);
    applyChannelGain(synth, ch, 0, 41);
  });
  const plain = await measureLevel(quiet, { ...job, program: 41 });
  assert.ok(Math.abs(back.rmsDb - plain.rmsDb) < 0.01, 'a preset without a gain plays at unity');
}

// ── render: the snapshot carries the gain into the offline synth ─────────
async function renderLevel(bank: BasicSoundBank, withGain: boolean): Promise<number> {
  const smf = notesToSmf([{ midi: 67, startSec: 0, durationSec: 1.4, velocity: 100 }], 40, 0, [], 120, [], {
    controls: [
      { sec: 0, channel: 0, controller: 1, value: 127 },
      { sec: 0, channel: 0, controller: 91, value: 0 },
      { sec: 0, channel: 0, controller: 93, value: 0 },
    ],
  });
  const midi = BasicMIDI.fromArrayBuffer(smf.buffer.slice(smf.byteOffset, smf.byteOffset + smf.byteLength) as ArrayBuffer, 'render');
  const synth = new SpessaSynthProcessor(LEVEL_SAMPLE_RATE, { eventsEnabled: false });
  await synth.processorInitialized;
  // The worklet's startOfflineRender, in its order: bank, snapshot, song, play.
  synth.soundBankManager.addSoundBank(bank, 'bank-0');
  const snapshot = withGain ? renderGainSnapshot(midi, LEVEL_SAMPLE_RATE) : undefined;
  if (withGain) assert.ok(snapshot, 'a render of a gained preset carries a snapshot');
  if (snapshot) synth.applySnapshot(snapshot);
  const seq = new SpessaSynthSequencer(synth);
  seq.loadNewSongList([midi]);
  seq.play();
  const frames = Math.round(1.6 * LEVEL_SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    seq.processTick();
    synth.process(left, right, i, Math.min(128, frames - i));
  }
  return maxWindowRmsDb(left, right);
}
{
  const refRender = await renderLevel(gm, false);
  const shortRender = await renderLevel(quiet, false);
  assert.ok(refRender - shortRender > 8.5, `the render is short too: ${(refRender - shortRender).toFixed(2)} dB`);
  const gained = await renderLevel(quiet, true);
  const diff = gained - refRender;
  assert.ok(Math.abs(diff) <= TOLERANCE_DB, `the render plays ${diff.toFixed(2)} dB from gm.sf3`);
  console.log(`render: short ${(refRender - shortRender).toFixed(2)} dB, with the gain ${diff.toFixed(2)} dB from gm.sf3`);
}

clearSoundbankGains();
console.log('soundbankGain: ok');
