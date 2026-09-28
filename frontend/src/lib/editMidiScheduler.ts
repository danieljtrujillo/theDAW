/**
 * editMidiScheduler — EDIT's live MIDI on the audio clock.
 *
 * EDIT plays a MIDI clip live through its own synths (soundfontEngine's EDIT
 * banks) when the clip has a program. This module decides what those synths
 * hear and WHEN, in audio-context seconds, so every note-on, note-off, program
 * change and pitch-wheel message is queued on the synth for the moment it
 * belongs to and lands on the render quantum the clips' audio plays in.
 *
 * The scheduler
 * -------------
 * A rolling lookahead: every EDIT_MIDI_TICK_MS a tick hands the synth what
 * falls in the next `lookaheadSec` of the transport. This is the standard Web
 * Audio two-clock pattern (a coarse JS timer deciding what a sample-accurate,
 * time-stamped schedule should contain), as described in Chris Wilson's "A
 * Tale of Two Clocks"; the implementation is written from that description.
 * The transport maps onto the context clock through ONE anchor (the context
 * time a pass started and the transport second it started from), the same
 * anchor liveMixer's playhead and the clips' audio sources use, so a note
 * cannot drift from the audio beside it however long the song runs.
 *
 * Each tick re-reads the clips, the tracks and the global picker. A note, a
 * clip, a program, a mute or a clip gain changed while playing changes what
 * plays next without a restart; a note is handed over at most once, because
 * the window's cursor only moves forward. Each clip's notes are timed once per
 * edit of that clip (the clip object is the cache key; editorStore replaces it
 * on every edit), so a tick costs a binary search per clip.
 *
 * What a clip plays
 * -----------------
 *   - The notes its bounce renders from (lib/rollClip clipRenderInput), each at
 *     its own length (clipNoteSpan: no 16th floor, a triplet 32nd stays a
 *     triplet 32nd), timed through the clip's tempo map (`sourceTempoMap`,
 *     lib/rollTempo stepClock) and cut at the clip's edges.
 *   - Its lanes' pitch bends: a wheel bends a whole channel, so each bent lane
 *     plays on a channel of its own (lib/pitchBend laneChannels; the track is
 *     given that many channels, lib/editChannels), with the lane's bend range
 *     and the wheel messages the bounce writes (bendWheelEvents), each at its
 *     own time. Every clip, bent or not, opens by setting the range and wheel
 *     of the channels it uses, so a clip after a bent one never inherits a bend.
 *   - Its part's controllers (a roll part's modulation, volume, pan,
 *     expression and sustain pedal: AudioClip `sourceRollPart` controls, lib/
 *     rollClip clipControlTimes), on every channel the clip plays on, each at
 *     its own time: the value each holds where the clip's window starts, at
 *     the clip's start, then every change inside the window. Where the clip
 *     ends, each controller it left off its General MIDI default goes back,
 *     the pedal first, so nothing it held rings past it, as its render stops
 *     there and the arrangement's MIDI export writes it (lib/arrangementMidi).
 *   - Its notes' articulations (lib/articulationMap articulatedNotes): each
 *     note plays shaped by its articulation (a staccato at half its length),
 *     and an articulation the soundfont holds as a preset of its own (a string
 *     part's pizzicato, GM 46) plays on a channel of its own after the clip's
 *     others, in that preset, through the scheduler's per-note program
 *     changes, so the part's other notes keep their program. A note on such a
 *     channel does not follow its lane's bend.
 *   - Its notes' own expression (PianoNote `expr`: pressure, timbre, bend),
 *     MPE-style: each expressive note plays on a member channel of its own,
 *     rotated across a block after the clip's lane channels (lib/mpeRotation;
 *     the track's `mpeChannels` sets the block's size, 0 turns it off), and
 *     just before it starts that channel's wheel, CC 74 and channel pressure
 *     are set to the note's. Where the clip ends its member channels go back
 *     to CC 74 at rest and no pressure.
 *   - Its gain and fades: the track's MIDI goes through one envelope gain per
 *     track, which follows the clip that is playing (lib/clipFade
 *     applyFadeAutomation with the clip's gain as the peak), the curve the
 *     clip's audio takes on export.
 *   - Notes already sounding where playback starts are started there (a
 *     "chase", as a DAW chases held notes), so pressing play in the middle of
 *     a held chord plays the chord. A percussion track does not chase: a drum
 *     hit is its onset, and striking it again mid-ring is louder than the take.
 *
 * Channel state between clips and passes
 * --------------------------------------
 * A render plays every clip from a channel at the General MIDI defaults, so
 * live playback keeps the channels there between clips:
 *   - Every pass opens each channel it plays on at those defaults (lib/
 *     rollTracks PART_CONTROLLERS: the pedal up first, then modulation 0,
 *     volume 100, pan 64 and expression 127), ahead of any clip's own state.
 *     SpessaSynth's stopAll silences voices and keeps controllers, so a pass
 *     stopped inside a pedalled clip (a stop, a seek, a loop wrap) would
 *     otherwise hand its pedal and volume to the next pass's notes, on
 *     whichever track the channel goes to then.
 *   - A clip that stops playing live part way (muted, deleted, or left with
 *     no program) after its controllers were handed over puts them back at
 *     once, after its last queued change, as its own end would have.
 *   - A clip that starts playing live part way (unmuted, or given a program)
 *     sets its channels where they are at that point (range, wheel and
 *     controllers), as a pass starting there does.
 *
 * Controller automation
 * ---------------------
 * A track's trackMidiCc automation lanes (lib/midiCcAutomation) send their
 * controller on every channel the track plays on: where a pass starts, the
 * value each lane has there, then a change wherever the lane's whole value
 * moves inside each window. A lane owns its controller on its track, so the
 * track's clips' own changes of it are left out while the lane is enabled
 * and has points. A lane that goes (removed, disabled, emptied) mid-pass puts
 * its controller back where the channel starts.
 *
 * Late ticks
 * ----------
 * A tick that runs late (a busy main thread, a hidden tab) does not fire a
 * burst of stale onsets: an onset further than `lateSec` behind the clock is
 * chased when its note is still sounding and skipped when it is over, and the
 * pass counts both (`stats`) so liveMixer can say so in the LOG.
 *
 * Stop and seek
 * -------------
 * SpessaSynth has no way to take back a queued event, and its stopAll does not
 * clear the queue. So `stop()` answers every note-on still waiting in the
 * queue with a note-off at the same time (the queue is stable, so the off runs
 * after the on), which ends that voice at the synth's shortest note. A pass
 * that starts while those pairs are still queued (a seek) sends its own notes
 * as they are: SpessaSynth gives each note-on of a key a note id and ends the
 * OLDEST sounding one of that key at each note-off, so a stale pair adds one
 * voice and takes one away. A note of the new pass sounding when the pair comes
 * goes on as the stale note's voice (struck again there) and its own note-off
 * ends it; striking it again after the cancel would leave a voice more than
 * note-offs, sounding until the next stop. The pass holds its wheel messages on
 * a channel until the last stale one has passed. The lookahead is short while
 * the page is visible so that window stays small (liveMixer).
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip, AutomationLane, EditorTrack } from '../state/editorStore';
import { clipPeakGain } from '../state/editorStore';
import { DEFAULT_LANES, sanitizeLanes } from '../state/pianoRollStore';
import { REVERB_SEND_CC, clipBankSelect, synthReverbSendOf } from './arrangementMidi';
import { NO_PROGRAM, clipVoice, effectiveProgramFor, isExternalOnly, isPercussionTrack, type GlobalVoice } from './clipProgram';
import { applyFadeAutomation, type AudioParamLike } from './clipFade';
import {
  BEND_CENTER,
  BEND_CHANNELS,
  DEFAULT_BEND_RANGE,
  bendValueAt,
  bendValueToRaw,
  bendWheelEvents,
  laneChannels,
  playingLane,
  sanitizeBends,
} from './pitchBend';
import { roundUpToBar } from './meterMap';
import { noteEndStep } from './clipNotes/units';
import { clipControlTimes, clipNoteSpan, clipRenderInput } from './rollClip';
import { PART_CONTROLLERS, partController } from './rollTracks';
import { articulatedNotes, clipArticulationInstrument } from './articulationMap';
import { automatedControllers, ccLaneEvents, ccLaneValueAt, trackCcLanes } from './midiCcAutomation';
import { stepClock } from './rollTempo';
import {
  MPE_DEFAULT_MEMBERS,
  TIMBRE_REST,
  expressionCurveSteps,
  expressionMessages,
  hasExpression,
  membersNeeded,
  noteBendRange,
  rotateMembers,
  trackMembers,
} from './mpeRotation';
import { TICKS_PER_STEP } from './rollSnap';

/** How far ahead of the clock a tick schedules while the page is visible. */
export const EDIT_MIDI_LOOKAHEAD_SEC = 0.1;
/** The lookahead while the page is hidden, where timers fire about once a second. */
export const EDIT_MIDI_HIDDEN_LOOKAHEAD_SEC = 1.5;
/** How often the driving timer fires. Comfortably inside the lookahead. */
export const EDIT_MIDI_TICK_MS = 25;
/** An onset further than this behind the clock is late: chased or skipped, never fired as a burst. */
export const EDIT_MIDI_LATE_SEC = 0.03;
/** Where a held-back wheel message lands after the last stale one on its channel. */
const AFTER_STALE_SEC = 1e-6;
const EPS = 1e-9;

