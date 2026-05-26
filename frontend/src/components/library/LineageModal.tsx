import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Network, X, GitBranch, GitFork, Workflow } from 'lucide-react';

const ForceGraph3D = lazy(() => import('react-force-graph-3d').then((m) => ({ default: m.default })));

interface GraphNode {
  id: string;
  kind?: string;
  title?: string;
  source?: string;
  duration_sec?: number;
  model?: string;
}

interface GraphEdge {
  from_id: string;
  to_id: string;
  kind: string;
  weight?: number;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type LineageTab = 'track' | 'genealogy' | 'graph3d';

interface LineageModalProps {
  open: boolean;
  rootEntryId: string | null;
  onClose: () => void;
}

const EDGE_COLOR_BY_KIND: Record<string, string> = {
  chimera_source_of: '#a78bfa',
  init_for: '#34d399',
  inpaint_for: '#fbbf24',
  stem_of: '#60a5fa',
  midi_of: '#f472b6',
  derived_from: '#94a3b8',
  used_in_lora: '#fb7185',
};

export const LineageModal: React.FC<LineageModalProps> = ({ open, rootEntryId, onClose }) => {
  const [tab, setTab] = useState<LineageTab>('track');
  const [perTrack, setPerTrack] = useState<GraphPayload | null>(null);
  const [libraryGraph, setLibraryGraph] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);

  // When the modal opens for a specific track, default to that view.
  // When opened library-wide, jump straight to the 3D graph.
  useEffect(() => {
    if (!open) return;
    setTab(rootEntryId ? 'track' : 'genealogy');
  }, [open, rootEntryId]);

  // Fetch the per-track BFS.
  useEffect(() => {
    if (!open || !rootEntryId) return;
    setLoading(true);
    setPerTrack(null);
    void fetch(`/api/library/${rootEntryId}/lineage?depth=4`)
      .then((r) => r.json())
      .then((j: GraphPayload) => setPerTrack(j))
      .catch(() => setPerTrack({ nodes: [], edges: [] }))
      .finally(() => setLoading(false));
  }, [open, rootEntryId]);

  // Fetch the full library graph for the family-tree + 3D-graph views.
  useEffect(() => {
    if (!open) return;
    if (tab !== 'genealogy' && tab !== 'graph3d') return;
    if (libraryGraph !== null) return;
    setLoading(true);
    void fetch('/api/library/_graph/all')
      .then((r) => r.json())
      .then((j: GraphPayload) => setLibraryGraph(j))
      .catch(() => setLibraryGraph({ nodes: [], edges: [] }))
      .finally(() => setLoading(false));
  }, [open, tab, libraryGraph]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-200 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[min(1100px,92vw)] h-[min(720px,86vh)] bg-[#0c0a14] border border-purple-500/30 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-purple-300" />
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] font-black uppercase tracking-widest text-purple-200">Lineage</span>
              <span className="text-[8px] font-mono uppercase tracking-wider text-purple-300/60">
                {rootEntryId ? `rooted at ${rootEntryId.slice(0, 16)}…` : 'library-wide'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {rootEntryId && (
              <TabButton active={tab === 'track'} onClick={() => setTab('track')} icon={<GitBranch className="w-3 h-3" />}>
                Track
              </TabButton>
            )}
            <TabButton active={tab === 'genealogy'} onClick={() => setTab('genealogy')} icon={<GitFork className="w-3 h-3" />}>
              Genealogy
            </TabButton>
            <TabButton active={tab === 'graph3d'} onClick={() => setTab('graph3d')} icon={<Workflow className="w-3 h-3" />}>
              3D graph
            </TabButton>
            <button onClick={onClose} className="ml-2 p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
              Loading lineage…
            </div>
          )}
          {tab === 'track' && rootEntryId && perTrack && (
            <TrackTreeView root={rootEntryId} payload={perTrack} />
          )}
          {tab === 'genealogy' && libraryGraph && (
            <GenealogyView payload={libraryGraph} />
          )}
          {tab === 'graph3d' && libraryGraph && (
            <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">Loading 3D engine…</div>}>
              <Graph3DView payload={libraryGraph} highlight={rootEntryId} />
            </Suspense>
          )}
        </div>

