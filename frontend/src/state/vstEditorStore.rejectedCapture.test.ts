/**
 * A plugin the HOST could not restore must not write its defaults over the
 * saved row (T18 fourth audit, CRITICAL 1).
 *
 * `sessionRegistry` already knows when a restore was refused — it sets the
 * row's `stateOrigin` to `state-rejected` — but that only changed a badge.
 * The capture timer is unconditional, so five seconds after the rejection the
 * plugin's FACTORY DEFAULTS were captured and stored over the state the user
 * had dialed in. No read ever failed here: this is an entry whose state was
 * read perfectly and handed to a host that would not take it.
 *
 * The other half matters just as much: once the user HAS moved something on
 * the defaulted plugin, that capture is wanted — it is their new sound, and
 * refusing it forever would lose their work instead.
 *
 * Run: npx tsx src/state/vstEditorStore.rejectedCapture.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';
import type { VstLiveSession, VstSessionRegistry } from '../lib/vstLive/sessionRegistry.ts';
import type { ChainEntry } from './effectChainStore.ts';

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

/** What the plugin answers while it is running at its factory defaults. */
const PLUGIN_DEFAULTS = 'STATE-OF-A-PLUGIN-AT-ITS-DEFAULTS';

const idb = new FakeIdb([['e1', { rawState: 'GOOD-STATE', stateHost: 'thedaw' }]]);
idb.install();

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

const { useEffectChainStore, vstStatesLoaded } = await import('./effectChainStore.ts');
const { captureLiveVstStates, __setLiveSessionLookupForTest, __simulateLiveEditorGestureForTest } = await import(
  './vstEditorStore.ts'
);
const { createVstLiveNode } = await import('../lib/vstLive/vstLiveNode.ts');
const { useVstLiveStore } = await import('./vstLiveStore.ts');

const session = {
  entryId: 'e1',
  sessionId: 's-e1',
  wsUrl: 'ws://x',
  pid: 1,
  stateDirty: false,
  userMovedOnRejectedState: false,
  client: {
    // The host answers get_state with what the plugin actually holds.
    getState: () => session.stateSink?.(PLUGIN_DEFAULTS),
    setState: () => {},
    openEditor: () => {},
    closeEditor: () => {},
    editorRect: () => {},
    setParams: () => {},
    // Exercised by the `pushParams` scenario below — a real chain-rebuild
    // param push calls this on the wire.
    setParam: () => {},
  },
} as unknown as VstLiveSession;
__setLiveSessionLookupForTest((id) => (id === 'e1' ? session : undefined));

await vstStatesLoaded;
await tick(5);
assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE', 'the row was read fine');

// The plugin spawned, the host refused the state, and the editor is open — so
// the 5 s timer asks this session for its state every tick.
useVstLiveStore.getState().setStatus('e1', 'live');
useVstLiveStore.getState().setEditorOpen('e1', true);
useVstLiveStore.getState().setStateOrigin('e1', 'state-rejected', 'plugin refused the state');

/* ── the tick after the rejection captures the DEFAULTS: refused ──────────── */
{
  await captureLiveVstStates({ sessions: () => [session], timeoutMs: 50 });
  await tick(10);
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE', 'memory kept the row');
  assert.deepEqual(idb.data.get('e1'), { rawState: 'GOOD-STATE', stateHost: 'thedaw' }, 'and so did the store');
  assert.ok(!(mem.get(STORE_KEY) ?? '').includes(PLUGIN_DEFAULTS), 'nothing of the defaults was persisted');
}

/* ── a refused capture must NOT clear the dirty flag (T18 fifth audit,
   CRITICAL 1 secondary): the next attempt has to keep trying ─────────────── */
{
  session.stateDirty = true;
  await captureLiveVstStates({ sessions: () => [session], timeoutMs: 50 });
  await tick(10);
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'GOOD-STATE', 'still refused');
  assert.equal(session.stateDirty, true, 'a refused write must not clear stateDirty — the next save retries');
}

