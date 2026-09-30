/**
 * components/session/ccModFxRouteModel — the pure decision behind a Perform
 * rail 'fx' CcMod route: which chain entry it addresses, plus the two values
 * DawSessionGrid.tsx's MIDI CC branch needs — the raw normalized 0..1 value a
 * live plugin's opaque parameter expects, and the min/max-scaled value a rack
 * effect's stored parameter expects. No DOM, no store, no chain handle: this
 * only decides, DawSessionGrid.tsx acts on the result.
 */
import type { CcMod } from '../../state/performRouting';

export interface CcModFxRoute {
  /** The chain entry id the Perform grid gave this device: `perform-<track>-<device>`. */
  entryId: string;
  paramKey: string;
  /** The raw 0..1 value, unscaled -- what a live plugin's opaque parameter expects. */
  normalized: number;
  /** `min + normalized * (max - min)` -- what a rack effect's stored parameter expects. */
  scaled: number;
}

/** Resolve an `'fx'` CcMod plus a fresh MIDI value to the chain entry id and
 *  the two values its two possible destinations (live plugin, rack effect)
 *  need. `null` for any other target, or an fx route missing the device
 *  index or parameter key it needs to address a chain entry. */
export function ccModFxRoute(cm: CcMod, value01: number): CcModFxRoute | null {
  if (cm.target !== 'fx') return null;
  if (cm.deviceIndex == null || !cm.paramKey) return null;
  const lo = cm.min ?? 0;
  const hi = cm.max ?? 1;
  return {
    entryId: `perform-${cm.trackIndex}-${cm.deviceIndex}`,
    paramKey: cm.paramKey,
    normalized: value01,
    scaled: lo + value01 * (hi - lo),
  };
}
