/**
 * vstParamAutomation — EDIT's automation lanes on a hosted plugin, as the
 * curves an offline print moves its parameters by.
 *
 * Live, the FX writer (state/liveMixer `applyFxAutomationFrame`) hands each lane's
 * value to the running plugin every frame. Offline, the print runs the plugin
 * over a file on the backend (`POST /api/vst/process-file`), so each lane goes
 * with the file: a piecewise-linear curve of the parameter's normalized value
 * over the file's sample frames, which both renderers apply at the start of
 * every block (backend/modules/vst/param_automation.py).
 *
 * The file a print sends starts at `originSec` on the timeline (0, or a range's
 * first rendered frame) and is ALIGNED to the timeline: each tap is trimmed by
 * the latency ahead of it (lib/render/insertPrint). So frame `f` of the file is
 * timeline `originSec + f / sampleRate`, and the parameter at that frame takes
 * the lane's value there.
 *
 * A straight segment needs only its two ends. A curved one (a breakpoint's
 * `curve`, lib/automationModes `curveShape`) is cut into straight pieces
 * `CURVE_STEP_SEC` long, so the print follows the bend the lane draws.
 */
import { sampleCurve } from '../automationModes';
import type { AutomationLane, AutomationTargetKind } from '../../state/editorStore';
import type { ChainEntry } from '../../state/effectChainStore';

/** One automated parameter, in the wire shape of `/process-file`'s `automation`. */
export interface HostParamAutomation {
  /** The parameter's position in the plugin's own list: the `p<index>` of its lane. */
  index: number;
  /** The plugin's own name for it, when the app has read the list. The
   *  pedalboard renderer numbers parameters its own way and finds one by this. */
  name?: string;
  /** `[frame, value]`, ascending, frame 0 first; the value holds past the last. */
  points: [number, number][];
}

/** Length of the straight pieces a curved segment is cut into, in seconds. */
export const CURVE_STEP_SEC = 0.005;
/** The most pieces one curved segment is cut into, however long it runs. */
const MAX_PIECES_PER_SEGMENT = 2048;

const PARAM_KEY = /^p(\d+)$/;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One lane as `[frame, value]` points over a file of `frames` frames at
 * `sampleRate` whose frame 0 is timeline `originSec`. Always starts at frame 0
 * (the value the lane holds there) and ends at `frames` (the value at the
 * file's end), so a window that opens or closes mid-segment is exact.
 */
export function laneToHostPoints(
  lane: Pick<AutomationLane, 'points'>,
  originSec: number,
  sampleRate: number,
  frames: number,
): [number, number][] {
  const pts = lane.points;
  if (pts.length === 0 || !(sampleRate > 0)) return [];
  const endSec = originSec + Math.max(0, frames) / sampleRate;
  const out: [number, number][] = [];
  const push = (t: number): void => {
    const frame = Math.max(0, Math.min(frames, Math.round((t - originSec) * sampleRate)));
    const value = clamp01(sampleCurve(pts, t) ?? 0);
    const last = out[out.length - 1];
    if (last && last[0] === frame) last[1] = value; // two times on one frame: the later wins
    else out.push([frame, value]);
  };
  push(originSec);
  for (let i = 0; i < pts.length; i += 1) {
    const p0 = pts[i];
    if (p0.t > originSec && p0.t < endSec) push(p0.t);
    const p1 = pts[i + 1];
    if (!p1 || (p0.curve ?? 0) === 0) continue;
    // A curved segment: straight pieces across the part of it the file holds.
    const span = p1.t - p0.t;
    if (!(span > 0) || p1.t <= originSec || p0.t >= endSec) continue;
    const pieces = Math.min(MAX_PIECES_PER_SEGMENT, Math.max(1, Math.ceil(span / CURVE_STEP_SEC)));
    for (let k = 1; k < pieces; k += 1) {
      const t = p0.t + (span * k) / pieces;
      if (t > originSec && t < endSec) push(t);
    }
  }
  push(endSec);
  return out;
}

/** Which lanes drive a printed insert: the kind and owner its place in the mix gives them. */
export interface HopAutomationSite {
  /** `trackFx` for a track insert, `busFx` for a bus insert, `masterFx` for the master VST chain. */
  kind: Extract<AutomationTargetKind, 'trackFx' | 'busFx' | 'masterFx'>;
  /** The track or bus id; ignored for the master. */
  ownerId?: string;
}

/**
 * Every lane on one printed insert, as the curves its print sends: the lanes
 * that are switched on, hold a breakpoint and name one of the plugin's own
 * parameters (`p<index>`), for this entry at this place. `paramName` supplies
 * the plugin's own name for an index, when the app has read the plugin's list.
 * Empty when nothing on the insert is automated.
 */
export function hopAutomation(
  lanes: readonly AutomationLane[],
  entry: Pick<ChainEntry, 'id'>,
  site: HopAutomationSite,
  file: { originSec: number; sampleRate: number; frames: number },
  paramName?: (entryId: string, index: number) => string | undefined,
): HostParamAutomation[] {
  const out: HostParamAutomation[] = [];
  const seen = new Set<number>();
  for (const lane of lanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const { kind, trackId, entryId, paramKey } = lane.target;
    if (kind !== site.kind || entryId !== entry.id) continue;
    if (kind !== 'masterFx' && trackId !== site.ownerId) continue;
    const m = PARAM_KEY.exec(paramKey ?? '');
    if (!m) continue;
    const index = Number(m[1]);
    if (seen.has(index)) continue;
    seen.add(index);
    const points = laneToHostPoints(lane, file.originSec, file.sampleRate, file.frames);
    if (points.length === 0) continue;
    const name = paramName?.(entry.id, index);
    out.push({ index, ...(name ? { name } : {}), points });
  }
  return out;
}
