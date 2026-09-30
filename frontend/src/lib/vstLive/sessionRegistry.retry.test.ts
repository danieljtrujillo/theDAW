/**
 * vstLive/sessionRegistry — retry() re-opening a session-less slot.
 *
 * `retry()` used to be a no-op unless a session already existed, so an entry
 * whose FIRST open failed (no host binary yet, backend down, spawn refused)
 * could never recover without a full chain rebuild. These cases cover the
 * session-less path: re-opening after a failed spawn, re-probing a host that
 * was not available at first, and staying a no-op while an open is already
 * running or the entry id is unknown. The healthy-session path (case 1) is
 * re-asserted here too, since retry() now branches on `slot.session`.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.retry.test.ts
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
  retryNowCalls = 0;
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
  retryNow(): void {
    this.retryNowCalls += 1;
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

/** Flush the microtask chain a real `fetch`/`.then()` pipeline runs on — the
 *  same trick sessionRegistry.test.ts uses for its background re-create case. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/* ── retry on a healthy session calls retryNow ─────────────────────────────── */
{
  const { registry } = setup();
  const s = await registry.acquire(entry('e1'), 48000);
  assert.ok(s, 'a healthy host yields a session');
  const client = FakeClient.made[0];
  assert.equal(client.retryNowCalls, 0);

  registry.retry('e1');
  assert.equal(client.retryNowCalls, 1, 'retryNow is called on the existing client');
  assert.equal(FakeClient.made.length, 1, 'no second client is made for a healthy session');
  assert.equal(liveEntries().e1.status, 'starting', 'the row says so while the reconnect runs');
}

/* ── retry re-opens a slot whose first spawn failed ────────────────────────── */
{
  const { backend, registry } = setup();
  backend.failCreate = 'session cap reached (24)';
  const first = await registry.acquire(entry('e1'), 48000);
  assert.equal(first, null, 'the first spawn failed');
  assert.equal(registry.get('e1'), undefined, 'no session to reconnect');
  assert.equal(liveEntries().e1.status, 'error');

  backend.failCreate = null;
  registry.retry('e1');
  await flush();
  assert.ok(registry.get('e1'), 'retry re-opens the slot now that the spawn succeeds');
  assert.equal(liveEntries().e1.status, 'starting');
}

/* ── retry re-probes the host binary ───────────────────────────────────────── */
{
  const { backend, registry } = setup();
  backend.hostInfo = { available: false, reason: 'thedaw-vst-host.exe not built — see docs/windows' };
  const first = await registry.acquire(entry('e1'), 48000);
  assert.equal(first, null);
  assert.equal(registry.get('e1'), undefined);
  assert.equal(liveEntries().e1.status, 'unavailable');

  // The user built the host binary; a plain retry must not replay the cached
  // "no" — it has to ask again.
  backend.hostInfo = { available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' };
  registry.retry('e1');
  await flush();
  assert.ok(registry.get('e1'), 'retry re-probes the host and opens once it answers available');
}

/* ── retry is a no-op while an open is in flight ───────────────────────────── */
{
  const { backend, registry } = setup();
  const opening = registry.acquire(entry('e1'), 48000);
  // The slot exists with `opening` set synchronously; retry must not race it.
  registry.retry('e1');
  registry.retry('e1');
  await opening;
  assert.equal(
    backend.calls.filter((c) => c.url === '/api/vst/live/session').length,
    1,
    'createSession was called exactly once',
  );
}

/* ── retry for an unknown entry id does nothing and does not throw ────────── */
{
  const { registry } = setup();
  assert.doesNotThrow(() => registry.retry('nobody'));
  assert.deepEqual(liveEntries(), {}, 'nothing was created for an id with no slot');
}

{
  // R1 review finding: retry's re-open mirrored acquire's spawn, but not
  // acquire's own guard against losing a race with close()/closeAll(). While
  // the re-open awaits the (re-probed) host check, nothing about `open()`
  // knows the slot it was handed has since been dropped from the registry —
  // so on the old code the freshly spawned session would land on an orphaned
  // slot, stay connected forever, and its host process would never get the
  // DELETE that tells it to exit.
  const { backend, registry } = setup();
  backend.failCreate = 'session cap reached (24)';
  const first = await registry.acquire(entry('e1'), 48000);
  assert.equal(first, null, 'the first spawn failed');

  backend.failCreate = null;
  registry.retry('e1');
  // close() lands synchronously, while retry's re-open is still suspended on
  // `await probeHost()` — the same race a "remove the entry right after
  // pressing retry" click produces.
  registry.close('e1');
  await flush();

  assert.equal(registry.get('e1'), undefined, 'the entry stays gone');
  const raced = FakeClient.made[FakeClient.made.length - 1];
  assert.ok(raced, 'the re-open still spawned a session before finding out it lost the race');
  assert.equal(raced.closed, 1, 'the orphaned session is closed, not left connected forever');
  assert.ok(
    backend.deleted.includes('/api/vst/live/session/sess-e1'),
    'and its host process gets the DELETE that tells it to exit — it is not leaked',
  );
}

console.log('vstLive/sessionRegistry.retry: ok');
