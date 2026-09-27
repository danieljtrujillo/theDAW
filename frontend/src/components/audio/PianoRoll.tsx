import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Info, Minus, Plus, Save, Scissors, Trash2, Unlink, Waves, X } from 'lucide-react';
import { DEFAULT_GROOVE_ID, DEFAULT_LANES, usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo } from '../../state/logStore';
import type { Meter } from '../../lib/colony';
import {
  barAt,
  bars as meterBars,
  gridLines,
  meterEquals,
  normalizeMeterMap,
  roundUpToBar,
  unrollLanes,
  type BarSpan,
  type PolyLane,
} from '../../lib/meterMap';
import {
  BEND_CENTER,
  DEFAULT_BEND_RANGE,
  liveLaneChannels,
  loopedBendAutomation,
  loopedWheelEvents,
  playedRollBends,
  playingLane,
  type LaneBend,
  type PlayedBend,
} from '../../lib/pitchBend';
import { BEND_TAIL_SEC, type VoiceBend } from '../../lib/pitchBendVoice';
import { midiFileToRoll, rollToMidiFile } from '../../lib/rollMidi';
import { playedRollNotes, quantizeRollClip } from '../../lib/rollClip';
import { copyNotes, duplicateNotes, pasteNotes, type NoteClipboardPayload } from '../../lib/noteClipboard';
import {
  MARQUEE_MIN_PX,
  VELOCITY_LANE_HEIGHT,
  VELOCITY_MAX,
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
  swingToGroove,
  type GrooveTemplate,
} from '../../lib/grooveTemplate';
import { buildGrooveFromMidiBytes } from '../../lib/grooveExtract';
import { BendLane } from './BendLane';
import { MidiMapper } from './MidiMapper';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { renderStepNotesToBlob } from '../../lib/midiSynth';
import { triggerPianoNote } from '../../lib/pianoTrigger';
import { getGlobalVoice, sfPitchWheel, sfPitchWheelRange } from '../../lib/soundfontEngine';
import { rollVoice, type ClipVoice } from '../../lib/clipProgram';
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
const KEYBOARD_WIDTH = 64;
const STEP_PX_MIN = 6;
const STEP_PX_MAX_BUTTON = 48;
const STEP_PX_MAX_WHEEL = 64;
/** Step lines draw only from this step width up; below it the bar, group and beat tiers carry the grid. */
const STEP_LINES_MIN_PX = 10;
/** The pickup cell prints its legend from this width (px) up; a narrower one keeps it in its title. */
const PICKUP_LEGEND_MIN_PX = 38;
/** Notes and lane repeats draw this far (px) past each side of the view, so a scroll redraws them only after crossing it. */
const WINDOW_OVERSCAN_PX = 960;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** The ruler's meter text: "7/8 3+2+2", "5/4 2+3", "4/4". */
const meterLabel = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` ${m.groups.join('+')}` : ''}`;

/** One SVG path of vertical lines at `steps`, from y0 to y1, on whole pixels. */
const linesPath = (steps: readonly number[], stepPx: number, y0: number, y1: number): string => {
  let d = '';
  for (const s of steps) d += `M${Math.round(s * stepPx) + 0.5} ${y0}V${y1}`;
  return d;
};

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
  'Click empty cell = add · Click note = select / second click on the only selected note = delete · Drag empty grid = marquee (Shift adds to the selection) · Shift-click note = add to the selection · Ctrl/Cmd-click note = in or out · Ctrl/Cmd+A = select all · Arrows nudge the selection (Shift = 4 steps / an octave) · Drag right edge = resize · Delete key removes the selection · Ctrl/Cmd+C = copy · Ctrl/Cmd+X = cut · Ctrl/Cmd+V = paste at the insertion point (the playhead while playing, otherwise the last step you clicked) · Ctrl/Cmd+D = duplicate after the selection · Velocity lane under the grid: drag a bar, or sweep across bars to draw · Right-click note for actions · Ctrl+wheel = zoom · Shift+wheel = scroll';

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
  { key: 'bpm' as const,        label: 'BPM',         min: 40,  max: 240, autoCc: 14, integer: true },
  { key: 'totalSteps' as const, label: 'Total Steps', min: 16,  max: 256, autoCc: 15, integer: true },
];

/** The voice the roll plays with now: its linked EDIT clip's, else its own
 *  program, else the global picker's (lib/clipProgram rollVoice). */
const currentRollVoice = (): ClipVoice => {
  const { clips, tracks } = useEditorStore.getState();
  const { editingClipId, voiceProgram } = usePianoRollStore.getState();
  return rollVoice(editingClipId, clips, tracks, getGlobalVoice(), voiceProgram);
};

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
  const setCurrentStep = usePianoRollStore((s) => s.setCurrentStep);
  const masterRef = useMasterGainRef();
  const playTimerRef = useRef<number | null>(null);

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);

  // Time-based lookahead scheduler: notes fire at their exact time
  // (step * stepSec), so FRACTIONAL step positions (32nd/64th notes and
  // micro-timing offsets) play — not just integer 16ths. Loops seamlessly by
  // scheduling each note's next occurrence every `total` steps. It resumes from
  // the store's current step, which every tick writes. It plays the lanes
  // unrolled. Each tick reads the notes, lanes, length, BPM and bends from the
  // store, so an edit while playing (a note, a meter, a lane's loop, a bend)
  // changes what plays next without a restart, and a step already scheduled is
  // never scheduled again.
  //
  // Pitch bend: a built-in voice follows its lane's curve through automation
  // scheduled with the note (lib/pitchBendVoice). A soundfont wheel bends a
  // whole channel, so each bent lane plays on its own channel and each tick
  // sends that channel's wheel messages for the window it schedules notes in.
  // The roll's soundfont channels count down from 14 (lib/pitchBend
  // liveLaneChannels), clear of EDIT's live MIDI and the arpeggiator.
  useEffect(() => {
    if (!isPlaying) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const lookahead = 0.12; // seconds scheduled ahead each tick
    const startStep = usePianoRollStore.getState().currentStep;
    // Absolute step `clock.step` sounds at `clock.time`; a tempo change re-anchors the clock at the cursor.
    const clock = { step: startStep, time: ctx.currentTime + 0.06, stepSec: 0 };
    // Absolute step s is roll step (s - lap.base) mod lap.total; a length change re-anchors the lap at the cursor.
    const lap = { base: 0, total: 0 };
    let cursor = startStep - 1e-4; // absolute step scheduled up to (inclusive)
    // Unroll once per note, lane, length or bend edit, not once per tick.
    let source: { notes: PianoNote[]; lanes: PolyLane[]; total: number; bends: LaneBend[] } | null = null;
    let played: PianoNote[] = [];
    let bent = new Map<number, PlayedBend>();
    let channels = new Map<number, number>();
    // Soundfont channels this playback has bent, with the range last sent, and the latest wheel message time.
    const wheelRanges = new Map<number, number>();
    let lastWheelTime = 0;
    // The next tick first sends each bent channel where its curve is: at the start, and after a bend, lane or length edit.
    let wheelFresh = true;

    /** A channel's wheel back at the centre and the default range, after every message already sent to it. */
    const releaseWheel = (ch: number) => {
      const at = Math.max(ctx.currentTime, lastWheelTime) + 0.001;
      sfPitchWheel(ch, BEND_CENTER, at);
      sfPitchWheelRange(ch, DEFAULT_BEND_RANGE, at);
      wheelRanges.delete(ch);
    };

    const tick = () => {
      const now = ctx.currentTime;
      const { notes, lanes, totalSteps: steps, bpm: tempo, bends } = usePianoRollStore.getState();
      const total = Math.max(1, steps);
      const stepSec = 60 / Math.max(40, tempo) / 4;
      if (clock.stepSec === 0) clock.stepSec = stepSec;
      else if (stepSec !== clock.stepSec) {
        clock.time += (cursor - clock.step) * clock.stepSec;
        clock.step = cursor;
        clock.stepSec = stepSec;
      }
      if (lap.total === 0) lap.total = total;
      else if (total !== lap.total) {
        // The playhead keeps its place, or starts over when the roll now ends before it.
        const pos = (((cursor - lap.base) % lap.total) + lap.total) % lap.total;
        lap.base = pos < total ? cursor - pos : cursor + 1e-4;
        lap.total = total;
      }
      if (!source || source.notes !== notes || source.lanes !== lanes || source.total !== total || source.bends !== bends) {
        if (source && (source.lanes !== lanes || source.total !== total || source.bends !== bends)) wheelFresh = true;
        source = { notes, lanes, total, bends };
        played = unrollLanes(notes, lanes, total);
        bent = playedRollBends(bends, lanes, total);
        channels = liveLaneChannels(lanes, bends);
      }
      const targetAbs = clock.step + (now + lookahead - clock.time) / stepSec;
      // The roll plays through its linked clip's voice, or the picker's.
      const voice = currentRollVoice();
      const soundfont = voice.program !== undefined;
      if (soundfont) {
        // A channel whose lane stopped bending goes back to the centre.
        const bentChannels = new Set([...bent.keys()].map((lane) => channels.get(lane) ?? 0));
        for (const ch of [...wheelRanges.keys()]) if (!bentChannels.has(ch)) releaseWheel(ch);
        for (const [lane, curve] of bent) {
          const ch = channels.get(lane) ?? 0;
          if (wheelRanges.get(ch) !== curve.range) {
            sfPitchWheelRange(ch, curve.range);
            wheelRanges.set(ch, curve.range);
          }
          for (const e of loopedWheelEvents(curve.points, total, cursor - lap.base, targetAbs - lap.base, wheelFresh, curve.range)) {
            const at = Math.max(now, clock.time + (e.abs + lap.base - clock.step) * stepSec);
            sfPitchWheel(ch, e.raw, at);
            lastWheelTime = Math.max(lastWheelTime, at);
          }
        }
        wheelFresh = false;
      }
      for (const n of played) {
        const first = lap.base + n.step;
        let occ = first + Math.ceil((cursor - first) / total) * total;
        if (occ <= cursor) occ += total;
        if (occ > targetAbs) continue;
        const lane = playingLane(n.lane, lanes);
        const channel = channels.get(lane) ?? 0;
        const curve = soundfont ? undefined : bent.get(lane);
        while (occ <= targetAbs) {
          const when = clock.time + (occ - clock.step) * stepSec;
          const at = Math.max(now, when);
          let bend: VoiceBend | undefined;
          if (curve) {
            // A note that starts late picks its curve up where the curve is by then.
            const { events, originStep } = loopedBendAutomation(curve, total, n.step + (at - when) / stepSec, n.length + BEND_TAIL_SEC / stepSec);
            bend = { events, originStep, stepSec };
          }
          triggerPianoNote(n.note, n.velocity, at, n.length * stepSec, masterRef.current, {
            channel,
            bend,
            program: voice.program,
            percussion: voice.percussion,
          });
          occ += total;
        }
      }
      cursor = Math.max(cursor, targetAbs);
      const elapsedAbs = clock.step + (now - clock.time) / stepSec;
      setCurrentStep((((elapsedAbs - lap.base) % total) + total) % total);
    };
    playTimerRef.current = window.setInterval(tick, 25);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      for (const ch of [...wheelRanges.keys()]) releaseWheel(ch);
    };
  }, [isPlaying, setCurrentStep, masterRef]);

  // The arpeggiator keeps running behind the roll face, so the key stops
  // whichever of the two is sounding before it starts either.
  const sounding = isPlaying || arpPlaying;
  const handlePlayToggle = () => {
    if (sounding) {
      if (isPlaying) stopPlayback();
      if (arpPlaying) onArpPlayingChange?.(false);
      return;
    }
    if (arpShowing) {
      onArpPlayingChange?.(true);
      return;
    }
    // Start from the top; the lookahead scheduler (effect above) fires notes,
    // including step 0, at their exact times.
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    setCurrentStep(0);
    setPlaying(true);
    logInfo('piano-roll', `Playing ${usePianoRollStore.getState().notes.length} notes at ${bpm} BPM`);
  };
  const playName = sounding ? 'Stop' : arpShowing ? 'Play the arpeggiator' : 'Play';
  const playTip = useDockTip({ word: sounding ? 'Stop' : 'Play', description: arpShowing && !sounding ? 'Play the arpeggiator' : undefined, label: playName });

  // STEPS moves by one bar of the meter the roll ends in, and a new length
  // lands on the next bar line in the direction of the change, whatever the meter.
  // A step from the arrow keys or the spin buttons applies at once. A typed
  // length applies on Enter or when the field loses focus, so the store never
  // rounds a first digit up to a bar line while the rest is still being typed.
  const endBarSteps = barAt(meterMap, Math.max(0, totalSteps - 1e-6), pickupSteps).len;
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
      <div className={FIELD}>
        <label htmlFor="piano-roll-bpm" className={FIELD_LEGEND}>BPM</label>
        <input
          id="piano-roll-bpm"
          type="number"
          name="piano-roll-bpm"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => setBpm(parseInt(e.target.value) || 120)}
          className={`${FIELD_VALUE} w-9 bg-transparent border-none outline-none`}
        />
      </div>
      <div className={FIELD}>
        <label htmlFor="piano-roll-total-steps" className={FIELD_LEGEND}>Steps</label>
        <input
          id="piano-roll-total-steps"
          type="number"
          name="piano-roll-total-steps"
          min={16}
          max={4096}
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
 * The roll's own voice, shown while an unlinked roll plays one (the Vocal2MIDI
 * panel's voice): the roll auditions and bounces with it in place of the
 * instrument picker. Pressing it returns the roll to the picker.
 */
export const PianoRollVoiceKey: React.FC = () => {
  const voiceProgram = usePianoRollStore((s) => s.voiceProgram);
  const linked = usePianoRollStore((s) => s.editingClipId !== null);
  const setVoiceProgram = usePianoRollStore((s) => s.setVoiceProgram);
  if (voiceProgram === null || linked) return null;
  const name = gmShortName(voiceProgram);
  return (
    <StripKey
      on
      onClick={() => setVoiceProgram(null)}
      aria-label={`Roll voice ${name}. Press to follow the instrument picker`}
      legend={`Roll: ${name}`}
      icon={<X className={STRIP_GLYPH} />}
      description={`The roll plays and bounces as ${name}, set by Vocal2MIDI. Press to follow the instrument picker.`}
    />
  );
};

/** Zoom out · step width · zoom in. The width is shared with the grid. */
export const PianoRollZoom: React.FC<{ stepPx: number; onStepPxChange: (px: number) => void }> = ({
  stepPx,
  onStepPxChange,
}) => (
  <>
    <StripKey
      iconOnly
      onClick={() => onStepPxChange(Math.max(STEP_PX_MIN, stepPx - 2))}
      aria-label="Zoom out"
      description="Narrower steps"
      icon={<Minus className={STRIP_GLYPH} />}
      legend="Zoom out"
    />
    <span className="w-5 text-center text-[12px] font-bold et-ink-2 tabular-nums" title="Step width (px)">
      {Math.round(stepPx)}
    </span>
    <StripKey
      iconOnly
      onClick={() => onStepPxChange(Math.min(STEP_PX_MAX_BUTTON, stepPx + 2))}
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
 * them (localStorage). APPLY is unchanged: one `replaceAll`, one undo step.
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
  const [imported, setImported] = useState<GrooveTemplate | null>(null);
  const grooveFileRef = useRef<HTMLInputElement>(null);
  const builtins = useMemo(() => builtinGrooves(), []);

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
    const { notes, replaceAll, meterMap, pickupSteps, totalSteps, lanes } = usePianoRollStore.getState();
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
        : ((imported && imported.id === grooveId ? imported : builtins.find((g) => g.id === grooveId)) ?? null);
    const groove = picked ?? swingToGroove(swingPct);
    // Quantize each note's start toward the nearest 16th at strength `q`
    // (`rollClip.quantizeRollClip`, which is `clipNotes.quantizeNotes` — the
    // arithmetic is not reimplemented here), then lay the groove over it
    // (`grooveTemplate.applyGroove`, same as before). Lengths are handled
    // separately, unchanged: a note's DURATION rounds toward the nearest whole
    // step, which is not what `quantizeEnds` computes (that snaps the note's
    // END POSITION to the grid, a different quantity).
    const { sourceRollNotes: quantizedSteps } = quantizeRollClip(
      {
        sourceRollNotes: notes,
        sourcePianoRoll: [],
        sourceLanes: lanes,
        sourceMeterMap: meterMap,
        sourcePickupSteps: pickupSteps,
        sourceTotalSteps: totalSteps,
      },
      { grid: '1/16', strength: q, groove, grooveStrength: picked ? q : 1 },
    );
    const adjusted = quantizedSteps.map((note, i) => {
      const originalLength = notes[i].length;
      const quantizedLength = Math.max(1, Math.round(originalLength));
      return { ...note, length: Math.max(1, originalLength + (quantizedLength - originalLength) * q) };
    });
    replaceAll(adjusted);
    logInfo('piano-roll', `Applied timing feel: quantize ${quantizePct}% · groove ${groove.name}`);
  };

  return (
    <>
      <div className={FIELD} title="Quantize: pulls notes toward the grid (100 = dead on)">
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
        title="Groove: the feel APPLY lays over the grid, as lateness per slot of the bar. The SWING slider is the first entry; the named grooves take their depth from QUANT."
      >
        <label htmlFor="piano-roll-groove" className={FIELD_LEGEND}>Groove</label>
        <select
          id="piano-roll-groove"
          name="piano-roll-groove"
          // An id nothing answers to shows as the slider entry, which is what it applies as.
          value={
            grooveId === imported?.id || builtins.some((g) => g.id === grooveId) ? grooveId : SLIDER_GROOVE_ID
          }
          onChange={(e) => setGrooveId(e.target.value)}
          className={`${FIELD_SELECT} max-w-28`}
        >
          <option value={SLIDER_GROOVE_ID}>Swing slider</option>
          {builtins.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
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
        description="Apply the quantize and swing amounts to every note"
        icon={<Check className={STRIP_GLYPH} />}
        legend="Apply"
      />
    </>
  );
};

/** "8 notes", and the playhead's step while the roll plays. */
export const PianoRollNoteCount: React.FC = () => {
  const count = usePianoRollStore((s) => s.notes.length);
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
      if (key === 'bpm') setBpm(Math.round(value));
      else if (key === 'totalSteps') {
        // Up to the next bar line of the roll's meter.
        setTotalSteps(Math.max(16, roundUpToBar(meterMap, Math.round(value), pickupSteps)));
      }
    }}
  />
);

/**
 * EDIT: render the notes to audio and add them to the waveform editor. Once a
 * clip is linked the key reads SAVE (latched) and re-renders that clip in
 * place; the corner target unlinks it.
 */
export const PianoRollEditKey: React.FC = () => {
  const noteCount = usePianoRollStore((s) => s.notes.length);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const setEditingClip = usePianoRollStore((s) => s.setEditingClip);
  const [isBouncing, setIsBouncing] = useState(false);
  const [clipMenuOpen, setClipMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  const handleSendToEditor = async () => {
    if (usePianoRollStore.getState().notes.length === 0) {
      logError('piano-roll', 'No notes to bounce');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const done = await bounceRollToEditor({ render: renderStepNotesToBlob, computePeaks, global: getGlobalVoice });
      if (!done) return;
      const ms = (performance.now() - start).toFixed(0);
      if (done.kind === 'updated') {
        logInfo('piano-roll', `Updated editor clip ${done.clipId.slice(0, 8)} (${done.duration.toFixed(2)}s, ${done.noteCount} notes)`);
        logInfo('piano-roll', `Re-bounce took ${ms}ms`);
      } else {
        logInfo('piano-roll', `Bounced ${done.noteCount} notes → editor (${done.duration.toFixed(2)}s in ${ms}ms)`);
      }
    } catch (e) {
      logError('piano-roll', `Bounce failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  const linked = !!editingClipId;
  const unlinkTip = useDockTip({
    word: 'Unlink',
    description: 'Detach: future renders create a new editor clip instead of updating the linked one',
    label: 'Unlink from the editor clip',
    expanded: clipMenuOpen,
    placement: 'right',
  });
  // The name always carries the key's word (the DockTip's EDIT or SAVE).
  const name = isBouncing
    ? linked
      ? 'Save: bouncing to the linked editor clip'
      : 'Edit: bouncing to the editor'
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
        description={linked
          ? `Linked to clip ${editingClipId.slice(0, 8)}: re-render and update it in place. Right-click or the corner to unlink.`
          : 'Render these notes to audio and add them to the waveform editor as a new track'}
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

