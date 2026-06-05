/**
 * Bare pointer-drag splitter primitive (extracted verbatim from the DJ
 * DesignLayout so the surface module is self-contained). Emits a pixel delta on
 * drag; the caller converts that to an fr transfer between two neighbours. The
 * splitter does not stretch itself — it lives inside a fixed-size gap track, so
 * it already spans the full cross-axis and reads as a guide line while dragging.
 *
 * Optional `snap` quantizes the boundary to a px step (0 = smooth); holding Ctrl
 * during the drag forces a 1px fine step. While active the bar glows so the user
 * sees the live guide line.
 */
import React, { useRef, useState } from 'react';

export const Splitter: React.FC<{
  axis: 'x' | 'y';
  onDelta: (dpx: number) => void;
  className?: string;
  title?: string;
  /** Snap step in px (0/undefined = smooth). Ctrl overrides to 1px. */
  snap?: number;
}> = ({ axis, onDelta, className, title, snap }) => {
  const drag = useRef(false);
  const last = useRef(0);
  const acc = useRef(0);
  const [active, setActive] = useState(false);
  const onDown = (e: React.PointerEvent) => {
    drag.current = true;
    setActive(true);
    last.current = axis === 'x' ? e.clientX : e.clientY;
    acc.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const cur = axis === 'x' ? e.clientX : e.clientY;
    const raw = cur - last.current;
    last.current = cur;
    const step = e.ctrlKey ? 1 : Math.max(1, snap ?? 0);
    if (step <= 1) {
      onDelta(raw); // smooth (no snapping, or 1px fine step)
      return;
    }
    // Quantize: only emit whole `step`-px increments, carrying the remainder.
    acc.current += raw;
    const n = Math.trunc(acc.current / step);
    if (n !== 0) {
      onDelta(n * step);
      acc.current -= n * step;
    }
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = false;
    setActive(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title={title ?? 'Drag to resize' + (snap ? ' · snaps (Ctrl = fine)' : '')}
      className={`z-50 rounded-full transition-colors ${
        active
          ? 'bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.7)]'
          : 'bg-purple-400/50 hover:bg-purple-300'
      } ${axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'} ${className ?? ''}`}
    />
  );
};
