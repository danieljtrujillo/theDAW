// An automation lane on a hosted plugin's parameter, as the curve its offline
// print moves the parameter by (lib/render/vstParamAutomation).
//
// The backend renders the plugin block by block and sets each automated
// parameter to its curve's value at the block's first frame, reading the curve
// as straight lines between `[frame, value]` points. So what this module owes
// the print is a curve whose straight-line reading IS the lane: the lane's value
// at the file's first frame, every breakpoint the file spans at its frame, a
// curved segment cut fine enough to follow its bend, and the lane's value at the
// file's last frame, so a window that closes mid-ramp does not hold the ramp's
// far end early.
//
// Run: npx tsx src/lib/render/vstParamAutomation.test.ts
import assert from 'node:assert/strict';

import { sampleCurve } from '../automationModes.ts';
import type { AutomationLane, AutomationTarget } from '../../state/editorStore.ts';
import { CURVE_STEP_SEC, hopAutomation, laneToHostPoints } from './vstParamAutomation.ts';

const SR = 1000;

const lane = (target: AutomationTarget, points: AutomationLane['points'], enabled = true): AutomationLane => ({
  id: `l-${target.kind}-${target.trackId ?? ''}-${target.entryId}-${target.paramKey}`, target, points, enabled,
});

/** The straight-line reading the renderers apply to a host curve. */
const readHost = (points: [number, number][], frame: number): number => {
  if (frame <= points[0][0]) return points[0][1];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [f0, v0] = points[i];
    const [f1, v1] = points[i + 1];
    if (frame >= f0 && frame <= f1) return f1 === f0 ? v1 : v0 + (v1 - v0) * ((frame - f0) / (f1 - f0));
  }
  return points[points.length - 1][1];
};

const near = (a: number, b: number, eps: number, what: string): void =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not ${b}`);

/* ── 1. A straight lane over the whole file ───────────────────────────────── */

{
  const pts = [{ t: 1, v: 0.2 }, { t: 3, v: 0.8 }];
  const host = laneToHostPoints({ points: pts }, 0, SR, 5 * SR);
  assert.deepEqual(host, [[0, 0.2], [1000, 0.2], [3000, 0.8], [5000, 0.8]],
    'the value held before the first point, each breakpoint at its frame, and the value held after the last');
}

/* ── 2. A range print's file starts part way along the lane ────────────────── */

// A range render hands the hop a file whose frame 0 is `originSec` on the
// timeline. A curve laid from timeline 0 would play the lane 2 s early.
{
  const pts = [{ t: 1, v: 0 }, { t: 3, v: 1 }];
  const host = laneToHostPoints({ points: pts }, 2, SR, 2 * SR);
  assert.deepEqual(host, [[0, 0.5], [1000, 1], [2000, 1]], 'frame 0 holds the lane at 2 s: half way up the ramp');
}

/* ── 3. A window that closes mid-ramp ends where the lane is at its end ────── */

{
  const pts = [{ t: 0, v: 0 }, { t: 10, v: 1 }];
  const host = laneToHostPoints({ points: pts }, 0, SR, 4 * SR);
  assert.deepEqual(host, [[0, 0], [4000, 0.4]], 'the file ends on 0.4, not on the ramp\'s far end');
}

/* ── 4. A curved segment is followed, not flattened ───────────────────────── */

{
  const pts = [{ t: 0, v: 0, curve: 0.8 }, { t: 1, v: 1 }];
  const host = laneToHostPoints({ points: pts }, 0, SR, SR);
  assert.ok(host.length >= Math.floor(1 / CURVE_STEP_SEC), `the bend is cut into pieces (${host.length} points)`);
  for (let f = 0; f <= SR; f += 37) {
    near(readHost(host, f), sampleCurve(pts, f / SR) ?? NaN, 0.02, `the host reading at frame ${f} follows the lane`);
  }
}

/* ── 5. Values leave normalized ───────────────────────────────────────────── */

{
  const host = laneToHostPoints({ points: [{ t: 0, v: 1.4 }, { t: 1, v: -0.2 }] }, 0, SR, 2 * SR);
  assert.ok(host.every(([, v]) => v >= 0 && v <= 1), 'a plugin parameter is 0..1');
}

/* ── 6. Which lanes a printed insert takes ────────────────────────────────── */

{
  const lanes: AutomationLane[] = [
    lane({ kind: 'trackFx', trackId: 't1', entryId: 'v1', paramKey: 'p3' }, [{ t: 0, v: 0.25 }]),
    lane({ kind: 'trackFx', trackId: 't1', entryId: 'v1', paramKey: 'mix' }, [{ t: 0, v: 0.5 }]),
    lane({ kind: 'trackFx', trackId: 't1', entryId: 'v1', paramKey: 'p4' }, [{ t: 0, v: 0.5 }], false),
    lane({ kind: 'trackFx', trackId: 't1', entryId: 'v1', paramKey: 'p5' }, []),
    lane({ kind: 'trackFx', trackId: 't2', entryId: 'v1', paramKey: 'p6' }, [{ t: 0, v: 0.5 }]),
    lane({ kind: 'busFx', trackId: 'b1', entryId: 'bv', paramKey: 'p0' }, [{ t: 0, v: 0.75 }]),
    lane({ kind: 'masterFx', entryId: 'mv', paramKey: 'p12' }, [{ t: 0, v: 0.1 }]),
  ];
  const file = { originSec: 0, sampleRate: SR, frames: SR };
  const names = (entryId: string, index: number) => (entryId === 'v1' && index === 3 ? 'Cutoff' : undefined);

  assert.deepEqual(
    hopAutomation(lanes, { id: 'v1' }, { kind: 'trackFx', ownerId: 't1' }, file, names),
    [{ index: 3, name: 'Cutoff', points: [[0, 0.25], [1000, 0.25]] }],
    'the track insert takes its own enabled plugin-parameter lane, named; a rack key, an off lane, an empty lane and another track\'s lane are not its',
  );
  assert.deepEqual(
    hopAutomation(lanes, { id: 'bv' }, { kind: 'busFx', ownerId: 'b1' }, file),
    [{ index: 0, points: [[0, 0.75], [1000, 0.75]] }],
    'a bus insert takes its bus\'s lane',
  );
  assert.deepEqual(
    hopAutomation(lanes, { id: 'mv' }, { kind: 'masterFx' }, file),
    [{ index: 12, points: [[0, 0.1], [1000, 0.1]] }],
    'a master plugin takes its masterFx lane',
  );
  assert.deepEqual(hopAutomation(lanes, { id: 'bv' }, { kind: 'trackFx', ownerId: 'b1' }, file), [],
    'a bus lane is not a track lane');
}

console.log('vstParamAutomation: all passed');
