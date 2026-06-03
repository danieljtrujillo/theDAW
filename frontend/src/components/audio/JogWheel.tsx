import React, { useEffect, useRef, useState } from 'react';
import { rgb, rgba, type RGB } from '../../lib/trackColor';
import * as djEngine from '../../state/djEngine';

/* ── JogWheel ──────────────────────────────────────────────────────────
   A DJ deck platter: a spinning disc with a position-progress ring and a
   center hub. Rotation + ring are driven IMPERATIVELY from the djEngine
   subscription (no per-frame React re-render). Vinyl-style drag scrubs the
   track (rotational delta → seek, rAF-throttled + pointer-captured).

   `fill` mode sizes the platter to fill its container (ResizeObserver →
   min(width,height)), so the deck can hand it a flex box and the circle
   grows to fill the space instead of sitting small in a sea of dead space. */

const SEC_PER_REV = 1.8;      // 33⅓-rpm feel
const SCRUB_TURNS = 4;        // seconds of travel per full drag-turn
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function JogWheel({ deckId, color, size = 132, disabled, fill }: {
  deckId: djEngine.DeckId;
  color: RGB;
  size?: number;
  disabled?: boolean;
  /** Auto-size the platter to fill its container (min of its width/height). */
  fill?: boolean;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const platterRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const [dim, setDim] = useState(size);

  // In fill mode, track the container's smaller side as the platter diameter.
  useEffect(() => {
    if (!fill) { setDim(size); return; }
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDim(Math.max(48, Math.floor(Math.min(r.width, r.height))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, size]);

  const D = dim;
  const R = D / 2;
  const stroke = Math.max(3, Math.round(D * 0.025));
  const r = R - stroke / 2 - 1;
  const circ = 2 * Math.PI * r;

  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    if (platterRef.current) platterRef.current.style.transform = `rotate(${(st.currentTime / SEC_PER_REV) * 360}deg)`;
    if (ringRef.current) {
      const p = st.duration > 0 ? clamp01(st.currentTime / st.duration) : 0;
      ringRef.current.style.strokeDashoffset = String(circ * (1 - p));
    }
  }), [deckId, circ]);

  // Vinyl scrub — rotational drag seeks proportionally.
  const scrubbing = useRef(false);
  const startAngle = useRef(0);
  const startTime = useRef(0);
  const pendingT = useRef<number | null>(null);
  const raf = useRef(0);
  const angleOf = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.atan2(e.clientY - (rect.top + rect.height / 2), e.clientX - (rect.left + rect.width / 2));
  };
  const apply = () => { raf.current = 0; const t = pendingT.current; pendingT.current = null; if (t != null) djEngine.seekDeck(deckId, t); };
  const onDown = (e: React.PointerEvent) => {
    if (disabled || djEngine.getStatus(deckId).duration <= 0) return;
    scrubbing.current = true;
    startAngle.current = angleOf(e);
    startTime.current = djEngine.getStatus(deckId).currentTime;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    let d = angleOf(e) - startAngle.current;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    pendingT.current = Math.max(0, startTime.current + (d / (2 * Math.PI)) * SEC_PER_REV * SCRUB_TURNS);
    if (!raf.current) raf.current = requestAnimationFrame(apply);
  };
  const onUp = (e: React.PointerEvent) => { scrubbing.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const wheel = (
    <div
      ref={rootRef}
      className={`relative select-none ${disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ width: D, height: D, touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title={disabled ? 'Load a track' : 'Drag to scrub'}
    >
      <svg className="absolute inset-0 -rotate-90" width={D} height={D}>
        <circle cx={R} cy={R} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle ref={ringRef} cx={R} cy={R} r={r} fill="none" stroke={rgb(color)} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${rgba(color, 0.7)})` }} />
      </svg>
      <div
        ref={platterRef}
        className="absolute rounded-full"
        style={{ inset: stroke + 3, background: 'radial-gradient(circle at 50% 38%, #1c1828, #0a080f 72%)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full"
          style={{ width: Math.max(3, D * 0.03), height: '36%', background: rgb(color), boxShadow: `0 0 6px ${rgba(color, 0.85)}` }} />
      </div>
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div className="rounded-full bg-black/70 border border-white/10 grid place-items-center"
          style={{ width: D * 0.32, height: D * 0.32 }}>
          <span className="font-black uppercase" style={{ color: rgb(color), fontSize: Math.max(11, D * 0.1) }}>{deckId}</span>
        </div>
      </div>
    </div>
  );

  if (!fill) return wheel;
  return (
    <div ref={measureRef} className="relative w-full h-full grid place-items-center min-h-0">
      {wheel}
    </div>
  );
}
