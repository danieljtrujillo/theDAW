/**
 * NodeF.I. control language — deliberately NOT the SLIDE style guide.
 *
 * Ranged params render as a TENDRIL: a filament under tension, anchored at
 * both ends, with a bead node pulled along it — the curve bows through the
 * bead like a plucked fiber, the spent portion of the filament thickens, and
 * a faint root drops from the bead to the rest line. Organic in line and
 * form, synthetic in precision. All colors are the node's accent MUTED
 * toward slate (nothing neon) over theme-var neutrals, so the controls sit
 * correctly on every theme.
 *
 * Choices render as CELLS: asymmetric-radius chips whose corners alternate,
 * reading as grown rather than stamped.
 *
 * Full input surface: drag, wheel (shift = ×10), arrow keys / Home / End,
 * double-click to reset, and a click-to-type exact value.
 */
import React, { useEffect, useRef, useState } from 'react';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Mix a hex accent toward slate so nothing reads neon; returns rgb(). */
export function muteAccent(hex: string, amt = 0.45): string {
  const n = hex.replace('#', '');
  if (n.length < 6) return hex;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const mix = (c: number, toward: number) => Math.round(c + (toward - c) * amt);
  return `rgb(${mix(r, 123)} ${mix(g, 130)} ${mix(b, 144)})`;
}

/** Trim float noise for display ("0.30000000004" → "0.3"). */
const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** Value readout that swaps to a bare underline input on click. */
function EditableValue({
  id,
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onChange(clamp(n, min ?? -Infinity, max ?? Infinity));
    setEditing(false);
  };
  if (editing) {
    return (
      <span className="shrink-0">
        <label htmlFor={id} className="sr-only">{label} value</label>
        <input
          id={id}
          name={id}
          type="number"
          autoFocus
          className="w-16 bg-transparent border-0 border-b border-white/25 text-right text-[12px] font-mono font-semibold text-zinc-100 outline-none focus:border-white/50 py-0"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(fmt(value));
        setEditing(true);
      }}
      title="Click to type an exact value"
      aria-label={`${label}: ${fmt(value)}${unit ? ` ${unit}` : ''} — click to type an exact value`}
      className="shrink-0 px-1 rounded text-[12px] font-mono font-semibold tabular-nums text-zinc-200 hover:text-white hover:bg-white/5 transition-colors"
    >
      {fmt(value)}
      {unit ? <span className="text-zinc-600 ml-0.5">{unit}</span> : null}
    </button>
  );
}

