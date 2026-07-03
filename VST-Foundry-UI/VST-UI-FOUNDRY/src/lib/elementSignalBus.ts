/**
 * Element signal bus — runtime-only pub/sub for element→element routing.
 *
 * When a control with element routes moves (preview drag, toggle click), the
 * routing engine publishes shaped values here; the DESTINATION element's
 * dispatcher subscribes to its own (elementId, prop) channels and drives its
 * local display state (ganged knob position, Label readout text, Meter level,
 * Toggle state, Waveform amplitude…).
 *
 * Values are EPHEMERAL by design — modulation is not a document edit, so
 * nothing here touches the element store, autosave, or undo history (exactly
 * like a real VST: turning a mod-routed knob doesn't rewrite the patch).
 *
 * Perf contract: publishing is O(listeners-for-that-channel); no React state
 * lives in the bus, so a 60fps source re-renders only subscribed elements.
 */

export type ElementSignal = number | boolean | string;

type Listener = (v: ElementSignal) => void;

const channelKey = (elementId: string, prop: string) => `${elementId}:${prop}`;

const listeners = new Map<string, Set<Listener>>();
const lastValues = new Map<string, ElementSignal>();

/** Publish a shaped value to one element property channel. */
export function publishElementSignal(
  elementId: string,
  prop: string,
  value: ElementSignal,
): void {
  const key = channelKey(elementId, prop);
  lastValues.set(key, value);
  const set = listeners.get(key);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(value);
    } catch {
      /* a listener that throws never breaks the bus */
    }
  }
}

/**
 * Subscribe to one element property channel. Fires immediately with the last
 * published value (if any) so late-mounting destinations paint current state.
 * Returns the unsubscribe function.
 */
export function subscribeElementSignal(
  elementId: string,
  prop: string,
  cb: Listener,
): () => void {
  const key = channelKey(elementId, prop);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  const last = lastValues.get(key);
  if (last !== undefined) {
    try {
      cb(last);
    } catch {
      /* ignore */
    }
  }
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(key);
  };
}

/** Last published value for a channel (undefined if never published). */
export function getElementSignal(
  elementId: string,
  prop: string,
): ElementSignal | undefined {
  return lastValues.get(channelKey(elementId, prop));
}

/** Drop all runtime signals (call on project load/clear so stale modulation
 *  from the previous document can't bleed into the next one). */
export function clearElementSignals(): void {
  lastValues.clear();
  // Listeners are owned by mounted components; they re-populate naturally.
}
