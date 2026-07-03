import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  Wand2,
  Loader2,
  Sparkles,
  PenTool,
  Scissors,
  X,
  Image as ImageIcon,
  Boxes,
} from "lucide-react";
import { Asset, Texture, ElementType } from "../../types";
import { ExtractedElement, ExtractedPanel } from "../../lib/extractor/types";
import {
  generateId,
  extractCrop,
  applyPolygonMask,
  trimTransparentPixels,
} from "../../lib/extractor/utils";
import { panelLocalToGlobal } from "../../lib/extractor/mapping";
import { LS_PROVIDER_KEYS } from "../orb/constants";
import ExtractCanvas from "./ExtractCanvas";
import ExtractTray from "./ExtractTray";
import MaskEditor from "./MaskEditor";

// A labeled cutout mapped back onto the source (background) image. Bounds are
// normalized [0..1]; the caller scales them onto canvasState dims to place an
// Image layer over the background.
export interface PlacedLayer {
  asset: Asset;
  bounds: { xmin: number; ymin: number; xmax: number; ymax: number };
  label: string;
  type?: string; // raw detected type (existing)
  controlType?: ElementType; // set by "Make Control": the chosen/normalized target type
  faceUrl?: string; // durable face URL (server-uploaded when possible)
}

// A whole module: panel backplate + its member controls, placed as one Foundry
// Group. Child bounds are SOURCE-image-normalized (same space as PlacedLayer).
export interface PlacedModule {
  title: string;
  bounds: { xmin: number; ymin: number; xmax: number; ymax: number };
  backplateAsset: Asset; // panel crop (durable URL when upload succeeded)
  // The durable uploaded URL for the panel crop. App places the backplate as a
  // Frame element wearing this as faceSrc (Task 10 amendment) rather than an
  // Image+asset — but the crop still lands in the Asset library via onAddAssets.
  backplateUrl: string;
  children: {
    asset: Asset;
    bounds: { xmin: number; ymin: number; xmax: number; ymax: number };
    label: string;
    controlType: ElementType;
    faceUrl?: string;
  }[];
}

interface ExtractorModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceImage: string | null; // canvasState.backgroundImage
  onAddAssets: (assets: Asset[]) => void;
  onPlaceLayers: (items: PlacedLayer[]) => void;
  onPlaceModules: (modules: PlacedModule[]) => void;
  onAddTextures: (textures: Texture[]) => void;
}

// Checkerboard tile reused from the tray previews — signals transparency on the
// canvas backdrop without injecting a global <style> block.
const CHECKER_TILE =
  "url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAMElEQVQ4T2P8z8Dwn4GKgHHUQBoG/mOUYkBBMy2mO41yqGFAi8VMRvNQDcR/qIQBALSZNxE9iG7uAAAAAElFTkSuQmCC')";

