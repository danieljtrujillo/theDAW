import assert from 'node:assert/strict';
import { MASTER_ID } from '../../state/routingGraph';
import {
  MASTER_ROW_ID,
  MASTER_ROW_LABEL,
  excludeMasterRow,
  isMasterRowId,
  masterAutomationLanes,
  masterFxButtonLabel,
  masterFxCount,
  masterLaneLabel,
  masterVolumeAria,
  meterFillPercent,
} from './masterTrackRowModel';

// --- Identity --------------------------------------------------------------------

// MASTER_ROW_ID equals routingGraph MASTER_ID
assert.equal(MASTER_ROW_ID, MASTER_ID);
assert.equal(MASTER_ROW_LABEL, 'MASTER');

// --- masterFxCount -----------------------------------------------------------------

// masterFxCount sums both chains and tolerates undefined
assert.equal(masterFxCount([{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]), 3);
assert.equal(masterFxCount(undefined, undefined), 0);
assert.equal(masterFxCount([{ id: 'a' }], undefined), 1);
assert.equal(masterFxCount(undefined, [{ id: 'a' }, { id: 'b' }]), 2);
assert.equal(masterFxCount(null as unknown as undefined, null as unknown as undefined), 0);
assert.equal(masterFxCount([], []), 0);

// --- masterFxButtonLabel -----------------------------------------------------------

// masterFxButtonLabel singular/plural/zero
assert.equal(masterFxButtonLabel(0), 'Master FX, no effects');
assert.equal(masterFxButtonLabel(1), 'Master FX, 1 effect');
assert.equal(masterFxButtonLabel(2), 'Master FX, 2 effects');
assert.equal(masterFxButtonLabel(11), 'Master FX, 11 effects');

// throws RangeError on NaN and -1
assert.throws(() => masterFxButtonLabel(Number.NaN), RangeError);
assert.throws(() => masterFxButtonLabel(-1), RangeError);
assert.throws(() => masterFxButtonLabel(Number.POSITIVE_INFINITY), RangeError);
assert.throws(() => masterFxButtonLabel(Number.NEGATIVE_INFINITY), RangeError);

// --- masterAutomationLanes -----------------------------------------------------------

// masterAutomationLanes keeps only masterFx lanes, in order
const lanes = [
  { id: '1', target: { kind: 'trackVolume' } },
  { id: '2', target: { kind: 'masterFx' } },
  { id: '3', target: { kind: 'trackFx' } },
  { id: '4', target: { kind: 'masterFx' } },
];
assert.deepEqual(
  masterAutomationLanes(lanes).map((l) => l.id),
  ['2', '4'],
);
assert.deepEqual(masterAutomationLanes(undefined), []);

// --- masterLaneLabel ------------------------------------------------------------------

// masterLaneLabel formats the effect param name, or 'parameter' when absent
assert.equal(masterLaneLabel({ paramKey: 'cutoff' }), 'master effect cutoff');
assert.equal(masterLaneLabel({}), 'master effect parameter');
assert.equal(masterLaneLabel({ paramKey: undefined }), 'master effect parameter');

// --- meterFillPercent ----------------------------------------------------------------

// meterFillPercent: -60 -> 0, 0 -> 100, -30 -> 50, -120 -> 0, -Infinity -> 0, NaN -> 0, +6 clamped to 100
assert.equal(meterFillPercent(-60), 0);
assert.equal(meterFillPercent(0), 100);
assert.equal(meterFillPercent(-30), 50);
assert.equal(meterFillPercent(-120), 0);
assert.equal(meterFillPercent(Number.NEGATIVE_INFINITY), 0);
assert.equal(meterFillPercent(Number.NaN), 0);
assert.equal(meterFillPercent(6), 100);
// Custom floor, and rounding to 1 decimal.
assert.equal(meterFillPercent(-45, -90), 50);
assert.equal(meterFillPercent(-19, -60), 68.3);

// floorDb must be finite and negative: 0 divides (0 - floorDb) to zero (NaN
// slipping past the [0, 100] clamp), and a positive floor inverts the scale
// silently. Both throw RangeError instead.
assert.throws(() => meterFillPercent(0, 0), RangeError);
assert.throws(() => meterFillPercent(-6, 0), RangeError);
assert.throws(() => meterFillPercent(-6, 10), RangeError);
assert.throws(() => meterFillPercent(-6, Number.NaN), RangeError);
assert.throws(() => meterFillPercent(-6, Number.POSITIVE_INFINITY), RangeError);
assert.throws(() => meterFillPercent(-6, Number.NEGATIVE_INFINITY), RangeError);

// --- masterVolumeAria ----------------------------------------------------------------

// masterVolumeAria formats and marks muted; clamps 120 -> 100
assert.equal(masterVolumeAria(75, false), 'Master volume 75 percent');
assert.equal(masterVolumeAria(75, true), 'Master volume 75 percent, muted');
assert.equal(masterVolumeAria(120, false), 'Master volume 100 percent');
assert.equal(masterVolumeAria(-5, false), 'Master volume 0 percent');
assert.equal(masterVolumeAria(64.6, false), 'Master volume 65 percent');

// --- excludeMasterRow ----------------------------------------------------------------

// excludeMasterRow drops the master id and keeps track order
const rows = [{ id: 't1' }, { id: MASTER_ID }, { id: 't2' }, { id: 't3' }];
assert.deepEqual(
  excludeMasterRow(rows).map((r) => r.id),
  ['t1', 't2', 't3'],
);
assert.equal(isMasterRowId(MASTER_ID), true);
assert.equal(isMasterRowId('t1'), false);

console.log('masterTrackRowModel: ok');
