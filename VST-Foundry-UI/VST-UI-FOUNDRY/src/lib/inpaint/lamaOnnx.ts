// ===========================================================================
// In-browser object removal (LaMa inpainting) via onnxruntime-web.
//
// Runs entirely on the user's machine — WebGPU when available, WASM fallback —
// so it ships to every user with no Python, no server, and no install. The
// model (Carve/LaMa-ONNX `lama_fp32.onnx`, fixed 512x512) is downloaded once
// and cached in IndexedDB.
//
// Verified I/O contract (Carve/LaMa-ONNX):
//   feeds: image [1,3,512,512] RGB, NCHW, 0..1
//          mask  [1,1,512,512] where 1 = pixel to REMOVE/repaint
//   output: [1,3,512,512], ALREADY scaled to 0..255 (clip + cast).
//
// The model is fixed at 512, so we work crop-based (ChatGPT's Photoshop-style
// recipe): dilate the brush mask, take a padded square box around it, resize
// that crop to 512, inpaint, resize back, and feather-blend into the original.
// Untouched pixels are preserved exactly; only the region around the object is
// ever resampled.
// ===========================================================================
// The `/webgpu` subpath is the build that actually carries the WebGPU
// execution provider (the default entry is WASM-only). Its JS glue is ~400KB;
// the 22MB `.jsep.wasm` it needs is NOT bundled — it's fetched at runtime from
// `ort.env.wasm.wasmPaths` (served from /public/ort/), so it only downloads
// when a removal actually runs, and the plain-wasm fallback reuses it.
import * as ort from "onnxruntime-web/webgpu";
import { get as idbGet, set as idbSet } from "idb-keyval";

const SIZE = 512;
// Default weights. Overridable via localStorage "foundry:lamaModelUrl" so a
// shipped build can self-host the model instead of hitting Hugging Face.
const DEFAULT_MODEL_URL =
  "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx";
const MODEL_IDB_KEY = "foundry:model:lama_fp32.onnx";

export type InpaintProgress =
  | { phase: "download"; loaded: number; total: number }
  | { phase: "init" }
  | { phase: "run" };

function modelUrl(): string {
  try {
    return localStorage.getItem("foundry:lamaModelUrl") || DEFAULT_MODEL_URL;
  } catch {
    return DEFAULT_MODEL_URL;
  }
}

let ortConfigured = false;
function configureOrt(): void {
  if (ortConfigured) return;
  // Single-threaded: avoids the SharedArrayBuffer / COOP+COEP requirement that
  // would otherwise break the rest of the app's cross-origin asset loads. The
  // WebGPU EP does its heavy work on-GPU, so threads aren't needed anyway.
  ort.env.wasm.numThreads = 1;
  // No wasmPaths override: the `/webgpu` *bundle* build self-locates its
  // `.jsep.wasm` via import.meta.url, which Vite rewrites to the emitted,
  // content-hashed asset URL at build time (and serves from node_modules in
  // dev). This is the canonical onnxruntime-web + bundler wiring.
  ortConfigured = true;
}

// Fetch model bytes with progress, caching in IndexedDB after the first pull.
async function fetchModelBytes(onProgress?: (p: InpaintProgress) => void): Promise<ArrayBuffer> {
  const cached = await idbGet<ArrayBuffer>(MODEL_IDB_KEY);
  if (cached && cached.byteLength > 0) return cached;

  const res = await fetch(modelUrl());
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);

  // Stream so we can report download progress on the ~200MB first pull.
  if (res.body && total > 0) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        onProgress?.({ phase: "download", loaded, total });
      }
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    const buf = out.buffer;
    try {
      await idbSet(MODEL_IDB_KEY, buf);
    } catch {
      /* cache is best-effort; a quota failure just re-downloads next time */
    }
    return buf;
  }

  const buf = await res.arrayBuffer();
  try {
    await idbSet(MODEL_IDB_KEY, buf);
  } catch {
    /* best-effort cache */
  }
  return buf;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

// Load (once) and cache the inference session. WebGPU when the browser exposes
// it, WASM otherwise. Re-throws and clears the cache on failure so a later call
// can retry (e.g. after the user frees storage or reconnects).
export async function getSession(onProgress?: (p: InpaintProgress) => void): Promise<ort.InferenceSession> {
  configureOrt();
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const bytes = await fetchModelBytes(onProgress);
      onProgress?.({ phase: "init" });
      const hasWebGpu = typeof navigator !== "undefined" && !!(navigator as any).gpu;
      const eps = hasWebGpu ? ["webgpu", "wasm"] : ["wasm"];
      return ort.InferenceSession.create(bytes, { executionProviders: eps as any });
    })().catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

// True if the model is already cached locally (drives the UI's "will download
// ~200MB" hint on first use).
export async function isModelCached(): Promise<boolean> {
  try {
    const cached = await idbGet<ArrayBuffer>(MODEL_IDB_KEY);
    return !!cached && cached.byteLength > 0;
  } catch {
    return false;
  }
}

// ---- pixel helpers --------------------------------------------------------

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  return ctx;
}

// Tight bounding box of painted (alpha>threshold) mask pixels, or null if empty.
function maskBBox(mask: HTMLCanvasElement): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h } = mask;
  const data = ctxOf(mask).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
}

