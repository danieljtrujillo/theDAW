import assert from 'node:assert/strict';
import {
  CHROME_COMPACT_MIN_PX,
  CHROME_FULL_MIN_PX,
  WHEEL_PROFILES,
  clipChromeTier,
  isWheelExcludedTarget,
  normalizeWheelDelta,
  timeAtLocalX,
  visibleClipHeader,
  wheelIntent,
  zoomAtMarker,
  zoomStep,
  type WheelAction,
  type WheelProfile,
} from './viewport';

const BOUNDS = { min: 0.25, max: 400 };
const close = (a: number, b: number, eps = 1e-9): void =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be close to ${b}`);

// --- zoomAtMarker ----------------------------------------------------------

// Marker mid-content stays centred over repeated zoom in and out.
{
  let view = { zoom: 50, scrollLeft: 0, viewportWidth: 1000, contentDurationSec: 600 };
  const marker = 300;
  for (const dir of ['in', 'in', 'in', 'out', 'out', 'out', 'out', 'in'] as const) {
    const next = zoomAtMarker(view, zoomStep(view.zoom, dir), marker, BOUNDS);
    view = { ...view, ...next };
    close(timeAtLocalX(view.viewportWidth / 2, view.scrollLeft, view.zoom), marker, 1e-6);
  }
}

// Clamped at 0: a marker near the start cannot be centred.
{
  const r = zoomAtMarker({ zoom: 10, scrollLeft: 500, viewportWidth: 1000, contentDurationSec: 600 }, 20, 5, BOUNDS);
  assert.equal(r.zoom, 20);
  assert.equal(r.scrollLeft, 0);
}

// Clamped at content end: scrollLeft = contentWidth - viewportWidth.
{
  const r = zoomAtMarker({ zoom: 10, scrollLeft: 0, viewportWidth: 1000, contentDurationSec: 600 }, 20, 599, BOUNDS);
  assert.equal(r.scrollLeft, 600 * 20 - 1000);
}

// Zoom bounds respected.
{
  const view = { zoom: 10, scrollLeft: 0, viewportWidth: 1000, contentDurationSec: 600 };
  assert.equal(zoomAtMarker(view, 10_000, 300, BOUNDS).zoom, 400);
  assert.equal(zoomAtMarker(view, 0.001, 300, BOUNDS).zoom, 0.25);
}

// Content shorter than the viewport -> scrollLeft 0.
{
  const r = zoomAtMarker({ zoom: 10, scrollLeft: 0, viewportWidth: 1000, contentDurationSec: 20 }, 20, 15, BOUNDS);
  assert.equal(r.zoom, 20);
  assert.equal(r.scrollLeft, 0);
}

// Invalid inputs throw RangeError.
{
  const view = { zoom: 10, scrollLeft: 0, viewportWidth: 1000, contentDurationSec: 60 };
  assert.throws(() => zoomAtMarker(view, Number.NaN, 1, BOUNDS), RangeError);
  assert.throws(() => zoomAtMarker(view, 10, Number.POSITIVE_INFINITY, BOUNDS), RangeError);
  assert.throws(() => zoomAtMarker({ ...view, viewportWidth: 0 }, 10, 1, BOUNDS), RangeError);
  assert.throws(() => zoomAtMarker({ ...view, contentDurationSec: -1 }, 10, 1, BOUNDS), RangeError);
  assert.throws(() => zoomAtMarker(view, 10, 1, { min: 5, max: 1 }), RangeError);
  assert.throws(() => zoomAtMarker(view, 10, 1, { min: 0, max: 1 }), RangeError);
}

// --- zoomStep / timeAtLocalX ----------------------------------------------

assert.equal(zoomStep(100, 'in'), 125);
assert.equal(zoomStep(125, 'out'), 100);
assert.equal(zoomStep(100, 'in', 2), 200);
assert.equal(zoomStep(100, 'out', 2), 50);
assert.throws(() => zoomStep(Number.NaN, 'in'), RangeError);
assert.throws(() => zoomStep(0, 'in'), RangeError);
assert.throws(() => zoomStep(100, 'in', 0), RangeError);

assert.equal(timeAtLocalX(100, 400, 50), 10);
assert.equal(timeAtLocalX(-500, 0, 50), 0);
assert.throws(() => timeAtLocalX(Number.NaN, 0, 50), RangeError);
assert.throws(() => timeAtLocalX(1, 0, 0), RangeError);

// --- normalizeWheelDelta ----------------------------------------------------

assert.deepEqual(normalizeWheelDelta({ deltaX: 3, deltaY: -7, deltaMode: 0 }, 800), { dx: 3, dy: -7 });
assert.deepEqual(normalizeWheelDelta({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 800), { dx: 16, dy: 48 });
assert.deepEqual(normalizeWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 800), { dx: 0, dy: -800 });
assert.throws(() => normalizeWheelDelta({ deltaX: Number.NaN, deltaY: 0, deltaMode: 0 }, 800), RangeError);
assert.throws(() => normalizeWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, Number.NaN), RangeError);

// --- wheel profiles -------------------------------------------------------

assert.equal(WHEEL_PROFILES.thedaw.id, 'thedaw');
assert.equal(WHEEL_PROFILES.thedaw.label, 'theDAW (wheel zooms, Ctrl = fine zoom)');
assert.equal(WHEEL_PROFILES.reaper.id, 'reaper');
assert.equal(WHEEL_PROFILES.reaper.label, 'REAPER default');

interface Mods { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
/** c = ctrl, m = meta, s = shift, a = alt. */
const mods = (s: string): Mods => ({
  ctrlKey: s.includes('c'),
  metaKey: s.includes('m'),
  shiftKey: s.includes('s'),
  altKey: s.includes('a'),
});
const vertical = (m: string, dy = 100) => ({ deltaX: 0, deltaY: dy, deltaMode: 0, ...mods(m) });

const expectations: Record<'thedaw' | 'reaper', Record<string, WheelAction>> = {
  thedaw: {
    '': 'zoom-time', c: 'zoom-time-fine', m: 'zoom-time-fine', s: 'pan-time', a: 'pan-lanes',
    cs: 'resize-lanes', ms: 'resize-lanes', ca: 'pan-lanes', ma: 'pan-lanes', csa: 'resize-lanes', sa: 'pan-lanes',
    cm: 'zoom-time-fine',
  },
  reaper: {
    '': 'zoom-time', c: 'resize-lanes', m: 'resize-lanes', s: 'pan-time', a: 'pan-time',
    cs: 'zoom-time-fine', ms: 'zoom-time-fine', ca: 'pan-lanes', ma: 'pan-lanes', csa: 'zoom-time-fine', sa: 'pan-time',
    cm: 'resize-lanes',
  },
};
for (const id of ['thedaw', 'reaper'] as const) {
  const profile: WheelProfile = WHEEL_PROFILES[id];
  for (const [combo, action] of Object.entries(expectations[id])) {
    assert.equal(wheelIntent(vertical(combo), profile, 800).action, action, `${id} "${combo}"`);
  }
}

// Zoom factors: wheel up zooms in; fine is nearer 1 than coarse; delta clamps at +-400.
{
  const p = WHEEL_PROFILES.thedaw;
  const coarse = wheelIntent(vertical('', -100), p, 800);
  const fine = wheelIntent(vertical('c', -100), p, 800);
  close(coarse.zoomFactor, Math.exp(100 * 0.002));
  close(fine.zoomFactor, Math.exp(100 * 0.0006));
  assert.ok(coarse.zoomFactor > fine.zoomFactor && fine.zoomFactor > 1);
  const coarseOut = wheelIntent(vertical('', 100), p, 800).zoomFactor;
  const fineOut = wheelIntent(vertical('c', 100), p, 800).zoomFactor;
  assert.ok(coarseOut < fineOut && fineOut < 1);
  close(wheelIntent(vertical('', -5000), p, 800).zoomFactor, Math.exp(400 * 0.002));
  close(wheelIntent(vertical('', -100), p, 800, { coarseSpeed: 0.01 }).zoomFactor, Math.exp(1));
  close(wheelIntent(vertical('c', -100), p, 800, { fineSpeed: 0.001 }).zoomFactor, Math.exp(0.1));
  // deltaMode 1 and 2 go through normalisation.
  close(wheelIntent({ ...vertical(''), deltaY: -3, deltaMode: 1 }, p, 800).zoomFactor, Math.exp(48 * 0.002));
  close(wheelIntent({ ...vertical(''), deltaY: -1, deltaMode: 2 }, p, 100).zoomFactor, Math.exp(100 * 0.002));
  // Non-zoom actions report factor 1.
  assert.equal(wheelIntent(vertical('s'), p, 800).zoomFactor, 1);
  assert.equal(wheelIntent(vertical('cs'), p, 800).zoomFactor, 1);
}

// Pan and lane payloads.
{
  const p = WHEEL_PROFILES.thedaw;
  assert.deepEqual(wheelIntent(vertical('s', 120), p, 800), { action: 'pan-time', zoomFactor: 1, panPx: 120, lanePx: 0 });
  assert.deepEqual(wheelIntent(vertical('a', -60), p, 800), { action: 'pan-lanes', zoomFactor: 1, panPx: -60, lanePx: 0 });
  assert.deepEqual(wheelIntent(vertical('cs', -30), p, 800), { action: 'resize-lanes', zoomFactor: 1, panPx: 0, lanePx: 30 });
  assert.deepEqual(wheelIntent(vertical('cs', 30), p, 800), { action: 'resize-lanes', zoomFactor: 1, panPx: 0, lanePx: -30 });
  const zoom = wheelIntent(vertical('', -30), p, 800);
  assert.equal(zoom.panPx, 0);
  assert.equal(zoom.lanePx, 0);
  // Line-mode pan is normalised to px.
  assert.equal(wheelIntent({ ...vertical('s'), deltaY: 2, deltaMode: 1 }, p, 800).panPx, 32);
  // Shift+wheel that the browser already turned horizontal still pans by that delta.
  assert.deepEqual(
    wheelIntent({ deltaX: 90, deltaY: 0, deltaMode: 0, ...mods('s') }, p, 800),
    { action: 'pan-time', zoomFactor: 1, panPx: 90, lanePx: 0 },
  );
}

// Horizontal trackpad with no modifiers pans time under both profiles.
for (const id of ['thedaw', 'reaper'] as const) {
  assert.deepEqual(
    wheelIntent({ deltaX: -40, deltaY: 5, deltaMode: 0, ...mods('') }, WHEEL_PROFILES[id], 800),
    { action: 'pan-time', zoomFactor: 1, panPx: -40, lanePx: 0 },
  );
}
// A modified horizontal gesture follows the profile, not the trackpad rule.
assert.equal(
  wheelIntent({ deltaX: -40, deltaY: 5, deltaMode: 0, ...mods('c') }, WHEEL_PROFILES.thedaw, 800).action,
  'zoom-time-fine',
);

assert.throws(() => wheelIntent({ ...vertical(''), deltaY: Number.NaN }, WHEEL_PROFILES.thedaw, 800), RangeError);
assert.throws(() => wheelIntent(vertical(''), WHEEL_PROFILES.thedaw, 800, { coarseSpeed: -1 }), RangeError);
assert.throws(() => wheelIntent(vertical('c'), WHEEL_PROFILES.thedaw, 800, { fineSpeed: Number.NaN }), RangeError);

// --- isWheelExcludedTarget --------------------------------------------------

assert.equal(isWheelExcludedTarget(null), false);
assert.equal(isWheelExcludedTarget({ tagName: 'INPUT' }), true);
assert.equal(isWheelExcludedTarget({ tagName: 'textarea' }), true);
assert.equal(isWheelExcludedTarget({ tagName: 'SELECT' }), true);
assert.equal(isWheelExcludedTarget({ tagName: 'DIV', isContentEditable: true }), true);
assert.equal(
  isWheelExcludedTarget({ tagName: 'DIV', closest: (sel) => (sel === '[data-wheel-passthrough]' ? {} : null) }),
  true,
);
assert.equal(isWheelExcludedTarget({ tagName: 'DIV', isContentEditable: false, closest: () => null }), false);
assert.equal(isWheelExcludedTarget({ tagName: 'CANVAS' }), false);
assert.equal(isWheelExcludedTarget({}), false);

// --- visibleClipHeader ------------------------------------------------------

// Clip starts left of the viewport: header begins at the viewport edge (+ padding).
assert.deepEqual(visibleClipHeader(0, 1000, 300, 500, 4), { leftInClip: 304, width: 492 });
// Clip ends right of the viewport.
assert.deepEqual(visibleClipHeader(400, 1000, 0, 600, 4), { leftInClip: 4, width: 192 });
// Fully inside.
assert.deepEqual(visibleClipHeader(100, 200, 0, 1000, 4), { leftInClip: 4, width: 192 });
// Default padding is 4.
assert.deepEqual(visibleClipHeader(100, 200, 0, 1000), { leftInClip: 4, width: 192 });
// Fully outside on either side, or only touching an edge.
assert.equal(visibleClipHeader(1200, 100, 0, 1000, 4), null);
assert.equal(visibleClipHeader(0, 100, 500, 1000, 4), null);
assert.equal(visibleClipHeader(1000, 100, 0, 1000, 4), null);
// A sliver narrower than twice the padding keeps a non-negative width.
assert.deepEqual(visibleClipHeader(0, 6, 0, 1000, 4), { leftInClip: 3, width: 0 });
assert.throws(() => visibleClipHeader(Number.NaN, 1, 0, 1), RangeError);

// --- clipChromeTier ---------------------------------------------------------

assert.equal(CHROME_FULL_MIN_PX, 140);
assert.equal(CHROME_COMPACT_MIN_PX, 48);
assert.equal(clipChromeTier(500), 'full');
assert.equal(clipChromeTier(140), 'full');
assert.equal(clipChromeTier(139.9), 'compact');
assert.equal(clipChromeTier(48), 'compact');
assert.equal(clipChromeTier(47.9), 'handle');
assert.equal(clipChromeTier(0), 'handle');
assert.throws(() => clipChromeTier(Number.NaN), RangeError);

console.log('viewport: ok');
