/**
 * Batch-12 QR-token fix: ControllerVisionModal's phone-pairing QR and
 * VJView's mobile-URL QR were both rendered by GETting `api.qrserver.com`
 * with the target URL folded into a `?data=` query param. For
 * ControllerVisionModal that URL carries the phone-pairing session id
 * (`backend/modules/controllervision/router.py` — `sid`), a bearer
 * credential for uploading into the user's controller-vision session; that
 * leaked it to a third-party service's access logs and any TLS-terminating
 * proxy in between. VJView's mobile URL carries no credential (it is just
 * `http://<lan-ip>:<port>` / `<port><path>` — see `backend/modules/vj/
 * sidecar.py::mobile_url_for` and `router.py::get_url`), but a QR is a
 * local rendering job with no reason to touch a remote host either way.
 *
 * `Shell.qrcode.test.ts` already asserts Shell.tsx is clean of
 * `api.qrserver.com`. This suite is the repo-wide companion: it scans every
 * file under `frontend/src/` so a fourth (or fifth) site cannot reintroduce
 * the same defect unnoticed, and it specifically pins ControllerVisionModal
 * and VJView to the same locally-rendered `react-qr-code` pattern Shell.tsx
 * uses (`lazy(() => import('react-qr-code'))` inside a `<Suspense>`).
 *
 * Run: `npx tsx src/qrCodeHosting.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);

function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...collectFiles(join(dir, entry.name)));
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (TEXT_EXT.has(ext)) found.push(join(dir, entry.name));
  }
  return found;
}

const files = collectFiles(srcDir);
assert.ok(files.length > 100, `expected to scan a substantial slice of frontend/src, found only ${files.length} files`);

const qrserverHits: string[] = [];
const createQrCodeHits: string[] = [];

for (const file of files) {
  // Test files legitimately mention the banned strings in their own
  // assertion prose/regex (this file's sibling Shell.qrcode.test.ts, and
  // this file itself) — scanning them would trivially self-fail. Only
  // non-test application source is held to the "never references" bar.
  if (/\.test\.[tj]sx?$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (/qrserver\.com/i.test(text)) qrserverHits.push(relative(srcDir, file));
  if (/https?:\/\/[^'"`\s]*\/create-qr-code/i.test(text)) createQrCodeHits.push(relative(srcDir, file));
}

assert.deepEqual(
  qrserverHits,
  [],
  `no file under frontend/src should reference api.qrserver.com (or any qrserver.com host) — found in: ${qrserverHits.join(', ')}`,
);
assert.deepEqual(
  createQrCodeHits,
  [],
  `no file under frontend/src should build a QR image URL against an external "create-qr-code" endpoint — found in: ${createQrCodeHits.join(', ')}`,
);

// Both fixed call sites must render QR codes locally via react-qr-code,
// lazy-loaded (kept out of the entry chunk) the same way Shell.tsx does,
// never via an <img> pointed at a remote generator.
const targets = [
  { path: join(srcDir, 'components/layout/ControllerVisionModal.tsx'), valueExpr: 'phoneUrl' },
  { path: join(srcDir, 'views/VJView.tsx'), valueExpr: 'mobileUrl' },
];

for (const { path, valueExpr } of targets) {
  const text = readFileSync(path, 'utf8');
  const label = relative(srcDir, path);
  assert.match(
    text,
    /lazy\(\(\) => import\(['"]react-qr-code['"]\)\)/,
    `${label} must render QR codes via a locally-rendered component (react-qr-code), lazy-loaded so it does not bloat the entry chunk`,
  );
  assert.match(
    text,
    new RegExp(`<QRCode\\s+value=\\{${valueExpr}\\}`),
    `${label} must render its QR locally from ${valueExpr}`,
  );
  assert.doesNotMatch(
    text,
    new RegExp(`<img[^>]*${valueExpr}`),
    `${label}'s QR must no longer be an <img> pointed at a remote-generated URL`,
  );
}

console.log('qrCodeHosting: all assertions passed');
