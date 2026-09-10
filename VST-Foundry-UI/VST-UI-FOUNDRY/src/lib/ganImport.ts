// Load a `.gan` back into an editable Foundry project.
//
// A `.gan` written by this app (ganExport.ts) embeds the full editable project
// at source/foundry-project.json — reading it back gives a lossless round-trip
// (every element, texture, custom module preserved). theDAW's backend importer
// embeds the same file now, so plugins that went project.json -> .gan round-trip
// too. A `.gan` without it (an older bundle, a hand-made one, a third party) is
// RECONSTRUCTED: the manifest's controls give the what, and the runtime's own
// index.html gives the where — every element is an absolutely positioned
// <iframe class="gan-frame" data-src="el_<id>.html" style="left:%;top:%;..."> over
// a stage whose background is `url(<artwork>)`. That is the layout the author
// built, in percentages of the canvas, and it puts every control back at its
// real position and size on its real artwork, with the decorative frames
// (panels, labels) returning as editable CustomCode elements. Only a .gan with
// no readable index.html falls to the last resort: controls on a grid.

import JSZip from "jszip";
import { UIElement, CanvasState } from "../types";
import { GAN_COMMENT, GanProjectSource } from "./ganExport";
import { GanManifest } from "./ganManifest";

export type GanSourceKind = "embedded" | "reconstructed";

export interface GanImportResult {
  manifest: GanManifest;
  project: GanProjectSource;
  sourceKind: GanSourceKind;
  // Whether the archive carried the "GANv1" comment (some tools strip it; the
  // presence of a valid manifest.json is the authoritative validity check).
  hadGanComment: boolean;
}

function defaultCanvas(width: number, height: number): CanvasState {
  return {
    backgroundImage: null,
    width: width || 800,
    height: height || 600,
    scale: 1,
    panX: 0,
    panY: 0,
    showRulers: true,
  };
}

function normalizeProject(
  parsed: unknown,
  manifest: GanManifest,
): GanProjectSource {
  const p = (parsed ?? {}) as Partial<GanProjectSource>;
  return {
    version: 1,
    elements: Array.isArray(p.elements) ? p.elements : [],
    canvasState:
      p.canvasState ??
      defaultCanvas(
        Number(manifest?.canvas?.width) || 800,
        Number(manifest?.canvas?.height) || 600,
      ),
    assets: Array.isArray(p.assets) ? p.assets : [],
    textures: Array.isArray(p.textures) ? p.textures : [],
    customModules: Array.isArray(p.customModules) ? p.customModules : [],
  };
}

