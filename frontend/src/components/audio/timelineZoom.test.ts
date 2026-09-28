import assert from 'node:assert/strict';
import { WHEEL_PROFILES } from '../../lib/timeline/viewport';
import { formatRangeReadout } from './timelineInteraction';
import {
  CLIP_EDGE_ZONE_PX,
  MIN_CONTENT_WIDTH_PX,
  RULER_BAR_LABEL_MIN_PX,
  RULER_CHAR_MAX_PX,
  RULER_TIME_LABEL_MIN_PX,
  ZOOM_FOLLOW_HOLD_MS,
  barLabelUnderReadout,
  clipChromeLayout,
  createZoomCoalescer,
  fitProjectZoom,
  fitRangeZoom,
  followHoldActive,
  localViewportWidth,
  planZoom,
  resolveAnchorSec,
  rulerBarLabels,
  rulerReadoutSpanPx,
  rulerTimeTicks,
  shouldRescrollAfterZoom,
  spanOfClips,
  viewportWindowSec,
  wheelDispatch,
} from './timelineZoom';

const BOUNDS = { min: 0.25, max: 400 };
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// --- Viewport width: viewport px -> local px, header column excluded --------
{
  // Unscaled, scroller only.
  assert.equal(localViewportWidth({ rectWidthPx: 1000, layoutZoom: 1 }), 1000);
  // Shell CSS zoom 0.85: a 850 px on-screen box is 1000 local px.
  near(localViewportWidth({ rectWidthPx: 850, layoutZoom: 0.85 }), 1000);
  // A measured box that includes the 200-px (viewport px) track-header column.
  near(localViewportWidth({ rectWidthPx: 1020, layoutZoom: 0.85, headerColumnPx: 170 }), 1000);
  // Never negative.
  assert.equal(localViewportWidth({ rectWidthPx: 100, layoutZoom: 1, headerColumnPx: 300 }), 0);
  assert.throws(() => localViewportWidth({ rectWidthPx: NaN, layoutZoom: 1 }), RangeError);
  assert.throws(() => localViewportWidth({ rectWidthPx: 100, layoutZoom: 0 }), RangeError);
}

// --- Anchor: the edit cursor, clamped into the content ------------------------
{
  assert.equal(resolveAnchorSec('edit-cursor', 60, 300), 60);
  assert.equal(resolveAnchorSec('edit-cursor', 900, 300), 300);
  assert.equal(resolveAnchorSec('edit-cursor', -4, 300), 0);
  assert.equal(resolveAnchorSec({ sec: 42 }, 60, 300), 42);
  assert.throws(() => resolveAnchorSec('edit-cursor', Infinity, 300), RangeError);
}

