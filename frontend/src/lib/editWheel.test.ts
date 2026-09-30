import assert from 'node:assert/strict';
import {
  DEFAULT_WHEEL_PAGE_HEIGHT_PX,
  EDIT_WHEEL_BINDINGS,
  WHEEL_LINE_HEIGHT_PX,
  hostPlatform,
  isMacPlatform,
  normalizeWheelDelta,
  resolveEditWheel,
  wheelGestureKey,
  zoomModifierHeld,
  type EditWheelInput,
} from './editWheel';

/** c = ctrl, m = meta, s = shift, a = alt. */
const mods = (s: string) => ({
  ctrlKey: s.includes('c'),
  metaKey: s.includes('m'),
  shiftKey: s.includes('s'),
  altKey: s.includes('a'),
});
const wheel = (m: string, platform: string, deltaY = 100, deltaX = 0, deltaMode = 0): EditWheelInput => ({
  deltaX, deltaY, deltaMode, platform, ...mods(m),
});

// --- The table, row by row, on Windows and macOS ------------------------------

assert.deepEqual(EDIT_WHEEL_BINDINGS, {
  plain: 'scroll-y', ctrl: 'zoom-x', shift: 'scroll-x', alt: 'zoom-y', ctrlShift: 'zoom-x-fine', ctrlAlt: 'scroll-y',
});

for (const platform of ['win32', 'darwin']) {
  // Vertical scroll: Mouse Wheel.
  assert.deepEqual(resolveEditWheel(wheel('', platform)), { kind: 'scroll-y', amount: 100, fine: false }, platform);
  assert.deepEqual(resolveEditWheel(wheel('', platform, -100)), { kind: 'scroll-y', amount: -100, fine: false }, platform);
  // Horizontal scroll: Shift + Mouse Wheel.
  assert.deepEqual(resolveEditWheel(wheel('s', platform)), { kind: 'scroll-x', amount: 100, fine: false }, platform);
  // Horizontal zoom: Ctrl + Mouse Wheel.
  assert.deepEqual(resolveEditWheel(wheel('c', platform, -100)), { kind: 'zoom-x', amount: -100, fine: false }, platform);
  // Vertical zoom (track height): Alt + Mouse Wheel.
  assert.deepEqual(resolveEditWheel(wheel('a', platform, -100)), { kind: 'zoom-y', amount: -100, fine: false }, platform);
  // Ctrl + Shift: fine time zoom. Ctrl + Alt: vertical scroll.
  assert.deepEqual(resolveEditWheel(wheel('cs', platform, 40)), { kind: 'zoom-x', amount: 40, fine: true }, platform);
  assert.deepEqual(resolveEditWheel(wheel('ca', platform, 40)), { kind: 'scroll-y', amount: 40, fine: false }, platform);
  // Shift + Alt without Ctrl is Alt.
  assert.equal(resolveEditWheel(wheel('sa', platform))?.kind, 'zoom-y', platform);
}

// Cmd + Mouse Wheel zooms on macOS only; on Windows the OS key is ignored.
assert.deepEqual(resolveEditWheel(wheel('m', 'darwin', -100)), { kind: 'zoom-x', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('m', 'MacIntel', -100)), { kind: 'zoom-x', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('m', 'macOS', -100)), { kind: 'zoom-x', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('ms', 'darwin', 40)), { kind: 'zoom-x', amount: 40, fine: true });
assert.deepEqual(resolveEditWheel(wheel('m', 'win32', -100)), { kind: 'scroll-y', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('m', 'Windows', -100)), { kind: 'scroll-y', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('ms', 'Win32', 40)), { kind: 'scroll-x', amount: 40, fine: false });
assert.deepEqual(resolveEditWheel(wheel('ma', 'linux', 40)), { kind: 'zoom-y', amount: 40, fine: false });
// Ctrl still zooms on macOS.
assert.equal(resolveEditWheel(wheel('c', 'darwin'))?.kind, 'zoom-x');

// --- Trackpads -----------------------------------------------------------------

// A two-finger horizontal swipe scrolls along time by its own delta.
assert.deepEqual(resolveEditWheel(wheel('', 'win32', 5, -40)), { kind: 'scroll-x', amount: -40, fine: false });
assert.deepEqual(resolveEditWheel(wheel('', 'darwin', 0, 60)), { kind: 'scroll-x', amount: 60, fine: false });
// A vertical swipe with a little sideways drift stays vertical.
assert.deepEqual(resolveEditWheel(wheel('', 'darwin', 80, 6)), { kind: 'scroll-y', amount: 80, fine: false });
// Shift + wheel that the browser already turned horizontal scrolls by that delta.
assert.deepEqual(resolveEditWheel(wheel('s', 'win32', 0, 90)), { kind: 'scroll-x', amount: 90, fine: false });
// A pinch reaches Chromium as Ctrl + wheel and zooms time.
assert.deepEqual(resolveEditWheel(wheel('c', 'darwin', -12)), { kind: 'zoom-x', amount: -12, fine: false });
assert.deepEqual(resolveEditWheel(wheel('c', 'win32', 7)), { kind: 'zoom-x', amount: 7, fine: false });
// A modified horizontal gesture follows the modifier, by the dominant delta.
assert.deepEqual(resolveEditWheel(wheel('c', 'win32', 5, -40)), { kind: 'zoom-x', amount: -40, fine: false });

