// Load a `.gan` back into an editable Foundry project.
//
// A `.gan` written by this app (ganExport.ts) embeds the full editable project
// at source/foundry-project.json — reading it back gives a lossless round-trip
// (every element, texture, custom module preserved). A `.gan` made elsewhere
// (theDAW's backend owl_import, a hand-made one, a third party) has no embedded
// source, so we RECONSTRUCT a best-effort editable starting point from the
// manifest's canvas + controls. It won't recover the original layout (that data
// isn't in the manifest) but it is never empty and is clearly flagged.

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

// Best-effort editable project from a source-less .gan: one native control per
// manifest control, laid out on a grid (original coordinates are unrecoverable).
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
    project: reconstructFromManifest(manifest),
    sourceKind: "reconstructed",
    hadGanComment,
  };
}
