import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Network, X, GitBranch, GitFork, Workflow, Maximize2, Minimize2, Sliders, Maximize } from 'lucide-react';

const ForceGraph3D = lazy(() => import('react-force-graph-3d').then((m) => ({ default: m.default })));
const ForceGraph2D = lazy(() => import('react-force-graph-2d').then((m) => ({ default: m.default })));

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

type VizPreset =
  | 'default'           // glossy spheres + curved bezier links + particles
  | 'wireframe-grid'    // neon wireframe icosahedrons + straight tight links
  | 'particle-cloud'    // tiny billboard sprites + faint lines (codepen 'm00nb0y')
  | 'constellation'     // bright spheres with cyan haze, no particles (codepen 'hiteshsahu')
  | 'matrix-cube'       // wireframe cubes + arrow-only edges
  | 'plasma';           // glowy octahedrons with thick particle streams

type NodeShape =
  | 'sphere'
  | 'cube'
  | 'octahedron'
  | 'tetrahedron'
  | 'icosahedron'
  | 'torus';

interface GraphAppearance {
  renderMode: '2d' | '3d';
  vizPreset: VizPreset;
  nodeShape: NodeShape;
  nodeSizeScale: number;       // 0.5 – 3
  linkWidth: number;           // 1 – 6
  linkOpacity: number;         // 0.2 – 1
  particles: boolean;
  particleSpeed: number;       // 0.001 – 0.02
  edgeCurve: number;           // 0 = straight, 0.5 = bezier curl
  labelMode: 'hover' | 'always';
  background: 'dark' | 'midnight' | 'pure-black';
  controlType: 'orbit' | 'trackball' | 'fly';
  wireframe: boolean;
}

// Defaults are pinned to the "Particle cloud" preset — the values match
// PRESET_BUNDLES['particle-cloud'] one-for-one. We mirror them on the
// top-level fields so the AppearancePanel's preset dropdown lands on
// 'particle-cloud' AND the individual sliders display the right
// numbers on first open, without needing the panel to "apply preset"
// at mount time.
const DEFAULT_APPEARANCE: GraphAppearance = {
  renderMode: '3d',
  vizPreset: 'particle-cloud',
  nodeShape: 'sphere',
  nodeSizeScale: 0.7,
  linkWidth: 1.0,
  linkOpacity: 0.35,
  particles: true,
  particleSpeed: 0.004,
  edgeCurve: 0.15,
  labelMode: 'hover',
  background: 'pure-black',
  // Trackball is the library's default and avoids the bug in
  // react-force-graph-3d where OrbitControls + DragControls can race
  // on pointer-cancel and throw `Cannot read properties of undefined
  // (reading 'x')`. Orbit / Fly are still selectable in the panel.
  controlType: 'trackball',
  wireframe: false,
};

const APPEARANCE_STORAGE_KEY = 'lineageGraphAppearance:v1';

