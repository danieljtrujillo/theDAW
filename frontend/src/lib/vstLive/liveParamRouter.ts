/**
 * vstLive/liveParamRouter — 60 Hz throttle from a Sway dimension or a Perform
 * macro sweep down to a live plugin's `setParam`, with a guaranteed final
 * value and exactly one commit per gesture.
 *
 * A sweep can emit far faster than a plugin (or the socket to its host)
 * should be asked to track: this collapses a burst of `push()` calls for the
 * same `(entryId, paramKey)` into a classic leading + trailing throttle — the
 * first move in a quiet window is sent immediately, everything after it
 * during that window coalesces into ONE trailing send carrying the newest
 * value, older values are discarded rather than queued. Whatever the
 * gesture's last push was is always the last thing sent (the trailing timer
 * is never cancelled without sending first), and the caller learns the
 * gesture ended — `commit`, exactly once — `idleMs` after the last push, so
 * the entry's stored params and automation lanes get written without doing
 * it on every tick.
 *
 * PURE: no timer of its own, no DOM, no store, no bridge — `now`, `schedule`
 * and `cancel` are injected so a test owns the clock, the same seam
 * `vstLive/jitterBuffer` uses for its audio math. This is the mirror image of
 * `state/vstEditorStore`'s `sinkLiveParams` (plugin editor -> store, coalesced
 * over `PARAM_COALESCE_MS`); it must not import or duplicate that coalescer —
 * only the direction reverses (store/controller -> plugin).
 */

export interface LiveParamRouterDeps {
  /** Monotonic clock, milliseconds. Same units as `schedule`/`cancel`. */
  now: () => number;
  /** setTimeout-shaped seam so a test can fire timers on its own schedule. */
  schedule: (fn: () => void, ms: number) => number;
  cancel: (h: number) => void;
  /** Deliver one coalesced value to the live plugin. */
  send: (entryId: string, paramKey: string, value: number) => void;
  /** The gesture ended: called exactly once, after the last `send`. */
  commit: (entryId: string, paramKey: string, value: number) => void;
  /** Minimum spacing between two `send` calls for the same key (default 16, ~60 Hz). */
  intervalMs?: number;
  /** Quiet time after the last push before a gesture is considered over (default 250). */
  idleMs?: number;
}

export interface LiveParamRouter {
  /** Route one value from a sweep. Throttled per `${entryId} ${paramKey}`. */
  push(entryId: string, paramKey: string, value: number): void;
  /** End the gesture for one key now: flush it, then commit. Idempotent — a
   *  key with no push since its last commit does nothing. */
  endGesture(entryId: string, paramKey: string): void;
  /** Send every key's pending value immediately. Never commits. */
  flush(): void;
  /** Cancel every timer without sending or committing. Inert afterward:
   *  later `push` calls are no-ops. */
  dispose(): void;
  /** Keys currently holding a value not yet sent. */
  pendingCount(): number;
}

interface KeyState {
  entryId: string;
  paramKey: string;
  /** `now()` at the last `send`; null = never sent. */
  lastSendTime: number | null;
  /** The value the last `send` carried; null = never sent. */
  lastSentValue: number | null;
  /** The newest value not yet sent; null = nothing pending. */
  pending: number | null;
  /** Armed trailing-send timer for this key, if any. */
  trailingHandle: number | null;
  /** Armed gesture-idle timer for this key, if any. */
  idleHandle: number | null;
}

const makeKey = (entryId: string, paramKey: string): string => `${entryId} ${paramKey}`;

export function createLiveParamRouter(deps: LiveParamRouterDeps): LiveParamRouter {
  const intervalMs = deps.intervalMs ?? 16;
  const idleMs = deps.idleMs ?? 250;
  const keys = new Map<string, KeyState>();
  let disposed = false;

  /** Send `value` now and record it as the key's last send. */
  const sendNow = (state: KeyState, value: number, at: number): void => {
    deps.send(state.entryId, state.paramKey, value);
    state.lastSendTime = at;
    state.lastSentValue = value;
    state.pending = null;
  };

  /** Send a key's pending value now (if any) and clear its trailing timer.
   *  Does not touch the idle timer or commit — that is `endGesture`'s job. */
  function flushKey(state: KeyState): void {
    if (state.trailingHandle !== null) {
      deps.cancel(state.trailingHandle);
      state.trailingHandle = null;
    }
    if (state.pending !== null) sendNow(state, state.pending, deps.now());
  }

  /** (Re)arm the gesture-idle timer: on fire, flush the key and commit once. */
  const armIdle = (state: KeyState): void => {
    if (state.idleHandle !== null) deps.cancel(state.idleHandle);
    state.idleHandle = deps.schedule(() => {
      state.idleHandle = null;
      flushKey(state);
      if (state.lastSentValue !== null) deps.commit(state.entryId, state.paramKey, state.lastSentValue);
    }, idleMs);
  };

  function push(entryId: string, paramKey: string, value: number): void {
    if (disposed) return;
    if (!Number.isFinite(value)) {
      throw new RangeError(`liveParamRouter: value must be a finite number, got ${value}`);
    }
    if (!entryId || !paramKey) {
      throw new RangeError('liveParamRouter: entryId and paramKey must be non-empty');
    }

    const key = makeKey(entryId, paramKey);
    let state = keys.get(key);
    if (!state) {
      state = {
        entryId,
        paramKey,
        lastSendTime: null,
        lastSentValue: null,
        pending: null,
        trailingHandle: null,
        idleHandle: null,
      };
      keys.set(key, state);
    }

    const now = deps.now();
    const leadingEdge = state.lastSendTime === null || now - state.lastSendTime >= intervalMs;
    if (leadingEdge) {
      sendNow(state, value, now);
    } else {
      state.pending = value;
      if (state.trailingHandle === null) {
        const remaining = intervalMs - (now - state.lastSendTime);
        state.trailingHandle = deps.schedule(() => {
          state.trailingHandle = null;
          // `pending` is only ever cleared by a send, so it is still set here.
          if (state.pending !== null) sendNow(state, state.pending, deps.now());
        }, remaining);
      }
    }

    armIdle(state);
  }

  function endGesture(entryId: string, paramKey: string): void {
    if (disposed) return;
    const state = keys.get(makeKey(entryId, paramKey));
    if (!state || state.idleHandle === null) return; // no push since the last commit
    deps.cancel(state.idleHandle);
    state.idleHandle = null;
    flushKey(state);
    if (state.lastSentValue !== null) deps.commit(entryId, paramKey, state.lastSentValue);
  }

  function flush(): void {
    if (disposed) return;
    for (const state of keys.values()) flushKey(state);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const state of keys.values()) {
      if (state.trailingHandle !== null) deps.cancel(state.trailingHandle);
      if (state.idleHandle !== null) deps.cancel(state.idleHandle);
    }
    keys.clear();
  }

  function pendingCount(): number {
    let n = 0;
    for (const state of keys.values()) if (state.pending !== null) n += 1;
    return n;
  }

  return { push, endGesture, flush, dispose, pendingCount };
}
