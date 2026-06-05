/**
 * Bare pointer-drag splitter primitive (extracted verbatim from the DJ
 * DesignLayout so the surface module is self-contained). Emits a pixel delta on
 * drag; the caller converts that to an fr transfer between two neighbours. The
 * splitter does not stretch itself — it lives inside a fixed-size gap track.
 */
import React, { useRef } from 'react';

export const Splitter: React.FC<{
  axis: 'x' | 'y';
  onDelta: (dpx: number) => void;
  className?: string;
  title?: string;
}> = ({ axis, onDelta, className, title }) => {
  const drag = useRef(false);
  const last = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    drag.current = true;
    last.current = axis === 'x' ? e.clientX : e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const cur = axis === 'x' ? e.clientX : e.clientY;
    onDelta(cur - last.current);
    last.current = cur;
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title={title ?? 'Drag to resize'}
      className={`z-50 rounded-full bg-purple-400/50 hover:bg-purple-300 transition-colors ${axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'} ${className ?? ''}`}
    />
  );
};
