/**
 * Twenty-four orchestral parts played live through SpessaSynth, with the onset
 * of every note measured against the audio clock.
 *
 * The sequence: a type-1 MIDI file with 24 parts, a tempo change at two bar
 * lines and three meters (4/4, 7/8, 5/4) is written (lib/midi encodeMidi) and
 * read back (parseMidi). Each part goes onto its own EDIT track the way a MIDI
 * file dropped into EDIT becomes a clip (lib/rollClip midiFileClipFields), and
 * each track gets its own instrument (the header's instrument select,
 * editorStore updateTrack). Then the pass play() plans (liveMixer planLiveMidi)
 * is played by the live scheduler (lib/editMidiScheduler) on a timer that runs
 * up to 50 ms late, into SpessaSynth's own processor (spessasynth_core, the
 * engine inside EDIT's AudioWorklet synths) with one output per channel, and
 * every note's onset is found in its part's audio.
 *
 * Drift is measured per part: each part repeats one pitch at one velocity, so
 * every note's attack is the same waveform, and the spread of (heard onset -
 * the time the anchor gives the note) across a part's notes is how far its
 * notes wander against the clock. The scheduler's spread must stay inside one
 * render quantum (128 samples, the synth's own event grid). The same file
 * played the way EDIT played MIDI before (each message sent without a time when
 * its timer fires, the timers late by the same 0-50 ms) is measured too, and
 * must fail that bound, so the measurement is known to catch the old path.
 *
 * Run from `frontend/`:
 *   npx tsx src/lib/editMidiScheduler.audio.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { encodeMidi, parseMidi, type MidiFileData, type MidiTrack } from './midi.ts';
import { midiFileClipFields } from './rollClip.ts';
import { stepClock } from './rollTempo.ts';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiSink } from './editMidiScheduler.ts';
import { localChannel, DRUM_CHANNEL } from './editChannels.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi, liveMidiNotes } from '../state/liveMixer.ts';
import type { GlobalVoice } from './clipProgram.ts';

const SR = 44100;
const QUANTUM = 128 / SR;
const PPQ = 480;
const PARTS = 24;
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const sfBytes = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const sf = sfBytes.buffer.slice(sfBytes.byteOffset, sfBytes.byteOffset + sfBytes.byteLength) as ArrayBuffer;

// Strings, winds, brass and tuned percussion with short releases (GM program, pitch).
const ORCHESTRA: Array<[number, number]> = [
  [45, 67], [45, 62], [45, 55], [45, 48], [46, 72], [46, 60], [56, 70], [56, 65],
  [57, 58], [58, 41], [60, 60], [60, 53], [68, 74], [69, 67], [70, 50], [71, 62],
  [72, 84], [73, 79], [11, 72], [12, 64], [13, 76], [9, 84], [8, 72], [0, 60],
];

// ── The file: 4/4 x3 at 96, 7/8 x2 at 72, 5/4 x3 at 132 ─────────────────────
const BAR44 = PPQ * 4;
const BAR78 = (PPQ / 2) * 7;
const BAR54 = PPQ * 5;
const T78 = BAR44 * 3;
const T54 = T78 + BAR78 * 2;
const END = T54 + BAR54 * 3;
const tempos = [{ tick: 0, bpm: 96 }, { tick: T78, bpm: 72 }, { tick: T54, bpm: 132 }];
const timeSignatures = [{ tick: 0, num: 4, den: 4 }, { tick: T78, num: 7, den: 8, groups: [3, 2, 2] }, { tick: T54, num: 5, den: 4 }];

/** Seconds of `tick` under the file's tempos, integrated here rather than by the app. */
function tickSec(tick: number): number {
  let sec = 0;
  for (let i = 0; i < tempos.length; i += 1) {
    const from = tempos[i].tick;
    const to = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
    if (tick <= from) break;
    sec += ((Math.min(tick, to) - from) / PPQ) * (60 / tempos[i].bpm);
  }
  return sec;
}

// Each part: its pitch every two quarters, an eighth long, staggered by 23 ticks a part.
const partTracks: MidiTrack[] = ORCHESTRA.map(([, pitch], p) => {
  const notes = [];
  for (let tick = p * 23; tick + PPQ / 2 <= END; tick += PPQ * 2) {
    notes.push({ tick, note: pitch, velocity: 100, durationTicks: PPQ / 2, channel: p % 16 === 9 ? 10 : p % 16 });
  }
  return { name: `Part ${p + 1}`, notes };
});
const written: MidiFileData = { ppq: PPQ, bpm: 96, tracks: partTracks, tempos, timeSignatures };
const file = parseMidi(encodeMidi(written));

