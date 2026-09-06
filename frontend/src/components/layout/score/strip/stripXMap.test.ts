import assert from 'node:assert/strict';

import type { CursorStep, ScoreTimeMap } from '../../scoreTimeMap.ts';
import {
  buildStripXMap,
  createScrollFollower,
  fitZoomForHeight,
  fitZoomForWidth,
  STRIP_MAX_WIDTH_PX,
  STRIP_SIZE_NOTICE,
  STRIP_ZOOM_MAX,
  STRIP_ZOOM_MIN,
  stripContentWidthPx,
  stripStepIndexAtSeconds,
  stripSystemCount,
  xAtSeconds,
  type OsmdLike,
} from './stripXMap.ts';

// Run with: npx tsx src/components/layout/score/strip/stripXMap.test.ts

/** A graphical measure at OSMD unit `x` with unit `width`. */
const gm = (x: number, width: number) => ({
  PositionAndShape: { AbsolutePosition: { x }, Size: { width } },
});

/** Two whole-note measures side by side: [0,100) and [100,200) in units. */
const makeOsmd = (): OsmdLike => ({
  GraphicSheet: { MeasureList: [[gm(0, 100)], [gm(100, 100)]] },
  Sheet: {
    SourceMeasures: [
      { AbsoluteTimestamp: { RealValue: 0 }, Duration: { RealValue: 1 } },
      { AbsoluteTimestamp: { RealValue: 1 }, Duration: { RealValue: 1 } },
    ],
  },
});

const makeMap = (steps: CursorStep[]): ScoreTimeMap => ({
  steps,
  totalSeconds: steps.length ? steps[steps.length - 1].seconds + 1 : 0,
  bpmUsed: 120,
  statedTempo: false,
  truncated: false,
});

const steps: CursorStep[] = [
  { seconds: 0, wholeNotes: 0, measureIndex: 0 },
  { seconds: 1, wholeNotes: 0.5, measureIndex: 0 },
  { seconds: 2, wholeNotes: 1, measureIndex: 1 },
  { seconds: 3, wholeNotes: 1.5, measureIndex: 1 },
];
const map = makeMap(steps);

// ---------------------------------------------------------------------------
// Proportional placement inside each measure, 10 px per unit at zoom 1.
{
  const xmap = buildStripXMap(makeOsmd(), map, 1);
  assert.ok(xmap.stepX instanceof Float64Array, 'stepX is a Float64Array');
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 1000, 1500], 'stepX at zoom 1');
  assert.equal(xmap.widthPx, 2000, 'widthPx is the right edge of the last measure');
}

// Zoom scales x and width linearly.
{
  const xmap = buildStripXMap(makeOsmd(), map, 2);
  assert.deepEqual(Array.from(xmap.stepX), [0, 1000, 2000, 3000], 'stepX at zoom 2');
  assert.equal(xmap.widthPx, 4000, 'widthPx at zoom 2');
}

// A non-finite or non-positive zoom is treated as 1 rather than collapsing.
{
  const xmap = buildStripXMap(makeOsmd(), map, Number.NaN);
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 1000, 1500], 'NaN zoom falls back to 1');
  const zero = buildStripXMap(makeOsmd(), map, 0);
  assert.deepEqual(Array.from(zero.stepX), [0, 500, 1000, 1500], 'zero zoom falls back to 1');
}

// A step past the end of its measure's duration is pinned to the right edge.
{
  const overflow = makeMap([
    { seconds: 0, wholeNotes: 0, measureIndex: 0 },
    { seconds: 1, wholeNotes: 1.25, measureIndex: 0 },
  ]);
  const xmap = buildStripXMap(makeOsmd(), overflow, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 1000], 'fraction clamps to 1');
}

