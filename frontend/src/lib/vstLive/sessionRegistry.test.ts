/**
 * vstLive/sessionRegistry — one host process per chain entry, outliving chain
 * rebuilds.
 *
 * play / stop / seek each rebuild EVERY chain in the mixer, which disposes and
 * re-makes every instance. If `dispose()` closed the plugin, pressing stop
 * would kill and respawn a 1.7 GB mastering suite. So disposal starts a 10 s
 * GRACE timer instead, and the rebuild that follows milliseconds later finds
 * the session still running and cancels it. Removing the entry, or closing the
 * project, closes for real.
 *
 * The backend is faked at the `fetch` boundary (the registry uses the real
 * `vstLiveApi`), so the URLs, methods and bodies on the wire are asserted here
 * too — they are half of the T41 contract.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry } from './sessionRegistry.ts';
import type { VstBridgeClientOptions } from './bridgeClient.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';
import { setLoadedVstEntryLookup } from '../vstStateStorage.ts';

/* ── fakes ─────────────────────────────────────────────────────────────────── */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

class FakeBackend {
  calls: Call[] = [];
  hostInfo: unknown = { available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' };
  /** Fail the next N session POSTs with this message. */
  failCreate: string | null = null;
  nextPort = 60001;
  sessions = new Map<string, { port: number }>();
  deleted: string[] = [];

  fetch = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ url: input, method, body });

    if (input === '/api/vst/live/host') return json(this.hostInfo);
    if (input === '/api/vst/live/session' && method === 'POST') {
      if (this.failCreate) return json({ detail: this.failCreate }, 500);
      const req = body as { chain_entry_id: string };
      const existing = this.sessions.get(req.chain_entry_id);
      const port = existing?.port ?? this.nextPort++;
      this.sessions.set(req.chain_entry_id, { port });
      return json({
        session_id: `sess-${req.chain_entry_id}`,
        ws_url: `ws://127.0.0.1:${port}`,
        pid: 4242,
        protocol: 1,
      });
    }
    if (method === 'DELETE') {
      this.deleted.push(input);
      return json({ raw_state: 'ZmluYWw=' });
    }
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
  get pending(): number {
    return this.timers.size;
  }
}

/** A stand-in for VstBridgeClient: records what the registry did to it. */
class FakeClient {
  static made: FakeClient[] = [];
  connected = 0;
  closed = 0;
  ready = false;
  constructor(readonly opts: VstBridgeClientOptions) {
    FakeClient.made.push(this);
  }
  connect(): void {
    this.connected += 1;
  }
  close(): void {
    this.closed += 1;
  }
}

const entry = (id: string, over: Partial<ChainEntry> = {}): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'c2F2ZWQ=' },
  ...over,
});

function setup(graceMs = 10000) {
  FakeClient.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const backend = new FakeBackend();
  const clock = new FakeClock();
  (globalThis as { fetch: unknown }).fetch = backend.fetch;
  const registry = createVstSessionRegistry({
    schedule: clock.schedule,
    cancel: clock.cancel,
    graceMs,
    makeClient: (opts) => new FakeClient(opts) as never,
  });
  return { backend, clock, registry };
}

const liveEntries = () => useVstLiveStore.getState().entries;

/* ── acquire: probes the host, spawns, and wires a client to the ws url ────── */
{
  const { backend, registry } = setup();
  const session = await registry.acquire(entry('e1'), 48000);
  assert.ok(session, 'a healthy host yields a session');
  assert.equal(session.sessionId, 'sess-e1');
  assert.equal(session.wsUrl, 'ws://127.0.0.1:60001');
  assert.equal(session.pid, 4242);

  assert.deepEqual(backend.calls[0], { url: '/api/vst/live/host', method: 'GET', body: undefined });
  assert.deepEqual(backend.calls[1], {
    url: '/api/vst/live/session',
    method: 'POST',
    body: {
      chain_entry_id: 'e1',
      plugin_path: 'C:/VST3/Ozone 11.vst3',
      plugin_name: 'Ozone 11',
      sample_rate: 48000,
      block_size: 512,
      channels: 2,
      // The entry's saved blob, whichever editor wrote it. See the state-origin
      // block below.
      raw_state: 'c2F2ZWQ=',
    },
  });

  assert.equal(FakeClient.made.length, 1);
  assert.equal(FakeClient.made[0].opts.url, 'ws://127.0.0.1:60001');
  assert.equal(FakeClient.made[0].connected, 1, 'the registry connects it');
  assert.equal(liveEntries().e1.status, 'starting', 'the row says so while the handshake runs');
  assert.equal(useVstLiveStore.getState().host.available, true);
}

