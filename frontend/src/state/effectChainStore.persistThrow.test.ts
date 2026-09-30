/**
 * No store action may throw a storage error at its caller (T18 third audit,
 * MAJOR 5).
 *
 * zustand's persist writes localStorage inside every `set`, and that write
 * can throw `QuotaExceededError`. Only the VST capture was wrapped, so a plain
 * knob move (`updateParams`), a bypass toggle, an add or a remove threw into
 * whatever called them — and a knob move from a plugin's own window arrives
 * inside a timer callback where nothing catches it at all.
 *
 * Every action now routes that throw through the same reporting path, and the
 * in-memory update (which zustand has already applied) stands.
 *
 * Run: npx tsx src/state/effectChainStore.persistThrow.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, tick } from './effectChainStore.fakeIdb.ts';

installLocalStorage();
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

/* ── a plain rack effect: every action survives a failing write ───────────── */
{
  useEffectChainStore.getState().addEffect('volume');
  const id = useEffectChainStore.getState().chain[0].id;
  failWrites = new DOMException('quota', 'QuotaExceededError');

  // The knob move that arrives from a plugin's own window, inside a timer.
  assert.doesNotThrow(() => useEffectChainStore.getState().updateParams(id, { level: 0.5 }));
  assert.doesNotThrow(() => useEffectChainStore.getState().toggleEnabled(id));
  assert.doesNotThrow(() => useEffectChainStore.getState().addEffect('highpass'));
  assert.doesNotThrow(() => useEffectChainStore.getState().addRackEffect('gater'));
  assert.doesNotThrow(() => useEffectChainStore.getState().reorder(0, 1));
  assert.doesNotThrow(() => useEffectChainStore.getState().addVst({ plugin_path: 'C:/p/A.vst3', plugin_name: 'A' }));
  assert.doesNotThrow(() => useEffectChainStore.getState().removeEffect(id));
  assert.doesNotThrow(() => useEffectChainStore.getState().clearChain());
  await tick(5);

  assert.equal(useEffectChainStore.getState().chain.length, 0, 'the in-memory updates all stood');
  assert.ok(reports.length > 0, 'the failed write was reported, not swallowed');
  assert.ok(
    reports.every(([, op]) => op === 'save'),
    `reported as save failures: ${JSON.stringify(reports)}`,
  );
  // Chain edits are USER actions, not a 5 s timer, so each failed one says so
  // (T18 fourth audit, MINOR 5): telling the user once and then silently
  // failing every later edit is how edits end up as orphan rows.
  const chainWrites = reports.filter(([rid]) => rid === '*').length;
  assert.ok(chainWrites >= 5, `every failed chain write is reported: ${JSON.stringify(reports)}`);
}

/* ── an id that is removed and re-added reports its next failure again
   (third audit, MINOR 8: undo of a delete reuses the id) ─────────────────── */
{
  failWrites = null;
  useEffectChainStore.setState({
    chain: [
      { id: 'reused', effect: 'vst3', params: {}, enabled: true, vst: { plugin_path: 'C:/p/B.vst3', plugin_name: 'B' } },
    ],
  });
  // No IndexedDB failure needed: the first save failure for this id is
  // reported, the second suppressed.
  idb.failPuts = new Error('store is down');
  useEffectChainStore.getState().setVstRawState('reused', 'ONE', 'thedaw');
  await tick(5);
  const afterFirst = reports.filter(([rid]) => rid === 'reused').length;
  assert.equal(afterFirst, 1, 'the first failure for this id is reported');

  useEffectChainStore.getState().setVstRawState('reused', 'TWO', 'thedaw');
  await tick(5);
  assert.equal(reports.filter(([rid]) => rid === 'reused').length, 1, 'the repeat is suppressed');

  // Removed and added back under the same id (an undo of a delete).
  useEffectChainStore.getState().removeEffect('reused');
  useEffectChainStore.setState({
    chain: [
      { id: 'reused', effect: 'vst3', params: {}, enabled: true, vst: { plugin_path: 'C:/p/B.vst3', plugin_name: 'B' } },
    ],
  });
  useEffectChainStore.getState().setVstRawState('reused', 'THREE', 'thedaw');
  await tick(5);
  assert.equal(
    reports.filter(([rid]) => rid === 'reused').length,
    2,
    'a re-added entry reports its own first failure',
  );
  idb.failPuts = null;
}

console.log('effectChainStore.persistThrow: ok');
