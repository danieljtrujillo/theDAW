/**
 * postRenderLineage (F23T-2): the one function between a finished render and
 * the lineage POST endpoint. Every seam — fetch, sleep, retry/backoff counts —
 * is injectable, so this suite drives the real retry/backoff logic without
 * touching the network or a real timer.
 *
 * Run: npx tsx src/lib/lineage/lineageClient.test.ts
 */
import assert from 'node:assert/strict';

import { LINEAGE_RENDERS_URL, postRenderLineage } from './lineageClient.ts';
import type { LineageRenderRecord } from './lineageTypes.ts';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const record = (over: Partial<LineageRenderRecord> = {}): LineageRenderRecord => ({
  render_id: 'r1',
  project_id: 'p1',
  project_name: 'My Project',
  created_at: '2026-09-18T00:00:00.000Z',
  output: { library_entry_id: 'e1', path: '/out.wav', kind: 'full', start_sec: null, end_sec: null },
  contributions: [],
  ...over,
});

interface FetchCall { url: string; init?: RequestInit }

/** A fake fetch that replays canned statuses in order; 'throw' rejects instead. */
const fakeFetch = (script: (number | 'throw')[]) => {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step === 'throw') throw new Error('network down');
    return { ok: step >= 200 && step < 300, status: step } as unknown as Response;
  };
  return { impl, calls };
};

/** A sleep stand-in that resolves immediately and records the ms it was given. */
const recordingSleep = () => {
  const waits: number[] = [];
  const impl = (ms: number): Promise<void> => { waits.push(ms); return Promise.resolve(); };
  return { impl, waits };
};

/* ── cases ────────────────────────────────────────────────────────────────── */

async function aSuccessfulPostSendsTheRecordToTheContractUrl(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([200]);
  const rec = record();

  const result = await postRenderLineage(rec, { fetchImpl });

  assert.deepEqual(result, { ok: true, attempts: 1 });
  assert.equal(calls.length, 1, 'exactly one request for a first-try success');
  assert.equal(calls[0].url, LINEAGE_RENDERS_URL);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string> | undefined)?.['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), rec, 'the body is the record, verbatim');
}

async function aServerErrorIsRetriedThenSucceeds(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([500, 500, 200]);
  const { impl: sleepImpl } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.deepEqual(result, { ok: true, attempts: 3 });
  assert.equal(calls.length, 3);
}

async function retriesAreExhaustedAndTheReasonSurvives(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([503]);
  const { impl: sleepImpl } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4, 'retries defaults to 3, so 4 attempts total');
  if (!result.ok) assert.match(result.reason, /503/, 'the last HTTP status survives into the reason');
  assert.equal(calls.length, 4);
}

async function aClientErrorIsNotRetried(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([400]);
  const { impl: sleepImpl } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.deepEqual(result, { ok: false, attempts: 1, reason: 'HTTP 400' });
  assert.equal(calls.length, 1, 'a bad body cannot be fixed by retrying it');
}

async function tooManyRequestsIsRetried(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([429, 200]);
  const { impl: sleepImpl } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.deepEqual(result, { ok: true, attempts: 2 });
  assert.equal(calls.length, 2);
}

async function aThrownFetchIsRetriedNotRethrown(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch(['throw', 'throw', 200]);
  const { impl: sleepImpl } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.deepEqual(result, { ok: true, attempts: 3 });
  assert.equal(calls.length, 3);
}

async function anEmptyRenderIdNeverReachesTheNetwork(): Promise<void> {
  const { impl: fetchImpl, calls } = fakeFetch([200]);

  const result = await postRenderLineage(record({ render_id: '' }), { fetchImpl });

  assert.deepEqual(result, { ok: false, attempts: 0, reason: 'render_id is required' });
  assert.equal(calls.length, 0, 'fetch is never called');
}

async function backoffGrowsWithEachAttempt(): Promise<void> {
  const { impl: fetchImpl } = fakeFetch([503, 503, 503, 503]);
  const { impl: sleepImpl, waits } = recordingSleep();

  const result = await postRenderLineage(record(), { fetchImpl, sleepImpl });

  assert.equal(result.ok, false);
  assert.deepEqual(waits, [400, 800, 1200], 'backoffMs * (attempt + 1), one sleep per retried attempt');
}

async function main(): Promise<void> {
  await aSuccessfulPostSendsTheRecordToTheContractUrl();
  await aServerErrorIsRetriedThenSucceeds();
  await retriesAreExhaustedAndTheReasonSurvives();
  await aClientErrorIsNotRetried();
  await tooManyRequestsIsRetried();
  await aThrownFetchIsRetriedNotRethrown();
  await anEmptyRenderIdNeverReachesTheNetwork();
  await backoffGrowsWithEachAttempt();
  console.log('lineageClient: ok');
}

await main();