/* ── idempotent: a second acquire reuses the running process ───────────────── */
{
  const { backend, registry } = setup();
  const a = await registry.acquire(entry('e1'), 48000);
  const b = await registry.acquire(entry('e1'), 48000);
  assert.equal(a, b, 'the same session object, not a second process');
  assert.equal(FakeClient.made.length, 1, 'and the same client');
  assert.equal(backend.calls.filter((c) => c.url === '/api/vst/live/session').length, 1);

  // Two acquires racing (a rebuild landing while the first is still in flight)
  // must also collapse to one spawn.
  const { backend: b2, registry: r2 } = setup();
  const [x, y] = await Promise.all([r2.acquire(entry('e2'), 48000), r2.acquire(entry('e2'), 48000)]);
  assert.equal(x, y);
  assert.equal(b2.calls.filter((c) => c.url === '/api/vst/live/session').length, 1, 'one spawn, not two');
}

/* ── release: the 10 s grace, and the rebuild that cancels it ──────────────── */
{
  const { backend, clock, registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s);

  registry.release('e1');
  assert.equal(FakeClient.made[0].closed, 0, 'dispose does NOT kill the plugin');
  assert.equal(backend.deleted.length, 0);

  clock.advance(9999);
  assert.equal(backend.deleted.length, 0, 'still inside the grace window');

  // This is what play/stop/seek look like: dispose, then rebuild immediately.
  const again = await registry.acquire(entry('e1'), 48000);
  assert.equal(again, s, 'the rebuild finds the same session');
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 're-acquiring cancelled the grace timer');
  assert.equal(FakeClient.made.length, 1, 'no respawn, so no click and no reload');

  registry.release('e1');
  clock.advance(10000);
  assert.deepEqual(backend.deleted, ['/api/vst/live/session/sess-e1'], 'an abandoned session closes on time');
  assert.equal(FakeClient.made[0].closed, 1, 'and its socket with it');
  assert.equal(liveEntries().e1, undefined, 'the row goes back to nothing');
  assert.equal(registry.get('e1'), undefined);
}

/* ── close: entry removed — immediate, no grace ────────────────────────────── */
{
  const { backend, clock, registry } = setup();
  await registry.acquire(entry('e1'), 48000);
  registry.close('e1');
  assert.deepEqual(backend.deleted, ['/api/vst/live/session/sess-e1']);
  assert.equal(FakeClient.made[0].closed, 1);
  assert.equal(clock.pending, 0, 'and leaves no timer behind');
  registry.close('e1'); // idempotent
  assert.equal(backend.deleted.length, 1);
}

/* ── closeAll: project close / page unload ─────────────────────────────────── */
{
  const { backend, clock, registry } = setup();
  await registry.acquire(entry('a'), 48000);
  await registry.acquire(entry('b'), 48000);
  registry.release('a'); // even one inside its grace window
  registry.closeAll();
  assert.deepEqual(backend.deleted.sort(), [
    '/api/vst/live/session/sess-a',
    '/api/vst/live/session/sess-b',
  ]);
  assert.equal(clock.pending, 0, 'every pending grace timer is cancelled');
  assert.deepEqual(liveEntries(), {});
  assert.equal(registry.get('a'), undefined);
}

/* ── an entry with nothing to host never reaches the backend ───────────────── */
{
  const { backend, registry } = setup();
  assert.equal(await registry.acquire(entry('x', { vst: undefined }), 48000), null);
  assert.equal(await registry.acquire(entry('y', { vst: { plugin_path: '', plugin_name: '' } }), 48000), null);
  assert.deepEqual(backend.calls, [], 'no host probe, no spawn');
  assert.deepEqual(liveEntries(), {}, 'and nothing to report on the row');
}

/* ── no host binary: render-only, with the reason the backend gave ─────────── */
{
  const { backend, registry } = setup();
  backend.hostInfo = { available: false, reason: 'thedaw-vst-host.exe not built — see docs/windows' };
  assert.equal(await registry.acquire(entry('e1'), 48000), null);
  assert.equal(liveEntries().e1.status, 'unavailable');
  assert.equal(liveEntries().e1.reason, 'thedaw-vst-host.exe not built — see docs/windows');
  assert.equal(backend.calls.length, 1, 'it does not try to spawn what does not exist');
  assert.equal(useVstLiveStore.getState().host.available, false);

  // The probe result is cached: a chain rebuild must not re-probe per entry.
  assert.equal(await registry.acquire(entry('e2'), 48000), null);
  assert.equal(backend.calls.length, 1, 'the host probe is asked once, not per entry');
  assert.equal(liveEntries().e2.status, 'unavailable');
}

