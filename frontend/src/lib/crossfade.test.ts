// crossfade: overlap regions between clips on one track, and the gain pair
// inside a region. Nothing is stored — the regions are derived from where the
// clips sit — so the suite pins the derivation (including the three-way case
// and the early exit) and the constant-power property of the gains.
import assert from 'node:assert/strict';
import { crossfadeGains, crossfadeRegions, type CrossfadeClip } from './crossfade.ts';

const clip = (id: string, startSec: number, durationSec: number): CrossfadeClip => ({ id, startSec, durationSec });
const shape = (r: ReturnType<typeof crossfadeRegions>) =>
  r.map((x) => [x.outId, x.inId, x.startSec, x.endSec, x.durationSec]);
const close = (a: number, b: number, eps: number, what: string) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// ── 1. Deriving the regions ──────────────────────────────────────────────────
{
  // Nothing to cross.
  assert.deepEqual(crossfadeRegions([]), []);
  assert.deepEqual(crossfadeRegions([clip('a', 0, 4)]), []);

  // Clips with a gap between them do not cross.
  assert.deepEqual(crossfadeRegions([clip('a', 0, 4), clip('b', 6, 4)]), []);

  // Clips that merely TOUCH do not cross either — an overlap needs length.
  assert.deepEqual(crossfadeRegions([clip('a', 0, 4), clip('b', 4, 4)]), []);

  // The plain case: b starts one second before a ends.
  assert.deepEqual(shape(crossfadeRegions([clip('a', 0, 4), clip('b', 3, 4)])), [['a', 'b', 3, 4, 1]]);

  // The input does not have to be sorted, and the earlier clip is always the
  // one that fades OUT.
  assert.deepEqual(shape(crossfadeRegions([clip('b', 3, 4), clip('a', 0, 4)])), [['a', 'b', 3, 4, 1]]);

  // A clip swallowed by a longer one: the overlap is the short clip's span.
  assert.deepEqual(shape(crossfadeRegions([clip('long', 0, 10), clip('in', 2, 3)])), [['long', 'in', 2, 5, 3]]);

  // Three clips overlapping each other give all three pairs.
  assert.deepEqual(
    shape(crossfadeRegions([clip('a', 0, 5), clip('b', 2, 5), clip('c', 4, 5)])),
    [['a', 'b', 2, 5, 3], ['a', 'c', 4, 5, 1], ['b', 'c', 4, 7, 3]],
  );

  // The early exit: 'c' starts after 'a' has ended, so a/c is not a region even
  // though a/b and b/c are.
  assert.deepEqual(
    shape(crossfadeRegions([clip('a', 0, 4), clip('b', 3, 4), clip('c', 5, 4)])),
    [['a', 'b', 3, 4, 1], ['b', 'c', 5, 7, 2]],
  );

  // Two clips starting together: the overlap runs to whichever ends first.
  assert.deepEqual(shape(crossfadeRegions([clip('a', 1, 3), clip('b', 1, 5)])), [['a', 'b', 1, 4, 3]]);

  // Zero-length and malformed clips cannot overlap anything.
  assert.deepEqual(crossfadeRegions([clip('a', 0, 4), clip('z', 2, 0)]), []);
  assert.deepEqual(crossfadeRegions([clip('a', 0, 4), clip('z', 2, -3)]), []);
}

// ── 2. The gains inside a region ─────────────────────────────────────────────
{
  const region = { startSec: 10, endSec: 14 };
  const HALF = Math.SQRT1_2;

  // Equal power is the default, and is the same sin/cos pair the DJ crossfader
  // uses: sum of squares stays at 1 all the way across.
  assert.deepEqual(crossfadeGains(10, region), { in: 0, out: 1 });
  close(crossfadeGains(12, region).in, HALF, 1e-12, 'equal-power in at the midpoint');
  close(crossfadeGains(12, region).out, HALF, 1e-12, 'equal-power out at the midpoint');
  close(crossfadeGains(14, region).in, 1, 1e-12, 'equal-power in at the end');
  close(crossfadeGains(14, region).out, 0, 1e-12, 'equal-power out at the end');
  for (let i = 0; i <= 200; i += 1) {
    const t = 10 + (4 * i) / 200;
    const g = crossfadeGains(t, region);
    close(g.in * g.in + g.out * g.out, 1, 1e-12, `constant power at ${t}`);
    close(g.in, Math.sin((((t - 10) / 4) * Math.PI) / 2), 1e-12, `equal-power in at ${t}`);
    close(g.out, Math.cos((((t - 10) / 4) * Math.PI) / 2), 1e-12, `equal-power out at ${t}`);
  }

  // Linear is t / 1 − t: the two sum to 1 instead, which dips in the middle.
  assert.deepEqual(crossfadeGains(10, region, 'linear'), { in: 0, out: 1 });
  assert.deepEqual(crossfadeGains(11, region, 'linear'), { in: 0.25, out: 0.75 });
  assert.deepEqual(crossfadeGains(12, region, 'linear'), { in: 0.5, out: 0.5 });
  assert.deepEqual(crossfadeGains(14, region, 'linear'), { in: 1, out: 0 });
  for (let i = 0; i <= 200; i += 1) {
    const t = 10 + (4 * i) / 200;
    const g = crossfadeGains(t, region, 'linear');
    close(g.in + g.out, 1, 1e-12, `linear sum at ${t}`);
  }

  // Outside the region the gains hold at their ends.
  assert.deepEqual(crossfadeGains(0, region, 'linear'), { in: 0, out: 1 });
  assert.deepEqual(crossfadeGains(100, region, 'linear'), { in: 1, out: 0 });

  // A region with no length is already fully crossed.
  assert.deepEqual(crossfadeGains(5, { startSec: 5, endSec: 5 }), { in: 1, out: 0 });

  // A derived region can be fed straight back in.
  const [r] = crossfadeRegions([clip('a', 0, 4), clip('b', 3, 4)]);
  assert.deepEqual(crossfadeGains(r.startSec, r, 'linear'), { in: 0, out: 1 });
  assert.deepEqual(crossfadeGains(r.endSec, r, 'linear'), { in: 1, out: 0 });
}

console.log('crossfade: ok');
