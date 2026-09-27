/**
 * syncopation — the rhythm engine's metrical weights and syncopation scores
 * (backend/modules/rhythm/engine.py _metrical_weights and _bar_syncopation)
 * on the piano roll's 16th-note grid, bar by bar through a meter map.
 *
 * LHL: a note on a weak position followed by silence on a stronger one,
 * weighted by the note's salience, per note, divided by 4. WNBD: 1 over the
 * distance to the nearest beat, per note, divided by 4. The off-beat ratio is
 * the share of onset salience on positions weaker than a beat.
 */
import type { Meter } from './colony';
import { accentLines, bars, stepsPerBar, type MeterSegment } from './meterMap';

const EPS = 1e-9;

export interface SyncopationScore { lhl: number; wnbd: number; offbeatRatio: number; onsets: number }
export interface BarSyncopation extends SyncopationScore { bar: number; start: number; len: number; meter: Meter }

/** Steps per beat of `m` (16/den): 2 for /8, 4 for /4. */
export const stepsPerBeat = (m: Meter): number => 16 / m.den;

/**
 * Weights per step of one bar of `m`: 4 bar start, 3 group start, 2 beat,
 * 1 the beat's main subdivision, 0 the rest. A compound meter with no groups
 * (6/8, 12/8) gives its dotted beats the group tier, so it counts in two or
 * four and never as six or twelve even beats. A bar of fractional length (an
 * odd numerator over 32) gets a weight for each step it starts, and a group
 * that starts on a half step weighs the step it rounds to.
 */
export function metricalWeights(m: Meter): number[] {
  const q = stepsPerBeat(m);
  const n = Math.max(1, Math.ceil(stepsPerBar(m) - EPS));
  const w = new Array<number>(n).fill(0);
  if (Number.isInteger(q) && q >= 2) for (let i = q / 2; i < n; i += q) w[i] = 1;
  const beat = Math.max(1, q);
  for (let i = 0; i < n; i += beat) w[i] = 2;
  for (const g of accentLines(m)) {
    const i = Math.round(g);
    if (i < n) w[i] = 3;
  }
  w[0] = 4;
  return w;
}

/** One bar's scores. `positions` are step indices inside the bar; `q` is steps per beat. */
export function barSyncopation(positions: readonly number[], saliences: readonly number[], weights: readonly number[], q: number): SyncopationScore {
  const n = weights.length;
  if (!positions.length || !n) return { lhl: 0, wnbd: 0, offbeatRatio: 0, onsets: 0 };
  const occupied = new Map<number, number>();
  positions.forEach((pos, i) => {
    const p = Math.trunc(Math.max(0, Math.min(n - 1, pos)));
    occupied.set(p, Math.max(occupied.get(p) ?? 0, Number(saliences[i] ?? 1)));
  });
  const ps = [...occupied.keys()].sort((a, b) => a - b);
  let lhl = 0;
  ps.forEach((p, i) => {
    const next = i + 1 < ps.length ? ps[i + 1] : n;
    if (next - p <= 1) return;
    let rest = -Infinity;
    for (let k = p + 1; k < next; k += 1) rest = Math.max(rest, weights[k]);
    if (rest > weights[p]) lhl += (occupied.get(p) ?? 0) * (rest - weights[p]);
  });
  let wnbd = 0;
  for (const p of ps) {
    const r = q > 0 ? p % q : 0;
    const d = q > 0 ? Math.min(r, q - r) / q : 0;
    wnbd += d === 0 ? 0 : 1 / d;
  }
  let total = 0;
  let off = 0;
  for (const [p, v] of occupied) {
    total += v;
    if (weights[p] < 2) off += v;
  }
  return {
    lhl: lhl / ps.length / 4,
    wnbd: wnbd / ps.length / 4,
    offbeatRatio: total > EPS ? off / total : 0,
    onsets: ps.length,
  };
}

/**
 * Scores for every bar before `totalSteps`. A note's salience is its velocity
 * over 127 (127 when it has none). Onsets round to the nearest step. The
 * pickup bar is scored against the end of a full bar of its meter.
 *
 * The notes go to their bars in one pass: sorted by step (a sorted list is
 * used as it is), then walked alongside the bars, which are contiguous.
 */
export function syncopationByBar(
  notes: readonly { step: number; velocity?: number }[],
  map: readonly MeterSegment[],
  totalSteps: number,
  pickupSteps = 0,
): BarSyncopation[] {
  let sorted = notes.filter((nt) => Number.isFinite(nt.step));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].step < sorted[i - 1].step) {
      sorted = sorted.sort((a, b) => a.step - b.step);
      break;
    }
  }
  const weightsOf = new Map<string, number[]>();
  const salience = (nt: { velocity?: number }) => (typeof nt.velocity === 'number' ? nt.velocity : 127) / 127;
  let next = 0;
  return bars(map, totalSteps, pickupSteps).map((b) => {
    const key = `${b.meter.num}/${b.meter.den}/${b.meter.groups.join('+')}`;
    let full = weightsOf.get(key);
    if (!full) weightsOf.set(key, (full = metricalWeights(b.meter)));
    const size = Math.max(1, Math.ceil(b.len - EPS));
    const offset = b.bar < 0 ? Math.max(0, full.length - size) : 0;
    const weights = b.bar < 0 ? full.slice(offset) : full;
    while (next < sorted.length && sorted[next].step < b.start - EPS) next += 1;
    const positions: number[] = [];
    const saliences: number[] = [];
    while (next < sorted.length && sorted[next].step < b.start + b.len - EPS) {
      positions.push(Math.round(sorted[next].step - b.start));
      saliences.push(salience(sorted[next]));
      next += 1;
    }
    const score = barSyncopation(positions, saliences, weights, stepsPerBeat(b.meter));
    if (offset > 0 && score.onsets > 0) {
      // WNBD measures distance to the beat in full-bar positions.
      score.wnbd = barSyncopation(positions.map((p) => p + offset), saliences, full, stepsPerBeat(b.meter)).wnbd;
    }
    return { bar: b.bar, start: b.start, len: b.len, meter: b.meter, ...score };
  });
}
