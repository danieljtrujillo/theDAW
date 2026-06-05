/**
 * Recursive row/column renderer for a container node, plus the `SurfaceNode`
 * dispatcher that picks container vs panel. Each child sits in a `ContainerCell`
 * that is a PANEL_MIME drop target, so dragging a panel header onto a child
 * reorders/moves that panel into this container at the child's index (works
 * across containers because the store's `reorderPanel` accepts any target).
 */
import React, { useState } from 'react';
import { GripVertical, Rows3, Columns3, Square, SquareDashedBottom } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { FrGrid } from './FrGrid';
import { SurfacePanel } from './SurfacePanel';
import { PANEL_MIME, encode, decodePanel } from './dnd';
import { useLayoutPrefs } from '../../state/layoutPrefsStore';
import type { ContainerNode, NodeId, SurfaceStoreApi } from '../../state/surfaceLayoutStore';

const ContainerCell: React.FC<{
  containerId: NodeId;
  index: number;
  design: boolean;
  surfaceId: string;
  store: SurfaceStoreApi;
  children: React.ReactNode;
}> = ({ containerId, index, design, surfaceId, store, children }) => {
  const [over, setOver] = useState(false);
  const accept = (e: React.DragEvent) => design && e.dataTransfer.types.includes(PANEL_MIME);
  return (
    <div
      className={`relative min-w-0 min-h-0 grid ${over ? 'ring-2 ring-inset ring-cyan-300/70 rounded' : ''}`}
      onDragOver={
        design
          ? (e) => {
              if (!accept(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOver(true);
            }
          : undefined
      }
      onDragLeave={design ? () => setOver(false) : undefined}
      onDrop={
        design
          ? (e) => {
              setOver(false);
              if (!accept(e)) return;
              const p = decodePanel(e.dataTransfer.getData(PANEL_MIME));
              if (!p || p.surfaceId !== surfaceId) return;
              e.preventDefault();
              e.stopPropagation();
              store.getState().reorderPanel(p.panelId, containerId, index);
            }
          : undefined
      }
    >
      {children}
    </div>
  );
};

export const SurfaceNode: React.FC<{ nodeId: NodeId }> = ({ nodeId }) => {
  const { store } = useSurface();
  const type = store((s) => s.layout.nodes[nodeId]?.type);
  if (!type) return null;
  return type === 'container' ? <SurfaceContainer nodeId={nodeId} /> : <SurfacePanel nodeId={nodeId} />;
};

export const SurfaceContainer: React.FC<{ nodeId: NodeId }> = ({ nodeId }) => {
  const { store, surfaceId } = useSurface();
  const node = store((s) => s.layout.nodes[nodeId]) as ContainerNode | undefined;
  const design = store((s) => s.designMode);
  const gapPx = useLayoutPrefs((s) => s.gapPx);
  if (!node || node.type !== 'container') return null;

  // A framed region draws one border + filled background spanning the whole
  // cell, with a little inner padding so controls float inside it. Leaf panels
  // stay transparent so the region reads as a single box, not a grid of boxes.
  const framed = !!node.framed;
  const frameChrome = framed
    ? `rounded-md border bg-(--panel) p-1 ${design ? 'border-purple-400/50' : 'border-(--panel-border)'}`
    : '';

  return (
    <div className={`relative h-full w-full min-h-0 min-w-0 ${frameChrome}`}>
      <FrGrid
        axis={node.axis}
        ids={node.children}
        fr={node.fr}
        design={design}
        gap={gapPx}
        className="h-full w-full min-h-0 min-w-0"
        onResize={(l, r, frac) => store.getState().resize(nodeId, l, r, frac)}
        renderItem={(childId, index) => (
          <ContainerCell
            containerId={nodeId}
            index={index}
            design={design}
            surfaceId={surfaceId}
            store={store}
          >
            <SurfaceNode nodeId={childId} />
          </ContainerCell>
        )}
      />
      {design && (
        <div className="absolute bottom-0 right-0 z-50 flex items-center gap-px">
          <button
            onClick={() => store.getState().toggleContainerFramed(nodeId)}
            title={framed ? 'Region frame ON — click to remove the border/background' : 'Add a region frame (border + filled background) around this group'}
            className={`h-3 w-3 grid place-items-center rounded-t ${framed ? 'bg-amber-500/90 text-amber-50' : 'bg-cyan-800/85 hover:bg-cyan-600 text-cyan-50'}`}
          >
            {framed ? <Square className="w-2 h-2" /> : <SquareDashedBottom className="w-2 h-2" />}
          </button>
          <button
            onClick={() => store.getState().toggleContainerAxis(nodeId)}
            title={`This row/column is ${node.axis === 'row' ? 'horizontal' : 'vertical'} — click to flip`}
            className="h-3 w-3 grid place-items-center rounded-t bg-cyan-700/85 hover:bg-cyan-500 text-cyan-50"
          >
            {node.axis === 'row' ? <Columns3 className="w-2 h-2" /> : <Rows3 className="w-2 h-2" />}
          </button>
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(PANEL_MIME, encode({ surfaceId, panelId: nodeId }));
            }}
            title="Drag this row/column to dock it elsewhere"
            className="h-3 w-3 grid place-items-center rounded-tl bg-cyan-600/85 hover:bg-cyan-500 cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="w-2 h-2 text-cyan-50" />
          </div>
        </div>
      )}
    </div>
  );
};
