/**
 * Measure-and-fit zoom for OSMD page rendering.
 *
 * OpenSheetMusicDisplay cannot split a music system across pages: when one
 * system (all staves of one line of music) is taller than the printable page
 * it is placed anyway and drawn straight through the bottom margin and off the
 * fixed-height page SVG, which clips it. A 7-staff band score at the SCORE tab's
 * default 520 px / 0.64 zoom reaches 161 units on a page whose usable height is
 * ~101 units. Nothing in OSMD lowers the zoom for that, so the viewer does it:
 * after render(), read every system's bottom edge, compare the tallest with the
 * usable line (PageHeight less the kept part of the bottom margin, see
 * FIT_MARGIN_KEEP) and, if it crosses it, scale zoom down by the ratio (with a
 * little slack) and render again, at most FIT_MAX_EXTRA_PASSES more times. Page height in OSMD units grows as zoom shrinks (the page is
 * pageWidthPx / zoom / 10 units wide, A4-proportioned), so one pass is usually
 * enough and the second only absorbs the reflow.
 *
 * Pure functions only (no React, no OSMD import) so the same maths runs under a
 * node:assert test, and frontend/scripts/renderScorePdf.mjs mirrors it so the
 * bundle PDF paginates exactly like the sheet on screen.
 */

/** Lowest zoom auto-fit will pick. Below this a staff is ~12 px tall on a 735 px
 *  page and unreadable, so a score that still overflows here is left alone (the
 *  arranger fix in score_arrange.py is the real cure for such scores). */
export const FIT_FLOOR = 0.3;
/** Multiplied into the fitted zoom so the tallest system lands a hair above
 *  the margin instead of exactly on it (reflow after a zoom change moves
 *  things by a unit or two). */
export const FIT_SLACK = 0.98;
/** Re-renders allowed after the first one; each pass re-engraves the whole
 *  score, seconds for a 100-page arrangement. */
export const FIT_MAX_EXTRA_PASSES = 2;
/** Below this relative change a new pass is not worth a re-render. */
export const FIT_MIN_RELATIVE_CHANGE = 0.005;
/**
 * Fraction of PageBottomMargin that must stay clear of ink. OSMD's own page
 * breaking lets a system's bottomline (ledger lines, hanging dynamics) run a
 * few units into the bottom margin as a matter of course: the real lead sheet
 * measures 8.8 units into its 14-unit margin at the default zoom and has always
 * looked fine, so fitting against the strict PageHeight - PageBottomMargin
 * would shrink every ordinary score (measured: lead sheet 0.64 -> 0.53, 19 ->
 * 13 pages). The fit target is therefore PageHeight - 0.3 * PageBottomMargin:
 * ink may use the top 70% of the margin, the bottom 30% (~4 units, where the
 * running footer's page number sits) is the line nothing may cross.
 */
export const FIT_MARGIN_KEEP = 0.3;

/** Vertical extent of one rendered music system, in OSMD units. `y` is the
 *  system's absolute top on its page; `borderBottom` is the bottom edge of the
 *  system's bounding box relative to that origin (it already includes the
 *  skyline/bottomline ink, i.e. ledger lines and hanging dynamics). */
export interface SystemExtent {
  y: number;
  borderBottom: number;
}

/** The slice of OpenSheetMusicDisplay the fit reads. A real OSMD instance is
 *  structurally assignable; the test hands in plain objects. */
export interface OsmdFitLike {
  GraphicSheet?: {
    MusicPages?: Array<{
      MusicSystems?: Array<{
        PositionAndShape?: {
          AbsolutePosition?: { y?: number };
          BorderBottom?: number;
        } | null;
      } | null> | null;
    } | null> | null;
  } | null;
  EngravingRules?: { PageHeight?: number; PageBottomMargin?: number } | null;
}

/** Every rendered system's extent, page by page. Missing/partial shapes are
 *  skipped rather than reported as NaN. */
export function measureSystems(osmd: OsmdFitLike): SystemExtent[] {
  const out: SystemExtent[] = [];
  const pages = osmd.GraphicSheet?.MusicPages ?? [];
  for (const page of pages) {
    for (const system of page?.MusicSystems ?? []) {
      const ps = system?.PositionAndShape;
      const y = ps?.AbsolutePosition?.y;
      const bb = ps?.BorderBottom;
      if (typeof y !== 'number' || typeof bb !== 'number') continue;
      if (!Number.isFinite(y) || !Number.isFinite(bb)) continue;
      out.push({ y, borderBottom: bb });
    }
  }
  return out;
}

/** Bottom edge of the tallest-reaching system, in page units; 0 when there
 *  are no systems. */
export function tallestSystemBottom(systems: readonly SystemExtent[]): number {
  let tallest = 0;
  for (const s of systems) {
    const bottom = s.y + s.borderBottom;
    if (Number.isFinite(bottom) && bottom > tallest) tallest = bottom;
  }
  return tallest;
}

