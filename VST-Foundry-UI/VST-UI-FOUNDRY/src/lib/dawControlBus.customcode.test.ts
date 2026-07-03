import { describe, it, expect } from "vitest";
import {
  bindableKindsFor,
  customCodeBindableParams,
  customCodeParamKinds,
  listenKindsFor,
} from "./dawControlBus";
import type { CustomParam, ElementType, UIElement } from "../types";

// Minimal UIElement factory — only the fields the capability derivation reads
// matter; the rest satisfy the required shape.
function el(type: ElementType, params?: CustomParam[]): UIElement {
  return {
    id: "e1",
    name: "el",
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...(params ? { params } : {}),
  };
}

const p = (key: string, type: CustomParam["type"]): CustomParam => ({
  key,
  label: key,
  type,
  value: type === "number" ? 0 : type === "toggle" ? false : "",
});

// The design binds CustomCode to theDAW PER numeric param (el.paramBindings),
// derived from the element's params rather than a static per-type kind list.
describe("customCodeBindableParams", () => {
  it("returns only the numeric params of a CustomCode element, in order", () => {
    const out = customCodeBindableParams(
      el("CustomCode", [
        p("cutoff", "number"),
        p("label", "text"),
        p("tint", "color"),
        p("res", "number"),
        p("on", "toggle"),
      ]),
    );
    expect(out.map((x) => x.key)).toEqual(["cutoff", "res"]);
  });

  it("returns [] for CustomCode with no numeric params", () => {
    expect(
      customCodeBindableParams(el("CustomCode", [p("label", "text"), p("tint", "color")])),
    ).toEqual([]);
  });

  it("returns [] for CustomCode with no params at all", () => {
    expect(customCodeBindableParams(el("CustomCode"))).toEqual([]);
  });

  it("returns [] for non-CustomCode types even if they carry params", () => {
    // Derivation is CustomCode-only: a Knob never binds via paramBindings.
    expect(customCodeBindableParams(el("Knob", [p("cutoff", "number")]))).toEqual([]);
    expect(customCodeBindableParams(el("Label"))).toEqual([]);
  });
});

describe("customCodeParamKinds", () => {
  it("advertises the continuous writable kinds a numeric param can drive", () => {
    expect(customCodeParamKinds()).toEqual(["knob", "fader"]);
  });
});

// Regression pin: adding CustomCode's per-param path must not disturb the
// element-level kind maps that drive the routing-stack / listen UI.
describe("existing kind maps are unchanged", () => {
  it("keeps CustomCode out of the element-level routing/listen maps", () => {
    expect(bindableKindsFor("CustomCode")).toBeNull();
    expect(listenKindsFor("CustomCode")).toBeNull();
  });

  it("preserves the established bindable/listen behavior for native types", () => {
    expect(bindableKindsFor("Knob")).toEqual(["knob", "fader"]);
    expect(bindableKindsFor("Toggle")).toEqual(["toggle"]);
    expect(bindableKindsFor("Meter")).toBeNull(); // listen-only
    // "toggle" joined the listen set with the built-in VST bind catalog
    // (boolean state sources — vst:transport.playing / vst:meter.clip —
    // drive LED-style meters via scaleFromTarget's 0/100 collapse).
    expect(listenKindsFor("Meter")).toEqual(["knob", "fader", "toggle"]);
    expect(listenKindsFor("Knob")).toBeNull();
  });
});