/* ── a spawn that fails says why, and stays retryable ──────────────────────── */
{
  const { backend, registry } = setup();
  backend.failCreate = 'session cap reached (24)';
  assert.equal(await registry.acquire(entry('e1'), 48000), null);
  assert.equal(liveEntries().e1.status, 'error');
  assert.match(liveEntries().e1.reason ?? '', /session cap reached/);

  backend.failCreate = null;
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s, 'the failure is not sticky — a retry can succeed');
  assert.equal(liveEntries().e1.status, 'starting');
}

/* ── an unreachable backend is an error, not a crash ───────────────────────── */
{
  const { registry } = setup();
  (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('Failed to fetch'));
  assert.equal(await registry.acquire(entry('e1'), 48000), null);
  assert.equal(liveEntries().e1.status, 'error');
  assert.match(liveEntries().e1.reason ?? '', /fetch/i);
}

/* ── the client gets a resolveUrl that re-creates a dead host process ──────── */
{
  const { backend, registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s);
  const resolve = FakeClient.made[0].opts.resolveUrl;
  assert.equal(typeof resolve, 'function', 'the client can ask for a fresh url');
  assert.equal(resolve?.(), 'ws://127.0.0.1:60001', 'while the session is alive it reuses it');

  // The socket died. The registry re-POSTs in the background (the POST is
  // idempotent per entry id, so a live process answers with its own url and a
  // dead one is respawned); until that lands, the client is told to wait.
  backend.sessions.delete('e1');
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;
  onStatus('error', 'socket closed (1006)');
  assert.equal(liveEntries().e1.status, 'error');
  assert.equal(liveEntries().e1.reason, 'socket closed (1006)');
  assert.equal(resolve?.(), null, 'no url is offered while the re-create is in flight');

  // Let the background re-create settle (a real macrotask, so every pending
  // microtask in the fetch chain drains — the registry's grace timers are on
  // the fake clock and are untouched by this).
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(resolve?.(), 'ws://127.0.0.1:60002', 'and the respawned process is handed over');
  assert.equal(registry.get('e1')?.wsUrl, 'ws://127.0.0.1:60002');
  assert.equal(registry.get('e1')?.sessionId, 'sess-e1', 'the session id is re-read too');
}

/* ── a session released after the host died still gets DELETEd ─────────────── */
{
  const { backend, clock, registry } = setup(1000);
  await registry.acquire(entry('e1'), 48000);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;
  onStatus('error', 'gone');
  registry.release('e1');
  clock.advance(1000);
  assert.deepEqual(backend.deleted, ['/api/vst/live/session/sess-e1'], 'the process is reaped either way');
}

