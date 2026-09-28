/**
 * The safety limiter after a synth whose channel plays a preset lifted above
 * unity by its playback gain (public/safety-limiter.worklet.js,
 * lib/synthOutputStage), and when the live stage and the render put it in.
 *
 * The limiter is the worklet file itself, run on stand-ins for the worklet
 * globals. The chord is gm.sf3's flute (0:73) with a +10.9 dB playback gain
 * registered, four notes at velocity 127 at the General MIDI volume: without the
 * limiter it passes full scale, through it no sample is above -0.3 dBFS, and
 * a single note that stays under the ceiling comes out unchanged.
 *
 *   cd frontend && npx tsx src/lib/safetyLimiter.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicMIDI, SpessaSynthProcessor, type BasicSoundBank } from 'spessasynth_core';
import { clearSoundbankGains, dbToGain, registerSoundbankGains, renderBoosted, selectionGainDb } from './soundbankGain.ts';
import { LEVEL_SAMPLE_RATE, loadBank } from './soundbankLevels.ts';
import { notesToSmf } from './midiWrite.ts';
import {
  SAFETY_CEILING_DB,
  SAFETY_LIMITER_NAME,
  SAFETY_RELEASE_SEC,
  createOutputStage,
  outputOf,
  setChannelLift,
  stageConnect,
  stageConnectChannel,
  stageDisconnectChannel,
  type LimiterNode,
  type StageSynth,
} from './synthOutputStage.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FLUTE_GAIN_DB = 10.9;

/* ── the worklet file, on stand-ins for its globals ────────────────────────── */

interface Processor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
type ProcessorClass = new (options?: { processorOptions?: Record<string, number> }) => Processor;
function loadLimiter(): { name: string; cls: ProcessorClass } {
  const code = readFileSync(join(here, '..', '..', 'public', 'safety-limiter.worklet.js'), 'utf8');
  let got: { name: string; cls: ProcessorClass } | null = null;
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', code) as (
    base: unknown,
    register: (name: string, cls: ProcessorClass) => void,
    rate: number,
  ) => void;
  run(class {}, (name, cls) => { got = { name, cls }; }, LEVEL_SAMPLE_RATE);
  assert.ok(got, 'the worklet registers its processor');
  return got!;
}
const { name, cls: Limiter } = loadLimiter();
assert.equal(name, SAFETY_LIMITER_NAME);

/** `left`/`right` through a fresh limiter, 128 frames at a time. */
function limit(left: Float32Array, right: Float32Array, active = true): { left: Float32Array; right: Float32Array } {
  const proc = new Limiter({ processorOptions: { ceilingDb: SAFETY_CEILING_DB, releaseSec: SAFETY_RELEASE_SEC } });
  const outL = new Float32Array(left.length);
  const outR = new Float32Array(right.length);
  const on = { active: new Float32Array([active ? 1 : 0]) };
  for (let i = 0; i < left.length; i += 128) {
    const n = Math.min(128, left.length - i);
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    proc.process([[left.subarray(i, i + n), right.subarray(i, i + n)]], [[oL, oR]], on);
    outL.set(oL, i);
    outR.set(oR, i);
  }
  return { left: outL, right: outR };
}

const peakDb = (l: Float32Array, r: Float32Array): number => {
  let p = 0;
  for (let i = 0; i < l.length; i += 1) p = Math.max(p, Math.abs(l[i]), Math.abs(r[i]));
  return 20 * Math.log10(p);
};
const rmsDb = (l: Float32Array, r: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < l.length; i += 1) sum += l[i] * l[i] + r[i] * r[i];
  return 10 * Math.log10(sum / (2 * l.length));
};

/* ── the flute, lifted ──────────────────────────────────────────────────────── */

const gmBytes = readFileSync(join(here, '..', '..', 'public', 'soundfonts', 'gm.sf3'));
const gm: BasicSoundBank = loadBank(gmBytes.buffer.slice(gmBytes.byteOffset, gmBytes.byteOffset + gmBytes.byteLength) as ArrayBuffer);

