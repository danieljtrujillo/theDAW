import React, { useRef, useState } from 'react';
import { accentVars, colorAt, rgb, rgba } from '../../lib/trackColor';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/* ── SlideTrack: the bare SLIDE glass-capsule slider ─────────────────────────
   The SLIDE look (capsule track + glowing colour-tracking fill + white knob)
   extracted from SlideRow as a label-less, drop-in replacement for a raw
   `input[type=range].pro-slider`. Each call site keeps its own label
   and value readout; only the slider itself becomes SLIDE. Width/height come from
   `className` (e.g. "w-full", "flex-1", "w-16"); pass `tint` to pin the colour
   instead of having it track the value. */
export function SlideTrack({
  value, onChange, min, max, step = 1, className, tint, ariaLabel, ariaLabelledBy, id, defaultValue,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  className?: string;
  tint?: number;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  id?: string;
  /** Value a double-click resets to. Defaults to 0 (clamped into range). */
  defaultValue?: number;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [drag, setDrag] = useState(false);
  const span = max - min || 1;
  const t = clamp((value - min) / span, 0, 1);
  const base = colorAt(tint ?? t);

  const fromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const nt = clamp((clientX - r.left) / r.width, 0, 1);
    return clamp(min + Math.round((nt * span) / step) * step, min, max);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true; setDrag(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onChange(fromX(e.clientX)); e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(fromX(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false; setDrag(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(clamp(+(value + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(6), min, max));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    let h = true;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': onChange(clamp(+(value + s).toFixed(6), min, max)); break;
      case 'ArrowDown': case 'ArrowLeft': onChange(clamp(+(value - s).toFixed(6), min, max)); break;
      case 'Home': onChange(min); break;
      case 'End': onChange(max); break;
      default: h = false;
    }
    if (h) e.preventDefault();
  };

  return (
    <div
      id={id}
      ref={trackRef}
      role="slider"
      aria-label={ariaLabelledBy ? undefined : ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className={`relative h-2.5 rounded-full bg-black/50 border border-white/10 cursor-pointer select-none ${className ?? ''}`}
      style={{ touchAction: 'none', ...accentVars(tint ?? t) }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onWheel={onWheel} onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(clamp(defaultValue ?? 0, min, max))}
    >
      <div className="absolute inset-y-0.5 left-0.5 rounded-full"
        style={{ width: `calc(${t * 100}% - 2px)`, background: rgb(base), boxShadow: `0 0 8px ${rgba(base, 0.7)}`, transition: drag ? 'none' : 'width 0.08s ease' }} />
      <div className="absolute top-1/2 w-3 h-3 rounded-full bg-white"
        style={{ left: `${t * 100}%`, transform: 'translate(-50%,-50%)', boxShadow: `0 0 8px ${rgba(base, 0.9)}`, transition: drag ? 'none' : 'left 0.08s ease' }} />
    </div>
  );
}
