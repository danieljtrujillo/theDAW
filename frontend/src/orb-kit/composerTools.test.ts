/**
 * The assistant's composer and score tools, called the way the relay calls
 * them (handletheDAWAction), against a stubbed backend:
 *
 *   - the table, the browser's allowlist and the tiers name one set of tools,
 *     none behind a confirmation, each with a receipt sentence of its own;
 *   - composer_plan writes four parts into the roll and tells the model the
 *     chords; a bad enum is refused before any request; a 422 comes back as
 *     the backend's own sentence, with the roll untouched;
 *   - the counterpoint tools take their cantus or subject from a roll part by
 *     name, and refuse a part that is not there;
 *   - the reads (styles, profile, check, corpus search) answer with their
 *     numbers, and a score import checks its file name first.
 *
 * Run: `npx tsx src/orb-kit/composerTools.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

import { handletheDAWAction, handletheDAWActionResult } from './actionHandlers.ts';
import { theDAW_ACTION_TYPES } from './assistantEvents.ts';
import { composerTool, composerToolNames } from './composerTools.ts';
import { describeToolCall, getToolTier } from './tool-tiers.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { toPianoNote } from '../lib/composeToRoll.ts';

// ── one set of names ────────────────────────────────────────────────────────
const names = composerToolNames();
assert.deepEqual(names.sort(), [
  'composer_canon',
  'composer_check',
  'composer_form',
  'composer_fugue',
  'composer_plan',
  'composer_profile',
  'composer_species',
  'composer_styles',
  'notation_corpus_open',
  'notation_corpus_search',
  'notation_import',
]);
const allowed = [...theDAW_ACTION_TYPES].filter((n) => n.startsWith('composer_') || n.startsWith('notation_')).sort();
assert.deepEqual(allowed, names, 'the browser allows exactly the tools the table serves');
for (const n of names) {
  assert.notEqual(getToolTier(n), 'T2_confirm', `${n} has a tier of its own`);
  assert.ok(!describeToolCall(n, {}).startsWith('Execute tool'), `${n} has a receipt sentence`);
}
for (const n of ['composer_check', 'composer_styles', 'composer_profile', 'notation_corpus_search']) {
  assert.equal(getToolTier(n), 'T0_silent', `${n} changes nothing`);
}
for (const n of ['composer_plan', 'composer_form', 'composer_species', 'composer_canon', 'composer_fugue', 'notation_import', 'notation_corpus_open']) {
  assert.equal(getToolTier(n), 'T1_inform', `${n} writes, and shows a receipt`);
}
assert.equal(composerTool('toString'), undefined, 'only the table’s own names');
assert.equal(describeToolCall('composer_form', { realize: true, form: 'minuet_and_trio', movement: 1 }), 'Realize movement 1 of a minuet and trio into the piano roll (replaces its parts)');

// ── the backend ─────────────────────────────────────────────────────────────
(globalThis as { window?: unknown }).window = {
  location: { href: 'http://localhost:5173/', origin: 'http://localhost:5173', hash: '', pathname: '/', search: '' },
  localStorage: { getItem: () => null, setItem: () => undefined },
  history: { replaceState: () => undefined },
};
const sent: { url: string; body: unknown }[] = [];
let planStatus = 200;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const two = (n: number) => [
  { note: n, tick: 0, ticks: 3840 },
  { note: n + 2, tick: 3840, ticks: 3840 },
];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : String(input);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
  sent.push({ url, body });
  if (url === '/api/composer/plan') {
    if (planStatus !== 200) return json(planStatus, { detail: 'a German sixth needs a minor key or a mixture' });
    return json(200, {
      key: 'D minor',
      final_key: 'D minor',
      bars: 2,
      seed: 5,
      cadence: 'half',
      style: 'bach',
      harmonic_rhythm: 'bar',
      ppq: 960,
      meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
      chords: [
        { index: 0, bar: 0, beat: 1, tick: 0, ticks: 3840, accent: 1, figure: 'i', key: 'D minor', kind: 'triad', pivot: null, pitches: {}, names: {} },
        { index: 1, bar: 1, beat: 1, tick: 3840, ticks: 3840, accent: 1, figure: 'V', key: 'D minor', kind: 'triad', pivot: null, pitches: {}, names: {} },
      ],
      parts: { soprano: two(74), alto: two(69), tenor: two(62), bass: two(50) },
      flags: [],
    });
  }
  if (url === '/api/composer/styles') {
    return json(200, { styles: [{ id: 'bach', name: 'J. S. Bach', era: 'Baroque', source: 'extracted', basis: 'chorales', works: 40, orchestration: 'satb_choir', chords_per_pulse: 1 }] });
  }
  if (url === '/api/composer/species') {
    return json(200, {
      species: 2,
      position: 'below',
      key: 'D dorian',
      ppq: 960,
      bar_ticks: 3840,
      seed: 0,
      invertible: null,
      order: ['cantus', 'counterpoint'],
      parts: { cantus: two(62), counterpoint: two(50) },
      suspensions: [],
      rhythm: [],
      violations: [],
      flags: [],
    });
  }
  if (url === '/api/composer/check') return json(200, { count: 0, flags: [] });
  if (url === '/api/composer/styles/bach') {
    return json(200, {
      id: 'bach',
      name: 'J. S. Bach',
      era: 'Baroque',
      source: 'extracted',
      basis: 'chorales',
      works: [],
      sample: { works: 40, bars: 900 },
      modes: { major: 0.6, minor: 0.4 },
      vocabulary: { major: { I: 0.5, V: 0.5 }, minor: { i: 1 } },
      cadences: { authentic_perfect: 1, authentic_imperfect: 0, half: 0, plagal: 0, deceptive: 0, phrygian_half: 0 },
      cadence_other: 0,
      harmonic_rhythm: { chords_per_bar: 3, chords_per_pulse: 0.75 },
    });
  }
  if (url.startsWith('/api/notation/corpus?')) {
    return json(200, { query: 'bach', total: 2, results: [{ id: 'bach_bwv66_6_mxl', composer: 'bach', title: 'Chorale', movement: '', parts: 4, path: 'bach/bwv66.6.mxl' }] });
  }
  return json(404, { detail: `no route ${url}` });
}) as typeof fetch;

// ── composer_plan ───────────────────────────────────────────────────────────
usePianoRollStore.getState().importParts([{ name: 'Part 1', notes: [] }]);
const planned = await handletheDAWAction({ type: 'composer_plan', payload: { key: 'D', mode: 'minor', bars: 2, cadence: 'half', style: 'bach', seed: 5, include: ['german'] } });
assert.ok(planned.startsWith('Wrote Soprano, Alto, Tenor, Bass (8 notes) into the piano roll: 2 bars in D minor'), planned);
assert.ok(planned.includes('"figure":"V"'), 'the model is told the chords');
assert.deepEqual(sent.at(-1)?.body, {
  key: 'D',
  mode: 'minor',
  bars: 2,
  meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  seed: 5,
  cadence: 'half',
  include: ['german'],
  style: 'bach',
});
assert.deepEqual(rollTracksOf(usePianoRollStore.getState()).map((t) => t.name), ['Soprano', 'Alto', 'Tenor', 'Bass']);

// A bad enum never reaches the backend.
sent.length = 0;
const badMode = await handletheDAWActionResult({ type: 'composer_plan', payload: { mode: 'dorian' } });
assert.equal(badMode.ok, false);
assert.equal(badMode.message, 'composer_plan: mode is one of major, minor; got dorian');
assert.equal(sent.length, 0);

// A refusal is the backend's own sentence, and the roll is untouched.
planStatus = 422;
const before = rollTracksOf(usePianoRollStore.getState()).map((t) => t.notes.length);
const refused = await handletheDAWActionResult({ type: 'composer_plan', payload: { key: 'C', include: ['german'] } });
assert.deepEqual(refused, { ok: false, message: 'composer_plan: a German sixth needs a minor key or a mixture' });
assert.deepEqual(rollTracksOf(usePianoRollStore.getState()).map((t) => t.notes.length), before);
planStatus = 200;

// write: false plans without writing.
const notWritten = await handletheDAWAction({ type: 'composer_plan', payload: { write: false } });
assert.ok(notWritten.startsWith('Planned (not written)'), notWritten);
// With SATB parts in the roll, a plan asks in their ranges, as the COMPOSE panel's does.
assert.deepEqual((sent.at(-1)?.body as { ranges?: Record<string, number[]> }).ranges?.soprano, [60, 84]);

// ── counterpoint from a roll part ───────────────────────────────────────────
usePianoRollStore.getState().addTrack({
  name: 'Cantus line',
  notes: [62, 65, 64, 62].map((n, i) => toPianoNote({ note: n, tick: i * 3840, ticks: 3840 })),
});
const species = await handletheDAWAction({ type: 'composer_species', payload: { species: 2, position: 'below', cantus_part: 'cantus line', key: 'D', mode: 'dorian' } });
assert.ok(species.startsWith('Wrote species 2 below the cantus in D dorian into the piano roll as Cantus firmus and Counterpoint'), species);
// The roll store's species write: the cantus goes into a part named "Cantus firmus", which takes the mark.
assert.equal(rollTracksOf(usePianoRollStore.getState()).find((t) => t.name === 'Cantus firmus')?.cantusFirmus, true);
const speciesBody = sent.at(-1)?.body as Record<string, unknown>;
assert.deepEqual((speciesBody.cantus as { note: number }[]).map((n) => n.note), [62, 65, 64, 62], 'the named part is the cantus');
assert.equal(speciesBody.preset, undefined);
const missing = await handletheDAWActionResult({ type: 'composer_species', payload: { cantus_part: 'Oboe' } });
assert.equal(missing.ok, false);
assert.match(missing.message, /^composer_species: no roll part "Oboe"; the parts are /);
const both = await handletheDAWActionResult({ type: 'composer_species', payload: { cantus_part: 'Cantus line', preset: 'fux_dorian' } });
assert.equal(both.ok, false);
assert.match(both.message, /a preset or a cantus_part, not both/);
const badInterval = await handletheDAWActionResult({ type: 'composer_canon', payload: { interval: 0 } });
assert.equal(badInterval.ok, false);
assert.match(badInterval.message, /^composer_canon: interval is one of 1, 2, 3/);

// ── reads ───────────────────────────────────────────────────────────────────
const styles = await handletheDAWAction({ type: 'composer_styles' });
assert.ok(styles.includes('"source":"measured"'), styles);
const profile = await handletheDAWAction({ type: 'composer_profile', payload: { style: 'bach' } });
assert.ok(profile.startsWith('Style profile J. S. Bach: '), profile);
assert.ok(profile.includes('"harmonic_rhythm":"3.00 chords a bar, 0.75 a pulse"'), profile);
const noSource = await handletheDAWActionResult({ type: 'composer_profile', payload: {} });
assert.deepEqual(noSource, { ok: false, message: 'composer_profile: pick at least one corpus piece' });
const checked = await handletheDAWAction({ type: 'composer_check', payload: { key: 'D', mode: 'minor' } });
assert.ok(checked.startsWith('No voice-leading flags over the roll'), checked);
assert.equal((sent.at(-1)?.body as Record<string, unknown>).key, 'D');
const corpus = await handletheDAWAction({ type: 'notation_corpus_search', payload: { query: 'bach', limit: 5 } });
assert.ok(corpus.includes('bach_bwv66_6_mxl'), corpus);
assert.equal(sent.at(-1)?.url, '/api/notation/corpus?q=bach&limit=100');

// ── score import checks its file first ──────────────────────────────────────
const badName = await handletheDAWActionResult({ type: 'notation_import', payload: { filename: 'song.mid', content: 'x' } });
assert.deepEqual(badName, { ok: false, message: 'notation_import: filename must end in .musicxml, .xml, .krn, .abc' });
const noContent = await handletheDAWActionResult({ type: 'notation_import', payload: { filename: 'tune.abc', content: '  ' } });
assert.deepEqual(noContent, { ok: false, message: 'notation_import: content is the score file text' });
const noId = await handletheDAWActionResult({ type: 'notation_corpus_open', payload: {} });
assert.equal(noId.ok, false);

console.log('composerTools tests passed');