/* ── state origin: EVERY saved state is handed back to the host ────────────── */
{
  // A blob the old pedalboard editor wrote loads in our host: the encodings are
  // the same container and the bit-order bug that made them look incompatible
  // is fixed and verified. So `state_host` no longer gates the restore — it
  // only picks the renderer — and the plugin comes up holding what the entry
  // says it holds.
  const { backend, registry } = setup();
  await registry.acquire(entry('legacy'), 48000);
  const post = backend.calls.find((c) => c.url === '/api/vst/live/session');
  assert.ok(post);
  assert.equal(
    (post.body as { raw_state?: string }).raw_state,
    'c2F2ZWQ=',
    'a pedalboard-origin state is restored at spawn like any other',
  );
  assert.equal(liveEntries().legacy.stateOrigin, 'live', 'and the row says nothing is missing');
}
{
  // The ONLY thing that puts a plugin at defaults now is the host reporting
  // that it could not restore the state — and then the row carries the reason
  // the host gave, not a guess.
  const { registry } = setup();
  await registry.acquire(entry('broken'), 48000);
  FakeClient.made[0].opts.handlers.onReady!({
    protocol: 1,
    plugin: { name: 'p', vendor: 'v', version: '1', category: 'Fx', identifier: 'id', format: 'VST3' },
    latency_samples: 0,
    tail_seconds: 0,
    sample_rate: 48000,
    block_size: 512,
    channels_in: 2,
    channels_out: 2,
    has_editor: false,
    state_compat: false,
    warnings: ['the state file was not restored: the plugin rejected it'],
  });
  assert.equal(liveEntries().broken.stateOrigin, 'state-rejected');
  assert.equal(
    liveEntries().broken.stateReason,
    'the state file was not restored: the plugin rejected it',
    "the host's own words reach the row",
  );
}
{
  // A ready with warnings that say nothing about the state is not a rejection.
  const { registry } = setup();
  await registry.acquire(entry('noisy'), 48000);
  FakeClient.made[0].opts.handlers.onReady!({
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
    warnings: ['plugin reports 4 outputs, only 2 are used'],
  });
  assert.equal(liveEntries().noisy.stateOrigin, 'live', 'an unrelated warning does not accuse the state');
}
{
  // A state failure that only shows up after `set_state` arrives as a
  // non-fatal `error`/`warning` on the socket.
  const { registry } = setup();
  await registry.acquire(entry('late'), 48000);
  FakeClient.made[0].opts.handlers.onWarning!('the plugin rejected the state blob');
  assert.equal(liveEntries().late.stateOrigin, 'state-rejected');
  assert.equal(liveEntries().late.stateReason, 'the plugin rejected the state blob');
}
{
  const { registry } = setup();
  await registry.acquire(entry('fine'), 48000);
  FakeClient.made[0].opts.handlers.onWarning!('editor view could not be created');
  assert.equal(liveEntries().fine.stateOrigin, 'live', 'an unrelated warning is not a state failure');
}
{
  const { backend, registry } = setup();
  await registry.acquire(
    entry('mine', { vst: { plugin_path: 'p.vst3', plugin_name: 'p', raw_state: 'TUlORQ==', state_host: 'thedaw' } }),
    48000,
  );
  const post = backend.calls.find((c) => c.url === '/api/vst/live/session');
  assert.equal(
    (post?.body as { raw_state?: string }).raw_state,
    'TUlORQ==',
    'a state OUR host wrote is restored at spawn',
  );
  assert.equal(liveEntries().mine.stateOrigin, 'live', 'so the plugin really is where the entry says');
}
{
  const { backend, registry } = setup();
  await registry.acquire(entry('blank', { vst: { plugin_path: 'p.vst3', plugin_name: 'p' } }), 48000);
  const post = backend.calls.find((c) => c.url === '/api/vst/live/session');
  assert.equal((post?.body as { raw_state?: string }).raw_state, undefined);
  assert.equal(liveEntries().blank.stateOrigin, 'live', 'nothing saved means nothing is missing');
}

/* ── a session remembers that its parameters moved since the last capture ──── */
{
  const { registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s);
  assert.equal(s.stateDirty, false, 'a fresh session has nothing uncaptured');
  assert.equal(s.userMovedOnRejectedState, false, 'and nothing the user touched yet either');
  registry.markParamsChanged('e1');
  assert.equal(registry.get('e1')?.stateDirty, true, 'a parameter push marks it for the next capture');
  assert.equal(
    registry.get('e1')?.userMovedOnRejectedState,
    false,
    'a plain rebuild-shaped push (markParamsChanged) must NOT look like a user gesture (T18 fifth audit, CRITICAL 1)',
  );
  registry.markParamsChanged('nobody'); // an entry with no session is a no-op
  assert.deepEqual(
    registry.sessions().map((x) => x.entryId),
    ['e1'],
    'the capture pass can enumerate what is running',
  );
}

/* ── markUserParamsChanged is what a GENUINE user gesture calls (a
   liveParamSink push, or a knob moved in the plugin's own editor window) —
   it marks both flags, unlike markParamsChanged above ─────────────────────── */
{
  const { registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s);
  registry.markUserParamsChanged('e1');
  assert.equal(registry.get('e1')?.stateDirty, true, 'still marks the session stale for the next capture');
  assert.equal(registry.get('e1')?.userMovedOnRejectedState, true, 'AND records that it was the user');
  registry.markUserParamsChanged('nobody'); // an entry with no session is a no-op
}

/* ── closing a session keeps the state the host wrote on its way out ───────── */
{
  const captured: { entryId: string; rawState: string }[] = [];
  FakeClient.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const backend = new FakeBackend();
  const clock = new FakeClock();
  (globalThis as { fetch: unknown }).fetch = backend.fetch;
  const registry = createVstSessionRegistry({
    schedule: clock.schedule,
    cancel: clock.cancel,
    graceMs: 1000,
    makeClient: (opts) => new FakeClient(opts) as never,
    stateSink: (entryId, rawState) => captured.push({ entryId, rawState }),
  });

  await registry.acquire(entry('e1'), 48000);
  registry.close('e1');
  // The DELETE is what makes the host write its state file, and its response
  // carries the blob back. Without this the last thing the user dialed in
  // before removing the entry — or closing the project — was simply lost.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(captured, [{ entryId: 'e1', rawState: 'ZmluYWw=' }], 'the shutdown state reaches the entry');
}

