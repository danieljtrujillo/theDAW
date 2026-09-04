/**
 * NodeF.I. saved sets — a named library of node-graph documents, separate from
 * the working canvas (which autosaves on its own). Persisted to localStorage;
 * sets also round-trip through JSON files (export/import in the rail) so a rig
 * can be backed up or moved between machines.
 *
 * Loading a set goes through nodefiStore.loadTemplate, which mints fresh
 * node ids — so a saved set never collides with ids already on the canvas and
 * one undo restores the previous graph.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { GraphEdge, GraphNode } from '../lib/nodefiTypes';

export interface SavedNodeSet {
  id: string;
  name: string;
  /** ISO timestamp of the save. */
  savedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The on-disk file shape for export/import. */
export interface NodeSetFile {
  app: 'thedaw-nodefi';
  version: 1;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

let seq = 0;
const uid = (): string => `set_${Date.now().toString(36)}${(seq++).toString(36)}`;

interface NodefiSetsState {
  sets: SavedNodeSet[];
  /** Snapshot the given document under a name (replaces a same-named set). */
  saveSet: (name: string, nodes: GraphNode[], edges: GraphEdge[]) => SavedNodeSet;
  deleteSet: (id: string) => void;
  /** Validate + ingest an exported file's parsed JSON. Throws on a bad shape. */
  importSet: (data: unknown, fallbackName: string) => SavedNodeSet;
}

export const useNodefiSetsStore = create<NodefiSetsState>()(
  persist(
    (set, get) => ({
      sets: [],

      saveSet: (name, nodes, edges) => {
        const trimmed = name.trim() || `Set ${get().sets.length + 1}`;
        const entry: SavedNodeSet = {
          id: uid(),
          name: trimmed,
          savedAt: new Date().toISOString(),
          // Deep-ish copy so later canvas edits can't mutate the snapshot.
          nodes: nodes.map((n) => ({ ...n, params: { ...n.params } })),
          edges: edges.map((e) => ({ ...e })),
        };
        set({ sets: [entry, ...get().sets.filter((s) => s.name !== trimmed)] });
        return entry;
      },

      deleteSet: (id) => set({ sets: get().sets.filter((s) => s.id !== id) }),

      importSet: (data, fallbackName) => {
        const d = data as Partial<NodeSetFile> | null;
        if (!d || d.app !== 'thedaw-nodefi' || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) {
          throw new Error('not a NodeF.I. set file');
        }
        return get().saveSet(String(d.name || fallbackName), d.nodes, d.edges);
      },
    }),
    // Pre-rename key kept deliberately — see nodefiStore. Renaming it would
    // orphan every saved set.
    { name: 'thedaw-audimate-sets-v1', version: 1 },
  ),
);

/** Build the export-file payload for one set. */
export const setToFile = (s: SavedNodeSet): NodeSetFile => ({
  app: 'thedaw-nodefi',
  version: 1,
  name: s.name,
  nodes: s.nodes,
  edges: s.edges,
});
