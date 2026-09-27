/**
 * The TEMPO lane's geometry: where a tempo point sits in the strip under the
 * piano roll, what the tempo curve between points looks like, and where a
 * fermata's hold is drawn.
 *
 * The strip shares the grid's x scale (one step is `stepPx` wide, and a tempo
 * event's beat is four steps), so a tempo change sits over the bar line it
 * changes at. Its y scale is tempo, linear between the range's `lo` at the
 * bottom and `hi` at the top. The range follows the map (tempoLaneRange), so a
 * map around 60 is drawn across 30-90 rather than as a sliver of 20-300.
 *
 * Everything here is pure, so the lane's behaviour is testable without a DOM.
 */
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN, clampTempoBpm, type TempoEvent } from './tempoMap';
import { PPQ } from './noteClock';

/** The strip's height in px: room for a point's 12px tempo label above and below the curve. */
export const TEMPO_LANE_HEIGHT = 96;
/** A point's drawn radius. */
export const TEMPO_POINT_R = 4;
/** How near a pointer has to be to grab a point: wider than the dot, so a 4px handle is not a 4px target. */
export const TEMPO_GRAB_R = 10;
/** The band at the top of the strip where fermata marks sit and are grabbed. */
export const FERMATA_BAND = 20;
/** The least span the strip shows, in BPM, so one tempo still has room above and below it. */
export const MIN_TEMPO_SPAN = 40;
/** A fermata a click adds: held for a quarter note, twice as long. */
export const DEFAULT_FERMATA = Object.freeze({ beats: 1, stretch: 2 });

/** The steps a quarter-note beat spans: the roll's steps are 16ths. */
const STEPS_PER_BEAT = 4;

/** What a click on empty strip adds: a tempo that holds, one that ramps to the next point, or a fermata. */
export type TempoLaneMode = 'step' | 'linear' | 'fermata';

export const TEMPO_MODE_LABEL: Record<TempoLaneMode, string> = { step: 'STEP', linear: 'RAMP', fermata: 'HOLD' };
export const TEMPO_MODE_TITLE: Record<TempoLaneMode, string> = {
  step: 'Step: a click adds a tempo that holds until the next point',
  linear: 'Ramp: a click adds a tempo that slides to the next point (a ritardando or an accelerando)',
  fermata: 'Hold: a click adds a fermata that holds the beats under it',
};

/** The mode after `mode` when the MODE key is pressed. */
export const nextTempoMode = (mode: TempoLaneMode): TempoLaneMode =>
  mode === 'step' ? 'linear' : mode === 'linear' ? 'fermata' : 'step';

/** The tempo span the strip shows. */
export interface TempoRange {
  lo: number;
  hi: number;
}

/**
 * The span that shows every tempo in `map` with room to draw past it: from
 * half the slowest to one and a half times the fastest, out to whole tens, at
 * least MIN_TEMPO_SPAN wide and inside the app's 20..300. A click can put a
 * point anywhere in it, so a ritardando to half the tempo is one click.
 */
export function tempoLaneRange(map: readonly TempoEvent[]): TempoRange {
  const tempi = map.filter((e) => !e.fermata).map((e) => e.bpm);
  const slow = tempi.length ? Math.min(...tempi) : 120;
  const fast = tempi.length ? Math.max(...tempi) : 120;
  let lo = Math.max(TEMPO_BPM_MIN, Math.floor((slow * 0.5) / 10) * 10);
  let hi = Math.min(TEMPO_BPM_MAX, Math.ceil((fast * 1.5) / 10) * 10);
  if (hi - lo < MIN_TEMPO_SPAN) {
    // Widened about its middle, then slid back inside 20..300 whole.
    const mid = (lo + hi) / 2;
    lo = Math.max(TEMPO_BPM_MIN, Math.min(TEMPO_BPM_MAX - MIN_TEMPO_SPAN, mid - MIN_TEMPO_SPAN / 2));
    hi = lo + MIN_TEMPO_SPAN;
  }
  return { lo, hi };
}

/** The curve's usable height: under the fermata band, over the bottom edge, less a point's radius each side. */
const curveBox = (height: number): { top: number; span: number } => {
  const top = FERMATA_BAND + TEMPO_POINT_R;
  return { top, span: Math.max(1, height - top - TEMPO_POINT_R) };
};

/** The y of `bpm` in a strip `height` tall showing `range`. */
export function tempoToY(bpm: number, range: TempoRange, height: number): number {
  const { top, span } = curveBox(height);
  const f = (Math.max(range.lo, Math.min(range.hi, bpm)) - range.lo) / Math.max(1e-9, range.hi - range.lo);
  return top + (1 - f) * span;
}

