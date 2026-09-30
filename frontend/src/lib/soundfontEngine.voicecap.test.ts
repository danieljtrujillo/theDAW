/**
 * The live synths' voice cap (soundfontEngine LIVE_VOICE_CAP) against a dense
 * tutti: 24 orchestral parts, each playing four-note chords that change every
 * eighth note at 120 BPM and ring into their releases, rendered through the bundled bank in
 * node (spessasynth_core SpessaSynthProcessor, the engine the worklet runs).
 *
 * At SpessaSynth's default cap of 350 the tutti runs out of voices and the
 * synth steals sounding ones; at LIVE_VOICE_CAP it never does. The cost of the
 * higher cap is measured on the same passage: the render time per second of
 * audio at each cap, printed with the peak voice count.
 *
 *   cd frontend && npx tsx src/lib/soundfontEngine.voicecap.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { LIVE_VOICE_CAP } from './soundfontEngine.ts';

const SR = 44100;
const SECONDS = 8;
const BEAT = 0.25;
const PARTS = 24;
const DEFAULT_CAP = 350;

// Strings, winds and brass: the programs of a symphony orchestra's sections.
const PROGRAMS = [40, 40, 41, 42, 43, 48, 48, 49, 73, 73, 68, 68, 71, 71, 70, 70, 60, 60, 60, 60, 56, 56, 57, 58];
// Where each part sits: violins high, basses low.
const ROOTS = [72, 69, 64, 55, 40, 67, 60, 52, 79, 76, 74, 71, 67, 64, 55, 48, 62, 57, 53, 50, 67, 64, 52, 40];
const CHORDS = [[0, 4, 7, 12], [2, 5, 9, 14], [4, 7, 11, 16], [-1, 2, 7, 11], [0, 4, 9, 12], [-3, 0, 5, 9], [-1, 2, 5, 7], [0, 4, 7, 12]];

const gm = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(gm.buffer.slice(gm.byteOffset, gm.byteOffset + gm.byteLength) as ArrayBuffer);

/** A part's channel: 0-8 then 10 up, around the drum channel. */
const channelOf = (part: number): number => (part < 9 ? part : part + 1);

async function tutti(cap: number): Promise<{ peak: number; atCap: number; msPerSec: number }> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: true, eventsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(bank, 'main');
  while (synth.midiChannels.length <= channelOf(PARTS - 1)) synth.createMIDIChannel();
  synth.setSystemParameter('voiceCap', cap);
  for (let p = 0; p < PARTS; p += 1) synth.programChange(channelOf(p), PROGRAMS[p]);
  const n = SR * SECONDS;
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  let peak = 0;
  let atCap = 0;
  let beat = -1;
  let held: Array<[number, number]> = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i += 128) {
    const b = Math.floor(i / SR / BEAT);
    if (b !== beat && i / SR < SECONDS - 1) {
      beat = b;
      // The chord changes on the beat: the old notes release, the new ones start with them still ringing.
      for (const [ch, key] of held) synth.noteOff(ch, key);
      held = [];
      const chord = CHORDS[b % CHORDS.length];
      for (let p = 0; p < PARTS; p += 1) {
        for (const iv of chord) {
          const key = ROOTS[p] + iv;
          synth.noteOn(channelOf(p), key, 96);
          held.push([channelOf(p), key]);
        }
      }
    }
    synth.process(left, right, 0, 128);
    peak = Math.max(peak, synth.voiceCount);
    if (synth.voiceCount >= cap) atCap += 1;
  }
  const ms = performance.now() - t0;
  return { peak, atCap, msPerSec: ms / SECONDS };
}

assert.ok(LIVE_VOICE_CAP > DEFAULT_CAP, 'the live cap is above SpessaSynth\'s default');
const low = await tutti(DEFAULT_CAP);
const high = await tutti(LIVE_VOICE_CAP);
console.log(`  cap ${DEFAULT_CAP}: peak ${low.peak} voices, ${low.atCap} render quanta at the cap, ${low.msPerSec.toFixed(1)} ms per second of audio`);
console.log(`  cap ${LIVE_VOICE_CAP}: peak ${high.peak} voices, ${high.atCap} render quanta at the cap, ${high.msPerSec.toFixed(1)} ms per second of audio`);
console.log(`  cost of the higher cap: ${((high.msPerSec / low.msPerSec - 1) * 100).toFixed(0)}% more render time for ${high.peak - low.peak} more voices`);
assert.ok(low.atCap > 0, `a 24-part tutti runs out of voices at ${DEFAULT_CAP}: its peak is ${low.peak}`);
assert.equal(high.atCap, 0, `at ${LIVE_VOICE_CAP} no voice is stolen: peak ${high.peak}`);
assert.ok(high.peak > DEFAULT_CAP, 'the tutti needs more voices than the default cap');

console.log('soundfontEngine.voicecap: ok');
