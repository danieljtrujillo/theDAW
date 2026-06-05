import React from 'react';
import { rgb, rgba, shade, type RGB } from '../../lib/trackColor';
import type { ButtonShape } from '../surface/widgetTypes';

// Per-shape style overrides (inline so they beat the default `rounded-md`). The
// four triangles are right-angle halves of a square via clip-path; two
// complementary ones tile a square.
const SHAPE_STYLE: Record<ButtonShape, React.CSSProperties> = {
  default: {},
  square: { borderRadius: 0, aspectRatio: '1 / 1' },
  rect: { borderRadius: 0 },
  circle: { borderRadius: '50%', aspectRatio: '1 / 1' },
  'tri-tl': { borderRadius: 0, clipPath: 'polygon(0 0, 100% 0, 0 100%)' },
  'tri-tr': { borderRadius: 0, clipPath: 'polygon(0 0, 100% 0, 100% 100%)' },
  'tri-bl': { borderRadius: 0, clipPath: 'polygon(0 0, 0 100%, 100% 100%)' },
  'tri-br': { borderRadius: 0, clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' },
};

/* ── SlidePad ──────────────────────────────────────────────────────────
   A SLIDE-language pad button: rounded glass cell, glows in its accent
   colour when lit/active. Same prop surface as the old DjPad so the DJ
   migration is near-mechanical, but it reads like the rest of the SLIDE
   surface (MAKE/MIX). Used for hotcues (set/jump/clear), loop/roll/beat-
   jump pads, transport, and toggles (slip / key-lock / cue).

   Lit colour is data: pass the deck accent RGB so Deck A pads glow purple
   and Deck B pads glow cyan. No drag here, so it is inherently lag-free. */

const PURPLE: RGB = [168, 85, 247];
const DANGER: RGB = [244, 63, 94];

export interface SlidePadProps {
  children: React.ReactNode;
  on?: boolean;
  /** Accent colour when lit (defaults to brand purple). */
  color?: RGB;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Pad outline shape (default rounded; square/rect/circle/diagonal tris). */
  shape?: ButtonShape;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerLeave?: (e: React.PointerEvent) => void;
}

export function SlidePad({
  children, on, color, disabled, danger, title, className, style, shape,
  onClick, onContextMenu, onPointerDown, onPointerUp, onPointerLeave,
}: SlidePadProps) {
  const c = danger ? DANGER : (color ?? PURPLE);
  const litStyle: React.CSSProperties = on
    ? {
        borderColor: rgba(c, 0.7),
        background: rgba(c, 0.22),
        color: rgb(shade(c, 0.55)),
        boxShadow: `0 0 10px ${rgba(c, 0.55)}`,
      }
    : {};
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-pressed={on}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      className={[
        'flex items-center justify-center gap-1 rounded-md border select-none',
        'text-[9px] font-bold uppercase tracking-wider leading-none px-2 py-1.5',
        'transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
        on ? '' : 'border-white/12 bg-black/40 text-zinc-400 hover:text-zinc-200 hover:border-white/25',
        className ?? '',
      ].join(' ')}
      style={{ ...litStyle, ...(shape && shape !== 'default' ? SHAPE_STYLE[shape] : {}), ...style }}
    >
      {children}
    </button>
  );
}
