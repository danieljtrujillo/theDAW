/**
 * mixLiveRack — routes the MIX tab's effect chain (effectChainStore) onto the
 * global player's master-output insert, so the chain's psychoacoustic effects are
 * heard LIVE on the footer transport (whatever the footer is playing) instead of
 * only via an offline bounce. buildEffectChain only builds entries whose id is a
 * rack effect, so backend/VST entries in the same chain are ignored here (they are
 * applied offline by processChain); the psychoacoustic subset is the live insert.
 *
 * The rack lives on the master insert independently of the loaded source, so
 * swapping the source / applying a new clip does NOT rebuild it. Effects never
 * restart, click, or re-initialise (oscillators, autopilot, etc.) when a new clip
 * is applied. Param tweaks are pushed live and click-free; only an
 * add/remove/reorder/toggle rebuilds, and unchanged instances are kept across the
 * rebuild so even that stays click-free.
 *
 * Attached once (idempotent) on the first MIX mount and kept for the session. An
 * EMPTY rack is a clean passthrough, so that costs nothing — but the chain is
 * persisted, so a rack effect left enabled in an earlier session goes live on the
 * GLOBAL insert the moment MIX is first opened and then shapes everything the app
 * plays, from every tab, for the rest of the session. Several of these effects
 * take real level (the HRTF spatializer's distance rolloff above all), which is
 * exactly why that state must never be invisible: `useMixLiveRackStore` and
 * `liveRackEntries` are what MIX's master-insert strip and the footer's MASTER FX
 * indicator read to name what is on the insert right now, `bypassLiveRack` is the
 * one-click way back to a clean master, and playerStore.dumpAudioChain's
 * 'mixLiveRack' probe still answers the same question from the console.
 */
import { create } from 'zustand';
import { useEffectChainStore, MIX_RACK_IDS } from './effectChainStore';
import { getEngineCtx, getMasterInsert, registerChainProbe } from './playerStore';
import { buildEffectChain, ensureChopModule, ensureGranularModule, getRackEffect, type ChainHandle } from '../lib/rackEffects';
import type { ChainEntry } from './effectChainStore';

/** The psychoacoustic subset of the unified chain — the only entries built onto
 *  the live master insert (backend + VST + the 4 collision ids are ignored here;
 *  they are applied offline by processChain). */
const rackSubset = (chain: ChainEntry[]): ChainEntry[] =>
  chain.filter((e) => MIX_RACK_IDS.has(e.effect));

/** Whether the rack is spliced onto the master insert. A module-scope flag can't
 *  drive a render, and the UI whose whole job is to say "your master is not
 *  clean" has to know the moment that becomes true. */
export const useMixLiveRackStore = create<{ attached: boolean }>(() => ({ attached: false }));

/** What is colouring the GLOBAL master right now: on the insert AND enabled. An
 *  empty list means the insert is the clean passthrough it ships as. `attached`
 *  is passed in rather than read from the store here so that a component showing
 *  this list is forced to subscribe to the flag that decides it. */
export const liveRackEntries = (chain: ChainEntry[], attached: boolean): ChainEntry[] =>
  attached ? rackSubset(chain).filter((e) => e.enabled) : [];

/** Display name for a live-rack entry, so MIX and the footer never disagree. */
export const rackEntryLabel = (e: ChainEntry): string =>
  getRackEffect(e.effect)?.label ?? e.label ?? e.effect;

/** Rack effects that change how LOUD the master is, not just how it sounds — the
 *  ones that can answer "why is everything suddenly so quiet". The spatializer is
 *  the worst of them: an HRTF panner on an inverse distance model, roughly a dB
 *  down at its default 1.5 m and about 5 dB down at the 3 m its motion presets
 *  reach. The gates (gater, chop, and Ares' gate stage) duty-cycle the level
 *  away, ring mod multiplies it off-carrier, OWL-Pad's filter programs swallow
 *  whole bands, and the compressor ships with 0 dB of makeup. */
export const LEVEL_TAKING_RACK_IDS: Set<string> = new Set([
  'spatializer', 'gater', 'chop', 'ringmod', 'owlpad', 'compressor', 'ares',
]);

/** Switch every live-rack effect off, leaving the insert a clean passthrough
 *  without throwing away the chain the user built. Written as ONE store update
 *  rather than a toggleEnabled per entry so the rack rebuilds once instead of N
 *  times; the chain is persisted, so the master stays clean next session too. */
