// Native `.gan` export from a Foundry design.
//
// A `.gan` is a ZIP (trailing archive comment "GANv1") holding manifest.json +
// index.html + assets — theDAW's plugin/VST filetype. This module builds one
// entirely client-side (like exportVst3Bundle), reusing the tested standalone
// renderer (vst3ExportUi.ts) so EVERY control type renders faithfully, wired to
// the `.gan` postMessage contract via the injected bridge (ganBridge.ts).
//
// It also embeds the full editable Foundry project as source/foundry-project.json
// so the .gan can be reopened and KEEP editing (see ganImport.ts). theDAW and
// GANduit only read manifest.json + index.html + referenced assets, so the
// embedded source is inert to them.

import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  UIElement,
  CanvasState,
  Asset,
  Texture,
  CustomModule,
} from "../types";
import { buildVst3Ui, SLUGIFY_FN_SOURCE, slugify } from "./vst3Export";
import { buildIndexHtml } from "./vst3ExportUi";
import { GAN_BRIDGE_JS } from "./ganBridge";
import {
  buildGanManifest,
  BuildGanManifestOpts,
  GanManifest,
} from "./ganManifest";

// The trailing ZIP comment that marks a file as a .gan (matches GAN_COMMENT in
// backend/modules/plugin/gan_file.py).
export const GAN_COMMENT = "GANv1";

// The full editable project embedded in a .gan for lossless round-trip editing.
export interface GanProjectSource {
  version: 1;
  elements: UIElement[];
  canvasState: CanvasState;
  assets: Asset[];
  textures: Texture[];
  customModules: CustomModule[];
}

const FOUNDRY_BRIDGE_TAG = '<script src="foundry-bridge.js"></script>';
const PARAMS_TAG = '<script src="params.js"></script>';

/**
 * The `.gan` index.html: the standard Foundry standalone shell, but with the
 * native-shell bridge (foundry-bridge.js) swapped for the inline `.gan` bridge,
 * so window.foundryHost is defined by the page itself (no sidecar file needed).
 */
export function buildGanIndexHtml(): string {
  const base = buildIndexHtml(SLUGIFY_FN_SOURCE);
  const inlineBridge = `<script>\n${GAN_BRIDGE_JS}\n</script>`;
  if (base.includes(FOUNDRY_BRIDGE_TAG)) {
    return base.replace(FOUNDRY_BRIDGE_TAG, inlineBridge);
  }
  // Defensive: if the shared template changed, still inject the bridge before
  // params.js so foundryHost exists rather than the UI silently emitting nothing.
  return base.replace(PARAMS_TAG, `${inlineBridge}\n${PARAMS_TAG}`);
}

export interface GanPackage {
  manifest: GanManifest;
  files: Record<string, string>;
}

/**
 * Assemble the in-memory contents of a `.gan` (before zipping). Pure — no I/O —
 * so it is unit-testable and reusable by a future "install into theDAW library"
 * path.
 */
export function buildGanPackage(
  elements: UIElement[],
  canvasState: CanvasState,
  assets: Asset[],
  textures: Texture[],
  customModules: CustomModule[],
  pluginName: string,
  opts: BuildGanManifestOpts = {},
): GanPackage {
  const name = (pluginName || "").trim() || "Foundry Plugin";
  const manifest = buildGanManifest(elements, canvasState, name, opts);
  const ui = buildVst3Ui(elements, canvasState, assets, textures);
  const source: GanProjectSource = {
    version: 1,
    elements,
    canvasState,
    assets,
    textures,
    customModules: customModules || [],
  };
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(manifest, null, 2),
    "index.html": buildGanIndexHtml(),
    "params.js": ui["ui/params.js"],
    "source/foundry-project.json": JSON.stringify(source),
  };
  return { manifest, files };
}

/** Sanitize a plugin name into a safe `.gan` file base name. */
function fileBaseName(pluginName: string): string {
  const slug = slugify(pluginName);
  return slug === "param" || !slug ? "foundry-plugin" : slug;
}

/**
 * Build a `.gan` and trigger a browser download. Mirrors exportVst3Bundle's
 * jszip + file-saver pattern; the ZIP carries the "GANv1" archive comment so
 * theDAW/GANduit recognize it.
 */
export async function exportGan(
  elements: UIElement[],
  canvasState: CanvasState,
  assets: Asset[],
  textures: Texture[],
  customModules: CustomModule[],
  pluginName: string,
): Promise<void> {
  const { manifest, files } = buildGanPackage(
    elements,
    canvasState,
    assets,
    textures,
    customModules,
    pluginName,
  );
  const zip = new JSZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.file(entry, content);
  }
  const blob = await zip.generateAsync({
    type: "blob",
    comment: GAN_COMMENT,
    compression: "DEFLATE",
  });
  saveAs(blob, `${fileBaseName(manifest.name)}.gan`);
}
