/**
 * meterFace — the logic behind the SHAPE row's METER face
 * (components/audio/MeterFace.tsx): the bar range a meter segment prints, the
 * selection as segments come and go, where ADD starts a change, the loop
 * stepper, the pitches GEN plays, the GEN write into a lane, what MATCH
 * applies from a song's rhythm analysis, and the FORM editor's section meters.
 *
 * Meter edits keep a segment that repeats its neighbour's meter (setMeterAt
 * with merge off), so stepping BEATS through the meter before it never takes
 * the selected segment away.
 *
 * Everything here is pure.
 */
import { parseGroups, partitions, type Meter, type RuleNode } from './colony';
import { GEN_DEFAULT_OPTS, type GenKind, type GenOpts } from './loomGen';
import { pitchClass } from './loomKey';
import {
  barAt, barStartStep, defaultGroups, normalizeMeterMap, removeChangeAt, segmentBars, segmentIndexAt, setMeterAt, stepsPerBar,
  type MeterSegment, type PolyLane,
} from './meterMap';
import { accelSpan, renderGen, type GenGate, type RollNote } from './rollLoom';
import { seedFromRhythm, type RhythmAnalysis } from './rhythmSeed';
import type { PianoNote } from '../state/pianoRollStore';

const EPS = 1e-9;

export const BEATS_MIN = 1;
export const BEATS_MAX = 32;
/** The unit keys: whole, half, quarter, 8th, 16th and 32nd notes (2/2, 3/2 and 7/32 are all choosable). */
export const UNITS = [1, 2, 4, 8, 16, 32] as const;
/** Velocity of a GEN note at 0 dB; the rule's gain and the group accent move it. */
export const GEN_VELOCITY = 96;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── segments and the selection ─────────────────────────────────────────── */

/** A valid segment index for `map`. */
export function clampSelection(map: readonly MeterSegment[], index: number): number {
  const n = normalizeMeterMap(map, false).length;
  return clamp(Number.isFinite(index) ? Math.floor(index) : 0, 0, n - 1);
}

/** The segment under `step`; the pickup belongs to the first segment. */
export function segmentAtStep(map: readonly MeterSegment[], step: number, pickupSteps = 0): number {
  return segmentIndexAt(map, Math.max(0, barAt(map, step, pickupSteps).bar));
}

/** Segment `index`'s bars, 1-based: "5-6", "7" for one bar, "7+" for the last segment, which runs on to the end. */
export function segmentLabel(map: readonly MeterSegment[], index: number, totalSteps: number, pickupSteps = 0): string {
  const segs = normalizeMeterMap(map, false);
  const i = clampSelection(segs, index);
  const { first, last } = segmentBars(segs, i, totalSteps, pickupSteps);
  if (i === segs.length - 1) return `${first + 1}+`;
  return first === last ? `${first + 1}` : `${first + 1}-${last + 1}`;
}

/** The map after an edit and the segment selected with it. */
export interface MeterEdit { meterMap: MeterSegment[]; selected: number }

/**
 * The bar ADD starts a change at: the playhead's bar, moved on past every bar
 * that already starts a change. The playhead in the selected segment's first
 * bar starts it at the next bar, and an ADD never replaces another change.
 */
export function addChangeBar(map: readonly MeterSegment[], step: number, pickupSteps = 0): number {
  const segs = normalizeMeterMap(map, false);
  const starts = new Set(segs.map((s) => s.bar));
  let bar = Math.max(0, barAt(segs, step, pickupSteps).bar);
  while (starts.has(bar)) bar += 1;
  return bar;
}

/** True when the ADD bar starts at or past the roll's end, where a change holds no steps and GEN writes nothing. */
export function addChangePastEnd(map: readonly MeterSegment[], step: number, pickupSteps: number, totalSteps: number): boolean {
  return barStartStep(map, addChangeBar(map, step, pickupSteps), pickupSteps) >= totalSteps - EPS;
}

