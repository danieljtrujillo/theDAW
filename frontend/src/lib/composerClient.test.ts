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

// ── capabilities is a GET ───────────────────────────────────────────────────
serve(200, { module: 'composer', ppq: 960 });
assert.equal((await composerApi.capabilities()).ppq, 960);
assert.equal(sent[0].url, '/api/composer/');
assert.equal(sent[0].method, 'GET');

// ── a 422 throws the route's own message ────────────────────────────────────
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