type PageRules = { PageHeight?: number; PageBottomMargin?: number } | null | undefined;

const finite = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);

/** Printable height of a page as OSMD defines it: PageHeight minus the whole
 *  bottom margin, in units. 0 when the rules are unreadable. */
export function printableHeight(rules: PageRules): number {
  const h = rules?.PageHeight;
  if (typeof h !== 'number' || !Number.isFinite(h)) return 0;
  return h - finite(rules?.PageBottomMargin);
}

/** The line no system may cross: PageHeight minus the kept part of the bottom
 *  margin (see FIT_MARGIN_KEEP). This is what "usable" means in a FitReport and
 *  what computeFitZoom fits against. 0 when the rules are unreadable. */
export function usableHeight(rules: PageRules): number {
  const h = rules?.PageHeight;
  if (typeof h !== 'number' || !Number.isFinite(h)) return 0;
  return h - finite(rules?.PageBottomMargin) * FIT_MARGIN_KEEP;
}

/**
 * The zoom to render at next. Returns `zoom` unchanged when every system stays
 * above the usable line (or when the inputs are unusable), otherwise
 * `zoom * usable / tallest * FIT_SLACK`, never below `floor`, and never above
 * the zoom passed in (this only ever shrinks).
 */
export function computeFitZoom(
  systems: readonly SystemExtent[],
  pageHeight: number,
  bottomMargin: number,
  zoom: number,
  floor: number = FIT_FLOOR,
): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return zoom;
  const usable = usableHeight({ PageHeight: pageHeight, PageBottomMargin: bottomMargin });
  if (!(usable > 0)) return zoom;
  const tallest = tallestSystemBottom(systems);
  if (!(tallest > usable)) return zoom;
  const scaled = zoom * (usable / tallest) * FIT_SLACK;
  const lowest = Number.isFinite(floor) && floor > 0 ? floor : FIT_FLOOR;
  return Math.min(zoom, Math.max(lowest, scaled));
}

/** One measurement of a rendered sheet, for status lines and JSON reports.
 *  All heights are OSMD page units. */
export interface FitReport {
  /** Bottom edge of the tallest-reaching system. */
  tallestBottom: number;
  /** The fit target: PageHeight - FIT_MARGIN_KEEP * PageBottomMargin. */
  usable: number;
  /** OSMD's own printable height: PageHeight - PageBottomMargin. */
  printable: number;
  pageHeight: number;
  bottomMargin: number;
  /** Number of systems measured (0 means nothing rendered or unreadable). */
  systems: number;
  /** Whether the tallest system crosses the usable line. */
  overflows: boolean;
}

export function fitReport(osmd: OsmdFitLike): FitReport {
  const systems = measureSystems(osmd);
  const tallestBottom = tallestSystemBottom(systems);
  const rules = osmd.EngravingRules;
  const usable = usableHeight(rules);
  return {
    tallestBottom,
    usable,
    printable: printableHeight(rules),
    pageHeight: finite(rules?.PageHeight),
    bottomMargin: finite(rules?.PageBottomMargin),
    systems: systems.length,
    overflows: usable > 0 && tallestBottom > usable,
  };
}

/**
 * Whether a pass from `current` to `next` is worth another render: `next` must
 * be lower by more than FIT_MIN_RELATIVE_CHANGE (a fit that lands within half a
 * percent is already there, and the floor stops it going lower anyway).
 */
export function worthAnotherPass(current: number, next: number): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(next) || current <= 0) return false;
  return next < current && (current - next) / current > FIT_MIN_RELATIVE_CHANGE;
}

/**
 * Drive the render/measure loop on a live renderer. `render(zoom)` must set the
 * zoom and re-render; it is called once per extra pass. Returns the final zoom
 * and the report of the last measurement. `passes` counts the extra renders.
 */
export function fitZoomToPage(
  osmd: OsmdFitLike,
  startZoom: number,
  render: (zoom: number) => void,
  opts: { floor?: number; maxExtraPasses?: number } = {},
): { zoom: number; passes: number; report: FitReport } {
  const floor = opts.floor ?? FIT_FLOOR;
  const maxExtra = Math.max(0, Math.floor(opts.maxExtraPasses ?? FIT_MAX_EXTRA_PASSES));
  let zoom = startZoom;
  let passes = 0;
  let report = fitReport(osmd);
  while (passes < maxExtra) {
    const next = computeFitZoom(
      measureSystems(osmd),
      osmd.EngravingRules?.PageHeight ?? 0,
      osmd.EngravingRules?.PageBottomMargin ?? 0,
      zoom,
      floor,
    );
    if (!worthAnotherPass(zoom, next)) break;
    zoom = next;
    passes += 1;
    render(zoom);
    report = fitReport(osmd);
  }
  return { zoom, passes, report };
}
