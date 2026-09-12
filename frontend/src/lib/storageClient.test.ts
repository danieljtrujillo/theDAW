/**
 * What Settings → Models actually prints when a storage call fails.
 *
 * ModelsSection renders `Model status failed: {error.message}`, so the message
 * thrown by storageClient's `json()` wrapper IS the user-visible string. This
 * suite drives the real `fetchModelStatus` against a stubbed `fetch` and
 * asserts on that whole rendered line — the bug report's "Model status failed:
 * HTTP 502" (gantasmo/theDAW#144) is pinned here as a string that can never
 * come back.
 *
 * Run: `npx tsx src/lib/storageClient.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { PROXY_ERROR_HEADER, PROXY_BACKEND_UNREACHABLE } from './httpError';
import { fetchModelStatus } from './storageClient';

const realFetch = globalThis.fetch;
let lastUrl = '';

/** Answer every request with `response`, recording the URL asked for. */
function serve(response: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastUrl = typeof input === 'string' ? input : String(input);
    return response();
  }) as typeof fetch;
}

/** The line the Settings panel renders for a failed model-status call. */
async function renderedError(): Promise<string> {
  try {
    await fetchModelStatus();
  } catch (e) {
    return `Model status failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return assert.fail('fetchModelStatus resolved on a failing response');
}

// ── the reported failure: the packaged proxy could not reach the backend ────
serve(() =>
  new Response('theDAW backend unreachable at http://127.0.0.1:8600: net::ERR_CONNECTION_REFUSED', {
    status: 502,
    headers: { [PROXY_ERROR_HEADER]: PROXY_BACKEND_UNREACHABLE },
  }),
);
const proxied = await renderedError();
assert.equal(lastUrl, '/api/storage/model-status');
assert.ok(proxied !== 'Model status failed: HTTP 502', 'the exact string from the bug report is gone');
assert.ok(/did not answer/.test(proxied), `names the failing hop: ${proxied}`);
assert.ok(/restart theDAW/i.test(proxied), 'and says what to do about it');
assert.ok(/ERR_CONNECTION_REFUSED/.test(proxied), 'keeping the technical reason for a bug report');
assert.ok(!/huggingface/i.test(proxied), 'nothing upstream is blamed for a local loopback failure');

// ── a gateway with nothing to say at all ───────────────────────────────────
serve(() => new Response('', { status: 502 }));
assert.ok(/did not answer/.test(await renderedError()));
serve(() => new Response('', { status: 504 }));
assert.ok(/timed out/.test(await renderedError()));

// ── the backend answered: its own words survive verbatim ───────────────────
serve(() => new Response('{"detail":"No checkpoint found there."}', { status: 400 }));
assert.equal(await renderedError(), 'Model status failed: No checkpoint found there.');

// ── nothing to go on: the bare status is still the last resort ─────────────
serve(() => new Response('', { status: 500 }));
assert.equal(await renderedError(), 'Model status failed: HTTP 500');

// ── a good answer is parsed, not shaped ────────────────────────────────────
serve(() =>
  new Response(JSON.stringify({ providers: [], usable_generation: true, local_only: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }),
);
const ok = await fetchModelStatus();
assert.equal(ok.usable_generation, true);
assert.deepEqual(ok.providers, []);

globalThis.fetch = realFetch;
console.log('storageClient tests passed');
