/**
 * The failed-Response → sentence helper, under plain node.
 *
 * Pins the failure that produced gantasmo/theDAW#144's "Model status failed:
 * HTTP 502": a gateway answers with a plain-text or empty body, so `r.json()`
 * throws and the old code fell all the way back to the bare status. Every case
 * below asserts on the string a USER would read.
 *
 * Covered: a FastAPI `detail` body, a validation-list detail, a plain-text
 * body, an empty body, an HTML error page, each of 502/503/504, and the
 * `x-thedaw-proxy-error` header the packaged proxy sets and nothing used to
 * read.
 *
 * Run: `npx tsx src/lib/httpError.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  BACKEND_UNREACHABLE,
  GATEWAY_TIMEOUT,
  HOP_HEADER,
  HOP_HUGGINGFACE,
  PROXY_ERROR_HEADER,
  PROXY_BACKEND_UNREACHABLE,
  UPSTREAM_UNAVAILABLE,
  describeHttpError,
  detailFromResponse,
  parseErrorBody,
} from './httpError';

const res = (body: string, status: number, headers?: Record<string, string>): Response =>
  new Response(body, { status, headers });

// ── parseErrorBody: what a body carries, and where it came from ─────────────
assert.deepEqual(parseErrorBody('{"detail":"No checkpoint found there."}'), {
  text: 'No checkpoint found there.',
  fromDetail: true,
});
assert.deepEqual(parseErrorBody('{"detail":[{"msg":"field required"},{"msg":"not a path"}]}'), {
  text: 'field required; not a path',
  fromDetail: true,
});
assert.deepEqual(parseErrorBody('theDAW backend unreachable at http://127.0.0.1:8600: connect ECONNREFUSED'), {
  text: 'theDAW backend unreachable at http://127.0.0.1:8600: connect ECONNREFUSED',
  fromDetail: false,
});
assert.deepEqual(parseErrorBody(''), { text: null, fromDetail: false });
assert.deepEqual(parseErrorBody('   \n  '), { text: null, fromDetail: false });
assert.deepEqual(parseErrorBody('{"error":"nope"}'), { text: null, fromDetail: false }, 'JSON with no detail says nothing');
assert.deepEqual(
  parseErrorBody('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'),
  { text: null, fromDetail: false },
  'an HTML error page is markup, not a message',
);
// Newlines collapse and long bodies are capped, so one stack trace cannot
// become the whole error line.
assert.equal(parseErrorBody('line one\n  line two').text, 'line one line two');
const long = parseErrorBody('x'.repeat(1000)).text ?? '';
assert.ok(long.length <= 300 && long.endsWith('…'), `capped, got ${long.length}`);

// ── the status the bug report showed: a 502 with nothing to say ─────────────
const bare502 = await describeHttpError(res('', 502));
assert.equal(bare502, BACKEND_UNREACHABLE);
assert.ok(!/HTTP 502/.test(`Model status failed: ${bare502}`), 'the user never sees a bare status again');
assert.ok(/backend/i.test(bare502) && !/huggingface/i.test(bare502), 'names our backend, blames nothing upstream');

assert.equal(await describeHttpError(res('', 503)), UPSTREAM_UNAVAILABLE);
assert.equal(await describeHttpError(res('', 504)), GATEWAY_TIMEOUT);
assert.notEqual(UPSTREAM_UNAVAILABLE, BACKEND_UNREACHABLE, '502 and 503 must never read the same');

// ── the packaged proxy: plain-text body + the header nothing used to read ───
const proxyBody = 'theDAW backend unreachable at http://127.0.0.1:8600: net::ERR_CONNECTION_REFUSED';
const proxied = await describeHttpError(
  res(proxyBody, 502, { [PROXY_ERROR_HEADER]: PROXY_BACKEND_UNREACHABLE }),
);
assert.ok(proxied.startsWith(BACKEND_UNREACHABLE), 'the actionable sentence leads');
assert.ok(proxied.includes(proxyBody), 'and the proxy text a bug report needs is kept');

// The header is evidence about the hop, so it wins even over a JSON detail.
const proxiedJson = await describeHttpError(
  res('{"detail":"whatever"}', 502, { [PROXY_ERROR_HEADER]: PROXY_BACKEND_UNREACHABLE }),
);
assert.ok(proxiedJson.startsWith(BACKEND_UNREACHABLE));

// ── a body that DID say something keeps its own words ───────────────────────
// The Vite dev proxy's 502 is JSON, and already actionable.
assert.equal(
  await describeHttpError(res('{"detail":"Backend unreachable — is the server running on port 8600?"}', 502)),
  'Backend unreachable — is the server running on port 8600?',
);
// A route of ours answering 502 about an upstream call is not relabelled.
assert.equal(
  await describeHttpError(res('{"detail":"RuntimeError: Cannot access gated repo"}', 502)),
  'RuntimeError: Cannot access gated repo',
);
// Plain text at a gateway status is kept, behind the sentence that acts on it.
const texty = await describeHttpError(res('upstream connect error', 503));
assert.equal(texty, `${UPSTREAM_UNAVAILABLE} (upstream connect error)`);

// ── non-gateway statuses: unchanged behaviour ───────────────────────────────
assert.equal(await describeHttpError(res('{"detail":"No registered checkpoint"}', 404)), 'No registered checkpoint');
assert.equal(await describeHttpError(res('', 404)), 'HTTP 404');
assert.equal(await describeHttpError(res('', 500)), 'HTTP 500');

// ── detailFromResponse: the body's own words, or nothing ────────────────────
assert.equal(
  await detailFromResponse(res('{"detail":"Could not reach huggingface.co: timeout"}', 503, { [HOP_HEADER]: HOP_HUGGINGFACE })),
  'Could not reach huggingface.co: timeout',
);
assert.equal(await detailFromResponse(res('', 503)), null);

console.log('httpError tests passed');
