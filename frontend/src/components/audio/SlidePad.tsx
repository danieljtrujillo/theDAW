import React from 'react';
import { rgb, rgba, shade, type RGB } from '../../lib/trackColor';

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
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerLeave?: (e: React.PointerEvent) => void;
}

export function SlidePad({
  children, on, color, disabled, danger, title, className, style,
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
      style={{ ...litStyle, ...style }}
    >
      {children}
    </button>
  );
}
