/**
 * A render's playback gain follows each channel's program changes through the
 * file (lib/soundbankGain renderGainSteps, routeRenderGains), not only its
 * first preset.
 *
 * The file plays a violin note, changes program partway through, and plays a
 * second note on the new preset. The quiet preset is gm.sf3's own violin
 * (0:40) with 10 dB of preset attenuation added and a playback gain of 10 dB
 * registered for it; the other preset (0:41, the viola) has none. Rendered as
 * the offline worklet renders it (the bank, the snapshot, the sequencer), each
 * channel on its own output with the steps applied there, both notes play at
 * gm.sf3's level: the snapshot alone left the second note 10 dB off.
 *
 * Run: `npx tsx src/lib/soundbankGain.programChange.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicMIDI, GeneratorTypes, SpessaSynthProcessor, SpessaSynthSequencer, type BasicSoundBank } from 'spessasynth_core';
import {
  clearSoundbankGains,
  registerSoundbankGains,
  renderGainSnapshot,
  renderGainSteps,
  routeRenderGains,
  type RenderGainStep,
} from './soundbankGain.ts';
import { LEVEL_SAMPLE_RATE, loadBank, maxWindowRmsDb, measureLevel } from './soundbankLevels.ts';

const TOLERANCE_DB = 1.5;
const here = dirname(fileURLToPath(import.meta.url));
const gmBytes = readFileSync(join(here, '..', '..', 'public', 'soundfonts', 'gm.sf3'));
const load = (): BasicSoundBank => loadBank(gmBytes.buffer.slice(gmBytes.byteOffset, gmBytes.byteOffset + gmBytes.byteLength) as ArrayBuffer);

function quietViolinBank(centibels: number): BasicSoundBank {
  const bank = load();
  const violin = bank.presets.find((p) => p.program === 40 && p.bankMSB === 0 && !p.isGMGSDrum);
  assert.ok(violin, 'gm.sf3 has a violin at 0:40');
  violin!.globalZone.setGenerator(GeneratorTypes.initialAttenuation, centibels);
  return bank;
}

/* ── a type-0 file, written by hand: 960 PPQ at 120 BPM, so 1920 ticks a second ── */

const PPQ = 960;
const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  for (let v = n >> 7; v > 0; v >>= 7) out.unshift((v & 0x7f) | 0x80);
  return out;
};
/** `events` as [tick, ...bytes], in time order. */
function smf(events: Array<[number, ...number[]]>): BasicMIDI {
  const body: number[] = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // 500000 us a quarter
  let at = 0;
  for (const [tick, ...bytes] of events) {
    body.push(...vlq(tick - at), ...bytes);
    at = tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 0xff];
  const len = body.length;
  const track = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
  const bytes = new Uint8Array([...head, ...track]);
  return BasicMIDI.fromArrayBuffer(bytes.buffer, 'program-change');
}
const sec = (s: number): number => Math.round(s * 2 * PPQ);
/** Channel 0: `first` for a 1.4 s note, then at 2 s `second` for another, with reverb and chorus off and CC1 full. */
const twoPresets = (first: number, second: number): BasicMIDI =>
  smf([
    [0, 0xb0, 0, 0],
    [0, 0xb0, 1, 127],
    [0, 0xb0, 91, 0],
    [0, 0xb0, 93, 0],
    [0, 0xc0, first],
    [0, 0x90, 67, 100],
    [sec(1.4), 0x80, 67, 0],
    [sec(2), 0xc0, second],
    [sec(2), 0x90, 67, 100],
    [sec(3.4), 0x80, 67, 0],
  ]);

