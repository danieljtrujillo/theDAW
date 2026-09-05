/**
 * Bravura glyph atlas for the note highway.
 *
 * The highway draws the SMuFL codepoints a `gantasmo.notechart` names
 * (`glyphCodepoint` / `noteheadCodepoint`) as textured sprites. Rather than
 * shipping a pre-baked sheet of the ~3000 Bravura glyphs, this module loads the
 * same Bravura web font alphaTab already bundles, then rasterises ONLY the
 * codepoints a given schedule uses into one 2D canvas the scene wraps in a
 * `THREE.CanvasTexture`. Nothing here imports three.js and nothing touches the
 * DOM at module-evaluation time, so the pure helpers (`atlasSizeFor`,
 * `cellsPerRow`, `FALLBACK_CODEPOINT`) are testable under node.
 *
 * Coordinates: every `GlyphRect` is expressed in texture UV units with the
 * canvas' own top-left origin (v grows downwards, exactly like the pixels).
 * `(u, v, w, h)` is the glyph's ink box; `(ax, ay)` is the anchor — the point
 * the chart's (x, y) refers to — as an offset from that box's top-left corner.
 * For notes the anchor is the notehead centre (SMuFL puts every note glyph's
 * origin at the notehead's left edge on the baseline, so that is origin +
 * half a notehead width); for rests and everything else it is the ink centre
 * horizontally and the baseline vertically (a rest hangs from / sits on the
 * staff line it is placed on). `emPx` records the font size the glyph was
 * drawn at so the scene can size sprites in staff spaces (1 em = 4 spaces).
 */

import { NOTEHEAD_BLACK_CODEPOINT } from '../../../../lib/notechart';

export const BRAVURA_FAMILY = 'Bravura';
/** noteheadBlack: what an undrawable codepoint is replaced with. */
export const FALLBACK_CODEPOINT = NOTEHEAD_BLACK_CODEPOINT;
/** Atlas edge lengths tried in order (texture size limits on mobile GPUs). */
export const ATLAS_SIZES: readonly number[] = [1024, 2048, 4096];
export const DEFAULT_CELL_PX = 96;
/** Nominal font size relative to the cell; a glyph taller than the cell is
 *  shrunk to fit and its `emPx` says so. */
export const FONT_TO_CELL = 0.6;

export interface GlyphRect {
  /** Ink box, UV units, top-left origin. */
  u: number;
  v: number;
  w: number;
  h: number;
  /** Anchor offset from the ink box's top-left corner, UV units. */
  ax: number;
  ay: number;
  /** Font size (px) the glyph was drawn at; 1 em = 4 staff spaces. */
  emPx: number;
}

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  /** Cell edge (px) of the grid the glyphs were laid out on. */
  cell: number;
  /** Canvas edge (px); the canvas is square. */
  size: number;
  /** Nominal font size (px) — `cell * FONT_TO_CELL`. */
  emPx: number;
  rects: Map<number, GlyphRect>;
  /** True when `cp` has its own rect (not the fallback). */
  has(cp: number): boolean;
  /** Rect for `cp`, or the fallback notehead's rect. */
  rect(cp: number): GlyphRect;
}

/** Glyph cells that fit along one edge of a `size` px atlas. */
export function cellsPerRow(size: number, cellPx: number): number {
  return Math.max(1, Math.floor(size / cellPx));
}

/**
 * Smallest atlas edge from `ATLAS_SIZES` whose grid holds `count` cells of
 * `cellPx`; the largest size when nothing fits (the builder then shrinks the
 * cell so every glyph still lands somewhere).
 */
export function atlasSizeFor(count: number, cellPx: number = DEFAULT_CELL_PX): number {
  const needed = Math.max(1, Math.ceil(count));
  for (const size of ATLAS_SIZES) {
    const n = cellsPerRow(size, cellPx);
    if (n * n >= needed) return size;
  }
  return ATLAS_SIZES[ATLAS_SIZES.length - 1];
}

/** Cell edge that lets `count` glyphs fit into a `size` px atlas. */
export function fitCell(count: number, size: number, cellPx: number): number {
  const needed = Math.max(1, Math.ceil(count));
  let cell = cellPx;
  while (cell > 16 && cellsPerRow(size, cell) ** 2 < needed) cell = Math.floor(cell * 0.75);
  return cell;
}

// ---------------------------------------------------------------------------
// font loading
// ---------------------------------------------------------------------------

let bravuraPromise: Promise<void> | null = null;

