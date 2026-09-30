/**
 * How long a MIDI bounce lasts, replayed through the render path with the
 * bundled General MIDI soundfont and SpessaSynth's own processor.
 *
 * Each case builds its render request the way the app does (a roll or EDIT
 * clip through midiSynth stepRenderRequest, a DAWproject clip through
 * dawProjectToEditor dawMidiRenderOptions, a Perform cell through
 * sessionCellSpan, a saved clip with no audio file through projectImport
 * tasmoMidiRenderOptions), turns the notes into the MIDI file
 * renderNotesToBlobSF plays (soundfontEngine notesRenderSmf), takes the span
 * renderMidiToBlob renders (renderTail renderSpan), renders it, and keeps the
 * frames renderMidiToBlob keeps (renderTail keptRenderFrames). Only the
 * OfflineAudioContext and the worklet are left out; the processor inside them
 * is the one used here.
 *
 * At 8039b45 renderStepNotesToBlob rendered with a fixed 0.6 s tail and
 * reported the nominal length without rendering it, and a DAWproject MIDI clip
 * or Perform cell rendered with a fixed 0.2 s tail and no floor (a looping
 * cell looped early by its missing rests), and a saved clip with no
 * audio file rendered with no floor: a final string chord was cut and the
 * rests after the last note were not in the audio. Run from
 * `frontend/`:
 *   npx tsx src/lib/renderLength.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { stepRenderRequest, type RenderNote, type RenderOptions } from './midiSynth.ts';
import { notesRenderSmf } from './soundfontEngine.ts';
import { dawMidiRenderOptions, dawMidiWindowSec } from './dawProjectToEditor.ts';
import type { DawClip } from './dawImportClient.ts';
import { tasmoMidiRenderOptions } from './projectImport.ts';
import { sessionCellSpan, sessionMidiRenderOptions } from './sessionCellSpan.ts';
import { audibleFrames, keptRenderFrames, midiPresetKeys, releaseLookupFromBank, renderSpan, renderTailSec } from './renderTail.ts';

const SR = 44100;
const sfBytes = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const sf = sfBytes.buffer.slice(sfBytes.byteOffset, sfBytes.byteOffset + sfBytes.byteLength) as ArrayBuffer;
const lookup = releaseLookupFromBank(SoundBankLoader.fromArrayBuffer(sf.slice(0)));

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => console.log(`  ok - ${name}`));
}

/** Render a MIDI file through SpessaSynth's processor for `seconds`. */
async function renderMidi(bytes: Uint8Array, seconds: number): Promise<Float32Array[]> {
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
  return [left, right];
}

/** The bounce as renderMidiToBlob makes it: the frames it keeps, and a long reference render of the same file. */
async function bounce(notes: RenderNote[], options: RenderOptions): Promise<{ keptSec: number; silentSec: number; lastEventSec: number }> {
  const smf = notesRenderSmf(notes, options);
  const midi = BasicMIDI.fromArrayBuffer(smf.buffer.slice(0) as ArrayBuffer);
  const span = renderSpan(midi.duration, options, () => renderTailSec(midiPresetKeys(midi), lookup));
  const audio = await renderMidi(smf, span.renderSec);
  const kept = keptRenderFrames(span, audio, SR);
  // Where the same file falls under the 16-bit floor when nothing stops it.
  const reference = await renderMidi(smf, midi.duration + 12);
  return { keptSec: kept / SR, silentSec: audibleFrames(reference, 0, SR) / SR, lastEventSec: midi.duration };
}

const CHORD = [48, 55, 60, 64];