/** Build a registry wired the same way as the block above, but with its own
 *  `captured` sink so each rejection-guard scenario starts clean. */
function setupWithStateSink(graceMs = 1000) {
  const captured: { entryId: string; rawState: string }[] = [];
  FakeClient.made = [];
  useVstLiveStore.setState({ entries: {}, host: { available: null } });
  const backend = new FakeBackend();
  const clock = new FakeClock();
  (globalThis as { fetch: unknown }).fetch = backend.fetch;
  const registry = createVstSessionRegistry({
    schedule: clock.schedule,
    cancel: clock.cancel,
    graceMs,
    makeClient: (opts) => new FakeClient(opts) as never,
    stateSink: (entryId, rawState) => captured.push({ entryId, rawState }),
  });
  return { captured, backend, clock, registry };
}

const rejectReady = {
  protocol: 1,
  plugin: { name: 'p', vendor: 'v', version: '1', category: 'Fx', identifier: 'id', format: 'VST3' },
  latency_samples: 0,
  tail_seconds: 0,
  sample_rate: 48000,
  block_size: 512,
  channels_in: 2,
  channels_out: 2,
  has_editor: false,
  state_compat: false,
  warnings: ['the state file was not restored: the plugin rejected it'],
};

/* ── shutdown's DELETE rescue must NOT overwrite a state the host refused
   (T18 fifth audit, CRITICAL 2): `clearEntry` wipes the row BEFORE the DELETE
   resolves, so the guard has to be snapshotted before that happens, not read
   from the store afterward ─────────────────────────────────────────────────── */
{
  const { captured, registry } = setupWithStateSink();
  await registry.acquire(entry('e1'), 48000);
  FakeClient.made[0].opts.handlers.onReady!(rejectReady);
  assert.equal(liveEntries().e1.stateOrigin, 'state-rejected', 'precondition: the row already knows');

  registry.close('e1'); // shutdown()
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(captured, [], 'the DELETE state is the plugin\'s untouched defaults, and must not land');
}

/* ── ...but once the user HAS moved something on the defaulted plugin, the
   shutdown rescue keeps it, same rule `sinkLiveRawState` applies ──────────── */
{
  const { captured, registry } = setupWithStateSink();
  await registry.acquire(entry('e1'), 48000);
  FakeClient.made[0].opts.handlers.onReady!(rejectReady);
  registry.markUserParamsChanged('e1');
  assert.equal(registry.get('e1')?.userMovedOnRejectedState, true, 'precondition');

  registry.close('e1');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    captured,
    [{ entryId: 'e1', rawState: 'ZmluYWw=' }],
    "the user's own edit on the defaulted plugin is not lost",
  );
}

/* ── closeAll (project close / page unload) applies the SAME guard ─────────── */
{
  const { captured, registry } = setupWithStateSink();
  await registry.acquire(entry('e1'), 48000);
  FakeClient.made[0].opts.handlers.onReady!(rejectReady);
  registry.closeAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(captured, [], 'closeAll must not overwrite a rejected row nobody touched either');
}

