/**
 * vstLive/sessionRegistry -- `mentionsState` exhaustiveness (T18 ninth audit,
 * CRITICAL 1).
 *
 * The `armStatePending()` window this file used to cover is GONE. The ninth
 * audit proved it added zero coverage over `mentionsState` -- every refusal
 * `set_state` and `restoreStateFile` can produce already matches the regex --
 * while actively causing false rejections: a SUCCESSFUL restore that then
 * triggers `restartComponent(kIoChanged|kReloadComponent)` (a plugin
 * reconfiguring on load) fires `onRestartRequired()`, which re-sends every
 * `prepare()` warning through `onWarning`. None of those warnings are about
 * state, but the window treated the first one it saw after `restored()` as
 * this delivery's answer regardless, and refused a plugin that had just
 * correctly restored.
 *
 * `mentionsState` is now the SOLE path, evaluated in `onReady`, `onWarning`
 * and `onError` alike. This file covers what now matters:
 *   1. Every `onRestartRequired`-replayed `prepare()` warning must leave a
 *      row that just restored successfully as `live`, not `state-rejected`.
 *   2. Every `vst3_editor.cpp` `editorError` must leave the row `live`.
 *   3. Every one of the nine `drainAudioNotices()` texts must leave the row
 *      `live`.
 *   4. Every one of the ~23 real host refusal strings must still be recorded
 *      as a rejection, read verbatim from the source.
 *
 * All host wording below is read verbatim from `native/vst-host/src`.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.stateWindow.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry } from './sessionRegistry.ts';
import type { VstBridgeClientOptions } from './bridgeClient.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import type { StoredVstState } from '../vstStateStorage.ts';

/* ── fakes (same shape as sessionRegistry.test.ts) ──────────────────────────── */

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
      return json({ session_id: `sess-${req.chain_entry_id}`, ws_url: `ws://127.0.0.1:${port}`, pid: 4242, protocol: 1 });
    }
    if (method === 'DELETE') return json({ raw_state: 'ZmluYWw=' });
    return json({ detail: `unexpected ${method} ${input}` }, 404);
  };
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakeClock {
  private t = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  schedule = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  cancel = (id: number): void => {
    this.timers.delete(id);
  };
  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= until && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = until;
  }
}

class FakeClient {
  static made: FakeClient[] = [];
  constructor(readonly opts: VstBridgeClientOptions) {
    FakeClient.made.push(this);
  }
  connect(): void {}
  close(): void {}
  setState(): void {}
  getState(): void {}
  openEditor(): void {}
  closeEditor(): void {}
  editorRect(): void {}
  setParams(): void {}
}

const entry = (id: string, raw = 'c2F2ZWQ='): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: raw },
});

function setup() {
  FakeClient.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const backend = new FakeBackend();
  const clock = new FakeClock();
  (globalThis as { fetch: unknown }).fetch = backend.fetch;
  const registry = createVstSessionRegistry({
    schedule: clock.schedule,
    cancel: clock.cancel,
    makeClient: (opts) => new FakeClient(opts) as never,
  });
  return { registry, clock };
}

const liveEntries = () => useVstLiveStore.getState().entries;

const readyMsg = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  plugin: { name: 'p', vendor: 'v', version: '1', category: 'Fx', identifier: 'id', format: 'VST3' },
  latency_samples: 0,
  tail_seconds: 0,
  sample_rate: 48000,
  block_size: 512,
  channels_in: 2,
  channels_out: 2,
  has_editor: false,
  state_compat: true,
  warnings: [] as string[],
  ...over,
});

/* ── item 1: a SUCCESSFUL restore followed by each `onRestartRequired`-
   replayed `prepare()` warning must leave the row `live` -- these are
   `Session.cpp:1013`'s replay of `result.warnings` after a plugin-triggered
   restart, read verbatim from `vst3_instance.cpp` -- and must NOT refuse the
   capture (i.e. must not clear the way for `sinkLiveRawState`'s rejection
   guard the way a false `state-rejected` would) ─────────────────────────── */
const restartWarnings: Array<{ line: string; text: string }> = [
  {
    line: 'vst3_instance.cpp:146',
    text: "the plugin's edit controller failed to initialise; parameters and the editor are unavailable",
  },
  {
    line: 'vst3_instance.cpp:153',
    text: 'this plugin exposes no edit controller: no parameters, no editor',
  },
  {
    line: 'vst3_instance.cpp:286',
    text: 'this plugin would not take a 2-channel layout; using its own preferred bus layout instead',
  },
  {
    line: 'vst3_instance.cpp:341',
    text: 'bus layout settled at 2 in / 2 out (asked for 2)',
  },
  {
    line: 'vst3_instance.cpp:493',
    text:
      'this plugin does not reliably round-trip its own state, so its live state is kept separately from the one the offline renderer uses',
  },
];

