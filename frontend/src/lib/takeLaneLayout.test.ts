// Run with: npx tsx src/lib/takeLaneLayout.test.ts
/**
 * takeLaneLayout — the comping UI's arithmetic, with no DOM and no store.
 *
 * `lib/clipComp` owns what a comp IS; this file owns what it LOOKS like and
 * what the keyboard does to it: rows to pixels, regions to pixels, a pointer
 * position back to a take and a time, the nearest boundary to a caret, one snap
 * step of a boundary, and the SOURCE-time rebase a flatten print needs.
 *
 * The rebase is the load-bearing one. A comp is stored in CLIP-relative seconds
 * and read through the clip's stretch rate (`liveMixer.compParts`:
 * `take.offsetIntoSource + seg.startSec * rate`), while `flattenComp` demands a
 * print at rate 1 spanning `clipSourceSpanSec`. So every boundary has to move to
 * where that same SOURCE moment lands at rate 1 — which is what the invariant
 * assertions below check directly, rather than checking the multiplication.
 */
import assert from 'node:assert/strict';
import { COMP_BOUNDARY_EPS, type CompRegion } from './clipComp.ts';
import {
  COMP_CROSSFADE_CHOICES_MS,
  compBoundaryHandles,
  compRegionIndexAt,
  compRegionSpans,
  laneComp,
  flattenPrintClip,
  flattenPrintComp,
  laneSecAtX,
  nearestCompBoundary,
  steppedBoundarySec,
  takeLaneIndexAtY,
  takeLaneRows,
} from './takeLaneLayout.ts';
import { clipSourceSpanSec, type AudioClip, type ClipTake } from '../state/editorStore.ts';

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/* ── rows ──────────────────────────────────────────────────────────────────── */
{
  // Three takes over 60px: equal rows that between them cover the whole box,
  // with no gap at the bottom from a floor() that lost the remainder.
  const rows = takeLaneRows(3, 60);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.takeIndex), [0, 1, 2]);
  assert.ok(near(rows[0].topPx, 0));
  assert.ok(near(rows[2].topPx + rows[2].heightPx, 60), 'the last row ends at the bottom');
  for (const r of rows) assert.ok(near(r.heightPx, 20));
}
{
  // An indivisible height still covers the box exactly.
  const rows = takeLaneRows(7, 50);
  assert.equal(rows.length, 7);
  assert.ok(near(rows[6].topPx + rows[6].heightPx, 50));
  for (let i = 1; i < rows.length; i += 1) assert.ok(near(rows[i].topPx, rows[i - 1].topPx + rows[i - 1].heightPx));
}
{
  // Nothing to draw: no takes, no height, or a nonsense height.
  assert.deepEqual(takeLaneRows(0, 60), []);
  assert.deepEqual(takeLaneRows(3, 0), []);
  assert.deepEqual(takeLaneRows(3, Number.NaN), []);
  assert.deepEqual(takeLaneRows(-2, 60), []);
}

/* ── y → take ──────────────────────────────────────────────────────────────── */
{
  assert.equal(takeLaneIndexAtY(0, 3, 60), 0);
  assert.equal(takeLaneIndexAtY(19.9, 3, 60), 0);
  assert.equal(takeLaneIndexAtY(20, 3, 60), 1);
  assert.equal(takeLaneIndexAtY(59.9, 3, 60), 2);
  // The very bottom edge belongs to the last row rather than to nothing: a
  // pointer released exactly on the box edge must still pick a take.
  assert.equal(takeLaneIndexAtY(60, 3, 60), 2);
  // Outside the box, and nonsense, pick nothing at all.
  assert.equal(takeLaneIndexAtY(-1, 3, 60), null);
  assert.equal(takeLaneIndexAtY(61, 3, 60), null);
  assert.equal(takeLaneIndexAtY(Number.NaN, 3, 60), null);
  assert.equal(takeLaneIndexAtY(10, 0, 60), null);
}

/* ── x → seconds ───────────────────────────────────────────────────────────── */
{
  // Pixels are clip-relative, so x is divided by the zoom and held inside the
  // clip box — a drag that ran off the end picks the clip's last instant, not a
  // time the comp model would refuse.
  assert.ok(near(laneSecAtX(100, 50, 8), 2));
  assert.ok(near(laneSecAtX(-30, 50, 8), 0));
  assert.ok(near(laneSecAtX(10_000, 50, 8), 8));
  assert.ok(near(laneSecAtX(100, 0, 8), 0), 'a zero zoom cannot divide');
  assert.ok(near(laneSecAtX(Number.NaN, 50, 8), 0));
}

