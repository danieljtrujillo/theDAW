/**
 * The safety limiter for sound bank presets lifted above unity by their
 * playback gain (public/safety-limiter.worklet.js, lib/synthOutputStage), the
 * single-note cap registration puts on a lift (lib/soundbankGain), and where
 * the live engine, a render and a bounce put the limiter.
 *
 * The limiter is the worklet file itself, run on stand-ins for the worklet
 * globals. The preset is gm.sf3's flute (0:73) with a +10.9 dB playback gain
 * in its manifest, and its clip check peak measured here the way the build
 * measures it (velocity 127 at the default CC 7, no gain):
 *
 *  - registration caps the lift, so no single velocity-127 note at CC 7 127,
 *    anywhere on the keyboard, passes -0.3 dBFS, and the limiter leaves a
 *    lone note exactly as it is;
 *  - a four-note fortissimo chord with the synth's reverb and chorus full up
 *    passes full scale in the synth's whole output (dry and effects), and
 *    through the limiter no sample of that sum is above -0.3 dBFS.
 *
 *   cd frontend && npx tsx src/lib/safetyLimiter.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicMIDI, SpessaSynthProcessor, type BasicSoundBank } from 'spessasynth_core';
import {
  anyLiftedVoice,
  clearSoundbankGains,
  dbToGain,
  registerSoundbankGains,
  renderBoosted,
  selectionGainDb,
  singleNoteGainCapDb,
} from './soundbankGain.ts';
import { LEVEL_SAMPLE_RATE, loadBank } from './soundbankLevels.ts';
import { notesToSmf } from './midiWrite.ts';
import {
  SAFETY_CEILING_DB,
  SAFETY_LIMITER_NAME,
  SAFETY_RELEASE_SEC,
  createLiftTracker,
  setLimiterActive,
  spliceLimiter,
  wireRenderOutput,
  type LimiterNode,
} from './synthOutputStage.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_GAIN_DB = 10.9;

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

/* ── the flute ──────────────────────────────────────────────────────────────── */

const gmBytes = readFileSync(join(here, '..', '..', 'public', 'soundfonts', 'gm.sf3'));
const gm: BasicSoundBank = loadBank(gmBytes.buffer.slice(gmBytes.byteOffset, gmBytes.byteOffset + gmBytes.byteLength) as ArrayBuffer);
const FRAMES = 128 * 620; // 1.8 s

/**
 * `notes` held 1 s at velocity 127 on the flute, the channel at `gainDb` of
 * playback gain and CC 7 `cc7`, reverb and chorus sends `fx` (0 = dry). The
 * synth's whole output: its dry mix plus its shared effects output.
 */
async function flute(notes: number[], gainDb: number, cc7: number, fx = 0): Promise<{ left: Float32Array; right: Float32Array }> {
  const synth = new SpessaSynthProcessor(LEVEL_SAMPLE_RATE, { eventsEnabled: false, effectsEnabled: fx > 0 });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(gm, 'gm');
  synth.programChange(0, 73);
  synth.controllerChange(0, 7, cc7);
  synth.controllerChange(0, 91, fx);
  synth.controllerChange(0, 93, fx);
  synth.midiChannels[0].setSystemParameter('gain', dbToGain(gainDb));
  for (const n of notes) synth.noteOn(0, n, 127);
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i += 128) {
    if (i === 128 * 344) for (const n of notes) synth.noteOff(0, n);
    // The whole sum: process() writes the dry mix and the effects returns into the same pair.
    synth.process(left, right, i, 128);
  }
  return { left, right };
}

clearSoundbankGains();

// The flute's clip check, as the build takes it: velocity 127 at the default CC 7 on its loudest note.
const KEYS = Array.from({ length: 48 }, (_, i) => 60 + i);
let checkPeak = 0;
for (const k of KEYS) {
  const r = await flute([k], 0, 100);
  checkPeak = Math.max(checkPeak, 10 ** (peakDb(r.left, r.right) / 20));
}

