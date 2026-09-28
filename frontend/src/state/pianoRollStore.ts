import { create } from 'zustand';
import { normalizeMeterMap, roundUpToBar, sanitizeTuplet, type LaneSpan, type MeterSegment, type PolyLane } from '../lib/meterMap';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from '../lib/noteClock';
import {
  DEFAULT_BEND_RANGE,
  MAX_BENT_LANES,
  MAX_BEND_STEP,
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
import {
  cleanMarkerName,
  isRollMarkerKind,
  markerAtPlace,
  markerTickOfStep,
  nextMarkerName,
  sameRollMarkers,
  sanitizeRollMarkers,
  type RollMarker,
  type RollMarkerInput,
} from '../lib/rollMarkers';
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
  cleanPartBankLsb,
  cleanPartChannel,
  cleanPartColor,
  cleanFigure,
  cleanFiguredBass,
  cleanPartControls,
  cleanPartName,
  cleanPartProgram,
  isDefaultPartName,
  isPercussionPart,
  makeRollTrack,
  nextPartColor,
  nextPartName,
  sanitizeRollTracks,
} from '../lib/rollTracks';
import { orchestraInstrument, type OrchestraInstrument } from '../lib/orchestra';
import { isArticulation, type Articulation } from '../lib/articulationMap';
import { buildExpression, withExpressionControls } from '../lib/clipNotes/expression';
import { sanitizeNoteExpression } from '../lib/noteExpression';
import {
  composerApi,
  type CanonResult,
  type CheckResult,
  type FormResult,
  type FugueResult,
  type PartRanges,
  type PlanResult,
  type SpeciesResult,
  type VoiceLeadingFlag,
} from '../lib/composerClient';
import {
  SATB,
  checkPick,
  continuoPartWrites,
  counterpointPartWrites,
  figuredBassLine,
  flagNoteIds,
  formMovementWrite,
  partRange,
  planPartWrites,
  satbRoleOf,
  type ComposerWrite,
  type PartWrite,
  type RollChordLabel,
} from '../lib/rollComposer';
import { cleanRollKey, estimateRollKey, rollKeyScale, type RollKey } from '../lib/rollKey';
import {
  augmentSelection,
  diminishSelection,
  fragmentSelection,
  invertSelection,
  retrogradeSelection,
  sequenceSelection,
} from '../lib/rollTransforms';

/**
 * Per-note expression — the three MPE dimensions a note can carry on its own,
 * independent of its channel's wheel. Ranges are fixed here so every reader
 * agrees: `pressure` and `timbre` are 0..1, `pitchBend` is -1..1 of
 * `bendRange` semitones when the note names one, else of whatever bend range
 * the note's channel is in. Those are the values the note starts at; `curves`
 * holds how each moves inside the note (lib/noteExpression). An MPE file or
 * controller brings them in (lib/mpeMidi, lib/midiCapture), the roll's CC
 * lane draws them for a selected note, and both MIDI writers write them as MPE.
 */
export interface NoteExpression {
  /** Aftertouch / channel pressure, 0..1. */
  pressure?: number;
  /** The third MPE dimension (CC 74 "timbre" / slide), 0..1. */
  timbre?: number;
  /** Bend at the note, -1..1 of its range. */
  pitchBend?: number;
  /** The semitones `pitchBend` ±1 is worth (an MPE member channel's range, 48 by default); absent, the channel's. */
  bendRange?: number;
  /** Each dimension's movement inside the note: points at ticks from its start, each holding until the next. */
  curves?: {
    pressure?: NoteExpressionPoint[];
    timbre?: NoteExpressionPoint[];
    pitchBend?: NoteExpressionPoint[];
  };
}

/** One point of a note's expression curve: ticks from the note's start, and the value from there. */
export interface NoteExpressionPoint {
  tick: number;
  value: number;
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
  /**
   * How the note is played (lib/articulationMap): legato, staccato,
   * pizzicato, tremolo, marcato, spiccato, col legno, harmonics or con
   * sordino. Absent is ordinario (arco on a string part). The roll's
   * articulation lane marks it; PLAY, EDIT and a render play it on the preset
   * or keyswitch it resolves to for the part's instrument.
   */
  articulation?: Articulation;
}

/**
 * A controller change a part carries: the modulation wheel (1), volume (7),
 * pan (10), expression (11) or the sustain pedal (64), as a MIDI file or a
 * score gives them (lib/rollTracks PART_CONTROLLERS). `tick` is on the roll's
 * clock, `PPQ` ticks to the quarter from the roll's start, as a note's is; the
 * change acts on every note of its part from there until the next one.
 */
export interface RollControl {
  tick: number;
  controller: number;
  /** 0-127. */
  value: number;
}

/**
 * A figure written under a note of a part's bass line (the figured-bass lane):
 * `tick` is the note's start on the roll's clock, `figure` the figures as
 * written ('6', '6/4', '7', '#6', '4/3'; blank is a root-position triad). The
 * continuo realizer (composerClient continuo) reads them under the notes that
 * start at their ticks.
 */