// --- deltaMode normalisation -----------------------------------------------------

assert.equal(WHEEL_LINE_HEIGHT_PX, 16);
assert.deepEqual(resolveEditWheel(wheel('', 'win32', 3, 0, 1)), { kind: 'scroll-y', amount: 48, fine: false });
assert.deepEqual(resolveEditWheel(wheel('s', 'win32', -2, 0, 1)), { kind: 'scroll-x', amount: -32, fine: false });
assert.deepEqual(resolveEditWheel(wheel('c', 'win32', 1, 0, 2), { pageHeightPx: 600 }), { kind: 'zoom-x', amount: 600, fine: false });
assert.deepEqual(resolveEditWheel(wheel('', 'win32', 1, 0, 2)), { kind: 'scroll-y', amount: DEFAULT_WHEEL_PAGE_HEIGHT_PX, fine: false });
assert.deepEqual(normalizeWheelDelta({ deltaX: 3, deltaY: -7, deltaMode: 0 }, 800), { dx: 3, dy: -7 });
assert.deepEqual(normalizeWheelDelta({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 800), { dx: 16, dy: 48 });
assert.deepEqual(normalizeWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 800), { dx: 0, dy: -800 });
assert.deepEqual(normalizeWheelDelta({ deltaX: 0, deltaY: 5, deltaMode: 9 }, 800), { dx: 0, dy: 5 });
assert.throws(() => resolveEditWheel(wheel('', 'win32', Number.NaN)), RangeError);
assert.throws(() => resolveEditWheel(wheel('', 'win32', 1, 0, 2), { pageHeightPx: Number.NaN }), RangeError);

// --- Nothing to do -----------------------------------------------------------------

assert.equal(resolveEditWheel(wheel('', 'win32', 0)), null);
assert.equal(resolveEditWheel(wheel('c', 'darwin', 0)), null);
assert.equal(resolveEditWheel(wheel('', 'win32', 100), { bindings: { ...EDIT_WHEEL_BINDINGS, plain: 'none' } }), null);
// Custom bindings (a wheel profile) replace the table, except the swipe rule.
const reaperLike = { ...EDIT_WHEEL_BINDINGS, plain: 'zoom-x' as const, ctrl: 'zoom-y' as const };
assert.deepEqual(resolveEditWheel(wheel('', 'win32', -100), { bindings: reaperLike }), { kind: 'zoom-x', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('c', 'win32', -100), { bindings: reaperLike }), { kind: 'zoom-y', amount: -100, fine: false });
assert.deepEqual(resolveEditWheel(wheel('', 'win32', 5, 40), { bindings: reaperLike }), { kind: 'scroll-x', amount: 40, fine: false });

// --- Platform helpers ------------------------------------------------------------

for (const p of ['darwin', 'Darwin', 'macOS', 'MacIntel', 'MacPPC', 'iPhone', 'iPad']) assert.ok(isMacPlatform(p), p);
for (const p of ['win32', 'Win32', 'Windows', 'linux', 'Linux x86_64', 'Android', '']) assert.ok(!isMacPlatform(p), p);
assert.equal(zoomModifierHeld({ ctrlKey: false, metaKey: true }, 'darwin'), true);
assert.equal(zoomModifierHeld({ ctrlKey: false, metaKey: true }, 'win32'), false);
assert.equal(zoomModifierHeld({ ctrlKey: true, metaKey: false }, 'win32'), true);
assert.equal(wheelGestureKey({ ...mods('cm') }, 'win32'), 'ctrl');
assert.equal(wheelGestureKey({ ...mods('csa') }, 'win32'), 'ctrlShift');
assert.equal(wheelGestureKey({ ...mods('ma') }, 'darwin'), 'ctrlAlt');
assert.equal(wheelGestureKey({ ...mods('ma') }, 'win32'), 'alt');
// Without a platform on the event the host's is read: Node's global navigator
// ("Win32", "MacIntel") or process.platform; both agree on the OS.
assert.ok(hostPlatform().length > 0);
assert.equal(isMacPlatform(hostPlatform()), process.platform === 'darwin');
assert.equal(resolveEditWheel({ ...wheel('m', 'x', -100), platform: undefined })?.kind, process.platform === 'darwin' ? 'zoom-x' : 'scroll-y');

console.log('editWheel: ok');
