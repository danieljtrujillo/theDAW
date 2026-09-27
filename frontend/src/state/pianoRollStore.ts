import { create } from 'zustand';
import { normalizeMeterMap, roundUpToBar, type MeterSegment, type PolyLane } from '../lib/meterMap';
import {
  DEFAULT_BEND_RANGE,
  MAX_BENT_LANES,
  bentLanes,
  capBentLanes,
  clampBendRange,
  sanitizeBendPoints,
  sanitizeBends,
  type BendPoint,
  type BendPointInput,
  type LaneBend,
} from '../lib/pitchBend';
// lib/rollSelection imports only the PianoNote TYPE back from here, which is
// erased at compile, so this is a one-way runtime dependency.
import { clampVelocity } from '../lib/rollSelection';

/**
 * Per-note expression — the three MPE dimensions a note can carry on its own,
 * independent of its channel's wheel. The roll only STORES these; nothing plays
 * or writes them yet (that is #42). Ranges are fixed here so every later reader
 * agrees: `pressure` and `timbre` are 0..1, `pitchBend` is -1..1 of whatever
 * bend range the note's channel is in.
 */
export interface NoteExpression {
  /** Aftertouch / channel pressure, 0..1. */
  pressure?: number;
  /** The third MPE dimension (CC 74 "timbre" / slide), 0..1. */
  timbre?: number;
  /** Bend at the note, -1..1 of its channel's range. */
  pitchBend?: number;
}

export interface PianoNote {
  id: string;
  /** MIDI note number (0-127). 60 = middle C. */
  note: number;
  /**
   * Where the note starts, in 16th-note steps from 0. DERIVED from `tick`:
   * every write goes to `tick` first and this is recomputed as
   * `tick / ticksPerStep()`. It keeps its fraction, so a swung or off-grid note
   * reads back at its real place. Kept for one release because a long tail of
   * callers still reads (and writes) steps.
   */
  step: number;
  /** Length in steps. DERIVED from `ticks`, exactly as `step` is from `tick`. */
  length: number;
  velocity: number;
  /** Polymeter lane id (see `lanes`). Absent means lane 0, which spans the whole roll. */
  lane?: number;
  /**
   * THE position: ticks from the roll's start at `PPQ` ticks to the quarter
   * note. Whole, never negative.
   *
   * Optional ONLY because a couple of dozen note-building call sites outside
   * this module still construct notes from `step`/`length` alone. Every note
   * the STORE holds has it: each list coming in goes through `withTicks`, which
   * migrates a tick-less note (`tick = step × ticksPerStep`) and re-ticks a note
   * whose `step` was rewritten behind the model's back (a paste, a lane unroll,
   * a virtuoso transform). Read it through `noteTick` rather than directly if
   * the note might not have come from the store.
   */
  tick?: number;
  /** THE length, in ticks at `PPQ`. Whole and at least 1. See `tick`. */
  ticks?: number;
  /** MIDI channel 1-16 (NOT the 0-15 wire value). Absent means "no channel of its own". */
  channel?: number;
  /** Per-note expression; absent when the note carries none. */
  expr?: NoteExpression;
}

/** The roll's meter: time signatures by bar, the pickup before bar 0, and the polymeter lanes. */
export interface RollMeter {
  meterMap: MeterSegment[];
  pickupSteps: number;
  lanes: PolyLane[];
}

interface PianoRollState {
  notes: PianoNote[];
  bpm: number;
  /** Total grid length in 16th-note steps. */
  totalSteps: number;
  /** Lowest and highest MIDI note numbers in view (inclusive). */
  lowestNote: number;
  highestNote: number;
  /** Every selected note, in the order the selection took them (so the last one
   *  in is the primary). Replaced whole on every change, never mutated. */
  selectedIds: Set<string>;
  /**
   * The PRIMARY selected note — the newest one in `selectedIds`, or null with
   * nothing selected. DERIVED: it is written only by the selection helper that
   * writes `selectedIds`, never on its own, so the two can never disagree. It
   * stays for one release so callers that only ever meant "the one selected
   * note" keep working; new code reads `selectedIds`.
   */
  selectedNoteId: string | null;
  isPlaying: boolean;
  currentStep: number;
  /** If set, the roll is editing an existing editor clip — next "send to editor" updates that clip in place. */
  editingClipId: string | null;
  /** Step span of the most recent live recording, highlighted in the grid; null
   *  when no recording has been placed. */
  recordedRange: { startStep: number; endStep: number } | null;
  /** Time signatures by bar (lib/meterMap). Always starts at bar 0. */
  meterMap: MeterSegment[];
  /** Steps before bar 0 (a pickup); 0 when the roll starts on a downbeat. */
  pickupSteps: number;
  /** Polymeter lanes. Lane 0 always exists and never loops. */
  lanes: PolyLane[];
  /** The lane new notes go into. */
  activeLane: number;
  /**
   * Pitch bend by lane (lib/pitchBend): each lane's points and range, sorted by
   * lane. A lane with no points and the default range has no entry. A bend
   * moves with its lane and keeps its steps through meter and length changes,
   * as notes do. At most MAX_BENT_LANES lanes have points.
   */
  bends: LaneBend[];
  /**
   * The timing feel the roll's Q and SWING controls hold, 0-100 and -50..50.
   * They belong to the roll rather than to the control that shows them: a tab
   * switch used to reset both to 100 / 0, so the amount someone dialled in was
   * gone the next time they came back. Persisted (localStorage) so a reload
   * keeps them too. They are NOT undo history — they are a setting, not an
   * edit; what they DO to the notes (applyTimingFeel's one replaceAll) is the
   * undoable part.
   */
  quantizePct: number;
  swingPct: number;
  /**
   * The groove template the roll's feel applies, by id (`lib/grooveTemplate`).
   * It sits beside Q and SWING for the same reason they do — it is a setting,
   * not an edit — and rides in the same persisted record, so a tab switch or a
   * reload comes back to the feel someone chose.
   */
  grooveId: string;

