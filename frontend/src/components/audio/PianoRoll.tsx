import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Gauge, Info, ListChecks, Minus, Plus, Repeat, Save, Scissors, Trash2, Triangle, Unlink, Waves, X } from 'lucide-react';
import {
  DEFAULT_GROOVE_ID,
  MAX_ROLL_STEPS,
  activeTrackOf,
  beginRollGesture,
  endRollGesture,
  rollTracksOf,
  usePianoRollStore,
  type PianoNote,
} from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx } from '../../state/playerStore';
import { useEditorStore } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo, logWarn } from '../../state/logStore';
import type { Meter } from '../../lib/colony';
import {
  barAt,
  bars as meterBars,
  gridLines,
  laneGridLines,
  laneLoop,
  laneTimeOf,
  meterEquals,
  roundUpToBar,
  unrollLanes,
  type BarSpan,
  type MeterSegment,
} from '../../lib/meterMap';
import { createRollScheduler, ROLL_LOOKAHEAD_SEC, ROLL_TICK_MS, type ScheduledWheel } from '../../lib/rollPartPlay';
import { rollPartVoice, rollPartVoices, type PartVoice } from '../../lib/rollPartVoice';
import { MAX_ROLL_PARTS, audiblePartIds, partFileChannels } from '../../lib/rollTracks';
import { KEPT_DOCUMENT_LOG, importMidiParts, importSheetParts, pastEndLog } from '../../lib/rollPartsImport';
import { RollTrackColumn } from './RollTrackColumn';
import { RollNotesCanvas, type RollNotesCanvasHandle } from './RollNotesCanvas';
import { RollMinimap } from './RollMinimap';
import { noteIndexOf, type NoteIndex } from '../../lib/noteIndex';
import { hitNote, lookOf, noteBox, ROLL_LOOKS } from '../../lib/rollCanvas';
import { clientToLocal, effectiveZoom } from '../../lib/canvasScale';
import { bpmText, laneSpanLabel } from '../../lib/meterFace';
import { midiFileNoteCount, partLaneChannels, rollMidiMpeNoRoom, rollToMidiFile } from '../../lib/rollMidi';
import { stepClock, tempoAtStep, type RollPlayState, type StepClock } from '../../lib/rollTempo';
import { splitRollTick, vstPartChannels, type RollVstRoute } from '../../lib/rollVstPlay';
import {
  attachRollInstruments,
  auditionRollVoice,
  rollVstStamp,
  sendRollVstMidi,
  startRollVstClock,
  stopRollVstClock,
  tickRollVstClock,
} from '../../state/rollInstruments';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../../lib/tempoMap';
import { CLICK_MODES, CLICK_MODE_LABEL, CLICK_MODE_TITLE, asClickMode, type MetronomeScheduler } from '../../lib/metronome';
import { COUNT_IN_HANDOFF_SEC, rollClickPlan, rollClickSteps, rollPlayOrigin, type RollClick } from '../../lib/rollClick';
import { COUNT_IN_CHOICES, createRollMetronome, useMetronomeStore, type CountInBars } from '../../state/metronomeStore';
import { feelRollNotes, playedRollNotes } from '../../lib/rollClip';
import {
  loopLabel,
  playStartLap,
  rollStepAt,
  rulerKeyStep,
  rulerLoop,
  rulerSeekStep,
  type RollLoop,
} from '../../lib/rollTransport';
import { copyNotes, duplicateNotes, pasteNotes, type NoteClipboardPayload } from '../../lib/noteClipboard';
import {
  TICKS_PER_STEP,
  clickPlacement,
  floorLine,
  laneSnapGrid,
  lengthenTicks,
  menuNudgeTick,
  moveBlock,
  nudgeTicks,
  resizeTicks,
  rollSnapDef,
  shortenTicks,
  snapGrid,
  snapLineSteps,
  type NoteOrigin,
  type SnapGrid,
} from '../../lib/rollSnap';
import {
  MARQUEE_MIN_PX,
  VELOCITY_LANE_HEIGHT,
  VELOCITY_MAX,
  VELOCITY_MIN,
  gridPointAt,
  marqueeBox,
  marqueeRect,
  notesInMarquee,
  velocityBarHeight,
  velocityNudgeWrites,
  velocityTargets,
  velocityToY,
  yToVelocity,
  type MarqueeRect,
  type RollGeometry,
  type RollPoint,
} from '../../lib/rollSelection';
import { syncopationByBar } from '../../lib/syncopation';
import {
  builtinGrooves,
  fromVirtuosoTemplate,
  swingGrooveById,
  swingToGroove,
  type GrooveTemplate,
} from '../../lib/grooveTemplate';
import { buildGrooveFromMidiBytes } from '../../lib/grooveExtract';
import { BendLane } from './BendLane';
import { CcLane } from './CcLane';
import { ArticulationLane } from './ArticulationLane';
import { TempoLane } from './TempoLane';
import { MARKER_ROW_HEIGHT, RollMarkerJump, RollMarkerRow } from './RollMarkers';
import { HARMONY_ROW_HEIGHT, RollHarmonyCorner, RollHarmonyRow, runRollVoiceLeadingCheck } from './RollHarmonyRow';
import { FiguredBassLane } from './FiguredBassLane';
import { rollTransformMenuItems } from './RollTransforms';
import { markerStep } from '../../lib/rollMarkers';
import { RollPlayhead } from './RollPlayhead';
import { MidiMapper } from './MidiMapper';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { triggerPianoNote } from '../../lib/pianoTrigger';
import { getGlobalVoice, sfChannelPressure, sfControlChange, sfPitchWheel, sfPitchWheelRange } from '../../lib/soundfontEngine';
import { drumKitName } from '../../lib/clipProgram';
import { chooseRollVoice, rollVoiceChoice } from '../../lib/rollVoiceChoice';
import { gmShortName } from '../../lib/gmInstruments';
import { bounceRollToEditor } from '../../lib/rollBounce';
import { parseSheetFile } from '../../lib/sheetImportClient';
import { ownsKey } from '../../lib/keyScope';
import {
  CORNER_CLEAR_GLYPH,
  CORNER_KEY,
  DockFlyout,
  FIELD,
  FIELD_LEGEND,
  FIELD_SELECT,
  FIELD_VALUE,
  FLYOUT_CARD,
  KEY_ON,
  KEY_PLAY_REST,
  RAIL_GLYPH,
  RANGE,
  RailKey,
  STRIP_GLYPH,
  STRIP_ICON_KEY,
  StripKey,
  MenuKey,
  useDockTip,
} from './midiDockKit';

const NOTE_HEIGHT = 12;
const HEADER_HEIGHT = 22;
/**
 * The rows that stick to the top of the grid's scroll box and cover the top of
 * the grid: the ruler and the marker row under it. The note canvas, the
 * overview's view box and the focus layer's scroll-into-view measure the
 * grid's visible height under them.
 */
const GRID_COVER_PX = HEADER_HEIGHT + MARKER_ROW_HEIGHT;
const KEYBOARD_WIDTH = 64;
/**
 * The widest zoom out: one pixel per 16th, so a 1920px view holds 120 bars of
 * 4/4 (the overview strip shows the whole roll at any zoom).
 */
export const STEP_PX_MIN = 1;
/** Below this width the zoom keys step by a factor (1.5) instead of 2px, so every width down to the floor is a few presses away. */
const STEP_PX_FINE = 8;
const STEP_PX_MAX_BUTTON = 48;
const STEP_PX_MAX_WHEEL = 64;
/** The snap grid's lines draw only where a cell is at least this wide; below it the bar, group and beat tiers carry the grid. */
const STEP_LINES_MIN_PX = 10;
/** A press on a note body moves the selection once the pointer has travelled this far (px). */
const NOTE_DRAG_MIN_PX = 3;
/** A step position as the note title prints it: whole steps as they are, a tuplet position to the hundredth. */
const stepText = (step: number): string => String(Math.round(step * 100) / 100);
/** The pickup cell prints its legend from this width (px) up; a narrower one keeps it in its title. */
const PICKUP_LEGEND_MIN_PX = 38;
/** The grid lines, the ruler and the velocity bars draw this far (px) past each side of the view, so a scroll redraws them only after crossing it. */
const WINDOW_OVERSCAN_PX = 960;
/** A tier of grid lines (beats, groups) draws only where its lines stand at least this far apart (px); the bar lines always draw. */
const MIN_TIER_GAP_PX = 4;
/** The resize handle: the last pixels of a note's drawn box. */
const NOTE_EDGE_PX = 6;
/** A bar number prints only on bars this far apart (px) at least, counted from bar 1, so the ruler stays legible zoomed out. */
const RULER_LABEL_MIN_PX = 40;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** The ruler's meter text: "7/8 3+2+2", "5/4 2+3", "4/4". */
const meterLabel = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` ${m.groups.join('+')}` : ''}`;

/** One SVG path of vertical lines at `steps`, from y0 to y1, on whole pixels, `dx` px to the left (the drawing's own left edge). */
const linesPath = (steps: readonly number[], stepPx: number, y0: number, y1: number, dx = 0): string => {
  let d = '';
  for (const s of steps) d += `M${Math.round(s * stepPx - dx) + 0.5} ${y0}V${y1}`;
  return d;
};

/** The first index of ascending `xs` holding a value past `v` (at or past it when `inclusive`); xs.length when none does. */
const searchSorted = (xs: readonly number[], v: number, inclusive: boolean): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? xs[mid] < v : xs[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * The lines of ascending `steps` inside [from, to], cut out by binary search,
 * so a view of a 4,096-bar roll costs the lines in view, not the roll's.
 */
const within = (steps: readonly number[], from: number, to: number): number[] =>
  steps.slice(searchSorted(steps, from, true), searchSorted(steps, to, false));

/** The index range of the bars (ascending, end to end) that meet [from, to]. */
const spansWithin = (spans: readonly BarSpan[], from: number, to: number): { first: number; end: number } => {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start + spans[mid].len < from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < spans.length && spans[end].start <= to) end += 1;
  return { first: lo, end };
};

/** The smallest gap (steps) between neighbouring lines of a sorted tier; Infinity for fewer than two. */
const minGap = (steps: readonly number[]): number => {
  let gap = Infinity;
  for (let i = 1; i < steps.length; i += 1) {
    const d = steps[i] - steps[i - 1];
    if (d > 1e-6 && d < gap) gap = d;
  }
  return gap;
};

/**
 * A tier's lines inside [from, to], or none where they stand closer than
 * MIN_TIER_GAP_PX there: zoomed out, the beats and then the groups drop out
 * wherever they would smear into a solid block, and the bar lines carry the grid.
 */
const tierWithin = (steps: readonly number[], from: number, to: number, stepPx: number): number[] => {
  const xs = within(steps, from, to);
  return minGap(xs) * stepPx < MIN_TIER_GAP_PX ? [] : xs;
};

/** The px range a window of steps covers inside a grid of `totalSteps`: the drawing's left edge and width. */
const windowPx = (win: { from: number; to: number }, stepPx: number, totalSteps: number): { x: number; width: number } => {
  const x = Math.max(0, Math.floor(win.from * stepPx));
  const right = Math.min(totalSteps * stepPx, Math.ceil(win.to * stepPx) + 1);
  return { x, width: Math.max(1, right - x) };
};

/**
 * How many bars apart the numbers stand among bars `barPx` wide: 1, 2, 4, 8 ...
 * so that the stride spans RULER_LABEL_MIN_PX. Each bar decides by its own
 * width, so a 2/16 bar thins the numbers around itself and never the wide bars
 * of the rest of the roll; bars all one width number as they always have.
 */
const rulerLabelStride = (barPx: number): number => {
  if (!(barPx > 0)) return 1 << 16;
  let stride = 1;
  while (barPx * stride < RULER_LABEL_MIN_PX && stride < 1 << 16) stride *= 2;
  return stride;
};

/** True when bar `b` prints its number: a bar counted from bar 1 at its own width's stride (rulerLabelStride). */
const rulerShowsNumber = (b: Pick<BarSpan, 'bar' | 'len'>, stepPx: number): boolean =>
  b.bar >= 0 && b.bar % rulerLabelStride(b.len * stepPx) === 0;

/** The notes as they sound, lane repeats written out and lane ids dropped (lib/rollClip); every hand-off that plays a note list once takes it. */
export { playedRollNotes };

/**
 * A lane note's look, all in the one accent. The active lane draws solid; each
 * other lane takes the next form by its rank among the inactive lanes:
 * outlined, striped, then outlined with a sparse hatch and striped the other way.
 * `edge` is the border colour, which a selected note replaces with white.
 * `minPx` is the narrowest a note of the form draws, so a one-step outlined or
 * striped note keeps its form at the smallest zoom.
 */
interface LaneForm { fill: string; edge: string; minPx: number; style?: React.CSSProperties }
const stripes = (angle: number): React.CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(${angle}deg, rgb(var(--et-accent)) 0 2px, rgb(var(--et-accent) / 0.16) 2px 4px)`,
});
const SOLID_FORM: LaneForm = { fill: 'bg-[rgb(var(--et-accent))]', edge: 'border-black/40', minPx: 4 };
const LANE_FORMS: readonly LaneForm[] = [
  { fill: 'bg-[rgb(var(--et-accent)/0.14)]', edge: 'border-[rgb(var(--et-accent))]', minPx: 8 },
  { fill: '', edge: 'border-[rgb(var(--et-accent)/0.8)]', minPx: 8, style: stripes(135) },
  {
    fill: 'bg-[rgb(var(--et-accent)/0.14)]',
    edge: 'border-[rgb(var(--et-accent))]',
    minPx: 8,
    style: { backgroundImage: 'repeating-linear-gradient(45deg, rgb(var(--et-accent) / 0.55) 0 1px, transparent 1px 5px)' },
  },
  { fill: '', edge: 'border-[rgb(var(--et-accent)/0.8)]', minPx: 8, style: stripes(45) },
];

const ROLL_HELP =
  'Click the ruler = move the playhead (PLAY starts there) · Drag along the ruler = loop those steps (LOOP turns it on and off) · Marker row under the ruler: double-click = add a section, click a flag = jump there, drag a flag = move it to a bar line, F2 = rename, MARKS = the jump list · Click empty cell = add · Click note = select / second click on the only selected note = delete · Drag empty grid = marquee (Shift adds to the selection) · Shift-click note = add to the selection · Ctrl/Cmd-click note = in or out · Ctrl/Cmd+A = select all · Drag a note = move the selection on the snap grid · Arrows nudge the selection a snap cell (Shift = 4 cells / an octave) · Drag right edge = resize to the snap grid · Delete key removes the selection · Ctrl/Cmd+C = copy · Ctrl/Cmd+X = cut · Ctrl/Cmd+V = paste at the insertion point (the playhead while playing, otherwise the last step you clicked) · Ctrl/Cmd+D = duplicate after the selection · Velocity lane under the grid: drag a bar, or sweep across bars to draw · Right-click note for actions · Alt+Left/Right = select the note before or after · Enter or Shift+F10 on the selected note = its menu · Ctrl+wheel = zoom (down to one pixel a step) · Shift+wheel = scroll · Overview strip above the grid = click or drag to jump anywhere in the roll · Harmony row over the ruler: a flag = select the notes it is about, CHECK in its corner = check voice leading · Figured bass lane: type a figure under a bass note, REALIZE = soprano, alto and tenor over it · Right-click a note = transform the selection (invert, retrograde, augment, diminish, sequence, fragment), check voice leading, mark the part as the cantus firmus';

/**
 * The roll's note clipboard: module-level, so it survives a remount and is
 * shared by every roll instance, and IN-APP — never `navigator.clipboard`. The
 * roll's note is an internal shape with no agreed text form, so a system
 * clipboard round trip needs a serialisation format, a parser and a version;
 * that is a ticket of its own (see lib/noteClipboard.ts). Nothing here leaves
 * the page.
 */
let noteClipboard: NoteClipboardPayload | null = null;

// triggerPianoNote / triggerPianoNoteFromMidi live in lib/pianoTrigger so the
// global Web MIDI listener + Sway surface can play a note without importing this
// whole component graph. The piano roll uses `triggerPianoNote` for its own
// scheduling (imported above).
const PIANO_MIDI_PARAMS = [
  // The app's tempo range (lib/tempoMap TEMPO_BPM_MIN..MAX), kept with its fraction.
  { key: 'bpm' as const,        label: 'BPM',         min: TEMPO_BPM_MIN, max: TEMPO_BPM_MAX, autoCc: 14 },
  { key: 'totalSteps' as const, label: 'Total Steps', min: 16,  max: 256, autoCc: 15, integer: true },
];

/** The voice the active part plays with now (lib/rollPartVoice): its own
 *  program, else its linked EDIT clip's, else the roll's own or the picker's.
 *  Every audition from the grid and the keyboard sounds through it, so each
 *  part is heard on its own instrument. */
const currentRollVoice = (): PartVoice => rollPartVoice();

const useMasterGainRef = () => {
  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const masterRef = useRef(masterGain);
  useEffect(() => { masterRef.current = masterGain; }, [masterGain]);
  return masterRef;
};

/* ── the roll's controls, laid out by the MIDI dock (MidiPanel) ─────────────
   Each piece subscribes to only what it shows, so a playhead tick or a note
   edit re-renders the key that reads it rather than the whole tab. */

/** The footer's hard-cornered transport glyphs, fill-only in currentColor. */
const Glyph: React.FC<{ d: string }> = ({ d }) => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false" className={STRIP_GLYPH}>
    <path d={d} />
  </svg>
);
const GLYPH_PLAY = 'M3 1.5 12.5 7 3 12.5Z';
const GLYPH_STOP = 'M2.5 2.5h9v9h-9z';

/**
 * PLAY / STOP, BPM and STEPS. Hosts the roll's playback scheduler: this key is
 * mounted whenever the MIDI tab is, exactly as the roll is. It is the tab's one
 * play key: while `arpShowing` it plays the arpeggiator instead of the hidden
 * roll, and while either one sounds it reads STOP and stops it.
 */
