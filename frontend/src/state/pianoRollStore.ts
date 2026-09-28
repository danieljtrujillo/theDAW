import { create } from 'zustand';
import { normalizeMeterMap, roundUpToBar, sanitizeTuplet, type LaneSpan, type MeterSegment, type PolyLane } from '../lib/meterMap';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from '../lib/noteClock';
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
import { sanitizeLoop, type RollLoop } from '../lib/rollTransport';
// lib/rollSnap imports only the PianoNote TYPE back from here, as rollSelection does.
import { DEFAULT_ROLL_SNAP, isRollSnapId, type RollSnapId } from '../lib/rollSnap';
import { sanitizeFermata, sanitizeRollTempoMap, startTempoOf, tickBeat } from '../lib/rollTempo';
import { clampTempoBpm, type TempoEvent } from '../lib/tempoMap';
// lib/rollTracks imports only the RollTrack and PianoNote TYPES back from here,
// erased at compile, so this too is a one-way runtime dependency.
import {
  MAX_ROLL_PARTS,
  PERCUSSION_PART_CHANNEL,
  allPartNotes,
  cleanPartBank,
  cleanPartChannel,
  cleanPartColor,
  cleanPartName,
  cleanPartProgram,
  isDefaultPartName,
  makeRollTrack,
  nextPartColor,
  nextPartName,
  sanitizeRollTracks,
} from '../lib/rollTracks';
import { orchestraInstrument } from '../lib/orchestra';

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

/**
 * A part of the roll: one instrument's line in a document that can hold a
 * whole orchestra (lib/rollTracks has the rules). The tempo map, the meter
 * map, the lanes and the bends belong to the document, and every part reads
 * them.
 *
 * The ACTIVE part's notes live in the store's `notes`, where every edit,
 * generator and import writes; its entry here keeps the rest of the part and
 * may hold notes from before it became active. Read every part's real notes
 * through `rollTracksOf`.
 */
export interface RollTrack {
  id: string;
  name: string;
  /** GM program 0-127 the part plays, or null to follow the roll's voice (its linked clip's, the roll's own, the picker's). On a percussion part, the kit. */
  program: number | null;
  /** Bank select (MSB) 0-127 sent before the program; 0 is the General MIDI set. */
  bank: number;
  /** MIDI channel 1-16 the part is written on, or null for the next free one; 10 makes it a percussion part. */
  channel: number | null;
  /** #rrggbb: the part's swatch, its ghost notes and its EDIT track. */
  color: string;
  mute: boolean;
  solo: boolean;
  notes: PianoNote[];
  /** The orchestral registry record the part was set to (lib/orchestra), when one was chosen. */
  instrumentId?: string;
}

/**
 * A roll part as the EDIT clip it bounced into records it (AudioClip
 * `sourceRollPart`): the roll document the clip belongs to (`doc`, shared by
 * the clips of every part bounced from one roll), the part's id, its place
 * among the parts, and its settings. Opening any of those clips opens them
 * all, one part each.
 */
export interface RollPartRef {
  doc: string;
  id: string;
  order: number;
  name: string;
  program: number | null;
  bank: number;
  channel: number | null;
  color: string;
  mute: boolean;
  solo: boolean;
  instrumentId?: string;
}

/** What loadFromClip takes to open a clip together with the clips of its other parts. */
export interface RollPartsLoad {
  /** The roll document the clips belong to; a new one when left out. */
  doc?: string;
  /** Every part, in order. The opened part's notes are the `notes` loadFromClip is given. */
  tracks: RollTrack[];
  /** The opened part. */
  activeTrackId: string;
  /** The EDIT clip each part saves into, by part id. */
  links: Record<string, string>;
}

/** A lane's own time as setLaneTime takes it: a field left out stays, null clears it. */
export interface LaneTimePatch {
  meterMap?: MeterSegment[] | null;
  tuplet?: { n: number; m: number } | null;
}

/** The roll's meter: time signatures by bar, the pickup before bar 0, and the polymeter lanes. */
export interface RollMeter {
  meterMap: MeterSegment[];
  pickupSteps: number;
  lanes: PolyLane[];
}

/** Which of the two kinds of tempo-map event a TEMPO lane edit names: a tempo change (or a ramp's start) or a fermata. */
export type TempoEventKind = 'tempo' | 'fermata';

interface PianoRollState {
  notes: PianoNote[];
  /** The starting tempo: always the tempo of `tempoMap`'s beat-0 event, which the header's BPM field edits. */
  bpm: number;
  /**
   * The tempo map (lib/rollTempo, lib/tempoMap): the beat-0 event at `bpm`,
   * then every tempo change, ramp and fermata, by quarter-note beat from the
   * roll's first step. Always sanitized (sanitizeRollTempoMap) and frozen, and
   * replaced whole on every change, so the scheduler and every render can key
   * their clocks on its identity. Part of the document: undo tracks it, a
   * bounce copies it onto the clip as `sourceTempoMap`, and MIDI export writes it.
   * MATCH writes a song's tempo changes here, so its bar lines land on the
   * song's downbeats while the notes keep their steps.
   */
  tempoMap: TempoEvent[];
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
  /**
   * The playhead, in steps. PLAY starts here, the scheduler writes it as the
   * roll sounds, and it stays where playback stopped; a click on the ruler
   * (`seek`) moves it. The METER face's ADD starts a change in its bar.
   */
  currentStep: number;
  /**
   * The loop range in steps, or null when none is set. `loopOn` says whether
   * PLAY loops it; a range that is off stays set, so the LOOP key turns it back
   * on. Both are transport state, like the playhead: not undo history, and not
   * saved with a clip.
   */
  loop: RollLoop | null;
  loopOn: boolean;
  /** Counts seeks, so a scheduler that is playing re-anchors at the new playhead. */
  seekId: number;
  /** If set, the roll is editing an existing editor clip — next "send to editor" updates that clip in place. */
  editingClipId: string | null;
  /** The GM program a roll with no linked clip auditions and bounces with;
   *  null follows the global instrument picker. A roll linked to an EDIT clip
   *  plays its clip's voice (lib/clipProgram rollVoice). Set by the Vocal2MIDI
   *  panel's voice and cleared from the roll's strip. It rides in the feel
   *  record (localStorage), so a reload keeps it, and a .tasmo saves it as
   *  `roll_voice`, which makes it a document field: choosing it is an undo step
   *  of its own (see RollHistorySnapshot), and opening a project sets it with
   *  restoreVoiceProgram, which records nothing. */
  voiceProgram: number | null;
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
  /**
   * The grid a click, a drag, a resize, an arrow nudge, the note menu and a
   * paste land on (lib/rollSnap), and the subdivision the grid draws. A
   * setting like the feel: persisted, never undo history.
   */
  snap: RollSnapId;
  /**
   * The roll's parts, in order (RollTrack). Always at least one. Part of the
   * document: undo tracks every part's fields and notes. The active part's
   * notes are `notes`; read every part through `rollTracksOf`.
   */
  tracks: RollTrack[];
  /** The part `notes` holds: where every edit, generator and import writes. View state, like the active lane. */
  activeTrackId: string;
  /**
   * The EDIT clip each part other than the active one saves into, by part id.
   * The active part's clip is `editingClipId`. Like the link, not undo history:
   * a bounce binding a part to its new clip is not an edit.
   */
  partLinks: Readonly<Record<string, string>>;
  /**
   * The roll document's id: every clip bounced from it records it
   * (RollPartRef.doc), so opening one of them opens every part. A new roll, an
   * import that replaces the parts and a clip opened alone start a new one.
   */
  rollDocId: string;
  /** Draw the other parts' notes behind the active part's (ghost notes). A setting: persisted, never undo history. */
  showGhosts: boolean;
  /** The parts column beside the keyboard is open. A setting, like showGhosts. */
  partsOpen: boolean;
  setShowGhosts: (on: boolean) => void;
  setPartsOpen: (open: boolean) => void;
  /**
   * Audition part `id` alone: it becomes the only soloed part, or, when it
   * already is, every solo clears. One undo step, as a solo is.
   */
  soloOnly: (id: string) => void;

