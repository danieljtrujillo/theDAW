/**
 * Where the composer's answers land in the piano roll, replayed through the
 * store the roll draws: a plan into an empty roll becomes the roll (four
 * parts, its meter), a write into a roll with notes replaces the parts it
 * names and keeps the rest, a counterpoint lands top voice first, a realized
 * movement brings its meter, tempo and section markers, the check sends every
 * part with notes top voice first, and a flag's row selects the notes it names.
 *
 * Run: `npx tsx src/lib/composeToRoll.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { CanonResult, FormMovement, PlanResult, SpeciesResult } from './composerClient';
import {
  partTitle,
  rollPartNotes,
  rollPartOptions,
  rollPartsForCheck,
  runVoiceLeadingCheck,
  selectFlagNotes,
  toPianoNote,
  writeCounterpoint,
  writeFormMovement,
  writePartsToRoll,
  writePlan,
} from './composeToRoll';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore';

const emptyRoll = (): void => {
  usePianoRollStore.getState().importParts([{ name: 'Part 1', notes: [] }]);
};
const parts = () => rollTracksOf(usePianoRollStore.getState());
const byName = (name: string) => parts().find((t) => t.name === name);

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
const threeFour = [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }];
const satb = (base: number) => [
  { note: base, tick: 0, ticks: 960 },
  { note: base + 2, tick: 960, ticks: 1920 },
];
const plan = {
  key: 'C major',
  bars: 2,
  meter_map: threeFour,
  parts: { soprano: satb(72), alto: satb(67), tenor: satb(60), bass: satb(48) },
  flags: [],
} as unknown as PlanResult;
emptyRoll();
const w1 = writePlan(plan);
assert.deepEqual(w1, { parts: ['Soprano', 'Alto', 'Tenor', 'Bass'], notes: 8, replaced: true });
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass']);
assert.deepEqual(usePianoRollStore.getState().meterMap, threeFour, "the roll takes the plan's meter");
assert.deepEqual(byName('Bass')?.notes.map((n) => [n.note, n.tick, n.ticks]), [
  [48, 0, 960],
  [50, 960, 1920],
]);

// ── into a roll with notes: named parts replaced, the rest kept ─────────────
usePianoRollStore.getState().addTrack({ name: 'Violin', notes: [toPianoNote({ note: 76, tick: 0, ticks: 960 })] });
const violinId = byName('Violin')?.id;
const sopranoId = byName('Soprano')?.id;
const w2 = writePartsToRoll([
  { name: 'soprano', notes: [{ note: 79, tick: 0, ticks: 480 }] },
  { name: 'descant', notes: [{ note: 84, tick: 15360 * 4, ticks: 960 }] },
]);
assert.equal(w2.replaced, false);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass', 'Violin', 'Descant']);
assert.equal(byName('Soprano')?.id, sopranoId, 'the same part, its notes replaced');
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.note), [79]);
assert.equal(byName('Violin')?.id, violinId);
assert.deepEqual(byName('Violin')?.notes.map((n) => n.note), [76], 'a part the write does not name keeps its notes');
assert.equal(usePianoRollStore.getState().activeTrackId, sopranoId, 'the first part written is the one being edited');
assert.ok(usePianoRollStore.getState().totalSteps >= (15360 * 4 + 960) / 240, 'the grid reaches the last note');

// ── counterpoint: top voice first ───────────────────────────────────────────
emptyRoll();
const species = {
  order: ['counterpoint', 'cantus'],
  parts: { counterpoint: [{ note: 74, tick: 0, ticks: 3840 }], cantus: [{ note: 62, tick: 0, ticks: 3840 }] },
} as unknown as SpeciesResult;
assert.deepEqual(writeCounterpoint(species).parts, ['Counterpoint', 'Cantus']);
assert.deepEqual(parts().map((t) => t.name), ['Counterpoint', 'Cantus']);
assert.deepEqual(usePianoRollStore.getState().meterMap[0].meter, { num: 4, den: 4, groups: [] }, 'counterpoint is written in 4/4');
const canon = {
  order: ['follower', 'leader'],
  parts: { leader: [{ note: 60, tick: 0, ticks: 960 }], follower: [{ note: 67, tick: 3840, ticks: 960 }] },
} as unknown as CanonResult;
writeCounterpoint(canon);
assert.deepEqual(parts().map((t) => t.name), ['Counterpoint', 'Cantus', 'Follower', 'Leader'], 'a roll with notes keeps them');
emptyRoll();
writeCounterpoint({
  voices: ['soprano', 'alto', 'bass'],
  parts: { soprano: [{ note: 72, tick: 0, ticks: 960 }], alto: [{ note: 67, tick: 960, ticks: 960 }], bass: [{ note: 48, tick: 1920, ticks: 960 }] },
} as never);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Bass'], "a fugue's voices in its own order");

// ── a realized movement replaces the roll with its meter, tempo and sections ─
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
    { index: 0, label: 'Minuet', role: 'minuet', start_tick: 0, parts: { soprano: satb(79), alto: [], tenor: [], bass: satb(43) } },
    { index: 1, label: 'Trio', role: 'trio', start_tick: 46080, parts: { soprano: [{ note: 74, tick: 46080, ticks: 960 }], alto: [], tenor: [], bass: [] } },
  ],
} as unknown as FormMovement;
usePianoRollStore.getState().addTrack({ name: 'Keep me?', notes: [toPianoNote({ note: 60, tick: 0, ticks: 960 })] });
const w3 = writeFormMovement(movement);
assert.equal(w3.replaced, true);
assert.equal(w3.notes, 5);
assert.deepEqual(parts().map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], 'a movement is the whole roll (undo brings the old one back)');
assert.deepEqual(byName('Soprano')?.notes.map((n) => n.tick), [0, 960, 46080], 'every section in one part');
const s3 = usePianoRollStore.getState();
assert.equal(s3.bpm, 126);
assert.deepEqual(s3.tempoMap.map((e) => [e.beat, e.bpm]), [
  [0, 126],
  [48, 112],
]);
assert.deepEqual(s3.meterMap, threeFour);
assert.deepEqual(s3.markers.map((m) => [m.name, m.tick, m.kind]), [
  ['Minuet and trio', 0, 'movement'],
  ['Minuet', 0, 'section'],
  ['Trio', 46080, 'section'],
]);
assert.throws(() => writeFormMovement({ ...movement, sections: [] } as FormMovement), /no notes/);

// ── reading the roll ────────────────────────────────────────────────────────
assert.deepEqual(rollPartOptions().map((o) => [o.name, o.notes]), [
  ['Soprano', 3],
  ['Alto', 0],
  ['Tenor', 0],
  ['Bass', 2],
]);
assert.deepEqual(rollPartNotes(byName('Bass')!.id).map((n) => [n.note, n.tick]), [
  [43, 0],
  [45, 960],
]);
assert.deepEqual(rollPartNotes('nope'), []);
const forCheck = rollPartsForCheck();
assert.deepEqual(forCheck.order, ['Soprano', 'Bass'], 'parts with notes, top voice first');
assert.equal(forCheck.idByName.Bass, byName('Bass')?.id);

// ── the check ───────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  location: { href: 'http://localhost:5173/', origin: 'http://localhost:5173', hash: '', pathname: '/', search: '' },
  localStorage: { getItem: () => null, setItem: () => undefined },
  history: { replaceState: () => undefined },
};
let body: Record<string, unknown> | null = null;
const flag = { bar: 0, beat: 2, tick: 960, parts: ['Bass', 'Soprano'], rule: 'parallel_octaves', message: 'octaves' };
globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ flags: [flag], count: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;
try {
  const outcome = await runVoiceLeadingCheck({ key: 'G', mode: 'major' });
  assert.equal(outcome.count, 1);
  assert.ok(body);
  const sent = body as Record<string, unknown>;
  assert.deepEqual(sent.order, ['Soprano', 'Bass']);
  assert.equal(sent.key, 'G');
  assert.equal(sent.mode, 'major');
  assert.deepEqual((sent.parts as Record<string, unknown[]>).Bass, [
    { note: 43, tick: 0, ticks: 960 },
    { note: 45, tick: 960, ticks: 1920 },
  ]);
  assert.deepEqual(sent.meter_map, [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }]);

  // A row selects the notes it names: in the first part it names that has an id.
  const n = selectFlagNotes(flag, outcome.idByName);
  assert.equal(n, 1);
  const s = usePianoRollStore.getState();
  assert.equal(s.activeTrackId, byName('Bass')?.id);
  assert.deepEqual([...s.selectedIds].map((id) => s.notes.find((x) => x.id === id)?.note), [45]);
  assert.equal(s.currentStep, 4, 'the playhead goes to the flag');
  assert.equal(selectFlagNotes({ tick: 0, parts: ['Nobody'] }, outcome.idByName), 0);

  // Fewer than two parts with notes: nothing to check, and no request.
  emptyRoll();
  body = null;
  await assert.rejects(runVoiceLeadingCheck(), /two parts with notes/);
  assert.equal(body, null);
} finally {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
}

console.log('composeToRoll tests passed');
