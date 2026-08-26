/**
 * Turn one alphaTab SVG chunk into something svg2pdf can actually draw.
 *
 * alphaTab's SVG backend is written for a browser that has loaded alphaTab's
 * stylesheet, so the markup leans on CSS in three ways that a headless PDF
 * conversion does not satisfy:
 *
 *   1. Music symbols are `<text>` nodes holding SMuFL private-use codepoints
 *      inside `<g class="at">`, and the Bravura family plus its size live only
 *      in the injected `.at` rule. With no stylesheet and no embedded font,
 *      every notehead and clef prints as whatever Latin byte the core font has
 *      at that code. They are replaced here with the real Bravura outlines.
 *   2. Everything else sets its font through the CSS `font:` shorthand, which
 *      svg2pdf never expands: it reads `font-size` and `font-family` only.
 *   3. Baselines are given as `dominant-baseline`, and svg2pdf reads
 *      `alignment-baseline` / `vertical-align` instead, so hanging and middle
 *      baselines silently became alphabetic ones.
 *
 * Everything here is a DOM rewrite performed before the chunk is handed to
 * svg2pdf, so alphaTab's own layout is left completely untouched.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutGlyphRun, loadSvgFont } from './svgFont.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The SMuFL private-use block. Written as numbers rather than as a regex range
// so the source file stays plain ASCII.
const PUA_FIRST = 0xe000;
const PUA_LAST = 0xf8ff;

/** Whether a string still holds a private-use codepoint, i.e. a symbol that
 *  would print as mojibake because no Latin font has a glyph for it. */
export const hasPrivateUse = (text) =>
  Array.from(text || '').some((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= PUA_FIRST && cp <= PUA_LAST;
  });

/** Locate Bravura.svg inside the installed alphaTab package. */
export const resolveMusicFontFile = () => {
  const candidates = [];
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@coderline/alphatab/package.json');
    candidates.push(join(dirname(pkg), 'dist', 'font', 'Bravura.svg'));
  } catch {
    // Not resolvable from here (bundled layouts); the relative guess below wins.
  }
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(
    join(here, '..', '..', 'node_modules', '@coderline', 'alphatab', 'dist', 'font', 'Bravura.svg'),
  );
  return candidates.find((p) => existsSync(p)) || null;
};

let cachedFont = null;

/** The Bravura outlines, parsed once per process. */
export const musicFont = () => {
  if (cachedFont) return cachedFont;
  const file = resolveMusicFontFile();
  if (!file) {
    throw new Error(
      'Bravura.svg was not found under @coderline/alphatab/dist/font; ' +
        'music symbols cannot be drawn as outlines',
    );
  }
  cachedFont = loadSvgFont(file);
  return cachedFont;
};

// ---- CSS the SVG relies on -------------------------------------------------

// jsPDF carries the Adobe core families only. Mapping every requested family
// onto one of them here makes the choice explicit, rather than leaving it to
// svg2pdf's fallback (which silently lands on Times for everything).
const coreFamily = (raw) => {
  const first = (raw || '').replace(/["']/g, '').split(',')[0].trim().toLowerCase();
  if (!first) return 'helvetica';
  if (first.includes('courier') || first.includes('mono')) return 'courier';
  // 'sans-serif' contains 'serif', so it has to be excluded before the test.
  if (first.includes('sans')) return 'helvetica';
  if (
    first.includes('georgia') ||
    first.includes('times') ||
    first.includes('serif') ||
    first.includes('garamond') ||
    first.includes('book')
  ) {
    return 'times';
  }
  return 'helvetica';
};

const SIZE_TOKEN_RE = /^([\d.]+)(px|pt|em|%)?(?:\/[\d.]+\w*)?$/;

/**
 * Expand a CSS `font:` shorthand into the pieces svg2pdf reads.
 * Returns null when the value has no size token, i.e. is not a real shorthand.
 */
export const parseFontShorthand = (value) => {
  const parts = String(value || '')
    .trim()
    .split(/\s+/);
  let style = 'normal';
  let weight = 'normal';
  let sizePx = 0;
  let familyAt = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const size = SIZE_TOKEN_RE.exec(parts[i]);
    if (size) {
      const n = Number.parseFloat(size[1]);
      // 'pt' is the only unit alphaTab could emit that is not already CSS px.
      sizePx = size[2] === 'pt' ? (n * 96) / 72 : n;
      familyAt = i + 1;
      break;
    }
    if (/^(italic|oblique)$/i.test(parts[i])) style = 'italic';
    else if (/^(bold|bolder|[6-9]00)$/i.test(parts[i])) weight = 'bold';
  }
  if (familyAt < 0) return null;
  return {
    style,
    weight,
    sizePx,
    family: coreFamily(parts.slice(familyAt).join(' ')),
  };
};

// svg2pdf matches these keywords; alphaTab writes the same words but under
// `dominant-baseline`, which svg2pdf never looks at.
const BASELINE_MAP = {
  hanging: 'hanging',
  middle: 'middle',
  central: 'middle',
  ideographic: 'ideographic',
  alphabetic: 'alphabetic',
  baseline: 'alphabetic',
  'text-top': 'top',
  'text-bottom': 'bottom',
};

const styleDeclarations = (style) => {
  const out = new Map();
  for (const decl of String(style || '').split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    out.set(decl.slice(0, at).trim().toLowerCase(), decl.slice(at + 1).trim());
  }
  return out;
};

// ---- rewrite ---------------------------------------------------------------

/**
 * Replace every SMuFL `<text>` in a chunk with Bravura outlines, in place.
 *
 * @param {SVGElement} svg the chunk's root `<svg>`, already parsed into a DOM
 * @param {{musicFontSize:number, font?:ReturnType<typeof loadSvgFont>}} options
 * @returns {{glyphs:number, missing:number, texts:number}}
 */
export const inlineMusicGlyphs = (svg, options) => {
  const font = options.font || musicFont();
  const baseSize = options.musicFontSize;
  const doc = svg.ownerDocument;
  const stats = { glyphs: 0, missing: 0, texts: 0 };

  for (const text of Array.from(svg.getElementsByTagName('text'))) {
    const parent = text.parentNode;
    const inMusicGroup =
      parent &&
      parent.nodeType === 1 &&
      String(parent.tagName).toLowerCase() === 'g' &&
      (parent.getAttribute('class') || '').split(/\s+/).includes('at');

    if (!inMusicGroup) {
      stats.texts += 1;
      continue;
    }

    // alphaTab expresses the per-symbol scale as a percentage of the CSS size,
    // and omits it entirely at 100%.
    const decls = styleDeclarations(text.getAttribute('style'));
    const pct = Number.parseFloat(decls.get('font-size') || '100');
    const sizePx = baseSize * ((Number.isFinite(pct) ? pct : 100) / 100);

    const anchor = text.getAttribute('text-anchor') || 'start';
    const run = layoutGlyphRun(font, text.textContent || '', sizePx, anchor);
    stats.missing += run.missing;

    const fill = text.getAttribute('fill');
    for (const piece of run.paths) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', piece.d);
      path.setAttribute('transform', piece.transform);
      // SVG fonts fill with the nonzero rule; Bravura winds its counters the
      // same way as its outer contours, so evenodd would punch them out.
      path.setAttribute('fill-rule', 'nonzero');
      if (fill) path.setAttribute('fill', fill);
      path.setAttribute('stroke', 'none');
      parent.insertBefore(path, text);
      stats.glyphs += 1;
    }
    parent.removeChild(text);
  }

  return stats;
};

