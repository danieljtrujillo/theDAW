import React, { useRef } from 'react';
import { rgb, rgba, type RGB } from '../../lib/trackColor';

/* ── SlideCrossfader ───────────────────────────────────────────────────
   Horizontal, center-detent bipolar fader (A ↔ B) in the SLIDE visual
   language: glass-capsule track, fill grows OUT from the center toward the
   handle, glowing knob. Colour is data — it tints toward the left accent
   (Deck A) below center and the right accent (Deck B) above center.

   Lag-free: position is driven inline from the live value with no CSS
   transition while dragging. Double-click recentres; wheel fine-tunes.
   Ported from the retired DjFader's pointer logic. */

const A_COLOR: RGB = [168, 85, 247]; // purple — Deck A
const B_COLOR: RGB = [34, 211, 238]; // cyan — Deck B

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export interface SlideCrossfaderProps {
  value: number;
  min?: number;
  max?: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  leftColor?: RGB;
  rightColor?: RGB;
  title?: string;
  ariaLabel?: string;
}

export function SlideCrossfader({
  value, min = -1, max = 1, defaultValue = 0, onChange,
  leftColor = A_COLOR, rightColor = B_COLOR, title, ariaLabel,
}: SlideCrossfaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const range = max - min || 1;
  const t = clamp((value - min) / range, 0, 1); // 0 (A) … 1 (B)
  const p = t * 100;
  const fillLeft = Math.min(p, 50);
  const fillWidth = Math.abs(p - 50);
  const side = value < 0 ? leftColor : rightColor;

  const fromClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    return clamp(min + ((clientX - r.left) / r.width) * range, min, max);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onChange(fromClientX(e.clientX));
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(fromClientX(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(clamp(value + (e.deltaY < 0 ? 1 : -1) * (range / 100) * (e.shiftKey ? 10 : 1), min, max));
  };

  return (
    <div
      ref={ref}
      className="relative h-3.5 w-full rounded-full bg-black/50 border border-white/10 cursor-pointer select-none"
      style={{ touchAction: 'none' }}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={title}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onWheel={onWheel}
      onDoubleClick={() => onChange(defaultValue)}
    >
      {/* center detent tick */}
      <div className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-white/15" />
      {/* fill grows out from center */}
      <div
        className="absolute inset-y-0.5 rounded-full"
        style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: rgb(side), boxShadow: `0 0 8px ${rgba(side, 0.7)}` }}
      />
      {/* knob */}
      <div
        className="absolute top-1/2 w-4 h-4 rounded-full bg-white"
        style={{ left: `${p}%`, transform: 'translate(-50%,-50%)', boxShadow: `0 0 8px ${rgba(side, 0.9)}` }}
      />
    </div>
  );
}
