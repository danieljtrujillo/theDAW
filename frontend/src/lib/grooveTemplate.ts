/**
 * Groove templates for the piano roll: a named feel expressed as **lateness
 * proportions per slot**, applied to notes instead of one scalar swing.
 *
 * A template covers one four-quarter bar split into `slots` equal slots, and
 * each entry says how late (+) or early (−) a note landing in that slot plays,
 * as a proportion of one slot. So with `slots: 16` (a bar of 16ths) a lateness
 * of 0.5 on slot 1 drags every off-16th half a 16th behind the grid. Strength
 * scales the whole thing linearly: 0 = the written grid, 1 = the full template.
 *
 * Design source (design only — no code copied, GPL-3/commercial):
 * `oss-refs/tracktion_engine/modules/tracktion_engine/model/edit/tracktion_GrooveTemplate.h`
 * (lateness proportions per note slot, scaled by a strength argument).
 *
 * The 16-slot timing pocket Virtuoso extracts from a reference performance
 * (`lib/grooveExtract.ts` → `GrooveTemplate` in `lib/virtuosoTransform.ts`) is
 * the same idea in different clothes, so the two adapters below convert between
 * them rather than duplicating the extractor.
 */
import type { GrooveTemplate as VirtuosoGroove } from './virtuosoTransform';

/** A feel: `lateness[slot]` is a proportion of one slot, −1..1, over one 4/4 bar. */
export interface GrooveTemplate {
  id: string;
  name: string;
  /** Slots per bar (a four-quarter bar). 16 = one slot per 16th note. */
  slots: number;
  /** One lateness proportion per slot, −1..1. Shorter arrays are padded with 0. */
  lateness: number[];
}

/** Notes this module can move: anything with a `step`. Other fields are carried through. */
export interface GrooveNote {
  step: number;
}

const clampLateness = (v: number): number =>
  Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Normalize an id/name/slots/lateness set into a valid template (slots >= 1, lateness padded). */
export function makeGroove(id: string, name: string, slots: number, lateness: number[]): GrooveTemplate {
  const n = Math.max(1, Math.round(Number.isFinite(slots) ? slots : 1));
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = clampLateness(lateness[i]);
  return { id, name, slots: n, lateness: out };
}

/** The roll's swing knob, as a groove: every odd slot of the bar lags by `swingPct`% of a step. */
export const SWING_GROOVE_PREFIX = 'swing';

/**
 * The scalar swing the roll applied before groove templates existed: each
 * odd 16th counted from the bar start moves by `swingPct` percent of a step
 * (positive lags, negative pushes ahead), clamped to ±49% as the slider was.
 *
 * A fractional percent is ROUNDED first, because the slider is integral and the
 * id has to be stable: `swingToGroove(12.4)` and `swingToGroove(12)` are the
 * same groove, `swing:12`.
 */
export function swingToGroove(swingPct: number): GrooveTemplate {
  const pct = Math.round(Number.isFinite(swingPct) ? swingPct : 0);
  const amount = Math.max(-0.49, Math.min(0.49, pct / 100));
  const lateness = new Array<number>(16).fill(0).map((_, i) => (i % 2 === 1 ? amount : 0));
  const sign = pct > 0 ? '+' : '';
  return makeGroove(`${SWING_GROOVE_PREFIX}:${pct}`, `Swing ${sign}${pct}%`, 16, lateness);
}

/** True for the ids `swingToGroove` mints, so the UI can keep those bound to the slider. */
export const isSwingGrooveId = (id: string): boolean => id.startsWith(`${SWING_GROOVE_PREFIX}:`);

/** Off-8ths (slots 2, 6, 10, 14) at a swing ratio: 50 = straight, 66.7 ≈ triplet. */
const swing8 = (ratioPct: number): GrooveTemplate => {
  const late = (4 * ratioPct) / 100 - 2;
  return makeGroove(
    `swing8:${ratioPct}`,
    `Swing 8ths ${ratioPct}%`,
    16,
    new Array<number>(16).fill(0).map((_, i) => (i % 4 === 2 ? late : 0)),
  );
};

/** Off-16ths (the odd slots) at a swing ratio: 50 = straight, 66.7 ≈ triplet. */
const swing16 = (ratioPct: number): GrooveTemplate => {
  const late = (2 * ratioPct) / 100 - 1;
  return makeGroove(
    `swing16:${ratioPct}`,
    `Swing 16ths ${ratioPct}%`,
    16,
    new Array<number>(16).fill(0).map((_, i) => (i % 2 === 1 ? late : 0)),
  );
};