/** ADD: a change with the selected segment's meter at the ADD bar, kept apart from its twin, and selected. */
export function addChange(map: readonly MeterSegment[], selected: number, step: number, pickupSteps = 0): MeterEdit {
  const segs = normalizeMeterMap(map, false);
  const meter = segs[clampSelection(segs, selected)].meter;
  const bar = addChangeBar(segs, step, pickupSteps);
  const meterMap = setMeterAt(segs, bar, meter, false);
  return { meterMap, selected: segmentIndexAt(meterMap, bar) };
}

/** The selected segment with `patch` applied; groups that no longer sum to the numerator are dropped. */
export function editMeter(map: readonly MeterSegment[], selected: number, patch: Partial<Meter>): MeterEdit {
  const segs = normalizeMeterMap(map, false);
  const i = clampSelection(segs, selected);
  const meterMap = setMeterAt(segs, segs[i].bar, { ...segs[i].meter, ...patch }, false);
  return { meterMap, selected: i };
}

/**
 * BEATS: the numerator, 1..32. The groups clear, as LOOM's meter editor clears
 * them, except that a compound meter starts in threes (6/8 is 3+3), so its
 * accents land on the dotted beats.
 */
export function setBeats(map: readonly MeterSegment[], selected: number, num: number): MeterEdit {
  const segs = normalizeMeterMap(map, false);
  const n = clamp(Math.round(num), BEATS_MIN, BEATS_MAX);
  return editMeter(segs, selected, { num: n, groups: defaultGroups(n, segs[clampSelection(segs, selected)].meter.den) });
}

/** UNIT: the denominator. Groups the meter has stay; a meter with none that becomes compound starts in threes. */
export function setUnit(map: readonly MeterSegment[], selected: number, den: number): MeterEdit {
  const segs = normalizeMeterMap(map, false);
  const meter = segs[clampSelection(segs, selected)].meter;
  return editMeter(segs, selected, { den, ...(meter.groups.length > 1 ? {} : { groups: defaultGroups(meter.num, den) }) });
}

export const setGroups = (map: readonly MeterSegment[], selected: number, groups: readonly number[]): MeterEdit =>
  editMeter(map, selected, { groups: [...groups] });

/** REMOVE: drop the selected change and select the segment that now holds its bars; null on bar 1. */
export function removeChange(map: readonly MeterSegment[], selected: number): MeterEdit | null {
  const segs = normalizeMeterMap(map, false);
  const bar = segs[clampSelection(segs, selected)].bar;
  if (bar <= 0) return null;
  const meterMap = removeChangeAt(segs, bar);
  return { meterMap, selected: segmentIndexAt(meterMap, bar) };
}

/** The select's value for a grouping: "3+2+2", or "" for even. */
export const groupsValue = (groups: readonly number[]): string => (groups.length > 1 ? groups.join('+') : '');
export const parseGroupsValue = (value: string): number[] => (value ? value.split('+').map(Number) : []);

/**
 * The grouping field's text as groups for `meter`: "3+3+2+1" gives the
 * groups, and a sum that differs from the numerator gives the numerator with
 * them (typing 2+2+3 into 4/8 makes 7/8 2+2+3). "" or one number is Even.
 * Null for text that is not whole numbers joined by "+", or that sums past
 * BEATS_MAX.
 */
export function parseGroupingText(text: string, meter: Meter): { num: number; groups: number[] } | null {
  const t = text.replace(/\s+/g, '');
  if (!t) return { num: meter.num, groups: [] };
  if (!/^\d+(\+\d+)*$/.test(t)) return null;
  const parts = t.split('+').map(Number);
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum < BEATS_MIN || sum > BEATS_MAX || !parseGroups(t, sum)) return null;
  return { num: sum, groups: parts.length > 1 ? parts : [] };
}

/** GROUPING field: the typed grouping applied to the selected segment, or null (the text is kept for the user to fix). */
export function setGroupingText(map: readonly MeterSegment[], selected: number, text: string): MeterEdit | null {
  const segs = normalizeMeterMap(map, false);
  const parsed = parseGroupingText(text, segs[clampSelection(segs, selected)].meter);
  return parsed ? editMeter(segs, selected, parsed) : null;
}