/** Pedal first, then by controller number: the order controllers go back to their defaults in. */
const pedalFirst = (a: number, b: number): number => (a === 64 ? -1 : b === 64 ? 1 : a - b);

/**
 * The value a General MIDI channel starts at for every controller a part keeps
 * (lib/rollTracks PART_CONTROLLERS), the sustain pedal first so nothing it held
 * rings on: what every pass opens its channels with, the state each clip's
 * render starts from.
 */
export const CHANNEL_DEFAULTS: ReadonlyArray<{ controller: number; value: number }> = Object.freeze(
  [...PART_CONTROLLERS]
    .sort((a, b) => pedalFirst(a.controller, b.controller))
    .map((c) => Object.freeze({ controller: c.controller, value: c.initial })),
);

/**
 * The controllers every pass opens every channel with. Brightness (74) and the
 * reverb send (91) go back to their defaults only on a channel a pass moved
 * them on: SpessaSynth recomputes a channel's filter on every brightness
 * change, even one to where it already is, which moves the onsets of the
 * notes that follow, so a pass sends none it does not need.
 */
const ALWAYS_OPENED: ReadonlySet<number> = new Set([1, 7, 10, 11, 64]);

/**
 * What EDIT's synths are told. Every time is audio-context seconds. `program`
 * is NO_PROGRAM (-1) for an external-only track's notes: no program change or
 * bank select goes with them (lib/clipProgram isExternalOnly). `bank` is
 * the bank select (CC 0) sent before `program` (lib/clipProgram clipBank: a
 * clip's own program in a roll part's Bank); 0 is the General MIDI set.
 * `bankLsb` is the CC 32 after it: the roll part's bank LSB while the clip
 * plays the part's program in the part's bank (lib/arrangementMidi
 * clipBankSelect, the same the MIDI export writes), else undefined.
 */
export interface EditMidiSink {
  noteOn(channel: number, program: number, midi: number, velocity: number, time: number, bank: number, bankLsb?: number): void;
  noteOff(channel: number, midi: number, time: number): void;
  wheel(channel: number, raw: number, time: number): void;
  wheelRange(channel: number, semitones: number, time: number): void;
  /** A controller change (a part's modulation, volume, pan, expression or pedal, a note's timbre), 0-127. */
  control(channel: number, controller: number, value: number, time: number): void;
  /** Channel pressure, 0-127: an expressive note's pressure on its member channel. */
  pressure?(channel: number, value: number, time: number): void;
}

/** A track's MIDI envelope gain: an AudioParam, or a recorder in tests. */
export interface EnvelopeParam extends AudioParamLike {
  cancelScheduledValues(time: number): unknown;
}

