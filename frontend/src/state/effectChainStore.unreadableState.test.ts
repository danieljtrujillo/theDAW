/**
 * An entry whose saved state could not be read (T18 third audit, CRITICAL 1
 * and MAJOR 2), at store level.
 *
 * While the state is unreadable the plugin that is running is at its
 * DEFAULTS, so:
 *  - the entry is marked as running on defaults, once, with the reason — the
 *    user sees it on the FX rack row instead of a plugin that silently sounds
 *    wrong and a capture that is refused every 5 s in silence;
 *  - releasing the refusal latch is NOT enough on its own. A successful retry
 *    hands the restored state to whatever is running; only when the running
 *    plugin matches the row again may captures be accepted, otherwise the very
 *    next capture would put the defaults over the row that was just read.
 *
 * Run: npx tsx src/state/effectChainStore.unreadableState.test.ts
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

const { useEffectChainStore, vstStatesLoaded, setVstStateLoadListener, retryVstStateLoad, isVstStateLoadFailed } =
  await import('./effectChainStore.ts');

const unreadable: [string, string][] = [];
const restored: [string, string][] = [];
let runningPluginMatches = false;
setVstStateLoadListener({
  unreadable: (id, reason) => unreadable.push([id, reason]),
  restored: (id, rawState) => {
    restored.push([id, rawState]);
    return runningPluginMatches;
  },
});

await vstStatesLoaded;
await tick(5);

/* ── the unreadable entry is marked once, with a reason ───────────────────── */
{
  assert.equal(unreadable.length, 1, `marked exactly once: ${JSON.stringify(unreadable)}`);
  assert.equal(unreadable[0][0], 'e1');
  assert.match(unreadable[0][1], /read|saved state/i, 'the mark carries a reason the user can read');

  // The 5 s capture keeps coming; it stays refused, and stays quiet.
  useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw');
  useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw');
  await tick(5);
  assert.equal(unreadable.length, 1, 'and not re-reported on every refused capture');
}

/* ── a retry that cannot make the running plugin match keeps the latch ───── */
{
  idb.failGetKeys.delete('e1');
  runningPluginMatches = false;
  await retryVstStateLoad('e1');
  assert.deepEqual(restored, [['e1', 'GOOD-STATE']], 'the restored state was handed to what is running');
  assert.equal(isVstStateLoadFailed('e1'), true, 'the running plugin still does not match: still latched');
  assert.equal(
    useEffectChainStore.getState().setVstRawState('e1', 'PLUGIN-DEFAULTS', 'thedaw'),
    false,
    'so a capture of the defaults is still refused',
  );
  assert.deepEqual(idb.data.get('e1'), { rawState: 'GOOD-STATE', stateHost: 'thedaw' });
}

/* ── once it does match, the latch is released ────────────────────────────── */
{
  runningPluginMatches = true;
  await retryVstStateLoad('e1');
  assert.equal(isVstStateLoadFailed('e1'), false, 'the latch is released');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE', 'and memory has the row');
  assert.equal(useEffectChainStore.getState().setVstRawState('e1', 'NOW-DIALED-IN', 'thedaw'), true);
  await tick(10);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'NOW-DIALED-IN', stateHost: 'thedaw' });
}

console.log('effectChainStore.unreadableState: ok');
