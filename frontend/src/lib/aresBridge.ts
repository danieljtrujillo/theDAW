/**
 * aresBridge - routes the Ares .gan control surface's postMessages onto ONE
 * 'ares' composite chain entry, wherever that entry lives (MIX's effect chain
 * or an EDIT track/master FX chain). The surface's XY Kaoss pad drives the
 * three macro params (X / Y / Z), and every other mapped control sets its own
 * param. Patches are rAF-coalesced (merged per frame) so 60fps pad input never
 * thrashes the store; the live racks push params without a rebuild, so it
 * stays click-free.
 *
 * Exactly ONE bridge is active app-wide: registering a new one detaches the
 * previous owner, so the same message is never applied twice.
 */

/** The chain-entry shape the bridge needs: id + current params. */
export interface AresEntryLike {
  id: string;
  params: Record<string, number>;
}

/* Each Ares .gan control id maps onto one param of the single 'ares' chain
   effect (all normalized 0..1). The XY Kaoss pad is handled separately: its
   X / Y / Z drive the three macro params below. Ids come from the bundled Ares
   project.json: the five knobs, the WET/DRY slider, Freeze, the filter-type
   selector, and the five blade on/off toggles all drive the effect. */
export const ARES_CTRL_PARAM: Record<string, string> = {
  '38c6p1p': 'filterCutoff', // lad_cutoff (on-blade knob)
  '9frddyr': 'delayTime', // lad_time
  ydmrzl8: 'reverbSize', // lad_size
  qwf45ly: 'grainsDensity', // lad_density
  n9rdt84: 'gateRate', // lad_rate
  t4uakcb: 'wetDry', // ares_sword_mix_slider
  p32cjjl: 'freeze', // ares_freeze_btn
  '5lf2jcc': 'filterType', // sel_filter
  tgfilter: 'filterOn', // ares_tgl_filter (blade icon on/off)
  tgdelay: 'delayOn', // ares_tgl_delay
  tgreverb: 'reverbOn', // ares_tgl_reverb
  tggrains: 'grainsOn', // ares_tgl_grains
  tggate: 'gateOn', // ares_tgl_gate
};

// XY pad: X sweeps the filter, Y drives the overall wet amount (obvious impact),
// Z the grain density.
export const ARES_PAD_AXES = ['filterCutoff', 'wetDry', 'grainsDensity'] as const;

/** The bundled Ares project's XY-pad control id, used until the installed
 *  plugin list resolves a fresher id. */
export const ARES_XY_PAD_FALLBACK_ID = 'pf5ixrn';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

interface AresBridgeOptions {
  /** Resolves the XY Kaoss pad's control id at message time (the installed
   *  plugin list can refresh after registration). */
  getXyPadId: () => string;
  /** Returns the 'ares' entry the surface drives right now, or null when the
   *  entry has been removed from its chain. */
  findEntry: () => AresEntryLike | null | undefined;
  /** Writes the merged params back onto that entry's chain. */
  updateParams: (entryId: string, params: Record<string, number>) => void;
}

let activeDetach: (() => void) | null = null;

/** Attach the Ares message bridge; returns an unregister function. The caller
 *  that owns the open surface registers, and its cleanup unregisters. */
export function registerAresBridge(opts: AresBridgeOptions): () => void {
  // Only one surface owner at a time: a new registration displaces the old one.
  if (activeDetach) {
    activeDetach();
    activeDetach = null;
  }
  let raf: number | null = null;
  let pendingPatch: Record<string, number> | null = null;
  const flush = () => {
    raf = null;
    const patch = pendingPatch;
    pendingPatch = null;
    if (!patch) return;
    const entry = opts.findEntry();
    if (!entry) return; // Ares controls act only while an 'ares' entry exists
    opts.updateParams(entry.id, { ...entry.params, ...patch });
  };
  const handler = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== 'updateValue') return;
    let add: Record<string, number> | null = null;
    if (d.id === opts.getXyPadId() && typeof d.valueX === 'number') {
      const axes = [
        d.valueX,
        typeof d.valueY === 'number' ? d.valueY : 0.5,
        typeof d.valueZ === 'number' ? d.valueZ : 0.5,
      ];
      add = {};
      for (let i = 0; i < ARES_PAD_AXES.length; i += 1) add[ARES_PAD_AXES[i]] = clamp01(axes[i]);
    } else {
      const key = ARES_CTRL_PARAM[d.id];
      if (key && typeof d.value === 'number') add = { [key]: clamp01(d.value) };
    }
    if (!add) return;
    pendingPatch = pendingPatch ? { ...pendingPatch, ...add } : add;
    if (raf == null) raf = requestAnimationFrame(flush);
  };
  window.addEventListener('message', handler);
  const detach = () => {
    window.removeEventListener('message', handler);
    if (raf != null) cancelAnimationFrame(raf);
  };
  activeDetach = detach;
  return () => {
    // Unregister only while this bridge is still the active owner (a later
    // registration may have displaced it already).
    if (activeDetach === detach) {
      detach();
      activeDetach = null;
    }
  };
}
