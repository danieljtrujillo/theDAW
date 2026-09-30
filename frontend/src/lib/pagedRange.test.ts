import assert from 'node:assert/strict';
import { clampVisibleRange } from './pagedRange';

// ── a range fully inside the result set ─────────────────────────────────────

assert.deepEqual(
  clampVisibleRange(0, 19, 1000),
  { start: 0, end: 19 },
  'a range fully inside the result set is returned unchanged',
);

// ── a range overhanging or entirely past the end ────────────────────────────

assert.deepEqual(
  clampVisibleRange(980, 1200, 1000),
  { start: 980, end: 999 },
  'a range overhanging the end is clamped to total-1',
);

assert.equal(
  clampVisibleRange(50, 60, 10),
  null,
  'a range entirely past the end is null (the exact input that throws today)',
);

assert.equal(clampVisibleRange(0, 19, 0), null, 'an empty result set is null');

// ── normalisation instead of throwing ───────────────────────────────────────

assert.deepEqual(
  clampVisibleRange(30, 5, 1000),
  { start: 30, end: 30 },
  'end before start is normalised, not thrown',
);

// ── garbage input never throws ──────────────────────────────────────────────

for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(clampVisibleRange(bad, 10, 1000), null, `start=${bad} is null, never a throw`);
  assert.equal(clampVisibleRange(0, bad, 1000), null, `end=${bad} is null, never a throw`);
  assert.equal(clampVisibleRange(0, 10, bad), null, `total=${bad} is null, never a throw`);
}

console.log('pagedRange: ok');
