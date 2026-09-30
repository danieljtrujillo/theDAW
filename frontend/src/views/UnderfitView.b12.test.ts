/**
 * Batch-12 T16 fixes for UnderfitView — pure helpers behind:
 *
 *   1. isUnderfitPollActive — the reachability ping (UnderfitView.tsx:98-101)
 *      ran on a bare `setInterval` every 3s forever, even while the Underfit
 *      tab was hidden behind another center tab or the window was
 *      backgrounded (FE-016).
 *   2. describeUnderfitUpdateStatus — a human-readable line for the new
 *      "check for updates" control, backed by the existing (previously
 *      uncalled) `GET /api/underfit/update-status` / `POST /api/underfit/update`
 *      endpoints (backend/modules/underfit/router.py:203,209).
 *   3. parseUnderfitUpdateResponse (audit follow-up, MAJOR) — a failed
 *      `POST /api/underfit/update` is a FastAPI `HTTPException(status_code,
 *      detail=result)`, so the real `{ok, reason, message}` body arrives
 *      WRAPPED as `{"detail": {...}}` at 409/500 — not at the top level the
 *      old code read, which is why the UI always showed a generic
 *      "HTTP 409"/"HTTP 500" instead of the backend's actual reason
 *      (router.py ~212, updater.py `apply()`).
 *   4. underfitCheckButtonLabel (audit follow-up, MINOR) — the check button
 *      used to say "Up to date" before any check ever ran AND after a failed
 *      check, because `update_available` is falsy in both cases. Now three
 *      distinct states.
 *   5. parseUnderfitCheckResponse (2nd audit follow-up, MAJOR) — `checkForUpdate`
 *      only ever set state inside `if (res.ok)`, so a non-2xx GET
 *      /api/underfit/update-status response (e.g. the Vite dev proxy's own
 *      error when the backend is down) left whatever status was already
 *      showing — including the initial "Up to date" default — instead of
 *      surfacing the failure.
 *
 * Run: `npx tsx src/views/UnderfitView.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  describeUnderfitUpdateStatus,
  isUnderfitPollActive,
  parseUnderfitCheckResponse,
  parseUnderfitUpdateResponse,
  underfitCheckButtonLabel,
} from './UnderfitView.tsx';

/* ------------------------------ isUnderfitPollActive ------------------------------ */
{
  assert.equal(isUnderfitPollActive(true, true), true, 'tab visible + document visible: active');
  assert.equal(isUnderfitPollActive(false, true), false, 'another center tab is shown: paused');
  assert.equal(isUnderfitPollActive(true, false), false, 'the document is backgrounded: paused');
  assert.equal(isUnderfitPollActive(false, false), false, 'both hidden: paused');
}

/* ------------------------------ describeUnderfitUpdateStatus ------------------------------ */
{
  assert.equal(
    describeUnderfitUpdateStatus(null),
    'Not checked yet.',
    'no status fetched yet',
  );
  assert.equal(
    describeUnderfitUpdateStatus({
      remote: 'https://github.com/dada-bots/underfit.git',
      branch: 'main',
      synced: 'abc1234',
      upstream: 'abc1234',
      update_available: false,
      checked_at: '2026-09-19T00:00:00',
      error: null,
    }),
    'Up to date (abc1234).',
    'synced === upstream reports up to date',
  );
  assert.equal(
    describeUnderfitUpdateStatus({
      remote: 'https://github.com/dada-bots/underfit.git',
      branch: 'main',
      synced: 'abc1234',
      upstream: 'def5678',
      update_available: true,
      checked_at: '2026-09-19T00:00:00',
      error: null,
    }),
    'Update available (abc1234 -> def5678).',
    'update available names both commits',
  );
  assert.equal(
    describeUnderfitUpdateStatus({
      remote: 'https://github.com/dada-bots/underfit.git',
      branch: 'main',
      synced: '',
      upstream: '',
      update_available: false,
      checked_at: '2026-09-19T00:00:00',
      error: 'could not reach upstream',
    }),
    'Could not check: could not reach upstream',
    'a fetch error is surfaced verbatim',
  );
}

