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
