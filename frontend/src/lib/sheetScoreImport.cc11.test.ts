/**
 * A score's hairpins, which the sheet importer sends as controller 11
 * (expression) changes beside the pedal's 64, land in the roll parts' own
 * controller changes and play. The printed levels are the notes' velocities;
 * CC11 is 127 where a level holds and shapes the level only inside a hairpin
 * (backend notation/expression.py, SheetExpression.cc11).
 *
 * The sequence: a two-part score (a violin with a crescendo from p to f, a
 * piano with its pedal and a diminuendo) is imported; each part keeps its
 * expression curve at its ticks, on the roll's clock, beside the pedal. PLAY
 * (lib/rollPartPlay, the scheduler the roll's transport runs) sends every
 * expression change on its part's channel at its tick's context time, the
 * part's state at a start halfway through, and MIDI export writes them as
 * controller 11. One undo takes an import of one part's dynamics back out
 * with its notes.
 *
 *   cd frontend && npx tsx src/lib/sheetScoreImport.cc11.test.ts
 */
import assert from 'node:assert/strict';
import { importSheetParts } from './rollPartsImport.ts';
import type { SheetScore } from './sheetImportClient.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS, type ScheduledWheel } from './rollPartPlay.ts';
import { stepClock } from './rollTempo.ts';
import { isPercussionPart, partControlCounts, rollLiveChannels } from './rollTracks.ts';
import { encodeMidi, parseMidi } from './midi.ts';
import { rollToMidiFile } from './rollMidi.ts';

const roll = () => usePianoRollStore.getState();
const note = (tick: number, ticks: number, pitch: number) => ({ pitch, step: tick / 240, length: ticks / 240, velocity: 80, tick, ticks });

// p (velocity 49) at bar 1, a crescendo through bar 2, f (velocity 80) at bar 3,
// sampled on each beat here. The crescendo's notes play at f's velocity, and
// CC11 = 127 x level / 80 brings the heard level from p up to f: 127 x 49/80
// = 78 at its start, back at 127 on the first onset after it.
const violinDynamics = [
  { tick: 3840, controller: 11, value: 78 },
  { tick: 4800, controller: 11, value: 90 },
  { tick: 5760, controller: 11, value: 102 },
  { tick: 6720, controller: 11, value: 115 },
  { tick: 7680, controller: 11, value: 127 },
];
// The pedal down through bar 1, and a diminuendo from f to p over the second
// half of bar 2: CC11 from 127 down along it, 127 again on bar 3's p note.
const pianoControls = [
  { tick: 0, controller: 64, value: 127 },
  { tick: 3840, controller: 64, value: 0 },
  { tick: 5760, controller: 11, value: 127 },
  { tick: 6720, controller: 11, value: 102 },
  { tick: 7680, controller: 11, value: 127 },
];
const score: SheetScore = {
  ok: true,
  name: 'Dynamics',
  format: 'musicxml',
  bpm: 100,
  time_signature: [4, 4],
  detected_key: 'C major',
  track_count: 2,
  note_count: 6,
  ppq: 960,
  time_signatures: [{ tick: 0, num: 4, den: 4, groups: [] }],
  pickup_ticks: 0,
  tempos: [{ tick: 0, bpm: 100 }],
  steps_per_quarter: 4,
  tracks: [
    { name: 'Violin', instrument: 'violin', program: 40, notes: [note(0, 3840, 76), note(3840, 3840, 79), note(7680, 3840, 81)], controls: violinDynamics },
    { name: 'Piano', instrument: 'piano', program: 0, notes: [note(0, 3840, 48), note(3840, 3840, 43), note(7680, 3840, 48)], controls: pianoControls },
  ],
};

// ── IMPORT: each part's expression curve, beside its pedal ─────────────────
const done = importSheetParts(score);
assert.equal(done.into, 'parts');
const [violin, piano] = rollTracksOf(roll());
assert.deepEqual(violin.controls, violinDynamics, "the violin's crescendo as controller 11 at its ticks");
assert.deepEqual(piano.controls, pianoControls, "the piano's pedal and diminuendo, in tick order");
assert.deepEqual(
  partControlCounts(violin.controls).map((c) => [c.controller.name, c.count]),
  [['Expression', 5]],
  'the parts column lists them as expression',
);
assert.ok(!isPercussionPart(violin));

