/**
 * A leaf panel. In Design Mode it shows a header strip with a drag grip (a
 * PANEL_MIME source so the panel can be moved/reordered across containers),
 * an inline-editable title, a mirror toggle, a padding drag-handle, split-row /
 * split-column buttons, and a remove button. The body either hosts ONE pinned
 * component full-bleed (library / source tree — no widget DnD, hidden from the
 * palette) or an fr-grid of relocatable WidgetCells.
 *
 * Uniform chrome: widget panels adopt the hardware-card border/bg so every
 * panel edge reads the same; pinned panels stay transparent (their hosted
 * component supplies its own card). Per-panel padding (padPx) and mirror
 * (reversed widget order + per-widget mirror opt) come from the layout store.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, FlipHorizontal, Rows3, Columns3, SeparatorHorizontal, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { FrGrid } from './FrGrid';
import { Splitter } from './Splitter';
import { WidgetCell } from './WidgetCell';
import { PANEL_MIME, WIDGET_MIME, encode, decodeWidget, decodePanel } from './dnd';
import type { Axis, EdgeDir, NodeId, PanelNode, SurfaceStoreApi } from '../../state/surfaceLayoutStore';

const PanelHeader: React.FC<{
  nodeId: NodeId;
  title: string;
  mirror: boolean;
  flow: Axis;
  padPx: number;
  surfaceId: string;
  store: SurfaceStoreApi;
}> = ({ nodeId, title, mirror, flow, padPx, surfaceId, store }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <div className="shrink-0 flex items-center gap-1 h-4 px-1 bg-purple-600/85 border-b border-purple-300/40 select-none">
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANEL_MIME, encode({ surfaceId, panelId: nodeId }));
        }}
        title="Drag to move this panel"
        className="cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="w-3 h-3 text-purple-50" />
      </div>

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            store.getState().renamePanel(nodeId, draft.trim() || 'Panel');
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-black/30 text-purple-50 text-[8px] font-black uppercase tracking-wider px-1 rounded focus:outline-none"
          title="Panel name"
        />
      ) : (
        <span
          onDoubleClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          className="flex-1 min-w-0 truncate text-[8px] font-black uppercase tracking-wider text-purple-50"
          title="Double-click to rename"
        >
          {title}
        </span>
      )}

      {/* draggable inner padding (margin) */}
      <Splitter
        axis="x"
        onDelta={(d) => store.getState().setPanelPad(nodeId, padPx + d * 0.25)}
        title={`Drag to set inner padding (${padPx}px)`}
        className="h-3 w-1.5 shrink-0"
      />
      <button
        onClick={() => store.getState().togglePanelFlow(nodeId)}
        title={`Layout: ${flow === 'row' ? 'horizontal' : 'vertical'} (click to toggle)`}
        className="text-purple-50/80 hover:text-white"
      >
        {flow === 'row' ? <Columns3 className="w-3 h-3" /> : <Rows3 className="w-3 h-3" />}
      </button>
      <button
        onClick={() => store.getState().addSpacer(nodeId)}
        title="Add a spacer (flexible empty cell)"
        className="text-purple-50/80 hover:text-white"
      >
        <SeparatorHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().togglePanelMirror(nodeId)}
        title={mirror ? 'Mirrored — click to un-mirror' : 'Mirror this panel (reverse order, flip icons)'}
        className={mirror ? 'text-amber-200' : 'text-purple-50/80 hover:text-white'}
      >
        <FlipHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().splitPanel(nodeId, 'row')}
        title="Add a panel to the right (split into columns)"
        className="text-purple-50/80 hover:text-white"
      >
        <SplitSquareHorizontal className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().splitPanel(nodeId, 'column')}
        title="Add a panel below (split into rows)"
        className="text-purple-50/80 hover:text-white"
      >
        <SplitSquareVertical className="w-3 h-3" />
      </button>
      <button
        onClick={() => store.getState().removePanel(nodeId)}
        title="Remove this panel (its controls return to the palette)"
        className="text-rose-200/90 hover:text-rose-100"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
};

