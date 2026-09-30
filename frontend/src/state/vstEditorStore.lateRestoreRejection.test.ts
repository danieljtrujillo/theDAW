/**
 * T18 sixth audit, CRITICAL 1 -- the full startup-failure -> retry -> host-
 * refusal sequence the finding traced, end to end, through the REAL
 * `sessionRegistry` (not a hand-mocked session): a late `restored()` delivery
 * that the host then refuses must be RECORDED, and must NOT let the next
 * capture write the plugin's untouched factory defaults over the saved row.
 *
 * Sequence:
 *   1. Startup: the IndexedDB read for e1 fails. The row goes to
 *      'state-rejected' and the entry spawns with NO raw_state -- the running
 *      session's `stateSent` starts false.
 *   2. The host comes up ready with nothing sent. A stray/unrelated `ready`
 *      warning mentioning restore failure must NOT be recorded: nothing was
 *      ever sent for it to have refused.
 *   3. The user opens the editor. The retry re-reads the row successfully,
 *      pushes it to the running plugin via `restored()` -- which must mark
 *      the session `stateSent` BEFORE the send -- and the refusal latch
 *      comes off.
 *   4. The plugin refuses the blob it was just handed. Because `stateSent`
 *      is now true, `sessionRegistry`'s `onWarning` handler records the
 *      rejection through its OWN real state-machine (the real
 *      `mentionsState` regex, the real `stateRejected`), not a hand-set flag.
 *   5. The 5 s capture timer fires. The refusal must hold: the row is not
 *      overwritten with the plugin's defaults.
 *
 * Run: npx tsx src/state/vstEditorStore.lateRestoreRejection.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb, STORE_KEY, tick } from './effectChainStore.fakeIdb.ts';
import type { VstBridgeClientOptions } from '../lib/vstLive/bridgeClient.ts';

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

/* ── fake backend for the REAL sessionRegistry (host probe + session POST) ── */
class FakeBackend {
  hostInfo: unknown = { available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' };
  nextPort = 60001;

  fetch = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;

    if (input === '/api/vst/live/host') return json(this.hostInfo);
    if (input === '/api/vst/live/session' && method === 'POST') {
      const req = body as { chain_entry_id: string };
      const port = this.nextPort++;
      return json({
        session_id: `sess-${req.chain_entry_id}`,
        ws_url: `ws://127.0.0.1:${port}`,
        pid: 4242,
        protocol: 1,
      });
    }
    if (method === 'DELETE') return json({ raw_state: 'ZmluYWw=' });
    return json({ detail: `unexpected ${method} ${input}` }, 404);
  };
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stand-in for VstBridgeClient: real enough for the registry to wire up
 *  its handlers, and to let this test fire them the way the host would. */
class FakeClient {
  static made: FakeClient[] = [];
  constructor(readonly opts: VstBridgeClientOptions) {
    FakeClient.made.push(this);
  }
  setState(s: string): void {
    calls.push(`setState(${s})`);
  }
  openEditor(): void {}
  closeEditor(): void {}
  editorRect(): void {}
  getState(): void {}
  setParams(): void {}
  connect(): void {}
  close(): void {}
}
const calls: string[] = [];

(globalThis as { fetch: unknown }).fetch = new FakeBackend().fetch;

/** What the plugin answers while it is running at its factory defaults. */
const PLUGIN_DEFAULTS = 'STATE-OF-A-PLUGIN-AT-ITS-DEFAULTS';

const idb = new FakeIdb([['e1', { rawState: 'GOOD-STATE', stateHost: 'thedaw' }]]);
idb.install();
idb.failGetKeys.set('e1', new Error('read failed')); // step 1: the startup read fails

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
const { useVstEditorStore, __setLiveSessionLookupForTest, __setLiveWaitClockForTest, captureLiveVstStates } =
  await import('./vstEditorStore.ts');
const { useVstLiveStore } = await import('./vstLiveStore.ts');
const { useVstEditorPrefs } = await import('./vstEditorPrefsStore.ts');
const { createVstSessionRegistry } = await import('../lib/vstLive/sessionRegistry.ts');

const registry = createVstSessionRegistry({
  makeClient: (opts) => new FakeClient(opts) as never,
});
__setLiveSessionLookupForTest((id) => registry.get(id));
__setLiveWaitClockForTest({ schedule: () => 1, cancel: () => {} });
useVstEditorPrefs.getState().setModeForPlugin('C:/VST3/Ozone 11.vst3', 'floating');

await vstStatesLoaded;
await tick(5);

/* ── step 1: the row says defaults, the entry has nothing saved to send ────── */
{
  const rowState = useVstLiveStore.getState().entries['e1'];
  assert.equal(rowState?.stateOrigin, 'state-rejected', 'the unreadable row already claims defaults');
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, undefined, 'nothing to spawn with');
}