  /** Add a part after the others and make it the active one, with the fields and notes given. One undo step. Returns its id, or null at MAX_ROLL_PARTS. */
  addTrack: (init?: Partial<Omit<RollTrack, 'id'>>) => string | null;
  /** Remove a part; the last part cannot go. Removing the active part makes its neighbour active. One undo step. */
  removeTrack: (id: string) => void;
  /** Make part `id` the one `notes` holds. Not an undo step; the selection clears, since it named the other part's notes. */
  setActiveTrack: (id: string) => void;
  /** Move part `id` to `index` in the list (held inside it). One undo step. */
  moveTrack: (id: string, index: number) => void;
  /** Rename a part (trimmed; blank keeps the old name). One undo step. */
  renameTrack: (id: string, name: string) => void;
  /**
   * Set a part's program (null: follow the roll's voice), and with
   * `percussion` given, put it on the percussion channel (true) or off it
   * (false). Clears its registry instrument. One undo step.
   */
  setTrackProgram: (id: string, program: number | null, percussion?: boolean) => void;
  /** Set a part's bank select, 0-127. One undo step. */
  setTrackBank: (id: string, bank: number) => void;
  /** Set a part's MIDI channel, 1-16 or null for the next free one. One undo step. */
  setTrackChannel: (id: string, channel: number | null) => void;
  /**
   * Put a part on an orchestral registry instrument (lib/orchestra): its GM
   * program and bank, the percussion channel for a kit, and its name when the
   * part still has a default name. null takes the instrument away and leaves
   * the program. One undo step.
   */
  setTrackInstrument: (id: string, instrumentId: string | null) => void;
  setTrackColor: (id: string, color: string) => void;
  setTrackMute: (id: string, mute: boolean) => void;
  setTrackSolo: (id: string, solo: boolean) => void;
  /** Replace one part's notes (the active part's through `notes`). One undo step. */
  setPartNotes: (id: string, notes: PianoNote[]) => void;
  /**
   * Replace every part with `parts` (a multi-track MIDI file, a score): new
   * ids, no links, the first part (or `activeIndex`) active, and the grid
   * fitted to every part's notes. The meter, bends and tempo map are taken as
   * importNotes takes them. One undo step.
   */
  importParts: (
    parts: ReadonlyArray<Partial<RollTrack>>,
    bpm?: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
    tempoMap?: readonly TempoEvent[],
    activeIndex?: number,
  ) => void;
  /** Record the EDIT clip part `id` saves into (null: none). Not an undo step, as the link is not. */
  bindPartClip: (id: string, clipId: string | null) => void;