// Grow the mask by ~radius px (blur + hard threshold) so an object's edge is
// included even when the user brushes just inside it.
function dilateMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = makeCanvas(mask.width, mask.height);
  const ctx = ctxOf(out);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = "none";
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    d[i] = d[i] > 20 ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// Soft-edged blend weight (0..255 alpha) from a mask, feathered by `feather` px.
function featherMask(mask: HTMLCanvasElement, feather: number): HTMLCanvasElement {
  const out = makeCanvas(mask.width, mask.height);
  const ctx = ctxOf(out);
  ctx.filter = `blur(${Math.max(0.5, feather)}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = "none";
  return out;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function toImageTensor(rgba: Uint8ClampedArray): ort.Tensor {
  const n = SIZE * SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = rgba[i * 4] / 255;
    f[n + i] = rgba[i * 4 + 1] / 255;
    f[2 * n + i] = rgba[i * 4 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
}

function toMaskTensor(rgba: Uint8ClampedArray): ort.Tensor {
  const n = SIZE * SIZE;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    f[i] = rgba[i * 4 + 3] > 8 ? 1 : 0;
  }
  return new ort.Tensor("float32", f, [1, 1, SIZE, SIZE]);
}

function outputToRgba(data: Float32Array): Uint8ClampedArray {
  const n = SIZE * SIZE;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = clampByte(data[i]); // output is already 0..255
    rgba[i * 4 + 1] = clampByte(data[n + i]);
    rgba[i * 4 + 2] = clampByte(data[2 * n + i]);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// Raw 512 inpaint pass. Returns the model's 512x512 RGBA result.
async function runLama512(
  crop512: HTMLCanvasElement,
  maskCrop512: HTMLCanvasElement,
  session: ort.InferenceSession,
): Promise<Uint8ClampedArray> {
  const imgData = ctxOf(crop512).getImageData(0, 0, SIZE, SIZE).data;
  const maskData = ctxOf(maskCrop512).getImageData(0, 0, SIZE, SIZE).data;
  const feeds: Record<string, ort.Tensor> = {
    image: toImageTensor(imgData),
    mask: toMaskTensor(maskData),
  };
  const results = await session.run(feeds);
  const outName = session.outputNames[0];
  const out = results[outName];
  return outputToRgba(out.data as Float32Array);
}

// ---- public API -----------------------------------------------------------

/**
 * Remove whatever is painted white on `maskCanvas` from `sourceCanvas` and
 * return a full-resolution result canvas with the region naturally filled.
 * `sourceCanvas` and `maskCanvas` MUST share pixel dimensions. Returns null if
 * nothing is painted.
 */
export async function removeObject(
  sourceCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  onProgress?: (p: InpaintProgress) => void,
): Promise<HTMLCanvasElement | null> {
  const W = sourceCanvas.width;
  const H = sourceCanvas.height;

  const bbox = maskBBox(maskCanvas);
  if (!bbox) return null;

  const session = await getSession(onProgress);
  onProgress?.({ phase: "run" });

  const bw = bbox.x1 - bbox.x0 + 1;
  const bh = bbox.y1 - bbox.y0 + 1;

  // Dilate + feather sized to the object, so edges are covered and the seam is
  // soft regardless of image scale.
  const objSpan = Math.max(bw, bh);
  const dilateR = Math.max(3, Math.round(objSpan * 0.04) + 3);
  const featherR = Math.max(2, Math.round(objSpan * 0.03) + 2);
  const dilated = dilateMask(maskCanvas, dilateR);

  // Padded SQUARE region around the object → resized to 512 without aspect
  // distortion. Clamp to the image; if it would cover most of the image, just
  // use the whole image as the crop.
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  let half = Math.round(objSpan / 2 + dilateR + objSpan * 0.35 + 16);
  const maxHalf = Math.ceil(Math.max(W, H) / 2);
  if (half > maxHalf) half = maxHalf;

  let rx = Math.round(cx - half);
  let ry = Math.round(cy - half);
  let rs = half * 2;
  // Clamp the square fully inside the image (shift, then shrink if needed).
  if (rs > W) rs = W;
  if (rs > H) rs = H;
  if (rx < 0) rx = 0;
  if (ry < 0) ry = 0;
  if (rx + rs > W) rx = W - rs;
  if (ry + rs > H) ry = H - rs;

  // Crop image + dilated mask to the region, scaled into 512.
  const crop512 = makeCanvas(SIZE, SIZE);
  ctxOf(crop512).drawImage(sourceCanvas, rx, ry, rs, rs, 0, 0, SIZE, SIZE);
  const maskCrop512 = makeCanvas(SIZE, SIZE);
  ctxOf(maskCrop512).drawImage(dilated, rx, ry, rs, rs, 0, 0, SIZE, SIZE);

  const out512 = await runLama512(crop512, maskCrop512, session);

  // Put the 512 result into a canvas, resize back to region size.
  const out512Canvas = makeCanvas(SIZE, SIZE);
  ctxOf(out512Canvas).putImageData(new ImageData(out512, SIZE, SIZE), 0, 0);
  const outRegion = makeCanvas(rs, rs);
  ctxOf(outRegion).drawImage(out512Canvas, 0, 0, SIZE, SIZE, 0, 0, rs, rs);

  // Feather weight for the region (soft mask edge), from the dilated mask.
  const feather = featherMask(dilated, featherR);
  const featherRegion = ctxOf(feather).getImageData(rx, ry, rs, rs).data;

  // Stamp the feather weight into the inpainted region's alpha, then composite
  // it over an exact copy of the original — untouched pixels stay byte-identical.
  const outImg = ctxOf(outRegion).getImageData(0, 0, rs, rs);
  const od = outImg.data;
  for (let i = 0; i < rs * rs; i++) {
    od[i * 4 + 3] = featherRegion[i * 4 + 3];
  }
  ctxOf(outRegion).putImageData(outImg, 0, 0);

  const result = makeCanvas(W, H);
  const rctx = ctxOf(result);
  rctx.drawImage(sourceCanvas, 0, 0);
  rctx.drawImage(outRegion, rx, ry);
  return result;
}
