// clipComp: the take/comp model, with no store, no AudioContext and no Blob.
//
// Everything here is pure arithmetic over a region list, so the suite pins the
// invariants the rest of the comping work leans on:
//
//   * a normalized comp is strictly ascending, starts at 0, and names only
//     takes that exist;
//   * the segments it derives never leave the clip box, however long a
//     crossfade is asked for;
//   * every editing operation (split, pick, drag) returns a list that is
//     itself normalized, so the operations compose;
//   * the digest is stable and order-sensitive, because a freeze signature
//     built on it has to go stale when the comp changes.
import assert from 'node:assert/strict';
import {
  COMP_BOUNDARY_EPS,
  compDigest, compSegments, isComped, moveBoundary, normalizeComp, setRegionAt, splitCompAt,
  type ClipTake, type CompRegion, type CompSegment,
} from './clipComp.ts';

const r = (startSec: number, takeIndex: number, crossfadeSec?: number): CompRegion =>
  (crossfadeSec === undefined ? { startSec, takeIndex } : { startSec, takeIndex, crossfadeSec });

/** Regions as tuples, so a failure prints the list instead of a wall of objects. */
const shape = (regions: readonly CompRegion[]): unknown[] =>
  regions.map((x) => [x.startSec, x.takeIndex, x.crossfadeSec ?? 0]);

const segShape = (segments: readonly CompSegment[]): unknown[] =>
  segments.map((s) => [s.takeIndex, s.startSec, s.endSec, s.fadeInSec, s.fadeOutSec]);

const close = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) <= 1e-9, `${what}: ${a} vs ${b}`);

// ── 1. normalizeComp ─────────────────────────────────────────────────────────
{
  // Nothing in, nothing out. An absent comp is the not-comped clip.
  assert.deepEqual(normalizeComp(undefined, 3, 10), []);
  assert.deepEqual(normalizeComp([], 3, 10), []);

  // No takes to point at, or no clip to cover: there is no comp to be had.
  assert.deepEqual(normalizeComp([r(0, 0)], 0, 10), []);
  assert.deepEqual(normalizeComp([r(0, 0)], -1, 10), []);
  assert.deepEqual(normalizeComp([r(0, 0)], 3, 0), []);
  assert.deepEqual(normalizeComp([r(0, 0)], 3, Number.NaN), []);

  // The plain case passes through untouched.
  assert.deepEqual(shape(normalizeComp([r(0, 0), r(4, 1)], 2, 10)), [[0, 0, 0], [4, 1, 0]]);

  // Unsorted input is sorted.
  assert.deepEqual(
    shape(normalizeComp([r(6, 2), r(0, 0), r(4, 1)], 3, 10)),
    [[0, 0, 0], [4, 1, 0], [6, 2, 0]],
  );

  // Duplicate starts collapse to the first one seen at that time.
  assert.deepEqual(
    shape(normalizeComp([r(0, 0), r(4, 1), r(4, 2)], 3, 10)),
    [[0, 0, 0], [4, 1, 0]],
  );

  // A take index that is out of range, negative, fractional or not a number at
  // all names no take, so the region is dropped rather than left dangling.
  assert.deepEqual(
    shape(normalizeComp([r(0, 0), r(2, 5), r(4, -1), r(6, 1.5), r(8, 1)], 2, 10)),
    [[0, 0, 0], [8, 1, 0]],
  );

  // A start before the clip head clamps to 0; one at or past the end has no
  // length and is dropped.
  assert.deepEqual(
    shape(normalizeComp([r(-3, 0), r(5, 1), r(10, 1), r(12, 1)], 2, 10)),
    [[0, 0, 0], [5, 1, 0]],
  );
  // A non-finite start is not a position at all.
  assert.deepEqual(shape(normalizeComp([r(0, 0), r(Number.NaN, 1)], 2, 10)), [[0, 0, 0]]);

  // Whatever the first region claimed, it starts at the clip head — a comp
  // with a gap at the front would leave part of the clip playing no take.
  assert.deepEqual(shape(normalizeComp([r(3, 1), r(6, 0)], 2, 10)), [[0, 1, 0], [6, 0, 0]]);

  // Crossfades: kept when positive, dropped when zero, negative or not finite,
  // and always dropped on the FIRST region — the clip head is not a boundary
  // between two takes.
  assert.deepEqual(
    shape(normalizeComp([r(0, 0, 1), r(2, 1, 0), r(4, 0, -1), r(6, 1, Number.NaN), r(8, 0, 0.5)], 2, 10)),
    [[0, 0, 0], [2, 1, 0], [4, 0, 0], [6, 1, 0], [8, 0, 0.5]],
  );

  // An absent crossfade stays absent rather than becoming `undefined`, so the
  // region objects compare cleanly (and serialize without a null).
  assert.deepEqual(normalizeComp([r(0, 0), r(4, 1, 2)], 2, 10), [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1, crossfadeSec: 2 }]);

  // Normalizing twice changes nothing: every later operation re-normalizes, so
  // this has to be a fixed point.
  const once = normalizeComp([r(6, 2), r(-1, 0), r(4, 1), r(4, 0)], 3, 10);
  assert.deepEqual(normalizeComp(once, 3, 10), once, 'normalizeComp is idempotent');

  // The input is not mutated.
  const input = [r(4, 1), r(0, 0)];
  normalizeComp(input, 2, 10);
  assert.deepEqual(shape(input), [[4, 1, 0], [0, 0, 0]], 'the caller keeps its own list');
}

