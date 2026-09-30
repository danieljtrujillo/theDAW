/**
 * vstLive/liveParamBinding — pure resolver from (entryId, paramKey) to a live
 * plugin's parameter index.
 *
 * A controller route (an automation write, a Sway binding, anything that
 * names a chain entry and a parameter key) needs one answer: does that pair
 * address a parameter of a RUNNING plugin, and if so which index. This module
 * answers that question and nothing else. Callers that get `null` back fall
 * through to exactly today's behaviour (the offline/pedalboard param path) --
 * this module never decides what happens on a miss, only whether it is one.
 *
 * PURE: no runtime import of `sessionRegistry` or `vstLiveStore` -- both are
 * module-level singletons (an open-socket registry, a zustand store) that a
 * resolver has no business touching. Callers already hold both and hand in
 * what they need through `LiveParamLookup`.
 */

/**
 * `p<index>` is how a live plugin parameter rides in a paramKey -- the same
 * convention `vstLiveNode.ts`'s `PARAM_KEY` reads (vstLiveNode.ts:139-141)
 * and `vstEditorStore.ts`'s `sinkLiveParams` writes (vstEditorStore.ts:147).
 * Restated here rather than imported: `vstLiveNode.ts` pulls in
 * AudioContext-dependent code this module must stay clear of.
 */
const PARAM_KEY = /^p(\d+)$/;

/** Parses a `p<index>` paramKey. Null for anything else -- a rack-effect key
 *  such as `mix`, a wrong-case prefix, or a malformed index. */
export function parseLiveParamIndex(paramKey: string): number | null {
  const m = PARAM_KEY.exec(paramKey);
  if (!m) return null;
  return Number(m[1]);
}

/** Prefix for a Sway target id that addresses a live plugin parameter,
 *  distinct from every other target-id family. */
export const LIVE_PARAM_TARGET_PREFIX = 'vstlive';

/** Builds the Sway target id addressing `paramKey` on `entryId`'s live
 *  plugin session. */
export function liveParamTargetId(entryId: string, paramKey: string): string {
  return `${LIVE_PARAM_TARGET_PREFIX}:${entryId}:${paramKey}`;
}

/** Parses a target id built by `liveParamTargetId`. Null for anything that is
 *  not exactly three colon-separated parts carrying the live-param prefix --
 *  an `entryId` containing a colon is not supported, so a 4-part id returns
 *  null rather than guessing which parts belong to the id. */
export function parseLiveParamTargetId(id: string): { entryId: string; paramKey: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const [prefix, entryId, paramKey] = parts;
  if (prefix !== LIVE_PARAM_TARGET_PREFIX) return null;
  return { entryId, paramKey };
}

/**
 * What `resolveLiveParam` needs from a caller that already holds the real
 * session registry and live store -- kept to the minimal structural shape
 * those two provide, so this module never imports either at runtime.
 */
export interface LiveParamLookup {
  /** `VstSessionRegistry.get` (sessionRegistry.ts:116): the entry's session,
   *  or undefined when it has none. */
  getSession: (entryId: string) => { client: { setParam: (index: number, value: number) => void } } | undefined;
  /** `vstLiveStatusOf` (vstLiveStore.ts:241-243): the entry's live-status
   *  record. Only `status` is read here. */
  statusOf: (entryId: string) => { status: string };
}

/**
 * Resolves `(entryId, paramKey)` to a live parameter index, or null when the
 * pair does not address a running plugin's parameter: not a `p<index>` key,
 * no session for the entry, or the session's status is not `'live'` (a
 * starting/error/unavailable/off session is not in the audio path -- per
 * `VstLiveStatus` (vstLiveStore.ts:31-41), `'live'` is the only status where
 * the plugin is there to receive a parameter write).
 */
export function resolveLiveParam(
  entryId: string,
  paramKey: string,
  lookup: LiveParamLookup,
): { entryId: string; paramKey: string; index: number } | null {
  const index = parseLiveParamIndex(paramKey);
  if (index === null) return null;
  if (!lookup.getSession(entryId)) return null;
  if (lookup.statusOf(entryId).status !== 'live') return null;
  return { entryId, paramKey, index };
}

/**
 * Clamps a value to the protocol's normalized 0..1 range. Throws rather than
 * silently coercing a non-finite value to some default -- this is what keeps
 * `bridgeClient.setParam` (bridgeClient.ts:439) from ever throwing on a
 * controller sweep: a jittery knob overshoot gets clamped here, while a NaN
 * (a real bug upstream) is surfaced loudly instead of swallowed.
 */
export function clampNormalized(v: number): number {
  if (!Number.isFinite(v)) {
    throw new RangeError('liveParamBinding: value must be a finite number, got ' + v);
  }
  return Math.min(1, Math.max(0, v));
}
