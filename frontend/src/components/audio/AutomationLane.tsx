/**
 * AutomationLane — draws one automation lane's curve over a timeline row, and when
 * `editable` is on, lets the user add, drag, and delete breakpoints directly on it.
 *
 *  - click the empty curve area: add a breakpoint
 *  - drag a point: move it (clamped between its neighbors so points never cross)
 *  - right-click or Alt-click a point: delete it
 *  - drag a segment's diamond handle: bend the segment (the left point's `curve`)
 *  - double-click that handle: straighten the segment again
 *
 * The drawn line is sampled from `interpolatePoints` — the same function the
 * engine plays the lane with — so a bent segment is drawn exactly as it sounds.
 *
 * Pointer math uses getBoundingClientRect ratios so it stays correct under the
 * app's CSS transform scale (rendered px vs layout px). Read-only lanes set
 * pointer-events to none so clip editing underneath is unaffected.
 */

import { useRef } from 'react';
import { useEditorStore, beginUndoStep, type AutomationLane as Lane, type AutomationTarget } from '../../state/editorStore';
import { clampCurve, curveFromDrag, interpolatePoints, type CurvePoint } from '../../lib/automationModes';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
// Keep a dragged point this far (seconds) from its neighbors, comfortably beyond
// the store's MIN_POINT_DT thinning so a drag never merges into a neighbor.
const DRAG_GAP = 0.03;
/** Interior samples drawn for one BENT segment. 16 is smooth at every zoom the
 *  editor offers while a linear lane still costs exactly its breakpoints. */
export const LANE_CURVE_SAMPLES = 16;
/** A segment narrower than this gets no curve handle: its midpoint would land
 *  inside a breakpoint's 9px grab circle and steal the drag. Layout px (SVG
 *  units) — the same space those grab circles are measured in, so the rule holds
 *  whatever CSS transform scale the app is drawn at. */
const MIN_HANDLE_SEGMENT_PX = 24;
/** Half the diamond handle's side, in px. */
const HANDLE_HALF = 3;

/**
 * The vertices of the lane's polyline, in SVG px — pure, so the sampling is
 * testable without a DOM.
 *
 * Every breakpoint contributes its own vertex. A segment whose LEFT point has a
 * curve additionally contributes `samplesPerSegment` interior samples, read from
 * `interpolatePoints` so the drawing and playback cannot disagree. A linear
 * segment contributes nothing extra, which is the whole lane for every project
 * written before curves existed.
 */
export function lanePathPoints(
  points: readonly CurvePoint[],
  zoom: number,
  yOf: (v: number) => number,
  samplesPerSegment: number = LANE_CURVE_SAMPLES,
): [number, number][] {
  const out: [number, number][] = [];
  if (points.length === 0) return out;
  const n = Math.max(0, Math.floor(samplesPerSegment));
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    out.push([p0.t * zoom, yOf(p0.v)]);
    if (clampCurve(p0.curve) === 0) continue;
    for (let k = 1; k <= n; k += 1) {
      const t = p0.t + (p1.t - p0.t) * (k / (n + 1));
      out.push([t * zoom, yOf(interpolatePoints(p0, p1, t))]);
    }
  }
  const last = points[points.length - 1];
  out.push([last.t * zoom, yOf(last.v)]);
  return out;
}

/** Screen-reader name for the lane, from its target alone — the component is
 *  handed no label, and the SVG is a picture of one named parameter. */
