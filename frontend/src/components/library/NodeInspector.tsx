/**
 * NodeInspector — the full detail + analytics panel for one lineage node.
 * Shared by the 2D genealogy DAG and the 3D force-graph. On open it fetches
 * the entry's full generation params (`/api/library/entries/{id}`) and musical
 * analysis (`/api/analysis/{id}`), and lazily aggregates "cultivation insights"
 * across the node's lineage (recurring prompt terms + common tags) so the user
 * can see the themes a sound family is built from. Copy buttons export the full
 * dataset, the prompt, or the chimera list.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, Copy, Check, Sparkles } from 'lucide-react';
import type { GraphNode, GraphEdge } from './LineageModal';

interface EntryDetail {
  title?: string;
  prompt?: string;
  negative_prompt?: string;
  model?: string;
  steps?: number;
  cfg?: number;
  seed?: number;
  duration?: number;
  chimera_sources?: string[];
  tags?: string[];
  rating?: number;
  favorite?: boolean;
  notes?: string;
  [k: string]: unknown;
}

interface Analysis {
  bpm?: number;
  key?: string;
  key_confidence?: number;
  scale?: string;
  loudness_lufs?: number;
  pitch_mean_hz?: number;
  rms_db?: number;
  [k: string]: unknown;
}

// Lineage-entry fetches are capped so a giant family doesn't fire hundreds of
// requests; we surface the cap rather than silently truncating.
const LINEAGE_FETCH_CAP = 40;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'with', 'in', 'on', 'to', 'for', 'at',
  'by', 'from', 'is', 'it', 'this', 'that', 'into', 'over', 'out', 'up', 'as',
  'but', 'are', 'was', 'be', 'no', 'not', 'very', 'more', 'some', 'like',
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Directed reachable set from `start` over `adj` (excludes start). */
function reach(start: string, adj: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const nb of adj[id] ?? []) {
      if (nb !== start && !out.has(nb)) {
        out.add(nb);
        stack.push(nb);
      }
    }
  }
  return out;
}

const CopyButton: React.FC<{ label: string; get: () => string; done: string | null; setDone: (s: string | null) => void }> = ({ label, get, done, setDone }) => (
  <button
    onClick={() => {
      const text = get();
      void navigator.clipboard?.writeText(text).then(() => {
        setDone(label);
        window.setTimeout(() => setDone(null), 1200);
      }).catch(() => { /* clipboard unavailable */ });
    }}
    className="flex items-center gap-1 text-[8px] font-mono uppercase tracking-wider px-1.5 py-1 rounded bg-white/5 border border-white/10 text-zinc-300 hover:text-white hover:border-purple-400/50 hover:bg-purple-500/10"
    title={`Copy ${label}`}
  >
    {done === label ? <Check className="w-2.5 h-2.5 text-emerald-300" /> : <Copy className="w-2.5 h-2.5" />}
    {label}
  </button>
);

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5 px-2 py-1 rounded bg-white/3 border border-white/5">
    <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
    <span className="text-[10px] font-mono text-zinc-200 tabular-nums">{value}</span>
  </div>
);