/** The clips a pass plays live and each track's channels (liveMixer planLiveMidi). */
export interface EditMidiPass {
  liveClipIds: ReadonlySet<string>;
  channelsOf: ReadonlyMap<string, readonly number[]>;
}

export interface EditMidiSchedulerDeps {
  /** The audio context's clock. */
  now: () => number;
  sink: EditMidiSink;
  /** Read on every tick. */
  clips: () => readonly AudioClip[];
  tracks: () => readonly EditorTrack[];
  global: () => GlobalVoice;
  /** The project tempo, which times a clip with no `sourceBpm`. */
  projectBpm: () => number | undefined;
  /** The track's envelope gain; absent or null and clip gain and fades are left alone. */
  envelope?: (trackId: string) => EnvelopeParam | null;
  /** Seconds ahead each tick schedules. Absent: EDIT_MIDI_LOOKAHEAD_SEC. */
  lookaheadSec?: () => number;
  /** Absent: EDIT_MIDI_LATE_SEC. */
  lateSec?: number;
  /** EDIT's automation lanes, read every tick; the trackMidiCc ones play (lib/midiCcAutomation). Absent: none. */
  automation?: () => readonly AutomationLane[];
}

/** The program and bank select a clip's notes are played in. */
interface LiveVoice {
  program: number;
  bank: number;
  bankLsb: number | undefined;
}

/** One note of a clip on the transport, in seconds, on the clip's `slot`-th channel. */
export interface TimedNote {
  on: number;
  off: number;
  midi: number;
  velocity: number;
  slot: number;
  /** The preset an articulation plays the note in (lib/articulationMap), on its own slot; absent: the clip's voice. */
  program?: number;
  bank?: number;
}

/**
 * One channel message of a clip on the transport: a bend range, a wheel
 * position, or a controller change (`cc`, with its `controller`); `reset` is
 * a controller put back to its default where the clip ends.
 */
export interface TimedCtl {
  t: number;
  slot: number;
  kind: 'range' | 'wheel' | 'cc' | 'reset' | 'pressure';
  value: number;
  /** The controller number, for `cc` and `reset`. */
  controller?: number;
}

/** A clip as the scheduler plays it: notes sorted by onset, channel messages sorted by time, and how many channels it uses. */
export interface ClipTiming {
  notes: TimedNote[];
  ctl: TimedCtl[];
  slots: number;
  /** The controllers its part changes, the pedal first; empty for a clip with none. */
  controllers: number[];
}

/** What a pass did, for the LOG. */
export interface EditMidiStats {
  notes: number;
  chased: number;
  late: number;
  skipped: number;
}

/** The fields clipLiveTiming reads. */
export type TimedClip = Pick<
  AudioClip,
  | 'startSec'
  | 'durationSec'
  | 'offsetIntoSource'
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceLanes'
  | 'sourceBends'
  | 'sourceBpm'
  | 'sourceTempoMap'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
> &
  Partial<Pick<AudioClip, 'sourceRollPart'>>;

/** A clip's grid length, as its re-render reads it (lib/clipRerender). */
const clipTotalSteps = (clip: Partial<TimedClip>): number =>
  clip.sourceTotalSteps ?? roundUpToBar(clip.sourceMeterMap ?? [], noteEndStep(clip.sourcePianoRoll ?? [], 1), clip.sourcePickupSteps ?? 0);

/**
 * Which slot (channel of the track's) each of a clip's notes plays on: its
 * lane's (one per bent lane and one the rest share), or, for a note whose
 * articulation plays a soundfont preset of its own, a slot after the lanes'
 * for that preset and the bent lane it sits in, so the lane's wheel bends it
 * there too (`artSlots` names the lane slot each follows; null when none).
 */
function clipSlotPlan(clip: Parameters<typeof clipRenderInput>[0] & Partial<TimedClip>, percussion: boolean, program: number | undefined) {
  const input = clipRenderInput(clip, clipTotalSteps(clip));
  const bends = percussion ? undefined : input.bends;
  const slotOf = new Map<number, number>();
  if (bends) for (const [lane, ch] of bends.channels) slotOf.set(lane, Math.max(0, BEND_CHANNELS.indexOf(ch)));
  const laneSlot = (lane: number | undefined): number => (bends ? slotOf.get(playingLane(lane, bends.lanes)) ?? 0 : 0);
  const laneSlots = bends && slotOf.size ? Math.max(...slotOf.values()) + 1 : 1;
  const bentLaneSlots = new Set<number>(bends ? [...bends.played.keys()].map((lane) => slotOf.get(lane) ?? 0) : []);
  const arts = articulatedNotes(input.notes, clipArticulationInstrument(clip, program, percussion));
  const artSlots: Array<{ follows: number | null }> = [];
  const artIndex = new Map<string, number>();
  const noteSlots = arts.notes.map((a) => {
    const ls = laneSlot(a.note.lane);
    if (!a.target) return ls;
    const follows = bentLaneSlots.has(ls) ? ls : null;
    const key = `${a.slot}|${follows ?? '-'}`;
    let i = artIndex.get(key);
    if (i === undefined) {
      i = artSlots.length;
      artSlots.push({ follows });
      artIndex.set(key, i);
    }
    return laneSlots + i;
  });
  return { input, bends, slotOf, laneSlots, arts, noteSlots, artSlots, slots: laneSlots + artSlots.length };
}

/**
 * How many channels a clip plays on: one, or one per lane of its that bends
 * plus one its other lanes share (lib/pitchBend laneChannels), exactly the
 * channels its bounce renders on, one more for each soundfont preset its
 * notes' articulations play (lib/articulationMap: a string part's pizzicato),
 * and then the member channels its expressive notes rotate across: as many as
 * sound at once, at most `members` (lib/mpeRotation). A percussion clip plays
 * on its one drum channel.
 */