// --- planZoom: the anchor stays centred through repeated zooms --------------
{
  const vw = 1000;
  let zoom = 10;
  for (let i = 0; i < 12; i++) {
    const next = planZoom({ requestedZoom: zoom * 1.25, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
    zoom = next.zoom;
    // Anchor time at the centre of the viewport after every step.
    near((next.scrollLeft + vw / 2) / next.zoom, 60, 1e-6);
  }
  // Zooming out to where the whole project fits: clamped to 0, not centred.
  const out = planZoom({ requestedZoom: 1, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  assert.equal(out.scrollLeft, 0);
  // Zoom is clamped to the store bounds.
  assert.equal(planZoom({ requestedZoom: 9999, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS }).zoom, 400);
  // The content is at least MIN_CONTENT_WIDTH_PX wide (the editor's own rule), so a
  // short project at a small zoom can still scroll to the min-width edge.
  const short = planZoom({ requestedZoom: 1, anchorSec: 900, totalDurationSec: 10, viewportWidth: 400, bounds: BOUNDS });
  assert.equal(short.scrollLeft, MIN_CONTENT_WIDTH_PX - 400);
  // At the end of the content the anchor cannot be centred: scroll clamps.
  const end = planZoom({ requestedZoom: 10, anchorSec: 300, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  assert.equal(end.scrollLeft, 300 * 10 - vw);
}

// --- CSS zoom + header column feed the same centring ------------------------
{
  const vw = localViewportWidth({ rectWidthPx: 1020, layoutZoom: 0.85, headerColumnPx: 170 });
  const p = planZoom({ requestedZoom: 20, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  near(p.scrollLeft, 60 * 20 - 500, 1e-6);
}

// --- Whether a zoom request should also move scrollLeft (F3 #1) -------------
{
  // At a bound: the clamp cannot move the zoom further, so an incidental
  // wheel/step nudge must not yank the view back to the anchor.
  assert.equal(shouldRescrollAfterZoom(BOUNDS.min, BOUNDS.min, false), false);
  assert.equal(shouldRescrollAfterZoom(BOUNDS.max, BOUNDS.max, false), false);
  // No-op off any bound: the requested zoom already equals the committed one.
  assert.equal(shouldRescrollAfterZoom(10, 10, false), false);
  // An explicit command (zoom to selection, zoom to fit) still moves the
  // viewport even when the zoom itself does not change.
  assert.equal(shouldRescrollAfterZoom(10, 10, true), true);
  assert.equal(shouldRescrollAfterZoom(BOUNDS.max, BOUNDS.max, true), true);
  // A real zoom change always rescrolls, explicit command or not.
  assert.equal(shouldRescrollAfterZoom(10, 20, false), true);
  assert.equal(shouldRescrollAfterZoom(10, 20, true), true);
}

// --- Fit helpers -------------------------------------------------------------
{
  // 10 s range in 1100 px with 5 % margin each side: 1100 / 11 = 100 px/s.
  const r = fitRangeZoom(10, 20, 1100);
  assert.ok(r);
  near(r.zoom, 100);
  assert.equal(r.centerSec, 15);
  assert.equal(fitRangeZoom(5, 5, 1000), null);
  assert.equal(fitRangeZoom(6, 5, 1000), null);
  assert.throws(() => fitRangeZoom(0, NaN, 1000), RangeError);

  // Project fit keeps the old rule: usable = max(200, vw - 24), anchored on the centre.
  const f = fitProjectZoom(100, 1024);
  assert.ok(f);
  near(f.zoom, 10);
  assert.equal(f.centerSec, 50);
  const pf = planZoom({ requestedZoom: f.zoom, anchorSec: f.centerSec, totalDurationSec: 100, viewportWidth: 1024, bounds: BOUNDS });
  assert.equal(pf.scrollLeft, 0);
  assert.equal(fitProjectZoom(0, 1000), null);

  assert.deepEqual(spanOfClips([{ startSec: 4, durationSec: 2 }, { startSec: 1, durationSec: 1 }]), { startSec: 1, endSec: 6 });
  assert.equal(spanOfClips([]), null);
}

// --- rAF coalescing: a wheel burst is one zoom request per frame -----------
{
  let scheduled: Array<() => void> = [];
  let cancelled = 0;
  let storeZoom = 10;
  const applied: number[] = [];
  const co = createZoomCoalescer({
    schedule: (cb) => { scheduled.push(cb); return scheduled.length; },
    cancel: () => { cancelled++; },
    readZoom: () => storeZoom,
    apply: (z) => { applied.push(z); storeZoom = z; },
    bounds: BOUNDS,
  });
  co.push(1.1);
  co.push(1.1);
  co.push(1.1);
  assert.equal(scheduled.length, 1, 'one frame scheduled for the burst');
  near(co.pending() ?? 0, 10 * 1.1 ** 3);
  scheduled[0]();
  assert.equal(applied.length, 1);
  near(applied[0], 13.31);
  assert.equal(co.pending(), null);
  // Next burst starts from the committed zoom.
  scheduled = [];
  co.push(0.5);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  near(applied[1], 13.31 * 0.5);
  // The pending target is clamped to the bounds while it accumulates.
  scheduled = [];
  for (let i = 0; i < 200; i++) co.push(2);
  assert.equal(co.pending(), 400);
  co.cancel();
  assert.equal(cancelled, 1);
  assert.equal(co.pending(), null);
  assert.throws(() => co.push(NaN), RangeError);
  assert.throws(() => co.push(0), RangeError);
}

// --- Wheel dispatch per profile ---------------------------------------------
{
  const base = { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  const lanes = { trackHeight: 100, min: 56, max: 260 };
  const td = WHEEL_PROFILES.thedaw;
  const rp = WHEEL_PROFILES.reaper;

  // theDAW: plain wheel zooms in (wheel up).
  const plain = wheelDispatch(base, td, 800, {}, lanes);
  assert.equal(plain.kind, 'zoom');
  assert.ok(plain.kind === 'zoom' && plain.factor > 1);
  // Ctrl = fine zoom: smaller step than plain.
  const fine = wheelDispatch({ ...base, ctrlKey: true }, td, 800, {}, lanes);
  assert.ok(fine.kind === 'zoom' && plain.kind === 'zoom' && fine.factor < plain.factor && fine.factor > 1);
  // Cmd counts as Ctrl.
  assert.deepEqual(wheelDispatch({ ...base, metaKey: true }, td, 800, {}, lanes), fine);
  // Speeds from prefs change the step.
  const fast = wheelDispatch(base, td, 800, { coarseSpeed: 0.004 }, lanes);
  assert.ok(fast.kind === 'zoom' && plain.kind === 'zoom' && fast.factor > plain.factor);
  // Shift = horizontal pan by the delta.
  assert.deepEqual(wheelDispatch({ ...base, shiftKey: true, deltaY: 120 }, td, 800, {}, lanes), { kind: 'scroll-x', px: 120 });
  // Alt = vertical pan.
  assert.deepEqual(wheelDispatch({ ...base, altKey: true, deltaY: 120 }, td, 800, {}, lanes), { kind: 'scroll-y', px: 120 });
  // Ctrl+Shift = lane height: wheel up by 100 px grows lanes by 25 px.
  assert.deepEqual(wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, td, 800, {}, lanes), { kind: 'lane-height', height: 125 });
  // Lane height clamps to the store bounds.
  assert.deepEqual(
    wheelDispatch({ ...base, ctrlKey: true, shiftKey: true, deltaY: 2000 }, td, 800, {}, lanes),
    { kind: 'lane-height', height: 56 },
  );
  // Lines mode (deltaMode 1) is scaled x16 before dispatch.
  assert.deepEqual(wheelDispatch({ ...base, shiftKey: true, deltaY: 3, deltaMode: 1 }, td, 800, {}, lanes), { kind: 'scroll-x', px: 48 });
  // A horizontal trackpad swipe pans time under any profile.
  assert.deepEqual(wheelDispatch({ ...base, deltaX: 40, deltaY: 5 }, rp, 800, {}, lanes), { kind: 'scroll-x', px: 40 });

  // REAPER: plain zooms, Ctrl = lane height, Alt = horizontal pan, Ctrl+Shift = fine zoom.
  assert.equal(wheelDispatch(base, rp, 800, {}, lanes).kind, 'zoom');
  assert.deepEqual(wheelDispatch({ ...base, ctrlKey: true }, rp, 800, {}, lanes), { kind: 'lane-height', height: 125 });
  assert.deepEqual(wheelDispatch({ ...base, altKey: true, deltaY: 60 }, rp, 800, {}, lanes), { kind: 'scroll-x', px: 60 });
  const rpFine = wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, rp, 800, {}, lanes);
  assert.ok(rpFine.kind === 'zoom' && plain.kind === 'zoom' && rpFine.factor < plain.factor);

  // No movement: nothing handled, so the caller does not preventDefault.
  assert.deepEqual(wheelDispatch({ ...base, deltaY: 0, shiftKey: true }, td, 800, {}, lanes), { kind: 'none' });
  assert.deepEqual(wheelDispatch({ ...base, deltaY: 0 }, td, 800, {}, lanes), { kind: 'none' });
  // Lane height already at the limit: nothing to do.
  assert.deepEqual(
    wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, td, 800, {}, { trackHeight: 260, min: 56, max: 260 }),
    { kind: 'none' },
  );
}

// --- Follow-playhead hold after a zoom --------------------------------------
{
  assert.equal(followHoldActive(1000, 1000 + ZOOM_FOLLOW_HOLD_MS), true);
  assert.equal(followHoldActive(1000 + ZOOM_FOLLOW_HOLD_MS, 1000 + ZOOM_FOLLOW_HOLD_MS), false);
  assert.equal(followHoldActive(5, 0), false);
}

// --- Grid window: visible range +-1 viewport, clamped to the content --------
{
  // zoom 10 px/s, viewport 1000 px scrolled to 2000: visible 200..300 s.
  assert.deepEqual(viewportWindowSec(2000, 1000, 10, 600), { startSec: 100, endSec: 400 });
  // At the start the window never goes negative.
  assert.deepEqual(viewportWindowSec(0, 1000, 10, 600), { startSec: 0, endSec: 200 });
  // At the end it stops at the content edge (max(total*zoom, 1000) / zoom).
  assert.deepEqual(viewportWindowSec(5000, 1000, 10, 600), { startSec: 400, endSec: 600 });
  // A short project still covers the min content width.
  assert.deepEqual(viewportWindowSec(0, 500, 1, 10), { startSec: 0, endSec: 1000 });
  assert.throws(() => viewportWindowSec(0, 500, 0, 10), RangeError);
}

// --- Ruler bar numbers -------------------------------------------------------
{
  // 120 bpm, 4/4: a bar is 2 s. At 18 px/s bars are 36 px apart: labelled.
  const labels = rulerBarLabels({ startSec: 0, endSec: 7, bpm: 120, zoom: 18 });
  assert.deepEqual(labels, [{ bar: 1, sec: 0 }, { bar: 2, sec: 2 }, { bar: 3, sec: 4 }, { bar: 4, sec: 6 }]);
  // 17 px/s: 34 px apart, too dense for bold 12 px numbers: none.
  assert.deepEqual(rulerBarLabels({ startSec: 0, endSec: 7, bpm: 120, zoom: 17 }), []);
  // Windowed: starts at the first bar inside the window.
  assert.deepEqual(rulerBarLabels({ startSec: 3, endSec: 6, bpm: 120, zoom: 50 }), [{ bar: 3, sec: 4 }, { bar: 4, sec: 6 }]);
  assert.throws(() => rulerBarLabels({ startSec: 0, endSec: 1, bpm: NaN, zoom: 10 }), RangeError);
}

// --- Ruler time ticks ---------------------------------------------------------
{
  // The exact regression: zoomed way out on a real session (the "00:00:00:00
  // :00:60:00:10..." garbled ruler). At 1.51 px/s the old code held a 10 s
  // step no matter what (15 px apart, below any legible width); the fixed
  // step must widen until labels are readable.
  const farOut = rulerTimeTicks({ startSec: 0, endSec: 300, zoom: 1.51 });
  const minPx = RULER_TIME_LABEL_MIN_PX;
  for (const t of farOut) assert.ok(t.sec === 0 || t.sec * 1.51 >= minPx, `${t.sec}s at 1.51px/s is ${t.sec * 1.51}px from 0, below ${minPx}px`);
  for (let i = 1; i < farOut.length; i++) {
    assert.ok((farOut[i].sec - farOut[i - 1].sec) * 1.51 >= minPx - 1e-9, 'consecutive ticks must be >= minPx apart');
  }
  assert.deepEqual(farOut.map((t) => t.sec), [0, 60, 120, 180, 240, 300]);

  // High zoom keeps the same density the old fixed-threshold code gave:
  // 60 px/s -> 1 s step, major every 5 s.
  const dense = rulerTimeTicks({ startSec: 0, endSec: 3, zoom: 60 });
  assert.deepEqual(dense, [
    { sec: 0, major: true }, { sec: 1, major: false }, { sec: 2, major: false }, { sec: 3, major: false },
  ]);

  // Windowed like rulerBarLabels: only ticks inside [startSec, endSec], not
  // from 0 — the whole-session walk is exactly what made this expensive on
  // a multi-minute project.
  assert.deepEqual(
    rulerTimeTicks({ startSec: 118, endSec: 122, zoom: 60 }),
    [{ sec: 118, major: false }, { sec: 119, major: false }, { sec: 120, major: true }, { sec: 121, major: false }, { sec: 122, major: false }],
  );

  // A session past an hour still gets a legible step (the ladder doubles
  // past 3600 s rather than capping).
  const veryFarOut = rulerTimeTicks({ startSec: 0, endSec: 14400, zoom: 0.02 });
  assert.ok(veryFarOut.length >= 2, 'must still produce ticks for a long session at extreme zoom-out');
  for (let i = 1; i < veryFarOut.length; i++) {
    assert.ok((veryFarOut[i].sec - veryFarOut[i - 1].sec) * 0.02 >= RULER_TIME_LABEL_MIN_PX - 1e-9);
  }

  assert.deepEqual(rulerTimeTicks({ startSec: 5, endSec: 1, zoom: 10 }), []);
  assert.throws(() => rulerTimeTicks({ startSec: 0, endSec: 1, zoom: 0 }), RangeError);
  assert.throws(() => rulerTimeTicks({ startSec: 0, endSec: 1, zoom: NaN }), RangeError);
}

// --- Ruler labels at their real size: bold 12 px, never touching ------------
{
  // The ruler draws its labels in bold 12 px sans (WaveformEditor.tsx). A
  // tabular digit there is at most ~7.2 px, a colon ~3.5 px, and a time label
  // starts 4 px past its tick. Sweep the whole zoom range the way a user
  // zooms out from the deepest zoom, over a 2 h session, and check every pair
  // of neighbours on screen keeps a gap. Before, the spacing was chosen for
  // 8 px mono text: at 12 px, bar numbers from 100 up touched at 24 px apart.
  const DIGIT_PX = 7.2;
  const COLON_PX = 3.5;
  const GAP_PX = 6;
  const timeLabel = (sec: number) => `${Math.floor(sec / 60).toString().padStart(2, '0')}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
  const labelPx = (text: string) => [...text].reduce((w, ch) => w + (ch === ':' ? COLON_PX : DIGIT_PX), 0);
  const sessionSec = 2 * 3600;
  for (let zoom = 400; zoom >= 0.25; zoom /= 1.25) {
    // Look at two screens around 1:50:00, where labels are widest.
    const startSec = Math.max(0, 6600 - 1920 / zoom);
    const endSec = Math.min(sessionSec, 6600 + 1920 / zoom);
    const ticks = rulerTimeTicks({ startSec, endSec, zoom });
    for (let i = 1; i < ticks.length; i++) {
      const prevRight = ticks[i - 1].sec * zoom + 4 + labelPx(timeLabel(ticks[i - 1].sec));
      assert.ok(
        ticks[i].sec * zoom - prevRight >= GAP_PX,
        `time labels ${timeLabel(ticks[i - 1].sec)} and ${timeLabel(ticks[i].sec)} at ${zoom.toFixed(2)} px/s leave ${(ticks[i].sec * zoom - prevRight).toFixed(1)} px`,
      );
    }
    const bars = rulerBarLabels({ startSec, endSec, bpm: 174, zoom });
    for (let i = 1; i < bars.length; i++) {
      const prevRight = bars[i - 1].sec * zoom + 2 + labelPx(String(bars[i - 1].bar));
      assert.ok(
        bars[i].sec * zoom - prevRight >= 4,
        `bar numbers ${bars[i - 1].bar} and ${bars[i].bar} at ${zoom.toFixed(2)} px/s overlap`,
      );
    }
  }
  assert.ok(RULER_BAR_LABEL_MIN_PX >= 2 + 4 * DIGIT_PX + 4, 'a four-digit bar number fits between bar lines');
}

// --- The range readout never draws over a bar number ------------------------
{
  // The sequence from the review: EDIT at 120 bpm, zoomed in until bar
  // numbers show, then a time range dragged across bars 5 to 8. The readout
  // and the bar numbers are both bold 12 px in the ruler's top row, so
  // "00:08.000 – 00:16.000 · 8.000s" was drawn through 6, 7 and 8. Sweep the
  // zoom from far out to deep in: every bar number left on screen must clear
  // the readout's real text, and the bound the ruler hides by must cover it.
  const DIGIT_PX = 7.2;
  const bpm = 120;
  const range = { startSec: 8, endSec: 16, scope: { kind: 'all-tracks' as const } };
  const readout = formatRangeReadout(range);
  assert.equal(readout, '00:08.000 – 00:16.000 · 8.000s');
  // The widest the readout's pill really gets: text at the digit width plus
  // its 4 px of padding each side, from 4 px into the band.
  const realLeft = (zoom: number) => range.startSec * zoom + 4;
  const realRight = (zoom: number) => realLeft(zoom) + 8 + [...readout].length * DIGIT_PX;
  let sawHidden = false;
  for (let zoom = 400; zoom >= 2; zoom /= 1.25) {
    const bars = rulerBarLabels({ startSec: 0, endSec: 60, bpm, zoom });
    const span = rulerReadoutSpanPx(range.startSec, zoom, readout);
    assert.ok(span.leftPx <= realLeft(zoom) && span.rightPx >= realRight(zoom), 'the hide bound covers the readout');
    for (const b of bars) {
      const left = b.sec * zoom + 2;
      const right = left + String(b.bar).length * DIGIT_PX;
      const hidden = barLabelUnderReadout(b, zoom, span);
      sawHidden ||= hidden;
      if (!hidden) {
        assert.ok(
          right <= realLeft(zoom) || left >= realRight(zoom),
          `bar ${b.bar} at ${zoom.toFixed(2)} px/s is drawn under the range readout`,
        );
      }
    }
  }
  assert.ok(sawHidden, 'the sweep reached a zoom where bar numbers sit under the readout');
  // Bars clear of the readout keep their numbers: bar 3 (4 s) and a bar well
  // past the pill at a zoom where the readout ends before it.
  const zoom = 40;
  const span = rulerReadoutSpanPx(range.startSec, zoom, readout);
  assert.equal(barLabelUnderReadout({ bar: 3, sec: 4 }, zoom, span), false);
  assert.equal(barLabelUnderReadout({ bar: 6, sec: 10 }, zoom, span), true);
  const firstClear = Math.ceil(span.rightPx / zoom / 2) + 1;
  assert.equal(barLabelUnderReadout({ bar: firstClear, sec: (firstClear - 1) * 2 }, zoom, span), false);
  assert.ok(RULER_CHAR_MAX_PX >= DIGIT_PX, 'the character bound is at least a bold 12 px digit');
}

// --- Clip chrome: header inside the visible part, off the resize zones -------
{
  // Clip 0..3000 px, scrolled to 2000 with a 1000-px viewport: header covers
  // the visible 2000..3000 minus the 6-px edge zone on each side.
  const l = clipChromeLayout(0, 3000, 2000, 1000);
  assert.deepEqual(l, { leftInClip: 2000 + CLIP_EDGE_ZONE_PX, width: 1000 - 2 * CLIP_EDGE_ZONE_PX, tier: 'full' });
  // Clip starting offscreen left, 100 px visible: compact.
  assert.equal(clipChromeLayout(-500, 600, 0, 1000)?.tier, 'compact');
  // Fully visible narrow clip: handle.
  const h = clipChromeLayout(100, 40, 0, 1000);
  assert.equal(h?.tier, 'handle');
  assert.equal(h?.leftInClip, CLIP_EDGE_ZONE_PX);
  // Offscreen clip: nothing.
  assert.equal(clipChromeLayout(5000, 100, 0, 1000), null);
}

// --- Grid window quantisation: stride-snapped so small scrolls don't redraw -
{
  // REGRESSION: a small scroll returns the identical window. (Base scrollLeft
  // 50, not 0: at scrollLeft 0 the raw end lands exactly on a stride
  // boundary, an unavoidable cusp of any pure snap-to-grid function, not a
  // regression in its own right.)
  assert.deepEqual(viewportWindowSec(50, 1000, 100, 300), viewportWindowSec(51, 1000, 100, 300));
  assert.deepEqual(viewportWindowSec(50, 1000, 100, 300), viewportWindowSec(110, 1000, 100, 300));
}
{
  // A scroll of a whole viewport does move the window.
  assert.ok(viewportWindowSec(0, 1000, 100, 300).endSec < viewportWindowSec(1000, 1000, 100, 300).endSec);
}
{
  // The window always covers the visible range, whatever the scroll position.
  const contentEnd = Math.max(300 * 100, 1000) / 100;
  for (const scrollLeft of [0, 137, 999, 5000, 29000]) {
    const w = viewportWindowSec(scrollLeft, 1000, 100, 300);
    assert.ok(w.startSec <= Math.min(scrollLeft / 100, contentEnd));
    assert.ok(w.endSec >= Math.min((scrollLeft + 1000) / 100, contentEnd));
  }
}
{
  // Clamped to the content and never inverted.
  assert.deepEqual(viewportWindowSec(1e6, 1000, 100, 300), { startSec: 300, endSec: 300 });
  for (const scrollLeft of [0, 137, 999, 5000, 29000, 1e6]) {
    const w = viewportWindowSec(scrollLeft, 1000, 100, 300);
    assert.ok(w.endSec >= w.startSec);
    assert.ok(Number.isFinite(w.startSec) && w.startSec >= 0);
    assert.ok(Number.isFinite(w.endSec) && w.endSec >= 0);
  }
}
{
  // A zero-width viewport does not produce NaN.
  const w = viewportWindowSec(0, 0, 100, 300);
  assert.ok(Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec >= w.startSec);
}
{
  // Guards intact.
  assert.throws(() => viewportWindowSec(0, 100, 0, 300), RangeError);
}

console.log('timelineZoom: ok');
