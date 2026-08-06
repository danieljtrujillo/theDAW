/**
 * Headless alphaTex (guitar/bass tablature) to A4 PDF.
 *
 * The sheet-music renderer beside this one drives OpenSheetMusicDisplay, which
 * reads MusicXML and knows nothing about alphaTex, so tabs had no PDF path at
 * all and were the one notation kind that could not leave the app printable.
 * alphaTab is already a dependency (it is what the SCORE tab renders tabs with),
 * so this uses its low-level ScoreRenderer with the SVG backend, which needs no
 * browser, and then draws the resulting SVG into jsPDF as vectors.
 *
 * Two things about that SVG are not self-contained, and both used to wreck the
 * output; `scripts/lib/alphaTabSvg.mjs` repairs them before anything is drawn:
 *
 *   Music symbols are `<text>` nodes carrying SMuFL private-use codepoints,
 *   with the Bravura family and its size supplied by a stylesheet alphaTab
 *   injects into the page. Headless there is no stylesheet and jsPDF has no
 *   Bravura, so every notehead, clef and rest printed as a Latin core-font
 *   character. They are swapped for Bravura's own outlines, taken from the
 *   Bravura.svg that ships in the alphaTab package (OFL, see Bravura-OFL.txt).
 *
 *   The chunks carry `width`/`height` but no `viewBox`, and without one svg2pdf
 *   reduces the outermost-`<svg>` transform to a translate: the `width`/`height`
 *   render options then only set the clip rectangle, so a 950-unit-wide chunk
 *   was drawn 950 mm wide and the page kept the top-left corner of it.
 *
 * Usage: node scripts/renderTabPdf.mjs <in.alphatex> <out.pdf> [--title T] [--artist A]
 * On success one JSON line goes to stdout: {"ok":true,"pages":N,"bytes":M}
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as alphaTab from '@coderline/alphatab';
import { musicFont, prepareChunk } from './lib/alphaTabSvg.mjs';

// ---- page geometry ---------------------------------------------------------

// A4 portrait in millimetres, matching the sheet renderer so a bundle's PDFs
// are all the same paper size.
const A4_W_MM = 210;
const A4_H_MM = 297;
const MARGIN_X_MM = 12;
const MARGIN_TOP_MM = 12;
const MARGIN_BOTTOM_MM = 14;
const CONTENT_W_MM = A4_W_MM - MARGIN_X_MM * 2;

// Render width in alphaTab's pixel space. This is the only knob that decides
// engraved size, because the strip is scaled to CONTENT_W_MM whatever it is:
// 950 px across 186 mm puts alphaTab's 9 px staff space at 1.76 mm, which is a
// standard rastral, and its 14 px tab digits at about 7.8 pt.
const RENDER_W = 950;

// ---- arguments -------------------------------------------------------------

const fail = (message) => {
  process.stderr.write(`renderTabPdf: ${message}\n`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    source: positional[0],
    output: positional[1],
    title: (flags.title ?? '').trim(),
    artist: (flags.artist ?? '').trim(),
  };
};

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.output) {
  fail('usage: renderTabPdf.mjs <input.alphatex> <output.pdf> [--title T] [--artist A]');
}

// ---- title block -----------------------------------------------------------

// Same cleaning as renderScorePdf.mjs, for the same reason: the notation
// pipeline names a score after the audio file it came from, so an untouched
// title still wears its container extension and any track-number prefix.
const TITLE_EXT_RE =
  /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|wma|alac|mp4|mov|webm|mkv|m4v|avi|mid|midi|musicxml|xml)$/i;
const TRACK_BRACKETED_RE = /^\s*[[(]\s*(?:\d{1,2}[-.])?\d{1,3}\s*[\])]\s*[-._]*\s*/;
const TRACK_NUMBERED_RE = /^\s*(?:(?:\d{1,2}[-.])?\d{1,3}|[A-Ha-h]\d{1,2})\s*[-._)]+\s*/;
const HAS_LETTER_RE = /\p{L}/u;

