/**
 * Is this page allowed to hold shared memory?
 *
 * `SharedArrayBuffer` — the ring buffer a live plugin host would hand to an
 * AudioWorklet — is only constructible in a cross-origin-isolated document:
 * one served with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. theDAW sends both from the two
 * places that serve the app (`frontend/vite.config.ts` `server.headers` in dev,
 * the `app://` protocol handler in `electron-ui/main/index.ts` when packaged),
 * but a page can still end up un-isolated — an embed served without the
 * headers, a browser that does not implement the flag, a stripped runtime.
 *
 * So nothing may assume it. This module is the single place that asks, and it
 * asks `globalThis` on every call rather than caching at import: the module is
 * pulled in during boot, and a cached "no" would outlive the condition that
 * produced it.
 *
 * Nothing here allocates shared memory or touches audio — it only reports.
 */
import { useVstLiveStore, type VstLiveHostState } from '../state/vstLiveStore';

/** True only in a document the browser has marked cross-origin isolated. */
export function isCrossOriginIsolated(): boolean {
  // Read through globalThis: `crossOriginIsolated` is a bare global in the DOM
  // lib but does not exist in Node (tests) or in a worker-less runtime, and a
  // bare reference would throw instead of answering "no".
  return (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
}

/** True when a `SharedArrayBuffer` can actually be constructed here. */
export function sabAvailable(): boolean {
  // Both halves matter. The constructor is present in plenty of non-isolated
  // pages (only shared *memory* is gated, not the name), and isolation without
  // the constructor shows up in trimmed-down runtimes; either alone is a trap.
  const ctor = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  return typeof ctor === 'function' && isCrossOriginIsolated();
}

/**
 * What the UI says about live VST hosting on this machine.
 *
 * CROSS-ORIGIN ISOLATION IS NO LONGER THE QUESTION. This used to report
 * `sabAvailable()`, because a live host was expected to hand the worklet a
 * SharedArrayBuffer ring, and shared memory needs an isolated document. The
 * bridge that was actually built (docs/design/vst-live-protocol.md) moves audio
 * over a `MessagePort` and a loopback WebSocket, neither of which is gated —
 * so an un-isolated page hosts plugins perfectly well, and telling the user to
 * go and fix their headers would send them after a fault that is not there. A
 * SharedArrayBuffer ring remains a possible later optimisation behind the same
 * node contract, which is why `sabAvailable` is still exported above.
 *
 * The question now is whether the backend has a host BINARY, which is a fact
 * about the machine that only `GET /api/vst/live/host` knows. That answer is
 * cached in `vstLiveStore` by the session registry; `available === null` means
 * nobody has asked yet, and an entry opened in that state proceeds
 * optimistically rather than declaring the machine plugin-less.
 *
 * `host` defaults to the current store value. A React caller passes its own
 * SUBSCRIBED value instead, so the row re-renders when the probe lands — a
 * `getState()` read inside a render would show the "checking…" answer forever.
 */
export function liveVstStatus(
  host: VstLiveHostState = useVstLiveStore.getState().host,
): { available: boolean | null; reason: string } {
  const { available, reason } = host;
  if (available === true) return { available, reason: 'live plugin host available' };
  if (available === null) return { available, reason: 'checking for the live plugin host…' };
  return {
    available,
    reason: reason ?? 'live plugin host unavailable — plugins render at freeze/bounce only',
  };
}