// ---------------------------------------------------------------------------
// xAtSeconds: linear between steps, pinned at both ends.
{
  const xmap = buildStripXMap(makeOsmd(), map, 1);
  assert.equal(xAtSeconds(map, xmap, 0.5), 250, 'lerp half way through the first step');
  assert.equal(xAtSeconds(map, xmap, 1), 500, 'exactly on a step');
  assert.equal(xAtSeconds(map, xmap, 2.5), 1250, 'lerp inside a later step');
  assert.equal(xAtSeconds(map, xmap, 3), 1500, 'on the last step');
  assert.equal(xAtSeconds(map, xmap, 99), 1500, 'beyond the end returns the last x');
  assert.equal(xAtSeconds(map, xmap, -5), 0, 'before the start returns the first x');
}

// Two steps at the same second (a chord split across staves) do not divide
// by zero; the earlier step's x wins until the clock passes it.
{
  const dup = makeMap([
    { seconds: 0, wholeNotes: 0, measureIndex: 0 },
    { seconds: 1, wholeNotes: 0.5, measureIndex: 0 },
    { seconds: 1, wholeNotes: 0.5, measureIndex: 0 },
    { seconds: 2, wholeNotes: 1, measureIndex: 1 },
  ]);
  const xmap = buildStripXMap(makeOsmd(), dup, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 500, 1000]);
  const x = xAtSeconds(dup, xmap, 1);
  assert.ok(Number.isFinite(x), 'no NaN from a zero-length span');
  assert.equal(x, 500);
  assert.equal(xAtSeconds(dup, xmap, 1.5), 750, 'lerp resumes after the duplicate');
}

// Empty map: everything degrades to 0 and never throws.
{
  const empty = makeMap([]);
  const xmap = buildStripXMap(makeOsmd(), empty, 1);
  assert.equal(xmap.stepX.length, 0);
  assert.equal(xmap.widthPx, 2000, 'width still comes from the graphical measures');
  assert.equal(xAtSeconds(empty, xmap, 1), 0);
  assert.equal(stripStepIndexAtSeconds([], 1), -1);
}

// stripStepIndexAtSeconds mirrors scoreTimeMap.findStepIndexBySeconds.
{
  assert.equal(stripStepIndexAtSeconds(steps, -1), 0, 'before first -> 0');
  assert.equal(stripStepIndexAtSeconds(steps, 0), 0);
  assert.equal(stripStepIndexAtSeconds(steps, 0.99), 0);
  assert.equal(stripStepIndexAtSeconds(steps, 1), 1, 'exactly on a step -> that step');
  assert.equal(stripStepIndexAtSeconds(steps, 2.5), 2);
  assert.equal(stripStepIndexAtSeconds(steps, 100), 3, 'past the end -> last');
}

// ---------------------------------------------------------------------------
// Hidden measure: MeasureList[1] has no graphical measure, so steps in
// measure 1 reuse the last known x and the map stays non-decreasing.
{
  const osmd = makeOsmd();
  osmd.GraphicSheet.MeasureList[1] = [undefined];
  const xmap = buildStripXMap(osmd, map, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 500, 500], 'hidden measure reuses last x');
  assert.equal(xmap.widthPx, 1000, 'width ignores the hidden measure');
  for (let i = 1; i < xmap.stepX.length; i += 1) {
    assert.ok(xmap.stepX[i] >= xmap.stepX[i - 1], `monotonic at ${i}`);
  }
  assert.equal(xAtSeconds(map, xmap, 2.5), 500, 'x holds still through the hidden measure');
}

// A hidden FIRST measure: nothing earlier to reuse, so x starts at 0.
{
  const osmd = makeOsmd();
  osmd.GraphicSheet.MeasureList[0] = [undefined];
  const xmap = buildStripXMap(osmd, map, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 0, 1000, 1500]);
}

// A whole row missing (undefined instead of an array) behaves like a hole.
{
  const osmd = makeOsmd();
  osmd.GraphicSheet.MeasureList[1] = undefined;
  const xmap = buildStripXMap(osmd, map, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 500, 500]);
}

// A hidden FIRST staff with a visible second staff: the first defined entry
// of the row is used, so the row still contributes its geometry.
{
  const osmd = makeOsmd();
  osmd.GraphicSheet.MeasureList[1] = [undefined, gm(100, 100)];
  const xmap = buildStripXMap(osmd, map, 1);
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 1000, 1500]);
}

