/**
 * components/session/ccModFxRouteModel — the pure decision behind a Perform
 * rail 'fx' CcMod, exercised without a DOM, a chain handle or a store.
 *
 * Run: npx tsx src/components/session/ccModFxRouteModel.test.ts
 */
import assert from 'node:assert/strict';

import { ccModFxRoute } from './ccModFxRouteModel.ts';
import type { CcMod } from '../../state/performRouting.ts';

/** A live-plugin-shaped fx CcMod (opaque `p<index>` paramKey, identity
 *  0..1 range); individual tests override only what they need. */
const FX_MOD: CcMod = {
  id: 'mod-1',
  channel: 0,
  number: 21,
  isNote: false,
  trackIndex: 2,
  target: 'fx',
  deviceIndex: 3,
  paramKey: 'p7',
  min: 0,
  max: 1,
  label: '03 Reverb · Mix',
};

/* ── a fx CcMod yields the perform-<track>-<device> entry id ─────────────── */
{
  const route = ccModFxRoute(FX_MOD, 0.5);
  assert.ok(route, 'a valid fx CcMod resolves');
  assert.equal(route.entryId, 'perform-2-3');
  assert.equal(route.paramKey, 'p7');

  // A different track/device pair yields a different entry id.
  const other = ccModFxRoute({ ...FX_MOD, trackIndex: 0, deviceIndex: 1 }, 0.5);
  assert.ok(other);
  assert.equal(other.entryId, 'perform-0-1');
}

/* ── the scaled value uses min/max and the normalized value is the raw 0..1 ── */
{
  const ranged: CcMod = { ...FX_MOD, min: 20, max: 120 };
  const route = ccModFxRoute(ranged, 0.25);
  assert.ok(route);
  assert.equal(route.normalized, 0.25, 'normalized is the raw 0..1, untouched by min/max');
  assert.equal(route.scaled, 45, '20 + 0.25 * (120 - 20) = 45');

  // No min/max recorded on the CcMod defaults to the identity range 0..1, so
  // scaled and normalized coincide -- the common case for a live plugin,
  // whose opaque parameters have no descriptor to define a custom range.
  const defaulted = ccModFxRoute({ ...FX_MOD, min: undefined, max: undefined }, 0.6);
  assert.ok(defaulted);
  assert.equal(defaulted.normalized, 0.6);
  assert.equal(defaulted.scaled, 0.6);
}

/* ── missing deviceIndex or paramKey yields null ──────────────────────────── */
{
  assert.equal(ccModFxRoute({ ...FX_MOD, deviceIndex: undefined }, 0.5), null, 'no deviceIndex, no route');
  assert.equal(ccModFxRoute({ ...FX_MOD, paramKey: undefined }, 0.5), null, 'no paramKey, no route');
  assert.equal(ccModFxRoute({ ...FX_MOD, paramKey: '' }, 0.5), null, 'an empty paramKey is not a valid target');
}

/* ── a volume or mute CcMod yields null ───────────────────────────────────── */
{
  assert.equal(ccModFxRoute({ ...FX_MOD, target: 'volume' }, 0.5), null, 'volume routes never touch the chain');
  assert.equal(ccModFxRoute({ ...FX_MOD, target: 'mute' }, 0.5), null, 'mute routes never touch the chain');
}

console.log('ccModFxRouteModel: ok');
