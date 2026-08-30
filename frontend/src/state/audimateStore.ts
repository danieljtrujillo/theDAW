/**
 * Audimate graph store. The nodes / edges / viewport are persisted so a graph
 * survives reloads; run state (per-node status, preview object URLs, running
 * flag) is transient and reset on load.
 *
 * Undo/redo mirrors surfaceLayoutStore's middleware: `set` is wrapped so any
 * action that changes `nodes` or `edges` snapshots the PREVIOUS document into
 * `past` (coalescing rapid drags into one step) and clears `future`. History is
 * session-only — never persisted.
 */
import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { EFFECT_DEFAULTS } from './effectChainStore';
import { nodeDef, type GraphEdge, type GraphNode, type NodeKind, type NodeRunStatus } from '../lib/audimateTypes';

let uidCounter = 0;
const uid = (p: string): string => `${p}_${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The undoable document — exactly what `past`/`future` snapshot. */
interface GraphDoc {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Effect nodes must carry their chosen effect's numeric params from birth —
 *  the runner serializes `node.params` straight into `/api/studio/process`,
 *  and the backend 400s on any missing key. (The inspector only seeds them
 *  when the user CHANGES the effect.) */
function seedParams(kind: NodeKind, defaults: Record<string, string | number>): Record<string, string | number> {
  if (kind !== 'effect') return { ...defaults };
  const effect = String(defaults.effect || 'mastering_chain');
  return { ...(EFFECT_DEFAULTS[effect] ?? {}), ...defaults };
}

interface AudimateState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: Viewport;
  /** Primary selection — drives the inspector. Always a member of selectedIds. */
  selectedId: string | null;
  /** Full multi-selection (click, ctrl-click, marquee). */
  selectedIds: string[];
  /** A selected wire (mutually exclusive with node selection for Delete). */
  selectedEdgeId: string | null;

  // session-only undo/redo (injected by the history middleware)
  past: GraphDoc[];
  future: GraphDoc[];

  // transient run state (not persisted)
  running: boolean;
  status: Record<string, NodeRunStatus>;
  statusMsg: Record<string, string>;
  previews: Record<string, string | null>;

  addNode: (kind: NodeKind, x: number, y: number) => string;
  moveNode: (id: string, x: number, y: number) => void;
  /** Translate every node in `ids` by the same delta (multi-drag / arrow keys). */
  moveNodesBy: (ids: string[], dx: number, dy: number) => void;
  removeNode: (id: string) => void;
  removeNodes: (ids: string[]) => void;
  /** Clone the given nodes (offset), remapping edges whose BOTH ends are cloned. */
  duplicateNodes: (ids: string[]) => void;
  updateParam: (id: string, key: string, value: string | number) => void;
  setParams: (id: string, params: Record<string, string | number>) => void;
  setTitle: (id: string, title: string) => void;

  connect: (from: string, fromPort: string, to: string, toPort: string) => void;
  removeEdge: (edgeId: string) => void;

  setViewport: (v: Viewport) => void;
  select: (id: string | null) => void;
  setSelection: (ids: string[]) => void;
  toggleInSelection: (id: string) => void;
  selectAll: () => void;
  selectEdge: (id: string | null) => void;
  clearGraph: () => void;

  undo: () => void;
  redo: () => void;

  setRunning: (v: boolean) => void;
  setStatus: (id: string, status: NodeRunStatus, msg?: string) => void;
  setPreview: (id: string, blob: Blob | null) => void;
  resetRun: () => void;
}

/* ── undo/redo history middleware ─────────────────────────────────────────── */
const HISTORY_LIMIT = 60;
// Consecutive document changes closer together than this collapse into ONE
// undo step, so a continuous node drag (many moveNode calls) is one step.
const COALESCE_MS = 350;

type BaseStore = Omit<AudimateState, 'past' | 'future' | 'undo' | 'redo'>;
type AnySet = (partial: unknown, replace?: boolean) => void;
type AudimatePersist = [['zustand/persist', { nodes: GraphNode[]; edges: GraphEdge[]; viewport: Viewport }]];

const withHistory =
  (config: (set: AnySet, get: () => AudimateState, api: unknown) => BaseStore): StateCreator<AudimateState, [], AudimatePersist> =>
  (set, get, api) => {
    const rawSet = set as unknown as AnySet;
    let lastPush = 0;
    const recordingSet: AnySet = (partial, replace) => {
      const before = get();
      rawSet(partial, replace);
      const after = get();
      if (after.nodes !== before.nodes || after.edges !== before.edges) {
        const now = Date.now();
        if (now - lastPush > COALESCE_MS) {
          rawSet({
            past: [...get().past, { nodes: before.nodes, edges: before.edges }].slice(-HISTORY_LIMIT),
            future: [],
          });
        }
        lastPush = now;
      }
    };
    /** Restoring a snapshot must drop selection/edge ids that no longer exist. */
    const applyDoc = (doc: GraphDoc, s: AudimateState) => {
      const nodeIds = new Set(doc.nodes.map((n) => n.id));
      const edgeIds = new Set(doc.edges.map((e) => e.id));
      const selectedIds = s.selectedIds.filter((id) => nodeIds.has(id));
      return {
        nodes: doc.nodes,
        edges: doc.edges,
        selectedIds,
        selectedId: s.selectedId && nodeIds.has(s.selectedId) ? s.selectedId : (selectedIds[0] ?? null),
        selectedEdgeId: s.selectedEdgeId && edgeIds.has(s.selectedEdgeId) ? s.selectedEdgeId : null,
      };
    };
    return {
      ...config(recordingSet, get, api),
      past: [],
      future: [],
      undo: () => {
        const s = get();
        if (!s.past.length) return;
        const doc = s.past[s.past.length - 1];
        rawSet({
          ...applyDoc(doc, s),
          past: s.past.slice(0, -1),
          future: [{ nodes: s.nodes, edges: s.edges }, ...s.future].slice(0, HISTORY_LIMIT),
        });
      },
      redo: () => {
        const s = get();
        if (!s.future.length) return;
        const doc = s.future[0];
        rawSet({
          ...applyDoc(doc, s),
          past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
        });
      },
    };
  };

export const useAudimateStore = create<AudimateState>()(
  persist(
    withHistory((set, get) => ({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedId: null,
      selectedIds: [],
      selectedEdgeId: null,

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
          params: seedParams(kind, def.defaults),
        };
        set({
          nodes: [...get().nodes, node],
          selectedId: id,
          selectedIds: [id],
          selectedEdgeId: null,
        });
        return id;
      },

      moveNode: (id, x, y) =>
        set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }),

      moveNodesBy: (ids, dx, dy) => {
        if (!ids.length || (dx === 0 && dy === 0)) return;
        const idSet = new Set(ids);
        set({ nodes: get().nodes.map((n) => (idSet.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) });
      },

      removeNode: (id) => get().removeNodes([id]),

      removeNodes: (ids) => {
        if (!ids.length) return;
        const idSet = new Set(ids);
        const s = get();
        const previews = { ...s.previews };
        const status = { ...s.status };
        for (const id of ids) {
          const prev = previews[id];
          if (prev) URL.revokeObjectURL(prev);
          delete previews[id];
          delete status[id];
        }
        const selectedIds = s.selectedIds.filter((sid) => !idSet.has(sid));
        set({
          nodes: s.nodes.filter((n) => !idSet.has(n.id)),
          edges: s.edges.filter((e) => !idSet.has(e.from) && !idSet.has(e.to)),
          selectedIds,
          selectedId: s.selectedId && idSet.has(s.selectedId) ? (selectedIds[0] ?? null) : s.selectedId,
          previews,
          status,
        });
      },

      duplicateNodes: (ids) => {
        const s = get();
        const originals = s.nodes.filter((n) => ids.includes(n.id));
        if (!originals.length) return;
        const OFFSET = 28;
        const idMap = new Map<string, string>();
        const clones: GraphNode[] = originals.map((n) => {
          const nid = uid(n.kind);
          idMap.set(n.id, nid);
          return { ...n, id: nid, x: n.x + OFFSET, y: n.y + OFFSET, params: { ...n.params } };
        });
        // Wires internal to the duplicated set come along; wires to the outside don't.
        const cloneEdges: GraphEdge[] = s.edges
          .filter((e) => idMap.has(e.from) && idMap.has(e.to))
          .map((e) => ({ ...e, id: uid('e'), from: idMap.get(e.from)!, to: idMap.get(e.to)! }));
        const cloneIds = clones.map((c) => c.id);
        set({
          nodes: [...s.nodes, ...clones],
          edges: [...s.edges, ...cloneEdges],
          selectedIds: cloneIds,
          selectedId: cloneIds[0] ?? null,
          selectedEdgeId: null,
        });
      },

      updateParam: (id, key, value) =>
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n)),
        }),

      setParams: (id, params) =>
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, params } : n)),
        }),

      setTitle: (id, title) =>
        set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, title } : n)) }),

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
        // A non-variadic input holds a single edge — replace any existing one.
        const edges = port.variadic
          ? s.edges
          : s.edges.filter((e) => !(e.to === to && e.toPort === toPort));
        const edge: GraphEdge = { id: uid('e'), from, fromPort, to, toPort };
        set({ edges: [...edges, edge] });
      },

      removeEdge: (edgeId) =>
        set({
          edges: get().edges.filter((e) => e.id !== edgeId),
          selectedEdgeId: get().selectedEdgeId === edgeId ? null : get().selectedEdgeId,
        }),

      setViewport: (v) => set({ viewport: v }),

      select: (id) => set({ selectedId: id, selectedIds: id ? [id] : [], selectedEdgeId: null }),

      setSelection: (ids) =>
        set({ selectedIds: ids, selectedId: ids[0] ?? null, selectedEdgeId: ids.length ? null : get().selectedEdgeId }),

      toggleInSelection: (id) => {
        const s = get();
        const has = s.selectedIds.includes(id);
        const selectedIds = has ? s.selectedIds.filter((sid) => sid !== id) : [...s.selectedIds, id];
        set({
          selectedIds,
          selectedId: has ? (selectedIds[0] ?? null) : id,
          selectedEdgeId: null,
        });
      },

      selectAll: () => {
        const ids = get().nodes.map((n) => n.id);
        set({ selectedIds: ids, selectedId: ids[0] ?? null, selectedEdgeId: null });
      },

      selectEdge: (id) =>
        set(id ? { selectedEdgeId: id, selectedId: null, selectedIds: [] } : { selectedEdgeId: null }),

      clearGraph: () => {
        for (const url of Object.values(get().previews)) if (url) URL.revokeObjectURL(url);
        set({ nodes: [], edges: [], selectedId: null, selectedIds: [], selectedEdgeId: null, status: {}, statusMsg: {}, previews: {} });
      },

      setRunning: (v) => set({ running: v }),

      setStatus: (id, status, msg) =>
        set({
          status: { ...get().status, [id]: status },
          statusMsg: msg === undefined ? get().statusMsg : { ...get().statusMsg, [id]: msg },
        }),

      setPreview: (id, blob) => {
        const old = get().previews[id];
        if (old) URL.revokeObjectURL(old);
        set({ previews: { ...get().previews, [id]: blob ? URL.createObjectURL(blob) : null } });
      },

      resetRun: () => {
        const status: Record<string, NodeRunStatus> = {};
        for (const n of get().nodes) status[n.id] = 'idle';
        set({ status, statusMsg: {} });
      },
    })),
    {
      name: 'thedaw-audimate-v1',
      version: 2,
      // v2: effect nodes now carry their effect's numeric params from creation.
      // Seed any persisted effect node that predates that so Run can't 400.
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as { nodes?: GraphNode[] };
        if (Array.isArray(p.nodes)) {
          p.nodes = p.nodes.map((n) => {
            if (n.kind !== 'effect') return n;
            const effect = String(n.params?.effect || 'mastering_chain');
            return { ...n, params: { ...(EFFECT_DEFAULTS[effect] ?? {}), ...n.params } };
          });
        }
        return p as unknown as AudimateState;
      },
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges, viewport: s.viewport }),
    },
  ),
);
