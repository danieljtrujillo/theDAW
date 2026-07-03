import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Brush, Eraser, Undo2, Trash2, Loader2, Sparkles } from "lucide-react";
import { removeObject, isModelCached, type InpaintProgress } from "../lib/inpaint/lamaOnnx";

interface InpaintModalProps {
  imageUrl: string;
  title?: string;
  onApply: (dataUrl: string) => void;
  onClose: () => void;
}

// Cap the working resolution so large images stay responsive and bounded in
// memory. UI textures/screenshots are well under this; bigger inputs are scaled
// down once on load and the result is delivered at that working resolution.
const MAX_DIM = 2048;
const UNDO_DEPTH = 15;

// Paint-over-the-object object removal (LaMa, in-browser). The visible mask is
// stored OPAQUE (clean binary alpha for the model) and only displayed at reduced
// opacity, so overlapping strokes never accumulate into a soft/partial mask.
export default function InpaintModal({ imageUrl, title, onApply, onClose }: InpaintModalProps) {
  const baseRef = useRef<HTMLCanvasElement>(null); // working image (source of truth)
  const maskRef = useRef<HTMLCanvasElement>(null); // brush mask overlay
  const wrapRef = useRef<HTMLDivElement>(null);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(40);
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false); // a removal has been applied to the working image
  const [hasStrokes, setHasStrokes] = useState(false);
  const [cached, setCached] = useState(true); // whether the model is already local

  const undoStack = useRef<ImageData[]>([]);
  const painting = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const maskCtx = () => maskRef.current?.getContext("2d", { willReadFrequently: true }) || null;

  // Load the image into the working canvas (scaled to the cap), size the mask
  // canvas to match, and reset state.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoadError(null);
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const base = baseRef.current;
      const mask = maskRef.current;
      if (!base || !mask) return;
      base.width = w;
      base.height = h;
      mask.width = w;
      mask.height = h;
      const bctx = base.getContext("2d");
      if (!bctx) {
        setLoadError("Could not get a drawing context.");
        return;
      }
      bctx.drawImage(img, 0, 0, w, h);
      maskCtx()?.clearRect(0, 0, w, h);
      undoStack.current = [];
      setDirty(false);
      setHasStrokes(false);
      setError(null);
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) setLoadError("Failed to load the image (it may be cross-origin without CORS).");
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    isModelCached().then((c) => setCached(c)).catch(() => setCached(false));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Map a pointer event to mask-canvas pixel coordinates.
  const toCanvasPt = (e: React.PointerEvent) => {
    const mask = maskRef.current!;
    const rect = mask.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * mask.width,
      y: ((e.clientY - rect.top) / rect.height) * mask.height,
    };
  };

  const stampBrush = (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const ctx = maskCtx();
    if (!ctx) return;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = "rgba(239,68,68,1)";
    ctx.fillStyle = "rgba(239,68,68,1)";
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    if (from) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const pushUndo = () => {
    const ctx = maskCtx();
    const mask = maskRef.current;
    if (!ctx || !mask) return;
    undoStack.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
    if (undoStack.current.length > UNDO_DEPTH) undoStack.current.shift();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy || !ready) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    painting.current = true;
    pushUndo();
    const p = toCanvasPt(e);
    lastPt.current = p;
    stampBrush(null, p);
    setHasStrokes(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!painting.current) return;
    const p = toCanvasPt(e);
    stampBrush(lastPt.current, p);
    lastPt.current = p;
  };
  const endStroke = () => {
    painting.current = false;
    lastPt.current = null;
  };

  const undo = () => {
    const ctx = maskCtx();
    const snap = undoStack.current.pop();
    if (!ctx || !snap) return;
    ctx.putImageData(snap, 0, 0);
    setHasStrokes(undoStack.current.length > 0 || maskHasPixels());
  };

  const maskHasPixels = (): boolean => {
    const ctx = maskCtx();
    const mask = maskRef.current;
    if (!ctx || !mask) return false;
    const d = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  };

  const clearMask = () => {
    const mask = maskRef.current;
    maskCtx()?.clearRect(0, 0, mask?.width || 0, mask?.height || 0);
    setHasStrokes(false);
  };

  const progressText = (p: InpaintProgress): string => {
    if (p.phase === "download") {
      const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
      return `Downloading model… ${pct}%`;
    }
    if (p.phase === "init") return "Loading model…";
    return "Removing…";
  };

  const runRemove = useCallback(async () => {
    const base = baseRef.current;
    const mask = maskRef.current;
    if (!base || !mask || busy) return;
    if (!maskHasPixels()) {
      setError("Paint over the thing you want gone first.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(cached ? "Removing…" : "Preparing model…");
    try {
      const result = await removeObject(base, mask, (p) => setStatus(progressText(p)));
      if (result) {
        const bctx = base.getContext("2d");
        bctx?.clearRect(0, 0, base.width, base.height);
        bctx?.drawImage(result, 0, 0);
        clearMask();
        undoStack.current = [];
        setDirty(true);
        setCached(true);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, cached, erase, brushSize]);

  const apply = () => {
    const base = baseRef.current;
    if (!base) return;
    try {
      onApply(base.toDataURL("image/png"));
    } catch (e: any) {
      setError(`Could not export the image: ${e?.message || e}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-9999 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex flex-col w-full max-w-5xl max-h-[90vh] bg-app-surface border border-app-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-app-main" />
            <span className="text-sm font-semibold text-app-main">
              Remove{title ? ` — ${title}` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1.5 rounded text-app-muted hover:text-white hover:bg-app-base disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap px-4 py-2 border-b border-app-border bg-app-base/40 shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setErase(false)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${!erase ? "bg-app-main text-app-base" : "text-app-muted hover:text-white hover:bg-app-base"}`}
              aria-pressed={!erase}
            >
              <Brush className="w-3.5 h-3.5" /> Brush
            </button>
            <button
              type="button"
              onClick={() => setErase(true)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${erase ? "bg-app-main text-app-base" : "text-app-muted hover:text-white hover:bg-app-base"}`}
              aria-pressed={erase}
            >
              <Eraser className="w-3.5 h-3.5" /> Erase mask
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-app-muted" htmlFor="inpaint-brush-size">
            Size
            <input
              id="inpaint-brush-size"
              name="inpaint-brush-size"
              type="range"
              min={5}
              max={200}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-28 accent-app-main"
            />
            <span className="w-8 tabular-nums text-app-main">{brushSize}</span>
          </label>

          <button
            type="button"
            onClick={undo}
            disabled={busy || undoStack.current.length === 0}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-app-muted hover:text-white hover:bg-app-base disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </button>
          <button
            type="button"
            onClick={clearMask}
            disabled={busy || !hasStrokes}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-app-muted hover:text-white hover:bg-app-base disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>

          <div className="ml-auto text-xs text-app-muted min-h-4">
            {busy && status ? (
              <span className="flex items-center gap-1.5 text-app-main">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {status}
              </span>
            ) : !cached ? (
              <span>First run downloads a ~200 MB model (cached after).</span>
            ) : null}
          </div>
        </div>

        {/* Canvas stage */}
        <div className="flex-1 min-h-0 overflow-auto bg-[repeating-conic-gradient(#1a1a1a_0deg_90deg,#232323_90deg_180deg)] bg-[length:24px_24px] flex items-center justify-center p-4">
          {loadError ? (
            <div className="text-sm text-red-400 max-w-md text-center">{loadError}</div>
          ) : (
            <div
              ref={wrapRef}
              className="relative inline-block max-w-full max-h-full shadow-lg"
              style={{ lineHeight: 0 }}
            >
              <canvas ref={baseRef} className="block max-w-full max-h-[60vh] w-auto h-auto select-none" />
              <canvas
                ref={maskRef}
                className="absolute inset-0 w-full h-full opacity-50"
                style={{ cursor: "crosshair", touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerLeave={endStroke}
                onPointerCancel={endStroke}
              />
              {!ready && !loadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-app-base/40">
                  <Loader2 className="w-5 h-5 animate-spin text-app-main" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-app-border shrink-0">
          {error && <span className="text-xs text-red-400 mr-auto max-w-md truncate" title={error}>{error}</span>}
          {!error && <span className="text-xs text-app-muted mr-auto">Paint over an object, then Remove. Repeat to clean up more.</span>}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm text-app-muted hover:text-white hover:bg-app-base disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runRemove}
            disabled={busy || !ready || !hasStrokes}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-app-main text-app-base font-medium hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Remove
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !dirty}
            className="px-3 py-1.5 rounded text-sm bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-40"
            title={dirty ? "Apply the cleaned image" : "Remove something first"}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
