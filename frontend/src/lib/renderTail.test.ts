/**
 * The render tail of a soundfont bounce (lib/renderTail), checked against the
 * bundled General MIDI soundfont and SpessaSynth's own processor.
 *
 * Replays what a bounce does with a final chord: the clip's notes become a
 * MIDI file (notesToSmf, as renderNotesToBlobSF builds it), the chord is
 * played and released, and the synth keeps rendering. At 8039b45 the render
 * stopped 0.6 s after the last note-off. Here the processor shows the string
 * chord still sounding at that point, and the tail the render now takes
 * (renderTailSec over the presets the file plays) reaches past the moment the
 * chord falls under the 16-bit floor. Run from `frontend/`:
 *   npx tsx src/lib/renderTail.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { notesToSmf } from './midiWrite.ts';
import {
  MIN_RENDER_TAIL_SEC,
  RENDER_TAIL_CAP_SEC,
  SILENCE_FLOOR,
  audibleFrames,
  midiPresetKeys,
  releaseLookupFromBank,
  renderTailSec,
} from './renderTail.ts';

const SR = 44100;
const sfBytes = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const sf = sfBytes.buffer.slice(sfBytes.byteOffset, sfBytes.byteOffset + sfBytes.byteLength) as ArrayBuffer;
const bank = SoundBankLoader.fromArrayBuffer(sf.slice(0));
const lookup = releaseLookupFromBank(bank);

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => console.log(`  ok - ${name}`));
}

/** Render a MIDI file through SpessaSynth's processor, sample by sample-block, for `seconds`. */
async function renderMidi(bytes: Uint8Array, seconds: number): Promise<Float32Array[]> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false, eventsEnabled: false });
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf.slice(0)), 'main');
  await synth.processorInitialized;
  const midi = BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  // Every channel event of the file, in time order, applied at its sample.
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
  const BLOCK = 128;
  let next = 0;
  for (let at = 0; at < total; at += BLOCK) {
    while (next < events.length && events[next].sample <= at) synth.processMessage(events[next++].data);
    synth.process(left, right, at, Math.min(BLOCK, total - at));
  }
  return [left, right];
}

const peakOf = (channels: readonly Float32Array[], from: number, to: number): number => {
  let p = 0;
  for (const c of channels) for (let i = Math.max(0, from); i < Math.min(c.length, to); i += 1) p = Math.max(p, Math.abs(c[i]));
  return p;
};

async function main(): Promise<void> {
  await run('a string section, harp and timpani release for longer than the old 0.6 s tail', () => {
    for (const [program, name] of [[48, 'strings'], [46, 'harp'], [47, 'timpani']] as const) {
      const sec = lookup({ program, drum: false, key: 60 });
      assert.ok(sec > 0.6, `${name} (program ${program}) releases over ${sec.toFixed(2)} s`);
    }
  });

  await run('the drum channel is read as a kit and a missing kit resolves as the synth resolves it', () => {
    const kick = lookup({ program: 0, drum: true, key: 36 });
    assert.ok(kick >= 0, 'the Standard kit has a kick');
    // Kit 3 is not in the bundled soundfont; getPreset falls back and a release is still found.
    assert.ok(Number.isFinite(lookup({ program: 3, drum: true, key: 36 })));
  });

  await run('midiPresetKeys reads every (program, key) a bounce file plays, the drum channel as a kit', () => {
    const smf = notesToSmf(
      [
        { midi: 60, startSec: 0, durationSec: 1, velocity: 100 },
        { midi: 36, startSec: 0, durationSec: 0.2, velocity: 100, channel: 9 },
      ],
      48,
    );
    const keys = midiPresetKeys(BasicMIDI.fromArrayBuffer(smf.buffer.slice(0) as ArrayBuffer));
    assert.deepEqual(
      keys.map((k) => `${k.drum ? 'd' : 'm'}${k.program}:${k.key}`).sort(),
      ['d48:36', 'm48:60'],
    );
  });

  await run('renderTailSec keeps a floor for the effects and a cap for a 30 s release', () => {
    assert.equal(renderTailSec([], lookup), MIN_RENDER_TAIL_SEC);
    assert.equal(renderTailSec([{ program: 0, drum: false, key: 60 }], () => 45), RENDER_TAIL_CAP_SEC);
  });

  await run('a final string chord: cut at 0.6 s at 8039b45, rung out by the tail the render takes now', async () => {
    // The last bar of a cue: a C major string chord held two seconds.
    const chord = [48, 55, 60, 64].map((midi) => ({ midi, startSec: 0, durationSec: 2, velocity: 100 }));
    const smf = notesToSmf(chord, 48);
    const midi = BasicMIDI.fromArrayBuffer(smf.buffer.slice(0) as ArrayBuffer);
    const tail = renderTailSec(midiPresetKeys(midi), lookup);
    const audio = await renderMidi(smf, midi.duration + RENDER_TAIL_CAP_SEC);
    const peak = peakOf(audio, 0, audio[0].length);
    assert.ok(peak > 0, 'the chord sounds');
    const oldEnd = Math.ceil((midi.duration + 0.6) * SR);
    const pastOldEnd = peakOf(audio, oldEnd, oldEnd + SR / 10);
    assert.ok(pastOldEnd >= peak * SILENCE_FLOOR, `the chord still sounds past the old 0.6 s tail (${pastOldEnd} of peak ${peak})`);
    const silentFrom = audibleFrames(audio, midi.duration * SR, SR);
    assert.ok(
      silentFrom <= Math.ceil((midi.duration + tail) * SR),
      `the tail (${tail.toFixed(2)} s) reaches the frame the chord falls silent at (${(silentFrom / SR - midi.duration).toFixed(2)} s past the last note-off)`,
    );
  });

  await run('audibleFrames never cuts before the floor and keeps a margin after the last sound', () => {
    const quiet = [new Float32Array(1000)];
    assert.equal(audibleFrames(quiet, 400, SR), 400);
    const blip = new Float32Array(SR);
    blip[100] = 1;
    assert.equal(audibleFrames([blip], 0, SR), 101 + Math.ceil(0.02 * SR));
    assert.equal(audibleFrames([blip], SR / 2, SR), SR / 2);
  });

  console.log('renderTail: ok');
}

await main();
