/**
 * EffectKnob — the SLIDE rotary dial (the same `.tk-dial` glass skin, 270°
 * conic arc and glowing pointer SlideKnob draws) driven by a param SCHEMA:
 * log travel for frequencies/times, bipolar fill from centre for gains, a
 * unit-aware readout, and double-click reset to the schema default.
 *
 * SlideKnob stays the MAKE/MIX quick-control; this is the schema-driven twin
 * for effect panels. Shared behaviours: vertical drag (Shift = fine), a wheel
 * that only turns the dial holding focus, arrow/Home/End keys, aria-slider
 * semantics.
 */
import React, { memo, useEffect, useId, useRef, useState } from 'react';
import { accentVars, colorAt, rgb, rgba } from '../../../lib/trackColor';
import { formatParamValue, fromNorm, snapParam, toNorm, type ParamSchema } from './paramFormat';

const PX_FULL = 170; // px of vertical drag to sweep the whole travel

interface EffectKnobProps {
  param: ParamSchema;
  value: number;
  onChange: (v: number) => void;
  /** Label shown above the dial (defaults to the param label). */
  label?: string;
  size?: number;
  /** Fixed accent position 0..1; otherwise the colour tracks the travel. */
  tint?: number;
  /** Value a double-click resets to (defaults to the schema default). */
  resetValue?: number;
  disabled?: boolean;
}

const EffectKnobImpl: React.FC<EffectKnobProps> = ({ param, value, onChange, label, size = 40, tint, resetValue, disabled }) => {
  const dialRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const lastY = useRef(0);
  const [active, setActive] = useState(false);
  const labelId = useId();

  const t = toNorm(param, value);
  const colorT = tint ?? t;
  const base = colorAt(colorT);
  const sweep = t * 270;
  const MIDPOINT = 135;
  const bipolar = !!param.bipolar;
  const fStart = Math.min(sweep, MIDPOINT);
  const fEnd = Math.max(sweep, MIDPOINT);
  const arcBg = bipolar
    ? `conic-gradient(from 225deg, rgba(255,255,255,0.09) 0deg ${fStart}deg, ${rgb(base)} ${fStart}deg ${fEnd}deg, ` +
      `rgba(255,255,255,0.09) ${fEnd}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`
    : `conic-gradient(from 225deg, ${rgb(base)} 0deg ${sweep}deg, ` +
      `rgba(255,255,255,0.09) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;

  const set = (v: number) => { if (!disabled) onChange(snapParam(param, v)); };
  const setNorm = (n: number) => { if (!disabled) onChange(fromNorm(param, n)); };
  const stepBy = (n: number) => set(value + n * param.step);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true; setActive(true); lastY.current = e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    // Focus BEFORE preventDefault: preventing the default on pointerdown
    // suppresses the compatibility mousedown and with it the focus a click
    // would otherwise give a tabbable element — so without this the dial could
    // never be document.activeElement and the wheel gate below would be shut
    // forever. preventScroll because effect racks are scrolling panels.
    el.focus({ preventScroll: true });
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = lastY.current - e.clientY;
    lastY.current = e.clientY;
    setNorm(toNorm(param, value) + (dy / PX_FULL) * (e.shiftKey ? 0.25 : 1));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false; setActive(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  // The wheel moves ONLY the focused dial. Every parameter of every effect in
  // the rack is one of these, including each effect's wet/dry MIX — and the MIX
  // rack splices onto the global master insert, so a dial you are merely
  // scrolling PAST must not move: an unmodified wheel over one used to walk the
  // level of everything the app plays, with no undo entry and no cue. Native +
  // non-passive because React registers onWheel passively at the root, where
  // preventDefault() is a silent no-op — and the pass-through path returns
  // BEFORE preventDefault, so scrolling over an unfocused dial still scrolls.
  const wheelStep = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelStep.current = (e) => stepBy((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  useEffect(() => {
    const el = dialRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      wheelStep.current(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled]);
  const onDoubleClick = () => set(resetValue ?? param.default);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mult = e.shiftKey ? 10 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': stepBy(mult); break;
      case 'ArrowDown': case 'ArrowLeft': stepBy(-mult); break;
      case 'PageUp': stepBy(10); break;
      case 'PageDown': stepBy(-10); break;
      case 'Home': set(param.min); break;
      case 'End': set(param.max); break;
      case 'Backspace': case 'Delete': set(resetValue ?? param.default); break;
      default: handled = false;
    }
    // stopPropagation as well as preventDefault: a dial now takes focus on
    // click, so its arrows/Home/End must not ALSO run the window-level editor
    // shortcuts (nudge clip, jump playhead) that share those keys.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const text = formatParamValue(param, value);
  const shownLabel = label ?? param.label;

  return (
    <div
      className={`flex flex-col items-center gap-1 select-none min-w-0 ${disabled ? 'opacity-40' : ''}`}
      style={{ width: size + 14, ...accentVars(colorT) }}
      title={param.tip}
    >
      <span id={labelId} className="text-[8px] font-bold uppercase tracking-wider text-zinc-400 truncate max-w-full text-center leading-none">
        {shownLabel}
      </span>
      <div
        ref={dialRef}
        className={`tk-dial${active ? ' is-active' : ''}`}
        role="slider"
        aria-labelledby={labelId}
        aria-valuemin={param.min}
        aria-valuemax={param.max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        style={{ width: size, height: size, touchAction: 'none', cursor: disabled ? 'default' : 'ns-resize' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => { if (!dragging.current) setActive(false); }}
      >
        <div className="tk-arc" style={{ background: arcBg }} />
        <div className="tk-face" />
        <div className="tk-point" style={{ transform: `rotate(${225 + sweep}deg)` }}><span /></div>
      </div>
      <span
        className="font-mono tabular-nums leading-none whitespace-nowrap"
        style={{
          fontSize: active ? '11px' : '9px',
          fontWeight: active ? 800 : 700,
          color: 'var(--accent)',
          textShadow: active ? `0 0 10px ${rgba(base, 0.55)}` : 'none',
          transition: 'font-size 0.1s ease, text-shadow 0.1s ease',
        }}
      >
        {text}
      </span>
    </div>
  );
};

export const EffectKnob = memo(EffectKnobImpl);
