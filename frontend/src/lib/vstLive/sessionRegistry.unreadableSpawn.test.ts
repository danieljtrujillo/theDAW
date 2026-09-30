/**
 * A spawn must not claim the plugin holds the saved state when nobody could
 * read that state (T18 fourth audit, MAJOR 3).
 *
 * `open()` sets `stateOrigin: 'live'` on every fresh spawn — "the plugin holds
 * what the entry holds" — which is true when the entry's state was read and
 * sent. It is exactly wrong when the state could NOT be read: the host was
 * handed nothing, the plugin is at its factory defaults, and the row showed a
 * plain LIVE badge while every capture was silently refused.
 *
 * Driven through the REAL registry (the fake stops at `fetch`), because the
 * editor-store tests inject a session lookup and never reach this line.
 *
 * Run: npx tsx src/lib/vstLive/sessionRegistry.unreadableSpawn.test.ts
 */
import assert from 'node:assert/strict';

import { createVstSessionRegistry } from './sessionRegistry.ts';
import { setVstStateUnresolvedLookup } from '../vstStateStorage.ts';
import type { VstBridgeClientOptions } from './bridgeClient.ts';
import { useVstLiveStore } from '../../state/vstLiveStore.ts';
import type { ChainEntry } from '../../state/effectChainStore.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

(globalThis as { fetch: unknown }).fetch = async (input: string, init?: { method?: string }) => {
  const method = init?.method ?? 'GET';
  if (input === '/api/vst/live/host') return json({ available: true, path: 'C:/x/host.exe', version: '1.0.0' });
  if (input === '/api/vst/live/session' && method === 'POST') {
    return json({ session_id: 'sess-1', ws_url: 'ws://127.0.0.1:60001', pid: 4242, protocol: 1 });
  }
  if (method === 'DELETE') return json({});
  return json({ detail: 'unexpected' }, 404);
};

class FakeClient {
  ready = false;
  constructor(readonly opts: VstBridgeClientOptions) {}
  connect(): void {}
  close(): void {}
}

const entry = (id: string): ChainEntry => ({
  id,
  effect: 'vst3',
  params: {},
  enabled: true,
  vst: { plugin_path: 'C:/VST3/Ozone 11.vst3', plugin_name: 'Ozone 11' },
});

useVstLiveStore.setState({ entries: {}, host: { available: null } });
const registry = createVstSessionRegistry({
  schedule: () => 1,
  cancel: () => {},
  makeClient: (opts) => new FakeClient(opts) as never,
});

/* ── an entry whose saved state could not be read ─────────────────────────── */
{
  setVstStateUnresolvedLookup((id) => id === 'unreadable');
  await registry.acquire(entry('unreadable'), 48000);
  const row = useVstLiveStore.getState().entries['unreadable'];
  assert.equal(row?.stateOrigin, 'state-rejected', 'the row says the plugin is on its factory defaults');
  assert.match(row?.stateReason ?? '', /read/i, `with a reason: ${row?.stateReason}`);
}

/* ── an entry whose state IS known is unchanged: the spawn sent it ────────── */
{
  await registry.acquire(entry('normal'), 48000);
  const row = useVstLiveStore.getState().entries['normal'];
  assert.equal(row?.stateOrigin, 'live', 'a normal spawn still claims the plugin holds the entry state');
  assert.equal(row?.stateReason, undefined);
}

setVstStateUnresolvedLookup(() => false);
console.log('vstLive/sessionRegistry.unreadableSpawn: ok');
