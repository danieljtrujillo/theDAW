/**
 * Where a spotlight card goes, and how a leader line reaches from it to the
 * thing it names.
 *
 * A pointer aimed by a CSS class is aimed at the CARD, not at the target — and
 * the card moves. `placeNote` clamps it into the viewport, and every affordance
 * worth pointing at in this app sits hard against an edge (the library tab is
 * pinned to the right, the PANELS and LOG strips are flush with the bottom), so
 * the clamp fires nearly every time. A triangle glued to the card's edge slides
 * with it and stops naming anything. The only aim that survives is one computed
 * from BOTH final rects, which is what `connect` does.
 *
 * Kept DOM-free so the arithmetic is testable without a browser (the wires.ts
 * pattern), and so the renderer can import a stylesheet without breaking
 * `npm run test:onboarding`, which runs bare `tsx` over the test file.
 */
import type { NotePlacement } from './featureNoteStore';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A measured leader: from the card's border to the target's border. */
export interface Connector {
  /** On the card's edge, on the line to the target. */
  tail: Point;
  /** On the target's edge, on the line back to the card. */
  tip: Point;
  length: number;
  /** Degrees, tail → tip, the way CSS `rotate()` takes them. */
  angle: number;
}

/** Gap between the target's edge and the card, leaving room for the pointer. */
export const OFFSET = 14;
/** Keep the card this far inside the viewport when a target sits near an edge. */
export const MARGIN = 8;
export const CARD_W = 208;

/** Raise this to leave the arrowhead a breath instead of landing on the border. */
export const TIP_GAP = 0;
/**
 * Below this the two boxes are already touching and a leader reads as lint.
 * Deliberately tiny: a card clamped into a screen corner ends up a few px from
 * its target, and that is exactly the case a leader still has to draw for.
 */
export const MIN_LENGTH = 2;

/** Card position for a target box, clamped into the viewport. */
export function placeNote(
  target: Box,
  placement: NotePlacement,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  let top: number;
  let left: number;
  switch (placement) {
    case 'left':
      left = target.left - card.width - OFFSET;
      top = target.top + target.height / 2 - card.height / 2;
      break;
    case 'right':
      left = target.left + target.width + OFFSET;
      top = target.top + target.height / 2 - card.height / 2;
      break;
    case 'top':
      left = target.left + target.width / 2 - card.width / 2;
      top = target.top - card.height - OFFSET;
      break;
    default:
      left = target.left + target.width / 2 - card.width / 2;
      top = target.top + target.height + OFFSET;
      break;
  }
  return {
    left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - card.width - MARGIN)),
    top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - card.height - MARGIN)),
  };
}

export const centre = (b: Box): Point => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

/** Where the ray from `box`'s centre toward `toward` leaves `box`, grown by `pad`. */
export function exitPoint(box: Box, toward: Point, pad = 0): Point {
  const c = centre(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return c;
  const ux = dx / len;
  const uy = dy / len;
  const hx = box.width / 2 + pad;
  const hy = box.height / 2 + pad;
  const sx = Math.abs(ux) > 1e-6 ? hx / Math.abs(ux) : Infinity;
  const sy = Math.abs(uy) > 1e-6 ? hy / Math.abs(uy) : Infinity;
  return { x: c.x + ux * Math.min(sx, sy), y: c.y + uy * Math.min(sx, sy) };
}

/**
 * The measured link from a placed card to its target.
 *
 * `tail` walks out of the card toward the target, `tip` walks out of the target
 * back toward the card — so the head always lands on the near face of the
 * target, at any angle, wherever the card ended up after clamping.
 *
 * Null when there is nothing worth drawing: concentric boxes, a gap under
 * MIN_LENGTH, or a card that has landed ON its target, which turns tail→tip
 * around and would draw an arrow pointing back into the card.
 */
export function connect(card: Box, target: Box, tipGap = TIP_GAP): Connector | null {
  const cc = centre(card);
  const tc = centre(target);
  const toTargetX = tc.x - cc.x;
  const toTargetY = tc.y - cc.y;
  if (Math.hypot(toTargetX, toTargetY) < 1e-6) return null;
  const tail = exitPoint(card, tc);
  const tip = exitPoint(target, cc, tipGap);
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  if (dx * toTargetX + dy * toTargetY <= 0) return null;
  const length = Math.hypot(dx, dy);
  if (length < MIN_LENGTH) return null;
  return { tail, tip, length, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}