  setBpm: (bpm: number) => void;
  setTotalSteps: (s: number) => void;
  setRange: (lo: number, hi: number) => void;
  addNote: (note: Omit<PianoNote, 'id'>) => string;
  removeNote: (id: string) => void;
  updateNote: (id: string, patch: Partial<PianoNote>) => void;
  /** Select exactly `id`, or nothing. The one-note form of `setSelection`. */
  setSelectedNote: (id: string | null) => void;
  /** Replace the selection. Ids with no note are dropped; `primary` takes the
   *  primary slot when it survives, otherwise the last surviving id does. */
  setSelection: (ids: Iterable<string>, primary?: string | null) => void;
  /** Add to the selection, keeping what is already there. The last id added becomes primary. */
  addToSelection: (ids: Iterable<string>) => void;
  /** In or out: a selected note leaves the selection, an unselected one joins it as primary. */
  toggleSelection: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  /**
   * Move every selected note by `dSteps` steps and `dNotes` semitones. The
   * DELTA is clamped, not each note, so the selection keeps its shape and stops
   * against the roll's edges as one block; only the direction of travel is
   * limited, so a note already outside the pitch range can still come back.
   */
  nudgeSelected: (dSteps: number, dNotes: number) => void;
  /** Set `ids` to one velocity, clamped 1-127. */
  setVelocity: (ids: Iterable<string>, velocity: number) => void;
  /** Multiply the velocity of `ids`, clamped 1-127. */
  scaleVelocity: (ids: Iterable<string>, factor: number) => void;
  /** Quantize amount, 0-100; persisted. */
  setQuantizePct: (pct: number) => void;
  /** Swing/rag amount, -50..50; persisted. */
  setSwingPct: (pct: number) => void;
  /** The groove template id the feel applies; persisted. Blank falls back to the default. */
  setGrooveId: (id: string) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentStep: (s: number) => void;
  replaceAll: (notes: PianoNote[]) => void;
  /**
   * Add `notes` in one write (one undo step) and select them, the first as the
   * primary. A note that runs past the roll's end grows the roll to the bar
   * line after it, up to MAX_ROLL_STEPS: a paste or a duplicate near the end
   * lands whole.
   */
  appendNotes: (notes: PianoNote[]) => void;
  clear: () => void;
  setEditingClip: (id: string | null) => void;
  /** Load an editor clip. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone.
   *  Opening a clip starts a new document: the undo and redo stacks empty, so an
   *  undo can never bring another clip's notes into this one. */
  loadFromClip: (
    clipId: string,
    notes: PianoNote[],
    bpm: number,
    totalSteps: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
  ) => void;
  /** Replace the grid with imported notes, auto-fitting length (to a bar line) AND
   *  pitch range to the content. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone. */
  importNotes: (notes: PianoNote[], bpm?: number, meter?: Partial<RollMeter>, bends?: readonly LaneBend[]) => void;
  /** Place a live recording WITHOUT shrinking the grid (keeps at least the 256
   *  default, rounded up to a bar), expanding the pitch range to fit, and marks the recorded span. */
  placeRecording: (notes: PianoNote[], range: { startStep: number; endStep: number }) => void;
  setMeterMap: (map: MeterSegment[]) => void;
  setPickupSteps: (steps: number) => void;
  setLanes: (lanes: PolyLane[]) => void;
  setActiveLane: (id: number) => void;
  /** Add a lane that loops every `cycleSteps` (null = the whole roll); returns its id. */
  addLane: (cycleSteps?: number | null) => number;
  /** Set a lane's loop length; lane 0 never loops. */
  setLaneCycle: (id: number, cycleSteps: number | null) => void;
  /** Remove a lane; its notes move to lane 0, and its bend too when lane 0 has no points. Lane 0 cannot be removed. */
  removeLane: (id: number) => void;
  /** Replace every lane's bend. A bend for a lane the roll does not have is dropped, and lanes past MAX_BENT_LANES lose their points. */
  setBends: (bends: readonly LaneBend[]) => void;
  /** Replace one lane's points (sorted, one per step, values clamped to -1..1). A lane without points takes none while MAX_BENT_LANES lanes bend. */
  setBendPoints: (lane: number, points: readonly BendPointInput[]) => void;
  /**
   * Add a point to a lane's curve, replacing a point at the same step. Returns the
   * new point's id, or null when the roll has no such lane, or when the lane has no
   * points while MAX_BENT_LANES lanes already bend (a MIDI file and the live synth
   * have no channel left for it).
   */
  addBendPoint: (lane: number, point: Omit<BendPointInput, 'id'>) => string | null;
  /** Move, re-value or re-shape a point. Landing on another point's step replaces that point. */
  moveBendPoint: (lane: number, id: string, patch: Partial<Omit<BendPoint, 'id'>>) => void;
  removeBendPoint: (lane: number, id: string) => void;
  /** Remove a lane's points, or every lane's when `lane` is left out. Ranges stay. */
  clearBend: (lane?: number) => void;
  /** Set a lane's bend range in semitones (0-48, to the cent). */
  setBendRange: (lane: number, semitones: number) => void;
  /** Write any of the meter map, pickup and lanes, then round the roll's length
   *  up to a bar line. `merge` false keeps a change that repeats the meter before
   *  it (the METER face's ADD). setMeterMap and setPickupSteps go through here.
   *  Lanes given take the bends of lanes that go with them, and a lane that
   *  arrives starts unbent (MATCH, and the METER face's ADD LANE). */
  applyMeter: (meter: Partial<RollMeter>, merge?: boolean) => void;

  // Undo / redo. Snapshots capture the document slices below; because every
  // mutation replaces arrays immutably, a snapshot just references the prior
  // arrays (no cloning). Rapid bursts (a note drag, a bend drag) coalesce into
  // one step. _undo/_redo are exposed so the UI can reflect availability.
  _undo: RollHistorySnapshot[];
  _redo: RollHistorySnapshot[];
  undo: () => void;
  redo: () => void;
}

/** The document slices tracked by undo / redo.
 *  The meter, the lanes and the bends are part of what the roll IS, so they
 *  belong here. Selection, the playhead, transport, the active lane and the
 *  recorded range deliberately do NOT — they are view and transport
 *  state, and putting them in the stack makes undo unusable mid-session.
 *
 *  The linked clip rides along on one kind of step only: a write that changed
 *  the link together with the document (CLEAR empties the roll and unlinks).
 *  That step carries the link it replaced, so undoing it relinks the clip whose
 *  notes come back, and SAVE keeps writing those notes into their own clip. A
 *  link change on its own (a bounce binding a new clip, UNLINK) is not a step,
 *  and opening a clip empties both stacks (loadFromClip). */
interface RollHistorySnapshot {
  notes: PianoNote[];
  bpm: number;
  totalSteps: number;
  lowestNote: number;
  highestNote: number;
  meterMap: MeterSegment[];
  pickupSteps: number;
  lanes: PolyLane[];
  bends: LaneBend[];
  /** The linked clip before the step, present only when the step's write changed it. */
  editingClipId?: string | null;
}

const DEFAULT_STEPS = 256;

const MIN_STEPS = 16;
const MAX_STEPS = 4096; // ~256 bars; enough for full-song MIDI imports
/** The longest the roll grows: a paste past it leaves out the notes that start beyond it. */
export const MAX_ROLL_STEPS = MAX_STEPS;
const EPS = 1e-9;
const FULL_LOW = 21; // A0 — the full 88-key piano stays in view so the roll scrolls
const FULL_HIGH = 108; // C8

