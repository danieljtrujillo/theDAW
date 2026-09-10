/**
 * node:assert regression for the spotlight leader. Run from `frontend/`:
 *   npx tsx src/onboarding/spotlightGeometry.test.ts
 *
 * The one thing worth pinning down is that the head lands ON the target, from
 * wherever the card ended up — including the case that broke the old fixed
 * triangle, where the card is clamped into a screen corner and the target is
 * somewhere off behind it.
 */
import assert from 'node:assert/strict';
import {
  CARD_W,
  MIN_LENGTH,
  OFFSET,
  centre,
  connect,
  exitPoint,
  placeNote,
  type Box,
} from './spotlightGeometry';

const VP = { width: 1280, height: 800 };
const CARD = { width: CARD_W, height: 64 };

const cardFor = (target: Box, placement: 'left' | 'right' | 'top' | 'bottom'): Box => ({
  ...placeNote(target, placement, CARD, VP),
  ...CARD,
});

/** True when p sits on `box`'s border (within a pixel). */
const onBorder = (box: Box, p: { x: number; y: number }): boolean => {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const insideX = p.x >= box.left - 0.01 && p.x <= right + 0.01;
  const insideY = p.y >= box.top - 0.01 && p.y <= bottom + 0.01;
  const onVertical = (Math.abs(p.x - box.left) < 0.01 || Math.abs(p.x - right) < 0.01) && insideY;
  const onHorizontal = (Math.abs(p.y - box.top) < 0.01 || Math.abs(p.y - bottom) < 0.01) && insideX;
  return onVertical || onHorizontal;
};

// The library tab: pinned to the right edge, so the card sits to its left and
// the leader runs straight across the OFFSET gap.
const libraryTab: Box = { top: 352, left: 1266, width: 14, height: 96 };
{
  const card = cardFor(libraryTab, 'left');
  const link = connect(card, libraryTab);
  assert.ok(link, 'the library tab gets a leader');
  assert.ok(Math.abs(link.tip.x - libraryTab.left) < 0.01, 'the head lands on the tab’s left edge');
  assert.ok(
    link.tip.y >= libraryTab.top && link.tip.y <= libraryTab.top + libraryTab.height,
    'the head lands within the tab, not past its ends',
  );
  assert.ok(Math.abs(link.tail.x - (card.left + card.width)) < 0.01, 'the tail sits on the card’s border');
  assert.ok(Math.abs(link.length - OFFSET) < 0.01, 'it spans exactly the gap placeNote left');
  assert.ok(Math.abs(link.angle) < 0.01, 'and runs level, card → target');
}

// THE CASE THE OLD POINTER COULD NOT DRAW: a target in the far corner clamps
// the card away from where placement asked for it, so a triangle glued to the
// card's edge points at nothing. A measured leader still reaches the target.
const corner: Box = { top: 0, left: 0, width: 10, height: 10 };
for (const placement of ['left', 'right', 'top', 'bottom'] as const) {
  const card = cardFor(corner, placement);
  const link = connect(card, corner);
  assert.ok(link, `${placement}: a clamped card still draws a leader`);
  assert.ok(onBorder(corner, link.tip), `${placement}: the head lands on the target’s border`);
  assert.ok(onBorder(card, link.tail), `${placement}: the tail leaves the card’s border`);
  assert.ok(link.length >= MIN_LENGTH, `${placement}: long enough to be worth drawing`);
}

// Aim: whenever a leader is drawn at all, it runs from the card toward the
// target — never back into the card.
for (const target of [libraryTab, corner]) {
  for (const placement of ['left', 'right', 'top', 'bottom'] as const) {
    const card = cardFor(target, placement);
    const link = connect(card, target);
    if (!link) continue; // the card landed on its target; nothing to point with
    const rad = (link.angle * Math.PI) / 180;
    const dx = centre(target).x - centre(card).x;
    const dy = centre(target).y - centre(card).y;
    if (Math.abs(dx) > 1) assert.equal(Math.sign(Math.cos(rad)), Math.sign(dx), `${placement}: aimed across`);
    if (Math.abs(dy) > 1) assert.equal(Math.sign(Math.sin(rad)), Math.sign(dy), `${placement}: aimed down/up`);
  }
}

// exitPoint: the face the ray leaves through, and the pad that pushes it out.
{
  const box: Box = { top: 0, left: 0, width: 100, height: 100 };
  assert.deepEqual(exitPoint(box, { x: 500, y: 50 }), { x: 100, y: 50 }, 'leaves through the right face');
  assert.deepEqual(exitPoint(box, { x: 500, y: 50 }, 5), { x: 105, y: 50 }, 'pad pushes it outward');
  assert.deepEqual(exitPoint(box, { x: 50, y: -500 }), { x: 50, y: 0 }, 'leaves through the top face');
}

// Nothing to draw: concentric boxes have no direction, and a card already
// touching its target gets no stub.
assert.equal(connect({ top: 0, left: 0, width: 100, height: 100 }, { top: 25, left: 25, width: 50, height: 50 }), null,
  'concentric boxes draw nothing');
assert.equal(connect({ top: 0, left: 0, width: 100, height: 20 }, { top: 0, left: 101, width: 20, height: 20 }), null,
  'a one-pixel gap is not worth a leader');
// Asking for 'right' on a target already at the right edge clamps the card back
// on top of it, which is the overlap the forward guard exists for.
assert.equal(connect(cardFor(libraryTab, 'right'), libraryTab), null,
  'a card sitting on its own target draws no leader');

console.log('spotlightGeometry connector tests passed');
