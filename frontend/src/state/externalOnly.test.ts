/**
 * An external-only track and a clock with no live MIDI.
 *
 * An external-only track (EditorTrack `externalOnly`, the track picker's
 * "External only") has no instrument of theDAW's: EDIT still plans and
 * schedules its notes live, they go to its MIDI out port with no program
 * change, and no synth of theDAW's hears them (no EDIT bank is even made for
 * them). A track beside it with an instrument keeps sounding on its synth
 * and on its own port. And the clock: an arrangement of audio alone, with a
 * track whose port has Clock ticked, still sends song position, Start and
 * the clocks while the transport plays (liveMixer starts it on every pass).
 *
 *   cd frontend && npx tsx src/state/externalOnly.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from './editorStore.ts';
import { internalBanks, liveMidiTrackStatus, planLiveMidi } from './liveMixer.ts';
import {
  externalOnlyChannels,
  passMidiSink,
  setMidiOutputPorts,
  startTrackRoutes,
  startTransportClock,
  stopTrackOutputs,
  tickTrackOutputs,
  trackOutputsActive,
} from './midiOutBus.ts';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiSink } from '../lib/editMidiScheduler.ts';
import type { GlobalVoice } from '../lib/clipProgram.ts';
import type { PianoNote } from './pianoRollStore.ts';
import { beatToTime, timeToBeat, type TempoEvent } from '../lib/tempoMap.ts';

const ed = () => useEditorStore.getState();
// The picker is off the soundfont: a track with no program of its own would play its bounce.
const OFF: GlobalVoice = { useSoundfont: false, activeProgram: 0 };
const sent: Array<{ port: string; bytes: number[] }> = [];
setMidiOutputPorts([
  { id: 'host', name: 'Orchestra Host', send: (bytes: number[]) => sent.push({ port: 'host', bytes }) },
  { id: 'synth', name: 'Hardware Synth', send: (bytes: number[]) => sent.push({ port: 'synth', bytes }) },
]);

const note = (id: string, midi: number, step: number): PianoNote => ({ id, note: midi, step, length: 4, velocity: 100 }) as PianoNote;
const clipOn = (trackId: string, notes: PianoNote[]) =>
  ed().addClipToTrack({
    trackId,
    label: 'part',
    audioBlob: null,
    mimeType: 'audio/wav',
    sourceDuration: 60,
    offsetIntoSource: 0,
    durationSec: 2,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: notes,
    sourceBpm: 120,
    sourceTotalSteps: 16,
  });

ed().loadProject({ tracks: [], clips: [] });
const host = ed().addTrack({ name: 'Horns (host)' });
ed().updateTrack(host, { externalOnly: true, midiOut: { id: 'host', label: 'Orchestra Host', channel: 3 } });
clipOn(host, [note('h1', 60, 0), note('h2', 64, 8)]);
const piano = ed().addTrack({ name: 'Piano', instrumentProgram: 0 });
ed().updateTrack(piano, { midiOut: { id: 'synth', label: 'Hardware Synth', channel: 1 } });
clipOn(piano, [note('p1', 48, 0)]);

// ── the plan ───────────────────────────────────────────────────────────────
const plan = planLiveMidi(ed().clips, ed().tracks, OFF);
{
  assert.equal(plan.liveClipIds.size, 2, 'the external-only clip plays live with no program anywhere');
  const status = liveMidiTrackStatus(ed().clips, ed().tracks, OFF);
  assert.equal(status.get(host)?.external, true);
  assert.equal(status.get(host)?.mode, 'live');
  assert.equal(status.get(piano)?.external, undefined);
  // Only the piano's channel needs a synth.
  const hostOnly = planLiveMidi(ed().clips.filter((c) => c.trackId === host), ed().tracks, OFF);
  assert.equal(internalBanks(hostOnly.channels, ed().tracks), 0, 'no EDIT bank is made for an external-only track');
  assert.equal(internalBanks(plan.channels, ed().tracks), 1);
}

// ── a pass: the port hears the host track, no synth does ───────────────────
{
  const internal: Array<{ kind: string; ch: number }> = [];
  const synthSink: EditMidiSink = {
    noteOn: (ch) => internal.push({ kind: 'on', ch }),
    noteOff: (ch) => internal.push({ kind: 'off', ch }),
    wheel: (ch) => internal.push({ kind: 'wheel', ch }),
    wheelRange: (ch) => internal.push({ kind: 'range', ch }),
    control: (ch) => internal.push({ kind: 'cc', ch }),
    pressure: (ch) => internal.push({ kind: 'pressure', ch }),
  };
  const clock = { t: 100 };
  const external = externalOnlyChannels(ed().tracks, plan.channels.channelsOf);
  const hostChannels = plan.channels.channelsOf.get(host) ?? [];
  assert.deepEqual([...external], [...hostChannels]);
  const out = startTrackRoutes({ tracks: ed().tracks, channelsOf: plan.channels.channelsOf, now: () => clock.t, toPerf: (t) => t * 1000 });
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: passMidiSink(synthSink, () => out, () => external),
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => OFF,
    projectBpm: () => ed().bpm,
  });
  sched.start({ liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf }, 0, clock.t);
  const end = clock.t + 3;
  while (clock.t < end) {
    clock.t += EDIT_MIDI_TICK_MS / 1000;
    sched.tick();
  }
  sched.stop();
  assert.ok(internal.length > 0, 'the piano still sounds on its synth');
  assert.ok(internal.every((m) => !external.has(m.ch)), 'no synth is told anything on the host track\'s channels');
  const toHost = sent.filter((s) => s.port === 'host').map((s) => s.bytes);
  const hostOns = toHost.filter((b) => (b[0] & 0xf0) === 0x90);
  assert.deepEqual(hostOns.map((b) => [b[0] & 0x0f, b[1]]), [[2, 60], [2, 64]], 'the host gets both notes, on channel 3');
  assert.equal(toHost.filter((b) => (b[0] & 0xf0) === 0xc0).length, 0, 'with no program change');
  assert.equal(toHost.filter((b) => (b[0] & 0xf0) === 0xb0 && (b[1] === 0 || b[1] === 32)).length, 0, 'and no bank select');
  const toSynth = sent.filter((s) => s.port === 'synth').map((s) => s.bytes);
  assert.deepEqual(toSynth.filter((b) => (b[0] & 0xf0) === 0xc0), [[0xc0, 0]], 'the piano track sends its program to its own port');
  stopTrackOutputs(0);
}

// ── the picker's External only, and back ───────────────────────────────────
{
  ed().setTrackVoice(host, 40, false);
  assert.equal(ed().tracks.find((t) => t.id === host)?.externalOnly, undefined, 'picking an instrument ends external-only playing');
  assert.equal(planLiveMidi(ed().clips, ed().tracks, OFF).channels.channelsOf.has(host), true);
  ed().updateTrack(host, { externalOnly: true, instrumentProgram: undefined });
}

// ── the clock on an arrangement of audio alone ─────────────────────────────
{
  sent.length = 0;
  ed().loadProject({ tracks: [], clips: [] });
  const drums = ed().addTrack({ name: 'Drum loop' });
  ed().updateTrack(drums, { midiOut: { id: 'host', label: 'Orchestra Host', channel: 10, clock: true } });
  assert.equal(planLiveMidi(ed().clips, ed().tracks, OFF).liveClipIds.size, 0, 'nothing plays live');
  const map: TempoEvent[] = [{ beat: 0, bpm: 120, timeSec: 0 }];
  const now = { t: 50 };
  const started = startTransportClock({
    tracks: ed().tracks,
    fromSec: 1,
    anchorCtx: 50,
    now: () => now.t,
    toPerf: (t) => t * 1000,
    beatAt: (s) => timeToBeat(map, s),
    secAt: (b) => beatToTime(map, b),
    lookaheadSec: 0.1,
  });
  assert.equal(started, true);
  assert.ok(trackOutputsActive());
  while (now.t < 51) {
    now.t += 0.025;
    tickTrackOutputs(0.1);
  }
  const bytes = sent.filter((s) => s.port === 'host').map((s) => s.bytes);
  assert.deepEqual(bytes.slice(0, 2), [[0xf2, 8, 0], [0xfb]], 'song position at beat 2 (8 sixteenths), then Continue');
  const clocks = bytes.filter((b) => b[0] === 0xf8).length;
  assert.ok(clocks >= 48 && clocks <= 54, `about two quarter notes of clock in a second at 120: ${clocks}`);
  stopTrackOutputs(0);
  assert.deepEqual(sent.at(-1)?.bytes, [0xfc], 'Stop when the transport stops');
  // No clocked port: no clock.
  ed().updateTrack(drums, { midiOut: { id: 'host', label: 'Orchestra Host', channel: 10 } });
  assert.equal(startTransportClock({ tracks: ed().tracks, fromSec: 0, anchorCtx: 0, now: () => 0, toPerf: (t) => t, beatAt: (s) => s, secAt: (b) => b }), false);
}

console.log('externalOnly: ok');
