/**
 * noteExpression — a note's own expression (PianoNote `expr`) brought into
 * range, and moved between clocks.
 *
 * A note carries up to three MPE dimensions (lib/mpeRotation plays them):
 * `pressure` and `timbre` (CC 74) 0..1, `pitchBend` -1..1 of `bendRange`
 * semitones (the note's channel's range when absent). Those are the values
 * the note starts at. `curves` holds how each dimension moves inside the note
 * after that, as points at ticks from the note's start on the note's own
 * clock (the roll's 960 PPQ in the store), each holding until the next: what
 * an MPE controller plays, what an MPE file carries, and what the roll's CC
 * lane draws for a selected note ("Note pressure", "Note timbre (74)", "Note
 * bend").
 *
 * Pure, so the store, the MIDI reader and writers, and node tests share it.
 */
import type { NoteExpression, NoteExpressionPoint } from '../state/pianoRollStore';

/** The dimensions a note's expression has. */
export type ExpressionDimension = 'pressure' | 'timbre' | 'pitchBend';
export const EXPRESSION_DIMENSIONS: readonly ExpressionDimension[] = Object.freeze(['pressure', 'timbre', 'pitchBend']);

/** The widest bend range a note may name, in semitones (MPE's member default is 48). */
export const MAX_NOTE_BEND_RANGE = 96;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A dimension's value brought into its range: 0..1, or -1..1 for the bend. */
export const clampDimension = (dim: ExpressionDimension, v: number): number =>
  dim === 'pitchBend' ? Math.max(-1, Math.min(1, v)) : Math.max(0, Math.min(1, v));

/** A curve cleaned: whole ticks after the start, sorted, the last of two at one tick, values in range. Undefined when empty. */
function cleanCurve(dim: ExpressionDimension, raw: unknown): NoteExpressionPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const byTick = new Map<number, number>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const { tick, value } = p as Record<string, unknown>;
    if (!isNum(tick) || !isNum(value)) continue;
    byTick.set(Math.max(1, Math.round(tick)), clampDimension(dim, value));
  }
  if (!byTick.size) return undefined;
  return [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({ tick, value }));
}

/** A note's expression brought into range (the store's rule for every note it holds); undefined when it carries none. */
export function sanitizeNoteExpression(e: unknown): NoteExpression | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const src = e as Record<string, unknown>;
  const out: NoteExpression = {};
  for (const dim of EXPRESSION_DIMENSIONS) if (isNum(src[dim])) out[dim] = clampDimension(dim, src[dim] as number);
  if (isNum(src.bendRange)) out.bendRange = Math.max(0, Math.min(MAX_NOTE_BEND_RANGE, src.bendRange));
  if (src.curves && typeof src.curves === 'object') {
    const curves: NonNullable<NoteExpression['curves']> = {};
    for (const dim of EXPRESSION_DIMENSIONS) {
      const c = cleanCurve(dim, (src.curves as Record<string, unknown>)[dim]);
      if (c) curves[dim] = c;
    }
    if (Object.keys(curves).length) out.curves = curves;
  }
  // A bend range alone is no expression.
  const keys = Object.keys(out).filter((k) => k !== 'bendRange');
  return keys.length ? out : undefined;
}

/** `e` with its curve ticks rescaled by `factor` (a file's ticks to the roll's, or back). */
export function scaleExpressionTicks(e: NoteExpression, factor: number): NoteExpression {
  if (!e.curves || factor === 1) return e;
  const curves: NonNullable<NoteExpression['curves']> = {};
  for (const dim of EXPRESSION_DIMENSIONS) {
    const c = e.curves[dim];
    if (c) curves[dim] = c.map((p) => ({ tick: Math.max(1, Math.round(p.tick * factor)), value: p.value }));
  }
  return { ...e, curves };
}

/** The dimension's value at `offset` ticks into the note: its start value, then each curve point in turn. Undefined when it has none. */
export function expressionAt(e: NoteExpression | undefined, dim: ExpressionDimension, offset: number): number | undefined {
  if (!e) return undefined;
  let v = e[dim];
  for (const p of e.curves?.[dim] ?? []) {
    if (p.tick > offset) break;
    v = p.value;
  }
  return v;
}

/** One dimension's start value and curve as one list of points from the note's start (tick 0 is the start value). */
export function dimensionPoints(e: NoteExpression | undefined, dim: ExpressionDimension): NoteExpressionPoint[] {
  if (!e) return [];
  const out: NoteExpressionPoint[] = [];
  if (isNum(e[dim])) out.push({ tick: 0, value: e[dim] as number });
  for (const p of e.curves?.[dim] ?? []) out.push({ ...p });
  return out;
}

/**
 * `e` with dimension `dim` replaced by `points` (ticks from the note's start):
 * the first point at or before the start is the start value, the rest the
 * curve. An empty list takes the dimension away. Undefined when nothing is left.
 */
export function withDimensionPoints(e: NoteExpression | undefined, dim: ExpressionDimension, points: readonly NoteExpressionPoint[]): NoteExpression | undefined {
  const base: NoteExpression = { ...(e ?? {}) };
  delete base[dim];
  const curves = { ...(base.curves ?? {}) };
  delete curves[dim];
  const sorted = [...points].sort((a, b) => a.tick - b.tick);
  if (sorted.length) {
    const first = sorted[0];
    base[dim] = clampDimension(dim, first.value);
    const rest = sorted.slice(1).filter((p) => p.tick > 0);
    if (rest.length) curves[dim] = rest.map((p) => ({ tick: Math.round(p.tick), value: clampDimension(dim, p.value) }));
  }
  if (Object.keys(curves).length) base.curves = curves;
  else delete base.curves;
  return sanitizeNoteExpression(base);
}
