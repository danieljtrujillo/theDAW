/**
 * shareLink.ts — the Mobile Access Share URL carries the LAN pairing token.
 *
 * The reported break: the Share URL and its QR code opened the full desktop UI
 * with no `#pair=<token>`, so the device that opened them was a stranger to the
 * backend and every save, open, project clip, VST effect and Gemini call it
 * made came back 403, while the dialog said the link worked. Only the
 * companion link to /mobile.html carried the token.
 *
 * The first block replays the real sequence end to end: the desktop builds the
 * link, a second device opens it (lib/pairing.ts runs as the page loads), and
 * that device's next API request carries `X-TheDAW-Pair`. The rest pins the
 * wiring in Shell.tsx (the house pattern for a component that needs the whole
 * app-store tree: source level, see Shell.pairing.test.ts) and the fragment
 * edge cases.
 *
 * Run: npx tsx src/lib/shareLink.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pairedShareLink } from './shareLink.ts';

const here = dirname(fileURLToPath(import.meta.url));

// ── the sequence: desktop builds the link, another device opens it ─────────
{
  const token = 'tok-3rd_party/+=';
  const link = pairedShareLink('http://192.168.1.20:5173', token);

  // The device's browser loads the link: location comes from the link itself.
  const opened = new URL(link);
  const store = new Map<string, string>();
  let hash = opened.hash;
  const origin = opened.origin;
  const location = {
    get hash() {
      return hash;
    },
    pathname: opened.pathname,
    search: opened.search,
    origin,
    get href() {
      return `${origin}${opened.pathname}${opened.search}${hash}`;
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = {
    location,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        const at = url.indexOf('#');
        hash = at === -1 ? '' : url.slice(at);
      },
    },
  };

  // The page's first API request, through the same helper every client uses.
  const sent: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  // Imported only now, as the opened page would load it: pairing.ts reads the
  // fragment at module load.
  const { getJson } = await import('./apiJson.ts');
  const { PAIRING_HEADER } = await import('./pairing.ts');

  await getJson('/api/project/recent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][PAIRING_HEADER], token, 'the opened page sends the token it was given');
  assert.equal(hash, '', 'and the token is gone from the address bar');
  assert.equal(store.get('thedaw.pairingToken'), token, 'kept for that origin across reloads');
}

// ── Shell hands out the paired link, everywhere the Share URL goes ─────────
{
  const shell = readFileSync(join(here, '..', 'components', 'layout', 'Shell.tsx'), 'utf8');
  assert.match(
    shell,
    /const pairedShareUrl = useMemo\(\s*\(\) => pairedShareLink\(shareUrl, lanPairingToken\)/,
    'the Share URL is built from the detected/override URL plus the pairing token',
  );
  assert.match(shell, /<QRCode value=\{pairedShareUrl\}/, 'the QR code encodes the paired link');
  assert.match(
    shell,
    /id="shell-share-url"[\s\S]{0,120}value=\{pairedShareUrl\}/,
    'the Share URL field shows the paired link',
  );
  assert.match(shell, /writeText\(pairedShareUrl\)/, 'Copy copies the paired link');
  assert.match(shell, /<a href=\{pairedShareUrl\}/, 'Open link in new tab opens the paired link');
  assert.doesNotMatch(shell, /value=\{shareUrl\}/, 'no Share URL control is left on the unpaired link');
  assert.doesNotMatch(shell, /writeText\(shareUrl\)/, 'and Copy no longer copies it');

  // The dialog says what a device opened from it can do, and says so honestly
  // when there is no token to hand out.
  assert.match(shell, /This link pairs the device that opens it/);
  assert.match(shell, /This link carries no pairing token/);
}

// ── the desktop entry reads the fragment itself ────────────────────────────
{
  const main = readFileSync(join(here, '..', 'main.tsx'), 'utf8');
  const pairingAt = main.indexOf("import './lib/pairing';");
  const appAt = main.indexOf("import App from './App.tsx';");
  assert.ok(pairingAt >= 0, 'main.tsx imports lib/pairing directly');
  assert.ok(pairingAt < appAt, 'before App, so the token is stored before any request');
}

// ── fragment edge cases ────────────────────────────────────────────────────
{
  assert.equal(pairedShareLink('http://10.0.0.5:5173', null), 'http://10.0.0.5:5173', 'no token: unchanged');
  assert.equal(pairedShareLink('', 'abc'), '', 'no URL: nothing to share');
  assert.equal(pairedShareLink('  https://x.trycloudflare.com/  ', 'abc'), 'https://x.trycloudflare.com/#pair=abc');
  assert.equal(
    pairedShareLink('https://x.trycloudflare.com/#view=edit', 'abc'),
    'https://x.trycloudflare.com/#view=edit&pair=abc',
    'other fragment parts are kept',
  );
  assert.equal(
    pairedShareLink('https://x.trycloudflare.com/#pair=old&view=edit', 'new'),
    'https://x.trycloudflare.com/#view=edit&pair=new',
    'a stale token in a pasted override is replaced, never doubled',
  );
  assert.equal(pairedShareLink('http://h:1/', 'a b&c'), 'http://h:1/#pair=a%20b%26c', 'the token is encoded');
}

console.log('shareLink.test.ts: all assertions passed');
