import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Network, X, GitBranch, Trees, Workflow } from 'lucide-react';

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

type LineageTab = 'track' | 'family' | 'graph3d';

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
    setTab(rootEntryId ? 'track' : 'graph3d');
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
    if (tab !== 'family' && tab !== 'graph3d') return;
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
            <TabButton active={tab === 'family'} onClick={() => setTab('family')} icon={<Trees className="w-3 h-3" />}>
              Family tree
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
          {tab === 'family' && libraryGraph && (
            <FamilyTreeView payload={libraryGraph} />
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


/** Library-wide ancestry/family-tree view. Each generation (depth from
 *  any root) gets its own horizontal row; nodes are auto-laid-out left-
 *  to-right within their row; SVG paths draw the parent→child edges.
 *  Pan/zoom via pointer-drag + wheel. */
const FamilyTreeView: React.FC<{ payload: GraphPayload }> = ({ payload }) => {
  // Build adjacency + node lookups.
  const { nodeMap, childrenOf, parentsOf } = useMemo(() => {
    const nm: Record<string, GraphNode> = {};
    payload.nodes.forEach((n) => {
      nm[n.id] = n;
    });
    const co: Record<string, string[]> = {};
    const po: Record<string, string[]> = {};
    payload.edges.forEach((e) => {
      (co[e.from_id] = co[e.from_id] || []).push(e.to_id);
      (po[e.to_id] = po[e.to_id] || []).push(e.from_id);
    });
    return { nodeMap: nm, childrenOf: co, parentsOf: po };
  }, [payload]);

  // Compute depth = longest path from any root. Roots = nodes with no
  // parents. Orphan nodes (no edges) all sit on row 0.
  const depths = useMemo(() => {
    const out: Record<string, number> = {};
    // Topological-ish via BFS from roots; for cycles we cap at 16.
    const roots = payload.nodes.filter((n) => !(parentsOf[n.id] && parentsOf[n.id].length));
    const queue: Array<[string, number]> = roots.map((r) => [r.id, 0]);
    while (queue.length) {
      const [id, d] = queue.shift()!;
      if (out[id] != null && out[id] >= d) continue;
      out[id] = d;
      if (d > 16) continue;
      for (const child of childrenOf[id] || []) queue.push([child, d + 1]);
    }
    // Any node not yet visited (cycle-only) → depth 0.
    payload.nodes.forEach((n) => {
      if (out[n.id] == null) out[n.id] = 0;
    });
    return out;
  }, [payload, childrenOf, parentsOf]);

  // Group nodes by depth, sort within depth by title for stability.
  const rows = useMemo(() => {
    const grouped: Record<number, GraphNode[]> = {};
    payload.nodes.forEach((n) => {
      const d = depths[n.id] ?? 0;
      (grouped[d] = grouped[d] || []).push(n);
    });
    const keys = Object.keys(grouped).map((k) => Number(k)).sort((a, b) => a - b);
    keys.forEach((d) => {
      grouped[d].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
    });
    return keys.map((d) => ({ depth: d, nodes: grouped[d] }));
  }, [payload, depths]);

  // Layout constants.
  const NODE_W = 180;
  const NODE_H = 56;
  const COL_GAP = 36;
  const ROW_GAP = 80;
  const PAD = 40;

  // Compute x,y for every node.
  const positions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    rows.forEach((row, rowIdx) => {
      const rowWidth = row.nodes.length * NODE_W + (row.nodes.length - 1) * COL_GAP;
      row.nodes.forEach((n, colIdx) => {
        pos[n.id] = {
          x: PAD + colIdx * (NODE_W + COL_GAP) - rowWidth / 2,
          y: PAD + rowIdx * (NODE_H + ROW_GAP),
        };
      });
    });
    return pos;
  }, [rows]);

  // Computed bounding box for the SVG viewBox.
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

  // Pan + zoom.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);

  if (payload.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic">
        Library is empty.
      </p>
    );
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => ({ ...v, k: Math.max(0.2, Math.min(4, v.k * factor)) }));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging({ x: e.clientX - view.x, y: e.clientY - view.y });
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setView((v) => ({ ...v, x: e.clientX - dragging.x, y: e.clientY - dragging.y }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(null);
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {/* */}
  };

  return (
    <div
      className="absolute inset-0 bg-[#06030c] overflow-hidden cursor-grab active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Reset button */}
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
          {payload.edges.map((edge, i) => {
            const from = positions[edge.from_id];
            const to = positions[edge.to_id];
            if (!from || !to) return null;
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            const midY = (y1 + y2) / 2;
            // Right-angled connector that bends through the midpoint.
            const d = `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`;
            const color = EDGE_COLOR_BY_KIND[edge.kind] ?? '#71717a';
            return (
              <g key={i}>
                <path d={d} stroke={color} strokeWidth={1.5} fill="none" opacity={0.7} />
                {/* Arrowhead at the child end. */}
                <polygon
                  points={`${x2 - 4},${y2 - 6} ${x2 + 4},${y2 - 6} ${x2},${y2}`}
                  fill={color}
                  opacity={0.85}
                />
              </g>
            );
          })}

          {/* Nodes. */}
          {payload.nodes.map((n) => {
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
                  opacity={0.8}
                />
                <text
                  x={10}
                  y={22}
                  fill="#e5e5e5"
                  fontSize={11}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fontWeight={700}
                >
                  {truncate(n.title ?? n.id, 24)}
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
                  y={50}
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

      {/* Generation labels down the left. */}
      <div className="absolute top-2 left-2 z-10 flex flex-col gap-20 text-[8px] font-mono uppercase tracking-widest text-zinc-600 pointer-events-none">
        {rows.map((row) => (
          <div key={row.depth}>gen {row.depth}</div>
        ))}
      </div>
    </div>
  );
};


function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}


/** Interactive 3D force-directed graph using react-force-graph-3d. */
const Graph3DView: React.FC<{ payload: GraphPayload; highlight: string | null }> = ({ payload, highlight }) => {
  const data = useMemo(
    () => ({
      nodes: payload.nodes.map((n) => ({
        id: n.id,
        name: n.title ?? n.id,
        title: n.title ?? '',
        source: n.source ?? '',
        model: n.model ?? '',
        val: 1 + Math.log10(1 + (n.duration_sec ?? 1)),
        color: n.id === highlight ? '#fbbf24' : pickNodeColor(n),
      })),
      links: payload.edges.map((e) => ({
        source: e.from_id,
        target: e.to_id,
        kind: e.kind,
        color: EDGE_COLOR_BY_KIND[e.kind] ?? '#71717a',
      })),
    }),
    [payload, highlight],
  );

  // Disable forwardRef warnings: the lib re-renders on every prop change which is fine here.
  return (
    <div className="absolute inset-0 bg-[#06030c]">
      <ForceGraph3D
        graphData={data}
        nodeAutoColorBy="source"
        nodeRelSize={5}
        backgroundColor="#06030c"
        linkColor={(l: { color?: string }) => l.color ?? '#71717a'}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={0.85}
        linkDirectionalParticles={1}
        linkDirectionalParticleSpeed={0.005}
        nodeLabel={(n: { name: string; source: string; model: string }) =>
          `<div style="font-family: monospace; font-size: 11px; padding: 4px 8px; background: rgba(12,8,24,0.92); border: 1px solid rgba(168,85,247,0.4); border-radius: 4px;">
            <div style="color: #e5e5e5; font-weight: 700;">${escapeHtml(n.name)}</div>
            <div style="color: #a3a3a3;">${escapeHtml(n.source)} · ${escapeHtml(n.model)}</div>
          </div>`
        }
      />
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