/* ── T18 sixth audit, CRITICAL 1: a late `restored()` delivery marks the
   session `stateSent`, and the rejection recorders must gate on THAT, not on
   `slot.entry.vst?.raw_state` -- which stays `undefined` for a session that
   was spawned with nothing and only got a state later. `restored()` itself
   lives in vstEditorStore and is exercised there
   (vstEditorStore.unreadableRetry.test.ts); this pins the registry side of
   the contract: with `stateSent` false, a refusal is NOT recorded, and once
   something has been marked `stateSent` (as `restored()` does before it
   calls `client.setState`), the SAME refusal IS recorded. ────────────────── */
{
  const { registry } = setup();
  // Spawned with nothing: the entry never had a saved state, so this session
  // starts with stateSent === false, same as a late-`restored()` candidate
  // before its retry lands.
  const s = await registry.acquire(entry('lateArrival', { vst: { plugin_path: 'p.vst3', plugin_name: 'p' } }), 48000);
  assert.ok(s);
  assert.equal(s.stateSent, false, 'nothing has been handed to this plugin yet');

  // The host refuses on ready anyway (a stray/unrelated event) -- must not be
  // recorded, because nothing was ever sent for it to refuse.
  FakeClient.made[0].opts.handlers.onReady!({
    protocol: 1,
    plugin: { name: 'p', vendor: 'v', version: '1', category: 'Fx', identifier: 'id', format: 'VST3' },
    latency_samples: 0,
    tail_seconds: 0,
    sample_rate: 48000,
    block_size: 512,
    channels_in: 2,
    channels_out: 2,
    has_editor: false,
    state_compat: false,
    warnings: ['the state file was not restored: the plugin rejected it'],
  });
  assert.equal(
    liveEntries().lateArrival.stateOrigin,
    'live',
    'nothing was sent, so there is nothing to have been rejected',
  );

  // `restored()`'s retry marks the session BEFORE it calls setState.
  s.stateSent = true;
  FakeClient.made[0].opts.handlers.onWarning!('the plugin rejected the state blob');
  assert.equal(
    liveEntries().lateArrival.stateOrigin,
    'state-rejected',
    'the SAME session, now marked stateSent, has the refusal recorded',
  );
  assert.equal(liveEntries().lateArrival.stateReason, 'the plugin rejected the state blob');
}

/* ── T18 sixth audit, MAJOR 2: `state_compat: false` alone is a round-trip
   ADVISORY, not a restore failure, and its warning text must not be read as
   one either -- the plugin's restore actually SUCCEEDED here. ────────────── */
{
  const { registry } = setup();
  await registry.acquire(entry('roundtrip'), 48000);
  FakeClient.made[0].opts.handlers.onReady!({
    protocol: 1,
    plugin: { name: 'p', vendor: 'v', version: '1', category: 'Fx', identifier: 'id', format: 'VST3' },
    latency_samples: 0,
    tail_seconds: 0,
    sample_rate: 48000,
    block_size: 512,
    channels_in: 2,
    channels_out: 2,
    has_editor: false,
    state_compat: false,
    warnings: [
      "this plugin does not reliably round-trip its own state, so its live state is kept separately from the one the offline renderer uses",
    ],
  });
  assert.equal(
    liveEntries().roundtrip.stateOrigin,
    'live',
    'a round-trip-compatibility advisory is not a restore refusal',
  );
}

/* ── T18 sixth audit, MINOR 3: `recreate()` must re-read the entry instead of
   respawning from a stale `slot.entry`. With the transport stopped nothing
   calls `ensure()`, so `slot.entry` still carries the entry as it was at
   `acquire()` time -- a capture that landed since then updated the ENTRY
   (via `loadedVstEntry`'s backing store) but not this stale snapshot.
   `recreate()` must re-read through `loadedVstEntry` and reset both
   `stateOrigin` and the new session's `stateSent` to match what it actually
   just spawned with, not keep claiming 'live' over a process handed the OLD
   blob ─────────────────────────────────────────────────────────────────── */
{
  const { registry, backend } = setup();
  const acquired = entry('stale', { vst: { plugin_path: 'p.vst3', plugin_name: 'p', raw_state: 'T0xE' } });
  const s = await registry.acquire(acquired, 48000);
  assert.ok(s);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;

  // A capture landed since acquire(): the backing store now holds a NEWER
  // blob than what `slot.entry` was built from, exactly like a socket loss
  // with the transport stopped and no rebuild in between.
  setLoadedVstEntryLookup((id) =>
    id === 'stale' ? entry('stale', { vst: { plugin_path: 'p.vst3', plugin_name: 'p', raw_state: 'TkVX' } }) : undefined,
  );

  onStatus('error', 'socket closed (1006)'); // trigger recreate(slot)
  await new Promise((r) => setTimeout(r, 0));
  setLoadedVstEntryLookup(() => undefined); // don't leak into later tests

  const post = backend.calls.filter((c) => c.url === '/api/vst/live/session' && c.method === 'POST').at(-1);
  assert.equal(
    (post?.body as { raw_state?: string }).raw_state,
    'TkVX',
    "recreate() respawns with the FRESHLY-READ entry's raw_state, not the acquire()-time snapshot",
  );
  assert.equal(liveEntries().stale.stateOrigin, 'live', 'the row matches what was actually just spawned with');
  assert.equal(registry.get('stale')?.stateSent, true, "the new session's stateSent reflects the fresh blob it was sent");
}

console.log('vstLive/sessionRegistry: ok');