export interface FiguredBassMark {
  tick: number;
  figure: string;
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
  /**
   * Bank select LSB (CC 32) 0-127, sent after the MSB and before the program
   * (XG and GS pick a voice's variations with it). Absent when the part sends
   * none, as every part made before it existed.
   */
  bankLsb?: number;
  /** MIDI channel 1-16 the part is written on, or null for the next free one; 10 makes it a percussion part. */
  channel: number | null;
  /** #rrggbb: the part's swatch, its ghost notes and its EDIT track. */
  color: string;
  mute: boolean;
  solo: boolean;
  notes: PianoNote[];
  /** The orchestral registry record the part was set to (lib/orchestra), when one was chosen. */
  instrumentId?: string;
  /**
   * The part's controller changes, sorted by tick (cleaned by lib/rollTracks
   * cleanPartControls). Absent when it has none, as every part made before
   * controllers existed. PLAY sends them on the part's channels, a bounce
   * renders them, and MIDI export writes them.
   */
  controls?: RollControl[];
  /**
   * The figures under the part's bass notes, sorted by tick, one per tick
   * (cleaned by lib/rollTracks cleanFiguredBass). Absent when it has none. The
   * part's clip saves them (RollPartRef), and undo covers every edit.
   */
  figuredBass?: FiguredBassMark[];
  /**
   * True for the part marked as the cantus firmus: species counterpoint is
   * written against its notes, and a counterpoint result writes its cantus
   * back into it. At most one part of a roll carries it. Absent when false.
   */
  cantusFirmus?: boolean;
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
  /** The part's bank select LSB (RollTrack `bankLsb`). Absent when it sends none. */
  bankLsb?: number;
  channel: number | null;
  color: string;
  mute: boolean;
  solo: boolean;
  instrumentId?: string;
  /** The part's controller changes (RollTrack `controls`), on the roll's clock. Absent when it has none. */
  controls?: RollControl[];
  /** The figures under the part's bass notes (RollTrack `figuredBass`). Absent when it has none. */
  figuredBass?: FiguredBassMark[];
  /** The part is the roll's cantus firmus (RollTrack `cantusFirmus`). Absent when it is not. */
  cantusFirmus?: boolean;
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

/**
 * What an import into the part being edited carries besides its notes
 * (importNotes `opts.part`): the file part's controller changes, which replace
 * the part's own (an empty list clears them), and its instrument, which the
 * part takes only when it follows the roll's voice (no program of its own):
 * the registry instrument when the file names one, else the file's program, on
 * the percussion channel when the file's part is percussion.
 */
export interface RollPartImport {
  controls?: readonly RollControl[];
  instrumentId?: string;
  program?: number | null;
  percussion?: boolean;
}

/** How importNotes treats the document's maps (see importNotes). */
export interface ImportNotesOptions {
  /**
   * The write owns the document's tempo map and meter: the ones it hands in
   * replace the roll's even while other parts hold notes. Virtuoso's song
   * build passes it, since the song's sections set the meters and tempos of
   * their own bars.
   */
  document?: boolean;
  /**
   * The markers the write brings (a file's, a song build's FORM sections with
   * the user's own): they replace the roll's whenever the write sets the
   * document. Left out, the markers stay.
   */
  markers?: readonly RollMarkerInput[];
  /**
   * A file's one part (RollPartImport): its controller changes and, for a
   * part that follows the roll's voice, its instrument, set on the part being
   * edited in the same undo step. Part-level, so it applies whether or not
   * the document is kept. Left out, the part keeps both, as every generator's
   * write does.
   */
  part?: RollPartImport;
}

/** What importNotes did with the document's maps. */
export interface ImportNotesResult {
  /**
   * True when other parts held notes, so the write went into the part being
   * edited and left the tempo map, the meter, the lanes, the bends and the
   * markers as the document had them, whatever it was handed; false when it
   * took them as a roll of one part does.
   */
  keptDocument: boolean;
}

/**
 * The last voice-leading answer the roll holds (runVoiceLeadingCheck, or the
 * flags a plan, a realized figured bass, a counterpoint or a form came back
 * with): the flags, which roll part each flag's part name stands for, and the
 * notes each of those parts had when it was checked, so the harmony row can
 * say when a part has changed since.
 */
export interface RollVoiceLeading {
  flags: VoiceLeadingFlag[];
  /** The roll part id each part name in the flags stands for. */
  ids: Record<string, string>;
  /** Each checked part's note list as it was checked, by part id (the same array while the part is unchanged). */
  notesAt: Record<string, PianoNote[]>;
  /** The key the parts were read in. */
  key: RollKey;
  /** Where the flags came from. */
  source: 'check' | 'plan' | 'continuo' | 'counterpoint' | 'form';
}

/** What a composer write did (writePlanToRoll, writeCounterpoint, writeFormMovement, realizeFiguredBass). */
export interface RollWriteResult {
  /** The id of the part each voice went into, in the answer's order (top voice first); a voice left out has none. */
  partIds: string[];
  /** Parts the write made (the rest existed and had their notes replaced). */
  created: number;
  /** Voices left out because the roll already held MAX_ROLL_PARTS parts. */
  skipped: number;
}

/** The motif transforms the roll's selection takes (lib/rollTransforms). */
export type RollTransformKind = 'invert' | 'retrograde' | 'augment' | 'diminish' | 'sequence' | 'fragment';

/** The roll's selection transforms' settings; each has a default. */
export interface RollTransformOptions {
  /** Augment and diminish: how many times longer or shorter (default 2). */
  factor?: number;
  /** Sequence: statements after the selection itself (default 2). */
  steps?: number;
  /** Sequence: scale steps (diatonic) or semitones (chromatic) each statement moves (default -1: down a step). */
  interval?: number;
  /** Fragment: keep the first ('head', the default) or last onsets. */
  part?: 'head' | 'tail';
  /** Fragment: onsets to keep (default half the selection's, at least one). */
  count?: number;
  /** Invert and sequence move by scale degree in the roll's key (default true), or by semitones when false. */
  diatonic?: boolean;
  /** Invert: the pitch to mirror about (default the selection's first note). */
  axis?: number;
}

/** The labels the roll's menus and keys give each transform. */
export const ROLL_TRANSFORM_LABELS: Readonly<Record<RollTransformKind, string>> = Object.freeze({
  invert: 'Invert',
  retrograde: 'Retrograde',
  augment: 'Augment',
  diminish: 'Diminish',
  sequence: 'Sequence',
  fragment: 'Fragment',
});

/** The transforms in menu order. */
export const ROLL_TRANSFORMS: readonly RollTransformKind[] = Object.freeze(['invert', 'retrograde', 'augment', 'diminish', 'sequence', 'fragment']);

/** What runVoiceLeadingCheck reads. */
export interface VoiceLeadingCheckOptions {
  /** Check these parts (two or more); left out, the SATB-named parts, else the four highest (lib/rollComposer checkPick). */
  partIds?: readonly string[];
  /** Read the parts in this key (the COMPOSE column's HARMONY key when its CHECK asks); left out, or not a key, the roll's (effectiveRollKey). */
  key?: RollKey;
}

/** The roll as a composer request reads it: its key, meter and each SATB voice's range from its part. */
export interface RollComposeContext {
  key: RollKey;
  /** True when the key is the roll's own; false when it was read from the notes. */
  keySet: boolean;
  meterMap: MeterSegment[];
  pickupSteps: number;
  /** A range for each SATB voice whose roll part the orchestra registry knows. */
  ranges: PartRanges;
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
   * Named markers on the ruler (lib/rollMarkers): sections and movements, by
   * tick, sorted. Part of the document: undo covers every add, rename, move
   * and removal, a bounce copies them onto the clip as `sourceMarkers` (and to
   * EDIT's timeline), and a .tasmo clip saves them as `roll_markers`. A song
   * build writes FORM's sections here and keeps the user's own.
   */
  markers: RollMarker[];
  /**
   * The roll's key (lib/rollKey), which the voice-leading check, the figured
   * bass realizer and the diatonic transforms read; null reads the key from
   * the notes (estimateRollKey). Part of the document: undo tracks it. A plan
   * or a form written into the roll sets it to the key it was written in.
   */
  rollKey: RollKey | null;
  /**
   * The last voice-leading answer (RollVoiceLeading), or null. Analysis, not
   * the document: undo leaves it, and a new document (a clip, a multi-part
   * import) clears it.
   */
  voiceLeading: RollVoiceLeading | null;
  /**
   * The roman figures of the last plan, realized figured bass or form written
   * into the roll (a species answer's suspension figures too), by tick. The
   * harmony row shows them beside the flags. Analysis, like voiceLeading.
   */
  harmonyChords: RollChordLabel[];
  /** The harmony row over the ruler is open. A setting: persisted, never undo history. */
  showHarmony: boolean;
  /**
   * EXPRESSION: the composer's writes (a plan, a counterpoint, a FORM
   * movement) and Virtuoso's song build shape each part they write with
   * phrase expression (lib/clipNotes/expression: CC 1 and CC 11 curves from
   * its hairpins, slurs and density, and seeded attacks). A setting:
   * persisted, never undo history.
   */
  expressionOn: boolean;
  setExpressionOn: (on: boolean) => void;
  /** The figured-bass lane under the grid is open. A setting, like showHarmony. */
  showFiguredBass: boolean;
  setShowHarmony: (on: boolean) => void;
  setShowFiguredBass: (on: boolean) => void;
  /** Set the roll's key, or null to read it from the notes. One undo step; none when it is the same. */
  setRollKey: (key: RollKey | null) => void;
  /** Drop the flags and the figures the harmony row shows. */
  clearVoiceLeading: () => void;
  /**
   * Send the roll's parts to the voice-leading checker (composerApi.check):
   * `opts.partIds` when two or more are given, else the parts named Soprano,
   * Alto, Tenor and Bass when two or more are, else the four highest parts
   * (lib/rollComposer checkPick), with the roll's meter map and pickup, its
   * key (`opts.key`, else rollKey, else read from the parts), the figures of the last plan when
   * the roll holds some, and each part's range from the orchestra registry.
   * Stores the flags (`voiceLeading`) and opens the harmony row. Throws when
   * fewer than two parts hold notes, and the route's ApiError when it fails.
   */
  runVoiceLeadingCheck: (opts?: VoiceLeadingCheckOptions) => Promise<CheckResult>;
  /**
   * Select the notes a flag is about: the flagged parts' notes sounding at its
   * tick. When the part being edited is one of them its notes are selected;
   * otherwise the first flagged part becomes the one being edited. The
   * playhead moves to the flag. Returns how many notes were selected.
   */
  selectFlagNotes: (flag: VoiceLeadingFlag) => number;
  /**
   * Write `figure` under the bass note at `tick` of part `partId` (the part
   * being edited when left out); a blank figure removes the one there. One
   * undo step; none when nothing changes.
   */
  setFigure: (tick: number, figure: string, partId?: string) => void;
  /** Replace a part's figured bass (cleaned; null or an empty list removes it). One undo step; none when nothing changes. */
  setFiguredBass: (partId: string, marks: readonly FiguredBassMark[] | null) => void;
  /**
   * Realize part `partId`'s figured bass (the part being edited when left
   * out) in four parts (composerApi.continuo): its notes, one at a time, with
   * the figure under each, in the roll's key, meter and the ranges of the
   * roll's Soprano, Alto and Tenor parts. The upper three voices go into the
   * parts named Soprano, Alto and Tenor (made when the roll has none), in one
   * undo step; the bass part keeps its notes. The harmony row gets the roman
   * numerals and the flags. Throws when the part has no notes, and the
   * route's ApiError when it fails.
   */
  realizeFiguredBass: (partId?: string) => Promise<RollWriteResult>;
  /** Mark part `partId` as the cantus firmus (the mark leaves any other part), or clear the mark with null. One undo step. */
  setCantusFirmus: (partId: string | null) => void;
  /**
   * Write a plan's (composerApi.plan) four voices into the parts named
   * Soprano, Alto, Tenor and Bass, each at its ticks, replacing their notes; a
   * voice with no such part gets a new one on the registry's voice of that
   * name. One undo step. The roll takes the plan's key, and the harmony row
   * its roman figures and flags. The meter stays the roll's: ask for the plan
   * with rollComposeContext's meter map.
   */
  writePlanToRoll: (plan: PlanResult) => RollWriteResult;
  /**
   * Write a species, canon or fugue answer (composerApi species / canon /
   * fugue) into the roll, each voice into the part named after it
   * (lib/rollComposer voicePartName: "Counterpoint", "Leader", "Follower",
   * "Soprano"...) at its ticks, replacing that part's notes, or into a new
   * part. A species answer's cantus goes back into the part marked as the
   * cantus firmus when there is one, else into a part named "Cantus firmus"
   * that takes the mark. One undo step. The harmony row gets the answer's
   * flags (and a species answer's suspension figures).
   */
  writeCounterpoint: (result: SpeciesResult | CanonResult | FugueResult) => RollWriteResult;
  /**
   * Write movement `movementIndex` (default 0) of a realized form
   * (composerApi.realizeForm) into the roll: its SATB voices into the
   * Soprano, Alto, Tenor and Bass parts, its meter map (no pickup) and tempo
   * map as the document's, a movement marker with its title and a section
   * marker at each section's start (FORM's own: they replace the markers an
   * earlier form wrote and keep the user's), the movement's key, and every
   * section's figures and flags for the harmony row. One undo step. Returns
   * null for a movement the form does not have or did not realize.
   */
  writeFormMovement: (form: FormResult, movementIndex?: number) => RollWriteResult | null;
  /**
   * Transform the selected notes of the part being edited (lib/rollTransforms):
   * invert, retrograde, augment, diminish, sequence or fragment, invert and
   * sequence by scale degree in the roll's key unless `opts.diatonic` is
   * false. The transformed notes (a sequence's copies with them) stay
   * selected. One undo step. Returns how many notes are selected after, 0
   * when nothing was selected.
   */
  transformSelection: (kind: RollTransformKind, opts?: RollTransformOptions) => number;
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
  /** Set a part's bank select LSB (CC 32), 0-127, or null to send none. One undo step; no step when nothing changes. */
  setTrackBankLsb: (id: string, bankLsb: number | null) => void;
  /** Set a part's MIDI channel, 1-16 or null for the next free one. One undo step. */
  setTrackChannel: (id: string, channel: number | null) => void;
  /**
   * Put a part on an orchestral registry instrument (lib/orchestra): its GM
   * program and bank (with no bank LSB: the file's variation belonged to the
   * voice it replaces), the percussion channel for a kit, and its name when the
   * part still has a default name. null takes the instrument away and leaves
   * the program. One undo step.
   */
  setTrackInstrument: (id: string, instrumentId: string | null) => void;
  setTrackColor: (id: string, color: string) => void;
  setTrackMute: (id: string, mute: boolean) => void;
  setTrackSolo: (id: string, solo: boolean) => void;
  /** Replace a part's controller changes (cleaned; null or an empty list removes them). One undo step; no step when nothing changes. */
  setTrackControls: (id: string, controls: readonly RollControl[] | null) => void;
  /** Replace one part's notes (the active part's through `notes`). One undo step. */
  setPartNotes: (id: string, notes: PianoNote[]) => void;
  /**
   * Replace every part with `parts` (a multi-track MIDI file, a score): new
   * ids, no links, the first part (or `activeIndex`) active, and the grid
   * fitted to every part's notes. The meter, bends and tempo map are taken as
   * importNotes takes them. The parts are a new document, so its markers are
   * `markers` (a file's own), and none when left out. One undo step.
   */
  importParts: (
    parts: ReadonlyArray<Partial<RollTrack>>,
    bpm?: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
    tempoMap?: readonly TempoEvent[],
    activeIndex?: number,
    markers?: readonly RollMarkerInput[],
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
  /**
   * Mark `ids` with `articulation` (lib/articulationMap), or null for
   * ordinario. One undo step; none when every note already has it.
   */
  setArticulation: (ids: Iterable<string>, articulation: Articulation | null) => void;
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
  /**
   * CLEAR: remove every note, controller change and figure of the part being
   * edited and unlink it. The lanes' points bend every part's notes, so they clear
   * only when no other part holds notes; their ranges stay.
   */
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
   *  `markers` are the clip's; left out (a clip bounced before markers), the roll opens with none.
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
    markers?: readonly RollMarkerInput[],
    parts?: RollPartsLoad,
  ) => void;
  /** Replace the notes of the part being edited with imported notes (the other
   *  parts keep theirs), auto-fitting length (to a bar line, holding every
   *  part's notes) AND pitch range to the content: every generator's and
   *  every one-part import's write.
   *
   *  In a roll of one part, or one whose other parts hold no notes, the write
   *  sets the document too. A `meter` field left out keeps the roll's current
   *  value. `bends` replaces every lane's bend (a lane the roll ends without is
   *  dropped, and lanes past MAX_BENT_LANES lose their points); left out, every
   *  lane's points are cleared and its range stays, as CLEAR does, since the
   *  notes they bent are gone. `tempoMap` replaces the roll's map (a MIDI
   *  file's tempo changes); left out, a finite `bpm` makes the roll one tempo
   *  at `bpm`, since the notes were placed at that tempo, and no `bpm` keeps
   *  the map the roll has. `opts.markers` replaces the roll's markers (a file
   *  import passes the file's, a song build FORM's and the user's); left out,
   *  the markers stay. `opts.part` (a file's one part) sets the part's
   *  controller changes and, when it follows the roll's voice, its instrument,
   *  in the same undo step (RollPartImport); left out, the part keeps both.
   *
   *  While other parts hold notes they play by the document's tempo map,
   *  meter, lanes and bends, so the write changes the part's notes (and
   *  `opts.part`) and the grid's fit only, whatever it is handed; a note on a
   *  lane the roll does not have (or has with other time than the notes' own
   *  `meter.lanes`) goes to lane A, and the document's markers stay too. With
   *  `opts.document` the tempo map, meter, bends and markers it hands in
   *  replace the roll's as in a roll of one part, and bends it leaves out
   *  stay. Returns whether the document was kept (ImportNotesResult). */
  importNotes: (
    notes: PianoNote[],
    bpm?: number,
    meter?: Partial<RollMeter>,
    bends?: readonly LaneBend[],
    tempoMap?: readonly TempoEvent[],
    opts?: ImportNotesOptions,
  ) => ImportNotesResult;
  /** Place a live recording WITHOUT shrinking the grid (keeps at least the 256
   *  default, rounded up to a bar), expanding the pitch range to fit, and marks the recorded span. */
  placeRecording: (notes: PianoNote[], range: { startStep: number; endStep: number }) => void;
  setMeterMap: (map: MeterSegment[]) => void;
  setPickupSteps: (steps: number) => void;
  /** Replace the lanes (sanitized). A note on a lane that goes moves to lane 0, in every part, and the lane's bend goes. */
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
  /**
   * Remove a lane; its notes move to lane 0 in every part (lanes are the
   * document's), and its bend too when lane 0 has no points. Lane 0 cannot be
   * removed.
   */
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
   *  arrives starts unbent (MATCH, and the METER face's ADD LANE); a note on a
   *  lane that goes moves to lane 0, in every part. */
  applyMeter: (meter: Partial<RollMeter>, merge?: boolean) => void;
  /**
   * Add a marker at `tick` (or `step`; neither = the playhead), a section
   * unless `kind` says otherwise, named the next free rehearsal letter or roman
   * numeral unless `name` is given. When one of its kind is already at that
   * tick, nothing is added: that marker stays, renamed to `name` when a name is
   * given, and its id is returned, so the caller selects it. Returns the id.
   */
  addMarker: (marker: RollMarkerInput) => string;
  /**
   * Rename, move (`tick` or `step`) or retype a marker. Any edit makes a FORM
   * marker the user's own. A move or retype onto the place of another marker of
   * that kind is refused (the marker keeps its place and kind; a rename in the
   * same patch still applies), so no edit removes a neighbour.
   */
  updateMarker: (id: string, patch: Omit<RollMarkerInput, 'id' | 'origin'>) => void;
  removeMarker: (id: string) => void;
  /** Replace every marker (sanitized). */
  setMarkers: (markers: readonly RollMarkerInput[]) => void;

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
 *  it back. The ruler's markers are here because a clip and a .tasmo save
 *  them: an add, a rename, a move (one step per drag) and a removal are steps.
 *  The roll's key is here because a plan, a form and the key picker set it,
 *  and the check and the transforms read it.
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
  markers: RollMarker[];
  /** The roll's key. Absent from a step written before the roll had one, which then keeps the key the roll has. */
  rollKey?: RollKey | null;
  /** The linked clip before the step, present only when the step's write changed it. */
  editingClipId?: string | null;
}

const DEFAULT_STEPS = 256;

const MIN_STEPS = 16;
// The roll's longest grid: 65,536 sixteenths, 4,096 bars of 4/4, a symphony
// movement. It is the bend lane's MAX_BEND_STEP, so the two limits never part:
// a bend point can sit wherever a note can.
const MAX_STEPS = MAX_BEND_STEP;
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

const uidMarker = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `mk-${crypto.randomUUID()}` : `mk-${Math.random().toString(36).slice(2)}-${Date.now()}`;

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
const validExpr = (e: unknown): NoteExpression | undefined => sanitizeNoteExpression(e);

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
  if (!isArticulation(n.articulation)) delete out.articulation;
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
  if ('articulation' in out && !isArticulation(out.articulation)) delete out.articulation;
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

// ── The Expression setting, persisted ───────────────────────────────────────

const EXPRESSION_KEY = 'thedaw.roll.expression.v1';

const loadExpressionOn = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(EXPRESSION_KEY) === '1';
  } catch {
    return false;
  }
};

const saveExpressionOn = (on: boolean): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(EXPRESSION_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota: the setting just does not survive the reload */
  }
};

