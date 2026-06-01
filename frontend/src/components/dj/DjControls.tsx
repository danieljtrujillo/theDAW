/**
 * DJ control widgets — the SLIDE controller-surface look (glass-capsule fader,
 * 270° conic-arc knob, glowing pad button) as plain prop-driven components for
 * the DJ decks. Visuals live in dj-controls.css; theme via the --accent and
 * --pad custom properties derived from the deck color.
 */
import React, { useRef } from 'react';
import { rgb, rgba, shade, type RGB } from '../../lib/trackColor';
import './dj-controls.css';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Deck-color → --accent* custom props (matches the SLIDE fill/glow theme). */
export function accentVars(color: RGB): React.CSSProperties {
  return {
    ['--accent']: rgb(color),
    ['--accent-bright']: rgb(shade(color, 0.45)),
    ['--accent-deep']: rgb(shade(color, -0.35)),
    ['--accent-glow']: rgba(color, 0.55),
    ['--accent-faint']: rgba(color, 0.16),
  } as React.CSSProperties;
}

function padVars(color: RGB): React.CSSProperties {
  return {
    ['--pad']: rgb(color),
    ['--pad-bright']: rgb(shade(color, 0.4)),
    ['--pad-glow']: rgba(color, 0.6),
  } as React.CSSProperties;
}

/* ------------------------------- KNOB -------------------------------------- */
interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  color: RGB;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  size?: number; // px
  title?: string;
}

export const DjKnob: React.FC<KnobProps> = ({
  label, value, min, max, defaultValue = 0, color, onChange, format, size = 40, title,
}) => {
  const dragging = useRef(false);
  const lastY = useRef(0);
  const range = max - min || 1;
  const t = clamp((value - min) / range, 0, 1);
  const sweep = t * 270;
  const arcBg =
    `conic-gradient(from 225deg, ${rgb(color)} 0deg ${sweep}deg, ` +
    `rgba(255,255,255,0.09) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    lastY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = lastY.current - e.clientY;
    lastY.current = e.clientY;
    onChange(clamp(value + (dy / 180) * range * (e.shiftKey ? 0.25 : 1), min, max));
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(clamp(value + (e.deltaY < 0 ? 1 : -1) * (range / 100) * (e.shiftKey ? 10 : 1), min, max));
  };

  return (
    <div className="dj-widget" style={accentVars(color)} title={title}>
      <div className="dj-name">{label}</div>
      <div
        className="dj-knob"
        style={{ ['--dial-d']: `${size}px` } as React.CSSProperties}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
        onDoubleClick={() => onChange(defaultValue)}
      >
        <div className="dj-knob-arc" style={{ background: arcBg }} />
        <div className="dj-knob-face" />
        <div className="dj-knob-point" style={{ transform: `rotate(${225 + sweep}deg)` }}>
          <span />
        </div>
      </div>
      <div className="dj-value">{format ? format(value) : value.toFixed(1)}</div>
    </div>
  );
};

/* --------------------------- HORIZONTAL FADER ------------------------------ */
interface FaderProps {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  color: RGB;
  onChange: (v: number) => void;
  /** Show a center detent tick (crossfader, pitch zero). */
  center?: boolean;
  title?: string;
  ariaLabel?: string;
}

export const DjFader: React.FC<FaderProps> = ({
  value, min, max, defaultValue, color, onChange, center, title, ariaLabel,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const range = max - min || 1;
  const t = clamp((value - min) / range, 0, 1);
  const p = t * 100;
  // With `center`, the colored fill grows OUT from the midpoint toward the
  // handle (no color when centered) — like a crossfader. Otherwise it fills
  // from the left edge.
  const fillLeft = center ? Math.min(p, 50) : 0;
  const fillWidth = center ? Math.abs(p - 50) : p;

  const fromClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    return clamp(min + ((clientX - r.left) / r.width) * range, min, max);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onChange(fromClientX(e.clientX));
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(fromClientX(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(clamp(value + (e.deltaY < 0 ? 1 : -1) * (range / 100) * (e.shiftKey ? 10 : 1), min, max));
  };

  return (
    <div
      ref={ref}
      className="dj-fader"
      style={accentVars(color)}
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
      onDoubleClick={defaultValue != null ? () => onChange(defaultValue) : undefined}
    >
      <div className="dj-fader-track" />
      {center && <div className="dj-fader-center" />}
      <div className="dj-fader-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />
      <div className="dj-fader-knob" style={{ left: `${p}%` }} />
    </div>
  );
};

/* -------------------------------- PAD -------------------------------------- */
interface PadProps {
  children: React.ReactNode;
  on?: boolean;
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

export const DjPad: React.FC<PadProps> = ({
  children, on, color, disabled, danger, title, className, style,
  onClick, onContextMenu, onPointerDown, onPointerUp, onPointerLeave,
}) => (
  <button
    type="button"
    className={`dj-pad${on ? ' on' : ''}${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`}
    style={{ ...(color ? padVars(color) : {}), ...style }}
    aria-pressed={on}
    disabled={disabled}
    title={title}
    onClick={onClick}
    onContextMenu={onContextMenu}
    onPointerDown={onPointerDown}
    onPointerUp={onPointerUp}
    onPointerLeave={onPointerLeave}
  >
    {children}
  </button>
);

/* Deck accent colors (match the existing purple/cyan deck theme). */
export const DECK_RGB: Record<'purple' | 'cyan', RGB> = {
  purple: [168, 85, 247],
  cyan: [34, 211, 238],
};
