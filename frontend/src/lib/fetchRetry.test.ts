// Run with: npx tsx src/lib/fetchRetry.test.ts
//
// The reported symptom: dropping a library entry on the timeline printed
// "Drop decode failed: HTTP 404" (WaveformEditor's drop handler logs
// `err.message`). The status is not the answer — the backend's 404 now says
// WHY there is no audio: no file in the entry, none in any media root, and a
// remote copy that refused. These helpers threw that away.
import assert from 'node:assert/strict';

const DETAIL =
  "Audio for entry 'c27de18c': no local file in any media root and the remote copy " +
  'is not accessible (the host answered HTTP 403).';

let responses: Response[] = [];
globalThis.fetch = (async () => {
  const next = responses.shift();
  if (!next) throw new Error('no response queued');
  return next;
}) as typeof fetch;

const { fetchBlobWithRetry, fetchMidiBytesWithRetry } = await import('./fetchRetry.ts');
const { ApiError } = await import('./apiJson.ts');

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
};

// --- the server's detail is what the user reads ------------------------------
{
  // One per attempt: the helper retries, and every attempt gets the same 404.
  responses = [0, 1, 2, 3].map(() => json({ detail: DETAIL }, 404));
  const err = await failureOf(() => fetchBlobWithRetry('/api/library/audio/c27de18c', { retries: 3, backoffMs: 0 }));

  assert.ok(err instanceof Error, 'a failure is still an Error');
  assert.equal((err as Error).message, DETAIL, 'the message IS the detail, not "HTTP 404"');
  assert.ok(!(err as Error).message.includes('HTTP 404'), (err as Error).message);
  // `Drop decode failed: ${err.message}` — what WaveformEditor prints.
  assert.ok(`Drop decode failed: ${(err as Error).message}`.includes('no local file in any media root'));
  assert.ok(err instanceof ApiError && err.status === 404, 'the status is carried alongside');
}

// --- a route that explains nothing reads exactly as it did before ------------
{
  responses = [0, 1].map(() => new Response('', { status: 404 }));
  const err = await failureOf(() => fetchBlobWithRetry('/api/library/audio/x', { retries: 1, backoffMs: 0 }));
  assert.equal((err as Error).message, 'HTTP 404');
}

// --- the MIDI helper gets the same treatment ---------------------------------
{
  responses = [json({ detail: 'no MIDI for this entry yet' }, 404)];
  const err = await failureOf(() => fetchMidiBytesWithRetry('/api/library/x/midi', { retries: 0, backoffMs: 0 }));
  assert.equal((err as Error).message, 'no MIDI for this entry yet');
}

// --- a success is untouched --------------------------------------------------
{
  responses = [new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })];
  const blob = await fetchBlobWithRetry('/api/library/audio/ok', { retries: 0 });
  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'audio/mpeg');
}

console.log('fetchRetry.test.ts: all assertions passed');