async function main(): Promise<void> {
  await run('a roll bounce that ends on a held string chord keeps the whole release', async () => {
    // Two bars at 120 BPM; the second bar is the chord, held to the end.
    const notes = CHORD.map((note) => ({ note, velocity: 100, step: 16, length: 16 }));
    const request = stepRenderRequest(notes, 120, 32, { program: 48 });
    assert.equal(request.options.tailSec, undefined, 'no fixed tail');
    const out = await bounce(request.notes, request.options);
    assert.ok(out.silentSec > out.lastEventSec + 0.6, `the chord rings past the old 0.6 s tail (${(out.silentSec - out.lastEventSec).toFixed(2)} s)`);
    assert.ok(out.keptSec >= out.silentSec - 0.001, `the bounce keeps it all (${out.keptSec.toFixed(2)} s of ${out.silentSec.toFixed(2)} s)`);
  });

  await run('a roll bounce whose last bar is a rest lasts its nominal length', async () => {
    // A short chord in the first half-bar of a two-bar pattern.
    const notes = CHORD.map((note) => ({ note, velocity: 100, step: 0, length: 2 }));
    const request = stepRenderRequest(notes, 120, 32, { program: 48 });
    const out = await bounce(request.notes, request.options);
    assert.ok(out.silentSec < request.nominalSec, 'the chord is silent before the pattern ends');
    assert.ok(out.keptSec >= request.nominalSec - 1 / SR, `the audio lasts the two bars (${out.keptSec.toFixed(2)} of ${request.nominalSec} s)`);
  });

  await run('a DAWproject clip ending on a chord and a bar of rest keeps both', async () => {
    const clip: DawClip = { name: 'cue', start_time: 8, end_time: 12, file_path: null };
    // A string chord over the first two seconds, then silence to the clip's end.
    const notes: RenderNote[] = CHORD.map((midi) => ({ midi, startSec: 0, durationSec: 2, velocity: 100 }));
    const options: RenderOptions = { ...dawMidiRenderOptions(clip), program: 48 };
    assert.equal(options.tailSec, undefined, 'no fixed tail');
    const out = await bounce(notes, options);
    assert.ok(out.keptSec >= 4 - 1 / SR, `the rest to the clip's end is in the audio (${out.keptSec.toFixed(2)} s)`);
    assert.ok(out.keptSec >= out.silentSec - 0.001, 'and the release is too');
    assert.ok(Math.abs(dawMidiWindowSec(clip, notes, out.keptSec) - out.keptSec) < 1e-9, 'the EDIT clip holds all of it');
  });

  await run('a DAWproject chord held to the clip end rings past it on the timeline', async () => {
    const clip: DawClip = { name: 'end', start_time: 0, end_time: 2, file_path: null };
    const notes: RenderNote[] = CHORD.map((midi) => ({ midi, startSec: 1, durationSec: 1, velocity: 100 }));
    const out = await bounce(notes, { ...dawMidiRenderOptions(clip), program: 48 });
    const window = dawMidiWindowSec(clip, notes, out.keptSec);
    assert.ok(window > 2 + 0.6, `the window runs past the clip for the release (${window.toFixed(2)} s)`);
    assert.ok(window >= out.silentSec - 0.001);
  });

  await run('a DAWproject clip with notes after its window keeps its own length', () => {
    const clip: DawClip = { name: 'long', start_time: 0, end_time: 2, file_path: null };
    const notes: RenderNote[] = [
      { midi: 60, startSec: 0, durationSec: 1, velocity: 100 },
      { midi: 62, startSec: 3, durationSec: 1, velocity: 100 },
    ];
    assert.equal(dawMidiWindowSec(clip, notes, 5.5), 2);
  });

  await run('a saved MIDI clip with no audio file reopens with the rests the file gives it', async () => {
    // A four-second clip whose chord fills its first second.
    const clip = { start_time: 10, end_time: 14, offset_into_source: 0 };
    const notes: RenderNote[] = CHORD.map((midi) => ({ midi, startSec: 0, durationSec: 1, velocity: 100 }));
    const options: RenderOptions = { ...tasmoMidiRenderOptions(clip), program: 48 };
    const out = await bounce(notes, options);
    assert.ok(out.keptSec >= 4 - 1 / SR, `the render lasts the clip (${out.keptSec.toFixed(2)} s)`);
  });

  await run('a looping Perform cell with a rest after its chord loops at its own length', async () => {
    // A one-bar loop at 120 BPM (2 s) whose chord fills its first half-second.
    const clip: DawClip = { name: 'loop', start_time: 0, end_time: 2, file_path: null, loop_on: true };
    const notes: RenderNote[] = CHORD.map((midi) => ({ midi, startSec: 0, durationSec: 0.5, velocity: 100 }));
    const out = await bounce(notes, { ...sessionMidiRenderOptions(clip), program: 48 });
    const span = sessionCellSpan(clip, out.keptSec, notes);
    assert.ok(span.loopEnd !== null && Math.abs(span.loopEnd - span.offset - 2) < 1e-6, `the loop is one bar long (${span.loopEnd})`);
  });

  await run('a one-shot Perform cell rings out past its window', async () => {
    const clip: DawClip = { name: 'hit', start_time: 0, end_time: 2, file_path: null, loop_on: false };
    const notes: RenderNote[] = CHORD.map((midi) => ({ midi, startSec: 1, durationSec: 1, velocity: 100 }));
    const out = await bounce(notes, { ...sessionMidiRenderOptions(clip), program: 48 });
    const span = sessionCellSpan(clip, out.keptSec, notes);
    assert.equal(span.loopEnd, null);
    assert.ok(span.duration >= out.silentSec - 0.001, `it plays the release (${span.duration.toFixed(2)} s)`);
    assert.equal(span.passSec, 2, 'a follow action still counts its plays by the window');
    const audio = sessionCellSpan({ ...clip, file_path: 'x.wav' }, 6, []);
    assert.equal(audio.duration, 2, 'an audio cell still stops at its window');
  });

  console.log('renderLength: ok');
}

await main();