/* ── regions → spans ───────────────────────────────────────────────────────── */
const COMP: CompRegion[] = [
  { startSec: 0, takeIndex: 0 },
  { startSec: 2, takeIndex: 1, crossfadeSec: 0.025 },
  { startSec: 5, takeIndex: 2 },
];
{
  const spans = compRegionSpans(COMP, 8, 50);
  assert.equal(spans.length, 3);
  // `index` is the index in the STORED array, because that is what
  // `moveCompBoundary` / `setCompCrossfade` name.
  assert.deepEqual(spans.map((s) => s.index), [0, 1, 2]);
  assert.deepEqual(spans.map((s) => s.takeIndex), [0, 1, 2]);
  assert.deepEqual(spans.map((s) => s.startSec), [0, 2, 5]);
  assert.deepEqual(spans.map((s) => s.endSec), [2, 5, 8], 'the last region runs to the clip end');
  assert.deepEqual(spans.map((s) => s.leftPx), [0, 100, 250]);
  assert.deepEqual(spans.map((s) => s.widthPx), [100, 150, 150]);
  assert.deepEqual(spans.map((s) => s.crossfadeSec), [0, 0.025, 0]);
}
{
  // Empty / degenerate inputs paint nothing rather than a zero-width sliver.
  assert.deepEqual(compRegionSpans([], 8, 50), []);
  assert.deepEqual(compRegionSpans(COMP, 0, 50), []);
  // A region starting at or past the clip end has no length and is dropped,
  // while the ones before it keep their own stored indices.
  const past = compRegionSpans([...COMP, { startSec: 8, takeIndex: 0 }], 8, 50);
  assert.deepEqual(past.map((s) => s.index), [0, 1, 2]);
}

/* ── what the lanes paint before the first pick ────────────────────────────── */
{
  // A stored comp is painted as stored, defensively copied so the paint can
  // never be written back through.
  const painted = laneComp(COMP, 0);
  assert.deepEqual(painted, COMP);
  assert.notEqual(painted[0], COMP[0]);
  // No comp yet: one region over the whole clip, naming the ACTIVE take —
  // exactly what `editorStore.setCompRegionAt` seeds before its first pick, so
  // the paint does not jump when that pick lands.
  assert.deepEqual(laneComp(undefined, 2), [{ startSec: 0, takeIndex: 2 }]);
  assert.deepEqual(laneComp([], 1), [{ startSec: 0, takeIndex: 1 }]);
  assert.deepEqual(laneComp(undefined, undefined), [{ startSec: 0, takeIndex: 0 }]);
  assert.deepEqual(laneComp([], -3), [{ startSec: 0, takeIndex: 0 }]);
  // The seeded region is the clip head, so it is never a boundary to drag.
  assert.deepEqual(compBoundaryHandles(laneComp([], 1), 8, 50), []);
}

/* ── boundary handles ──────────────────────────────────────────────────────── */
{
  const handles = compBoundaryHandles(COMP, 8, 50);
  // Region 0 opens at the clip head, which is not a boundary between two takes.
  assert.deepEqual(handles.map((h) => h.regionIndex), [1, 2]);
  assert.deepEqual(handles.map((h) => h.atSec), [2, 5]);
  assert.deepEqual(handles.map((h) => h.xPx), [100, 250]);
  assert.deepEqual(compBoundaryHandles([{ startSec: 0, takeIndex: 0 }], 8, 50), []);
  assert.deepEqual(compBoundaryHandles([], 8, 50), []);
}

/* ── the region under a time ───────────────────────────────────────────────── */
{
  assert.equal(compRegionIndexAt(COMP, 0), 0);
  assert.equal(compRegionIndexAt(COMP, 1.99), 0);
  assert.equal(compRegionIndexAt(COMP, 2), 1, 'a boundary belongs to the region it opens');
  assert.equal(compRegionIndexAt(COMP, 4.9), 1);
  assert.equal(compRegionIndexAt(COMP, 7.5), 2);
  // Before the head and off the end still resolve: the comp covers the clip.
  assert.equal(compRegionIndexAt(COMP, -1), 0);
  assert.equal(compRegionIndexAt(COMP, 99), 2);
  assert.equal(compRegionIndexAt([], 3), null);
  assert.equal(compRegionIndexAt(COMP, Number.NaN), null);
}