export const PianoRollTransport: React.FC<{
  arpShowing?: boolean;
  arpPlaying?: boolean;
  onArpPlayingChange?: (playing: boolean) => void;
}> = ({ arpShowing = false, arpPlaying = false, onArpPlayingChange }) => {
  const bpm = usePianoRollStore((s) => s.bpm);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const setBpm = usePianoRollStore((s) => s.setBpm);
  const setTotalSteps = usePianoRollStore((s) => s.setTotalSteps);
  const setPlaying = usePianoRollStore((s) => s.setPlaying);
  const play = usePianoRollStore((s) => s.play);
  const setCurrentStep = usePianoRollStore((s) => s.setCurrentStep);
  const masterRef = useMasterGainRef();
  const playTimerRef = useRef<number | null>(null);

  // The parts' VST3 instruments are hosted while the MIDI tab is open, which is
  // while this key is mounted (state/rollInstruments).
  useEffect(() => attachRollInstruments(), []);

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);

  // CLICK: the roll's own click track (lib/rollClick), on the metronome's
  // settings (state/metronomeStore). Its scheduler's transport is PLAY's
  // seconds, and its clicks are the roll's bars laid out in the click mode and
  // found in the lap the same way the notes are, so a loop, a seek, a meter
  // change or a tempo point moves the click with the notes. The play effect
  // below starts it, ticks it after each note window and stops it. A count-in
  // counts into the step PLAY will start on, at the tempo there, and PLAY's
  // first step sounds on the downbeat it counted.
  const clickOn = useMetronomeStore((s) => s.enabled);
  const toggleClick = useMetronomeStore((s) => s.toggle);
  const clickMode = useMetronomeStore((s) => s.clickMode);
  const setClickMode = useMetronomeStore((s) => s.setClickMode);
  const countInBars = useMetronomeStore((s) => s.countInBars);
  const setCountInBars = useMetronomeStore((s) => s.setCountInBars);
  const rollPlayRef = useRef<{ state: RollPlayState; origin: number } | null>(null);
  const clickStepsRef = useRef<{ of: readonly unknown[]; clicks: RollClick[] } | null>(null);
  const clickRef = useRef<MetronomeScheduler | null>(null);
  const click = useCallback((): MetronomeScheduler => {
    clickRef.current ??= createRollMetronome({
      transportSec: () => {
        const p = rollPlayRef.current;
        return p ? getEngineCtx().currentTime - p.origin : 0;
      },
      // The count-in reads the roll's own maps; while PLAY runs, `plan` does.
      tempoMap: () => {
        const r = usePianoRollStore.getState();
        return stepClock(r.bpm, r.tempoMap).map;
      },
      meterMap: () => usePianoRollStore.getState().meterMap,
      pickupSteps: () => usePianoRollStore.getState().pickupSteps,
      lookaheadSec: ROLL_LOOKAHEAD_SEC,
      plan: (from, until) => {
        const p = rollPlayRef.current;
        if (!p) return [];
        const r = usePianoRollStore.getState();
        const mode = useMetronomeStore.getState().clickMode;
        const of = [r.meterMap, r.pickupSteps, r.totalSteps, mode];
        const cached = clickStepsRef.current;
        if (!cached || cached.of.some((v, i) => v !== of[i])) {
          clickStepsRef.current = { of, clicks: rollClickSteps(r.meterMap, r.pickupSteps, Math.max(1, r.totalSteps), mode) };
        }
        return rollClickPlan(p.state.clock, p.origin, clickStepsRef.current?.clicks ?? [], from, until);
      },
    });
    return clickRef.current;
  }, []);
  const [counting, setCounting] = useState(false);
  const countCancelRef = useRef<(() => void) | null>(null);
  // The context time of the downbeat a finished count-in led into; the play effect anchors step 0 there.
  const countedDownbeatRef = useRef<number | null>(null);
  useEffect(() => () => {
    countCancelRef.current?.();
    countCancelRef.current = null;
    clickRef.current?.dispose();
    clickRef.current = null;
  }, []);

  // Time-based lookahead scheduler (lib/rollPartPlay): notes fire at their exact time (the
  // roll's tempo map gives every step its seconds, lib/rollTempo), so
  // FRACTIONAL step positions (32nd/64th notes and micro-timing offsets) play —
  // not just integer 16ths — and a ritardando or a fermata slows the notes
  // while they stay on their bar lines. It counts absolute
  // steps from the moment PLAY starts, and a lap (lib/rollTransport) maps them
  // onto roll steps over and over: the whole roll, or the loop range while the
  // loop is on. It starts at the playhead (the store's current step, which
  // every tick writes); with the loop on and the playhead outside it, at the
  // loop's start. It plays the lanes unrolled, and a note at or past the roll's
  // end (or outside the loop) stays silent. Each tick reads the parts, lanes,
  // length, tempo map, loop and bends from the store, so an edit while playing
  // (a note, a mute or solo, a part's instrument, a meter, a tempo point, a
  // lane's loop, a bend, the loop range)
  // changes what plays next without a restart, and a step already scheduled is
  // never scheduled again. A seek (the ruler) re-anchors the lap at the new
  // playhead.
  //
  // Pitch bend: a built-in voice follows its lane's curve through automation
  // scheduled with the note (lib/pitchBendVoice). A soundfont wheel bends a
  // whole channel, so each bent lane plays on its own channel and each tick
  // sends that channel's wheel messages for the window it schedules notes in.
  // A loop that starts past step 0 plays each curve re-based to its start
  // (lib/pitchBend shiftBend). The first part's soundfont channels count down
  // from 14 (lib/pitchBend liveLaneChannels), clear of EDIT's live MIDI and the
  // arpeggiator; every later part plays on channels of its own from 25 up
  // (lib/rollTracks rollLiveChannels), so twenty or more parts each keep
  // their own program.
  useEffect(() => {
    if (!isPlaying) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    // Absolute step 0 is where PLAY started, 60 ms from now or on the downbeat
    // a count-in counted. The scheduler (lib/rollPartPlay) keeps the lap and
    // its clock between ticks and returns what each window plays: every
    // audible part's notes on the part's own channel and voice, and the pitch
    // wheel of each bent lane on its own channel.
    const origin = rollPlayOrigin(ctx.currentTime, countedDownbeatRef.current);
    countedDownbeatRef.current = null;
    const start = usePianoRollStore.getState();
    const scheduler = createRollScheduler({ ...start, tracks: rollTracksOf(start) }, origin, ROLL_LOOKAHEAD_SEC);
    rollPlayRef.current = { state: scheduler.state(), origin };
    // The parts' VST3 instruments play on the roll's clock: from the first
    // downbeat, on the roll second of the step PLAY starts from, at its tempo.
    let tempoClock: { bpm: number; map: unknown; clock: StepClock } | null = null;
    const clockOf = (r: { bpm: number; tempoMap: Parameters<typeof stepClock>[1] }): StepClock => {
      if (!tempoClock || tempoClock.bpm !== r.bpm || tempoClock.map !== r.tempoMap) tempoClock = { bpm: r.bpm, map: r.tempoMap, clock: stepClock(r.bpm, r.tempoMap) };
      return tempoClock.clock;
    };
    const startStep = rollStepAt(scheduler.state().lapState.lap, 0);
    startRollVstClock(origin, clockOf(start).at(startStep), tempoAtStep(clockOf(start), startStep));
    // Each tick's VST3 parts: the plugin channel of each of their live channels, and the stamp on the roll's clock.
    let voices = rollPartVoices();
    const routeOf = (partId: string): RollVstRoute | undefined => {
      const vst = voices.get(partId)?.vst;
      if (!vst) return undefined;
      return { entryId: vst.entryId, channels: vstPartChannels(scheduler.partChannels(partId) ?? [], vst.channel), stamp: rollVstStamp };
    };
    // The click plans the same window as the notes, from the same lap clock, so
    // after a seek it never sounds a click the notes have left behind.
    const clicker = click();
    clicker.start();
    const send = (wheels: readonly ScheduledWheel[]) => {
      for (const w of wheels) {
        if (w.kind === 'range') sfPitchWheelRange(w.channel, w.value, w.time);
        else if (w.kind === 'control') sfControlChange(w.channel, w.controller ?? 0, w.value, w.time);
        else if (w.kind === 'pressure') sfChannelPressure(w.channel, w.value, w.time);
        else sfPitchWheel(w.channel, w.value, w.time);
      }
    };

    const tick = () => {
      const roll = usePianoRollStore.getState();
      // Each part plays through its own voice (lib/rollPartVoice): its VST3
      // instrument while that plugin plays, else its program, else its linked
      // clip's, else the roll's own or the picker's.
      voices = rollPartVoices();
      const scheduled = scheduler.tick(ctx.currentTime, { ...roll, tracks: rollTracksOf(roll) }, (id) => voices.get(id));
      rollPlayRef.current = { state: scheduler.state(), origin };
      // A VST3 part's notes and messages go to its plugin; the rest to the synth.
      const out = { ...scheduled, ...splitRollTick(scheduled, routeOf, scheduler.channelOwner, ctx.currentTime) };
      sendRollVstMidi(out.midi);
      tickRollVstClock(tempoAtStep(clockOf(roll), out.shownStep));
      send(out.wheels);
      for (const n of out.notes) {
        triggerPianoNote(n.note, n.velocity, n.when, n.duration, masterRef.current, {
          channel: n.channel,
          bend: n.bend,
          program: n.program,
          bank: n.bank,
          percussion: n.percussion,
        });
      }
      clicker.tick();
      setCurrentStep(out.shownStep);
    };
    // The first window now: a counted downbeat can be closer than one interval.
    tick();
    playTimerRef.current = window.setInterval(tick, ROLL_TICK_MS);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      // Every channel back where it starts: the synth's, and each plugin's after it releases its notes.
      const released = splitRollTick({ notes: [], wheels: scheduler.release(ctx.currentTime) }, routeOf, scheduler.channelOwner, ctx.currentTime);
      send(released.wheels);
      stopRollVstClock(ctx.currentTime, released.midi);
      clicker.stop();
      rollPlayRef.current = null;
    };
  }, [isPlaying, setCurrentStep, masterRef, click]);

  // The arpeggiator keeps running behind the roll face, so the key stops
  // whichever of the two is sounding before it starts either.
  const sounding = isPlaying || arpPlaying || counting;
  const handlePlayToggle = () => {
    if (sounding) {
      if (counting) {
        countCancelRef.current?.();
        countCancelRef.current = null;
        setCounting(false);
      }
      if (isPlaying) stopPlayback();
      if (arpPlaying) onArpPlayingChange?.(false);
      return;
    }
    if (arpShowing) {
      onArpPlayingChange?.(true);
      return;
    }
    // Start from the playhead (a click on the ruler puts it anywhere, and it
    // stays where the last playback stopped), or from the loop's start when the
    // loop is on and leaves the playhead out. The lookahead scheduler (effect
    // above) fires notes, the first step included, at their exact times.
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const metronome = useMetronomeStore.getState();
    countedDownbeatRef.current = null;
    if (!metronome.enabled || metronome.countInBars <= 0) {
      startPlay();
      return;
    }
    // The count-in: whole bars of the meter at the step PLAY starts on, ending
    // on that step's time under the roll's tempo map. It hands over to PLAY a
    // little before its downbeat with that downbeat's context time, and PLAY's
    // first step sounds on it. The key reads STOP meanwhile, and pressing it
    // cancels the count.
    const roll = usePianoRollStore.getState();
    const startStep = rollStepAt(playStartLap(roll).lap, 0);
    const startSec = stepClock(roll.bpm, roll.tempoMap).at(startStep);
    let done = false;
    setCounting(true);
    const cancel = click().countIn(metronome.countInBars, (downbeatAt) => {
      done = true;
      countCancelRef.current = null;
      countedDownbeatRef.current = downbeatAt ?? null;
      setCounting(false);
      startPlay();
    }, startSec, COUNT_IN_HANDOFF_SEC);
    if (!done) countCancelRef.current = cancel;
  };
  // PLAY starts the transport at the playhead; the count-in above calls it when the count ends.
  const startPlay = () => {
    play();
    const roll = usePianoRollStore.getState();
    logInfo('piano-roll', `Playing ${roll.notes.length} notes at ${bpmText(bpm)} BPM from step ${Math.floor(roll.currentStep) + 1}`);
  };

  // LOOP: turns the loop range on and off. With no range set it loops the bar
  // under the playhead; a drag along the ruler sets any range, and the corner
  // key clears it.
  const loopRange = usePianoRollStore((s) => s.loop);
  const loopOn = usePianoRollStore((s) => s.loopOn);
  const setLoop = usePianoRollStore((s) => s.setLoop);
  const setLoopOn = usePianoRollStore((s) => s.setLoopOn);
  const toggleLoop = () => {
    if (loopRange) {
      setLoopOn(!loopOn);
      return;
    }
    const r = usePianoRollStore.getState();
    const bar = barAt(r.meterMap, Math.min(Math.max(0, r.currentStep), Math.max(0, r.totalSteps - 1e-6)), r.pickupSteps);
    setLoop({ start: Math.max(0, bar.start), end: Math.min(r.totalSteps, bar.start + bar.len) });
  };
  const loopText = loopRange ? loopLabel(loopRange, meterMap, pickupSteps) : null;
  const clearLoopTip = useDockTip({ word: 'Clear loop', description: 'Remove the loop range', label: 'Clear the loop range' });
  const playName = sounding ? 'Stop' : arpShowing ? 'Play the arpeggiator' : 'Play';
  const playTip = useDockTip({ word: sounding ? 'Stop' : 'Play', description: arpShowing && !sounding ? 'Play the arpeggiator' : undefined, label: playName });

  // STEPS moves by one bar of the meter the roll ends in, and a new length
  // lands on the next bar line in the direction of the change, whatever the meter.
  // A step from the arrow keys or the spin buttons applies at once. A typed
  // length applies on Enter or when the field loses focus, so the store never
  // rounds a first digit up to a bar line while the rest is still being typed.
  const endBarSteps = barAt(meterMap, Math.max(0, totalSteps - 1e-6), pickupSteps).len;
  // BPM edits the starting tempo (the tempo map's beat-0 point), 20-300 with its fraction.
  const tempoChanges = usePianoRollStore((s) => s.tempoMap.length - 1);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const changeBpm = (text: string) => {
    const v = Number.parseFloat(text);
    if (Number.isFinite(v) && v > 0) setBpm(v);
  };
  const commitBpmDraft = () => {
    if (bpmDraft === null) return;
    setBpmDraft(null);
    changeBpm(bpmDraft);
  };
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);
  const changeTotalSteps = (v: number) => {
    if (!Number.isFinite(v)) return;
    setTotalSteps(v > totalSteps ? roundUpToBar(meterMap, v, pickupSteps) : barAt(meterMap, v, pickupSteps).start);
  };
  const commitStepsDraft = () => {
    if (stepsDraft === null) return;
    setStepsDraft(null);
    changeTotalSteps(parseInt(stepsDraft));
  };

  return (
    <>
      <button
        ref={playTip.anchorRef}
        type="button"
        onClick={handlePlayToggle}
        aria-label={playName}
        aria-describedby={playTip.describedBy}
        className={`${STRIP_ICON_KEY} w-7.5 ${sounding ? KEY_ON : KEY_PLAY_REST}`}
      >
        <Glyph d={sounding ? GLYPH_STOP : GLYPH_PLAY} />
      </button>
      {playTip.tip}
      <div className="relative">
        <StripKey
          on={loopOn}
          aria-pressed={loopOn}
          onClick={toggleLoop}
          legend="Loop"
          icon={<Repeat className={STRIP_GLYPH} />}
          description={
            loopText
              ? `${loopOn ? 'Looping' : 'Loop off:'} ${loopText}. Drag along the ruler to loop other steps.`
              : 'Loop the bar under the playhead. Drag along the ruler to loop any steps.'
          }
        />
        {loopRange && (
          <button
            ref={clearLoopTip.anchorRef}
            type="button"
            onClick={() => setLoop(null)}
            aria-label="Clear the loop range"
            aria-describedby={clearLoopTip.describedBy}
            className={CORNER_KEY}
          >
            <X aria-hidden="true" className="w-3 h-3" strokeWidth={2.5} />
          </button>
        )}
        {loopRange && clearLoopTip.tip}
      </div>
      <div className={FIELD} title={tempoChanges > 0 ? `The starting tempo; the TEMPO lane holds ${tempoChanges} more point${tempoChanges === 1 ? '' : 's'}` : 'The roll tempo, 20-300'}>
        <label htmlFor="piano-roll-bpm" className={FIELD_LEGEND}>BPM</label>
        <input
          id="piano-roll-bpm"
          type="number"
          name="piano-roll-bpm"
          min={TEMPO_BPM_MIN}
          max={TEMPO_BPM_MAX}
          step="any"
          // A take imported at a detected tempo keeps its fraction (97.3), so
          // the field shows it to the hundredth and takes a typed fraction.
          value={bpmDraft ?? Math.round(bpm * 100) / 100}
          onChange={(e) => {
            // Typing arrives as an InputEvent and applies on Enter or blur, so
            // the "1" of a typed 140 is never clamped to 20 first; a step from
            // the arrows or the spin buttons applies at once.
            if ('inputType' in e.nativeEvent) {
              setBpmDraft(e.target.value);
              return;
            }
            setBpmDraft(null);
            changeBpm(e.target.value);
          }}
          onBlur={commitBpmDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitBpmDraft();
            else if (e.key === 'Escape') setBpmDraft(null);
          }}
          className={`${FIELD_VALUE} w-13 bg-transparent border-none outline-none`}
        />
      </div>
      <div className={FIELD}>
        <label htmlFor="piano-roll-total-steps" className={FIELD_LEGEND}>Steps</label>
        <input
          id="piano-roll-total-steps"
          type="number"
          name="piano-roll-total-steps"
          min={16}
          max={MAX_ROLL_STEPS}
          step={endBarSteps}
          value={stepsDraft ?? totalSteps}
          onChange={(e) => {
            // Typing arrives as an InputEvent; a step from the arrows or the spin buttons as a plain Event.
            if ('inputType' in e.nativeEvent) {
              setStepsDraft(e.target.value);
              return;
            }
            setStepsDraft(null);
            changeTotalSteps(parseInt(e.target.value));
          }}
          onBlur={commitStepsDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitStepsDraft();
            else if (e.key === 'Escape') setStepsDraft(null);
          }}
          className={`${FIELD_VALUE} w-11 bg-transparent border-none outline-none`}
        />
      </div>
      <StripKey
        on={clickOn}
        aria-pressed={clickOn}
        onClick={toggleClick}
        legend="Click"
        icon={<Triangle className={STRIP_GLYPH} strokeWidth={2} />}
        description={
          clickOn
            ? `The click sounds while the roll plays, on ${CLICK_MODE_LABEL[clickMode].toLowerCase()}. The footer's click is the same switch.`
            : 'Turn the click on: it follows the roll\'s tempo map and time signatures'
        }
      />
      <div className={FIELD} title={CLICK_MODE_TITLE[clickMode]}>
        <label htmlFor="piano-roll-click-mode" className={FIELD_LEGEND}>Beat</label>
        <select
          id="piano-roll-click-mode"
          name="piano-roll-click-mode"
          value={clickMode}
          onChange={(e) => setClickMode(asClickMode(e.target.value))}
          className={FIELD_SELECT}
        >
          {CLICK_MODES.map((m) => (
            <option key={m} value={m} title={CLICK_MODE_TITLE[m]}>{CLICK_MODE_LABEL[m]}</option>
          ))}
        </select>
      </div>
      <div className={FIELD} title="Bars of clicks before PLAY starts, with the click on">
        <label htmlFor="piano-roll-count-in" className={FIELD_LEGEND}>Count</label>
        <select
          id="piano-roll-count-in"
          name="piano-roll-count-in"
          value={countInBars}
          onChange={(e) => setCountInBars(Number(e.target.value) as CountInBars)}
          className={FIELD_SELECT}
        >
          {COUNT_IN_CHOICES.map((n) => (
            <option key={n} value={n}>{n === 0 ? 'Off' : `${n} bar${n === 1 ? '' : 's'}`}</option>
          ))}
        </select>
      </div>
    </>
  );
};

