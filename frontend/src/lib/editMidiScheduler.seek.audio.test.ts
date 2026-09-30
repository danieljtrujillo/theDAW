/**
 * A seek while a note-on is still queued, played through SpessaSynth's own
 * processor (spessasynth_core, the engine inside EDIT's AudioWorklet synths).
 *
 * The sequence: an organ note (a sustained voice, so a voice left on is heard)
 * is queued by EDIT's live scheduler (lib/editMidiScheduler) inside its
 * lookahead; the pass stops (the scheduler cancels the queued note-on with a
 * note-off at its time, and liveMixer's editAllNotesOff stops every voice), and
 * a seek back starts a pass whose own strike of that note lands before the
 * stale note-on and its cancel. SpessaSynth ends the OLDEST sounding note-on of
 * a key at each note-off (its note ids), so the stale pair adds one voice and
 * ends one, and the note must sound once and stop at its own note-off.
 *
 * Before, the scheduler struck the note again after the cancel: the render
 * held one voice more than note-offs, and the organ sounded on after the note
 * ended, until the next stop. That old message order is rendered too, and must
 * be heard ringing on, so the measurement is known to catch it.
 *
 * Run from `frontend/`:
 *   npx tsx src/lib/editMidiScheduler.seek.audio.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import type { GlobalVoice } from './clipProgram.ts';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiSink } from './editMidiScheduler.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const SR = 44100;
const ORGAN = 16;
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const sfBytes = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const sf = sfBytes.buffer.slice(sfBytes.byteOffset, sfBytes.byteOffset + sfBytes.byteLength) as ArrayBuffer;
const ed = () => useEditorStore.getState();

async function newSynth(): Promise<SpessaSynthProcessor> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false, eventsEnabled: false });
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf.slice(0)), 'main');
  await synth.processorInitialized;
  return synth;
}

/** Render `seconds` of channel 0, calling `onBlock` before each render quantum; the RMS of each span asked for. */
async function render(
  seconds: number,
  onBlock: (synth: SpessaSynthProcessor) => void,
  spans: ReadonlyArray<[number, number]>,
): Promise<number[]> {
  const synth = await newSynth();
  const outs = Array.from({ length: 16 }, () => [new Float32Array(128), new Float32Array(128)]);
  const effL = new Float32Array(128);
  const effR = new Float32Array(128);
  const sums = spans.map(() => ({ acc: 0, n: 0 }));
  for (let at = 0; at < seconds * SR; at += 128) {
    onBlock(synth);
    for (const [l, r] of outs) {
      l.fill(0);
      r.fill(0);
    }
    synth.processSplit(outs, effL, effR, 0, 128);
    const t = at / SR;
    spans.forEach(([a, b], i) => {
      if (t < a || t >= b) return;
      for (let j = 0; j < 128; j += 1) sums[i].acc += outs[0][0][j] ** 2;
      sums[i].n += 128;
    });
  }
  return sums.map((s) => Math.sqrt(s.acc / Math.max(1, s.n)));
}

const send = (synth: SpessaSynthProcessor, bytes: number[], time?: number) =>
  synth.processMessage(new Uint8Array(bytes), 0, time !== undefined ? { time } : undefined);

/** The sink EDIT's bank is, on channel 0: a timed program change, then the timed note. */
function sinkFor(synth: SpessaSynthProcessor): EditMidiSink {
  let program = -1;
  return {
    noteOn: (ch, p, midi, vel, time) => {
      if (p !== program) {
        send(synth, [0xc0 | ch, p], time);
        program = p;
      }
      send(synth, [0x90 | ch, midi, vel], time);
    },
    noteOff: (ch, midi, time) => send(synth, [0x80 | ch, midi, 0], time),
    wheel: () => undefined,
    wheelRange: () => undefined,
    control: () => undefined,
  };
}

