/**
 * The draft text as the analyser reads it, plus the row each line was typed on.
 *
 * The lines themselves come from `singSync.splitText`, the frontend's mirror of
 * `split_text` in backend/modules/lyrics/schema.py — one mirror, not two, so
 * the kinds and the texts here can never drift from the ones the analysis
 * anchored its findings to.
 *
 * What that mirror cannot say is WHERE a line was typed: it collapses a run of
 * blank lines into one and drops the leading and trailing ones, so logical line
 * 9 may be physical row 14. The editor is a textarea and draws its gutter
 * against physical rows, so that mapping is rebuilt here — the only rule
 * duplicated, and the reason the test in this folder checks the composed result
 * against the backend's own output.
 */
import { splitText } from '../sing/singSync';

export type LyricLineKind = 'lyric' | 'marker' | 'blank';

export interface LyricLineRow {
  /** Index in the analysed document — what a Device span's `line` means. */
  index: number;
  /** Physical row of the textarea this line was typed on. */
  row: number;
  kind: LyricLineKind;
  text: string;
}

/** The physical row each emitted line came from, in emission order. */
const rowsFor = (text: string): number[] => {
  const out: number[] = [];
  let blankRun = false;
  (text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, row) => {
      const t = raw.replace(/\s+$/, '');
      if (!t.trim()) {
        // A blank line only counts when it separates two written ones, and a
        // run of them counts once — exactly as split_text does it.
        if (blankRun || out.length === 0) return;
        blankRun = true;
        out.push(row);
        return;
      }
      blankRun = false;
      out.push(row);
    });
  return out;
};

/** The logical lines of a draft, in the analyser's own numbering. */
export function splitLyricLines(text: string): LyricLineRow[] {
  const rows = rowsFor(text);
  // Trailing blanks are dropped by splitText and not by rowsFor, and they are
  // dropped from the END, so index-for-index the two still line up.
  return splitText(text).map((line, index) => ({
    index,
    row: rows[index] ?? index,
    kind: line.kind === 'marker' ? 'marker' : line.text ? 'lyric' : 'blank',
    text: line.text,
  }));
}

const VOWEL_RUN = /[aeiouy]+/g;

/**
 * Syllables by the schoolbook rule: vowel runs, minus a silent final `e`, at
 * least one. It is an ESTIMATE and is labelled as one wherever it is shown —
 * the analysis counts syllables from real pronunciations (CMUdict, or letter
 * rules behind it) and always wins once it has landed. This exists so a line
 * typed half a second ago still has a number beside it.
 */
export function estimateSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const runs = w.match(VOWEL_RUN);
  let n = runs ? runs.length : 0;
  if (w.length > 2 && w.endsWith('e') && !w.endsWith('le') && !/[aeiouy]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

export const estimateLineSyllables = (text: string): number =>
  text.split(/\s+/).filter(Boolean).reduce((sum, w) => sum + estimateSyllables(w), 0);

// --- tying the caret to the sheet ------------------------------------------
//
// The analysis anchors every finding to (line, word) in the ANALYSED
// document's numbering. The textarea knows only character offsets into its own
// value. These two turn one into the other, in both directions, so selecting a
// word while writing can light it on the sheet and picking one on the sheet
// can put the caret back on it.

export interface DraftWordRange {
  /** Index in the analysed document — what a Device span's `line` means. */
  index: number;
  word: number;
  /** Offsets into the textarea's own value. */
  start: number;
  end: number;
}

const NON_SPACE = /\S+/g;

/**
 * Every word of the draft, with where it sits in the textarea's value.
 *
 * The word ordinals must match `splitText`'s exactly — a finding's `word` is
 * an index into `line.words` — so they are read the same way it reads them:
 * the runs of non-whitespace in the row, in order. A textarea's value always
 * uses "\n" whatever the platform, so an offset here is an offset there.
 */
export function draftWordRanges(text: string): DraftWordRange[] {
  const byRow = new Map<number, LyricLineRow>();
  for (const line of splitLyricLines(text)) byRow.set(line.row, line);
  const out: DraftWordRange[] = [];
  let offset = 0;
  for (const [row, raw] of (text || '').split('\n').entries()) {
    const line = byRow.get(row);
    if (line && line.kind === 'lyric') {
      NON_SPACE.lastIndex = 0;
      let word = 0;
      let match = NON_SPACE.exec(raw);
      while (match) {
        out.push({
          index: line.index,
          word,
          start: offset + match.index,
          end: offset + match.index + match[0].length,
        });
        word += 1;
        match = NON_SPACE.exec(raw);
      }
    }
    offset += raw.length + 1;
  }
  return out;
}

/** The words a textarea selection covers, as the sheet's own `line:word` keys.
 *
 *  A collapsed caret still names the word it is sitting in, so simply clicking
 *  in a line lights that word rather than nothing. */
export function wordKeysInRange(
  ranges: readonly DraftWordRange[],
  start: number,
  end: number,
): Set<string> {
  const keys = new Set<string>();
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  for (const range of ranges) {
    const touches = lo === hi ? range.start <= lo && lo <= range.end : range.start < hi && range.end > lo;
    if (touches) keys.add(`${range.index}:${range.word}`);
  }
  return keys;
}

/** Where one word of the analysed document sits in the draft, or null when the
 *  draft has moved on from the analysis that named it. */
export function rangeForWord(
  ranges: readonly DraftWordRange[],
  line: number,
  word: number,
): [number, number] | null {
  for (const range of ranges) {
    if (range.index === line && range.word === word) return [range.start, range.end];
  }
  return null;
}