/**
 * BEND: opens the pitch bend lane under the grid (BendLane.tsx). It latches, so
 * the key says whether the lane is there, and it counts the lanes that bend so
 * a roll carrying bends says so with the lane closed.
 */
export const PianoRollBendKey: React.FC<{ on: boolean; onChange: (on: boolean) => void }> = ({ on, onChange }) => {
  const bends = usePianoRollStore((s) => s.bends);
  const bent = bends.filter((b) => b.points.length > 0).length;
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      legend="Bend"
      icon={<Waves className={STRIP_GLYPH} />}
      description={
        bent > 0
          ? `Pitch bend: the lane under the grid. ${bent} lane${bent === 1 ? '' : 's'} bend${bent === 1 ? 's' : ''} in this roll.`
          : 'Pitch bend: open the lane under the grid and click to add a point'
      }
    />
  );
};

/**
 * TEMPO: opens the tempo lane under the grid (TempoLane.tsx), where tempo
 * changes, ramps and fermatas are drawn. It latches like BEND, and counts the
 * points after the starting tempo so a roll that changes tempo says so with the
 * lane closed.
 */
export const PianoRollTempoKey: React.FC<{ on: boolean; onChange: (on: boolean) => void }> = ({ on, onChange }) => {
  const changes = usePianoRollStore((s) => s.tempoMap.length - 1);
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      legend="Tempo"
      icon={<Gauge className={STRIP_GLYPH} />}
      description={
        changes > 0
          ? `Tempo map: the lane under the grid. ${changes} tempo point${changes === 1 ? '' : 's'} after the start: changes, ramps and fermatas.`
          : 'Tempo map: open the lane under the grid to add a tempo change, a ritardando or a fermata'
      }
    />
  );
};

/**
 * The voice the roll plays when it is not the instrument picker's. An unlinked
 * roll shows its own voice (the Vocal2MIDI panel's), and pressing the key puts
 * the roll back on the picker. A roll linked to an EDIT clip plays that clip's
 * voice: the key shows the program its track (or the clip itself) holds, which
 * the Vocal2MIDI voice choice sets, and pressing it puts the track back on the
 * picker (one EDIT undo step).
 */
export const PianoRollVoiceKey: React.FC = () => {
  const voiceProgram = usePianoRollStore((s) => s.voiceProgram);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const part = usePianoRollStore((s) => activeTrackOf(s));
  const linkedClip = useEditorStore((s) => (editingClipId ? s.clips.find((c) => c.id === editingClipId) : undefined));
  const linkedTrack = useEditorStore((s) => (linkedClip ? s.tracks.find((t) => t.id === linkedClip.trackId) : undefined));
  const choice = rollVoiceChoice(editingClipId, linkedClip ? [linkedClip] : [], linkedTrack ? [linkedTrack] : [], voiceProgram, part);
  if (choice.program === null) return null;
  const name = choice.drums ? `${drumKitName(choice.program)} kit` : gmShortName(choice.program);
  if (part.program !== null) {
    return (
      <StripKey
        on
        onClick={() => chooseRollVoice(null)}
        aria-label={`Part voice ${name}, from part ${part.name}. Press to put the part on the roll voice`}
        legend={`Part: ${name}`}
        icon={<X className={STRIP_GLYPH} />}
        description={`The part ${part.name} plays and bounces as ${name}, set in the parts column. Press to put it back on the roll voice (its linked clip's, or the picker's).`}
      />
    );
  }
  if (choice.track) {
    const trackName = choice.track.name;
    return (
      <StripKey
        on
        onClick={() => chooseRollVoice(null)}
        aria-label={`Roll voice ${name}, from track ${trackName}. Press to put the track on the instrument picker`}
        legend={`Track: ${name}`}
        icon={<X className={STRIP_GLYPH} />}
        description={`The roll plays and bounces as ${name}, the instrument of its EDIT clip's track ${trackName}. Vocal2MIDI's voice choice sets it. Press to put the track on the instrument picker.`}
      />
    );
  }
  return (
    <StripKey
      on
      onClick={() => chooseRollVoice(null)}
      aria-label={`Roll voice ${name}. Press to follow the instrument picker`}
      legend={`Roll: ${name}`}
      icon={<X className={STRIP_GLYPH} />}
      description={`The roll plays and bounces as ${name}, set by Vocal2MIDI. Press to follow the instrument picker.`}
    />
  );
};

/** The next narrower step width the zoom-out key gives: 2px less, or down by 1.5 times below STEP_PX_FINE, to the floor. */
export const zoomOutPx = (px: number): number =>
  Math.max(STEP_PX_MIN, px > STEP_PX_FINE ? px - 2 : Math.round((px / 1.5) * 10) / 10);
/** The next wider step width the zoom-in key gives: 1.5 times up to STEP_PX_FINE, then 2px more, to the key's ceiling. */
export const zoomInPx = (px: number): number =>
  Math.min(STEP_PX_MAX_BUTTON, px >= STEP_PX_FINE ? px + 2 : Math.min(STEP_PX_FINE, Math.round(px * 1.5 * 10) / 10));

/** Zoom out · step width · zoom in. The width is shared with the grid. */
export const PianoRollZoom: React.FC<{ stepPx: number; onStepPxChange: (px: number) => void }> = ({
  stepPx,
  onStepPxChange,
}) => (
  <>
    <StripKey
      iconOnly
      onClick={() => onStepPxChange(zoomOutPx(stepPx))}
      aria-label="Zoom out"
      description="Narrower steps, down to one pixel a step"
      icon={<Minus className={STRIP_GLYPH} />}
      legend="Zoom out"
    />
    <span className="w-7 text-center text-[12px] font-bold et-ink-2 tabular-nums" title="Step width (px)">
      {stepPx < 10 ? Math.round(stepPx * 10) / 10 : Math.round(stepPx)}
    </span>
    <StripKey
      iconOnly
      onClick={() => onStepPxChange(zoomInPx(stepPx))}
      aria-label="Zoom in"
      description="Wider steps"
      icon={<Plus className={STRIP_GLYPH} />}
      legend="Zoom in"
    />
  </>
);

/**
 * The FEEL picker's first entry: the SWING slider, as a groove (the old
 * behaviour). It is the store's `DEFAULT_GROOVE_ID`, so a roll that has never
 * picked a groove — and a persisted feel record with a stale id — lands here.
 */
const SLIDER_GROOVE_ID = DEFAULT_GROOVE_ID;
const GROOVE_FILE_ACCEPT = '.mid,.midi,audio/midi';

/**
 * Q and SWING sliders, a GROOVE picker, and APPLY: the timing feel, applied on
 * demand.
 *
 * Both amounts live in the roll's store, not in this key: they were component
 * state, so switching to the ARP face and back — or a reload — put them back to
 * 100 / 0 and silently threw away what had been dialled in. The store persists
 * them (localStorage). APPLY is one `replaceAll`, one undo step.
 *
 * APPLY quantizes onto the roll's SNAP grid (lib/rollSnap), the grid a click
 * lands on: starts toward its nearest line and lengths toward whole cells, so a
 * quintuplet snap keeps quintuplets and a 7/8 3+2+2 grid restarts on each
 * group. A note in a lane with its own time lands on the lane's grid.
 *
 * The feel is a groove template (`lib/grooveTemplate.ts`): lateness per slot of
 * the bar rather than one scalar on every odd 16th. The picker's first entry IS
 * that old scalar — `swingToGroove(swingPct)` reproduces it exactly, bar starts
 * and all — so a document that sounded a certain way still does. The named
 * grooves (and one learned from a MIDI file) take their depth from QUANT, the
 * existing strength amount; the slider entry needs no depth because the SWING
 * amount already is one.
 *
 * The choice lives in the store beside the two amounts, persisted in the same
 * feel record. A groove learned from a MIDI file is NOT in that record (it is a
 * whole pocket, not an id), so its id resolves to nothing after a reload and
 * falls back to the slider — the roll's oldest, safest feel.
 */
export const PianoRollFeel: React.FC = () => {
  const noteCount = usePianoRollStore((s) => s.notes.length);
  const quantizePct = usePianoRollStore((s) => s.quantizePct);
  const swingPct = usePianoRollStore((s) => s.swingPct);
  const setQuantizePct = usePianoRollStore((s) => s.setQuantizePct);
  const setSwingPct = usePianoRollStore((s) => s.setSwingPct);
  const grooveId = usePianoRollStore((s) => s.grooveId);
  const setGrooveId = usePianoRollStore((s) => s.setGrooveId);
  const snapLabel = usePianoRollStore((s) => rollSnapDef(s.snap).label);
  const [imported, setImported] = useState<GrooveTemplate | null>(null);
  const grooveFileRef = useRef<HTMLInputElement>(null);
  const builtins = useMemo(() => builtinGrooves(), []);
  // A swing groove the list does not hold, such as the one MATCH reads off a
  // song ("Group swing 8ths 61.5%"): its id names it, so it has an entry of its own.
  const named = useMemo(
    () => (builtins.some((g) => g.id === grooveId) ? null : swingGrooveById(grooveId)),
    [builtins, grooveId],
  );

  const loadGrooveFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const pocket = buildGrooveFromMidiBytes(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
      if (!pocket) {
        logError('piano-roll', `${file.name} has no notes to learn a groove from.`);
        return;
      }
      const groove = fromVirtuosoTemplate(pocket);
      setImported(groove);
      setGrooveId(groove.id);
      logInfo('piano-roll', `Groove learned from ${file.name}`);
    } catch (err) {
      logError('piano-roll', `Could not read a groove from ${file.name}: ${String(err)}`);
    }
  };

  const applyTimingFeel = () => {
    const { notes, replaceAll, meterMap, pickupSteps, totalSteps, lanes, snap } = usePianoRollStore.getState();
    if (notes.length === 0) return;
    const q = Math.max(0, Math.min(1, quantizePct / 100));
    // An id that resolves to nothing — a stale one out of the persisted feel
    // record, or the MIDI groove of a previous session — IS the slider entry,
    // so resolve first and read the depth off what came back: the slider groove
    // IS the swing amount and applies whole, while every other groove is a
    // shape, and QUANT is how far into that shape the notes go.
    const picked =
      grooveId === SLIDER_GROOVE_ID
        ? null
        : ((imported && imported.id === grooveId ? imported : builtins.find((g) => g.id === grooveId) ?? named) ?? null);
    const groove = picked ?? swingToGroove(swingPct);
    // Each start moves toward the nearest line of the SNAP grid at strength
    // `q` and each DURATION toward a whole number of its cells (at QUANT 0 a
    // length stays as it was), then the groove lays over it, a group groove
    // following each bar's groups (`rollClip.feelRollNotes`). A lane with its
    // own time quantizes on its own grid.
    const adjusted = feelRollNotes(
      notes,
      { meterMap, pickupSteps, lanes, totalSteps },
      { snap, strength: q, groove, grooveStrength: picked ? q : 1 },
    );
    replaceAll(adjusted);
    logInfo('piano-roll', `Applied timing feel: quantize ${quantizePct}% to ${rollSnapDef(snap).label} · groove ${groove.name}`);
  };

  return (
    <>
      <div className={FIELD} title={`Quantize: pulls notes toward the ${snapLabel} snap grid, and lengths toward whole cells (100 = dead on)`}>
        <label htmlFor="piano-roll-quantize" className={FIELD_LEGEND}>Quant</label>
        <input
          id="piano-roll-quantize"
          type="range"
          name="piano-roll-quantize"
          min={0}
          max={100}
          value={quantizePct}
          onChange={(e) => setQuantizePct(parseInt(e.target.value) || 0)}
          className={RANGE}
        />
        <span className={`${FIELD_VALUE} w-5.5`}>{quantizePct}</span>
      </div>
      <div className={FIELD} title="Swing (rag): delays (+) or pushes (−) the off-16ths, in percent of a step">
        <label htmlFor="piano-roll-swing-rag" className={FIELD_LEGEND}>Swing</label>
        <input
          id="piano-roll-swing-rag"
          type="range"
          name="piano-roll-swing-rag"
          min={-50}
          max={50}
          value={swingPct}
          onChange={(e) => setSwingPct(parseInt(e.target.value) || 0)}
          className={RANGE}
        />
        <span className={`${FIELD_VALUE} w-5.5`}>{swingPct > 0 ? '+' : ''}{swingPct}</span>
      </div>
      <div
        className={FIELD}
        title="Groove: the feel APPLY lays over the grid, as lateness per slot of the bar. The SWING slider is the first entry; the named grooves take their depth from QUANT. The Group grooves, Notes inégales and Double-dotted follow each bar's groups, so 7/8 3+2+2 swings inside each group."
      >
        <label htmlFor="piano-roll-groove" className={FIELD_LEGEND}>Groove</label>
        <select
          id="piano-roll-groove"
          name="piano-roll-groove"
          // An id nothing answers to shows as the slider entry, which is what it applies as.
          value={
            grooveId === imported?.id || grooveId === named?.id || builtins.some((g) => g.id === grooveId) ? grooveId : SLIDER_GROOVE_ID
          }
          onChange={(e) => setGrooveId(e.target.value)}
          className={`${FIELD_SELECT} max-w-28`}
        >
          <option value={SLIDER_GROOVE_ID}>Swing slider</option>
          {builtins.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
          {named && named.id !== imported?.id && <option value={named.id}>{named.name}</option>}
          {imported && <option value={imported.id}>{imported.name}</option>}
        </select>
        <label htmlFor="piano-roll-groove-file" className="sr-only">Groove from a MIDI file</label>
        <input
          ref={grooveFileRef}
          type="file"
          id="piano-roll-groove-file"
          name="piano-roll-groove-file"
          accept={GROOVE_FILE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void loadGrooveFile(file);
          }}
        />
        <StripKey
          mini
          onClick={() => grooveFileRef.current?.click()}
          aria-label="Learn a groove from a MIDI file"
          description="Read a MIDI file's timing pocket — how late or early each slot of the bar is played — and add it to the groove list"
          legend="MIDI…"
        />
      </div>
      <StripKey
        onClick={applyTimingFeel}
        disabled={noteCount === 0}
        aria-label="Apply timing feel"
        description={`Apply the quantize amount on the ${snapLabel} snap grid and the groove to every note`}
        icon={<Check className={STRIP_GLYPH} />}
        legend="Apply"
      />
    </>
  );
};

/** "8 notes" (the part being edited's, with its name in a roll of several parts), and the playhead's step while the roll plays. */
export const PianoRollNoteCount: React.FC = () => {
  const count = usePianoRollStore((s) => s.notes.length);
  const partName = usePianoRollStore((s) => (s.tracks.length > 1 ? activeTrackOf(s).name : null));
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => (s.isPlaying ? Math.floor(s.currentStep) : 0));
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  return (
    <span className="shrink-0 text-[12px] font-semibold et-ink-2 whitespace-nowrap tabular-nums">
      {isPlaying && (
        <span className="et-ink-3 mr-1.5" title="Playhead step">
          {currentStep + 1}/{totalSteps}
        </span>
      )}
      {partName && <span className="et-ink-3 mr-1.5" title="The part being edited">{partName}</span>}
      {count} note{count === 1 ? '' : 's'}
    </span>
  );
};

/** MAP: the roll's MIDI mapper. A mapped CC moves BPM / total steps. */
export const PianoRollMapKey: React.FC = () => (
  <MidiMapper
    title="PIANO"
    accent="theme"
    variant="key"
    storageKey="sa3-midi-map:piano-v1"
    params={PIANO_MIDI_PARAMS}
    onChange={(key, value) => {
      const { setBpm, setTotalSteps, meterMap, pickupSteps } = usePianoRollStore.getState();
      if (key === 'bpm') setBpm(value);
      else if (key === 'totalSteps') {
        // Up to the next bar line of the roll's meter.
        setTotalSteps(Math.max(16, roundUpToBar(meterMap, Math.round(value), pickupSteps)));
      }
    }}
  />
);

/**
 * EDIT: put every part on the EDIT timeline as a MIDI clip on a track of its
 * own (lib/rollBounce). A part with a program plays live there and renders
 * when exported; one with no program is rendered through the MIDI render
 * queue so it can be heard. Once the part being edited is linked the key reads
 * SAVE (latched) and writes its clip, and every other linked part's clip, in
 * place; the corner target unlinks the part being edited.
 */