// ── PLAY: every expression change on its part's channel, on time ───────────
usePianoRollStore.setState({ currentStep: 0, loop: null, loopOn: false });
const start = roll();
const parts = rollTracksOf(start);
const live = rollLiveChannels(parts, start.lanes, start.bends);
const clock = stepClock(start.bpm, start.tempoMap);
const origin = 10;
const scheduler = createRollScheduler({ ...start, tracks: parts }, origin, ROLL_LOOKAHEAD_SEC);
const voiceOf = (id: string) => {
  const p = rollTracksOf(roll()).find((t) => t.id === id);
  return p ? { program: p.program ?? 0, bank: p.bank, percussion: isPercussionPart(p) } : undefined;
};
const sent: ScheduledWheel[] = [];
const endSec = clock.at(start.totalSteps);
for (let now = origin - 0.05; now < origin + endSec - ROLL_LOOKAHEAD_SEC; now += ROLL_TICK_MS / 1000) {
  const st = roll();
  for (const w of scheduler.tick(now, { ...st, tracks: rollTracksOf(st) }, voiceOf).wheels) if (w.kind === 'control') sent.push(w);
}
for (const p of parts) {
  const ch = live.get(p.id)!.base;
  for (const c of p.controls ?? []) {
    if (c.controller !== 11) continue;
    const at = origin + clock.at(c.tick / 240);
    const hit = sent.find((w) => w.channel === ch && w.controller === 11 && w.value === c.value && Math.abs((w.time ?? 0) - at) < 1e-6);
    assert.ok(hit, `${p.name}: expression ${c.value} at ${at.toFixed(3)} s`);
  }
}
// Starting inside the hairpin: the violin's channel gets the expression it has there first.
{
  usePianoRollStore.setState({ currentStep: 22 }); // tick 5280, after the change to 90 at 4800
  const st = roll();
  const halfway = createRollScheduler({ ...st, tracks: rollTracksOf(st) }, 50, ROLL_LOOKAHEAD_SEC);
  const first = halfway.tick(49.95, { ...st, tracks: rollTracksOf(st) }, voiceOf).wheels.filter((w) => w.kind === 'control');
  const ch = live.get(violin.id)!.base;
  assert.equal(first.find((w) => w.channel === ch && w.controller === 11)?.value, 90, 'the expression in force where playback starts');
  usePianoRollStore.setState({ currentStep: 0 });
}

// ── MIDI export writes controller 11 ────────────────────────────────────────
{
  const back = parseMidi(encodeMidi(rollToMidiFile(roll(), 960)));
  const expressions = back.tracks.flatMap((t) => (t.controls ?? []).filter((c) => c.controller === 11)).map((c) => [c.tick, c.value]);
  assert.deepEqual(
    expressions.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [...violinDynamics, ...pianoControls.filter((c) => c.controller === 11)].map((c) => [c.tick, c.value]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    'every expression change in the file',
  );
}

// ── A score of one part into the part being edited, dynamics and all, one undo ─
{
  const steps = roll()._undo.length;
  const one: SheetScore = { ...score, track_count: 1, tracks: [{ ...score.tracks[0], name: 'Flute', instrument: 'flute', program: 73 }] };
  roll().setActiveTrack(piano.id);
  importSheetParts(one);
  const active = rollTracksOf(roll()).find((t) => t.id === roll().activeTrackId)!;
  assert.deepEqual(active.controls, violinDynamics, "the part takes the score's dynamics in place of its own");
  assert.ok(roll()._undo.length > steps);
  roll().undo();
  assert.deepEqual(rollTracksOf(roll()).find((t) => t.id === piano.id)?.controls, pianoControls, 'one undo puts the pedal and diminuendo back');
}

console.log('sheetScoreImport.cc11: ok');
