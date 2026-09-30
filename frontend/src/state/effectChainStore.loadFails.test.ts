/**
 * A startup `get` that FAILS (T18 audit, MAJOR 3): IndexedDB is readable
 * enough to open but the read itself errors. The saved row may still hold the
 * user's state — we just could not read it this session — so:
 *  - the failure is reported as a LOAD failure,
 *  - `vstStatesLoaded` still settles (readers are not blocked forever),
 *  - no capture ever overwrites that row, in this session OR a later one:
 *    the capture is refused (an inline copy is what the next launch would put
 *    over the surviving row), and the read is retried instead — see
 *    effectChainStore.loadFailSession.test.ts.
 *
 * Run: npx tsx src/state/effectChainStore.loadFails.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb([
  ['bad', { rawState: 'SAVED-BUT-UNREADABLE', stateHost: 'thedaw' }],
  ['good', { rawState: 'SAVED-GOOD', stateHost: 'pedalboard' }],
]);
idb.install();
idb.failGetKeys.set('bad', new Error('broken partition'));

const vst = (name: string) => ({ plugin_path: `C:/plugins/${name}.vst3`, plugin_name: name });
localMem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: [
        { id: 'bad', effect: 'vst3', params: {}, enabled: true, vst: vst('Bad') },
        { id: 'good', effect: 'vst3', params: {}, enabled: true, vst: vst('Good') },
      ],
    },
    version: 1,
  }),
);

const { useEffectChainStore, setVstStateStorageErrorHandler, vstStatesLoaded } = await import('./effectChainStore.ts');
const reports: [string, string, string][] = [];
setVstStateStorageErrorHandler((entryId, error, op) =>
  reports.push([entryId, op, error instanceof Error ? error.message : String(error)]),
);

await vstStatesLoaded;
await tick(5);

const persisted = () => JSON.parse(localMem.get(STORE_KEY) ?? 'null');
const stored = (id: string) => persisted().state.chain.find((e: { id: string }) => e.id === id);

/* ── the failure is reported as a load, the other entry loads normally ────── */
{
  assert.deepEqual(reports, [['bad', 'load', 'broken partition']]);
  const chain = useEffectChainStore.getState().chain;
  assert.equal(chain[0].vst?.raw_state, undefined, 'nothing could be read for the failed entry');
  assert.equal(chain[1].vst?.raw_state, 'SAVED-GOOD');
}

/* ── a capture on the failed entry is refused outright: keeping it inline
   would be put over the surviving row on the NEXT launch (re-audit MAJOR 1) ── */
{
  const putsBefore = idb.ops.filter((o) => o === 'put:bad').length;
  assert.equal(useEffectChainStore.getState().setVstRawState('bad', 'NEW-CAPTURE', 'thedaw'), false);
  await tick(5);
  assert.equal(idb.ops.filter((o) => o === 'put:bad').length, putsBefore, 'no put over a row that failed to load');
  assert.deepEqual(idb.data.get('bad'), { rawState: 'SAVED-BUT-UNREADABLE', stateHost: 'thedaw' });
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined, 'memory did not take it');
  assert.equal(stored('bad').vst.raw_state, undefined, 'and neither did localStorage');
  useEffectChainStore.getState().updateParams('bad', { a: 1 });
  assert.equal(stored('bad').vst.raw_state, undefined, 'on every later write');
}

/* ── the startup GC does not touch a row whose load failed ─────────────────── */
{
  assert.ok(idb.data.has('bad'));
  assert.ok(idb.data.has('good'));
}

console.log('effectChainStore.loadFails: ok');
