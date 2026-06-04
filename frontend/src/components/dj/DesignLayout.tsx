/**
 * DJ Design Mode — direct-manipulation layout editing.
 *
 * `LayoutRow` renders a CSS-grid row whose track sizes (fr) + panel order come
 * from the persisted `useDjLayout` store. In Design Mode it overlays:
 *   • draggable SPLITTERS between panels (resize → adjusts the two neighbours' fr)
 *   • a drag SCRIM on each panel (drag onto another panel in the same row → swap)
 * Out of Design Mode it's a plain grid (the splitter cells are just the gap), so
 * there's zero behavioural/visual change until the user opts in.
 *
 * `Splitter` is the bare pointer-drag primitive (also used for the vertical band
 * heights in DJView). `DesignToolbar` is the floating enter/exit/reset/copy UI.
 */
import React, { useRef, useState } from 'react';
import { GripVertical, LayoutGrid, Check, RotateCcw, Copy, Move } from 'lucide-react';
import { useDjLayout, type RowKey, type PanelId } from '../../state/djLayoutStore';

const PANEL_MIME = 'application/x-thedaw-panel';
const GAP = 6; // matches the old gap-1.5 spacing

const PANEL_LABEL: Record<PanelId, string> = {
  sampler: 'Sampler', center: 'Decks · Mixer', browser: 'Browser',
  deckA: 'Deck A', mixer: 'Mixer', deckB: 'Deck B',
  fxA: 'FX · Stems A', next: 'Next', fxB: 'FX · Stems B',
  sourceTree: 'Source Tree', library: 'Library',
  pchA: 'Pitch A', eqA: 'EQ A', chA: 'Vol A', chB: 'Vol B', eqB: 'EQ B', pchB: 'Pitch B',
};

/* ── bare pointer-drag splitter primitive ─────────────────────────────────── */
export const Splitter: React.FC<{ axis: 'x' | 'y'; onDelta: (dpx: number) => void; className?: string; title?: string }> = ({ axis, onDelta, className, title }) => {
  const drag = useRef(false);
  const last = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    drag.current = true; last.current = axis === 'x' ? e.clientX : e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const cur = axis === 'x' ? e.clientX : e.clientY;
    onDelta(cur - last.current); last.current = cur;
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  return (
    <div
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      title={title ?? 'Drag to resize'}
      className={`z-50 rounded-full bg-purple-400/50 hover:bg-purple-300 transition-colors ${axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'} ${className ?? ''}`}
    />
  );
};

/* ── one panel cell ───────────────────────────────────────────────────────
 * In Design Mode the body stays interactive (so nested rows can be edited);
 * dragging happens via a thin labelled handle strip at the top, and the WHOLE
 * cell is the drop target. This lets panels nest editable groups inside them. */
const PanelCell: React.FC<{ rowKey: RowKey; id: PanelId; index: number; design: boolean; children: React.ReactNode }> = ({ rowKey, id, index, design, children }) => {
  const reorder = useDjLayout((s) => s.reorder);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`relative min-w-0 min-h-0 grid ${design && over ? 'ring-2 ring-inset ring-emerald-300' : ''}`}
      onDragOver={design ? (e) => { if (e.dataTransfer.types.includes(PANEL_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } } : undefined}
      onDragLeave={design ? () => setOver(false) : undefined}
      onDrop={design ? (e) => {
        setOver(false);
        const raw = e.dataTransfer.getData(PANEL_MIME);
        if (!raw) return;
        try { const p = JSON.parse(raw) as { rowKey: RowKey; from: number }; if (p.rowKey === rowKey) { e.preventDefault(); e.stopPropagation(); reorder(rowKey, p.from, index); } } catch { /* ignore */ }
      } : undefined}
    >
      {children}
      {design && (
        <div
          draggable
          onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(PANEL_MIME, JSON.stringify({ rowKey, from: index })); }}
          title={`Drag to move ${PANEL_LABEL[id]} (drop on another to swap)`}
          className="absolute top-0 left-0 right-0 z-50 h-4 flex items-center justify-center gap-1 bg-purple-600/85 hover:bg-purple-500 border-b border-purple-300/50 cursor-grab active:cursor-grabbing select-none"
        >
          <GripVertical className="w-3 h-3 text-purple-50 shrink-0" />
          <span className="text-[8px] font-black uppercase tracking-wider text-purple-50 truncate px-1">{PANEL_LABEL[id]}</span>
        </div>
      )}
    </div>
  );
};

