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
 * The timing pocket Virtuoso extracts from a reference performance
 * (`lib/grooveExtract.ts` → `GrooveTemplate` in `lib/virtuosoTransform.ts`) is
 * the same idea in different clothes, so the two adapters below convert between
 * them rather than duplicating the extractor. A pocket spans its reference bar
 * (14 slots for a 7/8 file), and the template it becomes spans the same.
 *
 * A GROUP groove (`scope: 'group'`) follows each bar's groups instead of the
 * bar line: its slots span a PAIR of pulses counted from every group start
 * (groupStartsForPulse), so swing inside 7/8 3+2+2 lays back the second 8th of
 * each group and never moves a group's downbeat. Notes inégales and
 * double-dotting are group grooves too.
 *
 * Slots are looked up by a note's exact place from its bar start (in ticks),
 * rounded to the nearer of a 16th and a slot, so a half-step pickup or a 7/32
 * bar finds the slot the note is really in.
 */
import type { Meter } from './colony';
import { accentLines, barAt, beatLines, stepsPerBar, type MeterSegment } from './meterMap';
import type { GrooveTemplate as VirtuosoGroove } from './virtuosoTransform';

/** A feel: `lateness[slot]` is a proportion of one slot, −1..1, over one 4/4 bar (or `barSteps`, or a pair of pulses). */
export interface GrooveTemplate {
  id: string;
  name: string;
  /** Slots per bar (a four-quarter bar). 16 = one slot per 16th note. A group groove: slots per pair of pulses. */
  slots: number;
  /** One lateness proportion per slot, −1..1. Shorter arrays are padded with 0. */
  lateness: number[];
  /** Steps the slots span from each bar line. Absent: a four-quarter bar (16 steps); a groove learned from a 7/8 file spans its 14. */
  barSteps?: number;
  /** 'group': the slots span a pair of pulses from every group start of every bar. Absent: they span the bar from its bar line. */
  scope?: 'bar' | 'group';
  /** A group groove's pulse in steps (2 swings 8ths, 1 swings 16ths). Absent: half of each bar's beat unit (8ths in 3/4, 16ths in 7/8). */
  pulseSteps?: number;
}

/** The fields past the four every groove has: a bar groove's span, a group groove's scope and pulse. */
export type GrooveShape = Pick<GrooveTemplate, 'barSteps' | 'scope' | 'pulseSteps'>;

/** Notes this module can move: anything with a `step`. Other fields are carried through. */
export interface GrooveNote {
  step: number;
}

const clampLateness = (v: number): number =>
  Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

const EPS = 1e-9;
/** Ticks in one step (a 16th at the note model's 960 to the quarter). */
const TICKS = 240;