/** Render `midi` as the offline worklet does, each channel on its own output with `steps` on it; `steps` null renders with no playback gain at all. */
async function render(bank: BasicSoundBank, midi: BasicMIDI, steps: ReadonlyMap<number, readonly RenderGainStep[]> | null): Promise<{ left: Float32Array; right: Float32Array }> {
  const synth = new SpessaSynthProcessor(LEVEL_SAMPLE_RATE, { eventsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(bank, 'bank-0');
  const snapshot = steps ? renderGainSnapshot(midi, LEVEL_SAMPLE_RATE) : undefined;
  if (snapshot) synth.applySnapshot(snapshot);
  const seq = new SpessaSynthSequencer(synth);
  seq.loadNewSongList([midi]);
  seq.play();
  const frames = Math.round(4 * LEVEL_SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const block = 128;
  const outs = Array.from({ length: 16 }, () => [new Float32Array(block), new Float32Array(block)]);
  const fxL = new Float32Array(block);
  const fxR = new Float32Array(block);
  const gainAt = (output: number, t: number): number => {
    let g = 1;
    for (const s of steps?.get(output) ?? []) if (s.sec <= t) g = s.gain;
    return g;
  };
  for (let i = 0; i < frames; i += block) {
    const n = Math.min(block, frames - i);
    for (const [l, r] of outs) { l.fill(0); r.fill(0); }
    fxL.fill(0);
    fxR.fill(0);
    seq.processTick();
    synth.processSplit(outs, fxL, fxR, 0, n);
    const t = i / LEVEL_SAMPLE_RATE;
    for (let o = 0; o < 16; o += 1) {
      const g = gainAt(o, t);
      for (let k = 0; k < n; k += 1) {
        left[i + k] += outs[o][0][k] * g;
        right[i + k] += outs[o][1][k] * g;
      }
    }
    for (let k = 0; k < n; k += 1) {
      left[i + k] += fxL[k];
      right[i + k] += fxR[k];
    }
  }
  return { left, right };
}

const at = (buf: { left: Float32Array; right: Float32Array }, from: number, to: number): number => {
  const a = Math.round(from * LEVEL_SAMPLE_RATE);
  const b = Math.round(to * LEVEL_SAMPLE_RATE);
  return maxWindowRmsDb(buf.left.subarray(a, b), buf.right.subarray(a, b));
};

// ── the steps a file's program changes make ───────────────────────────────
{
  clearSoundbankGains();
  registerSoundbankGains('orchestra', { playback_gain: { '0:40': 10 } });
  const down = renderGainSteps(twoPresets(40, 41));
  assert.deepEqual([...down.keys()], [0]);
  assert.equal(down.get(0)!.length, 1);
  assert.ok(Math.abs(down.get(0)![0].sec - 2) < 1e-6, 'at the program change');
  assert.ok(Math.abs(down.get(0)![0].gain - 10 ** (-10 / 20)) < 1e-9, 'the viola drops the violin\'s 10 dB');
  const up = renderGainSteps(twoPresets(41, 40));
  assert.ok(Math.abs(up.get(0)![0].gain - 10 ** (10 / 20)) < 1e-9, 'the violin gets its 10 dB at its program change');
  assert.equal(renderGainSteps(twoPresets(40, 40)).size, 0, 'one preset through the file: no step');
  assert.equal(renderGainSteps(twoPresets(41, 42)).size, 0, 'no gain on either preset: no step');
  clearSoundbankGains();
}

// ── the wiring: the stepped output leaves the destination for its gain node ──
{
  const calls: string[] = [];
  const gainCalls: Array<[number, number]> = [];
  const dest = { name: 'destination' } as unknown as AudioNode;
  const node = {
    gain: { setValueAtTime: (v: number, t: number) => { gainCalls.push([v, t]); } },
    connect: (to: AudioNode) => { calls.push(`node->${(to as unknown as { name: string }).name}`); return to; },
  } as unknown as GainNode;
  const made = routeRenderGains(
    { createGain: () => node },
    {
      connectChannel: (_t, ch) => { calls.push(`connect ${ch}`); return node; },
      disconnectChannel: (t, ch) => { calls.push(`disconnect ${ch} from ${(t as unknown as { name: string }).name}`); },
    },
    dest,
    new Map([[3, [{ sec: 2, gain: 0.5 }]]]),
  );
  assert.equal(made.length, 1);
  assert.deepEqual(calls, ['disconnect 3 from destination', 'connect 3', 'node->destination']);
  assert.deepEqual(gainCalls, [[1, 0], [0.5, 2]]);
  assert.deepEqual(routeRenderGains({ createGain: () => node }, { connectChannel: () => node, disconnectChannel: () => {} }, dest, new Map()), []);
}

// ── the level: both notes play at gm.sf3's ─────────────────────────────────
const gm = load();
const reference = await measureLevel(gm, { bank: 0, program: 40, note: 67, velocity: 100, cc1: 127, seconds: 1.5 });
let quiet = quietViolinBank(250);
let short = await measureLevel(quiet, { bank: 0, program: 40, note: 67, velocity: 100, cc1: 127, seconds: 1.5 });
for (let cb = 275; reference.rmsDb - short.rmsDb < 9.8 && cb <= 1000; cb += 25) {
  quiet = quietViolinBank(cb);
  short = await measureLevel(quiet, { bank: 0, program: 40, note: 67, velocity: 100, cc1: 127, seconds: 1.5 });
}
registerSoundbankGains('orchestra', { playback_gain: { '0:40': 10 } });
for (const [first, second] of [[40, 41], [41, 40]] as const) {
  const midi = twoPresets(first, second);
  const plain = await render(gm, midi, null);
  const snapshotOnly = await render(quiet, midi, new Map());
  const stepped = await render(quiet, midi, renderGainSteps(midi));
  const want = [at(plain, 0, 1.9), at(plain, 2, 3.9)];
  const was = [at(snapshotOnly, 0, 1.9) - want[0], at(snapshotOnly, 2, 3.9) - want[1]];
  const now = [at(stepped, 0, 1.9) - want[0], at(stepped, 2, 3.9) - want[1]];
  assert.ok(Math.abs(was[1]) > 8, `the snapshot alone left the second preset ${was[1].toFixed(2)} dB off`);
  assert.ok(Math.abs(now[0]) <= TOLERANCE_DB, `${first} then ${second}: the first note plays ${now[0].toFixed(2)} dB from gm.sf3`);
  assert.ok(Math.abs(now[1]) <= TOLERANCE_DB, `${first} then ${second}: the second note plays ${now[1].toFixed(2)} dB from gm.sf3`);
  console.log(`program ${first} -> ${second}: snapshot alone ${was.map((d) => d.toFixed(2)).join(' / ')} dB, stepped ${now.map((d) => d.toFixed(2)).join(' / ')} dB from gm.sf3`);
}
clearSoundbankGains();

console.log('soundbankGain.programChange: ok');
