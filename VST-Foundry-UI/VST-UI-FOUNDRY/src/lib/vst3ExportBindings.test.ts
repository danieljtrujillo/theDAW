/**
 * Manifest `bindings` section — built-in (`vst:`) binds riding the VST3
 * export so the native shell can honor them (see Vst3BindingEntry).
 */
import { describe, expect, it } from "vitest";
import { buildVst3Manifest, slugify } from "./vst3Export";
import type { CanvasState, UIElement } from "../types";

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
    type: "Knob",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...over,
  };
}

describe("buildVst3Manifest — bindings section", () => {
  it("emits a shaped route entry per vst: route on a param element", () => {
    const knob = el({
      id: "cutoff-knob",
      binding: {
        routes: [
          {
            id: "r1",
            dest: "daw",
            targetId: "vst:midi.cc.74",
            amount: -60,
            curve: "exp",
            rangeMin: 10,
            rangeMax: 90,
          },
          // Live theDAW route: NOT a manifest binding (shell can't reach it).
          { id: "r2", dest: "daw", targetId: "dj.mixer.xfade" },
          // Element route: never exported.
          { id: "r3", dest: "element", targetId: "other-el", prop: "value" },
        ],
      },
    });
    const m = buildVst3Manifest([knob], canvas, "P");
    expect(m.bindings).toHaveLength(1);
    expect(m.bindings[0]).toEqual({
      targetId: "vst:midi.cc.74",
      elementId: "cutoff-knob",
      paramId: slugify("cutoff-knob"),
      axis: "value",
      mode: "route",
      amount: -60,
      curve: "exp",
      rangeMin: 10,
      rangeMax: 90,
    });
  });

  it("maps XY axes onto the -x / -y param ids", () => {
    const xy = el({
      id: "pad",
      type: "XYPad",
      binding: {
        routes: [
          { id: "rx", dest: "daw", targetId: "vst:midi.cc.1", axis: "x" },
          { id: "ry", dest: "daw", targetId: "vst:midi.pitchbend", axis: "y" },
        ],
      },
    });
    const m = buildVst3Manifest([xy], canvas, "P");
    expect(m.bindings.map((b) => [b.paramId, b.targetId, b.axis])).toEqual([
      [`${slugify("pad")}-x`, "vst:midi.cc.1", "x"],
      [`${slugify("pad")}-y`, "vst:midi.pitchbend", "y"],
    ]);
    // Route defaults fill in.
    expect(m.bindings[0].amount).toBe(100);
    expect(m.bindings[0].curve).toBe("linear");
  });

  it("emits listen entries for bound displays — with param (Meter) and without (Waveform)", () => {
    const meter = el({
      id: "out-meter",
      type: "Meter",
      binding: { targetId: "vst:meter.out.l" },
    });
    const wave = el({
      id: "scope",
      type: "Waveform",
      binding: { targetId: "vst:lfo.1" },
    });
    const m = buildVst3Manifest([meter, wave], canvas, "P");
    expect(m.bindings).toHaveLength(2);

    const meterBind = m.bindings.find((b) => b.elementId === "out-meter")!;
    expect(meterBind.mode).toBe("listen");
    expect(meterBind.paramId).toBe(slugify("out-meter"));

    const waveBind = m.bindings.find((b) => b.elementId === "scope")!;
    expect(waveBind.mode).toBe("listen");
    expect(waveBind.paramId).toBeUndefined(); // Waveform exports no param
    expect(waveBind.targetId).toBe("vst:lfo.1");
  });

  it("exports CustomCode per-param vst: binds as unshaped routes", () => {
    const cc = el({
      id: "custom",
      type: "CustomCode",
      params: [
        { key: "speed", label: "Speed", type: "number", value: 1, min: 0, max: 10 },
      ],
      paramBindings: [
        { key: "speed", targetId: "vst:lfo.1.rate" },
        { key: "speed", targetId: "dj.deckA.rate" }, // live target: not exported
      ],
    });
    const m = buildVst3Manifest([cc], canvas, "P");
    expect(m.bindings).toHaveLength(1);
    expect(m.bindings[0].targetId).toBe("vst:lfo.1.rate");
    expect(m.bindings[0].paramId).toBe(
      `${slugify("custom")}-${slugify("speed")}`,
    );
  });

  it("emits no bindings for an unbound design (and the field always exists)", () => {
    const m = buildVst3Manifest([el({ id: "plain" })], canvas, "P");
    expect(m.bindings).toEqual([]);
  });

  it("honors legacy single-target fields via the routesOf migration", () => {
    const knob = el({
      id: "legacy-knob",
      binding: { targetId: "vst:macro.1" },
    });
    const m = buildVst3Manifest([knob], canvas, "P");
    expect(m.bindings).toHaveLength(1);
    expect(m.bindings[0].targetId).toBe("vst:macro.1");
    expect(m.bindings[0].mode).toBe("route");
  });
});
