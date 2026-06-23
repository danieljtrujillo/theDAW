/**
 * AutomationLane — draws one automation lane's curve over a timeline row, and when
 * `editable` is on, lets the user add, drag, and delete breakpoints directly on it.
 *
 *  - click the empty curve area: add a breakpoint
 *  - drag a point: move it (clamped between its neighbors so points never cross)
 *  - right-click or Alt-click a point: delete it
 *
 * Pointer math uses getBoundingClientRect ratios so it stays correct under the
 * app's CSS transform scale (rendered px vs layout px). Read-only lanes set
 * pointer-events to none so clip editing underneath is unaffected.
 */

import { useRef } from 'react';
import { useEditorStore, type AutomationLane as Lane } from '../../state/editorStore';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
// Keep a dragged point this far (seconds) from its neighbors, comfortably beyond
// the store's MIN_POINT_DT thinning so a drag never merges into a neighbor.
const DRAG_GAP = 0.03;

interface AutomationLaneProps {
  lane: Lane;
  zoom: number;
  width: number;
  height: number;
  top: number;
  color: string;
  /** value -> [0,1] (0 = bottom, 1 = top). */
  toNorm: (v: number) => number;
  /** [0,1] -> value. */
  fromNorm: (n: number) => number;
  editable: boolean;
}

export function AutomationLane({
  lane, zoom, width, height, top, color, toNorm, fromNorm, editable,
}: AutomationLaneProps) {
  const addAutomationPoint = useEditorStore((s) => s.addAutomationPoint);
  const updateAutomationPoint = useEditorStore((s) => s.updateAutomationPoint);
  const removeAutomationPoint = useEditorStore((s) => s.removeAutomationPoint);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);

  const yOf = (v: number) => (1 - clamp(toNorm(v), 0, 1)) * height;
  const maxT = width / Math.max(1e-6, zoom);

  // Pointer (clientX/Y) -> (t seconds, value), using rect ratios for scale safety.
  const fromPointer = (clientX: number, clientY: number): { t: number; v: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { t: 0, v: fromNorm(0.5) };
    const fx = clamp((clientX - rect.left) / rect.width, 0, 1);
    const fy = clamp((clientY - rect.top) / rect.height, 0, 1);
    return { t: clamp(fx * maxT, 0, maxT), v: fromNorm(1 - fy) };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (!editable || dragRef.current != null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const { t, v } = fromPointer(e.clientX, e.clientY);
    addAutomationPoint(lane.id, t, v);
    e.preventDefault();
  };

  const onPointDown = (e: React.PointerEvent, index: number) => {
    if (!editable) return;
    e.stopPropagation();
    if ((e.pointerType === 'mouse' && e.button === 2) || e.altKey) {
      removeAutomationPoint(lane.id, index);
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragRef.current = index;
    // Capture on the SVG (not the dot) so the SVG's onPointerMove keeps firing as
    // the drag continues; pointer capture would otherwise redirect moves to the dot.
    svgRef.current?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    const index = dragRef.current;
    if (index == null) return;
    const pts = lane.points;
    const lower = index > 0 ? pts[index - 1].t + DRAG_GAP : 0;
    const upper = index < pts.length - 1 ? pts[index + 1].t - DRAG_GAP : maxT;
    const { t, v } = fromPointer(e.clientX, e.clientY);
    updateAutomationPoint(lane.id, index, clamp(t, Math.min(lower, upper), Math.max(lower, upper)), v);
  };

  const onUp = (e: React.PointerEvent) => {
    if (dragRef.current == null) return;
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const pts = lane.points.map((p) => `${(p.t * zoom).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');

  return (
    <svg
      ref={svgRef}
      className="absolute left-0"
      style={{ top, width, height, pointerEvents: editable ? 'auto' : 'none', zIndex: editable ? 22 : 'auto' }}
      width={width}
      height={height}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => { if (editable) e.preventDefault(); }}
    >
      {editable && <rect x={0} y={0} width={width} height={height} fill={color} fillOpacity={0.05} />}
      <polyline points={pts} fill="none" stroke={color} strokeOpacity={editable ? 0.95 : 0.7} strokeWidth={editable ? 2 : 1.5} />
      {lane.points.map((p, i) => (
        <g key={`${lane.id}-${i}`}>
          <circle cx={p.t * zoom} cy={yOf(p.v)} r={editable ? 3 : 2} fill={color} fillOpacity={0.9} stroke="#fff" strokeWidth={editable ? 1 : 0} />
          {editable && (
            <circle
              cx={p.t * zoom}
              cy={yOf(p.v)}
              r={9}
              fill="transparent"
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => onPointDown(e, i)}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
