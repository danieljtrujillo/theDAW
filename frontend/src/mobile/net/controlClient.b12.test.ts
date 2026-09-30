/**
 * T20 re-audit item 7 (controlClient.ts): the XR posture code query key
 * moved from `?pair=` to `?xrcode=` (it collided in NAME with the unrelated
 * LAN pairing token, which rides `#pair=<token>` in the URL fragment — see
 * lib/pairing.ts). `?pair=` must still work as a fallback for one release
 * so an existing bookmarked/shared link keeps working.
 *
 * This drives `useControlStore.connect()` against a fake WebSocket and
 * inspects the `controller-hello` frame it sends on open, which carries
 * whatever `pairCode()` resolved to.
 *
 * jsdom supplies `window.location`; the WebSocket global is a minimal fake
 * (there is no real relay to connect to here).
 *
 * Run: `npx tsx src/mobile/net/controlClient.b12.test.ts`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

class FakeWebSocket {
  static OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // Test helper: simulate the relay accepting the connection.
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

async function helloCodeFor(url: string): Promise<string | null> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true });
  const win = dom.window;
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: win.location, configurable: true, writable: true });
  FakeWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });

  // Fresh module instance per URL: controlClient.ts has module-scope `ws`/
  // `running` state, so re-importing after resetting the module registry is
  // the only way to test `pairCode()` under a fresh `window.location` per
  // case without inventing a reset API this ticket has no reason to add.
  const modUrl = `./controlClient.ts?case=${encodeURIComponent(url)}`;
  const { useControlStore } = await import(modUrl);

  useControlStore.getState().connect();
  const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  sock.triggerOpen();
  assert.equal(sock.sent.length, 1, 'exactly one controller-hello frame is sent on open');
  const hello = JSON.parse(sock.sent[0]);
  assert.equal(hello.type, 'controller-hello');
  useControlStore.getState().disconnect();
  return hello.code as string | null;
}

// ── new key: ?xrcode= is read ───────────────────────────────────────────
assert.equal(
  await helloCodeFor('http://localhost/mobile.html?xrcode=1234'),
  '1234',
  '?xrcode= must be read as the XR posture code',
);

// ── old key: ?pair= still works as a fallback ───────────────────────────
assert.equal(
  await helloCodeFor('http://localhost/mobile.html?pair=5678'),
  '5678',
  '?pair= must still work as a fallback for an existing bookmarked/shared link',
);

// ── both present: ?xrcode= wins ─────────────────────────────────────────
assert.equal(
  await helloCodeFor('http://localhost/mobile.html?xrcode=new&pair=old'),
  'new',
  '?xrcode= must take priority over ?pair= when both are present',
);

// ── neither present: null ───────────────────────────────────────────────
assert.equal(
  await helloCodeFor('http://localhost/mobile.html'),
  null,
  'no code param at all resolves to null',
);

console.log('controlClient.b12: all assertions passed');
