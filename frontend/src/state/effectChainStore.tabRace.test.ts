/**
 * Two writes racing across tabs (T18 third audit, MINOR 6).
 *
 *  - `writePersisted` runs from an IndexedDB callback, long after the state it
 *    is about to write was read. Writing this tab's whole chain then would
 *    overwrite an edit another tab made in between, so the rewrite is skipped
 *    when the stored payload is no longer the one this tab last saw.
 *  - a rehydrate triggered by the other tab replaces the chain, and with it
 *    the in-memory blob of a capture whose put has not landed yet. That
 *    capture is the only copy there is, so the reload keeps it.
 *
 * Run: npx tsx src/state/effectChainStore.tabRace.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb();
idb.install();

const vstEntry = (id: string) => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: `C:/plugins/${id}.vst3`, plugin_name: id },
});
localMem.set(STORE_KEY, JSON.stringify({ state: { chain: [vstEntry('e1')] }, version: 1 }));

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');
await vstStatesLoaded;
await tick(5);

/* ── the confirm-time rewrite does not clobber another tab's newer edit ──── */
{
  idb.holdPuts = true;
  useEffectChainStore.getState().setVstRawState('e1', 'CAPTURE', 'thedaw');

  // The other tab writes a chain of its own while our put is in flight.
  const otherTabPayload = JSON.stringify({ state: { chain: [vstEntry('e1'), vstEntry('from-other-tab')] }, version: 1 });
  localMem.set(STORE_KEY, otherTabPayload);

  idb.releasePuts();
  await tick(10);
  assert.equal(
    localMem.get(STORE_KEY),
    otherTabPayload,
    'the rewrite after the put must not replace a payload written since',
  );
  assert.deepEqual(idb.data.get('e1'), { rawState: 'CAPTURE', stateHost: 'thedaw' }, 'the capture is stored');
}

/* ── a rehydrate does not drop a capture whose put is still in flight ────── */
{
  idb.holdPuts = true;
  useEffectChainStore.getState().setVstRawState('e1', 'IN-FLIGHT', 'thedaw');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'IN-FLIGHT');

  // The other tab's write arrives: same entry, no blob in the payload.
  localMem.set(STORE_KEY, JSON.stringify({ state: { chain: [vstEntry('e1')] }, version: 1 }));
  await useEffectChainStore.persist.rehydrate();
  await tick(10);
  assert.equal(
    useEffectChainStore.getState().chain[0].vst?.raw_state,
    'IN-FLIGHT',
    'the only copy of the capture survived the rehydrate',
  );

  idb.releasePuts();
  await tick(10);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'IN-FLIGHT', stateHost: 'thedaw' });
}

console.log('effectChainStore.tabRace: ok');
