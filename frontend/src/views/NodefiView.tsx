/**
 * Nodefi — a node-graph editor for building generation pipelines. A dark,
 * pannable/zoomable canvas of node cards wired by glowing bezier edges, with a
 * left palette and a right inspector. Run drives the graph through the existing
 * generate / effect / library actions (see lib/nodefiRunner.ts).
 *
 * Hand-rolled canvas (no node-editor dependency): CSS-transform world layer,
 * SVG edges, pointer-driven pan / node-drag / drag-to-connect. Standard
 * node-editor tools: click / ctrl-click / shift-drag marquee selection,
 * multi-drag, Delete, Ctrl+D duplicate, Ctrl+Z/Y undo-redo, F zoom-to-fit,
 * clickable wires, right-click menus.
 *
 * Pointer math: the Shell scales the whole DAW with CSS `zoom` (.dense-layout),
 * so `clientX/getBoundingClientRect()` are viewport px while the world layer
 * works in local px. Every screen→world conversion divides by
 * `effectiveZoom(canvas)` FIRST, then applies the graph viewport transform.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, Crosshair, Loader2, AlertCircle, CheckCircle2, Volume2, Pause, Undo2, Redo2, Scan, Copy, Unplug, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { NODE_ICONS } from '../components/nodefi/nodeIcons';
import { useNodefiStore } from '../state/nodefiStore';
import { runGraph, type RunController } from '../lib/nodefiRunner';
import { nodeDef, type GraphNode, type NodeKind, type NodeRunStatus } from '../lib/nodefiTypes';
import { NodefiPalette } from '../components/nodefi/NodefiPalette';
import { NodefiInspector } from '../components/nodefi/NodefiInspector';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { effectiveZoom } from '../lib/canvasScale';
import { ownsKey } from '../lib/keyScope';
import { logInfo } from '../state/logStore';
import { useLibraryStore } from '../state/libraryStore';
import { NODEFI_TEMPLATES, resolveTemplateSource } from '../data/nodefiTemplates';
import { startLiveGraph, isLiveOnlyKind, type LiveController } from '../lib/nodefiLive';
import type { SavedNodeSet } from '../state/nodefiSetsStore';

// Circular glossy nodes (see NODE_EDITOR reference): a fixed-diameter disc with
// ports on the rim and the label beneath. Edge endpoints land on the rim.
const NODE_DIAM = 88;
// Vertical allowance under the disc for the label row when fitting the view.
const NODE_LABEL_H = 34;
// Pull distance (local px) at which the palette goo strand snaps and the
// dragged orb travels free.
const GOO_SNAP = 150;
// Nodefi's identity accent (the tab is teal — in-view accents match it).
const ACCENT = '#2dd4bf';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface XY {
  x: number;
  y: number;
}

/** Vertical offset of port `idx` of `count` down the circle's rim, relative to
 *  the circle's top (`top`). A single port sits at the middle; multiples spread
 *  across the vertical span with padding so they stay on the arc. */
function portY(top: number, count: number, idx: number): number {
  if (count <= 1) return top + NODE_DIAM / 2;
  const pad = NODE_DIAM * 0.24;
  return top + pad + ((NODE_DIAM - 2 * pad) * idx) / (count - 1);
}

function portWorld(node: GraphNode, portId: string, dir: 'in' | 'out'): XY {
  const def = nodeDef(node.kind);
  const ports = dir === 'out' ? def.outputs : def.inputs;
  const idx = Math.max(0, ports.findIndex((p) => p.id === portId));
  return {
    x: dir === 'out' ? node.x + NODE_DIAM : node.x,
    y: portY(node.y, ports.length, idx),
  };
}

function edgePath(a: XY, b: XY): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

const STATUS_COLOR: Record<NodeRunStatus, string> = {
  idle: '#3f3a4a',
  queued: '#6b7280',
  running: '#f59e0b',
  done: '#34d399',
  error: '#f43f5e',
};

function PreviewButton({ url }: { url: string }): React.ReactElement {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const a = new Audio(url);
    a.onended = () => setPlaying(false);
    audioRef.current = a;
    return () => {
      a.pause();
      audioRef.current = null;
    };
  }, [url]);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      a.currentTime = 0;
      setPlaying(false);
    } else {
      void a.play();
      setPlaying(true);
    }
  };
  return (
    <button
      onClick={toggle}
      onMouseDown={(e) => e.stopPropagation()}
      aria-label={playing ? 'Stop preview' : 'Play preview'}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[9px] font-mono text-zinc-300 transition-colors"
    >
      {playing ? <Pause className="w-2.5 h-2.5" /> : <Volume2 className="w-2.5 h-2.5" />}
      preview
    </button>
  );
}

interface NodeCardProps {
  node: GraphNode;
  selected: boolean;
  status: NodeRunStatus;
  previewUrl: string | null;
  onHeaderDown: (e: React.MouseEvent, id: string) => void;
  onPortDown: (e: React.MouseEvent, id: string, portId: string) => void;
  onSelect: (e: React.MouseEvent, id: string) => void;
  onMenu: (e: React.MouseEvent, id: string) => void;
}

