/**
 * Headless MusicXML -> multi-page A4 PDF, engraved by the same OpenSheetMusicDisplay
 * build the SCORE tab uses.
 *
 * Bundle downloads are assembled server-side, but OSMD is the only permissively
 * licensed engraver in this project, and it only runs in a DOM. Driving it through
 * jsdom keeps one engraver for both paths, so a bundle PDF is the same engraving the
 * user already looked at on screen rather than a second renderer's approximation.
 *
 * Usage: node scripts/renderScorePdf.mjs <in.musicxml> <out.pdf> [--artist NAME] [--zoom N]
 *        [--page-width N]
 * On success one JSON line goes to stdout: {"ok":true,"pages":N,"bytes":M}
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { jsPDF } from 'jspdf';

// A4 portrait in millimetres, matching OSMD's pageFormat 'A4_P'.
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

// Mirrors ZOOM_DEFAULT in src/components/layout/ScoreView.tsx. OSMD derives the
// page width in its own units from container.offsetWidth / zoom / 10, so zoom and
// page width together decide where the page breaks fall; both have to match the UI
// or the PDF would paginate differently from the sheet on screen.
const ZOOM_DEFAULT = 0.64;
// ScoreView's initial pageWRef, i.e. the container width OSMD measures for one page.
const PAGE_WIDTH_PX = 520;

const fail = (message) => {
  console.error(`renderScorePdf: ${message}`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const zoom = Number(flags.zoom ?? ZOOM_DEFAULT);
  const pageWidth = Number(flags['page-width'] ?? PAGE_WIDTH_PX);
  return {
    source: positional[0],
    output: positional[1],
    artist: flags.artist ?? '',
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : ZOOM_DEFAULT,
    pageWidth: Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : PAGE_WIDTH_PX,
  };
};

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.output) {
  fail(
    'usage: renderScorePdf.mjs <input.musicxml> <output.pdf> ' +
      '[--artist NAME] [--zoom N] [--page-width N]',
  );
}

let musicXml;
try {
  musicXml = readFileSync(args.source, 'utf8');
} catch (e) {
  fail(`cannot read ${args.source}: ${e.message}`);
}

// ---- DOM -------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="osmd-host"></div></body></html>');
const win = dom.window;

globalThis.window = win;
globalThis.document = win.document;
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
globalThis.HTMLElement = win.HTMLElement;
globalThis.HTMLCanvasElement = win.HTMLCanvasElement;
globalThis.SVGElement = win.SVGElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.DOMParser = win.DOMParser;
globalThis.XMLSerializer = win.XMLSerializer;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.Image = win.Image;

// ---- text metrics ----------------------------------------------------------

// jsPDF carries the Adobe core-font width tables, so Times/Helvetica/Courier
// advance widths come from real metrics instead of a character-count guess. OSMD
// sizes titles, instrument labels and lyrics from measureText, and those widths
// feed the layout, so an invented number would shift the engraving.
const metricsDoc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

const FONT_RE = /^\s*(?<style>italic|oblique|normal)?\s*(?<weight>bold|bolder|[1-9]00|normal)?\s*(?<size>[\d.]+)(?<unit>px|pt|em)\s+(?<family>.+)$/i;

const familyFor = (raw) => {
  const name = (raw || '').replace(/["']/g, '').split(',')[0].trim().toLowerCase();
  if (name.includes('courier') || name.includes('mono')) return 'courier';
  if (name.includes('arial') || name.includes('helvetica') || name.includes('sans')) {
    return 'helvetica';
  }
  return 'times';
};

const parseFont = (spec) => {
  const m = FONT_RE.exec(spec || '');
  if (!m) return { family: 'times', style: 'normal', sizePx: 10 };
  const { style, weight, size, unit, family } = m.groups;
  const value = Number(size) || 10;
  const sizePx = unit.toLowerCase() === 'pt' ? (value * 96) / 72 : value;
  const italic = style && /italic|oblique/i.test(style);
  const bold = weight && /bold|bolder|[6-9]00/i.test(weight);
  let jsStyle = 'normal';
  if (italic && bold) jsStyle = 'bolditalic';
  else if (italic) jsStyle = 'italic';
  else if (bold) jsStyle = 'bold';
  return { family: familyFor(family), style: jsStyle, sizePx };
};

const measureTextWidth = (text, spec) => {
  const { family, style, sizePx } = parseFont(spec);
  try {
    metricsDoc.setFont(family, style);
    // getStringUnitWidth returns em units, so scaling by the pixel size gives px.
    return metricsDoc.getStringUnitWidth(String(text ?? '')) * sizePx;
  } catch {
    return String(text ?? '').length * sizePx * 0.5;
  }
};

// ---- ink-tracking 2D context ----------------------------------------------

// OSMD derives every sky/bottom line by drawing each measure onto a canvas and
// scanning the ALPHA channel for the topmost and bottommost inked pixel per column
// (PlainSkyBottomLineBatchCalculatorBackend.calculateFromCanvas). Those lines drive
// vertical system spacing, so without them the PDF would paginate differently from
// the browser. jsdom has no raster canvas and node-canvas is a native dependency
// this project does not carry, so this context records coverage instead of colour:
// only the alpha byte is ever written, and for a filled path the extreme pixel in a
// column always lies on its outline, so tracing outlines reproduces exactly the
// signal OSMD reads back.
class InkContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.width = Math.max(1, canvas.width | 0);
    this.height = Math.max(1, canvas.height | 0);
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.matrix = [1, 0, 0, 1, 0, 0];
    this.stack = [];
    this.path = [];
    this.current = null;
    this.lineWidth = 1;
    this.font = '10px Times New Roman';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.globalAlpha = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
  }

  // -- transforms
  save() {
    this.stack.push({
      matrix: this.matrix.slice(),
      lineWidth: this.lineWidth,
      font: this.font,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  restore() {
    const s = this.stack.pop();
    if (!s) return;
    this.matrix = s.matrix;
    this.lineWidth = s.lineWidth;
    this.font = s.font;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.globalAlpha = s.globalAlpha;
  }

  transform(a, b, c, d, e, f) {
    const m = this.matrix;
    this.matrix = [
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4],
      m[1] * e + m[3] * f + m[5],
    ];
  }

  setTransform(a, b, c, d, e, f) {
    this.matrix = [a, b, c, d, e, f];
  }

  resetTransform() {
    this.matrix = [1, 0, 0, 1, 0, 0];
  }

  translate(x, y) {
    this.transform(1, 0, 0, 1, x, y);
  }

  scale(x, y) {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  point(x, y) {
    const m = this.matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // -- path construction (points are transformed on the way in, as canvas does)
  beginPath() {
    this.path = [];
    this.current = null;
  }

  moveTo(x, y) {
    this.current = [this.point(x, y)];
    this.path.push(this.current);
  }

  lineTo(x, y) {
    if (!this.current) this.moveTo(x, y);
    else this.current.push(this.point(x, y));
  }

  closePath() {
    if (this.current && this.current.length > 1) this.current.push(this.current[0]);
  }

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    if (!this.current) this.moveTo(cp1x, cp1y);
    const p0 = this.current[this.current.length - 1];
    const p1 = this.point(cp1x, cp1y);
    const p2 = this.point(cp2x, cp2y);
    const p3 = this.point(x, y);
    const steps = InkContext.curveSteps(p0, p3);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const u = 1 - t;
      this.current.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    if (!this.current) this.moveTo(cpx, cpy);
    const p0 = this.current[this.current.length - 1];
    const p1 = this.point(cpx, cpy);
    const p2 = this.point(x, y);
    const steps = InkContext.curveSteps(p0, p2);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const u = 1 - t;
      this.current.push([
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      ]);
    }
  }

  arc(x, y, r, start, end, counter) {
    let a0 = start;
    let a1 = end;
    if (counter && a1 > a0) a1 -= Math.PI * 2;
    if (!counter && a1 < a0) a1 += Math.PI * 2;
    const steps = Math.max(6, Math.ceil(Math.abs(a1 - a0) * Math.max(2, r)));
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0 && !this.current) this.moveTo(px, py);
      else this.lineTo(px, py);
    }
  }

  ellipse(x, y, rx, ry, rotation, start, end, counter) {
    let a0 = start;
    let a1 = end;
    if (counter && a1 > a0) a1 -= Math.PI * 2;
    if (!counter && a1 < a0) a1 += Math.PI * 2;
    const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * Math.max(2, Math.max(rx, ry))));
    const cr = Math.cos(rotation || 0);
    const sr = Math.sin(rotation || 0);
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      const px = x + ex * cr - ey * sr;
      const py = y + ex * sr + ey * cr;
      if (i === 0 && !this.current) this.moveTo(px, py);
      else this.lineTo(px, py);
    }
  }

  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  static curveSteps(p0, p1) {
    const span = Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]);
    return Math.min(64, Math.max(4, Math.ceil(span / 2)));
  }

  // -- coverage
  ink(x, y, spread) {
    const x0 = Math.max(0, Math.floor(x - spread));
    const x1 = Math.min(this.width - 1, Math.ceil(x + spread));
    const y0 = Math.max(0, Math.floor(y - spread));
    const y1 = Math.min(this.height - 1, Math.ceil(y + spread));
    for (let py = y0; py <= y1; py += 1) {
      const row = py * this.width * 4;
      for (let px = x0; px <= x1; px += 1) this.pixels[row + px * 4 + 3] = 255;
    }
  }

  inkSegment(a, b, spread) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      this.ink(a[0] + dx * t, a[1] + dy * t, spread);
    }
  }

  inkPath(spread, close) {
    for (const sub of this.path) {
      if (sub.length === 1) {
        this.ink(sub[0][0], sub[0][1], spread);
        continue;
      }
      for (let i = 1; i < sub.length; i += 1) this.inkSegment(sub[i - 1], sub[i], spread);
      if (close && sub.length > 2) this.inkSegment(sub[sub.length - 1], sub[0], spread);
    }
  }

  // Half a pixel of spread stands in for the antialiased fringe a real canvas
  // leaves around an edge, which counts as alpha > 0 to OSMD's scan.
  fill() {
    this.inkPath(0.5, true);
  }

  stroke() {
    const scale = Math.sqrt(Math.abs(this.matrix[0] * this.matrix[3] - this.matrix[1] * this.matrix[2])) || 1;
    this.inkPath(Math.max(0.5, (this.lineWidth * scale) / 2 + 0.5), false);
  }

  fillRect(x, y, w, h) {
    const corners = [
      this.point(x, y),
      this.point(x + w, y),
      this.point(x + w, y + h),
      this.point(x, y + h),
    ];
    this.inkSegment(corners[0], corners[1], 0.5);
    this.inkSegment(corners[1], corners[2], 0.5);
    this.inkSegment(corners[2], corners[3], 0.5);
    this.inkSegment(corners[3], corners[0], 0.5);
  }

  strokeRect(x, y, w, h) {
    this.fillRect(x, y, w, h);
  }

  clearRect(x, y, w, h) {
    if (x <= 0 && y <= 0 && w >= this.width && h >= this.height) {
      this.pixels.fill(0);
      return;
    }
    const x0 = Math.max(0, Math.floor(x));
    const x1 = Math.min(this.width - 1, Math.ceil(x + w));
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(this.height - 1, Math.ceil(y + h));
    for (let py = y0; py <= y1; py += 1) {
      const row = py * this.width * 4;
      for (let px = x0; px <= x1; px += 1) this.pixels[row + px * 4 + 3] = 0;
    }
  }

  // -- text
  measureText(text) {
    return { width: measureTextWidth(text, this.font) };
  }

  fillText(text, x, y) {
    const { sizePx } = parseFont(this.font);
    const width = measureTextWidth(text, this.font);
    if (!(width > 0)) return;
    const top = this.point(x, y - sizePx * 0.75);
    const right = this.point(x + width, y - sizePx * 0.75);
    const bottomLeft = this.point(x, y + sizePx * 0.25);
    const bottomRight = this.point(x + width, y + sizePx * 0.25);
    this.inkSegment(top, right, 0.5);
    this.inkSegment(bottomLeft, bottomRight, 0.5);
  }

  strokeText(text, x, y) {
    this.fillText(text, x, y);
  }

  // -- read-back
  getImageData(x, y, w, h) {
    if (x === 0 && y === 0 && w >= this.width && h >= this.height) {
      return { data: this.pixels, width: this.width, height: this.height };
    }
    const width = Math.max(1, Math.min(this.width - x, Math.ceil(w)));
    const height = Math.max(1, Math.min(this.height - y, Math.ceil(h)));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py += 1) {
      const src = (py + y) * this.width * 4 + x * 4;
      data.set(this.pixels.subarray(src, src + width * 4), py * width * 4);
    }
    return { data, width, height };
  }

  // -- accepted and ignored: nothing here changes coverage
  setLineDash() {}
  getLineDash() {
    return [];
  }
  clip() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
  drawImage() {}
}

// OSMD asks for a canvas per sky/bottom-line pass and reads back width/height from
// the element, so the context is cached per element and rebuilt when it is resized.
win.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null;
  const cached = this._inkContext;
  if (cached && cached.width === (this.width | 0) && cached.height === (this.height | 0)) {
    return cached;
  }
  const ctx = new InkContext(this);
  this._inkContext = ctx;
  return ctx;
};

// svg2pdf calibrates itself by measuring one test string both through a canvas and
// through an SVG text node's bounding box, and picks the canvas path only when the
// two agree. jsdom implements neither, so both are answered from the same core-font
// metrics: they agree, and text lands where the widths say it does.
win.SVGElement.prototype.getBBox = function getBBox() {
  const text = this.textContent || '';
  const size = Number(this.getAttribute('font-size')?.replace(/px$/, '')) || 16;
  const spec = [
    this.getAttribute('font-style') || 'normal',
    this.getAttribute('font-weight') || 'normal',
    `${size}px`,
    this.getAttribute('font-family') || 'Times New Roman',
  ].join(' ');
  const width = this.tagName === 'text' ? measureTextWidth(text, spec) : 0;
  return { x: 0, y: -size * 0.75, width, height: this.tagName === 'text' ? size : 0 };
};

// ---- title block -----------------------------------------------------------

// The next four helpers are the headless half of prepareMusicXml() in
// ScoreView.tsx. music21 stamps the song name into BOTH work-title and
// movement-title, and OSMD maps those to Title and Subtitle, so an untouched file
// prints its own name twice. The tab rewrites the subtitle to the artist before
// rendering; without the same rewrite the PDF would not be the sheet on screen.

const TITLE_EXT_RE =
  /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|wma|alac|mp4|mov|webm|mkv|m4v|avi|mid|midi|musicxml|xml)$/i;
const TRACK_BRACKETED_RE = /^\s*[[(]\s*(?:\d{1,2}[-.])?\d{1,3}\s*[\])]\s*[-–—._]*\s*/;
const TRACK_NUMBERED_RE = /^\s*(?:(?:\d{1,2}[-.])?\d{1,3}|[A-Ha-h]\d{1,2})\s*[-–—._)]+\s*/;
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

