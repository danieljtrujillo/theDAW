/**
 * T20 re-audit item 7 (RemoteGate.tsx copy): RemoteGate's "Pairing needed"
 * message told the user to "open the URL with ?pair=<code>" — but `?pair=`
 * now names the LAN pairing token, and the XR posture code moved to
 * `?xrcode=` (Shell.tsx, controlClient.ts). A user following the OLD
 * guidance while holding a pairing token would paste it into the query
 * string, where it silently fails as a posture code.
 *
 * Run: `npx tsx src/mobile/ui/RemoteGate.b12.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'RemoteGate.tsx'),
  'utf8',
);

assert.match(
  source,
  /\?xrcode=<code>/,
  'RemoteGate must tell the user to open the URL with ?xrcode=<code>, matching controlClient.ts\'s pairCode() and Shell.tsx\'s companion link',
);
assert.doesNotMatch(
  source,
  /\?pair=<code>/,
  'RemoteGate must not tell the user to use ?pair=<code> — that name now belongs to the unrelated LAN pairing token',
);

console.log('RemoteGate.b12: all assertions passed');
