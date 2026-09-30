/**
 * What the composer client sends: the right route and method, snake_case
 * keys the backend's Pydantic models read, notes in ticks at 960 PPQ with the
 * roll's own fields left behind, the roll's meter map as it is, the phone's
 * pairing header, and the route's own message on a 422.
 *
 * Run: `npx tsx src/lib/composerClient.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { ApiError } from './apiJson';
import { COMPOSER_PPQ, composerApi, toComposerNote, toMeterMap } from './composerClient';
import type { MeterSegment } from './meterMap';

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let sent: Sent[] = [];

function serve(status: number, payload: unknown): void {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

// ── notes: ticks win, steps fill in, roll-only fields stay home ─────────────
assert.equal(COMPOSER_PPQ, 960);
assert.deepEqual(toComposerNote({ note: 60, tick: 480, ticks: 240, step: 99, length: 99 }), { note: 60, tick: 480, ticks: 240 });
assert.deepEqual(toComposerNote({ note: 62, step: 4, length: 2 }), { note: 62, tick: 960, ticks: 480 }, 'a step is 240 ticks');
assert.deepEqual(toComposerNote({ note: 64, step: 0, length: 0 }), { note: 64, tick: 0, ticks: 1 }, 'never zero length');
const rollNote = { id: 'n1', note: 67, step: 8, length: 4, velocity: 90, lane: 2, tick: 1920, ticks: 960 };
assert.deepEqual(toComposerNote(rollNote), { note: 67, tick: 1920, ticks: 960 });

// ── meter map: the roll's shape, copied ─────────────────────────────────────
const sevenEight: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }];
assert.deepEqual(toMeterMap(sevenEight), [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }]);
assert.notEqual(toMeterMap(sevenEight)[0].meter.groups, sevenEight[0].meter.groups, 'groups are copied');
assert.deepEqual(toMeterMap(undefined), []);

// A paired phone: apiJson attaches the token for a same-origin URL.
(globalThis as { window?: unknown }).window = {
  location: { href: 'http://192.168.1.20:5173/', origin: 'http://192.168.1.20:5173', hash: '', pathname: '/', search: '' },
  localStorage: { getItem: () => 'pair-token', setItem: () => undefined },
  history: { replaceState: () => undefined },
};

// ── plan ────────────────────────────────────────────────────────────────────
serve(200, { chords: [], parts: { soprano: [], alto: [], tenor: [], bass: [] }, flags: [] });
await composerApi.plan({
  key: 'F#',
  mode: 'minor',
  bars: 6,
  meterMap: sevenEight,
  include: ['neapolitan', 'german'],
  modulateTo: 'A',
  harmonicRhythm: 'bar',
  cadence: 'half',
  seed: 3,
});
assert.equal(sent.length, 1);
assert.equal(sent[0].url, '/api/composer/plan');
assert.equal(sent[0].method, 'POST');
assert.equal(sent[0].headers['Content-Type'], 'application/json');
assert.equal(sent[0].headers['X-TheDAW-Pair'], 'pair-token', 'a LAN caller carries its pairing token');
assert.deepEqual(sent[0].body, {
  key: 'F#',
  mode: 'minor',
  bars: 6,
  meter_map: [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }],
  seed: 3,
  cadence: 'half',
  include: ['neapolitan', 'german'],
  modulate_to: 'A',
  harmonic_rhythm: 'bar',
});

serve(200, { chords: [], parts: {}, flags: [] });
await composerApi.plan({ key: 'C' });
assert.deepEqual(sent[0].body, { key: 'C' }, 'unset options are left to the backend');

// ── check ───────────────────────────────────────────────────────────────────
serve(200, { flags: [], count: 0 });
await composerApi.check({
  parts: { violin: [rollNote], cello: [{ note: 48, step: 8, length: 4 }] },
  order: ['violin', 'cello'],
  key: 'C',
  chords: [{ tick: 0, figure: 'I', key: 'C' }],
  ranges: { violin: [55, 103], cello: [36, 76] },
  pickupSteps: 4,
});
assert.equal(sent[0].url, '/api/composer/check');
assert.deepEqual(sent[0].body, {
  parts: {
    violin: [{ note: 67, tick: 1920, ticks: 960 }],
    cello: [{ note: 48, tick: 1920, ticks: 960 }],
  },
  order: ['violin', 'cello'],
  key: 'C',
  chords: [{ tick: 0, figure: 'I', key: 'C' }],
  ranges: { violin: [55, 103], cello: [36, 76] },
  pickup_steps: 4,
});

// ── continuo ────────────────────────────────────────────────────────────────
serve(200, { chords: [], parts: {}, flags: [] });
await composerApi.continuo({
  key: 'C',
  bass: [
    { note: 48, tick: 0, ticks: 960, figure: '' },
    { note: 55, tick: 960, ticks: 960, figure: '6/4' },
  ],
  meterMap: sevenEight,
});
assert.equal(sent[0].url, '/api/composer/continuo');
assert.deepEqual(sent[0].body, {
  bass: [
    { note: 48, tick: 0, ticks: 960, figure: '' },
    { note: 55, tick: 960, ticks: 960, figure: '6/4' },
  ],
  key: 'C',
  meter_map: [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }],
});

// ── form and form/realize ───────────────────────────────────────────────────
serve(200, { form: 'symphony', movements: [] });
await composerApi.form({ form: 'symphony', key: 'Eb', seed: 4, bars: 320, harmonicRhythm: 'pulse' });
assert.equal(sent[0].url, '/api/composer/form');
assert.equal(sent[0].method, 'POST');
assert.equal(sent[0].headers['X-TheDAW-Pair'], 'pair-token');
assert.deepEqual(sent[0].body, { form: 'symphony', key: 'Eb', seed: 4, bars: 320, harmonic_rhythm: 'pulse' });

const groups = [2, 2, 3];
serve(200, { form: 'rondo', movements: [], flag_count: 0 });
await composerApi.realizeForm({
  form: 'rondo',
  key: 'g',
  mode: 'minor',
  rondo: 'ABACABA',
  meter: { num: 7, den: 8, groups },
  tempo: 152,
  ranges: { soprano: [60, 81] },
});
assert.equal(sent[0].url, '/api/composer/form/realize');
assert.deepEqual(sent[0].body, {
  form: 'rondo',
  key: 'g',
  mode: 'minor',
  meter: { num: 7, den: 8, groups: [2, 2, 3] },
  tempo: 152,
  rondo: 'ABACABA',
  ranges: { soprano: [60, 81] },
});
assert.notEqual((sent[0].body as { meter: { groups: number[] } }).meter.groups, groups, 'groups are copied');

serve(200, { form: 'theme_and_variations', movements: [] });
await composerApi.form({ form: 'theme_and_variations', key: 'D', variations: 6 });
assert.deepEqual(sent[0].body, { form: 'theme_and_variations', key: 'D', variations: 6 }, 'unset options are left to the backend');

serve(422, { detail: 'a single form is at most 400 bars' });
await assert.rejects(composerApi.form({ form: 'sonata', key: 'C', bars: 700 }), (e: unknown) => {
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 422);
  assert.match(e.message, /at most 400 bars/);
  return true;
});

// ── plan in a style ─────────────────────────────────────────────────────────
serve(200, { chords: [], parts: {}, flags: [], style: 'debussy', harmonic_rhythm: 'style' });
const styled = await composerApi.plan({ key: 'C', seed: 3, style: 'debussy' });
assert.deepEqual(sent[0].body, { key: 'C', seed: 3, style: 'debussy' }, 'no cadence: the style draws it');
assert.equal(styled.style, 'debussy');
serve(200, { chords: [], parts: {}, flags: [] });
await composerApi.plan({ key: 'C', style: 'bach', harmonicRhythm: 'pulse', cadence: 'plagal' });
assert.deepEqual(sent[0].body, { key: 'C', cadence: 'plagal', harmonic_rhythm: 'pulse', style: 'bach' });

// ── styles, one style, profile ──────────────────────────────────────────────
serve(200, {
  styles: [
    {
      id: 'bach',
      name: 'Johann Sebastian Bach',
      era: 'Baroque',
      source: 'extracted',
      basis: 'counted',
      works: 42,
      orchestration: 'satb_choir',
      chords_per_pulse: 1.17,
    },
  ],
});
const list = await composerApi.styles();
assert.equal(sent[0].url, '/api/composer/styles');
assert.equal(sent[0].method, 'GET');
assert.deepEqual(
  list.map((s) => [s.id, s.source]),
  [['bach', 'extracted']],
  'the list comes unwrapped',
);
serve(200, { flags: [], count: 0 });
assert.deepEqual(await composerApi.styles(), [], 'an answer with no list is no styles, never undefined');

serve(200, { schema: 'thedaw.composer.style', id: 'debussy', source: 'authored', works: [] });
const debussy = await composerApi.style('debussy');
assert.equal(sent[0].url, '/api/composer/styles/debussy');
assert.equal(debussy.source, 'authored');
serve(200, {});
await composerApi.style('a b/c');
assert.equal(sent[0].url, '/api/composer/styles/a%20b%2Fc', 'the id is one path segment');

serve(200, { schema: 'thedaw.composer.style', id: 'mine', works: ['bach_bwv66_6_mxl'] });
await composerApi.profile({ corpus: ['bach_bwv66_6_mxl'], id: 'mine', maxBars: 40 });
assert.equal(sent[0].url, '/api/composer/profile');
assert.equal(sent[0].method, 'POST');
assert.equal(sent[0].headers['X-TheDAW-Pair'], 'pair-token');
assert.deepEqual(sent[0].body, { corpus: ['bach_bwv66_6_mxl'], id: 'mine', max_bars: 40 });
serve(200, {});
await composerApi.profile({ entryId: 'entry-1', name: 'My chorale' });
assert.deepEqual(sent[0].body, { entry_id: 'entry-1', name: 'My chorale' });
serve(404, { detail: "no corpus piece 'nope'" });
await assert.rejects(composerApi.profile({ corpus: ['nope'] }), (e: unknown) => {
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 404);
  return true;
});

// ── capabilities is a GET ───────────────────────────────────────────────────
serve(200, { module: 'composer', ppq: 960 });
assert.equal((await composerApi.capabilities()).ppq, 960);
assert.equal(sent[0].url, '/api/composer/');
assert.equal(sent[0].method, 'GET');

// ── species: a cantus from the roll, in ticks, or a preset ──────────────────
serve(200, { parts: { counterpoint: [], cantus: [] }, violations: [], flags: [], suspensions: [] });
await composerApi.species({
  cantus: [rollNote, { note: 65, step: 24, length: 16 }],
  key: 'D dorian',
  species: 4,
  position: 'below',
  seed: 2,
  invertible: 12,
});
assert.equal(sent[0].url, '/api/composer/species');
assert.equal(sent[0].method, 'POST');
assert.equal(sent[0].headers['X-TheDAW-Pair'], 'pair-token');
assert.deepEqual(sent[0].body, {
  cantus: [
    { note: 67, tick: 1920, ticks: 960 },
    { note: 65, tick: 5760, ticks: 3840 },
  ],
  key: 'D dorian',
  species: 4,
  position: 'below',
  seed: 2,
  invertible: 12,
});

serve(200, { parts: { counterpoint: [], cantus: [] }, violations: [], flags: [], suspensions: [] });
await composerApi.species({ preset: 'fux_dorian', mode: 'dorian', startTick: 7680 });
assert.deepEqual(sent[0].body, { preset: 'fux_dorian', mode: 'dorian', start_tick: 7680 });

// ── invertible check ────────────────────────────────────────────────────────
serve(200, { ok: true, interval: 12, key: 'C major', original: {}, inverted: {} });
const inv = await composerApi.invertibleCheck({
  upper: [{ note: 69, tick: 0, ticks: 3840 }],
  lower: [{ note: 60, step: 0, length: 16 }],
  interval: 12,
  key: 'C',
});
assert.equal(inv.ok, true);
assert.equal(sent[0].url, '/api/composer/invertible-check');
assert.deepEqual(sent[0].body, {
  upper: [{ note: 69, tick: 0, ticks: 3840 }],
  lower: [{ note: 60, tick: 0, ticks: 3840 }],
  interval: 12,
  key: 'C',
});

// ── canon ───────────────────────────────────────────────────────────────────
serve(200, { parts: { leader: [], follower: [] }, violations: [], flags: [] });
await composerApi.canon({
  key: 'a',
  interval: -4,
  lag: 1920,
  bars: 10,
  transposition: 'real',
  rhythm: 'halves',
  startTick: 3840,
});
assert.equal(sent[0].url, '/api/composer/canon');
assert.deepEqual(sent[0].body, {
  key: 'a',
  interval: -4,
  lag: 1920,
  bars: 10,
  transposition: 'real',
  rhythm: 'halves',
  start_tick: 3840,
});

// ── fugue ───────────────────────────────────────────────────────────────────
serve(200, { parts: {}, entries: [], episodes: [], strettos: [], violations: [], flags: [] });
await composerApi.fugue({
  key: 'c',
  voices: 4,
  subject: [
    { note: 67, tick: 0, ticks: 960 },
    { note: 68, step: 4, length: 4 },
  ],
  episodes: 2,
  countersubject: false,
  seed: 5,
});
assert.equal(sent[0].url, '/api/composer/fugue');
assert.deepEqual(sent[0].body, {
  key: 'c',
  voices: 4,
  subject: [
    { note: 67, tick: 0, ticks: 960 },
    { note: 68, tick: 960, ticks: 960 },
  ],
  seed: 5,
  episodes: 2,
  countersubject: false,
});

serve(200, { parts: {}, entries: [], episodes: [], strettos: [], violations: [], flags: [] });
await composerApi.fugue({ key: 'G', subjectStart: 'dominant' });
assert.deepEqual(sent[0].body, { key: 'G', subject_start: 'dominant' }, 'no subject: the backend writes one');

// ── a 422 throws the route's own message ────────────────────────────────────
serve(422, { detail: 'the cantus reaches its final by step, or no cadence can be written' });
await assert.rejects(composerApi.species({ cantus: [{ note: 62, tick: 0, ticks: 3840 }] }), (e: unknown) => {
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 422);
  assert.match(e.message, /by step/);
  return true;
});

serve(422, { detail: 'this plan needs 9 chords and the bars hold 2; ask for more bars or a faster harmonic rhythm' });
await assert.rejects(composerApi.plan({ key: 'C', bars: 2, include: ['german'] }), (e: unknown) => {
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 422);
  assert.match(e.message, /needs 9 chords/);
  return true;
});

globalThis.fetch = realFetch;
(globalThis as { window?: unknown }).window = realWindow;
console.log('composerClient tests passed');
