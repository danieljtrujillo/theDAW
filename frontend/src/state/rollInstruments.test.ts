/**
 * A piano-roll part played through a VST3 instrument (state/rollInstruments),
 * replayed against the real roll store, the real live-session row store and
 * the real scheduler, with the live host's registry, the engine's graph and
 * the transport as fakes.
 *
 * The sequence: two parts, the first given a scanned VST3 instrument; the
 * MIDI tab opens (attach) and holds the plugin's session on the roll's own
 * transport; the session goes live; PLAY starts the roll's clock and every
 * tick hands the VST part's notes to the plugin as stamped MIDI while the
 * program part stays on the synth; STOP panics the plugin; a note auditioned
 * while stopped goes to the plugin; the plugin fails, the LOG says so and the
 * part plays its program; the plugin is switched off and the session let go.
 * Run from `frontend/`:
 *   npx tsx src/state/rollInstruments.test.ts
 */
import assert from 'node:assert/strict';
import { rollTracksOf, usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { useVstLiveStore } from './vstLiveStore.ts';
import { useLogStore } from './logStore.ts';
import type { ChainEntry } from './effectChainStore.ts';
import {
  __setRollInstrumentDepsForTest,
  attachRollInstruments,
  auditionRollVoice,
  rollVstState,
  rollVstStamp,
  rollVstVoiceOf,
  sendRollVstMidi,
  startRollVstClock,
  stopRollVstClock,
} from './rollInstruments.ts';
import { rollPartVoice, rollPartVoices } from '../lib/rollPartVoice.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS } from '../lib/rollPartPlay.ts';
import { splitRollTick, vstPartChannels, type RollVstRoute } from '../lib/rollVstPlay.ts';
import { stepClock } from '../lib/rollTempo.ts';
import type { VstBridgeClientLike, VstMidiEvent } from '../lib/vstLive/bridgeClient.ts';
import type { VstTransportInfo } from '../lib/vstLive/vstLiveNode.ts';
import { ROLL_HOLDER } from '../lib/vstLive/projectSessions.ts';

const SR = 48000;
const PLUGIN = { plugin_path: 'C:\\Program Files\\Common Files\\VST3\\Surge XT.vst3', plugin_name: 'Surge XT' };

// ── fakes: the live host's registry, one bridge client, the engine's graph ───
const sent: VstMidiEvent[] = [];
let panics = 0;
const client = {
  acceptsMidi: true,
  sendMidi: (events: readonly VstMidiEvent[]) => {
    sent.push(...events);
  },
  midiPanic: () => {
    panics += 1;
  },
} as unknown as VstBridgeClientLike;
const holds: Array<{ id: string; holder: string }> = [];
const unholds: Array<{ id: string; holder: string }> = [];
const sessions = new Map<string, { client: VstBridgeClientLike }>();
const transports: Array<{ id: string; info: VstTransportInfo | null }> = [];
const fakeNode = () => ({
  input: {} as AudioNode,
  output: { connect() {}, disconnect() {} } as unknown as AudioNode,
  dispose() {},
});
const ctx = {
  sampleRate: SR,
  currentTime: 0,
  createConstantSource: () => ({ offset: { value: 0 }, connect() {}, disconnect() {}, start() {}, stop() {} }),
  createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
} as unknown as BaseAudioContext;
__setRollInstrumentDepsForTest({
  registry: {
    hold: async (entry: ChainEntry, _sr: number, holder: string) => {
      holds.push({ id: entry.id, holder });
      sessions.set(entry.id, { client });
      useVstLiveStore.getState().setStatus(entry.id, 'starting');
      return null;
    },
    unhold: (id, holder) => {
      unholds.push({ id, holder });
    },
    get: (id) => sessions.get(id) as never,
  },
  createNode: () => fakeNode() as never,
  ctx: () => ctx,
  master: () => ({ connect() {} }) as unknown as AudioNode,
  setTransport: (id, info) => {
    transports.push({ id, info });
  },
});

// ── two parts: a VST3 part and a General MIDI part ──────────────────────────
const note = (step: number, pitch: number): PianoNote => ({ id: `n${step}-${pitch}`, note: pitch, step, length: 2, velocity: 90 });
const st = () => usePianoRollStore.getState();
usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
const first = rollTracksOf(st())[0].id;
st().setTrackProgram(first, 40, false);
st().setPartNotes(first, [note(0, 60), note(4, 64), note(8, 67)]);
const second = st().addTrack({ notes: [note(0, 48), note(8, 43)], program: 32 }) as string;
st().setTrackVstInstrument(first, PLUGIN);
const partA = () => rollTracksOf(st()).find((t) => t.id === first)!;
const entryId = partA().vstInstrument!.id;
assert.equal(partA().vstInstrument?.vst?.plugin_path, PLUGIN.plugin_path);
assert.equal(partA().program, 40, 'the part keeps its General MIDI program as the fallback');
assert.equal(rollVstState(entryId), 'off', 'nothing is hosted before the MIDI tab opens');

// ── the MIDI tab opens: the plugin's session is held on the roll's transport ─
const detach = attachRollInstruments();
assert.deepEqual(holds, [{ id: entryId, holder: ROLL_HOLDER }], "the part's instrument is held under the roll's own holder");
assert.equal(rollVstState(entryId), 'opening');
assert.equal(rollVstVoiceOf(partA()), undefined, 'while the plugin opens the part plays its program');
const firstTransport = transports.find((t) => t.id === entryId)?.info;
assert.ok(firstTransport && firstTransport.freeRun === true && firstTransport.discontinuity === true, "the entry is put on the roll's clock before its node exists");

// ── the session goes live ───────────────────────────────────────────────────
useVstLiveStore.getState().setStatus(entryId, 'live');
assert.equal(rollVstState(entryId), 'live');
assert.deepEqual(rollVstVoiceOf(partA()), { entryId, mode: 'keyswitch' });
assert.equal(rollPartVoice(first).vst?.entryId, entryId, "the part's voice names its plugin");
assert.equal(rollPartVoices().get(second)?.vst, undefined, 'the General MIDI part has none');

// ── PLAY: the VST part's notes reach the plugin, the program part the synth ──
const origin = 10.06;
const start = st();
const clock = stepClock(start.bpm, start.tempoMap);
const scheduler = createRollScheduler({ ...start, tracks: rollTracksOf(start) }, origin, ROLL_LOOKAHEAD_SEC);
transports.length = 0;
startRollVstClock(origin, 0, start.bpm);
assert.equal(panics, 1, 'PLAY drops what an audition left waiting');
const playTransport = transports.find((t) => t.id === entryId)?.info;
assert.ok(playTransport?.playing === true && playTransport.atTime === origin && playTransport.tempoBpm === start.bpm, 'the plugin is told the roll plays from its first downbeat at its tempo');
let voices = rollPartVoices();
const routeOf = (partId: string): RollVstRoute | undefined => {
  const vst = voices.get(partId)?.vst;
  if (!vst) return undefined;
  return { entryId: vst.entryId, channels: vstPartChannels(scheduler.partChannels(partId) ?? [], vst.channel), stamp: rollVstStamp };
};
const synthNotes: Array<{ partId: string; note: number }> = [];
let now = 10;
const endSec = clock.at(st().totalSteps);
while (now < origin + endSec - ROLL_LOOKAHEAD_SEC) {
  const roll = st();
  voices = rollPartVoices();
  const scheduled = scheduler.tick(now, { ...roll, tracks: rollTracksOf(roll) }, (id) => voices.get(id));
  const out = splitRollTick(scheduled, routeOf, scheduler.channelOwner, now);
  sendRollVstMidi(out.midi);
  for (const n of out.notes) synthNotes.push({ partId: n.partId, note: n.note });
  now += ROLL_TICK_MS / 1000;
}
assert.deepEqual(synthNotes.map((n) => n.partId), [second, second], 'only the General MIDI part plays on the synth');
const ons = sent.filter((e) => (e.data[0] & 0xf0) === 0x90);
const offs = sent.filter((e) => (e.data[0] & 0xf0) === 0x80);
assert.deepEqual(ons.map((e) => e.data[1]), [60, 64, 67], "the VST part's notes reach the plugin as note-ons");
assert.equal(offs.length, 3, 'each with its note-off');
assert.ok(ons.every((e) => (e.data[0] & 0x0f) === 0), "on the part's channel");
for (const [i, step] of [0, 4, 8].entries()) {
  assert.equal(ons[i].pos, Math.round(clock.at(step) * SR), `note ${i} is stamped on the roll's clock at its step`);
}
assert.ok(offs.every((e, i) => e.pos > ons[i].pos), 'every note-off after its note-on');

// ── STOP: the plugin releases everything and its channel messages go now ────
sent.length = 0;
const released = splitRollTick({ notes: [], wheels: scheduler.release(now) }, routeOf, scheduler.channelOwner, now);
stopRollVstClock(now, released.midi);
assert.equal(panics, 2, 'STOP panics the plugin');
assert.ok(sent.every((e) => e.pos === -1), "the part's channel resets play now");
assert.equal(transports.filter((t) => t.id === entryId).at(-1)?.info?.playing, false, 'the plugin is told the roll stopped');

// ── a note drawn while stopped auditions through the plugin ─────────────────
sent.length = 0;
auditionRollVoice(72, 100, now + 0.02, 0.25, 1, rollPartVoice(first));
assert.deepEqual(sent.map((e) => [e.data[0], e.data[1]]), [[0x90, 72], [0x80, 72]], 'the audition goes to the plugin');
assert.equal(sent[0].pos, rollVstStamp(now + 0.02), "stamped on the roll's clock, which runs on while stopped");

// ── the plugin fails: the LOG says so and the part plays its program ────────
useVstLiveStore.getState().setStatus(entryId, 'error', 'the plugin could not be loaded');
assert.equal(rollVstState(entryId), 'fallback');
assert.equal(rollVstVoiceOf(partA()), undefined, 'the part plays its program again');
const logged = useLogStore.getState().entries.filter((e) => e.source === 'piano-roll' && e.level === 'error');
assert.equal(logged.length, 1, 'one LOG line for the failure');
assert.match(logged[0].msg, /Surge XT could not play \(the plugin could not be loaded\)/);
assert.match(logged[0].msg, /plays Violin instead/, 'naming the General MIDI program it plays instead');
assert.equal(rollPartVoices().get(first)?.program, 40, "the scheduler's voice for the part is its program");
useVstLiveStore.getState().setStatus(entryId, 'error', 'the plugin could not be loaded');
assert.equal(useLogStore.getState().entries.filter((e) => e.source === 'piano-roll' && e.level === 'error').length, 1, 'the same failure is not logged twice');

// ── switching back to General MIDI lets the session go ─────────────────────
st().setTrackVstEnabled(first, false);
assert.equal(rollVstState(entryId), 'off');
assert.deepEqual(unholds, [{ id: entryId, holder: ROLL_HOLDER }], 'the roll gives its hold back');
assert.equal(transports.filter((t) => t.id === entryId).at(-1)?.info, null, "the entry is handed back to EDIT's transport");
assert.equal(partA().vstInstrument?.vst?.plugin_path, PLUGIN.plugin_path, 'the plugin and its state stay with the part, switched off');
st().setTrackVstInstrument(first, PLUGIN);
assert.equal(partA().vstInstrument?.id, entryId, 'choosing the same plugin again switches it back on under its own entry');
assert.equal(holds.length, 2, 'and holds its session again');
detach();
assert.equal(unholds.length, 2, 'closing the MIDI tab lets every session go');
__setRollInstrumentDepsForTest(null);
console.log('rollInstruments: a roll part plays through its VST3 instrument, falls back to its program, and lets the session go');