// ── 2. compSegments ──────────────────────────────────────────────────────────
{
  // Nothing to play.
  assert.deepEqual(compSegments([], 10), []);
  assert.deepEqual(compSegments([r(0, 0)], 0), []);

  // One region is the whole clip, and there is no boundary to fade across.
  assert.deepEqual(segShape(compSegments([r(0, 1)], 10)), [[1, 0, 10, 0, 0]]);

  // BUTT CUT: with no crossfade the regions meet exactly, and the last one runs
  // to the clip end.
  assert.deepEqual(
    segShape(compSegments([r(0, 0), r(4, 1), r(7, 0)], 10)),
    [[0, 0, 4, 0, 0], [1, 4, 7, 0, 0], [0, 7, 10, 0, 0]],
  );

  // SYMMETRIC CROSSFADE: a crossfade of L at a boundary runs the outgoing take
  // L/2 past it and starts the incoming one L/2 early, so both carry a fade of
  // L across the same window.
  assert.deepEqual(
    segShape(compSegments([r(0, 0), r(4, 1, 1)], 10)),
    [[0, 0, 4.5, 0, 1], [1, 3.5, 10, 1, 0]],
  );

  // The middle segment of a three-region comp carries a fade at each end.
  assert.deepEqual(
    segShape(compSegments([r(0, 0), r(4, 1, 1), r(7, 2, 2)], 10)),
    [[0, 0, 4.5, 0, 1], [1, 3.5, 8, 1, 2], [2, 6, 10, 2, 0]],
  );

  // EDGE CLAMP: a crossfade on the first region is ignored (nothing precedes
  // the clip head), and no segment reaches outside [0, clipDurationSec].
  const clamped = compSegments([r(0, 0, 4), r(3, 1, 2)], 6);
  assert.deepEqual(segShape(clamped), [[0, 0, 4, 0, 2], [1, 2, 6, 2, 0]]);
  for (const s of clamped) {
    assert.ok(s.startSec >= 0 && s.endSec <= 6, 'segments stay inside the clip box');
    assert.ok(s.endSec > s.startSec, 'and have length');
  }

  // A CROSSFADE LONGER THAN ITS NEIGHBOUR: each side gives up at most HALF its
  // own region, so a 10 s crossfade between a 1 s and a 5 s region reaches
  // 0.5 s each way and still cannot escape the box.
  const long = compSegments([r(0, 0), r(1, 1, 10)], 6);
  assert.deepEqual(segShape(long), [[0, 0, 1.5, 0, 1], [1, 0.5, 6, 1, 0]]);
  for (const s of long) {
    assert.ok(s.startSec >= 0 && s.endSec <= 6, 'an oversized crossfade is still inside the box');
  }

  // The same limit applies against the region the crossfade leads INTO.
  assert.deepEqual(
    segShape(compSegments([r(0, 0), r(4, 1, 10), r(5, 0)], 10)),
    [[0, 0, 4.5, 0, 1], [1, 3.5, 5, 1, 0], [0, 5, 10, 0, 0]],
  );

  // THE FADES FIT. A region with a crossfade at BOTH ends is the case that
  // makes this a rule rather than an accident: half from either side is what
  // keeps `fadeInSec + fadeOutSec <= endSec - startSec`, so the consumer's
  // `clipFade.clampClipFades` never shrinks one side of a seam and leaves the
  // two takes no longer summing across it.
  const doubled = compSegments([r(0, 0), r(4, 1, 10), r(5, 2, 10)], 10);
  assert.deepEqual(segShape(doubled), [[0, 0, 4.5, 0, 1], [1, 3.5, 5.5, 1, 1], [2, 4.5, 10, 1, 0]]);
  const fits = (segments: readonly CompSegment[], dur: number, what: string) => {
    for (const s of segments) {
      assert.ok(
        s.fadeInSec + s.fadeOutSec <= s.endSec - s.startSec + 1e-9,
        `${what}: fades ${s.fadeInSec}+${s.fadeOutSec} exceed the ${s.endSec - s.startSec}s segment`,
      );
      assert.ok(s.startSec >= 0 && s.endSec <= dur, `${what}: segment outside the clip box`);
    }
  };
  fits(doubled, 10, 'double crossfade');

  // ...and it holds whatever the crossfades and the region lengths are.
  for (const xf of [0.1, 1, 3, 10, 1000]) {
    for (const mid of [0.2, 1, 4, 8]) {
      const comp = [r(0, 0), r(mid, 1, xf), r(mid + 0.5, 2, xf), r(9, 0, xf)];
      fits(compSegments(comp, 10), 10, `xf=${xf} mid=${mid}`);
    }
  }

  // compSegments normalizes what it is handed, so a raw list from disk is safe.
  assert.deepEqual(
    segShape(compSegments([r(7, 0), r(3, 1)], 10)),
    [[1, 0, 7, 0, 0], [0, 7, 10, 0, 0]],
  );

  // A `takeIndex` that could not name any take — NaN, negative, fractional —
  // is dropped STRUCTURALLY, with no take count needed, so no segment ever
  // carries one out to a buffer resolver. Whether the index is in range for
  // this clip's take list stays `normalizeComp`'s job.
  assert.deepEqual(
    segShape(compSegments([r(0, 0), r(2, Number.NaN), r(4, -1), r(6, 1.5), r(8, 1)], 10)),
    [[0, 0, 8, 0, 0], [1, 8, 10, 0, 0]],
  );
  for (const s of compSegments([r(0, Number.NaN), r(5, -1)], 10)) {
    assert.fail(`a comp naming no take at all produced a segment: ${JSON.stringify(s)}`);
  }
  // The same check guards the editing operations, so a damaged comp cannot be
  // dragged or picked into a live one.
  assert.deepEqual(shape(setRegionAt([r(0, Number.NaN), r(4, -1)], 2, 1, 10)), [[0, 1, 0]]);
  assert.deepEqual(shape(moveBoundary([r(0, 0), r(4, Number.NaN), r(6, 1)], 1, 5, 10)), [[0, 0, 0], [5, 1, 0]]);

  // A butt cut leaves no gap and no overlap: the segments tile the clip.
  const tiled = compSegments([r(0, 0), r(2.5, 1), r(6, 2)], 9);
  close(tiled[0].endSec, tiled[1].startSec, 'segment 0 meets segment 1');
  close(tiled[1].endSec, tiled[2].startSec, 'segment 1 meets segment 2');
  close(tiled[0].startSec, 0, 'the first segment opens the clip');
  close(tiled[2].endSec, 9, 'the last segment closes it');
}