// Layout oddity: a later measure drawn LEFT of an earlier one can never make
// the strip scroll backwards.
{
  const osmd = makeOsmd();
  osmd.GraphicSheet.MeasureList[1] = [gm(-300, 100)];
  const xmap = buildStripXMap(osmd, map, 1);
  for (let i = 1; i < xmap.stepX.length; i += 1) {
    assert.ok(xmap.stepX[i] >= xmap.stepX[i - 1], `forced monotonic at ${i}`);
  }
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 500, 500]);
}

// Monotonicity over a longer randomised score: many measures, random widths,
// with a sprinkling of hidden measures.
{
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const measureCount = 60;
  const measureList: OsmdLike['GraphicSheet']['MeasureList'] = [];
  const sourceMeasures: OsmdLike['Sheet']['SourceMeasures'] = [];
  const longSteps: CursorStep[] = [];
  let x = 0;
  let wholes = 0;
  let sec = 0;
  for (let m = 0; m < measureCount; m += 1) {
    const width = 40 + Math.floor(rand() * 120);
    const hidden = rand() < 0.15;
    measureList.push(hidden ? [undefined] : [gm(x, width)]);
    sourceMeasures.push({
      AbsoluteTimestamp: { RealValue: wholes },
      Duration: { RealValue: 1 },
    });
    const subdiv = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < subdiv; k += 1) {
      longSteps.push({ seconds: sec, wholeNotes: wholes + k / subdiv, measureIndex: m });
      sec += 2 / subdiv;
    }
    if (!hidden) x += width;
    wholes += 1;
  }
  const osmd: OsmdLike = {
    GraphicSheet: { MeasureList: measureList },
    Sheet: { SourceMeasures: sourceMeasures },
  };
  const longMap = makeMap(longSteps);
  const xmap = buildStripXMap(osmd, longMap, 1.3);
  assert.equal(xmap.stepX.length, longSteps.length);
  for (let i = 1; i < xmap.stepX.length; i += 1) {
    assert.ok(
      Number.isFinite(xmap.stepX[i]) && xmap.stepX[i] >= xmap.stepX[i - 1],
      `random score monotonic at ${i}`,
    );
  }
  assert.ok(xmap.widthPx > 0 && xmap.stepX[xmap.stepX.length - 1] <= xmap.widthPx, 'steps stay inside the width');
  // xAtSeconds is itself monotonic across a fine time sweep.
  let prevX = -Infinity;
  for (let t = -1; t <= sec + 1; t += 0.05) {
    const xt = xAtSeconds(longMap, xmap, t);
    assert.ok(xt >= prevX, `xAtSeconds monotonic at t=${t.toFixed(2)}`);
    prevX = xt;
  }
}

// ---------------------------------------------------------------------------
// fitZoomForHeight: (pane - 8) / content, clamped to the shared zoom bounds.
{
  assert.equal(STRIP_ZOOM_MIN, 0.4, 'matches scoreShared ZOOM_MIN');
  assert.equal(STRIP_ZOOM_MAX, 3, 'matches scoreShared ZOOM_MAX');
  // 200 px of content at zoom 1 into a 408 px pane -> zoom 2.
  assert.equal(fitZoomForHeight(200, 408, 1), 2, 'scales up to fill the pane');
  // Measured at zoom 2, 400 px of content into a 208 px pane -> zoom 1.
  assert.equal(fitZoomForHeight(400, 208, 2), 1, 'accounts for the current zoom');
  assert.equal(fitZoomForHeight(10, 100_000, 1), STRIP_ZOOM_MAX, 'clamps to ZOOM_MAX');
  assert.equal(fitZoomForHeight(100_000, 100, 1), STRIP_ZOOM_MIN, 'clamps to ZOOM_MIN');
  // Degenerate measurements leave the zoom where it is (clamped).
  assert.equal(fitZoomForHeight(0, 500, 1.5), 1.5, 'no content height -> unchanged');
  assert.equal(fitZoomForHeight(300, 0, 1.5), 1.5, 'no pane height -> unchanged');
  assert.equal(fitZoomForHeight(300, 8, 1.5), 1.5, 'pane equal to padding -> unchanged');
  assert.equal(fitZoomForHeight(0, 0, 10), STRIP_ZOOM_MAX, 'unchanged still clamps');
  assert.equal(fitZoomForHeight(300, 400, Number.NaN), fitZoomForHeight(300, 400, 1), 'NaN zoom -> 1');
}

