/**
 * SLIDE-tab control widgets — React ports of the standalone /sliders template.
 *
 *   TrackFader — vertical glass capsule + smooth colored fill + number ruler
 *   TrackKnob  — 270° colored arc + glowing pointer (gap at the bottom)
 *   TrackPad   — toggle / momentary button that lights up in its color
 *
 * Each widget reads/writes its own value from slideStore (keyed by content +
 * item), so dragging one control only re-renders that control. Visual theme is
 * driven by --accent* CSS custom properties from trackColor.accentVars().
 *
 * Styling lives in track-controls.css (imported by SlidePanel). The shared
 * 4-row rhythm (.tw-name / .tw-body / .tw-value / .tw-map) keeps faders,
 * knobs, and pads aligned row-for-row in a column.
 */
import React, { memo, useRef } from 'react';
import { accentVars, colorAt, rgb, rgba, shade, smoothstep, seededValue, type RGB } from '../../lib/trackColor';
import { useSlideStore, valueKey, type SlideContent } from '../../state/slideStore';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const FOCUS_UNITS = 22; // magnifier reach for the ruler, in value units

interface WidgetProps {
  item: string;
  content: SlideContent;
  mapping?: string;
  /** Greyed, non-interactive — a physical control with nothing mapped to it
   *  (CONTROLLER view shows the full hardware layout this way). */
  muted?: boolean;
  /** Name shown on the lane, when it differs from the store key `item`
   *  (e.g. a stack lane keyed `stack:<id>` but titled by the stack name). */
  displayLabel?: string;
}

