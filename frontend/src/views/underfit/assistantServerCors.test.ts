/**
 * Every /api route of the UNDERFIT assistant backend answers the orb's origin.
 *
 * The orb runs on the Underfit dashboard (:8791) and reads
 * http://localhost:5473/api/health cross-origin to decide whether the backend
 * is up. server.ts registered /api/health (and /api/shutdown) above its
 * /api-wide CORS middleware, so the health response had no
 * Access-Control-Allow-Origin header, the browser refused it, and the orb
 * showed Offline while the server ran. Express runs middleware in
 * registration order, so the check is that the CORS middleware comes first.
 *
 * The backend's own packages (express) are not installed in this checkout's
 * frontend, so this reads the route table from the source.
 *
 * Run: npx tsx src/views/underfit/assistantServerCors.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '../../../../underfit/assistant-backend/server.ts');
const source = readFileSync(serverPath, 'utf-8');

const corsMatch = /app\.use\(\s*"\/api"\s*,\s*\(req, res, next\) => \{\s*if \(!applyCors\(req, res\)\)/.exec(source);
assert.ok(corsMatch, 'server.ts has an /api-wide middleware that runs applyCors');
const corsAt = corsMatch.index;

const routes = [...source.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*"(\/api[^"]*)"/g)];
assert.ok(routes.length > 5, `found the /api routes (${routes.length})`);
for (const route of routes) {
  assert.ok(
    (route.index ?? 0) > corsAt,
    `${route[1].toUpperCase()} ${route[2]} is registered before the CORS middleware, so the orb cannot read it`,
  );
}
for (const path of ['/api/health', '/api/shutdown']) {
  assert.ok(routes.some((r) => r[2] === path), `${path} is still served`);
}

// The dashboard origin the orb runs on is allowed.
assert.ok(source.includes('"http://localhost:8791"'), 'the dashboard origin is on the allow list');

console.log('assistantServerCors: ok');
