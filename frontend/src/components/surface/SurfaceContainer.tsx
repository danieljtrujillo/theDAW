/**
 * Recursive row/column renderer for a container node, plus the `SurfaceNode`
 * dispatcher that picks container vs panel. Each child sits in a `ContainerCell`
 * that is a PANEL_MIME drop target, so dragging a panel header onto a child
 * reorders/moves that panel into this container at the child's index (works
 * across containers because the store's `reorderPanel` accepts any target).
 */
import React, { useState } from 'react';
import { GripVertical } from 'lucide-react';
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

  return (
    <div className="relative h-full w-full min-h-0 min-w-0">
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
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(PANEL_MIME, encode({ surfaceId, panelId: nodeId }));
          }}
          title="Drag this row/column to dock it elsewhere"
          className="absolute bottom-0 right-0 z-50 h-3 w-3 grid place-items-center rounded-tl bg-cyan-600/85 hover:bg-cyan-500 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="w-2 h-2 text-cyan-50" />
        </div>
      )}
    </div>
  );
};