/* ── the nearest boundary to the caret ─────────────────────────────────────── */
{
  assert.equal(nearestCompBoundary(COMP, 0), 1);
  assert.equal(nearestCompBoundary(COMP, 3.4), 1);
  assert.equal(nearestCompBoundary(COMP, 3.6), 2);
  assert.equal(nearestCompBoundary(COMP, 99), 2);
  // A tie goes to the EARLIER boundary, so the answer never depends on float
  // noise in whichever comparison ran first.
  assert.equal(nearestCompBoundary(COMP, 3.5), 1);
  // One region is a clip with no boundary at all.
  assert.equal(nearestCompBoundary([{ startSec: 0, takeIndex: 0 }], 1), null);
  assert.equal(nearestCompBoundary([], 1), null);
  assert.equal(nearestCompBoundary(COMP, Number.NaN), null);
}

/* ── one snap step of a boundary ───────────────────────────────────────────── */
{
  // `]` walks forward by the snap step, `[` back.
  assert.ok(near(steppedBoundarySec(COMP, 1, 1, 0.5, 8) as number, 2.5));
  assert.ok(near(steppedBoundarySec(COMP, 1, -1, 0.5, 8) as number, 1.5));
  // Held strictly between the neighbours, exactly as `clipComp.moveBoundary`
  // does — a step that would collapse a region lands a hair short of it.
  assert.ok(near(steppedBoundarySec(COMP, 1, -1, 99, 8) as number, COMP_BOUNDARY_EPS));
  assert.ok(near(steppedBoundarySec(COMP, 1, 1, 99, 8) as number, 5 - COMP_BOUNDARY_EPS));
  assert.ok(near(steppedBoundarySec(COMP, 2, 1, 99, 8) as number, 8 - COMP_BOUNDARY_EPS));
  // Region 0 is the clip head, not a boundary; so is an index off the end.
  assert.equal(steppedBoundarySec(COMP, 0, 1, 0.5, 8), null);
  assert.equal(steppedBoundarySec(COMP, 3, 1, 0.5, 8), null);
  assert.equal(steppedBoundarySec(COMP, 1, 1, Number.NaN, 8), null);
  assert.equal(steppedBoundarySec(COMP, 1, 1, 0.5, 0), null);
}
{
  // Neighbours closer together than two epsilons leave the boundary between
  // them nowhere legal to go, so nothing is written at all.
  const tight: CompRegion[] = [
    { startSec: 0, takeIndex: 0 },
    { startSec: 1, takeIndex: 1 },
    { startSec: 1 + COMP_BOUNDARY_EPS / 2, takeIndex: 2 },
    { startSec: 1 + COMP_BOUNDARY_EPS, takeIndex: 0 },
  ];
  assert.equal(steppedBoundarySec(tight, 2, 1, 0.5, 8), null);
  assert.equal(steppedBoundarySec(tight, 2, -1, 0.5, 8), null);
  // Its neighbours, which DO have room, still move.
  assert.ok(near(steppedBoundarySec(tight, 1, -1, 0.5, 8) as number, 0.5));
}

/* ── the crossfade menu ────────────────────────────────────────────────────── */
{
  assert.deepEqual([...COMP_CROSSFADE_CHOICES_MS], [0, 10, 25, 50, 100]);
}

/* ── the flatten print: same SOURCE moments, at rate 1 ─────────────────────── */
const blobOf = (t: string): Blob => new Blob([t]);
const take = (id: string, offsetIntoSource: number): ClipTake => ({
  id, label: id.toUpperCase(), audioBlob: blobOf(id), mimeType: 'audio/wav',
  sourceDuration: 30, offsetIntoSource,
});
const clipWith = (over: Partial<AudioClip>): AudioClip => ({
  id: 'c1', trackId: 't1', label: 'vox', audioBlob: blobOf('a'), mimeType: 'audio/wav',
  sourceDuration: 30, offsetIntoSource: 1.5, durationSec: 8, startSec: 12, color: '#fff',
  fadeInSec: 0.4, fadeOutSec: 0.6, gain: 0.5, muted: true,
  takes: [take('a', 1.5), take('b', 2.5), take('c', 0.25)],
  activeTakeIndex: 0, comp: COMP.map((r) => ({ ...r })),
  ...over,
});