const laneName = (target: AutomationTarget): string => {
  if (target.kind === 'trackVolume') return 'track volume';
  if (target.kind === 'trackPan') return 'track pan';
  if (target.kind === 'trackMidiCc') return `track MIDI controller ${target.paramKey ?? ''}`.trim();
  const scope = target.kind === 'masterFx' ? 'master' : 'track';
  return `${scope} effect ${target.paramKey ?? 'parameter'}`;
};

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
  const setAutomationPointCurve = useEditorStore((s) => s.setAutomationPointCurve);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  // A curve drag is absolute against where it was grabbed, so a drag out and back
  // returns the original shape (the curve's mirror law) instead of accumulating.
  const curveDragRef = useRef<{ index: number; startCurve: number; startClientY: number } | null>(null);

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

  // Rendered-px vertical delta -> LAYOUT px, the same rect ratio fromPointer uses
  // so the app's CSS transform scale does not change how far a bend feels.
  const layoutDy = (dyClient: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return dyClient;
    return dyClient * (height / rect.height);
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (!editable || dragRef.current != null || curveDragRef.current != null) return;
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

  // The segment handle. Alt / right button are the POINT delete gesture; on a
  // handle they do nothing at all rather than deleting the point behind it.
  const onCurveDown = (e: React.PointerEvent, index: number) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    if ((e.pointerType === 'mouse' && e.button === 2) || e.altKey) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current != null) return;
    beginUndoStep(); // the whole bend is one undo step (the store coalesces the moves)
    curveDragRef.current = {
      index,
      startCurve: clampCurve(lane.points[index]?.curve),
      startClientY: e.clientY,
    };
    // Capture on the SVG for the same reason onPointDown does: keep the SVG's
    // onPointerMove firing once the pointer leaves the little diamond.
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onCurveDoubleClick = (e: React.MouseEvent, index: number) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    curveDragRef.current = null;
    setAutomationPointCurve(lane.id, index, 0);
  };

  const onMove = (e: React.PointerEvent) => {
    const bend = curveDragRef.current;
    if (bend) {
      setAutomationPointCurve(
        lane.id,
        bend.index,
        curveFromDrag(bend.startCurve, layoutDy(e.clientY - bend.startClientY)),
        // The pointer-down already cut the undo burst for the whole bend; without
        // this every move would push a snapshot and drop the redo stack.
        { coalesce: true },
      );
      return;
    }
    const index = dragRef.current;
    if (index == null) return;
    const pts = lane.points;
    const lower = index > 0 ? pts[index - 1].t + DRAG_GAP : 0;
    const upper = index < pts.length - 1 ? pts[index + 1].t - DRAG_GAP : maxT;
    const { t, v } = fromPointer(e.clientX, e.clientY);
    updateAutomationPoint(lane.id, index, clamp(t, Math.min(lower, upper), Math.max(lower, upper)), v);
  };

  const onUp = (e: React.PointerEvent) => {
    if (dragRef.current == null && curveDragRef.current == null) return;
    dragRef.current = null;
    curveDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const pts = lanePathPoints(lane.points, zoom, yOf)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');

  // One handle per segment, at the segment's horizontal midpoint and sitting ON
  // the drawn curve. Segments too narrow to hold one without colliding with a
  // breakpoint's grab circle get none.
  const handles = editable
    ? lane.points.slice(0, -1).flatMap((p0, i) => {
      const p1 = lane.points[i + 1];
      if ((p1.t - p0.t) * zoom < MIN_HANDLE_SEGMENT_PX) return [];
      const midT = (p0.t + p1.t) / 2;
      return [{ index: i, x: midT * zoom, y: yOf(interpolatePoints(p0, p1, midT)) }];
    })
    : [];

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
      role="img"
      aria-label={`Automation lane: ${laneName(lane.target)}`}
    >
      {editable && <rect x={0} y={0} width={width} height={height} fill={color} fillOpacity={0.05} />}
      <polyline points={pts} fill="none" stroke={color} strokeOpacity={editable ? 0.95 : 0.7} strokeWidth={editable ? 2 : 1.5} />
      {/* Handles are drawn BEFORE the breakpoints so a point's grab circle always
          wins where the two overlap — the point gestures come first. */}
      {handles.map((h) => (
        <g key={`${lane.id}-curve-${h.index}`}>
          <rect
            x={h.x - HANDLE_HALF}
            y={h.y - HANDLE_HALF}
            width={HANDLE_HALF * 2}
            height={HANDLE_HALF * 2}
            transform={`rotate(45 ${h.x} ${h.y})`}
            fill={color}
            fillOpacity={0.9}
            stroke="#fff"
            strokeWidth={1}
          />
          <circle
            cx={h.x}
            cy={h.y}
            r={9}
            fill="transparent"
            style={{ cursor: 'ns-resize' }}
            onPointerDown={(e) => onCurveDown(e, h.index)}
            onDoubleClick={(e) => onCurveDoubleClick(e, h.index)}
          />
        </g>
      ))}
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
