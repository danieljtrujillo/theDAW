/**
 * Draggable separator between two columns of a dock pane.
 *
 * Unlike the bare surface `Splitter` (which emits a raw px delta for the DJ
 * design grid) this one speaks in the 0..1 fraction the host stores, and it is
 * a real `role="separator"` widget: focusable, with arrow-key resizing and the
 * aria-value range the store clamps to.
 *
 * Two details that are easy to get wrong here:
 *   - the fraction is `(clientX - box.left) / box.width`, and both terms are
 *     viewport px, so the shell's CSS `zoom` cancels out (see lib/canvasScale
 *     for the coordinate spaces this avoids converting between);
 *   - `onChange` is throttled to one animation frame and the store is only
 *     written on release, because OSMD and alphaTab re-engrave on every width
 *     change and a raw pointermove stream queues one layout pass per event.
 */
import React, { useEffect, useRef, useState } from 'react';

export interface PaneSplitterProps {
  /** Current fraction (0..1) of the container the LEFT column takes. */
  value: number;
  /** Live preview while dragging — one call per animation frame. */
  onChange: (f: number) => void;
  /** Settled value: on release, and on every keyboard step. */
  onCommit: (f: number) => void;
  /** The row that holds both columns; the fraction is measured against it. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Accessible name, e.g. "Lyrics and score split". */
  label: string;
  /** id of the pane this separator resizes (the primary one), for
   *  aria-controls — the relationship a focusable separator has to expose. */
  controls?: string;
  min?: number;
  max?: number;
  /** Arrow-key step as a fraction; Shift takes four of them. */
  step?: number;
}

export const PaneSplitter: React.FC<PaneSplitterProps> = ({
  value,
  onChange,
  onCommit,
  containerRef,
  label,
  controls,
  min = 0.2,
  max = 0.8,
  step = 0.02,
}) => {
  const [dragging, setDragging] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const pending = useRef(value);

  const clamp = (f: number): number => Math.min(max, Math.max(min, f));

  // The panes share the row MINUS the bar, so the bar's own width comes out of
  // the span before the fraction is taken and half of it back off the pointer —
  // otherwise the bar trails the cursor by up to its own width at the extremes.
  const fractionAt = (clientX: number): number | null => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return null;
    const bar = barRef.current?.getBoundingClientRect().width ?? 0;
    const span = box.width - bar;
    if (span <= 0) return null;
    return clamp((clientX - box.left - bar / 2) / span);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pending.current = value;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const f = fractionAt(e.clientX);
    if (f === null) return;
    pending.current = f;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      onChange(pending.current);
    });
  };

  const onUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setDragging(false);
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    onCommit(pending.current);
  };

  // ScoreView's PAGE view pages on a WINDOW ArrowLeft/ArrowRight that only
  // skips INPUT/TEXTAREA/SELECT, so a resize from a focused separator would
  // also flip the page. Stop the key here once it has been handled.
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? step * 4 : step;
    if (e.key === 'ArrowLeft') onCommit(clamp(value - d));
    else if (e.key === 'ArrowRight') onCommit(clamp(value + d));
    else if (e.key === 'Home') onCommit(min);
    else if (e.key === 'End') onCommit(max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const pct = Math.round(value * 100);

  return (
    <>
      {/* While dragging, a full-window overlay sits above both panes so a canvas
          or iframe child can't swallow pointermove — the same guard Shell.tsx
          uses for the dock's height grip. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <div
        ref={barRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controls}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={pct}
        aria-valuetext={`${pct}% to the left pane`}
        tabIndex={0}
        title="Drag to resize (← / → keys; Shift for larger steps)"
        // A 4px bar reads right but is a miserable pointer target, so the
        // grabbable area is widened to ~20px with a pseudo-element that takes
        // no layout space — the columns still meet where the line is drawn.
        className={`relative w-1 shrink-0 cursor-col-resize outline-none touch-none transition-colors after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] ${
          dragging
            ? 'bg-rose-400/70'
            : 'bg-white/10 hover:bg-rose-400/40 focus-visible:bg-rose-400/60'
        }`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      />
    </>
  );
};

export default PaneSplitter;