// ── 3. splitCompAt ───────────────────────────────────────────────────────────
{
  const comp = [r(0, 0), r(4, 1, 1), r(7, 2)];

  // INSIDE A REGION: the straddling region continues on the right, re-seeded at
  // 0 and with its crossfade dropped (its leading boundary is now the clip head
  // of the right half).
  const inside = splitCompAt(comp, 5, 10);
  assert.deepEqual(shape(inside.left), [[0, 0, 0], [4, 1, 1]]);
  assert.deepEqual(shape(inside.right), [[0, 1, 0], [2, 2, 0]]);

  // ON A BOUNDARY: the region that starts exactly at the cut belongs to the
  // right half, and its crossfade goes with the boundary that no longer exists.
  const onBoundary = splitCompAt(comp, 4, 10);
  assert.deepEqual(shape(onBoundary.left), [[0, 0, 0]]);
  assert.deepEqual(shape(onBoundary.right), [[0, 1, 0], [3, 2, 0]]);

  // AT 0 and AT THE END: one half gets everything, the other nothing.
  const atZero = splitCompAt(comp, 0, 10);
  assert.deepEqual(atZero.left, []);
  assert.deepEqual(shape(atZero.right), [[0, 0, 0], [4, 1, 1], [7, 2, 0]]);
  const atEnd = splitCompAt(comp, 10, 10);
  assert.deepEqual(shape(atEnd.left), [[0, 0, 0], [4, 1, 1], [7, 2, 0]]);
  assert.deepEqual(atEnd.right, []);

  // Outside the clip on either side behaves like its nearest edge.
  assert.deepEqual(splitCompAt(comp, -2, 10).left, []);
  assert.deepEqual(splitCompAt(comp, 99, 10).right, []);
  assert.deepEqual(splitCompAt(comp, Number.NaN, 10).left, [], 'a non-finite cut is the clip head');

  // Both halves are themselves normalized against their OWN new length: nothing
  // survives past the half it landed in.
  const late = splitCompAt(comp, 8.5, 10);
  assert.deepEqual(shape(late.left), [[0, 0, 0], [4, 1, 1], [7, 2, 0]]);
  assert.deepEqual(shape(late.right), [[0, 2, 0]]);
  for (const side of [late.left, late.right]) {
    if (side.length > 0) assert.equal(side[0].startSec, 0, 'each half starts at its own head');
  }

  // An absent comp splits into two absent comps.
  assert.deepEqual(splitCompAt([], 5, 10), { left: [], right: [] });

  // The input list is not mutated.
  const before = shape(comp);
  splitCompAt(comp, 5, 10);
  assert.deepEqual(shape(comp), before, 'splitCompAt leaves its argument alone');
}