/* ============================== FADER ==================================== */
// memo: a fader subscribes to its OWN value, so dragging one (or clicking a
// view/page) never re-renders its siblings.
const TrackFaderImpl: React.FC<WidgetProps> = ({ item, content, mapping, muted, displayLabel }) => {
  const key = valueKey(content, item);
  const stored = useSlideStore((s) => s.values[key]);
  const setValue = useSlideStore((s) => s.setValue);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const value = muted ? 0 : (stored ?? seededValue(item));
  const t = value / 100;
  const base = colorAt(t);

  const fromClientY = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const yl = clamp(clientY - r.top, 0, r.height);
    return clamp(Math.round((1 - yl / r.height) * 100), 0, 100);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setValue(item, fromClientY(e.clientY));
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) setValue(item, fromClientY(e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    setValue(item, value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    let h = true;
    // Up/Down only — ←/→ are reserved for page navigation at the panel level.
    switch (e.key) {
      case 'ArrowUp': setValue(item, value + step); break;
      case 'ArrowDown': setValue(item, value - step); break;
      case 'PageUp': setValue(item, value + 10); break;
      case 'PageDown': setValue(item, value - 10); break;
      case 'Home': setValue(item, 100); break;
      case 'End': setValue(item, 0); break;
      default: h = false;
    }
    if (h) e.preventDefault();
  };

  // ruler marks every 5 units (numbers every 10). Step 5 (not 2) roughly
  // halves the node count per fader — a big win when many lanes re-render —
  // and reads cleaner at this compact scale where every-2 ticks merged anyway.
  const marks: React.ReactNode[] = [];
  for (let v = 0; v <= 100; v += 5) {
    const isMajor = v % 10 === 0;
    const p = smoothstep(1 - Math.abs(v - value) / FOCUS_UNITS);
    const tickW = isMajor ? 12 : 8;
    const txt: RGB = [lerp(150, 255, p), lerp(150, 255, p), lerp(155, 255, p)];
    const tickCol: RGB = [lerp(150, base[0], p), lerp(150, base[1], p), lerp(155, base[2], p)];
    marks.push(
      <div
        key={v}
        className="ts-mark"
        style={{
          top: `${(1 - v / 100) * 100}%`,
          transform: `translate(${-p * 7}px, -50%) scale(${1 + p * 0.6})`,
          opacity: lerp(0.22, 1, p),
          color: rgb(txt),
          // a bulging (magnified) number must paint ABOVE its smaller
          // neighbors — without this the next ruler mark, drawn later, clipped
          // the top of the enlarged digits.
          zIndex: 1 + Math.round(p * 10),
          ['--mark-glow' as string]: p > 0.02 ? `0 0 ${6 + p * 12}px ${rgba(base, 0.85 * p)}` : 'none',
        }}
      >
        {isMajor && <span className="ts-num">{v}</span>}
        <span className="ts-tick" style={{ width: tickW, background: rgb(tickCol) }} />
      </div>,
    );
  }

  const name = displayLabel ?? item;
  return (
    <div className={`tw${muted ? ' muted' : ''}`} style={accentVars(t)}>
      <div className="tw-name" title={muted ? '' : name}>{muted ? '—' : name}</div>
      <div className="tw-body">
        <div className="ts-stage">
          <div className="ts-scale">{marks}</div>
          <div
            className="ts-body"
            onPointerDown={muted ? undefined : onPointerDown}
            onPointerMove={muted ? undefined : onPointerMove}
            onPointerUp={muted ? undefined : onPointerUp}
            onPointerCancel={muted ? undefined : onPointerUp}
            onWheel={muted ? undefined : onWheel}
          >
            <div className="ts-track" ref={trackRef}>
              <div className="ts-fill" style={{ height: `${Math.max(t * 100, 3.5)}%` }} />
              <div
                className="ts-knob"
                tabIndex={muted ? -1 : 0}
                role="slider"
                aria-label={name}
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
                aria-disabled={muted || undefined}
                onKeyDown={muted ? undefined : onKeyDown}
                style={{ top: `${(1 - t) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="tw-value">{muted ? '—' : value}</div>
      <div className="tw-map" title={mapping || 'UNMAPPED'}>{muted ? 'UNMAPPED' : mapping || 'UNMAPPED'}</div>
    </div>
  );
};
export const TrackFader = memo(TrackFaderImpl);

/* ============================== KNOB ==================================== */
const TrackKnobImpl: React.FC<WidgetProps> = ({ item, content, mapping, muted }) => {
  const key = valueKey(content, item);
  const stored = useSlideStore((s) => s.values[key]);
  const setValue = useSlideStore((s) => s.setValue);
  const dragging = useRef(false);
  const lastY = useRef(0);
  const PX_FULL = 200;

  const value = muted ? 0 : (stored ?? seededValue(item));
  const t = value / 100;
  const base = colorAt(t);
  const sweep = t * 270;
  // gap centered at the BOTTOM: sweep clockwise from 7:30 (225°)
  const arcBg =
    `conic-gradient(from 225deg, ${rgb(base)} 0deg ${sweep}deg, ` +
    `rgba(255,255,255,0.09) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    lastY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = lastY.current - e.clientY;
    lastY.current = e.clientY;
    setValue(item, value + (dy / PX_FULL) * 100 * (e.shiftKey ? 0.25 : 1));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    setValue(item, value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    let h = true;
    // Up/Down only — ←/→ are reserved for page navigation at the panel level.
    switch (e.key) {
      case 'ArrowUp': setValue(item, value + step); break;
      case 'ArrowDown': setValue(item, value - step); break;
      case 'Home': setValue(item, 100); break;
      case 'End': setValue(item, 0); break;
      default: h = false;
    }
    if (h) e.preventDefault();
  };

  return (
    <div className={`tw${muted ? ' muted' : ''}`} style={accentVars(t)}>
      <div className="tw-name" title={muted ? '' : item}>{muted ? '—' : item}</div>
      <div className="tw-body">
        <div
          className="tk-dial"
          tabIndex={muted ? -1 : 0}
          role="slider"
          aria-label={item}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          aria-disabled={muted || undefined}
          onPointerDown={muted ? undefined : onPointerDown}
          onPointerMove={muted ? undefined : onPointerMove}
          onPointerUp={muted ? undefined : onPointerUp}
          onPointerCancel={muted ? undefined : onPointerUp}
          onWheel={muted ? undefined : onWheel}
          onKeyDown={muted ? undefined : onKeyDown}
        >
          <div className="tk-arc" style={{ background: arcBg }} />
          <div className="tk-face" />
          <div className="tk-point" style={{ transform: `rotate(${225 + sweep}deg)` }}>
            <span />
          </div>
        </div>
      </div>
      <div className="tw-value">{muted ? '—' : value}</div>
      <div className="tw-map" title={mapping || 'UNMAPPED'}>{muted ? 'UNMAPPED' : mapping || 'UNMAPPED'}</div>
    </div>
  );
};
export const TrackKnob = memo(TrackKnobImpl);

/* ============================== PAD ==================================== */
interface PadProps {
  item: string;
  content: SlideContent;
  color: RGB;
  momentary?: boolean;
  muted?: boolean;
}
const TrackPadImpl: React.FC<PadProps> = ({ item, content, color, momentary, muted }) => {
  const key = valueKey(content, item);
  const stored = useSlideStore((s) => s.pads[key]);
  const setOn = useSlideStore((s) => s.setOn);
  const on = muted ? false : (stored ?? false);

  const padVars = {
    ['--pad' as string]: rgb(color),
    ['--pad-bright' as string]: rgb(shade(color, 0.4)),
    ['--pad-glow' as string]: rgba(color, 0.65),
  };

  const handleDown = () => { if (momentary) setOn(item, true); };
  const handleUp = () => { if (momentary && on) setOn(item, false); };
  const handleClick = () => { if (!momentary) setOn(item, !on); };
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (momentary) { setOn(item, true); window.setTimeout(() => setOn(item, false), 120); }
      else setOn(item, !on);
    }
  };

  return (
    <div className={`tw${muted ? ' muted' : ''}`} style={padVars}>
      <div className="tw-name" title={muted ? '' : item}>{muted ? '—' : item}</div>
      <div className="tw-body">
        <button
          type="button"
          className={`tp-btn${on ? ' on' : ''}`}
          aria-pressed={on}
          aria-disabled={muted || undefined}
          tabIndex={muted ? -1 : 0}
          title={item}
          onPointerDown={muted ? undefined : handleDown}
          onPointerUp={muted ? undefined : handleUp}
          onPointerLeave={muted ? undefined : handleUp}
          onClick={muted ? undefined : handleClick}
          onKeyDown={muted ? undefined : handleKey}
        >
          <span className="tp-led" />
        </button>
      </div>
      <div className={`tw-value tp-value${on ? ' on' : ''}`}>{muted ? '—' : on ? 'ON' : 'OFF'}</div>
      <div className="tw-map" title={item}>{muted ? 'UNMAPPED' : on ? 'ACTIVE' : 'TOGGLE'}</div>
    </div>
  );
};
export const TrackPad = memo(TrackPadImpl);
