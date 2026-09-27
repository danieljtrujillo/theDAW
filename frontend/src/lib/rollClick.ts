/**
 * rollClick — where the piano roll's CLICK sounds while PLAY runs.
 *
 * The roll's PLAY counts absolute steps that loop over a lap of roll steps
 * (lib/rollTransport), timed by the lap clock over the roll's tempo map
 * (lib/rollTempo). A click track for it cannot be laid on one run of transport
 * seconds, because every lap plays the same bars again. So the clicks are roll
 * steps, laid once per bar from the roll's meter map in the click mode
 * (lib/metronome barClicks: quarters, group starts such as 3+2+2, or dotted
 * quarters), and each scheduling window finds the absolute steps they fall on
 * in the lap, exactly as it finds a note's.
 *
 * The scheduler's transport is PLAY's own seconds (context time minus the time
 * PLAY started), so it never sees a jump when the lap wraps, a seek re-anchors
 * the lap, or a tempo point moves: those change where the clicks fall, through
 * the same lap clock the notes use, and a click already scheduled stays put.
 *
 * Everything here is pure, so node tests load it.
 */
import { bars, type MeterSegment } from './meterMap';
import { spanClicks, type ClickMode, type ClickPlan } from './metronome';
import { lapAbsAt, lapTimeOf, type LapClock } from './rollTempo';
import { windowOnsets } from './rollTransport';

const EPS = 1e-9;

/** One click in the roll: its step, and whether it is a downbeat. */
export interface RollClick {
  step: number;
  accent: boolean;
}

/** Every click of the roll's first `totalSteps` steps, in step order: each bar's clicks in `mode` from its bar line. */
export function rollClickSteps(meterMap: readonly MeterSegment[], pickupSteps: number, totalSteps: number, mode: ClickMode): RollClick[] {
  const out: RollClick[] = [];
  for (const b of bars(meterMap, totalSteps, pickupSteps)) {
    for (const c of spanClicks(b, mode)) {
      const step = b.start + c.at;
      if (step < totalSteps - EPS) out.push({ step, accent: c.accent });
    }
  }
  return out;
}

/**
 * The clicks PLAY sounds from `fromSec` to `untilSec`, both in PLAY's seconds
 * (context time minus `origin`, the time absolute step 0 sounds). Each click's
 * `beat` is its absolute step over 4, which rises with its seconds lap after
 * lap, so the scheduler's cursor schedules each one once.
 */
export function rollClickPlan(clock: LapClock, origin: number, clicks: readonly RollClick[], fromSec: number, untilSec: number): ClickPlan[] {
  if (!(untilSec >= fromSec) || !clicks.length) return [];
  const fromAbs = lapAbsAt(clock, origin + fromSec);
  const toAbs = lapAbsAt(clock, origin + untilSec);
  // windowOnsets takes (from, to]; a click exactly on the window's start belongs to it.
  return windowOnsets(clicks, clock.lap, fromAbs - 1e-6, toAbs)
    .sort((a, b) => a.abs - b.abs)
    .map(({ note, abs }) => ({ beat: abs / 4, sec: lapTimeOf(clock, abs) - origin, accent: note.accent }));
}

/** PLAY's first step sounds this long after the key is pressed, with no count-in. */
export const PLAY_LEAD_SEC = 0.06;

/**
 * How long before the counted downbeat a count-in hands over to PLAY: one
 * release poll, the render that sets PLAY going and the first scheduling
 * window all fit before the downbeat sounds.
 */
export const COUNT_IN_HANDOFF_SEC = 0.12;

/**
 * The context time absolute step 0 of PLAY sounds at: the downbeat a count-in
 * led into while it is still ahead of `now`, so the first note and the running
 * click land on the counted beat; otherwise PLAY_LEAD_SEC from now (no count,
 * or a handover so late the downbeat already passed).
 */
export function rollPlayOrigin(now: number, countedDownbeat?: number | null): number {
  if (countedDownbeat != null && Number.isFinite(countedDownbeat) && countedDownbeat > now + EPS) return countedDownbeat;
  return now + PLAY_LEAD_SEC;
}
