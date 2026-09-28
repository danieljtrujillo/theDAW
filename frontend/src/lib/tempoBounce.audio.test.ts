/**
 * A ritardando written in the roll's tempo map, heard in the bounce: the roll
 * is sent to EDIT (lib/rollBounce), where the part plays live, and an export
 * renders it through the MIDI render queue (state/midiRenderQueue
 * clipsWithMidiAudio) with the render request the app makes (midiSynth
 * stepRenderRequest). The notes go into the MIDI file the soundfont render
 * plays (soundfontEngine notesRenderSmf), SpessaSynth's own processor renders
 * it with the bundled General MIDI bank, and each note's onset is measured in
 * the audio.
 *
 * The roll: a woodblock on every beat, 120 bpm for a bar, a ramp to 60 over
 * two bars, then a bar at 60. Every onset lands within 10 ms of the ramp's
 * closed-form second, and every note keeps the tick it was written at.
 * Run from `frontend/`:
 *   npx tsx src/lib/tempoBounce.audio.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { stepRenderRequest } from './midiSynth.ts';
import { notesRenderSmf } from './soundfontEngine.ts';
import { bounceRollToEditor } from './rollBounce.ts';
import { clipsWithMidiAudio, configureMidiRenderQueue } from '../state/midiRenderQueue.ts';
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

/** Where the sound first rises past a quarter of its peak within 100 ms after `from`. */
function onsetAfter(audio: Float32Array, from: number): number {
  const a = Math.max(0, Math.floor(from * SR));
  const b = Math.min(audio.length, a + Math.floor(0.1 * SR));
  let peak = 0;
  for (let i = a; i < b; i += 1) peak = Math.max(peak, Math.abs(audio[i]));
  for (let i = a; i < b; i += 1) if (Math.abs(audio[i]) >= peak / 4) return i / SR;
  return Number.NaN;
}

async function main(): Promise<void> {
  useEditorStore.getState().loadProject({ tracks: [], clips: [] });
  const roll = usePianoRollStore.getState();
  roll.clear();
  roll.setEditingClip(null);
  const notes: PianoNote[] = [];
  for (let beat = 0; beat < 16; beat += 1) notes.push({ id: `w${beat}`, note: 76, step: beat * 4, length: 1, velocity: 110 });
  roll.importNotes(notes, 120, undefined, [], [
    { beat: 0, bpm: 120 },
    { beat: 4, bpm: 120, curve: 'linear' },
    { beat: 12, bpm: 60 },
  ]);
  usePianoRollStore.setState({ totalSteps: 64 });
  const ticksBefore = usePianoRollStore.getState().notes.map((n) => n.tick);

  let smf: Uint8Array | null = null;
  let seconds = 0;
  const picker = () => ({ useSoundfont: true, activeProgram: WOODBLOCK });
  configureMidiRenderQueue({
    render: (n, bpm, total, opts) => {
      const req = stepRenderRequest(n, bpm, total, { ...opts, program: WOODBLOCK });
      smf = notesRenderSmf(req.notes, req.options);
      seconds = req.nominalSec;
      return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: req.nominalSec });
    },
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
    global: picker,
    ensureReady: () => Promise.resolve(),
  });
  const done = await bounceRollToEditor({ global: picker });
  assert.ok(done, 'the roll went to EDIT');
  assert.equal(smf, null, 'the part plays live, so the send renders nothing');
  const out = await clipsWithMidiAudio((c) => c.id === done.clipId);
  out.release();
  assert.ok(smf, 'the export rendered it');
  const audio = await renderMidi(smf as Uint8Array, seconds + 0.5);

  // The ramp in closed form: 120 falling 7.5 bpm a beat from beat 4 to beat 12.
  const k = -60 / 8;
  const expected = (beat: number): number => {
    if (beat <= 4) return beat * 0.5;
    if (beat <= 12) return 2 + (60 / k) * Math.log((120 + k * (beat - 4)) / 120);
    return 2 + (60 / k) * Math.log(60 / 120) + (beat - 12);
  };
  const measured: number[] = [];
  for (let beat = 0; beat < 16; beat += 1) {
    const want = expected(beat);
    const heard = onsetAfter(audio, Math.max(0, want - 0.02));
    measured.push(heard);
    assert.ok(Math.abs(heard - want) < 0.01, `beat ${beat}: heard at ${heard.toFixed(4)} s, written for ${want.toFixed(4)} s`);
  }
  // The ritardando slows beat by beat in the audio.
  for (let beat = 5; beat <= 12; beat += 1) {
    assert.ok(measured[beat] - measured[beat - 1] > measured[beat - 1] - measured[beat - 2] - 0.002, `beat ${beat} is later than the one before by more`);
  }
  assert.deepEqual(usePianoRollStore.getState().notes.map((n) => n.tick), ticksBefore, 'every note is still on its bar line');
  console.log(`tempoBounce.audio: ok (${measured.length} onsets, last at ${measured.at(-1)?.toFixed(3)} s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