/* ── a resizable + reorderable grid row, driven by the layout store ───────── */
export const LayoutRow: React.FC<{
  rowKey: RowKey;
  axis: 'x' | 'y';
  nodes: Partial<Record<PanelId, React.ReactNode>>;
  className?: string;
  style?: React.CSSProperties;
  /** When false, panels can still be resized but not dragged to reorder (no
   *  scrim) — used for the OUTER row whose panels nest other rows, so the
   *  nested panels stay grabbable. Default true. */
  reorderable?: boolean;
}> = ({ rowKey, axis, nodes, className, style, reorderable = true }) => {
  const design = useDjLayout((s) => s.designMode);
  const row = useDjLayout((s) => s.rows[rowKey]);
  const resize = useDjLayout((s) => s.resize);
  const ref = useRef<HTMLDivElement>(null);

  // Defensive: a persisted layout from before this row existed could leave it
  // undefined for a tick; render the panels plainly rather than crash.
  if (!row) {
    return <div className={className} style={{ ...style, display: 'flex', gap: GAP, minWidth: 0, minHeight: 0 }}>{Object.values(nodes)}</div>;
  }

  // Interleave fr tracks with fixed GAP tracks (the gap tracks hold splitters).
  const tracks: string[] = [];
  const children: React.ReactNode[] = [];
  row.order.forEach((id, i) => {
    if (i > 0) {
      tracks.push(`${GAP}px`);
      children.push(
        design ? (
          <Splitter
            key={`s-${id}`}
            axis={axis}
            title="Drag to resize"
            onDelta={(dpx) => {
              const el = ref.current;
              const size = el ? (axis === 'x' ? el.clientWidth : el.clientHeight) : 0;
              if (size > 0) resize(rowKey, row.order[i - 1], id, dpx / size);
            }}
          />
        ) : <div key={`s-${id}`} />,
      );
    }
    tracks.push(`${row.fr[id] ?? 1}fr`);
    children.push(
      <PanelCell key={id} rowKey={rowKey} id={id} index={i} design={design && reorderable}>
        {nodes[id]}
      </PanelCell>,
    );
  });

  const gridStyle: React.CSSProperties = axis === 'x'
    ? { display: 'grid', gridTemplateColumns: tracks.join(' '), minWidth: 0, minHeight: 0 }
    : { display: 'grid', gridTemplateRows: tracks.join(' '), minWidth: 0, minHeight: 0 };

  return <div ref={ref} className={className} style={{ ...style, ...gridStyle }}>{children}</div>;
};

/* ── floating enter / done / reset / copy toolbar ─────────────────────────── */
export const DesignToolbar: React.FC = () => {
  const design = useDjLayout((s) => s.designMode);
  const setDesignMode = useDjLayout((s) => s.setDesignMode);
  const reset = useDjLayout((s) => s.reset);
  const exportJSON = useDjLayout((s) => s.exportJSON);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportJSON()); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ }
  };

  if (!design) {
    return (
      <button
        onClick={() => setDesignMode(true)}
        title="Edit Layout — drag panels to move them, drag the borders to resize"
        className="absolute top-1.5 right-2 z-60 flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/60 text-zinc-400 hover:text-purple-200 hover:border-purple-400/50 text-[9px] font-black uppercase tracking-widest transition-colors"
      >
        <LayoutGrid className="w-3 h-3" /> Edit Layout
      </button>
    );
  }
  return (
    <div className="absolute top-1.5 right-2 z-60 flex items-center gap-1.5 px-2 py-1 rounded border border-purple-400/50 bg-[#150f22]/95 shadow-xl">
      <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-purple-200"><Move className="w-3 h-3" /> Design</span>
      <span className="text-[8px] font-mono text-zinc-500 max-w-44 leading-tight">drag panels to move · drag borders to resize</span>
      <button onClick={() => void copy()} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-cyan-200 hover:border-cyan-400/50 text-[8px] font-bold uppercase tracking-wider" title="Copy layout JSON (to bake in as the default)">
        <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy'}
      </button>
      <button onClick={reset} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-rose-300 hover:border-rose-400/50 text-[8px] font-bold uppercase tracking-wider" title="Reset to the default layout">
        <RotateCcw className="w-3 h-3" /> Reset
      </button>
      <button onClick={() => setDesignMode(false)} className="flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 text-[8px] font-black uppercase tracking-wider" title="Exit Design Mode">
        <Check className="w-3 h-3" /> Done
      </button>
    </div>
  );
};
