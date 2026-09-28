/**
 * midiCcAutomation — EDIT's trackMidiCc automation lanes as controller changes.
 *
 * A trackMidiCc lane (state/editorStore midiCcTarget) rides one controller a
 * roll part keeps (lib/rollTracks PART_CONTROLLERS) on a MIDI track, over
 * timeline seconds, as a curve of 0-127 breakpoints like any automation lane.
 * A synth takes a controller as whole steps, so the curve is read every
 * CC_AUTOMATION_STEP_SEC and a change is sent where its whole value moves:
 * a flat stretch sends nothing, a swell sends one change per step of value.
 *
 * The lane owns its controller on its track: while it is enabled and has
 * points, the track's clips' own changes of that controller (a roll part's
 * drawn expression) are left out, live and in the export, as a DAW's
 * automation overrides a clip's own controller data. EDIT's live MIDI
 * (lib/editMidiScheduler) sends these changes on every channel the track's
 * MIDI plays on, and the arrangement's MIDI export (lib/arrangementMidi)
 * writes them.
 *
 * Pure, so node tests load it.
 */
import type { AutomationLane } from '../state/editorStore';
import { sampleCurve } from './automationModes';
import { partController } from './rollTracks';

/** How often a lane's curve is read for a change: 10 ms, finer than a 64th at 300 BPM. */
export const CC_AUTOMATION_STEP_SEC = 0.01;

/** One controller change a lane sends, at a timeline second. */
export interface CcAutomationEvent {
  sec: number;
  value: number;
}

/** A lane of the controllers a track's automation owns: enabled trackMidiCc lanes with points. */
export interface TrackCcLane {
  trackId: string;
  controller: number;
  lane: AutomationLane;
}

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));

/** The controller a trackMidiCc lane names, or null (lib/rollTracks PART_CONTROLLERS only). */
function laneController(lane: AutomationLane): number | null {
  if (lane.target.kind !== 'trackMidiCc' || lane.target.paramKey === undefined) return null;
  const cc = Number(lane.target.paramKey);
  return Number.isInteger(cc) && partController(cc) ? cc : null;
}

/** Every enabled trackMidiCc lane with points, with its track and controller. */
export function trackCcLanes(lanes: readonly AutomationLane[] | undefined): TrackCcLane[] {
  const out: TrackCcLane[] = [];
  for (const lane of lanes ?? []) {
    if (!lane.enabled || !lane.points.length || !lane.target.trackId) continue;
    const controller = laneController(lane);
    if (controller === null) continue;
    out.push({ trackId: lane.target.trackId, controller, lane });
  }
  return out;
}

/** The controllers each track's automation owns, by track id. */
export function automatedControllers(lanes: readonly TrackCcLane[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const l of lanes) {
    const set = out.get(l.trackId) ?? new Set<number>();
    set.add(l.controller);
    out.set(l.trackId, set);
  }
  return out;
}

/** The lane's whole value at timeline second `t`. */
export const ccLaneValueAt = (lane: AutomationLane, t: number): number => clamp7(sampleCurve(lane.points, t) ?? 0);

/**
 * The changes `lane` sends from `fromSec` (inclusive) to `toSec` (exclusive),
 * read every `stepSec`: a change wherever the whole value differs from
 * `held`, the value the channel holds going in (null: none yet, so the first
 * reading is sent). Returns the changes and the value held after them.
 */
export function ccLaneEvents(
  lane: AutomationLane,
  fromSec: number,
  toSec: number,
  held: number | null,
  stepSec = CC_AUTOMATION_STEP_SEC,
): { events: CcAutomationEvent[]; held: number | null } {
  const events: CcAutomationEvent[] = [];
  let last = held;
  if (!(toSec > fromSec)) return { events, held: last };
  const step = stepSec > 0 ? stepSec : CC_AUTOMATION_STEP_SEC;
  // Readings on the lane's own grid of `step` from 0, so two windows that meet read the same instants.
  const first = Math.ceil(fromSec / step - 1e-9);
  for (let k = first; k * step < toSec - 1e-9; k += 1) {
    const t = k * step;
    const v = ccLaneValueAt(lane, t);
    if (v === last) continue;
    events.push({ sec: t, value: v });
    last = v;
  }
  return { events, held: last };
}
