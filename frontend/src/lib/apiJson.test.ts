// Run with: npx tsx src/lib/apiJson.test.ts
//
// The reported symptom: the SWAY tab said "GET /api/sway/url returned HTTP
// 502." That route never returns 502, so the status came from a hop in front
// of the backend and meant the backend was unreachable. Seven clients share
// this helper, so the message is fixed here once.
import assert from 'node:assert/strict';
import { BACKEND_UNREACHABLE, GATEWAY_TIMEOUT, UPSTREAM_UNAVAILABLE } from './httpError.ts';

const res = (body: string, status: number, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

// The helper is module-private, so exercise it through the exported getJson
// with a stubbed fetch — the same path every caller takes.
const withFetch = async (response: Response, run: () => Promise<unknown>): Promise<string> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    await run();
    return '<no error thrown>';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    globalThis.fetch = original;
  }
};

const { getJson, postJson } = await import('./apiJson.ts');

// A bare 502 from a proxy: names the failing hop instead of the status.
{
  const msg = await withFetch(res('Bad Gateway', 502), () => getJson('/api/sway/url'));
  assert.equal(msg, `${BACKEND_UNREACHABLE} (Bad Gateway)`, msg);
  assert.ok(!msg.includes('HTTP 502'), msg);
}

// An empty 502 body still explains itself.
{
  const msg = await withFetch(res('', 502), () => getJson('/api/vj/url'));
  assert.equal(msg, BACKEND_UNREACHABLE, msg);
}

// 503 is the backend answering about a hop it does not own — a different
// problem with a different fix, and it must not read as "backend is down".
{
  const msg = await withFetch(res('', 503), () => getJson('/api/x'));
  assert.equal(msg, UPSTREAM_UNAVAILABLE, msg);
  assert.notEqual(msg, BACKEND_UNREACHABLE);
}

// 504 is its own case.
{
  const msg = await withFetch(res('', 504), () => getJson('/api/x'));
  assert.equal(msg, GATEWAY_TIMEOUT, msg);
}

// A FastAPI `detail` is a real answer from a real route, so it wins outright —
// including on a 502 a router raised itself about an upstream call.
{
  const msg = await withFetch(
    res(JSON.stringify({ detail: 'The cockpit build is not staged.' }), 502),
    () => getJson('/api/sway/url'),
  );
  assert.equal(msg, 'The cockpit build is not staged.', msg);
}

// This app's own non-standard {error: "..."} bodies are still surfaced.
{
  const msg = await withFetch(res(JSON.stringify({ error: 'plugin scan failed' }), 500), () =>
    getJson('/api/plugin/list'),
  );
  assert.equal(msg, 'plugin scan failed', msg);
}

// `error` wins over a generic status, and an empty `error` does not.
{
  const msg = await withFetch(res(JSON.stringify({ error: '   ' }), 500), () => getJson('/api/x'));
  assert.ok(!msg.includes('   '), msg);
  assert.ok(msg.length > 0);
}

// The Vite HTML fallback is markup, not a message, and must never be pasted
// into the UI.
{
  const msg = await withFetch(res('<!doctype html><html><body>404</body></html>', 502), () =>
    getJson('/api/x'),
  );
  assert.equal(msg, BACKEND_UNREACHABLE, msg);
  assert.ok(!msg.includes('<'), msg);
}

// A 4xx with a plain-text body keeps the body: it is the server's own words.
{
  const msg = await withFetch(res('entry not found', 404), () => getJson('/api/x'));
  assert.equal(msg, 'entry not found', msg);
}

// postJson shares the same path.
{
  const msg = await withFetch(res('Bad Gateway', 502), () => postJson('/api/x', { a: 1 }));
  assert.equal(msg, `${BACKEND_UNREACHABLE} (Bad Gateway)`, msg);
}

// Reading the body twice would throw "body already read"; the helper clones.
{
  const msg = await withFetch(res(JSON.stringify({ error: 'once' }), 500), () => getJson('/api/x'));
  assert.equal(msg, 'once', msg);
}

console.log('apiJson tests passed');
