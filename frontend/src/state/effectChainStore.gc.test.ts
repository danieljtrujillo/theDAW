/**
 * Deleting stored plugin states, with two tabs of the SAME app open
 * (T18 re-audit, MAJOR 3 / MAJOR 4).
 *
 * Both tabs persist under one localStorage key, so they hydrate the SAME
 * entry ids: there is no per-tab id space, and "delete only my chain's ids"
 * is not by itself a guard. What keeps the two tabs from diverging is the
 * `storage` event: the tab that did not make the change rehydrates from what
 * the other one wrote, and reloads the states of whatever it now holds.
 *
 * The startup GC is the other half. A row missing from the last-writer-wins
 * chain is not proof of an orphan (the other tab may be mid-write), so a row
 * is deleted only after being seen orphaned on two consecutive startups.
 *
 * "Two tabs" here are two module instances of the store (a cache-busted
 * import) over one localStorage and one IndexedDB.
 *
 * Run: npx tsx src/state/effectChainStore.gc.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

/* ── a localStorage that also delivers `storage` events, as a browser does ── */
const localMem = new Map<string, string>();
const listeners: ((ev: { key: string | null }) => void)[] = [];
const storage = {
  getItem: (k: string) => localMem.get(k) ?? null,
  setItem: (k: string, v: string) => void localMem.set(k, String(v)),
  removeItem: (k: string) => void localMem.delete(k),
  clear: () => localMem.clear(),
  key: (i: number) => [...localMem.keys()][i] ?? null,
  get length() {
    return localMem.size;
  },
} as Storage;
const windowCore: Record<string, unknown> = {
  localStorage: storage,
  addEventListener: (type: string, fn: (ev: { key: string | null }) => void) => {
    if (type === 'storage') listeners.push(fn);
  },
  removeEventListener: () => {},
  setTimeout,
  clearTimeout,
};
const g = globalThis as unknown as { localStorage: Storage; window?: unknown };
g.localStorage = storage;
g.window = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
/** What a browser fires in the OTHER tab after a write. */
const fireStorageEvent = () => {
  for (const fn of [...listeners]) fn({ key: STORE_KEY });
};

const row = (s: string) => ({ rawState: s, stateHost: 'thedaw' });
const idb = new FakeIdb([
  ['a1', row('A1')],
  ['a2', row('A2')],
  ['ghost', row('GHOST')],
]);
idb.install();

const vst = (name: string) => ({ plugin_path: `C:/plugins/${name}.vst3`, plugin_name: name });
const chainPayload = (ids: string[]) =>
  JSON.stringify({
    state: {
      chain: ids.map((id) => ({ id, effect: 'vst3', params: {}, enabled: true, vst: vst(id) })),
    },
    version: 1,
  });
localMem.set(STORE_KEY, chainPayload(['a1', 'a2']));

/* ── tab A starts: the row no chain names is NOT deleted on the first sight ── */
const tabA = await import('./effectChainStore.ts');
await tabA.vstStatesLoaded;
await tabA.vstStateStartupGc;
assert.deepEqual(idb.data.get('ghost'), row('GHOST'), 'one startup is not proof of an orphan');
assert.equal(tabA.useEffectChainStore.getState().chain[0].vst?.raw_state, 'A1', 'its own states loaded');

/* ── tab B opens on the same chain ────────────────────────────────────────── */
const tabBModule = './effectChainStore.ts?tab=B' as string;
const tabB = (await import(tabBModule)) as typeof import('./effectChainStore.ts');
await tabB.vstStatesLoaded;
await tabB.vstStateStartupGc;
assert.equal(tabB.useEffectChainStore.getState().chain.length, 2, 'both tabs hold the same two entries');

/* ── this second startup sees the same orphan again, so now it is collected ─ */
assert.equal(idb.data.has('ghost'), false, 'orphaned on two consecutive startups: collected');
assert.deepEqual(idb.data.get('a1'), row('A1'), 'the rows the chain names are never touched');

/* ── tab B removes one entry: its row goes, and tab A follows the change
   instead of diverging ──────────────────────────────────────────────────── */
{
  tabB.useEffectChainStore.getState().removeEffect('a2');
  await tick(10);
  assert.equal(idb.data.has('a2'), false, 'the removed entry took its row with it');
  fireStorageEvent();
  await tick(10);
  assert.deepEqual(
    tabA.useEffectChainStore.getState().chain.map((e) => e.id),
    ['a1'],
    'tab A rehydrated from what tab B wrote',
  );
  assert.equal(tabA.useEffectChainStore.getState().chain[0].vst?.raw_state, 'A1', 'and reloaded its state');
  assert.deepEqual(idb.data.get('a1'), row('A1'), 'the row it still holds is untouched');
}

/* ── tab B clears its chain: only the ids of that chain are deleted, one by
   one — never the whole store ───────────────────────────────────────────── */
{
  tabB.useEffectChainStore.getState().clearChain();
  await tick(10);
  assert.equal(idb.data.has('a1'), false);
  assert.ok(!idb.ops.includes('clear'), 'the whole store is never cleared');
  fireStorageEvent();
  await tick(10);
  assert.deepEqual(tabA.useEffectChainStore.getState().chain, [], 'tab A followed the clear');
}

console.log('effectChainStore.gc: ok');
