/**
 * The DETAILS library pane's row model, under plain node.
 *
 * Pins: the sort orders the library offers and that sorting never mutates the
 * store's own array; the quick filter's every-term-must-match rule and the
 * fields it looks at; the row text a compact row draws (including the
 * fallbacks for a length-less or untitled entry); and the header readout's
 * "N of M" form once a filter is on.
 *
 * Run: `npx tsx src/lib/libraryRows.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import type { LibraryEntry } from '../state/libraryEntry';
import {
  filterLibraryEntries,
  formatRowDate,
  formatRowDuration,
  libraryCountLabel,
  libraryListRows,
  libraryRowText,
  matchesLibraryQuery,
  sortEntriesBy,
} from './libraryRows';

const entry = (over: Partial<LibraryEntry> & { id: string }): LibraryEntry => ({
  title: over.id,
  prompt: '',
  negativePrompt: '',
  model: 'small',
  duration: 0,
  steps: 0,
  cfg: 0,
  seed: 0,
  audioUrl: `/api/library/audio/${over.id}`,
  audioFilename: `${over.id}.wav`,
  fileSizeBytes: 0,
  mimeType: 'audio/wav',
  timestamp: '2026-01-01T00:00:00.000Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  lyrics: '',
  source: 'import',
  ...over,
});

const alpha = entry({
  id: 'a',
  title: 'Amen Break',
  timestamp: '2026-03-01T10:00:00.000Z',
  duration: 12.4,
  playCount: 3,
  tags: ['drums', 'jungle'],
});
const beta = entry({
  id: 'b',
  title: 'Cello Drone',
  timestamp: '2026-01-15T10:00:00.000Z',
  duration: 240,
  prompt: 'a slow bowed cello at 174 bpm',
  model: 'medium',
});
const gamma = entry({
  id: 'c',
  title: 'Bell Loop',
  timestamp: '2026-05-20T10:00:00.000Z',
  duration: 61,
  notes: 'from the jungle session',
});
const library: readonly LibraryEntry[] = [beta, alpha, gamma];

// ── sortEntriesBy ───────────────────────────────────────────────────────────
assert.deepEqual(sortEntriesBy(library, 'newest').map((e) => e.id), ['c', 'a', 'b'], 'newest first');
assert.deepEqual(sortEntriesBy(library, 'oldest').map((e) => e.id), ['b', 'a', 'c'], 'oldest first');
assert.deepEqual(sortEntriesBy(library, 'duration').map((e) => e.id), ['b', 'c', 'a'], 'longest first');
assert.deepEqual(sortEntriesBy(library, 'title').map((e) => e.id), ['a', 'c', 'b'], 'A→Z by title');
assert.deepEqual(sortEntriesBy(library, 'plays').map((e) => e.id), ['a', 'b', 'c'], 'most played first');

const source = [beta, alpha, gamma];
sortEntriesBy(source, 'title');
assert.deepEqual(source.map((e) => e.id), ['b', 'a', 'c'], 'the caller\'s array is untouched');

// ── matchesLibraryQuery ─────────────────────────────────────────────────────
assert.equal(matchesLibraryQuery(alpha, ''), true, 'an empty query matches everything');
assert.equal(matchesLibraryQuery(alpha, '   '), true, 'whitespace is an empty query');
assert.equal(matchesLibraryQuery(alpha, 'amen'), true, 'title');
assert.equal(matchesLibraryQuery(alpha, 'AMEN'), true, 'case-insensitive');
assert.equal(matchesLibraryQuery(alpha, 'jungle'), true, 'a tag');
assert.equal(matchesLibraryQuery(beta, '174'), true, 'the prompt');
assert.equal(matchesLibraryQuery(beta, 'medium'), true, 'the model');
assert.equal(matchesLibraryQuery(gamma, 'session'), true, 'the notes');
assert.equal(matchesLibraryQuery(alpha, 'amen drums'), true, 'both terms, different fields');
assert.equal(matchesLibraryQuery(alpha, 'amen cello'), false, 'every term has to match');
assert.equal(matchesLibraryQuery(alpha, 'cello'), false, "another entry's title does not match");

// ── filterLibraryEntries / libraryListRows ──────────────────────────────────
assert.deepEqual(filterLibraryEntries(library, '').map((e) => e.id), ['b', 'a', 'c'], 'no query -> the whole library, in order');
assert.notEqual(filterLibraryEntries(library, ''), library, 'and as a copy, never the store array itself');
assert.deepEqual(filterLibraryEntries(library, 'jungle').map((e) => e.id), ['a', 'c'], 'a tag and a note both hit');
assert.deepEqual(filterLibraryEntries(library, 'nothing-here'), [], 'no hits -> []');

assert.deepEqual(
  libraryListRows(library, 'title', '').map((e) => e.id),
  ['a', 'c', 'b'],
  'sorted, unfiltered',
);
assert.deepEqual(
  libraryListRows(library, 'newest', 'jungle').map((e) => e.id),
  ['c', 'a'],
  'sorted first, then filtered — the survivors keep the sort order',
);

// ── row text ────────────────────────────────────────────────────────────────
assert.equal(formatRowDuration(0), '--:--', 'no length -> --:--');
assert.equal(formatRowDuration(-3), '--:--', 'a negative length -> --:--');
assert.equal(formatRowDuration(Number.NaN), '--:--', 'NaN -> --:--');
assert.equal(formatRowDuration(9), '0:09', 'seconds are zero-padded');
assert.equal(formatRowDuration(61.4), '1:01');
assert.equal(formatRowDuration(3600), '60:00', 'an hour stays in minutes');

assert.equal(formatRowDate('not a date'), 'not a date', 'an unparsable stamp comes back as-is');
assert.equal(
  formatRowDate('2026-03-01T10:00:00.000Z'),
  new Date('2026-03-01T10:00:00.000Z').toLocaleDateString(),
  'a real stamp goes through toLocaleDateString',
);

const row = libraryRowText(alpha);
assert.equal(row.title, 'Amen Break');
assert.match(row.meta, /^small · 0:12 · /, 'model, length, then date');

assert.equal(
  libraryRowText(entry({ id: 'x', title: '   ', audioFilename: 'raw take.wav' })).title,
  'raw take.wav',
  'a blank title falls back to the filename',
);
assert.equal(
  libraryRowText(entry({ id: 'x', title: '', audioFilename: '' })).title,
  'untitled',
  '…and to "untitled" when there is nothing at all',
);
assert.equal(
  libraryRowText(entry({ id: 'x', model: '' })).meta.startsWith('--:--'),
  true,
  'an empty model leaves no dangling separator',
);

// ── header readout ──────────────────────────────────────────────────────────
assert.equal(libraryCountLabel(0, 0), '0 tracks');
assert.equal(libraryCountLabel(1, 1), '1 track', 'singular');
assert.equal(libraryCountLabel(42, 42), '42 tracks');
assert.equal(libraryCountLabel(42, 3), '3 of 42 tracks', 'a filter shows both numbers');

console.log('libraryRows tests passed');
