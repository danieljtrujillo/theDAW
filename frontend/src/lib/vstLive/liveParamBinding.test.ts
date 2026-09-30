/**
 * vstLive/liveParamBinding — resolving a (entryId, paramKey) pair to a live
 * plugin's parameter index is pure logic, so every case here uses fake
 * `LiveParamLookup` object literals rather than the real session registry or
 * live store: no socket, no zustand, no AudioContext anywhere in this file.
 *
 * Run: npx tsx src/lib/vstLive/liveParamBinding.test.ts
 */
import assert from 'node:assert/strict';

import {
  clampNormalized,
  LIVE_PARAM_TARGET_PREFIX,
  liveParamTargetId,
  parseLiveParamIndex,
  parseLiveParamTargetId,
  resolveLiveParam,
  type LiveParamLookup,
} from './liveParamBinding.ts';

/* ── parseLiveParamIndex accepts p0 and p137 and rejects mix, P3, p, p-1, p1x ── */
{
  assert.equal(parseLiveParamIndex('p0'), 0, 'p0 is index 0');
  assert.equal(parseLiveParamIndex('p137'), 137, 'multi-digit index');
  assert.equal(parseLiveParamIndex('mix'), null, 'a rack-effect key is not the p<index> convention');
  assert.equal(parseLiveParamIndex('P3'), null, 'the leading p is case-sensitive');
  assert.equal(parseLiveParamIndex('p'), null, 'no digits at all');
  assert.equal(parseLiveParamIndex('p-1'), null, 'a sign is not a digit');
  assert.equal(parseLiveParamIndex('p1x'), null, 'trailing non-digit characters');
}

/* ── target ids round-trip through liveParamTargetId / parseLiveParamTargetId ── */
{
  assert.equal(LIVE_PARAM_TARGET_PREFIX, 'vstlive');

  const id = liveParamTargetId('entry-1', 'p12');
  assert.equal(id, 'vstlive:entry-1:p12');
  assert.deepEqual(parseLiveParamTargetId(id), { entryId: 'entry-1', paramKey: 'p12' });

  // The codec round-trips whatever paramKey it is given -- whether that key
  // is a live p<index> key is parseLiveParamIndex's question, not this one's.
  const mixId = liveParamTargetId('entry-2', 'mix');
  assert.deepEqual(parseLiveParamTargetId(mixId), { entryId: 'entry-2', paramKey: 'mix' });
}

/* ── parseLiveParamTargetId rejects a foreign prefix and a malformed id ─────── */
{
  assert.equal(parseLiveParamTargetId('rack:entry-1:p0'), null, 'a foreign prefix is not this convention');
  assert.equal(parseLiveParamTargetId('vstlive:entry-1'), null, 'missing the paramKey segment');
  assert.equal(
    parseLiveParamTargetId('vstlive:entry-1:p0:extra'),
    null,
    'an entryId containing a colon is not supported -- too many parts, return null rather than guessing',
  );
  assert.equal(parseLiveParamTargetId('vstlive'), null, 'just the prefix, no separators at all');
  assert.equal(parseLiveParamTargetId(''), null, 'empty string');
}

/* ── resolveLiveParam returns the index for a live session ──────────────────── */
{
  const lookup: LiveParamLookup = {
    getSession: (entryId) => (entryId === 'e1' ? { client: { setParam: () => {} } } : undefined),
    statusOf: (entryId) => ({ status: entryId === 'e1' ? 'live' : 'off' }),
  };

  assert.deepEqual(resolveLiveParam('e1', 'p3', lookup), { entryId: 'e1', paramKey: 'p3', index: 3 });
}

/* ── resolveLiveParam returns null when the status is starting, error, unavailable or off ── */
{
  const makeLookup = (status: string): LiveParamLookup => ({
    getSession: () => ({ client: { setParam: () => {} } }),
    statusOf: () => ({ status }),
  });

  for (const status of ['starting', 'error', 'unavailable', 'off']) {
    assert.equal(resolveLiveParam('e1', 'p0', makeLookup(status)), null, `status '${status}' is not live`);
  }
}

/* ── resolveLiveParam returns null when there is no session ─────────────────── */
{
  const lookup: LiveParamLookup = {
    getSession: () => undefined,
    // Status alone must not be enough -- a session is required too.
    statusOf: () => ({ status: 'live' }),
  };
  assert.equal(resolveLiveParam('ghost', 'p0', lookup), null, 'no session for the entry at all');
}

/* ── resolveLiveParam returns null for a non p<index> paramKey (a rack effect key such as mix) ── */
{
  const lookup: LiveParamLookup = {
    getSession: () => ({ client: { setParam: () => {} } }),
    statusOf: () => ({ status: 'live' }),
  };
  assert.equal(resolveLiveParam('e1', 'mix', lookup), null, 'a rack-effect key never addresses a live plugin parameter');
}

/* ── clampNormalized clamps out-of-range values and throws RangeError on NaN ── */
{
  assert.equal(clampNormalized(0.5), 0.5, 'in-range values pass through');
  assert.equal(clampNormalized(-0.2), 0, 'clamps below 0');
  assert.equal(clampNormalized(1.5), 1, 'clamps above 1');
  assert.equal(clampNormalized(0), 0, 'lower bound is inclusive');
  assert.equal(clampNormalized(1), 1, 'upper bound is inclusive');

  const throwsRangeError = (fn: () => unknown, msg: string) =>
    assert.throws(fn, (e: unknown) => e instanceof RangeError && /finite number/.test(e.message), msg);

  throwsRangeError(() => clampNormalized(Number.NaN), 'NaN is not a finite number');
  throwsRangeError(() => clampNormalized(Number.POSITIVE_INFINITY), 'Infinity is not finite either');
  throwsRangeError(() => clampNormalized(Number.NEGATIVE_INFINITY), 'neither is -Infinity');
}

console.log('vstLive/liveParamBinding: ok');
