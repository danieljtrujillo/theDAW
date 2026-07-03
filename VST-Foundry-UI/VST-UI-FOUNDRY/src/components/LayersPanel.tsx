import React, { useState } from 'react';
import { UIElement, Asset } from '../types';
import { GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import CollapsiblePanel from './CollapsiblePanel';

interface LayersPanelProps {
  elements: UIElement[];
  selectedElementIds: string[];
  onSelectElement: (id: string, multi: boolean) => void;
  onReorder: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  onReorderTo?: (id: string, newIndex: number) => void;
  // For Image-layer thumbnails; rows fall back to a type initial without it.
  assets?: Asset[];
}

export default function LayersPanel({ elements, selectedElementIds, onSelectElement, onReorder, onReorderTo, assets = [] }: LayersPanelProps) {
  // Render in reverse so top elements appear at the top of the list
  const reversedElements = [...elements].reverse();
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId || !onReorderTo) {
      setDraggedId(null);
      return;
    }

    const sourceIndex = elements.findIndex(el => el.id === draggedId);
    const targetIndex = elements.findIndex(el => el.id === targetId);

    if (sourceIndex !== -1 && targetIndex !== -1) {
      onReorderTo(draggedId, targetIndex);
    }
    setDraggedId(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
  };

  return (
    <CollapsiblePanel title="Layers" defaultOpen={true} flex1={true} extraHeader={<span className="text-xs text-app-muted font-normal">{elements.length} items</span>}>
      <div className="p-2 space-y-1">
        {reversedElements.length === 0 && (
          <div className="text-center text-xs text-app-muted py-4">No layers</div>
        )}
        {reversedElements.map((el) => {
          const isSelected = selectedElementIds.includes(el.id);
          const index = elements.findIndex(e => e.id === el.id);
          const isDragging = draggedId === el.id;
          // Image layers show their asset as a thumbnail so rows are
          // tellable-apart at a glance; other types show a type initial.
          const thumbUrl = el.type === 'Image' && el.assetId
            ? assets.find(a => a.id === el.assetId)?.url
            : undefined;
          
          return (
            <div
              key={el.id}
              draggable
              onDragStart={(e) => handleDragStart(e, el.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, el.id)}
              onDragEnd={handleDragEnd}
              onClick={(e) => onSelectElement(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              className={`group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-all text-sm ${
                isSelected ? 'bg-[#2a2a2a] text-app-main border border-app-main/30 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]' : 'text-app-main hover:bg-app-surface border border-transparent'
              } ${isDragging ? 'opacity-50 border-dashed border-app-border' : ''}`}
            >
              <GripVertical className="w-3.5 h-3.5 text-app-muted group-hover:text-app-main cursor-grab active:cursor-grabbing" />
              <div className="w-6 h-6 shrink-0 rounded-sm border border-app-border bg-app-base flex items-center justify-center overflow-hidden select-none">
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    alt=""
                    className="max-w-full max-h-full object-contain pointer-events-none"
                  />
                ) : (
                  <span className="text-[8px] text-app-muted font-mono uppercase">
                    {el.type.slice(0, 2)}
                  </span>
                )}
              </div>
              <div className="flex-1 truncate select-none">
                {el.name} <span className="text-app-muted text-xs ml-1">({el.type})</span>
              </div>
              
              <div className="flex items-center gap-2">
                <span 
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono select-none whitespace-nowrap border transition-colors ${
                    elements.length > 1 && index === elements.length - 1
                      ? 'bg-purple-950/30 border-purple-800/40 text-purple-400'
                      : elements.length > 1 && index === 0
                        ? 'bg-zinc-950/60 border-zinc-900 text-zinc-500'
                        : 'bg-zinc-950/40 border-zinc-800/50 text-zinc-400'
                  }`}
                  title={`Stacking order (z-index): ${index}. Higher values render on top.`}
                >
                  {elements.length > 1 && index === elements.length - 1
                    ? `z-${index} (top)`
                    : elements.length > 1 && index === 0
                      ? `z-${index} (base)`
                      : `z-${index}`}
                </span>

                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'up'); }}
                    disabled={index === elements.length - 1}
                    className="p-1 hover:text-white disabled:opacity-30"
                    title="Move Layer Up"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'down'); }}
                    disabled={index === 0}
                    className="p-1 hover:text-white disabled:opacity-30"
                    title="Move Layer Down"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </CollapsiblePanel>
  );
}
