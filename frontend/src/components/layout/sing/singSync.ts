/**
 * singSync.ts - the pure maths of the SING tab: a binary-searchable index
 * over a LyricsDoc, tap-timing edits, and the pitch scoring rules. No DOM,
 * no React, so it runs under `npx tsx` in singSync.test.ts.
 */
import type { LyricLine, LyricWord, LyricsDoc } from '../../../lib/lyricsClient';

/** Human reaction time subtracted from a tap so the stamp lands on the beat. */
export const TAP_LEAD_MS = 80;
/** Length of a tapped line when no later timed line bounds it. */
export const TAP_SPREAD_MS = 3000;
/** Pitch scoring tolerance, either side of the target. */
export const TOLERANCE_CENTS = 50;
/** YIN clarity below this is noise, not a sung pitch. */
export const MIN_CLARITY = 0.6;
/** A timed word or line is never shorter than this (server invariant). */
export const MIN_WORD_MS = 40;
/** "[Chorus]", "(bridge)": a section marker, never sung. */
export const MARKER_RE = /^\s*[[(][^\])]{1,40}[\])]\s*$/;

export interface LineWords {
  /** Timed words only, in start order. */
  starts: Float64Array;
  ends: Float64Array;
  /** The doc word index behind each timed slot. */
  wordIdx: Int32Array;
}

export interface LyricsIndex {
  /** Starts of the timed lyric lines, in start order. */
  lineStarts: Float64Array;
  /** The doc line index behind each timed slot. */
  lineIdx: Int32Array;
  lineEnds: Float64Array;
  /** Per DOC line index: its timed words, or null when none are timed. */
  words: Array<LineWords | null>;
}

const isTimedLyric = (line: LyricLine): boolean =>
  line.kind === 'lyric' && line.start_ms !== null && line.text.trim().length > 0;

export function buildIndex(doc: LyricsDoc): LyricsIndex {
  const timed = doc.lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => isTimedLyric(line))
    .sort((a, b) => (a.line.start_ms as number) - (b.line.start_ms as number) || a.i - b.i);
  const lineStarts = new Float64Array(timed.length);
  const lineEnds = new Float64Array(timed.length);
  const lineIdx = new Int32Array(timed.length);
  timed.forEach(({ line, i }, k) => {
    lineStarts[k] = line.start_ms as number;
    lineEnds[k] = line.end_ms ?? (line.start_ms as number) + TAP_SPREAD_MS;
    lineIdx[k] = i;
  });
  const words: Array<LineWords | null> = doc.lines.map((line) => {
    const slots = line.words
      .map((w, j) => ({ w, j }))
      .filter(({ w }) => w.start_ms !== null)
      .sort((a, b) => (a.w.start_ms as number) - (b.w.start_ms as number) || a.j - b.j);
    if (slots.length === 0) return null;
    const starts = new Float64Array(slots.length);
    const ends = new Float64Array(slots.length);
    const wordIdx = new Int32Array(slots.length);
    slots.forEach(({ w, j }, k) => {
      starts[k] = w.start_ms as number;
      ends[k] = w.end_ms ?? (k + 1 < slots.length ? (slots[k + 1].w.start_ms as number) : starts[k] + MIN_WORD_MS);
      wordIdx[k] = j;
    });
    return { starts, ends, wordIdx };
  });
  return { lineStarts, lineIdx, lineEnds, words };
}

