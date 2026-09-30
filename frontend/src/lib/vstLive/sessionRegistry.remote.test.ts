/**
 * vstLive/sessionRegistry — refusing a live session when the PAGE ITSELF is
 * not local.
 *
 * The host binds loopback only, so `ws://127.0.0.1:<port>` only ever reaches
 * the machine that dials it. Opened from a phone or a second PC, that is
 * never the machine running the host: before this, `open()` still probed the
 * host and spawned a process on the machine that DOES have the plugins, then
 * left the row on a "reconnecting" pill forever once the socket predictably
 * could never connect. `isLocalPage` lets `open()` refuse up front, with a
 * reason the user can read, instead of spawning anything.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.remote.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry, isLocalPage } from './sessionRegistry.ts';
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
  nextPort = 60001;
  sessions = new Map<string, { port: number }>();
  deleted: string[] = [];

  fetch = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ url: input, method, body });

    if (input === '/api/vst/live/host') return json(this.hostInfo);
    if (input === '/api/vst/live/session' && method === 'POST') {
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
}

/** A stand-in for VstBridgeClient: records what the registry did to it. */
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
  retryNow(): void {}
}

const entry = (id: string, over: Partial<ChainEntry> = {}): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11', raw_state: 'c2F2ZWQ=' },
  ...over,
});

function setup(location?: { hostname: string; protocol: string }, graceMs = 10000) {
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
    location,
  });
  return { backend, registry };
}

const liveEntries = () => useVstLiveStore.getState().entries;

const REMOTE_REASON =
  'Live plugins run only on the computer that has them. This page is open from another device, so this plugin is applied when you freeze or bounce instead.';

/* ── a page on a LAN address never calls the backend and ends unavailable with the plain reason ── */
{
  const { backend, registry } = setup({ hostname: '192.168.1.42', protocol: 'http:' });
  const session = await registry.acquire(entry('e1'), 48000);
  assert.equal(session, null, 'a page dialing its own loopback gets nothing to host');
  assert.deepEqual(backend.calls, [], 'refused before the host probe and before the spawn');
  assert.equal(liveEntries().e1.status, 'unavailable');
  assert.equal(liveEntries().e1.reason, REMOTE_REASON);
}

/* ── localhost, 127.0.0.1, [::1], app: and file: are local ─────────────────── */
{
  const local: { hostname: string; protocol: string }[] = [
    { hostname: 'localhost', protocol: 'http:' },
    { hostname: '127.0.0.1', protocol: 'http:' },
    { hostname: '[::1]', protocol: 'http:' },
    { hostname: '::1', protocol: 'http:' },
    { hostname: 'whatever-desktop-picks', protocol: 'app:' },
    { hostname: 'whatever-desktop-picks', protocol: 'file:' },
  ];
  for (const loc of local) assert.equal(isLocalPage(loc), true, `expected local: ${JSON.stringify(loc)}`);

  const remote: { hostname: string; protocol: string }[] = [
    { hostname: '192.168.1.42', protocol: 'http:' },
    { hostname: 'mystudio.example.com', protocol: 'https:' },
    { hostname: '10.0.0.5', protocol: 'http:' },
  ];
  for (const loc of remote) assert.equal(isLocalPage(loc), false, `expected remote: ${JSON.stringify(loc)}`);
}

/* ── no location object means local ────────────────────────────────────────── */
{
  assert.equal(
    typeof (globalThis as { location?: unknown }).location,
    'undefined',
    'this suite runs under plain node — no ambient page location to fall back to, which is exactly the case under test',
  );
  const { backend, registry } = setup(); // no `location` dep, and globalThis has none either
  const session = await registry.acquire(entry('e1'), 48000);
  assert.ok(session, 'unknown is not remote — nothing is refused without proof the page is elsewhere');
  assert.equal(backend.calls.length, 2, 'host probe, then spawn — proceeds exactly as a local page would');
  assert.equal(liveEntries().e1.status, 'starting');
}

/* ── a local page still opens a session exactly as before ─────────────────── */
{
  const { backend, registry } = setup({ hostname: 'localhost', protocol: 'http:' });
  const session = await registry.acquire(entry('e1'), 48000);
  assert.ok(session, 'a healthy host yields a session for a local page');
  assert.equal(session.sessionId, 'sess-e1');
  assert.equal(session.wsUrl, 'ws://127.0.0.1:60001');
  assert.deepEqual(backend.calls[0], { url: '/api/vst/live/host', method: 'GET', body: undefined });
  assert.equal(backend.calls[1]?.url, '/api/vst/live/session');
  assert.equal(liveEntries().e1.status, 'starting');
}

console.log('vstLive/sessionRegistry.remote: ok');