  /** Set the starting tempo, 20-300 with its fraction kept; the map's beat-0 event takes it. */
  setBpm: (bpm: number) => void;
  /** Replace the tempo map (sanitized). Its beat-0 tempo becomes `bpm`; with none, the current `bpm` starts it. */
  setTempoMap: (events: readonly TempoEvent[]) => void;
  /** Add a tempo change, or a fermata when `event.fermata` is set, replacing one of its kind at its beat (on the roll's ticks). */
  addTempoEvent: (event: TempoEvent) => void;
  /**
   * Move, re-value or re-shape the event of `kind` at `beat`. The starting tempo
   * stays at beat 0 (a patch that moves it changes only its tempo and curve), and
   * an event that lands on another of its kind replaces it.
   */
  moveTempoEvent: (beat: number, kind: TempoEventKind, patch: Partial<TempoEvent>) => void;
  /** Remove the event of `kind` at `beat`. The starting tempo is never removed. */
  removeTempoEvent: (beat: number, kind: TempoEventKind) => void;
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
  /** The snap grid; persisted. An id the roll does not know leaves it as it is. */
  setSnap: (snap: RollSnapId) => void;
  /**
   * Retime and repitch notes in ONE write (one undo step), keeping the
   * selection: a drag of note bodies, TUPLET, and the note menu's steps. Each
   * update names a note's new `tick`, `ticks` and `note`; a field left out
   * stays, and an id with no note is skipped.
   */
  setNoteTimes: (updates: ReadonlyArray<{ id: string; tick?: number; ticks?: number; note?: number }>) => void;
  setPlaying: (playing: boolean) => void;
  /** PLAY: start the roll where the playhead is. The playhead, the seek and the
   *  loop stay as they are; the scheduler's lap starts from them (playStartLap). */
  play: () => void;
  setCurrentStep: (s: number) => void;
  /** Move the playhead to `step`, held inside the roll. While the roll plays, playback jumps there. */
  seek: (step: number) => void;
  /** Set the loop range (see `sanitizeLoop`) and turn the loop on; null clears the range and turns it off. */
  setLoop: (loop: RollLoop | null) => void;
  /** Turn the loop on or off. With no range set it stays off: the caller sets a range first. */
  setLoopOn: (on: boolean) => void;
  /** Replace the notes of the part being edited (every generator's write). */
  replaceAll: (notes: PianoNote[]) => void;
  /**
   * Add `notes` in one write (one undo step) and select them, the first as the
   * primary. A note that runs past the roll's end grows the roll to the bar
   * line after it, up to MAX_ROLL_STEPS: a paste or a duplicate near the end
   * lands whole.
   */
  appendNotes: (notes: PianoNote[]) => void;
  /** CLEAR: remove every note of the part being edited, unlink it, and clear the lanes' points. */
  clear: () => void;
  setEditingClip: (id: string | null) => void;
  /** Set the unlinked roll's own program (0-127), or null to follow the picker.
   *  One undo step. */
  setVoiceProgram: (program: number | null) => void;
  /** Put the roll on the voice a project opened with. Records no undo step, and
   *  the steps already in the history take it as their voice too, so stepping
   *  back over an earlier note edit keeps the project's voice. */
  restoreVoiceProgram: (program: number | null) => void;
  /** Load an editor clip. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone.
   *  Opening a clip is one undo step that carries the link it replaced: undoing it
   *  brings back the previous notes linked to the clip they came from, so an undo
   *  can never bring another clip's notes into this one. The loop clears.
   *  `parts` opens the clip with the clips of its other parts (lib/rollClip
   *  clipPartsLoad); left out, the clip opens as the roll's one part. */
  loadFromClip: (
    clipId: string,
    notes: PianoNote[],
    bpm: number,
    totalSteps: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
    tempoMap?: readonly TempoEvent[],
    parts?: RollPartsLoad,
  ) => void;
  /** Replace the notes of the part being edited with imported notes (the other
   *  parts keep theirs), auto-fitting length (to a bar line, holding every
   *  part's notes) AND
   *  pitch range to the content. A `meter` field left out keeps the roll's current value.
   *  `bends` replaces every lane's bend (a lane the roll ends without is dropped, and
   *  lanes past MAX_BENT_LANES lose their points); left out, every lane's points are
   *  cleared and its range stays, as CLEAR does, since the notes they bent are gone.
   *  `tempoMap` replaces the roll's map (a MIDI file's tempo changes); left out, a
   *  finite `bpm` makes the roll one tempo at `bpm`, since the notes were placed
   *  at that tempo, and no `bpm` keeps the map the roll has. */
  importNotes: (
    notes: PianoNote[],
    bpm?: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
    tempoMap?: readonly TempoEvent[],
  ) => void;
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
  /**
   * Set a lane's own time: `meterMap` (null or empty reads the roll's) and
   * `tuplet` (null, or n equal to m, is straight). A field left out stays.
   * Lane A keeps the roll's time. One undo step, as any lane edit.
   */
  setLaneTime: (id: number, time: LaneTimePatch) => void;
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
 *  The meter, the tempo map, the lanes and the bends are part of what the
 *  roll IS, so they belong here. Selection, the playhead, the loop, transport, the active lane
 *  and the recorded range deliberately do NOT — they are view and transport
 *  state, and putting them in the stack makes undo unusable mid-session.
 *
 *  The linked clip rides along on one kind of step only: a write that changed
 *  the link together with the document (CLEAR empties the roll and unlinks).
 *  That step carries the link it replaced, so undoing it relinks the clip whose
 *  notes come back, and SAVE keeps writing those notes into their own clip. A
 *  link change on its own (a bounce binding a new clip, UNLINK) is not a step.
 *  Opening a clip (loadFromClip) is a step that always carries the link, so
 *  undoing it relinks the clip whose notes come back.
 *
 *  The roll's own voice is here because a .tasmo saves it (`roll_voice`): a
 *  choice from the Vocal2MIDI panel is a step, and undo puts the voice before
 *  it back.
 *
 *  The parts are here whole (`tracks`, each with its real notes, the active
 *  one's included), with the part that was active. Undo keeps the part that is
 *  active now when the step still has it, so undoing an edit in another part
 *  changes that part without moving the view; a step that carries the link, or
 *  one that no longer has the active part, goes back to its own active part.
 *  `notes` is the active part's notes. `tracks` is optional only because a step
 *  written before parts existed has none: that step restores `notes` into the
 *  active part and leaves the parts as they are. */
interface RollHistorySnapshot {
  notes: PianoNote[];
  tracks?: RollTrack[];
  activeTrackId?: string;
  rollDocId?: string;
  bpm: number;
  tempoMap: TempoEvent[];
  totalSteps: number;
  lowestNote: number;
  highestNote: number;
  meterMap: MeterSegment[];
  pickupSteps: number;
  lanes: PolyLane[];
  bends: LaneBend[];
  voiceProgram: number | null;
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

/**
 * A lane's span with a start at or after 0 and an end after it (null = the
 * roll's end), both inside the roll's longest length; null for no span, a
 * malformed one, or one that covers the whole roll anyway.
 */
export const clampLaneSpan = (span: Partial<LaneSpan> | null | undefined): LaneSpan | null => {
  if (!span || typeof span !== 'object') return null;
  const start = Number(span.start);
  if (!Number.isFinite(start) || start < 0) return null;
  const from = Math.min(MAX_STEPS, start);
  const end = span.end == null ? null : Number(span.end);
  if (end !== null && (!Number.isFinite(end) || end <= from + EPS)) return null;
  if (from <= EPS && end === null) return null;
  return { start: from, end: end === null ? null : Math.min(MAX_STEPS, end) };
};

/**
 * Lane 0 first and never looping, unique ids, cycles clamped to whole steps,
 * spans kept when valid. A lane after A keeps its own meter map (normalized)
 * and tuplet ratio (sanitizeTuplet) when it has them; lane A always reads the
 * roll's meter, so it keeps neither.
 */
export const sanitizeLanes = (lanes: readonly PolyLane[] | null | undefined): PolyLane[] => {
  const seen = new Set<number>();
  const out: PolyLane[] = [];
  for (const l of lanes ?? []) {
    if (!l || !Number.isInteger(l.id) || l.id < 0 || seen.has(l.id)) continue;
    seen.add(l.id);
    const span = l.id === 0 ? null : clampLaneSpan(l.span);
    const lane: PolyLane = {
      id: l.id,
      name: String(l.name || laneName(l.id)),
      cycleSteps: l.id === 0 ? null : clampCycle(l.cycleSteps),
      ...(span ? { span } : {}),
    };
    if (l.id !== 0) {
      if (Array.isArray(l.meterMap) && l.meterMap.length) lane.meterMap = normalizeMeterMap(l.meterMap);
      const tuplet = sanitizeTuplet(l.tuplet);
      if (tuplet) lane.tuplet = tuplet;
    }
    out.push(lane);
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
 * The length, in steps, a note gets when its `length` is missing altogether.
 * The hand gestures (a click on an empty cell, a resize drag, the note menu's
 * Shorten) stop at one cell of the snap grid instead (lib/rollSnap), so a
 * quintuplet or a 64th drawn by hand keeps its own size.
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

// PPQ (960 ticks to the quarter), ROLL_STEPS_PER_BEAT (16ths) and
// MIN_NOTE_TICKS (one tick) live in lib/noteClock, a module with no imports,
// so a pure module can read them without loading this store.
export { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT };

/**
 * The BPM importNotes gives the roll for a finite `bpm`: `bpm` held to the
 * app's 20-300 (lib/tempoMap TEMPO_BPM_MIN..MAX) with its fraction kept, as
 * loadFromClip and setBpm keep it (any other `bpm` leaves the roll's tempo as
 * it is). A take converted to ticks at this tempo plays back at the seconds it
 * was played or detected at, and a take quantised at a fractional tempo (97.3)
 * keeps every note on its grid line.
 */
export const importedRollBpm = (bpm: number): number => clampTempoBpm(bpm);

/** One tempo at `bpm`: the map a roll gets when its notes arrive at a single tempo. */
const oneTempo = (bpm: number): TempoEvent[] => sanitizeRollTempoMap([], bpm);

/** The map and the `bpm` it starts at, written together so the two can never disagree. */
const tempoSlice = (tempoMap: TempoEvent[]): Pick<PianoRollState, 'bpm' | 'tempoMap'> =>
  ({ tempoMap, bpm: startTempoOf(tempoMap) as number });

/** True when `e` is the event of `kind` at `beat`. */
const isEventOf = (e: TempoEvent, beat: number, kind: TempoEventKind): boolean =>
  e.beat === beat && (kind === 'fermata') === !!e.fermata;

/** True when two tempo events hold the same beat, tempo, curve and fermata. */
const sameEvent = (a: TempoEvent, b: TempoEvent | undefined): boolean =>
  !!b && a.beat === b.beat && a.bpm === b.bpm && (a.curve ?? 'step') === (b.curve ?? 'step')
  && a.fermata?.beats === b.fermata?.beats && a.fermata?.stretch === b.fermata?.stretch;

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

/** The feel record. `voiceProgram` joined it after the others, so a record
 *  written before it has none and the roll follows the picker. */
type RollFeel = { quantizePct: number; swingPct: number; grooveId: string; voiceProgram: number | null };

const clampQuantizePct = (v: number): number =>
  Math.max(0, Math.min(100, Math.round(isNum(v) ? v : DEFAULT_QUANTIZE_PCT)));
const clampSwingPct = (v: number): number => Math.max(-50, Math.min(50, Math.round(isNum(v) ? v : DEFAULT_SWING_PCT)));
/** Any non-blank string is a groove id — the templates live elsewhere, and an id
 *  for a groove this session does not have simply finds nothing. */
const cleanGrooveId = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_GROOVE_ID);
/** A GM program 0-127, rounded, or null (follow the picker) for anything else. */
export const cleanVoiceProgram = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(127, Math.round(v))) : null;

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
      voiceProgram: cleanVoiceProgram(o.voiceProgram),
    };
  } catch {
    return { quantizePct: DEFAULT_QUANTIZE_PCT, swingPct: DEFAULT_SWING_PCT, grooveId: DEFAULT_GROOVE_ID, voiceProgram: null };
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

// ── The snap grid, persisted ─────────────────────────────────────────────────

const SNAP_KEY = 'thedaw.roll.snap.v1';

const loadSnap = (): RollSnapId => {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_ROLL_SNAP;
    const raw = localStorage.getItem(SNAP_KEY);
    return isRollSnapId(raw) ? raw : DEFAULT_ROLL_SNAP;
  } catch {
    return DEFAULT_ROLL_SNAP;
  }
};

const saveSnap = (snap: RollSnapId): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SNAP_KEY, snap);
  } catch {
    /* private mode / quota: the grid just does not survive the reload */
  }
};