/* ── the entry spawns with nothing: `stateSent` starts false ───────────────── */
const entry0 = useEffectChainStore.getState().chain[0];
const session = await registry.acquire(entry0, 48000);
assert.ok(session);
assert.equal(session.stateSent, false, 'nothing has been handed to this plugin');

/* ── step 2: a stray restore-failure warning on a session that was sent
   NOTHING must not be recorded ─────────────────────────────────────────────── */
FakeClient.made[0].opts.handlers.onWarning!('the state file was not restored: the plugin rejected it');
assert.equal(
  useVstLiveStore.getState().entries['e1']?.stateOrigin,
  'state-rejected',
  'unchanged -- this was already the unreadable-startup reason, not a fresh one',
);
const reasonBeforeRetry = useVstLiveStore.getState().entries['e1']?.stateReason;

/* ── step 3: the user opens the editor -- the retry succeeds and PUSHES the
   row to the running plugin, marking `stateSent`, before the latch clears ─── */
{
  idb.failGetKeys.delete('e1');
  const entry = useEffectChainStore.getState().chain[0];
  useVstLiveStore.getState().setStatus('e1', 'live');
  useVstEditorStore.getState().open(entry, () => {});
  await tick(15);

  assert.ok(calls.includes('setState(GOOD-STATE)'), `the running plugin was given the row: ${calls.join(',')}`);
  assert.equal(isVstStateLoadFailed('e1'), false, 'the latch is released');
  assert.equal(session.stateSent, true, 'restored() marked the session before it sent the blob');
  useVstEditorStore.getState().close();
}

/* ── step 4: NOW the plugin refuses the blob it was just handed -- in the
   words a REAL VST3 plugin actually sends (`vst3_instance.cpp:939`'s
   `Vst3Instance::setState` refusal), not the one generic phrase the sixth
   audit's test fed instead (T18 seventh audit, CRITICAL 1, TEST finding).
   With `stateSent` true, the registry's REAL onWarning handler must record
   it -- via `mentionsState`, the sole path since the ninth audit proved the
   `armStatePending()` window added no coverage `mentionsState` did not
   already have, while false-rejecting a successful restore's own
   `onRestartRequired` warnings (T18 ninth audit, CRITICAL 1). ─────────────── */
{
  FakeClient.made[0].opts.handlers.onWarning!(
    'the plugin rejected this component state (it is probably from another plugin)',
  );
  const row = useVstLiveStore.getState().entries['e1'];
  assert.equal(row?.stateOrigin, 'state-rejected', 'the refusal of the JUST-SENT blob is recorded');
  assert.equal(
    row?.stateReason,
    'the plugin rejected this component state (it is probably from another plugin)',
    "the host's own words reach the row",
  );
  assert.notEqual(row?.stateReason, reasonBeforeRetry, 'a NEW rejection, not a stale carry-over');
}

/* ── step 5: the capture that follows must NOT overwrite the row with the
   plugin's untouched defaults -- the guard is holding on a real rejection ─── */
{
  // The plugin answers get_state with what it actually holds: its untouched
  // factory defaults, since it refused the restore in step 4.
  session.client.getState = () => session.stateSink?.(PLUGIN_DEFAULTS);
  session.stateDirty = true;
  await captureLiveVstStates({ sessions: () => [session], timeoutMs: 50 });
  await tick(20);
  assert.equal(
    useEffectChainStore.getState().chain[0].vst?.raw_state,
    'GOOD-STATE',
    'the saved state survives -- no factory defaults were written over it',
  );
  assert.notEqual(useEffectChainStore.getState().chain[0].vst?.raw_state, PLUGIN_DEFAULTS);
}

