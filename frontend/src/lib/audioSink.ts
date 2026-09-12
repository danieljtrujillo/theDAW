/**
 * The apply layer for audio OUTPUT routing — the only module that touches a
 * sink API.
 *
 * Three tiers, and the app degrades down them visibly rather than silently:
 *
 *   1. `AudioContext.setSinkId` moves the whole shared graph (every one of the
 *      modules that route through getMasterGain) in one call. Chromium 110+,
 *      so the desktop app always has it. playerStore owns that call; this
 *      module only reports whether it exists.
 *   2. `HTMLMediaElement.setSinkId` moves ONE element. That is how the DJ cue
 *      bus reaches a second output, and how the handful of loose <audio>
 *      elements outside the graph follow their surface's setting.
 *   3. Neither — an old browser. The main-output control is DISABLED with a
 *      written reason. It deliberately does NOT fall back to re-routing the
 *      graph tail through a MediaStreamDestination + hidden <audio>: that hop
 *      destroys ctx.outputLatency, which the latency calibrator and the
 *      play-along time map both read, so it would trade a device choice for
 *      silently wrong timing.
 *
 * Loose elements register here instead of each subscribing to the store, so a
 * device change re-applies to all of them at once and a late-mounted element
 * gets the current sink the moment it registers.
 */
import { logError } from '../state/logStore';

/** Can the shared AudioContext itself be moved to another device? */
export const supportsContextSink = (): boolean =>
  typeof AudioContext !== 'undefined' &&
  typeof AudioContext.prototype === 'object' &&
  'setSinkId' in AudioContext.prototype;

/** Can a single <audio> element be moved to another device? */
export const supportsElementSink = (): boolean =>
  typeof HTMLMediaElement !== 'undefined' &&
  typeof HTMLMediaElement.prototype === 'object' &&
  'setSinkId' in HTMLMediaElement.prototype;

type SinkCapableElement = HTMLMediaElement & {
  setSinkId?: (id: string) => Promise<void>;
  sinkId?: string;
};

/**
 * Point one element at a device. '' = the OS default. Resolves false when the
 * runtime cannot route (or the device rejected it) — callers keep playing on
 * the default rather than treating it as fatal.
 */
export const applyElementSink = async (el: HTMLMediaElement, deviceId: string): Promise<boolean> => {
  const target = el as SinkCapableElement;
  if (typeof target.setSinkId !== 'function') return false;
  if (target.sinkId === deviceId) return true;
  try {
    await target.setSinkId(deviceId);
    return true;
  } catch (e) {
    logError('audio', `Output routing failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
};

/* ── the element registry ─────────────────────────────────────────────────── */

/** Surface id -> resolved deviceId. Installed by the io store at boot. */
type SinkResolver = (surface: string) => string;

let resolver: SinkResolver = () => '';
const registered = new Map<HTMLMediaElement, string>();

/**
 * Install the resolver and re-apply to everything already registered. The io
 * store calls this once at boot and again whenever the settings change.
 */
export const setSinkResolver = (fn: SinkResolver): void => {
  resolver = fn;
  refreshSinkElements();
};

/**
 * Follow a surface's output setting with one <audio>/<video> element. Returns
 * the disposer; call it from the same effect that created the element.
 */
export const registerSinkElement = (surface: string, el: HTMLMediaElement | null): (() => void) => {
  if (!el) return () => {};
  registered.set(el, surface);
  void applyElementSink(el, resolver(surface));
  return () => {
    registered.delete(el);
  };
};

/** Re-apply the current resolution to every registered element. */
export const refreshSinkElements = (): void => {
  for (const [el, surface] of registered) {
    void applyElementSink(el, resolver(surface));
  }
};

/** Test/diagnostic read: how many elements are following a setting right now. */
export const registeredSinkCount = (): number => registered.size;
