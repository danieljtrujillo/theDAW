/**
 * VJ performance SET bus.
 *
 * The DJ tab owns setlists (setlistStore). The VJ tab hosts the
 * GANTASMO iframe. Previously there was no path to hand a SET or a
 * single song from the DJ side into the VJ performance, so the two
 * felt disjointed. This module-level bus closes that gap:
 *
 *   - DJView (or any view) calls `sendSetToVj(payload)` /
 *     `sendTrackToVj(payload)`.
 *   - VJView registers a handler on mount that forwards the payload
 *     into the iframe via postMessage (`sa3-vj/load-set` /
 *     `sa3-vj/load-track`). The VJ project's bridge can append the
 *     entries to its archive bucket.
 *
 * When the VJ tab is not mounted the calls are buffered as a single
 * "pending" payload so a SET queued from the DJ tab is delivered the
 * moment the VJ tab opens and registers. This keeps the workflow
 * coherent regardless of tab order.
 */

export interface VjSetItem {
  /** Library entry id (or null for ad-hoc URL entries). */
  entryId: string | null;
  /** Human label shown in VJ HUDs / bucket. */
  label: string;
  /** Resolved media URL the VJ side can load, when known. */
  url?: string;
  /** Media kind hint. */
  kind?: 'audio' | 'video' | 'image';
}

export interface VjSetPayload {
  /** Setlist id, or null for a single ad-hoc track push. */
  setId: string | null;
  /** Display name for the performance/set. */
  name: string;
  /** Ordered items. */
  items: VjSetItem[];
}

interface VjSetHandler {
  loadSet: (payload: VjSetPayload) => void;
}

let handler: VjSetHandler | null = null;
let pending: VjSetPayload | null = null;
const listeners = new Set<(payload: VjSetPayload) => void>();

export function registerVjSetHandler(h: VjSetHandler): () => void {
  handler = h;
  // Flush any payload queued before the VJ tab mounted.
  if (pending) {
    try {
      h.loadSet(pending);
    } finally {
      pending = null;
    }
  }
  return () => {
    if (handler === h) handler = null;
  };
}

/** True iff the VJ tab is mounted and listening. */
export function isVjSetTargetActive(): boolean {
  return handler !== null;
}

/** Send a whole SET to the VJ performance. Buffered if VJ is closed. */
export function sendSetToVj(payload: VjSetPayload): void {
  for (const cb of listeners) cb(payload);
  if (handler) handler.loadSet(payload);
  else pending = payload;
}

/** Send a single track to the VJ performance. */
export function sendTrackToVj(item: VjSetItem): void {
  sendSetToVj({ setId: null, name: item.label, items: [item] });
}

/** Subscribe to outgoing SET pushes (e.g. for a confirmation toast). */
export function subscribeToVjSet(cb: (payload: VjSetPayload) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
