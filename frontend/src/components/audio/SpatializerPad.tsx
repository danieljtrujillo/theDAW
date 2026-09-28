/**
 * SpatializerPad — the visual guide + motion presets for the HRTF Spatializer
 * effect. A top-down pad (X = left/right, Z = front/back) shows the listener at
 * center and the source position; dragging sets azimuth and distance. A motion
 * selector + one-click presets (orbit, ping-pong, up/down, figure-8) drive the
 * audio-rate motion, and a path overlay previews where the source travels and,
 * for orbits, which way it spins.
 *
 * The pad is a pointer surface; its two axes are also real sliders on lines
 * through the source (PadAxisSlider): X is left/right and Z is front/back, in
 * the pad's distance units, so the keyboard and a screen reader move the
 * source across and forward one axis at a time.
 *
 * Rendered by FxRack in place of the generic sliders when the effect is the
 * spatializer. Values round-trip through the same ChainEntry.params the audio
 * factory reads, so the pad and the sound stay in sync.
 */

import { useEffect, useRef } from 'react';
import { SlideTrack } from './SlideTrack';
import { PadAxisSlider } from './PadAxisSlider';
import { createGestureTracker } from '../../lib/gestureTracker';
import { getRackEffect, SPATIAL_MOTIONS, SPATIAL_PRESETS } from '../../lib/rackEffects';

interface SpatializerPadProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
  /** The panel's gesture boundary: one start before the first `onChange` of a
   *  drag / key press / wheel burst and one end after its last. Lets a consumer
   *  recording a gesture (automation touch) stop guessing it from a deadline.
   *  See lib/gestureTracker.ts. The SLIDE sliders forward their own; the
   *  top-down pad is a bespoke pointer target with a single input, so it
   *  reports the pair directly from its pointerdown / pointerup. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

const PAD = 140;              // svg viewport (square)
const C = PAD / 2;            // center
const R = C - 12;             // usable radius (leave a ring margin)
const MAX_DIST = 8;           // distance value mapped to the pad edge
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Source azimuth/distance -> left/right (x) and front/back (z) in distance units. */
const sourceAxes = (azDeg: number, dist: number): { x: number; z: number } => {
  const az = (azDeg * Math.PI) / 180;
  return { x: Math.sin(az) * dist, z: Math.cos(az) * dist };
};

/** Left/right and front/back back to the azimuth (whole degrees) and distance the effect reads. */
const axesToSource = (x: number, z: number, minDist: number): { azimuth: number; distance: number } => ({
  azimuth: Math.round((Math.atan2(x, z) * 180) / Math.PI),
  distance: +clamp(Math.hypot(x, z), minDist, MAX_DIST).toFixed(2),
});

/** Source azimuth/distance -> pad pixel coords (front = up, right = right). */
const sourceXY = (azDeg: number, dist: number) => {
  const az = (azDeg * Math.PI) / 180;
  const r = (clamp(dist, 0, MAX_DIST) / MAX_DIST) * R;
  return { x: C + Math.sin(az) * r, y: C - Math.cos(az) * r };
};