// ---- What index.html knows that the manifest does not ------------------------

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FRAME_TAG = /<iframe\b[^>]*\bclass="[^"]*\bgan-frame\b[^"]*"[^>]*>/g;
const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

// One CSS length out of a style declaration, in canvas pixels. The runtime
// writes percentages so the layout survives resizing; px is accepted too.
function lengthPx(decl: string, prop: string, span: number): number | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?[\\d.]+)(%|px)`).exec(decl);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  return m[2] === "%" ? (v / 100) * span : v;
}

/** Element id -> pixel rect for every gan-frame the runtime index.html places,
 *  in stage order (which is z-order). Frames without a full box are skipped. */
export function placementsFromIndexHtml(
  html: string,
  canvasW: number,
  canvasH: number,
): Map<string, FrameRect> {
  const out = new Map<string, FrameRect>();
  for (const tag of html.match(FRAME_TAG) ?? []) {
    const id = /^el_(.+)\.html$/.exec(attr(tag, "data-src") ?? "")?.[1];
    const style = attr(tag, "style") ?? "";
    if (!id) continue;
    const x = lengthPx(style, "left", canvasW);
    const y = lengthPx(style, "top", canvasH);
    const width = lengthPx(style, "width", canvasW);
    const height = lengthPx(style, "height", canvasH);
    if (x === null || y === null || width === null || height === null) continue;
    out.set(id, {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    });
  }
  return out;
}

/** The stage artwork's file name, from the first `background: url(...)`. */
export function backgroundNameFromIndexHtml(html: string): string | null {
  const m = /background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+?)["']?\s*\)/.exec(html);
  return m ? m[1].trim() : null;
}

/** An element's own markup, without the runtime wrapper document around it. */
export function innerMarkup(doc: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(doc);
  return (m ? m[1] : doc).trim();
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

// The full reconstruction: controls at their authored boxes, decor as
// CustomCode, artwork on the canvas. Falls back to the grid when index.html is
// missing, so the result is never empty.
async function reconstructFromArchive(
  zip: JSZip,
  manifest: GanManifest,
): Promise<GanProjectSource> {
  const base = reconstructFromManifest(manifest);
  const entry = String((manifest as { entry_html?: string })?.entry_html || "index.html");
  const indexFile = zip.file(entry);
  if (!indexFile) return base;
  const html = await indexFile.async("string");
  const { width: w, height: h } = base.canvasState;
  const placed = placementsFromIndexHtml(html, w, h);
  if (placed.size === 0) return base;

  const controlIds = new Set(base.elements.map((e) => e.id));
  const elements: UIElement[] = base.elements.map((el) => {
    const r = placed.get(el.id);
    return r ? { ...el, ...r } : el;
  });
  for (const [id, r] of placed) {
    if (controlIds.has(id)) continue;
    const file = zip.file(`el_${id}.html`);
    const doc = file ? await file.async("string") : "";
    elements.push({
      id,
      name: id,
      type: "CustomCode",
      ...r,
      customCode: innerMarkup(doc),
      customCodeFit: "stretch",
    });
  }
  // Stage order is z-order; keep it for controls and decor alike.
  const order = new Map([...placed.keys()].map((id, i) => [id, i] as const));
  elements.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  const bgName = backgroundNameFromIndexHtml(html) ?? "background.png";
  const bgFile = zip.file(bgName);
  const ext = bgName.split(".").pop()?.toLowerCase() ?? "png";
  const backgroundImage = bgFile
    ? `data:${MIME[ext] ?? "image/png"};base64,${await bgFile.async("base64")}`
    : null;
  return { ...base, elements, canvasState: { ...base.canvasState, backgroundImage } };
}

// Last resort for a .gan with no readable index.html: one native control per
// manifest control, on a grid.
function reconstructFromManifest(manifest: GanManifest): GanProjectSource {
  const w = Number(manifest?.canvas?.width) || 800;
  const h = Number(manifest?.canvas?.height) || 600;
  const controls = Array.isArray(manifest?.controls) ? manifest.controls : [];
  const cols = Math.max(1, Math.floor(w / 160));
  const elements: UIElement[] = controls.map((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const type: UIElement["type"] =
      c.kind === "trigger"
        ? "Button"
        : c.kind === "xy" || c.kind === "xyz"
          ? "XYPad"
          : "Knob";
    return {
      id: c.id || `ctrl-${i}`,
      name: c.name || c.id || `Control ${i + 1}`,
      type,
      x: 24 + col * 160,
      y: 24 + row * 140,
      width: 96,
      height: 96,
      value: 0,
      min: 0,
      max: 1,
    };
  });
  return {
    version: 1,
    elements,
    canvasState: defaultCanvas(w, h),
    assets: [],
    textures: [],
    customModules: [],
  };
}

/**
 * Parse `.gan` bytes into an editable project. Throws only when the file is not
 * a readable `.gan` (missing/invalid manifest.json).
 */
export async function parseGan(
  data: ArrayBuffer | Uint8Array | Blob,
): Promise<GanImportResult> {
  let zip: JSZip;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zip = await JSZip.loadAsync(data as any);
  } catch {
    throw new Error("Not a .gan file: could not read the ZIP archive.");
  }

  // JSZip exposes the archive comment at runtime, but @types/jszip omits it.
  const zipComment = (zip as unknown as { comment?: string }).comment || "";
  const hadGanComment = zipComment.trim() === GAN_COMMENT;

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    throw new Error("Not a .gan file: manifest.json is missing.");
  }
  let manifest: GanManifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string")) as GanManifest;
  } catch {
    throw new Error("Invalid .gan: manifest.json is not valid JSON.");
  }

  const sourceFile = zip.file("source/foundry-project.json");
  if (sourceFile) {
    try {
      const parsed = JSON.parse(await sourceFile.async("string"));
      return {
        manifest,
        project: normalizeProject(parsed, manifest),
        sourceKind: "embedded",
        hadGanComment,
      };
    } catch {
      // Corrupt embedded source — fall through to reconstruction.
    }
  }

  return {
    manifest,
    project: await reconstructFromArchive(zip, manifest),
    sourceKind: "reconstructed",
    hadGanComment,
  };
}
