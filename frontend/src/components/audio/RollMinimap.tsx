import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rollTracksOf, usePianoRollStore } from '../../state/pianoRollStore';
import { barAt } from '../../lib/meterMap';
import { densityPoint, paintDensity, rollDensity } from '../../lib/rollDensity';
import { DEFAULT_ACCENT, NULL_PAINT, canvas2d, parseRgb } from '../../lib/rollCanvas';
import { applyCanvasBox, computeCanvasBox, effectiveZoom } from '../../lib/canvasScale';
import { FIELD_LEGEND, FIELD_VALUE } from './midiDockKit';
import { useThemeRepaint } from './RollNotesCanvas';

/** The strip's inner height (px): h-6 less its two 1px borders, until the strip is measured. */
const MAP_HEIGHT = 22;
/** The pitch rows the density map folds the grid into. */
const MAP_ROWS = 12;
/** Columns of the density grid per css px of strip width. */
const PX_PER_COL = 2;

/**
 * The roll's overview: every part's notes over the whole roll as a density
 * map (lib/rollDensity), with a box where the grid is looking. A click or a
 * drag centres the grid on that place, in time and in pitch. It is a slider for
 * the keyboard: its value is the bar at the view's left edge; the arrows move
 * the view a bar, Page Up and Page Down a screen, Home and End to the ends.
 */
