/**
 * EffectXYPad — a generic XY surface for a schema-declared param pair (the
 * OwlPad look: dark glass cell, faint grid, crosshair + glowing dot). X and Y
 * travel are log-aware through the same mapping the knobs use, so a
 * frequency axis sweeps musically. Keyboard: arrows nudge X/Y by one step
 * (Shift = 10 steps); double-click resets both to their defaults.
 */
import React, { useId, useRef } from 'react';
import { formatParamValue, fromNorm, snapParam, toNorm, type ParamSchema } from './paramFormat';

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
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const EffectXYPad: React.FC<EffectXYPadProps> = ({ label, xParam, yParam, x, y, onChange, size = 120, color = '#a855f7' }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  const capId = useId();

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
    fromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) fromPointer(e.clientX, e.clientY); };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const m = e.shiftKey ? 10 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': onChange({ x: snapParam(xParam, x + xParam.step * m), y }); break;
      case 'ArrowLeft': onChange({ x: snapParam(xParam, x - xParam.step * m), y }); break;
      case 'ArrowUp': onChange({ x, y: snapParam(yParam, y + yParam.step * m) }); break;
      case 'ArrowDown': onChange({ x, y: snapParam(yParam, y - yParam.step * m) }); break;
      case 'Backspace': case 'Delete': onChange({ x: xParam.default, y: yParam.default }); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  };

  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <span id={capId} className="text-[8px] font-bold uppercase tracking-wider text-zinc-400 leading-none truncate max-w-full">{label}</span>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="application"
        aria-labelledby={capId}
        aria-roledescription="XY pad"
        aria-description={`Drag to set ${xParam.label} (X) and ${yParam.label} (Y). Arrow keys nudge; Delete resets.`}
        tabIndex={0}
        className="shrink-0 rounded bg-black/50 border border-white/10 cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => onChange({ x: xParam.default, y: yParam.default })}
        onKeyDown={onKeyDown}
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
        <text x={size / 2} y={size - 3} textAnchor="middle" fontSize={7} fill="#71717a" fontFamily="monospace">{xParam.label}</text>
        <text x={3} y={9} fontSize={7} fill="#71717a" fontFamily="monospace">{yParam.label}</text>
      </svg>
      <span className="text-[8px] font-mono text-zinc-400 tabular-nums leading-none whitespace-nowrap">
        {formatParamValue(xParam, x)} · {formatParamValue(yParam, y)}
      </span>
    </div>
  );
};
