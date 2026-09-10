/**
 * The leader line both onboarding surfaces draw between a card and the control
 * it names.
 *
 * The geometry contract, because it is the whole reason this works at any card
 * position: the SVG's top-left is pinned at `(tail.x, tail.y - BAND/2)` and its
 * rotation pivot is `0 BAND/2`, which puts the pivot exactly on `tail`. Local x
 * then runs 0 → `length` along the card→target line, so local `(length, MID)`
 * maps to `tip` in viewport px — the point of the head lands ON the target's
 * border, at any angle. When the gap is shorter than the head, the stem
 * vanishes and the head shortens to fill it.
 *
 * Position, size and rotation are measured numbers, so they belong in an inline
 * style rather than in invented Tailwind values. The element carries no
 * z-index: it is `fixed` but still stacks inside its host's layer, and each
 * host controls paint order by DOM position (both draw it under their card, so
 * the card covers the seam where the stem meets its border).
 */
import React from 'react';
import { connect, type Box } from './spotlightGeometry';
import './onboarding.css';

/** Vertical room for the head plus its glow; the drawing is centred in it. */
const BAND = 16;
const MID = BAND / 2;
const HEAD_LEN = 9;
const HEAD_HALF = 5;
const STEM_W = 1.5;

export const SpotlightPointer: React.FC<{ card: Box; target: Box }> = ({ card, target }) => {
  const link = connect(card, target);
  if (!link) return null;
  const { tail, length, angle } = link;
  const stemEnd = Math.max(0, length - HEAD_LEN);
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none fixed overflow-visible"
      width={length}
      height={BAND}
      viewBox={`0 0 ${length} ${BAND}`}
      style={{
        left: tail.x,
        top: tail.y - MID,
        transform: `rotate(${angle}deg)`,
        transformOrigin: `0 ${MID}px`,
        filter: 'drop-shadow(0 0 6px rgba(168,85,247,0.55))',
      }}
    >
      {stemEnd > 0.5 && (
        <line
          className="spotlight-stem"
          x1={0}
          y1={MID}
          x2={stemEnd}
          y2={MID}
          stroke="rgba(168,85,247,0.85)"
          strokeWidth={STEM_W}
          strokeLinecap="round"
        />
      )}
      <path
        className="spotlight-tip"
        d={`M${length} ${MID} L${stemEnd} ${MID - HEAD_HALF} L${stemEnd} ${MID + HEAD_HALF} Z`}
        fill="#d8b4fe"
      />
    </svg>
  );
};

export default SpotlightPointer;
