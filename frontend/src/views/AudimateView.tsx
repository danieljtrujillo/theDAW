/**
 * Audimate — a node-graph editor for building generation pipelines. A dark,
 * pannable/zoomable canvas of node cards wired by glowing bezier edges, with a
 * left palette and a right inspector. Run drives the graph through the existing
 * generate / effect / library actions (see lib/audimateRunner.ts).
 *
 * Hand-rolled canvas (no node-editor dependency): CSS-transform world layer,
 * SVG edges, pointer-driven pan / node-drag / drag-to-connect.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, Crosshair, Loader2, AlertCircle, CheckCircle2, Volume2, Pause } from 'lucide-react';
import { useAudimateStore } from '../state/audimateStore';
import { runGraph, type RunController } from '../lib/audimateRunner';
import { nodeDef, type GraphNode, type NodeKind, type NodeRunStatus } from '../lib/audimateTypes';
import { AudimatePalette } from '../components/audimate/AudimatePalette';
import { AudimateInspector } from '../components/audimate/AudimateInspector';
import { logInfo } from '../state/logStore';

const NODE_W = 196;
const HEADER_H = 28;
const PORT_GAP = 24;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface XY {
  x: number;
  y: number;
}

function portWorld(node: GraphNode, portId: string, dir: 'in' | 'out'): XY {
  const def = nodeDef(node.kind);
  const ports = dir === 'out' ? def.outputs : def.inputs;
  const idx = Math.max(0, ports.findIndex((p) => p.id === portId));
  return {
    x: dir === 'out' ? node.x + NODE_W : node.x,
    y: node.y + HEADER_H + idx * PORT_GAP + PORT_GAP / 2,
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
  onSelect: (id: string) => void;
}

function NodeCard({ node, selected, status, previewUrl, onHeaderDown, onPortDown, onSelect }: NodeCardProps): React.ReactElement {
  const def = nodeDef(node.kind);
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  const portsH = rows * PORT_GAP;
  const glow = selected ? `0 0 0 1px ${def.accent}, 0 0 18px ${def.accent}66` : status === 'running' ? `0 0 16px ${def.accent}55` : 'none';

  return (
    <div
      className="absolute rounded-lg select-none"
      style={{
        left: node.x,
        top: node.y,
        width: NODE_W,
        background: '#141020',
        border: `1px solid ${selected ? def.accent : '#2a2440'}`,
        boxShadow: glow,
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
    >
      {/* Header (drag handle) */}
      <div
        className="flex items-center gap-1.5 px-2 cursor-grab active:cursor-grabbing"
        style={{ height: HEADER_H, borderBottom: '1px solid #221d36' }}
        onMouseDown={(e) => onHeaderDown(e, node.id)}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: def.accent }} />
        <span className="text-[10px] font-mono text-zinc-200 truncate flex-1">{node.title || def.label}</span>
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: STATUS_COLOR[status], boxShadow: status === 'running' ? `0 0 6px ${STATUS_COLOR[status]}` : 'none' }}
        />
      </div>

      {/* Ports */}
      <div className="relative" style={{ height: portsH }}>
        {def.inputs.map((p, i) => (
          <div key={p.id} className="absolute left-0 flex items-center gap-1" style={{ top: i * PORT_GAP, height: PORT_GAP }}>
            <span
              data-node={node.id}
              data-port-in={p.id}
              className="rounded-full cursor-crosshair"
              style={{ width: 12, height: 12, marginLeft: -6, border: `2px solid ${def.accent}`, background: '#0b0912' }}
            />
            <span className="text-[9px] font-mono text-zinc-500 pl-1">{p.label}</span>
          </div>
        ))}
        {def.outputs.map((p, i) => (
          <div key={p.id} className="absolute right-0 flex items-center gap-1 flex-row-reverse" style={{ top: i * PORT_GAP, height: PORT_GAP }}>
            <span
              data-node={node.id}
              data-port-out={p.id}
              onMouseDown={(e) => onPortDown(e, node.id, p.id)}
              className="rounded-full cursor-crosshair"
              style={{ width: 12, height: 12, marginRight: -6, border: `2px solid ${def.accent}`, background: '#0b0912' }}
            />
            <span className="text-[9px] font-mono text-zinc-500 pr-1">{p.label}</span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-2 py-1 border-t border-[#221d36] min-h-6">
        {status === 'running' ? <Loader2 className="w-3 h-3 text-amber-400 animate-spin" /> : null}
        {status === 'done' ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : null}
        {status === 'error' ? <AlertCircle className="w-3 h-3 text-rose-400" /> : null}
        {previewUrl ? <PreviewButton url={previewUrl} /> : <span className="text-[9px] font-mono text-zinc-600">{status}</span>}
      </div>
    </div>
  );
}

export function AudimateView(): React.ReactElement {
  const nodes = useAudimateStore((s) => s.nodes);
  const edges = useAudimateStore((s) => s.edges);
  const viewport = useAudimateStore((s) => s.viewport);
  const selectedId = useAudimateStore((s) => s.selectedId);
  const status = useAudimateStore((s) => s.status);
  const previews = useAudimateStore((s) => s.previews);
  const running = useAudimateStore((s) => s.running);

  const addNode = useAudimateStore((s) => s.addNode);
  const moveNode = useAudimateStore((s) => s.moveNode);
  const connect = useAudimateStore((s) => s.connect);
  const setViewport = useAudimateStore((s) => s.setViewport);
  const select = useAudimateStore((s) => s.select);
  const clearGraph = useAudimateStore((s) => s.clearGraph);
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
    | { type: 'drag'; id: string; offX: number; offY: number }
    | { type: 'wire'; from: string; fromPort: string; x1: number; y1: number }
    | null
  >(null);
  const [wireCursor, setWireCursor] = useState<XY | null>(null);

  const screenToWorld = useCallback((clientX: number, clientY: number): XY => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const vp = vpRef.current;
    const rx = clientX - (rect?.left ?? 0);
    const ry = clientY - (rect?.top ?? 0);
    return { x: (rx - vp.x) / vp.zoom, y: (ry - vp.y) / vp.zoom };
  }, []);

  // Global pointer handling for pan / drag / wire.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const it = interaction.current;
      if (!it) return;
      if (it.type === 'pan') {
        setViewport({ ...vpRef.current, x: it.ox + (e.clientX - it.sx), y: it.oy + (e.clientY - it.sy) });
      } else if (it.type === 'drag') {
        const w = screenToWorld(e.clientX, e.clientY);
        moveNode(it.id, w.x - it.offX, w.y - it.offY);
      } else if (it.type === 'wire') {
        setWireCursor(screenToWorld(e.clientX, e.clientY));
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
      }
      interaction.current = null;
      setWireCursor(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [connect, moveNode, screenToWorld, setViewport]);

  // Non-passive wheel zoom (around cursor).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
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
    // Background press: pan + deselect.
    const vp = vpRef.current;
    interaction.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: vp.x, oy: vp.y };
    select(null);
  };

  const onHeaderDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      const node = useAudimateStore.getState().nodes.find((n) => n.id === id);
      if (!node) return;
      const w = screenToWorld(e.clientX, e.clientY);
      interaction.current = { type: 'drag', id, offX: w.x - node.x, offY: w.y - node.y };
      select(id);
    },
    [screenToWorld, select],
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
      const rect = canvasRef.current?.getBoundingClientRect();
      const vp = vpRef.current;
      const cx = ((rect?.width ?? 800) / 2 - vp.x) / vp.zoom;
      const cy = ((rect?.height ?? 500) / 2 - vp.y) / vp.zoom;
      const jitter = (useAudimateStore.getState().nodes.length % 6) * 24;
      addNode(kind, cx - NODE_W / 2 + jitter, cy - 40 + jitter);
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

  const edgeEls = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) return null;
      const a = portWorld(from, e.fromPort, 'out');
      const b = portWorld(to, e.toPort, 'in');
      const color = nodeDef(from.kind).accent;
      return (
        <g key={e.id}>
          <path d={edgePath(a, b)} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={6} />
          <path d={edgePath(a, b)} fill="none" stroke={color} strokeWidth={2} />
        </g>
      );
    });
  }, [edges, nodes]);

  const wireEl = useMemo(() => {
    const it = interaction.current;
    if (!it || it.type !== 'wire' || !wireCursor) return null;
    return <path d={edgePath({ x: it.x1, y: it.y1 }, wireCursor)} fill="none" stroke="#a855f7" strokeWidth={2} strokeDasharray="5 4" />;
  }, [wireCursor]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#07050a]">
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
        <button
          onClick={resetView}
          title="Reset view"
          aria-label="Reset view"
          className="p-1 rounded border border-white/5 text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
        >
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
              <span className="text-[11px] font-mono text-zinc-600">Add nodes from the palette, wire them, then Run.</span>
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
                selected={selectedId === n.id}
                status={status[n.id] ?? 'idle'}
                previewUrl={previews[n.id] ?? null}
                onHeaderDown={onHeaderDown}
                onPortDown={onPortDown}
                onSelect={select}
              />
            ))}
          </div>
        </div>

        {/* Inspector */}
        <div className="w-64 shrink-0 border-l border-white/5 bg-black/20">
          <AudimateInspector />
        </div>
      </div>
    </div>
  );
}