/** The named feels the roll offers out of the box. `straight` is always first. */
export function builtinGrooves(): GrooveTemplate[] {
  return [
    makeGroove('straight', 'Straight', 16, new Array<number>(16).fill(0)),
    swing8(54),
    swing8(58),
    swing8(62),
    swing8(66),
    swing16(54),
    swing16(58),
    swing16(62),
    swing16(66),
  ];
}

/**
 * A swing groove by id: `swing8:<pct>` swings the off-8ths and `swing16:<pct>`
 * the off-16ths, the long note taking `pct` percent of the pair (50 straight,
 * 66.7 a triplet feel; 50-75, one decimal kept). These are the ids the named
 * swing feels carry, and MATCH writes a song's own swing the same way, so an
 * id in a saved feel record turns back into its groove after a reload.
 */
export function swingGrooveById(id: string): GrooveTemplate | null {
  const m = /^swing(8|16):(\d+(?:\.\d+)?)$/.exec(id.trim());
  if (!m) return null;
  const pct = Number(m[2]);
  if (!(pct >= 50 && pct <= 75)) return null;
  return m[1] === '8' ? swing8(pct) : swing16(pct);
}

/**
 * The groove an id names: a built-in feel, or any swing id `swingGrooveById`
 * reads. Null for an id nothing answers to (the SWING slider's own id, or the
 * MIDI groove of a previous session).
 */
export function grooveById(id: string): GrooveTemplate | null {
  return builtinGrooves().find((g) => g.id === id) ?? swingGrooveById(id);
}

/** Virtuoso's extracted pocket (16 timing offsets in step units) as a groove template. */
export function fromVirtuosoTemplate(t: VirtuosoGroove, id = `midi:${t.name}`): GrooveTemplate {
  return makeGroove(id, t.name, 16, t.timing ?? []);
}

/**
 * A groove as Virtuoso's pocket: 16 timing offsets in step units, flat emphasis.
 * A template with another slot count is sampled at the 16 sixteenth positions.
 *
 * TIMING ONLY, and lossy in two ways. Virtuoso's `humanize` reads timing in step
 * units of at most ±0.5 (`grooveExtract` clamps its own output there), so a
 * lateness outside that range is CLAMPED to ±0.5 and does not survive a
 * round-trip. And a groove template carries no emphasis, so `accent` comes back
 * flat 1s: the emphasis of a pocket that came from `fromVirtuosoTemplate` is
 * NOT carried through this adapter.
 */
export function toVirtuosoTemplate(g: GrooveTemplate): VirtuosoGroove {
  const timing = new Array<number>(16).fill(0).map((_, i) => {
    const slot = Math.floor((i * g.slots) / 16) % g.slots;
    return Math.max(-0.5, Math.min(0.5, g.lateness[slot] ?? 0));
  });
  return { name: g.name, timing, accent: new Array<number>(16).fill(1) };
}

/** The slot a bar-relative position falls in, wrapped into the template's cycle. */
export function slotOf(groove: GrooveTemplate, stepInBar: number, stepsPerBeat: number): number {
  const slotSteps = (stepsPerBeat * 4) / groove.slots;
  const i = Math.floor(Math.round(stepInBar) / slotSteps);
  return ((i % groove.slots) + groove.slots) % groove.slots;
}

/**
 * Move notes onto a groove. `strength` 0..1 scales every lateness; `barStartOf`
 * gives the step a note's bar starts on (so odd-length bars restart the cycle
 * exactly as the roll's old odd-16th rule did) and defaults to a cycle anchored
 * at step 0; `maxStep` is the last step of the grid, so a deep groove cannot
 * drag the roll's final notes off the end of it (omit it for no ceiling).
 *
 * Only `step` is written. Lengths are untouched and every other field of each
 * note is carried through unchanged — including any tick-domain fields, which
 * the roll's store re-derives from `step` when these notes go back in through
 * `replaceAll`.
 */
export function applyGroove<T extends GrooveNote>(
  notes: readonly T[],
  groove: GrooveTemplate,
  stepsPerBeat: number,
  strength: number,
  barStartOf?: (step: number) => number,
  maxStep?: number,
): T[] {
  const amount = clamp01(strength);
  const spb = Math.max(1, Math.round(Number.isFinite(stepsPerBeat) ? stepsPerBeat : 4));
  const slotSteps = (spb * 4) / groove.slots;
  const ceiling = Number.isFinite(maxStep) ? Math.max(0, maxStep as number) : Number.POSITIVE_INFINITY;
  if (amount === 0) return notes.map((n) => ({ ...n }));
  return notes.map((n) => {
    const grid = Math.round(n.step);
    const barStart = barStartOf ? barStartOf(grid) : 0;
    const slot = slotOf(groove, grid - barStart, spb);
    const late = (groove.lateness[slot] ?? 0) * amount * slotSteps;
    return { ...n, step: Math.min(ceiling, Math.max(0, n.step + late)) };
  });
}
