import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { applyCanvasBox, measureCanvasBox, scaleContextToBox, type CanvasBox } from '../../../../lib/canvasScale';
import { chordIndexAt, kindColor, type ChordTrack } from '../../../../lib/chordTrack';
import { NOTE_HIGHLIGHT_COLOR, READING_POS } from '../scoreShared';

export interface LyricWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface ChordStripCanvasProps {
  track: ChordTrack;
  /** Timed words for the lower row (best effort; omitted = no lyric row). */
  lyrics?: LyricWord[];
  /** Horizontal scale of the strip. */
  pxPerSec: number;
  /** Song time to draw at when the canvas redraws itself (resize, prop change). */
  getTime: () => number;
  onSeek: (sec: number) => void;
  /** Fires when the sounding chord index changes between draws (-1 before the first). */
  onChordChange?: (index: number) => void;
  ariaLabel: string;
}

export interface ChordStripCanvasHandle {
  /** Draw the strip for song time `now` (seconds). Called once per frame by the parent. */
  draw: (now: number) => void;
}

/** Vertical layout, CSS px. */
const RULER_H = 18;
const ROW_GAP = 4;
const LYRIC_ROW_H = 26;
const BLOCK_GAP_PX = 1;
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const BG = '#0a080f';
const RULER_INK = 'rgba(228, 228, 231, 0.55)'; // zinc-200
const BAR_INK = 'rgba(228, 228, 231, 0.9)';
const GRID_INK = 'rgba(255, 255, 255, 0.06)';
const SYMBOL_INK = '#0a080f';
const LYRIC_INK = '#e4e4e7';
const LYRIC_PAST_INK = 'rgba(228, 228, 231, 0.45)';