/* ── the pickup ─────────────────────────────────────────────────────────── */

/**
 * PICKUP steps by one unit of the first meter (an 8th in 6/8, a quarter in
 * 4/4), and by a half step with Shift, from none up to one unit short of a
 * full bar, the store's half-step grid and its 64-step cap. Returns the new
 * pickup in steps.
 */
export function stepPickup(map: readonly MeterSegment[], pickupSteps: number, dir: -1 | 1, fine: boolean): number {
  const first = normalizeMeterMap(map, false)[0].meter;
  const unit = fine ? 0.5 : Math.max(0.5, 16 / first.den);
  const max = pickupMax(map);
  const now = clamp(Number.isFinite(pickupSteps) ? pickupSteps : 0, 0, max);
  // From an off-unit pickup the first press lands on the unit grid.
  const next = dir > 0 ? Math.floor(now / unit + EPS) * unit + unit : Math.ceil(now / unit - EPS) * unit - unit;
  return clamp(Math.round(next * 2) / 2, 0, max);
}

/** The longest pickup: half a step short of a full bar of the first meter, and at most 64 steps. */
export const pickupMax = (map: readonly MeterSegment[]): number =>
  Math.max(0, Math.min(64, stepsPerBar(normalizeMeterMap(map, false)[0].meter) - 0.5));

/** The PICKUP readout: "Off", or the pickup as a fraction of a whole note in lowest terms ("1/2", "3/8", "5/32"). */
export function pickupLabel(pickupSteps: number): string {
  if (!(pickupSteps > EPS)) return 'Off';
  // Steps are 16ths and the store keeps half steps, so the pickup is a whole number of 32nds.
  const num = Math.round(pickupSteps * 2);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(num, 32);
  return `${num / g}/${32 / g}`;
}

/** GROUPS: Even plus LOOM's partitions of the numerator, and the meter's own grouping when those miss it. */
export function groupChoices(meter: Meter): Array<{ value: string; label: string }> {
  const out = partitions(meter.num).map((g) => ({ value: groupsValue(g), label: g.length > 1 ? g.join('+') : 'Even' }));
  const own = groupsValue(meter.groups);
  if (!out.some((c) => c.value === own)) out.push({ value: own, label: own });
  return out;
}

/* ── lanes ──────────────────────────────────────────────────────────────── */

/** The loop a new lane gets: one bar of the first meter. */
export const newLaneCycle = (map: readonly MeterSegment[]): number =>
  Math.max(1, Math.round(stepsPerBar(normalizeMeterMap(map, false)[0].meter)));

/**
 * LOOP: one step, or one bar of `barSteps` with Shift. A lane with no loop
 * counts as the whole roll; reaching the roll's length stops the loop (null).
 * A shorter loop always loops: from a loop at or past the roll's length it
 * lands one step inside the roll.
 */
export function stepLoop(cycle: number | null, dir: -1 | 1, byBar: boolean, barSteps: number, totalSteps: number): number | null {
  const total = Math.max(1, Math.floor(totalSteps));
  const by = byBar ? Math.max(1, Math.round(barSteps)) : 1;
  if (dir < 0) return clamp(Math.min(Math.round(cycle ?? total), total) - by, 1, Math.max(1, total - 1));
  const next = clamp(Math.round(cycle ?? total) + by, 1, total);
  return next >= total ? null : next;
}

export type LaneForm = 'solid' | 'outline' | 'stripe' | 'hatch' | 'stripe45';
const INACTIVE_FORMS: readonly LaneForm[] = ['outline', 'stripe', 'hatch', 'stripe45'];

/** Each lane's look in the roll (PianoRoll.tsx's lane forms): the active lane solid, the rest by rank among the inactive lanes. */
export function laneForms(lanes: readonly PolyLane[], activeLane: number): Map<number, LaneForm> {
  const out = new Map<number, LaneForm>();
  let rank = 0;
  for (const l of lanes) {
    if (l.id === activeLane) out.set(l.id, 'solid');
    else out.set(l.id, INACTIVE_FORMS[rank++ % INACTIVE_FORMS.length]);
  }
  return out;
}

