import React, { useMemo } from 'react';
import { GitBranch, CornerDownRight, Disc3, Network, Loader2 } from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { useAppUiStore } from '../state/appUiStore';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { LineageFamilyNotice, RelativeList, useLineageFamily } from '../components/library/LineageFamilyNotice';
import type { LineageNode } from '../lib/lineageInsights';

const OPEN_KEY =
  'flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs font-bold text-zinc-300 transition-colors hover:border-purple-400/50 hover:text-zinc-100';

interface Props {
  entry: LibraryEntry;
}

/**
 * CatalogueLineage — DETAILED lineage viewer, modeled on SunoHarvester's
 * remaster-chain / ancestry UI.
 *
 * Reads the lineage graph for the entry (the screen route, cut at the
 * server's node cap, with the whole family one press away), then renders:
 *   1. a LINEAR ancestor chain (walk parent edges up to the root),
 *   2. the current entry highlighted (amber),
 *   3. its direct CHILDREN (derivatives),
 *   4. SIBLINGS (other children of this entry's parent).
 * Each row is clickable → `setSelectedEntry` so the inspector re-targets.
 * "Open in graph" selects the entry and opens the LEARN center tab, whose
 * lineage view is the scale view or the classic graph (LearnHost decides).
 */
export const CatalogueLineage: React.FC<Props> = ({ entry }) => {
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);

  const lineage = useLineageFamily(entry.id, 3);
  const data = lineage.family;
  const { loading, error } = lineage;
  const notice = data ? (
    <LineageFamilyNotice
      family={data}
      busy={lineage.wholeBusy}
      error={lineage.wholeError}
      onLoadWhole={lineage.loadWhole}
    />
  ) : null;

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
      <div className="flex items-center justify-center gap-1.5 py-4 text-zinc-500">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <span className="text-xs font-bold">Reading lineage…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-3 gap-1">
        <span className="text-xs font-bold text-red-300">Lineage unavailable</span>
        <span className="text-xs font-bold text-zinc-500">{error}</span>
      </div>
    );
  }

  const hasRelations = ancestorChain.length > 1 || children.length > 0 || siblings.length > 0;

  if (!hasRelations) {
    return (
      <div className="flex flex-col gap-2 py-2">
        {notice}
        <div className="flex flex-col items-center justify-center py-3 text-zinc-500 gap-1.5">
          <GitBranch className="size-5 opacity-40" aria-hidden="true" />
          <span className="text-xs font-bold">Original: no lineage yet</span>
          <span className="text-xs font-bold text-zinc-500 text-center px-2">
            Generate with this track as init / inpaint to spawn a descendant.
          </span>
        </div>
        <button
          type="button"
          onClick={openInGraph}
          className={`${OPEN_KEY} self-center`}
          title="Open the lineage graph in LEARN"
        >
          <Network className="size-3.5" aria-hidden="true" /> Open in graph
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
        {/* A lineage node knows its `source` and nothing else, so this badge
            is the derived half of the same one provider the rows show. */}
        <ProviderBadge entry={{ source: node?.source }} className="shrink-0" />
        <span className={`text-xs font-bold truncate flex-1 ${isCurrent ? 'text-amber-200' : 'text-zinc-400'}`}>
          {title}
        </span>
        {node?.kind && node.kind !== 'entry' && (
          <span className="text-xs font-bold text-zinc-500 shrink-0 uppercase">{node.kind}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      {notice}
      {/* Ancestor chain (root → entry) */}
      {ancestorChain.map((id, i) =>
        renderNodeRow(id, { current: id === entry.id, depth: i }),
      )}

      {/* Direct children / derivatives */}
      {children.length > 0 && (
        <div className="mt-1 pt-1 border-t border-white/5">
          <span className="text-xs font-bold text-zinc-500 px-1.5">
            {children.length} descendant{children.length === 1 ? '' : 's'}
          </span>
          {data && (
            <RelativeList
              as="div"
              items={children}
              family={data}
              className="flex flex-col"
              render={(id) => renderNodeRow(id, { depth: ancestorChain.length, childOf: 'child' })}
            />
          )}
        </div>
      )}

      {/* Siblings (other children of the same parent) */}
      {siblings.length > 0 && (
        <div className="mt-1 pt-1 border-t border-white/5">
          <span className="text-xs font-bold text-zinc-500 px-1.5">
            {siblings.length} sibling{siblings.length === 1 ? '' : 's'}
          </span>
          {data && (
            <RelativeList
              as="div"
              items={siblings}
              family={data}
              className="flex flex-col"
              render={(id) => renderNodeRow(id, { childOf: 'sibling' })}
            />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={openInGraph}
        className={`${OPEN_KEY} self-center mt-1.5`}
        title="Open the lineage graph in LEARN"
      >
        <Network className="size-3.5" aria-hidden="true" /> Open in graph
      </button>
    </div>
  );
};