assert.equal(STRIP_SIZE_NOTICE, 4000, 'strip size notice threshold');

// ---------------------------------------------------------------------------
// The width cap: OSMD wraps a single staffline wider than 32767 px into a
// second system whose measures restart at x 0. The x map (by design) pins
// those measures to the right edge, so the view must detect the wrap and
// lower the zoom; these helpers are what it detects and fits with.
assert.equal(STRIP_MAX_WIDTH_PX, 32767, 'OSMD 1.9.9 SheetMaximumWidth / backend crop');

// stripSystemCount: sums MusicSystems over every page; 0 without pages.
{
  assert.equal(stripSystemCount(makeOsmd()), 0, 'no MusicPages -> 0');
  const one = makeOsmd();
  one.GraphicSheet.MusicPages = [{ MusicSystems: [{}] }];
  assert.equal(stripSystemCount(one), 1, 'one page, one system');
  const wrapped = makeOsmd();
  wrapped.GraphicSheet.MusicPages = [{ MusicSystems: [{}, {}] }];
  assert.equal(stripSystemCount(wrapped), 2, 'a wrapped single staffline');
  const pages = makeOsmd();
  pages.GraphicSheet.MusicPages = [{ MusicSystems: [{}] }, undefined, { MusicSystems: [{}, {}] }];
  assert.equal(stripSystemCount(pages), 3, 'systems summed across pages, holes skipped');
  const nul = makeOsmd();
  nul.GraphicSheet.MusicPages = null;
  assert.equal(stripSystemCount(nul), 0, 'null pages -> 0');
}

// stripContentWidthPx: sum of measure widths (+ the leftmost edge), scaled.
{
  assert.equal(stripContentWidthPx(makeOsmd(), 1), 2000, 'two 100-unit measures at zoom 1');
  assert.equal(stripContentWidthPx(makeOsmd(), 2), 4000, 'scales with zoom');
  assert.equal(stripContentWidthPx(makeOsmd(), Number.NaN), 2000, 'NaN zoom -> 1');
  const hidden = makeOsmd();
  hidden.GraphicSheet.MeasureList[1] = [undefined];
  assert.equal(stripContentWidthPx(hidden, 1), 1000, 'hidden measures add nothing');
  const offset = makeOsmd();
  offset.GraphicSheet.MeasureList = [[gm(5, 100)], [gm(105, 100)]];
  assert.equal(stripContentWidthPx(offset, 1), 2050, 'the left margin counts once');
  const empty = makeOsmd();
  empty.GraphicSheet.MeasureList = [[undefined], [undefined]];
  assert.equal(stripContentWidthPx(empty, 1), 0, 'nothing rendered -> 0');
  // A WRAPPED render: measure 2 restarted at x 0 on a second system. The
  // x map's right edge only sees the widest system, the content width sees
  // both, which is why the view fits on the latter.
  const wrapped = makeOsmd();
  wrapped.GraphicSheet.MeasureList = [[gm(0, 100)], [gm(0, 60)]];
  wrapped.GraphicSheet.MusicPages = [{ MusicSystems: [{}, {}] }];
  const xmap = buildStripXMap(wrapped, map, 1);
  assert.equal(xmap.widthPx, 1000, 'widthPx reports only the widest system');
  assert.deepEqual(Array.from(xmap.stepX), [0, 500, 500, 500], 'wrapped measures pin (the defect the fit removes)');
  assert.equal(stripContentWidthPx(wrapped, 1), 1600, 'content width sums both systems');
}

