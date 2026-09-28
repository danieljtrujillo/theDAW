/**
 * The piano roll's note layer drawn on one canvas: the other parts' ghost
 * notes, the looping lanes' repeats and the active part's notes, in that order.
 *
 * The canvas covers only the part of the grid in view. Each layer asks its
 * interval index (lib/noteIndex) for the notes inside the view on both axes,
 * the steps in view and the pitch rows in view, so a frame draws what can be
 * seen and nothing else, whatever the roll's length or part count. Notes of one
 * look are batched into one path and filled and stroked once.
 *
 * `paintRoll` takes a context shaped like CanvasRenderingContext2D (`Paint2D`),
 * so the draw path runs, and is measured, in node with a stand-in context.
 * The geometry here (`noteBox`, the look table) is the one the grid's hit test
 * and its focusable overlay use, so a click lands on the note drawn under it.
 */
import type { NoteIndex } from './noteIndex';
import type { PianoNote } from '../state/pianoRollStore';

/** The part of CanvasRenderingContext2D the roll draws with. */
export interface Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** A context that draws nothing, for a browser (or a test DOM) with no 2D canvas: the plan and its counts still run. */
export const NULL_PAINT: Paint2D = {
  fillStyle: '',
  strokeStyle: '',
  globalAlpha: 1,
  lineWidth: 1,
  beginPath() {},
  rect() {},
  fill() {},
  stroke() {},
  fillRect() {},
  clearRect() {},
  setTransform() {},
};

const contexts = new WeakMap<object, Paint2D | null>();

/**
 * The 2D context of `canvas`, asked for once per element: null where the page
 * has no 2D canvas. Kept per element, so a canvas unmounted and mounted again
 * (a clip scrolled out of view and back) draws into its own context, never
 * into the one of the element it replaced.
 */
export function canvas2d(canvas: HTMLCanvasElement): Paint2D | null {
  if (contexts.has(canvas)) return contexts.get(canvas) ?? null;
  let ctx: Paint2D | null = null;
  try {
    ctx = canvas.getContext('2d') as unknown as Paint2D | null;
  } catch {
    ctx = null;
  }
  contexts.set(canvas, ctx);
  return ctx;
}

export type Rgb = readonly [number, number, number];

/** An "r g b" (or "r, g, b") triplet as the theme's CSS variables hold it; `fallback` when it does not read as one. */
export function parseRgb(text: string | null | undefined, fallback: Rgb): Rgb {
  const parts = String(text ?? '').match(/-?\d+(?:\.\d+)?/g);
  if (!parts || parts.length < 3) return fallback;
  const [r, g, b] = parts.slice(0, 3).map((p) => Math.max(0, Math.min(255, Math.round(Number(p)))));
  return [r, g, b];
}

export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** The accent the roll uses when the theme variable cannot be read. */
export const DEFAULT_ACCENT: Rgb = [168, 85, 247];

/**
 * The patterns a lane's look fills with: stripes at 135° and 45°, and a sparse
 * hatch. Made from a small tile by the component (a browser canvas); a look
 * whose pattern is missing fills flat in its place.
 */
export type RollPattern = 'stripes135' | 'stripes45' | 'hatch45';

/**
 * A note's look. Index 0 is the active lane (solid); 1 to 4 are the other
 * lanes by rank, as PianoRoll's LANE_FORMS: outlined, striped, outlined with a
 * hatch, striped the other way. `minPx` is the narrowest a note of the look
 * draws, so a one-step note keeps its look at the widest zoom out.
 */
export interface RollLook {
  minPx: number;
  fill: (accent: Rgb) => string;
  pattern?: RollPattern;
  /** Fill with the pattern only (the stripes), or lay it over the flat fill (the hatch). */
  patternOnly?: boolean;
  edge: (accent: Rgb) => string;
}

export const ROLL_LOOKS: readonly RollLook[] = [
  { minPx: 4, fill: (a) => rgba(a, 1), edge: () => 'rgba(0,0,0,0.4)' },
  { minPx: 8, fill: (a) => rgba(a, 0.14), edge: (a) => rgba(a, 1) },
  { minPx: 8, fill: (a) => rgba(a, 0.5), pattern: 'stripes135', patternOnly: true, edge: (a) => rgba(a, 0.8) },
  { minPx: 8, fill: (a) => rgba(a, 0.14), pattern: 'hatch45', edge: (a) => rgba(a, 1) },
  { minPx: 8, fill: (a) => rgba(a, 0.5), pattern: 'stripes45', patternOnly: true, edge: (a) => rgba(a, 0.8) },
];
/** The widest minimum any look draws at (px): a query reaches this far left of the view. */
export const MAX_LOOK_MIN_PX = 8;
/** A ghost note's narrowest drawn width (px). */
export const GHOST_MIN_PX = 3;
/** A lane repeat's fill strength; its edge stays full. */
export const REPEAT_FILL_ALPHA = 0.38;