let restartIdx = 0;
for (const warning of restartWarnings) {
  const id = `restart-${restartIdx++}`;
  const { registry } = setup();
  const session = await registry.acquire(entry(id), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];

  // A successful restore: the delivery is sent, and the host answers `ready`
  // with no state warning at all (there is no ack for a plugin that took it).
  session.stateSent = true;

  // The plugin now reconfigures and restarts, and the host replays this
  // ONE `prepare()` warning over the same connection.
  client.opts.handlers.onWarning!(warning.text);

  assert.equal(
    liveEntries()[id]?.stateOrigin ?? 'live',
    'live',
    `${warning.line} must not be read as a state rejection`,
  );
}

/* ── item 2: every `vst3_editor.cpp` `editorError` must leave the row `live` ── */
const editorErrors: Array<{ line: string; text: string }> = [
  { line: 'vst3_editor.cpp:63', text: 'the editor window class could not be registered' },
  { line: 'vst3_editor.cpp:80', text: 'RegisterClassEx failed for the editor window' },
  { line: 'vst3_editor.cpp:156', text: 'this plugin has no edit controller, so it has no editor' },
  { line: 'vst3_editor.cpp:164', text: 'the plugin did not supply an editor view' },
  { line: 'vst3_editor.cpp:169', text: "the plugin's editor does not support being hosted in an HWND" },
  { line: 'vst3_editor.cpp:224', text: 'CreateWindowEx failed for the editor window' },
  { line: 'vst3_editor.cpp:237', text: 'the plugin refused to attach its editor to our window' },
  { line: 'Session.cpp:574', text: 'this plugin has no editor' },
  { line: 'Session.cpp:602', text: 'the editor could not be opened' },
  { line: 'vst3_instance.cpp:978', text: 'this plugin has no edit controller, so there is no editor to open' },
];

let editorErrIdx = 0;
for (const editorError of editorErrors) {
  const id = `editor-${editorErrIdx++}`;
  const { registry } = setup();
  const session = await registry.acquire(entry(id), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];
  session.stateSent = true;
  client.opts.handlers.onError!(editorError.text, false);
  assert.equal(liveEntries()[id]?.stateOrigin ?? 'live', 'live', `${editorError.line} must not be read as a state rejection`);
}

/* ── item 3: each of the nine `drainAudioNotices()` texts (`Session.cpp:33-
   54`) must leave the row `live` -- includes the `NotReady` text reachable
   exactly when a late `restored()` window is open after a `recreate()`
   respawn ─────────────────────────────────────────────────────────────────── */
const audioNotices = [
  'audio block received before hello/ready',
  'audio message is shorter than its header says',
  'audio message has the wrong magic',
  'audio message is not an audio_in frame',
  'audio message channel count is out of range (1..8)',
  'audio message frame count exceeds --block-size',
  'audio message is larger than the negotiated block',
  'websocket protocol violation',
  'audio thread notice',
];

let noticeIdx = 0;
for (const notice of audioNotices) {
  const id = `notice-${noticeIdx++}`;
  const { registry } = setup();
  const session = await registry.acquire(entry(id), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];
  session.stateSent = true;
  client.opts.handlers.onError!(notice, false);
  assert.equal(liveEntries()[id]?.stateOrigin ?? 'live', 'live', `drainAudioNotices text must not be read as a state rejection: ${notice}`);
}

/* ── item 4a: `restoreStateFile()`'s three startup-warning refusals arrive
   through `ready.warnings`, not `onWarning`/`onError` -- they must still be
   caught by the same `mentionsState` check `onReady` runs ────────────────── */
const startupRefusals: Array<{ line: string; text: string }> = [
  { line: 'Session.cpp:872', text: 'could not read the state file: disk error' },
  { line: 'Session.cpp:882', text: 'the plugin faulted while restoring the state file' },
  { line: 'Session.cpp:886', text: 'the state file was not restored: the plugin rejected it' },
];

let startupRefusalIdx = 0;
for (const refusal of startupRefusals) {
  const id = `startup-refusal-${startupRefusalIdx++}`;
  const { registry } = setup();
  const session = await registry.acquire(entry(id), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];
  session.stateSent = true;
  client.opts.handlers.onReady!(readyMsg({ warnings: [refusal.text] }));
  const row = liveEntries()[id];
  assert.equal(row?.stateOrigin, 'state-rejected', `mentionsState must catch ${refusal.line} via ready.warnings: ${refusal.text}`);
  assert.equal(row?.stateReason, refusal.text);
}

