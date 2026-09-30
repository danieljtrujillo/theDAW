/**
 * The composer answers as roll parts and the roll's parts as composer
 * questions, without the store: which parts a check reads, the notes a flag
 * is about, a bass line with its figures, and each answer's voices by name.
 *
 *   cd frontend && npx tsx src/lib/rollComposer.test.ts
 */
import assert from 'node:assert/strict';
import type { PianoNote, RollTrack } from '../state/pianoRollStore.ts';
import {
  checkPick,
  composerNotesToRoll,
  counterpointPartWrites,
  figureTicks,
  figuredBassLine,
  flagNoteIds,
  formMovementWrite,
  partRange,
  satbRoleOf,
  voicePartName,
} from './rollComposer.ts';
import type { CanonResult, FormResult } from './composerClient.ts';

const pn = (id: string, note: number, tick: number, ticks = 960): PianoNote => ({ id, note, tick, ticks, step: tick / 240, length: ticks / 240, velocity: 90 });
const part = (id: string, name: string, notes: PianoNote[], extra: Partial<RollTrack> = {}): RollTrack => ({
  id,
  name,
  program: null,
  bank: 0,
  channel: null,
  color: '#a855f7',
  mute: false,
  solo: false,
  notes,
  ...extra,
});

// ── SATB names ──────────────────────────────────────────────────────────────
assert.equal(satbRoleOf('Soprano'), 'soprano');
assert.equal(satbRoleOf('alto 2'), 'alto');
assert.equal(satbRoleOf('Bass voice'), 'bass');
assert.equal(satbRoleOf('Bass Clarinet'), null);
assert.equal(satbRoleOf('Contrabass'), null);
assert.deepEqual(partRange({ name: 'Tenor' }), [48, 72], "a Tenor part sings the registry tenor's range");
assert.deepEqual(partRange({ name: 'Part 1', instrumentId: 'violin' }), partRange({ name: 'Violin' }), 'an instrument, or the one the name names');
assert.equal(partRange({ name: 'Part 1' }), null, 'a part the registry does not know');

// ── which parts a check reads ───────────────────────────────────────────────
const tracks = [
  part('p1', 'Piano', [pn('a', 40, 0)]),
  part('s', 'Soprano', [pn('s1', 72, 0), pn('s2', 74, 960)]),
  part('b', 'Bass', [pn('b1', 48, 0), pn('b2', 43, 960, 1920)]),
  part('e', 'Alto', []),
  part('k', 'Drums', [pn('k1', 36, 0)], { channel: 10 }),
];
{
  const pick = checkPick(tracks);
  assert.ok(pick);
  assert.deepEqual(pick.order, ['soprano', 'bass'], 'the SATB parts with notes, under their voice names');
  assert.deepEqual(pick.ids, { soprano: 's', bass: 'b' });
  assert.deepEqual(Object.keys(pick.ranges), ['soprano', 'bass']);
}
{
  const pick = checkPick(tracks, ['p1', 's', 'k']);
  assert.deepEqual(pick?.order, ['Soprano', 'Piano'], 'chosen parts, top first, a drum part never');
}
{
  const twins = [part('x', 'Violin', [pn('x1', 76, 0)]), part('y', 'Violin', [pn('y1', 69, 0)])];
  assert.deepEqual(checkPick(twins)?.order, ['Violin', 'Violin 2'], 'two parts of one name each have a name of their own');
}
assert.equal(checkPick([tracks[0]]), null, 'one part is no check');

// ── the notes a flag is about ───────────────────────────────────────────────
{
  const ids = flagNoteIds({ tick: 1500, parts: ['soprano', 'bass', 'nobody'] }, { soprano: 's', bass: 'b' }, tracks);
  assert.deepEqual([...ids.entries()], [['s', ['s2']], ['b', ['b2']]], 'the notes sounding at the tick');
  assert.equal(flagNoteIds({ tick: 5000, parts: ['soprano'] }, { soprano: 's' }, tracks).size, 0);
}

// ── a bass line with its figures ────────────────────────────────────────────
{
  const notes = [pn('c', 48, 0, 1920), pn('g', 55, 0, 960), pn('d', 50, 960, 960), pn('e', 52, 1920, 960)];
  const line = figuredBassLine(notes, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '6/4' }, { tick: 4000, figure: '7' }]);
  assert.deepEqual(line, [
    { note: 48, tick: 0, ticks: 960, figure: '' },
    { note: 50, tick: 960, ticks: 960, figure: '6' },
    { note: 52, tick: 1920, ticks: 960, figure: '6/4' },
  ], 'the lowest note of each onset, cut short at the next, with its figure; a figure with no note stays home');
  assert.deepEqual(figureTicks(notes), [0, 960, 1920]);
}

// ── answers as named parts ──────────────────────────────────────────────────
assert.equal(voicePartName('counterpoint'), 'Counterpoint');
assert.equal(voicePartName('cantus'), 'Cantus firmus');
assert.equal(voicePartName('voice_2'), 'Voice 2');
{
  const rolled = composerNotesToRoll([{ note: 60, tick: 480, ticks: 240 }, { note: 200, tick: -3, ticks: 0, velocity: 110 }], 't');
  assert.deepEqual(rolled.map((n) => [n.note, n.tick, n.ticks, n.step, n.length, n.velocity]), [[60, 480, 240, 2, 1, 80], [127, 0, 1, 0, 1 / 240, 110]]);
  assert.notEqual(rolled[0].id, rolled[1].id);
}
{
  const canon = { key: 'C major', order: ['leader', 'follower'], parts: { leader: [{ note: 60, tick: 0, ticks: 960 }], follower: [{ note: 67, tick: 960, ticks: 960 }] }, flags: [] } as unknown as CanonResult;
  const w = counterpointPartWrites(canon);
  assert.deepEqual(w.writes.map((x) => [x.voice, x.name, x.cantus ?? false]), [['leader', 'Leader', false], ['follower', 'Follower', false]]);
  assert.deepEqual(w.key, { tonic: 'C', mode: 'major' });
}
{
  const planned = { movements: [{ key: 'C major', title: 'I', tempo: { bpm: 120 }, meter_map: [], tempo_map: [], sections: [{ parts: undefined, chords: [] }] }] } as unknown as FormResult;
  assert.equal(formMovementWrite(planned), null, 'a form planned but not realized has no voices to write');
}

console.log('rollComposer: ok');