export function clipLiveSlots(
  clip: Pick<AudioClip, 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'> & Partial<Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollPart'>>,
  percussion = false,
  program?: number,
  members = MPE_DEFAULT_MEMBERS,
): number {
  if (percussion) return 1;
  const expressive = (clip.sourcePianoRoll ?? []).filter((n) => hasExpression(n.expr)).map((n) => ({ start: n.step, end: n.step + n.length }));
  const mpe = membersNeeded(expressive, members);
  // No articulated note: the lanes' channels alone, counted as the bounce counts them.
  if (!(clip.sourcePianoRoll ?? clip.sourceRollNotes ?? []).some((n) => n.articulation)) {
    if (!clip.sourceBends?.length || !clip.sourceRollNotes?.length) return 1 + mpe;
    const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
    return Math.max(1, new Set(laneChannels(lanes, sanitizeBends(clip.sourceBends)).values()).size) + mpe;
  }
  return clipSlotPlan(clip, false, program).slots + mpe;
}

const byOn = (a: TimedNote, b: TimedNote) => a.on - b.on;

/**
 * Every note and channel message of `clip` on the transport, in seconds. The
 * notes are the ones its bounce renders from (clipRenderInput), at their own
 * lengths through the clip's clock, inside the clip's window: the trim offset
 * is taken off and a note running past an edge is cut at it. A percussion clip
 * ignores bends and plays on one channel. Expressive notes rotate across up
 * to `members` member channels after the lane channels (lib/mpeRotation).
 */
export function clipLiveTiming(
  clip: TimedClip,
  fallbackBpm: number | undefined,
  percussion = false,
  program?: number,
  members = MPE_DEFAULT_MEMBERS,
): ClipTiming {
  const clock = stepClock(clip.sourceBpm ?? fallbackBpm ?? 120, clip.sourceTempoMap);
  const offset = clip.offsetIntoSource ?? 0;
  const dur = clip.durationSec;
  const start = clip.startSec;
  // Each note shaped by its articulation; a preset articulation on a slot of its own after the lanes' (clipSlotPlan).
  const { bends, slotOf, laneSlots, arts, noteSlots, artSlots, slots: used } = clipSlotPlan(clip, percussion, program);

  // The expressive notes' member channels, after the lane and articulation channels: the rotation over every one of them, in steps.
  const expressive = percussion ? [] : arts.notes.filter((a) => hasExpression(a.played.expr));
  const spans = expressive.map((a) => ({ start: a.played.step, end: a.played.step + a.played.length }));
  const mpe = membersNeeded(spans, members);
  const memberOf = new Map<object, number>();
  rotateMembers(spans, mpe).forEach((m, i) => {
    if (m >= 0) memberOf.set(expressive[i], m);
  });
  // The expressive notes' own messages, added last so each stands over a channel default or a part's change at its time.
  const exprCtl: TimedCtl[] = [];

  const notes: TimedNote[] = [];
  for (const [i, a] of arts.notes.entries()) {
    const n = a.played;
    const { relStart, relEnd } = clipNoteSpan(n, clock, offset);
    if (relEnd <= 0 || relStart >= dur) continue; // outside this clip's window
    const member = memberOf.get(a);
    const on = start + Math.max(0, relStart);
    notes.push({
      on,
      off: start + Math.min(dur, relEnd),
      midi: n.note,
      velocity: n.velocity,
      slot: member === undefined ? noteSlots[i] : used + member,
      ...(a.target ? { program: a.target.program, bank: a.target.bank } : {}),
    });
    // The member channel takes the note's bend range (RPN 0), bend, timbre and
    // pressure just before the note starts, then each point of the note's
    // curves at its time while the note sounds.
    if (member !== undefined && n.expr) {
      const slot = used + member;
      const m = expressionMessages(n.expr);
      exprCtl.push({ t: on, slot, kind: 'range', value: noteBendRange(n.expr) });
      exprCtl.push({ t: on, slot, kind: 'wheel', value: m.wheel });
      exprCtl.push({ t: on, slot, kind: 'cc', controller: 74, value: m.timbre });
      exprCtl.push({ t: on, slot, kind: 'pressure', value: m.pressure });
      const off = start + Math.min(dur, relEnd);
      for (const e of expressionCurveSteps(n.expr)) {
        const t = start + clock.at(n.step + e.tick / TICKS_PER_STEP) - offset;
        if (t <= on + EPS || t >= off - EPS) continue;
        if (e.kind === 'timbre') exprCtl.push({ t, slot, kind: 'cc', controller: 74, value: e.value });
        else exprCtl.push({ t, slot, kind: e.kind, value: e.value });
      }
    }
  }
  notes.sort(byOn);
  const slots = used + mpe;

  const ctl: TimedCtl[] = [];
  // Every channel the clip uses opens at the clip's start: its range and its
  // wheel where the clip's source begins. A channel no lane bends goes back to
  // the default range at the centre.
  const bentSlots = new Set<number>();
  if (bends) {
    const fromStep = clock.stepAt(offset);
    const toStep = clock.stepAt(offset + dur);
    for (const [lane, played] of bends.played) {
      const slot = slotOf.get(lane) ?? 0;
      bentSlots.add(slot);
      ctl.push({ t: start, slot, kind: 'range', value: played.range });
      ctl.push({ t: start, slot, kind: 'wheel', value: bendValueToRaw(bendValueAt(played.points, fromStep)) });
      const last = played.points.length ? played.points[played.points.length - 1].step : fromStep;
      for (const e of bendWheelEvents(played.points, fromStep, Math.min(toStep, last), false, played.range)) {
        const t = start + clock.at(e.step) - offset;
        if (t > start + EPS && t < start + dur) ctl.push({ t, slot, kind: 'wheel', value: e.raw });
      }
    }
    // An articulation slot of a bent lane takes the lane's range and wheel, so its notes bend with the lane.
    const laneCtl = ctl.slice();
    artSlots.forEach((a, i) => {
      if (a.follows === null) return;
      const slot = laneSlots + i;
      bentSlots.add(slot);
      for (const c of laneCtl) if (c.slot === a.follows) ctl.push({ ...c, slot });
    });
  }
  for (let slot = 0; slot < slots; slot += 1) {
    if (bentSlots.has(slot)) continue;
    ctl.push({ t: start, slot, kind: 'range', value: DEFAULT_BEND_RANGE });
    ctl.push({ t: start, slot, kind: 'wheel', value: BEND_CENTER });
  }
  // Where the clip ends its member channels rest: CC 74 at its centre and no pressure.
  for (let slot = used; slot < slots; slot += 1) {
    ctl.push({ t: start + dur, slot, kind: 'reset', controller: 74, value: TIMBRE_REST });
    ctl.push({ t: start + dur, slot, kind: 'pressure', value: 0 });
  }
  // The part's controllers act on a channel, so each goes to every channel the clip plays on.
  const controls = clipControlTimes({ ...clip, offsetIntoSource: offset }, fallbackBpm ?? 120);
  const held = new Map<number, number>();
  if (controls.length) {
    for (const c of controls) {
      held.set(c.controller, c.value);
      for (let slot = 0; slot < slots; slot += 1) ctl.push({ t: c.sec, slot, kind: 'cc', controller: c.controller, value: c.value });
    }
    // Where the clip ends, each controller it left off its default goes back, the pedal first.
    const resets = [...held.entries()]
      .filter(([controller, value]) => value !== (partController(controller)?.initial ?? value))
      .sort(([a], [b]) => pedalFirst(a, b));
    for (const [controller] of resets) {
      const value = partController(controller)?.initial ?? 0;
      for (let slot = 0; slot < slots; slot += 1) ctl.push({ t: start + dur, slot, kind: 'reset', controller, value });
    }
  }
  ctl.push(...exprCtl);
  // Stable: at one time a channel's range stays ahead of its wheel, and its controllers keep their order.
  ctl.sort((a, b) => a.t - b.t);
  return { notes, ctl, slots, controllers: [...held.keys()].sort(pedalFirst) };
}