// ── Each part onto its own EDIT track, with its own instrument ───────────────
const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [] });
const firstTrack = ed().tracks[0].id;
const parts: Array<{ trackId: string; clipId: string; program: number; expected: number[] }> = [];
assert.equal(file.tracks.length, PARTS, 'the file reads back with its 24 parts');
file.tracks.forEach((track, p) => {
  const trackId = p === 0 ? firstTrack : ed().addTrack({ name: track.name });
  const fields = midiFileClipFields({ ...file, tracks: [track] }, `p${p}`);
  const clock = stepClock(fields.sourceBpm, fields.sourceTempoMap);
  const clipId = ed().addClipToTrack({
    trackId,
    label: track.name,
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: clock.at(fields.sourceTotalSteps),
    offsetIntoSource: 0,
    durationSec: clock.at(fields.sourceTotalSteps),
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    ...fields,
  });
  ed().updateTrack(trackId, { instrumentProgram: ORCHESTRA[p][0] });
  parts.push({ trackId, clipId, program: ORCHESTRA[p][0], expected: track.notes.map((n) => tickSec(n.tick)) });
});

// Each part keeps the file's tempo changes and meters.
for (const part of parts) {
  const clip = ed().clips.find((c) => c.id === part.clipId)!;
  assert.deepEqual((clip.sourceTempoMap ?? []).map((e) => [e.beat, e.bpm]), [[0, 96], [T78 / PPQ, 72], [T54 / PPQ, 132]], 'the part keeps both tempo changes');
  assert.deepEqual(
    (clip.sourceMeterMap ?? []).map((s) => `${s.bar}:${s.meter.num}/${s.meter.den}`),
    ['0:4/4', '3:7/8', '5:5/4'],
    'the part keeps its three meters',
  );
}

// The pass play() plans: every part live, on its own channel, with its own program.
const plan = planLiveMidi(ed().clips, ed().tracks, SF);
assert.equal(plan.liveClipIds.size, PARTS, 'all 24 parts play live');
assert.deepEqual(plan.channels.dropped, []);
const listed = liveMidiNotes(ed().clips, ed().tracks, plan, SF, 0, ed().bpm);
for (const part of parts) {
  const mine = listed.filter((n) => n.clipId === part.clipId);
  assert.equal(mine.length, part.expected.length, 'every note of the part plays');
  assert.ok(mine.every((n) => n.program === part.program), 'on the part\'s own instrument');
  assert.notEqual(localChannel(mine[0].channel), DRUM_CHANNEL, 'never on a drum channel');
  mine.forEach((n, i) => assert.ok(Math.abs(n.onDelaySec - part.expected[i]) < 1e-9, 'through the tempo map'));
}
const channelOf = new Map(parts.map((p) => [p.trackId, plan.channels.channelOf.get(p.trackId)!]));

// ── Rendering ────────────────────────────────────────────────────────────────
function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function newSynth(): Promise<SpessaSynthProcessor> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false, eventsEnabled: false });
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(sf.slice(0)), 'main');
  await synth.processorInitialized;
  for (let i = 0; i < 16; i += 1) synth.createMIDIChannel();
  return synth;
}

/** A global EDIT channel's status byte channel and offset. */
const route = (channel: number) => ({ low: channel % 16, offset: channel - (channel % 16) });

/** The sink EDIT's banks are, on one processor with 32 channels: a timed program change, then the timed note. */
function sinkFor(synth: SpessaSynthProcessor): EditMidiSink {
  const programs = new Map<number, number>();
  const send = (bytes: number[], channel: number, time?: number) =>
    synth.processMessage(new Uint8Array(bytes), route(channel).offset, time !== undefined ? { time } : undefined);
  return {
    noteOn: (ch, program, midi, vel, time) => {
      if (programs.get(ch) !== program) {
        send([0xc0 | route(ch).low, program], ch, time);
        programs.set(ch, program);
      }
      send([0x90 | route(ch).low, midi, vel], ch, time);
    },
    noteOff: (ch, midi, time) => send([0x80 | route(ch).low, midi, 0], ch, time),
    wheel: (ch, raw, time) => send([0xe0 | route(ch).low, raw & 0x7f, (raw >> 7) & 0x7f], ch, time),
    wheelRange: () => undefined,
  };
}

/** A timer due every 25 ms, each fire late by 0-50 ms: true when it fires at `now`. */
function jitteryTimer(seed: number): (now: number) => boolean {
  const late = prng(seed);
  let due = 0;
  return (now) => {
    if (due > now) return false;
    while (due <= now) due += EDIT_MIDI_TICK_MS / 1000 + late() * 0.05;
    return true;
  };
}

/** Render `seconds` with each used channel's left output kept, calling `onBlock` before each render quantum. */
async function render(seconds: number, onBlock: (synth: SpessaSynthProcessor) => void): Promise<Map<number, Float32Array>> {
  const synth = await newSynth();
  const total = Math.ceil(seconds * SR);
  const used = [...channelOf.values()];
  const audio = new Map(used.map((ch) => [ch, new Float32Array(total)]));
  const outs = Array.from({ length: 32 }, () => [new Float32Array(128), new Float32Array(128)]);
  const effL = new Float32Array(128);
  const effR = new Float32Array(128);
  for (let at = 0; at < total; at += 128) {
    onBlock(synth);
    const n = Math.min(128, total - at);
    for (const [l, r] of outs) { l.fill(0); r.fill(0); }
    synth.processSplit(outs, effL, effR, 0, n);
    for (const ch of used) audio.get(ch)!.set(outs[ch][0].subarray(0, n), at);
  }
  return audio;
}