export const NodeInspector: React.FC<{
  nodeId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  edgeColor: (kind: string) => string;
  onClose: () => void;
}> = ({ nodeId, nodes, edges, edgeColor, onClose }) => {
  const node = useMemo(() => nodes.find((n) => n.id === nodeId) ?? null, [nodes, nodeId]);
  const nodeMap = useMemo(() => {
    const m: Record<string, GraphNode> = {};
    nodes.forEach((n) => { m[n.id] = n; });
    return m;
  }, [nodes]);

  const { parentsOf, childrenOf } = useMemo(() => {
    const po: Record<string, string[]> = {};
    const co: Record<string, string[]> = {};
    edges.forEach((e) => {
      (co[e.from_id] = co[e.from_id] || []).push(e.to_id);
      (po[e.to_id] = po[e.to_id] || []).push(e.from_id);
    });
    return { parentsOf: po, childrenOf: co };
  }, [edges]);

  const incoming = useMemo(() => (nodeId ? edges.filter((e) => e.to_id === nodeId) : []), [edges, nodeId]);
  const outgoing = useMemo(() => (nodeId ? edges.filter((e) => e.from_id === nodeId) : []), [edges, nodeId]);

  const { ancestors, descendants, lineageKey } = useMemo(() => {
    if (!nodeId) return { ancestors: new Set<string>(), descendants: new Set<string>(), lineageKey: '' };
    const a = reach(nodeId, parentsOf);
    const d = reach(nodeId, childrenOf);
    const all = [...a, ...d].sort();
    return { ancestors: a, descendants: d, lineageKey: all.join(',') };
  }, [nodeId, parentsOf, childrenOf]);

  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [insights, setInsights] = useState<{ terms: Array<[string, number]>; tags: Array<[string, number]>; truncated: boolean; count: number } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Entry params + analysis for the selected node.
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setDetail(null);
    setAnalysis(null);
    // Only real entries have a generation record / analysis; stems, midi and
    // external nodes show just their graph-level info (no 404s).
    if (nodeMap[nodeId]?.kind !== 'entry') return () => { cancelled = true; };
    void fetch(`/api/library/entries/${nodeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { /* offline */ });
    void fetch(`/api/analysis/${nodeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => { if (!cancelled) setAnalysis(a); })
      .catch(() => { /* no analysis */ });
    return () => { cancelled = true; };
  }, [nodeId, nodeMap]);

  // Lazy lineage aggregation: recurring prompt terms + common tags.
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    // Only real library entries (kind 'entry') carry prompts/tags and are
    // fetchable via /entries/{id}; stems/midi/external lineage nodes are not,
    // so excluding them keeps the aggregation correct AND avoids 404 noise.
    const ids = (lineageKey ? lineageKey.split(',').filter(Boolean) : []).filter((id) => nodeMap[id]?.kind === 'entry');
    const truncated = ids.length > LINEAGE_FETCH_CAP;
    const use = ids.slice(0, LINEAGE_FETCH_CAP);
    if (use.length === 0) { setInsights({ terms: [], tags: [], truncated: false, count: 0 }); return; }
    setAnalyzing(true);
    setInsights(null);
    void Promise.all(
      use.map((id) => fetch(`/api/library/entries/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)),
    ).then((entries) => {
      if (cancelled) return;
      const termCount = new Map<string, number>();
      const tagCount = new Map<string, number>();
      for (const e of entries as Array<EntryDetail | null>) {
        if (!e) continue;
        for (const t of tokenize(String(e.prompt ?? ''))) termCount.set(t, (termCount.get(t) ?? 0) + 1);
        for (const tag of e.tags ?? []) tagCount.set(String(tag), (tagCount.get(String(tag)) ?? 0) + 1);
      }
      const top = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
      setInsights({ terms: top(termCount), tags: top(tagCount), truncated, count: use.length });
    }).finally(() => { if (!cancelled) setAnalyzing(false); });
    return () => { cancelled = true; };
  }, [nodeId, lineageKey, nodeMap]);

  if (!node) return null;

  // Outgoing edges grouped by relation kind → "what this node spawned".
  const spawnByKind = outgoing.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});

  const chimera = detail?.chimera_sources ?? [];

  const copyAll = () => JSON.stringify({ ...node, ...(detail ?? {}), analysis: analysis ?? null }, null, 2);

  return (
    <div className="absolute top-2 right-2 bottom-2 z-20 w-80 bg-[#0c0a14]/97 backdrop-blur-sm border border-purple-500/30 rounded shadow-xl flex flex-col select-text">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-widest text-purple-300">Node inspector</span>
        <button
          onClick={onClose}
          className="p-0.5 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5"
          title="Close (Esc, or click empty space / the node again)"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3">
        {/* Identity */}
        <div>
          <div className="text-[11px] font-bold text-zinc-100 wrap-break-word leading-snug">{node.title || node.id}</div>
          <div className="text-[8px] font-mono text-zinc-600 break-all mt-0.5">{node.id}</div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {node.source && <span className="text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 bg-purple-500/10 border border-purple-500/20 rounded text-purple-200">{node.source}</span>}
            {node.kind && <span className="text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 bg-zinc-500/10 border border-zinc-500/20 rounded text-zinc-300">{node.kind}</span>}
            {(detail?.model ?? node.model) && <span className="text-[8px] font-mono px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-200">{detail?.model ?? node.model}</span>}
            {typeof node.duration_sec === 'number' && node.duration_sec > 0 && <span className="text-[8px] font-mono px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-amber-200">{node.duration_sec.toFixed(1)}s</span>}
          </div>
        </div>

        {/* Copy actions */}
        <div className="flex flex-wrap gap-1.5">
          <CopyButton label="all (json)" get={copyAll} done={copied} setDone={setCopied} />
          <CopyButton label="prompt" get={() => detail?.prompt ?? ''} done={copied} setDone={setCopied} />
          {chimera.length > 0 && <CopyButton label="chimera" get={() => chimera.join('\n')} done={copied} setDone={setCopied} />}
        </div>

        {/* Generation params */}
        {detail?.prompt != null && (
          <div className="flex flex-col gap-1">
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Prompt</span>
            <p className="text-[10px] font-mono text-zinc-300 leading-relaxed wrap-break-word bg-black/30 rounded p-2 border border-white/5">{detail.prompt || <span className="text-zinc-600 italic">empty</span>}</p>
            {detail.negative_prompt ? (
              <>
                <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 mt-0.5">Negative</span>
                <p className="text-[9px] font-mono text-zinc-400 leading-relaxed wrap-break-word bg-black/20 rounded p-1.5 border border-white/5">{detail.negative_prompt}</p>
              </>
            ) : null}
          </div>
        )}
        {detail && (
          <div className="grid grid-cols-3 gap-1.5">
            {typeof detail.steps === 'number' && <Stat label="steps" value={detail.steps} />}
            {typeof detail.cfg === 'number' && <Stat label="cfg" value={detail.cfg} />}
            {typeof detail.seed === 'number' && <Stat label="seed" value={detail.seed} />}
          </div>
        )}

        {/* Chimera sources */}
        {chimera.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Chimera sources ({chimera.length})</span>
            <div className="flex flex-col gap-0.5">
              {chimera.slice(0, 12).map((c, i) => (
                <span key={`${c}-${i}`} className="text-[9px] font-mono text-zinc-400 truncate" title={c}>{c}</span>
              ))}
              {chimera.length > 12 && <span className="text-[8px] font-mono text-zinc-700 italic">+ {chimera.length - 12} more</span>}
            </div>
          </div>
        )}

        {/* Musical analysis */}
        {analysis && (analysis.bpm != null || analysis.key != null || analysis.loudness_lufs != null) && (
          <div className="flex flex-col gap-1">
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Analysis</span>
            <div className="grid grid-cols-2 gap-1.5">
              {analysis.bpm != null && <Stat label="bpm" value={Math.round(analysis.bpm)} />}
              {analysis.key != null && <Stat label="key" value={`${analysis.key}${analysis.scale ? ` ${analysis.scale}` : ''}`} />}
              {analysis.loudness_lufs != null && <Stat label="loudness" value={`${analysis.loudness_lufs.toFixed(1)} LUFS`} />}
              {analysis.pitch_mean_hz != null && <Stat label="pitch" value={`${Math.round(analysis.pitch_mean_hz)} Hz`} />}
            </div>
          </div>
        )}

        {/* Tags / rating / notes */}
        {detail && ((detail.tags && detail.tags.length > 0) || detail.rating || detail.notes) && (
          <div className="flex flex-col gap-1">
            {detail.tags && detail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((t) => <span key={t} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-200">{t}</span>)}
              </div>
            )}
            {typeof detail.rating === 'number' && detail.rating > 0 && <span className="text-[9px] font-mono text-amber-300">{'★'.repeat(Math.min(5, detail.rating))}<span className="text-zinc-700">{'★'.repeat(Math.max(0, 5 - detail.rating))}</span></span>}
            {detail.notes && <p className="text-[9px] font-mono text-zinc-400 italic wrap-break-word">{detail.notes}</p>}
          </div>
        )}

        {/* Cultivation insights */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/5">
          <span className="flex items-center gap-1 text-[8px] font-mono uppercase tracking-widest text-purple-300/80">
            <Sparkles className="w-2.5 h-2.5" /> Cultivation insights
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Stat label="ancestors" value={ancestors.size} />
            <Stat label="descendants" value={descendants.size} />
          </div>
          {Object.keys(spawnByKind).length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600">Spawned</span>
              <div className="flex flex-wrap gap-1">
                {Object.entries(spawnByKind).map(([kind, n]) => (
                  <span key={kind} className="flex items-center gap-1 text-[8px] font-mono text-zinc-400">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: edgeColor(kind) }} />
                    {n} {kind.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}
          {analyzing && <span className="text-[8px] font-mono text-zinc-600 italic">analyzing lineage…</span>}
          {insights && insights.terms.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600">Recurring prompt terms</span>
              <div className="flex flex-wrap gap-1">
                {insights.terms.map(([term, n]) => (
                  <span key={term} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-200">{term} <span className="text-purple-400/60">{n}</span></span>
                ))}
              </div>
            </div>
          )}
          {insights && insights.tags.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600">Common tags in lineage</span>
              <div className="flex flex-wrap gap-1">
                {insights.tags.map(([tag, n]) => (
                  <span key={tag} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-200">{tag} <span className="text-sky-400/60">{n}</span></span>
                ))}
              </div>
            </div>
          )}
          {insights?.truncated && <span className="text-[7px] font-mono text-amber-500/70 italic">insights sampled from {insights.count} of the lineage (capped at {LINEAGE_FETCH_CAP})</span>}
          {insights && insights.terms.length === 0 && insights.tags.length === 0 && !analyzing && (
            <span className="text-[8px] font-mono text-zinc-600 italic">no lineage prompts/tags to aggregate yet</span>
          )}
        </div>

        {/* Direct relationships */}
        {(incoming.length > 0 || outgoing.length > 0) && (
          <div className="flex flex-col gap-1.5 pt-1 border-t border-white/5">
            {incoming.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Incoming ({incoming.length})</span>
                {incoming.slice(0, 10).map((e, i) => (
                  <div key={`in-${i}`} className="flex items-center gap-1.5 text-[9px] font-mono">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: edgeColor(e.kind) }} />
                    <span className="text-zinc-500 shrink-0">{e.kind}</span>
                    <span className="text-zinc-400 truncate">{nodeMap[e.from_id]?.title ?? `${e.from_id.slice(0, 16)}…`}</span>
                  </div>
                ))}
              </div>
            )}
            {outgoing.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Outgoing ({outgoing.length})</span>
                {outgoing.slice(0, 10).map((e, i) => (
                  <div key={`out-${i}`} className="flex items-center gap-1.5 text-[9px] font-mono">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: edgeColor(e.kind) }} />
                    <span className="text-zinc-500 shrink-0">{e.kind}</span>
                    <span className="text-zinc-400 truncate">{nodeMap[e.to_id]?.title ?? `${e.to_id.slice(0, 16)}…`}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
