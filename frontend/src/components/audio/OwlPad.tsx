/**
 * OwlPad — XY performance surface for the OWL-Pad rack effect. Dragging sets the
 * effect's x/y params live (and engages it); a program selector picks what the
 * two axes do, and HOLD latches the last position instead of gating back to dry
 * when the pointer is released.
 *
 * The pad is a pointer surface; each axis is also a real slider on its
 * crosshair line (PadAxisSlider), so the keyboard and a screen reader reach X
 * and Y one at a time. A key press engages the effect like a press on the pad,
 * and with HOLD off the key's release gates it back to dry like a pointer
 * release.
 *
 * Rendered by FxRack in place of the generic sliders when the effect is 'owlpad'.
 * Values round-trip through the same ChainEntry.params the audio factory reads,
 * so the pad and the sound stay in sync (and the offline bounce uses them too).
 */

import { useEffect, useRef } from 'react';
import { SlideTrack } from './SlideTrack';
import { PadAxisSlider } from './PadAxisSlider';
import { createGestureTracker } from '../../lib/gestureTracker';
import { OWLPAD_PROGRAMS } from '../../lib/rackEffects';

interface OwlPadProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
  /** The panel's gesture boundary: one start before the first `onChange` of a
   *  drag / key press / wheel burst and one end after its last. Lets a consumer
   *  recording a gesture (automation touch) stop guessing it from a deadline.
   *  See lib/gestureTracker.ts. The SLIDE slider forwards its own; the XY
   *  SURFACE is a bespoke pointer target with a single input, so it reports the
   *  pair directly — the end after the release's own write (the gate-off), so
   *  that write lands INSIDE the gesture rather than after it. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

const PAD = 150; // svg viewport (square)
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** What the X and Y axes sweep for each program (for the on-pad captions). */
const axisLabels = (program: number): { x: string; y: string } => {
  switch (Math.round(program)) {
    case 3: return { x: 'Time', y: 'Feedback' };
    case 4: return { x: 'Freq', y: 'Feedback' };
    default: return { x: 'Freq', y: 'Reso' };
  }
};