export function bypassLiveRack(): void {
  const { chain } = useEffectChainStore.getState();
  const live = (e: ChainEntry): boolean => MIX_RACK_IDS.has(e.effect) && e.enabled;
  if (!chain.some(live)) return;
  useEffectChainStore.setState({ chain: chain.map((e) => (live(e) ? { ...e, enabled: false } : e)) });
}

let handle: ChainHandle | null = null;
let unsub: (() => void) | null = null;
let lastTopo = '';
let lastFull = '';

/** Topology signature (order + effect + enabled) — a change here forces a rebuild;
 *  everything else is a click-free param push. */
const topoSig = (chain: ChainEntry[]): string => {
  let s = '';
  for (const e of chain) s += `${e.id}:${e.effect}:${e.enabled ? 1 : 0}|`;
  return s;
};

/** Which AudioWorklet-backed effects are present + enabled (chop has its own node;
 *  ares embeds the granular worklet in its "grains" stage). */
const workletNeeds = (chain: ChainEntry[]): { chop: boolean; granular: boolean } => ({
  chop: chain.some((e) => e.effect === 'chop' && e.enabled),
  granular: chain.some((e) => e.effect === 'ares' && e.enabled),
});

/** Rebuild the live chain. If a worklet-backed effect is present, preregister its
 *  module on the live context first, then rebuild again so it builds as the real
 *  node rather than the one-shot passthrough the factory falls back to before the
 *  module loads. */
const rebuild = (chain: ChainEntry[]): void => {
  if (!handle) return;
  handle.rebuild(chain);
  const need = workletNeeds(chain);
  const loaders: Promise<void>[] = [];
  if (need.chop) loaders.push(ensureChopModule(getEngineCtx()));
  if (need.granular) loaders.push(ensureGranularModule(getEngineCtx()));
  if (loaders.length) {
    void Promise.all(loaders)
      .then(() => handle?.rebuild(rackSubset(useEffectChainStore.getState().chain)))
      .catch(() => { /* falls back to a clean passthrough */ });
  }
};

/** Reconcile the live rack with the store: rebuild on a topology change, otherwise
 *  push each entry's params live. Cheap no-op when nothing relevant changed. */
const reconcile = (chain: ChainEntry[]): void => {
  if (!handle) return;
  const full = JSON.stringify(chain);
  if (full === lastFull) return;
  lastFull = full;
  const topo = topoSig(chain);
  if (topo !== lastTopo) {
    lastTopo = topo;
    rebuild(chain);
  } else {
    for (const e of chain) handle.updateParams(e.id, e.params);
  }
};

/* What is spliced onto the GLOBAL master insert right now (see the header). */
registerChainProbe('mixLiveRack', () => ({
  attached: handle !== null,
  entries: rackSubset(useEffectChainStore.getState().chain).map((e) => ({
    effect: e.effect,
    enabled: e.enabled,
    params: e.params,
  })),
}));

/** Wire the MIX rack onto the master insert + subscribe to the store. Idempotent,
 *  so it is safe to call on every MIX mount. Never detaches on its own (the rack is
 *  a global master insert that should persist across tab switches). */
export function attachMixLiveRack(): void {
  if (handle) return;
  const { ctx, input, output } = getMasterInsert();
  const chain = rackSubset(useEffectChainStore.getState().chain);
  handle = buildEffectChain(ctx, input, output, chain);
  lastTopo = topoSig(chain);
  lastFull = JSON.stringify(chain);
  const need = workletNeeds(chain);
  if (need.chop || need.granular) rebuild(chain);
  unsub = useEffectChainStore.subscribe((s) => reconcile(rackSubset(s.chain)));
  useMixLiveRackStore.setState({ attached: true });
}

/** Tear the live rack down and restore the clean insert passthrough. Rarely needed
 *  (the rack normally persists for the session); provided for completeness/tests. */
export function detachMixLiveRack(): void {
  if (unsub) { unsub(); unsub = null; }
  if (handle) {
    const { input, output } = getMasterInsert();
    handle.dispose();
    handle = null;
    try { input.connect(output); } catch { /* restore the default passthrough */ }
  }
  lastTopo = '';
  lastFull = '';
  useMixLiveRackStore.setState({ attached: false });
}