/** The first index in `xs` whose key is at or past `t`. */
function lowerBound<T>(xs: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(xs[mid]) < t - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A message the tick hands over, ordered at one time as a MIDI file orders
 * them: off, a channel's defaults where a pass opens it (the pedal first), a
 * controller put back at a clip's end, a controller change, range, wheel, on.
 * The defaults and a reset come before a change at one time, so a clip's own
 * value, set where the pass opens or where the clip before it ends, stands.
 */
interface Out {
  time: number;
  order: number;
  send: () => void;
}

/** The `order` of a channel's defaults where a pass opens it: after a note-off, before a clip end's reset (0.1). */
const DEFAULTS_ORDER = 0.01;
/** The `order` of a controller put back at a clip's end, or when a clip stops playing live part way. */
const RESET_ORDER = 0.1;

/**
 * The controllers a live clip set on its channels this pass (ClipTiming
 * `controllers`), so they can go back if the clip stops playing live before
 * its end hands over its own resets.
 */
interface HeldControls {
  channels: number[];
  controllers: number[];
  /** Where the clip ends on the transport. */
  end: number;
  /** The context time of its latest change handed over (it may still wait in the synth's queue). */
  lastAt: number;
  /** True once any of its changes was handed over. */
  sent: boolean;
  /** True once its end's resets were handed over. */
  ended: boolean;
}

/** A note-on handed to the synth, until its note-off is. */
interface Sounding {
  clipId: string;
  channel: number;
  midi: number;
  off: number; // transport seconds
}

/** A note-on waiting in the synth's queue (its time still ahead of the clock). */
interface Queued {
  channel: number;
  midi: number;
  time: number;
}

/** What a track's envelope follows, and the clip fields it was scheduled from. */
interface EnvelopeOwner {
  clipId: string;
  sig: string;
}

const envelopeSig = (c: AudioClip): string =>
  `${c.startSec}|${c.durationSec}|${c.gain ?? ''}|${c.fadeInSec ?? ''}|${c.fadeOutSec ?? ''}|${c.fadeInCurve ?? ''}|${c.fadeOutCurve ?? ''}`;

const muteSoloOpen = (t: EditorTrack, anySolo: boolean): boolean => !t.mute && !(anySolo && !t.solo);

/**
 * The rolling-lookahead scheduler. It owns no timer: `tick()` is public, and
 * liveMixer (or a test) decides when it runs. One instance lives across passes,
 * so a pass can see what the one before it left in the synth's queue.
 */
export class EditMidiScheduler {
  private readonly deps: EditMidiSchedulerDeps;
  private running = false;
  private first = false;
  private pass: EditMidiPass = { liveClipIds: new Set(), channelsOf: new Map() };
  private anchorCtx = 0;
  private anchorT = 0;
  private fromT = 0;
  private cursor = 0;
  private endAt: () => number = () => Infinity;
  private sounding: Sounding[] = [];
  private queued: Queued[] = [];
  /** Per channel: the latest wheel or range message queued, so a new pass's wheel waits for it. */
  private ctlQueued = new Map<number, number>();
  private ctlFloor = new Map<number, number>();
  /** The reverb send (CC 91) each channel was last opened with, where a pass set one. */
  private reverbSent = new Map<number, number>();
  private envelopes = new Map<string, EnvelopeOwner>();
  /** The live clips whose controllers are on their channels, by clip id (HeldControls). */
  private held = new Map<string, HeldControls>();
  /** The clips the last tick played live, so a clip that starts playing part way is seen. */
  private lastLive: ReadonlySet<string> = new Set();
  private timing = new WeakMap<object, { bpm: number | undefined; percussion: boolean; program: number | undefined; members: number; timing: ClipTiming }>();
  /** The value each automated controller holds on its track's channels this pass, by `${trackId}:${controller}`. */
  private ccHeld = new Map<string, number>();
  /** Channels a controller outside ALWAYS_OPENED was sent to, by `${channel}:${controller}`: the next pass puts it back there. */
  private moved = new Set<string>();
  private counts: EditMidiStats = { notes: 0, chased: 0, late: 0, skipped: 0 };

  constructor(deps: EditMidiSchedulerDeps) {
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** What the current (or last) pass did. */
  get stats(): EditMidiStats {
    return { ...this.counts };
  }

  /**
   * Time every clip `pass` plays live, ahead of `start`. Timing a clip walks
   * all its notes (about 2 ms for 4000), so a caller that takes its anchor
   * after this keeps that work out of the first window.
   */
  prepare(pass: EditMidiPass): void {
    const trackById = new Map<string, EditorTrack>(this.deps.tracks().map((t): [string, EditorTrack] => [t.id, t]));
    const bpm = this.deps.projectBpm();
    for (const clip of this.deps.clips()) {
      if (!pass.liveClipIds.has(clip.id)) continue;
      const track = trackById.get(clip.trackId);
      this.timingOf(clip, bpm, isPercussionTrack(track), track ? effectiveProgramFor(clip, track, this.deps.global()) : undefined, trackMembers(track?.mpeChannels));
    }
  }

  /**
   * Start a pass: transport second `fromSec` sounds at context time
   * `anchorCtx`, and nothing is scheduled at or past `endSec()` (read every
   * tick: the loop's end, or the song's). The first window is scheduled now.
   */
  start(pass: EditMidiPass, fromSec: number, anchorCtx: number, endSec: () => number = () => Infinity): void {
    const now = this.deps.now();
    this.pass = pass;
    this.anchorCtx = anchorCtx;
    this.anchorT = fromSec;
    this.fromT = fromSec;
    this.cursor = fromSec;
    this.endAt = endSec;
    this.sounding = [];
    this.envelopes = new Map();
    // The pass opens every channel at the defaults, so no clip's controllers are held yet.
    this.held = new Map();
    this.ccHeld = new Map();
    this.lastLive = new Set();
    this.counts = { notes: 0, chased: 0, late: 0, skipped: 0 };
    // A wheel message of this pass on a channel waits until the last stale one
    // queued there has passed.
    this.ctlFloor = new Map([...this.ctlQueued].filter(([, t]) => t > now));
    this.queued = [];
    this.running = true;
    this.first = true;
    this.tick();
  }

  /**
   * End the pass: every note-on still waiting in the synth's queue gets a
   * note-off at its own time, and nothing more is handed over. Notes already
   * sounding are the caller's to silence (soundfontEngine editAllNotesOff).
   */
  stop(): void {
    if (!this.running) return;
    const now = this.deps.now();
    for (const q of this.queued) {
      if (q.time <= now) continue;
      this.deps.sink.noteOff(q.channel, q.midi, q.time);
    }
    this.queued = [];
    this.sounding = [];
    this.running = false;
  }

  private ctxOf(t: number): number {
    return this.anchorCtx + (t - this.anchorT);
  }

  private timingOf(clip: AudioClip, bpm: number | undefined, percussion: boolean, program: number | undefined, members: number): ClipTiming {
    const hit = this.timing.get(clip);
    if (hit && hit.bpm === bpm && hit.percussion === percussion && hit.program === program && hit.members === members) return hit.timing;
    const timing = clipLiveTiming(clip, bpm, percussion, program, members);
    this.timing.set(clip, { bpm, percussion, program, members, timing });
    return timing;
  }

  /** Schedule the track's envelope for `clip` from transport second `fromT` on. */
  private scheduleEnvelope(trackId: string, clip: AudioClip, fromT: number, now: number): void {
    this.envelopes.set(trackId, { clipId: clip.id, sig: envelopeSig(clip) });
    const param = this.deps.envelope?.(trackId);
    if (!param) return;
    const at = Math.max(now, this.ctxOf(fromT));
    param.cancelScheduledValues(at);
    applyFadeAutomation(param, clip, this.ctxOf(clip.startSec), Math.max(0, fromT - clip.startSec), { peak: clipPeakGain(clip) });
  }

  /** One pass of the lookahead. Safe to call at any rate, including too often. */
  tick(): void {
    if (!this.running) return;
    const { sink } = this.deps;
    const now = this.deps.now();
    const nowT = this.anchorT + (now - this.anchorCtx);
    const lookahead = Math.max(0, this.deps.lookaheadSec?.() ?? EDIT_MIDI_LOOKAHEAD_SEC);
    const lateSec = this.deps.lateSec ?? EDIT_MIDI_LATE_SEC;
    // The window is [cursor, until); a tick that comes early finds it empty.
    const until = Math.max(this.cursor, Math.min(nowT + lookahead, this.endAt()));
    const from = this.cursor;
    const first = this.first;
    this.first = false;
    this.queued = this.queued.filter((q) => q.time > now);

    const clips = this.deps.clips();
    const tracks = this.deps.tracks();
    const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
    const anySolo = tracks.some((t) => t.solo);
    const global = this.deps.global();
    const bpm = this.deps.projectBpm();
    const out: Out[] = [];
    const live = new Set<string>();
    // Every controller change goes through here, so a pass knows which channels moved brightness or the reverb send.
    const control = (channel: number, controller: number, value: number, t: number): void => {
      if (!ALWAYS_OPENED.has(controller)) this.moved.add(`${channel}:${controller}`);
      sink.control(channel, controller, value, t);
    };

    // A channel message at `time`, held until after the last stale one a stopped
    // pass left queued on its channel. Returns the time it goes at.
    const pushAt = (channel: number, time: number, order: number, send: (at: number) => void): number => {
      const floor = this.ctlFloor.get(channel);
      const at = floor !== undefined && time <= floor ? floor + AFTER_STALE_SEC : time;
      out.push({ time: at, order, send: () => send(at) });
      this.ctlQueued.set(channel, Math.max(this.ctlQueued.get(channel) ?? 0, at));
      return at;
    };
    const pushCtl = (channel: number, c: TimedCtl, time: number): number => {
      const controller = c.controller ?? 0;
      if (c.kind === 'range') return pushAt(channel, time, 0.25, (at) => sink.wheelRange(channel, c.value, at));
      if (c.kind === 'wheel') return pushAt(channel, time, 0.5, (at) => sink.wheel(channel, c.value, at));
      if (c.kind === 'pressure') return pushAt(channel, time, 0.3, (at) => sink.pressure?.(channel, c.value, at));
      return pushAt(channel, time, c.kind === 'reset' ? RESET_ORDER : 0.2, (at) => control(channel, controller, c.value, at));
    };

    // The pass opens every channel it plays on at the General MIDI defaults, the
    // pedal first, ahead of any clip's own state at the same time.
    if (first) {
      const at = Math.max(now, this.ctxOf(this.fromT));
      const channels = new Set<number>();
      for (const chans of this.pass.channelsOf.values()) for (const ch of chans) channels.add(ch);
      for (const channel of [...channels].sort((a, b) => a - b)) {
        CHANNEL_DEFAULTS.forEach((d, i) => {
          const key = `${channel}:${d.controller}`;
          if (!ALWAYS_OPENED.has(d.controller) && !this.moved.has(key)) return;
          this.moved.delete(key);
          pushAt(channel, at, DEFAULTS_ORDER + i * 1e-3, (t) => sink.control(channel, d.controller, d.value, t));
        });
      }
      // The track's reverb send (EditorTrack synthReverbSend, CC 91) after the
      // defaults. A channel a pass set a send on and whose track now names none
      // goes back to 0, the synth's reset, so no track inherits another's send.
      const sendOrder = DEFAULTS_ORDER + CHANNEL_DEFAULTS.length * 1e-3;
      for (const [trackId, chans] of this.pass.channelsOf) {
        const send = synthReverbSendOf(trackById.get(trackId));
        for (const channel of chans) {
          const value = send ?? (this.reverbSent.get(channel) ? 0 : undefined);
          if (value === undefined) continue;
          pushAt(channel, at, sendOrder, (t) => sink.control(channel, REVERB_SEND_CC, value, t));
          if (value) this.reverbSent.set(channel, value);
          else this.reverbSent.delete(channel);
        }
      }
    }

    // Controller automation: each enabled trackMidiCc lane's changes on its track's channels.
    const ccLanes = trackCcLanes(this.deps.automation?.());
    const automated = automatedControllers(ccLanes);
    const liveCc = new Set<string>();
    for (const l of ccLanes) {
      const chans = this.pass.channelsOf.get(l.trackId);
      if (!chans?.length) continue;
      const key = `${l.trackId}:${l.controller}`;
      liveCc.add(key);
      let held = this.ccHeld.get(key) ?? null;
      if (held === null) {
        // Where the lane comes in (the pass's start, or now for a lane added while playing): its value there.
        const joinT = first ? this.fromT : Math.max(from, nowT);
        held = ccLaneValueAt(l.lane, joinT);
        const at = Math.max(now, this.ctxOf(joinT));
        const value = held;
        for (const channel of chans) pushAt(channel, at, 0.2, (t) => control(channel, l.controller, value, t));
      }
      const { events, held: after } = ccLaneEvents(l.lane, Math.max(from, first ? this.fromT + 1e-6 : from), until, held);
      for (const e of events) {
        const at = Math.max(now, this.ctxOf(e.sec));
        for (const channel of chans) pushAt(channel, at, 0.2, (t) => control(channel, l.controller, e.value, t));
      }
      if (after !== null) this.ccHeld.set(key, after);
    }
    // A lane that went puts its controller back where the channel starts.
    for (const key of [...this.ccHeld.keys()]) {
      if (liveCc.has(key)) continue;
      this.ccHeld.delete(key);
      const cut = key.lastIndexOf(':');
      const trackId = key.slice(0, cut);
      const controller = Number(key.slice(cut + 1));
      const value = partController(controller)?.initial ?? 0;
      for (const channel of this.pass.channelsOf.get(trackId) ?? []) pushAt(channel, now, RESET_ORDER, (t) => sink.control(channel, controller, value, t));
    }

    const pushOn = (clipId: string, channel: number, voice: LiveVoice, n: TimedNote, time: number) => {
      // A note of this key still held on the channel ends where this one starts,
      // or its later note-off would cut this one.
      for (let i = this.sounding.length - 1; i >= 0; i -= 1) {
        const s = this.sounding[i];
        if (s.channel !== channel || s.midi !== n.midi || s.off <= n.on + EPS) continue;
        out.push({ time, order: 0, send: () => sink.noteOff(channel, n.midi, time) });
        this.sounding.splice(i, 1);
      }
      // A note an articulation plays in a preset of its own (on its own slot) takes that preset.
      const v = n.program !== undefined ? { program: n.program, bank: n.bank ?? 0, bankLsb: undefined } : voice;
      out.push({ time, order: 1, send: () => sink.noteOn(channel, v.program, n.midi, n.velocity, time, v.bank, v.bankLsb) });
      if (time > now) this.queued.push({ channel, midi: n.midi, time });
      this.sounding.push({ clipId, channel, midi: n.midi, off: n.off });
      this.counts.notes += 1;
    };

    for (const clip of clips) {
      if (!this.pass.liveClipIds.has(clip.id) || clip.muted) continue;
      const track = trackById.get(clip.trackId);
      const chans = track ? this.pass.channelsOf.get(track.id) : undefined;
      if (!track || !chans?.length) continue;
      // An external-only track plays to its MIDI port with no program of theDAW's.
      const external = isExternalOnly(track);
      const program = external ? NO_PROGRAM : effectiveProgramFor(clip, track, global);
      if (program === undefined) continue;
      const { bank, bankLsb } = external ? { bank: 0, bankLsb: undefined } : clipBankSelect(clipVoice(clip, track, global), clip.sourceRollPart);
      const voice: LiveVoice = { program, bank, bankLsb };
      live.add(clip.id);
      const percussion = isPercussionTrack(track);
      const timing = this.timingOf(clip, bpm, percussion, program, trackMembers(track.mpeChannels));
      const chOf = (slot: number) => chans[Math.min(slot, chans.length - 1)];
      const clipEnd = clip.startSec + clip.durationSec;
      const open = muteSoloOpen(track, anySolo);
      // The controllers the track's automation owns: the clip's own changes of them are left out.
      const owned = automated.get(track.id);
      const ownCtl = (c: TimedCtl): boolean => !owned || (c.kind !== 'cc' && c.kind !== 'reset') || !owned.has(c.controller ?? -1);

      // Envelope: a clip entering the window takes the track's envelope at its
      // start; playback starting inside a clip takes it from there; an edit to
      // the gain or fades of the clip that holds it reschedules it from now.
      const owner = this.envelopes.get(track.id);
      if (first && clip.startSec < this.fromT - EPS && clipEnd > this.fromT + EPS) {
        this.scheduleEnvelope(track.id, clip, this.fromT, now);
      } else if (clip.startSec >= from - EPS && clip.startSec < until - EPS) {
        this.scheduleEnvelope(track.id, clip, clip.startSec, now);
      } else if (owner?.clipId === clip.id && owner.sig !== envelopeSig(clip) && clipEnd > nowT) {
        this.scheduleEnvelope(track.id, clip, Math.max(nowT, clip.startSec), now);
      } else if (!owner && clip.startSec < nowT && clipEnd > nowT) {
        // A clip unmuted (or given a program) mid-way takes the envelope from now.
        this.scheduleEnvelope(track.id, clip, nowT, now);
      }

      // Channel messages: where each channel is at the point the clip starts being
      // heard inside its window (the start point of a pass, or where a clip unmuted
      // or given a program part way comes in), then the window's.
      const joinAt = first ? this.fromT : this.lastLive.has(clip.id) ? null : from;
      // The latest controller change of the clip handed over this tick.
      let lastCc = -Infinity;
      const noteCc = (c: TimedCtl, at: number) => {
        if (c.kind === 'cc' || c.kind === 'reset') lastCc = Math.max(lastCc, at);
      };
      if (joinAt !== null && clip.startSec < joinAt - EPS && clipEnd > joinAt + EPS) {
        const lastOf = new Map<string, TimedCtl>();
        for (const c of timing.ctl) {
          if (c.t > joinAt + EPS) break;
          // A controller keeps one value per channel, whether a change or a reset set it.
          const kind = c.kind === 'reset' ? 'cc' : c.kind;
          lastOf.set(`${c.slot}:${kind}:${c.controller ?? ''}`, c);
        }
        const at = Math.max(now, this.ctxOf(joinAt));
        for (const c of [...lastOf.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'range' ? -1 : 1))) {
          if (ownCtl(c)) noteCc(c, pushCtl(chOf(c.slot), c, at));
        }
      }
      for (let i = lowerBound(timing.ctl, from, (c) => c.t); i < timing.ctl.length; i += 1) {
        const c = timing.ctl[i];
        if (c.t >= until - EPS) break;
        if (ownCtl(c)) noteCc(c, pushCtl(chOf(c.slot), c, Math.max(now, this.ctxOf(c.t))));
      }
      // What the clip's controllers left on its channels, so they go back if it stops playing live first.
      if (timing.controllers.length) {
        const h = this.held.get(clip.id) ?? { channels: [], controllers: [], end: clipEnd, lastAt: -Infinity, sent: false, ended: false };
        h.channels = [...new Set(Array.from({ length: timing.slots }, (_, slot) => chOf(slot)))];
        h.controllers = timing.controllers;
        h.end = clipEnd;
        if (lastCc > -Infinity) {
          h.sent = true;
          h.lastAt = Math.max(h.lastAt, lastCc);
        }
        // The window reached its end, where its own resets go out.
        if (clipEnd >= from - EPS && clipEnd < until - EPS) h.ended = true;
        this.held.set(clip.id, h);
      }

      if (!open) continue;
      // Chase: notes sounding where playback starts start there.
      if (first && !percussion) {
        for (const n of timing.notes) {
          if (n.on >= this.fromT - EPS) break;
          if (n.off <= this.fromT + EPS) continue;
          pushOn(clip.id, chOf(n.slot), voice, n, Math.max(now, this.ctxOf(this.fromT)));
          this.counts.chased += 1;
        }
      }
      for (let i = lowerBound(timing.notes, from, (n) => n.on); i < timing.notes.length; i += 1) {
        const n = timing.notes[i];
        if (n.on >= until - EPS) break;
        const at = this.ctxOf(n.on);
        if (at < now - lateSec) {
          // Late: chase a note still sounding, skip one that is over.
          if (!percussion && n.off > nowT + EPS) {
            pushOn(clip.id, chOf(n.slot), voice, n, now);
            this.counts.late += 1;
          } else {
            this.counts.skipped += 1;
          }
          continue;
        }
        pushOn(clip.id, chOf(n.slot), voice, n, Math.max(now, at));
      }
    }

    // A clip that stopped playing live part way (muted, deleted, left with no
    // program), or whose end the pass went past without its resets (moved behind
    // the playhead), puts back the controllers it set, the pedal first, after its
    // last change that may still wait in the synth's queue.
    for (const [clipId, h] of this.held) {
      if (h.ended) {
        this.held.delete(clipId);
        continue;
      }
      if (live.has(clipId) && h.end >= from - EPS) continue;
      this.held.delete(clipId);
      if (!h.sent) continue;
      const at = Math.max(now, h.lastAt + AFTER_STALE_SEC);
      for (const channel of h.channels) {
        for (const controller of h.controllers) {
          const value = partController(controller)?.initial ?? 0;
          pushAt(channel, at, RESET_ORDER, (t) => sink.control(channel, controller, value, t));
        }
      }
    }

    // Note-offs: a note whose clip went away, was muted or stopped playing live
    // ends now; every other ends at its time once that falls in the window.
    const keep: Sounding[] = [];
    for (const s of this.sounding) {
      if (!live.has(s.clipId)) {
        out.push({ time: now, order: 0, send: () => sink.noteOff(s.channel, s.midi, now) });
      } else if (s.off < until - EPS) {
        const at = Math.max(now, this.ctxOf(s.off));
        out.push({ time: at, order: 0, send: () => sink.noteOff(s.channel, s.midi, at) });
      } else {
        keep.push(s);
      }
    }
    this.sounding = keep;

    out.sort((a, b) => a.time - b.time || a.order - b.order);
    for (const o of out) o.send();
    if (until > this.cursor) this.cursor = until;
    this.lastLive = live;
  }
}
