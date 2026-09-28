import { useLayoutEffect, useRef, type JSX } from 'react';
import { computeCanvasBox, effectiveZoom } from '../../lib/canvasScale';
import { gridCanvasDpr } from '../../lib/timeline/gridCanvasBudget';
import { gridLines, type GridLevel, type GridLine } from '../../lib/timeline/gridLines';
import { editGridLines } from '../../lib/editTimeMap';
import type { MeterSegment } from '../../lib/meterMap';
import type { TempoEvent } from '../../lib/tempoMap';

/**
 * Tempo-aware bar / beat / subdivision grid drawn behind the timeline lanes.
 *
 * Coordinates: `startSec`/`endSec` are timeline seconds, `zoom` is local CSS px
 * per second, so the layer sits at `left = startSec * zoom` local px inside the
 * lanes content element (which must be positioned). The layer is absolutely
 * positioned, `pointer-events-none` and `aria-hidden`, so it never intercepts
 * pointer input or moves its siblings. Callers window [startSec, endSec] to the
 * visible range; `gridLines` refuses more than 5000 lines.
 *
 * Tempo: pass the same `bpm` (and bar length) the editor snap uses, so drawn
 * lines and snap positions agree. With `tempoMap` and `meterMap` (the EDIT
 * arrangement's), the grid follows both instead (lib/editTimeMap editGridLines):
 * every bar in its own meter, with its groups, at the tempo it plays at, the
 * same maps `editorStore.snapSec` snaps to.
 */
export interface TimelineGridLayerProps {
  startSec: number;
  endSec: number;
  zoom: number;
  bpm: number;
  beatsPerBar?: number;
  subdivisionsPerBeat?: number;
  /** The arrangement's tempo map; with `meterMap`, it replaces `bpm` / `beatsPerBar`. */
  tempoMap?: readonly TempoEvent[];
  /** The arrangement's meter map. */
  meterMap?: readonly MeterSegment[];
  /** Layer height in local CSS px. */
  heightPx: number;
  /**
   * Any value that changes when the edit theme changes (the theme id). The line
   * colour is read from `--et-line` at draw time and the layer only redraws on
   * prop change, so this is what makes a theme switch recolour the grid.
   */
  themeKey?: string;
  style: {
    visible: boolean;
    /** Line alpha per tier, 0..1. */
    barOpacity: number;
    beatOpacity: number;
    subdivOpacity: number;
    /** Bar line width in local CSS px; beat and sub lines are 1 px. */
    barWidthPx: 1 | 2;
  };
}

const FALLBACK_RGB = '255 255 255';

/** The edit theme's `--et-line` triplet ("r g b") as numbers, or the fallback. */
function readLineRgb(el: Element | null): [number, number, number] {
  const parse = (raw: string): [number, number, number] | null => {
    const parts = raw.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2]];
  };
  const fallback = parse(FALLBACK_RGB) as [number, number, number];
  if (!el || typeof window === 'undefined') return fallback;
  return parse(window.getComputedStyle(el).getPropertyValue('--et-line')) ?? fallback;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function TimelineGridLayer(p: TimelineGridLayerProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { startSec, endSec, zoom, bpm, beatsPerBar = 4, subdivisionsPerBeat = 4, heightPx, themeKey, tempoMap, meterMap } = p;
  const { visible, barOpacity, beatOpacity, subdivOpacity, barWidthPx } = p.style;

  const widthPx = Math.max(0, (endSec - startSec) * zoom);
  const leftPx = startSec * zoom;

  // Draw once per input change; nothing here runs per frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const layoutZoom = effectiveZoom(canvas);
    const rawDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    // Cap the backing store: this is the largest canvas in the app (full lanes
    // height x ~3 viewports wide), and lanes height grows with track count.
    const maxDpr = gridCanvasDpr({ cssWidth: widthPx, cssHeight: heightPx, layoutZoom, dpr: rawDpr });
    const box = computeCanvasBox(0, 0, layoutZoom, rawDpr, { cssWidth: widthPx, cssHeight: heightPx, maxDpr });
    if (canvas.width !== box.deviceWidth) canvas.width = box.deviceWidth;
    if (canvas.height !== box.deviceHeight) canvas.height = box.deviceHeight;
    // Draw in device pixels so every line lands on a whole or half pixel.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let lines: GridLine[];
    try {
      lines = tempoMap && meterMap
        ? editGridLines({ startSec, endSec, zoom, tempoMap, meterMap })
        : gridLines({ startSec, endSec, bpm, beatsPerBar, subdivisionsPerBeat, zoom });
    } catch (err) {
      // Bad input or an unwindowed range: draw nothing rather than take the
      // editor down with it.
      console.warn('TimelineGridLayer: grid skipped', err);
      return;
    }

    const [r, g, b] = readLineRgb(canvas.parentElement);
    const tiers: { level: GridLevel; alpha: number; cssWidth: number }[] = [
      { level: 'sub', alpha: clamp01(subdivOpacity), cssWidth: 1 },
      { level: 'beat', alpha: clamp01(beatOpacity), cssWidth: 1 },
      { level: 'bar', alpha: clamp01(barOpacity), cssWidth: barWidthPx },
    ];
    const deviceH = canvas.height;
    for (const tier of tiers) {
      if (tier.alpha <= 0) continue;
      const lw = Math.max(1, Math.round(tier.cssWidth * box.scale));
      // An odd width centred on a whole pixel would straddle two pixels and
      // blur; shifting by half a pixel keeps it crisp.
      const offset = lw % 2 === 1 ? 0.5 : 0;
      ctx.beginPath();
      for (const line of lines) {
        if (line.level !== tier.level) continue;
        const x = Math.round((line.sec - startSec) * zoom * box.scale) + offset;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, deviceH);
      }
      ctx.lineWidth = lw;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${tier.alpha})`;
      ctx.stroke();
    }
  }, [visible, startSec, endSec, zoom, bpm, beatsPerBar, subdivisionsPerBeat, tempoMap, meterMap, heightPx, widthPx, barOpacity, beatOpacity, subdivOpacity, barWidthPx, themeKey]);

  if (!visible) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute top-0"
      style={{ left: leftPx, width: widthPx, height: heightPx }}
    />
  );
}