/** CLEAR: remove every note. */
export const PianoRollClearKey: React.FC = () => (
  <RailKey
    onClick={() => usePianoRollStore.getState().clear()}
    aria-label="Clear every note"
    description="Remove every note from the roll"
    icon={<Trash2 className={RAIL_GLYPH} />}
    legend="Clear"
  />
);

/** Save the roll as a Standard MIDI File at its own BPM and time signatures, lane
 *  repeats written out, each bent lane on its own channel with its pitch wheel and range (lib/rollMidi). */
export const exportRollMidi = async (): Promise<void> => {
  const roll = usePianoRollStore.getState();
  if (roll.notes.length === 0) {
    logError('piano-roll', 'No notes to export');
    return;
  }
  const file = rollToMidiFile(roll);
  const count = file.tracks[0]?.notes.length ?? 0;
  const result = await downloadMidi(file, 'piano-roll');
  // A cancelled or failed save exported nothing; saveFile already logged a failure.
  if (result.path) logInfo('piano-roll', `Exported ${count} notes as MIDI to ${result.path}`);
  else if (result.downloaded) logInfo('piano-roll', `Exported ${count} notes as MIDI`);
};

export const importMidiFileToRoll = (file: File): void => {
  file.arrayBuffer().then((buf) => {
    try {
      const data = parseMidi(new Uint8Array(buf));
      // Every track's notes, the file's time signatures and pickup (4/4 when it
      // has none). A channel whose pitch wheel moves gets its own lane and curve;
      // every other note is in lane A (lib/rollMidi).
      const { notes: flat, bpm, meter, bends } = midiFileToRoll(data, 'imp');
      if (flat.length === 0) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      // importNotes auto-fits the grid length (to a bar line of that map) AND pitch range to the import.
      usePianoRollStore.getState().importNotes(flat, bpm, meter, bends);
      const bent = bends.filter((b) => b.points.length).length;
      logInfo(
        'piano-roll',
        `Imported ${flat.length} notes from "${file.name}" at ${Math.round(bpm)} BPM in ${meterLabel(meter.meterMap[0].meter)}${bent ? `, pitch bend in ${bent} lane${bent === 1 ? '' : 's'}` : ''}`,
      );
    } catch (e) {
      logError('piano-roll', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }).catch((e) => logError('piano-roll', `Could not read file: ${e instanceof Error ? e.message : String(e)}`));
};

export const importSheetFileToRoll = (file: File): void => {
  void (async () => {
    try {
      const score = await parseSheetFile(file);
      // Flatten all parts into a single piano-roll layer (step/length already
      // on the 16th grid from the backend).
      const flat: PianoNote[] = [];
      for (const track of score.tracks) {
        for (const n of track.notes) {
          flat.push({
            id: `sheet-${Math.random().toString(36).slice(2)}-${flat.length}`,
            note: n.pitch,
            step: n.step,
            length: Math.max(1, n.length),
            velocity: n.velocity,
          });
        }
      }
      if (flat.length === 0) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      flat.sort((a, b) => a.step - b.step);
      // The score's first time signature holds for the whole roll; a score with
      // none, or one the roll cannot draw, is 4/4. Its notes start at step 0 and
      // carry no lanes or bends, so the roll's lanes reset to lane A alone, unbent.
      const [num, den] = score.time_signature ?? [];
      const meterMap = normalizeMeterMap([{ bar: 0, meter: { num: Number(num), den: Number(den), groups: [] } }]);
      usePianoRollStore.getState().importNotes(flat, score.bpm, { meterMap, pickupSteps: 0, lanes: [...DEFAULT_LANES] }, []);
      logInfo(
        'piano-roll',
        `Imported ${flat.length} notes from score "${file.name}" (${score.format}) at ${Math.round(score.bpm)} BPM in ${meterLabel(meterMap[0].meter)}`,
      );
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
 */
const RollRuler = React.memo(function RollRuler({
  spans,
  lhl,
  tiers,
  stepPx,
  totalSteps,
}: {
  spans: BarSpan[];
  lhl: number[];
  tiers: { bar: number[]; group: number[]; beat: number[] };
  stepPx: number;
  totalSteps: number;
}) {
  const width = totalSteps * stepPx;
  const ticks = useMemo(
    () => ({
      bar: linesPath(tiers.bar, stepPx, 0, HEADER_HEIGHT),
      // Below the 12px labels, which sit 5px from the top.
      group: linesPath(tiers.group, stepPx, 17, 21),
      beat: linesPath(tiers.beat, stepPx, 19, 21),
    }),
    [tiers, stepPx],
  );
  const max = useMemo(() => lhl.reduce((m, v) => Math.max(m, v), 0), [lhl]);

  return (
    // An opaque ground in the theme's canvas: notes and loop lines scrolled under the ruler stay off its ticks and text.
    // data-dock-ceiling: the SHAPE row's above cards (GEN, FORM) keep their tops below this line.
    <div data-dock-ceiling="" className="sticky top-0 z-20 bg-[#07050a] border-b border-white/5" style={{ height: HEADER_HEIGHT, width, minWidth: '100%' }}>
      {spans.map((b, i) => {
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
            {(b.bar >= 0 || cellPx >= PICKUP_LEGEND_MIN_PX) && <span>{b.bar >= 0 ? b.bar + 1 : 'Pickup'}</span>}
            {change && <span className="font-extrabold et-ink">{meterLabel(b.meter)}</span>}
          </div>
        );
      })}
      <svg
        aria-hidden="true"
        focusable="false"
        className="absolute top-0 left-0 h-full pointer-events-none"
        width={width}
        shapeRendering="crispEdges"
      >
        <path d={ticks.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
        <path d={ticks.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.4)]" />
        <path d={ticks.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
      </svg>
    </div>
  );
});

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

/**
 * Lane repeats: drawn under the stored notes, never clicked, and out of the
 * accessibility tree (the stored note speaks for them). Only the repeats inside
 * `win` (the view and its overscan) render, so a long roll with a short loop
 * stays light. A repeat keeps its lane's edge at full strength and fades only its fill.
 */
const LaneRepeats = React.memo(function LaneRepeats({
  repeats,
  laneOf,
  stepPx,
  lowestNote,
  highestNote,
  win,
}: {
  repeats: PianoNote[];
  laneOf: (lane: number | undefined) => { form: LaneForm; name: string };
  stepPx: number;
  lowestNote: number;
  highestNote: number;
  win: { from: number; to: number };
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none">
      {repeats.map((n) => {
        if (n.note < lowestNote || n.note > highestNote) return null;
        if (n.step > win.to || n.step + n.length < win.from) return null;
        const { form } = laneOf(n.lane);
        return (
          <div
            key={n.id}
            data-lane-repeat="1"
            className={`absolute rounded-sm border overflow-hidden z-5 ${form.edge}`}
            style={{
              left: n.step * stepPx,
              width: Math.max(form.minPx, n.length * stepPx - 1),
              top: (highestNote - n.note) * NOTE_HEIGHT + 1,
              height: NOTE_HEIGHT - 2,
            }}
          >
            <div className={`absolute inset-0 opacity-38 ${form.fill}`} style={form.style} />
          </div>
        );
      })}
    </div>
  );
});

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
            onClick={() => triggerPianoNote(midi, 100, getEngineCtx().currentTime + 0.02, 0.25, masterRef.current, currentRollVoice())}
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

/** The playhead: a 1px line in the theme's primary ink, which holds contrast on
 *  the grid and across the accent-filled notes. No glow. Only this re-renders
 *  as the roll plays. */
const RollPlayhead: React.FC<{ stepPx: number }> = ({ stepPx }) => {
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  if (!isPlaying) return null;
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-[rgb(var(--et-ink))] z-30 pointer-events-none"
      style={{ left: currentStep * stepPx + stepPx / 2 }}
    />
  );
};

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
 * them than the grid does.
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

  const bars = useMemo(
    () => notes.filter((n) => n.step <= win.to && n.step + n.length >= win.from),
    [notes, win],
  );

  /** The reading beside the legend: one selected velocity, a range, or a dash. */
  const reading = useMemo(() => {
    const picked = notes.filter((n) => selectedIds.has(n.id));
    if (picked.length === 0) return '—';
    const lo = picked.reduce((m, n) => Math.min(m, n.velocity), VELOCITY_MAX);
    const hi = picked.reduce((m, n) => Math.max(m, n.velocity), 1);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
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

  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const r = surfaceRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const step = x / Math.max(1e-6, stepPx);
    dragRef.current = step;
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
      {/* role="application": the arrow keys set velocity here, so a screen
          reader must send them through instead of moving its own cursor. */}
      <div
        ref={surfaceRef}
        role="application"
        tabIndex={0}
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
        <svg width={width} height={height} className="absolute inset-0 pointer-events-none" shapeRendering="crispEdges">
          {/* Quarter marks, so a bar's height reads as a value without a scale. */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={0}
              x2={width}
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

export const PianoRoll: React.FC<{
  stepPx: number;
  onStepPxChange: (px: number) => void;
  /** The bend lane is open under the grid (the strip's BEND key). */
  showBend?: boolean;
}> = ({
  stepPx,
  onStepPxChange,
  showBend = false,
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

  const addNote = usePianoRollStore((s) => s.addNote);
  const removeNote = usePianoRollStore((s) => s.removeNote);
  const updateNote = usePianoRollStore((s) => s.updateNote);
  const setSelectedNote = usePianoRollStore((s) => s.setSelectedNote);
  const setSelection = usePianoRollStore((s) => s.setSelection);
  const addToSelection = usePianoRollStore((s) => s.addToSelection);
  const toggleSelection = usePianoRollStore((s) => s.toggleSelection);
  const clear = usePianoRollStore((s) => s.clear);
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
  // length. Step lines skip the steps a stronger tier already draws.
  const gridPaths = useMemo(() => {
    const drawn = new Set([...tiers.bar, ...tiers.group, ...tiers.beat]);
    const steps: number[] = [];
    if (stepPx >= STEP_LINES_MIN_PX) for (let i = 0; i <= totalSteps; i += 1) if (!drawn.has(i)) steps.push(i);
    return {
      step: linesPath(steps, stepPx, 0, gridHeight),
      beat: linesPath(tiers.beat, stepPx, 0, gridHeight),
      group: linesPath(tiers.group, stepPx, 0, gridHeight),
      bar: linesPath(tiers.bar, stepPx, 0, gridHeight),
    };
  }, [tiers, stepPx, totalSteps, gridHeight]);

  // The notes in looping lanes, kept as the same array while none of them
  // changes, so an edit in a lane that does not loop leaves the repeats alone.
  const loopNotesRef = useRef<PianoNote[]>([]);
  const loopNotes = useMemo(() => {
    const looping = new Set(lanes.filter((l) => l.cycleSteps != null && l.cycleSteps > 0 && l.cycleSteps < totalSteps).map((l) => l.id));
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

  const loopEnds = useMemo(
    () => lanes.filter((l): l is PolyLane & { cycleSteps: number } => l.cycleSteps != null && l.cycleSteps > 0 && l.cycleSteps < totalSteps),
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

  // Map y-pixel inside the grid to a MIDI note. Top row = highestNote.
  const yToNote = useCallback(
    (y: number): number => highestNote - Math.floor(y / NOTE_HEIGHT),
    [highestNote],
  );
  const xToStep = useCallback((x: number): number => Math.floor(x / stepPx), [stepPx]);
  /** What lib/rollSelection needs to turn grid pixels into steps and notes. */
  const geo: RollGeometry = useMemo(
    () => ({ stepPx, noteHeight: NOTE_HEIGHT, highestNote }),
    [stepPx, highestNote],
  );

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
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return;
    const targetNote = yToNote(y);
    const targetStep = xToStep(x);
    if (targetStep < 0 || targetStep >= totalSteps) return;
    insertStepRef.current = targetStep;
    // If clicked on an existing note → select it, or remove it when it was the
    // one selected note before this press. Only stored notes count; a lane
    // repeat is drawn, not stored, and clicks pass through it.
    const hit = notes.find(
      (n) => n.note === targetNote && targetStep >= n.step && targetStep < n.step + n.length,
    );
    if (hit) {
      const press = pressRef.current;
      pressRef.current = null;
      if (modifierSelect(e, hit.id)) return;
      const wasSelected = press
        ? press.id === hit.id && press.wasSelected
        : selectedIds.size === 1 && selectedIds.has(hit.id);
      if (wasSelected) {
        removeNote(hit.id);
      } else {
        setSelectedNote(hit.id);
      }
      return;
    }
    // Otherwise add a 1-step note.
    addNote({ note: targetNote, step: targetStep, length: 2, velocity: 96 });
    triggerPianoNote(targetNote, 96, getEngineCtx().currentTime + 0.02, 0.2, masterRef.current, currentRollVoice());
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
  // Where a paste lands. The roll has NO edit cursor — its only step marker is
  // the transport playhead (`currentStep`), which is reset to 0 on play and is
  // stale once playback stops — so the insertion point is the playhead while the
  // roll is sounding and the last clicked step otherwise (an empty cell, or the
  // step a clicked note starts on), which is the roll's own "last click
  // position". A clip load replaces every note, so the point goes back to the
  // top with them — the step it held belonged to the roll that just left.
  const insertStepRef = useRef(0);
  useEffect(() => { insertStepRef.current = 0; }, [editingClipId]);
  // Right-drag a note to extend its length.
  const resizeRef = useRef<{ id: string; startX: number; initialLength: number } | null>(null);
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
    if (edge === 'right') {
      resizeRef.current = { id: note.id, startX: e.clientX, initialLength: note.length };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  /** A press on empty grid opens a marquee; the drag is only confirmed on the move. */
  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A press that starts off every note clears a note press that ended without a click.
    pressRef.current = null;
    // A fresh press: whatever the last drag armed, it can only ever swallow its
    // OWN click, never a later one.
    suppressClickRef.current = false;
    if (e.button !== 0) {
      marqueeRef.current = null;
      return;
    }
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    marqueeRef.current = {
      origin: gridPointAt(e.clientX - rect.left, e.clientY - rect.top, geo),
      startX: e.clientX,
      startY: e.clientY,
      shift: e.shiftKey,
      rect: null,
    };
    // Capture on the grid so a marquee dragged outside the scroll box still ends here.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const op = resizeRef.current;
    if (op) {
      const dx = e.clientX - op.startX;
      if (Math.abs(dx) >= 3 && pressRef.current?.id === op.id) pressRef.current.wasSelected = false;
      const deltaSteps = Math.round(dx / stepPx);
      const newLen = Math.max(1, op.initialLength + deltaSteps);
      updateNote(op.id, { length: newLen });
      return;
    }
    const mq = marqueeRef.current;
    if (!mq) return;
    // Until the pointer has travelled far enough this is still a click, which
    // is how a click on an empty cell keeps adding a note.
    if (!mq.rect && Math.abs(e.clientX - mq.startX) < MARQUEE_MIN_PX && Math.abs(e.clientY - mq.startY) < MARQUEE_MIN_PX) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = marqueeRect(mq.origin, gridPointAt(e.clientX - rect.left, e.clientY - rect.top, geo));
    mq.rect = next;
    setMarquee(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      resizeRef.current = null;
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
  // arrow whether or not it had anything to move. The bend and velocity lanes
  // are excluded: both take the arrows for their own points and bars, and a
  // window capture listener runs before their element handlers can stop it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if (t?.closest('[data-bend-lane], [data-velocity-lane]')) return;
      if (inPortalledOverlay(e.target, rootRef.current)) return;
      if (!ownsKey('piano-roll')) return;
      if (rootRef.current?.offsetParent === null) return; // roll hidden (ARP face showing)
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = usePianoRollStore.getState();
      if (s.selectedIds.size === 0) return;
      const coarse = e.shiftKey;
      if (e.key === 'ArrowLeft') s.nudgeSelected(coarse ? -4 : -1, 0);
      else if (e.key === 'ArrowRight') s.nudgeSelected(coarse ? 4 : 1, 0);
      else if (e.key === 'ArrowUp') s.nudgeSelected(0, coarse ? 12 : 1);
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
  // Each clipboard edit is ONE write of `notes` (replaceAll), which is one undo
  // step: the store's history subscriber snapshots the pre-change document on
  // the first change of a burst, so a cut (copy + delete) and a paste each
  // record exactly one step. The selection write that follows a paste touches no
  // tracked slice, so it adds no step of its own.
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
      const range = { lowestNote: s.lowestNote, highestNote: s.highestNote, totalSteps: s.totalSteps };
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
      const added = k === 'v'
        ? (noteClipboard ? pasteNotes(noteClipboard, s.isPlaying ? Math.floor(s.currentStep) : insertStepRef.current, range) : [])
        : duplicateNotes(s.notes, picked, range);
      if (added.length === 0) return;
      s.replaceAll([...s.notes, ...added]);
      // The block that just landed IS the selection, so a repeated Ctrl/Cmd+D
      // marches forward instead of stacking copies on the original, and the
      // earliest of them is the primary.
      s.setSelection(added.map((n) => n.id), added[0].id);
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
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const oldStepPx = stepPx;
      const nextStepPx = Math.max(STEP_PX_MIN, Math.min(STEP_PX_MAX_WHEEL, oldStepPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      onStepPxChange(nextStepPx);
      requestAnimationFrame(() => {
        el.scrollLeft = cursorX * (nextStepPx / oldStepPx) - (e.clientX - rect.left);
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
  const contentLo = notes.length ? notes.reduce((m, n) => Math.min(m, n.note), 127) : 60;
  const contentHi = notes.length ? notes.reduce((m, n) => Math.max(m, n.note), 0) : 72;
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const midNote = (contentLo + contentHi) / 2;
    const midY = (highestNote - midNote) * NOTE_HEIGHT;
    el.scrollTop = Math.max(0, midY - el.clientHeight / 2);
    if (keyboardRowsRef.current) keyboardRowsRef.current.scrollTop = el.scrollTop;
  }, [contentLo, contentHi, highestNote]);

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-[#07050a] overflow-hidden relative">
      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Keyboard column */}
        <div className="shrink-0 overflow-hidden bg-[#0c0a12] border-r border-white/5" style={{ width: KEYBOARD_WIDTH }}>
          <div
            className="bg-black/40 border-b border-white/5 flex items-center justify-center"
            style={{ height: HEADER_HEIGHT }}
            title={ROLL_HELP}
          >
            <Info aria-hidden="true" className="w-3 h-3 et-ink-3" />
            <span className="sr-only">{ROLL_HELP}</span>
          </div>
          <div ref={keyboardRowsRef} className="overflow-hidden" style={{ height: `calc(100% - ${HEADER_HEIGHT}px)` }}>
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
          {/* Ruler */}
          <RollRuler spans={barSpans} lhl={barLhl} tiers={tiers} stepPx={stepPx} totalSteps={totalSteps} />

          <div
            ref={gridRef}
            onPointerDown={onGridPointerDown}
            onClick={handleGridClick}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            <RowBackgrounds lowestNote={lowestNote} highestNote={highestNote} />
            {/* Vertical lines: bar lines strongest, then group starts, beats and
                (when a step is wide enough) steps. */}
            <svg
              aria-hidden="true"
              focusable="false"
              className="absolute top-0 left-0 pointer-events-none"
              width={gridWidth}
              height={gridHeight}
              shapeRendering="crispEdges"
            >
              {gridPaths.step && <path d={gridPaths.step} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.03)]" />}
              <path d={gridPaths.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.06)]" />
              <path d={gridPaths.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.12)]" />
              <path d={gridPaths.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
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
              const name = `Lane ${l.name} loops every ${l.cycleSteps} steps`;
              const tagPx = 18 + 7.5 * String(l.cycleSteps).length;
              const others = loopEnds.map((o) => o.cycleSteps);
              const roomRight = (Math.min(totalSteps, ...others.filter((c) => c > l.cycleSteps)) - l.cycleSteps) * stepPx;
              const roomLeft = (l.cycleSteps - Math.max(0, ...others.filter((c) => c < l.cycleSteps))) * stepPx;
              const onLeft = roomRight < tagPx && roomLeft >= tagPx;
              return (
                <div
                  key={l.id}
                  className="absolute top-0 bottom-0 w-0 border-l border-dashed border-[rgb(var(--et-ink)/0.5)] z-15 pointer-events-none"
                  style={{ left: l.cycleSteps * stepPx }}
                >
                  <span
                    role="img"
                    aria-label={name}
                    title={name}
                    data-loop-tag="1"
                    className={`sticky flex w-max items-center gap-0.5 ${onLeft ? '-ml-0.5 -translate-x-full' : 'ml-0.5'} px-0.5 py-0.5 rounded-xs bg-[#0a080f] text-[12px] leading-none font-bold et-ink tabular-nums whitespace-nowrap pointer-events-auto`}
                    style={{ top: HEADER_HEIGHT + 4 + i * 18, marginTop: 4 + i * 18 }}
                  >
                    <span className={`w-2 h-2 rounded-xs border ${form.fill} ${form.edge}`} style={form.style} />
                    {l.cycleSteps}
                  </span>
                </div>
              );
            })}
            <RollPlayhead stepPx={stepPx} />
            <LaneRepeats
              repeats={repeats}
              laneOf={laneOf}
              stepPx={stepPx}
              lowestNote={lowestNote}
              highestNote={highestNote}
              win={view}
            />
            {/* Notes */}
            {notes.map((n) => {
              if (n.note < lowestNote || n.note > highestNote) return null;
              if (n.step > view.to || n.step + n.length < view.from) return null;
              const row = highestNote - n.note;
              const left = n.step * stepPx;
              const lane = laneOf(n.lane);
              // The form's minimum drawn width grows the note to the right only; its start and stored length stay.
              const width = Math.max(lane.form.minPx, n.length * stepPx - 1);
              const top = row * NOTE_HEIGHT;
              const selected = selectedIds.has(n.id);
              return (
                <div
                  key={n.id}
                  data-piano-note="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    const press = pressRef.current;
                    pressRef.current = null;
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (modifierSelect(e, n.id)) return;
                    if (press?.id === n.id && press.wasSelected) removeNote(n.id);
                    else setSelectedNote(n.id);
                  }}
                  onPointerDown={(e) => onNotePointerDown(e, n, 'body')}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    // Right-click acts on this note, so it takes the selection
                    // unless it is already part of one.
                    if (!selectedIds.has(n.id)) setSelectedNote(n.id);
                    noteMenu.open(e, n);
                  }}
                  className={`absolute rounded-sm border z-10 transition-[filter] ${lane.form.fill} ${selected ? 'border-white brightness-125' : `${lane.form.edge} hover:brightness-110`}`}
                  style={{ ...lane.form.style, left, width, top: top + 1, height: NOTE_HEIGHT - 2 }}
                  title={`${noteLabel(n.note)} · step ${n.step + 1} · ${n.length} step${n.length === 1 ? '' : 's'}${lanes.length > 1 ? ` · lane ${lane.name}` : ''}`}
                >
                  <div
                    onPointerDown={(e) => onNotePointerDown(e, n, 'right')}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                </div>
              );
            })}
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

          {/* The velocity and bend lanes, inside the grid's scroll box so they
              keep the grid's x scale and scroll with it: a bar stays under its
              note, and a point under the note it bends, at every zoom and every
              scroll position. */}
          <VelocityLane stepPx={stepPx} totalSteps={totalSteps} win={view} />
          {showBend && <BendLane stepPx={stepPx} totalSteps={totalSteps} />}
        </div>
      </div>

      {/* Right-click menu for a single note. */}
      {(() => {
        const n = noteMenu.payload;
        if (!n) return null;
        const clampVel = (v: number) => Math.max(1, Math.min(127, v));
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
            label: 'Lengthen (+1 step)',
            onSelect: () => updateNote(n.id, { length: n.length + 1 }),
          },
          {
            type: 'item',
            label: 'Shorten (−1 step)',
            disabled: n.length <= 1,
            onSelect: () => updateNote(n.id, { length: Math.max(1, n.length - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge left',
            disabled: n.step <= 0,
            onSelect: () => updateNote(n.id, { step: Math.max(0, n.step - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge right',
            onSelect: () => updateNote(n.id, { step: n.step + 1 }),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Clear all notes',
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
            title={`${noteLabel(n.note)} · step ${n.step + 1}`}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};