/** The first sample at a quarter of the way from the level before `t` to the peak after it. */
function onsetNear(x: Float32Array, t: number): number {
  const a = Math.max(0, Math.floor((t - 0.004) * SR));
  const pre = Math.max(0, a - Math.floor(0.03 * SR));
  const b = Math.min(x.length, a + Math.floor(0.2 * SR));
  let base = 0;
  for (let i = pre; i < a; i += 1) base = Math.max(base, Math.abs(x[i]));
  let peak = 0;
  for (let i = a; i < b; i += 1) peak = Math.max(peak, Math.abs(x[i]));
  const th = base + (peak - base) * 0.25;
  for (let i = a; i < b; i += 1) if (Math.abs(x[i]) >= th) return i / SR;
  return Number.NaN;
}

/** Per part, the spread of (heard onset - anchored time) across its notes. */
function spreads(audio: Map<number, Float32Array>, anchor: number): { worst: number; mean: number; perPart: number[] } {
  const perPart = parts.map((part) => {
    const x = audio.get(channelOf.get(part.trackId)!)!;
    const offs = part.expected.map((t) => onsetNear(x, anchor + t) - (anchor + t));
    assert.ok(offs.every(Number.isFinite), `every note of ${part.trackId} is heard`);
    return Math.max(...offs) - Math.min(...offs);
  });
  return { worst: Math.max(...perPart), mean: perPart.reduce((a, b) => a + b, 0) / perPart.length, perPart };
}

const seconds = tickSec(END) + 0.6;
const ANCHOR = 0.05; // the pass starts 50 ms into the synth's clock

// The live scheduler.
let sched: EditMidiScheduler | null = null;
const timerFires = jitteryTimer(11);
const live = await render(seconds, (synth) => {
  if (!timerFires(synth.currentTime)) return;
  if (!sched) {
    sched = new EditMidiScheduler({
      now: () => synth.currentTime,
      sink: sinkFor(synth),
      clips: () => ed().clips,
      tracks: () => ed().tracks,
      global: () => SF,
      projectBpm: () => ed().bpm,
    });
    const pass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
    sched.prepare(pass);
    sched.start(pass, 0, ANCHOR);
    return;
  }
  sched.tick();
});
const liveStats = (sched as EditMidiScheduler | null)!.stats;
const liveSpread = spreads(live, ANCHOR);

// The path EDIT had: one timer per message, sent untimed when its timer fires,
// each timer late by 0-50 ms. Timers are checked before every render quantum.
const timerLate = prng(23);
const plainSink = (synth: SpessaSynthProcessor) => sinkFor(synth);
const pending = listed
  .flatMap((n) => [
    { at: ANCHOR + n.onDelaySec + timerLate() * 0.05, fire: (s: EditMidiSink) => s.noteOn(n.channel, n.program, n.midi, n.velocity, Number.NaN) },
    { at: ANCHOR + n.offDelaySec + timerLate() * 0.05, fire: (s: EditMidiSink) => s.noteOff(n.channel, n.midi, Number.NaN) },
  ])
  .sort((a, b) => a.at - b.at);
let next = 0;
let old: EditMidiSink | null = null;
const timers = await render(seconds, (synth) => {
  old ??= plainSink(synth);
  // NaN is no time: the synth plays the message at once, as a fired timer did.
  while (next < pending.length && pending[next].at <= synth.currentTime) pending[next++].fire(old);
});
const oldSpread = spreads(timers, ANCHOR);

const ms = (s: number) => `${(s * 1e3).toFixed(2)} ms`;
const noteCount = parts.reduce((a, p) => a + p.expected.length, 0);
console.log(`  ${PARTS} parts, ${noteCount} notes over ${seconds.toFixed(1)} s, timer late by 0-50 ms`);
console.log(`  per part: ${liveSpread.perPart.map((s) => (s * 1e3).toFixed(2)).join(" ")}`);
console.log(`  live scheduler: worst per-part onset spread ${ms(liveSpread.worst)}, mean ${ms(liveSpread.mean)} (render quantum ${ms(QUANTUM)})`);
console.log(`  untimed timers: worst per-part onset spread ${ms(oldSpread.worst)}, mean ${ms(oldSpread.mean)}`);

assert.deepEqual({ late: liveStats.late, skipped: liveStats.skipped }, { late: 0, skipped: 0 }, 'no note was late');
assert.equal(liveStats.notes, noteCount, 'every note was played once');
// One render quantum is the synth's own grid; the onset finder is allowed 1 ms
// more, for a release tail still ringing under the next attack (the harp's).
assert.ok(liveSpread.worst <= QUANTUM + 0.001, `live onsets stay within one render quantum of the clock (${ms(liveSpread.worst)})`);
assert.ok(oldSpread.worst > 4 * QUANTUM, `the measurement catches untimed timers (${ms(oldSpread.worst)})`);
console.log('editMidiScheduler.audio: ok');
