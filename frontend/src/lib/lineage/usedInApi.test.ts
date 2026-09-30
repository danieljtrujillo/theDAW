/**
 * fetchUsedIn / fetchSources / createStaleGuard (F23U-1).
 *
 * Pins: a 404 (or a blank entry id, which never reaches fetch) reads as the
 * module's own empty payload with `ok: true`, never as an error; only a
 * genuine non-ok status or a thrown network error produces `ok: false`.
 *
 * Run: `npx tsx src/lib/lineage/usedInApi.test.ts`
 */
import assert from 'node:assert/strict';
import { fetchUsedIn, fetchSources, createStaleGuard, USED_IN_ERROR, SOURCES_ERROR } from './usedInApi.ts';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);
const calls: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  return handler(url, init);
}) as typeof fetch;

// ── used-in: ok body is returned and arrays survive ─────────────────────────
{
  calls.length = 0;
  const projects = [{ project_id: 'p1', project_name: 'Song A', renders: 3, last_render_at: '2026-01-01T00:00:00Z' }];
  const renders = [
    {
      render_id: 'r1',
      created_at: '2026-01-01T00:00:00Z',
      kind: 'full',
      project_id: 'p1',
      project_name: 'Song A',
      output_entry_id: 'e1',
      output_path: '/x.wav',
    },
  ];
  handler = async () => jsonResponse({ entry_id: 'e1', projects, renders });

  const result = await fetchUsedIn('e1');

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.entry_id, 'e1');
    assert.deepEqual(result.data.projects, projects);
    assert.deepEqual(result.data.renders, renders);
  }
  assert.equal(calls.length, 1, 'exactly one request went out');
  assert.equal(new URL(calls[0], 'http://local').pathname, '/api/lineage/used-in/e1');
}

// ── used-in: 404 reads as empty, not as an error ────────────────────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ detail: 'Not Found' }, 404);

  const result = await fetchUsedIn('e1');

  assert.equal(result.ok, true, '404 is not an error');
  if (result.ok) assert.deepEqual(result.data, { entry_id: 'e1', projects: [], renders: [] });
}

// ── used-in: 500 reads as an error with USED_IN_ERROR ───────────────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ detail: 'boom' }, 500);

  const result = await fetchUsedIn('e1');

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, USED_IN_ERROR);
}

// ── used-in: a network throw reads as an error ──────────────────────────────
{
  calls.length = 0;
  handler = async () => {
    throw new Error('network down');
  };

  const result = await fetchUsedIn('e1');

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, USED_IN_ERROR);
}

// ── used-in: a garbage body normalises projects/renders to [] ───────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ entry_id: 'e1', projects: 'nope', renders: 42 });

  const result = await fetchUsedIn('e1');

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.projects, []);
    assert.deepEqual(result.data.renders, []);
  }
}

// ── used-in: a blank entry id makes no request ──────────────────────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ entry_id: 'should-not-be-called', projects: [], renders: [] });

  const result = await fetchUsedIn('   ');

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { entry_id: '   ', projects: [], renders: [] });
  assert.equal(calls.length, 0, 'a blank id never reaches fetch');
}

// ── sources: 404 reads as { render: null } with ok true ─────────────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ detail: 'Not Found' }, 404);

  const result = await fetchSources('e1');

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { entry_id: 'e1', render: null });
}

// ── sources: a non-object render normalises to null ─────────────────────────
{
  calls.length = 0;
  handler = async () => jsonResponse({ entry_id: 'e1', render: 'not-an-object' });

  const result = await fetchSources('e1');

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.render, null);
}

// ── sources: a non-ok status is an error with SOURCES_ERROR (same rules as
//    used-in — not one of the named cases, but stated directly in the ticket) ──
{
  calls.length = 0;
  handler = async () => jsonResponse({ detail: 'boom' }, 500);

  const result = await fetchSources('e1');

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, SOURCES_ERROR);
}

// ── staleGuard: only the newest token is current ────────────────────────────
{
  const guard = createStaleGuard();
  const t1 = guard.begin();
  const t2 = guard.begin();

  assert.equal(guard.isCurrent(t2), true);
  assert.equal(guard.isCurrent(t1), false, 'an earlier token goes stale once a newer one begins');

  const t3 = guard.begin();
  assert.equal(guard.isCurrent(t3), true);
  assert.equal(guard.isCurrent(t2), false);
}

console.log('usedInApi: ok');
