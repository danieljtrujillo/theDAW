import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProviderBadge } from '../components/library/ProviderBadge';
import type { NeighbourGroup, Neighbourhood } from './lineageScaleClient';
import { boundsOfBoxes, edgeLabelPoint, edgePath, layoutFocus, type LayoutBox } from './focusLayout';
import {
  canFocusNode, edgeColorForKinds, edgeKindsLabel, edgeWidthForRole, formatCount, formatDuration,
  groupAccessibleName, groupLabel, hiddenAccessibleName, hiddenFor, hiddenLabel,
  isCrossReferenceRole, mergeEdges, nodeAccessibleName, nodeTitle,
} from './lineageScaleModel';

/**
 * FocusGraph — ONE song and its immediate family, never the library.
 *
 * Sources sit in rows above the focus, derivatives in rows below it. Each pair
 * of songs gets exactly one line, labelled with every relation stored for that
 * pair, coloured by the first one's app-wide colour. A `uses` line (a mashup's
 * sources) is DASHED, because it is a cross-reference and not descent — and
 * the server never walks through one, so a neighbourhood cannot wander into an
 * unrelated tree.
 *
 * Anything too big to draw is already folded by the server: a group box says
 * "Covers (312)" and opens a list, and a node that was not expanded carries a
 * "+412 more" badge. So the number of DOM elements here is bounded by the
 * request's budget (1,500 at the very most), whatever the library holds.
 *
 * Every node and every group is a real <button>: focusable, Enter-activated,
 * and named for assistive tech. The drawing itself is decoration around them.
 */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.12;

interface ViewTransform {
  x: number;
  y: number;
  z: number;
}

const IDENTITY: ViewTransform = { x: 0, y: 0, z: 1 };

export interface FocusGraphProps {
  data: Neighbourhood;
  /** The id the neighbourhood was asked for. */
  focusId: string;
  onFocusNode: (id: string, title: string) => void;
  onOpenGroup: (group: NeighbourGroup) => void;
  className?: string;
}

