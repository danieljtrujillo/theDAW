/**
 * An EDIT track's MIDI output: each of the track's live channels goes to its
 * port on the track's channel and the ones after it, every message stamped
 * with the moment it sounds; each program change carries CC 0 and CC 32;
 * a stop ends every note sent; and the clock sends 24 clocks to the quarter
 * note on the tempo map, with song position and Start or Continue where the
 * pass starts and Stop where it ends. The last part plays a clip through
 * EDIT's live scheduler with its messages going to the port, as liveMixer
 * tees them.
 *
 *   cd frontend && npx tsx src/state/midiOutBus.test.ts
 */
import assert from 'node:assert/strict';
import { MidiClockScheduler, TrackOutSink, planTrackRoutes, setMidiOutputPorts, startTrackOutputs, stopTrackOutputs, tickTrackOutputs, trackOutputsActive } from './midiOutBus.ts';
import { beatToTime, timeToBeat, type TempoEvent } from '../lib/tempoMap.ts';

const live = [
  { id: 'p1', label: 'loopMIDI Port' },
  { id: 'p2', label: 'Orchestra Host' },
];

// ── routes ─────────────────────────────────────────────────────────────────
{
  const channelsOf = new Map([
    ['strings', [0, 1, 2]],
    ['horns', [3]],
    ['piano', [4]],
  ]);
  const plan = planTrackRoutes(
    [
      { id: 'strings', midiOut: { id: 'p1', label: 'loopMIDI Port', channel: 15 } },
      // A port id that rotated: found by its name.
      { id: 'horns', midiOut: { id: 'old-id', label: 'Orchestra Host', channel: 4, clock: true } },
      { id: 'piano' },
      { id: 'gone', name: 'Gone', midiOut: { id: 'x', label: 'Unplugged', channel: 1 } },
    ],
    channelsOf,
    live,
  );
  assert.deepEqual([...plan.routes.entries()], [
    [0, { portId: 'p1', channel: 14 }],
    [1, { portId: 'p1', channel: 15 }],
    [2, { portId: 'p1', channel: 0 }], // past 16 it wraps
    [3, { portId: 'p2', channel: 3 }],
  ]);
  assert.deepEqual(plan.clockPorts, ['p2']);
  assert.deepEqual(plan.missing, ['Gone']);
}

// ── the sink's bytes ───────────────────────────────────────────────────────
{
  const sent: Array<{ port: string; bytes: number[]; at: number }> = [];
  const sink = new TrackOutSink(
    new Map([[5, { portId: 'p1', channel: 2 }]]),
    (port, bytes, at) => sent.push({ port, bytes, at }),
    (t) => t * 1000 + 7,
  );
  sink.noteOn(5, 48, 60, 100, 1, 33, undefined);
  assert.deepEqual(sent.map((s) => s.bytes), [[0xb2, 0, 33], [0xb2, 32, 0], [0xc2, 48], [0x92, 60, 100]], 'CC 0, CC 32, program, note');
  assert.ok(sent.every((s) => s.port === 'p1' && s.at === 1007), 'stamped with the moment it sounds');
  sent.length = 0;
  sink.noteOn(5, 48, 64, 90, 1.5, 33, undefined);
  assert.deepEqual(sent.map((s) => s.bytes), [[0x92, 64, 90]], 'the same program is not sent again');
  sent.length = 0;
  sink.wheel(5, 12288, 2);
  sink.control(5, 74, 127, 2);
  sink.pressure(5, 64, 2);
  sink.wheelRange(5, 12, 2);
  assert.deepEqual(sent.slice(0, 3).map((s) => s.bytes), [[0xe2, 0, 96], [0xb2, 74, 127], [0xd2, 64]]);
  assert.deepEqual(sent.slice(3).map((s) => s.bytes), [[0xb2, 101, 0], [0xb2, 100, 0], [0xb2, 6, 12], [0xb2, 38, 0], [0xb2, 101, 127], [0xb2, 100, 127]], 'RPN 0/0: 12 semitones, then the null RPN');
  sent.length = 0;
  sink.noteOff(5, 60, 3);
  sink.allNotesOff(9999);
  assert.deepEqual(sent.map((s) => s.bytes), [[0x82, 60, 0], [0x82, 64, 0]], 'a stop ends the note still sounding');
  sent.length = 0;
  sink.noteOn(9, 1, 60, 100, 1, 0);
  assert.equal(sent.length, 0, 'a channel with no route sends nothing');
}

