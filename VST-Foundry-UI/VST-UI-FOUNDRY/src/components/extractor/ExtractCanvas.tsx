import React, { useState, useRef } from "react";
import { ExtractedElement } from "../../lib/extractor/types";
import { X, Loader2 } from "lucide-react";

interface ExtractCanvasProps {
  imageUrl: string;
  onLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  elements: ExtractedElement[];
  onDrawBox: (xmin: number, ymin: number, xmax: number, ymax: number, lassoPoints?: {x: number, y: number}[]) => void;
  onDeleteElement?: (id: string) => void;
  lassoMode?: boolean;
}

export default function ExtractCanvas({ imageUrl, onLoad, elements, onDrawBox, onDeleteElement, lassoMode }: ExtractCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [isLasso, setIsLasso] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });
  const [lassoPoints, setLassoPoints] = useState<{x: number, y: number}[]>([]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    
    // Get mouse position relative to the container
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setStartPos({ x, y });
    setCurrentPos({ x, y });
    
    if (e.altKey || lassoMode) {
      setIsLasso(true);
      setLassoPoints([{x, y}]);
    } else {
      setIsLasso(false);
      setLassoPoints([]);
    }
    
    setIsDrawing(true);
    
    // Capture pointer events so dragging outside doesn't break
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    
    setCurrentPos({ x, y });
    
    if (isLasso) {
      setLassoPoints(prev => [...prev, {x, y}]);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing || !containerRef.current) return;
    setIsDrawing(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    const rect = containerRef.current.getBoundingClientRect();
    
    if (isLasso && lassoPoints.length > 2) {
      // Calculate bounds from lasso
      const xs = lassoPoints.map(p => p.x);
      const ys = lassoPoints.map(p => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      
      if (maxX - minX > 5 && maxY - minY > 5) {
        onDrawBox(
          minX / rect.width,
          minY / rect.height,
          maxX / rect.width,
          maxY / rect.height,
          lassoPoints.map(p => ({ x: p.x / rect.width, y: p.y / rect.height }))
        );
      }
    } else {
      const minX = Math.min(startPos.x, currentPos.x);
      const maxX = Math.max(startPos.x, currentPos.x);
      const minY = Math.min(startPos.y, currentPos.y);
      const maxY = Math.max(startPos.y, currentPos.y);
      
      if (maxX - minX > 5 && maxY - minY > 5) {
        onDrawBox(
          minX / rect.width,
          minY / rect.height,
          maxX / rect.width,
          maxY / rect.height
        );
      }
    }
    
    setLassoPoints([]);
    setIsLasso(false);
  };

  return (
    <div className="relative shadow-2xl inline-block max-w-full max-h-full">
      <div 
        ref={containerRef}
        className="relative select-none cursor-crosshair touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img 
          src={imageUrl} 
          alt="Canvas target" 
          onLoad={onLoad} 
          className="max-w-full max-h-[80vh] object-contain pointer-events-none block"
          draggable={false}
        />

        {/* Existing Elements */}
        {elements.map((el) => {
          const widthStr = `${(el.xmax - el.xmin) * 100}%`;
          const heightStr = `${(el.ymax - el.ymin) * 100}%`;
          const leftStr = `${el.xmin * 100}%`;
          const topStr = `${el.ymin * 100}%`;

          const isProcessing = el.status === 'processing';
          const currentImg = 
              el.displayMode === "mask" && el.maskDataUrl ? el.maskDataUrl :
              el.displayMode === "cutout" && el.cutoutDataUrl ? el.cutoutDataUrl : 
              null;

          return (
            <div 
              key={el.id}
              className={`absolute pointer-events-auto transition-colors group ${!currentImg && !isProcessing ? 'border-2 border-blue-500 bg-blue-500/10 hover:bg-blue-500/20' : ''} ${isProcessing ? 'border-2 border-dashed border-purple-500 bg-purple-500/10' : ''}`}
              style={{
                left: leftStr,
                top: topStr,
                width: widthStr,
                height: heightStr,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {currentImg && !isProcessing && (
                <img 
                   src={currentImg} 
                   alt={el.label} 
                   className="w-full h-full object-fill drop-shadow-[0_0_5px_rgba(59,130,246,0.8)] opacity-90 hover:opacity-100 transition-opacity" 
                />
              )}

              {isProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-app-surface/50 backdrop-blur-sm">
                  <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                </div>
              )}
              
              <div className={`absolute -top-6 left-0 bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded shadow whitespace-nowrap overflow-hidden text-ellipsis max-w-full font-medium z-10 ${currentImg && !isProcessing ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''} ${isProcessing ? 'bg-purple-600' : ''}`}>
                {isProcessing ? 'Processing...' : el.label}
              </div>

              {onDeleteElement && (
                <button
                  type="button"
                  aria-label={"Delete " + el.label}
                  onClick={(e) => { e.stopPropagation(); onDeleteElement(el.id); }}
                  className="absolute -top-6 -right-6 bg-red-500 hover:bg-red-400 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-md"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Active Drawing Box / Lasso */}
        {isDrawing && (
          isLasso ? (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 50 }}>
              <polyline 
                points={lassoPoints.map(p => `${p.x},${p.y}`).join(' ')} 
                fill="rgba(255, 255, 255, 0.2)"
                stroke="white" 
                strokeWidth="2"
                strokeDasharray="4"
              />
            </svg>
          ) : (
            <div 
              className="absolute border-2 border-dashed border-white bg-white/10 pointer-events-none"
              style={{
                left: Math.min(startPos.x, currentPos.x),
                top: Math.min(startPos.y, currentPos.y),
                width: Math.abs(currentPos.x - startPos.x),
                height: Math.abs(currentPos.y - startPos.y),
              }}
            />
          )
        )}
      </div>
    </div>
  );
}