export const PianoRollEditKey: React.FC = () => {
  const noteCount = usePianoRollStore((s) => (s.notes.length > 0 || s.tracks.some((t) => t.id !== s.activeTrackId && t.notes.length > 0) ? 1 : 0));
  const partCount = usePianoRollStore((s) => s.tracks.length);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const setEditingClip = usePianoRollStore((s) => s.setEditingClip);
  const [isBouncing, setIsBouncing] = useState(false);
  const [clipMenuOpen, setClipMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  const handleSendToEditor = async () => {
    if (rollTracksOf(usePianoRollStore.getState()).every((t) => t.notes.length === 0)) {
      logError('piano-roll', 'No notes to send to the editor');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const done = await bounceRollToEditor({
        global: getGlobalVoice,
        onPart: (n, of, part) => {
          if (of > 1) logInfo('piano-roll', `Sent part ${n} of ${of}: ${part.name}`);
        },
      });
      if (!done) return;
      const ms = (performance.now() - start).toFixed(0);
      // A part with a program plays live in EDIT and renders when exported; one
      // with none was rendered through the MIDI render queue so it can be heard.
      const how = done.rendering ? 'rendered so it can be heard' : 'plays live';
      const made = done.parts.filter((p) => p.kind === 'created').length;
      if (done.parts.length > 1) {
        const heard = done.parts.filter((p) => p.rendering).length;
        logInfo(
          'piano-roll',
          `Sent ${done.parts.length} parts, ${done.noteCount} notes → editor: ${done.parts.length - made} updated in place, ${made} on new tracks; ${heard ? `${heard} rendered so they can be heard, the rest play live` : 'every part plays live'} (${ms}ms)`,
        );
      } else if (done.kind === 'updated') {
        logInfo('piano-roll', `Updated editor clip ${done.clipId.slice(0, 8)} (${done.duration.toFixed(2)}s, ${done.noteCount} notes; ${how})`);
        logInfo('piano-roll', `Save took ${ms}ms`);
      } else {
        logInfo('piano-roll', `Sent ${done.noteCount} notes → editor (${done.duration.toFixed(2)}s in ${ms}ms; ${how})`);
      }
    } catch (e) {
      logError('piano-roll', `Sending to the editor failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  const linked = !!editingClipId;
  const unlinkTip = useDockTip({
    word: 'Unlink',
    description: 'Detach: the next send creates a new editor clip instead of updating the linked one',
    label: 'Unlink from the editor clip',
    expanded: clipMenuOpen,
    placement: 'right',
  });
  // The name always carries the key's word (the DockTip's EDIT or SAVE).
  const name = isBouncing
    ? linked
      ? 'Save: sending to the linked editor clip'
      : 'Edit: sending to the editor'
    : linked
      ? `Save to the linked editor clip ${editingClipId.slice(0, 8)}`
      : 'Edit: send to the editor';
  return (
    <div
      ref={wrapRef}
      className="relative"
      onContextMenu={(e) => {
        if (!linked) return;
        e.preventDefault();
        setClipMenuOpen(true);
      }}
    >
      <RailKey
        ref={keyRef}
        onClick={() => void handleSendToEditor()}
        disabled={noteCount === 0}
        unavailable={isBouncing}
        tipSuppressed={clipMenuOpen && linked}
        aria-label={name}
        description={
          partCount > 1
            ? linked
              ? `This part is linked to clip ${editingClipId.slice(0, 8)}: re-render every part, each linked clip in place and each other part on a new track. Right-click or the corner to unlink this part.`
              : 'Render every part to audio and add each to the waveform editor on a track of its own'
            : linked
              ? `Linked to clip ${editingClipId.slice(0, 8)}: re-render and update it in place. Right-click or the corner to unlink.`
              : 'Render these notes to audio and add them to the waveform editor as a new track'
        }
        on={linked}
        icon={linked
          ? <Save className={`${RAIL_GLYPH} ${CORNER_CLEAR_GLYPH} ${isBouncing ? 'animate-pulse' : ''}`} />
          : <Scissors className={`${RAIL_GLYPH} ${isBouncing ? 'animate-pulse' : ''}`} />}
        legend={linked ? 'Save' : 'Edit'}
      />
      {linked && (
        <button
          ref={unlinkTip.anchorRef}
          type="button"
          onClick={() => setEditingClip(null)}
          aria-label="Unlink from the editor clip"
          aria-describedby={unlinkTip.describedBy}
          className={CORNER_KEY}
        >
          <Unlink aria-hidden="true" className="w-3 h-3" strokeWidth={2.5} />
        </button>
      )}
      {linked && unlinkTip.tip}
      {/* Right-click on SAVE: the same two actions as full-size menu items, so
          UNLINK does not depend on the 12px corner target. */}
      <DockFlyout
        open={clipMenuOpen && linked}
        anchorRef={wrapRef}
        returnFocusRef={keyRef}
        onClose={() => setClipMenuOpen(false)}
        placement="right"
        floorSelector="[data-dock-floor]"
        id="piano-roll-clip-menu"
        role="menu"
        aria-label="Linked editor clip"
        className={`w-28 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
      >
        <MenuKey
          onClick={() => {
            setClipMenuOpen(false);
            void handleSendToEditor();
          }}
          disabled={isBouncing || noteCount === 0}
          title="Re-render the notes and update the linked editor clip in place"
          icon={<Save className="w-3 h-3" />}
          legend="Save"
        />
        <MenuKey
          onClick={() => {
            setClipMenuOpen(false);
            setEditingClip(null);
          }}
          title="Detach: future renders will create a new editor clip instead of updating the linked one"
          icon={<Unlink className="w-3 h-3" />}
          legend="Unlink"
        />
      </DockFlyout>
    </div>
  );
};

/** CLEAR: remove every note of the part being edited, and its controller changes; the bends go only with the last part's notes (pianoRollStore clear). */
export const PianoRollClearKey: React.FC = () => {
  const partName = usePianoRollStore((s) => activeTrackOf(s).name);
  const several = usePianoRollStore((s) => s.tracks.length > 1);
  // Its name says the controller changes go too whenever the part has any.
  const what = usePianoRollStore((s) => (activeTrackOf(s).controls?.length ? 'every note and controller change' : 'every note'));
  return (
    <RailKey
      onClick={() => usePianoRollStore.getState().clear()}
      aria-label={several ? `Clear ${what} of ${partName}` : `Clear ${what}`}
      description={
        several
          ? `Remove every note and controller change of the part ${partName}. The other parts keep theirs, and while they hold any notes the pitch bends stay`
          : 'Remove every note and controller change from the roll'
      }
      icon={<Trash2 className={RAIL_GLYPH} />}
      legend="Clear"
    />
  );
};

/** Save the roll as a Standard MIDI File at its own BPM and time signatures, lane
 *  repeats written out, each bent lane on its own channel with its pitch wheel and
 *  range, and each part on its own track, channel and program (lib/rollMidi). */
export const exportRollMidi = async (): Promise<void> => {
  const roll = usePianoRollStore.getState();
  const parts = rollTracksOf(roll);
  if (parts.every((t) => t.notes.length === 0)) {
    logError('piano-roll', 'No notes to export');
    return;
  }
  // A part that follows the roll's voice is written with the program it plays now.
  const voices = rollPartVoices();
  const file = rollToMidiFile({ ...roll, voices });
  const shared = parts.length > 1 ? partFileChannels(parts).shared : [];
  if (shared.length) {
    const names = parts.filter((t) => shared.includes(t.id)).map((t) => t.name);
    logWarn('piano-roll', `A MIDI file has 16 channels: ${names.join(', ')} share channels, and a player sounds them on one program each`);
  }
  // A bent lane plays on a channel of its own; with every channel taken its notes go on the part's channel, unbent.
  const plan = parts.length > 1 ? partLaneChannels({ ...roll, voices }, parts) : null;
  const unbent = plan?.unbent ?? [];
  // A preset articulation (a pizzicato's GM 46) with no channel left plays in its part's own program.
  if (plan?.articulationFallback.length) {
    logWarn('piano-roll', `No MIDI channel was left for the articulations of ${plan.articulationFallback.map((f) => f.name).join(', ')}: their pizzicato, tremolo and muted notes play in the part's own program`);
  }
  if (unbent.length) {
    const lanes = unbent.map((u) => `${u.name} lane ${roll.lanes.find((l) => l.id === u.lane)?.name ?? u.lane}`);
    logWarn('piano-roll', `No MIDI channel was left for the pitch bend of ${lanes.join(', ')}: those notes are in the file unbent`);
  }
  // Notes with expression of their own go on the MPE zone's member channels, 15 down; with none free they go without it.
  if (rollMidiMpeNoRoom(file, parts)) {
    logWarn('piano-roll', "No MIDI channel was left for an MPE zone: notes with their own expression play on their part's channel, without it");
  }
  // One track per part, and per lane when the roll has more than lane A: the count is every track's notes.
  const count = midiFileNoteCount(file);
  const result = await downloadMidi(file, 'piano-roll');
  const partText = parts.length > 1 ? ` in ${parts.length} parts` : '';
  // A cancelled or failed save exported nothing; saveFile already logged a failure.
  if (result.path) logInfo('piano-roll', `Exported ${count} notes${partText} as MIDI to ${result.path}`);
  else if (result.downloaded) logInfo('piano-roll', `Exported ${count} notes${partText} as MIDI`);
};

export const importMidiFileToRoll = (file: File): void => {
  file.arrayBuffer().then((buf) => {
    try {
      const data = parseMidi(new Uint8Array(buf));
      if (data.tracks.every((t) => t.notes.length === 0)) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      // Every track's notes, the file's time signatures and pickup (4/4 when it
      // has none) and its tempo map. A file of several tracks (or channels)
      // becomes one part each, on its own instrument; a file of one goes into
      // the part being edited. A channel whose pitch wheel moves gets its own
      // lane and curve (lib/rollMidi, lib/rollPartsImport). The grid fits the
      // length (to a bar line of that map) and the pitch range of every part.
      const done = importMidiParts(data, 'imp');
      const changes = done.tempoChanges;
      const where = done.into === 'parts' ? ` as ${done.parts} parts` : ` into ${activeTrackOf(usePianoRollStore.getState()).name}`;
      logInfo(
        'piano-roll',
        `Imported ${done.notes} notes from "${file.name}"${where} at ${Math.round(done.bpm * 100) / 100} BPM${changes > 0 ? ` with ${changes} tempo change${changes === 1 ? '' : 's'}` : ''} in ${meterLabel(done.meterMap[0].meter)}${done.bentLanes ? `, pitch bend in ${done.bentLanes} lane${done.bentLanes === 1 ? '' : 's'}` : ''}`,
      );
      if (done.folded) logWarn('piano-roll', `The roll holds ${MAX_ROLL_PARTS} parts: the notes of the last ${done.folded + 1} tracks are in its last part`);
      if (done.pastEnd) logWarn('piano-roll', pastEndLog(done.pastEnd));
      if (done.keptDocument) logInfo('piano-roll', KEPT_DOCUMENT_LOG);
    } catch (e) {
      logError('piano-roll', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }).catch((e) => logError('piano-roll', `Could not read file: ${e instanceof Error ? e.message : String(e)}`));
};

export const importSheetFileToRoll = (file: File): void => {
  void (async () => {
    try {
      const score = await parseSheetFile(file);
      if (score.tracks.every((t) => t.notes.length === 0)) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      // Each part of the score becomes a part of the roll on the instrument the
      // score names, each note at its tick; a score of one part goes into the
      // part being edited. Every time signature (with the pickup) becomes the
      // roll's meter map and every tempo mark its tempo map
      // (lib/rollPartsImport importSheetParts).
      const done = importSheetParts(score);
      const meter = usePianoRollStore.getState().meterMap[0].meter;
      // The score's printed dynamics come as expression (controller 11), which each part plays and exports.
      const dynamics = score.tracks.reduce((n, t) => n + (t.controls ?? []).filter((c) => c.controller === 11).length, 0);
      const where = done.into === 'parts' ? ` as ${done.parts} parts` : ` into ${activeTrackOf(usePianoRollStore.getState()).name}`;
      const changes = [
        done.tempoChanges ? `${done.tempoChanges} tempo change${done.tempoChanges === 1 ? '' : 's'}` : '',
        done.meterChanges ? `${done.meterChanges} meter change${done.meterChanges === 1 ? '' : 's'}` : '',
        score.grace_notes ? `${score.grace_notes} grace notes timed` : '',
        score.ornaments ? `${score.ornaments} ornaments played out` : '',
        score.chord_symbols_skipped ? `${score.chord_symbols_skipped} chord symbols left out` : '',
        score.pedal_marks ? `${score.pedal_marks} sustain pedal mark${score.pedal_marks === 1 ? '' : 's'} as pedal changes` : '',
        dynamics ? `${dynamics} dynamic${dynamics === 1 ? '' : 's'} as expression changes` : '',
      ].filter(Boolean);
      logInfo(
        'piano-roll',
        `Imported ${done.notes} notes from score "${file.name}" (${score.format})${where} at ${Math.round(score.bpm * 100) / 100} BPM in ${meterLabel(meter)}${changes.length ? `, ${changes.join(', ')}` : ''}`,
      );
      if (score.unmapped_unpitched) logWarn('piano-roll', `${score.unmapped_unpitched} unpitched notes of "${file.name}" name no drum; they play on the snare (key 38)`);
      if (done.folded) logWarn('piano-roll', `The roll holds ${MAX_ROLL_PARTS} parts: the notes of the last ${done.folded + 1} parts are in its last part`);
      if (done.pastEnd) logWarn('piano-roll', pastEndLog(done.pastEnd));
      if (done.keptDocument) logInfo('piano-roll', KEPT_DOCUMENT_LOG);
    } catch (e) {
      logError('piano-roll', `Sheet import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
};

/* ── the grid: keyboard column, ruler, notes ──────────────────────────────── */

/**
 * The ruler: one cell per bar, as wide as the bar and clipped at the roll's
 * end, with its number ("Pickup" on a pickup wide enough to hold it), the meter
 * wherever it changes, a syncopation band along the top, and over the cells the
 * bar lines (the grid's own bar tier) with group and beat ticks. The band's
 * strength is each bar's LHL score over the highest score in the whole roll, so
 * a bar reads the same at any scroll.
 *
 * Only the bars and ticks inside `win` (the view and its overscan) render, so
 * a roll of thousands of bars draws the few dozen in view. Zoomed out, a bar
 * number prints every 2, 4, 8 ... bars (from bar 1), each bar by its own width
 * (rulerShowsNumber), so the numbers never run
 * into each other, and a tick tier whose lines stand closer than
 * MIN_TIER_GAP_PX drops out.
 */
const RollRuler = React.memo(function RollRuler({
  spans,
  lhl,
  tiers,
  stepPx,
  totalSteps,
  win,
}: {
  spans: BarSpan[];
  lhl: number[];
  tiers: { bar: number[]; group: number[]; beat: number[] };
  stepPx: number;
  totalSteps: number;
  win: { from: number; to: number };
}) {
  const box = windowPx(win, stepPx, totalSteps);
  const ticks = useMemo(
    () => ({
      bar: linesPath(within(tiers.bar, win.from, win.to), stepPx, 0, HEADER_HEIGHT, box.x),
      // Below the 12px labels, which sit 5px from the top.
      group: linesPath(tierWithin(tiers.group, win.from, win.to, stepPx), stepPx, 17, 21, box.x),
      beat: linesPath(tierWithin(tiers.beat, win.from, win.to, stepPx), stepPx, 19, 21, box.x),
    }),
    [tiers, stepPx, win, box.x],
  );
  const max = useMemo(() => lhl.reduce((m, v) => Math.max(m, v), 0), [lhl]);
  const shown = spansWithin(spans, win.from, win.to);

  return (
    // An opaque ground in the theme's canvas: notes and loop lines scrolled under the ruler stay off its ticks and text.
    // It fills RollSeek, which sticks to the top of the grid and takes the clicks.
    <div className="absolute inset-0 bg-[#07050a] border-b border-white/5">
      {spans.slice(shown.first, shown.end).map((b, k) => {
        const i = shown.first + k;
        const prev = i > 0 ? spans[i - 1] : null;
        const change = b.bar >= 0 && (!prev || prev.bar < 0 || !meterEquals(prev.meter, b.meter));
        const score = lhl[i] ?? 0;
        const alpha = 0.12 + 0.88 * (max > 0 ? Math.min(1, score / max) : 0);
        const cellPx = Math.max(0, Math.min(b.len, totalSteps - b.start)) * stepPx;
        return (
          <div
            key={b.start}
            data-ruler-bar="1"
            className="absolute top-0 bottom-0 overflow-hidden flex items-start gap-2.5 pl-1 pt-1.25 text-[12px] leading-none font-display font-bold text-zinc-500 whitespace-nowrap"
            style={{ left: b.start * stepPx, width: cellPx }}
            title={`${b.bar < 0 ? 'Pickup' : `Bar ${b.bar + 1}`} syncopation ${score.toFixed(2)}`}
          >
            <div
              data-sync-band="1"
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-0.75"
              style={{ backgroundColor: `rgb(var(--et-accent) / ${alpha.toFixed(3)})` }}
            />
            {/* Orbitron's "1" carries its space on the left, so 10px keeps the bar number
                visibly apart from the meter beside it ("1  7/8 3+2+2"). */}
            {(b.bar >= 0 ? rulerShowsNumber(b, stepPx) : cellPx >= PICKUP_LEGEND_MIN_PX) && <span>{b.bar >= 0 ? b.bar + 1 : 'Pickup'}</span>}
            {change && <span className="font-extrabold et-ink">{meterLabel(b.meter)}</span>}
          </div>
        );
      })}
      <svg
        aria-hidden="true"
        focusable="false"
        className="absolute top-0 h-full pointer-events-none"
        style={{ left: box.x }}
        width={box.width}
        shapeRendering="crispEdges"
      >
        {ticks.beat && <path d={ticks.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />}
        {ticks.group && <path d={ticks.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.4)]" />}
        <path d={ticks.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
      </svg>
    </div>
  );
});

/**
 * The ruler's transport layer: it sticks to the top of the grid, holds the
 * ruler (RollRuler, which only re-renders when the bars change) and takes the
 * pointer and the keys.
 *
 *   - a click moves the playhead to the step under the pointer (`seek`): PLAY
 *     starts there, a paste lands there, and the METER face's ADD starts a
 *     change in its bar; while the roll plays, playback jumps there
 *   - a drag along it sets the loop to the steps it covers and turns it on
 *   - it is a slider for the keyboard: the arrows move the playhead a step,
 *     Shift+arrows a bar, Home and End to the roll's ends
 *
 * It draws the loop range (full strength while the loop is on) and the
 * playhead's mark.
 */
function RollSeek({
  stepPx,
  totalSteps,
  meterMap,
  pickupSteps,
  onSeek,
  children,
  top = 0,
}: {
  stepPx: number;
  totalSteps: number;
  meterMap: MeterSegment[];
  pickupSteps: number;
  onSeek: (step: number) => void;
  children: React.ReactNode;
  /** Where the ruler sticks in the grid's scroll box: under the harmony row when it is open. */
  top?: number;
}) {
  const width = totalSteps * stepPx;
  const step = usePianoRollStore((s) => Math.floor(Math.max(0, s.currentStep)));
  const loop = usePianoRollStore((s) => s.loop);
  const loopOn = usePianoRollStore((s) => s.loopOn);
  const [draft, setDraft] = useState<RollLoop | null>(null);
  const pressRef = useRef<{ downStep: number; startX: number; dragging: boolean } | null>(null);

  // The pointer in the ruler's own px (the shell's CSS zoom taken out, lib/canvasScale), then in steps.
  const stepAtClient = (el: HTMLElement, clientX: number): number => clientToLocal(el, clientX, 0).x / stepPx;
  const seekTo = (to: number) => {
    const next = rulerSeekStep(to, totalSteps);
    usePianoRollStore.getState().seek(next);
    onSeek(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pressRef.current = { downStep: stepAtClient(e.currentTarget, e.clientX), startX: e.clientX, dragging: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return;
    e.stopPropagation();
    if (!press.dragging && Math.abs(e.clientX - press.startX) < MARQUEE_MIN_PX) return;
    press.dragging = true;
    setDraft(rulerLoop(press.downStep, stepAtClient(e.currentTarget, e.clientX), totalSteps));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    e.stopPropagation();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDraft(null);
    if (!press.dragging) {
      seekTo(stepAtClient(e.currentTarget, e.clientX));
      return;
    }
    // A drag that came back to the step line it started on sets nothing.
    const next = rulerLoop(press.downStep, stepAtClient(e.currentTarget, e.clientX), totalSteps);
    if (next) usePianoRollStore.getState().setLoop(next);
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pressRef.current) return;
    pressRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDraft(null);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const to = rulerKeyStep(e.key, e.shiftKey, step, totalSteps, meterMap, pickupSteps);
    if (to === null) return;
    // The ruler keeps the key, so an arrow here never also moves an EDIT clip.
    e.preventDefault();
    e.stopPropagation();
    seekTo(to);
  };

  const shown = draft ?? loop;
  const at = Math.min(step, Math.max(0, totalSteps - 1));
  const bar = barAt(meterMap, at, pickupSteps);
  return (
    // data-dock-ceiling: the SHAPE row's above cards (GEN, FORM) keep their tops below this line.
    <div
      data-dock-ceiling=""
      data-roll-ruler=""
      role="slider"
      tabIndex={0}
      aria-label="Playhead: click the ruler to move it, drag along it to set the loop"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, totalSteps)}
      aria-valuenow={at + 1}
      aria-valuetext={`Step ${at + 1}, ${bar.bar < 0 ? 'the pickup' : `bar ${bar.bar + 1}`}`}
      className="sticky z-20 cursor-pointer outline-none focus-visible:shadow-[inset_0_0_0_1px_rgb(var(--et-accent))]"
      style={{ top, height: HEADER_HEIGHT, width, minWidth: '100%' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      {children}
      {shown && (
        <div
          aria-hidden="true"
          data-loop-range="1"
          className={`absolute bottom-0 h-1.5 border-x pointer-events-none ${
            draft || loopOn
              ? 'bg-[rgb(var(--et-accent)/0.7)] border-[rgb(var(--et-accent))]'
              : 'bg-[rgb(var(--et-accent)/0.2)] border-[rgb(var(--et-accent)/0.5)]'
          }`}
          style={{ left: shown.start * stepPx, width: (shown.end - shown.start) * stepPx }}
        />
      )}
      <RulerPlayhead stepPx={stepPx} totalSteps={totalSteps} />
    </div>
  );
}

/** The playhead's mark on the ruler, level with the grid's playhead line. */
const RulerPlayhead: React.FC<{ stepPx: number; totalSteps: number }> = ({ stepPx, totalSteps }) => {
  const currentStep = usePianoRollStore((s) => s.currentStep);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  return (
    <div
      aria-hidden="true"
      className={`absolute top-0 bottom-0 w-0.5 -ml-px pointer-events-none bg-[rgb(var(--et-ink))] ${isPlaying ? '' : 'opacity-60'}`}
      style={{ left: Math.min(Math.max(0, currentStep), totalSteps) * stepPx }}
    />
  );
};

/**
 * The step range the grid shows, widened by the overscan on each side and
 * snapped out to whole overscan blocks, so a scroll changes it only when it
 * crosses a block. Until the grid is measured it is the roll's start, one
 * window wide plus the overscan.
 */
function useStepWindow(scrollRef: React.RefObject<HTMLDivElement | null>, stepPx: number): { from: number; to: number } {
  const [win, setWin] = useState(() => ({ from: 0, to: (window.innerWidth + 2 * WINDOW_OVERSCAN_PX) / stepPx }));
  // A passive effect: the grid's scroll element takes its ref after this child's layout effects run.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const x0 = Math.floor(el.scrollLeft / WINDOW_OVERSCAN_PX) * WINDOW_OVERSCAN_PX - WINDOW_OVERSCAN_PX;
      const x1 = Math.ceil((el.scrollLeft + el.clientWidth) / WINDOW_OVERSCAN_PX) * WINDOW_OVERSCAN_PX + WINDOW_OVERSCAN_PX;
      const next = { from: Math.max(0, x0) / stepPx, to: x1 / stepPx };
      setWin((w) => (w.from === next.from && w.to === next.to ? w : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, stepPx]);
  return win;
}

/** The MIDI notes from the top row down. */
const rowNotes = (lowestNote: number, highestNote: number): number[] => {
  const rows: number[] = [];
  for (let n = highestNote; n >= lowestNote; n -= 1) rows.push(n);
  return rows;
};

/** The keyboard column's keys, one per row; a click previews the pitch. Re-renders only when the range changes. */
const KeyboardKeys = React.memo(function KeyboardKeys({
  lowestNote,
  highestNote,
  masterRef,
}: {
  lowestNote: number;
  highestNote: number;
  masterRef: { current: number };
}) {
  return (
    <>
      {rowNotes(lowestNote, highestNote).map((midi) => {
        const black = isBlackKey(midi);
        const isC = midi % 12 === 0;
        return (
          <div
            key={midi}
            onClick={() => auditionRollVoice(midi, 100, getEngineCtx().currentTime + 0.02, 0.25, masterRef.current, currentRollVoice())}
            // Fixed key colours: the theme remaps bg-zinc-900 and text-zinc-700 (light
            // black keys on paper, pale C labels on dark), while a keyboard needs
            // dark black keys and dark ink on the white ones in every theme.
            // text-zinc-800 is left unmapped for exactly this.
            className={`flex items-center justify-end pr-1 text-[12px] leading-none font-bold cursor-pointer transition-shadow border-b border-black/40 hover:shadow-[inset_0_0_0_100px_rgb(var(--et-accent)/0.3)] ${black ? 'bg-[#18181b]' : isC ? 'bg-zinc-200 text-zinc-800' : 'bg-zinc-300 text-zinc-800'}`}
            style={{ height: NOTE_HEIGHT }}
            title={`Preview ${noteLabel(midi)}`}
          >
            {isC ? noteLabel(midi) : ''}
          </div>
        );
      })}
    </>
  );
});

/** The grid's row backgrounds: alternating black/white key tint and row lines. Re-renders only when the range changes. */
const RowBackgrounds = React.memo(function RowBackgrounds({ lowestNote, highestNote }: { lowestNote: number; highestNote: number }) {
  return (
    <>
      {rowNotes(lowestNote, highestNote).map((midi, idx) => (
        <div
          key={midi}
          className={`absolute left-0 right-0 border-b ${isBlackKey(midi) ? 'bg-white/2' : 'bg-white/4'} ${midi % 12 === 0 ? 'border-white/10' : 'border-black/30'}`}
          style={{ top: idx * NOTE_HEIGHT, height: NOTE_HEIGHT }}
        />
      ))}
    </>
  );
});

/** How much an arrow key moves the selected notes' velocity, and under Shift. */
const VELOCITY_KEY_STEP = 1;
const VELOCITY_KEY_COARSE = 10;

/**
 * The velocity lane: the strip under the grid where every note's velocity is a
 * bar standing at the note's own x position, so a bar sits under the note it
 * belongs to and scrolls and zooms with it (it lives inside the grid's scroll
 * box, as the bend lane does).
 *
 * Before this, velocity could only be moved ±10 at a time from a note's
 * right-click menu, one note per trip.
 *
 * Editing:
 *   - press a bar and drag up or down to set that note's velocity
 *   - keep dragging sideways to DRAW across a phrase: every note the sweep
 *     crosses takes the velocity the pointer is at, and a sweep that skips
 *     pixels still catches the notes between (lib/rollSelection notesInStepSpan)
 *   - a sweep that passes over a SELECTED note writes only the selected notes
 *     it passed, which is how one voice of a chord is isolated — otherwise the
 *     bars of a chord sit on top of each other and all move together
 *   - the lane takes focus, and the up / down arrows move every selected note's
 *     velocity by the same amount (Shift for 10), so a crescendo stays one
 *
 * The bars are windowed to the steps in view, so a long roll draws no more of
 * them than the grid does, and the svg itself covers only that window.
 */
const VelocityLane: React.FC<{
  stepPx: number;
  totalSteps: number;
  win: { from: number; to: number };
}> = ({ stepPx, totalSteps, win }) => {
  const notes = usePianoRollStore((s) => s.notes);
  const selectedIds = usePianoRollStore((s) => s.selectedIds);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The step the last pointer sample sat on, so a sweep covers the gap between samples.
  const dragRef = useRef<number | null>(null);
  // Unique per instance: every roll on the page gets its own help paragraph,
  // so aria-describedby can never point at another instance's copy.
  const helpId = useId();

  const width = Math.max(1, totalSteps * stepPx);
  const height = VELOCITY_LANE_HEIGHT;
  const box = windowPx(win, stepPx, totalSteps);

  // The notes in the window, from the notes' interval index (lib/noteIndex), which the grid shares.
  const bars = useMemo(() => noteIndexOf(notes).query(win.from, win.to), [notes, win]);

  /** The reading beside the legend: one selected velocity, a range, or a dash. */
  const reading = useMemo(() => {
    const picked = notes.filter((n) => selectedIds.has(n.id));
    if (picked.length === 0) return '—';
    const lo = picked.reduce((m, n) => Math.min(m, n.velocity), VELOCITY_MAX);
    const hi = picked.reduce((m, n) => Math.max(m, n.velocity), 1);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  }, [notes, selectedIds]);
  // The strip is a slider: its value is the selected notes' velocity (the
  // lowest of a range, which the arrow keys move together), or with none
  // selected the notes' average, which a drag draws over.
  const laneValue = useMemo(() => {
    const picked = notes.filter((n) => selectedIds.has(n.id));
    const pool = picked.length ? picked : notes;
    if (!pool.length) return { now: VELOCITY_MIN, text: 'No notes' };
    if (picked.length) {
      const lo = picked.reduce((m, n) => Math.min(m, n.velocity), VELOCITY_MAX);
      const hi = picked.reduce((m, n) => Math.max(m, n.velocity), VELOCITY_MIN);
      const count = `${picked.length} selected`;
      return { now: lo, text: lo === hi ? `Velocity ${lo}, ${count}` : `Velocity ${lo} to ${hi}, ${count}` };
    }
    const mean = Math.round(pool.reduce((sum, n) => sum + n.velocity, 0) / pool.length);
    return { now: mean, text: `None selected; the notes average velocity ${mean}` };
  }, [notes, selectedIds]);

  // Every write reads the store rather than this render's props: a sweep fires
  // faster than React re-renders, and each sample must see the note list the
  // one before it left.
  const writeAt = useCallback(
    (fromStep: number, toStep: number, y: number) => {
      const s = usePianoRollStore.getState();
      const ids = velocityTargets(s.notes, fromStep, toStep, s.selectedIds);
      if (ids.length > 0) s.setVelocity(ids, yToVelocity(y, height));
    },
    [height],
  );

  // The pointer in the strip's own px: the shell's CSS zoom taken out (lib/canvasScale).
  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const el = surfaceRef.current;
    return el ? clientToLocal(el, e.clientX, e.clientY) : { x: e.clientX, y: e.clientY };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const step = x / Math.max(1e-6, stepPx);
    dragRef.current = step;
    // The whole sweep is one undo step, however long it pauses.
    beginRollGesture();
    writeAt(step, step, y);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // preventDefault below suppresses the compatibility mousedown, and with it
    // the focus it would have given the strip, so the strip takes focus itself
    // — otherwise the arrow keys would not reach it after a click.
    surfaceRef.current?.focus();
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragRef.current;
    if (from === null) return;
    const { x, y } = localPoint(e);
    const step = x / Math.max(1e-6, stepPx);
    writeAt(from, step, y);
    dragRef.current = step;
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    endRollGesture();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // The lane keeps the key even with nothing selected, so an arrow here never
    // falls through to the roll's own nudge or the EDIT timeline's.
    e.preventDefault();
    e.stopPropagation();
    const s = usePianoRollStore.getState();
    const by = (e.shiftKey ? VELOCITY_KEY_COARSE : VELOCITY_KEY_STEP) * (e.key === 'ArrowUp' ? 1 : -1);
    // One write per velocity the selection lands on, so every note moves by the
    // same amount and the whole nudge is a single undo step.
    for (const w of velocityNudgeWrites(s.notes, s.selectedIds, by)) s.setVelocity(w.ids, w.velocity);
  };

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-velocity-lane="">
      <div className="h-6.5 flex items-center gap-1.5 px-1.5 border-b border-white/5">
        <span className={FIELD_LEGEND}>Velocity</span>
        <span className={FIELD_VALUE} title="The selected notes' velocity">{reading}</span>
        <span className="flex-1" />
        <span className="text-[12px] font-semibold et-ink-3 tabular-nums whitespace-nowrap">
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {/* A slider over the selected notes' velocity: the up and down arrow keys
          move it, and a screen reader announces the value as it moves. */}
      <div
        ref={surfaceRef}
        role="slider"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={VELOCITY_MIN}
        aria-valuemax={VELOCITY_MAX}
        aria-valuenow={laneValue.now}
        aria-valuetext={laneValue.text}
        aria-label={`Velocity lane, ${notes.length} note${notes.length === 1 ? '' : 's'}, ${
          selectedIds.size > 0 ? `${selectedIds.size} selected at velocity ${reading}` : 'none selected'
        }`}
        aria-describedby={helpId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="relative cursor-ns-resize outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))]"
        style={{ width, height }}
      >
        <svg
          width={box.width}
          height={height}
          className="absolute top-0 pointer-events-none"
          style={{ left: box.x }}
          viewBox={`${box.x} 0 ${box.width} ${height}`}
          shapeRendering="crispEdges"
        >
          {/* Quarter marks, so a bar's height reads as a value without a scale. */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={box.x}
              x2={box.x + box.width}
              y1={Math.round(height * (1 - f)) + 0.5}
              y2={Math.round(height * (1 - f)) + 0.5}
              stroke="rgb(255 255 255 / 0.06)"
              strokeWidth={1}
            />
          ))}
          {bars.map((n) => {
            const on = selectedIds.has(n.id);
            const h = velocityBarHeight(n.velocity, height);
            return (
              <rect
                key={n.id}
                x={n.step * stepPx}
                y={velocityToY(n.velocity, height)}
                width={Math.max(2, n.length * stepPx - 1)}
                height={Math.max(1, h)}
                fill={on ? 'rgb(var(--et-accent))' : 'rgb(var(--et-accent) / 0.34)'}
                stroke={on ? 'rgb(255 255 255 / 0.9)' : 'rgb(var(--et-accent) / 0.7)'}
                strokeWidth={1}
              />
            );
          })}
        </svg>
      </div>
      <p id={helpId} className="sr-only">
        Each bar is a note&apos;s velocity, 1 at the floor and 127 at the top. Drag a bar up or down to set it, and
        keep dragging sideways to draw across the notes you pass. With notes selected, a drag writes only the selected
        ones it passes. The up and down arrow keys move every selected note&apos;s velocity by one, or by ten with Shift.
      </p>
    </div>
  );
};

/**
 * True when a key belongs to a portalled menu, listbox or dialog rather than to
 * the roll.
 *
 * The roll's window listeners run on the CAPTURE phase and claim their keys
 * whenever `ownsKey('piano-roll')` says so — and that is true while the POINTER
 * merely rests on the dock, even though the keyboard is somewhere else
 * entirely. A context menu, a select's listbox and a modal all render through a
 * portal, outside the roll's root, so without this the roll would eat the arrow
 * keys that move a menu's highlight and the Ctrl/Cmd+A inside a dialog's field.
 */
const inPortalledOverlay = (target: EventTarget | null, root: HTMLElement | null): boolean => {
  const t = target instanceof Element ? target : null;
  if (!t || root?.contains(t)) return false;
  return !!t.closest('[role="menu"], [role="listbox"], [role="dialog"]');
};

/**
 * The keyboard's and the screen reader's way to the notes, which draw on a
 * canvas: a focusable box over the selected note (the primary one of a
 * selection), named with its pitch, step, length, velocity and lane, inside a
 * group that names the part and its note count. Neither takes the pointer:
 * the grid's hit test does (lib/rollCanvas hitNote).
 *
 * With it focused, Alt+Left and Alt+Right select the note before or after in
 * time (the interval index's order), scrolling it into view; the arrow keys
 * move the selection and Delete removes it (the roll's own keys); Enter,
 * Space, Shift+F10 or the menu key opens the note's menu. With nothing
 * selected the group itself takes focus, and Enter or Alt+Right selects the
 * first note.
 */
const NoteFocusLayer: React.FC<{
  notes: readonly PianoNote[];
  noteIdx: NoteIndex<PianoNote>;
  geo: RollGeometry;
  lookIndexOf: (lane: number | undefined) => number;
  laneName: (lane: number | undefined) => string;
  laneCount: number;
  partName: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onMenu: (n: PianoNote, clientX: number, clientY: number) => void;
  /** The note whose menu is open, or null: the focus box says so (aria-expanded). */
  menuNoteId: string | null;
}> = ({ notes, noteIdx, geo, lookIndexOf, laneName, laneCount, partName, scrollRef, onMenu, menuNoteId }) => {
  const selectedNoteId = usePianoRollStore((s) => s.selectedNoteId);
  const selectedCount = usePianoRollStore((s) => s.selectedIds.size);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const helpId = useId();
  const primary = useMemo(
    () => (selectedNoteId ? notes.find((n) => n.id === selectedNoteId) ?? null : null),
    [notes, selectedNoteId],
  );
  const shown = primary && primary.note >= lowestNote && primary.note <= highestNote ? primary : null;
  const box = shown ? noteBox(shown, geo, lookOf(lookIndexOf(shown.lane)).minPx) : null;

  // A note picked from the group's keys takes the focus the group had.
  useLayoutEffect(() => {
    if (shown && typeof document !== 'undefined' && document.activeElement === groupRef.current) noteRef.current?.focus();
  }, [shown]);

  /** Scrolls the grid so `n` is in view. */
  const reveal = (n: PianoNote) => {
    const el = scrollRef.current;
    if (!el) return;
    const b = noteBox(n, geo, lookOf(lookIndexOf(n.lane)).minPx);
    const w = el.clientWidth;
    const h = Math.max(0, el.clientHeight - GRID_COVER_PX);
    if (w > 0 && (b.x < el.scrollLeft || b.x + b.w > el.scrollLeft + w)) el.scrollLeft = Math.max(0, b.x - w / 4);
    if (h > 0 && (b.y < el.scrollTop || b.y + b.h > el.scrollTop + h)) el.scrollTop = Math.max(0, b.y - h / 2);
  };
  const pick = (n: PianoNote | null) => {
    if (!n) return;
    usePianoRollStore.getState().setSelectedNote(n.id);
    reveal(n);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      pick(primary ? noteIdx.step(primary, e.key === 'ArrowRight' ? 1 : -1) : noteIdx.first());
      return;
    }
    // Space activates a button as Enter does, so on the note's box it opens the
    // menu too, and it stops here: EDIT's window keys would take it for PLAY.
    const space = e.key === ' ' || e.key === 'Spacebar';
    const menuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || e.key === 'Enter' || (space && e.target === noteRef.current);
    if (!menuKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (!primary) {
      pick(noteIdx.first());
      return;
    }
    const r = noteRef.current?.getBoundingClientRect();
    onMenu(primary, r ? r.left + r.width / 2 : 0, r ? r.bottom : 0);
  };

  const noteName = shown
    ? `${noteLabel(shown.note)}, step ${stepText(shown.step + 1)}, ${stepText(shown.length)} step${shown.length === 1 ? '' : 's'}, velocity ${shown.velocity}${
        laneCount > 1 ? `, lane ${laneName(shown.lane)}` : ''
      }, selected${selectedCount > 1 ? `, one of ${selectedCount}` : ''}`
    : '';
  return (
    <div
      ref={groupRef}
      role="group"
      tabIndex={shown ? -1 : 0}
      aria-label={`Notes of ${partName}: ${notes.length} note${notes.length === 1 ? '' : 's'}, ${selectedCount} selected`}
      aria-describedby={helpId}
      data-roll-note-focus=""
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-11 pointer-events-none outline-none focus-visible:shadow-[inset_0_0_0_1px_rgb(var(--et-accent))]"
    >
      {box && (
        <div
          ref={noteRef}
          role="button"
          tabIndex={0}
          aria-label={noteName}
          aria-describedby={helpId}
          aria-haspopup="menu"
          aria-expanded={menuNoteId !== null && menuNoteId === shown?.id}
          data-note-focus=""
          className="absolute rounded-sm outline-none pointer-events-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-ink))]"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        />
      )}
      <p id={helpId} className="sr-only">
        Alt+Left and Alt+Right select the note before or after. The arrow keys move the selection, a semitone or a snap cell,
        and with Shift an octave or four cells. Delete removes it. Enter, Space, Shift+F10 or the menu key opens the note&apos;s menu.
      </p>
    </div>
  );
};

export const PianoRoll: React.FC<{
  stepPx: number;
  onStepPxChange: (px: number) => void;
  /** The bend lane is open under the grid (the strip's BEND key). */
  showBend?: boolean;
  /** The tempo lane is open under the grid (the strip's TEMPO key). */
  showTempo?: boolean;
  /** The CC lane is open under the grid (the strip's CC key). */
  showCc?: boolean;
  /** The articulation lane is open under the grid (the strip's ART key). */
  showArticulations?: boolean;
}> = ({
  stepPx,
  onStepPxChange,
  showBend = false,
  showTempo = false,
  showCc = false,
  showArticulations = false,
}) => {
  const notes = usePianoRollStore((s) => s.notes);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const selectedIds = usePianoRollStore((s) => s.selectedIds);
  const recordedRange = usePianoRollStore((s) => s.recordedRange);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const lanes = usePianoRollStore((s) => s.lanes);
  const activeLane = usePianoRollStore((s) => s.activeLane);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const snap = usePianoRollStore((s) => s.snap);
  const rollParts = usePianoRollStore((s) => s.tracks);
  const activeTrackId = usePianoRollStore((s) => s.activeTrackId);
  const showGhosts = usePianoRollStore((s) => s.showGhosts);
  const markers = usePianoRollStore((s) => s.markers);
  const showHarmony = usePianoRollStore((s) => s.showHarmony);
  const showFiguredBass = usePianoRollStore((s) => s.showFiguredBass);
  const cantusHere = usePianoRollStore((s) => activeTrackOf(s).cantusFirmus === true);
  // The harmony row sits over the ruler when it is open, so everything that sticks under it moves down by its height.
  const harmonyPx = showHarmony ? HARMONY_ROW_HEIGHT : 0;
  const coverPx = GRID_COVER_PX + harmonyPx;
  // The other parts, drawn behind the active one; their notes in the list are theirs.
  const ghostParts = useMemo(
    () => (showGhosts ? rollParts.filter((t) => t.id !== activeTrackId && t.notes.length > 0) : []),
    [showGhosts, rollParts, activeTrackId],
  );
  const audibleParts = useMemo(() => audiblePartIds(rollParts), [rollParts]);
  const partName = usePianoRollStore((s) => activeTrackOf(s).name);

  const addNote = usePianoRollStore((s) => s.addNote);
  const removeNote = usePianoRollStore((s) => s.removeNote);
  const updateNote = usePianoRollStore((s) => s.updateNote);
  const setSelectedNote = usePianoRollStore((s) => s.setSelectedNote);
  const setSelection = usePianoRollStore((s) => s.setSelection);
  const addToSelection = usePianoRollStore((s) => s.addToSelection);
  const toggleSelection = usePianoRollStore((s) => s.toggleSelection);
  const clear = usePianoRollStore((s) => s.clear);
  // CLEAR takes the part's controller changes with its notes: the menu entry says so when it has any.
  const clearsControls = usePianoRollStore((s) => !!activeTrackOf(s).controls?.length);
  const undo = usePianoRollStore((s) => s.undo);
  const redo = usePianoRollStore((s) => s.redo);
  const noteMenu = useContextMenu<PianoNote>();
  const masterRef = useMasterGainRef();

  const noteCount = highestNote - lowestNote + 1;
  const gridHeight = noteCount * NOTE_HEIGHT;
  const gridWidth = totalSteps * stepPx;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const keyboardRowsRef = useRef<HTMLDivElement | null>(null);
  // The steps in view plus the overscan: notes and lane repeats outside it do not render.
  const view = useStepWindow(gridScrollRef, stepPx);

  // The meter as the grid draws it: bars, the three line tiers, the notes as
  // they play (lane repeats written out) and each bar's syncopation score.
  const barSpans = useMemo(() => meterBars(meterMap, totalSteps, pickupSteps), [meterMap, totalSteps, pickupSteps]);
  const tiers = useMemo(() => gridLines(meterMap, totalSteps, pickupSteps), [meterMap, totalSteps, pickupSteps]);
  // The active lane's own time (a meter of its own, a tuplet ratio), or null
  // when it reads the roll's: then the grid draws the lane's bars, groups and
  // beats and every gesture snaps to them, while the roll's bar lines stay.
  const activeLaneDef = lanes.find((l) => l.id === activeLane);
  const laneTime = useMemo(() => laneTimeOf(activeLaneDef, meterMap, pickupSteps), [activeLaneDef, meterMap, pickupSteps]);
  const laneTiers = useMemo(() => (laneTime ? laneGridLines(laneTime, totalSteps) : null), [laneTime, totalSteps]);
  // The snap grid (lib/rollSnap): where a click, a drag, a resize, a nudge and
  // the note menu land, restarting at every group of every bar (of the active
  // lane's own bars when it has them). The key handlers read it through the
  // ref, so they need no re-binding.
  const snapLines = useMemo(
    () => (laneTime ? laneSnapGrid(laneTime, totalSteps, snap) : snapGrid(meterMap, pickupSteps, totalSteps, snap)),
    [laneTime, meterMap, pickupSteps, totalSteps, snap],
  );
  const snapRef = useRef<SnapGrid>(snapLines);
  snapRef.current = snapLines;
  // The scores read only each note's step, velocity and lane, so an edit that
  // changes none of them (a resize, a pitch move) keeps the previous note list
  // here and skips the unroll and the scoring.
  const onsetRef = useRef<PianoNote[]>(notes);
  const onsetNotes = useMemo(() => {
    const prev = onsetRef.current;
    const same = prev.length === notes.length
      && prev.every((p, i) => p === notes[i] || (p.step === notes[i].step && p.velocity === notes[i].velocity && p.lane === notes[i].lane));
    if (!same) onsetRef.current = notes;
    return onsetRef.current;
  }, [notes]);
  // The same scores keep the same array, so the ruler skips an edit that moves no onset.
  const lhlRef = useRef<number[]>([]);
  const barLhl = useMemo(() => {
    const played = unrollLanes(onsetNotes, lanes, totalSteps);
    const next = syncopationByBar(played, meterMap, totalSteps, pickupSteps).map((b) => b.lhl);
    const prev = lhlRef.current;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
    lhlRef.current = next;
    return next;
  }, [onsetNotes, lanes, meterMap, totalSteps, pickupSteps]);

  // Each tier is one SVG path, so the grid's node count stays flat at any
  // length, and each path holds only the lines inside the view and its
  // overscan (`view`), so a roll of thousands of bars draws the few in view.
  // Step lines skip the steps a stronger tier already draws; a beat or group
  // tier whose lines stand closer than MIN_TIER_GAP_PX in view drops out there.
  const gridBox = windowPx(view, stepPx, totalSteps);
  const gridPaths = useMemo(() => {
    const from = view.from;
    const to = view.to;
    const bars = within(tiers.bar, from, to);
    // An active lane with its own time draws its groups and beats in place of
    // the roll's, and its bar lines in the accent; the roll's bar lines stay.
    const near = (xs: readonly number[], x: number) => xs.some((b) => Math.abs(b - x) < 1e-6);
    const laneBar = laneTiers ? within(laneTiers.bar, from, to).filter((x) => !near(bars, x)) : [];
    const group = laneTiers ? tierWithin(laneTiers.group, from, to, stepPx).filter((x) => !near(bars, x)) : tierWithin(tiers.group, from, to, stepPx);
    const beat = laneTiers ? tierWithin(laneTiers.beat, from, to, stepPx).filter((x) => !near(bars, x)) : tierWithin(tiers.beat, from, to, stepPx);
    const drawn = new Set([...bars, ...group, ...beat, ...laneBar]);
    // The snap's own subdivision: 16ths, triplets, quintuplets, each restarting on its group.
    const steps = snapLineSteps({ ...snapLines, lines: within(snapLines.lines, from * TICKS_PER_STEP, to * TICKS_PER_STEP) }, stepPx, drawn, STEP_LINES_MIN_PX);
    const dx = gridBox.x;
    // Each marker's line down the grid, where its flag stands on the marker row:
    // a movement strong, a section fainter, so a long score's form reads across every part.
    const marked = markers.filter((m) => markerStep(m) >= from - 1e-9 && markerStep(m) <= to + 1e-9);
    const sectionSteps = marked.filter((m) => m.kind === 'section').map(markerStep);
    const movementSteps = marked.filter((m) => m.kind === 'movement').map(markerStep);
    return {
      step: linesPath(steps, stepPx, 0, gridHeight, dx),
      beat: linesPath(beat, stepPx, 0, gridHeight, dx),
      group: linesPath(group, stepPx, 0, gridHeight, dx),
      laneBar: laneBar.length ? linesPath(laneBar, stepPx, 0, gridHeight, dx) : '',
      bar: linesPath(bars, stepPx, 0, gridHeight, dx),
      section: sectionSteps.length ? linesPath(sectionSteps, stepPx, 0, gridHeight, dx) : '',
      movement: movementSteps.length ? linesPath(movementSteps, stepPx, 0, gridHeight, dx) : '',
    };
  }, [tiers, laneTiers, snapLines, stepPx, gridHeight, view, gridBox.x, markers]);

  // The notes in looping lanes, kept as the same array while none of them
  // changes, so an edit in a lane that does not loop leaves the repeats alone.
  const loopNotesRef = useRef<PianoNote[]>([]);
  const loopNotes = useMemo(() => {
    const looping = new Set(lanes.filter((l) => laneLoop(l, totalSteps)).map((l) => l.id));
    const next = looping.size ? notes.filter((n) => n.lane !== undefined && looping.has(n.lane)) : [];
    const prev = loopNotesRef.current;
    if (prev.length === next.length && prev.every((n, i) => n === next[i])) return prev;
    loopNotesRef.current = next;
    return next;
  }, [notes, lanes, totalSteps]);

  // A looping lane's repeats: its notes unrolled, less each copy that sits at
  // its note's stored step. A note placed past its lane's first cycle wraps, so
  // its first copy is a repeat too. A copy after the first has the id `<id>~<k>`.
  const repeats = useMemo(() => {
    const byId = new Map(loopNotes.map((n) => [n.id, n]));
    return unrollLanes(loopNotes, lanes, totalSteps).filter((u) => {
      const src = byId.get(u.id) ?? byId.get(u.id.slice(0, u.id.lastIndexOf('~')));
      return !(src && Math.abs(src.step - u.step) < 1e-6);
    });
  }, [loopNotes, lanes, totalSteps]);

  // Where each looping lane's first cycle ends: its loop from step 0, or from
  // its span's first step when it plays in part of the roll only (at the
  // span's end when the span is shorter than the cycle).
  const loopEnds = useMemo(
    () => lanes.flatMap((l) => {
      const loop = laneLoop(l, totalSteps);
      return loop ? [{ id: l.id, name: l.name, cycleSteps: loop.cycle, at: Math.min(loop.origin + loop.cycle, loop.end), span: l.span ?? null }] : [];
    }),
    [lanes, totalSteps],
  );

  const laneOf = useMemo(() => {
    const forms = new Map<number, { form: LaneForm; name: string }>();
    let rank = 0;
    for (const l of lanes) {
      if (l.id === activeLane) forms.set(l.id, { form: SOLID_FORM, name: l.name });
      else {
        forms.set(l.id, { form: LANE_FORMS[rank % LANE_FORMS.length], name: l.name });
        rank += 1;
      }
    }
    // A note whose lane is gone plays as lane 0 (unrollLanes passes it through), so it draws as lane 0.
    return (lane: number | undefined) => forms.get(lane ?? 0) ?? forms.get(0) ?? { form: SOLID_FORM, name: 'A' };
  }, [lanes, activeLane]);
  // The same looks as the canvas draws them (lib/rollCanvas ROLL_LOOKS): 0 for
  // the active lane, then 1 to 4 by rank among the others, as laneOf ranks them.
  const lookIndexOf = useMemo(() => {
    const looks = new Map<number, number>();
    let rank = 0;
    for (const l of lanes) {
      if (l.id === activeLane) looks.set(l.id, 0);
      else {
        looks.set(l.id, 1 + (rank % (ROLL_LOOKS.length - 1)));
        rank += 1;
      }
    }
    return (lane: number | undefined) => looks.get(lane ?? 0) ?? looks.get(0) ?? 0;
  }, [lanes, activeLane]);

  // The note layer's indexes (lib/noteIndex), one per note list and shared by
  // every reader of the list: the active part's notes (drawn, hit tested, and
  // the velocity lane's bars), the lane repeats and each other part's notes.
  const noteIdx = useMemo(() => noteIndexOf(notes), [notes]);
  const repeatIdx = useMemo(() => (repeats.length ? noteIndexOf(repeats) : null), [repeats]);
  const ghostLayers = useMemo(
    () => ghostParts.map((p) => ({ id: p.id, color: p.color, sounding: audibleParts.has(p.id), index: noteIndexOf(p.notes) })),
    [ghostParts, audibleParts],
  );
  const scene = useMemo(
    () => ({
      stepPx,
      noteHeight: NOTE_HEIGHT,
      highestNote,
      lowestNote,
      ghosts: ghostLayers,
      repeats: repeatIdx,
      notes: noteIdx,
      lookOfLane: lookIndexOf,
      selected: selectedIds,
    }),
    [stepPx, highestNote, lowestNote, ghostLayers, repeatIdx, noteIdx, lookIndexOf, selectedIds],
  );
  const canvasRef = useRef<RollNotesCanvasHandle | null>(null);

  // Map y-pixel inside the grid to a MIDI note. Top row = highestNote.
  const yToNote = useCallback(
    (y: number): number => highestNote - Math.floor(y / NOTE_HEIGHT),
    [highestNote],
  );
  /** What lib/rollSelection needs to turn grid pixels into steps and notes. */
  const geo: RollGeometry = useMemo(
    () => ({ stepPx, noteHeight: NOTE_HEIGHT, highestNote }),
    [stepPx, highestNote],
  );
  /**
   * A client point in grid px. The shell scales the DAW with CSS zoom (1.1 at
   * 1920x1080), and a client point and the grid's rect are viewport px while
   * the notes are drawn in grid px, so the offset is divided by the zoom
   * (lib/canvasScale clientToLocal): a click lands on the note drawn under it.
   */
  const gridPointOf = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = gridRef.current;
    return el ? clientToLocal(el, clientX, clientY) : null;
  };
  /** The active part's note under a client point, and whether the point is on its resize edge (lib/rollCanvas hitNote). */
  const hitAtClient = (clientX: number, clientY: number): { note: PianoNote; edge: boolean } | null => {
    const p = gridPointOf(clientX, clientY);
    if (!p || p.y >= gridHeight) return null;
    return hitNote(noteIdx, p.x, p.y, geo, lookIndexOf, NOTE_EDGE_PX);
  };
  /** The note's tooltip: pitch, step, length and lane. */
  const noteTitle = (n: PianoNote): string =>
    `${noteLabel(n.note)} · step ${stepText(n.step + 1)} · ${stepText(n.length)} step${n.length === 1 ? '' : 's'}${lanes.length > 1 ? ` · lane ${laneOf(n.lane).name}` : ''}`;
  // The note under a resting pointer: brightened on the canvas, its details in
  // the grid's tooltip, and the resize cursor over its right edge.
  const hoverRef = useRef<string | null>(null);
  const setHover = (hit: { note: PianoNote; edge: boolean } | null) => {
    const grid = gridRef.current;
    if (grid) {
      grid.style.cursor = hit?.edge ? 'ew-resize' : '';
      const title = hit ? noteTitle(hit.note) : '';
      if (grid.title !== title) grid.title = title;
    }
    const id = hit?.note.id ?? null;
    if (hoverRef.current === id) return;
    hoverRef.current = id;
    canvasRef.current?.setHover(id);
  };

  /**
   * Which selection a modifier click means. Shift adds, Ctrl/Cmd toggles, and a
   * plain click is handled by the caller (select, or delete the one selected
   * note). Returns true when it handled the click.
   */
  const modifierSelect = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, id: string): boolean => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelection(id);
      return true;
    }
    if (e.shiftKey) {
      addToSelection([id]);
      return true;
    }
    return false;
  };

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The click that ends a marquee drag is not a click on a cell.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // A press that began on a note ends on that note, wherever the pointer is
    // let go: a resize released past the note's snapped end, or a click that
    // wobbled across a row line, selects the pressed note (or deletes it, as a
    // second click does) and never adds one. The grid keeps the pointer from the
    // press, so the click reaches it here from anywhere.
    const press = pressRef.current;
    if (press) {
      pressRef.current = null;
      const pressed = usePianoRollStore.getState().notes.find((n) => n.id === press.id);
      if (!pressed || modifierSelect(e, pressed.id)) return;
      if (press.wasSelected) removeNote(pressed.id);
      else setSelectedNote(pressed.id);
      return;
    }
    const { x, y } = clientToLocal(e.currentTarget as HTMLDivElement, e.clientX, e.clientY);
    if (x < 0 || y < 0) return;
    const targetNote = yToNote(y);
    // A click with no press before it (nothing pressed on the grid first): on
    // an existing note it selects it, or removes it when it is the one selected
    // note. Only stored notes count; a lane repeat is drawn, not stored, and
    // clicks pass through it. The note is found in the interval index where the
    // canvas draws it (lib/rollCanvas).
    const hit = hitNote(noteIdx, x, y, geo, lookIndexOf, NOTE_EDGE_PX)?.note;
    if (hit) {
      if (modifierSelect(e, hit.id)) return;
      if (selectedIds.size === 1 && selectedIds.has(hit.id)) removeNote(hit.id);
      else setSelectedNote(hit.id);
      return;
    }
    const placed = clickPlacement(snapLines, x, stepPx);
    if (!placed) return;
    insertStepRef.current = placed.tick / TICKS_PER_STEP;
    // Otherwise add a note on the snap cell under the pointer: one cell long,
    // or an 8th on the 1/16 grid, as the roll has always drawn.
    addNote({
      note: targetNote,
      step: placed.tick / TICKS_PER_STEP,
      length: placed.ticks / TICKS_PER_STEP,
      tick: placed.tick,
      ticks: placed.ticks,
      velocity: 96,
    });
    auditionRollVoice(targetNote, 96, getEngineCtx().currentTime + 0.02, 0.2, masterRef.current, currentRollVoice());
  };

  // A press on a note selects it. The click that ends the press deletes the
  // note only when it was the ONLY selected note before the press and the press
  // did not resize it, so the first click selects and a second click deletes —
  // and a click inside a multi-selection collapses the selection onto that note
  // rather than deleting a note the user had merely swept over.
  const pressRef = useRef<{ id: string; wasSelected: boolean } | null>(null);
  /** True for the click that ends a marquee drag, which must not add or select. */
  const suppressClickRef = useRef(false);
  /**
   * A marquee in flight: where it started (in grid space and in client px, so
   * the "is this a drag yet" test is in pixels at any zoom), whether Shift was
   * held at the press, and the rectangle the last move produced.
   */
  const marqueeRef = useRef<
    { origin: RollPoint; startX: number; startY: number; shift: boolean; rect: MarqueeRect | null } | null
  >(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  // Where a paste lands: the playhead while the roll is sounding, and otherwise
  // the last step clicked (an empty cell, the step a clicked note starts on, or
  // a step clicked on the ruler, which moves the playhead there too), which is
  // the roll's own "last click position". A clip load replaces every note, so
  // the point goes back to the top with them — the step it held belonged to the
  // roll that just left.
  const insertStepRef = useRef(0);
  useEffect(() => { insertStepRef.current = 0; }, [editingClipId, activeTrackId]);
  const onRulerSeek = useCallback((step: number) => { insertStepRef.current = step; }, []);
  // A marker's jump (its flag, or the MARKS list): the playhead moves there, a
  // paste lands there, and the grid scrolls so the marker sits an eighth of the
  // view in from the left when it is out of view.
  const jumpToStep = useCallback((step: number) => {
    const s = usePianoRollStore.getState();
    s.seek(step);
    const at = usePianoRollStore.getState().currentStep;
    insertStepRef.current = at;
    const el = gridScrollRef.current;
    if (!el) return;
    const x = at * stepPx;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - el.clientWidth / 8);
  }, [stepPx]);
  // Drag a note's right edge to change its length on the snap grid. `zoom` is
  // the shell's CSS zoom at the press: a client-px travel over it is grid px.
  const resizeRef = useRef<{ id: string; startX: number; zoom: number; tick: number; initialTicks: number } | null>(null);
  /**
   * A press on a note body: where it started, and once the pointer has moved
   * NOTE_DRAG_MIN_PX, every selected note's start and pitch at that moment.
   * Each move places the notes from those origins (lib/rollSnap moveBlock).
   */
  const dragRef = useRef<{ id: string; startX: number; startY: number; zoom: number; origins: NoteOrigin[] | null } | null>(null);
  const onNotePointerDown = (e: React.PointerEvent, note: PianoNote, edge: 'right' | 'body') => {
    e.stopPropagation();
    // A press on a note is never a marquee.
    marqueeRef.current = null;
    const picked = usePianoRollStore.getState().selectedIds;
    pressRef.current = { id: note.id, wasSelected: picked.size === 1 && picked.has(note.id) };
    insertStepRef.current = note.step;
    // A modifier click is decided by the click handler, so the press leaves the
    // selection alone; and a press on a note already in the selection keeps the
    // whole selection, so grabbing one bar of a chord does not collapse it.
    if (!(e.shiftKey || e.ctrlKey || e.metaKey) && !picked.has(note.id)) setSelectedNote(note.id);
    const zoom = effectiveZoom(gridRef.current);
    if (edge === 'right') {
      const tick = note.tick ?? Math.round(note.step * TICKS_PER_STEP);
      resizeRef.current = { id: note.id, startX: e.clientX, zoom, tick, initialTicks: note.ticks ?? Math.round(note.length * TICKS_PER_STEP) };
      // The whole resize is one undo step, however slowly it crosses the lines.
      beginRollGesture();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // The whole drag is one undo step, however slowly it crosses the lines.
    beginRollGesture();
    dragRef.current = { id: note.id, startX: e.clientX, startY: e.clientY, zoom, origins: null };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  /**
   * A press on a note (found in the interval index where the canvas draws it)
   * selects, drags or, on its right edge, resizes it; a press on empty grid
   * opens a marquee, confirmed only on the move.
   */
  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A press that starts off every note clears a note press that ended without a click.
    pressRef.current = null;
    // A fresh press: whatever the last drag armed, it can only ever swallow its
    // OWN click, never a later one.
    suppressClickRef.current = false;
    const hit = hitAtClient(e.clientX, e.clientY);
    if (hit) {
      onNotePointerDown(e, hit.note, hit.edge ? 'right' : 'body');
      return;
    }
    if (e.button !== 0) {
      marqueeRef.current = null;
      return;
    }
    const p = gridPointOf(e.clientX, e.clientY);
    if (!p) return;
    marqueeRef.current = {
      origin: gridPointAt(p.x, p.y, geo),
      startX: e.clientX,
      startY: e.clientY,
      shift: e.shiftKey,
      rect: null,
    };
    // Capture on the grid so a marquee dragged outside the scroll box still ends here.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // A resting pointer (no drag, resize or marquee) shows the note under it.
    if (!resizeRef.current && !dragRef.current && !marqueeRef.current) {
      setHover(hitAtClient(e.clientX, e.clientY));
      return;
    }
    const op = resizeRef.current;
    if (op) {
      // The pointer's travel in grid px (client px over the shell's CSS zoom).
      const dx = (e.clientX - op.startX) / op.zoom;
      // Under the drag threshold the press is still a click and the length stays.
      if (Math.abs(dx) < NOTE_DRAG_MIN_PX) return;
      if (pressRef.current?.id === op.id) pressRef.current.wasSelected = false;
      // The end lands on the nearest snap line, stopping one cell after the
      // start. A note already shorter than a cell, a 32nd on the 1/16 grid,
      // keeps its length until the drag makes it longer.
      const ticks = resizeTicks(snapLines, op.tick, op.initialTicks, dx, stepPx);
      const s = usePianoRollStore.getState();
      if (ticks !== s.notes.find((n) => n.id === op.id)?.ticks) s.setNoteTimes([{ id: op.id, ticks }]);
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      // The pointer's travel in grid px (client px over the shell's CSS zoom).
      const dx = (e.clientX - drag.startX) / drag.zoom;
      const dy = (e.clientY - drag.startY) / drag.zoom;
      if (!drag.origins) {
        if (Math.abs(dx) < NOTE_DRAG_MIN_PX && Math.abs(dy) < NOTE_DRAG_MIN_PX) return;
        const s = usePianoRollStore.getState();
        const moving = new Set([...s.selectedIds, drag.id]);
        drag.origins = s.notes
          .filter((n) => moving.has(n.id))
          .map((n) => ({ id: n.id, tick: n.tick ?? Math.round(n.step * TICKS_PER_STEP), note: n.note }));
        // A drag is never the second click that deletes the note.
        if (pressRef.current?.id === drag.id) pressRef.current.wasSelected = false;
      }
      const s = usePianoRollStore.getState();
      s.setNoteTimes(moveBlock(snapLines, drag.origins, drag.id, dx, dy, stepPx, NOTE_HEIGHT, {
        endTick: snapLines.end,
        lowestNote: s.lowestNote,
        highestNote: s.highestNote,
      }));
      return;
    }
    const mq = marqueeRef.current;
    if (!mq) return;
    // Until the pointer has travelled far enough this is still a click, which
    // is how a click on an empty cell keeps adding a note.
    if (!mq.rect && Math.abs(e.clientX - mq.startX) < MARQUEE_MIN_PX && Math.abs(e.clientY - mq.startY) < MARQUEE_MIN_PX) return;
    const p = gridPointOf(e.clientX, e.clientY);
    if (!p) return;
    const next = marqueeRect(mq.origin, gridPointAt(p.x, p.y, geo));
    mq.rect = next;
    setMarquee(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      resizeRef.current = null;
      endRollGesture();
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) {
      endRollGesture();
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (drag.origins) {
        // The click that ends a drag neither selects nor deletes; the moved notes stay selected.
        suppressClickRef.current = true;
        const moved = usePianoRollStore.getState().notes.find((n) => n.id === drag.id);
        if (moved) insertStepRef.current = moved.step;
      }
      return;
    }
    const mq = marqueeRef.current;
    marqueeRef.current = null;
    if (!mq) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!mq.rect) return;
    setMarquee(null);
    // Shift extends what was already selected; a plain marquee replaces it,
    // and an empty one clears — a rubber band states the whole selection.
    const hits = notesInMarquee(usePianoRollStore.getState().notes, mq.rect);
    if (mq.shift) addToSelection(hits);
    else setSelection(hits);
    // The click that follows this release is the end of the drag, not a cell click.
    suppressClickRef.current = true;
  };

  /**
   * A drag that ends without a pointerup — a cancelled touch or pen gesture, or
   * a capture lost to another element — leaves nothing behind: no rubber band
   * on screen, no armed click suppression, and the selection untouched, because
   * a cancelled marquee never stated one.
   */
  const cancelMarquee = (e: React.PointerEvent) => {
    // A cancelled note drag or resize keeps the notes where the last move put
    // them, as the one undo step the gesture recorded.
    if (dragRef.current || resizeRef.current) endRollGesture();
    dragRef.current = null;
    resizeRef.current = null;
    if (!marqueeRef.current) return;
    marqueeRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setMarquee(null);
    suppressClickRef.current = false;
  };

  // Delete / Backspace removes the whole selection, in ONE write of `notes`
  // (so one undo step) whenever more than one note is going.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // A marker flag takes Delete for itself, and a key in a portalled card
      // (the MARKS list, a menu) is never a note edit.
      if (t?.closest?.('[data-roll-markers], [data-roll-harmony]') || inPortalledOverlay(e.target, rootRef.current)) return;
      // Only delete a note when the piano roll is the surface the user is on;
      // otherwise Delete in the EDIT timeline removed a clip AND a note. The
      // scope is the whole MIDI tab (MidiPanel), so a hidden roll (the ARP face
      // is showing) must not act on it.
      if (!ownsKey('piano-roll')) return;
      if (rootRef.current?.offsetParent === null) return;
      const s = usePianoRollStore.getState();
      if (s.selectedIds.size === 0) return;
      e.preventDefault();
      if (s.selectedIds.size === 1 && s.selectedNoteId) removeNote(s.selectedNoteId);
      else s.replaceAll(s.notes.filter((n) => !s.selectedIds.has(n.id)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeNote]);

  // The arrow keys nudge the selection: a step sideways, a semitone up or down,
  // and with Shift four steps or an octave. The whole selection moves by the
  // same amount (the store clamps the DELTA), so a chord keeps its shape.
  //
  // CAPTURE phase with stopImmediatePropagation, for the same reason the
  // clipboard keys below use it: `WaveformEditor` binds the arrows on `window`
  // in the bubble phase with no `ownsKey` gate, so one press would nudge a
  // roll note AND a timeline clip. Once the roll owns the key it swallows the
  // arrow whether or not it had anything to move. The bend, velocity and tempo
  // lanes and the ruler are excluded: each takes the arrows for itself (points,
  // bars, the playhead), and a window capture listener runs before their element
  // handlers can stop it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if (t?.closest('[data-bend-lane], [data-velocity-lane], [data-tempo-lane], [data-roll-ruler], [data-roll-markers], [data-roll-minimap], [data-roll-harmony], [data-figured-bass-lane]')) return;
      if (inPortalledOverlay(e.target, rootRef.current)) return;
      if (!ownsKey('piano-roll')) return;
      if (rootRef.current?.offsetParent === null) return; // roll hidden (ARP face showing)
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = usePianoRollStore.getState();
      if (s.selectedIds.size === 0) return;
      const coarse = e.shiftKey;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Sideways by snap cells, measured on the primary note, so a tuplet
        // figure steps along its own grid; the whole selection moves with it.
        const primary = s.notes.find((n) => n.id === s.selectedNoteId);
        if (!primary) return;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const dt = nudgeTicks(snapRef.current, primary.tick ?? Math.round(primary.step * TICKS_PER_STEP), dir, coarse ? 4 : 1);
        if (dt !== 0) s.nudgeSelected(dt / TICKS_PER_STEP, 0);
      } else if (e.key === 'ArrowUp') s.nudgeSelected(0, coarse ? 12 : 1);
      else s.nudgeSelected(0, coarse ? -12 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Undo / redo and the note clipboard. Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or
  // Ctrl+Y = redo, Ctrl/Cmd+C / X / V / D = copy / cut / paste / duplicate.
  // Registered on the CAPTURE phase so that when the roll owns the key it can
  // stopImmediatePropagation() before the EDIT timeline's own bubble-phase
  // window listener runs — otherwise one Ctrl+Z would step both the timeline's
  // history and the roll's, since both surfaces are mounted at once.
  //
  // Each clipboard edit is ONE write (replaceAll for a cut, appendNotes for a
  // paste or a duplicate), which is one undo step: the store's history
  // subscriber snapshots the pre-change document on the first change of a
  // burst, so a cut (copy + delete) and a paste each record exactly one step. A
  // paste that runs past the roll's end grows the roll in that same write.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y' && k !== 'a' && k !== 'c' && k !== 'x' && k !== 'v' && k !== 'd') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      // A portalled menu, listbox or dialog keeps its own Ctrl/Cmd+A and its
      // own clipboard keys, even while the pointer rests on the dock.
      if (inPortalledOverlay(e.target, rootRef.current)) return;
      if (!ownsKey('piano-roll')) return;
      if (rootRef.current?.offsetParent === null) return; // roll hidden (ARP face showing)
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
        return;
      }
      if (k === 'a') {
        // Select all the roll's notes, not the page's text, and not the EDIT
        // timeline's clips (its own Ctrl/Cmd+A runs on the bubble phase).
        e.preventDefault();
        e.stopImmediatePropagation();
        usePianoRollStore.getState().selectAll();
        return;
      }
      // The ONE escape from here on: a live text selection, which the browser
      // copies as text (the same test EDIT's own handler makes).
      if ((k === 'c' || k === 'x') && !(window.getSelection()?.isCollapsed ?? true)) return;
      // The roll owns the key, so it swallows it even when there is nothing to
      // copy or paste. EDIT's window listener runs on the bubble phase with no
      // ownsKey gate, so a c/x/v/d that fell through from here would cut, paste
      // or duplicate a CLIP while the user was working in the roll.
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = usePianoRollStore.getState();
      // The whole selection — the helpers have always taken a set of ids, so the
      // marquee needed no change here beyond handing them the real one.
      const picked = s.selectedIds;
      // The roll grows to hold a paste, up to its longest length.
      const range = { lowestNote: s.lowestNote, highestNote: s.highestNote, totalSteps: s.totalSteps, maxSteps: MAX_ROLL_STEPS };
      if (k === 'c' || k === 'x') {
        const payload = copyNotes(s.notes, picked);
        if (!payload) return; // nothing selected: the clipboard keeps what it had
        noteClipboard = payload;
        if (k === 'x') {
          const cut = new Set(payload.notes.map((n) => n.id));
          s.replaceAll(s.notes.filter((n) => !cut.has(n.id)));
        }
        return;
      }
      const wanted = k === 'v' ? (noteClipboard?.notes.length ?? 0) : picked.size;
      const added = k === 'v'
        ? (noteClipboard
          ? pasteNotes(noteClipboard, s.isPlaying ? floorLine(snapRef.current, s.currentStep * TICKS_PER_STEP) / TICKS_PER_STEP : insertStepRef.current, range)
          : [])
        : duplicateNotes(s.notes, picked, range);
      if (added.length < wanted) {
        const left = wanted - added.length;
        logWarn(
          'piano-roll',
          `${left} note${left === 1 ? '' : 's'} would start past step ${MAX_ROLL_STEPS}, the roll's longest length, and ${left === 1 ? 'was' : 'were'} left out`,
        );
      }
      if (added.length === 0) return;
      // The block that just landed IS the selection (appendNotes selects it), so
      // a repeated Ctrl/Cmd+D marches forward instead of stacking copies on the
      // original, and the earliest of them is the primary.
      s.appendNotes(added);
      // A paste moves the insertion point PAST the block it just wrote, so a
      // second Ctrl/Cmd+V lands after it instead of stacking an identical set in
      // place. A duplicate leaves the point on the copy it selected.
      insertStepRef.current = k === 'v'
        ? added.reduce((m, n) => Math.max(m, n.step + n.length), 0)
        : added[0].step;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo]);

  const handleGridScroll = () => {
    if (keyboardRowsRef.current && gridScrollRef.current) {
      keyboardRowsRef.current.scrollTop = gridScrollRef.current.scrollTop;
    }
  };

  const handleGridWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = gridScrollRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // The pointer in the scroll box's own px (the shell's CSS zoom taken out),
      // so the step under it stays under it at the new width.
      const pointerX = clientToLocal(el, e.clientX, e.clientY).x;
      const cursorX = pointerX + el.scrollLeft;
      const oldStepPx = stepPx;
      const nextStepPx = Math.max(STEP_PX_MIN, Math.min(STEP_PX_MAX_WHEEL, oldStepPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      onStepPxChange(nextStepPx);
      requestAnimationFrame(() => {
        el.scrollLeft = cursorX * (nextStepPx / oldStepPx) - pointerX;
      });
      return;
    }
    if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  };

  // Center the vertical scroll on the note content so it's visible in the tall
  // full-piano grid (~88 rows). Re-centers when the content pitch range changes
  // (a capture / import / clip load), not on edits within the current range.
  const contentLo = noteIdx.pitchRange?.low ?? 60;
  const contentHi = noteIdx.pitchRange?.high ?? 72;
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const midNote = (contentLo + contentHi) / 2;
    const midY = (highestNote - midNote) * NOTE_HEIGHT;
    // The middle of the rows in view, under the ruler. Until the grid is measured
    // (and in a DOM with no layout) its height is the window's, as the note canvas reads it.
    el.scrollTop = Math.max(0, midY - ((el.clientHeight || window.innerHeight) - coverPx) / 2);
    if (keyboardRowsRef.current) keyboardRowsRef.current.scrollTop = el.scrollTop;
    // Centred on content changes only: opening the harmony row does not scroll the grid.
  }, [contentLo, contentHi, highestNote]);

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-[#07050a] overflow-hidden relative">
      {/* Overview: every part over the whole roll; a click jumps the grid there. */}
      <RollMinimap scrollRef={gridScrollRef} stepPx={stepPx} noteHeight={NOTE_HEIGHT} headerPx={coverPx} />
      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Parts column: every part, its sound, mute and solo; the active part's settings. */}
        <RollTrackColumn />
        {/* Keyboard column */}
        <div className="shrink-0 overflow-hidden bg-[#0c0a12] border-r border-white/5" style={{ width: KEYBOARD_WIDTH }}>
          {/* Level with the harmony row: CHECK, the flag count, and hide. */}
          {showHarmony && (
            <div className="bg-black/40 border-b border-white/5" style={{ height: HARMONY_ROW_HEIGHT }}>
              <RollHarmonyCorner />
            </div>
          )}
          <div
            className="bg-black/40 border-b border-white/5 flex items-center justify-center"
            style={{ height: HEADER_HEIGHT }}
            title={ROLL_HELP}
          >
            <Info aria-hidden="true" className="w-3 h-3 et-ink-3" />
            <span className="sr-only">{ROLL_HELP}</span>
          </div>
          {/* Level with the marker row: MARKS opens the jump list. */}
          <div className="bg-black/40 border-b border-white/5" style={{ height: MARKER_ROW_HEIGHT }}>
            <RollMarkerJump onJump={jumpToStep} />
          </div>
          <div ref={keyboardRowsRef} className="overflow-hidden" style={{ height: `calc(100% - ${coverPx}px)` }}>
            <div style={{ height: gridHeight }}>
              <KeyboardKeys lowestNote={lowestNote} highestNote={highestNote} masterRef={masterRef} />
            </div>
          </div>
        </div>

        {/* Grid column */}
        <div
          ref={gridScrollRef}
          className="flex-1 overflow-auto"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelMarquee}
          onLostPointerCapture={cancelMarquee}
          onScroll={handleGridScroll}
          onWheel={handleGridWheel}
        >
          {/* Harmony row over the ruler: voice-leading flags and roman figures. */}
          {showHarmony && <RollHarmonyRow stepPx={stepPx} totalSteps={totalSteps} win={view} top={0} />}
          {/* Ruler */}
          <RollSeek
            stepPx={stepPx}
            totalSteps={totalSteps}
            meterMap={meterMap}
            pickupSteps={pickupSteps}
            onSeek={onRulerSeek}
            top={harmonyPx}
          >
            <RollRuler spans={barSpans} lhl={barLhl} tiers={tiers} stepPx={stepPx} totalSteps={totalSteps} win={view} />
          </RollSeek>
          {/* Named markers (sections, movements), sticking under the ruler. */}
          <RollMarkerRow
            top={HEADER_HEIGHT + harmonyPx}
            stepPx={stepPx}
            totalSteps={totalSteps}
            meterMap={meterMap}
            pickupSteps={pickupSteps}
            onJump={jumpToStep}
          />

          <div
            ref={gridRef}
            onPointerDown={onGridPointerDown}
            onClick={handleGridClick}
            onContextMenu={(e) => {
              const hit = hitAtClient(e.clientX, e.clientY);
              if (!hit) return;
              e.stopPropagation();
              // Right-click acts on this note, so it takes the selection unless it is already part of one.
              if (!usePianoRollStore.getState().selectedIds.has(hit.note.id)) setSelectedNote(hit.note.id);
              noteMenu.open(e, hit.note);
            }}
            onPointerLeave={() => setHover(null)}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            <RowBackgrounds lowestNote={lowestNote} highestNote={highestNote} />
            {/* Vertical lines: bar lines strongest, then group starts, beats and
                (when a step is wide enough) steps. An active lane with its own
                time adds its bar lines in the accent. */}
            <svg
              aria-hidden="true"
              focusable="false"
              className="absolute top-0 pointer-events-none"
              style={{ left: gridBox.x }}
              width={gridBox.width}
              height={gridHeight}
              shapeRendering="crispEdges"
            >
              {gridPaths.step && <path d={gridPaths.step} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.03)]" />}
              {gridPaths.beat && <path d={gridPaths.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.06)]" />}
              {gridPaths.group && <path d={gridPaths.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.12)]" />}
              {gridPaths.laneBar && <path d={gridPaths.laneBar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-accent)/0.45)]" />}
              <path d={gridPaths.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
              {gridPaths.section && <path data-roll-marker-lines="section" d={gridPaths.section} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-accent)/0.55)]" />}
              {gridPaths.movement && <path data-roll-marker-lines="movement" d={gridPaths.movement} fill="none" strokeWidth={2} className="stroke-[rgb(var(--et-accent)/0.9)]" />}
            </svg>
            {/* Recorded-region highlight: marks the last live take without
                shrinking the grid (the rest of the 256 stays empty). */}
            {recordedRange && recordedRange.endStep > recordedRange.startStep && (
              <div
                className="absolute top-0 bottom-0 bg-[rgb(var(--et-accent)/0.08)] border-x border-[rgb(var(--et-accent)/0.4)] pointer-events-none"
                style={{
                  left: recordedRange.startStep * stepPx,
                  width: (recordedRange.endStep - recordedRange.startStep) * stepPx,
                }}
              />
            )}
            {/* Loop ends: a dashed line where each looping lane starts over. The
                tag, the lane's swatch and its cycle in steps, sticks under the
                ruler while the grid scrolls and sits between neighbouring loop
                lines: right of its line, or left of it when the next line is too
                close on the right and the left has room. Each lane's tag sits a
                row lower so tags of nearby loops never overlap. Its title and
                accessible name say it in words. */}
            {loopEnds.map((l, i) => {
              const { form } = laneOf(l.id);
              const name = `Lane ${l.name} loops every ${l.cycleSteps} steps${l.span ? ` in bars ${laneSpanLabel(meterMap, l.span, pickupSteps)}` : ''}`;
              const tagPx = 18 + 7.5 * String(l.cycleSteps).length;
              const others = loopEnds.map((o) => o.at);
              const roomRight = (Math.min(totalSteps, ...others.filter((c) => c > l.at)) - l.at) * stepPx;
              const roomLeft = (l.at - Math.max(0, ...others.filter((c) => c < l.at))) * stepPx;
              const onLeft = roomRight < tagPx && roomLeft >= tagPx;
              return (
                <div
                  key={l.id}
                  className="absolute top-0 bottom-0 w-0 border-l border-dashed border-[rgb(var(--et-ink)/0.5)] z-15 pointer-events-none"
                  style={{ left: l.at * stepPx }}
                >
                  <span
                    role="img"
                    aria-label={name}
                    title={name}
                    data-loop-tag="1"
                    className={`sticky flex w-max items-center gap-0.5 ${onLeft ? '-ml-0.5 -translate-x-full' : 'ml-0.5'} px-0.5 py-0.5 rounded-xs bg-[#0a080f] text-[12px] leading-none font-bold et-ink tabular-nums whitespace-nowrap pointer-events-auto`}
                    style={{ top: coverPx + 4 + i * 18, marginTop: 4 + i * 18 }}
                  >
                    <span className={`w-2 h-2 rounded-xs border ${form.fill} ${form.edge}`} style={form.style} />
                    {l.cycleSteps}
                  </span>
                </div>
              );
            })}
            <RollPlayhead stepPx={stepPx} totalSteps={totalSteps} />
            {/* The note layer: every other part's notes (ghosts), the lane
                repeats and this part's notes on one canvas the size of the
                view (RollNotesCanvas), culled in time and pitch. */}
            <RollNotesCanvas
              ref={canvasRef}
              scrollRef={gridScrollRef}
              scene={scene}
              width={gridWidth}
              height={gridHeight}
              headerPx={coverPx}
            />
            <NoteFocusLayer
              notes={notes}
              noteIdx={noteIdx}
              geo={geo}
              lookIndexOf={lookIndexOf}
              laneName={(lane) => laneOf(lane).name}
              laneCount={lanes.length}
              partName={partName}
              scrollRef={gridScrollRef}
              onMenu={(n, x, y) => noteMenu.open(new MouseEvent('contextmenu', { clientX: x, clientY: y }), n)}
              menuNoteId={noteMenu.payload?.id ?? null}
            />
            {/* The marquee itself: drawn above the notes, never in the way of
                the pointer, and gone the moment the drag ends. */}
            {marquee && (
              <div
                aria-hidden="true"
                className="absolute z-20 border border-[rgb(var(--et-ink)/0.8)] bg-[rgb(var(--et-accent)/0.14)] pointer-events-none"
                style={marqueeBox(marquee, geo)}
              />
            )}
          </div>

          {/* The velocity, bend and tempo lanes, inside the grid's scroll box so
              they keep the grid's x scale and scroll with it: a bar stays under
              its note, a point under the note it bends, and a tempo change over
              its bar line, at every zoom and every scroll position. */}
          <VelocityLane stepPx={stepPx} totalSteps={totalSteps} win={view} />
          {showFiguredBass && <FiguredBassLane stepPx={stepPx} totalSteps={totalSteps} win={view} />}
          {showBend && <BendLane stepPx={stepPx} totalSteps={totalSteps} />}
          {showCc && <CcLane stepPx={stepPx} totalSteps={totalSteps} />}
          {showArticulations && <ArticulationLane stepPx={stepPx} totalSteps={totalSteps} />}
          {showTempo && <TempoLane stepPx={stepPx} totalSteps={totalSteps} />}
        </div>
      </div>

      {/* Right-click menu for a single note. */}
      {(() => {
        const n = noteMenu.payload;
        if (!n) return null;
        const clampVel = (v: number) => Math.max(1, Math.min(127, v));
        // Lengthen, Shorten and the nudges move to the snap grid's neighbouring
        // lines, measured from the note's bar or group (lib/rollSnap).
        const timing = { tick: n.tick ?? Math.round(n.step * TICKS_PER_STEP), ticks: n.ticks ?? Math.round(n.length * TICKS_PER_STEP) };
        const snapWord = rollSnapDef(snap).label;
        const longer = lengthenTicks(snapLines, timing);
        const shorter = shortenTicks(snapLines, timing);
        const left = menuNudgeTick(snapLines, timing.tick, -1);
        const right = menuNudgeTick(snapLines, timing.tick, 1);
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Duplicate (after)',
            hint: 'step+len',
            onSelect: () => {
              // The copy stays in the source note's lane, not the active one.
              addNote({ note: n.note, step: n.step + n.length, length: n.length, velocity: n.velocity, lane: n.lane ?? 0 });
            },
          },
          {
            type: 'item',
            label: 'Velocity +10',
            hint: `${n.velocity}`,
            disabled: n.velocity >= 127,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity + 10) }),
          },
          {
            type: 'item',
            label: 'Velocity −10',
            hint: `${n.velocity}`,
            disabled: n.velocity <= 1,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity - 10) }),
          },
          {
            type: 'item',
            label: `Lengthen (+${snapWord})`,
            hint: 'to the next line',
            disabled: longer === null,
            onSelect: () => longer !== null && updateNote(n.id, { ticks: longer }),
          },
          {
            type: 'item',
            label: `Shorten (−${snapWord})`,
            hint: 'to the line before',
            disabled: shorter === null,
            onSelect: () => shorter !== null && updateNote(n.id, { ticks: shorter }),
          },
          {
            type: 'item',
            label: 'Nudge left',
            hint: snapWord,
            disabled: left === null,
            onSelect: () => left !== null && updateNote(n.id, { tick: left }),
          },
          {
            type: 'item',
            label: 'Nudge right',
            hint: snapWord,
            disabled: right === null,
            onSelect: () => right !== null && updateNote(n.id, { tick: right }),
          },
          { type: 'separator' },
          // The motif transforms, on the whole selection (the note right-clicked is in it).
          ...rollTransformMenuItems(selectedIds.size),
          { type: 'separator' },
          { type: 'header', label: 'Compose' },
          {
            type: 'item',
            label: 'Check voice leading',
            icon: <ListChecks className="w-3 h-3" />,
            title: 'Check the parts for parallel fifths and octaves, crossings, spacing, range and unresolved tendency tones; the flags show in the harmony row',
            onSelect: () => void runRollVoiceLeadingCheck(),
          },
          {
            type: 'item',
            label: showHarmony ? 'Hide the harmony row' : 'Show the harmony row',
            onSelect: () => usePianoRollStore.getState().setShowHarmony(!showHarmony),
          },
          {
            type: 'item',
            label: showFiguredBass ? 'Hide the figured bass lane' : 'Show the figured bass lane',
            onSelect: () => usePianoRollStore.getState().setShowFiguredBass(!showFiguredBass),
          },
          {
            type: 'item',
            label: cantusHere ? `Unmark ${partName} as the cantus firmus` : `Mark ${partName} as the cantus firmus`,
            title: 'Species counterpoint is written against the cantus firmus, and a species answer writes its cantus back into this part',
            onSelect: () => usePianoRollStore.getState().setCantusFirmus(cantusHere ? null : activeTrackId),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: clearsControls ? 'Clear all notes and controllers' : 'Clear all notes',
            icon: <Trash2 className="w-3 h-3" />,
            hint: `${notes.length}`,
            onSelect: clear,
          },
          {
            type: 'item',
            label: 'Delete note',
            hint: 'Del',
            danger: true,
            onSelect: () => removeNote(n.id),
          },
        ];
        return (
          <ContextMenu
            position={noteMenu.position}
            onClose={noteMenu.close}
            items={items}
            title={`${noteLabel(n.note)} · step ${stepText(n.step + 1)}`}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};