function NodeCard({ node, selected, status, previewUrl, onHeaderDown, onPortDown, onSelect, onMenu }: NodeCardProps): React.ReactElement {
  const def = nodeDef(node.kind);
  const D = NODE_DIAM;
  const ring = selected ? def.accent : `${def.accent}66`;
  const glow = selected
    ? `0 0 0 2px ${def.accent}, 0 0 22px ${def.accent}66`
    : status === 'running'
      ? `0 0 20px ${def.accent}66`
      : '0 6px 16px rgba(0,0,0,0.55)';
  const showFooter = !!previewUrl || status === 'running' || status === 'done' || status === 'error';

  return (
    <div
      className="absolute select-none flex flex-col items-center"
      style={{ left: node.x, top: node.y, width: D }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect(e, node.id);
      }}
      onContextMenu={(e) => onMenu(e, node.id)}
    >
      {/* Glossy disc — the whole circle is the drag handle */}
      <div
        className="relative cursor-grab active:cursor-grabbing"
        style={{
          width: D,
          height: D,
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 30%, #332c4d 0%, #191325 46%, #0c0a15 100%)',
          border: `1px solid ${ring}`,
          boxShadow: glow,
        }}
        onMouseDown={(e) => onHeaderDown(e, node.id)}
      >
        {/* top gloss highlight */}
        <span
          className="absolute pointer-events-none"
          style={{ left: '20%', right: '30%', top: '12%', height: '26%', borderRadius: '50%', background: 'linear-gradient(180deg, rgba(255,255,255,0.20), rgba(255,255,255,0))' }}
        />
        {/* inner inset disc, faintly accent-lit */}
        <span
          className="absolute rounded-full pointer-events-none"
          style={{ inset: '22%', background: `radial-gradient(circle at 50% 40%, ${def.accent}26, #0b0912 72%)`, boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.7)' }}
        />
        {/* kind glyph — makes node types tellable at a glance */}
        {(() => {
          const KindIcon = NODE_ICONS[node.kind];
          return (
            <KindIcon
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none"
              style={{ color: def.accent, opacity: 0.9 }}
              strokeWidth={1.75}
            />
          );
        })()}
        {/* status dot */}
        <span
          className="absolute rounded-full"
          style={{ width: 8, height: 8, top: 6, right: 8, background: STATUS_COLOR[status], boxShadow: status === 'running' ? `0 0 6px ${STATUS_COLOR[status]}` : 'none' }}
        />
        {/* input ports on the left rim */}
        {def.inputs.map((p, i) => (
          <span
            key={p.id}
            data-node={node.id}
            data-port-in={p.id}
            title={p.label}
            className="absolute rounded-full cursor-crosshair"
            style={{ width: 12, height: 12, left: 0, top: portY(0, def.inputs.length, i) - 6, transform: 'translateX(-50%)', border: `2px solid ${def.accent}`, background: '#0b0912' }}
          />
        ))}
        {/* output ports on the right rim */}
        {def.outputs.map((p, i) => (
          <span
            key={p.id}
            data-node={node.id}
            data-port-out={p.id}
            title={p.label}
            onMouseDown={(e) => onPortDown(e, node.id, p.id)}
            className="absolute rounded-full cursor-crosshair"
            style={{ width: 12, height: 12, left: D, top: portY(0, def.outputs.length, i) - 6, transform: 'translateX(-50%)', border: `2px solid ${def.accent}`, background: '#0b0912' }}
          />
        ))}
      </div>

      {/* Label beneath the circle */}
      <span className="mt-1 max-w-40 truncate text-center text-[12px] font-mono font-bold leading-tight text-zinc-300">
        {node.title || def.label}
      </span>

      {/* Footer — preview / status, only when relevant */}
      {showFooter && (
        <div className="mt-0.5 flex items-center gap-1">
          {status === 'running' ? <Loader2 className="w-3 h-3 text-amber-400 animate-spin" /> : null}
          {status === 'done' && !previewUrl ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : null}
          {status === 'error' ? <AlertCircle className="w-3 h-3 text-rose-400" /> : null}
          {previewUrl ? <PreviewButton url={previewUrl} /> : null}
        </div>
      )}
    </div>
  );
}