/** First index i with arr[i] >= value (arr ascending). */
function lowerBound(arr: readonly number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mark which beats are downbeats (by time, 2 ms tolerance) and number the bars. */
function downbeatNumbers(beats: readonly number[], downbeats: readonly number[]): Int32Array {
  const bars = new Int32Array(beats.length).fill(0);
  let bar = 1;
  for (const d of downbeats) {
    const i = lowerBound(beats, d - 0.002);
    if (i < beats.length && Math.abs(beats[i] - d) <= 0.002) bars[i] = bar;
    bar += 1;
  }
  return bars;
}

/**
 * The CHORDS play-along strip: a 2D canvas that scrolls the chord track under
 * a fixed now-line at READING_POS of the pane width. Everything drawn is a
 * pure function of the song time handed to draw(), so the parent drives it
 * from the play-along clock (rAF while playing, store subscription while
 * paused) and nothing here keeps its own timer.
 *
 * Rows, top to bottom: beat ruler (downbeats taller, bar numbers), chord
 * blocks coloured by kind with opacity following the builder's confidence,
 * and an optional lyric row. Clicking seeks to the time under the pointer.
 */
export const ChordStripCanvas = forwardRef<ChordStripCanvasHandle, ChordStripCanvasProps>(
  ({ track, lyrics, pxPerSec, getTime, onSeek, onChordChange, ariaLabel }, ref) => {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const boxRef = useRef<CanvasBox | null>(null);
    const lastNowRef = useRef(0);
    const lastChordRef = useRef<number | null>(null);
    const [liveSymbol, setLiveSymbol] = useState('');

    const onChordChangeRef = useRef(onChordChange);
    onChordChangeRef.current = onChordChange;
    const getTimeRef = useRef(getTime);
    getTimeRef.current = getTime;
    const onSeekRef = useRef(onSeek);
    onSeekRef.current = onSeek;

    const beats = track.timing.beats;
    const barNumbers = useMemo(() => downbeatNumbers(beats, track.timing.downbeats), [beats, track.timing.downbeats]);
    const lyricStarts = useMemo(() => (lyrics ?? []).map((w) => w.startSec), [lyrics]);
    const scale = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : 60;

    const measure = useCallback((): CanvasBox | null => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return null;
      const box = measureCanvasBox(wrap, { maxDpr: 2 });
      applyCanvasBox(canvas, box);
      boxRef.current = box;
      return box;
    }, []);

    const draw = useCallback(
      (now: number): void => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const box = boxRef.current ?? measure();
        if (!box) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const t = Number.isFinite(now) ? Math.max(0, now) : 0;
        lastNowRef.current = t;

        const W = box.cssWidth;
        const H = box.cssHeight;
        scaleContextToBox(ctx, box);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);

        const x0 = W * READING_POS;
        const xOf = (sec: number): number => x0 + (sec - t) * scale;
        const t0 = t - x0 / scale;
        const t1 = t + (W - x0) / scale;

        const hasLyrics = !!lyrics && lyrics.length > 0;
        const chordTop = RULER_H + ROW_GAP;
        const chordBottom = hasLyrics ? H - LYRIC_ROW_H - ROW_GAP : H - ROW_GAP;
        const chordH = Math.max(8, chordBottom - chordTop);

        // Beat ruler: ticks for every beat in the window, downbeats taller with
        // a bar number; a faint grid line runs down the chord row on downbeats.
        ctx.font = `9px ${FONT_MONO}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        for (let i = lowerBound(beats, t0); i < beats.length && beats[i] <= t1; i += 1) {
          const x = Math.round(xOf(beats[i])) + 0.5;
          const bar = barNumbers[i];
          const isDown = bar > 0;
          ctx.strokeStyle = isDown ? BAR_INK : RULER_INK;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, isDown ? RULER_H - 12 : RULER_H - 6);
          ctx.lineTo(x, RULER_H);
          ctx.stroke();
          if (isDown) {
            ctx.fillStyle = BAR_INK;
            ctx.fillText(String(bar), x + 3, 1);
            ctx.strokeStyle = GRID_INK;
            ctx.beginPath();
            ctx.moveTo(x, chordTop);
            ctx.lineTo(x, chordBottom);
            ctx.stroke();
          }
        }
        // Ruler baseline.
        ctx.strokeStyle = GRID_INK;
        ctx.beginPath();
        ctx.moveTo(0, RULER_H + 0.5);
        ctx.lineTo(W, RULER_H + 0.5);
        ctx.stroke();

        // Chord blocks intersecting the window.
        const chords = track.chords;
        const currentIndex = chordIndexAt(track, t);
        let i = chordIndexAt(track, t0);
        if (i < 0) i = 0;
        ctx.font = `bold 13px ${FONT_MONO}`;
        ctx.textBaseline = 'middle';
        for (; i < chords.length && chords[i].startSec < t1; i += 1) {
          const span = chords[i];
          if (span.endSec <= t0) continue;
          const xs = xOf(span.startSec);
          const xe = xOf(span.endSec);
          const w = Math.max(1, xe - xs - BLOCK_GAP_PX);
          const isCurrent = i === currentIndex;
          const confidence = Number.isFinite(span.confidence) ? Math.min(1, Math.max(0, span.confidence)) : 1;
          ctx.globalAlpha = 0.35 + 0.65 * confidence;
          ctx.fillStyle = kindColor(span.kind);
          ctx.fillRect(xs, chordTop, w, chordH);
          ctx.globalAlpha = 1;
          if (isCurrent) {
            ctx.strokeStyle = NOTE_HIGHLIGHT_COLOR;
            ctx.lineWidth = 2;
            ctx.strokeRect(xs + 1, chordTop + 1, w - 2, chordH - 2);
          }
          // Symbol, left-aligned, clipped to its block.
          if (w > 12) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(xs, chordTop, w, chordH);
            ctx.clip();
            ctx.fillStyle = SYMBOL_INK;
            ctx.textAlign = 'left';
            ctx.fillText(span.symbol, xs + 6, chordTop + chordH / 2);
            ctx.restore();
          }
        }

        // Lyric row: words in the window, past words dimmed.
        if (hasLyrics && lyrics) {
          const rowTop = H - LYRIC_ROW_H;
          ctx.strokeStyle = GRID_INK;
          ctx.beginPath();
          ctx.moveTo(0, rowTop - ROW_GAP / 2 + 0.5);
          ctx.lineTo(W, rowTop - ROW_GAP / 2 + 0.5);
          ctx.stroke();
          ctx.font = `11px ${FONT_MONO}`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          // Words are sorted by start; a word can start before the window and
          // still be visible, so back up a few entries from the lower bound.
          let wi = Math.max(0, lowerBound(lyricStarts, t0) - 3);
          let lastRight = -Infinity;
          for (; wi < lyrics.length && lyrics[wi].startSec < t1; wi += 1) {
            const word = lyrics[wi];
            if (word.endSec < t0) continue;
            const x = xOf(word.startSec);
            if (x < lastRight) continue; // no overlapping words
            ctx.fillStyle = word.endSec < t ? LYRIC_PAST_INK : LYRIC_INK;
            ctx.fillText(word.text, x + 2, rowTop + LYRIC_ROW_H / 2);
            lastRight = x + 2 + ctx.measureText(word.text).width + 6;
          }
        }

        // NOW line.
        ctx.strokeStyle = NOTE_HIGHLIGHT_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0), 0);
        ctx.lineTo(Math.round(x0), H);
        ctx.stroke();

        if (lastChordRef.current !== currentIndex) {
          lastChordRef.current = currentIndex;
          setLiveSymbol(currentIndex >= 0 ? chords[currentIndex].symbol : '');
          onChordChangeRef.current?.(currentIndex);
        }
      },
      [track, lyrics, lyricStarts, beats, barNumbers, scale, measure],
    );

    useImperativeHandle(ref, () => ({ draw }), [draw]);

    // Size to the wrapper and redraw whenever the pane resizes.
    useEffect(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      measure();
      draw(getTimeRef.current());
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => {
        measure();
        draw(getTimeRef.current());
      });
      ro.observe(wrap);
      return () => ro.disconnect();
    }, [measure, draw]);

    // A new track starts the chord-change tracking over.
    useEffect(() => {
      lastChordRef.current = null;
    }, [track]);

    const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const box = boxRef.current;
      if (!canvas || !box) return;
      const rect = canvas.getBoundingClientRect();
      // clientX is in viewport px; the box knows the cumulative CSS zoom.
      const x = (e.clientX - rect.left) / box.zoom;
      const x0 = box.cssWidth * READING_POS;
      const now = getTimeRef.current();
      const target = Math.max(0, now + (x - x0) / scale);
      onSeekRef.current(target);
      draw(target);
    };

    return (
      <div ref={wrapRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[#0a080f]">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={ariaLabel}
          className="absolute inset-0 w-full h-full cursor-pointer"
          onClick={onClick}
          title="Click to seek"
        />
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {liveSymbol ? `Chord ${liveSymbol}` : ''}
        </div>
      </div>
    );
  },
);

ChordStripCanvas.displayName = 'ChordStripCanvas';

export default ChordStripCanvas;
