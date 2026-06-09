import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch, CornerDownRight, Disc3, Network, Loader2 } from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { useAppUiStore } from '../state/appUiStore';
import { CatalogueProviderBadge } from './CatalogueProviderBadge';

/** Shapes returned by GET /api/library/{id}/lineage?depth=N. */
interface LineageNode {
  id: string;
  kind: string;            // 'entry' | 'external' | 'stem' | 'midi' | ...
  title?: string | null;
  source?: string | null;
  duration_sec?: number | null;
}
interface LineageEdge {
  from_id: string;
  to_id: string;
  kind: string;            // 'variation' | 'inpaint' | 'remaster' | ...
  weight?: number;
}
interface LineageResponse {
  root: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

interface Props {
  entry: LibraryEntry;
}

/**
 * CatalogueLineage — DETAILED lineage viewer, modeled on SunoHarvester's
 * remaster-chain / ancestry UI.
 *
 * Fetches the lineage graph for the entry, then renders:
 *   1. a LINEAR ancestor chain (walk parent edges up to the root),
 *   2. the current entry highlighted (amber),
 *   3. its direct CHILDREN (derivatives),
 *   4. SIBLINGS (other children of this entry's parent).
 * Each row is clickable → `setSelectedEntry` so the inspector re-targets.
 * "Open in graph" jumps to the 3D LineageView in the LEARN center-tab.
 */
export const CatalogueLineage: React.FC<Props> = ({ entry }) => {
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);

  const [data, setData] = useState<LineageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    void fetch(`/api/library/${entry.id}/lineage?depth=3`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: LineageResponse) => { if (!cancelled) setData(json); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry.id]);

  // Build directed adjacency from edges (from = parent, to = child).
  const { ancestorChain, children, siblings, nodeMap } = useMemo(() => {
    const nodeMap = new Map<string, LineageNode>();
    const parentsOf = new Map<string, string[]>();
    const childrenOf = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    if (data) {
      for (const n of data.nodes) nodeMap.set(n.id, n);
      for (const e of data.edges) {
        push(childrenOf, e.from_id, e.to_id);
        push(parentsOf, e.to_id, e.from_id);
      }
    }

    // Walk parents up to the root → linear ancestor chain (root … entry).
    const chain: string[] = [entry.id];
    const seen = new Set<string>([entry.id]);
    let cursor = entry.id;
    // Follow the first parent at each step (a linear remaster chain). Guard
    // against cycles via `seen`.
    for (let guard = 0; guard < 64; guard += 1) {
      const parents = parentsOf.get(cursor);
      if (!parents || parents.length === 0) break;
      const next = parents.find((p) => !seen.has(p));
      if (!next) break;
      chain.unshift(next);
      seen.add(next);
      cursor = next;
    }

    const childIds = childrenOf.get(entry.id) ?? [];
    // Siblings = other children of this entry's immediate parent.
    const parent = (parentsOf.get(entry.id) ?? [])[0];
    const siblingIds = parent
      ? (childrenOf.get(parent) ?? []).filter((id) => id !== entry.id)
      : [];

    return {
      ancestorChain: chain,
      children: childIds,
      siblings: siblingIds,
      nodeMap,
    };
  }, [data, entry.id]);

  const openInGraph = () => {
    setSelectedEntry(entry.id);
    setCenterTab('learn');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-1.5 py-4 text-zinc-600">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-[9px] font-mono">loading lineage…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-3 text-zinc-600 gap-1">
        <span className="text-[9px] font-mono text-red-400/70">lineage unavailable</span>
        <span className="text-[8px] font-mono text-zinc-700">{error}</span>
      </div>
    );
  }

  const hasRelations = ancestorChain.length > 1 || children.length > 0 || siblings.length > 0;

  if (!hasRelations) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <div className="flex flex-col items-center justify-center py-3 text-zinc-600 gap-1.5">
          <GitBranch className="w-5 h-5 opacity-40" />
          <span className="text-[9px] font-mono">original — no lineage yet</span>
          <span className="text-[8px] font-mono text-zinc-700 text-center px-2">
            Generate with this track as init / inpaint to spawn a descendant.
          </span>
        </div>
        <button
          onClick={openInGraph}
          className="mono-tag self-center bg-white/5! text-zinc-400! flex items-center gap-1"
          title="Open the 3D lineage graph"
        >
          <Network className="w-2.5 h-2.5" /> Open in graph
        </button>
      </div>
    );
  }

  const renderNodeRow = (
    id: string,
    opts: { current?: boolean; depth?: number; childOf?: 'child' | 'sibling' } = {},
  ) => {
    const node = nodeMap.get(id);
    const title = node?.title ?? `${id.slice(0, 12)}…`;
    const isCurrent = opts.current ?? false;
    const isExternal = node ? node.kind !== 'entry' : true;
    return (
      <button
        key={`${opts.childOf ?? 'chain'}-${id}`}
        onClick={() => !isExternal && setSelectedEntry(id)}
        disabled={isExternal}
        className={`flex items-center gap-1.5 text-left rounded px-1.5 py-1 w-full transition-colors
          ${isExternal ? 'opacity-50 cursor-default' : 'hover:bg-white/5'}
          ${isCurrent ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : ''}`}
        style={{ marginLeft: opts.depth ? `${opts.depth * 12}px` : undefined }}
        title={title}
      >
        {opts.depth ? <CornerDownRight className="w-2.5 h-2.5 text-zinc-600 shrink-0" /> : null}
        <Disc3 className={`w-3 h-3 shrink-0 ${
          isCurrent ? 'text-amber-400'
            : opts.childOf === 'child' ? 'text-cyan-400/70'
            : opts.childOf === 'sibling' ? 'text-zinc-500'
            : 'text-indigo-400/70'}`} />
        <CatalogueProviderBadge source={node?.source} className="shrink-0" />
        <span className={`text-[9px] font-mono truncate flex-1 ${isCurrent ? 'text-amber-200 font-bold' : 'text-zinc-400'}`}>
          {title}
        </span>
        {node?.kind && node.kind !== 'entry' && (
          <span className="text-[7px] font-mono text-zinc-600 shrink-0 uppercase">{node.kind}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      {/* Ancestor chain (root → entry) */}
      {ancestorChain.map((id, i) =>
        renderNodeRow(id, { current: id === entry.id, depth: i }),
      )}

      {/* Direct children / derivatives */}
      {children.length > 0 && (
        <div className="mt-1 pt-1 border-t border-white/5">
          <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600 px-1.5">
            {children.length} descendant{children.length === 1 ? '' : 's'}
          </span>
          {children.map((id) =>
            renderNodeRow(id, { depth: ancestorChain.length, childOf: 'child' }),
          )}
        </div>
      )}

      {/* Siblings (other children of the same parent) */}
      {siblings.length > 0 && (
        <div className="mt-1 pt-1 border-t border-white/5">
          <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600 px-1.5">
            {siblings.length} sibling{siblings.length === 1 ? '' : 's'}
          </span>
          {siblings.map((id) => renderNodeRow(id, { childOf: 'sibling' }))}
        </div>
      )}

      <button
        onClick={openInGraph}
        className="mono-tag self-center mt-1.5 bg-white/5! text-zinc-400! flex items-center gap-1"
        title="Open the 3D lineage graph"
      >
        <Network className="w-2.5 h-2.5" /> Open in graph
      </button>
    </div>
  );
};