// ── 4. setRegionAt ───────────────────────────────────────────────────────────
{
  const comp = [r(0, 0), r(4, 1), r(7, 0)];

  // INSIDE a region: the region is split, and everything from the click to the
  // next boundary plays the picked take.
  assert.deepEqual(
    shape(setRegionAt(comp, 2, 2, 10)),
    [[0, 0, 0], [2, 2, 0], [4, 1, 0], [7, 0, 0]],
  );

  // AT a boundary: the region is retargeted in place rather than split, and its
  // crossfade stays with the boundary.
  assert.deepEqual(
    shape(setRegionAt([r(0, 0), r(4, 1, 1), r(7, 0)], 4, 2, 10)),
    [[0, 0, 0], [4, 2, 1], [7, 0, 0]],
  );

  // MERGE with the region before: picking take 0 at the 4 s boundary makes it
  // the same take as the head, so the boundary disappears.
  assert.deepEqual(shape(setRegionAt(comp, 4, 0, 10)), [[0, 0, 0]]);

  // MERGE with the region after: picking take 0 at 5 s inside region 1 runs to
  // the next boundary at 7 s, where the take 0 region already starts — so that
  // boundary stops being one and the two join into a single 5 s → end region.
  assert.deepEqual(shape(setRegionAt(comp, 5, 0, 10)), [[0, 0, 0], [4, 1, 0], [5, 0, 0]]);

  // A pick inside a region that already plays that take changes nothing.
  assert.deepEqual(shape(setRegionAt(comp, 1, 0, 10)), [[0, 0, 0], [4, 1, 0], [7, 0, 0]]);

  // At the clip head: the first region is retargeted, never prefixed.
  assert.deepEqual(shape(setRegionAt(comp, 0, 3, 10)), [[0, 3, 0], [4, 1, 0], [7, 0, 0]]);
  assert.deepEqual(shape(setRegionAt(comp, -5, 3, 10)), [[0, 3, 0], [4, 1, 0], [7, 0, 0]]);

  // At or past the end there is no room for a region, so nothing changes.
  assert.deepEqual(shape(setRegionAt(comp, 10, 2, 10)), [[0, 0, 0], [4, 1, 0], [7, 0, 0]]);
  assert.deepEqual(shape(setRegionAt(comp, 42, 2, 10)), [[0, 0, 0], [4, 1, 0], [7, 0, 0]]);

  // A take index that is not a take index is refused.
  assert.deepEqual(shape(setRegionAt(comp, 2, -1, 10)), [[0, 0, 0], [4, 1, 0], [7, 0, 0]]);
  assert.deepEqual(shape(setRegionAt(comp, 2, 1.5, 10)), [[0, 0, 0], [4, 1, 0], [7, 0, 0]]);

  // A clip with no comp yet: the pick seeds one region over the whole clip,
  // because there is no earlier boundary to preserve. A caller that wants the
  // head to keep the active take seeds `[{ startSec: 0, takeIndex: active }]`
  // first and then picks.
  assert.deepEqual(shape(setRegionAt([], 3, 2, 10)), [[0, 2, 0]]);
  assert.deepEqual(
    shape(setRegionAt(setRegionAt([], 0, 0, 10), 3, 2, 10)),
    [[0, 0, 0], [3, 2, 0]],
    'seed then pick keeps the head on the active take',
  );

  // The result is normalized, so picks compose.
  const twice = setRegionAt(setRegionAt(comp, 2, 2, 10), 6, 3, 10);
  assert.deepEqual(shape(twice), [[0, 0, 0], [2, 2, 0], [4, 1, 0], [6, 3, 0], [7, 0, 0]]);

  // The input list is not mutated.
  const before = shape(comp);
  setRegionAt(comp, 2, 2, 10);
  assert.deepEqual(shape(comp), before, 'setRegionAt leaves its argument alone');
}

