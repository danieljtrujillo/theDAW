/**
 * state/swayRouting — liveRouteFor, the pure resolver `drive()` uses to decide
 * whether a Sway dimension's target addresses a live plugin parameter instead
 * of the stored-value path. No socket, no zustand persistence, no engine --
 * `liveRouteFor` never calls `target.invoke` or `pushLiveParam`.
 *
 * Run: npx tsx src/state/swayRouting.live.test.ts
 */
import assert from 'node:assert/strict';

import { liveRouteFor } from './swayRouting.ts';
import type { BindableTarget } from '../components/surface/widgetTypes.ts';

/** A minimal BindableTarget -- `invoke` is never called by `liveRouteFor`,
 *  which is pure, so it only needs to exist to satisfy the type. */
function makeTarget(overrides: Partial<BindableTarget> & Pick<BindableTarget, 'id' | 'kind'>): BindableTarget {
  return {
    label: 'test target',
    group: 'Test',
    invoke: () => {},
    ...overrides,
  };
}

/* ── liveRouteFor returns null for a DJ/MAKE/PROCESS target id ────────────── */
{
  const dj = makeTarget({ id: 'dj.deckAVolume', kind: 'fader' });
  const make = makeTarget({ id: 'make.cfgMusic', kind: 'knob' });
  const proc = makeTarget({ id: 'process.eqMid', kind: 'knob' });

  assert.equal(liveRouteFor(dj, 0.5), null, 'a dj.* id does not parse as a live-param target');
  assert.equal(liveRouteFor(make, 0.5), null, 'a make.* id does not parse as a live-param target');
  assert.equal(liveRouteFor(proc, 0.5), null, 'a process.* id does not parse as a live-param target');
}

/* ── liveRouteFor resolves a vstlive: target id and normalizes the value ──── */
{
  const t = makeTarget({ id: 'vstlive:entry-1:p3', kind: 'knob', min: 20, max: 400 });

  const route = liveRouteFor(t, 0.5);
  if (!route) throw new Error('expected a vstlive: id to resolve');
  assert.equal(route.entryId, 'entry-1');
  assert.equal(route.paramKey, 'p3');
  assert.ok(
    Math.abs(route.value - 0.5) < 1e-9,
    'scaling into [min,max] and back to normalized is the identity, regardless of the target range',
  );
}

/* ── liveRouteFor returns null for a toggle and for a pad target ──────────── */
{
  const toggle = makeTarget({ id: 'vstlive:entry-1:p0', kind: 'toggle' });
  const pad = makeTarget({ id: 'vstlive:entry-1:p1', kind: 'pad' });

  assert.equal(liveRouteFor(toggle, 1), null, 'a toggle never reaches a live plugin (parameter is continuous)');
  assert.equal(liveRouteFor(pad, 1), null, 'a pad never reaches a live plugin (parameter is continuous)');
}

/* ── a target with min/max 0..1 passes the dimension value through unchanged ── */
{
  const t = makeTarget({ id: 'vstlive:entry-2:p7', kind: 'fader' }); // no min/max -> defaults to 0..1

  const route = liveRouteFor(t, 0.732);
  if (!route) throw new Error('expected a vstlive: id to resolve');
  assert.equal(route.value, 0.732, 'default 0..1 range is the identity mapping');
}

console.log('state/swayRouting.live: ok');