// ── the clock ──────────────────────────────────────────────────────────────
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120, timeSec: 0 }, { beat: 4, bpm: 60 }];
  const now = { t: 10 };
  const sent: Array<{ bytes: number[]; at: number }> = [];
  const clock = new MidiClockScheduler({
    send: (bytes, at) => sent.push({ bytes, at }),
    toPerf: (t) => t * 1000,
    now: () => now.t,
    beatAt: (sec) => timeToBeat(map, sec),
    secAt: (beat) => beatToTime(map, beat),
  });
  // From the top: song position 0 and Start.
  clock.start(0, 10, 0.1);
  assert.deepEqual(sent.slice(0, 2).map((s) => s.bytes), [[0xf2, 0, 0], [0xfa]]);
  assert.deepEqual(sent[2].bytes, [0xf8], 'the first clock at the start');
  assert.equal(sent.filter((x) => x.bytes[0] === 0xf8).length, 5, 'the first tenth of a second of clocks goes with the start');
  // The scheduler ticks every 25 ms, a tenth of a second ahead, as EDIT's timer does.
  while (now.t < 13) {
    now.t += 0.025;
    clock.tick(0.1);
  }
  const clocks = sent.filter((s) => s.bytes[0] === 0xf8);
  const first = clocks.filter((c) => c.at < 12000 - 1e-6);
  assert.equal(first.length, 96, 'two seconds at 120 BPM: four quarter notes, 24 clocks each');
  const gaps = first.slice(1).map((c, i) => c.at - first[i].at);
  assert.ok(gaps.every((g) => Math.abs(g - 1000 / 48) < 1e-6), `evenly at 120 BPM: ${gaps.filter((g) => Math.abs(g - 1000 / 48) >= 1e-6).slice(0, 5).join(', ')}`);
  const slow = clocks.filter((c) => c.at >= 12000 - 1e-6 && c.at < 13000 - 1e-6);
  assert.equal(slow.length, 24, 'past beat 4 the tempo is 60: one quarter note a second');
  assert.ok(clocks.every((c, i) => i === 0 || c.at >= clocks[i - 1].at), 'in order');
  clock.stop();
  assert.deepEqual(sent.at(-1)?.bytes, [0xfc], 'Stop');

  // From bar 2: song position 16 sixteenths, then Continue.
  sent.length = 0;
  now.t = 20;
  clock.start(2, 20);
  assert.deepEqual(sent.slice(0, 2).map((s) => s.bytes), [[0xf2, 16, 0], [0xfb]]);
}

// ── a pass: startTrackOutputs, the scheduler's messages, the stop ──────────
{
  const sent: Array<{ port: string; bytes: number[] }> = [];
  setMidiOutputPorts(live.map((p) => ({ id: p.id, name: p.label, send: (bytes: number[]) => sent.push({ port: p.id, bytes }) })));
  const map: TempoEvent[] = [{ beat: 0, bpm: 120, timeSec: 0 }];
  const sink = startTrackOutputs({
    tracks: [{ id: 't1', midiOut: { id: 'p2', label: 'Orchestra Host', channel: 1, clock: true } }],
    channelsOf: new Map([['t1', [0]]]),
    fromSec: 0,
    anchorCtx: 5,
    now: () => 5,
    toPerf: (t) => t * 1000,
    beatAt: (s) => timeToBeat(map, s),
    secAt: (b) => beatToTime(map, b),
  });
  assert.ok(sink && trackOutputsActive());
  sink.noteOn(0, 40, 67, 100, 5.1, 0);
  tickTrackOutputs(0.1);
  assert.ok(sent.some((s) => s.port === 'p2' && s.bytes[0] === 0x90), 'the note reaches the host');
  assert.ok(sent.some((s) => s.port === 'p2' && s.bytes[0] === 0xfa), 'Start');
  stopTrackOutputs(6000);
  assert.equal(trackOutputsActive(), false);
  assert.deepEqual(sent.filter((s) => s.bytes[0] === 0x80).map((s) => s.bytes), [[0x80, 67, 0]], 'the held note ends');
  assert.deepEqual(sent.at(-1)?.bytes, [0xfc], 'Stop');
  // No track with an output: nothing starts.
  assert.equal(startTrackOutputs({ tracks: [{ id: 't1' }], channelsOf: new Map(), fromSec: 0, anchorCtx: 0, now: () => 0, toPerf: (t) => t, beatAt: (s) => s, secAt: (b) => b }), null);
}

// ── a loop wrap: the stopped pass's clocks sent ahead arrive before the new Start ──
{
  const got: Array<{ bytes: number[]; at: number }> = [];
  setMidiOutputPorts([{ id: 'loop', name: 'Loop Host', send: (bytes: number[], at?: number) => got.push({ bytes, at: at ?? 0 }) }]);
  const tracks = [{ id: 't', midiOut: { id: 'loop', label: 'Loop Host', channel: 1, clock: true } }];
  let now = 1000;
  const common = { tracks, channelsOf: new Map(), now: () => now, toPerf: (t: number) => t * 1000, beatAt: (s: number) => s * 2, secAt: (b: number) => b / 2, lookaheadSec: 0.1 };
  // A two-second loop at 120: the wrap is seen at 1002.016 s, with the next 0.1 s of clocks already sent.
  startTrackOutputs({ ...common, fromSec: 0, anchorCtx: 1000 });
  for (; now < 1002.016; now += 0.025) tickTrackOutputs(0.1);
  now = 1002.016;
  startTrackOutputs({ ...common, fromSec: 0, anchorCtx: now });
  for (; now < 1003.016; now += 0.025) tickTrackOutputs(0.1);
  stopTrackOutputs(now * 1000);
  const start = got.findIndex((g, i) => i > 1 && g.bytes[0] === 0xfa);
  const lastStale = Math.max(...got.slice(0, start).map((g) => g.at));
  assert.ok(got[start].at >= lastStale, 'the new Start goes after every clock the stopped pass sent');
  assert.deepEqual(got[start - 2].bytes, [0xfc], 'Stop, then song position, then Start');
  assert.ok(got.every((g, i) => i === 0 || g.at >= got[i - 1].at), 'the port hears its clock messages in time order');
}

console.log('midiOutBus: ok');
