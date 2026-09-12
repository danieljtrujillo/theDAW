/**
 * Which hop the Hugging Face auth client blames, and what it says about it.
 *
 * Two failures this pins (gantasmo/theDAW#144):
 *   1. a backend outage used to come back from `fetchHfStatus` as a clean
 *      "not signed in", so a dead backend and a missing token were the same
 *      screen. It now reports `logged_in: null` plus an `error`.
 *   2. 502 meant "our backend never answered" to the frontend and "the Hub
 *      answered badly" to the backend — the same status carrying opposite
 *      claims. The backend now answers 503 + `x-thedaw-hop: huggingface` for
 *      the hop it does not own, and the messages below must never swap.
 *
 * Run: `npx tsx src/lib/hfAuthClient.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { HOP_HEADER, HOP_HUGGINGFACE, PROXY_ERROR_HEADER, PROXY_BACKEND_UNREACHABLE } from './httpError';
import { HfAuthError, fetchHfStatus, hfLogin } from './hfAuthClient';

const realFetch = globalThis.fetch;

/** Answer every request with what `response` returns (or throw what it throws). */
function serve(response: () => Response): void {
  globalThis.fetch = (async () => response()) as typeof fetch;
}

/** The HfAuthError a sign-in attempt produced. Fails the suite if it resolved. */
async function loginError(): Promise<HfAuthError> {
  try {
    await hfLogin('hf_token');
  } catch (e) {
    assert.ok(e instanceof HfAuthError, `expected HfAuthError, got ${String(e)}`);
    return e;
  }
  return assert.fail('hfLogin resolved on a failing response');
}

// ── status: a real answer passes straight through ───────────────────────────
serve(() =>
  new Response(JSON.stringify({ logged_in: true, username: 'someone', token_source: 'stored' }), { status: 200 }),
);
const signedIn = await fetchHfStatus();
assert.deepEqual(
  { logged_in: signedIn.logged_in, username: signedIn.username, available: signedIn.available, error: signedIn.error },
  { logged_in: true, username: 'someone', available: true, error: null },
);

// The Hub-unknown third state is still preserved end to end.
serve(() => new Response(JSON.stringify({ logged_in: null, token_source: 'env', checking: true }), { status: 200 }));
const unknown = await fetchHfStatus();
assert.equal(unknown.logged_in, null);
assert.equal(unknown.checking, true);
assert.equal(unknown.error, null, 'the CALL worked; only the Hub verdict is unknown');

// ── status: the module is off — a real "no", and the one the UI acts on ─────
serve(() => new Response('{"detail":"Not Found"}', { status: 404 }));
const off = await fetchHfStatus();
assert.equal(off.available, false);
assert.equal(off.logged_in, false);

// ── status: an unreachable backend is NOT a signed-out user ─────────────────
serve(() =>
  new Response('theDAW backend unreachable at http://127.0.0.1:8600: net::ERR_CONNECTION_REFUSED', {
    status: 502,
    headers: { [PROXY_ERROR_HEADER]: PROXY_BACKEND_UNREACHABLE },
  }),
);
const down = await fetchHfStatus();
assert.equal(down.logged_in, null, 'never false — we did not measure a signed-out user');
assert.equal(down.available, true, 'the module is presumed present; we just could not ask');
assert.equal(down.error?.kind, 'backend-down');
assert.ok(/did not answer/.test(down.error?.message ?? ''), down.error?.message);
assert.ok(!/huggingface/i.test(down.error?.message ?? ''), 'the Hub is not blamed for a local failure');

// fetch itself rejecting (backend still binding its port) reads the same way.
globalThis.fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;
const thrown = await fetchHfStatus();
assert.equal(thrown.logged_in, null);
assert.equal(thrown.error?.kind, 'backend-down');

// A 503 while ASKING for status is the Hub hop, not ours.
serve(() =>
  new Response('{"detail":"Could not reach huggingface.co: timed out"}', {
    status: 503,
    headers: { [HOP_HEADER]: HOP_HUGGINGFACE },
  }),
);
const hubDown = await fetchHfStatus();
assert.equal(hubDown.logged_in, null);
assert.equal(hubDown.error?.kind, 'unreachable');

// ── login: the Hub's own verdicts ───────────────────────────────────────────
serve(() => new Response('{"detail":"Invalid Hugging Face token"}', { status: 401 }));
assert.equal((await loginError()).kind, 'rejected');

serve(() => new Response('{"detail":"Not Found"}', { status: 404 }));
assert.equal((await loginError()).kind, 'disabled');

serve(() => new Response(JSON.stringify({ logged_in: true, username: 'someone' }), { status: 200 }));
assert.equal(await hfLogin('hf_token'), 'someone');

// ── login: 503 + the hop marker = the Hub hop failed, and says so ───────────
serve(() =>
  new Response('{"detail":"Could not reach huggingface.co: [Errno 11001] getaddrinfo failed"}', {
    status: 503,
    headers: { [HOP_HEADER]: HOP_HUGGINGFACE },
  }),
);
const hubUnreachable = await loginError();
assert.equal(hubUnreachable.kind, 'unreachable');
assert.match(hubUnreachable.message, /huggingface\.co/, 'the backend detail names the right hop');

// The backend's OTHER upstream failure — the Hub answered, badly — is the same
// hop and the same status, with its own words.
serve(() =>
  new Response('{"detail":"huggingface.co returned HTTP 500"}', {
    status: 503,
    headers: { [HOP_HEADER]: HOP_HUGGINGFACE },
  }),
);
const hubErrored = await loginError();
assert.equal(hubErrored.kind, 'unreachable');
assert.equal(hubErrored.message, 'huggingface.co returned HTTP 500');

// Status alone is enough if a deployment strips the marker header.
serve(() => new Response('', { status: 503 }));
assert.equal((await loginError()).kind, 'unreachable');

// ── login: 502 = a gateway, so the Hub was never contacted ─────────────────
serve(() =>
  new Response('theDAW backend unreachable at http://127.0.0.1:8600: net::ERR_CONNECTION_REFUSED', {
    status: 502,
    headers: { [PROXY_ERROR_HEADER]: PROXY_BACKEND_UNREACHABLE },
  }),
);
const gateway = await loginError();
assert.equal(gateway.kind, 'backend-down');
assert.ok(/did not answer/.test(gateway.message), gateway.message);
assert.ok(!/huggingface/i.test(gateway.message), 'this is the inversion that sent a user to debug their internet');

serve(() => new Response('', { status: 502 }));
assert.equal((await loginError()).kind, 'backend-down');
serve(() => new Response('', { status: 504 }));
assert.equal((await loginError()).kind, 'backend-down');

// ── login: anything else still says something ──────────────────────────────
serve(() => new Response('{"detail":"Token validated but could not be stored: disk full"}', { status: 500 }));
const stored = await loginError();
assert.equal(stored.kind, 'unknown');
assert.equal(stored.message, 'Token validated but could not be stored: disk full');

serve(() => new Response('', { status: 418 }));
assert.equal((await loginError()).message, 'Sign-in failed (HTTP 418).');

globalThis.fetch = realFetch;
console.log('hfAuthClient tests passed');
