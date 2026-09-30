import JSZip from "jszip";
import { buildGanPackage, GAN_COMMENT } from "../../src/lib/ganExport";
import { buildVst3Manifest, buildVst3Ui } from "../../src/lib/vst3Export";
import type { PreparedPowerMode } from "./prepare";

export type PowerModeFiles = Record<string, string | Uint8Array>;

export async function buildPowerModeFiles(
  prepared: PreparedPowerMode,
  originalSource: string,
  name: string,
): Promise<PowerModeFiles> {
  const { elements, canvasState, assets, textures, customModules } = prepared.project;
  const gan = buildGanPackage(elements, canvasState, assets, textures, customModules, name);
  const ganZip = new JSZip();
  for (const [entry, content] of Object.entries(gan.files)) ganZip.file(entry, content);
  const ganBytes = await ganZip.generateAsync({ type: "uint8array", comment: GAN_COMMENT, compression: "DEFLATE" });
  const vstZip = new JSZip();
  vstZip.file("manifest.json", JSON.stringify(buildVst3Manifest(elements, canvasState, name), null, 2));
  for (const [entry, content] of Object.entries(buildVst3Ui(elements, canvasState, assets, textures))) vstZip.file(entry, content);
  const vstBytes = await vstZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return {
    "power-mode.project.json": originalSource,
    "gan-manifest.json": JSON.stringify(gan.manifest, null, 2),
    "power-mode.gan": ganBytes,
    "power-mode.vst3data.zip": vstBytes,
  };
}