// ── The composer rows' settings, persisted ──────────────────────────────────

const COMPOSE_VIEW_KEY = 'thedaw.roll.compose.v1';

const loadComposeView = (): { showHarmony: boolean; showFiguredBass: boolean } => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('no storage');
    const raw = localStorage.getItem(COMPOSE_VIEW_KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    return { showHarmony: o?.showHarmony === true, showFiguredBass: o?.showFiguredBass === true };
  } catch {
    return { showHarmony: false, showFiguredBass: false };
  }
};

const saveComposeView = (v: { showHarmony: boolean; showFiguredBass: boolean }): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COMPOSE_VIEW_KEY, JSON.stringify(v));
  } catch {
    /* private mode / quota: the rows just do not survive the reload */
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

/** The part marked as the cantus firmus, with its real notes, or null: what a species request sends as its `cantus`. */
export const cantusFirmusOf = (s: PartsView): RollTrack | null => rollTracksOf(s).find((t) => t.cantusFirmus === true) ?? null;

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

/**
 * True when a part other than the one being edited holds notes: those notes
 * play by the document's tempo map, meter, lanes and bends, so a write into the
 * active part leaves them alone (importNotes, CLEAR, lib/rollTakes importTake).
 */
export const otherPartsHoldNotes = (s: Pick<PianoRollState, 'tracks' | 'activeTrackId'>): boolean =>
  s.tracks.some((t) => t.id !== s.activeTrackId && t.notes.length > 0);

/** A note without its lane: lane 0, which spans the whole roll. */
const withoutLane = (n: PianoNote): PianoNote => {
  if (n.lane === undefined) return n;
  const { lane: _drop, ...rest } = n;
  return rest;
};

/** The JSON of a lane's time: its loop, span, meter map and tuplet. Two lanes with the same text keep time alike. */
const laneTimeText = (l: PolyLane): string =>
  JSON.stringify([l.cycleSteps ?? null, l.span ?? null, l.meterMap ?? null, l.tuplet ?? null]);

/**
 * `notes` for a roll that keeps its lanes `lanes`: a note keeps its lane when
 * the roll has it and, for notes that came with lanes of their own
 * (`incoming`), when that lane keeps the same time in both; any other note goes
 * to lane 0, so it never joins a lane that loops or counts otherwise.
 */
const notesOnLanes = (notes: readonly PianoNote[], lanes: readonly PolyLane[], incoming?: readonly PolyLane[]): PianoNote[] => {
  const theirs = incoming ? new Map(sanitizeLanes(incoming).map((l): [number, string] => [l.id, laneTimeText(l)])) : null;
  const kept = new Set(lanes.filter((l) => l.id !== 0 && (!theirs || theirs.get(l.id) === laneTimeText(l))).map((l) => l.id));
  return notes.map((n) => (n.lane === undefined || n.lane === 0 || kept.has(n.lane) ? n : withoutLane(n)));
};

/** `list` with every note on a lane not in `live` moved to lane 0; the same array when none moves. */
const onLiveLanes = (list: PianoNote[], live: ReadonlySet<number>): PianoNote[] =>
  list.some((n) => n.lane !== undefined && !live.has(n.lane))
    ? list.map((n) => (n.lane !== undefined && !live.has(n.lane) ? withoutLane(n) : n))
    : list;

/**
 * Every part's notes with a lane `lanes` does not have moved to lane 0. The
 * lanes belong to the document, so a lane that goes takes no part's notes
 * with it, and a lane added later with its id finds none of them. The active
 * part's notes are `notes` (its entry in `tracks` is stale until it is left,
 * when `notes` replaces it). The same arrays when no note moves, so a lane
 * edit that leaves the notes records nothing for them.
 */
const partsOnLanes = (
  s: Pick<PianoRollState, 'notes' | 'tracks' | 'activeTrackId'>,
  lanes: readonly PolyLane[],
): Pick<PianoRollState, 'notes' | 'tracks'> => {
  const live = new Set(lanes.map((l) => l.id));
  let moved = false;
  const tracks = s.tracks.map((t) => {
    if (t.id === s.activeTrackId) return t;
    const notes = onLiveLanes(t.notes, live);
    if (notes === t.notes) return t;
    moved = true;
    return { ...t, notes };
  });
  return { notes: onLiveLanes(s.notes, live), tracks: moved ? tracks : s.tracks };
};

/** The id a new lane takes: past every lane, and past every lane a note of any part still names (a clip saved before lanes moved their notes). */
const nextLaneId = (s: Pick<PianoRollState, 'lanes' | 'notes' | 'tracks' | 'activeTrackId'>): number => {
  let top = s.lanes.reduce((m, l) => Math.max(m, l.id), 0);
  for (const part of rollTracksOf(s)) {
    for (const n of part.notes) if (n.lane !== undefined && n.lane > top) top = n.lane;
  }
  return top + 1;
};

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

/** A part with its bank select LSB set to `bankLsb`: the field removed when it sends none. */
const withBankLsb = (t: RollTrack, bankLsb: number | undefined): RollTrack => {
  if (bankLsb !== undefined) return t.bankLsb === bankLsb ? t : { ...t, bankLsb };
  if (t.bankLsb === undefined) return t;
  const { bankLsb: _drop, ...rest } = t;
  return rest;
};

/** A part with its controller changes set to `controls`: the field removed when there are none. */
const withControls = (t: RollTrack, controls: RollControl[] | undefined): RollTrack => {
  if (controls?.length) return { ...t, controls };
  if (t.controls === undefined) return t;
  const { controls: _drop, ...rest } = t;
  return rest;
};

/** True when two controller lists hold the same changes in the same order. */
const sameControls = (a: readonly RollControl[] | undefined, b: readonly RollControl[] | undefined): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((c, i) => c.tick === y[i].tick && c.controller === y[i].controller && c.value === y[i].value);
};