/* ── GEN ────────────────────────────────────────────────────────────────── */

/**
 * Semitones above the root for each Virtuoso mode: the W/H step strings of
 * arpEngine's MusicalScale dictionary, written out. arpEngine itself loads the
 * soundfont player, which this pure module keeps out of its imports.
 */
const MODE_STEPS: Record<string, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  melodic: [0, 2, 3, 5, 7, 9, 11],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
};

/** The scale of `key` and `mode` for one octave up from the root nearest middle C (60): the pitches GEN's symbols play. A mode the table lacks plays major. */
export function lanePitches(key: string, mode: string): number[] {
  const pc = pitchClass(key) ?? 0;
  const root = 60 + (pc <= 6 ? pc : pc - 12);
  return (MODE_STEPS[mode] ?? MODE_STEPS.major).map((s) => root + s);
}

export type GateChoice = { kind: 'open' } | GenGate;

export interface GenSettings {
  kind: GenKind;
  /** The rule's options; string options (fractal kind, life rule) pass through. */
  opts: GenOpts;
  /** Rule steps in one pass. */
  steps: number;
  gate: GateChoice;
  seed: number;
}

export interface GenOptSpec { key: string; legend: string; title: string; step: number; min: number; max: number }

const OPT_SPECS: Record<string, Omit<GenOptSpec, 'key'>> = {
  hits: { legend: 'Hits', title: 'Hits: notes spread as evenly as possible across the steps', step: 1, min: 0, max: 64 },
  steps: { legend: 'Steps', title: 'Steps: rule steps in one pass, spread across the pass', step: 1, min: 1, max: 256 },
  rotate: { legend: 'Rotate', title: 'Rotate: steps the pattern turns on each pass', step: 1, min: -32, max: 32 },
  drift: { legend: 'Drift', title: 'Drift: steps the sequence moves on each pass', step: 1, min: -8, max: 8 },
  depth: { legend: 'Depth', title: 'Depth: levels of the rule', step: 1, min: 0, max: 8 },
  density: { legend: 'Density', title: 'Density: share of live cells in the first generation', step: 0.05, min: 0, max: 1 },
  rows: { legend: 'Rows', title: 'Rows: rows of the Life grid; 0 gives one row per pitch', step: 1, min: 0, max: 16 },
  p: { legend: 'Odds', title: 'Odds: the chance a cell plays', step: 0.05, min: 0, max: 1 },
  size: { legend: 'Size', title: 'Size: beats in one fragment', step: 1, min: 1, max: 8 },
  every: { legend: 'Every', title: 'Every: steps between an echo and its repeat', step: 1, min: 1, max: 16 },
  decay: { legend: 'Decay', title: 'Decay: dB each repeat drops', step: 1, min: 0, max: 24 },
  curve: { legend: 'Curve', title: 'Curve: the shape of the sweep; 1 is straight', step: 0.25, min: 0.25, max: 4 },
};

const KIND_SPECS: Partial<Record<GenKind, Record<string, Partial<Omit<GenOptSpec, 'key'>>>>> = {
  fractal: { depth: { min: 1, title: 'Depth: levels of the Cantor dust' } },
  echo: { depth: { title: 'Depth: repeats after each echo' } },
  accel: {
    from: { legend: 'From', title: 'From: the speed at the start of the pass', step: 0.25, min: 0.25, max: 4 },
    to: { legend: 'To', title: 'To: the speed at the end of the pass', step: 0.25, min: 0.25, max: 4 },
  },
  gliss: {
    from: { legend: 'From', title: 'From: semitones at the start of the pass', step: 1, min: -24, max: 24 },
    to: { legend: 'To', title: 'To: semitones at the end of the pass', step: 1, min: -24, max: 24 },
  },
};

