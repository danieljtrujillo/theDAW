/**
 * vstLive/sessionRegistry — `recreate()`'s orphan-on-teardown race (RVT-3).
 *
 * A background re-create's `createSession` POST can still be in flight when
 * the user removes the entry (or closes the project). The old code's bare
 * `if (!slot.session) return;` matched that case but then just dropped
 * `info.session_id` on the floor: nobody holds it and nothing DELETEs it, so
 * it counts against the backend's session cap until the parent process dies.
 * `acquire()` already handles the same race correctly (see
 * sessionRegistry.test.ts / sessionRegistry.retry.test.ts) — this file pins
 * `recreate()` to the same shape.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.recreate.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry } from './sessionRegistry.ts';
import type { VstBridgeClientOptions } from './bridgeClient.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';

/* ── fakes (copied from sessionRegistry.test.ts) ──────────────────────────── */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

class FakeBackend {
  calls: Call[] = [];
  hostInfo: unknown = { available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' };
  /** Fail the next session POST with this message. */
  failCreate: string | null = null;
  nextPort = 60001;
  deleted: string[] = [];
  /** Armed by `deferNextCreate()`: the next session POST suspends here until
   *  `landDeferredCreate()` runs — how the tests below control exactly when a
   *  background re-create's `createSession` resolves relative to `close()`. */
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  deferNextCreate(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  landDeferredCreate(): void {
    this.release?.();
    this.release = null;
  }

  fetch = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ url: input, method, body });