        {/* Footer legend */}
        <div className="flex items-center flex-wrap gap-3 px-4 py-2 border-t border-white/5 text-[8px] font-mono uppercase tracking-wider text-zinc-500 shrink-0">
          {Object.entries(EDGE_COLOR_BY_KIND).map(([kind, color]) => (
            <span key={kind} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: color }} />
              {kind}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};


interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const TabButton: React.FC<TabButtonProps> = ({ active, onClick, icon, children }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
      active
        ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
        : 'border-white/5 text-zinc-500 hover:text-zinc-300'
    }`}
  >
    {icon}
    {children}
  </button>
);


/** Per-track BFS rendered as a horizontal hierarchy (parents on the left,
 *  the root in the middle, children on the right). Pure SVG — no extra dep. */
const TrackTreeView: React.FC<{ root: string; payload: GraphPayload }> = ({ root, payload }) => {
  // Group edges by direction from the root.
  const parents = useMemo(
    () => payload.edges.filter((e) => e.to_id === root).map((e) => e.from_id),
    [payload, root],
  );
  const children = useMemo(
    () => payload.edges.filter((e) => e.from_id === root).map((e) => e.to_id),
    [payload, root],
  );
  const nodeMap = useMemo(() => Object.fromEntries(payload.nodes.map((n) => [n.id, n])), [payload]);
  const rootNode = nodeMap[root];

  return (
    <div className="absolute inset-0 overflow-auto p-6">
      <div className="grid grid-cols-3 gap-6 min-h-full items-start">
        <Column title="Parents" nodes={parents.map((id) => nodeMap[id]).filter(Boolean) as GraphNode[]} accent="border-emerald-500/40 text-emerald-300" />
        <Column title="This track" nodes={rootNode ? [rootNode] : []} accent="border-purple-500/60 text-purple-200" highlight />
        <Column title="Children" nodes={children.map((id) => nodeMap[id]).filter(Boolean) as GraphNode[]} accent="border-amber-500/40 text-amber-300" />
      </div>
      {parents.length === 0 && children.length === 0 && (
        <p className="text-center text-[10px] text-zinc-500 italic py-8">
          This track has no recorded lineage yet. Generate a Chimera or use this track as an init / inpaint source to start populating it.
        </p>
      )}
    </div>
  );
};


const Column: React.FC<{ title: string; nodes: GraphNode[]; accent: string; highlight?: boolean }> = ({ title, nodes, accent, highlight }) => (
  <div className="flex flex-col gap-2">
    <div className={`text-[9px] font-black uppercase tracking-widest border-b pb-1 ${accent}`}>
      {title} ({nodes.length})
    </div>
    {nodes.length === 0 ? (
      <span className="text-[10px] text-zinc-600 italic">none</span>
    ) : (
      nodes.map((n) => (
        <div
          key={n.id}
          className={`rounded border p-2 ${highlight ? 'bg-purple-500/10 border-purple-500/40' : 'bg-white/3 border-white/5'}`}
        >
          <div className="text-[10px] text-zinc-100 truncate">{n.title ?? n.id}</div>
          <div className="text-[8px] font-mono text-zinc-500 truncate">
            {n.kind ?? 'entry'} · {n.source ?? '—'}
          </div>
        </div>
      ))
    )}
  </div>
);


/** Library-wide genealogy: a layered DAG layout (Sugiyama-style).
 *
 *  1. Filter to nodes that participate in at least one relation —
 *     isolated tracks aren't "genealogy", they're just unrelated entries.
 *  2. Assign each node to a generation = longest path from any root.
 *  3. Within each generation, order nodes via the median heuristic to
 *     minimize parent↔child edge crossings (cheap, gives a clearly
 *     readable layout even at 30+ nodes).
 *  4. Render rounded-rect cards with orthogonal connecting lines drawn
 *     as SVG paths, color-coded by relation kind, with arrowheads at
 *     the child end.
 *  5. Pan via mouse drag, zoom via wheel, Reset View button.
 */
const GenealogyView: React.FC<{ payload: GraphPayload }> = ({ payload }) => {
  // -- Filter to the connected subgraph --------------------------------
  const connected = useMemo(() => {
    const involved = new Set<string>();
    payload.edges.forEach((e) => {
      involved.add(e.from_id);
      involved.add(e.to_id);
    });
    const nodes = payload.nodes.filter((n) => involved.has(n.id));
    // Also keep any edges whose endpoints both still exist (defensive).
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = payload.edges.filter(
      (e) => idSet.has(e.from_id) && idSet.has(e.to_id),
    );
    return { nodes, edges };
  }, [payload]);

  // -- Build adjacency -------------------------------------------------
  const { nodeMap, childrenOf, parentsOf } = useMemo(() => {
    const nm: Record<string, GraphNode> = {};
    connected.nodes.forEach((n) => {
      nm[n.id] = n;
    });
    const co: Record<string, string[]> = {};
    const po: Record<string, string[]> = {};
    connected.edges.forEach((e) => {
      (co[e.from_id] = co[e.from_id] || []).push(e.to_id);
      (po[e.to_id] = po[e.to_id] || []).push(e.from_id);
    });
    return { nodeMap: nm, childrenOf: co, parentsOf: po };
  }, [connected]);

  // -- Step 1: assign layer = longest path from any root --------------
  const layers = useMemo(() => {
    const out: Record<string, number> = {};
    const roots = connected.nodes.filter(
      (n) => !(parentsOf[n.id] && parentsOf[n.id].length),
    );
    // Multi-pass relaxation so that a node at the bottom of a long
    // chain ends up at the deepest layer.
    roots.forEach((r) => {
      out[r.id] = 0;
    });
    let changed = true;
    let safety = 0;
    while (changed && safety < 50) {
      changed = false;
      safety += 1;
      connected.edges.forEach((e) => {
        const fromLayer = out[e.from_id] ?? 0;
        const want = fromLayer + 1;
        if ((out[e.to_id] ?? -1) < want) {
          out[e.to_id] = want;
          changed = true;
        }
      });
    }
    connected.nodes.forEach((n) => {
      if (out[n.id] == null) out[n.id] = 0;
    });
    return out;
  }, [connected, parentsOf]);

  // -- Step 2: order within layer via median heuristic ----------------
  const orderedRows = useMemo(() => {
    const grouped: Record<number, string[]> = {};
    connected.nodes.forEach((n) => {
      const d = layers[n.id] ?? 0;
      (grouped[d] = grouped[d] || []).push(n.id);
    });
    const layerKeys = Object.keys(grouped)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    // Initial alphabetical order for stability.
    layerKeys.forEach((d) => {
      grouped[d].sort((a, b) =>
        (nodeMap[a]?.title ?? a).localeCompare(nodeMap[b]?.title ?? b),
      );
    });

    // Median-of-parents heuristic, sweeping top-down then bottom-up
    // a few times. This is the simplest crossing-reduction step in
    // the Sugiyama framework.
    const positionInRow = (id: string, row: string[]): number => row.indexOf(id);
    for (let iter = 0; iter < 12; iter += 1) {
      const topDown = iter % 2 === 0;
      const order = topDown ? layerKeys.slice(1) : layerKeys.slice(0, -1).reverse();
      order.forEach((d) => {
        const adjLayer = topDown ? d - 1 : d + 1;
        const adjRow = grouped[adjLayer] || [];
        const adjMap = topDown ? parentsOf : childrenOf;
        const newRow = [...grouped[d]];
        const medianOf = (id: string): number => {
          const refs = (adjMap[id] || []).filter((n) => adjRow.includes(n));
          if (refs.length === 0) return positionInRow(id, grouped[d]);
          const positions = refs
            .map((r) => positionInRow(r, adjRow))
            .filter((p) => p >= 0)
            .sort((a, b) => a - b);
          if (positions.length === 0) return positionInRow(id, grouped[d]);
          return positions[Math.floor(positions.length / 2)];
        };
        newRow.sort((a, b) => medianOf(a) - medianOf(b));
        grouped[d] = newRow;
      });
    }

    return layerKeys.map((d) => ({ layer: d, ids: grouped[d] }));
  }, [connected, nodeMap, layers, parentsOf, childrenOf]);

  // -- Step 3: coordinate assignment ----------------------------------
  const NODE_W = 200;
  const NODE_H = 60;
  const COL_GAP = 28;
  const ROW_GAP = 90;
  const PAD = 40;

  const positions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    // Find the widest row to center smaller rows under it.
    const widestCount = Math.max(
      1,
      ...orderedRows.map((r) => r.ids.length),
    );
    const widestPx = widestCount * NODE_W + (widestCount - 1) * COL_GAP;
    orderedRows.forEach((row, rowIdx) => {
      const rowPx = row.ids.length * NODE_W + (row.ids.length - 1) * COL_GAP;
      const startX = PAD + (widestPx - rowPx) / 2;
      row.ids.forEach((id, colIdx) => {
        pos[id] = {
          x: startX + colIdx * (NODE_W + COL_GAP),
          y: PAD + rowIdx * (NODE_H + ROW_GAP),
        };
      });
    });
    return pos;
  }, [orderedRows]);

  // -- Bounds for the SVG ---------------------------------------------
  const bounds = useMemo(() => {
    const ids = Object.keys(positions);
    if (ids.length === 0) return { minX: 0, maxX: 800, minY: 0, maxY: 400 };
    const xs = ids.map((id) => positions[id].x);
    const ys = ids.map((id) => positions[id].y);
    return {
      minX: Math.min(...xs) - PAD,
      maxX: Math.max(...xs) + NODE_W + PAD,
      minY: Math.min(...ys) - PAD,
      maxY: Math.max(...ys) + NODE_H + PAD,
    };
  }, [positions]);

  // -- Pan + zoom -----------------------------------------------------
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  if (connected.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic px-12 text-center">
        No genealogy yet — entries become connected when you generate from
        chimera sources, separate stems, convert to MIDI, or mark a
        track as derived-from another. Right-click a track → "Show
        lineage" to start populating relationships.
      </p>
    );
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => ({ ...v, k: Math.max(0.2, Math.min(4, v.k * factor)) }));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = { x: e.clientX - view.x, y: e.clientY - view.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = draggingRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
  };

  return (
    <div
      className="absolute inset-0 bg-[#06030c] overflow-hidden cursor-grab active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <button
        onClick={() => setView({ x: 0, y: 0, k: 1 })}
        className="absolute top-2 right-2 z-10 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-200 bg-black/40 border border-white/10 px-2 py-1 rounded"
      >
        Reset view
      </button>

      <div
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}
      >
        <svg
          width={bounds.maxX - bounds.minX}
          height={bounds.maxY - bounds.minY}
          viewBox={`${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`}
          style={{ display: 'block' }}
        >
          {/* Edges first so nodes paint on top. */}
          {connected.edges.map((edge, i) => {
            const from = positions[edge.from_id];
            const to = positions[edge.to_id];
            if (!from || !to) return null;
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            // Smooth cubic Bezier — feels more like a real genealogy
            // chart than the harsh right-angled bend my first pass had.
            const dy = (y2 - y1) * 0.5;
            const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
            const color = EDGE_COLOR_BY_KIND[edge.kind] ?? '#71717a';
            return (
              <g key={i}>
                <path
                  d={d}
                  stroke={color}
                  strokeWidth={1.5}
                  fill="none"
                  opacity={0.7}
                />
                <polygon
                  points={`${x2 - 4},${y2 - 7} ${x2 + 4},${y2 - 7} ${x2},${y2}`}
                  fill={color}
                  opacity={0.9}
                />
              </g>
            );
          })}

          {/* Nodes. */}
          {connected.nodes.map((n) => {
            const p = positions[n.id];
            if (!p) return null;
            const sourceColor = pickNodeColor(n);
            return (
              <g key={n.id} transform={`translate(${p.x}, ${p.y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  ry={6}
                  fill="#0c0a14"
                  stroke={sourceColor}
                  strokeWidth={1.5}
                />
                <rect
                  width={NODE_W}
                  height={4}
                  rx={2}
                  ry={2}
                  fill={sourceColor}
                  opacity={0.85}
                />
                <text
                  x={10}
                  y={22}
                  fill="#e5e5e5"
                  fontSize={11}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fontWeight={700}
                >
                  {truncate(n.title ?? n.id, 26)}
                </text>
                <text
                  x={10}
                  y={38}
                  fill="#a3a3a3"
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {(n.source ?? '—')} · {n.model ?? n.kind ?? 'entry'}
                </text>
                <text
                  x={10}
                  y={52}
                  fill="#71717a"
                  fontSize={8}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {typeof n.duration_sec === 'number' && n.duration_sec > 0
                    ? `${n.duration_sec.toFixed(1)}s`
                    : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Generation gutter labels. */}
      <div className="absolute top-0 left-2 z-10 text-[8px] font-mono uppercase tracking-widest text-zinc-600 pointer-events-none">
        {orderedRows.map((row, i) => (
          <div
            key={row.layer}
            style={{
              position: 'absolute',
              top: (PAD + i * (NODE_H + ROW_GAP)) * view.k + view.y + 8,
              left: 0,
            }}
          >
            gen {row.layer}
          </div>
        ))}
      </div>

      {/* Help hint */}
      <div className="absolute bottom-2 left-2 z-10 text-[8px] font-mono text-zinc-600 pointer-events-none">
        drag to pan · wheel to zoom · {connected.nodes.length} connected entries · {connected.edges.length} relationships
      </div>
    </div>
  );
};


function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}


/** Interactive 3D force-directed graph using react-force-graph-3d.
 *  Camera auto-fits to the connected subgraph on first render so the
 *  user lands on something usable instead of a dot in the distance.
 *  Trackball controls run at a calmer pace than the library's defaults. */
const Graph3DView: React.FC<{ payload: GraphPayload; highlight: string | null }> = ({ payload, highlight }) => {
  // Same filter as Genealogy: drop nodes that don't participate in any
  // relation, otherwise 100+ disconnected dots dominate the view.
  const connected = useMemo(() => {
    const involved = new Set<string>();
    payload.edges.forEach((e) => {
      involved.add(e.from_id);
      involved.add(e.to_id);
    });
    const nodes = payload.nodes.filter((n) => involved.has(n.id));
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = payload.edges.filter(
      (e) => idSet.has(e.from_id) && idSet.has(e.to_id),
    );
    return { nodes, edges };
  }, [payload]);

  const data = useMemo(
    () => ({
      nodes: connected.nodes.map((n) => ({
        id: n.id,
        name: n.title ?? n.id,
        title: n.title ?? '',
        source: n.source ?? '',
        model: n.model ?? '',
        val: 4 + Math.log10(1 + (n.duration_sec ?? 1)) * 6,
        color: n.id === highlight ? '#fbbf24' : pickNodeColor(n),
      })),
      links: connected.edges.map((e) => ({
        source: e.from_id,
        target: e.to_id,
        kind: e.kind,
        color: EDGE_COLOR_BY_KIND[e.kind] ?? '#71717a',
      })),
    }),
    [connected, highlight],
  );

  const fgRef = useRef<unknown>(null);

  // After the force layout has a chance to settle, zoom-to-fit so the
  // user lands on a useful framing.
  useEffect(() => {
    const t = setTimeout(() => {
      const ref = fgRef.current as { zoomToFit?: (ms: number, pad: number) => void } | null;
      if (ref?.zoomToFit) ref.zoomToFit(800, 60);
    }, 1500);
    return () => clearTimeout(t);
  }, [data]);

  if (connected.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic px-12 text-center">
        No relationships yet. Generate a Chimera, separate stems, or convert
        a track to MIDI to start populating the graph.
      </p>
    );
  }

