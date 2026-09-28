/**
 * Per-note expression, MPE-style: the rotation of expressive notes across
 * member channels, and EDIT's live scheduler playing them. A clip with three
 * overlapping expressive notes plays each on a member channel of its own,
 * whose wheel, CC 74 and channel pressure are set to the note's just before it
 * starts; its other notes stay on the track's channel; the track plans the
 * member channels (liveMixer planLiveMidi); where the clip ends the members
 * rest; and a track with expression off plays every note on its own channel.
 *
 *   cd frontend && npx tsx src/lib/mpeRotation.test.ts
 */
import assert from 'node:assert/strict';
import {
  MPE_DEFAULT_MEMBERS,
  TIMBRE_REST,
  expressionMessages,
  hasExpression,
  maxOverlap,
  membersNeeded,
  rotateMembers,
  trackMembers,
} from './mpeRotation.ts';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, clipLiveSlots, type EditMidiPass } from './editMidiScheduler.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import type { GlobalVoice } from './clipProgram.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

// ── the rotation ───────────────────────────────────────────────────────────
{
  assert.equal(hasExpression(undefined), false);
  assert.equal(hasExpression({}), false);
  assert.equal(hasExpression({ timbre: 0.5 }), true);
  assert.equal(trackMembers(undefined), MPE_DEFAULT_MEMBERS);
  assert.equal(trackMembers(0), 0);
  assert.equal(trackMembers(40), 15);
  assert.equal(maxOverlap([{ start: 0, end: 4 }, { start: 4, end: 8 }]), 1, 'a note ending where the next starts does not overlap it');
  assert.equal(maxOverlap([{ start: 0, end: 4 }, { start: 1, end: 3 }, { start: 2, end: 8 }]), 3);
  assert.equal(membersNeeded([{ start: 0, end: 4 }, { start: 1, end: 3 }, { start: 2, end: 8 }], 2), 2);
  // Three members: a chord takes three; the next note takes the member free longest.
  const spans = [
    { start: 0, end: 4 },
    { start: 0, end: 2 },
    { start: 0, end: 6 },
    { start: 3, end: 5 }, // member 1 is free since 2, member 0 is busy until 4
    { start: 7, end: 8 }, // all free: member 0 (free since 4) over 1 (5) and 2 (6)
  ];
  assert.deepEqual(rotateMembers(spans, 3), [0, 1, 2, 1, 0]);
  // Every member busy: the one whose note ends first is shared.
  assert.deepEqual(rotateMembers([{ start: 0, end: 5 }, { start: 0, end: 3 }, { start: 1, end: 2 }], 2), [0, 1, 1]);
  assert.deepEqual(rotateMembers(spans, 0), [-1, -1, -1, -1, -1]);
  assert.deepEqual(expressionMessages({ pitchBend: 0.5, timbre: 1, pressure: 0.5 }), { wheel: 12288, timbre: 127, pressure: 64 });
  assert.deepEqual(expressionMessages({ pressure: 0.25 }), { wheel: 8192, timbre: TIMBRE_REST, pressure: 32 }, 'what a note leaves out rests');
}

// ── EDIT plays it ──────────────────────────────────────────────────────────
const ed = () => useEditorStore.getState();
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };
const note = (id: string, midi: number, step: number, length: number, expr?: PianoNote['expr']): PianoNote =>
  ({ id, note: midi, step, length, velocity: 100, ...(expr ? { expr } : {}) }) as PianoNote;

type Msg = { kind: string; ch: number; value?: number; controller?: number; midi?: number; t: number };

