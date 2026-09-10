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
import {
  draftWordRanges,
  estimateLineSyllables,
  rangeForWord,
  splitLyricLines,
  wordKeysInRange,
} from './lyricLines';
import { splitText } from '../sing/singSync';

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

// --- the tie between the caret and the sheet -----------------------------
//
// A word ordinal here has to be the SAME ordinal `splitText` gives it, or
// selecting a word while writing lights a different word on the sheet.

const DRAFT = '[Chorus]\n  hold the line\n\n\nand let it   go now\n';
const ranges = draftWordRanges(DRAFT);

// Only lyric lines carry words; the marker line is not one of them.
assert.deepEqual(
  ranges.map((r) => [r.index, r.word, DRAFT.slice(r.start, r.end)]),
  [
    [1, 0, 'hold'],
    [1, 1, 'the'],
    [1, 2, 'line'],
    [3, 0, 'and'],
    [3, 1, 'let'],
    [3, 2, 'it'],
    [3, 3, 'go'],
    [3, 4, 'now'],
  ],
);

// Every ordinal agrees with the tokenisation the analysis was anchored to.
const analysed = splitText(DRAFT);
for (const range of ranges) {
  assert.equal(
    analysed[range.index].words[range.word].text,
    DRAFT.slice(range.start, range.end),
    `word ${range.index}:${range.word}`,
  );
}

// A selection covers every word it touches, even partly.
const at = (needle: string): number => DRAFT.indexOf(needle);
assert.deepEqual(
  [...wordKeysInRange(ranges, at('the'), at('line') + 2)].sort(),
  ['1:1', '1:2'],
);

// A collapsed caret inside a word still names that word, so a click lights
// something rather than nothing.
assert.deepEqual([...wordKeysInRange(ranges, at('hold') + 2, at('hold') + 2)], ['1:0']);

// And back the other way, for a word picked on the sheet.
assert.deepEqual(rangeForWord(ranges, 3, 4), [at('now'), at('now') + 3]);
assert.equal(rangeForWord(ranges, 3, 9), null);
assert.equal(rangeForWord(ranges, 0, 0), null); // the marker has no words

console.log('lyricLines: ok');
