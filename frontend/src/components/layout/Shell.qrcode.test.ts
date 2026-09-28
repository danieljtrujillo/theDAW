/**
 * T20 re-audit item 1 (CRITICAL): the mobile-access and phone-companion QR
 * codes were rendered by GETting `api.qrserver.com` with the full target URL
 * (including, for the companion QR, the LAN pairing token riding
 * `#pair=<token>`) folded into a `?data=` query param. `encodeURIComponent`
 * turns the URL fragment into a plain query value, so `<img src=...>` sent
 * the token to a third-party server's access logs and any TLS-terminating
 * proxy in between — this proves neither QR is produced that way any more.
 *
 * Shell needs the full app-store tree mounted to exercise this at runtime,
 * so per the house pattern for a component-only fix (see Shell.test.ts /
 * Shell.pairing.test.ts) this asserts the wiring at SOURCE level.
 *
 * Run: `npx tsx src/components/layout/Shell.qrcode.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Shell.tsx'),
  'utf8',
);

// No third-party QR image service, and no other absolute http(s) URL used
// to render either QR code.
assert.doesNotMatch(
  source,
  /qrserver\.com/i,
  'Shell must not reference api.qrserver.com (or any qrserver.com host) anywhere — the companion QR must never leave the browser',
);
assert.doesNotMatch(
  source,
  /https?:\/\/[^'"`\s]*\/create-qr-code/i,
  'Shell must not build a QR image URL against any external "create-qr-code" endpoint',
);

// The QR payload must be produced locally: a client-side <QRCode> component
// fed the raw value directly, not an <img> pointed at a remote generator.
assert.match(
  source,
  /lazy\(\(\) => import\(['"]react-qr-code['"]\)\)/,
  'Shell must render QR codes via a locally-rendered component (react-qr-code), lazy-loaded so it does not bloat the entry chunk',
);
assert.doesNotMatch(
  source,
  /<img[^>]*qrImageUrl/,
  'the mobile-access QR must no longer be an <img> pointed at a remote-generated URL',
);
assert.doesNotMatch(
  source,
  /<img[^>]*companionQrUrl/,
  'the companion QR must no longer be an <img> pointed at a remote-generated URL',
);
assert.match(
  source,
  /<QRCode\s+value=\{pairedShareUrl\}/,
  'the mobile-access QR must render locally from pairedShareUrl (the Share URL plus the LAN pairing token, see lib/shareLink.ts)',
);
assert.match(
  source,
  /<QRCode\s+value=\{companionUrl\}/,
  'the companion QR must render locally from companionUrl (which can carry the LAN pairing token) — never round-tripped through a third party',
);

console.log('Shell.qrcode: all assertions passed');
