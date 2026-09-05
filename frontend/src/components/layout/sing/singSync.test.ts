import assert from 'node:assert/strict';

import type { LyricLine, LyricsDoc } from '../../../lib/lyricsClient.ts';
import {
  assignTap,
  buildIndex,
  findActiveLine,
  findActiveWord,
  formatChip,
  LineScore,
  nextUntimedLine,
  nudgeLine,
  scoreFrame,
  splitText,
  TAP_LEAD_MS,
  unstamp,
  wordDocIndex,
  wordProgress,
} from './singSync.ts';

// Keep this text identical to FIXTURE_TXT in tests/test_lyrics_lrc.py.
const FIXTURE_TXT = "First line here\nSecond line later\n\n[Chorus]\n(bridge)\nDon't stop now\n";

const line = (text: string, start: number | null, end: number | null, wordTimes?: Array<[number, number]>): LyricLine => {
  const kind = /^\s*[[(][^\])]{1,40}[\])]\s*$/.test(text) ? 'marker' : 'lyric';
  const words = kind === 'lyric'
    ? text.split(/\s+/).filter(Boolean).map((t, i) => ({
        text: t,
        start_ms: wordTimes ? wordTimes[i][0] : null,
        end_ms: wordTimes ? wordTimes[i][1] : null,
      }))
    : [];
  return { text, kind, start_ms: start, end_ms: end, confidence: null, words };
};

const doc = (lines: LyricLine[]): LyricsDoc => ({
  version: 1,
  entry_id: 'e',
  timing_unit: 'ms_project_relative',
  language: 'en',
  source: 'manual',
  text: lines.map((l) => l.text).join('\n'),
  offset_ms: 0,
  lines,
  stats: null,
  updated_at: 0,
});

// ---- index + lookups ---------------------------------------------------------

const six = doc([
  line('[Verse]', null, null),
  line('one two three', 1000, 3000, [[1000, 1600], [1600, 2300], [2300, 3000]]),
  line('four five', 3000, 5000, [[3000, 4000], [4000, 5000]]),
  line('untimed line', null, null),
  line('[Chorus]', null, null),
  line('six seven eight', 6000, 9000),
]);
const idx = buildIndex(six);
assert.deepEqual(Array.from(idx.lineIdx), [1, 2, 5], 'index holds timed lyric lines only');
assert.equal(idx.words[1]?.starts.length, 3);
assert.equal(idx.words[5], null, 'a line whose words are untimed has no word index');
assert.equal(findActiveLine(idx, 0), -1, 'before the first line');
assert.equal(findActiveLine(idx, 1000), 1, 'exactly on a start');
assert.equal(findActiveLine(idx, 4500), 2, 'between lines');
assert.equal(findActiveLine(idx, 99_999), 5, 'after the last');
assert.equal(findActiveWord(idx, 1, 500), -1, 'before the first word');
assert.equal(findActiveWord(idx, 1, 1700), 1);
assert.equal(wordDocIndex(idx, 1, 1), 1);
assert.equal(findActiveWord(idx, 5, 7000), -1, 'no word timings');
assert.equal(wordProgress(idx, 1, 1, 1600), 0);
assert.ok(Math.abs(wordProgress(idx, 1, 1, 1950) - 0.5) < 1e-9);
assert.equal(wordProgress(idx, 1, 1, 9999), 1, 'clamped');
assert.equal(wordProgress(idx, 1, 1, 0), 0, 'clamped low');

// ---- tap / unstamp / nudge -----------------------------------------------------

assert.equal(nextUntimedLine(six), 3, 'first untimed lyric line (markers skipped)');
assert.equal(nextUntimedLine(six, 3), -1);

const tapped = assignTap(six, 3, 5580);
assert.equal(six.lines[3].start_ms, null, 'assignTap is immutable');
assert.equal(tapped.lines[3].start_ms, 5580 - TAP_LEAD_MS);
assert.equal(tapped.lines[3].end_ms, 6000, 'ends where the next timed line starts');
assert.equal(tapped.lines[2].end_ms, 5500, 'previous timed line now ends at the tap');
const w = tapped.lines[3].words;
assert.equal(w[0].start_ms, 5500);
assert.equal(w[w.length - 1].end_ms, 6000);
assert.ok((w[0].end_ms as number) <= (w[1].start_ms as number), 'words spread in order');