/* ------------------------------ parseUnderfitUpdateResponse ------------------------------ */
{
  // A success (200) body is the result directly — no `detail` wrapper.
  assert.deepEqual(
    parseUnderfitUpdateResponse(true, 200, { ok: true, message: 'Underfit updated from upstream.', output: 'log...' }),
    { ok: true, message: 'Underfit updated from upstream.', output: 'log...' },
    '200: read top-level fields',
  );

  // 409 dirty_tree — FastAPI HTTPException wraps `detail=result` as {"detail": {...}}.
  assert.deepEqual(
    parseUnderfitUpdateResponse(false, 409, {
      detail: { ok: false, reason: 'dirty_tree', message: 'theDAW has uncommitted changes.' },
    }),
    { ok: false, reason: 'dirty_tree', message: 'theDAW has uncommitted changes.' },
    '409: unwraps body.detail (THE BUG — used to read top-level fields and show a generic message)',
  );

  // 500 pull_failed — same wrapper shape, different reason/output.
  assert.deepEqual(
    parseUnderfitUpdateResponse(false, 500, {
      detail: { ok: false, reason: 'pull_failed', message: 'Update failed (usually a merge conflict).', output: 'git says...' },
    }),
    { ok: false, reason: 'pull_failed', message: 'Update failed (usually a merge conflict).', output: 'git says...' },
    '500: unwraps body.detail',
  );

  // A non-JSON / unparseable body still degrades to a sane, honest fallback.
  assert.deepEqual(
    parseUnderfitUpdateResponse(false, 500, null),
    { ok: false, message: 'HTTP 500' },
    'unparseable body: falls back to an HTTP-status message',
  );
  assert.deepEqual(
    parseUnderfitUpdateResponse(false, 409, { detail: 'not an object' }),
    { ok: false, message: 'HTTP 409' },
    'a non-object detail also falls back',
  );
}

/* ------------------------------ underfitCheckButtonLabel ------------------------------ */
{
  assert.equal(underfitCheckButtonLabel(null), 'Check updates', 'no status fetched yet');
  assert.equal(
    underfitCheckButtonLabel({
      remote: '', branch: '', synced: '', upstream: '', update_available: false,
      checked_at: '', error: 'could not reach upstream',
    }),
    'Check failed',
    'a failed check is distinct from "up to date" (THE BUG)',
  );
  assert.equal(
    underfitCheckButtonLabel({
      remote: '', branch: '', synced: 'abc', upstream: 'abc', update_available: false,
      checked_at: '', error: null,
    }),
    'Up to date',
    'a successful check with nothing new',
  );
  assert.equal(
    underfitCheckButtonLabel({
      remote: '', branch: '', synced: 'abc', upstream: 'def', update_available: true,
      checked_at: '', error: null,
    }),
    'Update available',
    'a successful check with an update',
  );
}

/* ------------------------------ parseUnderfitCheckResponse (2nd audit follow-up) ------------------------------ */
{
  const okBody = {
    remote: 'https://github.com/dada-bots/underfit.git', branch: 'main',
    synced: 'abc1234', upstream: 'abc1234', update_available: false,
    checked_at: '2026-09-19T00:00:00', error: null,
  };
  assert.deepEqual(parseUnderfitCheckResponse(true, 200, okBody), okBody, '200: read the body as-is');

  // THE BUG: the old code did nothing on a non-2xx response, silently
  // leaving whatever status (even the untouched "Up to date" default) was
  // already showing.
  assert.deepEqual(
    parseUnderfitCheckResponse(false, 502, { detail: 'Bad Gateway' }),
    { remote: '', branch: '', synced: '', upstream: '', update_available: false, checked_at: '', error: 'HTTP 502' },
    '502 (e.g. the dev proxy when the backend is down): an explicit error status naming the HTTP code',
  );
  assert.deepEqual(
    parseUnderfitCheckResponse(false, 500, null),
    { remote: '', branch: '', synced: '', upstream: '', update_available: false, checked_at: '', error: 'HTTP 500' },
    '500 with an unparseable body: same explicit error status',
  );
  // A malformed 200 (body missing/not an object) also degrades honestly
  // rather than pretending it was a real status.
  assert.deepEqual(
    parseUnderfitCheckResponse(true, 200, null),
    { remote: '', branch: '', synced: '', upstream: '', update_available: false, checked_at: '', error: 'HTTP 200' },
    '200 with no parseable body: falls back to an HTTP-status error rather than a fake "up to date"',
  );
}

console.log('UnderfitView.b12.test.ts: all assertions passed');
