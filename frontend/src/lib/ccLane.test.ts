/**
 * The CC lanes (stage 4.1): a part's controllers drawn in the roll's CC lane,
 * played live in EDIT, written by both MIDI writers, and ridden by a track's
 * trackMidiCc automation.
 *
 * The sequence each block replays:
 *   - the lane's edits rewrite one controller and leave the part's others
 *     (a file's pedal under a drawn swell);
 *   - a freehand swell and a RAMP write a change per step of value, and a
 *     hardware pass overwrites what it passes over;
 *   - brightness (74) and the reverb send (91) go through the roll's .mid
 *     export and back, and through notesToSmf's render file;
 *   - EDIT's live scheduler sends a part's 74 on the clip's channel at its
 *     time, and a trackMidiCc lane sends its controller and overrides the
 *     clip's own changes of it, live and in the arrangement's export.
 *
 *   cd frontend && npx tsx src/lib/ccLane.test.ts
 */
import assert from 'node:assert/strict';
import type { AudioClip, AutomationLane, EditorTrack } from '../state/editorStore.ts';
import { midiCcOfTarget, midiCcTarget } from '../state/editorStore.ts';
import { makeRollTrack } from './rollTracks.ts';
import { migrateNotes, type PianoNote, type RollControl } from '../state/pianoRollStore.ts';
import {
  ccPath,
  ccValueAt,
  controllerPoints,
  rampPoints,
  recordCcPoint,
  replaceCcSpan,
  setCcPoint,
  withControllerPoints,
} from './ccLane.ts';
import { rollToMidiFile } from './rollMidi.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { notesToSmf } from './midiWrite.ts';
import { EditMidiScheduler, type EditMidiPass } from './editMidiScheduler.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { ccLaneEvents } from './midiCcAutomation.ts';
import { DEFAULT_LANES } from '../state/pianoRollStore.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';

const PEDAL: RollControl[] = [
  { tick: 0, controller: 64, value: 127 },
  { tick: 1920, controller: 64, value: 0 },
];

// ── The lane's edits rewrite one controller ─────────────────────────────────
{
  const drawn = withControllerPoints(PEDAL, 11, [
    { tick: 960, value: 40 },
    { tick: 480, value: 90.6 },
    { tick: -5, value: 300 },
  ]);
  assert.deepEqual(
    drawn,
    [
      { tick: 0, controller: 64, value: 127 },
      { tick: 0, controller: 11, value: 127 },
      { tick: 480, controller: 11, value: 91 },
      { tick: 960, controller: 11, value: 40 },
      { tick: 1920, controller: 64, value: 0 },
    ],
    'the pedal stays; expression is cleaned, sorted and clamped',
  );
  assert.deepEqual(controllerPoints(drawn, 64), [{ tick: 0, value: 127 }, { tick: 1920, value: 0 }]);
  assert.equal(withControllerPoints([{ tick: 0, controller: 11, value: 5 }], 11, []), undefined, 'a part with none left carries no field');
  assert.equal(ccValueAt([], 100, 74), 64, 'brightness starts at 64');
  assert.equal(ccValueAt([], 100, 91), 0, 'the reverb send starts where SpessaSynth starts it');
  assert.equal(ccValueAt([{ tick: 50, value: 9 }], 100, 1), 9);
  assert.ok(ccPath([{ tick: 960, value: 127 }], 11, { stepPx: 10, ticksPerStep: 240, totalTicks: 1920, height: 72 }).startsWith('M0 4.00'), 'the path starts at the channel’s start value');
}

// ── A swell and a hardware pass ──────────────────────────────────────────────
{
  const swell = rampPoints(0, 20, 960, 110, 60);
  assert.equal(swell[0].tick, 0);
  assert.equal(swell[0].value, 20);
  assert.deepEqual(swell[swell.length - 1], { tick: 960, value: 110 }, 'it ends on the target');
  for (let i = 1; i < swell.length; i += 1) {
    assert.ok(swell[i].tick > swell[i - 1].tick && swell[i].value > swell[i - 1].value, 'a rising swell: every change later and louder');
  }
  assert.deepEqual(rampPoints(0, 50, 960, 50), [{ tick: 0, value: 50 }], 'a flat ramp is one change');
  // RAMP between two points replaces what lies between them.
  const before = setCcPoint(setCcPoint(setCcPoint([], 0, 10), 480, 99), 960, 100);
  const ramped = replaceCcSpan(before, 0, 960, rampPoints(0, 10, 960, 100));
  assert.ok(!ramped.some((p) => p.tick === 480 && p.value === 99), 'the point in the middle goes');

  // Hardware: a pass writes at the playhead and overwrites the changes it passes.
  let points = [{ tick: 500, value: 1 }, { tick: 700, value: 2 }, { tick: 2000, value: 3 }];
  let last: number | null = null;
  for (const [tick, value] of [[400, 60], [600, 70], [800, 70], [900, 80]] as const) {
    points = recordCcPoint(points, 11, tick, value, last);
    last = tick;
  }
  assert.deepEqual(points, [
    { tick: 400, value: 60 },
    { tick: 600, value: 70 },
    { tick: 900, value: 80 },
    { tick: 2000, value: 3 },
  ], 'the 500 and 700 changes it passed are gone; a repeated 70 writes nothing; the change past the pass stays');
}