// One organ note from 1.0 s to 1.5 s (steps 8 to 12 at 120).
ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().tracks[0].id;
ed().updateTrack(trackId, { instrumentProgram: ORGAN });
ed().addClipToTrack({
  trackId,
  label: 'organ',
  audioBlob: new Blob([], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 8,
  offsetIntoSource: 0,
  durationSec: 8,
  startSec: 0,
  color: '#a855f7',
  sourceKind: 'piano-roll',
  sourcePianoRoll: [{ id: 'a', note: 60, step: 8, length: 4, velocity: 100 } as PianoNote],
  sourceBpm: 120,
  sourceTotalSteps: 64,
});
const plan = planLiveMidi(ed().clips, ed().tracks, SF);
assert.deepEqual(plan.channels.channelsOf.get(trackId), [0], 'the organ plays live on channel 0');
const pass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };

const SPANS: Array<[number, number]> = [
  [1.1, 1.4], // the note, sounding
  [2.0, 3.0], // well past its end and the organ's release
];

// The note played once, as a reference level.
const reference = await render(3, (() => {
  let sent = false;
  return (synth: SpessaSynthProcessor) => {
    if (sent) return;
    sent = true;
    send(synth, [0xc0, ORGAN]);
    send(synth, [0x90, 60, 100], 1.0);
    send(synth, [0x80, 60, 0], 1.5);
  };
})(), SPANS);
assert.ok(reference[0] > 0.005, `the organ note sounds (${reference[0]})`);
assert.ok(reference[1] < 1e-4, `and is silent after it ends (${reference[1]})`);

// Live: play from 0, stop at 0.94 s with the note-on queued for 1.0 s, seek back to 0.96 s.
let sched: EditMidiScheduler | null = null;
let seeked = false;
let due = 0;
const live = await render(3, (synth) => {
  if (!sched) {
    sched = new EditMidiScheduler({
      now: () => synth.currentTime,
      sink: sinkFor(synth),
      clips: () => ed().clips,
      tracks: () => ed().tracks,
      global: () => SF,
      projectBpm: () => ed().bpm,
    });
    sched.prepare(pass);
    sched.start(pass, 0, synth.currentTime);
    due = synth.currentTime + EDIT_MIDI_TICK_MS / 1000;
    return;
  }
  if (!seeked && synth.currentTime >= 0.94) {
    seeked = true;
    // liveMixer: clearMidiTimers (the scheduler's stop, then editAllNotesOff), then start from the seek.
    sched.stop();
    synth.stopAllChannels(true);
    sched.start(pass, 0.96, synth.currentTime);
    due = synth.currentTime + EDIT_MIDI_TICK_MS / 1000;
    return;
  }
  if (synth.currentTime >= due) {
    sched.tick();
    due += EDIT_MIDI_TICK_MS / 1000;
  }
}, SPANS);
assert.ok(seeked);
console.log(`  seek back over a queued note: sounding ${live[0].toFixed(4)} (one voice ${reference[0].toFixed(4)}), after its end ${live[1].toExponential(2)}`);
assert.ok(live[0] > reference[0] * 0.5 && live[0] < reference[0] * 1.5, 'the note sounds as one voice');
assert.ok(live[1] < 1e-4, `no voice is left sounding after the note ends (${live[1]})`);

// The old order: the new pass's strike, then a strike again after the stale pair.
const old = await render(3, (() => {
  let step = 0;
  return (synth: SpessaSynthProcessor) => {
    if (step === 0) {
      send(synth, [0xc0, ORGAN]);
      send(synth, [0x90, 60, 100], 1.0); // the pass's note-on, queued
      step = 1;
    } else if (step === 1 && synth.currentTime >= 0.94) {
      send(synth, [0x80, 60, 0], 1.0); // stop(): its cancel
      synth.stopAllChannels(true);
      send(synth, [0x90, 60, 100], 0.98); // the seek's strike
      send(synth, [0x90, 60, 100], 1.0); // struck again after the cancel
      send(synth, [0x80, 60, 0], 1.48); // the note's own note-off
      step = 2;
    }
  };
})(), SPANS);
console.log(`  the old order: after the note's end ${old[1].toFixed(4)}`);
assert.ok(old[1] > 0.005, 'the old order leaves the organ sounding: the measurement hears a hanging voice');

console.log('editMidiScheduler.seek.audio: ok');
