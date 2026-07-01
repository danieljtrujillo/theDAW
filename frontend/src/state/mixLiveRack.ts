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
 * Attached once (idempotent) on the first MIX mount and kept for the session — an
 * empty rack is a clean passthrough, so leaving it attached colours nothing and
 * costs nothing.
 */
import { useEffectChainStore, MIX_RACK_IDS } from './effectChainStore';
import { getEngineCtx, getMasterInsert } from './playerStore';
import { buildEffectChain, ensureChopModule, ensureGranularModule, type ChainHandle } from '../lib/rackEffects';
import type { ChainEntry } from './effectChainStore';

/** The psychoacoustic subset of the unified chain — the only entries built onto
 *  the live master insert (backend + VST + the 4 collision ids are ignored here;
 *  they are applied offline by processChain). */
const rackSubset = (chain: ChainEntry[]): ChainEntry[] =>
  chain.filter((e) => MIX_RACK_IDS.has(e.effect));

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
}