export default function ExtractorModal({
  isOpen,
  onClose,
  sourceImage,
  onAddAssets,
  onPlaceLayers,
  onPlaceModules,
  onAddTextures,
}: ExtractorModalProps) {
  const [elements, setElements] = useState<ExtractedElement[]>([]);
  const [panels, setPanels] = useState<ExtractedPanel[]>([]);
  const [isDetectingPanels, setIsDetectingPanels] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [isDetecting, setIsDetecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [lassoMode, setLassoMode] = useState(false);
  const [editingMaskId, setEditingMaskId] = useState<string | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);

  // Provider/model state — key comes from the same localStorage store the
  // assistant orb uses; the model list is live-fetched. No hardcoded ids.
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState<
    { id: string; label: string }[]
  >([]);

  const imageRef = useRef<HTMLImageElement | null>(null);
  // Blob URLs this modal owns (created by the @imgly background-removal
  // fallback). The original leaked these; we revoke them on delete / reset,
  // and hand ownership to the design when a cutout is placed as an asset.
  const blobUrlsRef = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // On open: read the Gemini key from the orb's store, live-fetch the model
  // list, and default the selection to gemini's provider defaultModel.
  useEffect(() => {
    if (!isOpen) return;

    let key = "";
    try {
      const raw = localStorage.getItem(LS_PROVIDER_KEYS);
      if (raw) {
        const parsed = JSON.parse(raw);
        key =
          parsed && typeof parsed.gemini === "string" ? parsed.gemini : "";
      }
    } catch (err) {
      console.error("Failed to read provider keys from localStorage", err);
    }
    setApiKey(key ?? "");

    let cancelled = false;
    const load = async () => {
      let list: { id: string; label: string }[] = [];
      try {
        const url = key
          ? `/api/assistant/models/gemini?apiKey=${encodeURIComponent(key)}`
          : "/api/assistant/models/gemini";
        const res = await fetch(url);
        const data = await res.json();
        list = Array.isArray(data) ? data : data?.models || [];
      } catch (err) {
        console.error("Failed to fetch Gemini models", err);
      }
      if (cancelled) return;
      setAvailableModels(list);

      let defaultModel = "";
      try {
        const res = await fetch("/api/assistant/providers");
        const data = await res.json();
        const provList = Array.isArray(data) ? data : data?.providers || [];
        const gemini = provList.find((p: { id?: string }) => p?.id === "gemini");
        defaultModel =
          gemini && typeof gemini.defaultModel === "string"
            ? gemini.defaultModel
            : "";
      } catch (err) {
        console.error("Failed to fetch provider defaults", err);
      }
      if (cancelled) return;

      setModel((prev) => {
        if (prev && list.some((m) => m.id === prev)) return prev;
        if (defaultModel && list.some((m) => m.id === defaultModel)) {
          return defaultModel;
        }
        return list[0]?.id || defaultModel || "";
      });
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // The workspace SURVIVES close/reopen — captured elements, cutouts, and
  // settings stay put so closing the modal never throws work away. State only
  // resets when the background image itself changes, because every element's
  // bounds are relative to that image.
  const prevSourceRef = useRef<string | null>(sourceImage);
  useEffect(() => {
    if (prevSourceRef.current === sourceImage) return;
    prevSourceRef.current = sourceImage;
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current.clear();
    imageRef.current = null;
    setElements([]);
    setPanels([]);
    setImageSize({ width: 0, height: 0 });
    setEditingMaskId(null);
    setIsDetecting(false);
    setIsProcessing(false);
    setDetectError(null);
  }, [sourceImage]);

  // Final safety net: revoke any remaining owned blob URLs on unmount.
  useEffect(() => {
    const owned = blobUrlsRef.current;
    return () => {
      owned.forEach((u) => URL.revokeObjectURL(u));
      owned.clear();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Element helpers
  // ---------------------------------------------------------------------------
  const updateElement = (id: string, updates: Partial<ExtractedElement>) => {
    setElements((prev) =>
      prev.map((el) => (el.id === id ? { ...el, ...updates } : el)),
    );
  };

  // Revoke any blob URLs an element references that this modal still owns.
  const revokeElementBlobUrls = (el: ExtractedElement) => {
    [el.cutoutDataUrl, el.maskDataUrl, el.cropDataUrl].forEach((u) => {
      if (u && blobUrlsRef.current.has(u)) {
        URL.revokeObjectURL(u);
        blobUrlsRef.current.delete(u);
      }
    });
  };

  const deleteElement = (id: string) => {
    setElements((prev) => {
      const target = prev.find((el) => el.id === id);
      if (target) revokeElementBlobUrls(target);
      return prev.filter((el) => el.id !== id);
    });
  };

  const onImageLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    imageRef.current = img;
    setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
  };

  // ---------------------------------------------------------------------------
  // Capture (manual rect / lasso) — queues as "pending"; deliberately does NOT
  // auto-process (the original hammered the API on every box). Process Pending
  // runs the pipeline sequentially.
  // ---------------------------------------------------------------------------
  const handleManualDraw = async (
    xmin: number,
    ymin: number,
    xmax: number,
    ymax: number,
    lassoPoints?: { x: number; y: number }[],
  ) => {
    if (!imageRef.current) return;
    if (xmax <= xmin || ymax <= ymin) return;

    let cropDataUrl = extractCrop(imageRef.current, xmin, ymin, xmax, ymax);
    let finalPolygon: { x: number; y: number }[] | undefined = undefined;

    if (lassoPoints && lassoPoints.length > 2) {
      // Transform full-image-relative points to crop-relative points.
      finalPolygon = lassoPoints.map((p) => ({
        x: (p.x - xmin) / (xmax - xmin),
        y: (p.y - ymin) / (ymax - ymin),
      }));
      cropDataUrl = await applyPolygonMask(cropDataUrl, finalPolygon);
    }

    const newElement: ExtractedElement = {
      id: generateId(),
      label: "Pending",
      type: "unknown",
      xmin,
      ymin,
      xmax,
      ymax,
      cropDataUrl,
      cutoutDataUrl: lassoPoints ? cropDataUrl : undefined,
      displayMode: lassoPoints ? "cutout" : "rect",
      polygon: finalPolygon,
      status: "pending",
    };

    setElements((prev) => [...prev, newElement]);
    // No auto-process: element waits in the queue for Process Pending.
  };

  // ---------------------------------------------------------------------------
  // Processing pipeline: label + polygon cutout → @imgly fallback → trim.
  // sensitivityOverride lets a re-process run at a different sensitivity than
  // the global slider (per-card "Redo" in the tray).
  // ---------------------------------------------------------------------------
  const processElement = async (
    el: ExtractedElement,
    sensitivityOverride?: number,
  ) => {
    updateElement(el.id, { status: "processing" });

    let cutoutUrl = el.cutoutDataUrl;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let labelData: any = {};
    let createdBlobUrl: string | null = null;

    // 1. Labeling + AI semantic cutout (pending / detected only).
    if ((el.status === "pending" || el.status === "detected") && el.cropDataUrl) {
      try {
        const response = await fetch("/api/extract/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: el.cropDataUrl,
            mimeType: "image/png",
            sensitivity: sensitivityOverride ?? sensitivity,
            apiKey,
            model,
          }),
        });
        if (response.ok) {
          labelData = await response.json();
          if (labelData.polygon && labelData.polygon.length > 2) {
            cutoutUrl = await applyPolygonMask(el.cropDataUrl, labelData.polygon);
          }
        }
      } catch (err) {
        console.error("Labeling failed for", el.id, err);
      }
    }

    // 2. Generic background-removal fallback (only when no polygon cutout).
    //    Dynamic import keeps the ~40MB WASM off the initial bundle.
    if (!cutoutUrl && el.cropDataUrl) {
      try {
        const { removeBackground } = await import("@imgly/background-removal");
        const blob = await removeBackground(el.cropDataUrl);
        createdBlobUrl = URL.createObjectURL(blob);
        blobUrlsRef.current.add(createdBlobUrl);
        cutoutUrl = createdBlobUrl;
      } catch (err) {
        console.error("Background removal failed for", el.id, err);
      }
    }

    let finalBounds = {
      xmin: el.xmin,
      ymin: el.ymin,
      xmax: el.xmax,
      ymax: el.ymax,
    };

    // 3. Trim transparent pixels — tightens the normalized bounds.
    if (cutoutUrl) {
      const trimmed = await trimTransparentPixels(
        cutoutUrl,
        el.xmin,
        el.ymin,
        imageSize.width,
        imageSize.height,
      );
      if (trimmed) {
        // Trimming produced a fresh data URL; any intermediate @imgly blob URL
        // is now orphaned — revoke it (the original leaked here).
        if (createdBlobUrl) {
          URL.revokeObjectURL(createdBlobUrl);
          blobUrlsRef.current.delete(createdBlobUrl);
          createdBlobUrl = null;
        }
        cutoutUrl = trimmed.trimmedDataUrl;
        finalBounds = {
          xmin: trimmed.xmin,
          ymin: trimmed.ymin,
          xmax: trimmed.xmax,
          ymax: trimmed.ymax,
        };
      }
    }

    updateElement(el.id, {
      cutoutDataUrl: cutoutUrl,
      displayMode: cutoutUrl ? "cutout" : "rect",
      status: "labeled",
      polygon: labelData.polygon,
      shape: labelData.shape,
      ...finalBounds,
      ...(labelData.label
        ? {
            label: labelData.label,
            type: labelData.type,
            description: labelData.description,
            tags: labelData.tags || [],
            group: labelData.group || "",
          }
        : el.status === "pending"
          ? { label: "Unknown Component" }
          : {}),
    });
  };

  const handleProcessPending = async () => {
    const pending = elements.filter(
      (el) => el.status === "pending" || el.status === "detected",
    );
    if (pending.length === 0) return;

    setIsProcessing(true);
    for (const el of pending) {
      await processElement(el);
    }
    setIsProcessing(false);
  };

  // Re-run the pipeline on ONE element at an alternative sensitivity — for
  // when the first pass produced a bad cutout or labels. Re-crops the source
  // at the element's CURRENT bounds (post-trim bounds still contain the whole
  // visible control, and a fresh crop keeps crop↔bounds consistent for the
  // next trim), releases the old artifacts, and processes as freshly pending.
  const handleReprocess = async (
    el: ExtractedElement,
    altSensitivity: number,
  ) => {
    if (!imageRef.current || el.status === "processing") return;
    revokeElementBlobUrls(el);
    const cropDataUrl = extractCrop(
      imageRef.current,
      el.xmin,
      el.ymin,
      el.xmax,
      el.ymax,
    );
    const reset: ExtractedElement = {
      ...el,
      cropDataUrl,
      cutoutDataUrl: undefined,
      maskDataUrl: undefined,
      polygon: undefined,
      displayMode: "rect",
      status: "pending",
    };
    setElements((prev) => prev.map((x) => (x.id === el.id ? reset : x)));
    await processElement(reset, altSensitivity);
  };

  // ---------------------------------------------------------------------------
  // Auto detect — downscales the source to <=2048 max dim before base64.
  // ---------------------------------------------------------------------------
  const handleAutoDetect = async () => {
    if (!sourceImage || !imageRef.current) return;
    setIsDetecting(true);
    setDetectError(null);

    try {
      const base64Data = drawDownscaledDataUrl(
        imageRef.current,
        imageSize.width,
        imageSize.height,
        2048,
      );

      const response = await fetch("/api/extract/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: base64Data,
          mimeType: "image/png",
          sensitivity,
          apiKey,
          model,
        }),
      });

      if (!response.ok) throw new Error("Detection failed");

      const data = await response.json();
      const detected: ExtractedElement[] = (data.elements || []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el: any) => ({
          id: generateId(),
          label: el.label,
          type: el.type,
          xmin: el.xmin,
          ymin: el.ymin,
          xmax: el.xmax,
          ymax: el.ymax,
          status: "detected",
          displayMode: "rect",
          cropDataUrl: extractCrop(
            imageRef.current!,
            el.xmin,
            el.ymin,
            el.xmax,
            el.ymax,
          ),
        }),
      );

      setElements((prev) => [...prev, ...detected]);
    } catch (err) {
      console.error("Auto detect error:", err);
      setDetectError("Failed to auto-detect elements.");
    } finally {
      setIsDetecting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Detect Modules — two-pass group extraction. Pass 1: detect titled module
  // panels. Pass 2: run the EXISTING per-crop control detection inside each
  // panel, mapping the crop-relative child bounds back to source space and
  // tagging children with panelId + group=title. Sequential per panel
  // (rate-limit safety, same as Process Pending).
  // ---------------------------------------------------------------------------
  const handleDetectModules = async () => {
    if (!sourceImage || !imageRef.current) return;
    setIsDetectingPanels(true);
    setDetectError(null);
    try {
      const base64Data = drawDownscaledDataUrl(
        imageRef.current,
        imageSize.width,
        imageSize.height,
        2048,
      );
      const res = await fetch("/api/extract/detect-panels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: base64Data,
          mimeType: "image/png",
          sensitivity,
          apiKey,
          model,
        }),
      });
      if (!res.ok) {
        throw new Error((await res.json())?.error || "Panel detection failed");
      }
      const data = await res.json();
      const found: ExtractedPanel[] = (data.panels || []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => ({
          id: generateId(),
          title: String(p.title || "Module"),
          xmin: p.xmin,
          ymin: p.ymin,
          xmax: p.xmax,
          ymax: p.ymax,
          cropDataUrl: extractCrop(
            imageRef.current!,
            p.xmin,
            p.ymin,
            p.xmax,
            p.ymax,
          ),
          status: "detected" as const,
        }),
      );
      setPanels((prev) => [...prev, ...found]);

      // Pass 2: scan each panel's crop for its member controls, sequentially.
      for (const panel of found) {
        setPanels((prev) =>
          prev.map((x) =>
            x.id === panel.id ? { ...x, status: "scanning" } : x,
          ),
        );
        try {
          const childRes = await fetch("/api/extract/detect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: panel.cropDataUrl,
              mimeType: "image/png",
              sensitivity,
              apiKey,
              model,
            }),
          });
          if (childRes.ok) {
            const childData = await childRes.json();
            const children: ExtractedElement[] = (childData.elements || []).map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (c: any) => {
                const g = panelLocalToGlobal(c, panel);
                return {
                  id: generateId(),
                  label: c.label,
                  type: c.type,
                  xmin: g.xmin,
                  ymin: g.ymin,
                  xmax: g.xmax,
                  ymax: g.ymax,
                  status: "detected" as const,
                  displayMode: "rect" as const,
                  cropDataUrl: extractCrop(
                    imageRef.current!,
                    g.xmin,
                    g.ymin,
                    g.xmax,
                    g.ymax,
                  ),
                  group: panel.title,
                  panelId: panel.id,
                };
              },
            );
            setElements((prev) => [...prev, ...children]);
          }
        } catch (err) {
          console.error("Panel child scan failed", panel.id, err);
        }
        setPanels((prev) =>
          prev.map((x) =>
            x.id === panel.id ? { ...x, status: "scanned" } : x,
          ),
        );
      }
    } catch (err) {
      setDetectError(
        err instanceof Error ? err.message : "Panel detection failed",
      );
    } finally {
      setIsDetectingPanels(false);
    }
  };

  // Remove a panel but KEEP its detected children as loose elements — clear
  // their panelId so they fall back into the ungrouped list. Children are never
  // deleted here, only ungrouped.
  const deletePanel = (id: string) => {
    setPanels((prev) => prev.filter((p) => p.id !== id));
    setElements((prev) =>
      prev.map((el) =>
        el.panelId === id ? { ...el, panelId: undefined } : el,
      ),
    );
  };

  // ---------------------------------------------------------------------------
  // Mask editing
  // ---------------------------------------------------------------------------
  const handleSaveMask = (id: string, maskDataUrl: string) => {
    updateElement(id, { maskDataUrl, displayMode: "mask" });
    setEditingMaskId(null);
  };

  const editingElement = elements.find((el) => el.id === editingMaskId);

  // ---------------------------------------------------------------------------
  // Design sinks: assets (+ optional positioned layers).
  // ---------------------------------------------------------------------------
  const handleAddToDesign = (
    els: ExtractedElement[],
    placeOnCanvas: boolean,
  ) => {
    const pairs = els
      .map((el) => {
        // mask > cutout > crop precedence.
        const url = el.maskDataUrl || el.cutoutDataUrl || el.cropDataUrl || "";
        if (!url) return null;
        // Hand blob-URL ownership to the design so the modal's reset/delete
        // sweep does not revoke a URL the canvas still renders.
        if (blobUrlsRef.current.has(url)) blobUrlsRef.current.delete(url);
        const asset: Asset = { id: crypto.randomUUID(), name: el.label, url };
        return { el, asset };
      })
      .filter(
        (p): p is { el: ExtractedElement; asset: Asset } => p !== null,
      );

    if (pairs.length === 0) return;

    onAddAssets(pairs.map((p) => p.asset));

    if (placeOnCanvas) {
      const layers: PlacedLayer[] = pairs.map(({ el, asset }) => ({
        asset,
        bounds: { xmin: el.xmin, ymin: el.ymin, xmax: el.xmax, ymax: el.ymax },
        label: el.label,
        type: el.type,
      }));
      onPlaceLayers(layers);
    }
  };

  // Materialize an element's current image to the most durable URL available.
  // Same flow as TextureManager's upload: convert any blob URL (@imgly cutouts)
  // to a data URL first, then POST /api/textures/upload so the image gets a
  // /textures/<id> URL on disk that outlives blob-URL revocation. Returns
  // { url, durable: true } on a successful server upload, { url, durable: false }
  // with the inline data URL when the upload fails, or null when the element has
  // no usable image (or the blob read failed). Shared by handleAddAsTextures and
  // handleMakeControls so both sinks get identical, durable face/texture URLs.
  const uploadCutout = async (
    el: ExtractedElement,
  ): Promise<{ url: string; durable: boolean } | null> => {
    // mask > cutout > crop precedence, same as every other sink.
    const src = el.maskDataUrl || el.cutoutDataUrl || el.cropDataUrl;
    if (!src) return null;
    let dataUrl = src;
    if (!src.startsWith("data:")) {
      try {
        const blob = await (await fetch(src)).blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch (err) {
        console.error("Failed to read cutout for upload", el.id, err);
        return null;
      }
    }
    const name = `${el.label || el.id}.png`;
    try {
      const resp = await fetch("/api/textures/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl, name }),
      });
      if (resp.ok) {
        const { url } = await resp.json();
        return { url, durable: true };
      }
    } catch {
      // fall through to the inline data-URL fallback
    }
    return { url: dataUrl, durable: false };
  };

  // Extracted cutouts → Texture Library, for applying onto UI elements. Uploads
  // via the shared uploadCutout helper so each texture gets a durable
  // /textures/<id> URL on disk (with an inline data-URL fallback). The durable
  // id is recovered from that URL so a texture keeps the same on-disk identity
  // its DELETE route matches against; the fallback keeps the original short id.
  const handleAddAsTextures = async (els: ExtractedElement[]) => {
    const textures: Texture[] = [];
    for (const el of els) {
      const uploaded = await uploadCutout(el);
      if (!uploaded) continue;
      const name = `${el.label || el.id}.png`;
      if (uploaded.durable) {
        // /textures/<uuid>.<ext> → <uuid>, the id the delete route resolves.
        const fileId = uploaded.url
          .replace(/^.*\/textures\//, "")
          .replace(/\.[^.]+$/, "");
        textures.push({ id: fileId, name, url: uploaded.url });
      } else {
        textures.push({
          id: Math.random().toString(36).substring(2, 9),
          name,
          url: uploaded.url,
        });
      }
    }
    if (textures.length) onAddTextures(textures);
  };

  // Extracted cutouts → real interactive controls. Each item's cutout is
  // uploaded for a durable face URL, then placed as a layer carrying the chosen
  // controlType + faceUrl so App can spawn a native control wearing the image
  // (see PlacedLayer / C4). When the upload can't run (blob read failed), fall
  // back to the raw image and hand blob-URL ownership to the design exactly like
  // handleAddToDesign, so the modal's cleanup sweep won't revoke it out from
  // under the canvas.
  const handleMakeControls = async (
    items: { el: ExtractedElement; controlType: ElementType }[],
  ) => {
    const assets: Asset[] = [];
    const layers: PlacedLayer[] = [];
    for (const { el, controlType } of items) {
      // mask > cutout > crop precedence, matching every other sink.
      const rawUrl =
        el.maskDataUrl || el.cutoutDataUrl || el.cropDataUrl || "";
      if (!rawUrl) continue;

      const uploaded = await uploadCutout(el);
      let url: string;
      if (uploaded) {
        url = uploaded.url;
      } else {
        // Hand blob-URL ownership to the design so reset/delete does not revoke
        // a URL the canvas still renders (same handoff as handleAddToDesign).
        if (blobUrlsRef.current.has(rawUrl)) blobUrlsRef.current.delete(rawUrl);
        url = rawUrl;
      }

      const asset: Asset = { id: crypto.randomUUID(), name: el.label, url };
      assets.push(asset);
      layers.push({
        asset,
        bounds: { xmin: el.xmin, ymin: el.ymin, xmax: el.xmax, ymax: el.ymax },
        label: el.label,
        type: el.type,
        controlType,
        faceUrl: url,
      });
    }

    if (assets.length === 0) return;
    onAddAssets(assets);
    onPlaceLayers(layers);
  };

  // Extracted module → a whole Foundry Group. Uploads the panel crop for a
  // durable backplate face URL (same uploadCutout flow as handleMakeControls,
  // fed a synthetic element carrying the panel crop), then builds each member
  // control exactly like handleMakeControls (mask>cutout>crop → durable face
  // URL → Asset → chosen controlType). App materializes the panel as a Frame
  // wearing backplateUrl and the children as face-wearing controls at exact
  // offsets. The panel crop still lands in the Asset library via onAddAssets.
  const handlePlaceModule = async (
    panel: ExtractedPanel,
    items: { el: ExtractedElement; controlType: ElementType }[],
  ) => {
    // Durable backplate URL via the shared upload helper (inline fallback).
    const backplateEl: ExtractedElement = {
      id: panel.id,
      label: `${panel.title} backplate`,
      cropDataUrl: panel.cropDataUrl,
      xmin: panel.xmin,
      ymin: panel.ymin,
      xmax: panel.xmax,
      ymax: panel.ymax,
      displayMode: "rect",
      status: "detected",
    };
    const uploadedBackplate = await uploadCutout(backplateEl);
    const backplateUrl =
      uploadedBackplate?.url || panel.cropDataUrl || "";
    const backplateAsset: Asset = {
      id: crypto.randomUUID(),
      name: `${panel.title} backplate`,
      url: backplateUrl,
    };

    const childAssets: Asset[] = [];
    const children: PlacedModule["children"] = [];
    for (const { el, controlType } of items) {
      // mask > cutout > crop precedence, matching every other sink.
      const rawUrl =
        el.maskDataUrl || el.cutoutDataUrl || el.cropDataUrl || "";
      if (!rawUrl) continue;

      const uploaded = await uploadCutout(el);
      let url: string;
      if (uploaded) {
        url = uploaded.url;
      } else {
        // Hand blob-URL ownership to the design so reset/delete does not revoke
        // a URL the canvas still renders (same handoff as handleMakeControls).
        if (blobUrlsRef.current.has(rawUrl)) blobUrlsRef.current.delete(rawUrl);
        url = rawUrl;
      }

      const asset: Asset = { id: crypto.randomUUID(), name: el.label, url };
      childAssets.push(asset);
      children.push({
        asset,
        bounds: { xmin: el.xmin, ymin: el.ymin, xmax: el.xmax, ymax: el.ymax },
        label: el.label,
        controlType,
        faceUrl: url,
      });
    }

    const placedModule: PlacedModule = {
      title: panel.title,
      bounds: {
        xmin: panel.xmin,
        ymin: panel.ymin,
        xmax: panel.xmax,
        ymax: panel.ymax,
      },
      backplateAsset,
      backplateUrl,
      children,
    };

    onAddAssets([backplateAsset, ...childAssets]);
    onPlaceModules([placedModule]);
  };

  if (!isOpen) return null;

  const hasProcessable = elements.some(
    (e) => e.status === "pending" || e.status === "detected",
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-app-base border border-app-border rounded-xl shadow-2xl w-full max-w-[95vw] h-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header toolbar */}
        <div className="border-b border-app-border bg-app-surface px-4 py-2.5 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <Scissors className="w-4 h-4 text-app-accent" />
            <h2 className="text-sm font-bold text-app-main uppercase tracking-wide">
              Extract Components
            </h2>
          </div>

          <div className="flex items-center gap-3 flex-wrap justify-end">
            {detectError && (
              <span className="text-xs text-red-400">{detectError}</span>
            )}

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="extract-model"
                className="text-xs text-app-muted"
              >
                Model
              </label>
              <select
                id="extract-model"
                name="extract-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bg-app-surface text-app-main text-sm py-1.5 px-3 rounded border border-app-border outline-none focus:border-app-accent max-w-50"
              >
                {availableModels.length > 0 ? (
                  availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label || m.id}
                    </option>
                  ))
                ) : model ? (
                  <option value={model}>{model}</option>
                ) : (
                  <option value="">Loading models…</option>
                )}
              </select>
            </div>

            <button
              type="button"
              aria-pressed={lassoMode}
              onClick={() => setLassoMode((v) => !v)}
              title="Toggle freeform lasso tool (Alt + Drag)"
              className={`text-sm font-medium py-1.5 px-3 rounded border transition-colors flex items-center gap-2 ${
                lassoMode
                  ? "border-app-accent text-app-accent bg-app-surface"
                  : "border-app-border text-app-muted bg-app-surface hover:bg-app-surface-hover"
              }`}
            >
              <PenTool className="w-4 h-4" />
              Lasso
            </button>

            <div className="flex items-center gap-2">
              <label
                htmlFor="extract-sensitivity"
                className="text-xs text-app-muted whitespace-nowrap"
              >
                Sensitivity: {Math.round(sensitivity * 100)}%
              </label>
              <input
                id="extract-sensitivity"
                name="extract-sensitivity"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={sensitivity}
                onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                className="w-24 accent-purple-500"
              />
            </div>

            <button
              type="button"
              onClick={handleProcessPending}
              disabled={isProcessing || !hasProcessable}
              className="text-sm font-medium py-1.5 px-3 rounded border border-app-border bg-app-surface text-app-main hover:bg-app-surface-hover disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              Process Pending
            </button>

            <button
              type="button"
              onClick={handleAutoDetect}
              disabled={!sourceImage || isDetecting}
              className="btn-3d text-white text-sm font-medium py-1.5 px-3 rounded disabled:opacity-50 flex items-center gap-2"
            >
              {isDetecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4" />
              )}
              Auto Detect
            </button>

            <button
              type="button"
              onClick={handleDetectModules}
              disabled={!sourceImage || isDetectingPanels}
              className="btn-3d text-white text-sm font-medium py-1.5 px-3 rounded disabled:opacity-50 flex items-center gap-2"
            >
              {isDetectingPanels ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Boxes className="w-4 h-4" />
              )}
              Detect Modules
            </button>

            <button
              type="button"
              aria-label="Close extractor"
              onClick={onClose}
              className="p-1 text-app-muted hover:text-app-main rounded hover:bg-app-surface-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: draw surface + asset tray */}
        <div className="flex-1 flex overflow-hidden">
          <div
            className="flex-1 relative overflow-auto flex items-center justify-center p-8 bg-app-surface"
            style={{ backgroundImage: CHECKER_TILE }}
          >
            {!sourceImage ? (
              <div className="text-app-muted flex flex-col items-center gap-4">
                <ImageIcon className="w-16 h-16 opacity-50" />
                <p>Upload a background image on the canvas first.</p>
              </div>
            ) : (
              <ExtractCanvas
                imageUrl={sourceImage}
                onLoad={onImageLoad}
                elements={elements}
                onDrawBox={handleManualDraw}
                onDeleteElement={deleteElement}
                lassoMode={lassoMode}
              />
            )}
          </div>

          <ExtractTray
            elements={elements}
            panels={panels}
            onDelete={deleteElement}
            onUpdate={updateElement}
            onEditMask={(id) => setEditingMaskId(id)}
            onAddToDesign={handleAddToDesign}
            onAddAsTextures={handleAddAsTextures}
            onMakeControls={handleMakeControls}
            onPlaceModule={handlePlaceModule}
            onDeletePanel={deletePanel}
            sensitivity={sensitivity}
            onReprocess={handleReprocess}
          />
        </div>

        {/* Mask editor overlay (sits above the modal at z-60) */}
        {editingMaskId && editingElement && (
          <MaskEditor
            imageUrl={
              editingElement.cutoutDataUrl || editingElement.cropDataUrl || ""
            }
            onSave={(dataUrl) => handleSaveMask(editingMaskId, dataUrl)}
            onCancel={() => setEditingMaskId(null)}
          />
        )}
      </div>
    </div>
  );
}

// Draw the source image to an offscreen canvas at <=maxDim on its longest side,
// then return a PNG data URL. When the image already fits, scale is 1 and this
// is identical to a straight toDataURL. Bounds stay normalized, so downscaling
// the detection input changes nothing downstream.
function drawDownscaledDataUrl(
  img: HTMLImageElement,
  width: number,
  height: number,
  maxDim: number,
): string {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxDim / Math.max(width, height || 1));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