/** Index of the last value <= pos, or -1. */
function lastAtOrBefore(arr: Float64Array, pos: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The DOC line index sounding at posMs (the last timed line that started),
 *  or -1 before the first one. */
export function findActiveLine(idx: LyricsIndex, posMs: number): number {
  const k = lastAtOrBefore(idx.lineStarts, posMs);
  return k < 0 ? -1 : idx.lineIdx[k];
}

/** The timed slot index (into LineWords) of the word sounding at posMs on a
 *  doc line, or -1 when the line has no word timings or posMs precedes them. */
export function findActiveWord(idx: LyricsIndex, lineIdx: number, posMs: number): number {
  const words = lineIdx >= 0 ? idx.words[lineIdx] : null;
  if (!words) return -1;
  return lastAtOrBefore(words.starts, posMs);
}

/** The DOC word index behind a timed slot. */
export function wordDocIndex(idx: LyricsIndex, lineIdx: number, slot: number): number {
  const words = idx.words[lineIdx];
  if (!words || slot < 0 || slot >= words.wordIdx.length) return -1;
  return words.wordIdx[slot];
}

/** 0..1 progress through a timed word slot at posMs. */
export function wordProgress(idx: LyricsIndex, lineIdx: number, slot: number, posMs: number): number {
  const words = idx.words[lineIdx];
  if (!words || slot < 0 || slot >= words.starts.length) return 0;
  const start = words.starts[slot];
  const end = Math.max(start + 1, words.ends[slot]);
  const p = (posMs - start) / (end - start);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** The next timed lyric line AFTER a doc line (in start order), or -1. */
export function nextTimedLine(idx: LyricsIndex, lineIdx: number): number {
  const k = Array.prototype.indexOf.call(idx.lineIdx, lineIdx);
  if (k < 0 || k + 1 >= idx.lineIdx.length) return -1;
  return idx.lineIdx[k + 1];
}

/** The first untimed lyric line after `afterLine`, or -1. */
export function nextUntimedLine(doc: LyricsDoc, afterLine = -1): number {
  for (let i = afterLine + 1; i < doc.lines.length; i += 1) {
    const line = doc.lines[i];
    if (line.kind === 'lyric' && line.text.trim() && line.start_ms === null) return i;
  }
  return -1;
}

const cloneDoc = (doc: LyricsDoc): LyricsDoc => ({
  ...doc,
  lines: doc.lines.map((line) => ({ ...line, words: line.words.map((w) => ({ ...w })) })),
});

/** Spread a line's words across [start, end] by character weight. */
function spreadWords(line: LyricLine, start: number, end: number): void {
  const weights = line.words.map((w) => w.text.length + 1);
  const total = Math.max(1, weights.reduce((a, b) => a + b, 0));
  const span = Math.max(0, end - start);
  let acc = 0;
  line.words.forEach((w, i) => {
    w.start_ms = Math.round(start + (span * acc) / total);
    acc += weights[i];
    w.end_ms = Math.round(start + (span * acc) / total);
  });
}

const prevTimedLine = (doc: LyricsDoc, before: number): number => {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (isTimedLyric(doc.lines[i])) return i;
  }
  return -1;
};

const nextTimedLineInDoc = (doc: LyricsDoc, after: number): number => {
  for (let i = after + 1; i < doc.lines.length; i += 1) {
    if (isTimedLyric(doc.lines[i])) return i;
  }
  return -1;
};

/** Stamp a line at a tap: start = tap - lead; end = the next timed line's
 *  start (or +TAP_SPREAD_MS); words spread by weight; the previous timed line
 *  ends here; an earlier line that had a later start is pulled back, and a
 *  later line that had an earlier start loses its stamp, so the document
 *  stays monotonic. */
export function assignTap(doc: LyricsDoc, lineIdx: number, tapMs: number): LyricsDoc {
  const next = cloneDoc(doc);
  const line = next.lines[lineIdx];
  if (!line || line.kind !== 'lyric') return next;
  const start = Math.max(0, Math.round(tapMs - TAP_LEAD_MS));
  // A later line stamped BEFORE this tap was stamped wrong (or is being
  // re-done): its stamp is superseded, so the document stays monotonic.
  for (let i = lineIdx + 1; i < next.lines.length; i += 1) {
    const l = next.lines[i];
    if (isTimedLyric(l) && (l.start_ms as number) < start + MIN_WORD_MS) {
      l.start_ms = null;
      l.end_ms = null;
      l.confidence = null;
      for (const w of l.words) {
        w.start_ms = null;
        w.end_ms = null;
      }
    }
  }
  const after = nextTimedLineInDoc(next, lineIdx);
  const afterStart = after >= 0 ? (next.lines[after].start_ms as number) : -1;
  const end = afterStart > start + MIN_WORD_MS ? afterStart : start + TAP_SPREAD_MS;
  line.start_ms = start;
  line.end_ms = end;
  spreadWords(line, start, end);
  if (line.words.length === 0 && line.text.trim()) {
    line.words = line.text.split(/\s+/).filter(Boolean).map((text) => ({ text, start_ms: null, end_ms: null }));
    spreadWords(line, start, end);
  }
  const prev = prevTimedLine(next, lineIdx);
  if (prev >= 0) {
    const p = next.lines[prev];
    p.end_ms = Math.max((p.start_ms as number) + MIN_WORD_MS, start);
    for (const w of p.words) {
      if (w.end_ms !== null && w.end_ms > p.end_ms) w.end_ms = p.end_ms;
      if (w.start_ms !== null && w.start_ms > p.end_ms) w.start_ms = Math.max(0, p.end_ms - MIN_WORD_MS);
    }
  }
  // Earlier lines stamped later than this one (an out-of-order tap) are
  // pulled back so starts never decrease in document order.
  for (let i = lineIdx - 1; i >= 0; i -= 1) {
    const l = next.lines[i];
    if (!isTimedLyric(l)) continue;
    if ((l.start_ms as number) <= start) break;
    const shift = start - (l.start_ms as number);
    nudgeInPlace(l, shift);
    l.end_ms = Math.max((l.start_ms as number) + MIN_WORD_MS, Math.min(l.end_ms ?? start, start));
  }
  return next;
}

function nudgeInPlace(line: LyricLine, deltaMs: number): void {
  if (line.start_ms !== null) line.start_ms = Math.max(0, line.start_ms + deltaMs);
  if (line.end_ms !== null) line.end_ms = Math.max(0, line.end_ms + deltaMs);
  for (const w of line.words) {
    if (w.start_ms !== null) w.start_ms = Math.max(0, w.start_ms + deltaMs);
    if (w.end_ms !== null) w.end_ms = Math.max(0, w.end_ms + deltaMs);
  }
}

/** Remove a line's timings (and its words'). */
export function unstamp(doc: LyricsDoc, lineIdx: number): LyricsDoc {
  const next = cloneDoc(doc);
  const line = next.lines[lineIdx];
  if (!line) return next;
  line.start_ms = null;
  line.end_ms = null;
  line.confidence = null;
  for (const w of line.words) {
    w.start_ms = null;
    w.end_ms = null;
  }
  return next;
}

/** Shift a timed line (and its words) by deltaMs, clamped at 0 and inside its
 *  timed neighbours so the document stays monotonic. */
export function nudgeLine(doc: LyricsDoc, lineIdx: number, deltaMs: number): LyricsDoc {
  const next = cloneDoc(doc);
  const line = next.lines[lineIdx];
  if (!line || line.start_ms === null) return next;
  let delta = Math.round(deltaMs);
  const prev = prevTimedLine(next, lineIdx);
  const after = nextTimedLineInDoc(next, lineIdx);
  const lo = prev >= 0 ? (next.lines[prev].start_ms as number) + MIN_WORD_MS : 0;
  const hi = after >= 0 ? (next.lines[after].start_ms as number) - MIN_WORD_MS : Number.POSITIVE_INFINITY;
  const target = Math.min(hi, Math.max(lo, line.start_ms + delta));
  delta = target - line.start_ms;
  if (delta === 0) return next;
  nudgeInPlace(line, delta);
  if (prev >= 0) {
    const p = next.lines[prev];
    if (p.end_ms !== null && p.end_ms > (line.start_ms as number)) p.end_ms = line.start_ms;
  }
  if (after >= 0 && line.end_ms !== null) {
    const a = next.lines[after];
    if (line.end_ms > (a.start_ms as number)) line.end_ms = a.start_ms as number;
  }
  return next;
}

/** Client twin of schema.split_text: blank runs collapse, leading and
 *  trailing blanks drop, markers are classified, lyric lines get words. */
export function splitText(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let blankRun = false;
  for (const raw of (text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.replace(/\s+$/, '');
    if (!t.trim()) {
      if (blankRun || out.length === 0) continue;
      blankRun = true;
      out.push({ text: '', kind: 'lyric', start_ms: null, end_ms: null, confidence: null, words: [] });
      continue;
    }
    blankRun = false;
    if (MARKER_RE.test(t)) {
      out.push({ text: t.trim(), kind: 'marker', start_ms: null, end_ms: null, confidence: null, words: [] });
    } else {
      const words: LyricWord[] = t.split(/\s+/).filter(Boolean).map((w) => ({ text: w, start_ms: null, end_ms: null }));
      out.push({ text: t, kind: 'lyric', start_ms: null, end_ms: null, confidence: null, words });
    }
  }
  while (out.length && !out[out.length - 1].text) out.pop();
  return out;
}

export const frequencyToCents = (hz: number, targetHz: number): number =>
  1200 * Math.log2(hz / targetHz);

/** Octave-folded pitch judgement: the nearest octave of the target counts. */
export function scoreFrame(midiFloat: number, targetMidi: number): { hit: boolean; cents: number } {
  const diff = midiFloat - targetMidi;
  const folded = ((((diff + 6) % 12) + 12) % 12) - 6; // (-6, 6]
  const cents = folded * 100;
  return { hit: Math.abs(cents) <= TOLERANCE_CENTS, cents };
}

export interface ScoreTally {
  hits: number;
  frames: number;
  pct: number;
}

/** Per-line and total hit counts, plus the current streak of hits. */
export class LineScore {
  private lines = new Map<number, { hits: number; frames: number }>();
  private hitsTotal = 0;
  private framesTotal = 0;
  streak = 0;

  add(lineIdx: number, hit: boolean): void {
    const rec = this.lines.get(lineIdx) ?? { hits: 0, frames: 0 };
    rec.frames += 1;
    this.framesTotal += 1;
    if (hit) {
      rec.hits += 1;
      this.hitsTotal += 1;
      this.streak += 1;
    } else {
      this.streak = 0;
    }
    this.lines.set(lineIdx, rec);
  }

  line(lineIdx: number): ScoreTally {
    const rec = this.lines.get(lineIdx) ?? { hits: 0, frames: 0 };
    return { hits: rec.hits, frames: rec.frames, pct: rec.frames ? (100 * rec.hits) / rec.frames : 0 };
  }

  total(): ScoreTally {
    return {
      hits: this.hitsTotal,
      frames: this.framesTotal,
      pct: this.framesTotal ? (100 * this.hitsTotal) / this.framesTotal : 0,
    };
  }

  reset(): void {
    this.lines.clear();
    this.hitsTotal = 0;
    this.framesTotal = 0;
    this.streak = 0;
  }
}

/** mm:ss.t for the time chips. */
export function formatChip(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}
