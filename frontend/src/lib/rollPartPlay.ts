/**
 * rollPartPlay — the piano roll's playback scheduler, every part at once.
 *
 * PLAY runs a lookahead scheduler on the audio clock: every 25 ms it reads the
 * roll and schedules each note starting in the next ROLL_LOOKAHEAD_SEC at its
 * exact context time, which the roll's tempo map gives every step
 * (lib/rollTempo). A late timer tick schedules a note late only when the note
 * is already due; it never moves when a note sounds, so the parts stay in time
 * with each other and with anything else on the engine's clock.
 *
 * This module is that scheduler with nothing audible in it: `tick` returns the
 * notes and pitch wheel messages to send, and the roll's transport
 * (PianoRoll.tsx) sends them. A node test drives the same code on a simulated
 * clock.
 *
 * Parts: every part sounds unless muted, or unless another part is soloed
 * (lib/rollTracks audiblePartIds), each with its own voice and on its own live
 * channel (rollLiveChannels), so 24 parts play 24 programs at once. Each tick
 * reads the parts, so a mute, a solo, a program or a note edit while playing
 * changes what plays next without a restart.
 *
 * Pitch bend: a soundfont wheel bends a whole channel, so each bent lane of a
 * part plays on a channel of its own, and each tick sends that channel's wheel
 * messages for the window it schedules notes in. A built-in voice follows its
 * lane's curve through automation scheduled with the note.
 *
 * Articulations: each note plays shaped by its articulation (a staccato at
 * half its written length), and an articulation a soundfont holds as a preset
 * of its own (a string part's pizzicato, GM 46) plays that preset on a
 * channel of its own (lib/articulationMap articulatedNotes, lib/rollTracks
 * rollLiveChannels `arts`), so the part's other notes keep their program. The
 * part's controllers go to those channels too.
 *
 * Controllers: a soundfont part's controller changes (RollTrack `controls`:
 * modulation, volume, pan, expression, the sustain pedal) go out on every
 * channel the part plays on, each at its step's context time, in the same
 * window as the notes. Where playback starts, seeks, re-anchors or loops back,
 * each channel first gets the value every controller holds there
 * (lib/rollTracks controlStateBefore), so a part started halfway has the
 * volume and pedal it has at that bar. A part that falls silent (muted, or
 * another part soloed) and STOP put its controllers back where a channel
 * starts, pedal up first, so a held pedal never outlives its part.
 *
 * Expression: a note with pressure, timbre or bend of its own (PianoNote
 * `expr`) plays MPE-style on a member channel of its part's (lib/rollTracks
 * `mpe`), taken in rotation (lib/mpeRotation): just before it starts, that
 * channel gets the note's bend range (RPN 0, `bendRange`, else 2), its bend,
 * CC 74 and channel pressure, and each point of its curves goes out at its
 * time while the note sounds. STOP puts the member channels back at rest.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { RollControl, RollTrack } from '../state/pianoRollStore';
import { unrollLanes, type PolyLane } from './meterMap';
import {
  BEND_CENTER,
  DEFAULT_BEND_RANGE,
  bentLanes,
  loopedBendAutomation,
  loopedWheelEvents,
  playedRollBends,
  playingLane,
  shiftPlayedBends,
  type LaneBend,
  type PlayedBend,
} from './pitchBend';
import { BEND_TAIL_SEC, type VoiceBend } from './pitchBendVoice';
import {
  followRollPlay,
  lapAbsAt,
  lapLocalTime,
  lapTimeOf,
  spanSec,
  startRollPlay,
  stepsIn,
  type RollPlaySource,
  type RollPlayState,
} from './rollTempo';
import { REANCHOR_STEPS, rollStepAt, shownStep, windowOnsets } from './rollTransport';
import { TICKS_PER_STEP } from './rollSnap';
import { audiblePartIds, controlStateBefore, partController, rollLiveChannels, type PartLiveChannels } from './rollTracks';
import { articulatedNotes, type ArticulatedNote, type SoundfontArticulationTarget } from './articulationMap';
import type { PianoNote } from '../state/pianoRollStore';
import { MPE_DEFAULT_MEMBERS, TIMBRE_REST, expressionCurveSteps, expressionMessages, hasExpression, membersNeeded, noteBendRange } from './mpeRotation';

/** Seconds the scheduler plans ahead each tick: its notes, and the roll's click. */
export const ROLL_LOOKAHEAD_SEC = 0.12;
/** Milliseconds between the scheduler's ticks. */
export const ROLL_TICK_MS = 25;
/** The most lap starts one window sends controller states for. */
const MAX_LAP_STARTS = 64;
/** The controllers of a part that has none: one list, so a rebuilt plan sees no change in them. */
const NO_CONTROLS: readonly RollControl[] = Object.freeze([]);

