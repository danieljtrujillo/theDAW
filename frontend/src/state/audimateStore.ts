/**
 * Audimate graph store. The nodes / edges / viewport are persisted so a graph
 * survives reloads; run state (per-node status, preview object URLs, running
 * flag) is transient and reset on load.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nodeDef, type GraphEdge, type GraphNode, type NodeKind, type NodeRunStatus } from '../lib/audimateTypes';

let uidCounter = 0;
const uid = (p: string): string => `${p}_${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface AudimateState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: Viewport;
  selectedId: string | null;

  // transient run state (not persisted)
  running: boolean;
  status: Record<string, NodeRunStatus>;
  statusMsg: Record<string, string>;
  previews: Record<string, string | null>;

  addNode: (kind: NodeKind, x: number, y: number) => string;
  moveNode: (id: string, x: number, y: number) => void;
  removeNode: (id: string) => void;
  updateParam: (id: string, key: string, value: string | number) => void;
  setParams: (id: string, params: Record<string, string | number>) => void;
  setTitle: (id: string, title: string) => void;

  connect: (from: string, fromPort: string, to: string, toPort: string) => void;
  removeEdge: (edgeId: string) => void;

  setViewport: (v: Viewport) => void;
  select: (id: string | null) => void;
  clearGraph: () => void;

  setRunning: (v: boolean) => void;
  setStatus: (id: string, status: NodeRunStatus, msg?: string) => void;
  setPreview: (id: string, blob: Blob | null) => void;
  resetRun: () => void;
}

export const useAudimateStore = create<AudimateState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedId: null,

      running: false,
      status: {},
      statusMsg: {},
      previews: {},

      addNode: (kind, x, y) => {
        const def = nodeDef(kind);
        const id = uid(kind);
        const node: GraphNode = {
          id,
          kind,
          x,
          y,
          params: { ...def.defaults },
        };
        set((s) => ({ nodes: [...s.nodes, node], selectedId: id }));
        return id;
      },

      moveNode: (id, x, y) =>
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) })),

      removeNode: (id) => {
        const prev = get().previews[id];
        if (prev) URL.revokeObjectURL(prev);
        set((s) => {
          const previews = { ...s.previews };
          delete previews[id];
          const status = { ...s.status };
          delete status[id];
          return {
            nodes: s.nodes.filter((n) => n.id !== id),
            edges: s.edges.filter((e) => e.from !== id && e.to !== id),
            selectedId: s.selectedId === id ? null : s.selectedId,
            previews,
            status,
          };
        });
      },

      updateParam: (id, key, value) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n)),
        })),

      setParams: (id, params) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, params } : n)),
        })),

      setTitle: (id, title) =>
        set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, title } : n)) })),

      connect: (from, fromPort, to, toPort) => {
        if (from === to) return;
        const s = get();
        const target = s.nodes.find((n) => n.id === to);
        if (!target) return;
        const port = nodeDef(target.kind).inputs.find((p) => p.id === toPort);
        if (!port) return;
        // Duplicate edge? ignore.
        if (s.edges.some((e) => e.from === from && e.fromPort === fromPort && e.to === to && e.toPort === toPort)) {
          return;
        }
        set((st) => {
          // A non-variadic input holds a single edge — replace any existing one.
          const edges = port.variadic
            ? st.edges
            : st.edges.filter((e) => !(e.to === to && e.toPort === toPort));
          const edge: GraphEdge = { id: uid('e'), from, fromPort, to, toPort };
          return { edges: [...edges, edge] };
        });
      },

      removeEdge: (edgeId) => set((s) => ({ edges: s.edges.filter((e) => e.id !== edgeId) })),

      setViewport: (v) => set({ viewport: v }),
      select: (id) => set({ selectedId: id }),

      clearGraph: () => {
        for (const url of Object.values(get().previews)) if (url) URL.revokeObjectURL(url);
        set({ nodes: [], edges: [], selectedId: null, status: {}, statusMsg: {}, previews: {} });
      },

      setRunning: (v) => set({ running: v }),

      setStatus: (id, status, msg) =>
        set((s) => ({
          status: { ...s.status, [id]: status },
          statusMsg: msg === undefined ? s.statusMsg : { ...s.statusMsg, [id]: msg },
        })),

      setPreview: (id, blob) =>
        set((s) => {
          const old = s.previews[id];
          if (old) URL.revokeObjectURL(old);
          return { previews: { ...s.previews, [id]: blob ? URL.createObjectURL(blob) : null } };
        }),

      resetRun: () =>
        set((s) => {
          const status: Record<string, NodeRunStatus> = {};
          for (const n of s.nodes) status[n.id] = 'idle';
          return { status, statusMsg: {} };
        }),
    }),
    {
      name: 'thedaw-audimate-v1',
      version: 1,
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges, viewport: s.viewport }),
    },
  ),
);