// ── 5. moveBoundary ──────────────────────────────────────────────────────────
{
  const comp = [r(0, 0), r(4, 1, 1), r(7, 2)];

  // A move that lands between the neighbours is taken as given, crossfade and
  // all.
  assert.deepEqual(shape(moveBoundary(comp, 1, 2, 10)), [[0, 0, 0], [2, 1, 1], [7, 2, 0]]);

  // CLAMPED BELOW: a drag past the previous boundary stops just after it, so
  // the list stays strictly ascending instead of collapsing a region away.
  const low = moveBoundary(comp, 1, -5, 10);
  close(low[1].startSec, COMP_BOUNDARY_EPS, 'clamped to just after the clip head');
  assert.ok(low[1].startSec > low[0].startSec, 'boundaries stay ordered');

  // CLAMPED ABOVE: against the NEXT boundary for a middle region...
  const high = moveBoundary(comp, 1, 99, 10);
  close(high[1].startSec, 7 - COMP_BOUNDARY_EPS, 'clamped to just before the next boundary');
  assert.ok(high[1].startSec < high[2].startSec, 'boundaries stay ordered');

  // ...and against the CLIP END for the last region.
  const last = moveBoundary(comp, 2, 99, 10);
  close(last[2].startSec, 10 - COMP_BOUNDARY_EPS, 'the last boundary stops before the clip end');

  // Region 0 is the clip head, not a boundary: it cannot be dragged.
  assert.deepEqual(shape(moveBoundary(comp, 0, 3, 10)), [[0, 0, 0], [4, 1, 1], [7, 2, 0]]);

  // Out-of-range or nonsense arguments leave the comp alone.
  for (const [idx, to] of [[9, 3], [-1, 3], [1.5, 3], [1, Number.NaN]] as [number, number][]) {
    assert.deepEqual(
      shape(moveBoundary(comp, idx, to, 10)), [[0, 0, 0], [4, 1, 1], [7, 2, 0]],
      `moveBoundary(${idx}, ${to}) is a no-op`,
    );
  }

  // Two boundaries with no room between them refuse the move rather than
  // stacking on the same instant.
  const tight = [r(0, 0), r(1, 1), r(1 + COMP_BOUNDARY_EPS, 2)];
  assert.deepEqual(shape(moveBoundary(tight, 2, 0, 10)), shape(normalizeComp(tight, 3, 10)));

  // A moved boundary is still normalized, so moves compose.
  const moved = moveBoundary(moveBoundary(comp, 1, 5, 10), 2, 6, 10);
  assert.deepEqual(shape(moved), [[0, 0, 0], [5, 1, 1], [6, 2, 0]]);

  // The input list is not mutated.
  const before = shape(comp);
  moveBoundary(comp, 1, 2, 10);
  assert.deepEqual(shape(comp), before, 'moveBoundary leaves its argument alone');
}