/**
 * What putting part `t` on registry instrument `inst` changes: its program, its
 * bank (a kit takes the melodic set's), the percussion channel for a kit (off it
 * for a melodic instrument), and its name while the part still has a default one.
 */
const instrumentPatchOf = (tracks: readonly RollTrack[], t: RollTrack, inst: OrchestraInstrument): Partial<RollTrack> => ({
  instrumentId: inst.id,
  program: inst.program,
  bank: inst.percussion ? 0 : cleanPartBank(inst.bank),
  channel: inst.percussion ? PERCUSSION_PART_CHANNEL : t.channel === PERCUSSION_PART_CHANNEL ? null : t.channel,
  ...(isDefaultPartName(t.name) ? { name: uniquePartName(tracks, inst.name, t.id) } : {}),
});

/** The channel a part takes with `percussion` given: 10 for true, off 10 for false, its own when left out. */
const percussionChannelOf = (t: RollTrack, percussion: boolean | undefined): number | null =>
  percussion === true
    ? PERCUSSION_PART_CHANNEL
    : percussion === false && t.channel === PERCUSSION_PART_CHANNEL
      ? null
      : t.channel;

/**
 * The parts after an import into the part being edited that carries `part`
 * (RollPartImport): its controller changes replace the part's own, and a part
 * that follows the roll's voice takes the file's registry instrument (when the
 * file sets no program, or that instrument's), else the file's program. An
 * empty patch when nothing changes.
 */
