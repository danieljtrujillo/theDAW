/**
 * vstLive/liveParamSink — the one entry point a router calls to move a live
 * plugin parameter.
 *
 * A Sway dimension or a Perform macro sweep names an `(entryId, paramKey)`
 * pair and a normalized value; it does not know, and must not need to know,
 * whether that pair addresses a running plugin. This is the only module that
 * both answers that question (`resolveLiveParam`, over the real
 * `sessionRegistry` + `vstLiveStore`) and acts on it (`liveParamRouter`'s
 * throttle, down to `VstBridgeClient.setParam`) — everywhere else either
 * calls `pushLiveParam`/`endLiveParamGesture` below or falls through to
 * today's offline/pedalboard param path, unchanged, on a `false` return.
 *
 * `createLiveParamSink` takes every effectful dependency as a parameter, so a
 * test drives it with a fake lookup, a fake clock and a fake client — no
 * socket, no zustand, no AudioContext. `liveParams` is the real module
 * singleton the app wires to, built lazily (see `ensureSingleton`) so that
 * merely importing this module never touches `window`/`performance`/timers.
 */
import { createLiveParamRouter, type LiveParamRouterDeps } from './liveParamRouter';
import { resolveLiveParam, clampNormalized, parseLiveParamIndex, type LiveParamLookup } from './liveParamBinding';
import { vstSessions } from './sessionRegistry';
import { vstLiveStatusOf } from '../../state/vstLiveStore';

export interface LiveParamSink {
  /** Route one value from a sweep. Not resolvable to a running plugin's
   *  parameter (no `p<index>` key, no session, or the session is not
   *  `'live'`) -> `false`, nothing done at all. Resolvable -> the value is
   *  clamped to 0..1, handed to the throttle, `markParamsChanged` is called,
   *  and this returns `true`. `commit`, if given, is the callback that gets
   *  this key's ONE end-of-gesture value instead of the module commit sink. */
  push(entryId: string, paramKey: string, value01: number, commit?: (value: number) => void): boolean;
  /** End the gesture for one key now: flush its pending value, then the one
   *  commit. Idempotent — a key with no push since its last commit does
   *  nothing (see `liveParamRouter`'s `endGesture`). */
  endGesture(entryId: string, paramKey: string): void;
  dispose(): void;
}

/**
 * Module-wide fallback for a gesture's one commit, used whenever the `push`
 * calls that made up the gesture carried no per-call `commit` of their own.
 * Whatever owns an entry's stored params (`state/vstEditorStore`, today)
 * installs itself here — this module has no opinion on where a committed
 * value is written, only that it is written exactly once per gesture.
 */
let moduleCommitSink: ((entryId: string, paramKey: string, value: number) => void) | null = null;

/** Point the gesture-commit fallback at a sink; `null` unhooks it. */
export function setLiveParamCommitSink(
  fn: ((entryId: string, paramKey: string, value: number) => void) | null,
): void {
  moduleCommitSink = fn;
}

const makeKey = (entryId: string, paramKey: string): string => `${entryId} ${paramKey}`;

export function createLiveParamSink(deps: {
  lookup: LiveParamLookup;
  markParamsChanged: (entryId: string) => void;
  timers: Pick<LiveParamRouterDeps, 'now' | 'schedule' | 'cancel'>;
  intervalMs?: number;
  idleMs?: number;
}): LiveParamSink {
  /** The per-call `commit` given to the MOST RECENT accepted `push` for a
   *  key. Set on every accepted push, including to `undefined` when that
   *  push had none — that absence is itself the "most recent" answer and
   *  must fall through to the module sink, even if an earlier push in the
   *  same gesture did carry a callback. */
  const perCallCommits = new Map<string, ((value: number) => void) | undefined>();

  const router = createLiveParamRouter({
    now: deps.timers.now,
    schedule: deps.timers.schedule,
    cancel: deps.timers.cancel,
    intervalMs: deps.intervalMs,
    idleMs: deps.idleMs,
    send: (entryId, paramKey, value) => {
      // Re-resolved on every send, never captured at push time: the session
      // behind entryId can be replaced (sessionRegistry's `recreate`) between
      // when a value was queued and when the throttle actually fires.
      const session = deps.lookup.getSession(entryId);
      if (!session) return;
      const index = parseLiveParamIndex(paramKey);
      if (index === null) return;
      try {
        session.client.setParam(index, value);
      } catch {
        // A dead socket throws here; the controller thread (a knob, a macro
        // sweep) must never see it. Swallow it and let the next tick retry.
      }
    },
    commit: (entryId, paramKey, value) => {
      const perCall = perCallCommits.get(makeKey(entryId, paramKey));
      if (perCall) perCall(value);
      else moduleCommitSink?.(entryId, paramKey, value);
    },
  });

  function push(entryId: string, paramKey: string, value01: number, commit?: (value: number) => void): boolean {
    if (!resolveLiveParam(entryId, paramKey, deps.lookup)) return false;
    const clamped = clampNormalized(value01);
    perCallCommits.set(makeKey(entryId, paramKey), commit);
    router.push(entryId, paramKey, clamped);
    deps.markParamsChanged(entryId);
    return true;
  }

  function endGesture(entryId: string, paramKey: string): void {
    router.endGesture(entryId, paramKey);
  }

  function dispose(): void {
    router.dispose();
    perCallCommits.clear();
  }

  return { push, endGesture, dispose };
}

/* ── module singleton ────────────────────────────────────────────────────── */

let singleton: LiveParamSink | null = null;

/**
 * Built on first use, not at import time. `performance.now`/`setTimeout` and
 * the real session registry have no business running just because some other
 * module imported this file — e.g. a test that only wants `createLiveParamSink`.
 */
function ensureSingleton(): LiveParamSink {
  if (!singleton) {
    const lookup: LiveParamLookup = {
      getSession: (entryId) => vstSessions.get(entryId),
      statusOf: (entryId) => vstLiveStatusOf(entryId),
    };
    singleton = createLiveParamSink({
      lookup,
      // A push routed through here IS a genuine user gesture — a Sway
      // dimension or a Perform macro sweep the user is driving — not a chain
      // rebuild's re-push, so it may also unlock the save-time rejection
      // guard in `sinkLiveRawState` (T18 fifth audit, CRITICAL 1).
      markParamsChanged: (entryId) => vstSessions.markUserParamsChanged(entryId),
      timers: {
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        cancel: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
      },
    });
  }
  return singleton;
}

/** The one entry point wiring sites import to push one value from a sweep.
 *  See `LiveParamSink.push`. */
export function pushLiveParam(
  entryId: string,
  paramKey: string,
  value01: number,
  commit?: (value: number) => void,
): boolean {
  return ensureSingleton().push(entryId, paramKey, value01, commit);
}

/** End the gesture for one key now. See `LiveParamSink.endGesture`. */
export function endLiveParamGesture(entryId: string, paramKey: string): void {
  ensureSingleton().endGesture(entryId, paramKey);
}

/** The real module singleton, built over `vstSessions` + `vstLiveStatusOf` +
 *  real timers. Prefer `pushLiveParam`/`endLiveParamGesture` at call sites;
 *  this is here for symmetry with `LiveParamSink` and for `dispose`. */
export const liveParams: LiveParamSink = {
  push: pushLiveParam,
  endGesture: endLiveParamGesture,
  dispose: () => ensureSingleton().dispose(),
};