async function fontCandidates(): Promise<string[]> {
  const urls: string[] = [];
  // alphaTab publishes its font directory through the package exports map
  // (`./font/*`), so Vite resolves these to hashed asset URLs in the build
  // and to /@fs/ paths in dev. They are dynamic imports so this module stays
  // loadable outside Vite (node tests) — the import only runs on demand.
  try {
    urls.push((await import('@coderline/alphatab/font/Bravura.woff2?url')).default);
  } catch {
    // resolution failed; fall through to the next candidate
  }
  try {
    urls.push((await import('@coderline/alphatab/font/Bravura.otf?url')).default);
  } catch {
    // resolution failed; fall through to the next candidate
  }
  // The alphaTab Vite plugin also copies the font next to the app (public
  // /font/), which is where its own renderer looks for it.
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  urls.push(`${base.endsWith('/') ? base : `${base}/`}font/Bravura.woff2`);
  return urls;
}

async function loadFace(url: string): Promise<FontFace> {
  const face = new FontFace(BRAVURA_FAMILY, `url(${JSON.stringify(url)})`);
  await face.load();
  document.fonts.add(face);
  return face;
}

/**
 * Load Bravura once per session and resolve when the browser can draw it.
 * Throws a clear Error when neither the bundled woff2/otf nor the public copy
 * loads (the caller shows a fallback card instead of a blank highway).
 */
export function loadBravura(): Promise<void> {
  if (bravuraPromise) return bravuraPromise;
  bravuraPromise = (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
      throw new Error('Bravura: the FontFace API is unavailable in this environment');
    }
    // Something else (alphaTab, a stylesheet) may already have registered it.
    let alreadyThere = false;
    try {
      alreadyThere = document.fonts.check(`64px ${BRAVURA_FAMILY}`) && [...document.fonts].some((f) => f.family === BRAVURA_FAMILY);
    } catch {
      alreadyThere = false;
    }
    if (!alreadyThere) {
      const errors: string[] = [];
      let loaded = false;
      for (const url of await fontCandidates()) {
        try {
          await loadFace(url);
          loaded = true;
          break;
        } catch (e) {
          errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!loaded) throw new Error(`Bravura font failed to load (${errors.join('; ') || 'no candidate URL'})`);
    }
    const ready = await document.fonts.load(`64px ${BRAVURA_FAMILY}`);
    if (!ready.length && !document.fonts.check(`64px ${BRAVURA_FAMILY}`)) {
      throw new Error('Bravura font registered but never became ready');
    }
  })();
  // Let a later call retry after a failure instead of caching the rejection.
  bravuraPromise.catch(() => {
    bravuraPromise = null;
  });
  return bravuraPromise;
}

// ---------------------------------------------------------------------------
// atlas
// ---------------------------------------------------------------------------

interface InkBox {
  left: number;
  right: number;
  ascent: number;
  descent: number;
  advance: number;
}

function measureInk(ctx: CanvasRenderingContext2D, text: string): InkBox {
  const m = ctx.measureText(text);
  return {
    left: m.actualBoundingBoxLeft ?? 0,
    right: m.actualBoundingBoxRight ?? m.width,
    ascent: m.actualBoundingBoxAscent ?? 0,
    descent: m.actualBoundingBoxDescent ?? 0,
    advance: m.width,
  };
}

function inkIsEmpty(ink: InkBox): boolean {
  return ink.advance <= 0 || ink.right + ink.left <= 0 || ink.ascent + ink.descent <= 0;
}

/**
 * Rasterise `codepoints` (deduplicated, fallback notehead always included)
 * white on transparent into a square canvas. Requires Bravura to be loaded
 * (`await loadBravura()` first); a codepoint the font cannot draw maps to the
 * fallback notehead's rect.
 */