/* ── pushParams -> markParamsChanged -> capture on a state-rejected row must
   NOT write (T18 fifth audit, CRITICAL 1: the REAL chain-rebuild path, not a
   hand-set flag). A rebuild's unconditional param re-push marks `stateDirty`
   exactly like a genuine change — that alone must never unlock the guard. ── */
{
  session.stateDirty = false;
  session.userMovedOnRejectedState = false;

  class FakeParam {
    value = 0;
    setValueAtTime(): this {
      return this;
    }
    linearRampToValueAtTime(v: number): this {
      this.value = v;
      return this;
    }
    cancelScheduledValues(): this {
      return this;
    }
  }
  class FakeGain {
    gain = new FakeParam();
    connect(dest: unknown): unknown {
      return dest;
    }
    disconnect(): void {}
  }
  class FakeCtx {
    currentTime = 0;
    sampleRate = 48000;
    audioWorklet = { addModule: async () => {} };
    createGain(): FakeGain {
      return new FakeGain();
    }
  }
  class FakeWorklet {
    port = { onmessage: null as unknown, postMessage: () => {} };
    onprocessorerror: (() => void) | null = null;
    connect(dest: unknown): unknown {
      return dest;
    }
    disconnect(): void {}
  }
  class FakeRegistry implements VstSessionRegistry {
    acquire(): Promise<VstLiveSession | null> {
      return Promise.resolve(session);
    }
    release(): void {}
    hold(): Promise<null> {
      return Promise.resolve(null);
    }
    unhold(): void {}
    forget(): void {}
    close(): void {}
    closeAll(): void {}
    retry(): void {}
    get(): VstLiveSession | undefined {
      return session;
    }
    sessions(): VstLiveSession[] {
      return [session];
    }
    markParamsChanged(entryId: string): void {
      if (entryId === session.entryId) session.stateDirty = true;
    }
    markUserParamsChanged(entryId: string): void {
      if (entryId === session.entryId) {
        session.stateDirty = true;
        session.userMovedOnRejectedState = true;
      }
    }
    hostAvailable(): boolean | null {
      return true;
    }
    sessionIds(): string[] {
      return [session.sessionId];
    }
  }

  const nodeEntry: ChainEntry = {
    id: 'e1',
    effect: 'vst3',
    params: { p0: 0.2 },
    enabled: true,
    vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
  };
  const inst = createVstLiveNode(new FakeCtx() as unknown as BaseAudioContext, nodeEntry, {
    registry: new FakeRegistry(),
    parkMs: 0, // immediate teardown on dispose(); this test does not exercise parking
    ensureModule: async () => {},
    makeWorklet: () => new FakeWorklet() as unknown as AudioWorkletNode,
  })!;
  await tick(5); // let the node's acquire() resolve and its session assignment land

  // A genuine value change — exactly what a chain rebuild re-pushes — reaches
  // pushParams and marks the session stale through the SAME registry method a
  // real rebuild uses, never through the user-gesture one.
  inst.setParams({ p0: 0.9 });
  assert.equal(session.stateDirty, true, 'pushParams marked the session stale, as a real rebuild would');
  assert.equal(
    session.userMovedOnRejectedState,
    false,
    'a chain-rebuild push must never look like a user gesture',
  );

  await captureLiveVstStates({ sessions: () => [session], timeoutMs: 50 });
  await tick(10);
  assert.equal(
    useEffectChainStore.getState().chain[0].vst?.raw_state,
    'GOOD-STATE',
    'a rebuild-driven stateDirty must not unlock the rejection guard',
  );
  inst.dispose();
}

/* ── the user turns a knob on the defaulted plugin: THAT capture is theirs
   (T18 fifth audit, CRITICAL 1: driven through the REAL user-gesture path —
   what `gestureSink`/`paramSink` call in the plugin's own editor window —
   never a hand-set flag) ─────────────────────────────────────────────────── */
{
  __simulateLiveEditorGestureForTest('e1');
  assert.equal(session.userMovedOnRejectedState, true, 'the simulated gesture set the real flag');
  await captureLiveVstStates({ sessions: () => [session], timeoutMs: 50 });
  await tick(10);
  assert.equal(
    useEffectChainStore.getState().chain[0].vst?.raw_state,
    PLUGIN_DEFAULTS,
    'a capture after the user moved something is their new sound, and is kept',
  );
  assert.deepEqual(idb.data.get('e1'), { rawState: PLUGIN_DEFAULTS, stateHost: 'thedaw' });
}

console.log('vstEditorStore.rejectedCapture: ok');