export const lookOf = (index: number): RollLook => ROLL_LOOKS[Math.max(0, Math.min(ROLL_LOOKS.length - 1, index | 0))];

/** The grid's geometry, as the roll lays it out. */
export interface RollGridGeometry {
  stepPx: number;
  noteHeight: number;
  highestNote: number;
  lowestNote: number;
}

/** Where a note of look `minPx` draws in the grid (px): the box the pointer hits and the overlay covers. */
export function noteBox(
  n: Pick<PianoNote, 'step' | 'length' | 'note'>,
  g: Pick<RollGridGeometry, 'stepPx' | 'noteHeight' | 'highestNote'>,
  minPx: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: n.step * g.stepPx,
    y: (g.highestNote - n.note) * g.noteHeight + 1,
    w: Math.max(minPx, n.length * g.stepPx - 1),
    h: g.noteHeight - 2,
  };
}

/** The part of the grid in view (grid px). */
export interface RollView {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The steps and pitches a view shows: `from`/`to` in steps (reaching `reachPx`
 * left, for notes drawn wider than they last), `low`/`high` the pitch rows,
 * clipped to the grid's range. Null when the view shows no row.
 */
export function viewRange(
  view: RollView,
  g: RollGridGeometry,
  reachPx: number,
): { from: number; to: number; low: number; high: number } | null {
  if (!(view.width > 0) || !(view.height > 0) || !(g.stepPx > 0)) return null;
  const topRow = Math.floor(view.y / g.noteHeight);
  const bottomRow = Math.floor((view.y + view.height) / g.noteHeight);
  const high = Math.min(g.highestNote, g.highestNote - topRow);
  const low = Math.max(g.lowestNote, g.highestNote - bottomRow);
  if (low > high) return null;
  return { from: (view.x - reachPx) / g.stepPx, to: (view.x + view.width) / g.stepPx, low, high };
}

/** Another part's notes, drawn behind in its colour; fainter when it does not sound. */
export interface GhostLayer {
  id: string;
  color: string;
  sounding: boolean;
  index: NoteIndex<PianoNote>;
}

export interface RollScene extends RollGridGeometry {
  ghosts: readonly GhostLayer[];
  /** The looping lanes' repeats (drawn, never stored), or null. */
  repeats: NoteIndex<PianoNote> | null;
  /** The active part's notes. */
  notes: NoteIndex<PianoNote>;
  /** The look index (ROLL_LOOKS) of a note's lane. */
  lookOfLane: (lane: number | undefined) => number;
  selected: ReadonlySet<string>;
  hoverId: string | null;
  accent: Rgb;
  patterns?: Partial<Record<RollPattern, CanvasPattern>>;
}

export interface RollPaintStats {
  ghosts: number;
  repeats: number;
  notes: number;
  selected: number;
  /** Ghost notes drawn per part id. */
  ghostParts: Record<string, number>;
}

/** Fills and strokes one batch of rects. */
function flush(
  ctx: Paint2D,
  rects: number[],
  fill: string | CanvasPattern | null,
  fillAlpha: number,
  edge: string | null,
  edgeAlpha: number,
): void {
  if (!rects.length) return;
  ctx.beginPath();
  for (let i = 0; i < rects.length; i += 4) ctx.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
  if (fill !== null) {
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (edge !== null) {
    ctx.globalAlpha = edgeAlpha;
    ctx.strokeStyle = edge;
    ctx.stroke();
  }
}

/**
 * Draws the scene's notes inside `view` onto `ctx`, whose backing store is
 * `view.width * scale` by `view.height * scale` device pixels (`scale` is the
 * device pixel ratio times the shell's CSS zoom, so a note stays sharp at the
 * 1.1 zoom a 1920x1080 window gets): it clears the view, then draws the
 * ghosts, the repeats and the notes on top. Returns what it drew.
 */
export function paintRoll(ctx: Paint2D, scene: RollScene, view: RollView, scale = 1): RollPaintStats {
  const stats: RollPaintStats = { ghosts: 0, repeats: 0, notes: 0, selected: 0, ghostParts: {} };
  ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
  ctx.clearRect(view.x, view.y, view.width, view.height);
  ctx.lineWidth = 1;
  const g = scene;
  const range = viewRange(view, g, MAX_LOOK_MIN_PX);
  if (!range) return stats;
  const { from, to, low, high } = range;
  const accent = scene.accent;

  // Ghosts: one path per part, straight from its index into the context,
  // filled and stroked once in its colour at two strengths.
  const ghostFrom = (view.x - GHOST_MIN_PX) / g.stepPx;
  const { stepPx, noteHeight, highestNote } = g;
  const ghostH = noteHeight - 5;
  for (const layer of scene.ghosts) {
    ctx.beginPath();
    const count = layer.index.spansInRect(ghostFrom, to, low, high, (start, end, pitch) => {
      const w = (end - start) * stepPx - 1;
      ctx.rect(start * stepPx + 0.5, (highestNote - pitch) * noteHeight + 2.5, w > GHOST_MIN_PX ? w : GHOST_MIN_PX, ghostH);
    });
    stats.ghosts += count;
    stats.ghostParts[layer.id] = count;
    if (!count) continue;
    ctx.globalAlpha = layer.sounding ? 0.3 : 0.1;
    ctx.fillStyle = layer.color;
    ctx.fill();
    ctx.globalAlpha = layer.sounding ? 0.75 : 0.3;
    ctx.strokeStyle = layer.color;
    ctx.stroke();
  }

  // Lane repeats and notes: batched per look (and, for notes, per selected).
  const batches = (): number[][] => ROLL_LOOKS.map(() => []);
  const fillOf = (look: RollLook): string | CanvasPattern => {
    const pat = look.pattern ? scene.patterns?.[look.pattern] : undefined;
    return look.patternOnly && pat ? pat : look.fill(accent);
  };
  const overlay = (look: RollLook): CanvasPattern | null => {
    const pat = look.pattern && !look.patternOnly ? scene.patterns?.[look.pattern] : undefined;
    return pat ?? null;
  };
  const drawBatch = (list: number[][], fillAlpha: number, edgeOf: (look: RollLook) => string) => {
    list.forEach((r, i) => {
      const look = ROLL_LOOKS[i];
      flush(ctx, r, fillOf(look), fillAlpha, null, 1);
      const pat = overlay(look);
      if (pat) flush(ctx, r, pat, fillAlpha, null, 1);
      flush(ctx, r, null, 1, edgeOf(look), 1);
    });
  };

  if (scene.repeats) {
    const rep = batches();
    stats.repeats = scene.repeats.queryRect(from, to, low, high, (n) => {
      const li = scene.lookOfLane(n.lane);
      const b = noteBox(n, g, ROLL_LOOKS[li].minPx);
      // Strokes sit on the half pixel, inside the box, as a 1px CSS border does.
      rep[li].push(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    });
    drawBatch(rep, REPEAT_FILL_ALPHA, (look) => look.edge(accent));
  }

  const plain = batches();
  const picked = batches();
  let hover: { x: number; y: number; w: number; h: number } | null = null;
  stats.notes = scene.notes.queryRect(from, to, low, high, (n) => {
    const li = scene.lookOfLane(n.lane);
    const b = noteBox(n, g, ROLL_LOOKS[li].minPx);
    const on = scene.selected.has(n.id);
    if (on) stats.selected += 1;
    (on ? picked : plain)[li].push(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    if (n.id === scene.hoverId) hover = b;
  });
  drawBatch(plain, 1, (look) => look.edge(accent));
  // A selected note: its look, brightened, with a white edge.
  drawBatch(picked, 1, () => 'rgba(255,255,255,1)');
  const brighten: number[] = [];
  for (const r of picked) brighten.push(...r);
  flush(ctx, brighten, 'rgba(255,255,255,1)', 0.18, null, 1);
  if (hover) {
    const h = hover as { x: number; y: number; w: number; h: number };
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(h.x, h.y, h.w, h.h);
  }
  ctx.globalAlpha = 1;
  return stats;
}

/**
 * The active note under a grid point, and whether the point is on its right
 * edge (the resize handle: the last `edgePx` of the drawn box, and never more
 * than its last third, so a note drawn a few px wide at a far zoom-out still
 * has a body to drag). The pitch is the row; the time test uses each note's
 * drawn width (its look's minimum), so a note drawn wider than it lasts is hit
 * where it is drawn. Of overlapping notes the one latest in the list wins.
 */
export function hitNote(
  index: NoteIndex<PianoNote>,
  x: number,
  y: number,
  g: Pick<RollGridGeometry, 'stepPx' | 'noteHeight' | 'highestNote'>,
  lookOfLane: (lane: number | undefined) => number,
  edgePx: number,
): { note: PianoNote; edge: boolean } | null {
  if (!(g.stepPx > 0) || !(x >= 0) || !(y >= 0)) return null;
  const pitch = g.highestNote - Math.floor(y / g.noteHeight);
  const at = x / g.stepPx;
  // A drawn box is max(minPx, length * stepPx - 1) wide: in steps, a note reaches (minPx + 1) / stepPx at least.
  const minSteps = (n: PianoNote) => (lookOf(lookOfLane(n.lane)).minPx + 1) / g.stepPx;
  const hit = index.hitTest(at, pitch, (MAX_LOOK_MIN_PX + 1) / g.stepPx, minSteps);
  if (!hit) return null;
  const box = noteBox(hit, g, lookOf(lookOfLane(hit.lane)).minPx);
  return { note: hit, edge: x >= box.x + box.w - Math.min(edgePx, box.w / 3) };
}
