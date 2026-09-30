/**
 * effectChainStore — the MIX chain, and WHICH HOST produced a plugin's saved
 * state.
 *
 * A plugin's state blob is NOT portable between theDAW's live host and the
 * offline pedalboard renderer (measured in T40b: iZotope Vinyl and Ozone reject
 * each other's component state, AIR accepts the blob and then ignores it). So a
 * `raw_state` is only meaningful together with the host that wrote it, and the
 * entry has to remember which one that was — otherwise the render path feeds a
 * blob to a host that will silently do nothing with it.
 *
 * ABSENT MEANS PEDALBOARD. Every project saved before this field existed was
 * captured by the old editor sidecar, so the absent case must keep behaving
 * exactly as it did, and `vstStateHost` is the one place that decision lives.
 *
 * Run: npx tsx src/state/effectChainStore.test.ts
 */
import assert from 'node:assert/strict';

import type { ChainEntry } from './effectChainStore.ts';

// The store is `persist`-wrapped and rehydrates in its MODULE BODY, so the
// storage shim has to exist before that body runs — hence the dynamic import
// below rather than a static one (ESM evaluates every static import first).
// zustand's default storage reads `window.localStorage`, so BOTH have to be
// there; without them every write logs "storage is currently unavailable".
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
  const g = globalThis as unknown as { localStorage: Storage; window?: { localStorage: Storage } };
  g.localStorage = storage;
  if (typeof g.window === 'undefined') g.window = { localStorage: storage };
}

const { useEffectChainStore, vstStateHost } = await import('./effectChainStore.ts');

const st = () => useEffectChainStore.getState();
const reset = () => useEffectChainStore.setState({ chain: [] });
const only = (): ChainEntry => {
  const [e] = st().chain;
  assert.ok(e, 'expected exactly one chain entry');
  return e;
};

const PLUGIN = { plugin_path: 'C:/plugins/Ozone 11.vst3', plugin_name: 'Ozone 11' };

/* ── a freshly added plugin has no state and therefore no origin ───────────── */
{
  reset();
  st().addVst(PLUGIN);
  const e = only();
  assert.equal(e.effect, 'vst3');
  assert.equal(e.vst?.raw_state, undefined, 'a new entry starts at the plugin defaults');
  assert.equal(e.vst?.state_host, undefined, 'no state means no origin to record');
}

/* ── the old editor path is the DEFAULT origin ─────────────────────────────── */
{
  reset();
  st().addVst(PLUGIN);
  const id = only().id;
  st().setVstRawState(id, 'AAAA');
  assert.equal(only().vst?.raw_state, 'AAAA');
  assert.equal(
    only().vst?.state_host,
    'pedalboard',
    'a capture that does not name its host is the sidecar, as every pre-existing one was',
  );
  assert.equal(vstStateHost(only().vst), 'pedalboard');
}

/* ── a live capture names theDAW's own host, and flips a legacy entry ───────── */
{
  reset();
  st().addVst(PLUGIN);
  const id = only().id;
  st().setVstRawState(id, 'OLD');
  st().setVstRawState(id, 'LIVE', 'thedaw');
  assert.equal(only().vst?.raw_state, 'LIVE');
  assert.equal(only().vst?.state_host, 'thedaw', 'capturing live re-homes the entry');
  assert.equal(vstStateHost(only().vst), 'thedaw');
}

/* ── an absent / undefined vst reads as pedalboard, never as thedaw ────────── */
{
  assert.equal(vstStateHost(undefined), 'pedalboard', 'an entry with no plugin is not live-homed');
  assert.equal(
    vstStateHost({ plugin_path: 'p', plugin_name: 'p', raw_state: 'X' }),
    'pedalboard',
    'a state written before the field existed came from the sidecar',
  );
}

/* ── a state write never touches a different entry ─────────────────────────── */
{
  reset();
  st().addVst(PLUGIN);
  st().addVst({ plugin_path: 'C:/plugins/Vinyl.vst3', plugin_name: 'Vinyl' });
  const [a, b] = st().chain;
  st().setVstRawState(a.id, 'ONLY-A', 'thedaw');
  assert.equal(st().chain[0].vst?.state_host, 'thedaw');
  assert.equal(st().chain[1].vst?.raw_state, undefined, `${b.vst?.plugin_name} was left alone`);
  assert.equal(st().chain[1].vst?.state_host, undefined);
}

reset();
console.log('effectChainStore: ok');