/** The steppers a rule's menu shows: hits, steps and rotate for euclid; every other rule's numeric options, then steps. */
export function genOptionSpecs(kind: GenKind): GenOptSpec[] {
  const spec = (key: string): GenOptSpec | null => {
    const s = { ...OPT_SPECS[key], ...KIND_SPECS[kind]?.[key] };
    return typeof s.step === 'number' && s.legend ? ({ key, ...s } as GenOptSpec) : null;
  };
  const keys = kind === 'euclid'
    ? ['hits', 'steps', 'rotate']
    : [...Object.entries(GEN_DEFAULT_OPTS[kind]).filter(([, v]) => typeof v === 'number').map(([k]) => k), 'steps'];
  return keys.map(spec).filter((s): s is GenOptSpec => s !== null);
}

/** One stepper press: on the spec's step grid, inside its range. */
export function stepOption(value: number, spec: Pick<GenOptSpec, 'step' | 'min' | 'max'>, dir: -1 | 1): number {
  const next = Math.round((value + dir * spec.step) / spec.step) * spec.step;
  return Math.round(clamp(next, spec.min, spec.max) * 1e4) / 1e4;
}

export const formatOption = (value: number, spec: Pick<GenOptSpec, 'key' | 'step'>): string =>
  spec.key === 'rows' && value === 0 ? 'Auto' : spec.step < 1 ? String(Math.round(value * 100) / 100) : String(value);

/** Where a WRITE lands. */
export interface GenTarget {
  lane: number;
  name: string;
  /** First roll step written, and the step after the last. */
  start: number;
  end: number;
  /** Roll steps in one rule pass, and how many passes. */
  passLen: number;
  passes: number;
  /** The lane's loop when it loops. */
  cycle: number | null;
  /** Bars written (0-based) when the target is a segment's bars. */
  bars: { first: number; last: number } | null;
  /** The segment's meter, whose group starts GEN accents. */
  meter: Meter | null;
}

type RollShape = { meterMap: MeterSegment[]; pickupSteps: number; lanes: PolyLane[]; activeLane: number; totalSteps: number };

/** A looping lane gets one cycle from step 0; any other lane gets the selected segment's bars, one pass per bar. */
export function genTarget(roll: RollShape, selected: number): GenTarget {
  const lane = roll.lanes.find((l) => l.id === roll.activeLane) ?? roll.lanes[0] ?? { id: 0, name: 'A', cycleSteps: null };
  const cycle = lane.cycleSteps;
  if (lane.id !== 0 && cycle != null && cycle > 0 && cycle < roll.totalSteps) {
    return { lane: lane.id, name: lane.name, start: 0, end: cycle, passLen: cycle, passes: 1, cycle, bars: null, meter: null };
  }
  const segs = normalizeMeterMap(roll.meterMap, false);
  const i = clampSelection(segs, selected);
  const bars = segmentBars(segs, i, roll.totalSteps, roll.pickupSteps);
  const start = barStartStep(segs, bars.first, roll.pickupSteps);
  const passLen = stepsPerBar(segs[i].meter);
  const passes = bars.last - bars.first + 1;
  return { lane: lane.id, name: lane.name, start, end: start + passes * passLen, passLen, passes, cycle: null, bars, meter: segs[i].meter };
}

const ruleOf = (s: GenSettings, symbols: number): RuleNode => ({
  kind: 'rule', id: 'gen', gen: s.kind, steps: Math.max(1, Math.round(s.steps)), symbols: Math.max(1, symbols), opts: s.opts,
});

const gateOf = (g: GateChoice): GenGate | undefined => (g.kind === 'open' ? undefined : g);

/** The first pass's rule steps, the gate applied: true where a note starts. */
export function genPreview(s: GenSettings, pitches: readonly number[], lane = 0): boolean[] {
  const rule = ruleOf(s, pitches.length);
  const out = new Array<boolean>(rule.steps).fill(false);
  const notes = renderGen(rule, pitches, { startStep: 0, stepLen: 1, laps: 1, seed: s.seed, baseVel: GEN_VELOCITY, lane, gate: gateOf(s.gate) });
  for (const n of notes) out[Math.round(n.step)] = true;
  return out;
}

/**
 * `notes` with `lane`'s notes in [start, end) swapped for `fresh`. With a
 * `cycle`, a note's place is its step within the cycle, since a looping lane
 * plays every note it holds inside its first cycle. Lane 0 notes carry no lane.
 */
