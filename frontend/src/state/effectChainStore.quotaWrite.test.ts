/**
 * A localStorage quota error while capturing must not throw out of
 * `setVstRawState` (T18 re-audit, MAJOR 2).
 *
 * The capture writes the store first, and zustand's persist `setItem` runs
 * inside that write with no catch of its own. A large inline capture that
 * exceeds the localStorage quota therefore threw before the IndexedDB put was
 * even started: the capture reached NEITHER store, nothing was reported, and
 * the throw escaped into the save path that called it.
 *
 * The in-memory update is already applied when that throw happens, so the
 * capture continues to IndexedDB — which is exactly where a blob too big for
 * localStorage belongs — and the localStorage failure is reported.
 *
 * Run: npx tsx src/state/effectChainStore.quotaWrite.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb();
idb.install();

let failWrites: Error | null = null;
const realSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
globalThis.localStorage.setItem = (k: string, v: string) => {
  if (failWrites) throw failWrites;
  realSetItem(k, v);
};

const { useEffectChainStore, setVstStateStorageErrorHandler, vstStatesLoaded } = await import('./effectChainStore.ts');
const reports: [string, string][] = [];
setVstStateStorageErrorHandler((id, _e, op) => reports.push([id, op]));
await vstStatesLoaded;

useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Ozone 11.vst3', plugin_name: 'Ozone 11' });
const id = useEffectChainStore.getState().chain[0].id;

/* ── the quota error does not escape, and the capture still reaches IndexedDB ── */
{
  failWrites = new DOMException('quota', 'QuotaExceededError');
  let threw: unknown = null;
  let accepted = false;
  try {
    accepted = useEffectChainStore.getState().setVstRawState(id, 'HUGE-STATE', 'thedaw');
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, 'setVstRawState must not throw at its caller');
  assert.equal(accepted, true, 'the capture was accepted');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'HUGE-STATE', 'memory has it');
  await tick(10);
  assert.deepEqual(idb.data.get(id), { rawState: 'HUGE-STATE', stateHost: 'thedaw' }, 'IndexedDB has it');
  assert.ok(
    reports.some(([rid, op]) => rid === id && op === 'save'),
    `the localStorage failure was reported: ${JSON.stringify(reports)}`,
  );
}

/* ── once localStorage works again the payload is written, without the blob ── */
{
  failWrites = null;
  useEffectChainStore.getState().updateParams(id, { a: 1 });
  const payload = JSON.parse(localMem.get(STORE_KEY) ?? 'null');
  assert.equal(payload.state.chain[0].vst.raw_state, undefined, 'confirmed in IndexedDB, so stripped');
}

console.log('effectChainStore.quotaWrite: ok');