// ── The parts column's settings, persisted ──────────────────────────────────

const PARTS_VIEW_KEY = 'thedaw.roll.parts.v1';

const loadPartsView = (): { showGhosts: boolean; partsOpen: boolean } => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('no storage');
    const raw = localStorage.getItem(PARTS_VIEW_KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    return { showGhosts: o?.showGhosts !== false, partsOpen: o?.partsOpen !== false };
  } catch {
    return { showGhosts: true, partsOpen: true };
  }
};

const savePartsView = (v: { showGhosts: boolean; partsOpen: boolean }): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PARTS_VIEW_KEY, JSON.stringify(v));
  } catch {
    /* private mode / quota: the view just does not survive the reload */
  }
};

// ── Undo / redo plumbing (module-scoped) ─────────────────────────────────────
const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 300; // changes closer than this fold into one undo step
let historyApplying = false;     // true while undo/redo writes, so it doesn't self-record
let lastDocChangeAt = -Infinity;
// A pointer gesture in progress (beginRollGesture .. endRollGesture): every
// change inside it folds into the step its first change recorded, however long
// the pointer pauses between moves.
let gestureOpen = false;
let gestureRecorded = false;

/** The next document change records its own undo step. */
const cutHistoryBurst = (): void => {
  lastDocChangeAt = -Infinity;
  gestureRecorded = false;
};

/**
 * Open one undo step for a pointer gesture: a note drag, a resize, a velocity
 * sweep or a bend-point drag. The gesture's first change records the step and
 * every later change folds into it until endRollGesture, so a slow drag that
 * crosses snap lines seconds apart is still one Ctrl+Z. It also cuts the burst
 * before it, so a drag started right after another edit is its own step.
 */
export const beginRollGesture = (): void => {
  cutHistoryBurst();
  gestureOpen = true;
};

/** Close the gesture beginRollGesture opened; the next change starts a new step. */
export const endRollGesture = (): void => {
  gestureOpen = false;
  cutHistoryBurst();
};

// ── Parts ───────────────────────────────────────────────────────────────────

type PartsView = Pick<PianoRollState, 'tracks' | 'activeTrackId' | 'notes'>;
let tracksMemo: { tracks: RollTrack[]; active: string; notes: PianoNote[]; out: RollTrack[] } | null = null;

/**
 * Every part with its real notes: the active part's are the store's `notes`.
 * The same array comes back while the parts, the active part and its notes
 * stay the same, so a selector can read it.
 */
export const rollTracksOf = (s: PartsView): RollTrack[] => {
  const m = tracksMemo;
  if (m && m.tracks === s.tracks && m.active === s.activeTrackId && m.notes === s.notes) return m.out;
  const out = s.tracks.map((t) => (t.id === s.activeTrackId && t.notes !== s.notes ? { ...t, notes: s.notes } : t));
  tracksMemo = { tracks: s.tracks, active: s.activeTrackId, notes: s.notes, out };
  return out;
};

/** The active part, as the list holds it (its notes may be stale; `notes` is its truth). */
export const activeTrackOf = (s: Pick<PianoRollState, 'tracks' | 'activeTrackId'>): RollTrack =>
  s.tracks.find((t) => t.id === s.activeTrackId) ?? s.tracks[0];

/** The EDIT clip part `id` saves into: the link for the active part, its own entry for any other. */
export const partLinkOf = (s: Pick<PianoRollState, 'activeTrackId' | 'editingClipId' | 'partLinks'>, id: string): string | null =>
  id === s.activeTrackId ? s.editingClipId : s.partLinks[id] ?? null;