export function replaceLaneNotes(
  notes: readonly PianoNote[], lane: number, start: number, end: number, fresh: readonly RollNote[], idPrefix: string, cycle: number | null = null,
): PianoNote[] {
  const at = (step: number) => (cycle ? ((step % cycle) + cycle) % cycle : step);
  const kept = notes.filter((n) => !((n.lane ?? 0) === lane && at(n.step) >= start - EPS && at(n.step) < end - EPS));
  const added = fresh.map((n, i) => {
    const { lane: _drop, ...rest } = n;
    return { ...rest, ...(lane !== 0 ? { lane } : {}), id: `${idPrefix}-${i}` };
  });
  return [...kept, ...added];
}

/** WRITE: the rule rendered into the target, replacing the lane's notes there. */
export function genWrite(
  roll: RollShape & { notes: PianoNote[] }, selected: number, s: GenSettings, pitches: readonly number[], idPrefix: string,
): { notes: PianoNote[]; written: number; target: GenTarget } {
  const target = genTarget(roll, selected);
  const rule = ruleOf(s, pitches.length);
  let fresh = renderGen(rule, pitches, {
    startStep: target.start,
    stepLen: target.passLen / rule.steps,
    laps: target.passes,
    seed: s.seed,
    baseVel: GEN_VELOCITY,
    lane: target.lane,
    meter: target.meter ?? undefined,
    gate: gateOf(s.gate),
  });
  if (s.kind === 'accel') {
    const from = Number(s.opts.from ?? 1);
    const to = Number(s.opts.to ?? 2);
    const curve = Number(s.opts.curve ?? 1);
    for (let k = 0; k < target.passes; k += 1) fresh = accelSpan(fresh, target.start + k * target.passLen, target.passLen, from, to, curve);
  }
  const stop = Math.min(target.end, roll.totalSteps);
  fresh = fresh.filter((n) => n.step < stop - EPS).map((n) => ({ ...n, length: Math.min(n.length, stop - n.step) }));
  return {
    notes: replaceLaneNotes(roll.notes, target.lane, target.start, target.end, fresh, idPrefix, target.cycle),
    written: fresh.length,
    target,
  };
}

export const genStatus = (written: number, laneName: string): string =>
  written === 0
    ? `GEN WROTE NO NOTES IN LANE ${laneName.toUpperCase()}. ADD HITS OR OPEN THE GATE.`
    : `GEN WROTE ${written} NOTE${written === 1 ? '' : 'S'} IN LANE ${laneName.toUpperCase()}.`;

/* ── MATCH ──────────────────────────────────────────────────────────────── */

export interface MatchApply {
  meterMap: MeterSegment[];
  pickupSteps: number;
  bpm: number | null;
  /** The song's lanes, given only when the roll holds lane A alone. */
  lanes: PolyLane[] | null;
}

export interface MatchResult { apply: MatchApply | null; status: string; level: 'info' | 'warn' | 'error' }

