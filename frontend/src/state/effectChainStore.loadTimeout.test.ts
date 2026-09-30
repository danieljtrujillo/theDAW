/**
 * The read budget is per read, and a timeout is not a failure
 * (T18 third audit, MAJOR 3 — and the original MINOR 4).
 *
 * IndexedDB can simply not answer: an `open` blocked by another tab, a read
 * that never settles. The editor open, the MIX render and every live plugin
 * spawn wait on the loaded signal, so the signal must always settle.
 *
 * Two things the shared 5 s clock got wrong:
 *  - it was armed for every entry at the same instant, so on a project with
 *    many plugins the later reads spent their budget on the shared open and
 *    on queueing behind the earlier ones, and several entries could latch as
 *    failed at once. The budget is now armed when the read's transaction is
 *    actually created.
 *  - a timeout latched the entry as FAILED, which is a claim we cannot make:
 *    a slow store is not an unreadable row. A timeout leaves the entry
 *    PENDING — captures stay refused, which is the safe answer — and only a
 *    real rejection latches it as failed.
 *
 * Run: npx tsx src/state/effectChainStore.loadTimeout.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const row = (s: string) => ({ rawState: s, stateHost: 'thedaw' });
const idb = new FakeIdb([
  ['e1', row('S1')],
  ['e2', row('S2')],
  ['e3', row('S3')],
]);
idb.install();

const vst = (name: string) => ({ plugin_path: `C:/plugins/${name}.vst3`, plugin_name: name });
localMem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: ['e1', 'e2', 'e3'].map((id) => ({ id, effect: 'vst3', params: {}, enabled: true, vst: vst(id) })),
    },
    version: 1,
  }),
);

const { __setVstStateStoreTimeoutsForTest } = await import('../lib/vstStateStorage.ts');
// A shared open that takes most of a shared budget, then reads that each
// answer well inside their own.
__setVstStateStoreTimeoutsForTest({ openMs: 400, txMs: 40 });
idb.openDelayMs = 60;
idb.getDelayMs = 15;

const { useEffectChainStore, vstStatesLoaded, setVstStateStorageErrorHandler, setVstStateLoadListener } =
  await import('./effectChainStore.ts');
const reports: [string, string][] = [];
setVstStateStorageErrorHandler((id, _e, op) => reports.push([id, op]));
const unreadable: [string, string][] = [];
setVstStateLoadListener({
  unreadable: (id, reason) => unreadable.push([id, reason]),
  restored: () => true,
});

/* ── every read gets its OWN budget, so a slow shared open fails nobody ──── */
{
  await vstStatesLoaded;
  await tick(5);
  assert.deepEqual(reports, [], `no read failed: ${JSON.stringify(reports)}`);
  assert.deepEqual(
    useEffectChainStore.getState().chain.map((e) => e.vst?.raw_state),
    ['S1', 'S2', 'S3'],
    'all three states loaded',
  );
}

/* ── a read that never answers: the budget expires, the entry is left
   PENDING (captures refused) and never latched as "failed to read", and the
   user is TOLD rather than left in a silent stall (MINOR 6) ──────────────── */
{
  const second = './effectChainStore.ts?slow=1' as string;
  idb.holdGets = true;
  localMem.set(
    STORE_KEY,
    JSON.stringify({
      state: { chain: [{ id: 'e1', effect: 'vst3', params: {}, enabled: true, vst: vst('e1') }] },
      version: 1,
    }),
  );
  const store2 = (await import(second)) as typeof import('./effectChainStore.ts');
  // A second module instance keeps its own listener, like a second page load.
  const told: [string, string][] = [];
  store2.setVstStateLoadListener({
    unreadable: (id, reason) => told.push([id, reason]),
    restored: () => true,
  });

  // The read is held open for good; the budget is what ends the wait.
  for (let i = 0; i < 100 && told.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(told.length > 0, 'the wait ended on its own, and the user was told');
  assert.match(told[0][1], /did not answer .* within \d+ ms/, `the line names the wait: ${told[0][1]}`);

  assert.equal(store2.isVstStateLoadFailed('e1'), false, 'a slow store is not an unreadable row');
  assert.equal(
    store2.useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw'),
    false,
    'but captures stay refused while nothing is known',
  );
  assert.deepEqual(idb.data.get('e1'), row('S1'), 'and the row is untouched');
  idb.releaseGets();
}

console.log('effectChainStore.loadTimeout: ok');
