/**
 * Drawing a connection between two words, wherever the words are.
 *
 * Two surfaces need this and they are laid out nothing alike — the analysis
 * sheet is a wrapped column of small text, the karaoke is a few huge centred
 * lines — so the geometry lives here rather than in either of them. Both are
 * measured from the DOM: text wraps, and there is no layout model in either
 * surface to compute a position from.
 *
 * Three things every measurement here has to respect, and all of them were
 * learnt from wires that landed beside the words instead of on them:
 *
 *   - **the space.** `getBoundingClientRect` speaks viewport px, while the
 *     layer the wires are drawn on sits inside the shell's CSS `zoom` and
 *     carries no `viewBox`, so one user unit there is one LOCAL px. Every rect
 *     that comes in is divided back into that space by {@link hostFrameOf}.
 *   - **the unit.** The reader sets the type size on the sheet and the pane
 *     width sets it on the karaoke, so a curve stated in pixels is a different
 *     curve at every size. Everything below is stated in line boxes and in
 *     ROWS, measured off the surface itself — which is the unit
 *     `SheetLink.reach` is already decided in, for the same reason.
 *   - **the decoration.** A finding is painted as padding and a rule on the
 *     word's own box, so the box a browser reports is not the word. Both
 *     anchor makers take it back off ({@link textInsetOf}) — otherwise a wire
 *     leaves a marked word lower than it leaves the plain text beside it, and
 *     which of the two you get depends on whether that word happens to carry a
 *     finding.
 */
import { effectiveZoom } from '../../../lib/canvasScale';