const joinParts = (parts: string[]): string =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} AND ${parts[parts.length - 1]}`;

/** What MATCH writes from a rhythm analysis, and the status line that says so. The roll's `bpm` places the pickup when the analysis has no tempo. */
export function matchApply(roll: { lanes: readonly PolyLane[]; bpm: number }, analysis: RhythmAnalysis): MatchResult {
  if (analysis.status !== 'ready') {
    return { apply: null, status: 'THE RHYTHM ANALYSIS IS STILL RUNNING. PRESS MATCH AGAIN WHEN IT FINISHES.', level: 'warn' };
  }
  const seed = seedFromRhythm(analysis, roll.bpm);
  if (!seed) return { apply: null, status: 'THE RHYTHM ANALYSIS HAS NO METER. ANALYZE THE SONG AGAIN, THEN PRESS MATCH.', level: 'warn' };
  // A whole number: the BPM field shows and steps whole beats per minute.
  const bpm = seed.bpm != null ? clamp(Math.round(seed.bpm), 40, 240) : null;
  const addLanes = roll.lanes.length <= 1 && seed.lanes.length > 1;
  const apply: MatchApply = { meterMap: seed.meterMap, pickupSteps: seed.pickupSteps, bpm, lanes: addLanes ? seed.lanes : null };

  const changes = seed.meterMap.length;
  const parts = [changes === 1 ? `${meterLabel(seed.meterMap[0].meter)} THROUGHOUT` : `${changes} METERS`];
  parts.push(seed.pickupSteps > 0 ? `A ${seed.pickupSteps}-STEP PICKUP` : 'NO PICKUP');
  if (bpm != null) parts.push(`${bpm} BPM`);
  if (addLanes) parts.push(`${seed.lanes.length - 1} LANE${seed.lanes.length === 2 ? '' : 'S'}`);
  let status = `MATCH SET ${joinParts(parts)}.`;
  if (!addLanes && seed.lanes.length > 1) status += ' THE ROLL KEPT ITS OWN LANES.';
  if (seed.uncertainBars > 0) status += ` ${seed.uncertainBars} BAR${seed.uncertainBars === 1 ? ' IS' : 'S ARE'} UNCERTAIN.`;
  let level: MatchResult['level'] = 'info';
  if (!seed.tempoStable) {
    status += " THE SONG'S TEMPO MOVES, SO BAR LINES DRIFT FROM THE NOTES.";
    level = 'warn';
  }
  return { apply, status, level };
}

/**
 * A failed MATCH as a status line. fetchRhythm's errors carry the HTTP status:
 * a 404 is a song the library does not hold, and a 502, 503 or 504 is the dev
 * proxy with no backend behind it.
 */
export function matchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'MATCH COULD NOT REACH THE BACKEND. START THE BACKEND AND PRESS MATCH AGAIN.';
  const code = Number(/failed with (\d{3})/.exec(msg)?.[1] ?? 0);
  if (code === 404) return 'MATCH FOUND NO SUCH SONG IN THE LIBRARY. CHOOSE THE SONG FROM THE LIST, THEN PRESS MATCH.';
  if (code === 502 || code === 503 || code === 504) return 'THE BACKEND IS NOT ANSWERING. START THE BACKEND AND PRESS MATCH AGAIN.';
  return `MATCH FAILED: ${msg.replace(/[.\s]+$/, '').toUpperCase()}. ANALYZE THE SONG, THEN PRESS MATCH AGAIN.`;
}

/* ── FORM section meters ────────────────────────────────────────────────── */

/** Meter text as the ruler prints it: "7/8 3+2+2", "4/4". */
export const meterLabel = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` ${m.groups.join('+')}` : ''}`;

const m = (num: number, den: number, groups: number[] = []): Meter => ({ num, den, groups });

/** The meters the FORM editor offers a section; "" is the roll's own map. */
export const SECTION_METERS: readonly Meter[] = [
  m(4, 4), m(3, 4), m(2, 4), m(2, 2), m(3, 2), m(6, 8, [3, 3]), m(9, 8, [3, 3, 3]), m(5, 4), m(5, 8),
  m(7, 8, [3, 2, 2]), m(7, 8, [2, 2, 3]), m(9, 8, [2, 2, 2, 3]), m(11, 8, [3, 3, 3, 2]), m(12, 8, [3, 3, 3, 3]),
];

/** The FORM select's options for a section: the list, plus the section's own meter when the list lacks it. */
export function sectionMeterChoices(current: Meter | undefined): Array<{ value: string; label: string }> {
  const out = SECTION_METERS.map((x) => ({ value: meterLabel(x), label: meterLabel(x) }));
  if (current && !out.some((c) => c.value === meterLabel(current))) out.push({ value: meterLabel(current), label: meterLabel(current) });
  return out;
}

/** The meter a FORM select value names, or null for "Roll". */
export function parseMeterLabel(value: string): Meter | null {
  const hit = /^(\d+)\/(\d+)(?: (\d+(?:\+\d+)+))?$/.exec(value.trim());
  if (!hit) return null;
  return m(Number(hit[1]), Number(hit[2]), hit[3] ? hit[3].split('+').map(Number) : []);
}
