/**
 * A failed startup load must not cost the saved row one restart later
 * (T18 re-audit, MAJOR 1).
 *
 * The first fix kept a capture made after a failed load inline in
 * localStorage. `startupLoadFailed` is in-memory only, so the NEXT launch saw
 * an inline blob, treated it as "unconfirmed", and put it straight over the
 * IndexedDB row that had survived — and a capture needs no user action at all
 * (the registry sinks the host's state on release, the editor captures every
 * 5 s). One transient read error then destroyed the only good copy.
 *
 * So a capture on an entry whose load failed is refused outright, exactly like
 * one on an entry still loading, and the read is retried instead.
 *
 * The second "session" is a second module instance of the store (a
 * cache-busted import) over the SAME localStorage and IndexedDB: a real
 * restart, module state and all.
 *
 * Run: npx tsx src/state/effectChainStore.loadFailSession.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb([['e1', { rawState: 'THE-GOOD-STATE', stateHost: 'thedaw' }]]);
idb.install();
idb.failGetKeys.set('e1', new Error('read failed'));

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

/* ── session 1: the load fails, and the capture that follows is refused ───── */
{
  const { useEffectChainStore, vstStatesLoaded, setVstStateStorageErrorHandler } = await import(
    './effectChainStore.ts'
  );
  const reports: [string, string][] = [];
  setVstStateStorageErrorHandler((id, _e, op) => reports.push([id, op]));
  await vstStatesLoaded;
  await tick(5);
  assert.deepEqual(reports, [['e1', 'load']], 'the failure was reported as a load');

  const accepted = useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw');
  assert.equal(accepted, false, 'a capture over a row whose load failed is refused');
  await tick(5);
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined, 'memory did not take it');
  assert.ok(!localMem.get(STORE_KEY)!.includes('PLUGIN-DEFAULTS'), 'and neither did localStorage');
  assert.deepEqual(idb.data.get('e1'), { rawState: 'THE-GOOD-STATE', stateHost: 'thedaw' }, 'the row is untouched');
  setVstStateStorageErrorHandler(null);
}

/* ── the read recovers: a retry (what the editor open asks for) picks the
   saved state up, and captures are accepted again ───────────────────────── */
{
  const { useEffectChainStore, retryVstStateLoad, isVstStateLoadFailed } = await import('./effectChainStore.ts');
  assert.equal(isVstStateLoadFailed('e1'), true);
  idb.failGetKeys.delete('e1');
  await retryVstStateLoad('e1');
  assert.equal(isVstStateLoadFailed('e1'), false, 'the retry cleared the failure');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'THE-GOOD-STATE', 'the saved state arrived');
  assert.equal(useEffectChainStore.getState().setVstRawState('e1', 'DIALED-IN', 'thedaw'), true);
  await tick(10);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'DIALED-IN', stateHost: 'thedaw' });
}

/* ── session 2 (a fresh module instance, same storage): a restart after a
   failed load must still find the saved row, never a defaults blob ──────── */
{
  idb.data.set('e1', { rawState: 'THE-GOOD-STATE', stateHost: 'thedaw' });
  const opsBefore = idb.ops.length;
  const secondSession = './effectChainStore.ts?session=2' as string;
  const { useEffectChainStore: store2 } = (await import(secondSession)) as typeof import('./effectChainStore.ts');
  await tick(10);
  assert.ok(
    !idb.ops.slice(opsBefore).some((o) => o === 'put:e1'),
    `a restart must not put anything over the saved row: ${idb.ops.slice(opsBefore).join(',')}`,
  );
  assert.deepEqual(idb.data.get('e1'), { rawState: 'THE-GOOD-STATE', stateHost: 'thedaw' });
  assert.equal(store2.getState().chain[0].vst?.raw_state, 'THE-GOOD-STATE', 'and it loads normally');
}

console.log('effectChainStore.loadFailSession: ok');
