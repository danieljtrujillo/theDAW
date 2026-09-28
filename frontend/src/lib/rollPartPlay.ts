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
 * No Vite-only imports, so node tests load it.
 */
import type { RollTrack } from '../state/pianoRollStore';
import { unrollLanes, type PolyLane } from './meterMap';
import {
  BEND_CENTER,
  DEFAULT_BEND_RANGE,
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
import { REANCHOR_STEPS, shownStep, windowOnsets } from './rollTransport';
import { audiblePartIds, rollLiveChannels, type PartLiveChannels } from './rollTracks';
import type { PianoNote } from '../state/pianoRollStore';

/** Seconds the scheduler plans ahead each tick: its notes, and the roll's click. */
export const ROLL_LOOKAHEAD_SEC = 0.12;
/** Milliseconds between the scheduler's ticks. */
export const ROLL_TICK_MS = 25;

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

/** A pitch wheel message (`value` 0-16383) or a bend range (`value` in semitones) for a channel, at `time` (now when absent). */
export interface ScheduledWheel {
  kind: 'wheel' | 'range';
  channel: number;
  value: number;
  time?: number;
}

export interface RollTickResult {
  notes: ScheduledRollNote[];
  wheels: ScheduledWheel[];
  /** The step the playhead shows now. */
  shownStep: number;
}

/** A part's notes as they sound (lane repeats written out) and its live channels. */
interface PartPlan {
  id: string;
  played: PianoNote[];
  channels: PartLiveChannels;
}

export interface RollScheduler {
  /** Schedule the window from the last tick to `now` + the lookahead. */
  tick: (now: number, roll: RollSchedulerSource, voiceOf: (partId: string) => SchedulerVoice | undefined) => RollTickResult;
  /** Put every bent channel back at the centre and the default range, after every message already sent: STOP. */
  release: (now: number) => ScheduledWheel[];
  /** The lap and its clock as the last tick left them (the click reads them). */
  state: () => RollPlayState;
}

/** A scheduler for PLAY starting with absolute step 0 at context time `origin`. */
export function createRollScheduler(roll: RollSchedulerSource, origin: number, lookahead = ROLL_LOOKAHEAD_SEC): RollScheduler {
  let playState = startRollPlay(roll, origin);
  let cursor = -REANCHOR_STEPS; // absolute step scheduled up to (inclusive)
  // Unrolled once per part, lane, length or bend edit, not once per tick.
  let source: { tracks: readonly RollTrack[]; lanes: readonly PolyLane[]; total: number; bends: readonly LaneBend[] } | null = null;
  let plans: PartPlan[] = [];
  let bent = new Map<number, PlayedBend>();
  let lapCurves = bent;
  let lapCurvesOf: { bent: Map<number, PlayedBend>; start: number } | null = null;
  // Channels this playback has bent, with the range last sent, and the latest wheel message time.
  const wheelRanges = new Map<number, number>();
  let lastWheelTime = 0;
  // The next tick first sends each bent channel where its curve is: at the start, and after a bend, lane, length, loop or seek.
  let wheelFresh = true;

  const releaseWheel = (ch: number, now: number, out: ScheduledWheel[]) => {
    const at = Math.max(now, lastWheelTime) + 0.001;
    out.push({ kind: 'wheel', channel: ch, value: BEND_CENTER, time: at });
    out.push({ kind: 'range', channel: ch, value: DEFAULT_BEND_RANGE, time: at });
    wheelRanges.delete(ch);
  };

  const tick: RollScheduler['tick'] = (now, r, voiceOf) => {
    const { tracks, lanes, bends } = r;
    const total = Math.max(1, r.totalSteps);
    const wheels: ScheduledWheel[] = [];
    const notes: ScheduledRollNote[] = [];
    const followed = followRollPlay(playState, r, cursor);
    // A re-anchored lap sends every bent channel where its curve is at the new place.
    if (followed.lapState !== playState.lapState) wheelFresh = true;
    playState = followed;
    const { lapState, steps, clock: lc } = playState;
    const { lap } = lapState;
    if (!source || source.tracks !== tracks || source.lanes !== lanes || source.total !== total || source.bends !== bends) {
      if (source && (source.lanes !== lanes || source.total !== total || source.bends !== bends)) wheelFresh = true;
      // A part moved to another channel starts its curve fresh there.
      if (source && source.tracks.length !== tracks.length) wheelFresh = true;
      source = { tracks, lanes, total, bends };
      const channels = rollLiveChannels(tracks, lanes, bends);
      plans = tracks.map((t) => ({ id: t.id, played: unrollLanes(t.notes, lanes, total), channels: channels.get(t.id) as PartLiveChannels }));
      bent = playedRollBends(bends, lanes, total);
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
      for (const lane of plan.channels.bent) if (lapCurves.has(lane)) bentChannels.add(plan.channels.lanes.get(lane) as number);
    }
    // A channel whose lane stopped bending goes back to the centre.
    for (const ch of [...wheelRanges.keys()]) if (!bentChannels.has(ch)) releaseWheel(ch, now, wheels);
    for (const plan of plans) {
      const voice = voices.get(plan.id) as SchedulerVoice;
      if (voice.program === undefined || voice.percussion) continue;
      for (const lane of plan.channels.bent) {
        const curve = lapCurves.get(lane);
        if (!curve) continue;
        const ch = plan.channels.lanes.get(lane) as number;
        if (wheelRanges.get(ch) !== curve.range) {
          wheels.push({ kind: 'range', channel: ch, value: curve.range });
          wheelRanges.set(ch, curve.range);
        }
        for (const e of loopedWheelEvents(curve.points, lap.len, cursor - lap.base, targetAbs - lap.base, wheelFresh, curve.range)) {
          const at = Math.max(now, lapTimeOf(lc, e.abs + lap.base));
          wheels.push({ kind: 'wheel', channel: ch, value: e.raw, time: at });
          lastWheelTime = Math.max(lastWheelTime, at);
        }
      }
    }
    wheelFresh = false;

    const audible = audiblePartIds(tracks);
    for (const plan of plans) {
      if (!audible.has(plan.id)) continue;
      const voice = voices.get(plan.id) as SchedulerVoice;
      const soundfont = voice.program !== undefined;
      for (const { note: n, abs: occ } of windowOnsets(plan.played, lap, cursor, targetAbs)) {
        const lane = playingLane(n.lane, lanes);
        const channel = plan.channels.lanes.get(lane) ?? plan.channels.base;
        const curve = soundfont ? undefined : lapCurves.get(lane);
        const when = lapTimeOf(lc, occ);
        const at = Math.max(now, when);
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
          ...(voice.program !== undefined ? { program: voice.program } : {}),
          ...(voice.bank ? { bank: voice.bank } : {}),
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
      return out;
    },
    state: () => playState,
  };
}