const stripTrackPrefix = (t) => {
  const stripped = t.replace(TRACK_BRACKETED_RE, '').replace(TRACK_NUMBERED_RE, '');
  return stripped !== t && HAS_LETTER_RE.test(stripped) ? stripped.trim() : t;
};

const cleanTitleText = (raw) => {
  const t = (raw || '').trim().replace(TITLE_EXT_RE, '').trim();
  if (/^music21( fragment)?$/i.test(t)) return '';
  return stripTrackPrefix(t);
};

// ---- alphaTab --------------------------------------------------------------

const buildSettings = () => {
  const settings = new alphaTab.Settings();
  settings.core.engine = 'svg';
  settings.core.enableLazyLoading = false;
  settings.display.scale = 1;
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  // alphaTab's own header is a track header: the song name, then the tuning
  // caption ("Bass 5 Strings Tuning"), with no artist anywhere. The title block
  // is drawn below instead, so the tab gets the same title/artist pair the
  // sheet PDF has. Everything here is header material, never engraving.
  for (const element of [
    alphaTab.NotationElement.ScoreTitle,
    alphaTab.NotationElement.ScoreSubTitle,
    alphaTab.NotationElement.ScoreArtist,
    alphaTab.NotationElement.ScoreAlbum,
    alphaTab.NotationElement.ScoreWords,
    alphaTab.NotationElement.ScoreMusic,
    alphaTab.NotationElement.ScoreWordsAndMusic,
    alphaTab.NotationElement.ScoreCopyright,
    alphaTab.NotationElement.GuitarTuning,
    alphaTab.NotationElement.TrackNames,
  ]) {
    settings.notation.elements.set(element, false);
  }
  return settings;
};

const loadScore = (tex, settings) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, settings);
  return importer.readScore();
};

/** Render every chunk alphaTab produces, in document order, as SVG strings. */
const renderSvgChunks = (score, settings, tracks) =>
  new Promise((resolve, reject) => {
    const renderer = new alphaTab.rendering.ScoreRenderer(settings);
    renderer.width = RENDER_W;
    const chunks = [];
    renderer.preRender.on(() => {
      chunks.length = 0;
    });
    renderer.partialRenderFinished.on((result) => {
      if (result && typeof result.renderResult === 'string') chunks.push(result.renderResult);
    });
    renderer.renderFinished.on(() => resolve(chunks));
    renderer.error.on((e) => reject(e instanceof Error ? e : new Error(String(e))));
    try {
      renderer.renderScore(score, tracks);
    } catch (e) {
      reject(e);
    }
  });

// ---- main ------------------------------------------------------------------

let tex;
try {
  tex = readFileSync(args.source, 'utf8');
} catch (e) {
  fail(`cannot read ${args.source}: ${e.message}`);
}

const settings = buildSettings();
let score;
try {
  score = loadScore(tex, settings);
} catch (e) {
  fail(`alphaTex could not be parsed: ${e.message}`);
}

const songTitle = cleanTitleText(args.title || score.title || '');
const artist = (args.artist || score.artist || score.subTitle || '').trim();

// The notation pipeline writes one instrument per .alphatex, so track 0 is the
// whole file; this is the track the SCORE tab shows for the same artifact.
let chunks;
try {
  chunks = await renderSvgChunks(score, settings, [0]);
} catch (e) {
  fail(`alphaTab render failed: ${e.message}`);
}
if (chunks.length === 0) fail('alphaTab produced no render chunks');

// ---- DOM -------------------------------------------------------------------