export const SurfacePanel: React.FC<{ nodeId: NodeId }> = ({ nodeId }) => {
  const { store, surfaceId, registry } = useSurface();
  const node = store((s) => s.layout.nodes[nodeId]) as PanelNode | undefined;
  const design = store((s) => s.designMode);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 });
  const [dockEdge, setDockEdge] = useState<EdgeDir | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBodySize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!node || node.type !== 'panel') return null;
  const pinnedDef = node.pinned ? registry[node.pinned] : null;
  const isPinned = !!node.pinned;
  const padPx = node.padPx ?? 0;

  // Uniform chrome: widget panels match the hardware-card frame so all panel
  // edges read the same; pinned panels stay transparent (host owns its card).
  const chrome = isPinned
    ? 'bg-transparent'
    : `rounded border bg-(--panel) ${design ? 'border-purple-400/60' : 'border-(--panel-border)'}`;
  // Pinned panels host scrollable components and must clip; widget panels stay
  // overflow-visible so a control's bulging readout/number can spill into the
  // (empty) gap instead of being clipped at the panel edge.
  const clip = isPinned ? 'overflow-hidden' : 'overflow-visible';

  // Mirror reverses the visible widget order; the true store index is still
  // passed to each cell so drag-reorder + resize stay correct.
  const widgets = node.widgets;
  const displayIds = node.mirror ? [...widgets].reverse() : widgets;

  // Which edge a dragged panel/row is hovering, for directional docking.
  const computeEdge = (e: React.DragEvent): EdgeDir => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    const dL = x, dR = 1 - x, dT = y, dB = 1 - y;
    const m = Math.min(dL, dR, dT, dB);
    return m === dL ? 'left' : m === dR ? 'right' : m === dT ? 'top' : 'bottom';
  };

  return (
    <div
      className={`relative h-full w-full min-h-0 min-w-0 flex flex-col ${clip} ${chrome}`}
      onDragOver={design ? (e) => { if (!e.dataTransfer.types.includes(PANEL_MIME)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDockEdge(computeEdge(e)); } : undefined}
      onDragLeave={design ? (e) => { e.stopPropagation(); setDockEdge(null); } : undefined}
      onDrop={design ? (e) => { if (!e.dataTransfer.types.includes(PANEL_MIME)) return; const p = decodePanel(e.dataTransfer.getData(PANEL_MIME)); const edge = computeEdge(e); setDockEdge(null); if (!p || p.surfaceId !== surfaceId) return; e.preventDefault(); e.stopPropagation(); store.getState().dockNode(p.panelId, nodeId, edge); } : undefined}
    >
      {design && <PanelHeader nodeId={nodeId} title={node.title} mirror={!!node.mirror} flow={node.flow} padPx={padPx} surfaceId={surfaceId} store={store} />}

      <div
        ref={bodyRef}
        className="relative flex-1 min-h-0 min-w-0 flex"
        style={{ padding: padPx }}
        onDragOver={
          design && !isPinned
            ? (e) => {
                if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            : undefined
        }
        onDrop={
          design && !isPinned
            ? (e) => {
                if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
                const p = decodeWidget(e.dataTransfer.getData(WIDGET_MIME));
                if (!p || p.surfaceId !== surfaceId) return;
                e.preventDefault();
                store.getState().moveWidget(p.widgetId, nodeId, node.widgets.length);
              }
            : undefined
        }
      >
        {pinnedDef ? (
          <div className="flex-1 min-h-0 min-w-0">{pinnedDef.render(bodySize)}</div>
        ) : widgets.length === 0 ? (
          <div className="flex-1 grid place-items-center">
            <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest">
              {design ? 'drop controls here' : ''}
            </span>
          </div>
        ) : (
          <FrGrid
            axis={node.flow}
            ids={displayIds}
            fr={node.widgetFr ?? {}}
            design={design}
            gap={4}
            className="flex-1 min-h-0 min-w-0"
            onResize={(l, r, frac) => store.getState().resizeWidget(nodeId, l, r, frac)}
            renderItem={(wid) => (
              <WidgetCell
                widgetId={wid}
                panelId={nodeId}
                index={widgets.indexOf(wid)}
                design={design}
                justify={node.widgetJustify?.[wid]}
                mirror={node.mirror}
                margins={node.widgetMargins?.[wid]}
              />
            )}
          />
        )}
      </div>
      {design && dockEdge && (
        <div
          className={`pointer-events-none absolute z-50 bg-cyan-400/80 rounded ${
            dockEdge === 'left'
              ? 'left-0 top-0 bottom-0 w-1'
              : dockEdge === 'right'
                ? 'right-0 top-0 bottom-0 w-1'
                : dockEdge === 'top'
                  ? 'top-0 left-0 right-0 h-1'
                  : 'bottom-0 left-0 right-0 h-1'
          }`}
        />
      )}
    </div>
  );
};
