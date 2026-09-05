/**
 * node:assert regression for the measure-and-fit zoom maths.
 * Run: cd frontend && npx tsx src/components/layout/score/scoreFit.test.ts
 */
import assert from 'node:assert/strict';
import {
  FIT_FLOOR,
  FIT_MARGIN_KEEP,
  FIT_MAX_EXTRA_PASSES,
  FIT_SLACK,
  computeFitZoom,
  fitReport,
  fitZoomToPage,
  measureSystems,
  printableHeight,
  tallestSystemBottom,
  usableHeight,
  worthAnotherPass,
  type OsmdFitLike,
  type SystemExtent,
} from './scoreFit.ts';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// A4 portrait page height in OSMD units for a container width in CSS px.
const A4 = 297 / 210;
const pageHeightUnits = (pageWidthPx: number, zoom: number) => (pageWidthPx / zoom / 10) * A4;
const BOTTOM = 14;

// ---- computeFitZoom -------------------------------------------------------
{
  // ScoreView defaults: 520 px, zoom 0.64 → page 114.9 units, usable 100.9.
  const pageH = pageHeightUnits(520, 0.64);
  close(pageH, 114.91, 0.01);
  close(printableHeight({ PageHeight: pageH, PageBottomMargin: BOTTOM }), 100.91, 0.01);
  // The fit target keeps 30 % of the margin (4.2 units) clear: 110.7.
  assert.equal(FIT_MARGIN_KEEP, 0.3);
  close(usableHeight({ PageHeight: pageH, PageBottomMargin: BOTTOM }), 114.91 - 4.2, 0.01);

  // Everything fits → zoom unchanged (exact same number back).
  const fits: SystemExtent[] = [
    { y: 10, borderBottom: 20 },
    { y: 40, borderBottom: 25 },
    { y: 70, borderBottom: 29 },
  ];
  assert.equal(computeFitZoom(fits, pageH, BOTTOM, 0.64), 0.64);
  // Exactly on the usable line still fits (<=).
  const onTheLine: SystemExtent[] = [{ y: 0, borderBottom: pageH - BOTTOM * FIT_MARGIN_KEEP }];
  assert.equal(computeFitZoom(onTheLine, pageH, BOTTOM, 0.64), 0.64);
  // The real lead sheet: its bottomline runs 8.8 units into the 14-unit margin
  // (tallest 109.7 at 520 px / 0.64). That has always rendered fine and must
  // stay at 64 % — the whole reason the target is not the strict printable line.
  const leadSheet: SystemExtent[] = [{ y: 80.7, borderBottom: 29 }];
  close(tallestSystemBottom(leadSheet), 109.7);
  assert.ok(tallestSystemBottom(leadSheet) > printableHeight({ PageHeight: pageH, PageBottomMargin: BOTTOM }));
  assert.equal(computeFitZoom(leadSheet, pageH, BOTTOM, 0.64), 0.64);

  // The measured band-score page-1 system: 161 units tall vs 110.7 usable.
  const tall: SystemExtent[] = [{ y: 0, borderBottom: 161.0 }];
  const usable = pageH - BOTTOM * FIT_MARGIN_KEEP;
  const expected = 0.64 * (usable / 161.0) * FIT_SLACK;
  close(computeFitZoom(tall, pageH, BOTTOM, 0.64), expected);
  assert.ok(expected < 0.64 && expected > FIT_FLOOR);

  // Never below the floor.
  const huge: SystemExtent[] = [{ y: 0, borderBottom: 10_000 }];
  assert.equal(computeFitZoom(huge, pageH, BOTTOM, 0.64), FIT_FLOOR);
  assert.equal(computeFitZoom(huge, pageH, BOTTOM, 0.64, 0.5), 0.5);
  // Bad floor falls back to the default floor.
  assert.equal(computeFitZoom(huge, pageH, BOTTOM, 0.64, NaN), FIT_FLOOR);
  assert.equal(computeFitZoom(huge, pageH, BOTTOM, 0.64, 0), FIT_FLOOR);

  // Only ever shrinks: a zoom already below what the ratio suggests stays.
  assert.equal(computeFitZoom(fits, pageH, BOTTOM, 0.35), 0.35);

  // Degenerate inputs leave zoom alone.
  assert.equal(computeFitZoom([], pageH, BOTTOM, 0.64), 0.64);
  assert.equal(computeFitZoom(tall, 0, BOTTOM, 0.64), 0.64);
  assert.equal(computeFitZoom(tall, NaN, BOTTOM, 0.64), 0.64);
  assert.equal(computeFitZoom(tall, 4, 14, 0.64), 0.64); // usable <= 0 (4 - 4.2)
  assert.ok(Number.isNaN(computeFitZoom(tall, pageH, BOTTOM, NaN)));
  assert.equal(computeFitZoom(tall, pageH, BOTTOM, 0), 0);
  // A NaN system is ignored, not propagated.
  const withNaN: SystemExtent[] = [{ y: NaN, borderBottom: 5 }, { y: 0, borderBottom: 30 }];
  assert.equal(tallestSystemBottom(withNaN), 30);
  assert.equal(computeFitZoom(withNaN, pageH, BOTTOM, 0.64), 0.64);
}

