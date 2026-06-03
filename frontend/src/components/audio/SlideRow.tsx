import React, { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { accentVars, colorAt, rgb, rgba } from '../../lib/trackColor';
import { HoverTip } from '../ui/Tooltip';
import { HOVER_TOOLTIPS } from '../ui/tooltips';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/* ── SlideRow: horizontal SLIDE-style fader row ────────────────────────
   Glass-capsule track + glowing colored fill/knob (the SLIDE look, laid
   out horizontally), a value field that tints with the value, and fixed
   slots so every row's number/suffix/randomize line up in a column.
   Shared by the MAKE (AdvancedGenPanel) and MIX (MixPanel) rails. */
export function SlideRow({ label, value, onChange, min, max, step = 1, tipKey, onRandomize }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  tipKey?: string;
  onRandomize?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [drag, setDrag] = useState(false);
  const span = max - min || 1;
  const t = clamp((value - min) / span, 0, 1);
  const base = colorAt(t);
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
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;
  const labelEl = <span className="text-[11px] text-zinc-300 whitespace-nowrap">{label}</span>;
  return (
    <div className="flex items-center gap-2" style={accentVars(t)}>
      <div className="w-16 shrink-0 flex items-center gap-1">
        {tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}
        {onRandomize && (
          <button onClick={onRandomize} title="Randomize" className="btn-ghost cursor-pointer p-0.5 shrink-0 text-zinc-500 hover:text-purple-300">
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
      <div ref={trackRef}
        className="relative flex-1 min-w-0 h-3 rounded-full bg-black/50 border border-white/10 cursor-pointer select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="absolute inset-y-0.5 left-0.5 rounded-full"
          style={{ width: `calc(${t * 100}% - 2px)`, background: rgb(base), boxShadow: `0 0 8px ${rgba(base, 0.7)}`, transition: drag ? 'none' : 'width 0.08s ease' }} />
        <div className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-white"
          style={{ left: `${t * 100}%`, transform: 'translate(-50%,-50%)', boxShadow: `0 0 8px ${rgba(base, 0.9)}`, transition: drag ? 'none' : 'left 0.08s ease' }} />
      </div>
      <input type="number" className="compact-input w-11 text-center tabular-nums shrink-0"
        style={{ color: rgb(base), fontWeight: 700 }}
        min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value || 0)} />
    </div>
  );
}
