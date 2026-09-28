/**
 * Quantize clip notes onto a snap grid.
 *
 * Deliberately not a hard snap: `strength` lets a performance keep its feel
 * while getting tighter, and `swing` moves every second grid line late (or
 * early) so a straight 1/8 grid can be pushed toward a shuffle. Both are what
 * the assistant reaches for when asked to "tighten this up a bit" rather than
 * "put it exactly on the grid".
 */
import type { PianoNote } from '../../state/pianoRollStore';
import type { SnapDivision } from '../../state/editorStore';
import { barAt, type MeterSegment } from '../meterMap';
import { divisionToSteps } from './units';

/** The shortest note quantizing may ever leave behind, in steps. */
export const MIN_NOTE_STEPS = 0.25;

export interface QuantizeOptions {
  /** Grid to snap to. 'off' (or an unknown division) is a no-op. */
  grid: SnapDivision;
  /** How far toward the grid line to move, 0 = not at all, 1 = all the way. */
  strength?: number;
  /** Offsets every second grid line by `swing * gridSteps / 2`. -1..1. */
  swing?: number;
  /** Also snap note ends, changing lengths. Off by default. */
  quantizeEnds?: boolean;
  /**
   * The notes' meter map. Given, the grid restarts on every bar line, so a
   * half-step pickup or a 7/32 bar keeps its lines on its own bar, and the
   * swung lines are counted from each bar start; a pickup counts its lines back
   * from bar 1. Absent, the lines run from step 0 as they always have.
   */
  meterMap?: readonly MeterSegment[];
  /** Steps before bar 0, read with `meterMap`. */
  pickupSteps?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * The position of grid line `index`, in steps, with swing applied. Odd lines —
 * the offbeats — move by half the swing amount; even lines never move, so the
 * downbeat stays where the listener expects it.
 */
const gridLine = (index: number, gridSteps: number, swing: number): number =>
  index * gridSteps + (index % 2 === 0 ? 0 : (swing * gridSteps) / 2);

/**
 * The swung grid line nearest to `position`. Swing can push a line past the
 * midpoint between its neighbours, so the three candidates around the
 * unswung guess are all measured rather than trusting the rounding.
 */
const nearestLine = (position: number, gridSteps: number, swing: number): number => {
  const guess = Math.round(position / gridSteps);
  let best = gridLine(guess, gridSteps, swing);
  let bestDistance = Math.abs(position - best);
  for (const index of [guess - 1, guess + 1]) {
    if (index < 0) continue;
    const candidate = gridLine(index, gridSteps, swing);
    const distance = Math.abs(position - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

const EPS = 1e-9;

/**
 * The swung grid line nearest to `position` with the grid restarting at each
 * bar line of `map`. The candidates are the lines of the bar that holds the
 * position, each side of the unswung guess, plus both bar lines, so a bar whose
 * length is not a whole number of cells ends on its own bar line. Inside a
 * pickup the lines count back from bar 1 and their parity is counted from it.
 */
const nearestBarLine = (
  position: number, gridSteps: number, swing: number, map: readonly MeterSegment[], pickupSteps: number,
): number => {
  const bar = barAt(map, position, pickupSteps);
  const end = bar.start + bar.len;
  const back = bar.bar < 0;
  // Offset of line k from the anchor: the bar start, or bar 1 counted backwards.
  const lineAt = (k: number): number => (back ? end - gridLine(k, gridSteps, -swing) : bar.start + gridLine(k, gridSteps, swing));
  const from = back ? end - position : position - bar.start;
  const guess = Math.round(from / gridSteps);
  // The unswung guess is measured first, so a tie keeps it, as nearestLine does.
  let best = bar.start;
  let bestDistance = Infinity;
  const consider = (candidate: number): void => {
    const distance = Math.abs(position - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  };
  for (const k of [guess, guess - 1, guess + 1]) {
    if (k < 0) continue;
    const candidate = lineAt(k);
    if (candidate < bar.start - EPS || candidate > end + EPS) continue;
    consider(candidate);
  }
  consider(bar.start);
  consider(end);
  return best;
};

/**
 * Snap note starts (and optionally ends) toward the grid. Returns a new array
 * of new notes in the input order, ids preserved.
 */
export function quantizeNotes(
  notes: readonly PianoNote[],
  options: QuantizeOptions,
): PianoNote[] {
  const gridSteps = divisionToSteps(options.grid);
  if (gridSteps <= 0) return notes.map((note) => ({ ...note }));

  const strength = clamp(options.strength ?? 1, 0, 1);
  const swing = clamp(options.swing ?? 0, -1, 1);
  const quantizeEnds = options.quantizeEnds ?? false;
  const map = options.meterMap;
  const pickup = Math.max(0, options.pickupSteps ?? 0);
  // '1/1' is a bar. With a meter map that is the bar line of whatever meter
  // holds (a 5/4 bar is 20 steps, not a 16-step cell and a 4-step remainder);
  // without one it stays the 16-step 4/4 bar it has always been.
  const barLineNear = (position: number): number => {
    const bar = barAt(map as readonly MeterSegment[], position, pickup);
    const end = bar.start + bar.len;
    return position - bar.start <= end - position ? bar.start : end;
  };
  const lineNear = (position: number): number =>
    map && map.length
      ? options.grid === '1/1' ? barLineNear(position) : nearestBarLine(position, gridSteps, swing, map, pickup)
      : nearestLine(position, gridSteps, swing);

  return notes.map((note) => {
    const target = lineNear(note.step);
    const step = Math.max(0, note.step + (target - note.step) * strength);

    if (!quantizeEnds) return { ...note, step };

    const end = note.step + note.length;
    const endTarget = lineNear(end);
    const newEnd = end + (endTarget - end) * strength;
    return { ...note, step, length: Math.max(MIN_NOTE_STEPS, newEnd - step) };
  });
}