// ── Both MIDI writers carry 74 and 91 ───────────────────────────────────────
const lanes: PolyLane[] = [...DEFAULT_LANES] as PolyLane[];
const n = (id: string, note: number, step: number, length = 8): PianoNote => ({ id, note, step, length, velocity: 90 });
{
  const controls: RollControl[] = [
    { tick: 0, controller: 91, value: 20 },
    { tick: 480, controller: 74, value: 100 },
  ];
  const tracks = [
    makeRollTrack({ id: 'vn', name: 'Violin', program: 40, controls, notes: migrateNotes([n('a', 76, 0)]) }, 0),
    makeRollTrack({ id: 'vc', name: 'Cello', program: 42, notes: migrateNotes([n('b', 48, 0)]) }, 1),
  ];
  const file = rollToMidiFile({
    notes: [],
    lanes,
    totalSteps: 32,
    bpm: 120,
    meterMap: normalizeMeterMap([]),
    pickupSteps: 0,
    bends: [],
    tracks,
  });
  const back = parseMidi(encodeMidi(file));
  const violin = back.tracks.find((t) => t.name.startsWith('Violin'));
  assert.deepEqual(
    violin?.controls?.map((c) => [c.tick, c.controller, c.value]),
    [[0, 91, 20], [480, 74, 100]],
    'the roll’s .mid export writes the reverb send and brightness, and they read back',
  );
  const bytes = notesToSmf([{ midi: 60, startSec: 0, durationSec: 1, velocity: 90 }], 40, 0, [], 120, [], {
    controls: [{ sec: 0.5, channel: 0, controller: 74, value: 101 }],
  });
  const smf = parseMidi(bytes);
  assert.deepEqual(smf.tracks[0].controls?.map((c) => [c.tick, c.controller, c.value]), [[480, 74, 101]], 'notesToSmf writes brightness at its tick');
}

// ── EDIT: a part's 74 live, and a trackMidiCc lane that owns expression ──────
type Cc = { ch: number; controller: number; value: number; t: number };
function play(clips: AudioClip[], tracks: EditorTrack[], automation: AutomationLane[], seconds: number): Cc[] {
  const clock = { t: 10 };
  const out: Cc[] = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: () => {},
      noteOff: () => {},
      wheel: () => {},
      wheelRange: () => {},
      control: (ch, controller, value, t) => out.push({ ch, controller, value, t: Math.round((t - 10) * 1000) / 1000 }),
    },
    clips: () => clips,
    tracks: () => tracks,
    global: () => ({ useSoundfont: true, activeProgram: 0 }),
    projectBpm: () => 120,
    automation: () => automation,
  });
  const pass: EditMidiPass = { liveClipIds: new Set(clips.map((c) => c.id)), channelsOf: new Map(tracks.map((t, i) => [t.id, [i]])) };
  sched.start(pass, 0, 10);
  while (clock.t < 10 + seconds) {
    clock.t += 0.025;
    sched.tick();
  }
  sched.stop();
  return out;
}
{
  const track = { id: 'strings', name: 'Strings', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [] } as unknown as EditorTrack;
  const part = makeRollTrack({ id: 'p', name: 'Violin', program: 40, controls: [{ tick: 960, controller: 74, value: 30 }, { tick: 960, controller: 11, value: 5 }] }, 0);
  const clip = {
    id: 'c1',
    trackId: 'strings',
    label: 'Violin',
    mimeType: 'audio/wav',
    sourceDuration: 4,
    offsetIntoSource: 0,
    durationSec: 4,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [n('x', 72, 0, 16)],
    sourceBpm: 120,
    sourceTotalSteps: 32,
    sourceRollPart: { doc: 'd', id: 'p', order: 0, name: 'Violin', program: 40, bank: 0, channel: null, color: '#fff', mute: false, solo: false, controls: part.controls },
  } as unknown as AudioClip;

  const live = play([clip], [track], [], 1);
  assert.ok(live.some((m) => m.controller === 74 && m.value === 30 && Math.abs(m.t - 0.5) < 1e-6), 'brightness 30 on beat 2, half a second in');
  assert.ok(live.some((m) => m.controller === 11 && m.value === 5), 'the part’s expression plays with no lane');

  const lane: AutomationLane = {
    id: 'l',
    target: midiCcTarget('strings', 11),
    points: [{ t: 0, v: 20 }, { t: 1, v: 120 }],
    enabled: true,
  };
  assert.equal(midiCcOfTarget(lane.target), 11);
  const auto = play([clip], [track], [lane], 1.2);
  const expr = auto.filter((m) => m.controller === 11);
  assert.ok(!expr.some((m) => m.value === 5), 'the lane owns expression: the part’s own change of it is left out');
  assert.equal(expr[0].value, 127, 'the pass opens the channel at the default first');
  assert.equal(expr[1].value, 20, 'then the lane’s value where the pass starts');
  const rising = expr.slice(1).map((m) => m.value);
  for (let i = 1; i < rising.length; i += 1) assert.ok(rising[i] > rising[i - 1], 'the swell only rises');
  assert.equal(rising[rising.length - 1], 120, 'and reaches the lane’s top');
  assert.ok(auto.some((m) => m.controller === 74 && m.value === 30), 'the part’s brightness still plays');
  const events = ccLaneEvents(lane, 0, 1, null).events;
  assert.equal(events.length, 100, 'a change per step of value over the second: 20 up to 119, 120 lands at t = 1');

  // The arrangement's export: the lane's changes on the track's channel, the part's expression left out.
  const file = arrangementToMidiFile({ tracks: [track], clips: [clip], bpm: 120, automationLanes: [lane] });
  const ctl = file.file.tracks[0].controls ?? [];
  const cc11 = ctl.filter((c) => c.controller === 11);
  assert.equal(cc11[0].tick, 0);
  assert.equal(cc11[0].value, 20, 'the lane’s value at the file’s start');
  assert.ok(!cc11.some((c) => c.value === 5), 'the part’s own expression is left out of the file too');
  assert.equal(Math.max(...cc11.map((c) => c.value)), 120);
  assert.ok(ctl.some((c) => c.controller === 74 && c.value === 30 && c.tick === 960), 'the part’s brightness is written');
}

console.log('ccLane: ok');