/** The roll as the scheduler reads it each tick. `tracks` is every part with its real notes (pianoRollStore rollTracksOf). */
export interface RollSchedulerSource extends RollPlaySource {
  tracks: readonly RollTrack[];
  lanes: readonly PolyLane[];
  bends: readonly LaneBend[];
}

/** A part's voice for this tick: the program and bank it sounds, and whether it is on a drum channel. No program is the built-in voice. */
export interface SchedulerVoice {
  program?: number;
  bank?: number;
  percussion: boolean;
}

/** One note to sound, at context time `when` for `duration` seconds. */
export interface ScheduledRollNote {
  partId: string;
  note: number;
  velocity: number;
  when: number;
  duration: number;
  /** The live soundfont channel (its part's, or its bent lane's). */
  channel: number;
  program?: number;
  bank?: number;
  percussion: boolean;
  /** The curve a built-in voice follows; none on the soundfont, whose channel wheel bends it. */
  bend?: VoiceBend;
  /** The note's roll step, and the absolute step (from PLAY) it sounds at. */
  step: number;
  abs: number;
}

/**
 * A channel message for the soundfont, at `time` (now when absent): a pitch
 * wheel message (`value` 0-16383), a bend range (`value` in semitones), a
 * controller change (`controller`, `value` 0-127), or channel pressure
 * (`value` 0-127, an expressive note's on its member channel).
 */
export interface ScheduledWheel {
  kind: 'wheel' | 'range' | 'control' | 'pressure';
  channel: number;
  value: number;
  /** The controller number of a 'control' message. */
  controller?: number;
  time?: number;
}

export interface RollTickResult {
  notes: ScheduledRollNote[];
  /** Every pitch wheel, bend range and controller message for the window, in time order per channel. */
  wheels: ScheduledWheel[];
  /** The step the playhead shows now. */
  shownStep: number;
}

/** A part's controller change placed on the step grid, as windowOnsets reads items. */
interface ControlItem {
  step: number;
  controller: number;
  value: number;
}

/** A part's notes as they sound (lane repeats written out), its live channels and its controller changes. */
interface PartPlan {
  id: string;
  played: PianoNote[];
  channels: PartLiveChannels;
  /** Every channel the part plays on (its own and its bent lanes'), each once. */
  channelList: number[];
  controls: readonly RollControl[];
  controlItems: ControlItem[];
  /** Each played note as its articulation plays it, by the played note. */
  arts: Map<PianoNote, ArticulatedNote<PianoNote>>;
  /** The soundfont presets its articulations play in, one channel each (`channels.arts`). */
  artTargets: SoundfontArticulationTarget[];
  /** Each articulated note's articulation channel, as an index into `channels.arts`. */
  artIndex: Map<PianoNote, number>;
  /** The bent lane each articulation channel follows (its wheel goes there too), or null. */
  artFollows: Array<number | null>;
}

