import React, { useRef, useState, useEffect } from "react";
import { RotateCw } from "lucide-react";
import { CanvasState, CanvasTool, UIElement, ElementType, Asset, Texture, CustomParam } from "../types";
import InteractiveControl from "./InteractiveControl";
import CustomCodeFrame from "./CustomCodeFrame";
import { ProcessedImage } from "./canvas/ProcessedImage";
import { drawRulers as drawRulersImpl } from "./canvas/rulers";
import { GridOverlay } from "./canvas/gridOverlay";
import { wheelZoomAtPoint } from "./canvas/viewportMath";
import { useCanvasGestures } from "./canvas/useCanvasGestures";
import { RESIZE_HANDLES } from "./canvas/resizeMath";
import AnnotationLayer, { AnnotationSubTool, ANNOTATION_PALETTE } from "./canvas/AnnotationLayer";
import AnnotationToolbar from "./canvas/AnnotationToolbar";

interface CanvasProps {
  canvasState: CanvasState;
  elements: UIElement[];
  assets: Asset[];
  textures?: Texture[];
  selectedElementIds: string[];
  activeTool: CanvasTool;
  onSetActiveTool: (tool: CanvasTool) => void;
  onUpdateCanvas: (updates: Partial<CanvasState>) => void;
  onDrop: (
    type: ElementType,
    x: number,
    y: number,
    defaultWidth: number,
    defaultHeight: number,
    assetId?: string,
    variant?: string,
    customCode?: string,
    presetData?: any,
  ) => void;
  onUpdateElements: (
    ids: string[],
    updates: Partial<UIElement> | ((el: UIElement) => Partial<UIElement>),
  ) => void;
  onSelectElements: (ids: string[], multi: boolean) => void;
  onContextMenu?: (x: number, y: number, elementId?: string) => void;
  onRegisterParams?: (elementId: string, params: CustomParam[]) => void;
  onParamValueChange?: (
    elementId: string,
    key: string,
    value: number | string | boolean,
  ) => void;
}

// CustomCode rendering (sandboxed iframe + live parameter bridge) lives in
// ./CustomCodeFrame so the theme-var reader and the iframe document builder are
// defined once alongside the postMessage plumbing that drives them.
//
// Canvas is the composition entry. The heavy pieces live in ./canvas/:
//   - rulers.ts             — pure ruler drawing + tick math
//   - useCanvasGestures.ts  — drag / marquee / pan gesture engine + drop handlers
//   - ProcessedImage.tsx    — image element renderer (bg-removal, glow, texture)
//   - gridOverlay.tsx       — fixed grid background overlay

