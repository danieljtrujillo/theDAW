/**
 * PadAxisSlider — one axis of an XY pad as a real slider.
 *
 * An XY pad is a pointer surface: a drag sets two values at once. A screen
 * reader and a keyboard need each value on its own, so every pad draws two of
 * these inside its SVG, one on the X crosshair line and one on the Y line.
 * Each is a focusable `role="slider"` with its own name, range and
 * `aria-valuenow`, operated by the keys the ARIA slider pattern lists:
 * Right/Up raise it by a step, Left/Down lower it, PageUp/PageDown move ten
 * steps (Shift+arrow too), Home and End go to the ends. Delete runs the pad's
 * own reset when it has one.
 *
 * The pad keeps its drag: a press on the line lands on the SVG under it, so the
 * pad's pointer handlers see it as they did. The slider draws a wider,
 * brighter line while it holds focus, so the focused axis is visible.
 *
 * The pad owns the values; this component only computes the next value of a
 * key press and hands it to `onKey`, which also receives the key so the pad can
 * open and close its gesture (lib/gestureTracker) around the write.
 */
import React, { useState } from 'react';

export interface PadAxisSliderProps {
  axis: 'x' | 'y';
  /** Accessible name, such as "Filter cutoff (X)". */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What a screen reader reads for the value ("440 Hz"). */
  valueText: string;
  /** Where the crosshair line sits, in the SVG's own units. */
  pos: number;
  /** The SVG's size in its own units (the line spans it). */
  size: number;
  color: string;
  /** A key press that moves the value: the new value, already clamped to min..max, and the key. */
  onKey: (next: number, key: string) => void;
  /** Delete / Backspace: the pad's reset, when it has one. */
  onReset?: (key: string) => void;
  /** Every keyup and the blur (key undefined), so the pad can close a key gesture. */
  onKeyRelease?: (key?: string) => void;
}

const clampTo = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The value a key press gives, or null for a key the slider does not take. */
export function padAxisNext(key: string, shift: boolean, value: number, min: number, max: number, step: number): number | null {
  const big = step * 10;
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return clampTo(value + (shift ? big : step), min, max);
    case 'ArrowLeft': case 'ArrowDown': return clampTo(value - (shift ? big : step), min, max);
    case 'PageUp': return clampTo(value + big, min, max);
    case 'PageDown': return clampTo(value - big, min, max);
    case 'Home': return min;
    case 'End': return max;
    default: return null;
  }
}

export const PadAxisSlider: React.FC<PadAxisSliderProps> = ({
  axis, label, value, min, max, step, valueText, pos, size, color, onKey, onReset, onKeyRelease,
}) => {
  const [focused, setFocused] = useState(false);
  const line = axis === 'x'
    ? { x1: pos, y1: 0, x2: pos, y2: size }
    : { x1: 0, y1: pos, x2: size, y2: pos };
  return (
    <g
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className="outline-none cursor-crosshair"
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); onKeyRelease?.(); }}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && onReset) {
          onReset(e.key);
          e.preventDefault();
          return;
        }
        const next = padAxisNext(e.key, e.shiftKey, value, min, max, step);
        if (next === null) return;
        onKey(next, e.key);
        e.preventDefault();
      }}
      onKeyUp={(e) => onKeyRelease?.(e.key)}
    >
      {/* A wide, clear stroke: the line's hit area and the focus target. */}
      <line {...line} stroke="#000" strokeOpacity={0} strokeWidth={12} />
      {focused && <line {...line} stroke={color} strokeOpacity={0.95} strokeWidth={3} />}
    </g>
  );
};
