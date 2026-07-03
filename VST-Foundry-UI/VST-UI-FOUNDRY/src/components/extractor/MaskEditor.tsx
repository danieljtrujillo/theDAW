import React, { useRef, useEffect, useState } from "react";
import { X, Check, MousePointer2, Eraser } from "lucide-react";

interface MaskEditorProps {
  imageUrl: string;
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}

export default function MaskEditor({ imageUrl, onSave, onCancel }: MaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [brushSize, setBrushSize] = useState(10);

  const imgRef = useRef<HTMLImageElement>(null);

  // We keep a separate mask canvas
  const maskCanvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;

      const canvas = canvasRef.current;
      const maskCanvas = maskCanvasRef.current;
      if (!canvas) return;

      canvas.width = img.width;
      canvas.height = img.height;
      maskCanvas.width = img.width;
      maskCanvas.height = img.height;

      // Initialize mask canvas to fully white (fully opaque)
      const maskCtx = maskCanvas.getContext("2d");
      if (maskCtx) {
        maskCtx.fillStyle = "white";
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      }

      renderCanvas();
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const renderCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const img = imgRef.current;
    const maskCanvas = maskCanvasRef.current;

    if (!canvas || !ctx || !img) return;

    // Clear main canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw original image
    ctx.drawImage(img, 0, 0);

    // Apply mask (destination-in means keep pixels where mask is opaque)
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0);

    // Reset composite operation
    ctx.globalCompositeOperation = "source-over";
  };

  const getCoordinates = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    draw(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    draw(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDrawing(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;

    const { x, y } = getCoordinates(e);

    maskCtx.globalCompositeOperation = mode === "add" ? "source-over" : "destination-out";
    maskCtx.beginPath();
    maskCtx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    maskCtx.fillStyle = mode === "add" ? "white" : "rgba(0,0,0,1)";
    maskCtx.fill();

    renderCanvas();
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      onSave(canvas.toDataURL("image/png"));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-60 p-4">
      <div className="bg-app-base rounded-xl shadow-2xl overflow-hidden flex flex-col max-w-4xl w-full max-h-[90vh]">
        <div className="h-14 border-b border-app-border bg-app-surface flex items-center justify-between px-4 shrink-0">
          <h2 className="font-semibold text-app-main">Mask Assist</h2>
          <button
            type="button"
            aria-label="Close mask editor"
            onClick={onCancel}
            className="text-app-muted hover:text-app-main p-1 rounded-md hover:bg-app-surface-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Toolbar */}
          <div className="w-48 border-r border-app-border p-4 flex flex-col gap-6 bg-app-surface/50 overflow-y-auto">
            <div className="space-y-3">
              <span className="text-xs font-semibold text-app-muted uppercase tracking-wider">Tool</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={mode === "add"}
                  onClick={() => setMode("add")}
                  className={`flex-1 flex flex-col items-center justify-center gap-2 py-3 rounded-lg border transition-colors ${mode === "add" ? "border-blue-500 bg-blue-500/10 text-blue-400" : "border-app-border bg-app-surface/50 text-app-muted hover:bg-app-surface-hover"}`}
                >
                  <MousePointer2 className="w-5 h-5" />
                  <span className="text-xs font-medium">Add</span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "remove"}
                  onClick={() => setMode("remove")}
                  className={`flex-1 flex flex-col items-center justify-center gap-2 py-3 rounded-lg border transition-colors ${mode === "remove" ? "border-blue-500 bg-blue-500/10 text-blue-400" : "border-app-border bg-app-surface/50 text-app-muted hover:bg-app-surface-hover"}`}
                >
                  <Eraser className="w-5 h-5" />
                  <span className="text-xs font-medium">Remove</span>
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <label htmlFor="extract-mask-brush" className="text-xs font-semibold text-app-muted uppercase tracking-wider">Brush Size ({brushSize}px)</label>
              <input
                id="extract-mask-brush"
                name="extract-mask-brush"
                type="range"
                min="1"
                max="100"
                value={brushSize}
                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                className="w-full accent-blue-500"
              />
            </div>
          </div>

          {/* Canvas Area */}
          <div className="flex-1 bg-app-surface p-8 flex items-center justify-center relative overflow-auto checkered-bg" ref={containerRef}>
            <style>{`
              .checkered-bg {
                background-image: 
                  linear-gradient(45deg, #18181b 25%, transparent 25%), 
                  linear-gradient(-45deg, #18181b 25%, transparent 25%), 
                  linear-gradient(45deg, transparent 75%, #18181b 75%), 
                  linear-gradient(-45deg, transparent 75%, #18181b 75%);
                background-size: 20px 20px;
                background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
              }
            `}</style>

            <div className="shadow-2xl ring-1 ring-app-border/50 relative">
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="max-w-full max-h-[70vh] cursor-crosshair touch-none object-contain"
                style={{
                  width: imgRef.current ? `${imgRef.current.width}px` : "auto",
                  height: imgRef.current ? `${imgRef.current.height}px` : "auto"
                }}
              />

              {/* Brush cursor preview */}
              <div
                className="absolute border border-white/50 rounded-full pointer-events-none backdrop-invert bg-white/20 hidden md:block"
                style={{
                  width: brushSize,
                  height: brushSize,
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  opacity: 0 // We'd need to track mouse over container to show this properly, skipping for simplicity
                }}
              />
            </div>
          </div>
        </div>

        <div className="h-16 border-t border-app-border bg-app-surface flex items-center justify-end px-6 shrink-0 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium text-app-main hover:text-app-main hover:bg-app-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-2 btn-3d text-white text-sm font-medium rounded-lg shadow-sm flex items-center gap-2"
          >
            <Check className="w-4 h-4" />
            Save Mask
          </button>
        </div>
      </div>
    </div>
  );
}