// jsdom parses the SVG strings into real elements, which is what svg2pdf draws.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// Node 21+ defines globalThis.navigator as a getter-only accessor, so a plain
// assignment throws. Redefine it instead; svg2pdf reads navigator.userAgent.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
});
globalThis.SVGElement = window.SVGElement;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const { jsPDF } = await import('jspdf');
// Importing svg2pdf.js registers a .svg() method on the jsPDF prototype. Its
// named export is not reliably reachable across build shapes (in Node the
// module resolves with only default/module.exports), so prefer the plugin
// method and fall back to whichever named form is present.
const svg2pdfModule = await import('svg2pdf.js');
const svg2pdfFn = svg2pdfModule.svg2pdf || svg2pdfModule.default?.svg2pdf || svg2pdfModule.default;

const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

// ---- text metrics ----------------------------------------------------------

// jsdom implements neither getBBox nor a 2D canvas context, and svg2pdf calls
// both: it measures one test string each way and only trusts the canvas when
// the two agree. Both are answered from jsPDF's own core-font width tables, so
// they agree with each other AND with what jsPDF will actually draw. The
// measurements go through a throwaway document because taking them on `doc`
// would leave its font state wherever the last measurement left it, mid-page.
const metricsDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

const coreFamily = (raw) => {
  const first = (raw || '').replace(/["']/g, '').split(',')[0].trim().toLowerCase();
  if (first.includes('courier') || first.includes('mono')) return 'courier';
  if (first.includes('sans')) return 'helvetica';
  if (first.includes('georgia') || first.includes('times') || first.includes('serif')) {
    return 'times';
  }
  return 'helvetica';
};

const coreStyle = (style, weight) => {
  const italic = /italic|oblique/i.test(style || '');
  const bold = /bold|bolder|[6-9]00/i.test(String(weight || ''));
  if (italic && bold) return 'bolditalic';
  if (italic) return 'italic';
  if (bold) return 'bold';
  return 'normal';
};

const measure = (text, sizePx, family, style, weight) => {
  const value = String(text ?? '');
  if (!value) return 0;
  try {
    metricsDoc.setFont(coreFamily(family), coreStyle(style, weight));
    // getStringUnitWidth returns em units, so scaling by the pixel size gives px.
    return metricsDoc.getStringUnitWidth(value) * sizePx;
  } catch {
    return value.length * sizePx * 0.5;
  }
};

window.SVGElement.prototype.getBBox = function getBBox() {
  const isText = String(this.tagName).toLowerCase() === 'text';
  const size = Number.parseFloat((this.getAttribute('font-size') || '').replace(/px$/i, '')) || 12;
  if (!isText) return { x: 0, y: 0, width: 0, height: 0 };
  const width = measure(
    this.textContent,
    size,
    this.getAttribute('font-family'),
    this.getAttribute('font-style'),
    this.getAttribute('font-weight'),
  );
  return { x: 0, y: -size * 0.75, width, height: size };
};

const CANVAS_FONT_RE = /^\s*(?<style>italic|oblique|normal)?\s*(?<weight>bold|bolder|[1-9]00|normal)?\s*(?<size>[\d.]+)px\s+(?<family>.+)$/i;

window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null;
  // alphaTab does its own layout (unlike OSMD it never measures ink), so the
  // only thing this context has to answer honestly is text width.
  return {
    font: '12px helvetica',
    measureText(text) {
      const m = CANVAS_FONT_RE.exec(this.font || '');
      const g = m ? m.groups : null;
      return {
        width: measure(
          text,
          g ? Number.parseFloat(g.size) : 12,
          g ? g.family : '',
          g ? g.style : '',
          g ? g.weight : '',
        ),
      };
    },
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    clearRect() {},
    fillRect() {},
    drawImage() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
  };
};

// ---- title block -----------------------------------------------------------

const TITLE_PT = 17;
const ARTIST_PT = 11;
const PT_TO_MM = 25.4 / 72;

/** Draw the title and the artist beneath it, and report how far down the page
 *  the engraving may start. */
const drawTitleBlock = () => {
  if (!songTitle && !artist) return MARGIN_TOP_MM;
  let cursor = MARGIN_TOP_MM;
  const centre = A4_W_MM / 2;

  if (songTitle) {
    doc.setFont('times', 'bold');
    doc.setFontSize(TITLE_PT);
    const lines = doc.splitTextToSize(songTitle, CONTENT_W_MM);
    for (const line of lines) {
      cursor += TITLE_PT * PT_TO_MM;
      doc.text(line, centre, cursor, { align: 'center' });
    }
  }
  if (artist) {
    doc.setFont('times', 'italic');
    doc.setFontSize(ARTIST_PT);
    const lines = doc.splitTextToSize(artist, CONTENT_W_MM);
    for (const line of lines) {
      cursor += ARTIST_PT * PT_TO_MM * 1.35;
      doc.text(line, centre, cursor, { align: 'center' });
    }
  }
  // Breathing room between the block and the first system.
  return cursor + 6;
};

// ---- draw ------------------------------------------------------------------

const font = musicFont();
const musicFontSize = settings.display.resources.engravingSettings.musicFontSize;
const totals = { glyphs: 0, missing: 0, leftoverPua: 0 };
const pageBottom = A4_H_MM - MARGIN_BOTTOM_MM;
const FULL_PAGE_MM = A4_H_MM - MARGIN_TOP_MM - MARGIN_BOTTOM_MM;

let cursorMm = drawTitleBlock();
let pageTop = cursorMm;
let pages = 1;

for (const markup of chunks) {
  const container = window.document.createElement('div');
  container.innerHTML = markup;
  const svg = container.querySelector('svg');
  if (!svg) continue;

  const stats = prepareChunk(svg, { font, musicFontSize });
  totals.glyphs += stats.glyphs;
  totals.missing += stats.missing;
  totals.leftoverPua += stats.leftoverPua;
  // alphaTab emits an empty surface for headers it was told not to draw.
  if (!(stats.width > 0) || !(stats.height > 0)) continue;

  // Measured from the chunk's own SVG rather than from the render event, so
  // the box a chunk is drawn into is exactly the box it was laid out in.
  let widthMm = CONTENT_W_MM;
  let heightMm = (stats.height / stats.width) * CONTENT_W_MM;

  // A single system taller than a whole page cannot be paginated away, so it is
  // shrunk to fit; svg2pdf would otherwise clip the bottom off it.
  if (heightMm > FULL_PAGE_MM) {
    widthMm *= FULL_PAGE_MM / heightMm;
    heightMm = FULL_PAGE_MM;
  }

  if (cursorMm > pageTop && cursorMm + heightMm > pageBottom) {
    doc.addPage('a4', 'portrait');
    pages += 1;
    pageTop = MARGIN_TOP_MM;
    cursorMm = MARGIN_TOP_MM;
  }

  const opts = {
    x: MARGIN_X_MM + (CONTENT_W_MM - widthMm) / 2,
    y: cursorMm,
    width: widthMm,
    height: heightMm,
  };
  try {
    if (typeof doc.svg === 'function') await doc.svg(svg, opts);
    else if (typeof svg2pdfFn === 'function') await svg2pdfFn(svg, doc, opts);
    else fail('svg2pdf.js exposed neither doc.svg() nor a callable export');
  } catch (e) {
    fail(`a system could not be drawn into the PDF: ${e.message}`);
  }
  cursorMm += heightMm;
}

if (totals.glyphs === 0) fail('no music glyphs were drawn; the Bravura outlines did not load');
if (totals.missing > 0 || totals.leftoverPua > 0) {
  // Not fatal, but it is the exact shape of the bug this renderer exists to
  // avoid, so it must not pass silently.
  process.stderr.write(
    `renderTabPdf: ${totals.missing} symbol(s) had no Bravura outline and ` +
      `${totals.leftoverPua} text run(s) still hold private-use codepoints\n`,
  );
}

const bytes = Buffer.from(doc.output('arraybuffer'));
try {
  writeFileSync(args.output, bytes);
} catch (e) {
  fail(`cannot write ${args.output}: ${e.message}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, pages, bytes: bytes.length })}\n`);