export function buildGlyphAtlas(codepoints: Iterable<number>, cellPx: number = DEFAULT_CELL_PX): GlyphAtlas {
  const wanted = new Set<number>();
  for (const cp of codepoints) {
    if (Number.isInteger(cp) && cp > 0) wanted.add(cp);
  }
  wanted.add(FALLBACK_CODEPOINT);

  const size = atlasSizeFor(wanted.size, cellPx);
  const cell = fitCell(wanted.size, size, cellPx);
  const perRow = cellsPerRow(size, cell);
  const emPx = Math.max(8, Math.round(cell * FONT_TO_CELL));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('glyph atlas: 2D canvas context unavailable');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `${emPx}px ${BRAVURA_FAMILY}`;

  // Notehead width at the nominal size: the anchor of every note glyph.
  const headInk = measureInk(ctx, String.fromCodePoint(FALLBACK_CODEPOINT));
  const headWidth = Math.max(1, headInk.right + headInk.left);

  const rects = new Map<number, GlyphRect>();
  const undrawable: number[] = [];
  const pad = Math.max(2, Math.round(cell * 0.04));
  let slot = 0;

  for (const cp of wanted) {
    const text = String.fromCodePoint(cp);
    let fontPx = emPx;
    ctx.font = `${fontPx}px ${BRAVURA_FAMILY}`;
    let ink = measureInk(ctx, text);
    if (inkIsEmpty(ink)) {
      undrawable.push(cp);
      continue;
    }
    // Shrink glyphs whose ink would spill out of the cell (long rests,
    // multi-flag notes at odd sizes) and remember the size they were drawn at.
    const inkW = ink.left + ink.right;
    const inkH = ink.ascent + ink.descent;
    const avail = cell - 2 * pad;
    const shrink = Math.min(1, avail / Math.max(inkW, 1e-6), avail / Math.max(inkH, 1e-6));
    if (shrink < 1) {
      fontPx = Math.max(6, Math.floor(fontPx * shrink));
      ctx.font = `${fontPx}px ${BRAVURA_FAMILY}`;
      ink = measureInk(ctx, text);
    }
    const w = Math.max(1, Math.ceil(ink.left + ink.right));
    const h = Math.max(1, Math.ceil(ink.ascent + ink.descent));
    const col = slot % perRow;
    const row = Math.floor(slot / perRow);
    slot += 1;
    const cellX = col * cell;
    const cellY = row * cell;
    // Centre the ink in the cell; the origin (baseline, x = 0) follows.
    const inkX = cellX + Math.floor((cell - w) / 2);
    const inkY = cellY + Math.floor((cell - h) / 2);
    const originX = inkX + ink.left;
    const baselineY = inkY + ink.ascent;
    ctx.fillText(text, originX, baselineY);

    const isNoteLike = isNoteGlyph(cp);
    const headAtSize = headWidth * (fontPx / emPx);
    const anchorX = isNoteLike ? originX + Math.min(headAtSize, w) / 2 : inkX + w / 2;
    const anchorY = baselineY;
    rects.set(cp, {
      u: inkX / size,
      v: inkY / size,
      w: w / size,
      h: h / size,
      ax: (anchorX - inkX) / size,
      ay: (anchorY - inkY) / size,
      emPx: fontPx,
    });
  }

  const fallback = rects.get(FALLBACK_CODEPOINT);
  if (!fallback) {
    // The font is not really available (every glyph measured empty): draw a
    // plain disc so the highway still shows something instead of nothing.
    const r = Math.max(2, Math.round(emPx * 0.14));
    const cx = Math.floor(cell / 2);
    const cy = Math.floor(cell / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.2, r, -0.35, 0, Math.PI * 2);
    ctx.fill();
    const w = Math.ceil(r * 2.4);
    const h = Math.ceil(r * 2);
    rects.set(FALLBACK_CODEPOINT, {
      u: (cx - w / 2) / size,
      v: (cy - h / 2) / size,
      w: w / size,
      h: h / size,
      ax: w / 2 / size,
      ay: h / 2 / size,
      emPx,
    });
  }
  const fallbackRect = rects.get(FALLBACK_CODEPOINT) as GlyphRect;
  const own = new Set(rects.keys());
  for (const cp of undrawable) rects.set(cp, fallbackRect);

  return {
    canvas,
    cell,
    size,
    emPx,
    rects,
    has: (cp: number) => own.has(cp),
    rect: (cp: number) => rects.get(cp) ?? fallbackRect,
  };
}

/**
 * SMuFL ranges whose glyph origin sits at the notehead's left edge: noteheads
 * (U+E0A0–E0FF), individual notes with stems/flags (U+E1D0–E1EF), beamed
 * groups (U+E1F0–E1FF) and note-name noteheads (U+E150–E1AF). Everything else
 * (rests, clefs, accidentals, barlines) is anchored at its ink centre.
 */
export function isNoteGlyph(cp: number): boolean {
  return (cp >= 0xe0a0 && cp <= 0xe0ff) || (cp >= 0xe150 && cp <= 0xe1af) || (cp >= 0xe1d0 && cp <= 0xe1ff);
}