/* ── T18 seventh audit, CRITICAL 1 -- the phrase list on its OWN (no
   `armStatePending()` window: this session's state was sent at SPAWN, from
   `entry.vst.raw_state`, never through a late `restored()` delivery) must
   still catch every wording a real VST3 plugin's own refusal path emits,
   read verbatim from the host source -- this is the "startup restore" path
   the window itself cannot cover, since nothing calls `restored()` for it. ── */
{
  const e2 = {
    id: 'e2',
    effect: 'vst3',
    params: {},
    enabled: true,
    vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'GOOD-STATE-2' },
  };
  const session2 = await registry.acquire(e2, 48000);
  assert.ok(session2);
  assert.equal(session2.stateSent, true, 'sent at spawn, from entry.vst.raw_state');
  const client2 = FakeClient.made[FakeClient.made.length - 1];

  const reset = () => useVstLiveStore.getState().setStateOrigin('e2', 'live');
  const rejected = () => useVstLiveStore.getState().entries['e2']?.stateOrigin === 'state-rejected';

  // vst3_instance.cpp:939 -- Vst3Instance::setState's own component-state refusal.
  reset();
  client2.opts.handlers.onWarning!('the plugin rejected this component state (it is probably from another plugin)');
  assert.ok(rejected(), 'Vst3Instance::setState refusal is caught');

  // vst3_state_container.cpp readStateContainer() -- a malformed or foreign blob.
  reset();
  client2.opts.handlers.onWarning!('state blob is not a plugin state container (bad magic)');
  assert.ok(rejected(), 'bad-magic container error is caught');

  reset();
  client2.opts.handlers.onWarning!('state blob is not a VST3PluginState document');
  assert.ok(rejected(), 'wrong-document container error is caught');

  reset();
  client2.opts.handlers.onWarning!('state blob has no IComponent element');
  assert.ok(rejected(), 'missing-IComponent container error is caught');

  // vst3_state_container.cpp:175/184/200 -- the too-small/declared-length/
  // unterminated-element family the eighth audit found missing from the
  // phrase list (T18 eighth audit, MAJOR 2).
  reset();
  client2.opts.handlers.onWarning!('state blob is too small to be a plugin state container');
  assert.ok(rejected(), 'too-small container error is caught');

  reset();
  client2.opts.handlers.onWarning!('state blob declares 900 bytes of XML but holds 120');
  assert.ok(rejected(), 'declared-length container error is caught');

  reset();
  client2.opts.handlers.onWarning!('state blob has an unterminated element');
  assert.ok(rejected(), 'unterminated-element container error is caught');

  // vst3_state_container.cpp:105/126/136 (wrapped by :208/:213) -- the
  // "state text " decode-refusal family (T18 eighth audit, MAJOR 2).
  reset();
  client2.opts.handlers.onWarning!("IComponent: state text has no '<length>.' prefix");
  assert.ok(rejected(), 'missing length-prefix text error is caught');

  reset();
  client2.opts.handlers.onWarning!('IComponent: state text is truncated (5 characters, expected 20)');
  assert.ok(rejected(), 'truncated text error is caught');

  reset();
  client2.opts.handlers.onWarning!('IEditController: state text contains a character outside the encoding alphabet');
  assert.ok(rejected(), 'out-of-alphabet text error is caught');

  // vst3_instance.cpp:902 -- Vst3Instance::setState with no plugin loaded
  // (T18 eighth audit, MAJOR 2).
  reset();
  client2.opts.handlers.onWarning!('no plugin is loaded');
  assert.ok(rejected(), '"no plugin is loaded" is caught');

  // Session.cpp:528 -- the missing-"state_b64" refusal, which has no colon
  // after `set_state` so the existing `set_state:` prefix missed it (T18
  // eighth audit, MAJOR 2).
  reset();
  client2.opts.handlers.onError!('set_state needs "state_b64"', false);
  assert.ok(rejected(), '"set_state needs" is caught');

  // Session.cpp:546 -- the audio-park-timeout busy refusal, via the generic `set_state:` prefix.
  reset();
  client2.opts.handlers.onError!('set_state: the plugin is busy (audio did not pause in time); try again', false);
  assert.ok(rejected(), 'the busy/park-timeout refusal is caught');

  // vst3_instance.cpp:852 (fault text from vst3_guard.cpp:23) -- a crash inside IComponent::setState.
  reset();
  client2.opts.handlers.onWarning!(
    'the plugin crashed (access violation) inside IComponent::setState; this state blob does not belong to it',
  );
  assert.ok(rejected(), 'the crash-inside-setState warning is caught');

  // vst3_instance.cpp:866/907 -- a plugin already faulted by an earlier state call.
  reset();
  client2.opts.handlers.onWarning!('this plugin faulted on an earlier state call and cannot be trusted with another');
  assert.ok(rejected(), 'the faulted-instance guard is caught');
}

console.log('vstEditorStore.lateRestoreRejection: ok');
