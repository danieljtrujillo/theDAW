/**
 * `loadedVstEntry` (installed by `effectChainStore.ts`, backing
 * `sessionRegistry.recreate()`'s re-read) used to search only this store's
 * own MIX chain -- `useEffectChainStore.getState().chain.find(...)` -- and
 * return `undefined` for anything else. `recreate()` falls through to
 * `?? slot.entry` on `undefined`, which is the STALE entry from the last
 * chain rebuild, so a track `fxChain` entry or a `masterVstChain` entry
 * silently lost every capture recorded since then on every respawn
 * (T18 seventh audit, MAJOR 2). This pins the widened lookup effectChainStore
 * installs, which walks all three chains the same way `sinkLiveRawState` in
 * `vstEditorStore.ts` does.
 *
 * Run: npx tsx src/state/effectChainStore.loadedVstEntryLookup.test.ts
 */
import assert from 'node:assert/strict';
import { installLocalStorage, tick } from './effectChainStore.fakeIdb.ts';

installLocalStorage();

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');
const { useEditorStore } = await import('./editorStore.ts');
const { loadedVstEntry } = await import('../lib/vstStateStorage.ts');

await vstStatesLoaded;
await tick(5);

/* ── a track entry is found, not just the MIX chain ────────────────────────── */
{
  const trackId = useEditorStore.getState().addTrack();
  useEditorStore.setState((s) => ({
    tracks: s.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            fxChain: [
              {
                id: 'track-e1',
                effect: 'vst3',
                params: {},
                enabled: true,
                vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'TRACK-S1' },
              },
            ],
          }
        : t,
    ),
  }));

  assert.equal(
    useEffectChainStore.getState().chain.find((e) => e.id === 'track-e1'),
    undefined,
    'the entry is not in the MIX chain at all',
  );
  const found = loadedVstEntry('track-e1');
  assert.ok(found, 'the track entry is found by loadedVstEntry');
  assert.equal(found?.vst?.raw_state, 'TRACK-S1', 'with its CURRENT raw_state, not a stale one');

  // The exact regression: a capture writes a NEWER state after the last
  // rebuild, with no `ensure()` call to refresh any cached `slot.entry`.
  // `recreate()`'s re-read must see it too.
  useEditorStore.getState().setTrackVstRawState(trackId, 'track-e1', 'TRACK-S2', 'thedaw');
  assert.equal(loadedVstEntry('track-e1')?.vst?.raw_state, 'TRACK-S2', 'and the re-read sees the newest capture');
}

/* ── a master VST entry is found too ───────────────────────────────────────── */
{
  useEditorStore.setState({
    masterVstChain: [
      {
        id: 'master-e1',
        effect: 'vst3',
        params: {},
        enabled: true,
        vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'MASTER-S1' },
      },
    ],
  });

  assert.equal(
    useEffectChainStore.getState().chain.find((e) => e.id === 'master-e1'),
    undefined,
    'not in the MIX chain either',
  );
  const found = loadedVstEntry('master-e1');
  assert.ok(found, 'the master entry is found by loadedVstEntry');
  assert.equal(found?.vst?.raw_state, 'MASTER-S1');

  useEditorStore.getState().setMasterVstRawState('master-e1', 'MASTER-S2', 'thedaw');
  assert.equal(loadedVstEntry('master-e1')?.vst?.raw_state, 'MASTER-S2', 'and the re-read sees the newest capture');
}

/* ── an id in none of the three chains stays undefined ─────────────────────── */
assert.equal(loadedVstEntry('nope'), undefined);

console.log('effectChainStore.loadedVstEntryLookup: ok');
