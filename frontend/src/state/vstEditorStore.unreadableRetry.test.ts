/**
 * The whole sequence the third T18 audit traced (CRITICAL 1), end to end.
 *
 * A startup read fails, so the refusal latch is on — but the live host was
 * already handed nothing and the plugin is running at its DEFAULTS. The user
 * clicks Edit GUI, the retry reads the row successfully, and the latch comes
 * off. If nothing pushed the row to the running plugin, the plugin would
 * still be at its defaults and its next 5 s capture — now accepted — would
 * put those defaults over the row that had just been read successfully.
 *
 * So the state read by the retry is pushed to the running session first, and
 * the latch comes off only once that has happened. The captures here carry
 * the plugin's ACTUAL defaults value, as the real capture path does.
 *
 * Run: npx tsx src/state/vstEditorStore.unreadableRetry.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';
import type { VstLiveSession } from '../lib/vstLive/sessionRegistry.ts';

/* ── window/localStorage shim ─────────────────────────────────────────────── */
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
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
g.localStorage = storage;
g.window = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
  throw new Error('network disabled in this test');
}) as typeof fetch;

/** What the plugin answers with while it is running at its factory defaults. */
const PLUGIN_DEFAULTS = 'STATE-OF-A-PLUGIN-AT-ITS-DEFAULTS';

const idb = new FakeIdb([['e1', { rawState: 'GOOD-STATE', stateHost: 'thedaw' }]]);
idb.install();
idb.failGetKeys.set('e1', new Error('read failed'));

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
          vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
        },
      ],
    },
    version: 1,
  }),
);

const { useEffectChainStore, vstStatesLoaded, isVstStateLoadFailed } = await import('./effectChainStore.ts');
const { useVstEditorStore, __setLiveSessionLookupForTest, __setLiveWaitClockForTest } = await import(
  './vstEditorStore.ts'
);
const { useVstLiveStore } = await import('./vstLiveStore.ts');
const { useVstEditorPrefs } = await import('./vstEditorPrefsStore.ts');

/* ── the plugin the host is running: spawned with nothing, so at defaults ── */
const calls: string[] = [];
const session = {
  entryId: 'e1',
  sessionId: 's-e1',
  wsUrl: 'ws://x',
  pid: 1,
  stateDirty: false,
  client: {
    setState: (s: string) => calls.push(`setState(${s})`),
    openEditor: () => calls.push('openEditor'),
    closeEditor: () => calls.push('closeEditor'),
    editorRect: () => calls.push('editorRect'),
    getState: () => calls.push('getState'),
    setParams: () => calls.push('setParams'),
  },
} as unknown as VstLiveSession;
__setLiveSessionLookupForTest((id) => (id === 'e1' ? session : undefined));
__setLiveWaitClockForTest({ schedule: () => 1, cancel: () => {} });
useVstLiveStore.getState().setStatus('e1', 'live');
useVstEditorPrefs.getState().setModeForPlugin('C:/VST3/Ozone 11.vst3', 'floating');

await vstStatesLoaded;
await tick(5);

/* ── while the state is unreadable the row SAYS the plugin is on defaults ── */
{
  const rowState = useVstLiveStore.getState().entries['e1'];
  assert.equal(rowState?.stateOrigin, 'state-rejected', 'the FX rack badge reads LIVE · DEFAULTS');
  assert.match(rowState?.stateReason ?? '', /read|saved state/i, `with a reason: ${rowState?.stateReason}`);
}

/* ── the running plugin's own 5 s capture is refused ─────────────────────── */
{
  // The store call every capture path ends in (the editor's 5 s timer, the
  // registry's sink when the host is released).
  useEffectChainStore.getState().setVstRawState('e1', PLUGIN_DEFAULTS, 'thedaw');
  await tick(5);
  assert.deepEqual(idb.data.get('e1'), { rawState: 'GOOD-STATE', stateHost: 'thedaw' }, 'the row survived');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined, 'and memory took nothing');
}

/* ── the user clicks Edit GUI: the read is retried, and what it read is
   pushed to the plugin that is running before the latch comes off ───────── */
{
  idb.failGetKeys.delete('e1');
  const entry = useEffectChainStore.getState().chain[0];
  useVstEditorStore.getState().open(entry, () => {});
  await tick(15);

  assert.ok(calls.includes(`setState(GOOD-STATE)`), `the running plugin was given the row: ${calls.join(',')}`);
  assert.equal(isVstStateLoadFailed('e1'), false, 'and only then is the latch released');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE');
  assert.deepEqual(idb.data.get('e1'), { rawState: 'GOOD-STATE', stateHost: 'thedaw' }, 'never overwritten');
}

/* ── a capture of the DEFAULTS value can no longer reach the row unnoticed:
   the plugin now holds the row, so the next capture is of the row ───────── */
{
  const beforeOrigin = useVstLiveStore.getState().entries['e1']?.stateOrigin;
  assert.equal(beforeOrigin, 'live', 'the row no longer claims defaults');
}

useVstEditorStore.getState().close();
console.log('vstEditorStore.unreadableRetry: ok');
