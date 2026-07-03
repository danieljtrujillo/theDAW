import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { UIElement, CanvasState } from "../types";
import { buildGanManifest } from "./ganManifest";
import { buildGanPackage, GAN_COMMENT } from "./ganExport";
import { parseGan } from "./ganImport";

const CANVAS: CanvasState = {
  backgroundImage: null,
  width: 640,
  height: 480,
  scale: 1,
  panX: 0,
  panY: 0,
  showRulers: true,
};

const KNOB: UIElement = {
  id: "cutoff",
  name: "Cutoff",
  type: "Knob",
  x: 40,
  y: 60,
  width: 80,
  height: 80,
  value: 50,
  min: 0,
  max: 100,
};

const FIXED = { nowIso: "2026-07-02T00:00:00.000Z", id: "test-plugin" };

async function zipPackage(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", comment: GAN_COMMENT });
}

describe("buildGanManifest", () => {
  it("emits a controller manifest with one control + param per knob", () => {
    const m = buildGanManifest([KNOB], CANVAS, "My Plugin", FIXED);
    expect(m.format).toBe("gan");
    expect(m.kind).toBe("controller");
    expect(m.source).toBe("vst-foundry");
    expect(m.canvas).toEqual({ width: 640, height: 480 });
    expect(m.controls).toEqual([
      { id: "cutoff", name: "Cutoff", kind: "value" },
    ]);
    expect(m.params).toHaveLength(1);
    expect(m.params[0]).toMatchObject({ id: "cutoff", type: "float" });
  });
});

describe("buildGanPackage", () => {
  it("packages manifest + index.html + params.js + embedded source", () => {
    const { files } = buildGanPackage([KNOB], CANVAS, [], [], [], "My Plugin", FIXED);
    expect(Object.keys(files).sort()).toEqual([
      "index.html",
      "manifest.json",
      "params.js",
      "source/foundry-project.json",
    ]);
    // The .gan index.html uses the inline .gan bridge, NOT the native shell one.
    expect(files["index.html"]).not.toContain("foundry-bridge.js");
    expect(files["index.html"]).toContain("window.foundryHost");
    expect(files["index.html"]).toContain('type: "updateValue"');
    expect(files["index.html"]).toContain('<script src="params.js"></script>');
    expect(files["params.js"]).toContain("window.FOUNDRY_DESIGN");
  });
});

describe("parseGan round-trip", () => {
  it("restores the exact editable project from an embedded-source .gan", async () => {
    const { files } = buildGanPackage([KNOB], CANVAS, [], [], [], "My Plugin", FIXED);
    const bytes = await zipPackage(files);
    const res = await parseGan(bytes);
    expect(res.sourceKind).toBe("embedded");
    expect(res.hadGanComment).toBe(true);
    expect(res.project.elements).toEqual([KNOB]);
    expect(res.project.canvasState).toEqual(CANVAS);
    expect(res.manifest.id).toBe("test-plugin");
  });

  it("rejects a zip with no manifest.json", async () => {
    const bytes = await zipPackage({ "readme.txt": "hi" });
    await expect(parseGan(bytes)).rejects.toThrow(/manifest\.json/);
  });

  it("reconstructs an editable project from a source-less .gan", async () => {
    const manifest = buildGanManifest([KNOB], CANVAS, "My Plugin", FIXED);
    const bytes = await zipPackage({
      "manifest.json": JSON.stringify(manifest),
    });
    const res = await parseGan(bytes);
    expect(res.sourceKind).toBe("reconstructed");
    expect(res.project.elements).toHaveLength(manifest.controls.length);
    expect(res.project.elements[0].type).toBe("Knob");
    expect(res.project.elements[0].id).toBe("cutoff");
  });
});
