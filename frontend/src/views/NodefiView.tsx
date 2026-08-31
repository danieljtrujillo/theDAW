/**
 * Audimate — a node-graph editor for building generation pipelines. A dark,
 * pannable/zoomable canvas of node cards wired by glowing bezier edges, with a
 * left palette and a right inspector. Run drives the graph through the existing
 * generate / effect / library actions (see lib/audimateRunner.ts).
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
import { Play, Square, Trash2, Crosshair, Loader2, AlertCircle, CheckCircle2, Volume2, Pause, Undo2, Redo2, Scan, Copy, Unplug } from 'lucide-react';
import { useAudimateStore } from '../state/audimateStore';
import { runGraph, type RunController } from '../lib/audimateRunner';
import { nodeDef, type GraphNode, type NodeKind, type NodeRunStatus } from '../lib/audimateTypes';
import { AudimatePalette } from '../components/audimate/AudimatePalette';
import { AudimateInspector } from '../components/audimate/AudimateInspector';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { effectiveZoom } from '../lib/canvasScale';
import { ownsKey } from '../lib/keyScope';
import { logInfo } from '../state/logStore';

// Circular glossy nodes (see NODE_EDITOR reference): a fixed-diameter disc with
// ports on the rim and the label beneath. Edge endpoints land on the rim.
const NODE_DIAM = 88;
// Vertical allowance under the disc for the label row when fitting the view.
const NODE_LABEL_H = 34;

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
      <span className="mt-1 max-w-35 truncate text-center text-[10px] font-mono leading-tight text-zinc-300">
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

export function AudimateView(): React.ReactElement {
  const nodes = useAudimateStore((s) => s.nodes);
  const edges = useAudimateStore((s) => s.edges);
  const viewport = useAudimateStore((s) => s.viewport);
  const selectedIds = useAudimateStore((s) => s.selectedIds);
  const selectedEdgeId = useAudimateStore((s) => s.selectedEdgeId);
  const status = useAudimateStore((s) => s.status);
  const previews = useAudimateStore((s) => s.previews);
  const running = useAudimateStore((s) => s.running);
  const canUndo = useAudimateStore((s) => s.past.length > 0);
  const canRedo = useAudimateStore((s) => s.future.length > 0);

  const addNode = useAudimateStore((s) => s.addNode);
  const moveNodesBy = useAudimateStore((s) => s.moveNodesBy);
  const connect = useAudimateStore((s) => s.connect);
  const removeEdge = useAudimateStore((s) => s.removeEdge);
  const setViewport = useAudimateStore((s) => s.setViewport);
  const select = useAudimateStore((s) => s.select);
  const setSelection = useAudimateStore((s) => s.setSelection);
  const toggleInSelection = useAudimateStore((s) => s.toggleInSelection);
  const selectEdge = useAudimateStore((s) => s.selectEdge);
  const clearGraph = useAudimateStore((s) => s.clearGraph);
  const undo = useAudimateStore((s) => s.undo);
  const redo = useAudimateStore((s) => s.redo);
  const setRunning = useAudimateStore((s) => s.setRunning);
  const setStatus = useAudimateStore((s) => s.setStatus);
  const setPreview = useAudimateStore((s) => s.setPreview);
  const resetRun = useAudimateStore((s) => s.resetRun);

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
        const hit = useAudimateStore
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
      const st = useAudimateStore.getState();
      if (!st.selectedIds.includes(id)) select(id);
      const ids = useAudimateStore.getState().selectedIds;
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
      const st = useAudimateStore.getState();
      if (!st.selectedIds.includes(id)) select(id);
      nodeMenu.open(e, id);
    },
    [nodeMenu, select],
  );

  const onPortDown = useCallback((e: React.MouseEvent, id: string, portId: string) => {
    e.stopPropagation();
    const node = useAudimateStore.getState().nodes.find((n) => n.id === id);
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
      const jitter = (useAudimateStore.getState().nodes.length % 6) * 24;
      addNode(kind, cx - NODE_DIAM / 2 + jitter, cy - NODE_DIAM / 2 + jitter);
    },
    [addNode],
  );

  const run = useCallback(() => {
    const st = useAudimateStore.getState();
    if (!st.nodes.length || st.running) return;
    resetRun();
    setRunning(true);
    logInfo('audimate', `running ${st.nodes.length} node(s)`);
    const ctrl = runGraph(st.nodes, st.edges, {
      onStatus: (id, s, msg) => setStatus(id, s, msg),
      onOutput: (id, blob) => setPreview(id, blob),
      onLog: (m) => logInfo('audimate', m),
    });
    controllerRef.current = ctrl;
    ctrl.promise
      .then(() => logInfo('audimate', 'run complete'))
      .catch((err) => {
        if (err instanceof Error && err.message !== 'cancelled') logInfo('audimate', `run stopped — ${err.message}`);
      })
      .finally(() => {
        setRunning(false);
        controllerRef.current = null;
      });
  }, [resetRun, setPreview, setRunning, setStatus]);

  const stop = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);

  const resetView = useCallback(() => setViewport({ x: 0, y: 0, zoom: 1 }), [setViewport]);

  const zoomToFit = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const st = useAudimateStore.getState();
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

  // Keyboard: Delete, Ctrl+Z/Y, Ctrl+D, Ctrl+A, Esc, F — arbitrated through
  // the shared key-scope so the EDIT timeline / dock panels keep their keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!ownsKey('audimate')) return;
      const st = useAudimateStore.getState();
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
      return (
        <g key={e.id}>
          {/* faint accent halo + a thin light-grey core, like the reference */}
          <path d={d} fill="none" stroke={color} strokeOpacity={isSel ? 0.5 : 0.22} strokeWidth={isSel ? 7 : 5} />
          <path d={d} fill="none" stroke={isSel ? '#e9d5ff' : 'rgba(206,202,220,0.6)'} strokeWidth={isSel ? 2.5 : 1.5} />
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
    return <path d={edgePath({ x: it.x1, y: it.y1 }, wireCursor)} fill="none" stroke="#a855f7" strokeWidth={2} strokeDasharray="5 4" />;
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
        className="absolute pointer-events-none border border-purple-400/70 bg-purple-500/10"
        style={{ left: x, top: y, width: w, height: h }}
      />
    );
  }, [boxCursor]);

  const nodeMenuItems = useMemo((): ContextMenuItem[] => {
    const id = nodeMenu.payload;
    if (!id) return [];
    const st = useAudimateStore.getState();
    const ids = st.selectedIds.includes(id) && st.selectedIds.length > 1 ? st.selectedIds : [id];
    const many = ids.length > 1;
    return [
      {
        type: 'item',
        label: many ? `Duplicate ${ids.length} nodes` : 'Duplicate',
        icon: <Copy className="w-3 h-3" />,
        hint: 'Ctrl+D',
        onSelect: () => useAudimateStore.getState().duplicateNodes(ids),
      },
      {
        type: 'item',
        label: many ? 'Disconnect all' : 'Disconnect',
        icon: <Unplug className="w-3 h-3" />,
        onSelect: () => {
          const cur = useAudimateStore.getState();
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
        onSelect: () => useAudimateStore.getState().removeNodes(ids),
      },
    ];
  }, [nodeMenu.payload]);

  const toolBtn =
    'p-1 rounded border border-white/5 text-zinc-500 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div data-keyscope="audimate" className="absolute inset-0 flex flex-col bg-[#07050a]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-black/30 shrink-0">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Audimate</span>
        <div className="flex-1" />
        {running ? (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-rose-500/50 bg-rose-500/15 text-rose-200 text-[10px] font-mono uppercase tracking-wider hover:bg-rose-500/25 transition-colors"
          >
            <Square className="w-3 h-3" /> Stop
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!nodes.length}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-purple-500/50 bg-purple-500/15 text-purple-100 text-[10px] font-mono uppercase tracking-wider hover:bg-purple-500/25 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <Play className="w-3 h-3" /> Run
          </button>
        )}
        <div className="w-px h-4 bg-white/10" />
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" className={toolBtn}>
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" className={toolBtn}>
          <Redo2 className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button onClick={zoomToFit} disabled={!nodes.length} title="Zoom to fit (F)" aria-label="Zoom to fit" className={toolBtn}>
          <Scan className="w-3.5 h-3.5" />
        </button>
        <button onClick={resetView} title="Reset view" aria-label="Reset view" className={toolBtn}>
          <Crosshair className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => {
            if (nodes.length) clearGraph();
          }}
          disabled={!nodes.length}
          title="Clear graph"
          aria-label="Clear graph"
          className="p-1 rounded border border-white/5 text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Palette */}
        <div className="w-40 shrink-0 border-r border-white/5 bg-black/20">
          <AudimatePalette onAdd={spawn} />
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          onMouseDown={onCanvasDown}
          className="relative flex-1 min-w-0 overflow-hidden"
          style={{
            cursor: 'grab',
            backgroundColor: '#07050a',
            backgroundImage:
              'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        >
          {!nodes.length ? (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <span className="text-[11px] font-mono text-zinc-600 text-center leading-relaxed">
                Add nodes from the palette, wire them, then Run.
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
        </div>

        {/* Inspector */}
        <div className="w-64 shrink-0 border-l border-white/5 bg-black/20">
          <AudimateInspector />
        </div>
      </div>

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