/** `notes` held 1 s at velocity 127 on the flute with its playback gain on the channel, at the General MIDI volume (CC 7 at 100). */
async function flute(notes: number[]): Promise<{ left: Float32Array; right: Float32Array }> {
  const synth = new SpessaSynthProcessor(LEVEL_SAMPLE_RATE, { eventsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(gm, 'gm');
  synth.programChange(0, 73);
  synth.midiChannels[0].setSystemParameter('gain', dbToGain(selectionGainDb(0, 73, 0)));
  for (const n of notes) synth.noteOn(0, n, 127);
  const frames = Math.round(1.8 * LEVEL_SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    if (i >= LEVEL_SAMPLE_RATE && i < LEVEL_SAMPLE_RATE + 128) for (const n of notes) synth.noteOff(0, n);
    synth.process(left, right, i, Math.min(128, frames - i));
  }
  return { left, right };
}

clearSoundbankGains();
registerSoundbankGains('orchestra', { playback_gain: { '0:73': FLUTE_GAIN_DB } });

// A four-note fortissimo chord passes full scale; through the limiter no sample is above the ceiling.
{
  const chord = await flute([84, 88, 91, 96]);
  const before = peakDb(chord.left, chord.right);
  assert.ok(before > 0, `the lifted chord passes full scale without the limiter: ${before.toFixed(2)} dBFS`);
  const out = limit(chord.left, chord.right);
  const after = peakDb(out.left, out.right);
  assert.ok(after <= SAFETY_CEILING_DB + 1e-4, `no sample above ${SAFETY_CEILING_DB} dBFS: ${after.toFixed(3)} dBFS`);
  console.log(`chord: ${before.toFixed(2)} dBFS without the limiter, ${after.toFixed(3)} dBFS through it`);
  // Switched off, it takes no reduction and passes the signal as it is.
  const off = limit(chord.left, chord.right, false);
  assert.equal(peakDb(off.left, off.right), before);
}

// A single note under the ceiling comes out unchanged.
{
  const note = await flute([72]);
  const before = peakDb(note.left, note.right);
  assert.ok(before < SAFETY_CEILING_DB, `the single note stays under the ceiling: ${before.toFixed(2)} dBFS`);
  const out = limit(note.left, note.right);
  assert.ok(Math.abs(peakDb(out.left, out.right) - before) < 0.1, 'its peak is unchanged');
  assert.ok(Math.abs(rmsDb(out.left, out.right) - rmsDb(note.left, note.right)) < 0.1, 'its level is unchanged');
  console.log(`single note: ${before.toFixed(2)} dBFS, through the limiter ${peakDb(out.left, out.right).toFixed(2)} dBFS`);
}

/* ── when the render puts it in ─────────────────────────────────────────────── */

{
  const file = (program: number): BasicMIDI => {
    const smf = notesToSmf([{ midi: 72, startSec: 0, durationSec: 1, velocity: 127 }], program);
    return BasicMIDI.fromArrayBuffer(smf.buffer.slice(smf.byteOffset, smf.byteOffset + smf.byteLength) as ArrayBuffer, 'lift');
  };
  assert.equal(renderBoosted(file(73)), true, 'a file on the lifted flute renders through the limiter');
  assert.equal(renderBoosted(file(40)), false, 'a file on a preset with no lift does not');
  registerSoundbankGains('orchestra', { playback_gain: { '0:73': -2 } });
  assert.equal(renderBoosted(file(73)), false, 'a gain that lowers a preset needs no limiter');
}
clearSoundbankGains();

/* ── the live output stage ──────────────────────────────────────────────────── */

{
  interface Node { id: string; to: string[]; connect(n: Node): Node; disconnect(n: Node): void }
  const node = (id: string): Node => {
    const n: Node = {
      id,
      to: [],
      connect(t) { n.to.push(t.id); return t; },
      disconnect(t) {
        const i = n.to.indexOf(t.id);
        if (i < 0) throw new Error('not connected');
        n.to.splice(i, 1);
      },
    };
    return n;
  };
  const synthOut: string[][] = Array.from({ length: 17 }, () => []);
  const synth: StageSynth = {
    connect: (t) => { for (const o of synthOut) o.push((t as unknown as Node).id); return t; },
    connectChannel: (t, ch) => { synthOut[(ch % 16) + 1].push((t as unknown as Node).id); return t; },
    disconnectChannel: (t, ch) => {
      const list = synthOut[(ch % 16) + 1];
      list.splice(list.indexOf((t as unknown as Node).id), 1);
    },
  };
  let made = 0;
  const active: Array<[string, number, number]> = [];
  const makeLimiter = (): LimiterNode => {
    const n = node(`limiter${made++}`);
    return Object.assign(n, {
      parameters: { get: () => ({ setValueAtTime: (v: number, t: number) => { active.push([n.id, v, t]); } }) },
    }) as unknown as LimiterNode;
  };
  let nodes = 0;
  const stage = createOutputStage({ createGain: () => node(`out${nodes++}`) as unknown as GainNode }, synth, makeLimiter);
  const master = node('master');
  const track = node('track');
  stageConnect(stage, master as unknown as AudioNode);
  assert.deepEqual(synthOut[0], ['out0'], 'the effects bus plays into its own node');
  for (let ch = 0; ch < 16; ch += 1) assert.deepEqual(synthOut[ch + 1], [`out${ch + 1}`], `channel ${ch} plays into its own node`);
  assert.ok(stage.outs.every((o) => (o as unknown as Node).to.includes('master')), 'every node reaches the master');

  // A channel routed to a track goes from its node.
  stageDisconnectChannel(stage, master as unknown as AudioNode, 3);
  stageConnectChannel(stage, track as unknown as AudioNode, 3);
  assert.deepEqual((stage.outs[outputOf(3)] as unknown as Node).to, ['track']);

  // No lift, no limiter.
  setChannelLift(stage, 3, false, 1);
  assert.equal(made, 0);
  // The flute's program change at 2 s: the limiter goes in ahead of channel 3's node, idle until then.
  setChannelLift(stage, 3, true, 2);
  assert.equal(made, 1);
  assert.deepEqual(synthOut[outputOf(3)], ['limiter0'], 'channel 3 plays into its limiter');
  assert.deepEqual((stage.limiters[outputOf(3)] as unknown as Node).to, ['out4'], 'the limiter plays into the channel node');
  assert.deepEqual((stage.outs[outputOf(3)] as unknown as Node).to, ['track'], 'the routing is untouched');
  assert.deepEqual(active, [['limiter0', 0, 0], ['limiter0', 1, 2]]);
  // Channel 19 shares the output: the limiter stays on until neither plays a lifted preset.
  setChannelLift(stage, 19, true, 3);
  setChannelLift(stage, 3, false, 4);
  setChannelLift(stage, 19, false, 5);
  assert.deepEqual(active.slice(2), [['limiter0', 1, 3], ['limiter0', 1, 4], ['limiter0', 0, 5]]);
  assert.equal(made, 1, 'one limiter per output');
  // Where the limiter module did not load, the channel plays on without one.
  const bare = createOutputStage({ createGain: () => node(`bare${nodes++}`) as unknown as GainNode }, synth, () => null);
  setChannelLift(bare, 5, true, 0);
  assert.equal(bare.limiters[outputOf(5)], null);
}

console.log('safetyLimiter: ok');