    if (input === '/api/vst/live/host') return json(this.hostInfo);
    if (input === '/api/vst/live/session' && method === 'POST') {
      // Only clear `gate`, not `release`: `release` is the resolver for the
      // `pending` promise captured below, and must stay callable until the
      // test actually calls `landDeferredCreate()` — clearing it here (before
      // that call) would leave `pending` stuck forever.
      const pending = this.gate;
      this.gate = null;
      if (pending) await pending;
      if (this.failCreate) return json({ detail: this.failCreate }, 500);
      const req = body as { chain_entry_id: string };
      const port = this.nextPort++;
      // A fresh port per POST (rather than reusing one per entry id, as the
      // shared fake does) so a re-created session is always distinguishable
      // from the one it replaces.
      return json({
        session_id: `sess-${req.chain_entry_id}-${port}`,
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
}

/** A stand-in for VstBridgeClient: just enough for the registry to wire up,
 *  plus the `onStatus` handle the tests use to simulate a dead socket. */
class FakeClient {
  static made: FakeClient[] = [];
  connected = 0;
  closed = 0;
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

function setup(graceMs = 10000, stateSink?: (entryId: string, rawState: string) => void) {
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
    stateSink,
  });
  return { backend, registry };
}

const liveEntries = () => useVstLiveStore.getState().entries;

/** Flush the microtask chain a real fetch/.then() pipeline runs on — the same
 *  trick sessionRegistry.test.ts uses for its background re-create case. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/* ── a re-create that lands while the entry is gone deletes the new session ── */
{
  const { backend, registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;

  backend.deferNextCreate();
  onStatus('error', 'socket closed (1006)'); // trigger recreate(slot) in the background
  registry.close('e1'); // the entry is removed before the re-create's POST resolves
  backend.landDeferredCreate();
  await flush();

  assert.equal(
    backend.calls.filter((c) => c.url === '/api/vst/live/session' && c.method === 'POST').length,
    2,
    'the re-create POST landed',
  );
  // The first DELETE is close()'s teardown of the live session; the second is
  // the fix under test — the orphan the re-create produced after that. Fails
  // on the reverted file: the bare `if (!slot.session) return;` drops
  // `info.session_id` with no DELETE.
  assert.deepEqual(backend.deleted, [
    '/api/vst/live/session/sess-e1-60001',
    '/api/vst/live/session/sess-e1-60002',
  ]);
  assert.equal(registry.get('e1'), undefined, 'the entry stays gone');
}

/* ── a re-create that lands on a live slot updates the url and deletes nothing extra ── */
{
  const { backend, registry } = setup();
  const s = await registry.acquire(entry('e2'), 48000);
  assert.ok(s);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;

  onStatus('error', 'socket closed (1006)'); // no gate: the re-create lands on the next flush
  await flush();

  const got = registry.get('e2');
  assert.ok(got, 'the slot is still live');
  assert.equal(got.wsUrl, 'ws://127.0.0.1:60002', 'the slot picks up the re-created url');
  assert.equal(got.sessionId, 'sess-e2-60002', 'and the re-read session id');
  assert.equal(backend.deleted.length, 0, 'nothing was torn down, so nothing was DELETEd');
}

/* ── a rejected re-create puts the reason on the row ───────────────────────── */
{
  const { registry, backend } = setup();
  const s = await registry.acquire(entry('e3'), 48000);
  assert.ok(s);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;

  backend.failCreate = 'session cap reached (24)';
  onStatus('error', 'socket closed (1006)');
  await flush();

  assert.equal(liveEntries().e3.status, 'error');
  assert.match(liveEntries().e3.reason ?? '', /session cap reached/);

  // `recreating` must still be cleared in `finally` — a second socket loss
  // has to start another re-create, not be swallowed by recreate()'s own
  // `if (slot.recreating) return;` guard.
  backend.failCreate = null;
  const postsBefore = backend.calls.filter((c) => c.url === '/api/vst/live/session' && c.method === 'POST').length;
  onStatus('error', 'socket closed again (1006)');
  await flush();
  const postsAfter = backend.calls.filter((c) => c.url === '/api/vst/live/session' && c.method === 'POST').length;
  assert.equal(postsAfter, postsBefore + 1, 'recreating was cleared, so the second failure retries');
}

/* ── T18 seventh audit, MINOR 3 -- recreate() must not CLEAR an actual host
   rejection before the new session confirms it, and a close() that races the
   respawn must still rescue the DELETE's answer as a rejection, not 'live' ── */
{
  const rescued: Array<[string, string]> = [];
  const { backend, registry } = setup(10000, (entryId, rawState) => rescued.push([entryId, rawState]));
  const s = await registry.acquire(entry('e4'), 48000);
  assert.ok(s);
  const onStatus = FakeClient.made[0].opts.handlers.onStatus!;
  const onWarning = FakeClient.made[0].opts.handlers.onWarning!;

  // The host actually refused this session's state before the socket died.
  onWarning('the plugin rejected the state blob');
  assert.equal(liveEntries().e4?.stateOrigin, 'state-rejected', 'the refusal is recorded');

  backend.deferNextCreate();
  onStatus('error', 'socket closed (1006)'); // starts recreate() in the background

  // Before the respawn's POST has even resolved -- let alone before its own
  // `ready`/`warning`/`error` lands -- the row must still say the truth. The
  // reverted code wrote 'live' here SYNCHRONOUSLY, with no confirmation from
  // the new process at all.
  assert.equal(
    liveEntries().e4?.stateOrigin,
    'state-rejected',
    "recreate() must not clear a rejection before the new session confirms it",
  );

  // The entry leaves the project WHILE the respawn is still in flight -- the
  // exact window the finding could not drive in the reverted code.
  registry.close('e4');
  backend.landDeferredCreate();
  await flush();

  // `shutdown`'s `wasRejected` read the row BEFORE `clearEntry` wiped it. With
  // the origin still 'state-rejected' (never cleared by recreate()), the
  // DELETE's `raw_state` -- the plugin's untouched factory defaults, since it
  // was never actually handed a state that took -- must NOT be rescued onto
  // the entry. The reverted code's premature 'live' write made `wasRejected`
  // false here, so `rescued` would have gained an ['e4', ...] entry.
  assert.deepEqual(rescued, [], "a rejection recorded before the window must survive it");
  assert.equal(registry.get('e4'), undefined, 'the entry stays gone');
}

console.log('vstLive/sessionRegistry.recreate: ok');