/** Normalize an id/name/slots/lateness set into a valid template (slots >= 1, lateness padded). */
export function makeGroove(id: string, name: string, slots: number, lateness: number[], shape: GrooveShape = {}): GrooveTemplate {
  const n = Math.max(1, Math.round(Number.isFinite(slots) ? slots : 1));
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = clampLateness(lateness[i]);
  const g: GrooveTemplate = { id, name, slots: n, lateness: out };
  if (typeof shape.barSteps === 'number' && Number.isFinite(shape.barSteps) && shape.barSteps > 0) g.barSteps = shape.barSteps;
  if (shape.scope === 'group') g.scope = 'group';
  if (typeof shape.pulseSteps === 'number' && Number.isFinite(shape.pulseSteps) && shape.pulseSteps > 0) g.pulseSteps = shape.pulseSteps;
  return g;
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

/**
 * Swing inside each group: the second of every pair of pulses, counted from
 * each group start, at a swing ratio (50 = straight, 66.7 ≈ triplet). A 3-group
 * plays long-short-plain, and no group downbeat ever moves.
 */
const groupSwing = (pulse: 1 | 2, ratioPct: number): GrooveTemplate =>
  makeGroove(
    `group${pulse === 2 ? 8 : 16}:${ratioPct}`,
    `Group swing ${pulse === 2 ? '8ths' : '16ths'} ${ratioPct}%`,
    2,
    [0, (2 * ratioPct) / 100 - 1],
    { scope: 'group', pulseSteps: pulse },
  );

/** Notes inégales: the two halves of each beat long-short at 3:2, counted from each group start. */
const inegales = (): GrooveTemplate =>
  makeGroove('inegales:60', 'Notes inégales 3:2', 2, [0, 0.2], { scope: 'group' });

/**
 * Double-dotting: in each pair of pulses from a group start, a note on the last
 * quarter of the pair (the short note after a dot) moves to its last eighth, so
 * a dotted 8th and 16th plays as a double-dotted 8th and 32nd.
 */
const doubleDot = (pulse: 2 | 4): GrooveTemplate =>
  makeGroove(
    `ddot:${pulse === 2 ? 8 : 4}`,
    `Double-dotted ${pulse === 2 ? '8ths' : 'quarters'}`,
    4,
    [0, 0, 0, 0.5],
    { scope: 'group', pulseSteps: pulse },
  );

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
    groupSwing(2, 58),
    groupSwing(2, 62),
    groupSwing(2, 66),
    groupSwing(1, 62),
    groupSwing(1, 66),
    inegales(),
    doubleDot(2),
    doubleDot(4),
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

/**
 * Virtuoso's extracted pocket (timing offsets in step units) as a groove
 * template. A pocket that says how many steps a slot is (`slotSteps`, which
 * the extractor writes) keeps its own slot count and spans its reference bar;
 * an older 16-slot pocket, or a shorter one padded out, spans a 4/4 bar.
 */
export function fromVirtuosoTemplate(t: VirtuosoGroove, id = `midi:${t.name}`): GrooveTemplate {
  const timing = t.timing ?? [];
  const marked = typeof t.slotSteps === 'number' && Number.isFinite(t.slotSteps) && t.slotSteps > 0;
  const slotSteps = marked ? (t.slotSteps as number) : 1;
  const slots = marked || timing.length > 16 ? Math.max(1, timing.length) : 16;
  const barSteps = slots * slotSteps;
  return makeGroove(id, t.name, slots, timing.map((v) => v / slotSteps), barSteps === 16 ? {} : { barSteps });
}

/**
 * A groove as Virtuoso's pocket: timing offsets in step units, flat emphasis.
 * A 4/4 template with another slot count is sampled at the 16 sixteenth
 * positions; a template learned from another bar length keeps its slots and
 * says how many steps each is (`slotSteps`); a group groove is written as it
 * lands on the 16ths of a 4/4 bar.
 *
 * TIMING ONLY, and lossy in two ways. Virtuoso's `humanize` reads timing in step
 * units of at most ±0.5 (`grooveExtract` clamps its own output there), so a
 * lateness outside that range is CLAMPED to ±0.5 and does not survive a
 * round-trip. And a groove template carries no emphasis, so `accent` comes back
 * flat 1s: the emphasis of a pocket that came from `fromVirtuosoTemplate` is
 * NOT carried through this adapter.
 */
export function toVirtuosoTemplate(g: GrooveTemplate): VirtuosoGroove {
  const half = (v: number): number => Math.max(-0.5, Math.min(0.5, v));
  if (g.scope === 'group') {
    const bar: GrooveBar = { start: 0, len: 16, meter: { num: 4, den: 4, groups: [] }, bar: 0 };
    const timing = new Array<number>(16).fill(0).map((_, i) => half(grooveLateness(g, i, bar)));
    return { name: g.name, timing, accent: new Array<number>(16).fill(1) };
  }
  if (g.barSteps !== undefined) {
    const slotSteps = g.barSteps / g.slots;
    const timing = g.lateness.map((v) => half(v * slotSteps));
    return { name: g.name, timing, accent: new Array<number>(g.slots).fill(1), slotSteps };
  }
  const timing = new Array<number>(16).fill(0).map((_, i) => {
    const slot = Math.floor((i * g.slots) / 16) % g.slots;
    return half(g.lateness[slot] ?? 0);
  });
  return { name: g.name, timing, accent: new Array<number>(16).fill(1) };
}

/** The slot a bar-relative position falls in, wrapped into the template's cycle. */
export function slotOf(groove: GrooveTemplate, stepInBar: number, stepsPerBeat: number): number {
  const slotSteps = (stepsPerBeat * 4) / groove.slots;
  const i = Math.floor(Math.round(stepInBar) / slotSteps);
  return ((i % groove.slots) + groove.slots) % groove.slots;
}

/** A bar as grooves read it: where it starts, its length, its meter, and -1 for the pickup. */
export interface GrooveBar {
  start: number;
  len: number;
  meter: Meter;
  bar: number;
}

/**
 * `pos` (steps from a slot origin) rounded to the nearer of a 16th and a slot,
 * in ticks so float dust never tips a note into the slot before it.
 */
const roundedPos = (pos: number, slotSteps: number): number => {
  const unit = Math.min(1, slotSteps) * TICKS;
  return (Math.round(Math.round(pos * TICKS) / unit) * unit) / TICKS;
};

const slotIn = (pos: number, slotSteps: number, slots: number): number => {
  const i = Math.floor(pos / slotSteps + EPS);
  return ((i % slots) + slots) % slots;
};

/**
 * Where a group groove's pairs start in one bar of `m`, for a pulse of
 * `pulse` steps: the bar's accents (its groups, a compound meter's dotted
 * beats) when it has more than one; else its beats when a beat holds two
 * pulses or more (4/4 swings its 8ths inside each quarter); else the bar line.
 */
export function groupStartsForPulse(m: Meter, pulse: number): number[] {
  const accents = accentLines(m);
  if (accents.length > 1) return accents;
  if (16 / m.den >= 2 * pulse - EPS) return beatLines(m);
  return [0];
}

/** A group groove's pulse in a bar of `m`: its own, or half the bar's beat unit. */
export const groovePulse = (g: GrooveTemplate, m: Meter): number => g.pulseSteps ?? 16 / m.den / 2;

/**
 * The lateness in steps a groove gives a note at `step` in `bar`, at full
 * strength. A bar groove counts its slots from the bar line (a pickup from its
 * own start, as the roll's swing always has) over `barSteps` (`span` by
 * default, a 4/4 bar); a group groove counts pairs of pulses from each group
 * start, with a pickup counted back from bar 1. A note that rounds onto the
 * next bar line takes that bar's slot 0.
 */
export function grooveLateness(g: GrooveTemplate, step: number, bar: GrooveBar, span = 16): number {
  if (g.scope === 'group') {
    const pulse = groovePulse(g, bar.meter);
    const pair = 2 * pulse;
    const slotSteps = pair / g.slots;
    const full = stepsPerBar(bar.meter);
    const phase = bar.bar < 0 ? full - bar.len : 0;
    const p = roundedPos(step - bar.start + phase, slotSteps);
    if (p >= full - EPS || p < -EPS) return (g.lateness[0] ?? 0) * slotSteps;
    let from = 0;
    for (const s of groupStartsForPulse(bar.meter, pulse)) if (s <= p + EPS) from = s;
    const inPair = (((p - from) % pair) + pair) % pair;
    return (g.lateness[slotIn(inPair, slotSteps, g.slots)] ?? 0) * slotSteps;
  }
  const slotSteps = (g.barSteps ?? span) / g.slots;
  const p = roundedPos(step - bar.start, slotSteps);
  const slot = p >= bar.len - EPS ? 0 : slotIn(p, slotSteps, g.slots);
  return (g.lateness[slot] ?? 0) * slotSteps;
}

/**
 * Move notes onto a groove. `strength` 0..1 scales every lateness; `barStartOf`
 * gives the step a note's bar starts on (so odd-length bars restart the cycle
 * exactly as the roll's old odd-16th rule did) and defaults to a cycle anchored
 * at step 0; `maxStep` is the last step of the grid, so a deep groove cannot
 * drag the roll's final notes off the end of it (omit it for no ceiling).
 *
 * The slot is read from the note's place measured from its own bar line, to the nearer of a 16th and a slot (grooveLateness), and a place
 * that rounds onto a later bar's start takes that bar's first slot. With no
 * meter to read, a group groove counts its groups in 4/4 bars;
 * applyGrooveInMeter reads each bar's own meter.
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
  const span = spb * 4;
  const ceiling = Number.isFinite(maxStep) ? Math.max(0, maxStep as number) : Number.POSITIVE_INFINITY;
  if (amount === 0) return notes.map((n) => ({ ...n }));
  const meter: Meter = { num: 4, den: 4, groups: [] };
  return notes.map((n) => {
    let start = barStartOf ? barStartOf(n.step) : 0;
    if (groove.scope === 'group') {
      if (!barStartOf) start = Math.floor(n.step / 16 + EPS) * 16;
    } else {
      // A place that rounds into a later bar is counted from that bar's line.
      const line = start + roundedPos(n.step - start, (groove.barSteps ?? span) / groove.slots);
      const lineStart = barStartOf ? barStartOf(line) : 0;
      if (lineStart > start + EPS) start = lineStart;
    }
    const bar: GrooveBar = { start, len: groove.scope === 'group' ? 16 : Infinity, meter, bar: 0 };
    const late = grooveLateness(groove, n.step, bar, span) * amount;
    return { ...n, step: Math.min(ceiling, Math.max(0, n.step + late)) };
  });
}

/**
 * applyGroove with each note's bar read from `map` and `pickupSteps`: a bar
 * groove restarts on every bar line, and a group groove follows each bar's
 * own groups, so 7/8 3+2+2 and 12/8 in threes each get their own pairs.
 */
export function applyGrooveInMeter<T extends GrooveNote>(
  notes: readonly T[],
  groove: GrooveTemplate,
  strength: number,
  map: readonly MeterSegment[],
  pickupSteps = 0,
  maxStep?: number,
): T[] {
  const amount = clamp01(strength);
  const ceiling = Number.isFinite(maxStep) ? Math.max(0, maxStep as number) : Number.POSITIVE_INFINITY;
  if (amount === 0) return notes.map((n) => ({ ...n }));
  return notes.map((n) => {
    const b = barAt(map, n.step, pickupSteps);
    const late = grooveLateness(groove, n.step, { start: b.start, len: b.len, meter: b.meter, bar: b.bar }) * amount;
    return { ...n, step: Math.min(ceiling, Math.max(0, n.step + late)) };
  });
}