/* ── item 4b: every remaining real host refusal string, delivered via
   `onWarning`/`onError` -- `mentionsState` is the SOLE path now, so this is
   the entire safety net ───────────────────────────────────────────────────── */
const refusals: Array<{ line: string; text: string }> = [
  { line: 'Session.cpp:528', text: 'set_state needs "state_b64"' },
  { line: 'Session.cpp:533', text: 'set_state: "state_b64" is not valid base64' },
  { line: 'Session.cpp:537', text: 'set_state: decoded state is empty' },
  { line: 'Session.cpp:546', text: 'set_state: the plugin is busy (audio did not pause in time); try again' },
  { line: 'Session.cpp:558', text: 'the plugin rejected the state blob' },
  {
    line: 'vst3_instance.cpp:853',
    text: 'the plugin crashed (access violation) inside IComponent::setState; this state blob does not belong to it',
  },
  { line: 'vst3_instance.cpp:862', text: 'no plugin is loaded' },
  {
    line: 'vst3_instance.cpp:866',
    text: 'this plugin faulted on an earlier state call and cannot be trusted with another',
  },
  { line: 'vst3_instance.cpp:903', text: 'no plugin is loaded' },
  {
    line: 'vst3_instance.cpp:907',
    text: 'this plugin faulted on an earlier state call and cannot be trusted with another',
  },
  {
    line: 'vst3_instance.cpp:939',
    text: 'the plugin rejected this component state (it is probably from another plugin)',
  },
  { line: 'vst3_state_container.cpp:105', text: "state text has no '<length>.' prefix" },
  { line: 'vst3_state_container.cpp:112', text: 'state text length prefix is not a number' },
  { line: 'vst3_state_container.cpp:117', text: 'state text declares an implausible length' },
  { line: 'vst3_state_container.cpp:126', text: 'state text is truncated (5 characters, expected 20)' },
  { line: 'vst3_state_container.cpp:136', text: 'state text contains a character outside the encoding alphabet' },
  { line: 'vst3_state_container.cpp:175', text: 'state blob is too small to be a plugin state container' },
  { line: 'vst3_state_container.cpp:179', text: 'state blob is not a plugin state container (bad magic)' },
  { line: 'vst3_state_container.cpp:184', text: 'state blob declares 900 bytes of XML but holds 120 bytes in total' },
  { line: 'vst3_state_container.cpp:190', text: 'state blob is not a VST3PluginState document' },
  { line: 'vst3_state_container.cpp:200', text: 'state blob has an unterminated element' },
  { line: 'vst3_state_container.cpp:204', text: 'state blob has no IComponent element' },
  { line: 'vst3_state_container.cpp:208', text: "IComponent: state text has no '<length>.' prefix" },
  { line: 'vst3_state_container.cpp:213', text: 'IEditController: state text is truncated (5 characters, expected 20)' },
];

let refusalIdx = 0;
for (const refusal of refusals) {
  const id = `refusal-${refusalIdx++}`;
  const { registry } = setup();
  const session = await registry.acquire(entry(id), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];
  session.stateSent = true;
  client.opts.handlers.onWarning!(refusal.text);
  const row = liveEntries()[id];
  assert.equal(row?.stateOrigin, 'state-rejected', `mentionsState must catch ${refusal.line}: ${refusal.text}`);
  assert.equal(row?.stateReason, refusal.text);
}

/* ── item 4 (cont'd): the same refusal set, delivered via `onError` instead
   of `onWarning` -- `Session.cpp`'s `set_state` refusals and
   `restoreStateFile()`'s startup-warning path both reach the client through
   `sendError`, so both handlers must apply `mentionsState` identically ───── */
{
  const { registry } = setup();
  const session = await registry.acquire(entry('refusal-via-error'), 48000);
  assert.ok(session);
  const client = FakeClient.made[0];
  session.stateSent = true;
  client.opts.handlers.onError!('set_state needs "state_b64"', false);
  const row = liveEntries()['refusal-via-error'];
  assert.equal(row?.stateOrigin, 'state-rejected', 'onError applies mentionsState the same as onWarning');
}