// ── 6. compDigest ────────────────────────────────────────────────────────────
{
  const comp = [r(0, 0), r(4, 1, 1)];

  // Stable: the same input gives the same string every time.
  assert.equal(compDigest(comp, 0), compDigest([r(0, 0), r(4, 1, 1)], 0));

  // Order-sensitive: the same regions in a different order are a different comp
  // (the digest is deliberately NOT normalized — it reports what is stored).
  assert.notEqual(compDigest([r(0, 0), r(4, 1)], 0), compDigest([r(4, 1), r(0, 0)], 0));

  // Every field participates: a moved boundary, a changed take, a changed
  // crossfade and a changed active take all change the string.
  assert.notEqual(compDigest(comp, 0), compDigest([r(0, 0), r(5, 1, 1)], 0));
  assert.notEqual(compDigest(comp, 0), compDigest([r(0, 0), r(4, 2, 1)], 0));
  assert.notEqual(compDigest(comp, 0), compDigest([r(0, 0), r(4, 1, 2)], 0));
  assert.notEqual(compDigest(comp, 0), compDigest([r(0, 0), r(4, 1)], 0));
  assert.notEqual(compDigest(comp, 0), compDigest(comp, 1));

  // An absent comp and an empty one are the same thing, and an absent active
  // take is take 0 — the invariant says the clip's own blob mirrors takes[0].
  assert.equal(compDigest(undefined, 0), compDigest([], 0));
  assert.equal(compDigest(undefined, undefined), compDigest(undefined, 0));
  assert.equal(compDigest(undefined, -1), compDigest(undefined, 0), 'a nonsense active take reads as 0');

  // A clip with no comp at all digests to a short constant, so adding the field
  // to a freeze signature cannot change what an un-comped document hashes to
  // beyond appending this one token.
  assert.equal(compDigest(undefined, undefined), '0#');
}

// ── 7. isComped ──────────────────────────────────────────────────────────────
{
  const take = (id: string): ClipTake => ({
    id, label: id, audioBlob: null as unknown as Blob, mimeType: 'audio/wav',
    sourceDuration: 4, offsetIntoSource: 0,
  });

  assert.equal(isComped({}), false, 'a plain clip is not comped');
  assert.equal(isComped({ takes: [take('a')] }), false, 'one take is not a comp');
  assert.equal(isComped({ takes: [take('a'), take('b')] }), false, 'two takes with no comp is take SWITCHING');
  assert.equal(isComped({ comp: [r(0, 0)] }), false, 'a comp with no takes is nothing');
  assert.equal(isComped({ takes: [take('a')], comp: [r(0, 0)] }), false, 'one take cannot be comped against itself');
  assert.equal(isComped({ takes: [take('a'), take('b')], comp: [] }), false, 'an empty comp is no comp');
  assert.equal(isComped({ takes: [take('a'), take('b')], comp: [r(0, 0)] }), true);
  assert.equal(isComped({ takes: [take('a'), take('b')], comp: [r(0, 0), r(2, 1)] }), true);
}

console.log('clipComp: ok');