export const RollMinimap: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  stepPx: number;
  noteHeight: number;
  headerPx: number;
}> = ({ scrollRef, stepPx, noteHeight, headerPx }) => {
  const notes = usePianoRollStore((s) => s.notes);
  const tracks = usePianoRollStore((s) => s.tracks);
  const activeTrackId = usePianoRollStore((s) => s.activeTrackId);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const parts = useMemo(() => rollTracksOf({ notes, tracks, activeTrackId }), [notes, tracks, activeTrackId]);
  const labelId = useId();
  const helpId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The strip's inner size (css px), measured; 0 until then.
  const [boxWidth, setBoxWidth] = useState(0);
  const [boxHeight, setBoxHeight] = useState(0);
  // Where the grid looks, as fractions of the whole grid: left, top, width, height.
  const [view, setView] = useState({ left: 0, top: 0, width: 1, height: 1 });

  const gridWidth = Math.max(1, totalSteps * stepPx);
  const gridHeight = Math.max(1, (highestNote - lowestNote + 1) * noteHeight);

  // The strip's width, and the grid's view as it scrolls, once per frame.
  useEffect(() => {
    const el = scrollRef.current;
    const box = boxRef.current;
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (box) {
        setBoxWidth((w) => (w === box.clientWidth ? w : box.clientWidth));
        setBoxHeight((h) => (h === box.clientHeight ? h : box.clientHeight));
      }
      if (!el) return;
      const win = typeof window === 'undefined' ? null : window;
      const cw = el.clientWidth || win?.innerWidth || 0;
      const ch = Math.max(0, (el.clientHeight || win?.innerHeight || 0) - headerPx);
      const next = {
        left: Math.min(1, el.scrollLeft / gridWidth),
        top: Math.min(1, el.scrollTop / gridHeight),
        width: Math.min(1, cw / gridWidth),
        height: Math.min(1, ch / gridHeight),
      };
      setView((v) => (v.left === next.left && v.top === next.top && v.width === next.width && v.height === next.height ? v : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el?.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (el) ro?.observe(el);
    if (box) ro?.observe(box);
    return () => {
      el?.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, gridWidth, gridHeight, headerPx]);

  // Until the strip is measured (and in a DOM with no layout) it draws as if 600px wide.
  const width = boxWidth || 600;
  const height = boxHeight || MAP_HEIGHT;
  const density = useMemo(
    () =>
      rollDensity(parts, {
        cols: Math.max(1, Math.round(width / PX_PER_COL)),
        rows: MAP_ROWS,
        totalSteps: Math.max(1, totalSteps),
        lowNote: lowestNote,
        highNote: highestNote,
      }),
    [parts, width, totalSteps, lowestNote, highestNote],
  );

  // A theme switch repaints the map in the new accent.
  const [themeTick, setThemeTick] = useState(0);
  const onTheme = useCallback(() => setThemeTick((t) => t + 1), []);
  useThemeRepaint(canvasRef, onTheme);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const win = typeof window === 'undefined' ? null : window;
    // The backing store covers the strip at the device pixel ratio times the shell's CSS zoom (lib/canvasScale).
    const box = computeCanvasBox(0, 0, effectiveZoom(canvas), Math.max(1, win?.devicePixelRatio || 1), {
      cssWidth: width,
      cssHeight: height,
    });
    applyCanvasBox(canvas, box);
    const accent = parseRgb(win ? win.getComputedStyle(canvas).getPropertyValue('--et-accent') : '', DEFAULT_ACCENT);
    const drawn = paintDensity(canvas2d(canvas) ?? NULL_PAINT, density, width, height, accent, box.scale);
    canvas.dataset.cells = String(drawn);
    canvas.dataset.scale = String(box.scale);
  }, [density, width, height, themeTick]);

  /** Centres the grid on a step and a pitch. */
  const jumpTo = useCallback(
    (step: number, pitch: number | null) => {
      const el = scrollRef.current;
      if (!el) return;
      const win = typeof window === 'undefined' ? null : window;
      const cw = el.clientWidth || win?.innerWidth || 0;
      const ch = Math.max(0, (el.clientHeight || win?.innerHeight || 0) - headerPx);
      el.scrollLeft = Math.max(0, Math.min(gridWidth - cw, step * stepPx - cw / 2));
      if (pitch !== null) el.scrollTop = Math.max(0, Math.min(gridHeight - ch, (highestNote - pitch) * noteHeight - ch / 2));
    },
    [scrollRef, headerPx, gridWidth, gridHeight, stepPx, highestNote, noteHeight],
  );

  const pressRef = useRef(false);
  const jumpAtPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = r.width || width;
    const p = densityPoint(e.clientX - r.left, e.clientY - r.top, w, r.height || height, {
      totalSteps: Math.max(1, totalSteps),
      lowNote: lowestNote,
      highNote: highestNote,
    });
    jumpTo(p.step, p.pitch);
  };

  // The slider's value: the bar at the view's left edge, of every bar in the roll.
  const leftStep = Math.max(0, Math.min(totalSteps - 1e-6, view.left * totalSteps));
  const rightStep = Math.max(0, Math.min(totalSteps - 1e-6, (view.left + view.width) * totalSteps));
  const barNo = (step: number) => {
    const b = barAt(meterMap, step, pickupSteps);
    return b.bar < 0 ? 0 : b.bar + 1;
  };
  const first = barNo(leftStep);
  const last = barNo(rightStep);
  const barCount = Math.max(1, barNo(Math.max(0, totalSteps - 1e-6)));
  const bars = first === last ? `Bar ${first}` : `Bars ${first}–${last}`;
  const text = `${bars} of ${barCount}`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = scrollRef.current;
    if (!el) return;
    const cw = el.clientWidth || (typeof window === 'undefined' ? 0 : window.innerWidth);
    // The view as it is now, not as the last frame measured it.
    const nowStep = Math.max(0, Math.min(totalSteps - 1e-6, el.scrollLeft / stepPx));
    const bar = barAt(meterMap, nowStep, pickupSteps);
    let left: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') left = (bar.start + bar.len) * stepPx;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      // Back to this bar's start, or to the bar before when the view already starts on it.
      const back = nowStep - bar.start < 1e-6 ? barAt(meterMap, Math.max(0, bar.start - 1e-6), pickupSteps).start : bar.start;
      left = Math.max(0, back) * stepPx;
    } else if (e.key === 'PageDown') left = el.scrollLeft + cw;
    else if (e.key === 'PageUp') left = el.scrollLeft - cw;
    else if (e.key === 'Home') left = 0;
    else if (e.key === 'End') left = gridWidth;
    if (left === null) return;
    // The strip keeps the key, so an arrow here never also nudges a note or a clip.
    e.preventDefault();
    e.stopPropagation();
    el.scrollLeft = Math.max(0, Math.min(gridWidth - cw, left));
  };

  return (
    <div className="shrink-0 h-8 flex items-center gap-2 px-2 border-b border-white/5 bg-[#0c0a12]" data-roll-minimap="">
      <span id={labelId} className={FIELD_LEGEND}>Overview</span>
      <span className={`${FIELD_VALUE} w-36 text-left`} aria-hidden="true">{text}</span>
      <div
        ref={boxRef}
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        aria-orientation="horizontal"
        aria-valuemin={Math.min(1, barCount)}
        aria-valuemax={barCount}
        aria-valuenow={Math.max(Math.min(1, barCount), first)}
        aria-valuetext={text}
        className="relative flex-1 min-w-0 h-6 rounded-xs bg-black/40 border border-white/8 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))]"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          pressRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          jumpAtPointer(e);
        }}
        onPointerMove={(e) => {
          if (pressRef.current) jumpAtPointer(e);
        }}
        onPointerUp={(e) => {
          pressRef.current = false;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={() => {
          pressRef.current = false;
        }}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} data-roll-density="" aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
        <div
          aria-hidden="true"
          data-roll-minimap-view=""
          className="absolute border border-[rgb(var(--et-ink)/0.85)] bg-[rgb(var(--et-ink)/0.08)] pointer-events-none"
          style={{
            left: `${view.left * 100}%`,
            top: `${view.top * 100}%`,
            width: `max(3px, ${view.width * 100}%)`,
            height: `max(3px, ${view.height * 100}%)`,
          }}
        />
      </div>
      <p id={helpId} className="sr-only">
        The whole roll, every part. Click or drag to move the grid there. The arrow keys move it a bar, Page Up and Page Down a
        screen, Home and End to the start and the end.
      </p>
    </div>
  );
};