/* ── item 2 (T18 batch-12 note 2): an `unreadable` entry whose retry ALSO
   fails, opened through the offline sidecar with no live host available,
   must NOT let the sidecar's factory-defaults capture overwrite the stored
   blob. `vstEditorStore.ts`'s `drainSession` and its editor-result `poll`
   both write through the CALLER's sink (`WaveformEditor.tsx` /
   `MixView.tsx` -> `setTrackVstRawState` / `setMasterVstRawState` /
   `setVstRawState`), which bypassed `sinkLiveRawState`'s `state-rejected`
   check entirely; both sites now carry the same check inline.
   `vstEditorStore.ts` pulls in `effectChainStore.ts` (a `persist`-wrapped
   store) at RUNTIME -- unlike `sessionRegistry.ts`'s type-only `ChainEntry`
   import above -- so this block sets up the window/localStorage/fetch shim
   the dynamic imports below need, scoped to not affect anything above. ── */
{
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
    // Real timers, but the poll loop's 1.5 s interval is collapsed to 0 so
    // this test does not actually wait 1.5 s per poll -- `tick()` below
    // still has to pump the event loop for it to fire.
    setTimeout: (fn: (...args: unknown[]) => void) => setTimeout(fn, 0) as unknown as number,
    clearTimeout,
  };
  const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
  g.localStorage = storage;
  g.window = new Proxy(windowCore, {
    get: (target, prop, receiver) =>
      Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
  });

  const PLUGIN_DEFAULTS = 'STATE-OF-A-PLUGIN-AT-ITS-DEFAULTS';
  let openEditorCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/vst/open-editor')) {
      openEditorCalls += 1;
      return new Response(JSON.stringify({ status: 'launching', preset_path: '' }), { status: 200 });
    }
    if (u.includes('/api/vst/editor-result')) {
      return new Response(JSON.stringify({ status: 'ok', raw_state: PLUGIN_DEFAULTS }), { status: 200 });
    }
    if (u.includes('/api/vst/editor-rect')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in item-2 test: ${u}`);
  }) as typeof fetch;

  const { FakeIdb, STORE_KEY, tick } = await import('../../state/effectChainStore.fakeIdb.ts');
  const idb = new FakeIdb([['e-item2', { rawState: 'SAVED-GOOD-STATE', stateHost: 'thedaw' }]]);
  idb.install();
  // Left set (never deleted): BOTH the startup read and open()'s one retry
  // fail -- the `unreadable` flavour item 2 is about, not `state-rejected`
  // via a host refusal (which cannot reach the offline path at all).
  idb.failGetKeys.set('e-item2', new Error('read failed'));

  mem.set(
    STORE_KEY,
    JSON.stringify({
      state: {
        chain: [
          {
            id: 'e-item2',
            effect: 'vst3',
            params: {},
            enabled: true,
            vst: { plugin_path: 'C:/VST3/Item2.vst3', plugin_name: 'Item2' },
          },
        ],
      },
      version: 1,
    }),
  );

  const { useEffectChainStore, vstStatesLoaded } = await import('../../state/effectChainStore.ts');
  const { useVstEditorStore, __setLiveHolderForTest, __setLiveWaitClockForTest } = await import(
    '../../state/vstEditorStore.ts'
  );
  const { useVstLiveStore: useVstLiveStoreForItem2 } = await import('../../state/vstLiveStore.ts');
  const { useVstEditorPrefs } = await import('../../state/vstEditorPrefsStore.ts');

  // No live host here at all -- open() must take the offline sidecar branch
  // directly, the scenario item 2 describes.
  __setLiveHolderForTest({ hostAvailable: () => false, hold: () => Promise.resolve(null), unhold: () => {} });
  __setLiveWaitClockForTest({ schedule: () => 1, cancel: () => {} });
  useVstEditorPrefs.getState().setModeForPlugin('C:/VST3/Item2.vst3', 'floating');

  await vstStatesLoaded;
  await tick(5);

  const rowBefore = useVstLiveStoreForItem2.getState().entries['e-item2'];
  assert.equal(rowBefore?.stateOrigin, 'state-rejected', 'setup: the failed startup read marks the row rejected');

  const entry = useEffectChainStore.getState().chain[0];
  useVstEditorStore.getState().open(entry, useEffectChainStore.getState().setVstRawState);
  // open()'s load gate retries the read (also failing), re-enters with
  // stateReady: true, opens the sidecar, and its poll captures the plugin's
  // factory defaults -- give all of that real microtask/timer turns to run.
  await tick(40);

  assert.ok(openEditorCalls > 0, 'setup: the offline sidecar editor was actually opened for this scenario');
  const stored = idb.data.get('e-item2') as StoredVstState | undefined;
  assert.equal(
    stored?.rawState,
    'SAVED-GOOD-STATE',
    'the sidecar capture at factory defaults must not overwrite the stored blob',
  );
  assert.notEqual(stored?.rawState, PLUGIN_DEFAULTS);

  useVstEditorStore.getState().close();
}

console.log('sessionRegistry.stateWindow: ok');