/** The tendril — NodeF.I.'s ranged-parameter control. */
export function TendrilParam({
  id,
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  unit,
  accent,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue?: number;
  unit?: string;
  accent: string;
  onChange: (v: number) => void;
}): React.ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(200);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const sync = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = max - min || 1;
  const t = clamp((value - min) / span, 0, 1);
  const tone = muteAccent(accent);

  const H = 26;
  const PAD = 7;
  const track = Math.max(20, width - PAD * 2);
  const baseY = 19;
  const lift = dragging ? 10 : 7;
  const bx = PAD + t * track;
  const by = baseY - lift;
  // Two quadratic segments through the bead — the filament bows toward it.
  const leftD = `M ${PAD},${baseY} Q ${(PAD + bx) / 2},${baseY} ${bx},${by}`;
  const rightD = `M ${bx},${by} Q ${(bx + PAD + track) / 2},${baseY} ${PAD + track},${baseY}`;

  const snap = (raw: number) => {
    const stepped = min + Math.round((raw - min) / step) * step;
    return clamp(Number(stepped.toFixed(6)), min, max);
  };
  const fromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    // A ratio of viewport px over viewport px — layout zoom cancels out.
    const f = clamp((clientX - rect.left) / rect.width, 0, 1);
    return snap(min + f * span);
  };

  const draggingRef = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    draggingRef.current = true;
    setDragging(true);
    // Capture can throw on exotic/synthetic pointers — never let it eat the value change.
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* uncaptured drag still works */ }
    onChange(fromClientX(e.clientX));
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) onChange(fromClientX(e.clientX));
  };
  const endDrag = (e: React.PointerEvent) => {
    draggingRef.current = false;
    setDragging(false);
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  };
  const onWheel = (e: React.WheelEvent) => {
    onChange(snap(value + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step * (e.shiftKey ? 10 : 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        onChange(snap(value + s));
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        onChange(snap(value - s));
        break;
      case 'Home':
        onChange(min);
        break;
      case 'End':
        onChange(max);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono-label truncate">{label}</span>
        <EditableValue id={id} label={label} value={value} unit={unit} min={min} max={max} step={step} onChange={onChange} />
      </div>
      <svg
        ref={svgRef}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        className="block w-full cursor-ew-resize select-none outline-none focus-visible:ring-1 focus-visible:ring-white/30 rounded"
        style={{ height: H, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onChange(clamp(defaultValue ?? min, min, max))}
      >
        {/* rest line — where the filament would lie slack */}
        <line
          x1={PAD}
          y1={baseY}
          x2={PAD + track}
          y2={baseY}
          style={{ stroke: 'rgb(var(--et-line, 255 255 255) / 0.12)' }}
          strokeWidth={1}
          strokeDasharray="1 5"
        />
        {/* growth marks along the rest line */}
        {[0.25, 0.5, 0.75].map((f) => (
          <circle
            key={f}
            cx={PAD + f * track}
            cy={baseY}
            r={1}
            style={{ fill: 'rgb(var(--et-line, 255 255 255) / 0.18)' }}
          />
        ))}
        {/* spent filament — thick, muted accent */}
        <path d={leftD} fill="none" stroke={tone} strokeWidth={2.25} strokeLinecap="round" style={{ opacity: 0.95 }} />
        {/* slack filament — thin, neutral */}
        <path
          d={rightD}
          fill="none"
          strokeWidth={1.25}
          strokeLinecap="round"
          style={{ stroke: 'rgb(var(--et-line, 255 255 255) / 0.3)' }}
        />
        {/* root — the bead's tether back to rest */}
        <line x1={bx} y1={by + 3} x2={bx} y2={baseY} stroke={tone} strokeWidth={0.75} style={{ opacity: 0.5 }} />
        {/* the bead node */}
        <circle cx={bx} cy={by} r={6} fill={tone} style={{ opacity: 0.16 }} />
        <circle cx={bx} cy={by} r={3} fill={tone} />
        <circle cx={bx - 0.9} cy={by - 0.9} r={0.9} fill="rgba(255,255,255,0.55)" />
      </svg>
    </div>
  );
}

/** Organic segmented choice — alternating asymmetric cells. */
export function CellChoice({
  label,
  value,
  options,
  accent,
  onChange,
  columns,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  accent: string;
  onChange: (v: string) => void;
  /** Grid columns; omit for a natural wrap. */
  columns?: number;
}): React.ReactElement {
  const tone = muteAccent(accent);
  return (
    <div>
      <span className="mono-label block mb-0.5">{label}</span>
      <div
        role="group"
        aria-label={label}
        className={columns ? 'grid gap-1' : 'flex flex-wrap gap-1'}
        style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {options.map((o, i) => {
          const active = o.value === value;
          const radii = i % 2 === 0 ? '10px 3px 10px 3px' : '3px 10px 3px 10px';
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              title={o.label}
              style={{
                borderRadius: radii,
                ...(active ? { borderColor: tone, background: `${accent}14` } : undefined),
              }}
              className={`px-1.5 py-1 border text-[10px] font-mono font-bold uppercase tracking-wide truncate transition-colors min-w-0 ${
                active
                  ? 'text-(--text-primary)'
                  : 'border-white/10 bg-white/2 text-zinc-500 hover:text-zinc-200 hover:border-white/25'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Unbounded numeric param — a quiet underline row, not a box. */
export function BareNumber({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-white/8 pb-1">
      <label htmlFor={id} className="mono-label truncate">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        className="w-20 bg-transparent border-0 text-right text-[12px] font-mono font-semibold tabular-nums text-zinc-200 outline-none focus:text-white py-0"
        value={value}
        min={min}
        max={max}
        step={step ?? 'any'}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
