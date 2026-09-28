/**
 * The roll's overview: how many notes sound in each cell of a coarse grid over
 * the whole roll (columns across its length, rows across its pitch range), for
 * every part at once. The minimap (components/audio/RollMinimap) draws it and
 * jumps the grid to the cell clicked.
 *
 * Each part's grid is kept per note list (a WeakMap), so an edit in one part
 * recounts that part only and the overview is the sum of the cached grids.
 */
import type { PianoNote } from '../state/pianoRollStore';
import type { Paint2D, Rgb } from './rollCanvas';
import { rgba } from './rollCanvas';

export interface DensityShape {
  cols: number;
  rows: number;
  totalSteps: number;
  lowNote: number;
  highNote: number;
}

export interface Density extends DensityShape {
  /** Row-major counts: cells[row * cols + col], row 0 at the top (the highest pitches). */
  cells: Float32Array;
  max: number;
}

const shapeKey = (s: DensityShape): string => `${s.cols}|${s.rows}|${s.totalSteps}|${s.lowNote}|${s.highNote}`;
const partCache = new WeakMap<readonly PianoNote[], { key: string; cells: Float32Array }>();

/** The row a pitch falls in, row 0 at the top. */
export const densityRow = (pitch: number, s: Pick<DensityShape, 'rows' | 'lowNote' | 'highNote'>): number => {
  const span = Math.max(1, s.highNote - s.lowNote + 1);
  const r = Math.floor(((s.highNote - pitch) / span) * s.rows);
  return Math.max(0, Math.min(s.rows - 1, r));
};

/** One note list's counts: each note adds one to every column it sounds in, in its pitch's row. */
function partCells(notes: readonly PianoNote[], s: DensityShape): Float32Array {
  const key = shapeKey(s);
  const hit = partCache.get(notes);
  if (hit && hit.key === key) return hit.cells;
  const cells = new Float32Array(s.cols * s.rows);
  const perCol = s.cols / Math.max(1, s.totalSteps);
  for (const n of notes) {
    if (!Number.isFinite(n.step) || !Number.isFinite(n.note)) continue;
    if (n.note < s.lowNote || n.note > s.highNote) continue;
    const c0 = Math.floor(n.step * perCol);
    if (c0 >= s.cols || n.step + Math.max(0, n.length) < 0) continue;
    const c1 = Math.min(s.cols - 1, Math.max(c0, Math.ceil((n.step + Math.max(0, n.length)) * perCol) - 1));
    const base = densityRow(n.note, s) * s.cols;
    for (let c = Math.max(0, c0); c <= c1; c += 1) cells[base + c] += 1;
  }
  partCache.set(notes, { key, cells });
  return cells;
}

/** The counts of every part's notes summed. */
export function rollDensity(parts: readonly { notes: readonly PianoNote[] }[], s: DensityShape): Density {
  const cells = new Float32Array(Math.max(0, s.cols * s.rows));
  if (s.cols > 0 && s.rows > 0) {
    for (const p of parts) {
      if (!p.notes.length) continue;
      const own = partCells(p.notes, s);
      for (let i = 0; i < cells.length; i += 1) cells[i] += own[i];
    }
  }
  let max = 0;
  for (let i = 0; i < cells.length; i += 1) if (cells[i] > max) max = cells[i];
  return { ...s, cells, max };
}

/** How strong a cell draws: none for an empty one, then 0.18 up to 1 by the square root of its share of the fullest cell. */
export const densityAlpha = (count: number, max: number): number =>
  count <= 0 || max <= 0 ? 0 : 0.18 + 0.82 * Math.sqrt(Math.min(1, count / max));

/**
 * Draws `d` over a `width` by `height` (css px) canvas in the accent; `scale`
 * is the backing store's device pixels per css px (the device pixel ratio
 * times the shell's CSS zoom). Returns the cells drawn.
 */
export function paintDensity(ctx: Paint2D, d: Density, width: number, height: number, accent: Rgb, scale = 1): number {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!d.cols || !d.rows || d.max <= 0) return 0;
  const cw = width / d.cols;
  const rh = height / d.rows;
  ctx.fillStyle = rgba(accent, 1);
  let drawn = 0;
  for (let r = 0; r < d.rows; r += 1) {
    for (let c = 0; c < d.cols; c += 1) {
      const v = d.cells[r * d.cols + c];
      if (v <= 0) continue;
      ctx.globalAlpha = densityAlpha(v, d.max);
      ctx.fillRect(c * cw, r * rh, Math.max(1, cw), Math.max(1, rh));
      drawn += 1;
    }
  }
  ctx.globalAlpha = 1;
  return drawn;
}

/** The step and pitch at a point of the overview (css px from its top-left). */
export function densityPoint(x: number, y: number, width: number, height: number, s: Pick<DensityShape, 'totalSteps' | 'lowNote' | 'highNote'>): { step: number; pitch: number } {
  const fx = width > 0 ? Math.max(0, Math.min(1, x / width)) : 0;
  const fy = height > 0 ? Math.max(0, Math.min(1, y / height)) : 0.5;
  return {
    step: fx * s.totalSteps,
    pitch: Math.round(s.highNote - fy * (s.highNote - s.lowNote)),
  };
}
