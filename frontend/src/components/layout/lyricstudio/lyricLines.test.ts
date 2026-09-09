/**
 * `splitLyricLines` against the backend it mirrors.
 *
 * Every expectation below is the literal output of
 * `backend.modules.lyrics.schema.split_text` for the same input. If the two
 * ever disagree the LYRIC tab's gutter puts one line's rhyme letter beside
 * another line's words, so this is the test that keeps them honest.
 *
 * Run: `npx tsx src/components/layout/lyricstudio/lyricLines.test.ts`
 */
import assert from 'node:assert/strict';
import { estimateLineSyllables, splitLyricLines } from './lyricLines';

/** The backend has one kind for a blank line ('lyric' with empty text); the
 *  editor calls it 'blank' so the gutter can skip it. Fold it back to compare. */
const asBackend = (text: string): Array<{ kind: string; text: string }> =>
  splitLyricLines(text).map((l) => ({ kind: l.kind === 'blank' ? 'lyric' : l.kind, text: l.text }));

assert.deepEqual(asBackend(''), []);

assert.deepEqual(asBackend('\n\n\nalpha\n\n\n\nbeta\n\n'), [
  { kind: 'lyric', text: 'alpha' },
  { kind: 'lyric', text: '' },
  { kind: 'lyric', text: 'beta' },
]);

assert.deepEqual(asBackend('[Chorus]\nalpha beta\n\n\ngamma  \n(bridge)\nomega'), [
  { kind: 'marker', text: '[Chorus]' },
  { kind: 'lyric', text: 'alpha beta' },
  { kind: 'lyric', text: '' },
  { kind: 'lyric', text: 'gamma' },
  { kind: 'marker', text: '(bridge)' },
  { kind: 'lyric', text: 'omega' },
]);

// Leading whitespace is kept (the backend only rstrips); a tab-only line is blank.
assert.deepEqual(asBackend('  padded  \n\t\nnext'), [
  { kind: 'lyric', text: '  padded' },
  { kind: 'lyric', text: '' },
  { kind: 'lyric', text: 'next' },
]);

// A bracketed line longer than forty characters is not a marker.
assert.deepEqual(asBackend('[a very long marker that goes past forty characters for sure]\nline'), [
  { kind: 'lyric', text: '[a very long marker that goes past forty characters for sure]' },
  { kind: 'lyric', text: 'line' },
]);

// CRLF is normalised, and the physical row survives the blank-run collapse so
// the gutter can line the letters up with the textarea.
const rows = splitLyricLines('one\r\n\r\n\r\ntwo');
assert.deepEqual(
  rows.map((l) => [l.index, l.row, l.kind]),
  [
    [0, 0, 'lyric'],
    [1, 1, 'blank'],
    [2, 3, 'lyric'],
  ],
);

// The estimate is vowel runs, and it over-counts a word like "breathes" (two
// runs, one syllable). It is only ever shown as an estimate, in a dimmer ink,
// until the analyser's real count lands — this asserts the shape of the rule,
// not a claim that it is right.
assert.equal(estimateLineSyllables('the city breathes a silver light'), 9);
assert.equal(estimateLineSyllables(''), 0);
assert.equal(estimateLineSyllables('rhythm'), 1); // the y carries the run

console.log('lyricLines: ok');