export interface Anchor {
  /** Centre of the span, in the host's own local px. */
  x: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One drawn fragment of an element: one that wraps produces two or more. */
export interface Fragment {
  s: number;
  e: number;
  rect: DOMRect;
  /** What this fragment's own element is wearing ({@link textInsetOf}), in the
   *  host's own local px. Left off for plain text, which wears nothing. */
  inset?: TextInset;
}

/** How far a box hangs past the text inside it, above and below, in local px. */
export interface TextInset {
  above: number;
  below: number;
}

const NO_INSET: TextInset = { above: 0, below: 0 };

/**
 * What a piece of text is WEARING, taken back off its box.
 *
 * `getClientRects` and `offsetHeight` both report a BORDER box, and both
 * surfaces hang their findings off that box: on the sheet a marked word gets
 * 2px of padding and a 2-to-6px rule under it, and a `meaning` word a dotted
 * rule over it instead (sing.css). So the same wire left a marked word 4px
 * lower than the plain text beside it, and which of the two a reader saw
 * depended on whether that word happened to carry a finding. Taken off here,
 * `top` and `bottom` mean the text's own baseline box on every fragment.
 *
 * Read off the computed style rather than subtracted as a number, because the
 * decoration is not one number: measured in Chromium it is 3px under a slant
 * rhyme and 8px under a certain repetition, and the karaoke states the very
 * same marks in em against type the pane width sets between 20px and 46px, so
 * its 0.2em is 4px at one end and 9px at the other. Computed styles are
 * already local px — unlike a rect, which is why this comes off AFTER the zoom
 * division and never before it.
 */
export function textInsetOf(el: Element | null | undefined): TextInset {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return NO_INSET;
  const cs = window.getComputedStyle(el);
  const above = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const below = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
  return {
    above: Number.isFinite(above) ? above : 0,
    below: Number.isFinite(below) ? below : 0,
  };
}

/**
 * The box the wires are drawn in, and the space its measurements arrive in.
 *
 * A rect delta is viewport px; the wire layer's user units are the host's own
 * local px. Dividing by the cumulative zoom lands back in the space the SVG
 * actually draws in — the same correction ScoreView makes before it touches
 * scrollLeft, and the one canvasScale exists to spell out.
 */
export interface HostFrame {
  /** The host's own client-rect origin, viewport px. */
  left: number;
  top: number;
  /** Cumulative CSS `zoom` on the host (canvasScale.effectiveZoom). */
  zoom: number;
}

/** Measure a host into the frame its wires are drawn in. */
export function hostFrameOf(host: Element): HostFrame {
  const rect = host.getBoundingClientRect();
  const zoom = effectiveZoom(host);
  return { left: rect.left, top: rect.top, zoom: zoom > 0 ? zoom : 1 };
}

/**
 * One line box of the text being wired, in the host's own px.
 *
 * Computed styles are already local px, so this needs no zoom division — and
 * `line-height` is what actually sets how tall a row of this text is, which is
 * the only honest unit for a curve drawn between two rows of it.
 */
export function lineBoxOf(el: Element | null | undefined): number {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 16;
  const cs = window.getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = parseFloat(cs.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.2 : 16;
}

/** One row of a surface: where its top is, and how many line boxes it fills. */
export interface RowBox {
  /** Row top in the host's own px. Only differences are used, so any common
   *  origin will do. */
  top: number;
  /** Drawn rows inside this one element. A lyric line that wraps is two rows
   *  to a reader and to a wire, and one element to the DOM. */
  lines: number;
}

/**
 * How far it is from one drawn row to the next, taken from the rows THEMSELVES.
 *
 * A row is a line box plus whatever the surface puts between rows — 6px of
 * `.la-text` padding on the sheet, a `clamp()` flex gap in the karaoke — and no
 * reading of the stylesheet predicts both. Each neighbouring pair contributes
 * its gap divided by the number of rows the earlier element spans, so a lyric
 * of half short and half wrapped lines still reports the pitch of ONE row;
 * measuring the elements naively is what let that mixture drag the answer
 * between one line box and two, which changed the route with the song.
 *
 * The median is what survives a blank line and a marker set at 0.78em; gaps
 * under half a line box are dropped, since those are two boxes of the same row
 * rather than a step down to the next.
 */
export function rowPitchOf(rows: readonly RowBox[], fallback: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const span = Math.max(1, rows[i - 1].lines);
    const gap = (rows[i].top - rows[i - 1].top) / span;
    if (gap > fallback * 0.5) gaps.push(gap);
  }
  if (!gaps.length) return fallback;
  gaps.sort((p, q) => p - q);
  return gaps[gaps.length >> 1];
}

/** How much of a line box two fragments may differ by and still be one row. */
const ROW_BAND = 0.5;

/** Fragments gathered onto one visual row, and how much of the row they cover. */
interface RowCluster {
  left: number;
  right: number;
  top: number;
  bottom: number;
  mid: number;
  w: number;
}

/**
 * Where a stretch of one line ended up on screen.
 *
 * Fragments are grouped by the visual row they landed on and the widest row
 * wins. Measuring per element instead would take the bounding box AROUND a
 * wrapped stretch — a rectangle covering the whole column, whose centre is in
 * the middle of nowhere — and the wire would start in the margin.
 *
 * A row is a BAND, not a pixel. `getClientRects` reports border boxes, and two
 * pieces of one line need not report the same top: the `meaning` family wears
 * its rule along the TOP of the word where its neighbours wear one underneath
 * (sing.css), and a zoomed subtree reports fractions of a pixel. Keyed on an
 * exact top, one visual row became two, the widest of the two won, and the
 * wire anchored to whichever half of the line happened to be fatter.
 * Clustering by vertical centre with half a line box of tolerance covers every
 * such skew and has no bucket edge to fall off — and the decoration comes off
 * each fragment first, so what is grouped is the words and not their boxes.
 */
export function anchorFrom(
  fragments: readonly Fragment[] | undefined,
  start: number,
  end: number,
  frame: HostFrame,
  line: number,
): Anchor | null {
  if (!fragments) return null;
  const boxes: RowCluster[] = [];
  for (const frag of fragments) {
    if (frag.e <= start || frag.s >= end) continue;
    const ink = frag.inset ?? NO_INSET;
    const left = (frag.rect.left - frame.left) / frame.zoom;
    const right = (frag.rect.right - frame.left) / frame.zoom;
    // The rect is viewport px and the inset is local px, so the zoom comes out
    // of the rect first and the decoration comes off the result.
    const top = (frag.rect.top - frame.top) / frame.zoom + ink.above;
    const bottom = (frag.rect.bottom - frame.top) / frame.zoom - ink.below;
    boxes.push({ left, right, top, bottom, mid: (top + bottom) / 2, w: right - left });
  }
  if (!boxes.length) return null;
  boxes.sort((p, q) => p.mid - q.mid);
  const band = line * ROW_BAND;
  let cluster: RowCluster | null = null;
  let best: RowCluster | null = null;
  for (const box of boxes) {
    // The seed's centre is what the band is measured from, so a run of
    // fragments cannot creep a cluster down the page one tolerance at a time.
    if (!cluster || box.mid - cluster.mid > band) {
      cluster = { ...box };
    } else {
      cluster.left = Math.min(cluster.left, box.left);
      cluster.right = Math.max(cluster.right, box.right);
      cluster.top = Math.min(cluster.top, box.top);
      cluster.bottom = Math.max(cluster.bottom, box.bottom);
      cluster.w += box.w;
    }
    if (!best || cluster.w > best.w) best = cluster;
  }
  if (!best) return null;
  return {
    x: (best.left + best.right) / 2,
    left: best.left,
    right: best.right,
    top: best.top,
    bottom: best.bottom,
  };
}

/**
 * One element's LAID-OUT box, as an anchor. The karaoke's words are whole
 * elements, so there is nothing to group.
 *
 * Offsets, not a client rect: `getBoundingClientRect` folds in every transform
 * on the way up, and the karaoke scales the line being sung by 1.16 (sing.css)
 * from a handler that never re-measures. A rect anchor is therefore whichever
 * transform state happened to be live at the last measurement — the wire on one
 * line drawn against the geometry of another. Offsets are pre-transform and are
 * already in the host's own space, so there is no zoom to divide out either.
 *
 * The walk stops at the host, which is the element the wire layer is stretched
 * over, so the two share an origin exactly.
 *
 * `offsetHeight` is a border box, so the same decoration the sheet's fragments
 * carry comes off here too — at singing size the karaoke's underline and its
 * padding are 9px of it, which is half a line box of daylight between a wire
 * that leaves a marked word and one that leaves a plain one.
 */
export function anchorOffset(el: HTMLElement, host: HTMLElement): Anchor {
  let x = 0;
  let y = 0;
  for (let node: HTMLElement | null = el; node && node !== host; node = node.offsetParent as HTMLElement | null) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const ink = textInsetOf(el);
  return { x: x + w / 2, left: x, right: x + w, top: y + ink.above, bottom: y + h - ink.below };
}

const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Every curve constant below is a multiple of one of these two, so the same
 *  pair of words is the same SHAPE of wire at 11px and at 46px. */
export interface RouteMetrics {
  /** One line box of the text being wired ({@link lineBoxOf}), host px. */
  line: number;
  /** Top-to-top distance between two drawn rows ({@link rowPitchOf}), host px. */
  pitch: number;
}

export interface RouteOptions extends RouteMetrics {
  /** Wires that share a pair of lines are pushed apart by this index. */
  lane?: number;
  /** How far left the longest wire may reach. */
  leftEdge?: number;
  /** How many ROWS a wire may step down before it leaves the column and routes
   *  down the margin instead of arcing through the words between its two ends.
   *  Rows, not pixels, because a row is what the reader counts — and because
   *  `SheetLink.reach` is already decided in lines for the same reason. A pixel
   *  threshold against a type size the reader sets flips the route at the wrong
   *  moment, which is what made a wire change shape when nothing but the type
   *  had changed. */
  farRows?: number;
}

/** The curve, in line boxes. At the sheet's default — 12px type, a 19.2px line
 *  box — every one of these lands within a pixel of the raw constant it
 *  replaces, so the default sheet is the sheet it was and now follows the
 *  type. */
const DIP_MAX = 0.95; // was 18px
const DIP_MIN = 0.26; // was 5px
const DIP_LANE = 0.16; // was 3px
const DIP_SPREAD = 0.12; // of the horizontal reach; already dimensionless
const STEP_FLOOR = 0.3; // was 6px
const STEP_PULL = 0.55; // of dy; already dimensionless
const STEP_LANE = 0.21; // was 4px
const BOW = 0.28; // of dy; already dimensionless
const BOW_MIN = 1.35; // was 26px
const BOW_MAX = 6.8; // was 130px
const BOW_LANE = 0.47; // was 9px

/** Two anchors within this fraction of a line box share a row.
 *
 *  Deliberately far looser than the 2px it replaces: a `meaning` fragment
 *  carries a 1-3px top border its neighbours do not, so two ends of one line
 *  can report tops several pixels apart. Widening it is safe because the
 *  tightest row on the sheet is 23.6px — an 11px reading size, line-height 1.6,
 *  plus 3px of padding at each end — where 0.45 of a line box is 7.9px. No two
 *  real rows can ever fall inside that, at any size the reader can pick. */
const SAME_ROW = 0.45;

/** A wire this many rows long or longer leaves the column. One row past the
 *  two lines `LINK_NEAR_LINES` calls near, so what the store draws at rest is
 *  what stays among the words. */
const FAR_ROWS = 3;

export type Route = 'slur' | 'step' | 'margin';

export interface Wire {
  d: string;
  route: Route;
  /** Where the stroke actually leaves and lands. The renderer draws its
   *  endpoint dots HERE rather than guessing the route a second time — that
   *  second guess is what left a dot half a word away from its own wire, and
   *  half a word is wider the longer the word and the bigger the type. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * The wire between two anchors, routed by how far apart they are.
 *
 * Three routes, because one curve cannot serve all three distances:
 *
 *   - **inside a line** — a slur under the words, the way a phrase mark sits;
 *   - **neighbouring rows** — a vertical S whose control points sit directly
 *     under and over the two ends, so the curve stays in the gap between the
 *     rows instead of sweeping sideways across the text;
 *   - **a long reach** — out to the left of the column, down the margin, and
 *     back in, so none of the words it passes are crossed.
 *
 * `lane` is what keeps four rhymes between the same two lines from being four
 * identical curves drawn on top of each other and read as one.
 */
export function routeWire(a: Anchor, b: Anchor, options: RouteOptions): Wire {
  const { line, pitch } = options;
  const lane = options.lane ?? 0;
  const leftEdge = options.leftEdge ?? 2;
  if (Math.abs(a.top - b.top) < line * SAME_ROW) {
    const y = Math.max(a.bottom, b.bottom);
    const dip =
      Math.min(line * DIP_MAX, line * DIP_MIN + Math.abs(b.x - a.x) * DIP_SPREAD) + lane * line * DIP_LANE;
    return {
      d: `M ${a.x} ${a.bottom} C ${a.x} ${y + dip}, ${b.x} ${y + dip}, ${b.x} ${b.bottom}`,
      route: 'slur',
      ax: a.x,
      ay: a.bottom,
      bx: b.x,
      by: b.bottom,
    };
  }
  const ay = a.bottom;
  const by = b.top;
  const dy = Math.max(line * STEP_FLOOR, by - ay);
  // Top to top over the measured pitch, which is a row count and nothing else.
  // `dy` is the WHITESPACE between two inline boxes, so thresholding on it
  // counts a different number of rows at every type size — the same distance
  // was four rows of small text and three of large, and the wire changed shape
  // on the way between them.
  const rowsApart = pitch > 0 ? Math.abs(b.top - a.top) / pitch : 0;
  if (rowsApart < (options.farRows ?? FAR_ROWS)) {
    const pull = dy * STEP_PULL + lane * line * STEP_LANE;
    return {
      d: `M ${a.x} ${ay} C ${a.x} ${ay + pull}, ${b.x} ${by - pull}, ${b.x} ${by}`,
      route: 'step',
      ax: a.x,
      ay,
      bx: b.x,
      by,
    };
  }
  const bulge = clampTo(dy * BOW, line * BOW_MIN, line * BOW_MAX) + lane * line * BOW_LANE;
  const cx = Math.max(leftEdge, Math.min(a.left, b.left) - bulge);
  return {
    d: `M ${a.left} ${ay} C ${cx} ${ay + dy * 0.2}, ${cx} ${by - dy * 0.2}, ${b.left} ${by}`,
    route: 'margin',
    ax: a.left,
    ay,
    bx: b.left,
    by,
  };
}