export const FocusGraph: React.FC<FocusGraphProps> = ({
  data, focusId, onFocusNode, onOpenGroup, className,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewTransform>(IDENTITY);
  const panRef = useRef<{ id: number; x: number; y: number; from: ViewTransform } | null>(null);

  const layout = useMemo(
    () => layoutFocus({
      nodes: data.nodes.map((n) => ({ id: n.id, generation: n.generation })),
      groups: data.groups.map((g) => ({ id: g.id, parent_id: g.parent_id, direction: g.direction })),
    }),
    [data],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, Neighbourhood['nodes'][number]>();
    for (const n of data.nodes) map.set(n.id, n);
    return map;
  }, [data]);

  const groupById = useMemo(() => {
    const map = new Map<string, NeighbourGroup>();
    for (const g of data.groups) map.set(g.id, g);
    return map;
  }, [data]);

  /** One line per pair, endpoints resolved to boxes. An edge whose endpoint
   *  was folded into a group has no box, and is not drawn to nowhere. */
  const lines = useMemo(() => {
    const out: Array<{
      key: string; d: string; color: string; dashed: boolean; width: number;
      label: string; labelX: number; labelY: number; title: string;
    }> = [];
    for (const e of mergeEdges(data.edges)) {
      const from = layout.nodeById.get(e.from);
      const to = layout.nodeById.get(e.to);
      if (!from || !to) continue;
      const mid = edgeLabelPoint(from, to);
      const label = edgeKindsLabel(e.kinds);
      const fromTitle = nodeTitle(nodeById.get(e.from) ?? { id: e.from, title: '' });
      const toTitle = nodeTitle(nodeById.get(e.to) ?? { id: e.to, title: '' });
      out.push({
        key: `${e.from}->${e.to}`,
        d: edgePath(from, to),
        color: edgeColorForKinds(e.kinds),
        dashed: isCrossReferenceRole(e.role),
        width: edgeWidthForRole(e.role),
        label,
        labelX: mid.x,
        labelY: mid.y,
        title: `${fromTitle} — ${label} — ${toTitle}`,
      });
    }
    return out;
  }, [data, layout, nodeById]);

  const bounds = layout.bounds;

  // A new neighbourhood is a new drawing: start it centred and unzoomed rather
  // than wherever the previous song had been dragged to.
  useEffect(() => {
    setView(IDENTITY);
  }, [focusId, data]);

  // Wheel zoom toward the cursor. Registered by hand because a React onWheel
  // handler is passive, and a passive listener cannot preventDefault — the
  // page behind would scroll while the graph zoomed.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Pointer position relative to the transform origin (the panel centre).
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      setView((cur) => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, e.deltaY < 0 ? cur.z * ZOOM_STEP : cur.z / ZOOM_STEP));
        if (next === cur.z) return cur;
        const k = next / cur.z;
        return { z: next, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // A node is a button; dragging must never steal its click.
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: view };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [view]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.id !== e.pointerId) return;
    setView({ z: pan.from.z, x: pan.from.x + (e.clientX - pan.x), y: pan.from.y + (e.clientY - pan.y) });
  }, []);

  const endPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.id !== e.pointerId) return;
    panRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((cur) => ({ ...cur, z: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur.z * factor)) }));
  }, []);

  const focusTitle = nodeTitle(nodeById.get(focusId) ?? { id: focusId, title: '' });

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black/40 ${className ?? ''}`}>
      <div
        ref={wrapRef}
        role="group"
        aria-label={`Lineage around ${focusTitle}: ${formatCount(data.nodes.length)} songs, ${formatCount(lines.length)} relationships`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        className="absolute inset-0 cursor-grab touch-none select-none active:cursor-grabbing"
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: '0 0' }}
        >
          <svg
            width={Math.max(1, bounds.width)}
            height={Math.max(1, bounds.height)}
            viewBox={`${bounds.minX} ${bounds.minY} ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`}
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ left: bounds.minX, top: bounds.minY, overflow: 'visible' }}
          >
            {lines.map((line) => (
              <g key={line.key}>
                <title>{line.title}</title>
                <path
                  d={line.d}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={line.width}
                  strokeDasharray={line.dashed ? '5 4' : undefined}
                  opacity={line.dashed ? 0.65 : 0.9}
                />
                <text
                  x={line.labelX}
                  y={line.labelY}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily="ui-monospace, monospace"
                  fill={line.color}
                  opacity={0.85}
                >
                  {line.label}
                </text>
              </g>
            ))}
          </svg>

          {layout.nodes.map((box: LayoutBox) => {
            const node = nodeById.get(box.id);
            if (!node) return null;
            const title = nodeTitle(node);
            const hidden = hiddenFor(data.hidden, node.id);
            const badge = hiddenLabel(hidden);
            const isFocus = node.id === focusId;
            const duration = formatDuration(node.duration_sec);
            if (!canFocusNode(node.id)) {
              // A '/' in the id is a path separator to the route, so focusing
              // this node could only ever 404. It is drawn, named by its id,
              // and left out of the tab order rather than offered as a button
              // that fails. (These are link endpoints, not songs: a chimera
              // source label is an arbitrary string.)
              return (
                <div
                  key={box.id}
                  data-node-id={node.id}
                  data-generation={node.generation}
                  data-unfocusable="true"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  className="absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded border border-dashed border-white/10 bg-black/60 px-2 py-1 text-left text-zinc-500"
                >
                  <span className="truncate text-[11px] leading-tight">{node.id}</span>
                  <span className="truncate text-[9px] font-mono text-zinc-600">
                    not a song — cannot be opened
                  </span>
                  {/* Not being focusable does not make the relatives the
                      server left out disappear: this badge is the only thing
                      that says the picture around this node is partial. */}
                  {badge && (
                    <span
                      title={hiddenAccessibleName(hidden, title)}
                      className="absolute right-1 top-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 text-[8px] font-mono text-amber-200"
                    >
                      {badge}
                    </span>
                  )}
                </div>
              );
            }
            return (
              <button
                key={box.id}
                type="button"
                onClick={() => onFocusNode(node.id, title)}
                aria-label={nodeAccessibleName(node)}
                aria-current={isFocus ? 'true' : undefined}
                data-node-id={node.id}
                data-generation={node.generation}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                className={`absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded border px-2 py-1 text-left transition-colors ${
                  isFocus
                    ? 'border-purple-400/70 bg-purple-500/15 text-zinc-100'
                    : node.in_library
                      ? 'border-white/10 bg-zinc-900/90 text-zinc-200 hover:border-purple-400/50 hover:bg-zinc-800/90'
                      : 'border-dashed border-white/10 bg-black/60 text-zinc-500 hover:border-white/25'
                }`}
              >
                <span className="flex items-center gap-1">
                  <span className="min-w-0 grow truncate text-[11px] leading-tight">{title}</span>
                  <ProviderBadge entry={{ model: node.model, source: node.source }} className="shrink-0" />
                </span>
                <span className="truncate text-[9px] font-mono text-zinc-500">
                  {node.in_library ? '' : 'not in library · '}
                  {duration ? `${duration} · ` : ''}
                  {formatCount(node.play_count)} plays
                </span>
                {badge && (
                  <span
                    title={hiddenAccessibleName(hidden, title)}
                    className="absolute right-1 top-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 text-[8px] font-mono text-amber-200"
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}

          {layout.groups.map((box: LayoutBox) => {
            const group = groupById.get(box.id);
            if (!group) return null;
            const parentTitle = nodeTitle(nodeById.get(group.parent_id) ?? { id: group.parent_id, title: '' });
            return (
              <button
                key={box.id}
                type="button"
                onClick={() => onOpenGroup(group)}
                aria-label={groupAccessibleName(group, parentTitle)}
                data-group-id={group.id}
                data-group-kind={group.kind}
                data-group-direction={group.direction}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                className="absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded border border-dashed border-sky-400/40 bg-sky-500/10 px-2 py-1 text-left text-sky-100 hover:border-sky-300/70 hover:bg-sky-500/20"
              >
                <span className="truncate text-[11px] leading-tight">{groupLabel(group)}</span>
                <span className="truncate text-[9px] font-mono text-sky-300/70">open the list</span>
              </button>
            );
          })}
        </div>
      </div>

      {data.truncated && (
        <p
          role="status"
          className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[9px] font-mono text-amber-200"
        >
          Budget of {formatCount(data.budget)} reached — this is part of the family, not all of it. Lower the depth, or open a list.
        </p>
      )}

      <div className="pointer-events-none absolute bottom-1 left-2 right-2 flex items-end justify-between gap-2">
        <p className="text-[9px] font-mono text-zinc-500">
          drag to pan · wheel to zoom · click a song to re-centre · solid = descent, dashed = used by
        </p>
        <span className="pointer-events-auto flex gap-1">
          <button
            type="button"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            aria-label="Zoom out"
            className="rounded border border-white/10 bg-black/60 px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:border-white/25 hover:text-white"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-label="Zoom in"
            className="rounded border border-white/10 bg-black/60 px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:border-white/25 hover:text-white"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setView(IDENTITY)}
            aria-label="Reset the view"
            className="rounded border border-white/10 bg-black/60 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
          >
            Reset
          </button>
        </span>
      </div>
    </div>
  );
};

/** Exported for the layout tests' sake: the drawing's extent, so a caller can
 *  size a container without re-deriving the layout. */
export const focusGraphBounds = (data: Neighbourhood) => {
  const layout = layoutFocus({
    nodes: data.nodes.map((n) => ({ id: n.id, generation: n.generation })),
    groups: data.groups.map((g) => ({ id: g.id, parent_id: g.parent_id, direction: g.direction })),
  });
  return boundsOfBoxes(layout.nodes.concat(layout.groups));
};

export default FocusGraph;
