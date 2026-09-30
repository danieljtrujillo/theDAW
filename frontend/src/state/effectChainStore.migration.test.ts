/**
 * effectChainStore's localStorage/IndexedDB split (FE-003).
 *
 * `raw_state` is a base64 capture of a plugin's full parameter state — up to
 * a few MB for some plugins. Before this, effectChainStore's `persist`
 * middleware kept it inline in the persisted chain, so every store update
 * (a knob move, the live editor's 5s capture tick) re-serialized every loaded
 * plugin's full state blob back into localStorage — exceeding its quota with
 * more than a couple of heavy plugins loaded.
 *
 * This suite pins what a real user's browser must keep doing:
 *  - a chain saved by the OLD code (raw_state inline, no/legacy version) must
 *    still load with every plugin's state intact;
 *  - the only copy of a plugin state is never dropped before a second copy is
 *    confirmed: zustand writes localStorage right after `migrate` returns,
 *    long before the IndexedDB put finishes, and that write (and every write
 *    until the put succeeds) must still carry the blob;
 *  - once the put IS confirmed, the store rewrites localStorage on its own
 *    without the blob, and it never reaches localStorage again.
 *
 * Run: npx tsx src/state/effectChainStore.migration.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, installLocalStorage, STORE_KEY, waitUntil } from './effectChainStore.fakeIdb.ts';

const localMem = installLocalStorage();
const idb = new FakeIdb();
idb.install();
// The migration's put is held open: the worst moment for the localStorage
// write zustand makes right after migrate() returns.
idb.holdPuts = true;

/* ── seed localStorage as the OLD (pre-migration) code would have written it:
   version 0, raw_state inline on the VST entry ─────────────────────────── */
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

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');
const { getVstRawState } = await import('../lib/vstStateStorage.ts');

await new Promise<void>((resolve) => {
  if (useEffectChainStore.persist.hasHydrated()) resolve();
  else useEffectChainStore.persist.onFinishHydration(() => resolve());
});

const persisted = () => JSON.parse(localMem.get(STORE_KEY) ?? 'null');

/* ── a legacy chain keeps loading with its state intact ───────────────────── */
{
  const [entry] = useEffectChainStore.getState().chain;
  assert.ok(entry, 'the legacy entry survived hydration');
  assert.equal(entry.vst?.raw_state, 'LEGACY-STATE', 'this session sees the state exactly as before');
}

/* ── straight after migration, before the put resolves, localStorage still
   holds the blob: it is the ONLY copy ────────────────────────────────────── */
{
  const written = persisted();
  assert.equal(written.version, 1, 'zustand wrote the migrated payload');
  assert.equal(
    written.state.chain[0].vst.raw_state,
    'LEGACY-STATE',
    'the write right after migrate() must keep the blob while the put is unconfirmed',
  );
  assert.equal(idb.data.has('e1'), false, 'the put has not landed yet');

  // Any other write in that window keeps it too.
  useEffectChainStore.getState().updateParams('e1', { foo: 1 });
  assert.equal(persisted().state.chain[0].vst.raw_state, 'LEGACY-STATE', 'a knob move before the put lands keeps the blob');
  await vstStatesLoaded;
}

/* ── the put lands: IndexedDB has it, and localStorage is rewritten without
   it by the store itself, with no further user action ─────────────────── */
{
  idb.releasePuts();
  await waitUntil(() => persisted().state.chain[0].vst.raw_state === undefined);
  const stored = await getVstRawState('e1');
  assert.deepEqual(stored, { rawState: 'LEGACY-STATE', stateHost: undefined });
  assert.ok(!localMem.get(STORE_KEY)!.includes('LEGACY-STATE'), 'once confirmed, the blob leaves localStorage');
  assert.equal(
    useEffectChainStore.getState().chain[0].vst?.raw_state,
    'LEGACY-STATE',
    'the running app still has it in memory',
  );
}

/* ── from here on, raw_state never reaches localStorage again ─────────────── */
{
  useEffectChainStore.getState().updateParams('e1', { foo: 2 });
  const written = localMem.get(STORE_KEY);
  assert.ok(written, 'the store persisted something after the update');
  assert.ok(!written!.includes('LEGACY-STATE'), 'the blob itself must not be in the persisted payload');
  const parsed = JSON.parse(written!);
  assert.equal(parsed.state.chain[0].vst.raw_state, undefined, 'partialize strips a confirmed raw_state');
  assert.equal(parsed.version, 1, 'future loads see the new version and skip the migration');
}

/* ── a NEW capture is kept inline until ITS put is confirmed ──────────────── */
{
  idb.holdPuts = true;
  const accepted = useEffectChainStore.getState().setVstRawState('e1', 'NEWER-STATE', 'thedaw');
  assert.equal(accepted, true);
  assert.equal(persisted().state.chain[0].vst.raw_state, 'NEWER-STATE', 'unconfirmed capture stays inline');
  idb.releasePuts();
  await waitUntil(() => persisted().state.chain[0].vst.raw_state === undefined);
  assert.deepEqual(await getVstRawState('e1'), { rawState: 'NEWER-STATE', stateHost: 'thedaw' });
}

console.log('effectChainStore.migration: ok');
