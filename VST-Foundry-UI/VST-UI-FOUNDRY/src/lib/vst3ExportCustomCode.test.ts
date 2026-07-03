import { describe, it, expect } from "vitest";
import { buildVst3Manifest, slugify } from "./vst3Export";
import { buildIndexHtml } from "./vst3ExportUi";
import { BRIDGE_BOOTSTRAP_SOURCE } from "./customCodeBridge";
import { CanvasState, CustomParam, UIElement } from "../types";

const canvas: CanvasState = {
  backgroundImage: null,
  width: 800,
  height: 600,
  scale: 1,
  panX: 0,
  panY: 0,
};

function el(over: Partial<UIElement>): UIElement {
  return {
    id: "e1",
    name: "El",
    type: "CustomCode",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...over,
  };
}

function numParam(key: string, over: Partial<CustomParam> = {}): CustomParam {
  return { key, label: key, type: "number", value: 0, min: 0, max: 100, ...over };
}

describe("buildVst3Manifest — CustomCode params", () => {
  it("emits one continuous param per numeric CustomParam with slugged, namespaced ids", () => {
    const cc = el({
      id: "cc-1",
      name: "Synth",
      params: [
        numParam("cutoff", { label: "Cutoff", min: 20, max: 2000, value: 500, default: 800 }),
        numParam("res", { label: "Res", min: 0, max: 1, value: 0.5 }),
      ],
    });
    const m = buildVst3Manifest([cc], canvas, "P");
    expect(m.params).toHaveLength(2);

    const p0 = m.params[0];
    expect(p0.id).toBe(`${slugify("cc-1")}-${slugify("cutoff")}`);
    expect(p0.elementId).toBe("cc-1");
    expect(p0.kind).toBe("continuous");
    expect(p0.min).toBe(20);
    expect(p0.max).toBe(2000);
    expect(p0.default).toBe(800); // explicit default wins
    expect(p0.cc).toBeGreaterThanOrEqual(0);

    expect(m.params[1].default).toBe(0.5); // falls back to value when no default
    expect(m.params[0].cc).not.toBe(m.params[1].cc); // unique CCs
  });

  it("ignores non-numeric params (color/select/toggle/text)", () => {
    const cc = el({
      id: "cc2",
      params: [
        { key: "tint", label: "Tint", type: "color", value: "#fff" },
        { key: "mode", label: "Mode", type: "select", value: "a", options: ["a", "b"] },
        { key: "on", label: "On", type: "toggle", value: true },
        { key: "note", label: "Note", type: "text", value: "hi" },
      ],
    });
    expect(buildVst3Manifest([cc], canvas, "P").params).toHaveLength(0);
  });

  it("emits nothing for CustomCode with no params (unchanged from prior behavior)", () => {
    const cc = el({ id: "cc3", customCode: "<div>hi</div>" });
    expect(buildVst3Manifest([cc], canvas, "P").params).toHaveLength(0);
  });

  it("guards a zero-width param range (min === max)", () => {
    const cc = el({ id: "cc6", params: [numParam("fixed", { min: 5, max: 5, value: 5 })] });
    const p = buildVst3Manifest([cc], canvas, "P").params[0];
    expect(p.min).toBe(5);
    expect(p.max).toBe(6);
  });

  it("does not disturb native control params; CustomCode params ride alongside", () => {
    const knob = el({ id: "k1", name: "Vol", type: "Knob", min: 0, max: 10, value: 5 });
    const cc = el({
      id: "cc4",
      name: "FX",
      params: [numParam("mix", { min: 0, max: 100, value: 50 })],
    });
    const m = buildVst3Manifest([knob, cc], canvas, "P");
    expect(m.params).toHaveLength(2);

    const knobP = m.params.find((p) => p.elementId === "k1")!;
    expect(knobP.id).toBe(slugify("k1"));
    expect(knobP.kind).toBe("continuous");

    const ccP = m.params.find((p) => p.elementId === "cc4")!;
    expect(ccP.id).toBe(`${slugify("cc4")}-${slugify("mix")}`);

    const ccs = m.params.map((p) => p.cc).filter((c) => c >= 0);
    expect(new Set(ccs).size).toBe(ccs.length); // no CC collisions
  });

  it("carries an informational binding from paramBindings", () => {
    const cc = el({
      id: "cc5",
      params: [numParam("depth")],
      paramBindings: [{ key: "depth", targetId: "daw.lfo1" }],
    });
    const p = buildVst3Manifest([cc], canvas, "P").params[0];
    expect(p.binding).toEqual({ dawTargetId: "daw.lfo1" });
  });

  it("respects the 128-param cap across CustomCode params", () => {
    const many: CustomParam[] = [];
    for (let i = 0; i < 200; i++) many.push(numParam(`p${i}`));
    const cc = el({ id: "big", params: many });
    expect(buildVst3Manifest([cc], canvas, "P").params).toHaveLength(128);
  });
});

describe("exported bundle — shared CustomCode bridge", () => {
  const html = buildIndexHtml("function foundrySlugify(x){return String(x);}");

  it("embeds the actual shared bridge bootstrap so exported custom code has window.PARAMS", () => {
    const marker = "userRegistered"; // token unique to BRIDGE_BOOTSTRAP_SOURCE
    expect(BRIDGE_BOOTSTRAP_SOURCE).toContain(marker);
    expect(html).toContain(marker);
    expect(html).toContain("foundryRegisterParams");
    expect(html).toContain("window.foundrySetParam");
  });

  it("wires both directions of the param bridge plus scale-fit", () => {
    expect(html).toContain("foundry:setParams"); // host -> iframe
    expect(html).toContain("foundry:paramChanged"); // iframe -> host
    expect(html).toContain("foundry:contentSize"); // scale-fit measurement
  });

  it("does not break the outer <script> (bootstrap '<' escaped; only real closings remain)", () => {
    // index.html has exactly three <script> blocks: foundry-bridge.js, params.js,
    // and the renderer. The injected bridge escapes every '<' to \\u003c and the
    // renderer splits its runtime script tags, so no stray </script> leaks in.
    const closings = html.split("</script>").length - 1;
    expect(closings).toBe(3);
  });
});
