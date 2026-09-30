/**
 * T22 FETCH/CACHE HYGIENE — FE-020: `questMidiClient`'s `wsUrl()` jumped
 * straight from the https check to the desktop-app fallback
 * (`ws://127.0.0.1:8600/...`), skipping the LAN/dev case every other bridge
 * client here handles (see `xrControlClient.ts`'s `wsUrl()`): a page served
 * over plain http with a real `host` (Vite dev on another machine's LAN IP, a
 * phone/companion device) must connect back to ITS OWN host, not to
 * 127.0.0.1 on whatever machine happens to run the browser.
 *
 * Run: npx tsx src/state/questMidiClient.b12.test.ts
 */
import assert from 'node:assert/strict';

class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  close(): void {
    this.onclose?.();
  }
}

const location: { protocol: string; host: string } = { protocol: 'http:', host: '' };
const g = globalThis as unknown as Record<string, unknown>;
g.window = { location, setTimeout, clearTimeout };
g.WebSocket = FakeSocket;

const { startQuestMidi, stopQuestMidi } = await import('./questMidiClient.ts');

/** Start the bridge under `loc`, read the socket URL it opened, and stop it. */
function urlFor(loc: { protocol: string; host: string }): string {
  location.protocol = loc.protocol;
  location.host = loc.host;
  FakeSocket.made.length = 0;
  startQuestMidi();
  const sock = FakeSocket.made[0];
  assert.ok(sock, `a socket was opened for ${JSON.stringify(loc)}`);
  stopQuestMidi();
  return sock.url;
}

// ── LAN / dev http origin: derive from the page's own host ─────────────────
assert.equal(
  urlFor({ protocol: 'http:', host: '192.168.1.50:5173' }),
  'ws://192.168.1.50:5173/api/questmidi/ws',
  'an http page with a host connects back to that SAME host, not to a hardcoded 127.0.0.1',
);

// ── https origin: same-origin wss ───────────────────────────────────────────
assert.equal(
  urlFor({ protocol: 'https:', host: 'daw.example.com' }),
  'wss://daw.example.com/api/questmidi/ws',
  'https origin uses wss on the same host',
);

// ── Desktop app:// renderer (no usable host): falls back to loopback:8600 ──
assert.equal(
  urlFor({ protocol: 'app:', host: '' }),
  'ws://127.0.0.1:8600/api/questmidi/ws',
  'a renderer protocol with no host falls back to the local backend port',
);

console.log('questMidiClient: wsUrl derives from the page host on LAN/dev http, not a hardcoded loopback');
