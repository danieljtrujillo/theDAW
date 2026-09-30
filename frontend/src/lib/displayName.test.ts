/**
 * The display-name sanitizer, under plain node.
 *
 * Pins the narrowness that matters: a source id goes, and nothing else does.
 * Most names carry no id, and brackets are load-bearing in real titles
 * (`[Live]`, `(Remix)`), so a greedy strip would quietly rename half a library.
 *
 * The bracketed-short cases below are real filenames out of the user's Suno
 * library, not invented ones.
 *
 * Run: `npx tsx src/lib/displayName.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { findSourceIds, hasSourceId, stripSourceId } from './displayName';

const UUID = 'edb97fd2-6d1d-4e7f-b94c-36ccd464afc2';

// ── full uuid: the case this exists for ─────────────────────────────────────
assert.equal(stripSourceId(`UrZunzet [${UUID}]`), 'UrZunzet');
assert.equal(
  stripSourceId(`UrZunzet [${UUID}].mp3`),
  'UrZunzet.mp3',
  'the extension survives; only the id is removed',
);
assert.equal(
  stripSourceId(`UrZunzet [${UUID}] · vocals`),
  'UrZunzet · vocals',
  'a stem suffix survives',
);
assert.equal(stripSourceId(`UrZunzet (${UUID})`), 'UrZunzet', 'parens too');
assert.equal(stripSourceId(UUID.toUpperCase().replace(/^/, 'Song [') + ']'), 'Song');

// ── suno's SHORT id — real names from the library ───────────────────────────
assert.equal(
  stripSourceId('UrZunzet - Instrumental [8c80f0ed].mp3'),
  'UrZunzet - Instrumental.mp3',
  'the short id goes, the " - Instrumental" part stays',
);
assert.equal(stripSourceId('UrZunzet - Vocals [d666aa97].mp3'), 'UrZunzet - Vocals.mp3');
assert.equal(
  stripSourceId('UrZunzet (Cover) (Cover) [0b9f59a7].mp3'),
  'UrZunzet (Cover) (Cover).mp3',
  'the (Cover) markers are part of the title and survive',
);
assert.equal(
  stripSourceId('UrZunzet (Cover) (Remastered) [08f6ae86].mp3'),
  'UrZunzet (Cover) (Remastered).mp3',
);
assert.equal(
  stripSourceId('UrZunzet - [8c80f0ed].mp3'),
  'UrZunzet.mp3',
  'a separator left dangling by the removal is cleaned up',
);

// ── bare uuid, no brackets ──────────────────────────────────────────────────
assert.equal(stripSourceId(`UrZunzet - ${UUID}.mp3`), 'UrZunzet.mp3');
assert.equal(stripSourceId(`UrZunzet ${UUID}`), 'UrZunzet');

// ── names with no id are returned untouched ─────────────────────────────────
for (const name of [
  'UrZunzet',
  'UrZunzet.mp3',
  '02 - Test - Beta.wav',
  'RÜFÜS DU SOL - Lately (Adam Ten & Mita Gami Extended Remix).aiff',
  'untitled',
]) {
  assert.equal(stripSourceId(name), name, `unchanged: ${name}`);
}

// ── brackets that are part of the actual title survive ──────────────────────
assert.equal(stripSourceId('Track [Live]'), 'Track [Live]');
assert.equal(stripSourceId('Song (Remix)'), 'Song (Remix)');
assert.equal(stripSourceId('Demo [2026-09-14]'), 'Demo [2026-09-14]', 'a date is not an id');
assert.equal(stripSourceId('Take [abc123]'), 'Take [abc123]', 'six hex is too short to be an id');
assert.equal(
  stripSourceId('Track [deadbeef]'),
  'Track [deadbeef]',
  'eight hex letters with no digit reads as a word, not an id',
);
assert.equal(
  stripSourceId('Mix [0123456789ab]'),
  'Mix [0123456789ab]',
  'twelve hex is neither shape',
);

// ── the detector ────────────────────────────────────────────────────────────
assert.equal(hasSourceId('UrZunzet - Instrumental [8c80f0ed].mp3'), true);
assert.equal(hasSourceId('Track [Live]'), false);
assert.equal(hasSourceId(''), false);
assert.equal(hasSourceId(null), false);

assert.deepEqual(
  findSourceIds('UrZunzet - Instrumental [8c80f0ed].mp3').map((m) => [m.id, m.kind]),
  [['8c80f0ed', 'short']],
);
assert.deepEqual(
  findSourceIds(`UrZunzet [${UUID}]`).map((m) => [m.id, m.kind]),
  [[UUID, 'uuid']],
  'a bracketed uuid is reported once, not twice',
);
assert.deepEqual(findSourceIds('Track [Live]'), [], 'nothing to find');

// ── degenerate input never yields an empty label ────────────────────────────
assert.equal(stripSourceId(`[${UUID}]`), `[${UUID}]`, 'an id-only name keeps something to draw');
assert.equal(stripSourceId('[8c80f0ed]'), '[8c80f0ed]', 'the same for a short id');
assert.equal(stripSourceId(''), '');
assert.equal(stripSourceId(null), '');
assert.equal(stripSourceId(undefined), '');

console.log('displayName tests passed');