const wrapTitle = (t, budget) => {
  if (t.length <= budget) return t;
  const lines = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    let word = w;
    if (cur && `${cur} ${word}`.length > budget) {
      lines.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${word}` : word;
    while (cur.length > budget) {
      lines.push(cur.slice(0, budget));
      cur = cur.slice(budget);
      word = cur;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
};

const prepareMusicXml = (xml, pageWidthPx, artist) => {
  const doc = new win.DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return xml;
  const root = doc.documentElement;
  const budget = Math.max(16, Math.floor(pageWidthPx / 13));

  const song = cleanTitleText(
    (
      doc.querySelector('work > work-title')?.textContent ||
      doc.querySelector('movement-title')?.textContent ||
      ''
    ).trim(),
  );

  let work = doc.querySelector('work');
  if (!work) {
    work = doc.createElement('work');
    root.insertBefore(work, root.firstChild);
  }
  let workTitle = work.querySelector('work-title');
  if (!workTitle) {
    workTitle = doc.createElement('work-title');
    work.appendChild(workTitle);
  }
  workTitle.textContent = song ? wrapTitle(song, budget) : '';

  // No --artist given: the score's composer credit is what music21 stamped from
  // the configured artist, which is the same name the tab reads from settings.
  const credit =
    artist || doc.querySelector('identification creator[type="composer"]')?.textContent || '';
  let movement = doc.querySelector('movement-title');
  if (!movement) {
    movement = doc.createElement('movement-title');
    if (work.nextSibling) root.insertBefore(movement, work.nextSibling);
    else root.appendChild(movement);
  }
  movement.textContent = credit.trim();

  for (const cw of Array.from(doc.querySelectorAll('credit-words'))) {
    if (/^music21( fragment)?$/i.test((cw.textContent || '').trim())) cw.textContent = '';
  }

  // XMLSerializer leaves the declaration out (it is not part of the DOM), and
  // OSMD rejects any string that does not open with <?xml.
  const out = new win.XMLSerializer().serializeToString(doc);
  return out.startsWith('<?xml') ? out : `<?xml version="1.0" encoding="UTF-8"?>\n${out}`;
};

// ---- engraving -------------------------------------------------------------

/** The engraving rules from ScoreView.tsx applySheetEngraving(), kept in step so
 *  the headless pages are the same engraving the SCORE tab shows. */
const applySheetEngraving = (rules) => {
  if (!rules) return;
  try {
    rules.SheetTitleHeight = 2.2;
    rules.SheetSubtitleHeight = 1.4;
    rules.SheetComposerHeight = 1.5;
    rules.SheetAuthorHeight = 1.4;
    rules.TitleTopDistance = 5.0;
    rules.TitleBottomDistance = 1.0;
    rules.SpacingBetweenTextLines = 1.0;
    rules.MeasureNumberLabelHeight = 1.0;
    rules.InstrumentLabelTextHeight = 1.4;
    rules.LyricsHeight = 1.5;
    rules.InstantaneousTempoTextHeight = 1.6;
    rules.ContinuousTempoTextHeight = 1.4;
    rules.PageLeftMargin = 4.0;
    rules.PageRightMargin = 4.0;
    rules.PageTopMargin = 5.5;
    rules.PageBottomMargin = 14.0;
    rules.MinimumDistanceBetweenSystems = 4.0;
    rules.MinSkyBottomDistBetweenSystems = 2.0;
    rules.StaffDistance = 4.0;
    rules.BetweenStaffDistance = 4.0;
    rules.RenderMeasureNumbersOnlyAtSystemStart = true;
  } catch {
    /* older OSMD builds: ignore unsupported rules */
  }
};

const host = win.document.getElementById('osmd-host');
// jsdom has no layout, so offsetWidth is always 0 and OSMD would size the page to
// nothing. This is the one measurement it takes from the DOM.
Object.defineProperty(host, 'offsetWidth', { value: args.pageWidth, configurable: true });

const osmdModule = await import('opensheetmusicdisplay');
const OpenSheetMusicDisplay =
  osmdModule.OpenSheetMusicDisplay || osmdModule.default?.OpenSheetMusicDisplay;
if (typeof OpenSheetMusicDisplay !== 'function') {
  fail('opensheetmusicdisplay did not export OpenSheetMusicDisplay');
}

const osmd = new OpenSheetMusicDisplay(host, {
  backend: 'svg',
  autoResize: false,
  drawTitle: true,
  drawSubtitle: true,
  drawComposer: false,
  pageFormat: 'A4_P',
  pageBackgroundColor: '#FFFFFF',
});
applySheetEngraving(osmd.EngravingRules);

// OSMD treats a string that is not XML as a URL to fetch, which fails much later
// with an unrelated message, so the document is validated here instead.
if (!musicXml.trim().startsWith('<')) fail(`${args.source} is not an XML document`);
const parsed = new win.DOMParser().parseFromString(musicXml, 'application/xml');
if (parsed.querySelector('parsererror')) {
  fail(`${args.source} is not well-formed XML`);
}

try {
  await osmd.load(prepareMusicXml(musicXml, args.pageWidth, args.artist));
} catch (e) {
  fail(`OSMD could not load the MusicXML: ${e.message}`);
}

try {
  osmd.Zoom = args.zoom;
  osmd.render();
} catch (e) {
  fail(`OSMD render failed: ${e.message}`);
}

const pages = Array.from(host.querySelectorAll('svg'));
if (pages.length === 0) fail('OSMD rendered no pages');

// ---- PDF -------------------------------------------------------------------

// Node resolves the UMD build, so the named export arrives under default.
const svg2pdfModule = await import('svg2pdf.js');
const svg2pdf = svg2pdfModule.svg2pdf || svg2pdfModule.default?.svg2pdf;
if (typeof svg2pdf !== 'function') fail('svg2pdf.js did not export svg2pdf');
const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
for (let i = 0; i < pages.length; i += 1) {
  if (i > 0) doc.addPage('a4', 'portrait');
  try {
    await svg2pdf(pages[i], doc, { x: 0, y: 0, width: A4_WIDTH_MM, height: A4_HEIGHT_MM });
  } catch (e) {
    fail(`page ${i + 1} could not be drawn into the PDF: ${e.message}`);
  }
}

const bytes = Buffer.from(doc.output('arraybuffer'));
try {
  writeFileSync(args.output, bytes);
} catch (e) {
  fail(`cannot write ${args.output}: ${e.message}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, pages: pages.length, bytes: bytes.length })}\n`);