// Out-of-order tap: stamping line 1 AFTER line 2's stamp supersedes line 2.
const outOfOrder = assignTap(six, 1, 4000 + TAP_LEAD_MS);
assert.equal(outOfOrder.lines[1].start_ms, 4000);
assert.equal(outOfOrder.lines[2].start_ms, null, 'the conflicting later stamp is dropped');
assert.equal(outOfOrder.lines[1].end_ms, 6000, 'the line now reaches the next surviving stamp');
// And the mirror case: re-stamping line 2 earlier than line 1 pulls line 1 back.
const pulled = assignTap(six, 2, 500 + TAP_LEAD_MS);
assert.equal(pulled.lines[2].start_ms, 500);
assert.equal(pulled.lines[1].start_ms, 500, 'the earlier line is pulled back to the tap');
const starts = outOfOrder.lines.filter((l) => l.start_ms !== null).map((l) => l.start_ms as number);
assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'monotonic after an out-of-order tap');

const cleared = unstamp(tapped, 3);
assert.equal(cleared.lines[3].start_ms, null);
assert.ok(cleared.lines[3].words.every((x) => x.start_ms === null && x.end_ms === null));

const nudged = nudgeLine(six, 2, -50);
assert.equal(nudged.lines[2].start_ms, 2950);
assert.equal(nudged.lines[2].words[0].start_ms, 2950);
assert.equal(nudged.lines[1].end_ms, 2950, 'previous line ends where the nudged one starts');
const clampedLow = nudgeLine(six, 1, -5000);
assert.equal(clampedLow.lines[1].start_ms, 0, 'clamped at zero');
const clampedHigh = nudgeLine(six, 2, 50_000);
assert.ok((clampedHigh.lines[2].start_ms as number) < 6000, 'cannot pass the next timed line');
assert.ok((clampedHigh.lines[2].start_ms as number) > 3000);
const untouched = nudgeLine(six, 3, 100);
assert.equal(untouched.lines[3].start_ms, null, 'an untimed line does not nudge');

// ---- splitText ------------------------------------------------------------------

const split = splitText(FIXTURE_TXT);
assert.deepEqual(
  split.map((l) => l.text),
  ['First line here', 'Second line later', '', '[Chorus]', '(bridge)', "Don't stop now"],
);
assert.deepEqual(split.map((l) => l.kind), ['lyric', 'lyric', 'lyric', 'marker', 'marker', 'lyric']);
assert.deepEqual(split[5].words.map((x) => x.text), ["Don't", 'stop', 'now']);
assert.deepEqual(splitText('\n\n\na\n\n\n\nb\n\n').map((l) => l.text), ['a', '', 'b'], 'blank runs collapse');

// ---- scoring ----------------------------------------------------------------------

assert.equal(scoreFrame(72, 60).hit, true, 'octave folded');
assert.equal(scoreFrame(60.4, 60).hit, true);
assert.equal(scoreFrame(60.6, 60).hit, false, 'outside +-50 cents');
assert.equal(scoreFrame(59.5, 60).cents, -50);
assert.equal(Math.abs(scoreFrame(66, 60).cents), 600, 'a tritone folds to six semitones either way');
const score = new LineScore();
score.add(1, true);
score.add(1, true);
score.add(1, false);
score.add(2, true);
assert.deepEqual(score.line(1), { hits: 2, frames: 3, pct: (200 / 3) });
assert.equal(score.total().hits, 3);
assert.equal(score.total().frames, 4);
assert.equal(score.streak, 1);
score.reset();
assert.equal(score.total().frames, 0);

// ---- chips --------------------------------------------------------------------------

assert.equal(formatChip(62345), '1:02.3');
assert.equal(formatChip(0), '0:00.0');

// ---- stress: 763 lines / ~8000 words, 10k lookups < 50 ms ---------------------------

const bigLines: LyricLine[] = [];
let t = 0;
for (let i = 0; i < 763; i += 1) {
  const n = 10 + (i % 3);
  const words: Array<[number, number]> = [];
  for (let j = 0; j < n; j += 1) {
    words.push([t, t + 250]);
    t += 260;
  }
  bigLines.push(line(Array.from({ length: n }, (_, j) => `w${j}`).join(' '), words[0][0], t, words));
}
const big = doc(bigLines);
const bigIdx = buildIndex(big);
const t0 = performance.now();
let acc = 0;
for (let i = 0; i < 10_000; i += 1) {
  const pos = (i * 7919) % t;
  const li = findActiveLine(bigIdx, pos);
  acc += findActiveWord(bigIdx, li, pos);
}
const elapsed = performance.now() - t0;
assert.ok(acc !== 0);
assert.ok(elapsed < 50, `10k lookups took ${elapsed.toFixed(1)} ms`);

console.log('singSync tests passed');