export interface RollScheduler {
  /** Schedule the window from the last tick to `now` + the lookahead. */
  tick: (now: number, roll: RollSchedulerSource, voiceOf: (partId: string) => SchedulerVoice | undefined) => RollTickResult;
  /**
   * Put every bent channel back at the centre and the default range, and every
   * controller this playback sent back where a channel starts (pedal up
   * first), after every message already sent: STOP.
   */
  release: (now: number) => ScheduledWheel[];
  /** The lap and its clock as the last tick left them (the click reads them). */
  state: () => RollPlayState;
}

/**
 * The controller values to send where playback lands on `tick`: each
 * controller's state just before it (lib/rollTracks controlStateBefore),
 * leaving out a controller that changes AT `tick`, since its change plays
 * there in the same window.
 */
function stateToSend(controls: readonly RollControl[], tick: number): Array<[number, number]> {
  const changing = new Set(controls.filter((c) => Math.abs(c.tick - tick) < 0.5).map((c) => c.controller));
  return [...controlStateBefore(controls, tick)].filter(([controller]) => !changing.has(controller));
}

/** The channels a part's bent lane `lane` bends: its own, and each articulation channel that follows it. */
function laneWheelChannels(plan: PartPlan, lane: number): number[] {
  const out = [plan.channels.lanes.get(lane) as number];
  plan.artFollows.forEach((f, i) => {
    const ch = plan.channels.arts?.[i];
    if (f === lane && ch !== undefined) out.push(ch);
  });
  return out;
}

