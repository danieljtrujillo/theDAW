/**
 * The plugin editor never opens on a state that has not loaded yet (T18
 * audit, MAJOR 3), and a failed load is worded as a LOAD (MINOR 5).
 *
 * On startup a MIX chain entry's `raw_state` arrives from IndexedDB a moment
 * after hydration. Opening the editor in that gap used to hand the live host
 * (and the offline sidecar) an entry with no state — the plugin opened at its
 * defaults, and its next capture wrote those defaults over the saved row.
 * `open()` now waits for `vstStatesLoaded` and re-reads the entry.
 *
 * Run: npx tsx src/state/vstEditorStore.loadGate.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';
import type { ChainEntry } from './effectChainStore.ts';

/* ── window/localStorage shim, installed BEFORE any store import rehydrates
   (same shape as vstEditorStore.live.test.ts) ──────────────────────────── */
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
const windowCore: Record<string, unknown> = {
  localStorage: storage,
  devicePixelRatio: 1,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
const windowShim = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
g.localStorage = storage;
g.window = windowShim;
(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
  throw new Error('network disabled in this test');
}) as typeof fetch;

const idb = new FakeIdb([
  ['e1', { rawState: 'SAVED-1', stateHost: 'thedaw' }],
  ['e2', { rawState: 'SAVED-2', stateHost: 'thedaw' }],
]);
idb.install();
idb.holdGets = true;
idb.failGetKeys.set('e2', new Error('read failed'));

const vst = (name: string) => ({ plugin_path: `C:/VST3/${name}.vst3`, plugin_name: name });
mem.set(
  STORE_KEY,
  JSON.stringify({
    state: {
      chain: [
        { id: 'e1', effect: 'vst3', params: {}, enabled: true, vst: vst('One') },
        { id: 'e2', effect: 'vst3', params: {}, enabled: true, vst: vst('Two') },
      ],
    },
    version: 1,
  }),
);

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');
const { useVstEditorStore, __setLiveHolderForTest, __setLiveWaitClockForTest } = await import('./vstEditorStore.ts');
const { useStatusBarStore } = await import('./statusBarStore.ts');
const { useVstEditorPrefs } = await import('./vstEditorPrefsStore.ts');

const statusTexts: string[] = [];
useStatusBarStore.subscribe((s) => statusTexts.push(s.text));

const held: ChainEntry[] = [];
__setLiveHolderForTest({
  hostAvailable: () => true,
  hold: (entry) => {
    held.push(entry);
    return new Promise(() => {});
  },
  unhold: () => {},
});
__setLiveWaitClockForTest({ schedule: () => 1, cancel: () => {} });
useVstEditorPrefs.getState().setModeForPlugin('C:/VST3/One.vst3', 'floating');

/* ── opening before the state has loaded does not reach the host yet ──────── */
{
  const snapshot = useEffectChainStore.getState().chain[0];
  assert.equal(snapshot.vst?.raw_state, undefined, 'precondition: the state has not arrived');
  useVstEditorStore.getState().open(snapshot, () => {});
  await tick(10);
  assert.equal(held.length, 0, 'no live session is started on an entry whose state is still loading');
}

/* ── once it has, the host gets the entry WITH its saved state ─────────────── */
{
  idb.releaseGets();
  await vstStatesLoaded;
  await tick(10);
  assert.equal(held.length, 1, 'the deferred open went ahead');
  assert.equal(held[0].id, 'e1');
  assert.equal(held[0].vst?.raw_state, 'SAVED-1', 'with the loaded state, not the empty snapshot');
}

/* ── the failed load is worded as a load ───────────────────────────────────── */
{
  const loadLine = statusTexts.find((t) => t.includes('Two') || t.includes('load'));
  assert.ok(loadLine, `a load failure reached the status bar: ${JSON.stringify(statusTexts)}`);
  assert.match(loadLine!, /could not load saved plugin state/);
  assert.match(loadLine!, /read failed/);
  assert.ok(!/failed to save|try again/i.test(loadLine!), `no save/try-again wording on a load failure: ${loadLine}`);
}

useVstEditorStore.getState().close();
console.log('vstEditorStore.loadGate: ok');
