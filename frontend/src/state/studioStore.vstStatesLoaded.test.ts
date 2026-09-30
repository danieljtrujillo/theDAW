/**
 * The MIX render never sends a plugin's EMPTY state while its saved state is
 * still loading from IndexedDB (T18 audit, MAJOR 3). A render started in the
 * startup gap used to post the VST stage with no `raw_state` — the plugin
 * rendered at its defaults. `processChain` now waits for `vstStatesLoaded`
 * before it reads the chain.
 *
 * Run: npx tsx src/state/studioStore.vstStatesLoaded.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;
const windowCore: Record<string, unknown> = { localStorage: storage, setTimeout, clearTimeout, setInterval, clearInterval };
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
g.localStorage = storage;
g.window = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});

const idb = new FakeIdb([['e1', { rawState: 'SAVED-STATE', stateHost: 'thedaw' }]]);
idb.install();
idb.holdGets = true;
mem.set(
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

// effectChainStore needs `window.localStorage` when it is created (its persist
// storage is resolved then); studioStore's import graph (playerStore) reads
// Vite's `import.meta.env` whenever `window` exists, which plain tsx lacks —
// so the chain store is created first and `window` removed before the rest,
// exactly as studioStore.vstStateHost.test.ts runs it (no window at all).
const { vstStatesLoaded } = await import('./effectChainStore.ts');
delete g.window;
const { useStudioStore } = await import('./studioStore.ts');
const { useAdvancedEditorSourceStore } = await import('./advancedEditorStore.ts');

type ProcessVstPayload = Parameters<ReturnType<typeof useStudioStore.getState>['processVst']>[0];
const calls: ProcessVstPayload[] = [];
useAdvancedEditorSourceStore.setState({ sourceFile: new File(['RIFF'], 'source.wav', { type: 'audio/wav' }) });
useStudioStore.setState({
  processVst: async (payload: ProcessVstPayload) => {
    calls.push(payload);
  },
});

const run = useStudioStore.getState().processChain();
await tick(10);
assert.equal(calls.length, 0, 'the render does not read the chain while the state is loading');

/* ── a second click inside the load window must not queue a second render
   (T18 re-audit, MINOR 7: the busy flag is set BEFORE the wait) ─────────── */
assert.equal(useStudioStore.getState().isChainProcessing, true, 'the chain reads as busy while it waits');
const second = useStudioStore.getState().processChain();

idb.releaseGets();
await vstStatesLoaded;
await Promise.all([run, second]);
assert.equal(calls.length, 1, 'the render ran once the state had loaded, and only once');
assert.equal(calls[0].rawState, 'SAVED-STATE', 'with the saved state, not the empty one');

console.log('studioStore.vstStatesLoaded: ok');
