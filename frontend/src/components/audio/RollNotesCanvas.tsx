import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { applyCanvasBox, computeCanvasBox, effectiveZoom } from '../../lib/canvasScale';
import {
  DEFAULT_ACCENT,
  NULL_PAINT,
  canvas2d,
  paintRoll,
  parseRgb,
  type Paint2D,
  type RollPattern,
  type RollScene,
  type RollView,
  type Rgb,
} from '../../lib/rollCanvas';

/**
 * The roll's note layer (lib/rollCanvas) on a canvas the size of the grid's
 * view. It sits in a clipping box over the whole grid and moves with the
 * scroll, so its backing store never grows with the roll's length: a scroll
 * or a resize repaints the frame (once per animation frame), and a new scene
 * (notes, parts, selection, zoom) repaints at once.
 *
 * The backing store holds the view at the device pixel ratio times the shell's
 * CSS zoom (lib/canvasScale), so the notes are as sharp as the DOM around them
 * at every window size.
 *
 * What it drew is on the canvas as data attributes (`data-notes`,
 * `data-ghosts`, `data-repeats`, `data-selected`, and `data-scale`, the
 * device pixels per grid pixel), which the tests read.
 */
export interface RollNotesCanvasHandle {
  /** Repaint with a hovered note (brightened) or none. */
  setHover: (id: string | null) => void;
}

type SceneInput = Omit<RollScene, 'accent' | 'patterns' | 'hoverId'>;

/** A lane look's tile edge (grid px). */
const TILE = 6;

/**
 * A diagonal-stripe or hatch tile for a lane's look, in the accent. Null where
 * the page has no 2D canvas. The context draws in grid px, and a pattern is
 * laid from the origin of that space, so the stripes stay put under the notes
 * as the view scrolls.
 */
function makePattern(kind: RollPattern, accent: Rgb, host: Paint2D | null): CanvasPattern | null {
  if (typeof document === 'undefined' || !host || !('createPattern' in host)) return null;
  const tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const ctx = canvas2d(tile) as unknown as CanvasRenderingContext2D | null;
  if (!ctx || typeof ctx.moveTo !== 'function') return null;
  const [r, g, b] = accent;
  const line = (width: number, color: string, down: boolean) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let k = -TILE; k <= TILE * 2; k += TILE) {
      if (down) {
        ctx.moveTo(k, 0);
        ctx.lineTo(k + TILE, TILE);
      } else {
        ctx.moveTo(k, TILE);
        ctx.lineTo(k + TILE, 0);
      }
    }
    ctx.stroke();
  };
  if (kind === 'hatch45') {
    line(1, `rgba(${r},${g},${b},0.55)`, false);
  } else {
    ctx.fillStyle = `rgba(${r},${g},${b},0.16)`;
    ctx.fillRect(0, 0, TILE, TILE);
    line(2.2, `rgb(${r},${g},${b})`, kind === 'stripes135');
  }
  return (host as unknown as CanvasRenderingContext2D).createPattern(tile, 'repeat');
}

/**
 * Calls `repaint` when the theme around `ref` changes: the nearest
 * `.edit-theme-scope` (the Shell root, which carries the theme's colour
 * variables) or the document root changes its class, style or data attributes.
 * A canvas reads the accent when it paints, so a theme switch must repaint it.
 */
export function useThemeRepaint(ref: React.RefObject<Element | null>, repaint: () => void): void {
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const scope = ref.current?.closest('.edit-theme-scope') ?? null;
    const targets = [document.documentElement, ...(scope ? [scope] : [])];
    const mo = new MutationObserver(() => repaint());
    for (const t of targets) mo.observe(t, { attributes: true, attributeFilter: ['class', 'style', 'data-et-light', 'data-theme'] });
    return () => mo.disconnect();
  }, [ref, repaint]);
}

export const RollNotesCanvas = forwardRef<
  RollNotesCanvasHandle,
  {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    scene: SceneInput;
    /** The grid's full size (px). */
    width: number;
    height: number;
    /** The rows that stick to the top of the scroll box (the ruler), which cover the grid's top. */
    headerPx: number;
  }
>(function RollNotesCanvas({ scrollRef, scene, width, height, headerPx }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<string | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const sizeRef = useRef({ width, height, headerPx });
  sizeRef.current = { width, height, headerPx };
  const patternsRef = useRef<{ accent: string; patterns: Partial<Record<RollPattern, CanvasPattern>> } | null>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const el = scrollRef.current;
    if (!canvas) return;
    const { width: gw, height: gh, headerPx: hp } = sizeRef.current;
    const win = typeof window === 'undefined' ? null : window;
    // Until the grid is measured (and in a DOM with no layout) the view is the window's size.
    const clientW = el?.clientWidth || win?.innerWidth || 0;
    const clientH = (el?.clientHeight || win?.innerHeight || 0) - hp;
    const x = Math.max(0, Math.min(el?.scrollLeft ?? 0, Math.max(0, gw - 1)));
    const y = Math.max(0, Math.min(el?.scrollTop ?? 0, Math.max(0, gh - 1)));
    const view: RollView = {
      x,
      y,
      width: Math.max(0, Math.min(clientW, gw - x)),
      height: Math.max(0, Math.min(clientH, gh - y)),
    };
    // The view in grid px; the backing store in device px: grid px times the
    // device pixel ratio times the shell's CSS zoom.
    const box = computeCanvasBox(0, 0, effectiveZoom(canvas), Math.max(1, win?.devicePixelRatio || 1), {
      cssWidth: view.width,
      cssHeight: view.height,
    });
    applyCanvasBox(canvas, box);
    canvas.style.left = `${view.x}px`;
    canvas.style.top = `${view.y}px`;
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
    const real = canvas2d(canvas);
    const accentText = win ? win.getComputedStyle(canvas).getPropertyValue('--et-accent') : '';
    const accent = parseRgb(accentText, DEFAULT_ACCENT);
    const key = accent.join(',');
    if (!patternsRef.current || patternsRef.current.accent !== key) {
      const patterns: Partial<Record<RollPattern, CanvasPattern>> = {};
      for (const kind of ['stripes135', 'stripes45', 'hatch45'] as const) {
        const p = makePattern(kind, accent, real);
        if (p) patterns[kind] = p;
      }
      patternsRef.current = { accent: key, patterns };
    }
    const stats = paintRoll(
      real ?? NULL_PAINT,
      { ...sceneRef.current, accent, patterns: patternsRef.current.patterns, hoverId: hoverRef.current },
      view,
      box.scale,
    );
    canvas.dataset.notes = String(stats.notes);
    canvas.dataset.ghosts = String(stats.ghosts);
    canvas.dataset.repeats = String(stats.repeats);
    canvas.dataset.selected = String(stats.selected);
    canvas.dataset.scale = String(box.scale);
  }, [scrollRef]);

  useImperativeHandle(ref, () => ({
    setHover: (id) => {
      if (hoverRef.current === id) return;
      hoverRef.current = id;
      paint();
    },
  }), [paint]);

  useThemeRepaint(canvasRef, paint);

  // A new scene or grid size paints before the browser shows the frame.
  useLayoutEffect(() => {
    paint();
  }, [paint, scene, width, height, headerPx]);

  // Scrolls and resizes paint once per frame; a window resize changes the
  // shell's CSS zoom, which the backing store follows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          paint();
        });
      }
    };
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    // The scroll box takes its ref after this layer's layout effect ran on the
    // first mount, so paint once more now that its view can be read.
    paint();
    return () => {
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, paint]);

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none z-10">
      <canvas ref={canvasRef} data-roll-notes="" className="absolute" />
    </div>
  );
});