// fitZoomForWidth: only ever lowers, aims 2% under the cap, clamps.
{
  const cap = STRIP_MAX_WIDTH_PX;
  assert.equal(fitZoomForWidth(20_000, cap, 1), 1, 'fits already -> unchanged');
  assert.equal(fitZoomForWidth(cap * 0.98, cap, 0.7), 0.7, 'exactly at the target -> unchanged');
  const fitted = fitZoomForWidth(40_000, cap, 1);
  assert.ok(Math.abs(fitted - (cap * 0.98) / 40_000) < 1e-9, 'fitted zoom is target / content');
  assert.ok(fitted < 1 && 40_000 * fitted <= cap * 0.98 + 1e-6, 'the fitted strip is under the cap');
  // Measured at zoom 0.64: the band score needs ~41000 px -> ~0.50.
  const band = fitZoomForWidth(41_052, cap, 0.64);
  assert.ok(band > 0.49 && band < 0.51, 'band score 0.64 -> about 0.50');
  assert.equal(fitZoomForWidth(10_000_000, cap, 1), STRIP_ZOOM_MIN, 'clamps to ZOOM_MIN');
  assert.equal(fitZoomForWidth(100, cap, 10), STRIP_ZOOM_MAX, 'an out-of-range zoom is clamped even when it fits');
  assert.equal(fitZoomForWidth(0, cap, 0.8), 0.8, 'no content width -> unchanged');
  assert.equal(fitZoomForWidth(50_000, 0, 0.8), 0.8, 'no cap -> unchanged');
  assert.equal(fitZoomForWidth(50_000, cap, Number.NaN), fitZoomForWidth(50_000, cap, 1), 'NaN zoom -> 1');
  // Idempotent: fitting the fitted result changes nothing.
  const once = fitZoomForWidth(60_000, cap, 1.2);
  assert.equal(fitZoomForWidth(60_000 * (once / 1.2), cap, once), once, 'fixed point after one pass');
}

// createScrollFollower: a plateau-then-jump target becomes one forward glide
// with no step; a seek snaps; a steady target is tracked with a small lag.
{
  const f = createScrollFollower();
  assert.equal(f.step(100, 0, 1000), 100, 'the first frame snaps to the target');
  // Steady 60 px/s target at 60 fps: the follower keeps up within a notehead
  // and never moves backwards.
  let prev = 100;
  let t = 0;
  for (let i = 1; i <= 120; i += 1) {
    t = i / 60;
    const x = f.step(100 + 60 * t, t, 1000);
    assert.ok(x >= prev - 1e-9, `never backwards (frame ${i})`);
    prev = x;
  }
  const lag = 100 + 60 * t - prev;
  assert.ok(lag >= 0 && lag < 20, `steady lag ${lag.toFixed(1)} px stays under a notehead`);
  // A plateau (the target stands still 0.5 s) then a 90 px jump: no frame
  // moves more than a few px, and the follower arrives.
  const hold = prev;
  const targetJump = 100 + 60 * t + 90;
  let maxStep = 0;
  let x = prev;
  for (let i = 1; i <= 90; i += 1) {
    const tt = t + i / 60;
    const target = i <= 30 ? 100 + 60 * t : targetJump;
    const nx = f.step(target, tt, 1000);
    maxStep = Math.max(maxStep, Math.abs(nx - x));
    assert.ok(nx >= x - 1e-9, `no backward drift after the plateau (frame ${i})`);
    x = nx;
  }
  assert.ok(x >= hold, 'moved forward over the plateau + jump');
  assert.ok(maxStep < 25, `largest single-frame move ${maxStep.toFixed(1)} px is a glide, not a step`);
  assert.ok(Math.abs(targetJump - x) < 5, `arrived within 5 px of the jump target (${(targetJump - x).toFixed(1)})`);
  // A seek (further than 60% of the pane) snaps.
  assert.equal(f.step(5000, t + 2, 1000), 5000, 'a far target snaps');
  assert.equal(f.step(20, t + 2.02, 1000), 20, 'a far target behind snaps too');
  // snap() resets the motion state.
  assert.equal(f.snap(300), 300);
  assert.equal(f.step(300, 10, 1000), 300, 'no motion at the target');
  // Degenerate input keeps the last position.
  assert.equal(f.step(Number.NaN, 10.1, 1000), 300, 'NaN target -> stay');
}

console.log('stripXMap tests passed');
