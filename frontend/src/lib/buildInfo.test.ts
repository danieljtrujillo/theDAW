// Run with: npx tsx src/lib/buildInfo.test.ts
//
// The Update dialog shows the frontend bundle's SHA next to the backend's and
// warns when they differ, because the backend serves whatever frontend/dist
// exists and a stale bundle hides fixes that are already in source.
import assert from 'node:assert/strict';
import {
  formatBuildTime,
  formatSha,
  frontendBuild,
  normalizeSha,
  parseBackendBuild,
  staleBundle,
} from './buildInfo.ts';

// Stale only when both are known and differ.
assert.equal(staleBundle('abc1234', 'abc1234'), false);
assert.equal(staleBundle('abc1234', 'def5678'), true);
assert.equal(staleBundle(null, 'def5678'), false);
assert.equal(staleBundle('abc1234', null), false);
assert.equal(staleBundle(null, null), false);
assert.equal(staleBundle('unknown', 'def5678'), false, 'the build fallback is not a SHA');
assert.equal(staleBundle('abc1234', ''), false);

// Different short lengths (or a full SHA override) of the same commit match.
assert.equal(staleBundle('abc1234', 'abc12345'), false);
assert.equal(staleBundle('ABC1234', 'abc1234def0123456789'), false);
assert.equal(staleBundle('abc1235', 'abc12345'), true);

// normalizeSha rejects non-strings, blanks and "unknown".
assert.equal(normalizeSha(undefined), null);
assert.equal(normalizeSha(42), null);
assert.equal(normalizeSha('  '), null);
assert.equal(normalizeSha('Unknown'), null);
assert.equal(normalizeSha(' 721ea5b '), '721ea5b');

// Backend payload parsing is defensive.
assert.deepEqual(parseBackendBuild({ git_sha: '721ea5b', started_at: '2026-09-18T12:34:56.789Z' }), {
  sha: '721ea5b',
  time: '2026-09-18T12:34:56.789Z',
});
assert.deepEqual(parseBackendBuild({ git_sha: null, started_at: 'not a date' }), { sha: null, time: null });
assert.deepEqual(parseBackendBuild(null), { sha: null, time: null });
assert.deepEqual(parseBackendBuild('oops'), { sha: null, time: null });

// Formatting.
assert.equal(formatBuildTime('2026-09-18T12:34:56.789Z'), '2026-09-18 12:34 UTC');
assert.equal(formatBuildTime('2026-09-18T14:34:56+02:00'), '2026-09-18 12:34 UTC');
assert.equal(formatBuildTime(null), '');
assert.equal(formatBuildTime('garbage'), '');
assert.equal(formatSha(null), 'unknown');
assert.equal(formatSha('721ea5b'), '721ea5b');

// Outside a Vite build the defines do not exist; reading them must not throw.
{
  const stamp = frontendBuild();
  if (typeof __APP_BUILD_SHA__ === 'undefined') {
    assert.equal(stamp.sha, null);
  }
  if (typeof __APP_BUILD_TIME__ === 'undefined') {
    assert.equal(stamp.time, null);
  }
}

console.log('buildInfo tests passed');