/** A new roll document id. */
const rollDocUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `roll-${crypto.randomUUID()}` : `roll-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** The notes of every part but the active one: what a fit to the notes must still hold. */
const otherPartNotes = (s: Pick<PianoRollState, 'tracks' | 'activeTrackId'>): PianoNote[] =>
  allPartNotes(s.tracks.filter((t) => t.id !== s.activeTrackId));

/** `links` with `id` set to `clipId`, or without `id` when `clipId` is null. */
const withPartLink = (links: Readonly<Record<string, string>>, id: string, clipId: string | null): Record<string, string> => {
  const next = { ...links };
  if (clipId) next[id] = clipId;
  else delete next[id];
  return next;
};

/**
 * The state that makes part `id` the active one: the current notes stored into
 * the part that was active, the link kept for it, and `id`'s notes and link in
 * their place. The selection clears, since it named the other part's notes.
 */
const activateSlice = (s: PianoRollState, id: string, tracks: RollTrack[] = s.tracks): Partial<PianoRollState> => {
  const stored = tracks.map((t) => (t.id === s.activeTrackId ? { ...t, notes: s.notes } : t));
  const target = stored.find((t) => t.id === id) ?? stored[0];
  const partLinks = withPartLink(s.partLinks, s.activeTrackId, s.editingClipId);
  return {
    tracks: stored,
    activeTrackId: target.id,
    notes: target.notes,
    editingClipId: partLinks[target.id] ?? null,
    partLinks,
    ...noSelection(),
  };
};

/** A part without its registry instrument. */
const withoutInstrument = (t: RollTrack): RollTrack => {
  if (t.instrumentId === undefined) return t;
  const { instrumentId: _drop, ...rest } = t;
  return rest;
};

/** `name`, or "`name` 2", "`name` 3"... when another part than `self` has it. */
const uniquePartName = (tracks: readonly RollTrack[], name: string, self: string): string => {
  const taken = new Set(tracks.filter((t) => t.id !== self).map((t) => t.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
};

/** `tracks` with part `id` patched by `patch` (fields cleaned by the caller); null when no part is `id` or nothing changes. */
const patchTrack = (tracks: RollTrack[], id: string, patch: Partial<RollTrack>): RollTrack[] | null => {
  const i = tracks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const before = tracks[i];
  const after = { ...before, ...patch };
  if ((Object.keys(patch) as (keyof RollTrack)[]).every((k) => before[k] === after[k])) return null;
  const next = tracks.slice();
  next[i] = after;
  return next;
};

/**
 * The parts, active part, link and notes a history step puts back. A step
 * that carries the link, or that no longer has the part now active, goes back
 * to the part it had active; any other keeps the active part, so undoing an
 * edit in another part leaves the view where it is. A step written before
 * parts existed puts its notes into the active part.
 */
const restoredParts = (s: PianoRollState, step: RollHistorySnapshot): Partial<PianoRollState> => {
  if (!step.tracks?.length) return { notes: step.notes };
  const carriesLink = 'editingClipId' in step;
  const has = (id: string | undefined) => !!id && step.tracks!.some((t) => t.id === id);
  const keep = !carriesLink && has(s.activeTrackId);
  const activeTrackId = keep ? s.activeTrackId : has(step.activeTrackId) ? (step.activeTrackId as string) : step.tracks[0].id;
  const partLinks = activeTrackId === s.activeTrackId ? s.partLinks : withPartLink(s.partLinks, s.activeTrackId, s.editingClipId);
  const active = step.tracks.find((t) => t.id === activeTrackId) as RollTrack;
  return {
    tracks: step.tracks,
    ...(step.rollDocId ? { rollDocId: step.rollDocId } : {}),
    activeTrackId,
    notes: active.notes,
    partLinks,
    ...(carriesLink
      ? { editingClipId: step.editingClipId ?? null }
      : activeTrackId === s.activeTrackId
        ? {}
        : { editingClipId: partLinks[activeTrackId] ?? null }),
  };
};

/**
 * A step's fields that are not its parts (restoredParts puts those back): the
 * tempo, the grid, the meter, the lanes, the bends and the voice, and a link
 * only on a step written before parts existed.
 */
const docFieldsOf = (step: RollHistorySnapshot): Partial<PianoRollState> => {
  const { notes: _notes, tracks, activeTrackId: _active, rollDocId: _doc, editingClipId, ...doc } = step;
  return tracks?.length || !('editingClipId' in step) ? doc : { ...doc, editingClipId: editingClipId ?? null };
};

const docSnapshot = (s: PianoRollState): RollHistorySnapshot => ({
  notes: s.notes,
  tracks: rollTracksOf(s),
  activeTrackId: s.activeTrackId,
  rollDocId: s.rollDocId,
  bpm: s.bpm,
  tempoMap: s.tempoMap,
  totalSteps: s.totalSteps,
  lowestNote: s.lowestNote,
  highestNote: s.highestNote,
  meterMap: s.meterMap,
  pickupSteps: s.pickupSteps,
  lanes: s.lanes,
  bends: s.bends,
  voiceProgram: s.voiceProgram,
});

/** Write the feel record from the store, after a write that moved one of its fields. */
const saveFeelOf = (s: PianoRollState): void =>
  saveFeel({ quantizePct: s.quantizePct, swingPct: s.swingPct, grooveId: s.grooveId, voiceProgram: s.voiceProgram });

/** `snap` carrying `link` when `step` carries a link, so the opposite stack's step puts the link back too. */
const withLink = (snap: RollHistorySnapshot, step: RollHistorySnapshot, link: string | null): RollHistorySnapshot =>
  'editingClipId' in step ? { ...snap, editingClipId: link } : snap;

const SEED_NOTES = seed();
const FIRST_PART = makeRollTrack({ notes: SEED_NOTES }, 0);

export const usePianoRollStore = create<PianoRollState>()((set, get) => ({
  notes: SEED_NOTES,
  tracks: [FIRST_PART],
  activeTrackId: FIRST_PART.id,
  partLinks: {},
  rollDocId: rollDocUid(),
  ...loadPartsView(),
  bpm: 120,
  tempoMap: oneTempo(120),
  totalSteps: DEFAULT_STEPS, // 16 bars at 16ths — a roomy default canvas
  lowestNote: FULL_LOW, // A0 — full piano in view, scrollable
  highestNote: FULL_HIGH, // C8
  selectedIds: new Set<string>(),
  selectedNoteId: null,
  isPlaying: false,
  currentStep: 0,
  loop: null,
  loopOn: false,
  seekId: 0,
  editingClipId: null,
  recordedRange: null,
  meterMap: normalizeMeterMap(null),
  pickupSteps: 0,
  lanes: sanitizeLanes(DEFAULT_LANES),
  activeLane: 0,
  bends: [],
  ...loadFeel(),
  snap: loadSnap(),
  _undo: [],
  _redo: [],

  setShowGhosts: (on) => {
    set({ showGhosts: on === true });
    savePartsView({ showGhosts: get().showGhosts, partsOpen: get().partsOpen });
  },
  setPartsOpen: (open) => {
    set({ partsOpen: open === true });
    savePartsView({ showGhosts: get().showGhosts, partsOpen: get().partsOpen });
  },
  soloOnly: (id) =>
    set((s) => {
      if (!s.tracks.some((t) => t.id === id)) return {};
      const alone = s.tracks.every((t) => t.solo === (t.id === id));
      return { tracks: s.tracks.map((t) => {
        const solo = alone ? false : t.id === id;
        return t.solo === solo ? t : { ...t, solo };
      }) };
    }),
  addTrack: (init = {}) => {
    const s = get();
    if (s.tracks.length >= MAX_ROLL_PARTS) return null;
    const track = makeRollTrack(
      {
        ...init,
        id: undefined,
        name: init.name ?? nextPartName(s.tracks),
        color: init.color ?? nextPartColor(s.tracks),
        notes: migrateNotes(init.notes ?? []),
      },
      s.tracks.length,
    );
    // The new part is where the next edit goes, and it saves into no clip yet.
    set((st) => activateSlice(st, track.id, [...st.tracks, track]));
    return track.id;
  },
  removeTrack: (id) =>
    set((s) => {
      if (s.tracks.length <= 1) return {};
      const i = s.tracks.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const rest = s.tracks.filter((t) => t.id !== id);
      if (id !== s.activeTrackId) return { tracks: rest };
      // The neighbour that took its place, else the one before it. The removed
      // part's link stays in partLinks, so undoing the removal relinks it.
      return activateSlice(s, rest[Math.min(i, rest.length - 1)].id, rest);
    }),
  setActiveTrack: (id) => {
    const s = get();
    if (id === s.activeTrackId || !s.tracks.some((t) => t.id === id)) return;
    // Every part's notes are the same before and after, so this is no step.
    historyApplying = true;
    try {
      set((st) => activateSlice(st, id));
    } finally {
      historyApplying = false;
    }
    cutHistoryBurst();
  },
  moveTrack: (id, index) =>
    set((s) => {
      const from = s.tracks.findIndex((t) => t.id === id);
      if (from < 0 || !isNum(index)) return {};
      const to = Math.max(0, Math.min(s.tracks.length - 1, Math.round(index)));
      if (to === from) return {};
      const tracks = s.tracks.slice();
      const [moved] = tracks.splice(from, 1);
      tracks.splice(to, 0, moved);
      return { tracks };
    }),
  renameTrack: (id, name) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      const tracks = t ? patchTrack(s.tracks, id, { name: cleanPartName(name, t.name) }) : null;
      return tracks ? { tracks } : {};
    }),
  setTrackProgram: (id, program, percussion) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      if (!t) return {};
      const channel = percussion === true
        ? PERCUSSION_PART_CHANNEL
        : percussion === false && t.channel === PERCUSSION_PART_CHANNEL
          ? null
          : t.channel;
      const patched = patchTrack(s.tracks, id, { program: cleanPartProgram(program), channel });
      // A program chosen by hand is no longer the registry instrument's.
      const tracks = (patched ?? s.tracks).map((x) => (x.id === id ? withoutInstrument(x) : x));
      return tracks.some((x, i) => x !== s.tracks[i]) ? { tracks } : {};
    }),
  setTrackBank: (id, bank) =>
    set((s) => {
      const tracks = patchTrack(s.tracks, id, { bank: cleanPartBank(bank) });
      return tracks ? { tracks } : {};
    }),
  setTrackChannel: (id, channel) =>
    set((s) => {
      const tracks = patchTrack(s.tracks, id, { channel: cleanPartChannel(channel) });
      return tracks ? { tracks } : {};
    }),
  setTrackInstrument: (id, instrumentId) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      if (!t) return {};
      if (!instrumentId) {
        if (t.instrumentId === undefined) return {};
        return { tracks: s.tracks.map((x) => (x.id === id ? withoutInstrument(x) : x)) };
      }
      const inst = orchestraInstrument(instrumentId);
      if (!inst) return {};
      const patch: Partial<RollTrack> = {
        instrumentId: inst.id,
        program: inst.program,
        // A kit is chosen by its program on the percussion channel; the bank is the melodic set's.
        bank: inst.percussion ? 0 : cleanPartBank(inst.bank),
        channel: inst.percussion ? PERCUSSION_PART_CHANNEL : t.channel === PERCUSSION_PART_CHANNEL ? null : t.channel,
        ...(isDefaultPartName(t.name) ? { name: uniquePartName(s.tracks, inst.name, id) } : {}),
      };
      const tracks = patchTrack(s.tracks, id, patch);
      return tracks ? { tracks } : {};
    }),
  setTrackColor: (id, color) =>
    set((s) => {
      const t = s.tracks.find((x) => x.id === id);
      const tracks = t ? patchTrack(s.tracks, id, { color: cleanPartColor(color, t.color) }) : null;
      return tracks ? { tracks } : {};
    }),
  setTrackMute: (id, mute) =>
    set((s) => {
      const tracks = patchTrack(s.tracks, id, { mute: mute === true });
      return tracks ? { tracks } : {};
    }),
  setTrackSolo: (id, solo) =>
    set((s) => {
      const tracks = patchTrack(s.tracks, id, { solo: solo === true });
      return tracks ? { tracks } : {};
    }),
  setPartNotes: (id, incoming) =>
    set((s) => {
      if (id === s.activeTrackId) return { notes: migrateNotes(incoming), ...noSelection() };
      const tracks = patchTrack(s.tracks, id, { notes: migrateNotes(incoming) });
      return tracks ? { tracks } : {};
    }),
  importParts: (parts, bpm, meter, incomingBends, incomingTempo, activeIndex = 0) =>
    set((s) => {
      // Past MAX_ROLL_PARTS the notes of the parts that do not fit go into the last one, so none is lost.
      const kept = parts.slice(0, MAX_ROLL_PARTS).map((p) => ({ ...p, id: undefined, notes: [...(p.notes ?? [])] }));
      if (parts.length > MAX_ROLL_PARTS && kept.length) {
        const last = kept[kept.length - 1];
        for (const p of parts.slice(MAX_ROLL_PARTS)) last.notes.push(...(p.notes ?? []));
      }
      const tracks = sanitizeRollTracks(kept.map((p) => ({ ...p, notes: migrateNotes(p.notes) })));
      const active = tracks[Math.max(0, Math.min(tracks.length - 1, isNum(activeIndex) ? Math.round(activeIndex) : 0))];
      const m = mergeMeter(s, meter);
      const finiteBpm = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
      const tempo = incomingTempo
        ? tempoSlice(sanitizeRollTempoMap(incomingTempo, finiteBpm ? importedRollBpm(bpm) : s.bpm))
        : finiteBpm
          ? tempoSlice(oneTempo(importedRollBpm(bpm)))
          : {};
      const all = allPartNotes(tracks);
      return {
        tracks,
        activeTrackId: active.id,
        notes: active.notes,
        // New parts save into no clip, in a new document; the parts they replace keep their links for an undo.
        editingClipId: null,
        rollDocId: rollDocUid(),
        partLinks: withPartLink(s.partLinks, s.activeTrackId, s.editingClipId),
        ...m,
        bends: replacedBends(s, m.lanes, incomingBends),
        ...(all.length ? fitToNotes(all, m.meterMap, m.pickupSteps) : {}),
        ...noSelection(),
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...tempo,
      };
    }),
  bindPartClip: (id, clipId) =>
    set((s) => {
      if (id === s.activeTrackId) return s.editingClipId === clipId ? {} : { editingClipId: clipId };
      if (!s.tracks.some((t) => t.id === id)) return {};
      return { partLinks: withPartLink(s.partLinks, id, clipId) };
    }),

  setBpm: (bpm) =>
    set((s) => {
      if (!isNum(bpm) || bpm <= 0) return {};
      const next = clampTempoBpm(bpm);
      if (next === s.bpm) return {};
      return tempoSlice(sanitizeRollTempoMap(s.tempoMap.map((e) => (isEventOf(e, 0, 'tempo') ? { ...e, bpm: next } : e)), next));
    }),
  setTempoMap: (events) =>
    set((s) => {
      const next = sanitizeRollTempoMap(events, s.bpm);
      // An equal map writes nothing, so writing it again adds no undo step.
      return next.length === s.tempoMap.length && next.every((e, i) => sameEvent(e, s.tempoMap[i])) ? {} : tempoSlice(next);
    }),
  addTempoEvent: (event) =>
    set((s) => {
      if (!event || !isNum(event.beat)) return {};
      // Appended last, so it wins over an event of its kind already at its beat.
      return tempoSlice(sanitizeRollTempoMap([...s.tempoMap, event], s.bpm));
    }),
  moveTempoEvent: (beat, kind, patch) =>
    set((s) => {
      const found = s.tempoMap.find((e) => isEventOf(e, beat, kind));
      if (!found) return {};
      const start = kind === 'tempo' && beat === 0;
      const moved: TempoEvent = {
        ...found,
        beat: start ? 0 : isNum(patch.beat) ? tickBeat(patch.beat) : found.beat,
        bpm: isNum(patch.bpm) && patch.bpm > 0 ? patch.bpm : found.bpm,
        ...(kind === 'tempo' ? { curve: patch.curve ?? found.curve } : {}),
        ...(kind === 'fermata' ? { fermata: sanitizeFermata({ ...found.fermata, ...patch.fermata }) ?? found.fermata } : {}),
      };
      // A tempo change dragged onto beat 0 would take the starting tempo's
      // place; it stops a tick after it instead, so the start is never lost.
      if (!start && kind === 'tempo' && moved.beat <= 0) moved.beat = tickBeat(1 / PPQ);
      const rest = s.tempoMap.filter((e) => e !== found);
      const next = sanitizeRollTempoMap([...rest, moved], s.bpm);
      return next.length === s.tempoMap.length && next.every((e, i) => sameEvent(e, s.tempoMap[i])) ? {} : tempoSlice(next);
    }),
  removeTempoEvent: (beat, kind) =>
    set((s) => {
      if (kind === 'tempo' && beat === 0) return {};
      const next = s.tempoMap.filter((e) => !isEventOf(e, beat, kind));
      return next.length === s.tempoMap.length ? {} : tempoSlice(sanitizeRollTempoMap(next, s.bpm));
    }),
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
      saveFeel({ quantizePct, swingPct: s.swingPct, grooveId: s.grooveId, voiceProgram: s.voiceProgram });
      return { quantizePct };
    }),
  setSwingPct: (pct) =>
    set((s) => {
      const swingPct = clampSwingPct(pct);
      saveFeel({ quantizePct: s.quantizePct, swingPct, grooveId: s.grooveId, voiceProgram: s.voiceProgram });
      return { swingPct };
    }),
  setGrooveId: (id) =>
    set((s) => {
      const grooveId = cleanGrooveId(id);
      saveFeel({ quantizePct: s.quantizePct, swingPct: s.swingPct, grooveId, voiceProgram: s.voiceProgram });
      return { grooveId };
    }),

  setSnap: (snap) => {
    if (!isRollSnapId(snap)) return;
    saveSnap(snap);
    set({ snap });
  },
  setNoteTimes: (updates) =>
    set((s) => {
      const byId = new Map(updates.map((u) => [u.id, u]));
      let changed = false;
      const notes = s.notes.map((n) => {
        const u = byId.get(n.id);
        if (!u) return n;
        const patch: Partial<PianoNote> = {};
        if (isNum(u.tick) && u.tick !== n.tick) patch.tick = u.tick;
        if (isNum(u.ticks) && u.ticks !== n.ticks) patch.ticks = u.ticks;
        if (isNum(u.note) && u.note !== n.note) patch.note = u.note;
        if (Object.keys(patch).length === 0) return n;
        changed = true;
        return patchedNote(n, patch);
      });
      // No write when nothing moved, so a held drag records no undo step of its own.
      return changed ? { notes } : {};
    }),

  setPlaying: (isPlaying) => set({ isPlaying }),
  play: () => set({ isPlaying: true }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  seek: (step) =>
    set((s) => ({
      currentStep: Math.max(0, Math.min(Math.max(0, s.totalSteps - 1), isNum(step) ? step : 0)),
      seekId: s.seekId + 1,
    })),
  setLoop: (loop) =>
    set(() => {
      const next = sanitizeLoop(loop);
      return { loop: next, loopOn: next !== null };
    }),
  setLoopOn: (on) => set((s) => ({ loopOn: on && s.loop !== null })),
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
  setVoiceProgram: (program) => {
    set({ voiceProgram: cleanVoiceProgram(program) });
    saveFeelOf(get());
  },
  restoreVoiceProgram: (program) => {
    const voiceProgram = cleanVoiceProgram(program);
    historyApplying = true;
    try {
      set((s) => ({
        voiceProgram,
        _undo: s._undo.map((step) => ({ ...step, voiceProgram })),
        _redo: s._redo.map((step) => ({ ...step, voiceProgram })),
      }));
    } finally {
      historyApplying = false;
    }
    saveFeelOf(get());
  },
  loadFromClip: (clipId, incoming, bpm, totalSteps, meter, incomingBends, incomingTempo, parts) => {
    // Opening a clip is one undo step of its own, and the step carries the link
    // it replaced: undoing it brings back the roll's previous notes (unsaved
    // work included) linked to the clip they came from, so SAVE writes them
    // there and never into the clip just opened. The step is written here, not
    // by the recorder, so it never folds into the burst before it, and the next
    // edit starts a fresh step.
    historyApplying = true;
    try {
      set((s) => {
        const undo = [...s._undo, { ...docSnapshot(s), editingClipId: s.editingClipId }];
        if (undo.length > HISTORY_LIMIT) undo.shift();
        const notes = migrateNotes(incoming);
        const m = mergeMeter(s, meter);
        // The clip's parts, the opened one holding `notes`; a clip with none of
        // its own (bounced before parts, or alone) opens as the roll's one part.
        const tracks = parts?.tracks.length
          ? sanitizeRollTracks(parts.tracks.map((t) => ({ ...t, notes: migrateNotes(t.notes ?? []) })))
          : [makeRollTrack({}, 0)];
        const activeTrackId = tracks.some((t) => t.id === parts?.activeTrackId) ? (parts?.activeTrackId as string) : tracks[0].id;
        const opened = tracks.map((t) => (t.id === activeTrackId ? { ...t, notes } : t));
        let partLinks = withPartLink(s.partLinks, s.activeTrackId, s.editingClipId);
        for (const t of opened) {
          if (t.id !== activeTrackId) partLinks = withPartLink(partLinks, t.id, parts?.links[t.id] ?? null);
        }
        const all = allPartNotes(opened);
        const fit = all.length > 0 ? fitToNotes(all, m.meterMap, m.pickupSteps) : null;
        return {
          notes,
          tracks: opened,
          activeTrackId,
          partLinks,
          rollDocId: parts?.doc || rollDocUid(),
          ...m,
          bends: replacedBends(s, m.lanes, incomingBends),
          // A clip bounced before the roll had a tempo map plays at one tempo, its own.
          ...tempoSlice(sanitizeRollTempoMap(incomingTempo ?? [], isNum(bpm) && bpm > 0 ? bpm : s.bpm)),
          totalSteps: Math.min(
            MAX_STEPS,
            roundUpToBar(m.meterMap, Math.max(MIN_STEPS, totalSteps, fit?.totalSteps ?? MIN_STEPS), m.pickupSteps),
          ),
          ...(fit ? { lowestNote: fit.lowestNote, highestNote: fit.highestNote } : {}),
          editingClipId: clipId,
          ...noSelection(),
          isPlaying: false,
          currentStep: 0,
          loop: null,
          loopOn: false,
          recordedRange: null,
          _undo: undo,
          _redo: [],
        };
      });
    } finally {
      historyApplying = false;
    }
    cutHistoryBurst();
  },

  importNotes: (incoming, bpm, meter, incomingBends, incomingTempo) =>
    set((s) => {
      const notes = migrateNotes(incoming);
      const m = mergeMeter(s, meter);
      const bends = replacedBends(s, m.lanes, incomingBends);
      const finiteBpm = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
      // The file's own map, or one tempo at the tempo the notes were placed at, or the roll's map as it is.
      const tempo = incomingTempo
        ? tempoSlice(sanitizeRollTempoMap(incomingTempo, finiteBpm ? importedRollBpm(bpm) : s.bpm))
        : finiteBpm
          ? tempoSlice(oneTempo(importedRollBpm(bpm)))
          : {};
      if (notes.length === 0) {
        return { notes, ...m, bends, ...tempo, ...noSelection(), currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...m,
        bends,
        // The notes go into the active part; the grid still holds every other part's.
        ...fitToNotes([...notes, ...otherPartNotes(s)], m.meterMap, m.pickupSteps),
        ...noSelection(),
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...tempo,
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
  setLaneTime: (id, time) =>
    set((s) => {
      if (id === 0 || !s.lanes.some((l) => l.id === id)) return {};
      const lanes = sanitizeLanes(
        s.lanes.map((l) => {
          if (l.id !== id) return l;
          const next: PolyLane = { ...l };
          if ('meterMap' in time) {
            if (time.meterMap?.length) next.meterMap = time.meterMap;
            else delete next.meterMap;
          }
          if ('tuplet' in time) {
            if (time.tuplet) next.tuplet = time.tuplet;
            else delete next.tuplet;
          }
          return next;
        }),
      );
      return { lanes };
    }),
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
    const parts = restoredParts(s, prev);
    historyApplying = true;
    set({
      ...docFieldsOf(prev),
      ...parts,
      // A lane the step is going back to may not have the active one.
      activeLane: prev.lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
      // Nor may it have the notes that were selected: a step back over an added
      // note, a paste or a cut leaves ids behind that no longer exist, and a
      // dead id in the set would survive into the next copy, nudge or delete.
      ...selectionOf(parts.notes as PianoNote[], s.selectedIds, s.selectedNoteId),
      _undo: s._undo.slice(0, -1),
      _redo: [...s._redo, current],
    });
    historyApplying = false;
    cutHistoryBurst(); // the next real edit starts a fresh undo step
    if (prev.voiceProgram !== s.voiceProgram) saveFeelOf(get());
  },

  redo: () => {
    const s = get();
    if (s._redo.length === 0) return;
    const next = s._redo[s._redo.length - 1];
    const current = withLink(docSnapshot(s), next, s.editingClipId);
    const parts = restoredParts(s, next);
    historyApplying = true;
    set({
      ...docFieldsOf(next),
      ...parts,
      activeLane: next.lanes.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
      // Same as undo: only the ids the step forward still has stay selected.
      ...selectionOf(parts.notes as PianoNote[], s.selectedIds, s.selectedNoteId),
      _undo: [...s._undo, current],
      _redo: s._redo.slice(0, -1),
    });
    historyApplying = false;
    cutHistoryBurst();
    if (next.voiceProgram !== s.voiceProgram) saveFeelOf(get());
  },
}));

// Record undo history whenever a tracked document slice changes. Only the FIRST
// change of a burst captures the pre-change snapshot, so a continuous gesture (a
// note drag, a resize, a bend-point drag) collapses into a single undo step.
// Selection, the playhead, the loop, transport, the active lane and the
// recorded range don't touch these slices, so they never pollute history. A
// write that changes the linked clip WITH the document (CLEAR) always starts
// its own step, and the step keeps the link it replaced. A voice choice is a
// click, never a gesture, so it too always starts its own step. undo/redo and
// loadFromClip set historyApplying so their own writes aren't recorded here
// (loadFromClip pushes its own linked step).
usePianoRollStore.subscribe((state, prev) => {
  if (historyApplying) return;
  if (
    state.notes === prev.notes &&
    state.tracks === prev.tracks &&
    state.bpm === prev.bpm &&
    state.tempoMap === prev.tempoMap &&
    state.totalSteps === prev.totalSteps &&
    state.lowestNote === prev.lowestNote &&
    state.highestNote === prev.highestNote &&
    state.meterMap === prev.meterMap &&
    state.pickupSteps === prev.pickupSteps &&
    state.lanes === prev.lanes &&
    state.bends === prev.bends &&
    state.voiceProgram === prev.voiceProgram
  ) return;
  const relinked = state.editingClipId !== prev.editingClipId;
  const revoiced = state.voiceProgram !== prev.voiceProgram;
  const now = performance.now();
  // Inside a pointer gesture time does not end the step; the gesture's end does.
  const coalesce = !relinked && !revoiced && (gestureOpen ? gestureRecorded : now - lastDocChangeAt < HISTORY_COALESCE_MS);
  lastDocChangeAt = now;
  if (gestureOpen) gestureRecorded = true;
  // A voice step is whole: the next edit, however soon, starts a step of its own.
  if (revoiced) cutHistoryBurst();
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
  lanes: s.lanes.map((l) => ({
    ...l,
    ...(l.meterMap ? { meterMap: l.meterMap.map((seg) => ({ bar: seg.bar, meter: { ...seg.meter, groups: [...seg.meter.groups] } })) } : {}),
    ...(l.tuplet ? { tuplet: { ...l.tuplet } } : {}),
  })),
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
