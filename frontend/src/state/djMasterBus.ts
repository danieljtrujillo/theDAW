/**
 * DJ master transport bus.
 *
 * In DJ mode the footer's central ▶ is the "Live Master" — it should drive the
 * DJ decks / the active set, NOT the global single-track player (that produced a
 * confusing second playhead). The footer can't reach the deck engine + setlist
 * directly, so it calls this module-level bus; the DJ tab registers a handler
 * (it owns the decks + active setlist) and reports the live state back so the
 * footer icon stays honest.
 *
 * Mirrors vjPlaybackBus's shape.
 */
export type DjMasterState = 'playing' | 'paused';

interface DjMasterHandler {
  /** Play the set from the top / pause everything (master toggle). */
  toggle: () => void;
  getState: () => DjMasterState;
}

let handler: DjMasterHandler | null = null;
const listeners = new Set<(s: DjMasterState) => void>();

/** DJ tab installs the handler on mount; returns an unregister. */
export function registerDjMasterHandler(h: DjMasterHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** Footer master ▶ in DJ mode. No-op until the DJ tab has registered. */
export function toggleDjMaster(): void {
  handler?.toggle();
}

export function getDjMasterState(): DjMasterState {
  return handler?.getState() ?? 'paused';
}

/** True iff the DJ tab is mounted and owns the master transport. */
export function isDjMasterActive(): boolean {
  return handler !== null;
}

/** DJ tab pushes the live master state (playing/paused) so the footer mirrors it. */
export function reportDjMasterState(s: DjMasterState): void {
  for (const cb of listeners) cb(s);
}

export function subscribeDjMasterState(cb: (s: DjMasterState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
