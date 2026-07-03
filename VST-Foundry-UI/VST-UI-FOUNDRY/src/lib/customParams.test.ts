import { describe, it, expect } from "vitest";
import { sanitizeCustomParams, mergeCustomParams } from "./customParams";
import {
  buildBridgeDoc,
  escapeScriptJson,
  elementStyleTokens,
  BRIDGE_BOOTSTRAP_SOURCE,
} from "./customCodeBridge";
import { UIElement } from "../types";

// Characterization + security: sanitizeCustomParams normalizes untrusted param
// schemas (e.g. from a CustomCode iframe self-registering). Pins the current
// validation/coercion rules.
describe("sanitizeCustomParams", () => {
  it("returns [] for non-array input", () => {
    expect(sanitizeCustomParams(null)).toEqual([]);
    expect(sanitizeCustomParams("nope" as unknown)).toEqual([]);
    expect(sanitizeCustomParams({} as unknown)).toEqual([]);
  });

  it("drops entries without a valid key and strips illegal key chars", () => {
    const out = sanitizeCustomParams([
      { key: "good", type: "text", value: "hi" },
      { key: "", type: "text", value: "x" },
      { type: "text", value: "x" },
      { key: "wi th-bad!", type: "text", value: "y" },
    ]);
    expect(out.map((p) => p.key)).toEqual(["good", "withbad"]);
  });

  it("dedupes repeated keys (first wins)", () => {
    const out = sanitizeCustomParams([
      { key: "dup", type: "text", value: "first" },
      { key: "dup", type: "text", value: "second" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe("first");
  });

  it("coerces number values and clamps to min/max", () => {
    const out = sanitizeCustomParams([
      { key: "n", type: "number", value: "42" },
      { key: "hi", type: "number", value: 500, min: 0, max: 100 },
      { key: "lo", type: "number", value: -5, min: 0, max: 100 },
      { key: "bad", type: "number", value: "notnum" },
    ]);
    const byKey = Object.fromEntries(out.map((p) => [p.key, p.value]));
    expect(byKey.n).toBe(42);
    expect(byKey.hi).toBe(100);
    expect(byKey.lo).toBe(0);
    expect(byKey.bad).toBe(0);
  });

  it("parses toggle strings explicitly (so 'false' is false)", () => {
    const out = sanitizeCustomParams([
      { key: "a", type: "toggle", value: "false" },
      { key: "b", type: "toggle", value: "true" },
      { key: "c", type: "toggle", value: 1 },
    ]);
    const byKey = Object.fromEntries(out.map((p) => [p.key, p.value]));
    expect(byKey.a).toBe(false);
    expect(byKey.b).toBe(true);
    expect(byKey.c).toBe(true);
  });

  it("filters select options and falls the value back to the first option", () => {
    const out = sanitizeCustomParams([
      { key: "s", type: "select", value: "z", options: ["a", "b", 3] },
    ]);
    expect(out[0].options).toEqual(["a", "b"]);
    expect(out[0].value).toBe("a");
  });
});

// Reconcile a re-registered schema against existing params so a code regen never
// wipes user-set values, while structure follows the new schema.
describe("mergeCustomParams", () => {
  it("keeps the existing value when a key is re-registered", () => {
    const out = mergeCustomParams(
      [{ key: "a", label: "A", type: "number", value: 7 }],
      [{ key: "a", label: "A renamed", type: "number", value: 0, min: 0, max: 10 }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(7); // user value survives
    expect(out[0].label).toBe("A renamed"); // structure from registered
    expect(out[0].min).toBe(0);
    expect(out[0].max).toBe(10);
  });

  it("prunes keys absent from the registered schema", () => {
    const out = mergeCustomParams(
      [
        { key: "a", label: "A", type: "number", value: 1 },
        { key: "b", label: "B", type: "number", value: 2 },
      ],
      [{ key: "a", label: "A", type: "number", value: 0 }],
    );
    expect(out.map((p) => p.key)).toEqual(["a"]);
  });

  it("adds new keys with their registered values and keeps registered order", () => {
    const out = mergeCustomParams(
      [{ key: "a", label: "A", type: "number", value: 7 }],
      [
        { key: "a", label: "A", type: "number", value: 0 },
        { key: "b", label: "B", type: "number", value: 3 },
      ],
    );
    expect(out.map((p) => p.key)).toEqual(["a", "b"]);
    expect(out[0].value).toBe(7);
    expect(out[1].value).toBe(3);
  });

  it("adopts the registered type and re-coerces the existing value to it", () => {
    const out = mergeCustomParams(
      [{ key: "a", label: "A", type: "text", value: "5" }],
      [{ key: "a", label: "A", type: "number", value: 0 }],
    );
    expect(out[0].type).toBe("number");
    expect(out[0].value).toBe(5);
  });

  it("clamps the preserved value into the newly registered range", () => {
    const out = mergeCustomParams(
      [{ key: "a", label: "A", type: "number", value: 999 }],
      [{ key: "a", label: "A", type: "number", value: 0, min: 0, max: 100 }],
    );
    expect(out[0].value).toBe(100);
  });

  it("preserves the existing stable id so React keys don't churn", () => {
    const out = mergeCustomParams(
      [{ id: "id-1", key: "a", label: "A", type: "number", value: 4 }],
      [{ id: "id-2", key: "a", label: "A", type: "number", value: 0 }],
    );
    expect(out[0].id).toBe("id-1");
  });

  it("handles undefined existing and empty registered", () => {
    expect(
      mergeCustomParams(undefined, [
        { key: "a", label: "A", type: "number", value: 5 },
      ]),
    ).toHaveLength(1);
    expect(
      mergeCustomParams([{ key: "a", label: "A", type: "number", value: 5 }], []),
    ).toEqual([]);
  });
});

// The shared bridge that both the live app and the exported bundle embed.
describe("customCodeBridge", () => {
  it("escapes < and the U+2028/U+2029 separators for safe <script> embedding", () => {
    expect(escapeScriptJson("<")).toBe("\\u003c");
    expect(escapeScriptJson(String.fromCharCode(0x2028))).toBe("\\u2028");
    expect(escapeScriptJson(String.fromCharCode(0x2029))).toBe("\\u2029");
  });

  it("assembles a doc with the bootstrap, PARAMS, theme and style vars", () => {
    const doc = buildBridgeDoc({
      code: "<div id='x'></div>",
      paramsJson: JSON.stringify({ gain: 3 }),
      themeCss: "--app-main: #fff;",
      styleVarsCss: "--el-base-color: #000;",
    });
    expect(doc).toContain("window.PARAMS = {\"gain\":3}");
    expect(doc).toContain(BRIDGE_BOOTSTRAP_SOURCE);
    expect(doc).toContain("foundry:paramChanged");
    expect(doc).toContain("--app-main: #fff;");
    expect(doc).toContain("--el-base-color: #000;");
  });

  it("never lets a param value inject a stray </script>", () => {
    const doc = buildBridgeDoc({
      code: "",
      paramsJson: JSON.stringify({ evil: "</script><script>alert(1)" }),
      themeCss: "",
      styleVarsCss: "",
    });
    // Only the two real bridge <script> blocks may close; the injected one is escaped.
    expect((doc.match(/<\/script>/g) || []).length).toBe(2);
    expect(doc).toContain("\\u003c/script>");
  });

  it("BRIDGE_BOOTSTRAP_SOURCE is syntactically valid JS", () => {
    expect(() => new Function(BRIDGE_BOOTSTRAP_SOURCE)).not.toThrow();
  });

  it("elementStyleTokens maps set fields and omits undefined ones", () => {
    const el = {
      id: "e1",
      name: "cc",
      type: "CustomCode",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      baseColor: "#123456",
      opacity: 50,
    } as UIElement;
    const tokens = elementStyleTokens(el);
    expect(tokens["--el-base-color"]).toBe("#123456");
    expect(tokens["--el-opacity"]).toBe("0.5");
    expect(tokens["--el-active-color"]).toBeUndefined();
  });
});