/**
 * Give every remaining `<text>` the explicit font and baseline attributes
 * svg2pdf reads, and report any private-use codepoint still sitting in one
 * (which would print as mojibake and means a glyph was missed).
 */
export const normalizeTextNodes = (svg) => {
  let leftoverPua = 0;
  for (const text of Array.from(svg.getElementsByTagName('text'))) {
    const decls = styleDeclarations(text.getAttribute('style'));

    const shorthand = decls.has('font') ? parseFontShorthand(decls.get('font')) : null;
    if (shorthand) {
      text.setAttribute('font-family', shorthand.family);
      text.setAttribute('font-size', `${shorthand.sizePx}px`);
      text.setAttribute('font-style', shorthand.style);
      text.setAttribute('font-weight', shorthand.weight);
    } else {
      const family = decls.get('font-family') || text.getAttribute('font-family');
      if (family) text.setAttribute('font-family', coreFamily(family));
      if (decls.has('font-size')) text.setAttribute('font-size', decls.get('font-size'));
    }

    const baseline = decls.get('dominant-baseline') || text.getAttribute('dominant-baseline');
    if (baseline) {
      const mapped = BASELINE_MAP[baseline.trim().toLowerCase()];
      if (mapped) text.setAttribute('alignment-baseline', mapped);
    }

    // The shorthand and the baseline have been promoted to attributes; leaving
    // them in `style` would let svg2pdf's style-first lookup read the parts it
    // does understand out of a declaration it cannot fully parse.
    const kept = [];
    for (const [prop, value] of decls) {
      if (prop === 'font' || prop === 'dominant-baseline' || prop.startsWith('font-')) continue;
      kept.push(`${prop}:${value}`);
    }
    if (kept.length) text.setAttribute('style', kept.join(';'));
    else text.removeAttribute('style');

    if (hasPrivateUse(text.textContent)) leftoverPua += 1;
  }
  return leftoverPua;
};

/**
 * Give the chunk a viewBox.
 *
 * Without one, svg2pdf's outermost-`<svg>` transform is a plain translate: the
 * `width`/`height` render options are still used for the clip rectangle but
 * never scale the content, so a 1200-unit-wide chunk is drawn 1200 mm wide and
 * everything past the page edge is cut away. A viewBox is what makes those two
 * options mean "fit the chunk into this box".
 *
 * @returns {{width:number, height:number}} the chunk's own pixel size
 */
export const applyViewBox = (svg) => {
  const px = (value, fallback) => {
    const n = Number.parseFloat(String(value || '').replace(/px$/i, ''));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const existing = svg.getAttribute('viewBox');
  if (existing) {
    const parts = existing.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = px(svg.getAttribute('width'), 0);
  const height = px(svg.getAttribute('height'), 0);
  if (width > 0 && height > 0) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // A chunk's box is where alphaTab placed it, not a bound on its ink: an
  // ascender or a beam can sit a pixel or two outside. alphaTab's own
  // stylesheet says `overflow: visible`, and svg2pdf clips the outermost
  // `<svg>` to its box unless told the same, which shaved the tops off glyphs
  // that straddled a boundary. The chunks tile the strip, so nothing is hidden
  // by letting them bleed into each other the way they do on screen.
  svg.setAttribute('overflow', 'visible');
  return { width, height };
};

/**
 * The whole per-chunk preparation, in the order the rewrites depend on: the
 * music glyphs have to leave the DOM as text before the remaining text nodes
 * are checked for leftover private-use codepoints.
 *
 * @param {SVGElement} svg
 * @param {{musicFontSize:number, font?:ReturnType<typeof loadSvgFont>}} options
 */
export const prepareChunk = (svg, options) => {
  const stats = inlineMusicGlyphs(svg, options);
  stats.leftoverPua = normalizeTextNodes(svg);
  const box = applyViewBox(svg);
  return { ...stats, ...box };
};
