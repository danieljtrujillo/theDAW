/**
 * No IndexedDB at all (T18 audit, CRITICAL 2): a browser with IndexedDB
 * disabled, a private window that refuses it, a sandboxed frame. Every put
 * rejects, so there is never a second copy — `raw_state` must stay inline in
 * localStorage exactly as it did before T18, never dropped.
 *
 * Run: npx tsx src/state/effectChainStore.noIndexedDb.test.ts
 */
import assert from 'node:assert/strict';
import { installLocalStorage, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, 'undefined', 'precondition: no IndexedDB');

localMem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: [
        {
          id: 'legacy',
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

const { useEffectChainStore, setVstStateStorageErrorHandler, vstStatesLoaded } = await import('./effectChainStore.ts');
const reports: [string, string][] = [];
setVstStateStorageErrorHandler((entryId, _error, op) => reports.push([entryId, op]));

await new Promise<void>((resolve) => {
  if (useEffectChainStore.persist.hasHydrated()) resolve();
  else useEffectChainStore.persist.onFinishHydration(() => resolve());
});
await vstStatesLoaded;
await tick(5);

const persisted = () => JSON.parse(localMem.get(STORE_KEY) ?? 'null');
const entry = (id: string) => persisted().state.chain.find((e: { id: string }) => e.id === id);

/* ── the legacy blob survives the migration ───────────────────────────────── */
assert.equal(entry('legacy').vst.raw_state, 'LEGACY-STATE');
assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'LEGACY-STATE');

/* ── a new capture is written inline, as before T18 ───────────────────────── */
useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Vinyl.vst3', plugin_name: 'Vinyl' });
const id = useEffectChainStore.getState().chain[1].id;
assert.equal(useEffectChainStore.getState().setVstRawState(id, 'NEW-STATE', 'thedaw'), true);
await tick(5);
assert.equal(entry(id).vst.raw_state, 'NEW-STATE', 'the capture is in localStorage');
useEffectChainStore.getState().updateParams(id, { a: 1 });
assert.equal(entry(id).vst.raw_state, 'NEW-STATE', 'and stays there on later writes');
assert.equal(entry('legacy').vst.raw_state, 'LEGACY-STATE');

/* ── and each failed save was reported, not swallowed ─────────────────────── */
assert.ok(reports.some(([rid, op]) => rid === 'legacy' && op === 'save'), `legacy save reported: ${JSON.stringify(reports)}`);
assert.ok(reports.some(([rid, op]) => rid === id && op === 'save'), `new save reported: ${JSON.stringify(reports)}`);

/* ── and a repeated failure for the same entry is reported ONCE per session
   (T18 re-audit, MINOR 6): the live editor captures every 5 s, and a status
   bar line every 5 s for the same unavailable store is noise ────────────── */
{
  const before = reports.filter(([rid]) => rid === id).length;
  useEffectChainStore.getState().setVstRawState(id, 'NEW-STATE-2', 'thedaw');
  useEffectChainStore.getState().setVstRawState(id, 'NEW-STATE-3', 'thedaw');
  await tick(5);
  assert.equal(reports.filter(([rid]) => rid === id).length, before, 'no second report for the same entry');
  assert.equal(entry(id).vst.raw_state, 'NEW-STATE-3', 'every capture is still kept inline');
}

console.log('effectChainStore.noIndexedDb: ok');