export function OwlPad({ params, onChange, idPrefix, onGestureStart, onGestureEnd }: OwlPadProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);
  // Unmounting mid-drag must still close the gesture: the pad's own pointerup
  // will never arrive, and a begun lane with no end is the one failure the
  // automation store cannot recover from (lib/automationGesture.ts). Read
  // through a ref so the cleanup cannot close over a stale prop.
  const endRef = useRef(onGestureEnd); endRef.current = onGestureEnd;
  const startRef = useRef(onGestureStart); startRef.current = onGestureStart;
  // The axis sliders' key gestures: one start before a press's first write,
  // one end after its keyup (or the blur). Created on demand, closed on unmount.
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

  const x = clamp(params.x ?? 0.5, 0, 1);
  const y = clamp(params.y ?? 0.3, 0, 1);
  const program = Math.round(params.program ?? 0);
  const mix = params.mix ?? 1;
  const hold = (params.hold ?? 1) >= 0.5;
  const engaged = (params.active ?? 1) >= 0.5;

  const dotX = x * PAD;
  const dotY = (1 - y) * PAD; // y = 1 is the top of the pad
  const labels = axisLabels(program);

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });

  const fromPointer = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
    onChange({ ...params, x: +nx.toFixed(3), y: +(1 - ny).toFixed(3), active: 1 });
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
    if (!hold) onChange({ ...params, active: 0 }); // gate back to dry on release
    if (wasDragging) onGestureEnd?.();             // AFTER that final write
  };

  const keyMove = (key: string, next: Record<string, number>) => {
    getKeyGesture().key('down', key);
    onChange({ ...params, ...next, active: 1 });
  };
  const keyRelease = (key?: string) => {
    // A key's release gates back to dry like a pointer release, inside the gesture.
    if (key !== undefined && !hold && engaged) onChange({ ...params, active: 0 });
    getKeyGesture().key('up', key);
  };

  const programId = `${idPrefix}-owlpad-program`;
  const mixId = `${idPrefix}-owlpad-mix-label`;

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
          aria-label={`OWL-Pad XY pad. Drag to sweep ${labels.x} on the X axis and ${labels.y} on the Y axis, or use the X and Y sliders on the crosshair.`}
          className="shrink-0 rounded bg-black/50 border border-white/10 cursor-crosshair touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* grid */}
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f}>
              <line x1={f * PAD} y1={0} x2={f * PAD} y2={PAD} stroke="#ffffff" strokeOpacity={0.05} />
              <line x1={0} y1={f * PAD} x2={PAD} y2={f * PAD} stroke="#ffffff" strokeOpacity={0.05} />
            </g>
          ))}
          {/* crosshair + position dot (dimmed when gated to dry) */}
          <line x1={dotX} y1={0} x2={dotX} y2={PAD} stroke="#a855f7" strokeOpacity={engaged ? 0.4 : 0.12} strokeWidth={1} />
          <line x1={0} y1={dotY} x2={PAD} y2={dotY} stroke="#a855f7" strokeOpacity={engaged ? 0.4 : 0.12} strokeWidth={1} />
          <circle cx={dotX} cy={dotY} r={6} fill={engaged ? '#a855f7' : '#3f3f46'} stroke="#fff" strokeWidth={1} />
          <PadAxisSlider
            axis="x"
            label={`OWL-Pad ${labels.x} (X)`}
            value={x}
            min={0}
            max={1}
            step={0.01}
            valueText={`${labels.x} ${Math.round(x * 100)}%`}
            pos={dotX}
            size={PAD}
            color="#a855f7"
            onKey={(next, key) => keyMove(key, { x: +next.toFixed(3) })}
            onKeyRelease={keyRelease}
          />
          <PadAxisSlider
            axis="y"
            label={`OWL-Pad ${labels.y} (Y)`}
            value={y}
            min={0}
            max={1}
            step={0.01}
            valueText={`${labels.y} ${Math.round(y * 100)}%`}
            pos={dotY}
            size={PAD}
            color="#a855f7"
            onKey={(next, key) => keyMove(key, { y: +next.toFixed(3) })}
            onKeyRelease={keyRelease}
          />
          {/* axis captions, drawn last with a dark halo so the crosshair and the
              dot passing under a word never cut its letters */}
          <text x={PAD / 2} y={PAD - 4} textAnchor="middle" fontSize={12} fill="#d4d4d8" stroke="#000" strokeOpacity={0.9} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" className="font-sans font-bold">{labels.x}</text>
          <text x={4} y={14} fontSize={12} fill="#d4d4d8" stroke="#000" strokeOpacity={0.9} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" className="font-sans font-bold">{labels.y}</text>
        </svg>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <label htmlFor={programId} className="sr-only">OWL-Pad program</label>
          <select
            id={programId}
            name={programId}
            value={program}
            onChange={(e) => set('program', Number(e.target.value))}
            className="form-select px-2 py-1 font-sans text-xs font-bold"
            style={{ colorScheme: 'dark' }}
          >
            {OWLPAD_PROGRAMS.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
          {/* Fixed name with aria-pressed; the visible word flips with the state. */}
          <button
            onClick={() => set('hold', hold ? 0 : 1)}
            aria-pressed={hold}
            aria-label="Hold"
            title={hold ? 'Hold on: the pad latches its last position' : 'Hold off: releasing the pad gates back to dry'}
            className={`font-display text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${hold ? 'border-purple-500/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
          >
            {hold ? 'HOLD' : 'GATE'}
          </button>
          <div className="flex items-center gap-2">
            <span id={mixId} className="font-sans text-xs font-bold text-zinc-400 w-8 shrink-0">Mix</span>
            <SlideTrack
              value={mix}
              min={0}
              max={1}
              step={0.01}
              ariaLabelledBy={mixId}
              className="flex-1"
              onChange={(v) => set('mix', v)}
              onGestureStart={onGestureStart}
              onGestureEnd={onGestureEnd}
            />
            <span className="font-sans text-xs font-bold text-zinc-300 w-8 shrink-0 text-right tabular-nums">{mix.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
