/**
 * VJ playback bus.
 *
 * VJView (the iframe host on the SA3 side) registers a handler on
 * mount that knows how to forward play/pause requests into the VJ
 * iframe via postMessage. The PlayerFooter and the LOG strip's
 * track controls call togglePlayback() / playVj() / pauseVj() and
 * the registered handler does the rest.
 *
 * When no VJ tab is active (handler not registered), the calls are
 * inert — the bus is opt-in. The VJ side listens for the resulting
 * `sa3-vj/playback` postMessage and calls video.play() / video.pause()
 * on its own video element.
 */

export type VjPlaybackState = 'playing' | 'paused' | 'unknown';

interface VjPlaybackHandler {
  /** Tell the VJ iframe to play. */
  play: () => void;
  /** Tell the VJ iframe to pause. */
  pause: () => void;
  /** Read the last-known playback state. The VJ side reports this
   *  back via postMessage so the SA3 UI can show the right icon. */
  getState: () => VjPlaybackState;
}

let handler: VjPlaybackHandler | null = null;
const stateListeners = new Set<(s: VjPlaybackState) => void>();
let cachedState: VjPlaybackState = 'unknown';

export function registerVjPlaybackHandler(h: VjPlaybackHandler): () => void {
  handler = h;
  // Refresh cached state so subscribers see the right icon immediately.
  cachedState = h.getState();
  for (const cb of stateListeners) cb(cachedState);
  return () => {
    if (handler === h) handler = null;
    cachedState = 'unknown';
    for (const cb of stateListeners) cb(cachedState);
  };
}

/** Push the latest state into the bus — called by VJView when it
 *  receives a state echo from the iframe or when it issues a command. */
export function reportVjPlaybackState(s: VjPlaybackState): void {
  cachedState = s;
  for (const cb of stateListeners) cb(cachedState);
}

export function getVjPlaybackState(): VjPlaybackState {
  return cachedState;
}

/** True iff a VJ playback handler is currently registered (i.e. the
 *  VJ tab is mounted). UI uses this to decide whether to route the
 *  play button to VJ. */
export function isVjPlaybackActive(): boolean {
  return handler !== null;
}

export function playVj(): void {
  cachedState = 'playing';
  for (const cb of stateListeners) cb(cachedState);
  if (handler) {
    handler.play();
  }
}

export function pauseVj(): void {
  cachedState = 'paused';
  for (const cb of stateListeners) cb(cachedState);
  if (handler) {
    handler.pause();
  }
}

export function toggleVjPlayback(): void {
  const next = cachedState === 'playing' ? 'paused' : 'playing';
  if (next === 'playing') playVj();
  else pauseVj();
}

export function subscribeToVjPlaybackState(cb: (s: VjPlaybackState) => void): () => void {
  stateListeners.add(cb);
  cb(cachedState);
  return () => {
    stateListeners.delete(cb);
  };
}
