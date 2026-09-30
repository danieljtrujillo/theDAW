/**
 * vstLive/sessionRegistry — hold() / unhold(): a session kept alive by something
 * that is not an audio node.
 *
 * The plugin's own window has to belong to the LIVE instance, and the user can
 * open it before the engine has built the chain (add a plugin with the transport
 * stopped). So the editor HOLDS the entry's session: the first hold spawns it,
 * a node that arrives later reuses it, and the reaper cannot run while either a
 * holder or a node is left.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.hold.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry } from './sessionRegistry.ts';
import type { VstBridgeClientOptions } from './bridgeClient.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';

/* ── fakes (same shape as sessionRegistry.retry.test.ts) ──────────────────── */

class FakeBackend {
  creates = 0;
  deleted: string[] = [];
  fetch = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (input === '/api/vst/live/host') {
      return json({ available: true, path: 'C:/x/thedaw-vst-host.exe', version: '1.0.0' });
    }
    if (input === '/api/vst/live/session' && method === 'POST') {
      this.creates += 1;
      const req = JSON.parse(init?.body ?? '{}') as { chain_entry_id: string };
      return json({ session_id: `sess-${req.chain_entry_id}`, ws_url: 'ws://127.0.0.1:60001', pid: 4242, protocol: 1 });
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
}

class FakeClient {
  static made: FakeClient[] = [];
  closed = 0;
  constructor(readonly opts: VstBridgeClientOptions) {
    FakeClient.made.push(this);
  }
  connect(): void {}
  close(): void {
    this.closed += 1;
  }
  retryNow(): void {}
}

const entry = (id: string): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 12.vst3', plugin_name: 'Ozone 12', raw_state: 'c2F2ZWQ=' },
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

/* ── a hold with no node spawns the session, and a node arriving later reuses it ── */
{
  const { backend, registry } = setup();
  const held = await registry.hold(entry('a'), 44100, 'editor');
  assert.ok(held, 'a hold opens the session when nothing else has');
  assert.equal(backend.creates, 1, 'one spawn for the hold');
  const forNode = await registry.acquire(entry('a'), 44100);
  assert.equal(forNode, held, 'the node gets the SAME session the editor window belongs to');
  assert.equal(backend.creates, 1, 'a node arriving later never spawns a second plugin instance');
}

/* ── the reaper cannot run while a holder remains ── */
{
  const { backend, clock, registry } = setup(10000);
  await registry.hold(entry('b'), 44100, 'editor');
  await registry.acquire(entry('b'), 44100);
  registry.release('b'); // the node goes away (transport stopped, chain rebuilt)
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 'the editor window still holds the session: it must stay up');
  registry.unhold('b', 'editor');
  clock.advance(9999);
  assert.equal(backend.deleted.length, 0, 'the grace period starts only at the last unhold');
  clock.advance(2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.deleted.length, 1, 'no holder and no node left: the session is reaped after the grace period');
}

/* ── giving a hold back while a node still uses the session changes nothing ── */
{
  const { backend, clock, registry } = setup(10000);
  await registry.acquire(entry('c'), 44100);
  await registry.hold(entry('c'), 44100, 'editor');
  registry.unhold('c', 'editor'); // the user closed the plugin window during playback
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 'closing the plugin window must never take the live plugin out of the mix');
  assert.equal(FakeClient.made[0]?.closed ?? 0, 0, 'the socket stays open');
}

/* ── unhold is idempotent and unknown holders are ignored ── */
{
  const { backend, clock, registry } = setup(10000);
  await registry.hold(entry('d'), 44100, 'editor');
  registry.unhold('d', 'someone-else');
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 'a holder that never held cannot start the reaper');
  registry.unhold('d', 'editor');
  registry.unhold('d', 'editor');
  clock.advance(10001);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.deleted.length, 1, 'a double unhold reaps once');
  registry.unhold('nope', 'editor'); // unknown entry: no throw
}

/* ── two nodes: the session survives until the LAST one releases ── */
{
  const { backend, clock, registry } = setup(10000);
  await registry.acquire(entry('e'), 44100); // old graph
  await registry.acquire(entry('e'), 44100); // new graph built before the old one is disposed
  registry.release('e');
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 'a rebuild that acquires before it releases must not reap the session it is using');
  registry.release('e');
  clock.advance(10001);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.deleted.length, 1);
}

/* ── forget(): the entry left the project — a node of the last graph cannot keep its host alive ── */
{
  const { backend, clock, registry } = setup(10000);
  await registry.hold(entry('f'), 44100, 'project');
  await registry.hold(entry('f'), 44100, 'editor');
  await registry.acquire(entry('f'), 44100); // the node built by the last Play; the transport is stopped now
  registry.forget('f');
  clock.advance(9999);
  assert.equal(backend.deleted.length, 0, 'the grace period still applies: an undo can get the same plugin back');
  clock.advance(2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.deleted.length, 1, 'no Play was needed: the host of a removed plugin is shut down');
  registry.release('f'); // the stale node is disposed at the next Play: nothing left to release, no throw
  registry.forget('f'); // unknown by now: no throw
}

/* ── forget() then an undo inside the grace period: the very same session comes back ── */
{
  const { backend, clock, registry } = setup(10000);
  const first = await registry.hold(entry('g'), 44100, 'project');
  await registry.acquire(entry('g'), 44100);
  registry.forget('g');
  clock.advance(5000);
  const again = await registry.hold(entry('g'), 44100, 'project'); // undo: the entry is back in the rack
  assert.equal(again, first, 'the running plugin is reused, settings and all');
  registry.release('g'); // the stale node goes at the next Play; its count was already dropped
  clock.advance(60000);
  assert.equal(backend.deleted.length, 0, 'the project holds it again: no reaper');
  assert.equal(backend.creates, 1, 'and nothing was respawned');
}

console.log('vstLive/sessionRegistry.hold: ok');
