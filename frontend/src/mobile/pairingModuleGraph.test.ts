/**
 * T20 re-audit item 2 (MAJOR): `lib/pairing.ts` is the only reader of
 * `#pair=<token>` in the URL fragment (see `initPairing()`, run once at
 * module scope on import) — but nothing on the companion entry point's
 * module graph ever imported it, so the phone never stored the token, never
 * stripped it from the address bar, and never sent it as the
 * `X-TheDAW-Pair` header. `Shell.pairing.test.ts` only proved the desktop
 * SOURCE contains `#pair=`; it cannot prove the mobile bundle actually
 * consumes it — that requires walking the real import graph from the
 * companion entry point, which is what this does.
 *
 * A source scan of `main.tsx` alone is not enough: an earlier pass could
 * "fix" this by importing pairing.ts from some other file already on the
 * graph, and a regression could just as easily drop the import again
 * without touching main.tsx. Walking the whole graph from the true entry
 * point is what actually proves consumption end to end — the same
 * philosophy as `App.bundle.check.ts` for the desktop entry chunk, but
 * cheap enough (pure source-level relative-import parsing, no bundler run)
 * to live in the regular `npm test` discovery run instead of `test:bundle`.
 *
 * Run: `npx tsx src/mobile/pairingModuleGraph.test.ts`
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = dirname(dirname(fileURLToPath(import.meta.url))); // .../src
const entryFile = join(srcRoot, 'mobile', 'main.tsx');

// Matches `import ... from '<spec>'`, `import '<spec>'` (side-effect only,
// exactly how main.tsx pulls in pairing.ts), and `export ... from '<spec>'`
// — only relative specifiers (`./`, `../`) are graph edges; a bare package
// specifier (`react`, `lucide-react`, ...) is a leaf we don't walk into.
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx'];
const INDEX_EXTS = ['index.ts', 'index.tsx', 'index.js'];

function resolveModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const ext of CANDIDATE_EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  for (const indexFile of INDEX_EXTS) {
    const candidate = join(base, indexFile);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const visited = new Set<string>();
const queue: string[] = [entryFile];

while (queue.length > 0) {
  const file = queue.pop()!;
  if (visited.has(file)) continue;
  visited.add(file);

  // Only walk files this tool actually parses for imports (source, not
  // css/assets — `main.tsx` also imports `./mobile.css`, which resolveModule
  // correctly fails to resolve as a JS module and is simply not queued).
  if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;

  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const resolved = resolveModule(file, match[1]);
    if (resolved && !visited.has(resolved)) queue.push(resolved);
  }
}

const pairingModule = join(srcRoot, 'lib', 'pairing.ts');
assert.ok(
  visited.has(pairingModule),
  `lib/pairing.ts must be reachable from mobile/main.tsx's import graph (walked ${visited.size} modules, pairing.ts absent) — the companion entry point must consume the LAN pairing token`,
);

console.log(`pairingModuleGraph: all assertions passed (${visited.size} modules walked)`);
