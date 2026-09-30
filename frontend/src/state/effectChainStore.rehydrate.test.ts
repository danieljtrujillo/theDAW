/**
 * effectChainStore rehydrates a captured VST `raw_state` back from IndexedDB
 * on load (FE-003's other half): a chain saved by the NEW code carries no
 * `raw_state` inline (partialize stripped it once IndexedDB confirmed it), so
 * on the next load the running app must pull each entry's blob back from
 * IndexedDB.
 *
 * Until that startup `get` resolves the entry reads as "no state", which is
 * also what a plugin at its DEFAULTS looks like. A capture landing in that
 * gap (a live session spawned on the empty value writing its state back) must
 * never overwrite the saved row (T18 audit, MAJOR 3), and `vstStatesLoaded`
 * is what readers await to never see the gap at all.
 *
 * Run: npx tsx src/state/effectChainStore.rehydrate.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick, waitUntil } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb([['e1', { rawState: 'FROM-INDEXEDDB', stateHost: 'thedaw' }]]);
idb.install();
idb.holdGets = true;

localMem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: [
        {
          id: 'e1',
          effect: 'vst3',
          params: {},
          enabled: true,
          vst: { plugin_path: 'C:/plugins/Ozone 11.vst3', plugin_name: 'Ozone 11' },
        },
      ],
    },
    version: 1,
  }),
);

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');

await new Promise<void>((resolve) => {
  if (useEffectChainStore.persist.hasHydrated()) resolve();
  else useEffectChainStore.persist.onFinishHydration(() => resolve());
});

let loaded = false;
void vstStatesLoaded.then(() => {
  loaded = true;
});

/* ── immediately after hydration, the state has not arrived yet, and the
   loaded signal has not settled ─────────────────────────────────────────── */
{
  const [entry] = useEffectChainStore.getState().chain;
  assert.ok(entry, 'the entry itself hydrated normally');
  assert.equal(entry.vst?.raw_state, undefined);
  await tick(5);
  assert.equal(loaded, false, 'vstStatesLoaded waits for the startup get');
}

/* ── a capture landing before the get resolves cannot overwrite the row ─── */
{
  const accepted = useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw');
  assert.equal(accepted, false, 'a capture over a row still loading is refused');
  await tick(5);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'FROM-INDEXEDDB', stateHost: 'thedaw' }, 'the saved row is intact');
  assert.ok(!idb.ops.some((op) => op.startsWith('put:')), 'no put was even attempted');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined, 'memory did not take the defaults');
  assert.ok(!(localMem.get(STORE_KEY) ?? '').includes('PLUGIN-DEFAULTS'), 'nor did localStorage');
}

/* ── the get resolves: the saved state is what the app sees ────────────────── */
{
  idb.releaseGets();
  await vstStatesLoaded;
  await tick();
  assert.equal(loaded, true, 'vstStatesLoaded settled once the get finished');
  const entry = useEffectChainStore.getState().chain[0];
  assert.equal(entry.vst?.raw_state, 'FROM-INDEXEDDB', 'restored by the time vstStatesLoaded settles');
  assert.equal(entry.vst?.state_host, 'thedaw', 'the stored host name came back with it');
  assert.ok(!(localMem.get(STORE_KEY) ?? '').includes('FROM-INDEXEDDB'), 'never written to localStorage');
}

/* ── after loading, captures are accepted again ───────────────────────────── */
{
  assert.equal(useEffectChainStore.getState().setVstRawState('e1', 'DIALED-IN', 'thedaw'), true);
  await waitUntil(() => (idb.data.get('e1') as { rawState?: string } | undefined)?.rawState === 'DIALED-IN');
  assert.deepEqual(idb.data.get('e1'), { rawState: 'DIALED-IN', stateHost: 'thedaw' });
}

console.log('effectChainStore.rehydrate: ok');