// ---- tallestSystemBottom / usableHeight -------------------------------------
{
  assert.equal(tallestSystemBottom([]), 0);
  assert.equal(
    tallestSystemBottom([
      { y: 5, borderBottom: 10 },
      { y: 50, borderBottom: 40 },
      { y: 80, borderBottom: 5 },
    ]),
    90,
  );
  assert.equal(usableHeight(null), 0);
  assert.equal(usableHeight({}), 0);
  assert.equal(usableHeight({ PageHeight: 100 }), 100);
  assert.equal(usableHeight({ PageHeight: 100, PageBottomMargin: NaN }), 100);
  close(usableHeight({ PageHeight: 100, PageBottomMargin: 14 }), 95.8);
  assert.equal(printableHeight(null), 0);
  assert.equal(printableHeight({ PageHeight: 100 }), 100);
  assert.equal(printableHeight({ PageHeight: 100, PageBottomMargin: 14 }), 86);
  assert.equal(printableHeight({ PageHeight: NaN, PageBottomMargin: 14 }), 0);
}

// ---- measureSystems on an OSMD-shaped object -----------------------------------
{
  const osmd: OsmdFitLike = {
    GraphicSheet: {
      MusicPages: [
        {
          MusicSystems: [
            { PositionAndShape: { AbsolutePosition: { y: 10 }, BorderBottom: 20 } },
            null,
            { PositionAndShape: null },
            { PositionAndShape: { AbsolutePosition: { y: 40 }, BorderBottom: NaN } },
            { PositionAndShape: { AbsolutePosition: {}, BorderBottom: 5 } },
          ],
        },
        null,
        { MusicSystems: null },
        { MusicSystems: [{ PositionAndShape: { AbsolutePosition: { y: 3 }, BorderBottom: 150 } }] },
      ],
    },
    EngravingRules: { PageHeight: 114.91, PageBottomMargin: 14 },
  };
  assert.deepEqual(measureSystems(osmd), [
    { y: 10, borderBottom: 20 },
    { y: 3, borderBottom: 150 },
  ]);
  const report = fitReport(osmd);
  assert.equal(report.systems, 2);
  assert.equal(report.tallestBottom, 153);
  close(report.usable, 110.71);
  close(report.printable, 100.91);
  assert.equal(report.pageHeight, 114.91);
  assert.equal(report.bottomMargin, 14);
  assert.equal(report.overflows, true);
  const empty = { tallestBottom: 0, usable: 0, printable: 0, pageHeight: 0, bottomMargin: 0, systems: 0, overflows: false };
  assert.deepEqual(fitReport({}), empty);
  assert.deepEqual(fitReport({ GraphicSheet: null, EngravingRules: null }), empty);
}

// ---- worthAnotherPass ---------------------------------------------------------
{
  assert.equal(worthAnotherPass(0.64, 0.5), true);
  assert.equal(worthAnotherPass(0.64, 0.64), false);
  assert.equal(worthAnotherPass(0.64, 0.7), false);
  assert.equal(worthAnotherPass(0.64, 0.639), false); // < 0.5 % — not worth a re-render
  assert.equal(worthAnotherPass(0.64, 0.63), true);
  assert.equal(worthAnotherPass(NaN, 0.5), false);
  assert.equal(worthAnotherPass(0.64, NaN), false);
  assert.equal(worthAnotherPass(0, 0), false);
}

