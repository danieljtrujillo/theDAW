/* ── automationGesture: arm → begin → end, per lane, grouped by surface ───────
 *
 * A record mode is a statement about a GESTURE — touch punches out when you let
 * go, latch holds what you let go of — so the automation store needs begin / move
 * / end per lane, not a stream of anonymous values. This is the bookkeeping that
 * turns a widget's boundary plus a stream of `onChange`s into exactly that, and
 * it lives here rather than inside the editor because a begin with no end is the
 * one failure the store cannot recover from: the hold goes on overwriting the
 * lane ahead of the playhead until the transport stops, with the parameter never
 * handed back.
 *
 * The rules, in one place because they only make sense together:
 *
 * · A TARGET is one lane. A GROUP is the surface that reports the boundary. They
 *   are usually the same — a track fader is one SlideTrack writing one lane — but
 *   an XY surface (the OWL-Pad, the Spatializer) reports ONE boundary while
 *   writing several lanes, so the group is the rack entry and the lanes under it
 *   open and close together.
 * · `arm(group)` is the widget's `onGestureStart`. Per lib/gestureTracker's scope
 *   note it carries no value and does NOT promise a change is coming, so arming
 *   records nothing: it only says which surface is live. The FIRST `change` for a
 *   lane is the real begin; every later one moves.
 * · `end(group)` is the widget's `onGestureEnd`. It ends every lane of the group
 *   that actually began, and an end for a group that never began — or never
 *   existed — is simply dropped. Balance is the guarantee; a change having
 *   happened is not.
 * · An `arm` for a group that is still open CLOSES it first, so a dropped end can
 *   never leave two gestures on one surface.
 * · A control that reports NO boundary still has to end somewhere, so a group
 *   that was never armed falls back to an idle deadline: `idleMs` with no further
 *   change, pushed out by each change. Since batch 9 (T27) every rack control
 *   on the automation path reports its boundary — EffectKnob, EffectXYPad, the
 *   SlidePad toggle and the enum <select> through EffectControls, and the two
 *   bespoke XY surfaces — so the deadline is reached only by a host that passes
 *   no gesture props (MixView renders EffectControls that way, outside the
 *   automation consumer). It stays as the last guard, not as a live path.
 * · `dispose()` (unmount) ends everything open, exactly once, and a widget's own
 *   end arriving afterwards is inert. It is NOT terminal: React StrictMode runs
 *   mount → cleanup → mount on the same instance, so a machine that went inert
 *   after a dispose would leave every handler dead for the whole dev session.
 *
 * The clock is injected so the whole thing is testable without a DOM, the same
 * way lib/gestureTracker.ts is.
 */

/** How long a control that reports no gesture boundary may sit still before it
 *  counts as released. Short enough that a knob flick punches out promptly. */
export const RACK_GESTURE_IDLE_MS = 250;

export interface AutomationGestureOptions<T> {
  /** Identity of the LANE a change writes to. */
  keyOf: (target: T) => string;
  /** Identity of the SURFACE that reports the boundary. Defaults to `keyOf`. */
  groupOf?: (target: T) => string;
  /** First change for a lane. */
  onBegin: (target: T, v: number) => void;
  /** Every later change for a lane. */
  onMove: (target: T, v: number) => void;
  /** The lane is let go. Only ever called for a lane that began. */
  onEnd: (target: T) => void;
  /** Fallback deadline. Defaults to `RACK_GESTURE_IDLE_MS`. */
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface AutomationGesture<T> {
  /** A surface opened a gesture. Records nothing; closes a stale one first. */
  arm(group: string): void;
  /** A value arrived for one lane. Begins it, or moves it. */
  change(target: T, v: number): void;
  /** A surface let go (or its fallback deadline expired). */
  end(group: string): void;
  /** Unmount: end every open lane, exactly once. */
  dispose(): void;
  /** How many surfaces are open right now (armed or begun). For traces/tests. */
  openGroups(): number;
}

interface LaneState<T> {
  target: T;
  begun: boolean;
}

interface GroupState<T> {
  /** True when the surface reports its own boundary, so no deadline is armed. */
  explicit: boolean;
  /** Fallback idle timer handle (0 = none). */
  idle: number;
  lanes: Map<string, LaneState<T>>;
}

export function createAutomationGesture<T>(opts: AutomationGestureOptions<T>): AutomationGesture<T> {
  const groupOf = opts.groupOf ?? opts.keyOf;
  const idleMs = opts.idleMs ?? RACK_GESTURE_IDLE_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((handle: number) => clearTimeout(handle));

  const groups = new Map<string, GroupState<T>>();

  const end = (group: string): void => {
    const g = groups.get(group);
    if (!g) return; // never armed, or already ended — both tolerated
    // Out of the map before any callback runs, so a re-entrant end takes the
    // guard above and stops.
    groups.delete(group);
    if (g.idle !== 0) clearTimer(g.idle);
    for (const lane of g.lanes.values()) {
      if (lane.begun) opts.onEnd(lane.target); // an armed lane that never moved just disarms
    }
  };

  return {
    arm: (group) => {
      end(group);
      groups.set(group, { explicit: true, idle: 0, lanes: new Map() });
    },

    change: (target, v) => {
      const group = groupOf(target);
      let g = groups.get(group);
      if (!g) {
        // No arm came first: a control with no boundary to report.
        g = { explicit: false, idle: 0, lanes: new Map() };
        groups.set(group, g);
      }
      const key = opts.keyOf(target);
      let lane = g.lanes.get(key);
      if (!lane) {
        lane = { target, begun: false };
        g.lanes.set(key, lane);
      }
      if (lane.begun) opts.onMove(target, v);
      else {
        opts.onBegin(target, v);
        lane.begun = true;
      }
      if (g.explicit) return; // the widget will say when this ends
      if (g.idle !== 0) clearTimer(g.idle);
      g.idle = setTimer(() => end(group), idleMs);
    },

    end,

    dispose: () => {
      for (const group of [...groups.keys()]) end(group);
      groups.clear();
    },

    openGroups: () => groups.size,
  };
}
