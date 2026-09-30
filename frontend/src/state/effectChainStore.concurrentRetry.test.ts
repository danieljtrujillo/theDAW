/**
 * Two callers asking for the same entry's state share ONE read
 * (T18 fourth audit, MINOR 4).
 *
 * `retryVstStateLoad` checked "is this entry unresolved?" before "is a read
 * already running?" — and an entry with a read in flight does not count as
 * unresolved. So the second caller was handed an already-resolved promise and
 * carried on as if the state were there: `open()` re-entered with
 * `stateReady: true` while the state was still absent, which is the very gap
 * the gate exists to close.
 *
 * Run: npx tsx src/state/effectChainStore.concurrentRetry.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb([['e1', { rawState: 'GOOD-STATE', stateHost: 'thedaw' }]]);
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

const { useEffectChainStore, vstStatesLoaded, retryVstStateLoad } = await import('./effectChainStore.ts');
await vstStatesLoaded;
await tick(5);

/* ── the read recovers, but is held open: two callers, one read ───────────── */
{
  idb.failGetKeys.delete('e1');
  idb.holdGets = true;

  const settled: string[] = [];
  const first = retryVstStateLoad('e1').then(() => settled.push('first'));
  const second = retryVstStateLoad('e1').then(() => settled.push('second'));
  await tick(5);

  assert.deepEqual(settled, [], 'neither caller may be told the state is there while the read is in flight');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined);

  idb.releaseGets();
  await Promise.all([first, second]);
  assert.deepEqual(settled.sort(), ['first', 'second'], 'both callers wait for the same read');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE');
  assert.equal(idb.ops.filter((o) => o === 'get:e1').length, 1, 'and it really was ONE read');
}

console.log('effectChainStore.concurrentRetry: ok');
