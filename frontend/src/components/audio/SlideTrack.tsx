import React, { useEffect, useRef, useState } from 'react';
import { accentVars, colorAt, rgb, rgba } from '../../lib/trackColor';
import { createGestureTracker } from '../../lib/gestureTracker';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/* ── SlideTrack: the bare SLIDE glass-capsule slider ─────────────────────────
   The SLIDE look (capsule track + glowing colour-tracking fill + white knob)
   extracted from SlideRow as a label-less, drop-in replacement for a raw
   `input[type=range].pro-slider`. Each call site keeps its own label
   and value readout; only the slider itself becomes SLIDE. Width/height come from
   `className` (e.g. "w-full", "flex-1", "w-16"); pass `tint` to pin the colour
   instead of having it track the value.

   The widget also reports its GESTURE boundary — `onGestureStart` before the
   first `onChange` of a drag / key press / wheel burst and `onGestureEnd` after
   its last — so a consumer recording a gesture (automation touch, an undo
   coalescer) does not have to infer one from window listeners and a deadline.
   Both props are optional and the widget behaves identically without them; the
   rules live in `lib/gestureTracker.ts`. */
export function SlideTrack({
  value, onChange, min, max, step = 1, className, tint, ariaLabel, ariaLabelledBy, id, defaultValue,
  onGestureStart, onGestureEnd,
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
  /** Fired once before the first `onChange` of a gesture. */
  onGestureStart?: () => void;
  /** Fired once after the last `onChange` of a gesture — including a gesture
   *  that produced no change at all, and including an unmount mid-gesture. */
  onGestureEnd?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [drag, setDrag] = useState(false);
  // The tracker outlives every render (a gesture spans many), so it reads the
  // callbacks through refs rather than closing over the props of the render that
  // happened to create it.
  const startRef = useRef(onGestureStart); startRef.current = onGestureStart;
  const endRef = useRef(onGestureEnd); endRef.current = onGestureEnd;
  const gestureRef = useRef<ReturnType<typeof createGestureTracker> | null>(null);
  // Created ON DEMAND, never during render, and dropped by the unmount cleanup.
  // `dispose()` is terminal, so a tracker that survived a cleanup would be a dead
  // widget: StrictMode runs mount → cleanup → mount on the SAME instance with
  // refs intact, which under a render-time `??=` left every handler a no-op for
  // the whole dev session. Clearing the ref makes the second mount build a fresh
  // one, and in production the cleanup only ever runs at the real unmount.
  const getGesture = () => (gestureRef.current ??= createGestureTracker({
    onStart: () => startRef.current?.(),
    onEnd: () => endRef.current?.(),
  }));
  // Unmounting mid-gesture still closes it, exactly once.
  useEffect(() => () => {
    gestureRef.current?.dispose();
    gestureRef.current = null;
  }, []);
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
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    // Focus BEFORE preventDefault: preventing the default on pointerdown
    // suppresses the compatibility mousedown and with it the focus a click
    // would otherwise give a tabbable element — so without this the widget
    // could never become document.activeElement, and the wheel gate below
    // would be shut forever. It is also what role="slider" + tabIndex promise.
    el.focus({ preventScroll: true });
    getGesture().pointerDown();
    onChange(fromX(e.clientX)); e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(fromX(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false; setDrag(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    getGesture().pointerUp();
  };
  // The wheel moves ONLY the focused slider. This one widget is the footer's
  // master volume, every EDIT track fader and every effect parameter in the app,
  // and a fader you are merely scrolling PAST must not move: an unmodified wheel
  // over one used to walk its value with no undo entry and no cue beyond a 10 px
  // fill. Native + non-passive because React registers onWheel passively at the
  // root, where preventDefault() is a silent no-op — and the pass-through path
  // returns BEFORE preventDefault so scrolling over a slider still scrolls.
  const wheelStep = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelStep.current = (e) => {
    getGesture().wheelTick();
    onChange(clamp(+(value + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(6), min, max));
  };
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      wheelStep.current(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // The next value is computed BEFORE anything is dispatched, so the gesture can
  // open ahead of the change it belongs to and an unhandled key stays inert.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': next = clamp(+(value + s).toFixed(6), min, max); break;
      case 'ArrowDown': case 'ArrowLeft': next = clamp(+(value - s).toFixed(6), min, max); break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
    }
    if (next === null) return;
    getGesture().key('down', e.key);
    onChange(next);
    // stopPropagation as well as preventDefault: clicking a slider now focuses
    // it, so arrows/Home/End reaching this handler must not ALSO run the
    // window-level editor shortcuts (nudge clip, jump playhead) that share them.
    e.preventDefault(); e.stopPropagation();
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
      onKeyDown={onKeyDown}
      // The keyup closes the key gesture; blur is the backstop for a focus lost
      // mid-press, whose keyup is delivered somewhere else. Neither can touch a
      // pointer drag or a wheel burst — see lib/gestureTracker.ts.
      onKeyUp={(e) => getGesture().key('up', e.key)}
      onBlur={() => getGesture().key('up')}
      onDoubleClick={() => {
        // The reset is a gesture of one change, in its own pair: the clicks that
        // produced the double-click closed their own gestures on their pointerups.
        const g = getGesture();
        g.pointerDown();
        onChange(clamp(defaultValue ?? 0, min, max));
        g.pointerUp();
      }}
    >
      <div className="absolute inset-y-0.5 left-0.5 rounded-full"
        style={{ width: `calc(${t * 100}% - 2px)`, background: rgb(base), boxShadow: `0 0 8px ${rgba(base, 0.7)}`, transition: drag ? 'none' : 'width 0.08s ease' }} />
      <div className="absolute top-1/2 w-3 h-3 rounded-full bg-white"
        style={{ left: `${t * 100}%`, transform: 'translate(-50%,-50%)', boxShadow: `0 0 8px ${rgba(base, 0.9)}`, transition: drag ? 'none' : 'left 0.08s ease' }} />
    </div>
  );
}