  return (
    <div className="absolute inset-0 bg-[#06030c]">
      <ForceGraph3D
        ref={fgRef as React.MutableRefObject<unknown>}
        graphData={data}
        nodeAutoColorBy="source"
        nodeRelSize={5}
        backgroundColor="#06030c"
        showNavInfo={false}
        controlType="orbit"
        cameraPosition={{ z: 280 }}
        linkColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
        linkOpacity={0.85}
        linkWidth={2.5}
        linkDirectionalArrowLength={5}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
        linkDirectionalParticles={2}
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleSpeed={0.006}
        nodeLabel={(n: { name: string; source: string; model: string }) =>
          `<div style="font-family: monospace; font-size: 11px; padding: 6px 8px; background: rgba(12,8,24,0.95); border: 1px solid rgba(168,85,247,0.5); border-radius: 4px; max-width: 280px; word-wrap: break-word; overflow-wrap: anywhere; white-space: normal; line-height: 1.3;">
            <div style="color: #e5e5e5; font-weight: 700; word-wrap: break-word;">${escapeHtml(n.name)}</div>
            <div style="color: #a3a3a3; font-size: 10px;">${escapeHtml(n.source)} · ${escapeHtml(n.model)}</div>
          </div>`
        }
      />
      <div className="absolute bottom-2 left-2 z-10 text-[8px] font-mono text-zinc-600 pointer-events-none">
        click-drag rotate · right-click-drag pan · wheel zoom · {connected.nodes.length} connected nodes · {connected.edges.length} relationships
      </div>
    </div>
  );
};


function pickNodeColor(n: GraphNode): string {
  switch (n.source) {
    case 'generate':
      return '#a78bfa';
    case 'import':
      return '#60a5fa';
    case 'studio':
      return '#34d399';
    case undefined:
    case null:
      return '#71717a';
    default:
      return '#fb923c';
  }
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