function loadStoredAppearance(): GraphAppearance {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<GraphAppearance>;
    // Merge over defaults so newly-added fields take their default
    // when an older payload is read back.
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Preset bundles — selecting a preset swaps a coordinated set of
 *  rendering choices for a distinct visual style (inspired by the
 *  CodePen graph demos the user pointed at). */
const PRESET_BUNDLES: Record<VizPreset, Partial<GraphAppearance>> = {
  'default': {
    nodeShape: 'sphere',
    wireframe: false,
    linkWidth: 2.5,
    linkOpacity: 0.85,
    edgeCurve: 0.0,
    particles: true,
    particleSpeed: 0.006,
    background: 'midnight',
  },
  'wireframe-grid': {
    nodeShape: 'icosahedron',
    wireframe: true,
    linkWidth: 1.2,
    linkOpacity: 0.6,
    edgeCurve: 0.0,
    particles: false,
    background: 'pure-black',
  },
  'particle-cloud': {
    nodeShape: 'sphere',
    wireframe: false,
    nodeSizeScale: 0.7,
    linkWidth: 1.0,
    linkOpacity: 0.35,
    edgeCurve: 0.15,
    particles: true,
    particleSpeed: 0.004,
    background: 'pure-black',
  },
  'constellation': {
    nodeShape: 'sphere',
    wireframe: false,
    nodeSizeScale: 1.2,
    linkWidth: 1.2,
    linkOpacity: 0.5,
    edgeCurve: 0.0,
    particles: false,
    background: 'midnight',
  },
  'matrix-cube': {
    nodeShape: 'cube',
    wireframe: true,
    linkWidth: 1.0,
    linkOpacity: 0.7,
    edgeCurve: 0.0,
    particles: false,
    background: 'pure-black',
  },
  'plasma': {
    nodeShape: 'octahedron',
    wireframe: false,
    nodeSizeScale: 1.4,
    linkWidth: 3.5,
    linkOpacity: 0.95,
    edgeCurve: 0.25,
    particles: true,
    particleSpeed: 0.012,
    background: 'midnight',
  },
};

const BG_COLORS: Record<GraphAppearance['background'], string> = {
  dark: '#0c0a14',
  midnight: '#06030c',
  'pure-black': '#000000',
};

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
  const [fullscreen, setFullscreen] = useState(false);
  // Appearance options for the 3D graph; controlled in a side drawer.
  // Hydrated from localStorage so settings survive a reload.
  const [appearance, setAppearance] = useState<GraphAppearance>(loadStoredAppearance);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // Persist appearance changes to localStorage (debounced via the
  // natural batching of React state updates — each setAppearance flushes
  // once per render, and JSON.stringify is cheap on this small object).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // Quota exceeded / SecurityError in private mode — silently skip;
      // session-only persistence is acceptable.
    }
  }, [appearance]);

  // When the modal opens for a specific track, default to that view.
  // When opened library-wide, jump straight to the genealogy view.
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

  // The modal renders via a portal mounted at document.body so it
  // escapes the `.dense-layout { zoom: 0.85 }` ancestor on <Shell>.
  // CSS `zoom` re-scales the canvas but react-force-graph's tooltip
  // overlay uses unzoomed CSS pixel coordinates → the hover/click pop-
  // up landed several centimetres away from the cursor. Portalling out
  // of the zoomed subtree fixes that for both the genealogy SVG and
  // the 3D-graph WebGL canvas.
  const modalShellClass = fullscreen
    ? 'relative w-full h-full bg-[#0c0a14] flex flex-col overflow-hidden'
    : 'relative w-[min(1100px,92vw)] h-[min(720px,86vh)] bg-[#0c0a14] border border-purple-500/30 rounded-lg shadow-2xl flex flex-col overflow-hidden';

  const content = (
    <div className="fixed inset-0 z-200 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className={modalShellClass}>
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
            {tab === 'graph3d' && (
              <button
                onClick={() => setAppearanceOpen((v) => !v)}
                className={`ml-1 p-1 rounded transition-colors ${appearanceOpen ? 'bg-purple-500/20 text-purple-200' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
                title="Appearance options"
              >
                <Sliders className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setFullscreen((v) => !v)}
              className="ml-1 p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5"
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onClose} className="ml-1 p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5">
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
              <Graph3DView
                payload={libraryGraph}
                highlight={rootEntryId}
                appearance={appearance}
              />
            </Suspense>
          )}

          {tab === 'graph3d' && appearanceOpen && (
            <AppearancePanel
              value={appearance}
              onChange={setAppearance}
              onClose={() => setAppearanceOpen(false)}
            />
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

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
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
  // Layout is LEFT→RIGHT: each generation is a vertical column of
  // stacked sub-rows. When a generation has many nodes we split it
  // across multiple SUB-COLUMNS (brick pattern) so a single generation
  // doesn't run off the bottom of the modal. Alternating sub-columns
  // are offset vertically by NODE_H/2 to stagger like the user's
  // reference screenshot.
  const NODE_W = 190;
  const NODE_H = 54;
  const COL_GAP = 90;     // gap between separate GENERATIONS
  const SUBCOL_GAP = 28;  // gap between sub-columns within a generation
  const ROW_GAP = 14;     // gap between stacked nodes in the same sub-column
  const PAD = 32;
  const STAGGER_PX = NODE_H * 0.5;
  const MAX_NODES_PER_SUBCOL = 14;

  const generationLayouts = useMemo(() => {
    type SubCol = { startX: number; ids: string[]; offset: number };
    const layouts: Array<{
      layer: number;
      subCols: SubCol[];
      genStartX: number;
      genEndX: number;
      colCount: number;
    }> = [];
    let cursorX = PAD;
    orderedRows.forEach((row) => {
      // Split row.ids across N sub-columns; brick-stagger alternating
      // sub-columns by half a node height so neighbors don't form a
      // perfect grid.
      const nSub = Math.max(1, Math.ceil(row.ids.length / MAX_NODES_PER_SUBCOL));
      const perSub = Math.ceil(row.ids.length / nSub);
      const subCols: SubCol[] = [];
      for (let s = 0; s < nSub; s += 1) {
        const slice = row.ids.slice(s * perSub, (s + 1) * perSub);
        subCols.push({
          startX: cursorX + s * (NODE_W + SUBCOL_GAP),
          ids: slice,
          offset: s % 2 === 1 ? STAGGER_PX : 0,
        });
      }
      const colCount = nSub;
      const genStartX = cursorX;
      const genEndX = cursorX + colCount * NODE_W + (colCount - 1) * SUBCOL_GAP;
      layouts.push({ layer: row.layer, subCols, genStartX, genEndX, colCount });
      cursorX = genEndX + COL_GAP;
    });
    return layouts;
  }, [orderedRows]);

  const positions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    // Vertical centering: find the tallest sub-column across the
    // whole layout, then center smaller sub-columns to it.
    let tallestPx = 0;
    generationLayouts.forEach((g) =>
      g.subCols.forEach((sc) => {
        const px = sc.ids.length * NODE_H + (sc.ids.length - 1) * ROW_GAP;
        if (px > tallestPx) tallestPx = px;
      }),
    );
    generationLayouts.forEach((g) => {
      g.subCols.forEach((sc) => {
        const colPx = sc.ids.length * NODE_H + (sc.ids.length - 1) * ROW_GAP;
        const startY = PAD + (tallestPx - colPx) / 2 + sc.offset;
        sc.ids.forEach((id, rowIdx) => {
          pos[id] = {
            x: sc.startX,
            y: startY + rowIdx * (NODE_H + ROW_GAP),
          };
        });
      });
    });
    return pos;
  }, [generationLayouts]);

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
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-fit on first mount + when bounds change so the whole tree
  // lands visible inside the modal regardless of how wide the widest
  // generation is. The "Fit" button re-runs this on demand.
  const fitToView = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const gw = bounds.maxX - bounds.minX;
    const gh = bounds.maxY - bounds.minY;
    if (cw <= 0 || ch <= 0 || gw <= 0 || gh <= 0) return;
    const margin = 40;
    const k = Math.min(
      (cw - margin) / gw,
      (ch - margin) / gh,
      1.0,
    );
    const x = (cw - gw * k) / 2 - bounds.minX * k;
    const y = (ch - gh * k) / 2 - bounds.minY * k;
    setView({ x, y, k });
  }, [bounds]);

  // Fit once the layout settles + whenever the bounds change shape.
  useEffect(() => {
    fitToView();
  }, [fitToView]);

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

  // Wheel listener must be attached non-passively so we can preventDefault
  // and stop the parent (Shell) from scrolling. React's JSX wheel handler
  // is registered as passive by default → console fires
  // "Unable to preventDefault inside passive event listener invocation".
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((v) => ({ ...v, k: Math.max(0.2, Math.min(4, v.k * factor)) }));
    };
    el.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', onNativeWheel);
  }, []);

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
      ref={containerRef}
      className="absolute inset-0 bg-[#06030c] overflow-hidden cursor-grab active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <button
          onClick={fitToView}
          className="text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:text-purple-200 bg-purple-500/15 border border-purple-500/30 hover:border-purple-400/60 px-2 py-1 rounded flex items-center gap-1"
          title="Fit the entire genealogy into the viewport"
        >
          <Maximize className="w-2.5 h-2.5" /> Fit
        </button>
        <button
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
          className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-200 bg-black/40 border border-white/10 px-2 py-1 rounded"
          title="Reset to native scale"
        >
          Reset
        </button>
      </div>

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
          {/* Edges first so nodes paint on top. Flow is left-to-right:
              parent on the left, child on the right of the next column. */}
          {connected.edges.map((edge, i) => {
            const from = positions[edge.from_id];
            const to = positions[edge.to_id];
            if (!from || !to) return null;
            const x1 = from.x + NODE_W;          // parent's right edge
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;                      // child's left edge
            const y2 = to.y + NODE_H / 2;
            // Smooth cubic Bezier curving across the column gap.
            const dx = (x2 - x1) * 0.5;
            const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
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
                  points={`${x2 - 7},${y2 - 4} ${x2 - 7},${y2 + 4} ${x2},${y2}`}
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

      {/* Generation column headers — each one spans its (possibly
          multi-sub-column) generation width and follows the canvas in
          screen-space so they don't pan/zoom with content. */}
      <div className="absolute top-0 left-0 z-10 text-[9px] font-mono uppercase tracking-widest text-zinc-500 pointer-events-none">
        {generationLayouts.map((g) => {
          const centerWorldX = (g.genStartX + g.genEndX) / 2;
          return (
            <div
              key={g.layer}
              style={{
                position: 'absolute',
                left: centerWorldX * view.k + view.x,
                top: 8,
                transform: 'translateX(-50%)',
              }}
              className="bg-purple-500/20 border border-purple-500/40 rounded px-2 py-0.5 text-purple-200"
            >
              gen {g.layer}
            </div>
          );
        })}
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


interface AppearancePanelProps {
  value: GraphAppearance;
  onChange: (next: GraphAppearance) => void;
  onClose: () => void;
}

/** Side drawer of toggles for the 3D graph. Inspired by the
 *  graphrag-workbench appearance panel — node-size scale, link weight,
 *  particles, edge curvature, control type, background. */
const AppearancePanel: React.FC<AppearancePanelProps> = ({ value, onChange, onClose }) => {
  const patch = (p: Partial<GraphAppearance>) => onChange({ ...value, ...p });
  return (
    <div className="absolute top-2 right-2 z-30 w-60 bg-[#0c0a14]/95 border border-purple-500/30 rounded-lg shadow-2xl p-3 flex flex-col gap-2 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-black uppercase tracking-widest text-purple-200">Appearance</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onChange(DEFAULT_APPEARANCE)}
            className="text-[8px] font-mono uppercase tracking-widest text-zinc-400 hover:text-zinc-100 border border-white/10 hover:border-white/20 px-1.5 py-0.5 rounded"
            title="Reset appearance to defaults"
          >
            Reset
          </button>
          <button onClick={onClose} className="p-0.5 text-zinc-500 hover:text-white rounded hover:bg-white/5">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <SelectRow
        label="Render mode"
        value={value.renderMode}
        options={[
          { value: '3d', label: '3D (force)' },
          { value: '2d', label: '2D (canvas)' },
        ]}
        onChange={(v) => patch({ renderMode: v as GraphAppearance['renderMode'] })}
      />
      <SelectRow
        label="Style preset"
        value={value.vizPreset}
        options={[
          { value: 'default',         label: 'Default spheres' },
          { value: 'wireframe-grid',  label: 'Wireframe grid' },
          { value: 'particle-cloud',  label: 'Particle cloud' },
          { value: 'constellation',   label: 'Constellation' },
          { value: 'matrix-cube',     label: 'Matrix cubes' },
          { value: 'plasma',          label: 'Plasma' },
        ]}
        onChange={(v) => {
          const next = v as VizPreset;
          // Applying a preset swaps a coordinated bundle of options.
          onChange({ ...value, vizPreset: next, ...PRESET_BUNDLES[next] });
        }}
      />
      <SelectRow
        label="Node shape"
        value={value.nodeShape}
        options={[
          { value: 'sphere',       label: 'Sphere' },
          { value: 'cube',         label: 'Cube' },
          { value: 'octahedron',   label: 'Octahedron' },
          { value: 'tetrahedron',  label: 'Tetrahedron' },
          { value: 'icosahedron',  label: 'Icosahedron' },
          { value: 'torus',        label: 'Torus' },
        ]}
        onChange={(v) => patch({ nodeShape: v as NodeShape })}
      />
      <ToggleRow
        label="Wireframe"
        on={value.wireframe}
        onChange={(on) => patch({ wireframe: on })}
      />
      <SelectRow
        label="Labels"
        value={value.labelMode}
        options={[
          { value: 'hover', label: 'On hover only' },
          { value: 'always', label: 'Always visible (2D)' },
        ]}
        onChange={(v) => patch({ labelMode: v as GraphAppearance['labelMode'] })}
      />

      <SliderRow
        label={`Node size ${value.nodeSizeScale.toFixed(1)}×`}
        min={0.5} max={3.0} step={0.1}
        value={value.nodeSizeScale}
        onChange={(v) => patch({ nodeSizeScale: v })}
      />
      <SliderRow
        label={`Link width ${value.linkWidth.toFixed(1)}`}
        min={1} max={6} step={0.5}
        value={value.linkWidth}
        onChange={(v) => patch({ linkWidth: v })}
      />
      <SliderRow
        label={`Link opacity ${value.linkOpacity.toFixed(2)}`}
        min={0.2} max={1} step={0.05}
        value={value.linkOpacity}
        onChange={(v) => patch({ linkOpacity: v })}
      />
      <SliderRow
        label={`Edge curve ${value.edgeCurve.toFixed(2)}`}
        min={0} max={0.6} step={0.05}
        value={value.edgeCurve}
        onChange={(v) => patch({ edgeCurve: v })}
      />

      <ToggleRow
        label="Particles"
        on={value.particles}
        onChange={(on) => patch({ particles: on })}
      />
      {value.particles && (
        <SliderRow
          label={`Particle speed ${value.particleSpeed.toFixed(3)}`}
          min={0.001} max={0.02} step={0.001}
          value={value.particleSpeed}
          onChange={(v) => patch({ particleSpeed: v })}
        />
      )}

      <SelectRow
        label="Controls"
        value={value.controlType}
        options={[
          { value: 'orbit', label: 'Orbit (calm)' },
          { value: 'trackball', label: 'Trackball (free)' },
          { value: 'fly', label: 'Fly' },
        ]}
        onChange={(v) => patch({ controlType: v as GraphAppearance['controlType'] })}
      />
      <SelectRow
        label="Background"
        value={value.background}
        options={[
          { value: 'midnight', label: 'Midnight' },
          { value: 'dark', label: 'Dark' },
          { value: 'pure-black', label: 'Pure black' },
        ]}
        onChange={(v) => patch({ background: v as GraphAppearance['background'] })}
      />
    </div>
  );
};


const SliderRow: React.FC<{ label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }> = ({ label, min, max, step, value, onChange }) => (
  <label className="flex flex-col gap-0.5">
    <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-400">{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="pro-slider"
    />
  </label>
);


const ToggleRow: React.FC<{ label: string; on: boolean; onChange: (on: boolean) => void }> = ({ label, on, onChange }) => (
  <button
    onClick={() => onChange(!on)}
    className="flex items-center justify-between text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white px-1 py-1 rounded hover:bg-white/5"
  >
    <span>{label}</span>
    <span className={`text-[8px] ${on ? 'text-emerald-300' : 'text-zinc-600'}`}>{on ? 'ON' : 'OFF'}</span>
  </button>
);


const SelectRow: React.FC<{ label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => (
  <label className="flex flex-col gap-0.5">
    <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-400">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="compact-input bg-black/40 text-[10px]"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </label>
);


/** Interactive 3D force-directed graph using react-force-graph-3d.
 *  Camera auto-fits to the connected subgraph on first render so the
 *  user lands on something usable instead of a dot in the distance.
 *  Appearance controlled via the AppearancePanel side drawer. */
const Graph3DView: React.FC<{
  payload: GraphPayload;
  highlight: string | null;
  appearance: GraphAppearance;
}> = ({ payload, highlight, appearance }) => {
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

  // Graphrag-workbench-style search: when the query is non-empty, nodes
  // whose name/prompt/model don't substring-match are visually muted
  // (gray, low alpha) and their incident edges are dimmed. Empty query
  // disables the filter. Matching is case-insensitive.
  const [searchQuery, setSearchQuery] = useState('');
  const searchNeedle = searchQuery.trim().toLowerCase();
  const matchSet = useMemo(() => {
    if (!searchNeedle) return null;
    const out = new Set<string>();
    for (const n of connected.nodes) {
      const haystack = `${n.title ?? ''} ${n.id} ${n.source ?? ''} ${n.model ?? ''}`.toLowerCase();
      if (haystack.includes(searchNeedle)) out.add(n.id);
    }
    return out;
  }, [searchNeedle, connected.nodes]);

  const data = useMemo(
    () => ({
      nodes: connected.nodes.map((n) => {
        const isMatch = matchSet === null || matchSet.has(n.id);
        const baseColor = n.id === highlight ? '#fbbf24' : pickNodeColor(n);
        return {
          id: n.id,
          name: n.title ?? n.id,
          title: n.title ?? '',
          source: n.source ?? '',
          model: n.model ?? '',
          val: (4 + Math.log10(1 + (n.duration_sec ?? 1)) * 6) * appearance.nodeSizeScale,
          color: isMatch ? baseColor : '#2a2336',
          // expose match flag so labelHtml / future hover hooks can read it
          __searchDim: !isMatch,
        };
      }),
      links: connected.edges.map((e) => {
        const isMatch =
          matchSet === null || (matchSet.has(e.from_id) && matchSet.has(e.to_id));
        const baseColor = EDGE_COLOR_BY_KIND[e.kind] ?? '#a78bfa';
        return {
          source: e.from_id,
          target: e.to_id,
          kind: e.kind,
          color: isMatch ? baseColor : '#1c1828',
          __searchDim: !isMatch,
        };
      }),
    }),
    [connected, highlight, appearance.nodeSizeScale, matchSet],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // Fit-to-view at two checkpoints so we catch both early- and late-
  // settling force layouts. Without this the camera lingers at its
  // default position and the user sees one disconnected dot far off
  // in z-space.
  useEffect(() => {
    const timeouts = [400, 1500, 3000].map((ms) =>
      setTimeout(() => {
        const ref = fgRef.current as {
          zoomToFit?: (ms: number, pad: number) => void;
          centerAt?: (x: number, y: number, ms: number) => void;
        } | null;
        if (ref?.zoomToFit) ref.zoomToFit(600, 80);
        if (ref?.centerAt) ref.centerAt(0, 0, 600);
      }, ms),
    );
    return () => timeouts.forEach(clearTimeout);
  }, [data, appearance.renderMode]);

  // Inject a starfield + ambient/point lights into the underlying
  // Three.js scene once it exists. Used by every 3D preset, so the
  // graph never looks like it's floating in a black void.
  //
  // Wrapped in a deferred handle so the heavy 1500-point geometry build
  // doesn't block the React commit phase — that pile-on is what triggers
  // "[Violation] 'message' handler took Xms" on initial modal open.
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    let teardown: (() => void) | null = null;
    let cancelled = false;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    const schedule = (fn: () => void) => {
      if (typeof ric === 'function') ric(fn, { timeout: 500 });
      else setTimeout(fn, 0);
    };
    schedule(() => {
      if (cancelled) return;
      const setup = setupStarfield();
      if (setup) teardown = setup;
    });
    return () => {
      cancelled = true;
      teardown?.();
    };

    function setupStarfield(): (() => void) | null {
    const THREE = threeRef.current;
    const ref = fgRef.current as { scene?: () => unknown } | null;
    if (!THREE || !ref?.scene) return null;
    const scene = ref.scene() as import('three').Scene;
    if (!scene) return null;

    // Wipe any prior starfield from a previous mount.
    const prior = scene.getObjectByName('__lineage_stars__');
    if (prior) scene.remove(prior);
    const priorLight = scene.getObjectByName('__lineage_ambient__');
    if (priorLight) scene.remove(priorLight);

    const starsGeo = new THREE.BufferGeometry();
    const STAR_COUNT = 1500;
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const palette = [
      new THREE.Color('#a78bfa'),
      new THREE.Color('#60a5fa'),
      new THREE.Color('#34d399'),
      new THREE.Color('#f472b6'),
      new THREE.Color('#fbbf24'),
      new THREE.Color('#ffffff'),
    ];
    for (let i = 0; i < STAR_COUNT; i += 1) {
      // Sphere of radius 1200 around origin — far enough that nodes
      // never visually overlap the starfield.
      const r = 800 + Math.random() * 800;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    starsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starsGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const starsMat = new THREE.PointsMaterial({
      size: 1.8,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(starsGeo, starsMat);
    stars.name = '__lineage_stars__';
    scene.add(stars);

    // Soft ambient + a colored point light so emissive haloes pop a
    // little even when the camera is far away.
    const ambient = new THREE.AmbientLight(0x9580ff, 0.55);
    ambient.name = '__lineage_ambient__';
    scene.add(ambient);

    return () => {
      scene.remove(stars);
      scene.remove(ambient);
      starsGeo.dispose();
      starsMat.dispose();
    };
    }
  }, [appearance.renderMode, appearance.vizPreset, data]);

  if (connected.nodes.length === 0) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 italic px-12 text-center">
        No relationships yet. Generate a Chimera, separate stems, or convert
        a track to MIDI to start populating the graph.
      </p>
    );
  }

  const bgColor = BG_COLORS[appearance.background];

  const labelHtml = (n: { name: string; source: string; model: string }) =>
    `<div style="font-family: monospace; font-size: 11px; padding: 6px 8px; background: rgba(12,8,24,0.95); border: 1px solid rgba(168,85,247,0.5); border-radius: 4px; max-width: 280px; word-wrap: break-word; overflow-wrap: anywhere; white-space: normal; line-height: 1.3;">
        <div style="color: #e5e5e5; font-weight: 700; word-wrap: break-word;">${escapeHtml(n.name)}</div>
        <div style="color: #a3a3a3; font-size: 10px;">${escapeHtml(n.source)} · ${escapeHtml(n.model)}</div>
      </div>`;

  // Build a Three.js mesh per node based on the chosen shape +
  // wireframe flag. Lazy-imports three only when the 3D mode is on
  // so 2D users don't pay the bundle cost.
  const buildNodeObject = useMemo(() => {
    let THREE: typeof import('three') | null = null;
    return async (
      node: { color?: string; val?: number },
    ): Promise<unknown> => {
      if (!THREE) {
        THREE = await import('three');
      }
      const t = THREE;
      const size = Math.cbrt(node.val ?? 4);
      let geometry: import('three').BufferGeometry;
      switch (appearance.nodeShape) {
        case 'cube':
          geometry = new t.BoxGeometry(size, size, size);
          break;
        case 'octahedron':
          geometry = new t.OctahedronGeometry(size * 0.85);
          break;
        case 'tetrahedron':
          geometry = new t.TetrahedronGeometry(size);
          break;
        case 'icosahedron':
          geometry = new t.IcosahedronGeometry(size * 0.85);
          break;
        case 'torus':
          geometry = new t.TorusGeometry(size * 0.7, size * 0.25, 8, 16);
          break;
        case 'sphere':
        default:
          geometry = new t.SphereGeometry(size, 12, 12);
          break;
      }
      const color = new t.Color(node.color ?? '#a78bfa');
      const material = new t.MeshBasicMaterial({
        color,
        wireframe: appearance.wireframe,
        transparent: true,
        opacity: appearance.wireframe ? 0.95 : 0.9,
      });
      const mesh = new t.Mesh(geometry, material);
      return mesh;
    };
    // Re-build when shape OR wireframe toggle changes.
  }, [appearance.nodeShape, appearance.wireframe]);

  // Synchronous wrapper: react-force-graph calls nodeThreeObject
  // synchronously, so we cache the lazy-import promise + render with
  // a placeholder until three is loaded. In practice three loads in
  // <100ms once the user opens the 3D tab.
  const threeRef = useRef<typeof import('three') | null>(null);
  useEffect(() => {
    if (appearance.renderMode !== '3d') return;
    void import('three').then((mod) => {
      threeRef.current = mod;
    });
  }, [appearance.renderMode]);

  const nodeThreeObject = (node: { color?: string; val?: number }): unknown => {
    void buildNodeObject;
    const THREE = threeRef.current;
    if (!THREE) return undefined; // first frame: fall through to default sphere
    const size = Math.cbrt(node.val ?? 4);
    let geometry: import('three').BufferGeometry;
    switch (appearance.nodeShape) {
      case 'cube':
        geometry = new THREE.BoxGeometry(size, size, size);
        break;
      case 'octahedron':
        geometry = new THREE.OctahedronGeometry(size * 0.85);
        break;
      case 'tetrahedron':
        geometry = new THREE.TetrahedronGeometry(size);
        break;
      case 'icosahedron':
        geometry = new THREE.IcosahedronGeometry(size * 0.85);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(size * 0.7, size * 0.25, 8, 16);
        break;
      case 'sphere':
      default:
        geometry = new THREE.SphereGeometry(size, 16, 16);
        break;
    }
    const colorHex = node.color ?? '#a78bfa';
    const baseColor = new THREE.Color(colorHex);
    // Build a Group so we can stack a wireframe halo + inner solid for
    // the glossy "neon" look the codepens go for.
    const group = new THREE.Group();
    if (appearance.wireframe) {
      const wire = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: baseColor,
          wireframe: true,
          transparent: true,
          opacity: 0.95,
        }),
      );
      group.add(wire);
    } else {
      // Solid inner core + slightly larger translucent "halo" that
      // approximates a glow without needing a postprocessing pass.
      const inner = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.95 }),
      );
      group.add(inner);
      const haloGeo = geometry.clone();
      haloGeo.scale(1.45, 1.45, 1.45);
      const halo = new THREE.Mesh(
        haloGeo,
        new THREE.MeshBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(halo);
    }
    return group;
  };

  return (
    <div className="absolute inset-0" style={{ background: bgColor }}>
      {appearance.renderMode === '3d' ? (
        <ForceGraph3D
          ref={fgRef}
          graphData={data}
          nodeAutoColorBy="source"
          nodeRelSize={5}
          backgroundColor={bgColor}
          showNavInfo={false}
          controlType={appearance.controlType}
          linkColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkOpacity={appearance.linkOpacity}
          linkWidth={appearance.linkWidth}
          linkCurvature={appearance.edgeCurve}
          linkDirectionalArrowLength={5}
          linkDirectionalArrowRelPos={0.92}
          linkDirectionalArrowColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkDirectionalParticles={appearance.particles ? 2 : 0}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleSpeed={appearance.particleSpeed}
          nodeThreeObject={nodeThreeObject}
          nodeLabel={labelHtml}
        />
      ) : (
        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          nodeRelSize={5}
          backgroundColor={bgColor}
          // Node drag is on by default in ForceGraph2D — being explicit
          // here so a refactor doesn't silently disable it. Each node is
          // grabbable; the force layout updates around it in real time.
          enableNodeDrag={true}
          enablePanInteraction={true}
          enableZoomInteraction={true}
          linkColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkLineDash={() => null}
          linkWidth={appearance.linkWidth}
          linkCurvature={appearance.edgeCurve}
          linkDirectionalArrowLength={6}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={(l: { color?: string }) => l.color ?? '#a78bfa'}
          linkDirectionalParticles={appearance.particles ? 2 : 0}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleSpeed={appearance.particleSpeed}
          nodeCanvasObjectMode={() =>
            appearance.labelMode === 'always' ? 'after' : undefined
          }
          nodeCanvasObject={(node: { x: number; y: number; name: string; color: string; val: number }, ctx: CanvasRenderingContext2D, globalScale: number) => {
            if (appearance.labelMode !== 'always') return;
            const label = node.name;
            const fontSize = 11 / globalScale;
            ctx.font = `${fontSize}px ui-monospace, monospace`;
            const textWidth = ctx.measureText(label).width;
            const padding = 4 / globalScale;
            ctx.fillStyle = 'rgba(12,8,24,0.85)';
            ctx.fillRect(
              node.x - textWidth / 2 - padding,
              node.y + node.val + 2 / globalScale,
              textWidth + padding * 2,
              fontSize + padding,
            );
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#e5e5e5';
            ctx.fillText(label, node.x, node.y + node.val + 2 / globalScale + padding / 2);
          }}
          nodeLabel={labelHtml}
        />
      )}
      {/* Search overlay — sits above the graph canvas, fixed top-left.
          Typing filters nodes/edges by dimming non-matching ones; empty
          query restores everything. Inspired by graphrag-workbench's
          query box. */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
        <input
          id="lineage-graph-search"
          name="lineage-graph-search"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search graph…"
          className="bg-black/60 backdrop-blur-sm border border-purple-500/30 rounded px-2 py-1 text-[10px] font-mono text-zinc-200 placeholder-zinc-500 w-44 focus:outline-none focus:border-purple-400/60"
        />
        {matchSet !== null && (
          <span className="text-[9px] font-mono text-purple-300/80 px-1.5 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded">
            {matchSet.size} / {connected.nodes.length}
          </span>
        )}
      </div>
      <div className="absolute bottom-2 left-2 z-10 text-[8px] font-mono text-zinc-600 pointer-events-none">
        {appearance.renderMode === '3d'
          ? 'click-drag rotate · right-click-drag pan · wheel zoom'
          : 'click-drag pan · wheel zoom'}
        {' · '}{connected.nodes.length} connected nodes · {connected.edges.length} relationships
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
