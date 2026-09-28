/**
 * Where the composer's answers land in the piano roll, replayed through the
 * adapter the COMPOSE panel and the assistant's tools call, which writes with
 * the roll store's own composer actions:
 *
 *   - a plan into an empty roll becomes the roll (its spare empty part goes,
 *     the Soprano is edited), takes the plan's key and figures, and one undo
 *     brings the empty roll back;
 *   - a write by name into a roll with notes replaces the parts it names and
 *     keeps the rest;
 *   - a species answer's cantus goes back into the part marked as the cantus
 *     firmus, which is also the cantus "the selected part" sends; a canon and
 *     a fugue land by voice name; each is one undo step;
 *   - a realized movement brings its meter, tempo and section markers and
 *     keeps a part it does not name;
 *   - the request context is the roll's key, meter and SATB ranges, and the
 *     panel's pickers name the roll's key;
 *   - the check sends the SATB parts in the roll's key (or the one asked
 *     for), and its flags are the store's voiceLeading, the ones the harmony
 *     row shows; a flag's row selects the notes it names.
 *
 * Run: `npx tsx src/lib/composeToRoll.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { CanonResult, FormResult, FugueResult, PlanResult, SpeciesResult, VoiceLeadingFlag } from './composerClient';
import {
  partTitle,
  rollKeyForPanel,
  rollPartNotes,
  rollPartOptions,
  rollRequestContext,
  runVoiceLeadingCheck,
  selectFlagNotes,
  speciesCantusNotes,
  speciesCantusPart,
  toPianoNote,
  writeCounterpoint,
  writeFormMovement,
  writePartsToRoll,
  writePlan,
} from './composeToRoll';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore';

const roll = () => usePianoRollStore.getState();
const emptyRoll = (): void => {
  roll().importParts([{ name: 'Part 1', notes: [] }], 120, { meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  usePianoRollStore.setState({ _undo: [], _redo: [], rollKey: null, voiceLeading: null, harmonyChords: [] });
};
const parts = () => rollTracksOf(roll());
const byName = (name: string) => parts().find((t) => t.name === name);
const nameOf = (id: string) => parts().find((t) => t.id === id)?.name;

// Each write is its own undo step: the history joins writes closer than 300 ms, which a test makes in microseconds.
const realNow = performance.now.bind(performance);
let clock = realNow();
performance.now = () => (clock += 1000);

// ── a note keeps its tick ───────────────────────────────────────────────────
const pn = toPianoNote({ note: 60, tick: 480, ticks: 240 });
assert.equal(pn.tick, 480);
assert.equal(pn.ticks, 240);
assert.equal(pn.step, 2, '480 ticks is two 16ths');
assert.equal(pn.length, 1);
assert.equal(pn.velocity, 80, 'a default velocity');
assert.equal(toPianoNote({ note: 200, tick: -5, ticks: 0, velocity: 0 }).note, 127);
assert.equal(toPianoNote({ note: 60, tick: -5, ticks: 0, velocity: 0 }).tick, 0);
assert.equal(toPianoNote({ note: 60, tick: 0, ticks: 0, velocity: 0 }).velocity, 1, 'velocity 0 is a note-off, never a note');
assert.equal(partTitle('soprano'), 'Soprano');

// ── a plan into an empty roll becomes the roll ──────────────────────────────
const satb = (base: number) => [
  { note: base, tick: 0, ticks: 960 },
  { note: base + 2, tick: 960, ticks: 1920 },
];
const plan = {
  key: 'C major',
  final_key: 'C major',
  bars: 2,
  meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  chords: [
    { tick: 0, figure: 'I', key: 'C major' },
    { tick: 960, figure: 'V', key: 'C major' },
  ],
  parts: { soprano: satb(72), alto: satb(67), tenor: satb(60), bass: satb(48) },
  flags: [],
} as unknown as PlanResult;
emptyRoll();
const emptyId = parts()[0].id;
const w1 = writePlan(plan);
assert.deepEqual(w1.parts, ['Soprano', 'Alto', 'Tenor', 'Bass']);
assert.equal(w1.notes, 8);
assert.equal(w1.replaced, true, 'the roll held no notes: the plan is the roll');
assert.equal(w1.created, 4);
assert.equal(w1.skipped, 0);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], 'the spare empty part goes');
assert.equal(roll().activeTrackId, byName('Soprano')?.id, 'the top voice is the part being edited');
assert.deepEqual(w1.partIds, ['Soprano', 'Alto', 'Tenor', 'Bass'].map((n) => byName(n)?.id));
assert.deepEqual(byName('Bass')?.notes.map((n) => [n.note, n.tick, n.ticks]), [
  [48, 0, 960],
  [50, 960, 1920],
]);
assert.deepEqual(roll().rollKey, { tonic: 'C', mode: 'major' }, "the roll takes the plan's key");
assert.deepEqual(roll().harmonyChords.map((c) => c.figure), ['I', 'V'], "the harmony row's figures");
assert.equal(roll().voiceLeading?.source, 'plan');
assert.equal(roll()._undo.length, 1, 'one undo step');
roll().undo();
assert.deepEqual(parts().map((t) => [t.id, t.name]), [[emptyId, 'Part 1']], 'undo brings the empty roll back');
assert.equal(roll().activeTrackId, emptyId);
assert.equal(roll().rollKey, null, 'and its key');
roll().redo();
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], 'redo writes the plan again');

// A second plan replaces the named parts' notes and keeps the part being edited.
roll().setActiveTrack(byName('Tenor')!.id);
const w1b = writePlan({ ...plan, parts: { ...plan.parts, soprano: [{ note: 76, tick: 0, ticks: 3840 }] } } as PlanResult);
assert.equal(w1b.replaced, false);
assert.equal(w1b.created, 0);
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.note), [76]);
assert.equal(nameOf(roll().activeTrackId), 'Tenor', 'the part being edited stays');
roll().undo();
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.note), [72, 74], 'one undo puts the first plan back');

// ── into a roll with notes by name: named parts replaced, the rest kept ─────
roll().addTrack({ name: 'Violin', notes: [toPianoNote({ note: 76, tick: 0, ticks: 960 })] });
const violinId = byName('Violin')?.id;
const sopranoId = byName('Soprano')?.id;
const w2 = writePartsToRoll([
  { name: 'soprano', notes: [{ note: 79, tick: 0, ticks: 480 }] },
  { name: 'descant', notes: [{ note: 84, tick: 15360 * 4, ticks: 960 }] },
]);
assert.equal(w2.replaced, false);
assert.equal(w2.created, 1);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass', 'Violin', 'Descant']);
assert.equal(byName('Soprano')?.id, sopranoId, 'the same part, its notes replaced');
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.note), [79]);
assert.equal(byName('Violin')?.id, violinId);
assert.deepEqual(byName('Violin')?.notes.map((n) => n.note), [76], 'a part the write does not name keeps its notes');
assert.equal(roll().activeTrackId, sopranoId, 'the first part written is the one being edited');
assert.ok(roll().totalSteps >= (15360 * 4 + 960) / 240, 'the grid reaches the last note');

// ── counterpoint: the cantus firmus part, then canon and fugue voices ───────
emptyRoll();
roll().importParts(
  [
    { name: 'Violin', notes: [toPianoNote({ note: 76, tick: 0, ticks: 3840 })] },
    { name: 'Bass', notes: [62, 65, 64, 62].map((note, i) => toPianoNote({ note, tick: i * 3840, ticks: 3840 })) },
  ],
  120,
);
usePianoRollStore.setState({ _undo: [], _redo: [] });
const bassId = byName('Bass')!.id;
assert.deepEqual(speciesCantusPart(), { id: roll().activeTrackId, name: 'Violin', marked: false }, 'no mark: the part being edited');
roll().setCantusFirmus(bassId);
assert.deepEqual(speciesCantusPart(), { id: bassId, name: 'Bass', marked: true }, 'the part marked as the cantus firmus');
assert.deepEqual(speciesCantusNotes().map((n) => n.note), [62, 65, 64, 62], 'its notes are the cantus a species request sends');
const species = {
  species: 1,
  position: 'above',
  key: 'D dorian',
  order: ['counterpoint', 'cantus'],
  parts: {
    counterpoint: [69, 69, 67, 74].map((note, i) => ({ note, tick: i * 3840, ticks: 3840 })),
    cantus: [62, 65, 64, 62].map((note, i) => ({ note, tick: i * 3840, ticks: 3840 })),
  },
  suspensions: [],
  violations: [],
  flags: [],
} as unknown as SpeciesResult;
const undoBefore = roll()._undo.length;
const w3 = writeCounterpoint(species);
assert.deepEqual(w3.parts, ['Counterpoint', 'Bass'], 'top voice first; the cantus back in the marked part');
assert.equal(w3.created, 1);
assert.equal(w3.notes, 8);
assert.equal(roll()._undo.length, undoBefore + 1, 'one undo step');
assert.deepEqual(parts().map((t) => t.name), ['Violin', 'Bass', 'Counterpoint'], 'the other part stays');
roll().undo();
assert.equal(byName('Counterpoint'), undefined, 'undo takes the counterpoint away');
roll().redo();
const canon = {
  key: 'C major',
  canonic_until: 3840,
  order: ['leader', 'follower'],
  parts: { leader: [{ note: 60, tick: 0, ticks: 960 }], follower: [{ note: 67, tick: 3840, ticks: 960 }] },
  violations: [],
  flags: [],
} as unknown as CanonResult;
assert.deepEqual(writeCounterpoint(canon).parts, ['Leader', 'Follower']);
emptyRoll();
const w4 = writeCounterpoint({
  key: 'C minor',
  entries: [],
  voices: ['soprano', 'alto', 'bass'],
  parts: { soprano: [{ note: 72, tick: 0, ticks: 960 }], alto: [{ note: 67, tick: 960, ticks: 960 }], bass: [{ note: 48, tick: 1920, ticks: 960 }] },
  violations: [],
  flags: [],
} as unknown as FugueResult);
assert.equal(w4.replaced, true);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Bass'], "a fugue's voices in its own order, the roll's spare part gone");

// ── a realized movement: meter, tempo and sections; the other parts stay ────
const threeFour = [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }];
const movement = {
  index: 0,
  title: 'Minuet and trio',
  form: 'minuet_and_trio',
  key: 'G major',
  tempo: { bpm: 126, marking: 'Menuetto: Allegretto' },
  meter: { num: 3, den: 4, groups: [] },
  bars: 32,
  ticks: 32 * 2880,
  meter_map: threeFour,
  tempo_map: [
    { beat: 0, bpm: 126, curve: 'step', bar: 0, tick: 0, marking: 'Allegretto' },
    { beat: 48, bpm: 112, curve: 'step', bar: 16, tick: 46080, marking: 'Trio' },
  ],
  sections: [
    { index: 0, label: 'Minuet', role: 'minuet', start_tick: 0, chords: [], parts: { soprano: satb(79), alto: [], tenor: [], bass: satb(43) } },
    { index: 1, label: 'Trio', role: 'trio', start_tick: 46080, chords: [], parts: { soprano: [{ note: 74, tick: 46080, ticks: 960 }], alto: [], tenor: [], bass: [] } },
  ],
};
const form = { form: 'minuet_and_trio', key: 'G major', movements: [movement] } as unknown as FormResult;
roll().addTrack({ name: 'Keep me', notes: [toPianoNote({ note: 60, tick: 0, ticks: 960 })] });
const formUndo = roll()._undo.length;
const w5 = writeFormMovement(form, 0);
assert.equal(w5.replaced, false);
assert.equal(w5.notes, 5);
assert.equal(roll()._undo.length, formUndo + 1, 'one undo step');
assert.ok(byName('Keep me'), 'a part the movement does not name stays');
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.tick), [0, 960, 46080], 'every section in one part');
const s5 = roll();
assert.equal(s5.bpm, 126);
assert.deepEqual(s5.tempoMap.map((e) => [e.beat, e.bpm]), [
  [0, 126],
  [48, 112],
]);
assert.deepEqual(s5.meterMap, threeFour);
assert.deepEqual(s5.markers.map((m) => [m.name, m.tick, m.kind]), [
  ['Minuet and trio', 0, 'movement'],
  ['Minuet', 0, 'section'],
  ['Trio', 46080, 'section'],
]);
assert.deepEqual(s5.rollKey, { tonic: 'G', mode: 'major' });
const planned = { ...form, movements: [{ ...movement, sections: movement.sections.map((s) => ({ ...s, parts: undefined })) }] } as unknown as FormResult;
assert.throws(() => writeFormMovement(planned), /no notes/, 'a planned movement has no voices to write');
assert.throws(() => writeFormMovement(form, 4), /no notes/, 'nor a movement the form does not have');

// ── reading the roll ────────────────────────────────────────────────────────
assert.deepEqual(rollPartOptions().map((o) => [o.name, o.notes]), [
  ['Soprano', 3],
  ['Alto', 0],
  ['Bass', 2],
  ['Keep me', 1],
  ['Tenor', 0],
]);
assert.deepEqual(rollPartNotes(byName('Bass')!.id).map((n) => [n.note, n.tick]), [
  [43, 0],
  [45, 960],
]);
assert.deepEqual(rollPartNotes('nope'), []);

// The request context: the roll's key, meter and each SATB part's range.
const ctx = rollRequestContext();
assert.deepEqual(ctx.key, { tonic: 'G', mode: 'major' });
assert.equal(ctx.keySet, true);
assert.deepEqual(ctx.meterMap, threeFour);
assert.deepEqual(ctx.ranges.soprano, [60, 84], "the Soprano part's range from the registry");
assert.deepEqual(rollKeyForPanel(), { key: 'G', mode: 'major' });
roll().setRollKey({ tonic: 'G#', mode: 'minor' });
assert.deepEqual(rollKeyForPanel(), { key: 'Ab', mode: 'minor' }, "the panel's own spelling of the pitch class");
roll().undo();

// ── the check: the store's, its flags the harmony row's ─────────────────────
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  location: { href: 'http://localhost:5173/', origin: 'http://localhost:5173', hash: '', pathname: '/', search: '' },
  localStorage: { getItem: () => null, setItem: () => undefined },
  history: { replaceState: () => undefined },
};
let body: Record<string, unknown> | null = null;
const flag: VoiceLeadingFlag = { bar: 0, beat: 2, tick: 960, parts: ['bass', 'soprano'], rule: 'parallel_octaves', message: 'octaves' };
globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ flags: [flag], count: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
const sentBody = (): Record<string, unknown> => {
  assert.ok(body, 'a request went out');
  return body;
};
try {
  // In the roll's own key.
  const outcome = await runVoiceLeadingCheck();
  assert.equal(outcome.count, 1);
  const sent = sentBody();
  assert.deepEqual(sent.order, ['soprano', 'bass'], 'the SATB parts with notes, top voice first; Keep me is left out');
  assert.deepEqual([sent.key, sent.mode], ['G', 'major'], "the roll's key");
  assert.deepEqual((sent.parts as Record<string, unknown[]>).bass, [
    { note: 43, tick: 0, ticks: 960 },
    { note: 45, tick: 960, ticks: 1920 },
  ]);
  assert.deepEqual(sent.meter_map, threeFour);
  assert.deepEqual((sent.ranges as Record<string, number[]>).soprano, [60, 84], 'each voice range from the registry');
  assert.deepEqual(outcome.idByName, { soprano: byName('Soprano')?.id, bass: byName('Bass')?.id });
  const vl = roll().voiceLeading;
  assert.equal(vl?.source, 'check');
  assert.deepEqual(vl?.flags, [flag], "the flags are the store's: the harmony row shows these");
  assert.equal(roll().showHarmony, true, 'and the row opens');

  // In a key asked for: the roll's own stays.
  body = null;
  await runVoiceLeadingCheck({ key: 'D', mode: 'minor' });
  assert.deepEqual([sentBody().key, sentBody().mode], ['D', 'minor']);
  assert.deepEqual(roll().voiceLeading?.key, { tonic: 'D', mode: 'minor' });
  assert.deepEqual(roll().rollKey, { tonic: 'G', mode: 'major' });

  // A row selects the notes it names: the part being edited when it is one, else the first.
  roll().setActiveTrack(byName('Keep me')!.id);
  const n = selectFlagNotes(flag);
  assert.equal(n, 1);
  const s = roll();
  assert.equal(s.activeTrackId, byName('Bass')?.id);
  assert.deepEqual([...s.selectedIds].map((id) => s.notes.find((x) => x.id === id)?.note), [45]);
  assert.equal(s.currentStep, 4, 'the playhead goes to the flag');
  assert.equal(selectFlagNotes({ ...flag, parts: ['nobody'] }), 0);

  // Fewer than two parts with notes: nothing to check, and no request.
  emptyRoll();
  body = null;
  await assert.rejects(runVoiceLeadingCheck(), /two parts with notes/);
  assert.equal(body, null);
} finally {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
  performance.now = realNow;
}

console.log('composeToRoll tests passed');