const importedPartSlice = (s: PianoRollState, part: RollPartImport): Partial<PianoRollState> => {
  const i = s.tracks.findIndex((t) => t.id === s.activeTrackId);
  if (i < 0) return {};
  const before = s.tracks[i];
  let t = before;
  if (part.controls !== undefined) {
    const next = cleanPartControls(part.controls);
    if (!sameControls(t.controls, next)) t = withControls(t, next);
  }
  if (before.program === null) {
    const inst = orchestraInstrument(part.instrumentId);
    if (inst && (part.program == null || inst.program === part.program)) {
      t = { ...t, ...instrumentPatchOf(s.tracks, t, inst) };
    } else if (part.program != null) {
      t = withoutInstrument({ ...t, program: cleanPartProgram(part.program), channel: percussionChannelOf(t, part.percussion) });
    }
  }
  if (t === before) return {};
  const tracks = s.tracks.slice();
  tracks[i] = t;
  return { tracks };
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
  markers: s.markers,
  rollKey: s.rollKey,
});

/** Write the feel record from the store, after a write that moved one of its fields. */
const saveFeelOf = (s: PianoRollState): void =>
  saveFeel({ quantizePct: s.quantizePct, swingPct: s.swingPct, grooveId: s.grooveId, voiceProgram: s.voiceProgram });

/** `snap` carrying `link` when `step` carries a link, so the opposite stack's step puts the link back too. */
const withLink = (snap: RollHistorySnapshot, step: RollHistorySnapshot, link: string | null): RollHistorySnapshot =>
  'editingClipId' in step ? { ...snap, editingClipId: link } : snap;

// ── Composer writes ─────────────────────────────────────────────────────────

type KeySource = Pick<PianoRollState, 'rollKey' | 'tracks' | 'activeTrackId' | 'notes'>;

/** The key the roll reads in: its own (`rollKey`), else the key its parts' notes are in (lib/rollKey estimateRollKey). */
export const effectiveRollKey = (s: KeySource): RollKey => s.rollKey ?? estimateRollKey(allPartNotes(rollTracksOf(s)));

/**
 * The roll as a composer request reads it (RollComposeContext): its key, its
 * meter map and pickup, and the range of each SATB voice whose part (by name)
 * the orchestra registry knows. A plan, a continuo or a check asked with it
 * fits the roll it is written back into.
 */
export const rollComposeContext = (s: KeySource & Pick<PianoRollState, 'meterMap' | 'pickupSteps'>): RollComposeContext => {
  const tracks = rollTracksOf(s);
  const ranges: PartRanges = {};
  for (const role of SATB) {
    const t = tracks.find((x) => satbRoleOf(x.name) === role);
    const r = t ? partRange(t) : null;
    if (r) ranges[role] = r;
  }
  return {
    key: effectiveRollKey(s),
    keySet: s.rollKey !== null,
    meterMap: s.meterMap.map((seg) => ({ bar: seg.bar, meter: { ...seg.meter, groups: [...seg.meter.groups] } })),
    pickupSteps: s.pickupSteps,
    ranges,
  };
};

/** The parts after a composer write, the notes of the part being edited, and the part each write went into. */
interface PartsWrite {
  tracks: RollTrack[];
  notes: PianoNote[];
  /** The part being edited after the write: the one before, or the first written when that one was a spare empty part the write dropped. */
  activeId: string;
  /** The part each write went into, in the writes' order; null for one left out. */
  idsByWrite: (string | null)[];
  created: number;
  skipped: number;
}

/**
 * An empty part a composer write into an empty roll leaves out: a default
 * name, no notes, and nothing set on it that the write would lose (a registry
 * instrument, figures, the cantus firmus mark).
 */
const isSparePart = (t: RollTrack): boolean =>
  t.notes.length === 0 && isDefaultPartName(t.name) && !t.instrumentId && !t.cantusFirmus && !t.figuredBass?.length;

/**
 * `writes` into the roll's parts: each into the part it names (a cantus into
 * the part marked as the cantus firmus first), replacing its notes, or into a
 * new part named after it on the registry instrument the write names. A part
 * takes one write at most. Past MAX_ROLL_PARTS a write that needs a new part
 * is left out. On a roll with no notes in any part the spare empty parts
 * (isSparePart) go, so the answer becomes the roll and its first voice the
 * part being edited.
 */
const writeParts = (s: PianoRollState, writes: readonly PartWrite[]): PartsWrite => {
  let tracks = rollTracksOf(s).slice();
  if (writes.length > 0 && tracks.every((t) => t.notes.length === 0)) tracks = tracks.filter((t) => !isSparePart(t));
  const written = new Set<string>();
  const idsByWrite: (string | null)[] = [];
  let created = 0;
  let skipped = 0;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const w of writes) {
    const notes = migrateNotes(w.notes);
    const markCantus = w.cantus === true && !tracks.some((t) => t.cantusFirmus);
    let i = w.cantus ? tracks.findIndex((t) => t.cantusFirmus && !written.has(t.id)) : -1;
    if (i < 0) i = tracks.findIndex((t) => !written.has(t.id) && same(t.name, w.name));
    if (i >= 0) {
      const t = tracks[i];
      tracks[i] = { ...t, notes, ...(markCantus ? { cantusFirmus: true } : {}) };
      written.add(t.id);
      idsByWrite.push(t.id);
      continue;
    }
    if (tracks.length >= MAX_ROLL_PARTS) {
      skipped += 1;
      idsByWrite.push(null);
      continue;
    }
    let t = makeRollTrack({ name: uniquePartName(tracks, w.name, ''), color: nextPartColor(tracks), notes }, tracks.length);
    const inst = orchestraInstrument(w.instrumentId);
    if (inst) t = { ...t, ...instrumentPatchOf(tracks, t, inst) };
    if (markCantus) t.cantusFirmus = true;
    tracks = [...tracks, t];
    written.add(t.id);
    idsByWrite.push(t.id);
    created += 1;
  }
  const active = tracks.find((t) => t.id === s.activeTrackId) ?? tracks.find((t) => written.has(t.id)) ?? tracks[0];
  return { tracks, notes: active.notes, activeId: active.id, idsByWrite, created, skipped };
};

/**
 * `done` with every part it wrote shaped by phrase expression
 * (lib/clipNotes/expression): its attacks moved and its CC 1 and CC 11 set
 * from its phrases, which `boundaries` (section starts) split again. The
 * part's other controllers stay. A percussion part is left as written.
 */
const expressedWrite = (done: PartsWrite, boundaries: readonly number[] = []): PartsWrite => {
  const written = new Set(done.idsByWrite.filter((id): id is string => !!id));
  const tracks = done.tracks.map((t, i) => {
    if (!written.has(t.id) || !t.notes.length || isPercussionPart(t)) return t;
    const r = buildExpression(t.notes, {
      seed: i + 1,
      boundaries,
      instrument: { instrumentId: t.instrumentId, program: t.program },
    });
    return withControls({ ...t, notes: migrateNotes(r.notes) }, cleanPartControls(withExpressionControls(t.controls, r.controls)));
  });
  const active = tracks.find((t) => t.id === done.activeId) ?? tracks[0];
  return { ...done, tracks, notes: active.notes };
};

/** The part being edited moved to `done.activeId` (the write left the one before out): its clip link comes along, as setActiveTrack's does. */
const writtenActive = (s: PianoRollState, done: PartsWrite): Partial<PianoRollState> => {
  if (done.activeId === s.activeTrackId) return {};
  const partLinks = withPartLink(s.partLinks, s.activeTrackId, s.editingClipId);
  return { activeTrackId: done.activeId, editingClipId: partLinks[done.activeId] ?? null, partLinks };
};

