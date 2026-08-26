/**
 * Reader for SVG fonts (the `<font>/<glyph>` flavour FontForge exports).
 *
 * The PDF pipeline needs music symbols as vector outlines, not as text: jsPDF
 * only carries the Adobe core Latin fonts, so any codepoint outside them prints
 * as whatever byte the core encoding happens to hold. SMuFL puts every notehead,
 * clef and rest in the private-use area (U+E000-U+F8FF), which is exactly where
 * that falls apart. Bravura ships beside alphaTab in five formats, and the SVG
 * one is the only format whose glyphs are already path outlines keyed by
 * codepoint, so it can be read here with no font-parsing dependency and no
 * copyleft tool in the chain (Bravura is OFL, see Bravura-OFL.txt next to it).
 */

import { readFileSync } from 'node:fs';

// Path data holds no '>' characters, so a glyph element can be matched as a
// single non-greedy run without a real XML parse of a 1.8 MB file.
const GLYPH_RE = /<glyph\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
const FONT_FACE_RE = /<font-face\s([^>]*)>/;
// A space, not a word boundary: `<font-face` would satisfy `<font\b` too, and
// the fallback advance would then be read off the wrong element.
const FONT_RE = /<font\s([^>]*)>/;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** SVG-font `unicode` attributes arrive as entities far more often than as raw
 *  characters, and FontForge writes hex ones for everything above ASCII. */
const decodeEntities = (raw) =>
  raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });

const attributes = (chunk) => {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(chunk);
  while (m) {
    out[m[1]] = m[2];
    m = ATTR_RE.exec(chunk);
  }
  return out;
};

const number = (value, fallback) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Parse an SVG font file into a codepoint -> outline map.
 *
 * @param {string} file absolute path to the .svg font
 * @returns {{unitsPerEm:number, ascent:number, descent:number,
 *            defaultAdvance:number, glyphs:Map<number,{d:string,adv:number}>}}
 */
export const loadSvgFont = (file) => {
  const source = readFileSync(file, 'utf8');

  const face = attributes(FONT_FACE_RE.exec(source)?.[1] || '');
  const font = attributes(FONT_RE.exec(source)?.[1] || '');
  const unitsPerEm = number(face['units-per-em'], 1000);
  const defaultAdvance = number(font['horiz-adv-x'], unitsPerEm / 2);

  const glyphs = new Map();
  GLYPH_RE.lastIndex = 0;
  let match = GLYPH_RE.exec(source);
  while (match) {
    const attrs = attributes(match[1]);
    const d = attrs.d;
    // Whitespace glyphs legitimately carry no outline; they still advance, but
    // there is nothing to draw and nothing that could print as mojibake.
    if (d && attrs.unicode !== undefined) {
      const text = decodeEntities(attrs.unicode);
      const points = Array.from(text);
      // Ligature entries map several codepoints to one outline. alphaTab only
      // ever emits single codepoints, so those entries would never be hit.
      if (points.length === 1) {
        const cp = points[0].codePointAt(0);
        if (!glyphs.has(cp)) {
          glyphs.set(cp, { d, adv: number(attrs['horiz-adv-x'], defaultAdvance) });
        }
      }
    }
    match = GLYPH_RE.exec(source);
  }

  return {
    unitsPerEm,
    ascent: number(face.ascent, unitsPerEm * 0.8),
    descent: number(face.descent, -unitsPerEm * 0.2),
    defaultAdvance,
    glyphs,
  };
};

/**
 * Lay out a string of glyphs at a given font size, as outlines.
 *
 * SVG fonts are drawn in a y-up em box, so each outline gets a `scale(s, -s)`
 * to land in the y-down user space of the document that hosts it, positioned so
 * the origin is on the alphabetic baseline: the same origin an SVG `<text>` at
 * the same coordinates would have used.
 *
 * @param {ReturnType<typeof loadSvgFont>} font
 * @param {string} text
 * @param {number} sizePx rendered em size in user units
 * @param {'start'|'middle'|'end'} anchor horizontal alignment about x = 0
 * @returns {{paths:{d:string,transform:string}[], width:number, missing:number}}
 */
export const layoutGlyphRun = (font, text, sizePx, anchor = 'start') => {
  const scale = sizePx / font.unitsPerEm;
  const points = Array.from(text);

  let advance = 0;
  let missing = 0;
  for (const ch of points) {
    const glyph = font.glyphs.get(ch.codePointAt(0));
    if (!glyph) missing += 1;
    advance += glyph ? glyph.adv : font.defaultAdvance;
  }
  const width = advance * scale;

  let cursor = 0;
  if (anchor === 'middle') cursor = -width / 2;
  else if (anchor === 'end') cursor = -width;

  const paths = [];
  for (const ch of points) {
    const glyph = font.glyphs.get(ch.codePointAt(0));
    if (glyph) {
      // Two decimals in user units is well under a printer dot at any sane
      // page scale, and keeps the transform strings short in a file that can
      // carry tens of thousands of glyphs.
      const dx = Math.round(cursor * 100) / 100;
      paths.push({
        d: glyph.d,
        transform: `translate(${dx} 0) scale(${scale} ${-scale})`,
      });
    }
    cursor += (glyph ? glyph.adv : font.defaultAdvance) * scale;
  }

  return { paths, width, missing };
};