/** Where region `i` reads its take's source, for a clip played at `rate`. */
const sourceMomentOf = (clip: AudioClip, i: number, rate: number): number =>
  (clip.takes as ClipTake[])[(clip.comp as CompRegion[])[i].takeIndex].offsetIntoSource
  + (clip.comp as CompRegion[])[i].startSec * rate;

for (const rate of [1, 2, 0.5, 1.25]) {
  const clip = clipWith({ timeStretchRate: rate });
  const print = flattenPrintClip(clip);
  const printComp = print.comp as CompRegion[];
  assert.equal(printComp.length, COMP.length);
  // THE INVARIANT: each region reads the same source second as it did live.
  for (let i = 0; i < printComp.length; i += 1) {
    assert.ok(
      near(sourceMomentOf(print, i, 1), sourceMomentOf(clip, i, rate), 1e-9),
      `region ${i} reads the same source moment at rate ${rate}`,
    );
  }
  // The print is a SOURCE: rate 1, over every source second the clip reads, so
  // `flattenComp`'s length check passes on exactly this render.
  assert.equal(print.timeStretchRate, 1);
  assert.ok(near(print.durationSec, clipSourceSpanSec(clip)));
  assert.ok(near(clipSourceSpanSec(print), print.durationSec));
  assert.equal(print.startSec, 0, 'the print starts at the head of its own render');
  // The clip's own properties are NOT printed — the clip keeps reading its
  // print through all of them.
  assert.equal(print.gain, 1);
  assert.equal(print.muted, false);
  assert.equal(print.fadeInSec, 0);
  assert.equal(print.fadeOutSec, 0);
  assert.equal(print.warpMarkers, undefined);
  assert.notEqual(print.id, clip.id, 'the print is its own clip, never the document one');
  assert.equal(print.trackId, clip.trackId, 'the render still needs a track to group under');
  // The takes ride along by reference: the print is a re-scoped view of the
  // same audio, never a copy of the bytes.
  assert.equal(print.takes, clip.takes);
  assert.equal(print.activeTakeIndex, clip.activeTakeIndex);
  assert.equal(print.audioBlob, clip.audioBlob);
  // The source document is untouched.
  assert.deepEqual(clip.comp, COMP);
}
{
  // The crossfade is a length in the same clock as the boundaries, so it rides
  // the same rebase — a 25 ms seam at rate 2 is 50 ms of SOURCE.
  const print = flattenPrintClip(clipWith({ timeStretchRate: 2 }));
  assert.ok(near((print.comp as CompRegion[])[1].crossfadeSec as number, 0.05));
  const unity = flattenPrintClip(clipWith({ timeStretchRate: 1 }));
  assert.ok(near((unity.comp as CompRegion[])[1].crossfadeSec as number, 0.025));
}
{
  // 'offline' has the stretch already baked into the blob, so it plays at unity
  // and the rebase is the identity — the same rule `clipStretchRate` states.
  const print = flattenPrintClip(clipWith({ timeStretchRate: 2, stretchMode: 'offline' }));
  assert.ok(near(print.durationSec, 8));
  assert.deepEqual(print.comp, COMP);
}
{
  // The rebase alone, without a clip around it.
  assert.deepEqual(flattenPrintComp(COMP, 1), COMP);
  assert.deepEqual(flattenPrintComp(undefined, 2), []);
  assert.deepEqual(flattenPrintComp([], 2), []);
  // A rate that is not a rate leaves the comp where it is rather than sending
  // every boundary to NaN.
  assert.deepEqual(flattenPrintComp(COMP, Number.NaN), COMP);
  assert.deepEqual(flattenPrintComp(COMP, 0), COMP);
  // No `crossfadeSec` KEY is invented where there was none, so the regions
  // still compare and serialize the way `clipComp` writes them.
  assert.ok(!('crossfadeSec' in flattenPrintComp(COMP, 2)[0]));
}

console.log('takeLaneLayout: all assertions passed');