/** The grid after a write: long enough (to a bar line) for every part's notes, never shorter than it was, and tall enough for them. */
const grownGrid = (
  s: Pick<PianoRollState, 'totalSteps' | 'lowestNote' | 'highestNote'>,
  tracks: readonly RollTrack[],
  meterMap: MeterSegment[],
  pickupSteps: number,
): Pick<PianoRollState, 'totalSteps' | 'lowestNote' | 'highestNote'> => {
  const all = allPartNotes(tracks);
  const end = all.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  const lo = all.reduce((m, n) => Math.min(m, n.note), 127);
  const hi = all.reduce((m, n) => Math.max(m, n.note), 0);
  return {
    totalSteps: Math.min(MAX_STEPS, roundUpToBar(meterMap, Math.max(MIN_STEPS, s.totalSteps, end), pickupSteps)),
    lowestNote: all.length ? Math.max(0, Math.min(s.lowestNote, lo - 2)) : s.lowestNote,
    highestNote: all.length ? Math.min(127, Math.max(s.highestNote, hi + 2)) : s.highestNote,
  };
};

/** The voice-leading answer a write came back with, its part names mapped onto the parts the write went into. */
const writtenVoiceLeading = (
  w: ComposerWrite,
  done: PartsWrite,
  source: RollVoiceLeading['source'],
  key: RollKey,
  extra: Record<string, string> = {},
): RollVoiceLeading => {
  const ids: Record<string, string> = { ...extra };
  w.writes.forEach((wr, i) => {
    const id = done.idsByWrite[i];
    if (id) ids[wr.voice] = id;
  });
  const notesAt: Record<string, PianoNote[]> = {};
  for (const id of Object.values(ids)) {
    const t = done.tracks.find((x) => x.id === id);
    if (t) notesAt[id] = t.notes;
  }
  return { flags: w.flags, ids, notesAt, key, source };
};

const writeResultOf = (done: PartsWrite): RollWriteResult => ({
  partIds: done.idsByWrite.filter((id): id is string => !!id),
  created: done.created,
  skipped: done.skipped,
});

/** A roman numeral figure the checker reads as harmony: 'I', 'V7/V', 'bVI', 'N6', 'It6', 'Ger65'. */
const ROMAN_FIGURE = /^[#b♭♯]*(?:[ivIV]+|N|It|Fr|Ger)/;

/** True when two keys are the same key (or both none). */
const sameRollKey = (a: RollKey | null, b: RollKey | null): boolean =>
  a === b || (!!a && !!b && a.tonic === b.tonic && a.mode === b.mode);

/** True when two figured basses hold the same figures at the same ticks. */
const sameFigures = (a: readonly FiguredBassMark[] | undefined, b: readonly FiguredBassMark[] | undefined): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((m, i) => m.tick === y[i].tick && m.figure === y[i].figure);
};

/** A part with its figured bass set to `marks`: the field removed when there are none. */
const withFiguredBass = (t: RollTrack, marks: FiguredBassMark[] | undefined): RollTrack => {
  if (marks?.length) return { ...t, figuredBass: marks };
  if (t.figuredBass === undefined) return t;
  const { figuredBass: _drop, ...rest } = t;
  return rest;
};

/** Write the composer rows' settings from the store. */
const saveComposeViewOf = (s: Pick<PianoRollState, 'showHarmony' | 'showFiguredBass'>): void =>
  saveComposeView({ showHarmony: s.showHarmony, showFiguredBass: s.showFiguredBass });

/**
 * A composer answer's voices written into the roll's parts in one undo step
 * (writeParts), the grid grown to hold them, the answer's figures and flags
 * for the harmony row (which opens when there are any), and, with `setKey`,
 * the answer's key as the roll's. `extraIds` maps flag part names the writes
 * do not carry (a continuo's bass) onto their parts; `readKey` is the key the
 * answer was asked in.
 */
