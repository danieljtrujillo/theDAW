/**
 * node:assert regression for feature-note placement. Run from `frontend/`:
 *   npx tsx src/onboarding/featureNotes.test.ts
 *
 * placeNote is pure geometry, so the interesting cases -- a target hard against
 * a viewport edge, which is where every note-worthy affordance in this shell
 * lives -- are testable without a DOM. It lives in spotlightGeometry.ts, not in
 * the renderer, so this runner never has to resolve a .css import.
 *
 * The leader that reaches from a placed card to its target is pinned next door,
 * in spotlightGeometry.test.ts.
 */
import assert from 'node:assert/strict';
import { placeNote } from './spotlightGeometry';

const VP = { width: 1280, height: 800 };
const CARD = { width: 208, height: 64 };

// A slim tab hard against the right edge, vertically centred: the shape a
// 'left' note has to cope with, and the one that has nowhere to grow into.
const edgeTab = { top: 352, left: 1266, width: 14, height: 96 };
const left = placeNote(edgeTab, 'left', CARD, VP);
assert.equal(left.left, 1266 - 208 - 14, 'sits to the left of the tab');
assert.equal(left.top, 352 + 48 - 32, 'centred on the tab');
assert.ok(left.left + CARD.width <= VP.width - 8, 'stays on screen');

// The LOG strip: flush with the bottom edge, so a "top" note must not be
// pushed off the bottom, and must clear the strip.
const logStrip = { top: 776, left: 980, width: 300, height: 24 };
const above = placeNote(logStrip, 'top', CARD, VP);
assert.equal(above.top, 776 - 64 - 14, 'sits above the strip');
assert.ok(above.top + CARD.height < logStrip.top, 'never covers its own target');

// A target in the far corner still yields an on-screen card.
const corner = { top: 0, left: 0, width: 10, height: 10 };
for (const p of ['left', 'top', 'right', 'bottom'] as const) {
  const pos = placeNote(corner, p, CARD, VP);
  assert.ok(pos.left >= 8 && pos.top >= 8, `${p}: clamped into the viewport`);
  assert.ok(pos.left + CARD.width <= VP.width - 8, `${p}: right edge on screen`);
  assert.ok(pos.top + CARD.height <= VP.height - 8, `${p}: bottom edge on screen`);
}

// A viewport narrower than the card still clamps to the margin, never negative.
const tiny = placeNote(corner, 'left', CARD, { width: 120, height: 120 });
assert.ok(tiny.left >= 8 && tiny.top >= 8, 'degenerate viewport stays positive');

console.log('featureNotes placement tests passed');