export const DEFAULT_LANES: readonly PolyLane[] = Object.freeze([{ id: 0, name: 'A', cycleSteps: null }]);

/** A, B, … Z, then AA, AB … */
export const laneName = (index: number): string => {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};

const clampCycle = (steps: number | null | undefined): number | null =>
  typeof steps === 'number' && Number.isFinite(steps) && steps >= 1 ? Math.min(MAX_STEPS, Math.round(steps)) : null;

/** Lane 0 first and never looping, unique ids, cycles clamped to whole steps. */
export const sanitizeLanes = (lanes: readonly PolyLane[] | null | undefined): PolyLane[] => {
  const seen = new Set<number>();
  const out: PolyLane[] = [];
  for (const l of lanes ?? []) {
    if (!l || !Number.isInteger(l.id) || l.id < 0 || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({ id: l.id, name: String(l.name || laneName(l.id)), cycleSteps: l.id === 0 ? null : clampCycle(l.cycleSteps) });
  }
  if (!seen.has(0)) out.unshift({ id: 0, name: 'A', cycleSteps: null });
  return out.sort((a, b) => a.id - b.id);
};

const clampPickup = (steps: number | undefined, fallback: number): number =>
  typeof steps === 'number' && Number.isFinite(steps) ? Math.max(0, Math.min(64, Math.round(steps * 2) / 2)) : fallback;

/** The meter fields a load or import ends with: each one given replaces the current one. */
const mergeMeter = (s: Pick<PianoRollState, 'meterMap' | 'pickupSteps' | 'lanes' | 'activeLane'>, meter?: Partial<RollMeter>) => {
  const lanes = meter?.lanes ? sanitizeLanes(meter.lanes) : s.lanes;
  return {
    meterMap: meter?.meterMap ? normalizeMeterMap(meter.meterMap) : s.meterMap,
    pickupSteps: clampPickup(meter?.pickupSteps, s.pickupSteps),
    lanes,
    activeLane: lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
  };
};

const hasLane = (lanes: readonly PolyLane[], id: number): boolean => lanes.some((l) => l.id === id);

/** `bends` with only the lanes in `lanes`. */
const bendsForLanes = (bends: readonly LaneBend[], lanes: readonly PolyLane[]): LaneBend[] =>
  bends.filter((b) => hasLane(lanes, b.lane));

/** `bends` of the lanes in both `before` and `after`: a lane that goes takes its bend, and a lane that arrives starts unbent, whatever a lane with its id once had. */
const bendsAcrossLanes = (bends: readonly LaneBend[], before: readonly PolyLane[], after: readonly PolyLane[]): LaneBend[] =>
  bends.filter((b) => hasLane(before, b.lane) && hasLane(after, b.lane));

/** True when lane `lane` may take points: it bends already, or fewer than MAX_BENT_LANES lanes do. */
const mayBend = (s: Pick<PianoRollState, 'lanes' | 'bends'>, lane: number): boolean => {
  const bent = bentLanes(s.lanes, s.bends);
  return bent.has(lane) || bent.size < MAX_BENT_LANES;
};

/**
 * `bends` with lane `lane` rewritten by `edit`, which gets the lane's bend (an
 * empty one at the default range when it has none). Other lanes keep their
 * objects; an edit that leaves no points and the default range removes the entry.
 */
const withLaneBend = (bends: readonly LaneBend[], lane: number, edit: (b: LaneBend) => Partial<LaneBend>): LaneBend[] => {
  const current = bends.find((b) => b.lane === lane) ?? { lane, range: DEFAULT_BEND_RANGE, points: [] };
  const patch = edit(current);
  const next: LaneBend = {
    lane,
    range: clampBendRange(patch.range ?? current.range),
    points: patch.points ? sanitizeBendPoints(patch.points, `bp${lane}`) : current.points,
  };
  const others = bends.filter((b) => b.lane !== lane);
  const keep = next.points.length > 0 || next.range !== DEFAULT_BEND_RANGE;
  return (keep ? [...others, next] : others).sort((a, b) => a.lane - b.lane);
};

/** Every lane's points removed, ranges kept. */
const clearedBends = (bends: readonly LaneBend[]): LaneBend[] => sanitizeBends(bends.map((b) => ({ ...b, points: [] })));

/**
 * The bends a load or import that replaces the notes ends with: `incoming` for
 * the lanes the roll ends with (capped at MAX_BENT_LANES), or with none given,
 * the roll's own for the lanes it keeps with every point removed.
 */
const replacedBends = (
  s: Pick<PianoRollState, 'lanes' | 'bends'>,
  lanes: readonly PolyLane[],
  incoming: readonly LaneBend[] | undefined,
): LaneBend[] =>
  incoming ? capBentLanes(bendsForLanes(sanitizeBends(incoming), lanes), lanes) : clearedBends(bendsAcrossLanes(s.bends, s.lanes, lanes));

const uidBend = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `bp-${crypto.randomUUID()}` : `bp-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Fit grid LENGTH (snapped up to a bar line of the meter map) to a note set, and
 *  keep the full piano range in view (expanded if content goes beyond it) so
 *  vertical scrolling always works and notes are never cropped. */
const fitToNotes = (
  notes: PianoNote[],
  meterMap: MeterSegment[],
  pickupSteps: number,
): { totalSteps: number; lowestNote: number; highestNote: number } => {
  const lastStep = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  const totalSteps = Math.min(MAX_STEPS, roundUpToBar(meterMap, Math.max(MIN_STEPS, lastStep), pickupSteps));
  const lo = Math.max(0, Math.min(FULL_LOW, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2));
  const hi = Math.min(127, Math.max(FULL_HIGH, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2));
  return { totalSteps, lowestNote: lo, highestNote: hi };
};

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pn-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const seed = (): PianoNote[] => {
  // A short C-major arpeggio across two bars so the grid isn't empty on first load.
  const arr: PianoNote[] = [];
  const pitches = [60, 64, 67, 72, 67, 64, 60, 67]; // C E G C G E C G
  for (let i = 0; i < pitches.length; i += 1) {
    arr.push(withTicks({ id: uid(), note: pitches[i], step: i * 2, length: 2, velocity: 90 }));
  }
  return arr;
};

// ── Selection ────────────────────────────────────────────────────────────────

/** The selection slice: the set AND the primary it derives, which are only ever
 *  written together. `primary` wins the primary slot when it survives the
 *  filter; otherwise the newest surviving id does (a Set keeps insertion order). */
type SelectionSlice = Pick<PianoRollState, 'selectedIds' | 'selectedNoteId'>;

const selectionOf = (notes: readonly PianoNote[], ids: Iterable<string>, primary?: string | null): SelectionSlice => {
  const live = new Set(notes.map((n) => n.id));
  const selectedIds = new Set<string>();
  for (const id of ids) if (live.has(id)) selectedIds.add(id);
  let newest: string | null = null;
  for (const id of selectedIds) newest = id;
  return { selectedIds, selectedNoteId: primary != null && selectedIds.has(primary) ? primary : newest };
};

/** Nothing selected — a fresh Set each time, because the state's Sets are
 *  replaced rather than mutated and no two states may share one. */
const noSelection = (): SelectionSlice => ({ selectedIds: new Set<string>(), selectedNoteId: null });

// ── Note validation ──────────────────────────────────────────────────────────

/**
 * The shortest note a GESTURE makes, in steps: a click on an empty cell, a
 * resize drag, the note menu's Shorten. The grid cannot draw or grab a note
 * thinner than one cell by hand, so those gestures stop at one step.
 *
 * The MODEL's floor is one tick (`MIN_NOTE_TICKS`), however a length arrives:
 * as `ticks`, or as a `length` in steps from a caller that builds notes without
 * ticks — GEN, Virtuoso, sheet import, audio-to-notes, AI COMPOSE, a paste. A
 * two-thirds-step 16th triplet or a half-step 32nd is the intention there, and
 * raising it to a whole step would make every such run overlap the note after
 * it. A length missing altogether (not a number) is taken as one step.
 */
export const MIN_NOTE_LENGTH = 1;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── Ticks: the note model's clock ────────────────────────────────────────────
//
// Design source (design only — nothing copied): Tracktion Engine
// `modules/tracktion_engine/midi/tracktion_MidiNote.h` (GPL-3 / commercial),
// whose MidiNote keeps ONE authoritative musical position and length and hands
// out quantised positions as a computed view rather than writing them back.
// The same split here: `tick`/`ticks` are the note, `step`/`length` are the
// 16th-note view of it, and quantise never becomes the stored truth.

/**
 * Ticks to the quarter note. 960 is divisible by 3, 4, 5, 6, 8, 12, 16, 32 and
 * 64, so triplets, quintuplets and 64ths all land on whole ticks — which is why
 * finer quantise does not need another model change.
 */
export const PPQ = 960;

/** The roll's own grid: sixteenths, so four steps to the beat. */
export const ROLL_STEPS_PER_BEAT = 4;

/** The shortest note the model holds at all: one tick. */
export const MIN_NOTE_TICKS = 1;

/** One tick as a length in the roll's steps: the model's floor for a `length`. */
export const MIN_NOTE_STEPS = MIN_NOTE_TICKS / (PPQ / ROLL_STEPS_PER_BEAT);

const validStepsPerBeat = (stepsPerBeat?: number): number =>
  isNum(stepsPerBeat) && stepsPerBeat > 0 ? stepsPerBeat : ROLL_STEPS_PER_BEAT;

/** Ticks in one step of a grid of `stepsPerBeat` steps to the beat (4 = the roll's 16ths). */
export const ticksPerStep = (stepsPerBeat?: number): number => PPQ / validStepsPerBeat(stepsPerBeat);

/** A step position as ticks: whole (ticks are integers), never negative. */
export const tickOfStep = (step: number, stepsPerBeat?: number): number =>
  Math.max(0, Math.round((isNum(step) ? step : 0) * ticksPerStep(stepsPerBeat)));

/** A tick position as steps, fraction kept — this is what makes `step` a view of `tick`. */
export const stepOfTick = (tick: number, stepsPerBeat?: number): number =>
  Math.max(0, isNum(tick) ? tick : 0) / ticksPerStep(stepsPerBeat);

/**
 * The ticks a note really has.
 *
 * `tick`/`ticks` win when they are there AND still agree with `step`/`length`
 * (within half a tick, which is as close as the two can be told apart). They
 * lose when they disagree, because the only way that happens is a pure helper
 * outside the model — `noteClipboard.pasteNotes`, `meterMap.unrollLanes`, the
 * virtuoso transforms — having rewritten `step` on a spread copy. Re-ticking
 * from the rewritten step is what keeps those helpers working untouched, and a
 * note that never left the store can never take that branch: its `step` is
 * `tick / ticksPerStep`, so the two always agree.
 *
 * `stepsPerBeat` is the grid the CALLER counts steps on, and it is consulted on
 * the tick-less branch ONLY. A note that already has a `tick` came from the
 * store, whose `step`/`length` are always counted on the roll's own grid
 * (`ROLL_STEPS_PER_BEAT`), so that — never the caller's grid — is what the
 * agreement check compares against. Otherwise a caller asking for the notes on
 * a triplet grid (`noteEvents(store.notes, 3)`) would find every note in
 * disagreement and rewrite every authoritative tick to `round(tick * 4/3)`.
 */
const timingOf = (n: Partial<PianoNote>, stepsPerBeat?: number): { tick: number; ticks: number } => {
  const per = ticksPerStep();
  const keepTick = isNum(n.tick) && (!isNum(n.step) || Math.abs(n.tick - n.step * per) < 0.5);
  const tick = keepTick ? Math.max(0, Math.round(n.tick as number)) : tickOfStep(isNum(n.step) ? n.step : 0, stepsPerBeat);
  const keepTicks = isNum(n.ticks) && (!isNum(n.length) || Math.abs(n.ticks - n.length * per) < 0.5);
  // A tick-less length keeps its own size down to one tick; only a length that
  // is not a number at all falls back to one step (see MIN_NOTE_LENGTH).
  const ticks = keepTicks
    ? Math.max(MIN_NOTE_TICKS, Math.round(n.ticks as number))
    : Math.max(MIN_NOTE_TICKS, tickOfStep(isNum(n.length) ? n.length : MIN_NOTE_LENGTH, stepsPerBeat));
  return { tick, ticks };
};

/** A note's start in ticks, migrating one that has none. Pure. */
export const noteTick = (n: Partial<PianoNote>, stepsPerBeat?: number): number => timingOf(n, stepsPerBeat).tick;

/** A note's length in ticks, migrating one that has none. Pure. */
export const noteTicks = (n: Partial<PianoNote>, stepsPerBeat?: number): number => timingOf(n, stepsPerBeat).ticks;

/** A whole MIDI channel 1-16, or undefined when there is none to keep. */
const validChannel = (v: unknown): number | undefined =>
  isNum(v) ? Math.max(1, Math.min(16, Math.round(v))) : undefined;

const clampUnit = (v: number): number => Math.max(0, Math.min(1, v));

/** Expression with each dimension in range, or undefined when nothing is left. */
const validExpr = (e: unknown): NoteExpression | undefined => {
  if (!e || typeof e !== 'object') return undefined;
  const src = e as NoteExpression;
  const out: NoteExpression = {};
  if (isNum(src.pressure)) out.pressure = clampUnit(src.pressure);
  if (isNum(src.timbre)) out.timbre = clampUnit(src.timbre);
  if (isNum(src.pitchBend)) out.pitchBend = Math.max(-1, Math.min(1, src.pitchBend));
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * A note with its ticks settled and `step`/`length` recomputed from them, plus
 * channel and expression brought into range. THE way a note list gets into the
 * store: every load, import, paste and recording goes through it, so the tick
 * invariant holds for every note the roll holds.
 *
 * `note` and `velocity` are deliberately left alone here — whole-list ingest
 * never validated them and starting now would silently rewrite existing
 * projects. The add/update path (`validNote`) still clamps both.
 */
export const withTicks = (n: PianoNote, stepsPerBeat?: number): PianoNote => {
  // The step VIEW is always the roll's own 16ths — `stepsPerBeat` says how an
  // incoming tick-less `step` was counted, not how the store writes one back.
  // Keeping it fixed is what makes `step === tick / ticksPerStep()` hold for
  // every note in the store, whatever grid it arrived on.
  const per = ticksPerStep();
  const { tick, ticks } = timingOf(n, stepsPerBeat);
  const out: PianoNote = { ...n, tick, ticks, step: tick / per, length: ticks / per };
  const channel = validChannel(n.channel);
  if (channel === undefined) delete out.channel;
  else out.channel = channel;
  const expr = validExpr(n.expr);
  if (expr === undefined) delete out.expr;
  else out.expr = expr;
  return out;
};

/** A note list brought into the model — see `withTicks`. */
export const migrateNotes = (notes: readonly PianoNote[], stepsPerBeat?: number): PianoNote[] =>
  notes.map((n) => withTicks(n, stepsPerBeat));

/**
 * A note's fields brought inside the model's bounds: a whole MIDI note 0-127, a
 * whole velocity 1-127 (0 is a note-off, never a note), a start at or after the
 * roll's beginning and a length of at least one tick (in steps or in ticks), a
 * whole tick at or after 0, a channel 1-16 and expression in range.
 *
 * `step` keeps its FRACTION on purpose — swing, micro-timing and an imported
 * off-grid take all place notes between 16ths, and the scheduler fires them at
 * their exact time. Only the fields present in `patch` are touched, and `id` is
 * never one of them: two notes with one id would break the selection outright.
 */
const validNote = <T extends Partial<PianoNote>>(patch: T): Omit<T, 'id'> => {
  const { id: _drop, ...rest } = patch;
  const out = { ...rest } as Partial<PianoNote>;
  if ('note' in out) out.note = Math.max(0, Math.min(127, Math.round(isNum(out.note) ? out.note : 0)));
  if ('velocity' in out) out.velocity = clampVelocity(out.velocity as number);
  if ('step' in out) out.step = Math.max(0, isNum(out.step) ? out.step : 0);
  if ('length' in out) out.length = isNum(out.length) ? Math.max(MIN_NOTE_STEPS, out.length) : MIN_NOTE_LENGTH;
  if ('tick' in out) out.tick = Math.max(0, Math.round(isNum(out.tick) ? out.tick : 0));
  if ('ticks' in out) out.ticks = Math.max(MIN_NOTE_TICKS, Math.round(isNum(out.ticks) ? out.ticks : MIN_NOTE_TICKS));
  if ('channel' in out) {
    const channel = validChannel(out.channel);
    if (channel === undefined) delete out.channel;
    else out.channel = channel;
  }
  if ('expr' in out) {
    const expr = validExpr(out.expr);
    if (expr === undefined) delete out.expr;
    else out.expr = expr;
  }
  return out as Omit<T, 'id'>;
};

/**
 * `patch` validated and applied to `base`, keeping the two timing pairs in step:
 * a patch that names `tick`/`ticks` moves the derived `step`/`length`, and one
 * that names `step`/`length` re-ticks the note. Ticks lead when a patch somehow
 * names both.
 */
const patchedNote = (base: PianoNote, patch: Partial<PianoNote>): PianoNote => {
  const p = validNote(patch) as Partial<PianoNote>;
  const out: PianoNote = { ...base, ...p };
  // A patch that names a channel or expression the model cannot hold is asking
  // for NONE, so the one the note had goes rather than surviving the write.
  if ('channel' in patch && !('channel' in p)) delete out.channel;
  if ('expr' in patch && !('expr' in p)) delete out.expr;
  const per = ticksPerStep();
  if ('tick' in p) out.step = (out.tick as number) / per;
  else if ('step' in p) out.tick = tickOfStep(out.step);
  if ('ticks' in p) out.length = (out.ticks as number) / per;
  else if ('length' in p) out.ticks = Math.max(MIN_NOTE_TICKS, tickOfStep(out.length));
  return out;
};

// ── The timing feel, persisted ───────────────────────────────────────────────

/** Where the roll's Q / SWING amounts live between sessions. */
const FEEL_KEY = 'thedaw.roll.feel.v1';
const DEFAULT_QUANTIZE_PCT = 100;
const DEFAULT_SWING_PCT = 0;
/** The feel's groove before anyone picks one: the roll's own swing. */
export const DEFAULT_GROOVE_ID = 'swing';

type RollFeel = { quantizePct: number; swingPct: number; grooveId: string };

const clampQuantizePct = (v: number): number =>
  Math.max(0, Math.min(100, Math.round(isNum(v) ? v : DEFAULT_QUANTIZE_PCT)));
const clampSwingPct = (v: number): number => Math.max(-50, Math.min(50, Math.round(isNum(v) ? v : DEFAULT_SWING_PCT)));
/** Any non-blank string is a groove id — the templates live elsewhere, and an id
 *  for a groove this session does not have simply finds nothing. */
const cleanGrooveId = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_GROOVE_ID);

const loadFeel = (): RollFeel => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('no storage');
    const raw = localStorage.getItem(FEEL_KEY);
    if (!raw) throw new Error('nothing saved');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    const o = parsed as Record<string, unknown>;
    return {
      quantizePct: clampQuantizePct(o.quantizePct as number),
      swingPct: clampSwingPct(o.swingPct as number),
      // A record written before grooves had a home has no id; the default fills in.
      grooveId: cleanGrooveId(o.grooveId),
    };
  } catch {
    return { quantizePct: DEFAULT_QUANTIZE_PCT, swingPct: DEFAULT_SWING_PCT, grooveId: DEFAULT_GROOVE_ID };
  }
};

const saveFeel = (feel: RollFeel): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FEEL_KEY, JSON.stringify(feel));
  } catch {
    /* private mode / quota: the feel just does not survive the reload */
  }
};

// ── Undo / redo plumbing (module-scoped) ─────────────────────────────────────
const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 300; // changes closer than this fold into one undo step
let historyApplying = false;     // true while undo/redo writes, so it doesn't self-record
let lastDocChangeAt = -Infinity;

const docSnapshot = (s: PianoRollState): RollHistorySnapshot => ({
  notes: s.notes,
  bpm: s.bpm,
  totalSteps: s.totalSteps,
  lowestNote: s.lowestNote,
  highestNote: s.highestNote,
  meterMap: s.meterMap,
  pickupSteps: s.pickupSteps,
  lanes: s.lanes,
  bends: s.bends,
});

/** `snap` carrying `link` when `step` carries a link, so the opposite stack's step puts the link back too. */
const withLink = (snap: RollHistorySnapshot, step: RollHistorySnapshot, link: string | null): RollHistorySnapshot =>
  'editingClipId' in step ? { ...snap, editingClipId: link } : snap;

export const usePianoRollStore = create<PianoRollState>()((set, get) => ({
  notes: seed(),
  bpm: 120,
  totalSteps: DEFAULT_STEPS, // 16 bars at 16ths — a roomy default canvas
  lowestNote: FULL_LOW, // A0 — full piano in view, scrollable
  highestNote: FULL_HIGH, // C8
  selectedIds: new Set<string>(),
  selectedNoteId: null,
  isPlaying: false,
  currentStep: 0,
  editingClipId: null,
  recordedRange: null,
  meterMap: normalizeMeterMap(null),
  pickupSteps: 0,
  lanes: sanitizeLanes(DEFAULT_LANES),
  activeLane: 0,
  bends: [],
  ...loadFeel(),
  _undo: [],
  _redo: [],

  setBpm: (bpm) => set({ bpm: Math.max(40, Math.min(240, bpm)) }),
  setTotalSteps: (totalSteps) =>
    set((s) => ({ totalSteps: Math.min(MAX_STEPS, roundUpToBar(s.meterMap, Math.max(MIN_STEPS, totalSteps), s.pickupSteps)) })),
  setRange: (lo, hi) => set({ lowestNote: Math.max(0, lo), highestNote: Math.min(127, hi) }),

  addNote: (note) => {
    const id = uid();
    set((s) => {
      const lane = note.lane ?? (s.activeLane !== 0 ? s.activeLane : undefined);
      const { lane: _drop, ...rest } = note;
      // withTicks settles the timing whichever pair the caller gave.
      const notes = [...s.notes, withTicks({ ...validNote(rest), ...(lane !== undefined ? { lane } : {}), id } as PianoNote)];
      // A note just drawn is the whole selection, as it has always been.
      return { notes, ...selectionOf(notes, [id]) };
    });
    return id;
  },

  removeNote: (id) =>
    set((s) => {
      const notes = s.notes.filter((n) => n.id !== id);
      if (notes.length === s.notes.length) return {};
      return { notes, ...(s.selectedIds.has(id) ? selectionOf(notes, s.selectedIds, s.selectedNoteId) : {}) };
    }),

  updateNote: (id, patch) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? patchedNote(n, patch) : n)),
    })),

  setSelectedNote: (id) => set((s) => selectionOf(s.notes, id ? [id] : [])),
  setSelection: (ids, primary) => set((s) => selectionOf(s.notes, ids, primary)),
  addToSelection: (ids) => set((s) => selectionOf(s.notes, [...s.selectedIds, ...ids])),
  toggleSelection: (id) =>
    set((s) => {
      if (!s.selectedIds.has(id)) return selectionOf(s.notes, [...s.selectedIds, id], id);
      const kept = [...s.selectedIds].filter((x) => x !== id);
      return selectionOf(s.notes, kept, s.selectedNoteId === id ? null : s.selectedNoteId);
    }),
  selectAll: () => set((s) => selectionOf(s.notes, s.notes.map((n) => n.id))),
  clearSelection: () => set((s) => (s.selectedIds.size === 0 ? {} : noSelection())),

  nudgeSelected: (dSteps, dNotes) =>
    set((s) => {
      const picked = s.notes.filter((n) => s.selectedIds.has(n.id));
      if (picked.length === 0) return {};
      const lastStep = Math.max(0, s.totalSteps - 1);
      const lo = Math.min(s.lowestNote, s.highestNote);
      const hi = Math.max(s.lowestNote, s.highestNote);
      const minStep = picked.reduce((m, n) => Math.min(m, n.step), Infinity);
      const maxStep = picked.reduce((m, n) => Math.max(m, n.step), -Infinity);
      const minNote = picked.reduce((m, n) => Math.min(m, n.note), Infinity);
      const maxNote = picked.reduce((m, n) => Math.max(m, n.note), -Infinity);
      // Clamp the delta in its direction of travel only: at a wall the move is
      // dropped, but a note already past a wall can still be moved back inside.
      let ds = isNum(dSteps) ? dSteps : 0;
      if (ds > 0) ds = Math.min(ds, Math.max(0, lastStep - maxStep));
      else if (ds < 0) ds = Math.max(ds, Math.min(0, -minStep));
      let dn = Math.round(isNum(dNotes) ? dNotes : 0);
      if (dn > 0) dn = Math.min(dn, Math.max(0, hi - maxNote));
      else if (dn < 0) dn = Math.max(dn, Math.min(0, lo - minNote));
      if (ds === 0 && dn === 0) return {};
      // Through patchedNote so the move lands on the ticks, not only on the view.
      return { notes: s.notes.map((n) => (s.selectedIds.has(n.id) ? patchedNote(n, { step: n.step + ds, note: n.note + dn }) : n)) };
    }),

  setVelocity: (ids, velocity) =>
    set((s) => {
      const want = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
      if (want.size === 0) return {};
      const v = clampVelocity(velocity);
      let changed = false;
      const notes = s.notes.map((n) => {
        if (!want.has(n.id) || n.velocity === v) return n;
        changed = true;
        return { ...n, velocity: v };
      });
      // No write when a drag lands on the value the notes already hold, so a
      // held pointer records no undo step of its own.
      return changed ? { notes } : {};
    }),

  scaleVelocity: (ids, factor) =>
    set((s) => {
      const want = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
      if (want.size === 0 || !isNum(factor)) return {};
      let changed = false;
      const notes = s.notes.map((n) => {
        if (!want.has(n.id)) return n;
        const v = clampVelocity(n.velocity * factor);
        if (v === n.velocity) return n;
        changed = true;
        return { ...n, velocity: v };
      });
      return changed ? { notes } : {};
    }),

  setQuantizePct: (pct) =>
    set((s) => {
      const quantizePct = clampQuantizePct(pct);
      saveFeel({ quantizePct, swingPct: s.swingPct, grooveId: s.grooveId });
      return { quantizePct };
    }),
  setSwingPct: (pct) =>
    set((s) => {
      const swingPct = clampSwingPct(pct);
      saveFeel({ quantizePct: s.quantizePct, swingPct, grooveId: s.grooveId });
      return { swingPct };
    }),
  setGrooveId: (id) =>
    set((s) => {
      const grooveId = cleanGrooveId(id);
      saveFeel({ quantizePct: s.quantizePct, swingPct: s.swingPct, grooveId });
      return { grooveId };
    }),

  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  replaceAll: (notes) => set({ notes: migrateNotes(notes), ...noSelection() }),
  appendNotes: (incoming) =>
    set((s) => {
      if (incoming.length === 0) return {};
      const added = migrateNotes(incoming);
      const notes = [...s.notes, ...added];
      const end = added.reduce((m, n) => Math.max(m, n.step + n.length), 0);
      const totalSteps = end > s.totalSteps + EPS
        ? Math.min(MAX_STEPS, roundUpToBar(s.meterMap, end, s.pickupSteps))
        : s.totalSteps;
      return { notes, totalSteps, ...selectionOf(notes, added.map((n) => n.id), added[0].id) };
    }),
  clear: () =>
    set((s) => ({ notes: [], ...noSelection(), editingClipId: null, recordedRange: null, bends: clearedBends(s.bends) })),

  setEditingClip: (editingClipId) => set({ editingClipId }),
  loadFromClip: (clipId, incoming, bpm, totalSteps, meter, incomingBends) => {
    // A new document: its history starts empty. The write is not recorded (an
    // undo of it would hand back the previous clip's notes while the roll is
    // linked to this one, and SAVE would write them here), and the next edit
    // starts a fresh step instead of folding into whatever came before.
    historyApplying = true;
    try {
      set((s) => {
        const notes = migrateNotes(incoming);
        const m = mergeMeter(s, meter);
        const fit = notes.length > 0 ? fitToNotes(notes, m.meterMap, m.pickupSteps) : null;
        return {
          notes,
          ...m,
          bends: replacedBends(s, m.lanes, incomingBends),
          bpm: Math.max(40, Math.min(240, bpm)),
          totalSteps: Math.min(
            MAX_STEPS,
            roundUpToBar(m.meterMap, Math.max(MIN_STEPS, totalSteps, fit?.totalSteps ?? MIN_STEPS), m.pickupSteps),
          ),
          ...(fit ? { lowestNote: fit.lowestNote, highestNote: fit.highestNote } : {}),
          editingClipId: clipId,
          ...noSelection(),
          isPlaying: false,
          currentStep: 0,
          recordedRange: null,
          _undo: [],
          _redo: [],
        };
      });
    } finally {
      historyApplying = false;
    }
    lastDocChangeAt = -Infinity;
  },

  importNotes: (incoming, bpm, meter, incomingBends) =>
    set((s) => {
      const notes = migrateNotes(incoming);
      const m = mergeMeter(s, meter);
      const bends = replacedBends(s, m.lanes, incomingBends);
      if (notes.length === 0) {
        return { notes, ...m, bends, ...noSelection(), currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...m,
        bends,
        ...fitToNotes(notes, m.meterMap, m.pickupSteps),
        ...noSelection(),
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...(typeof bpm === 'number' && Number.isFinite(bpm)
          ? { bpm: Math.max(40, Math.min(240, Math.round(bpm))) }
          : {}),
      };
    }),

  placeRecording: (incoming, range) =>
    set((s) => {
      const notes = migrateNotes(incoming);
      // Keep at least the 256-step default — never shrink the grid for a short
      // take. Expand the pitch range to include the take (full keyboard stays).
      const lo = notes.length
        ? Math.max(0, Math.min(s.lowestNote, notes.reduce((m, n) => Math.min(m, n.note), 127) - 2))
        : s.lowestNote;
      const hi = notes.length
        ? Math.min(127, Math.max(s.highestNote, notes.reduce((m, n) => Math.max(m, n.note), 0) + 2))
        : s.highestNote;
      return {
        notes,
        totalSteps: Math.min(MAX_STEPS, roundUpToBar(s.meterMap, Math.max(DEFAULT_STEPS, s.totalSteps), s.pickupSteps)),
        lowestNote: lo,
        highestNote: hi,
        recordedRange: range,
        ...noSelection(),
        currentStep: 0,
        isPlaying: false,
      };
    }),

  setMeterMap: (map) => get().applyMeter({ meterMap: map }),
  setPickupSteps: (steps) => get().applyMeter({ pickupSteps: steps }),
  applyMeter: (meter, merge = true) =>
    set((s) => {
      const m = mergeMeter(s, meter);
      const meterMap = meter.meterMap ? normalizeMeterMap(meter.meterMap, merge) : m.meterMap;
      const bends = meter.lanes ? bendsAcrossLanes(s.bends, s.lanes, m.lanes) : s.bends;
      return {
        ...m,
        meterMap,
        // The same object when no lane took a bend with it, so a player sees no bend edit.
        bends: bends.length === s.bends.length ? s.bends : bends,
        totalSteps: Math.min(MAX_STEPS, roundUpToBar(meterMap, Math.max(MIN_STEPS, s.totalSteps), m.pickupSteps)),
      };
    }),
  setLanes: (lanes) =>
    set((s) => {
      const next = sanitizeLanes(lanes);
      return {
        lanes: next,
        activeLane: next.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
        bends: bendsForLanes(s.bends, next),
      };
    }),
  setActiveLane: (id) => set((s) => (s.lanes.some((l) => l.id === id) ? { activeLane: id } : {})),
  addLane: (cycleSteps = null) => {
    const { lanes, bends } = get();
    const id = lanes.reduce((m, l) => Math.max(m, l.id), 0) + 1;
    // A new lane starts unbent, whatever a lane with its id once had.
    set({
      lanes: sanitizeLanes([...lanes, { id, name: laneName(id), cycleSteps: clampCycle(cycleSteps) }]),
      bends: bends.filter((b) => b.lane !== id),
    });
    return id;
  },
  setLaneCycle: (id, cycleSteps) =>
    set((s) => ({ lanes: s.lanes.map((l) => (l.id === id && id !== 0 ? { ...l, cycleSteps: clampCycle(cycleSteps) } : l)) })),
  removeLane: (id) =>
    set((s) => {
      if (id === 0 || !s.lanes.some((l) => l.id === id)) return {};
      // The lane's notes move to lane 0, and its bend goes with them when lane 0 has no points of its own.
      const gone = s.bends.find((b) => b.lane === id);
      const zero = s.bends.find((b) => b.lane === 0);
      const rest = s.bends.filter((b) => b.lane !== id);
      const bends = gone?.points.length && !zero?.points.length
        ? withLaneBend(rest, 0, () => ({ range: gone.range, points: gone.points }))
        : rest;
      return {
        lanes: s.lanes.filter((l) => l.id !== id),
        notes: s.notes.map((n) => {
          if (n.lane !== id) return n;
          const { lane: _drop, ...rest } = n;
          return rest;
        }),
        activeLane: s.activeLane === id ? 0 : s.activeLane,
        bends,
      };
    }),

  setBends: (bends) => set((s) => ({ bends: capBentLanes(bendsForLanes(sanitizeBends(bends), s.lanes), s.lanes) })),
  setBendPoints: (lane, points) =>
    set((s) =>
      hasLane(s.lanes, lane) && (points.length === 0 || mayBend(s, lane))
        ? { bends: withLaneBend(s.bends, lane, () => ({ points: points.map((p) => ({ ...p })) as BendPoint[] })) }
        : {},
    ),
  addBendPoint: (lane, point) => {
    const s = get();
    if (!hasLane(s.lanes, lane) || !mayBend(s, lane)) return null;
    const id = uidBend();
    // Appended last, so it wins over a point already at its step.
    set((s) => ({ bends: withLaneBend(s.bends, lane, (b) => ({ points: [...b.points, { ...point, id } as BendPoint] })) }));
    return id;
  },
  moveBendPoint: (lane, id, patch) =>
    set((s) => {
      const bend = s.bends.find((b) => b.lane === lane);
      const p = bend?.points.find((x) => x.id === id);
      if (!bend || !p) return {};
      const moved: BendPoint = {
        id,
        step: typeof patch.step === 'number' && Number.isFinite(patch.step) ? patch.step : p.step,
        value: typeof patch.value === 'number' && Number.isFinite(patch.value) ? patch.value : p.value,
        shape: patch.shape ?? p.shape,
      };
      return { bends: withLaneBend(s.bends, lane, (b) => ({ points: [...b.points.filter((x) => x.id !== id), moved] })) };
    }),
  removeBendPoint: (lane, id) =>
    set((s) => {
      const bend = s.bends.find((b) => b.lane === lane);
      if (!bend?.points.some((x) => x.id === id)) return {};
      return { bends: withLaneBend(s.bends, lane, (b) => ({ points: b.points.filter((x) => x.id !== id) })) };
    }),
  clearBend: (lane) =>
    set((s) => ({
      bends: lane === undefined ? clearedBends(s.bends) : withLaneBend(s.bends, lane, () => ({ points: [] })),
    })),
  setBendRange: (lane, semitones) =>
    set((s) => (hasLane(s.lanes, lane) ? { bends: withLaneBend(s.bends, lane, () => ({ range: semitones })) } : {})),

  undo: () => {
    const s = get();
    if (s._undo.length === 0) return;
    const prev = s._undo[s._undo.length - 1];
    // A step that carries the link restores it (spread from `prev` below), and
    // its redo carries the link it replaces.
    const current = withLink(docSnapshot(s), prev, s.editingClipId);
    historyApplying = true;
    set({
      ...prev,
      // A lane the step is going back to may not have the active one.
      activeLane: prev.lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
      // Nor may it have the notes that were selected: a step back over an added
      // note, a paste or a cut leaves ids behind that no longer exist, and a
      // dead id in the set would survive into the next copy, nudge or delete.
      ...selectionOf(prev.notes, s.selectedIds, s.selectedNoteId),
      _undo: s._undo.slice(0, -1),
      _redo: [...s._redo, current],
    });
    historyApplying = false;
    lastDocChangeAt = -Infinity; // the next real edit starts a fresh undo step
  },

  redo: () => {
    const s = get();
    if (s._redo.length === 0) return;
    const next = s._redo[s._redo.length - 1];
    const current = withLink(docSnapshot(s), next, s.editingClipId);
    historyApplying = true;
    set({
      ...next,
      activeLane: next.lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
      // Same as undo: only the ids the step forward still has stay selected.
      ...selectionOf(next.notes, s.selectedIds, s.selectedNoteId),
      _undo: [...s._undo, current],
      _redo: s._redo.slice(0, -1),
    });
    historyApplying = false;
    lastDocChangeAt = -Infinity;
  },
}));

// Record undo history whenever a tracked document slice changes. Only the FIRST
// change of a burst captures the pre-change snapshot, so a continuous gesture (a
// note drag, a resize, a bend-point drag) collapses into a single undo step.
// Selection, the playhead, transport, the active lane and the recorded
// range don't touch these slices, so they never pollute history. A
// write that changes the linked clip WITH the document (CLEAR) always starts
// its own step, and the step keeps the link it replaced. undo/redo and
// loadFromClip set historyApplying so their own writes aren't recorded.
usePianoRollStore.subscribe((state, prev) => {
  if (historyApplying) return;
  if (
    state.notes === prev.notes &&
    state.bpm === prev.bpm &&
    state.totalSteps === prev.totalSteps &&
    state.lowestNote === prev.lowestNote &&
    state.highestNote === prev.highestNote &&
    state.meterMap === prev.meterMap &&
    state.pickupSteps === prev.pickupSteps &&
    state.lanes === prev.lanes &&
    state.bends === prev.bends
  ) return;
  const relinked = state.editingClipId !== prev.editingClipId;
  const now = performance.now();
  const coalesce = !relinked && now - lastDocChangeAt < HISTORY_COALESCE_MS;
  lastDocChangeAt = now;
  if (coalesce) return; // mid-burst; the burst start captured the undo point
  historyApplying = true;
  usePianoRollStore.setState((s) => {
    const snap = docSnapshot(prev);
    const undo = [...s._undo, relinked ? { ...snap, editingClipId: prev.editingClipId } : snap];
    if (undo.length > HISTORY_LIMIT) undo.shift();
    return { _undo: undo, _redo: [] };
  });
  historyApplying = false;
});

/** The roll's meter fields, for a bounce payload, a project save or an export. */
export const rollMeterOf = (s: Pick<PianoRollState, 'meterMap' | 'pickupSteps' | 'lanes'>): RollMeter => ({
  meterMap: s.meterMap.map((seg) => ({ bar: seg.bar, meter: { ...seg.meter, groups: [...seg.meter.groups] } })),
  pickupSteps: s.pickupSteps,
  lanes: s.lanes.map((l) => ({ ...l })),
});

/**
 * Convert the store's note list into the shared MIDI util's note format.
 *
 * Straight from the notes' OWN ticks, rescaled from `PPQ` to the file's `ppq` —
 * it no longer re-derives a position from `step`, so nothing is quantised a
 * second time on the way out. At `ppq === PPQ` the ticks come through untouched.
 */
export const pianoNotesToMidiNotes = (
  notes: PianoNote[],
  ppq: number,
): Array<{ tick: number; note: number; velocity: number; durationTicks: number; channel: number }> => {
  const scale = (isNum(ppq) && ppq > 0 ? ppq : PPQ) / PPQ;
  return notes.map((n) => ({
    tick: Math.round(noteTick(n) * scale),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(noteTicks(n) * scale)),
    channel: 0,
  }));
};
