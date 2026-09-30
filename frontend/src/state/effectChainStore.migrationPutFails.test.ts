/**
 * A failed IndexedDB put during the v0 -> v1 migration must leave the plugin
 * state in localStorage (T18 audit, CRITICAL 1).
 *
 * The old code stripped `raw_state` from every localStorage write whether or
 * not the IndexedDB copy existed, so a QuotaExceededError (or a broken
 * IndexedDB partition) during the migration deleted the user's only copy of
 * the plugin's state on the very next write. The rule: the only copy of a
 * plugin state is never dropped before a second copy is confirmed.
 *
 * Run: npx tsx src/state/effectChainStore.migrationPutFails.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb();
idb.install();
idb.failPuts = new DOMException('quota', 'QuotaExceededError');

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
          vst: { plugin_path: 'C:/plugins/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'LEGACY-STATE' },
        },
      ],
    },
    version: 0,
  }),
);

const { useEffectChainStore, setVstStateStorageErrorHandler } = await import('./effectChainStore.ts');
const reports: [string, string, string][] = [];
setVstStateStorageErrorHandler((entryId, error, op) =>
  reports.push([entryId, op, error instanceof Error ? error.name : String(error)]),
);

await new Promise<void>((resolve) => {
  if (useEffectChainStore.persist.hasHydrated()) resolve();
  else useEffectChainStore.persist.onFinishHydration(() => resolve());
});
await tick(5);

const persisted = () => JSON.parse(localMem.get(STORE_KEY) ?? 'null');

/* ── the put failed, and the blob is still in localStorage ────────────────── */
{
  assert.equal(idb.data.has('e1'), false, 'nothing reached IndexedDB');
  assert.equal(persisted().state.chain[0].vst.raw_state, 'LEGACY-STATE', 'the only copy was kept inline');
  assert.deepEqual(reports, [['e1', 'save', 'QuotaExceededError']], 'and the failure was reported as a save');
}

/* ── and it stays there on every later write ──────────────────────────────── */
{
  useEffectChainStore.getState().updateParams('e1', { foo: 1 });
  useEffectChainStore.getState().toggleEnabled('e1');
  await tick(5);
  assert.equal(persisted().state.chain[0].vst.raw_state, 'LEGACY-STATE', 'later writes keep the blob too');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'LEGACY-STATE', 'and memory has it');
}

/* ── a later capture whose put fails also stays inline (never dropped) ────── */
{
  useEffectChainStore.getState().setVstRawState('e1', 'CAPTURED', 'thedaw');
  await tick(5);
  assert.equal(persisted().state.chain[0].vst.raw_state, 'CAPTURED');
  assert.equal(persisted().state.chain[0].vst.state_host, 'thedaw');
}

/* ── once IndexedDB works again, the next capture moves it out ────────────── */
{
  idb.failPuts = null;
  useEffectChainStore.getState().setVstRawState('e1', 'CAPTURED-2', 'thedaw');
  await tick(10);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'CAPTURED-2', stateHost: 'thedaw' });
  assert.equal(persisted().state.chain[0].vst.raw_state, undefined, 'confirmed, so stripped');
}

console.log('effectChainStore.migrationPutFails: ok');
