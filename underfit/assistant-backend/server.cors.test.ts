/**
 * The assistant server's CORS answer, from the real server.
 *
 * The orb on Underfit's dashboard (:8791) reads http://localhost:5473/api/health
 * cross-origin to decide the backend is up. /api/health was registered above
 * the /api CORS middleware, so its answer carried no
 * Access-Control-Allow-Origin, the browser refused it, and the orb stayed on
 * Offline with the server running. /api/shutdown sat there too and took a
 * post from any page. This imports server.ts the way its own comment
 * describes (NODE_ENV=test: the app is built, nothing listens on 5473), binds
 * it to a free loopback port and asks it what a browser would.
 *
 * Run with `npm test` in underfit/assistant-backend.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// server.ts creates ./data/... under the working folder when it loads.
const home = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "assistant-cors-"));
process.chdir(scratch);

const { app } = await import("./server.ts");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((ready) => server.once("listening", () => ready()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const DASHBOARD = "http://localhost:8791";
const STRANGER = "https://example.com";

try {
  const health = await fetch(`${base}/api/health`, { headers: { Origin: DASHBOARD } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), DASHBOARD);
  assert.equal((await health.json()).app, "underfit-assistant");

  const preflight = await fetch(`${base}/api/health`, {
    method: "OPTIONS",
    headers: { Origin: DASHBOARD, "Access-Control-Request-Method": "GET" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), DASHBOARD);

  // theDAW's sidecar sends no Origin at all and must still get through.
  const sidecar = await fetch(`${base}/api/health`);
  assert.equal(sidecar.status, 200);

  const refused = await fetch(`${base}/api/health`, { headers: { Origin: STRANGER } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);

  // A page on another site cannot stop the server.
  const shutdown = await fetch(`${base}/api/shutdown`, {
    method: "POST",
    headers: { Origin: STRANGER },
  });
  assert.equal(shutdown.status, 403);

  console.log("server.cors: ok");
} finally {
  // Close the keep-alive sockets fetch left open, then the server, and wait
  // for it: the process then ends on its own with an empty event loop. A
  // process.exit() here, while those sockets were still closing, crashed
  // Node on Windows (libuv "Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)", exit 127) in most runs, after the test had passed.
  server.closeAllConnections();
  await new Promise<void>((closed) => server.close(() => closed()));
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
}