const commitComposerWrite = (
  w: ComposerWrite,
  source: RollVoiceLeading['source'],
  setKey: boolean,
  extraIds: Record<string, string> = {},
  readKey?: RollKey,
  expressive = false,
): RollWriteResult => {
  let out: RollWriteResult = { partIds: [], created: 0, skipped: 0 };
  cutHistoryBurst();
  usePianoRollStore.setState((s) => {
    const written = writeParts(s, w.writes);
    // EXPRESSION on: each written part shaped by its phrases (expressedWrite).
    const done = expressive && s.expressionOn ? expressedWrite(written) : written;
    out = writeResultOf(done);
    const key = setKey && w.key ? w.key : null;
    const vlKey = key ?? readKey ?? effectiveRollKey({ ...s, tracks: done.tracks, notes: done.notes, activeTrackId: done.activeId });
    return {
      tracks: done.tracks,
      notes: done.notes,
      ...writtenActive(s, done),
      ...selectionOf(done.notes, s.selectedIds, s.selectedNoteId),
      ...grownGrid(s, done.tracks, s.meterMap, s.pickupSteps),
      ...(key && !sameRollKey(key, s.rollKey) ? { rollKey: key } : {}),
      harmonyChords: w.chords,
      voiceLeading: writtenVoiceLeading(w, done, source, vlKey, extraIds),
      ...(w.chords.length || w.flags.length ? { showHarmony: true } : {}),
    };
  });
  cutHistoryBurst();
  saveComposeViewOf(usePianoRollStore.getState());
  return out;
};

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
  markers: [],
  rollKey: null,
  voiceLeading: null,
  harmonyChords: [],
  ...loadComposeView(),
  expressionOn: loadExpressionOn(),
  setExpressionOn: (on) => {
    set({ expressionOn: on === true });
    saveExpressionOn(on === true);
  },
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
      const channel = percussionChannelOf(t, percussion);
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
  setTrackBankLsb: (id, bankLsb) =>
    set((s) => {
      const i = s.tracks.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const next = withBankLsb(s.tracks[i], cleanPartBankLsb(bankLsb));
      // The same value writes nothing, so it adds no undo step.
      if (next === s.tracks[i]) return {};
      const tracks = s.tracks.slice();
      tracks[i] = next;
      return { tracks };
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
      // A kit is chosen by its program on the percussion channel; the bank is the melodic set's.
      const patched = patchTrack(s.tracks, id, instrumentPatchOf(s.tracks, t, inst));
      // The instrument's own bank, with no LSB: a file's variation belonged to the voice it replaces.
      const tracks = (patched ?? s.tracks).map((x) => (x.id === id ? withBankLsb(x, undefined) : x));
      return tracks.some((x, i) => x !== s.tracks[i]) ? { tracks } : {};
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
  setTrackControls: (id, controls) =>
    set((s) => {
      const i = s.tracks.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const next = cleanPartControls(controls ?? []);
      // An equal list writes nothing, so it adds no undo step.
      if (sameControls(s.tracks[i].controls, next)) return {};
      const tracks = s.tracks.slice();
      tracks[i] = withControls(tracks[i], next);
      return { tracks };
    }),
  setPartNotes: (id, incoming) =>
    set((s) => {
      if (id === s.activeTrackId) return { notes: migrateNotes(incoming), ...noSelection() };
      const tracks = patchTrack(s.tracks, id, { notes: migrateNotes(incoming) });
      return tracks ? { tracks } : {};
    }),
  importParts: (parts, bpm, meter, incomingBends, incomingTempo, activeIndex = 0, incomingMarkers) =>
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
        // A new document: the file's markers, else none (the previous document's go with its parts).
        markers: sanitizeRollMarkers(incomingMarkers ?? []),
        // Its key is read from its notes until one is chosen, and the last check's flags were about the parts it replaces.
        rollKey: null,
        voiceLeading: null,
        harmonyChords: [],
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

  setArticulation: (ids, articulation) =>
    set((s) => {
      const want = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
      const art = isArticulation(articulation) ? articulation : undefined;
      let changed = false;
      const notes = s.notes.map((n) => {
        if (!want.has(n.id) || n.articulation === art) return n;
        changed = true;
        if (art) return { ...n, articulation: art };
        const { articulation: _drop, ...rest } = n;
        return rest;
      });
      return changed ? { notes } : {};
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
    set((s) => {
      // The part's controller changes and figures go with its notes: they shaped and figured notes that are gone.
      const active = s.tracks.find((t) => t.id === s.activeTrackId);
      const tracks = active?.controls || active?.figuredBass
        ? s.tracks.map((t) => (t === active ? withFiguredBass(withControls(t, undefined), undefined) : t))
        : s.tracks;
      return {
        notes: [],
        tracks,
        ...noSelection(),
        editingClipId: null,
        recordedRange: null,
        // The lanes' points bend every part's notes: they go with the last notes, never with one part's.
        ...(otherPartsHoldNotes(s) ? {} : { bends: clearedBends(s.bends) }),
      };
    }),

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
  loadFromClip: (clipId, incoming, bpm, totalSteps, meter, incomingBends, incomingTempo, incomingMarkers, parts) => {
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
          markers: sanitizeRollMarkers(incomingMarkers ?? []),
          // A clip opens with its key read from its notes, and without the flags of the roll it replaces.
          rollKey: null,
          voiceLeading: null,
          harmonyChords: [],
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

  importNotes: (incoming, bpm, meter, incomingBends, incomingTempo, opts) => {
    const shared = otherPartsHoldNotes(get());
    const keptDocument = shared && opts?.document !== true;
    set((s) => {
      if (keptDocument) {
        // The other parts play by the document's tempo map, meter, lanes and
        // bends, so a write into this part changes its notes and the fit only,
        // and the file part's controllers and instrument, which are its own.
        const notes = migrateNotes(notesOnLanes(incoming, s.lanes, meter?.lanes));
        return {
          notes,
          ...(opts?.part ? importedPartSlice(s, opts.part) : {}),
          // The grid still holds every other part's notes.
          ...(notes.length ? fitToNotes([...notes, ...otherPartNotes(s)], s.meterMap, s.pickupSteps) : {}),
          ...noSelection(),
          currentStep: 0,
          isPlaying: false,
          recordedRange: null,
        };
      }
      const notes = migrateNotes(incoming);
      const markers = opts?.markers ? { markers: sanitizeRollMarkers(opts.markers) } : {};
      const m = mergeMeter(s, meter);
      // Other parts' notes still sound through the lanes' points, so a write that owns the maps keeps the bends it leaves out.
      const bends = shared && !incomingBends ? bendsAcrossLanes(s.bends, s.lanes, m.lanes) : replacedBends(s, m.lanes, incomingBends);
      const finiteBpm = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
      // The file's own map, or one tempo at the tempo the notes were placed at, or the roll's map as it is.
      const tempo = incomingTempo
        ? tempoSlice(sanitizeRollTempoMap(incomingTempo, finiteBpm ? importedRollBpm(bpm) : s.bpm))
        : finiteBpm
          ? tempoSlice(oneTempo(importedRollBpm(bpm)))
          : {};
      // Lanes that go take no other part's notes with them.
      const others = shared && meter?.lanes ? { tracks: partsOnLanes({ notes, tracks: s.tracks, activeTrackId: s.activeTrackId }, m.lanes).tracks } : {};
      // The file's part: its controller changes, and its instrument for a part
      // that has none of its own, over the parts `others` left. In this write,
      // so one step.
      const partSlice = opts?.part ? importedPartSlice({ ...s, ...others }, opts.part) : {};
      if (notes.length === 0) {
        return { notes, ...others, ...partSlice, ...m, bends, ...tempo, ...markers, ...noSelection(), currentStep: 0, isPlaying: false, recordedRange: null };
      }
      return {
        notes,
        ...others,
        ...partSlice,
        ...m,
        bends,
        ...markers,
        // The notes go into the active part; the grid still holds every other part's.
        ...fitToNotes([...notes, ...otherPartNotes(s)], m.meterMap, m.pickupSteps),
        ...noSelection(),
        currentStep: 0,
        isPlaying: false,
        recordedRange: null,
        ...tempo,
      };
    });
    return { keptDocument };
  },

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
        // A lane that goes takes no part's notes with it.
        ...(meter.lanes ? partsOnLanes(s, m.lanes) : {}),
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
        ...partsOnLanes(s, next),
        activeLane: next.some((l) => l.id === s.activeLane) ? s.activeLane : 0,
        bends: bendsForLanes(s.bends, next),
      };
    }),
  setActiveLane: (id) => set((s) => (s.lanes.some((l) => l.id === id) ? { activeLane: id } : {})),
  addLane: (cycleSteps = null) => {
    const s = get();
    const { lanes, bends } = s;
    const id = nextLaneId(s);
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
      const lanes = s.lanes.filter((l) => l.id !== id);
      return {
        lanes,
        // Every part's notes on the lane, the parts not being edited too: lanes are the document's.
        ...partsOnLanes(s, lanes),
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

  addMarker: (marker) => {
    const s = get();
    const kind = isRollMarkerKind(marker.kind) ? marker.kind : 'section';
    const id = typeof marker.id === 'string' && marker.id.trim() ? marker.id.trim() : uidMarker();
    const tick = isNum(marker.tick) && marker.tick >= 0 ? Math.round(marker.tick) : markerTickOfStep(isNum(marker.step) ? marker.step : s.currentStep);
    // A place already holding one of this kind keeps it: the new marker would otherwise replace it.
    const there = markerAtPlace(s.markers, kind, tick, id);
    if (there) {
      if (typeof marker.name === 'string' && marker.name.trim()) get().updateMarker(there.id, { name: marker.name });
      return there.id;
    }
    const name = cleanMarkerName(marker.name, nextMarkerName(s.markers, kind));
    set((st) => ({ markers: sanitizeRollMarkers([...st.markers.filter((m) => m.id !== id), { id, tick, name, kind }]) }));
    return id;
  },
  updateMarker: (id, patch) =>
    set((s) => {
      const found = s.markers.find((m) => m.id === id);
      if (!found) return {};
      let kind = isRollMarkerKind(patch.kind) ? patch.kind : found.kind;
      let tick = isNum(patch.tick) && patch.tick >= 0
        ? Math.round(patch.tick)
        : isNum(patch.step) ? markerTickOfStep(patch.step) : found.tick;
      // Landing on another marker of this kind would remove it (one of a kind per place): refuse the move,
      // and the retype too when the marker's own place already holds one of the new kind.
      if (markerAtPlace(s.markers, kind, tick, id)) {
        tick = found.tick;
        if (markerAtPlace(s.markers, kind, tick, id)) kind = found.kind;
      }
      const name = 'name' in patch ? cleanMarkerName(patch.name, found.name) : found.name;
      // An edit that changes nothing writes nothing, so a held drag records no step of its own.
      if (tick === found.tick && name === found.name && kind === found.kind) return {};
      // The edited marker is the user's now: no origin, so the next song build keeps it.
      const next = sanitizeRollMarkers([...s.markers.filter((m) => m.id !== id), { id, tick, name, kind }]);
      return sameRollMarkers(next, s.markers) ? {} : { markers: next };
    }),
  removeMarker: (id) =>
    set((s) => {
      const markers = s.markers.filter((m) => m.id !== id);
      return markers.length === s.markers.length ? {} : { markers };
    }),
  setMarkers: (list) =>
    set((s) => {
      const markers = sanitizeRollMarkers(list);
      return sameRollMarkers(markers, s.markers) ? {} : { markers };
    }),

  setShowHarmony: (on) => {
    set({ showHarmony: on === true });
    saveComposeViewOf(get());
  },
  setShowFiguredBass: (on) => {
    set({ showFiguredBass: on === true });
    saveComposeViewOf(get());
  },
  setRollKey: (key) =>
    set((s) => {
      const next = key === null ? null : cleanRollKey(key);
      if (key !== null && next === null) return {};
      return sameRollKey(next, s.rollKey) ? {} : { rollKey: next };
    }),
  clearVoiceLeading: () => set((s) => (s.voiceLeading === null && s.harmonyChords.length === 0 ? {} : { voiceLeading: null, harmonyChords: [] })),
  runVoiceLeadingCheck: async (opts = {}) => {
    const s = get();
    const pick = checkPick(rollTracksOf(s), opts.partIds);
    if (!pick) throw new Error('A voice-leading check needs two parts with notes');
    const key = cleanRollKey(opts.key) ?? effectiveRollKey(s);
    // The roman figures of a plan, a continuo or a form say what the harmony is; a suspension's '7-6' or a bare figure does not.
    const harmony = s.harmonyChords.filter((c) => ROMAN_FIGURE.test(c.figure));
    const result = await composerApi.check({
      parts: pick.parts,
      order: pick.order,
      key: key.tonic,
      mode: key.mode,
      ...(harmony.length ? { chords: harmony.map((c) => ({ tick: c.tick, figure: c.figure, ...(c.key ? { key: c.key } : {}) })) } : {}),
      ranges: pick.ranges,
      meterMap: s.meterMap,
      pickupSteps: s.pickupSteps,
    });
    const notesAt: Record<string, PianoNote[]> = {};
    for (const [name, id] of Object.entries(pick.ids)) notesAt[id] = pick.parts[name];
    set({ voiceLeading: { flags: result.flags, ids: pick.ids, notesAt, key, source: 'check' }, showHarmony: true });
    saveComposeViewOf(get());
    return result;
  },
  selectFlagNotes: (flag) => {
    const s = get();
    const vl = s.voiceLeading;
    if (!vl) return 0;
    const byPart = flagNoteIds(flag, vl.ids, rollTracksOf(s));
    const step = Math.max(0, flag.tick) / ticksPerStep();
    const target = byPart.has(s.activeTrackId) ? s.activeTrackId : [...byPart.keys()][0];
    if (target && target !== s.activeTrackId) get().setActiveTrack(target);
    const ids = target ? byPart.get(target) ?? [] : [];
    if (ids.length) get().setSelection(ids);
    get().seek(step);
    return ids.length;
  },
  setFigure: (tick, figure, partId) =>
    set((s) => {
      const id = partId ?? s.activeTrackId;
      const i = s.tracks.findIndex((t) => t.id === id);
      if (i < 0 || !isNum(tick)) return {};
      const at = Math.max(0, Math.round(tick));
      const text = cleanFigure(figure);
      const rest = (s.tracks[i].figuredBass ?? []).filter((m) => m.tick !== at);
      const next = cleanFiguredBass(text ? [...rest, { tick: at, figure: text }] : rest);
      if (sameFigures(s.tracks[i].figuredBass, next)) return {};
      const tracks = s.tracks.slice();
      tracks[i] = withFiguredBass(tracks[i], next);
      return { tracks };
    }),
  setFiguredBass: (partId, marks) =>
    set((s) => {
      const i = s.tracks.findIndex((t) => t.id === partId);
      if (i < 0) return {};
      const next = cleanFiguredBass(marks ?? []);
      if (sameFigures(s.tracks[i].figuredBass, next)) return {};
      const tracks = s.tracks.slice();
      tracks[i] = withFiguredBass(tracks[i], next);
      return { tracks };
    }),
  realizeFiguredBass: async (partId) => {
    const s = get();
    const part = rollTracksOf(s).find((t) => t.id === (partId ?? s.activeTrackId));
    if (!part || part.notes.length === 0) throw new Error('The bass part has no notes to realize');
    const ctx = rollComposeContext(s);
    const own = partRange(part);
    const result = await composerApi.continuo({
      bass: figuredBassLine(part.notes, part.figuredBass),
      key: ctx.key.tonic,
      mode: ctx.key.mode,
      ranges: { ...ctx.ranges, ...(own ? { bass: own } : {}) },
      meterMap: s.meterMap,
      pickupSteps: s.pickupSteps,
    });
    return commitComposerWrite(continuoPartWrites(result), 'continuo', false, { bass: part.id }, ctx.key);
  },
  setCantusFirmus: (partId) =>
    set((s) => {
      if (partId !== null && !s.tracks.some((t) => t.id === partId)) return {};
      let changed = false;
      const tracks = s.tracks.map((t) => {
        const on = t.id === partId;
        if ((t.cantusFirmus === true) === on) return t;
        changed = true;
        if (on) return { ...t, cantusFirmus: true };
        const { cantusFirmus: _drop, ...rest } = t;
        return rest;
      });
      return changed ? { tracks } : {};
    }),
  writePlanToRoll: (plan) => commitComposerWrite(planPartWrites(plan), 'plan', true, {}, undefined, true),
  writeCounterpoint: (result) => commitComposerWrite(counterpointPartWrites(result), 'counterpoint', false, {}, undefined, true),
  writeFormMovement: (form, movementIndex = 0) => {
    const w = formMovementWrite(form, movementIndex);
    if (!w) return null;
    let out: RollWriteResult = { partIds: [], created: 0, skipped: 0 };
    cutHistoryBurst();
    set((s) => {
      const written = writeParts(s, w.writes);
      // EXPRESSION on: each written part shaped by its phrases, split again at the movement's sections.
      const done = s.expressionOn ? expressedWrite(written, w.markers.map((m) => m.tick)) : written;
      out = writeResultOf(done);
      const meterMap = normalizeMeterMap(w.meterMap);
      const tempo = tempoSlice(sanitizeRollTempoMap(w.tempoMap, importedRollBpm(w.bpm)));
      // FORM's markers replace the ones an earlier form wrote; the user's own stay, and win a place both hold.
      const markers = sanitizeRollMarkers([...w.markers, ...s.markers.filter((m) => m.origin !== 'form')]);
      const key = w.key ?? effectiveRollKey({ ...s, tracks: done.tracks, notes: done.notes, activeTrackId: done.activeId });
      return {
        tracks: done.tracks,
        notes: done.notes,
        ...writtenActive(s, done),
        ...selectionOf(done.notes, s.selectedIds, s.selectedNoteId),
        meterMap,
        pickupSteps: 0,
        ...tempo,
        markers,
        ...grownGrid(s, done.tracks, meterMap, 0),
        ...(w.key && !sameRollKey(w.key, s.rollKey) ? { rollKey: w.key } : {}),
        harmonyChords: w.chords,
        voiceLeading: writtenVoiceLeading(w, done, 'form', key),
        showHarmony: true,
      };
    });
    cutHistoryBurst();
    saveComposeViewOf(get());
    return out;
  },
  transformSelection: (kind, opts = {}) => {
    const s = get();
    if (s.selectedIds.size === 0) return 0;
    const scale = opts.diatonic === false ? null : rollKeyScale(effectiveRollKey(s));
    const sel = s.selectedIds;
    let out: PianoNote[];
    if (kind === 'invert') out = invertSelection(s.notes, sel, { scale, ...(isNum(opts.axis) ? { axis: opts.axis } : {}) });
    else if (kind === 'retrograde') out = retrogradeSelection(s.notes, sel);
    else if (kind === 'augment') out = augmentSelection(s.notes, sel, isNum(opts.factor) && opts.factor > 0 ? opts.factor : 2);
    else if (kind === 'diminish') out = diminishSelection(s.notes, sel, isNum(opts.factor) && opts.factor > 0 ? opts.factor : 2);
    else if (kind === 'sequence') {
      const steps = isNum(opts.steps) ? Math.max(1, Math.round(opts.steps)) : 2;
      out = sequenceSelection(s.notes, sel, { steps, interval: isNum(opts.interval) ? Math.round(opts.interval) : -1, scale });
    } else {
      const onsets = new Set(s.notes.filter((n) => sel.has(n.id)).map((n) => noteTick(n))).size;
      const count = isNum(opts.count) ? Math.max(1, Math.round(opts.count)) : Math.max(1, Math.floor(onsets / 2));
      out = fragmentSelection(s.notes, sel, { part: opts.part === 'tail' ? 'tail' : 'head', count });
    }
    // A sequence's copies take ids of their own; each transformed note keeps its id and stays selected.
    const before = new Set(s.notes.map((n) => n.id));
    const notes = migrateNotes(out.map((n) => (before.has(n.id) ? n : { ...n, id: uid() })));
    const picked = notes.filter((n) => sel.has(n.id) || !before.has(n.id)).map((n) => n.id);
    cutHistoryBurst();
    set((st) => {
      const end = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
      return {
        notes,
        totalSteps: end > st.totalSteps + EPS ? Math.min(MAX_STEPS, roundUpToBar(st.meterMap, end, st.pickupSteps)) : st.totalSteps,
        ...selectionOf(notes, picked, st.selectedNoteId),
      };
    });
    cutHistoryBurst();
    return get().selectedIds.size;
  },

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
    state.voiceProgram === prev.voiceProgram &&
    state.markers === prev.markers &&
    state.rollKey === prev.rollKey
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