export function SpatializerPad({ params, onChange, idPrefix, onGestureStart, onGestureEnd }: SpatializerPadProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  // Unmounting mid-drag must still close the gesture: the pad's own pointerup
  // will never arrive, and a begun lane with no end is the one failure the
  // automation store cannot recover from (lib/automationGesture.ts). Read
  // through a ref so the cleanup cannot close over a stale prop.
  const endRef = useRef(onGestureEnd); endRef.current = onGestureEnd;
  const startRef = useRef(onGestureStart); startRef.current = onGestureStart;
  // The axis sliders' key gestures, closed on keyup, blur or unmount.
  const keyGesture = useRef<ReturnType<typeof createGestureTracker> | null>(null);
  const getKeyGesture = () => (keyGesture.current ??= createGestureTracker({
    onStart: () => startRef.current?.(),
    onEnd: () => endRef.current?.(),
  }));
  useEffect(() => () => {
    if (dragging.current) endRef.current?.();
    keyGesture.current?.dispose();
    keyGesture.current = null;
  }, []);
  const def = getRackEffect('spatializer');

  const azimuth = params.azimuth ?? 0;
  const elevation = params.elevation ?? 0;
  const distance = params.distance ?? 1.5;
  const motion = Math.round(params.motion ?? 0);
  const motionRate = params.motionRate ?? 0.3;
  const motionDepth = params.motionDepth ?? 1.5;

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });
  const merge = (values: Record<string, number>) => onChange({ ...params, ...values });

  const src = sourceXY(azimuth, distance);
  const depthPx = (clamp(motionDepth, 0, MAX_DIST) / MAX_DIST) * R;

  const fromPointer = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Map client px into the 0..PAD viewport (svg is rendered at rect size).
    const px = ((clientX - rect.left) / rect.width) * PAD;
    const py = ((clientY - rect.top) / rect.height) * PAD;
    const nx = (px - C) / R;
    const nz = -(py - C) / R; // up = front = +z
    const dist = clamp(Math.hypot(nx, nz) * MAX_DIST, def?.params.find((p) => p.key === 'distance')?.min ?? 0.5, MAX_DIST);
    const az = (Math.atan2(nx, nz) * 180) / Math.PI; // 0 = front, +90 = right
    onChange({ ...params, azimuth: Math.round(az), distance: +dist.toFixed(2) });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    onGestureStart?.(); // before the press's own write, below
    fromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) fromPointer(e.clientX, e.clientY); };
  const onUp = (e: React.PointerEvent) => {
    // pointerup and pointercancel both land here; only the one that actually
    // ended a drag closes the gesture, so the pair stays balanced.
    const wasDragging = dragging.current;
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (wasDragging) onGestureEnd?.();
  };

  // Path overlay describing the motion around the source point. The pad is a
  // top-down view (X across, Z front/back), so the Y (elevation) half of the
  // vertical orbits is drawn dashed to read as out of the plane.
  const renderMotionPath = () => {
    if (motion === 0) return null;
    const stroke = '#a855f7';
    // Autopilot — fixed dashed orbit ring + a tiny level-meter glyph: its motion is
    // driven by the audio at play time, not the Depth slider, so use a fixed radius.
    if (motion === 11) {
      const r = R * 0.6;
      const bars = [0.5, 1, 0.7];
      return (
        <g>
          <circle cx={src.x} cy={src.y} r={r} fill="none" stroke={stroke} strokeOpacity={0.4} strokeWidth={1.2} strokeDasharray="3 3" />
          {bars.map((h, i) => (
            <line key={i} x1={src.x + (i - 1) * 4} y1={src.y + 4} x2={src.x + (i - 1) * 4} y2={src.y + 4 - 9 * h} stroke={stroke} strokeOpacity={0.85} strokeWidth={1.6} />
          ))}
        </g>
      );
    }
    if (depthPx < 1) return null;
    // Horizontal orbit (XZ) — circle in the pad plane + spin-direction arrow.
    if (motion === 1 || motion === 2) {
      const cw = motion === 1;
      const ax = src.x + (cw ? depthPx : -depthPx) * 0.35;
      return (
        <g>
          <circle cx={src.x} cy={src.y} r={depthPx} fill="none" stroke={stroke} strokeOpacity={0.5} strokeWidth={1.2} />
          <path
            d={`M ${ax} ${src.y - depthPx - 3} L ${ax + (cw ? 5 : -5)} ${src.y - depthPx} L ${ax} ${src.y - depthPx + 3} Z`}
            fill={stroke}
          />
        </g>
      );
    }
    // Frontal orbit (XY wheel) — X span in-plane, elevation half dashed-vertical.
    if (motion === 3) {
      return (
        <g stroke={stroke} strokeOpacity={0.55} strokeWidth={1.2} fill="none">
          <ellipse cx={src.x} cy={src.y} rx={depthPx} ry={depthPx * 0.4} />
          <line x1={src.x} y1={src.y - depthPx} x2={src.x} y2={src.y + depthPx} strokeDasharray="2 2" strokeOpacity={0.4} />
        </g>
      );
    }
    // Sagittal orbit (YZ, over the top) — front/back span in-plane, elevation dashed.
    if (motion === 4) {
      return (
        <g stroke={stroke} strokeOpacity={0.55} strokeWidth={1.2} fill="none">
          <ellipse cx={src.x} cy={src.y} rx={depthPx * 0.4} ry={depthPx} />
          <line x1={src.x - depthPx} y1={src.y} x2={src.x + depthPx} y2={src.y} strokeDasharray="2 2" strokeOpacity={0.4} />
        </g>
      );
    }
    // Spherical — horizontal circle plus a dashed precession ring.
    if (motion === 5) {
      return (
        <g fill="none" stroke={stroke} strokeOpacity={0.5} strokeWidth={1.2}>
          <circle cx={src.x} cy={src.y} r={depthPx} />
          <ellipse cx={src.x} cy={src.y} rx={depthPx} ry={depthPx * 0.45} strokeDasharray="2 2" strokeOpacity={0.4} />
        </g>
      );
    }
    // Ping-pong (X) — horizontal line.
    if (motion === 6) {
      return (
        <line x1={src.x - depthPx} y1={src.y} x2={src.x + depthPx} y2={src.y} stroke={stroke} strokeOpacity={0.6} strokeWidth={1.2} />
      );
    }
    // Up/down (Y, elevation) — vertical dashed glyph (out of the XZ plane).
    if (motion === 7) {
      return (
        <line x1={src.x} y1={src.y - depthPx} x2={src.x} y2={src.y + depthPx} stroke={stroke} strokeOpacity={0.6} strokeWidth={1.2} strokeDasharray="2 2" />
      );
    }
    // Figure-8 (XZ lemniscate) — two side-by-side circles.
    if (motion === 8) {
      const r2 = depthPx * 0.5;
      return (
        <g fill="none" stroke={stroke} strokeOpacity={0.5} strokeWidth={1.2}>
          <circle cx={src.x - r2} cy={src.y} r={r2} />
          <circle cx={src.x + r2} cy={src.y} r={r2} />
        </g>
      );
    }
    // Expand/Collapse (radial breathing) — concentric rings from the source.
    if (motion === 9) {
      return (
        <g fill="none" stroke={stroke} strokeOpacity={0.5} strokeWidth={1.2}>
          <circle cx={src.x} cy={src.y} r={depthPx} strokeDasharray="3 3" />
          <circle cx={src.x} cy={src.y} r={depthPx * 0.5} />
        </g>
      );
    }
    // Teleport — scattered dots evoking chunks jumping to spread positions (the
    // actual targets come from onset analysis at play time; this is just a hint).
    if (motion === 10) {
      const dots = Array.from({ length: 7 }, (_, i) => {
        const a = (i * 137.508 * Math.PI) / 180;
        const r = depthPx * (0.35 + 0.6 * ((i % 3) / 2));
        return { x: src.x + Math.cos(a) * r, y: src.y + Math.sin(a) * r };
      });
      return (
        <g fill={stroke} fillOpacity={0.55}>
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={1.6} />
          ))}
        </g>
      );
    }
    return null;
  };

  const minDist = def?.params.find((p) => p.key === 'distance')?.min ?? 0.5;
  const axes = sourceAxes(azimuth, distance);
  const axisText = (v: number, neg: string, pos: string) => (Math.abs(v) < 0.005 ? 'centre' : `${Math.abs(v).toFixed(1)} ${v < 0 ? neg : pos}`);
  const keyMove = (key: string, x: number, z: number) => {
    getKeyGesture().key('down', key);
    onChange({ ...params, ...axesToSource(x, z, minDist) });
  };
  const keyRelease = (key?: string) => getKeyGesture().key('up', key);

  const motionId = `${idPrefix}-motion`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <svg
          ref={svgRef}
          width={PAD}
          height={PAD}
          viewBox={`0 0 ${PAD} ${PAD}`}
          role="group"
          aria-roledescription="XY pad"
          aria-label="Spatial position pad. Drag to set azimuth and distance, or use the left-right and front-back sliders through the source. Precise values are in the sliders below."
          className="shrink-0 rounded bg-black/50 border border-white/10 cursor-crosshair touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* distance rings */}
          {[0.33, 0.66, 1].map((f) => (
            <circle key={f} cx={C} cy={C} r={R * f} fill="none" stroke="#ffffff" strokeOpacity={0.08} />
          ))}
          {/* axes */}
          <line x1={C} y1={C - R} x2={C} y2={C + R} stroke="#ffffff" strokeOpacity={0.06} />
          <line x1={C - R} y1={C} x2={C + R} y2={C} stroke="#ffffff" strokeOpacity={0.06} />
          {/* front marker */}
          <text x={C} y={15} textAnchor="middle" fontSize={12} fill="#a1a1aa" className="font-display font-bold">FRONT</text>
          {renderMotionPath()}
          {/* listener */}
          <circle cx={C} cy={C} r={3} fill="#52525b" />
          {/* source */}
          <line x1={C} y1={C} x2={src.x} y2={src.y} stroke="#a855f7" strokeOpacity={0.35} strokeWidth={1} />
          <circle cx={src.x} cy={src.y} r={5} fill="#a855f7" stroke="#fff" strokeWidth={1} />
          <PadAxisSlider
            axis="x"
            label="Source left-right (X)"
            value={+axes.x.toFixed(2)}
            min={-MAX_DIST}
            max={MAX_DIST}
            step={0.1}
            valueText={axisText(axes.x, 'left', 'right')}
            pos={src.x}
            size={PAD}
            color="#a855f7"
            onKey={(next, key) => keyMove(key, next, axes.z)}
            onKeyRelease={keyRelease}
          />
          <PadAxisSlider
            axis="y"
            label="Source front-back (Z)"
            value={+axes.z.toFixed(2)}
            min={-MAX_DIST}
            max={MAX_DIST}
            step={0.1}
            valueText={axisText(axes.z, 'behind', 'in front')}
            pos={src.y}
            size={PAD}
            color="#a855f7"
            onKey={(next, key) => keyMove(key, axes.x, next)}
            onKeyRelease={keyRelease}
          />
        </svg>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <label htmlFor={motionId} className="sr-only">Motion mode</label>
          <select
            id={motionId}
            name={motionId}
            value={motion}
            onChange={(e) => set('motion', Number(e.target.value))}
            className="form-select px-2 py-1 font-sans text-xs font-bold"
            style={{ colorScheme: 'dark' }}
          >
            {SPATIAL_MOTIONS.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-1">
            {SPATIAL_PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => merge(preset.values)}
                className="font-sans text-xs font-bold px-1.5 py-1 rounded border border-white/5 bg-black/30 text-zinc-400 hover:text-purple-200 hover:border-purple-500/40 hover:bg-purple-500/10 transition-colors truncate"
                title={`Apply the ${preset.label} motion preset`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Precise + accessible numeric controls */}
      <div className="flex flex-col gap-1">
        {[
          { key: 'azimuth', label: 'Azimuth', value: azimuth, min: -180, max: 180, step: 1, unit: 'deg' },
          { key: 'elevation', label: 'Elevation', value: elevation, min: -90, max: 90, step: 1, unit: 'deg' },
          { key: 'distance', label: 'Distance', value: distance, min: 0.5, max: 10, step: 0.1, unit: '' },
          { key: 'motionRate', label: 'Rate', value: motionRate, min: 0, max: 4, step: 0.01, unit: 'Hz' },
          { key: 'motionDepth', label: 'Depth', value: motionDepth, min: 0, max: 8, step: 0.1, unit: '' },
        ].map((p) => {
          const labelId = `${idPrefix}-${p.key}-label`;
          const decimals = p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span id={labelId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">{p.label}</span>
              <SlideTrack
                value={p.value}
                min={p.min}
                max={p.max}
                step={p.step}
                ariaLabelledBy={labelId}
                className="flex-1"
                onChange={(v) => set(p.key, v)}
                onGestureStart={onGestureStart}
                onGestureEnd={onGestureEnd}
              />
              <span className="font-sans text-xs font-bold text-zinc-300 w-16 shrink-0 text-right tabular-nums">
                {p.value.toFixed(decimals)}{p.unit ? ` ${p.unit}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