// ── registration caps the lift for a single note ──────────────────────────────
{
  const cap = singleNoteGainCapDb(checkPeak);
  assert.ok(cap < MANIFEST_GAIN_DB, `the manifest's +${MANIFEST_GAIN_DB} dB would take a lone note past the ceiling (cap ${cap.toFixed(2)} dB)`);
  registerSoundbankGains('orchestra', {
    playback_gain: { '0:73': MANIFEST_GAIN_DB, '0:40': -2, '0:41': 3 },
    levelling: { presets: [{ bank: 0, program: 73, clip_check: { output_peak: checkPeak } }, { bank: 0, program: 40, clip_check: { output_peak: 0.9 } }] },
  });
  const fluteGain = selectionGainDb(0, 73);
  assert.ok(Math.abs(fluteGain - cap) < 1e-9, `the flute plays at its cap: ${fluteGain.toFixed(2)} dB`);
  assert.equal(selectionGainDb(0, 40), -2, 'a cut is kept as it is');
  assert.equal(selectionGainDb(0, 41), 3, 'a preset with no clip check keeps its manifest gain');
  let loudest = -Infinity;
  let at = 0;
  for (const k of KEYS) {
    const r = await flute([k], fluteGain, 127);
    const p = peakDb(r.left, r.right);
    if (p > loudest) [loudest, at] = [p, k];
  }
  assert.ok(loudest <= SAFETY_CEILING_DB, `no single velocity-127 note at CC 7 127 passes the ceiling: ${loudest.toFixed(2)} dBFS at key ${at}`);
  // The limiter leaves the loudest lone note exactly as it is.
  const lone = await flute([at], fluteGain, 127);
  const out = limit(lone.left, lone.right);
  let diff = 0;
  for (let i = 0; i < FRAMES; i += 1) diff = Math.max(diff, Math.abs(out.left[i] - lone.left[i]), Math.abs(out.right[i] - lone.right[i]));
  assert.equal(diff, 0, 'a lone note under the ceiling passes the limiter sample for sample');
  console.log(`single note: gain capped from +${MANIFEST_GAIN_DB} to +${fluteGain.toFixed(2)} dB, loudest note ${at} at ${loudest.toFixed(2)} dBFS, untouched by the limiter`);

  // A chord with the synth's reverb and chorus, as the master limiter sees it.
  const chord = await flute([84, 88, 91, 96], fluteGain, 127, 127);
  const before = peakDb(chord.left, chord.right);
  assert.ok(before > SAFETY_CEILING_DB, `the chord and its reverb pass the ceiling without the limiter: ${before.toFixed(2)} dBFS`);
  const limited = limit(chord.left, chord.right);
  const after = peakDb(limited.left, limited.right);
  assert.ok(after <= SAFETY_CEILING_DB + 1e-4, `through the limiter no sample of the sum is above ${SAFETY_CEILING_DB} dBFS: ${after.toFixed(3)} dBFS`);
  const idle = limit(chord.left, chord.right, false);
  assert.equal(peakDb(idle.left, idle.right), before, 'idle, it passes the signal as it is');
  console.log(`chord with reverb and chorus: ${before.toFixed(2)} dBFS without the limiter, ${after.toFixed(3)} dBFS through it`);
}

// ── which voices and files turn it on ─────────────────────────────────────────
{
  const file = (program: number): BasicMIDI => {
    const smf = notesToSmf([{ midi: 72, startSec: 0, durationSec: 1, velocity: 127 }], program);
    return BasicMIDI.fromArrayBuffer(smf.buffer.slice(smf.byteOffset, smf.byteOffset + smf.byteLength) as ArrayBuffer, 'lift');
  };
  assert.equal(renderBoosted(file(73)), true, 'a file on the lifted flute renders through the limiter');
  assert.equal(renderBoosted(file(40)), false, 'a file on a lowered preset does not');
  assert.equal(anyLiftedVoice([{ program: 40 }, { program: 73, bank: 0 }]), true, 'a bounce with the flute in it');
  assert.equal(anyLiftedVoice([{ program: 40 }, { program: undefined }]), false);
}
clearSoundbankGains();

/* ── the wiring ─────────────────────────────────────────────────────────────── */

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
const asAudio = (n: Node) => n as unknown as AudioNode;

// Live: the master's safety insert takes the limiter in, and the limiter follows the lifted channels.
{
  const input = node('safetyIn');
  const output = node('safetyOut');
  input.connect(output);
  const calls: Array<[number, number]> = [];
  const limiter = Object.assign(node('limiter'), {
    parameters: { get: () => ({ setValueAtTime: (v: number, t: number) => { calls.push([v, t]); } }) },
  }) as unknown as LimiterNode;
  spliceLimiter({ input: asAudio(input), output: asAudio(output) }, limiter);
  assert.deepEqual(input.to, ['limiter']);
  assert.deepEqual((limiter as unknown as Node).to, ['safetyOut']);

  const tracker = createLiftTracker((active, time) => setLimiterActive(limiter, active, time));
  tracker.set('0:3', false, 1);
  assert.deepEqual(calls, [], 'no lifted channel, nothing sent');
  tracker.set('0:3', true, 2);
  tracker.set('1:5', true, 3);
  tracker.set('0:3', false, 4);
  assert.equal(tracker.active(), true, 'one channel still lifted');
  tracker.set('1:5', false, 5);
  assert.deepEqual(calls, [[1, 2], [0, 5]], 'on from the first lift, off when the last lifted channel changes preset');
}

// A render: the whole synth, dry outputs and effects output alike, plays into the limiter, and the limiter into the destination.
{
  const dest = node('destination');
  const limiter = node('limiter');
  const outs: string[] = [];
  const synth = { connect: (t: AudioNode) => { outs.push((t as unknown as Node).id); return t; } };
  assert.equal(wireRenderOutput(synth, asAudio(dest), asAudio(limiter)), asAudio(limiter));
  assert.deepEqual(outs, ['limiter']);
  assert.deepEqual(limiter.to, ['destination']);
  const plainOuts: string[] = [];
  const plain = { connect: (t: AudioNode) => { plainOuts.push((t as unknown as Node).id); return t; } };
  assert.equal(wireRenderOutput(plain, asAudio(dest), null), asAudio(dest));
  assert.deepEqual(plainOuts, ['destination']);
}

console.log('safetyLimiter: ok');