function play(): { msgs: Msg[]; channels: readonly number[] } {
  const clock = { t: 100 };
  const msgs: Msg[] = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (ch, _p, midi, _v, t) => msgs.push({ kind: 'on', ch, midi, t }),
      noteOff: (ch, midi, t) => msgs.push({ kind: 'off', ch, midi, t }),
      wheel: (ch, value, t) => msgs.push({ kind: 'wheel', ch, value, t }),
      wheelRange: (ch, value, t) => msgs.push({ kind: 'range', ch, value, t }),
      control: (ch, controller, value, t) => msgs.push({ kind: 'cc', ch, controller, value, t }),
      pressure: (ch, value, t) => msgs.push({ kind: 'pressure', ch, value, t }),
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => SF,
    projectBpm: () => ed().bpm,
  });
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  const pass: EditMidiPass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
  sched.start(pass, 0, clock.t);
  const end = clock.t + 3;
  while (clock.t < end) {
    clock.t += EDIT_MIDI_TICK_MS / 1000;
    sched.tick();
  }
  sched.stop();
  return { msgs, channels: plan.channels.channelsOf.get(ed().tracks[0].id) ?? [] };
}

ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().tracks[0].id;
const notes = [
  note('a', 60, 0, 8, { pitchBend: 0.5, pressure: 0.5 }),
  note('b', 64, 0, 8, { timbre: 1 }),
  note('c', 67, 2, 4, { pressure: 1 }),
  note('plain', 48, 0, 16),
];
const clipId = ed().addClipToTrack({
  trackId,
  label: 'Expressive',
  audioBlob: new Blob([], { type: 'audio/wav' }),
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
ed().updateClip(clipId, { instrumentProgram: 40 });

{
  assert.equal(clipLiveSlots({ sourcePianoRoll: notes }), 4, "the track's channel and three members for three overlapping expressive notes");
  const { msgs, channels } = play();
  assert.equal(channels.length, 4, 'the track holds four live channels');
  const onOf = (midi: number) => msgs.find((m) => m.kind === 'on' && m.midi === midi)!;
  const [base, ...members] = channels;
  assert.equal(onOf(48).ch, base, 'a note with no expression plays on the track channel');
  const expressiveChannels = [onOf(60).ch, onOf(64).ch, onOf(67).ch];
  assert.deepEqual([...new Set(expressiveChannels)].sort((x, y) => x - y), [...members].sort((x, y) => x - y), 'each expressive note on a member channel of its own');
  // Each expressive note's channel is set to it just before it starts, in the order handed to the synth.
  for (const [midi, want] of [
    [60, { wheel: 12288, timbre: TIMBRE_REST, pressure: 64 }],
    [64, { wheel: 8192, timbre: 127, pressure: 0 }],
    [67, { wheel: 8192, timbre: TIMBRE_REST, pressure: 127 }],
  ] as const) {
    const on = onOf(midi);
    const i = msgs.indexOf(on);
    const before = msgs.slice(0, i).filter((m) => m.ch === on.ch && Math.abs(m.t - on.t) < 1e-9);
    const last = (kind: string, controller?: number) =>
      [...before].reverse().find((m) => m.kind === kind && (controller === undefined || m.controller === controller))?.value;
    assert.equal(last('wheel'), want.wheel, `note ${midi}: its bend`);
    assert.equal(last('cc', 74), want.timbre, `note ${midi}: its timbre`);
    assert.equal(last('pressure'), want.pressure, `note ${midi}: its pressure`);
  }
  // Where the clip ends, its member channels rest.
  for (const ch of members) {
    const tail = msgs.filter((m) => m.ch === ch && (m.kind === 'pressure' || (m.kind === 'cc' && m.controller === 74)));
    const lastPressure = tail.filter((m) => m.kind === 'pressure').at(-1);
    const lastTimbre = tail.filter((m) => m.kind === 'cc').at(-1);
    assert.equal(lastPressure?.value, 0, `member ${ch}: no pressure after the clip`);
    assert.equal(lastTimbre?.value, TIMBRE_REST, `member ${ch}: CC 74 at rest after the clip`);
  }
}

// ── expression off: every note on the track's channel ──────────────────────
{
  ed().updateTrack(trackId, { mpeChannels: 0 });
  const { msgs, channels } = play();
  assert.equal(channels.length, 1);
  assert.ok(msgs.filter((m) => m.kind === 'on').every((m) => m.ch === channels[0]));
  assert.equal(msgs.filter((m) => m.kind === 'pressure').length, 0, 'no pressure sent');
}

// ── two members for three notes: the third shares ──────────────────────────
{
  ed().updateTrack(trackId, { mpeChannels: 2 });
  const { msgs, channels } = play();
  assert.equal(channels.length, 3);
  const expressive = msgs.filter((m) => m.kind === 'on' && m.midi !== 48).map((m) => m.ch);
  assert.ok(expressive.every((ch) => ch !== channels[0]), 'expressive notes stay on member channels');
  assert.equal(new Set(expressive).size, 2);
}

console.log('mpeRotation: ok');
