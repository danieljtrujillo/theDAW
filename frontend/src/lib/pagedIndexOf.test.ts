/**
 * Finding a row's global index in a sparsely loaded result set, under node.
 *
 * Pins: only pages that are actually in hand are walked (one probe rules a
 * whole unloaded page out), the answer is the true GLOBAL index, and a row on
 * no loaded page answers -1 instead of scanning 200,000 empty slots.
 *
 * Run: `npx tsx src/lib/pagedIndexOf.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { pagedIndexOf } from './pagedIndexOf.ts';

const PAGE = 200;
const TOTAL = 200_000;

/** Pages 0 and 500 are loaded; everything else is still on the server. */
const loadedPages = new Set([0, 500]);
let probes = 0;
const entryAt = (index: number): { id: string } | undefined => {
  probes += 1;
  return loadedPages.has(Math.floor(index / PAGE)) ? { id: `e${index}` } : undefined;
};

// ── A row on a loaded page ─────────────────────────────────────────────────
{
  probes = 0;
  assert.equal(pagedIndexOf('e100017', TOTAL, entryAt, PAGE), 100017, 'the global index, not the page offset');
  assert.equal(pagedIndexOf('e0', TOTAL, entryAt, PAGE), 0, 'the very first row');
  assert.equal(pagedIndexOf('e199', TOTAL, entryAt, PAGE), 199, 'the last row of page 0');
}

// ── A row nobody has loaded ────────────────────────────────────────────────
{
  probes = 0;
  assert.equal(pagedIndexOf('e77000', TOTAL, entryAt, PAGE), -1, 'not in hand is -1');
  // 1000 pages, of which 2 are walked: 998 single probes + 2 × 200 rows.
  assert.ok(probes <= 1400, `an unloaded page costs one probe, not 200 (used ${probes})`);
}

// ── Degenerate input ───────────────────────────────────────────────────────
{
  assert.equal(pagedIndexOf('e0', 0, entryAt, PAGE), -1, 'an empty result set has no index');
  assert.equal(pagedIndexOf('', TOTAL, entryAt, PAGE), -1, 'an empty id matches nothing');
  assert.throws(() => pagedIndexOf('e0', TOTAL, entryAt, 0), RangeError);
  assert.throws(() => pagedIndexOf('e0', TOTAL, entryAt, Number.NaN), RangeError);
  assert.throws(() => pagedIndexOf('e0', Number.POSITIVE_INFINITY, entryAt, PAGE), RangeError);
}

console.log('pagedIndexOf: ok');