// ---- fitZoomToPage: a simulated renderer ---------------------------------------
// System heights in OSMD units do not change with zoom; the page height does
// (pageWidthPx / zoom / 10 * A4). That is exactly why lowering zoom fits more.
const makeFakeOsmd = (pageWidthPx: number, systemHeights: number[], initialZoom: number) => {
  const renders: number[] = [];
  const osmd: OsmdFitLike & { Zoom: number } = {
    Zoom: initialZoom,
    EngravingRules: { PageHeight: pageHeightUnits(pageWidthPx, initialZoom), PageBottomMargin: BOTTOM },
    GraphicSheet: { MusicPages: [] },
  };
  const layout = () => {
    // One system per page, each starting at a 5.5-unit top margin.
    osmd.GraphicSheet = {
      MusicPages: systemHeights.map((h) => ({
        MusicSystems: [{ PositionAndShape: { AbsolutePosition: { y: 5.5 }, BorderBottom: h } }],
      })),
    };
  };
  layout();
  const render = (zoom: number) => {
    renders.push(zoom);
    osmd.Zoom = zoom;
    osmd.EngravingRules = { PageHeight: pageHeightUnits(pageWidthPx, zoom), PageBottomMargin: BOTTOM };
    layout();
  };
  return { osmd, render, renders };
};

{
  // Lead sheet: 15–29-unit systems fit at 0.64 → no extra render, zoom untouched.
  // (The fake stacks one system per page, so heights are the whole story here.)
  const lead = makeFakeOsmd(520, [15, 22, 29, 104.2], 0.64); // 104.2 + 5.5 = 109.7, the real worst case
  const r = fitZoomToPage(lead.osmd, 0.64, lead.render);
  assert.equal(r.zoom, 0.64);
  assert.equal(r.passes, 0);
  assert.deepEqual(lead.renders, []);
  assert.equal(r.report.overflows, false);
}
{
  // The old band score: a 147-unit system at 520 px converges in one pass
  // (page height in units grows as zoom shrinks) and lands inside the page.
  const band = makeFakeOsmd(520, [147.3, 120, 130], 0.64);
  const r = fitZoomToPage(band.osmd, 0.64, band.render);
  assert.equal(r.passes, 1);
  assert.equal(band.renders.length, 1);
  assert.ok(r.zoom < 0.64 && r.zoom >= FIT_FLOOR, `zoom ${r.zoom}`);
  assert.equal(r.report.overflows, false);
  assert.ok(r.report.tallestBottom <= r.report.usable);
  close(r.zoom, computeFitZoom([{ y: 5.5, borderBottom: 147.3 }], pageHeightUnits(520, 0.64), BOTTOM, 0.64));
}
{
  // Floor: a system nothing can fit stops at FIT_FLOOR and never renders more
  // than FIT_MAX_EXTRA_PASSES times.
  const monster = makeFakeOsmd(360, [900], 0.64);
  const r = fitZoomToPage(monster.osmd, 0.64, monster.render);
  assert.equal(r.zoom, FIT_FLOOR);
  assert.ok(r.passes <= FIT_MAX_EXTRA_PASSES);
  assert.equal(r.passes, 1); // second pass would not move below the floor
  assert.equal(r.report.overflows, true); // honestly reported
}
{
  // A renderer whose reflow adds height after the first pass needs the second
  // pass, and stops there even though a third would still help.
  let calls = 0;
  const fake = makeFakeOsmd(520, [140], 0.64);
  const render = (zoom: number) => {
    calls += 1;
    fake.render(zoom);
    // Reflow surprise: every re-render grows the system by 30 units.
    fake.osmd.GraphicSheet = {
      MusicPages: [{ MusicSystems: [{ PositionAndShape: { AbsolutePosition: { y: 5.5 }, BorderBottom: 140 + 30 * calls } }] }],
    };
  };
  const r = fitZoomToPage(fake.osmd, 0.64, render);
  assert.equal(r.passes, FIT_MAX_EXTRA_PASSES);
  assert.equal(calls, FIT_MAX_EXTRA_PASSES);
  assert.equal(r.zoom, fake.osmd.Zoom);
  // maxExtraPasses: 0 measures only.
  const zeroPass = makeFakeOsmd(520, [147], 0.64);
  const r0 = fitZoomToPage(zeroPass.osmd, 0.64, zeroPass.render, { maxExtraPasses: 0 });
  assert.equal(r0.passes, 0);
  assert.equal(r0.zoom, 0.64);
  assert.equal(r0.report.overflows, true);
  // Custom floor is honoured.
  const floored = makeFakeOsmd(360, [900], 0.64);
  const rf = fitZoomToPage(floored.osmd, 0.64, floored.render, { floor: 0.5 });
  assert.equal(rf.zoom, 0.5);
}

console.log('scoreFit tests passed');
