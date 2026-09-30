/**
 * EffectXYPad — a generic XY surface for a schema-declared param pair (the
 * OwlPad look: dark glass cell, faint grid, crosshair + glowing dot). X and Y
 * travel are log-aware through the same mapping the knobs use, so a
 * frequency axis sweeps musically. The pad is a pointer surface; each axis is
 * also a real slider on its crosshair line (PadAxisSlider): Tab reaches the X
 * slider, then the Y slider, and each takes the arrow keys (Shift = 10
 * steps), PageUp/PageDown, Home and End; Delete resets both. Double-click
 * resets both to their defaults.
 *
 * Like SlideTrack and EffectKnob, the pad reports its GESTURE boundary —
 * `onGestureStart` before the first `onChange` of a drag / key press and
 * `onGestureEnd` after its last — so a consumer recording a gesture (automation
 * touch) does not have to infer one from a deadline. One boundary covers BOTH
 * lanes: a drag writes x and y together, and they begin and end together. Both
 * props are optional; the rules live in `lib/gestureTracker.ts`.
 */
import React, { useEffect, useId, useRef } from 'react';
import { createGestureTracker } from '../../../lib/gestureTracker';
import { formatParamValue, fromNorm, snapParam, toNorm, type ParamSchema } from './paramFormat';
import { PadAxisSlider } from '../PadAxisSlider';

interface EffectXYPadProps {
  label: string;
  xParam: ParamSchema;
  yParam: ParamSchema;
  x: number;
  y: number;
  onChange: (next: { x: number; y: number }) => void;
  size?: number;
  /** Hex accent for the dot/crosshair (defaults to the purple brand). */
  color?: string;
  /** Fired once before the first `onChange` of a gesture. */
  onGestureStart?: () => void;
  /** Fired once after the last `onChange` of a gesture — including a gesture
   *  that produced no change at all, and including an unmount mid-gesture. */
  onGestureEnd?: () => void;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const EffectXYPad: React.FC<EffectXYPadProps> = ({ label, xParam, yParam, x, y, onChange, size = 120, color = '#a855f7', onGestureStart, onGestureEnd }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  const capId = useId();
  // The tracker outlives every render (a gesture spans many), so it reads the
  // callbacks through refs rather than closing over the props of the render that
  // happened to create it. Created ON DEMAND and dropped by the unmount cleanup,
  // because `dispose()` is terminal and StrictMode remounts the same instance.
  const startRef = useRef(onGestureStart); startRef.current = onGestureStart;
  const endRef = useRef(onGestureEnd); endRef.current = onGestureEnd;
  const gestureRef = useRef<ReturnType<typeof createGestureTracker> | null>(null);
  const getGesture = () => (gestureRef.current ??= createGestureTracker({
    onStart: () => startRef.current?.(),
    onEnd: () => endRef.current?.(),
  }));
  // Unmounting mid-gesture still closes it, exactly once.
  useEffect(() => () => {
    gestureRef.current?.dispose();
    gestureRef.current = null;
  }, []);

  const nx = toNorm(xParam, x);
  const ny = toNorm(yParam, y);
  const dotX = nx * size;
  const dotY = (1 - ny) * size;

  const fromPointer = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const tx = clamp((clientX - r.left) / r.width, 0, 1);
    const ty = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    onChange({ x: fromNorm(xParam, tx), y: fromNorm(yParam, ty) });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    getGesture().pointerDown(); // before the press's own write, below
    fromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) fromPointer(e.clientX, e.clientY); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    getGesture().pointerUp();
  };
  // A key press opens the gesture ahead of the change it belongs to; the
  // slider hands over only keys it takes, so an unhandled key stays inert.
  const keyWrite = (key: string, next: { x: number; y: number }) => {
    getGesture().key('down', key);
    onChange(next);
  };
  const reset = (key: string) => keyWrite(key, { x: xParam.default, y: yParam.default });
  // The keyup closes the key gesture; blur (no key) is the backstop for a
  // focus lost mid-press, whose keyup is delivered somewhere else.
  const release = (key?: string) => getGesture().key('up', key);

  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <span id={capId} className="font-sans text-xs font-bold text-zinc-400 leading-none truncate max-w-full">{label}</span>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="group"
        aria-labelledby={capId}
        aria-roledescription="XY pad"
        aria-description={`Drag to set ${xParam.label} (X) and ${yParam.label} (Y), or use the X and Y sliders on the crosshair. Delete resets.`}
        className="shrink-0 rounded bg-black/50 border border-white/10 cursor-crosshair touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => {
          // The reset is a gesture of one change, in its own pair: the clicks
          // that produced the double-click closed their own gestures on their
          // pointerups.
          const g = getGesture();
          g.pointerDown();
          onChange({ x: xParam.default, y: yParam.default });
          g.pointerUp();
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * size} y1={0} x2={f * size} y2={size} stroke="#ffffff" strokeOpacity={0.05} />
            <line x1={0} y1={f * size} x2={size} y2={f * size} stroke="#ffffff" strokeOpacity={0.05} />
          </g>
        ))}
        <line x1={dotX} y1={0} x2={dotX} y2={size} stroke={color} strokeOpacity={0.35} strokeWidth={1} />
        <line x1={0} y1={dotY} x2={size} y2={dotY} stroke={color} strokeOpacity={0.35} strokeWidth={1} />
        <circle cx={dotX} cy={dotY} r={9} fill={color} fillOpacity={0.18} />
        <circle cx={dotX} cy={dotY} r={5} fill={color} stroke="#fff" strokeWidth={1} />
        <PadAxisSlider
          axis="x"
          label={`${label} ${xParam.label} (X)`}
          value={x}
          min={xParam.min}
          max={xParam.max}
          step={xParam.step}
          valueText={formatParamValue(xParam, x)}
          pos={dotX}
          size={size}
          color={color}
          onKey={(next, key) => keyWrite(key, { x: snapParam(xParam, next), y })}
          onReset={reset}
          onKeyRelease={release}
        />
        <PadAxisSlider
          axis="y"
          label={`${label} ${yParam.label} (Y)`}
          value={y}
          min={yParam.min}
          max={yParam.max}
          step={yParam.step}
          valueText={formatParamValue(yParam, y)}
          pos={dotY}
          size={size}
          color={color}
          onKey={(next, key) => keyWrite(key, { x, y: snapParam(yParam, next) })}
          onReset={reset}
          onKeyRelease={release}
        />
        {/* Axis names drawn last with a dark halo, so the crosshair and the dot
            passing under a word never cut its letters. */}
        <text x={size / 2} y={size - 4} textAnchor="middle" fontSize={12} fill="#d4d4d8" stroke="#000" strokeOpacity={0.9} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" className="font-sans font-bold">{xParam.label}</text>
        <text x={4} y={14} fontSize={12} fill="#d4d4d8" stroke="#000" strokeOpacity={0.9} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" className="font-sans font-bold">{yParam.label}</text>
      </svg>
      <span className="font-sans text-xs font-bold text-zinc-400 tabular-nums leading-none whitespace-nowrap">
        {formatParamValue(xParam, x)} · {formatParamValue(yParam, y)}
      </span>
    </div>
  );
};