export default function Canvas({
  canvasState,
  elements,
  assets,
  textures = [],
  selectedElementIds,
  activeTool,
  onSetActiveTool,
  onUpdateCanvas,
  onDrop,
  onUpdateElements,
  onSelectElements,
  onContextMenu,
  onRegisterParams,
  onParamValueChange,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topRulerRef = useRef<HTMLCanvasElement>(null);
  const leftRulerRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const rulerRafRef = useRef<number | null>(null);

  // Annotation UI state (per-session; the annotations themselves persist on
  // canvasState and ride the existing autosave).
  const [annSubTool, setAnnSubTool] = useState<AnnotationSubTool>("pen");
  const [annColor, setAnnColor] = useState<string>(ANNOTATION_PALETTE[0]);
  const [annStrokeWidth, setAnnStrokeWidth] = useState(3);

  const {
    canvasRef,
    dragState,
    marquee,
    isPanning,
    resizeState,
    isDraggingOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleCanvasMouseDown,
    handleElementMouseDown,
    handleResizeHandleMouseDown,
  } = useCanvasGestures({
    canvasState,
    elements,
    selectedElementIds,
    activeTool,
    onUpdateCanvas,
    onSelectElements,
    onUpdateElements,
    onDrop,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };

    updateSize();
    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  const drawRulers = React.useCallback(() => {
    drawRulersImpl({
      topCanvas: topRulerRef.current,
      leftCanvas: leftRulerRef.current,
      containerSize,
      mousePos: mousePosRef.current,
      scale: canvasState.scale,
      panX: canvasState.panX,
      panY: canvasState.panY,
      canvasWidth: canvasState.width,
      canvasHeight: canvasState.height,
    });
  }, [
    canvasState.scale,
    canvasState.panX,
    canvasState.panY,
    canvasState.width,
    canvasState.height,
    containerSize,
  ]);

  useEffect(() => {
    drawRulers();
  }, [drawRulers]);

  useEffect(() => {
    return () => {
      if (rulerRafRef.current !== null) {
        cancelAnimationFrame(rulerRafRef.current);
      }
    };
  }, []);

  const handleContainerMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    mousePosRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    if (rulerRafRef.current !== null) {
      cancelAnimationFrame(rulerRafRef.current);
    }
    rulerRafRef.current = requestAnimationFrame(() => {
      rulerRafRef.current = null;
      drawRulers();
    });
  };

  const handleContainerMouseLeave = () => {
    if (rulerRafRef.current !== null) {
      cancelAnimationFrame(rulerRafRef.current);
      rulerRafRef.current = null;
    }
    mousePosRef.current = null;
    drawRulers();
  };

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      const requireCtrl = canvasState.requireCtrlToZoom !== false; // Default to true

      if (!requireCtrl || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        // Cursor-anchored multiplicative zoom; the math lives in
        // viewportMath.ts (pure + unit-tested), this is just the DOM adapter.
        const rect = container.getBoundingClientRect();
        const next = wheelZoomAtPoint({
          scale: canvasState.scale || 1,
          panX: canvasState.panX || 0,
          panY: canvasState.panY || 0,
          cursorX: e.clientX - rect.left - rect.width / 2,
          cursorY: e.clientY - rect.top - rect.height / 2,
          deltaY: e.deltaY,
        });
        if (next) onUpdateCanvas(next);
      } else {
        // Pan with wheel if we don't require ctrl to zoom
        e.preventDefault();
        onUpdateCanvas({
          panX: (canvasState.panX || 0) - e.deltaX,
          panY: (canvasState.panY || 0) - e.deltaY,
        });
      }
    };
    const container = containerRef.current;
    if (container) {
      container.addEventListener("wheel", handleWheel, { passive: false });
    }
    return () => {
      if (container) {
        container.removeEventListener("wheel", handleWheel);
      }
    };
  }, [
    canvasState.scale,
    canvasState.panX,
    canvasState.panY,
    canvasState.requireCtrlToZoom,
    onUpdateCanvas,
  ]);

  const renderElement = (el: UIElement, index: number = 0) => {
    const isPreview = !!canvasState.isPreviewMode;
    const isSelected = !isPreview && selectedElementIds.includes(el.id);
    const children = elements.filter((c) => c.groupId === el.id);
    const asset = assets.find((a) => a.id === el.assetId);

    let cornerRadiusStyle: string | undefined;
    const roundedClass = (() => {
      const variant = el.variant;
      if (el.type === "Knob")
        return variant === "Brutalist" ? "rounded-none" : "rounded-full";
      if (el.type === "Spatial3D") return "rounded-full";
      if (el.type === "Toggle") return "rounded-full";
      if (el.type === "Button" && variant === "Brutalist")
        return "rounded-none";
      if (el.type === "Meter" && variant === "VU Meter") return "rounded";
      if (el.cornerRadius) {
        cornerRadiusStyle = `${el.cornerRadius}px`;
        return "";
      }
      return "rounded";
    })();

    return (
      <div
        key={el.id}
        data-element-id={el.id}
        style={{
          position: "absolute",
          left: el.x,
          top: el.y,
          width: el.width,
          height: el.height,
          transform: `rotate(${el.rotation || 0}deg)`,
          transformOrigin: "center center",
          zIndex: dragState?.isDragging && isSelected ? 1000 + index : index, // Keeps on top only while dragging
          mixBlendMode: (el.type === "Image" && el.blendMode) ? (el.blendMode as any) : undefined,
          borderRadius: cornerRadiusStyle,
        }}
        onMouseDown={(e) => handleElementMouseDown(e, el.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-vst-texture")) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onDrop={(e) => {
          const texDataStr = e.dataTransfer.getData(
            "application/x-vst-texture",
          );
          if (texDataStr) {
            e.preventDefault();
            e.stopPropagation();
            try {
              const texData = JSON.parse(texDataStr);
              onUpdateElements([el.id], { textureId: texData.id });
            } catch (err) {
              console.error(
                "Failed to parse texture drop payload",
                err,
              );
            }
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onContextMenu && !isPreview) {
            const rect = (
              e.currentTarget as HTMLElement
            ).getBoundingClientRect();
            onContextMenu(rect.right + 10, rect.top, el.id);
          }
        }}
        className={`group outline-none select-none flex flex-col ${roundedClass} ${
          isSelected
            ? "ring-2 ring-app-main"
            : isPreview
              ? ""
              : "ring-1 ring-transparent hover:ring-white/50"
        } ${dragState?.isDragging && isSelected ? (el.isLocked ? "" : "cursor-grabbing") : isPreview ? "" : el.isLocked ? "" : "cursor-grab"}`}
      >
        {isSelected && selectedElementIds.length === 1 && !isPreview && (
          <div
            className="absolute -top-6 left-0 bg-app-main text-app-base text-[10px] font-bold px-1.5 py-0.5 rounded shadow whitespace-nowrap"
            style={{
              transform: `rotate(${-(el.rotation || 0)}deg)`,
              transformOrigin: "bottom left",
            }}
          >
            {el.name} ({el.type})
          </div>
        )}

        {/* Render logic based on type */}
        <div
          className="w-full h-full relative pointer-events-none"
          style={{
            opacity:
              el.type === "Image" || el.type === "Group"
                ? (el.opacity ?? 100) / 100
                : 1,
          }}
        >
          {el.type === "Image" && asset ? (
            <ProcessedImage
              el={el}
              asset={asset}
              texture={textures.find((a) => a.id === el.textureId)}
            />
          ) : el.type === "Group" ? (
            <div
              className={`w-full h-full border-2 ${isPreview ? "border-transparent" : "border-dashed border-white/20"} rounded pointer-events-none relative`}
            >
              {children.map((child, childIdx) =>
                renderElement(child, childIdx),
              )}
            </div>
          ) : el.type === "CustomCode" ? (
            <CustomCodeFrame
              el={el}
              isPreview={isPreview}
              textureUrl={textures.find((a) => a.id === el.textureId)?.url}
              onRegisterParams={onRegisterParams}
              onParamValueChange={onParamValueChange}
            />
          ) : (
            <div
              className={`w-full h-full flex flex-col items-center justify-center ${isPreview ? "pointer-events-auto" : "pointer-events-none"}`}
            >
              <InteractiveControl
                el={el}
                isPreview={isPreview}
                textureUrl={textures.find((a) => a.id === el.textureId)?.url}
                onUpdateElements={onUpdateElements}
              />
            </div>
          )}

          {el.type === "Group" && el.textureId && (
            <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-[inherit]" style={{ mixBlendMode: (el.textureBlendMode as any) || "normal" }}>
              <div
                className="w-full h-full origin-center"
                style={{
                  backgroundImage: `url(${textures.find((a) => a.id === el.textureId)?.url})`,
                  backgroundSize: el.textureSize || "cover",
                  backgroundPosition: `calc(50% + ${el.textureOffsetX || 0}px) calc(50% + ${el.textureOffsetY || 0}px)`,
                  backgroundRepeat: el.textureRepeat || "no-repeat",
                  opacity: (el.textureOpacity ?? 100) / 100,
                  transform: `scale(${(el.textureScale ?? 100) / 100}) rotate(${el.textureRotation || 0}deg)`,
                }}
              />
            </div>
          )}
        </div>

        {/* Rotation indicator in edit mode for knobs */}
        {!isPreview && el.type === "Knob" && (
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -mt-4 w-px h-4 bg-app-main/50 pointer-events-none flex flex-col items-center">
            <div
              className="w-1.5 h-1.5 rounded-full border border-app-main bg-app-base absolute -top-1"
              title="0° Point"
            />
          </div>
        )}

        {/* Selection chrome: rotate handle + 8 resize handles. Rendered only
            for a single, unlocked, non-preview selection. All handle sizes and
            offsets are divided by the canvas scale so they stay a constant
            on-screen size at any zoom. The actual resize gesture lives in
            useCanvasGestures (handleResizeHandleMouseDown). */}
        {isSelected &&
          selectedElementIds.length === 1 &&
          !el.isLocked &&
          !isPreview && (
            <>
              {/* Rotate handle */}
              <div
                className="absolute -top-6 left-1/2 -translate-x-1/2 w-5 h-5 bg-app-surface border border-app-main text-app-main rounded-full cursor-pointer flex items-center justify-center pointer-events-auto z-20 shadow-md hover:bg-app-main hover:text-app-base transition-colors"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  const rect = (
                    e.currentTarget.parentElement as HTMLElement
                  ).getBoundingClientRect();
                  const centerX = rect.left + rect.width / 2;
                  const centerY = rect.top + rect.height / 2;

                  const onMouseMove = (moveEvent: MouseEvent) => {
                    const dx = moveEvent.clientX - centerX;
                    const dy = moveEvent.clientY - centerY;
                    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
                    angle = (angle + 90) % 360; // Offset because handle is at top
                    if (moveEvent.shiftKey) {
                      // 15 degree increments
                      angle = Math.round(angle / 15) * 15;
                    }
                    if (angle < 0) angle += 360;
                    onUpdateElements([el.id], { rotation: Math.round(angle) });
                  };

                  const onMouseUp = () => {
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                  };

                  window.addEventListener("mousemove", onMouseMove);
                  window.addEventListener("mouseup", onMouseUp);
                }}
              >
                <RotateCw className="w-3 h-3" />
              </div>
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-px h-4 bg-app-main pointer-events-none" />

              {/* Resize handles: 4 corners + 4 edge midpoints */}
              {(() => {
                const handleScale = canvasState.scale || 1;
                const handleSize = 8 / handleScale;
                const handleHalf = handleSize / 2;
                return RESIZE_HANDLES.map((h) => (
                  <div
                    key={h.handle}
                    className="absolute bg-app-main border border-app-base pointer-events-auto z-20"
                    style={{
                      left: el.width * h.ux - handleHalf,
                      top: el.height * h.uy - handleHalf,
                      width: handleSize,
                      height: handleSize,
                      borderWidth: 1 / handleScale,
                      cursor: h.cursor,
                    }}
                    onMouseDown={(e) =>
                      handleResizeHandleMouseDown(e, el.id, h.handle)
                    }
                  />
                ));
              })()}
            </>
          )}
      </div>
    );
  };

  const rootElements = elements.filter((el) => !el.groupId);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          onUpdateCanvas({
            backgroundImage: event.target?.result as string,
            width: img.width,
            height: img.height,
            scale: 1, // Reset scale when new image is loaded
            panX: 0,
            panY: 0,
          });
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Only trigger upload if clicking directly on the empty canvas background (not on an element)
    if (!canvasState.backgroundImage && e.target === canvasRef.current) {
      fileInputRef.current?.click();
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={handleContainerMouseLeave}
      className={`flex-1 min-w-0 min-h-0 bg-[#020202] shadow-[inset_0_0_100px_rgba(0,0,0,0.9)] overflow-hidden flex relative ${activeTool === "pan" ? "cursor-grab active:cursor-grabbing" : ""}`}
      onMouseDown={handleCanvasMouseDown}
    >
      <style>{`
        @keyframes slow-breath {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
        @keyframes neon-flicker {
          0%, 18%, 22%, 25%, 53%, 57%, 100% { opacity: 1; filter: brightness(1); }
          20%, 24%, 55% { opacity: 0.35; filter: brightness(0.75); }
        }
        @keyframes bob-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        .animate-slow-breath {
          animation: slow-breath 3.5s ease-in-out infinite;
        }
        .animate-neon-flicker {
          animation: neon-flicker 2.1s linear infinite;
        }
        .animate-bob-float {
          animation: bob-float 3s ease-in-out infinite;
        }
      `}</style>
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        className="hidden"
        onChange={handleImageUpload}
      />
      {/* Toolbar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-app-base border border-app-border rounded-lg p-2 shadow-xl z-50 flex gap-2">
        <button
          onClick={() => onSetActiveTool("select")}
          className={`px-3 py-1 text-xs rounded transition-colors ${activeTool === "select" ? "btn-3d text-white" : "text-app-muted hover:bg-app-surface"}`}
          title="Select elements (V)"
        >
          Select (V)
        </button>
        <button
          onClick={() => onSetActiveTool("pan")}
          className={`px-3 py-1 text-xs rounded transition-colors ${activeTool === "pan" ? "btn-3d text-white" : "text-app-muted hover:bg-app-surface"}`}
          title="Pan canvas (H or Spacebar)"
        >
          Pan (H)
        </button>
        <button
          onClick={() => onSetActiveTool(activeTool === "annotate" ? "select" : "annotate")}
          className={`px-3 py-1 text-xs rounded transition-colors ${activeTool === "annotate" ? "btn-3d text-white" : "text-app-muted hover:bg-app-surface"}`}
          title="Draw annotations the AI assistant can see — freehand or shapes; colors can map to element types via the legend"
        >
          Annotate
        </button>
        <div className="w-px bg-app-surface-hover mx-1" />
        <button
          onClick={() =>
            onUpdateCanvas({
              scale: Math.max(0.1, (canvasState.scale || 1) - 0.1),
            })
          }
          className="px-2 py-1 text-xs text-app-muted hover:bg-app-surface rounded transition-colors"
          title="Zoom out"
        >
          -
        </button>
        <div
          className="px-2 py-1 text-xs text-app-main min-w-15 text-center font-mono"
          title="Current zoom level"
        >
          {Math.round((canvasState.scale || 1) * 100)}%
        </div>
        <button
          onClick={() =>
            onUpdateCanvas({
              scale: Math.min(3, (canvasState.scale || 1) + 0.1),
            })
          }
          className="px-2 py-1 text-xs text-app-muted hover:bg-app-surface rounded transition-colors"
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => onUpdateCanvas({ scale: 1, panX: 0, panY: 0 })}
          className="px-3 py-1 text-xs text-app-muted hover:bg-app-surface rounded transition-colors ml-1"
          title="Reset zoom and pan"
        >
          Reset
        </button>
        <div className="w-px bg-app-surface-hover mx-1" />
        <label
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-app-muted hover:text-white cursor-pointer transition-colors"
          title="Require holding Ctrl/Cmd to scroll-zoom the canvas"
        >
          <input
            type="checkbox"
            checked={canvasState.requireCtrlToZoom !== false}
            onChange={(e) =>
              onUpdateCanvas({ requireCtrlToZoom: e.target.checked })
            }
            className="rounded border-app-border bg-app-base"
          />
          Require Ctrl to Zoom
        </label>
        <div className="w-px bg-app-surface-hover mx-1" />
        <label
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-app-muted hover:text-white cursor-pointer transition-colors"
          title="Toggle the visual alignment rulers"
        >
          <input
            type="checkbox"
            checked={canvasState.showRulers !== false}
            onChange={(e) =>
              onUpdateCanvas({ showRulers: e.target.checked })
            }
            className="rounded border-app-border bg-app-base text-app-main focus:ring-app-main"
          />
          Show Rulers
        </label>
      </div>

      {/* Scalable & Pannable Area */}
      <div className="absolute inset-0 overflow-visible origin-center pointer-events-none flex items-center justify-center">
        <div
          style={{
            transform: `translate(${canvasState.panX || 0}px, ${canvasState.panY || 0}px) scale(${canvasState.scale || 1})`,
            transition:
              isPanning || dragState?.isDragging || resizeState?.isResizing
                ? "none"
                : "transform 0.1s ease-out",
          }}
          className="pointer-events-auto"
        >
          <div
            ref={canvasRef}
            data-vst-canvas="root"
            onClick={handleCanvasClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onMouseDown={handleCanvasMouseDown}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onContextMenu && !canvasState.isPreviewMode)
                onContextMenu(e.clientX, e.clientY);
            }}
            className={`relative shadow-2xl overflow-visible transition-colors ${!canvasState.backgroundImage ? "cursor-pointer hover:bg-app-surface/60" : ""} ${
              isDraggingOver ? "ring-2 ring-app-main bg-app-surface/50" : ""
            }`}
            style={{
              width: canvasState.width,
              height: canvasState.height,
              backgroundColor: canvasState.backgroundImage
                ? "transparent"
                : "#1a1a1a",
              backgroundImage: canvasState.backgroundImage
                ? `url(${canvasState.backgroundImage})`
                : "none",
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }}
          >
            {!canvasState.backgroundImage && elements.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-app-muted pointer-events-none text-sm">
                Upload a background image and drag components here
              </div>
            )}

            {/* Smart Snap Guides */}
            {dragState?.guides?.map((guide, i) => (
              <div
                key={`guide-${i}`}
                className={`absolute bg-fuchsia-500 z-50 ${guide.type === "x" ? "w-px h-500 -top-250 -translate-x-[0.5px]" : "h-px w-500 -left-250 -translate-y-[0.5px]"}`}
                style={{
                  left: guide.type === "x" ? guide.pos : 0,
                  top: guide.type === "y" ? guide.pos : 0,
                  pointerEvents: "none",
                }}
              />
            ))}

            {rootElements.map((el, i) => renderElement(el, i))}

            {/* User annotations — canvas-space overlay the assistant can see */}
            <AnnotationLayer
              canvasState={canvasState}
              active={activeTool === "annotate" && !canvasState.isPreviewMode}
              subTool={annSubTool}
              color={annColor}
              strokeWidth={annStrokeWidth}
              onUpdateCanvas={onUpdateCanvas}
            />

            {/* Marquee Selection Box */}
            {marquee && !canvasState.isPreviewMode && (
              <div
                className="absolute bg-app-main/20 border border-app-main pointer-events-none z-50"
                style={{
                  left: Math.min(marquee.startX, marquee.currentX),
                  top: Math.min(marquee.startY, marquee.currentY),
                  width: Math.abs(marquee.currentX - marquee.startX),
                  height: Math.abs(marquee.currentY - marquee.startY),
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Annotation sub-toolbar (only in annotate mode) */}
      {activeTool === "annotate" && !canvasState.isPreviewMode && (
        <AnnotationToolbar
          canvasState={canvasState}
          subTool={annSubTool}
          color={annColor}
          strokeWidth={annStrokeWidth}
          onSetSubTool={setAnnSubTool}
          onSetColor={setAnnColor}
          onSetStrokeWidth={setAnnStrokeWidth}
          onUpdateCanvas={onUpdateCanvas}
        />
      )}

      {/* Grid overlay — anchored to the canvas's on-screen rect so its lines
          land exactly on the canvas-space grid the snap logic rounds to.
          Animation gating mirrors the pannable wrapper's transform transition. */}
      <GridOverlay
        canvasState={canvasState}
        containerSize={containerSize}
        animate={
          !(isPanning || dragState?.isDragging || resizeState?.isResizing)
        }
      />

      {/* Visual Rulers */}
      {canvasState.showRulers !== false && (
        <>
          <canvas
            ref={topRulerRef}
            className="absolute top-0 left-0 h-6 w-full pointer-events-none z-30"
          />
          <canvas
            ref={leftRulerRef}
            className="absolute top-0 left-0 w-6 h-full pointer-events-none z-30"
          />
          <div
            className="absolute top-0 left-0 w-6 h-6 bg-[#09090b] border-r border-b border-[#27272a] z-40 flex items-center justify-center select-none"
          >
            <span className="text-[9px] font-mono font-bold text-zinc-500">px</span>
          </div>
        </>
      )}
    </div>
  );
}