export function NodefiView(): React.ReactElement {
  const nodes = useNodefiStore((s) => s.nodes);
  const edges = useNodefiStore((s) => s.edges);
  const viewport = useNodefiStore((s) => s.viewport);
  const railWidth = useNodefiStore((s) => s.railWidth);
  const inspectorWidth = useNodefiStore((s) => s.inspectorWidth);
  const railOpen = useNodefiStore((s) => s.railOpen);
  const inspectorOpen = useNodefiStore((s) => s.inspectorOpen);
  const setRailOpen = useNodefiStore((s) => s.setRailOpen);
  const setInspectorOpen = useNodefiStore((s) => s.setInspectorOpen);
  const selectedIds = useNodefiStore((s) => s.selectedIds);
  const selectedEdgeId = useNodefiStore((s) => s.selectedEdgeId);
  const status = useNodefiStore((s) => s.status);
  const previews = useNodefiStore((s) => s.previews);
  const running = useNodefiStore((s) => s.running);
  const canUndo = useNodefiStore((s) => s.past.length > 0);
  const canRedo = useNodefiStore((s) => s.future.length > 0);

  const addNode = useNodefiStore((s) => s.addNode);
  const moveNodesBy = useNodefiStore((s) => s.moveNodesBy);
  const connect = useNodefiStore((s) => s.connect);
  const removeEdge = useNodefiStore((s) => s.removeEdge);
  const setViewport = useNodefiStore((s) => s.setViewport);
  const select = useNodefiStore((s) => s.select);
  const setSelection = useNodefiStore((s) => s.setSelection);
  const toggleInSelection = useNodefiStore((s) => s.toggleInSelection);
  const selectEdge = useNodefiStore((s) => s.selectEdge);
  const clearGraph = useNodefiStore((s) => s.clearGraph);
  const undo = useNodefiStore((s) => s.undo);
  const redo = useNodefiStore((s) => s.redo);
  const setRunning = useNodefiStore((s) => s.setRunning);
  const setStatus = useNodefiStore((s) => s.setStatus);
  const setPreview = useNodefiStore((s) => s.setPreview);
  const resetRun = useNodefiStore((s) => s.resetRun);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;
  const controllerRef = useRef<RunController | null>(null);

  const interaction = useRef<
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { type: 'drag'; ids: string[]; lastX: number; lastY: number }
    | { type: 'wire'; from: string; fromPort: string; x1: number; y1: number }
    | { type: 'box'; x0: number; y0: number }
    | null
  >(null);
  const [wireCursor, setWireCursor] = useState<XY | null>(null);
  // Marquee rect endpoints in WORLD coords (normalized when rendered/applied).
  const [boxCursor, setBoxCursor] = useState<XY | null>(null);

  const nodeMenu = useContextMenu<string>();
  const edgeMenu = useContextMenu<string>();

  const screenToWorld = useCallback((clientX: number, clientY: number): XY => {
    const el = canvasRef.current;
    const rect = el?.getBoundingClientRect();
    // clientX and rect.left are viewport px (scaled by the shell's CSS zoom);
    // the world layer lives in local px — undo the zoom before the graph
    // viewport transform.
    const ez = effectiveZoom(el);
    const vp = vpRef.current;
    const rx = (clientX - (rect?.left ?? 0)) / ez;
    const ry = (clientY - (rect?.top ?? 0)) / ez;
    return { x: (rx - vp.x) / vp.zoom, y: (ry - vp.y) / vp.zoom };
  }, []);

  // Global pointer handling for pan / drag / wire / marquee.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const it = interaction.current;
      if (!it) return;
      if (it.type === 'pan') {
        const ez = effectiveZoom(canvasRef.current);
        setViewport({
          ...vpRef.current,
          x: it.ox + (e.clientX - it.sx) / ez,
          y: it.oy + (e.clientY - it.sy) / ez,
        });
      } else if (it.type === 'drag') {
        const w = screenToWorld(e.clientX, e.clientY);
        moveNodesBy(it.ids, w.x - it.lastX, w.y - it.lastY);
        it.lastX = w.x;
        it.lastY = w.y;
      } else if (it.type === 'wire') {
        setWireCursor(screenToWorld(e.clientX, e.clientY));
      } else if (it.type === 'box') {
        setBoxCursor(screenToWorld(e.clientX, e.clientY));
      }
    };
    const onUp = (e: MouseEvent) => {
      const it = interaction.current;
      if (it?.type === 'wire') {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const portEl = el?.closest('[data-port-in]') as HTMLElement | null;
        if (portEl) {
          const to = portEl.getAttribute('data-node');
          const toPort = portEl.getAttribute('data-port-in');
          if (to && toPort) connect(it.from, it.fromPort, to, toPort);
        }
      } else if (it?.type === 'box') {
        const cur = screenToWorld(e.clientX, e.clientY);
        const x0 = Math.min(it.x0, cur.x);
        const y0 = Math.min(it.y0, cur.y);
        const x1 = Math.max(it.x0, cur.x);
        const y1 = Math.max(it.y0, cur.y);
        const hit = useNodefiStore
          .getState()
          .nodes.filter((n) => n.x + NODE_DIAM > x0 && n.x < x1 && n.y + NODE_DIAM > y0 && n.y < y1)
          .map((n) => n.id);
        setSelection(hit);
      }
      interaction.current = null;
      setWireCursor(null);
      setBoxCursor(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [connect, moveNodesBy, screenToWorld, setSelection, setViewport]);

  // Non-passive wheel zoom (around cursor).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ez = effectiveZoom(el);
      const mx = (e.clientX - rect.left) / ez;
      const my = (e.clientY - rect.top) / ez;
      const vp = vpRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nz = clamp(vp.zoom * factor, 0.25, 2.5);
      const wx = (mx - vp.x) / vp.zoom;
      const wy = (my - vp.y) / vp.zoom;
      setViewport({ x: mx - wx * nz, y: my - wy * nz, zoom: nz });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setViewport]);

  const onCanvasDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      // Shift+drag on the background: marquee box-select.
      const w = screenToWorld(e.clientX, e.clientY);
      interaction.current = { type: 'box', x0: w.x, y0: w.y };
      setBoxCursor(w);
      return;
    }
    // Background press: pan + deselect.
    const vp = vpRef.current;
    interaction.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: vp.x, oy: vp.y };
    select(null);
  };

  const onHeaderDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      if (e.ctrlKey || e.metaKey) {
        toggleInSelection(id);
        return;
      }
      // Pressing an unselected node selects it; pressing a member of the
      // current selection keeps the selection so the whole group drags.
      const st = useNodefiStore.getState();
      if (!st.selectedIds.includes(id)) select(id);
      const ids = useNodefiStore.getState().selectedIds;
      const w = screenToWorld(e.clientX, e.clientY);
      interaction.current = { type: 'drag', ids: ids.length ? ids : [id], lastX: w.x, lastY: w.y };
    },
    [screenToWorld, select, toggleInSelection],
  );

  const onNodeSelect = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.ctrlKey || e.metaKey) toggleInSelection(id);
      else select(id);
    },
    [select, toggleInSelection],
  );

  const onNodeMenu = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      const st = useNodefiStore.getState();
      if (!st.selectedIds.includes(id)) select(id);
      nodeMenu.open(e, id);
    },
    [nodeMenu, select],
  );

  const onPortDown = useCallback((e: React.MouseEvent, id: string, portId: string) => {
    e.stopPropagation();
    const node = useNodefiStore.getState().nodes.find((n) => n.id === id);
    if (!node) return;
    const p = portWorld(node, portId, 'out');
    interaction.current = { type: 'wire', from: id, fromPort: portId, x1: p.x, y1: p.y };
    setWireCursor(p);
  }, []);

  const spawn = useCallback(
    (kind: NodeKind) => {
      const el = canvasRef.current;
      const rect = el?.getBoundingClientRect();
      const ez = effectiveZoom(el);
      const vp = vpRef.current;
      const cw = (rect?.width ?? 800) / ez;
      const ch = (rect?.height ?? 500) / ez;
      const cx = (cw / 2 - vp.x) / vp.zoom;
      const cy = (ch / 2 - vp.y) / vp.zoom;
      const jitter = (useNodefiStore.getState().nodes.length % 6) * 24;
      addNode(kind, cx - NODE_DIAM / 2 + jitter, cy - NODE_DIAM / 2 + jitter);
    },
    [addNode],
  );

  // ── Goo drag: pull an orb out of the palette rail onto the canvas ─────────
  // All coordinates are LOCAL px (client / effectiveZoom) so the fixed overlay
  // lines up under the shell's CSS zoom. The strand renders as metaballs
  // (blur + contrast filter) between the grab origin and the pointer; past
  // GOO_SNAP it snaps and the ghost orb travels free. Release over the canvas
  // drops the node at the pointer; a press without movement drops at centre.
  const [gooDrag, setGooDrag] = useState<
    | { kind: NodeKind; origin: XY; cur: XY; overCanvas: boolean }
    | null
  >(null);
  const gooRef = useRef<{ kind: NodeKind; origin: XY; cx: number; cy: number; moved: boolean } | null>(null);
  // A pointer gesture fully handles its own add; the button's onClick must then
  // be ignored (canceling pointerdown does not reliably suppress the compat
  // click). Keyboard activation fires click with no preceding pointerup, so it
  // passes the guard and still adds a node.
  const clickGuardRef = useRef(0);

  const onPaletteAdd = useCallback(
    (kind: NodeKind) => {
      if (Date.now() - clickGuardRef.current < 400) return;
      spawn(kind);
    },
    [spawn],
  );

  const onOrbDown = useCallback(
    (kind: NodeKind, e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || !e.isPrimary) return;
      // Canceling pointerdown suppresses the compatibility click, so the
      // palette button's onClick stays keyboard-only while pointers go
      // through this drag path.
      e.preventDefault();
      const ez = effectiveZoom(canvasRef.current);
      const origin = { x: e.clientX / ez, y: e.clientY / ez };
      gooRef.current = { kind, origin, cx: e.clientX, cy: e.clientY, moved: false };
      setGooDrag({ kind, origin, cur: origin, overCanvas: false });
      const inCanvas = (ev: PointerEvent): boolean => {
        const r = canvasRef.current?.getBoundingClientRect();
        return !!r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      };
      const onMove = (ev: PointerEvent) => {
        const g = gooRef.current;
        if (!g) return;
        if (Math.hypot(ev.clientX - g.cx, ev.clientY - g.cy) > 5) g.moved = true;
        setGooDrag({
          kind: g.kind,
          origin: g.origin,
          cur: { x: ev.clientX / ez, y: ev.clientY / ez },
          overCanvas: inCanvas(ev),
        });
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        const g = gooRef.current;
        gooRef.current = null;
        setGooDrag(null);
        if (!g) return;
        clickGuardRef.current = Date.now();
        if (!g.moved) {
          spawn(g.kind);
          return;
        }
        if (inCanvas(ev)) {
          const w = screenToWorld(ev.clientX, ev.clientY);
          addNode(g.kind, w.x - NODE_DIAM / 2, w.y - NODE_DIAM / 2);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [addNode, screenToWorld, spawn],
  );

  const run = useCallback(() => {
    const st = useNodefiStore.getState();
    if (!st.nodes.length || st.running) return;
    resetRun();
    setRunning(true);
    logInfo('nodefi', `running ${st.nodes.length} node(s)`);
    const ctrl = runGraph(st.nodes, st.edges, {
      onStatus: (id, s, msg) => setStatus(id, s, msg),
      onOutput: (id, blob) => setPreview(id, blob),
      onLog: (m) => logInfo('nodefi', m),
    });
    controllerRef.current = ctrl;
    ctrl.promise
      .then(() => logInfo('nodefi', 'run complete'))
      .catch((err) => {
        if (err instanceof Error && err.message !== 'cancelled') logInfo('nodefi', `run stopped — ${err.message}`);
      })
      .finally(() => {
        setRunning(false);
        controllerRef.current = null;
      });
  }, [resetRun, setPreview, setRunning, setStatus]);

  const stop = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);

  // ── LIVE performance mode ─────────────────────────────────────────────────
  // Real-time Web Audio playback of the live subgraph (stems, Live FX, LFOs) —
  // no AI model runs. Param edits stream into the running graph; structural
  // edits (add/remove/rewire) stop it so the graph can be re-armed.
  const [liveOn, setLiveOn] = useState(false);
  const liveRef = useRef<LiveController | null>(null);
  const hasLiveNodes = useMemo(() => nodes.some((n) => isLiveOnlyKind(n.kind)), [nodes]);

  const stopLive = useCallback(() => {
    liveRef.current?.stop();
    liveRef.current = null;
    setLiveOn(false);
  }, []);

  const goLive = useCallback(async () => {
    const st = useNodefiStore.getState();
    if (st.running || liveRef.current) return;
    st.resetRun();
    try {
      const ctrl = await startLiveGraph(st.nodes, st.edges, {
        onStatus: (id, s, msg) => useNodefiStore.getState().setStatus(id, s, msg),
        onLog: (m) => logInfo('nodefi', m),
      });
      liveRef.current = ctrl;
      setLiveOn(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo('nodefi', `LIVE failed — ${msg}`);
    }
  }, []);

  // While live: stream param edits into the engine; a structural change
  // (nodes added/removed, wires changed) stops the performance cleanly.
  useEffect(() => {
    if (!liveOn) return undefined;
    let prevNodes = useNodefiStore.getState().nodes;
    let prevEdges = useNodefiStore.getState().edges;
    const unsub = useNodefiStore.subscribe((s) => {
      if (s.edges !== prevEdges || s.nodes.length !== prevNodes.length) {
        prevEdges = s.edges;
        prevNodes = s.nodes;
        logInfo('nodefi', 'graph changed — LIVE stopped (press LIVE to re-arm)');
        stopLive();
        return;
      }
      if (s.nodes !== prevNodes) {
        const prevById = new Map(prevNodes.map((n) => [n.id, n]));
        for (const n of s.nodes) {
          const p = prevById.get(n.id);
          if (p && p.params !== n.params) liveRef.current?.updateParams(n);
        }
        prevNodes = s.nodes;
      }
    });
    return unsub;
  }, [liveOn, stopLive]);

  const resetView = useCallback(() => setViewport({ x: 0, y: 0, zoom: 1 }), [setViewport]);

  const zoomToFit = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const st = useNodefiStore.getState();
    if (!st.nodes.length) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const rect = el.getBoundingClientRect();
    const ez = effectiveZoom(el);
    const cw = rect.width / ez;
    const ch = rect.height / ez;
    // Warm-mounted but hidden tab (display:none) measures 0 — don't divide by it.
    if (cw < 40 || ch < 40) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of st.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_DIAM);
      maxY = Math.max(maxY, n.y + NODE_DIAM + NODE_LABEL_H);
    }
    const margin = 60;
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    const k = clamp(Math.min((cw - margin) / gw, (ch - margin) / gh), 0.25, 1.5);
    setViewport({
      x: (cw - gw * k) / 2 - minX * k,
      y: (ch - gh * k) / 2 - minY * k,
      zoom: k,
    });
  }, [setViewport]);

  // Load a template patch: resolve its GANTASMO source song against the live
  // library (id first, then title), stamp the Library node, replace the graph
  // (one undo step), and frame it.
  const loadTemplate = useCallback(
    async (tplId: string) => {
      const tpl = NODEFI_TEMPLATES.find((t) => t.id === tplId);
      if (!tpl) return;
      const lib = useLibraryStore.getState();
      if (!lib.entries.length) await lib.load();
      const entry = resolveTemplateSource(tpl, useLibraryStore.getState().entries);
      const nodes = tpl.nodes.map((n) =>
        tpl.sourceKeys.includes(n.key)
          ? {
              ...n,
              title: entry ? (n.title ?? tpl.song) : `${n.title ?? tpl.song} (import needed)`,
              params: { ...(n.params ?? {}), libraryId: entry?.id ?? '' },
            }
          : n,
      );
      useNodefiStore.getState().loadTemplate(nodes, tpl.edges);
      logInfo(
        'nodefi',
        entry
          ? `template "${tpl.name}" loaded — source: ${entry.title} (Ctrl+Z restores the previous graph)`
          : `template "${tpl.name}" loaded — "${tpl.song}" is not in the library yet; import it, then pick it on the Library node`,
      );
      requestAnimationFrame(() => zoomToFit());
    },
    [zoomToFit],
  );

  // Load a saved set — through loadTemplate, so fresh ids are minted and one
  // undo restores the previous graph.
  const loadSavedSet = useCallback(
    (s: SavedNodeSet) => {
      useNodefiStore.getState().loadTemplate(
        s.nodes.map((n) => ({ key: n.id, kind: n.kind, x: n.x, y: n.y, title: n.title, params: n.params })),
        s.edges.map((e) => [e.from, e.fromPort, e.to, e.toPort] as [string, string, string, string]),
      );
      logInfo('nodefi', `set "${s.name}" loaded (Ctrl+Z restores the previous graph)`);
      requestAnimationFrame(() => zoomToFit());
    },
    [zoomToFit],
  );

  // Keyboard: Delete, Ctrl+Z/Y, Ctrl+D, Ctrl+A, Esc, F — arbitrated through
  // the shared key-scope so the EDIT timeline / dock panels keep their keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!ownsKey('nodefi')) return;
      const st = useNodefiStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        st.undo();
      } else if ((mod && key === 'y') || (mod && e.shiftKey && key === 'z')) {
        e.preventDefault();
        st.redo();
      } else if (mod && key === 'd') {
        e.preventDefault();
        if (st.selectedIds.length) st.duplicateNodes(st.selectedIds);
      } else if (mod && key === 'a') {
        e.preventDefault();
        st.selectAll();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selectedEdgeId) {
          e.preventDefault();
          st.removeEdge(st.selectedEdgeId);
        } else if (st.selectedIds.length) {
          e.preventDefault();
          st.removeNodes(st.selectedIds);
        }
      } else if (e.key === 'Escape') {
        st.select(null);
      } else if (!mod && key === 'f') {
        e.preventDefault();
        zoomToFit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomToFit]);

  const edgeEls = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) return null;
      const a = portWorld(from, e.fromPort, 'out');
      const b = portWorld(to, e.toPort, 'in');
      const d = edgePath(a, b);
      const color = nodeDef(from.kind).accent;
      const isSel = e.id === selectedEdgeId;
      // Mod (automation) wires render dashed so signal flow reads at a glance.
      const isMod = nodeDef(from.kind).outputs.find((p) => p.id === e.fromPort)?.type === 'mod';
      return (
        <g key={e.id}>
          {/* faint accent halo + a thin light-grey core, like the reference */}
          <path d={d} fill="none" stroke={color} strokeOpacity={isSel ? 0.5 : 0.22} strokeWidth={isSel ? 7 : isMod ? 4 : 5} />
          <path d={d} fill="none" stroke={isSel ? '#99f6e4' : 'rgba(206,202,220,0.6)'} strokeWidth={isSel ? 2.5 : isMod ? 1.25 : 1.5} strokeDasharray={isMod ? '6 5' : undefined} />
          {/* invisible fat hit path — the parent SVG is pointer-events-none,
              so wires opt back in here to be clickable */}
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={14}
            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            onMouseDown={(ev) => {
              if (ev.button !== 0) return;
              ev.stopPropagation();
              selectEdge(e.id);
            }}
            onDoubleClick={(ev) => {
              ev.stopPropagation();
              removeEdge(e.id);
            }}
            onContextMenu={(ev) => {
              ev.stopPropagation();
              selectEdge(e.id);
              edgeMenu.open(ev, e.id);
            }}
          />
        </g>
      );
    });
  }, [edges, nodes, selectedEdgeId, selectEdge, removeEdge, edgeMenu]);

  const wireEl = useMemo(() => {
    const it = interaction.current;
    if (!it || it.type !== 'wire' || !wireCursor) return null;
    return <path d={edgePath({ x: it.x1, y: it.y1 }, wireCursor)} fill="none" stroke={ACCENT} strokeWidth={2} strokeDasharray="5 4" />;
  }, [wireCursor]);

  const boxEl = useMemo(() => {
    const it = interaction.current;
    if (!it || it.type !== 'box' || !boxCursor) return null;
    const x = Math.min(it.x0, boxCursor.x);
    const y = Math.min(it.y0, boxCursor.y);
    const w = Math.abs(boxCursor.x - it.x0);
    const h = Math.abs(boxCursor.y - it.y0);
    return (
      <div
        className="absolute pointer-events-none border border-teal-300/70 bg-teal-400/10"
        style={{ left: x, top: y, width: w, height: h }}
      />
    );
  }, [boxCursor]);

  const nodeMenuItems = useMemo((): ContextMenuItem[] => {
    const id = nodeMenu.payload;
    if (!id) return [];
    const st = useNodefiStore.getState();
    const ids = st.selectedIds.includes(id) && st.selectedIds.length > 1 ? st.selectedIds : [id];
    const many = ids.length > 1;
    return [
      {
        type: 'item',
        label: many ? `Duplicate ${ids.length} nodes` : 'Duplicate',
        icon: <Copy className="w-3 h-3" />,
        hint: 'Ctrl+D',
        onSelect: () => useNodefiStore.getState().duplicateNodes(ids),
      },
      {
        type: 'item',
        label: many ? 'Disconnect all' : 'Disconnect',
        icon: <Unplug className="w-3 h-3" />,
        onSelect: () => {
          const cur = useNodefiStore.getState();
          const idSet = new Set(ids);
          for (const e of cur.edges.filter((e) => idSet.has(e.from) || idSet.has(e.to))) {
            cur.removeEdge(e.id);
          }
        },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: many ? `Delete ${ids.length} nodes` : 'Delete',
        icon: <Trash2 className="w-3 h-3" />,
        hint: 'Del',
        danger: true,
        onSelect: () => useNodefiStore.getState().removeNodes(ids),
      },
    ];
  }, [nodeMenu.payload]);

  const toolBtn =
    'p-1.5 rounded-full text-zinc-500 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none';

  // Drag-resize either rail. Deltas divide by effectiveZoom (same local-px
  // space as every other pointer interaction here).
  const startRailResize = useCallback((e: React.PointerEvent, which: 'rail' | 'inspector') => {
    if (e.button !== 0) return;
    e.preventDefault();
    const ez = effectiveZoom(canvasRef.current);
    const startX = e.clientX;
    const st = useNodefiStore.getState();
    const startW = which === 'rail' ? st.railWidth : st.inspectorWidth;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / ez;
      if (which === 'rail') useNodefiStore.getState().setRailWidth(startW + dx);
      else useNodefiStore.getState().setInspectorWidth(startW - dx);
    };
    const onUp = () => window.removeEventListener('pointermove', onMove);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, []);

  return (
    <div data-keyscope="nodefi" className="absolute inset-0 flex bg-[#07050a]">
      {/* Node foundry rail — resizable (drag its right edge) and collapsible. */}
      {railOpen ? (
        <div className="relative shrink-0 border-r border-white/5 bg-black/30 backdrop-blur-xl" style={{ width: railWidth }}>
          <NodefiPalette onAdd={onPaletteAdd} onOrbDown={onOrbDown} onLoadTemplate={(id) => void loadTemplate(id)} onLoadSet={loadSavedSet} />
          <button
            type="button"
            onClick={() => setRailOpen(false)}
            title="Collapse the node rail"
            aria-label="Collapse the node rail"
            className="absolute top-2 right-1 z-10 p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
          >
            <ChevronsLeft className="w-3.5 h-3.5" />
          </button>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the node rail"
            title="Drag to resize"
            onPointerDown={(e) => startRailResize(e, 'rail')}
            className="absolute inset-y-0 -right-1 w-2 cursor-col-resize z-10"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRailOpen(true)}
          title="Expand the node rail"
          aria-label="Expand the node rail"
          className="shrink-0 w-6 border-r border-white/5 bg-black/30 backdrop-blur-xl flex flex-col items-center pt-2 gap-2 text-zinc-500 hover:text-white transition-colors"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest" style={{ writingMode: 'vertical-rl' }}>Nodes</span>
        </button>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        onMouseDown={onCanvasDown}
        className="relative flex-1 min-w-0 overflow-hidden"
        style={{
          cursor: 'grab',
          backgroundColor: 'var(--et-canvas, #07050a)',
          backgroundImage: [
            'radial-gradient(circle, rgba(127,127,127,0.16) 1px, transparent 1px)',
            'radial-gradient(1000px 640px at 18% -10%, rgba(45,212,191,0.06), transparent 60%)',
            'radial-gradient(900px 560px at 88% 110%, rgba(139,92,246,0.07), transparent 60%)',
          ].join(', '),
          backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px, 100% 100%, 100% 100%`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px, 0 0, 0 0`,
        }}
      >
        {!nodes.length ? (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[13px] font-mono font-semibold text-zinc-500 text-center leading-relaxed">
              Pull a node out of the rail — or load a live set below it.
              <br />
              Shift+drag box-select · Ctrl+D duplicate · Del delete · F fit
            </span>
          </div>
        ) : null}

        <div
          className="absolute top-0 left-0"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: '0 0' }}
        >
          <svg className="absolute top-0 left-0 overflow-visible pointer-events-none" width={1} height={1}>
            {edgeEls}
            {wireEl}
          </svg>
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              selected={selectedIds.includes(n.id)}
              status={status[n.id] ?? 'idle'}
              previewUrl={previews[n.id] ?? null}
              onHeaderDown={onHeaderDown}
              onPortDown={onPortDown}
              onSelect={onNodeSelect}
              onMenu={onNodeMenu}
            />
          ))}
          {boxEl}
        </div>

        {/* Edge vignette — depth without touching the world layer (themed). */}
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{ boxShadow: 'inset 0 0 120px 30px rgb(var(--et-shade, 0 0 0) / 0.45)' }}
        />

        {/* Floating command dock — replaces the old toolbar row. */}
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 pl-1.5 pr-2 py-1 rounded-full border border-white/10 bg-black/60 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.45),0_0_0_1px_rgba(45,212,191,0.08)]"
        >
          {hasLiveNodes ? (
            <button
              onClick={() => (liveOn ? stopLive() : void goLive())}
              disabled={running}
              title={liveOn ? 'Stop the live performance' : 'Perform the live subgraph in real time (stems + Live FX + LFOs — no AI models)'}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-mono font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                liveOn
                  ? 'border-rose-400/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30'
                  : 'border-teal-400/50 bg-teal-500/15 text-teal-100 hover:bg-teal-500/25'
              }`}
            >
              {liveOn ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {liveOn ? 'Stop Live' : 'LIVE'}
            </button>
          ) : null}
          {running ? (
            <button
              onClick={stop}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-rose-500/50 bg-rose-500/15 text-rose-200 text-[10px] font-mono uppercase tracking-wider hover:bg-rose-500/25 transition-colors"
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!nodes.length || liveOn}
              title="Render the graph offline (AI + effect nodes)"
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-teal-400/50 bg-teal-500/15 text-teal-100 text-[10px] font-mono uppercase tracking-wider hover:bg-teal-500/25 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <Play className="w-3 h-3" /> Run
            </button>
          )}
          <div className="w-px h-4 bg-white/10 mx-0.5" />
          <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" className={toolBtn}>
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" className={toolBtn}>
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-white/10 mx-0.5" />
          <button onClick={zoomToFit} disabled={!nodes.length} title="Zoom to fit (F)" aria-label="Zoom to fit" className={toolBtn}>
            <Scan className="w-3.5 h-3.5" />
          </button>
          <button onClick={resetView} title="Reset view" aria-label="Reset view" className={toolBtn}>
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-white/10 mx-0.5" />
          <button
            onClick={() => {
              if (nodes.length) clearGraph();
            }}
            disabled={!nodes.length}
            title="Clear graph"
            aria-label="Clear graph"
            className="p-1.5 rounded-full text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Inspector — resizable (drag its left edge) and collapsible. */}
      {inspectorOpen ? (
        <div className="relative shrink-0 border-l border-white/5 bg-black/30 backdrop-blur-xl" style={{ width: inspectorWidth }}>
          <NodefiInspector />
          <button
            type="button"
            onClick={() => setInspectorOpen(false)}
            title="Collapse the inspector"
            aria-label="Collapse the inspector"
            className="absolute top-2 left-1 z-10 p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
          >
            <ChevronsRight className="w-3.5 h-3.5" />
          </button>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the inspector"
            title="Drag to resize"
            onPointerDown={(e) => startRailResize(e, 'inspector')}
            className="absolute inset-y-0 -left-1 w-2 cursor-col-resize z-10"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setInspectorOpen(true)}
          title="Expand the inspector"
          aria-label="Expand the inspector"
          className="shrink-0 w-6 border-l border-white/5 bg-black/30 backdrop-blur-xl flex flex-col items-center pt-2 gap-2 text-zinc-500 hover:text-white transition-colors"
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest" style={{ writingMode: 'vertical-rl' }}>Inspector</span>
        </button>
      )}

      {/* Goo drag overlay — the strand from the rail well to the pointer, then
          the free ghost orb once it snaps. Fixed + local-px coords (see above). */}
      {gooDrag ? (() => {
        const def = nodeDef(gooDrag.kind);
        const { origin, cur, overCanvas } = gooDrag;
        const dx = cur.x - origin.x;
        const dy = cur.y - origin.y;
        const dist = Math.hypot(dx, dy);
        const snapped = dist > GOO_SNAP;
        const t = Math.min(1, dist / GOO_SNAP);
        const blobs: React.ReactElement[] = [];
        if (!snapped) {
          const N = 7;
          for (let i = 0; i <= N; i += 1) {
            const f = i / N;
            const taper = (16 - 11 * f) * (1 - 0.55 * t);
            const r = Math.max(2.5, taper) + (i === N ? 6 : 0);
            blobs.push(<circle key={i} cx={origin.x + dx * f} cy={origin.y + dy * f} r={r} />);
          }
        }
        return (
          <div className="fixed inset-0 z-50 pointer-events-none">
            <svg className="w-full h-full">
              <defs>
                <filter id="nodefi-goo">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
                  <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -12" />
                </filter>
              </defs>
              {!snapped ? (
                <g filter="url(#nodefi-goo)" fill={def.accent} opacity={0.5}>
                  {blobs}
                </g>
              ) : null}
              {/* the well keeps a lit ring where the orb was pulled from */}
              <circle cx={origin.x} cy={origin.y} r={snapped ? 7 : 10} fill="none" stroke={def.accent} strokeOpacity={0.5} strokeWidth={2} />
              {/* ghost orb under the pointer */}
              <circle
                cx={cur.x}
                cy={cur.y}
                r={22}
                fill="#12101c"
                fillOpacity={0.92}
                stroke={def.accent}
                strokeWidth={overCanvas ? 2.5 : 1.5}
                strokeOpacity={overCanvas ? 1 : 0.6}
              />
              <circle cx={cur.x} cy={cur.y} r={10} fill={def.accent} fillOpacity={0.25} />
            </svg>
            <span
              className="fixed text-[10px] font-mono text-zinc-200 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
              style={{ left: cur.x + 18, top: cur.y + 18 }}
            >
              {def.label}
            </span>
          </div>
        );
      })() : null}

      <ContextMenu
        position={nodeMenu.position}
        onClose={nodeMenu.close}
        items={nodeMenuItems}
      />
      <ContextMenu
        position={edgeMenu.position}
        onClose={edgeMenu.close}
        title="Wire"
        items={[
          {
            type: 'item',
            label: 'Delete wire',
            icon: <Trash2 className="w-3 h-3" />,
            hint: 'Del',
            danger: true,
            onSelect: () => {
              if (edgeMenu.payload) removeEdge(edgeMenu.payload);
            },
          },
        ]}
      />
    </div>
  );
}