/** A scheduler for PLAY starting with absolute step 0 at context time `origin`. */
export function createRollScheduler(roll: RollSchedulerSource, origin: number, lookahead = ROLL_LOOKAHEAD_SEC): RollScheduler {
  let playState = startRollPlay(roll, origin);
  let cursor = -REANCHOR_STEPS; // absolute step scheduled up to (inclusive)
  // Unrolled once per part, lane, length or bend edit, not once per tick.
  let source: { tracks: readonly RollTrack[]; lanes: readonly PolyLane[]; total: number; bends: readonly LaneBend[]; voices: string } | null = null;
  let plans: PartPlan[] = [];
  let bent = new Map<number, PlayedBend>();
  let lapCurves = bent;
  let lapCurvesOf: { bent: Map<number, PlayedBend>; start: number } | null = null;
  // Channels this playback has bent, with the range last sent, and the latest wheel message time.
  const wheelRanges = new Map<number, number>();
  let lastWheelTime = 0;
  // The next tick first sends each bent channel where its curve is: at the start, and after a bend, lane, length, loop or seek.
  let wheelFresh = true;
  // Controllers: each channel's controllers this playback has sent (STOP and a
  // part falling silent put them back), the parts whose controllers are on
  // their channels now, and the latest controller message time.
  const controlTouched = new Map<number, Set<number>>();
  const controlLive = new Set<string>();
  let lastControlTime = 0;
  // The next tick first sends every sounding part's controller state where it
  // resumes: at the start, and after a seek, a re-anchor, or a change of the
  // parts' controllers or channels.
  let controlFresh = true;
  // Each part's controllers and channels as the last plan had them, so a change is seen.
  let controlShape = new Map<string, { controls: readonly RollControl[]; channels: string }>();
  // Member channels: the context time each one's last note ends, and the ones this playback has set.
  const memberBusy = new Map<number, number>();
  const memberTouched = new Set<number>();
  let lastMemberTime = 0;
  /** A member channel for a note from `when` to `end`: the one free longest, else the one whose note ends first (lib/mpeRotation). */
  const takeMember = (channels: readonly number[], when: number, end: number): number => {
    let pick = -1;
    for (const ch of channels) {
      const busy = memberBusy.get(ch) ?? -Infinity;
      if (busy > when + 1e-9) continue;
      if (pick < 0 || busy < (memberBusy.get(pick) ?? -Infinity)) pick = ch;
    }
    if (pick < 0) {
      pick = channels[0];
      for (const ch of channels) if ((memberBusy.get(ch) ?? -Infinity) < (memberBusy.get(pick) ?? -Infinity)) pick = ch;
    }
    memberBusy.set(pick, Math.max(memberBusy.get(pick) ?? -Infinity, end));
    return pick;
  };

  const releaseWheel = (ch: number, now: number, out: ScheduledWheel[]) => {
    const at = Math.max(now, lastWheelTime) + 0.001;
    out.push({ kind: 'wheel', channel: ch, value: BEND_CENTER, time: at });
    out.push({ kind: 'range', channel: ch, value: DEFAULT_BEND_RANGE, time: at });
    wheelRanges.delete(ch);
  };

  /** Put `channels`' controllers back where a channel starts, at `at`: the pedal first, so nothing it held rings on. */
  const resetControls = (channels: Iterable<number>, at: number, out: ScheduledWheel[]) => {
    for (const ch of channels) {
      const touched = controlTouched.get(ch);
      if (!touched) continue;
      const order = [...touched].sort((a, b) => (a === 64 ? -1 : b === 64 ? 1 : a - b));
      for (const controller of order) out.push({ kind: 'control', channel: ch, controller, value: partController(controller)?.initial ?? 0, time: at });
      controlTouched.delete(ch);
      lastControlTime = Math.max(lastControlTime, at);
    }
  };

  const tick: RollScheduler['tick'] = (now, r, voiceOf) => {
    const { tracks, lanes, bends } = r;
    const total = Math.max(1, r.totalSteps);
    const wheels: ScheduledWheel[] = [];
    const notes: ScheduledRollNote[] = [];
    const followed = followRollPlay(playState, r, cursor);
    // A re-anchored lap sends every bent channel where its curve is at the new
    // place, and every sounding part's controllers as they are there.
    if (followed.lapState !== playState.lapState) {
      wheelFresh = true;
      controlFresh = true;
    }
    playState = followed;
    const { lapState, steps, clock: lc } = playState;
    const { lap } = lapState;
    // The program each part sounds decides what its articulations resolve to.
    const partPrograms = tracks.map((t) => voiceOf(t.id)?.program);
    const voiceSig = partPrograms.map((p) => p ?? '').join(',');
    if (!source || source.tracks !== tracks || source.lanes !== lanes || source.total !== total || source.bends !== bends || source.voices !== voiceSig) {
      if (source && (source.lanes !== lanes || source.total !== total || source.bends !== bends)) wheelFresh = true;
      // A part moved to another channel starts its curve fresh there.
      if (source && source.tracks.length !== tracks.length) wheelFresh = true;
      source = { tracks, lanes, total, bends, voices: voiceSig };
      const unrolled = tracks.map((t) => unrollLanes(t.notes, lanes, total));
      const artsOf = tracks.map((t, i) =>
        articulatedNotes(unrolled[i], { instrumentId: t.instrumentId, program: t.program ?? partPrograms[i] ?? null, percussion: voiceOf(t.id)?.percussion === true }),
      );
      // An articulation channel per preset and bent lane, so a pizzicato in a bent lane bends with it.
      const bentSet = bentLanes(lanes, bends);
      const artPlans = artsOf.map((arts) => {
        const index = new Map<PianoNote, number>();
        const follows: Array<number | null> = [];
        const keyed = new Map<string, number>();
        for (const a of arts.notes) {
          if (!a.target) continue;
          const lane = playingLane(a.note.lane, lanes);
          const follow = bentSet.has(lane) ? lane : null;
          const key = `${a.slot}|${follow ?? '-'}`;
          let k = keyed.get(key);
          if (k === undefined) {
            k = follows.length;
            follows.push(follow);
            keyed.set(key, k);
          }
          index.set(a.note, k);
        }
        return { index, follows };
      });
      // The member channels each part's expressive notes rotate across: as many as sound at once.
      const memberCounts = new Map(
        tracks.map((t, i) => [
          t.id,
          membersNeeded(
            unrolled[i].filter((n) => hasExpression(n.expr)).map((n) => ({ start: n.step, end: n.step + n.length })),
            MPE_DEFAULT_MEMBERS,
          ),
        ]),
      );
      const channels = rollLiveChannels(tracks, lanes, bends, new Map(tracks.map((t, i) => [t.id, artPlans[i].follows.length])), memberCounts);
      plans = tracks.map((t, i) => {
        const ch = channels.get(t.id) as PartLiveChannels;
        const controls = t.controls ?? NO_CONTROLS;
        return {
          id: t.id,
          played: unrolled[i],
          channels: ch,
          channelList: [...new Set([ch.base, ...ch.lanes.values(), ...(ch.arts ?? [])])].sort((a, b) => a - b),
          controls,
          controlItems: controls.map((c) => ({ step: c.tick / TICKS_PER_STEP, controller: c.controller, value: c.value })),
          arts: new Map(artsOf[i].notes.map((a) => [a.note, a])),
          artTargets: artsOf[i].targets,
          artIndex: artPlans[i].index,
          artFollows: artPlans[i].follows,
        };
      });
      bent = playedRollBends(bends, lanes, total);
      // A part whose controllers or channels changed: every channel goes back
      // to where it starts and every sounding part sends its state again, so
      // no channel keeps a value (a held pedal) that no part now owns.
      const shape = new Map(plans.map((p) => [p.id, { controls: p.controls, channels: p.channelList.join(',') }]));
      const changed = shape.size !== controlShape.size
        || [...shape].some(([id, s]) => controlShape.get(id)?.controls !== s.controls || controlShape.get(id)?.channels !== s.channels);
      controlShape = shape;
      if (changed && controlTouched.size) {
        resetControls([...controlTouched.keys()], now, wheels);
        controlLive.clear();
        controlFresh = true;
      }
    }
    if (!lapCurvesOf || lapCurvesOf.bent !== bent || lapCurvesOf.start !== lap.start) {
      lapCurvesOf = { bent, start: lap.start };
      lapCurves = shiftPlayedBends(bent, lap.start);
    }
    const targetAbs = lapAbsAt(lc, now + lookahead);
    const voices = new Map(plans.map((p) => [p.id, voiceOf(p.id) ?? { percussion: false }]));

    // Each soundfont part's bent lanes: their own channels' wheel messages for this window.
    const bentChannels = new Set<number>();
    for (const plan of plans) {
      const voice = voices.get(plan.id) as SchedulerVoice;
      if (voice.program === undefined || voice.percussion) continue;
      for (const lane of plan.channels.bent) if (lapCurves.has(lane)) for (const ch of laneWheelChannels(plan, lane)) bentChannels.add(ch);
    }
    // A channel whose lane stopped bending goes back to the centre.
    for (const ch of [...wheelRanges.keys()]) if (!bentChannels.has(ch)) releaseWheel(ch, now, wheels);
    for (const plan of plans) {
      const voice = voices.get(plan.id) as SchedulerVoice;
      if (voice.program === undefined || voice.percussion) continue;
      for (const lane of plan.channels.bent) {
        const curve = lapCurves.get(lane);
        if (!curve) continue;
        const events = loopedWheelEvents(curve.points, lap.len, cursor - lap.base, targetAbs - lap.base, wheelFresh, curve.range);
        // The lane's channel, and each articulation channel that follows the lane.
        for (const ch of laneWheelChannels(plan, lane)) {
          if (wheelRanges.get(ch) !== curve.range) {
            wheels.push({ kind: 'range', channel: ch, value: curve.range });
            wheelRanges.set(ch, curve.range);
          }
          for (const e of events) {
            const at = Math.max(now, lapTimeOf(lc, e.abs + lap.base));
            wheels.push({ kind: 'wheel', channel: ch, value: e.raw, time: at });
            lastWheelTime = Math.max(lastWheelTime, at);
          }
        }
      }
    }
    wheelFresh = false;

    const audible = audiblePartIds(tracks);

    // Controllers: each sounding soundfont part's changes on every channel it
    // plays on. A part that is not heard puts its channels back.
    const controlOut: Array<{ time: number; order: number; msg: ScheduledWheel }> = [];
    const sendControl = (time: number, order: number, channel: number, controller: number, value: number) => {
      controlOut.push({ time, order, msg: { kind: 'control', channel, controller, value, time } });
      let touched = controlTouched.get(channel);
      if (!touched) controlTouched.set(channel, (touched = new Set()));
      touched.add(controller);
      lastControlTime = Math.max(lastControlTime, time);
    };
    // Where this window resumes: the first absolute step it can schedule, its roll tick and its time.
    const resumeAbs = cursor + REANCHOR_STEPS;
    const resumeTick = rollStepAt(lap, resumeAbs) * TICKS_PER_STEP;
    const resumeTime = Math.max(now, lapTimeOf(lc, resumeAbs));
    for (const plan of plans) {
      const voice = voices.get(plan.id) as SchedulerVoice;
      const sounding = voice.program !== undefined && audible.has(plan.id) && plan.controls.length > 0;
      if (!sounding) {
        if (controlLive.has(plan.id)) {
          const silenced: ScheduledWheel[] = [];
          resetControls(plan.channelList, now, silenced);
          for (const msg of silenced) controlOut.push({ time: now, order: -1, msg });
          controlLive.delete(plan.id);
        }
        continue;
      }
      // The state where playback resumes, once: at the start, after a re-anchor, or when the part is heard again.
      const chased = controlFresh || !controlLive.has(plan.id);
      if (chased) {
        for (const [controller, value] of stateToSend(plan.controls, resumeTick)) {
          for (const ch of plan.channelList) sendControl(resumeTime, 0, ch, controller, value);
        }
        controlLive.add(plan.id);
      }
      // Each time the lap starts over inside the window, the state where it starts.
      const from = chased ? resumeAbs + 1e-9 : cursor;
      const firstLap = Math.max(0, Math.floor((from - lap.base) / lap.len) + 1);
      // At most MAX_LAP_STARTS in one window: a lap that short is a sliver of a step, not a loop anyone hears.
      for (let k = firstLap; k < firstLap + MAX_LAP_STARTS && lap.base + k * lap.len <= targetAbs; k += 1) {
        const at = Math.max(now, lapTimeOf(lc, lap.base + k * lap.len));
        for (const [controller, value] of stateToSend(plan.controls, lap.start * TICKS_PER_STEP)) {
          for (const ch of plan.channelList) sendControl(at, 0, ch, controller, value);
        }
      }
      for (const { note: c, abs } of windowOnsets(plan.controlItems, lap, cursor, targetAbs)) {
        const at = Math.max(now, lapTimeOf(lc, abs));
        for (const ch of plan.channelList) sendControl(at, 1, ch, c.controller, c.value);
      }
    }
    controlFresh = false;
    // In time order; at one time a part's state before its changes (stable within each).
    controlOut.sort((a, b) => a.time - b.time || a.order - b.order);
    for (const c of controlOut) wheels.push(c.msg);

    for (const plan of plans) {
      if (!audible.has(plan.id)) continue;
      const voice = voices.get(plan.id) as SchedulerVoice;
      const soundfont = voice.program !== undefined;
      for (const { note: written, abs: occ } of windowOnsets(plan.played, lap, cursor, targetAbs)) {
        // The note as its articulation plays it, and the preset channel it plays on when it has one.
        const art = plan.arts.get(written);
        const n = art?.played ?? written;
        const artAt = plan.artIndex.get(written);
        const artChannel = soundfont && art?.target && artAt !== undefined ? plan.channels.arts?.[artAt] : undefined;
        const lane = playingLane(n.lane, lanes);
        const when = lapTimeOf(lc, occ);
        const at = Math.max(now, when);
        // A soundfont note with expression of its own plays on a member channel, set to the note first.
        const members = plan.channels.mpe;
        const expressive = soundfont && !voice.percussion && !!members?.length && hasExpression(n.expr);
        const endAt = Math.max(at, lapTimeOf(lc, occ + Math.max(1 / TICKS_PER_STEP, n.length)));
        const member = expressive && members ? takeMember(members, at, endAt) : undefined;
        const channel = member ?? artChannel ?? plan.channels.lanes.get(lane) ?? plan.channels.base;
        if (member !== undefined && n.expr) {
          const m = expressionMessages(n.expr);
          wheels.push({ kind: 'range', channel: member, value: noteBendRange(n.expr), time: at });
          wheels.push({ kind: 'wheel', channel: member, value: m.wheel, time: at });
          wheels.push({ kind: 'control', channel: member, controller: 74, value: m.timbre, time: at });
          wheels.push({ kind: 'pressure', channel: member, value: m.pressure, time: at });
          for (const e of expressionCurveSteps(n.expr)) {
            const t = lapTimeOf(lc, occ + e.tick / TICKS_PER_STEP);
            if (t <= at || t >= endAt) continue;
            if (e.kind === 'timbre') wheels.push({ kind: 'control', channel: member, controller: 74, value: e.value, time: t });
            else wheels.push({ kind: e.kind, channel: member, value: e.value, time: t });
          }
          memberTouched.add(member);
          lastMemberTime = Math.max(lastMemberTime, endAt);
        }
        const curve = soundfont ? undefined : lapCurves.get(lane);
        let bend: VoiceBend | undefined;
        if (curve) {
          // A note that starts late picks its curve up where the curve is by then.
          const late = at > when ? stepsIn(steps, n.step, at - when) : 0;
          const end = n.step + n.length;
          const { events, originStep } = loopedBendAutomation(curve, lap.len, n.step - lap.start + late, n.length + stepsIn(steps, end, BEND_TAIL_SEC));
          bend = steps.stepSec !== undefined
            ? { events, originStep, stepSec: steps.stepSec }
            : { events, originStep, stepSec: spanSec(steps, n.step, 1), stepTime: lapLocalTime(lap, steps) };
        }
        notes.push({
          partId: plan.id,
          note: n.note,
          velocity: n.velocity,
          when: at,
          // A note lasts as long as its own steps do under the map.
          duration: spanSec(steps, n.step, n.length),
          channel,
          ...(artChannel !== undefined && art?.target
            ? { program: art.target.program, ...(art.target.bank ? { bank: art.target.bank } : {}) }
            : {
                ...(voice.program !== undefined ? { program: voice.program } : {}),
                ...(voice.bank ? { bank: voice.bank } : {}),
              }),
          percussion: voice.percussion,
          ...(bend ? { bend } : {}),
          step: n.step,
          abs: occ,
        });
      }
    }
    cursor = Math.max(cursor, targetAbs);
    return { notes, wheels, shownStep: shownStep(lapState, lapAbsAt(lc, now)) };
  };

  return {
    tick,
    release: (now) => {
      const out: ScheduledWheel[] = [];
      for (const ch of [...wheelRanges.keys()]) releaseWheel(ch, now, out);
      // After every controller change already sent, so a pedal-down in the lookahead cannot outlast STOP.
      resetControls([...controlTouched.keys()], Math.max(now, lastControlTime) + 0.001, out);
      controlLive.clear();
      // Each member channel back at rest: the centre, the default range, CC 74 at rest and no pressure.
      const rest = Math.max(now, lastMemberTime, lastWheelTime) + 0.001;
      for (const ch of memberTouched) {
        out.push({ kind: 'wheel', channel: ch, value: BEND_CENTER, time: rest });
        out.push({ kind: 'range', channel: ch, value: DEFAULT_BEND_RANGE, time: rest });
        out.push({ kind: 'control', channel: ch, controller: 74, value: TIMBRE_REST, time: rest });
        out.push({ kind: 'pressure', channel: ch, value: 0, time: rest });
      }
      memberTouched.clear();
      memberBusy.clear();
      return out;
    },
    state: () => playState,
  };
}