/** The tempo at `y`, inside `range` and the app's 20..300. */
export function yToTempo(y: number, range: TempoRange, height: number): number {
  const { top, span } = curveBox(height);
  const f = 1 - (y - top) / span;
  return clampTempoBpm(range.lo + Math.max(0, Math.min(1, f)) * (range.hi - range.lo));
}

/** A dragged tempo: to the whole BPM, or to the hundredth with Alt held (`free`). */
export const snapTempo = (bpm: number, free = false): number =>
  clampTempoBpm(free ? Math.round(bpm * 100) / 100 : Math.round(bpm));

/**
 * The beat a pointer at `x` lands on: on the step grid (`quantum` steps, 1 is
 * a 16th), or on the roll's ticks with Alt held (`free`), inside the roll.
 */
export function snapTempoBeat(x: number, stepPx: number, totalSteps: number, quantum = 1, free = false): number {
  if (!(stepPx > 0)) return 0;
  const step = Math.max(0, Math.min(totalSteps, x / stepPx));
  const snapped = free || !(quantum > 0) ? step : Math.round(step / quantum) * quantum;
  return Math.round((Math.min(totalSteps, snapped) / STEPS_PER_BEAT) * PPQ) / PPQ;
}

/** The x of a beat in the strip. */
export const beatToX = (beat: number, stepPx: number): number => beat * STEPS_PER_BEAT * stepPx;

/**
 * The SVG path of the tempo across `totalSteps`: a step holds flat and jumps at
 * the next point, a ramp is a straight line to it, and the last tempo holds to
 * the roll's end. Fermatas are drawn apart (fermataMarks): they are holds, not
 * tempi.
 */
export function tempoPath(
  map: readonly TempoEvent[],
  { stepPx, totalSteps, height, range }: { stepPx: number; totalSteps: number; height: number; range: TempoRange },
): string {
  const tempi = map.filter((e) => !e.fermata);
  const x = (beat: number) => Math.round(beatToX(beat, stepPx) * 100) / 100;
  const y = (bpm: number) => Math.round(tempoToY(bpm, range, height) * 100) / 100;
  const end = totalSteps / STEPS_PER_BEAT;
  if (!tempi.length) return `M 0 ${y(120)} L ${x(end)} ${y(120)}`;
  const d: string[] = [`M 0 ${y(tempi[0].bpm)}`];
  for (let i = 0; i < tempi.length; i += 1) {
    const e = tempi[i];
    const next = tempi[i + 1];
    d.push(`L ${x(e.beat)} ${y(e.bpm)}`);
    if (!next) break;
    // A ramp's next lineTo is the ramp itself; a step holds, then jumps there.
    if (e.curve !== 'linear') d.push(`L ${x(next.beat)} ${y(e.bpm)}`);
  }
  const last = tempi[tempi.length - 1];
  if (last.beat < end) d.push(`L ${x(end)} ${y(last.bpm)}`);
  return d.join(' ');
}

/** Where a fermata is drawn: its mark's x, and the span of its hold. */
export interface FermataMark {
  event: TempoEvent;
  x: number;
  endX: number;
}

/** Every fermata's mark and hold span, in beat order. */
export const fermataMarks = (map: readonly TempoEvent[], stepPx: number): FermataMark[] =>
  map
    .filter((e) => !!e.fermata)
    .map((e) => ({ event: e, x: beatToX(e.beat, stepPx), endX: beatToX(e.beat + (e.fermata?.beats ?? 0), stepPx) }));

/** The tempo point within TEMPO_GRAB_R of (`x`, `y`), nearest first, or null. */
export function tempoPointAt(
  map: readonly TempoEvent[],
  x: number,
  y: number,
  { stepPx, height, range }: { stepPx: number; height: number; range: TempoRange },
): TempoEvent | null {
  let best: TempoEvent | null = null;
  let bestD = Infinity;
  for (const e of map) {
    if (e.fermata) continue;
    const d = Math.hypot(beatToX(e.beat, stepPx) - x, tempoToY(e.bpm, range, height) - y);
    if (d <= TEMPO_GRAB_R && d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** The fermata whose mark is under (`x`, `y`) in the band at the top, or null. */
export function fermataAt(map: readonly TempoEvent[], x: number, y: number, stepPx: number): TempoEvent | null {
  if (y > FERMATA_BAND) return null;
  let best: TempoEvent | null = null;
  let bestD = Infinity;
  for (const m of fermataMarks(map, stepPx)) {
    const d = Math.abs(m.x - x);
    if (d <= TEMPO_GRAB_R && d < bestD) {
      best = m.event;
      bestD = d;
    }
  }
  return best;
}

/** A tempo as the lane reads it: whole BPM, or to the hundredth when it has a fraction. */
export const tempoText = (bpm: number): string => String(Math.round(bpm * 100) / 100);
